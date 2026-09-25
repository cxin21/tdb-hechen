/**
 * Task PA RED 套件：价值锚 per-agent 严格独立（推翻 spec §5.1 裁决 2）。
 *
 * 契约（task-pa-brief 六步逐字采用）：
 *   1. 移除 SEC-1 兜底：listValues 严格返回该 agent 桶的内容（可为空）——
 *      非 default 租户空桶 → []（不再读时回退 default 桶锚）。
 *   2. 存量迁移：default 锚扇出（幂等）——init 时把 default 桶全部锚 INSERT OR IGNORE
 *      到 l1_records 中出现的每个 distinct (team,user,agent) 三元组（有记忆的 agent 才扇出）；
 *      origin='seed'、pinned/valence 沿用；二次 init 零重复；已有自己锚的 agent 不被改写。
 *   3. listL1TenantTriplets：l1_records SELECT DISTINCT（迁移与自生长共用三元组来源）。
 *   4. growth state per-tenant：get/setAnchorGrowthState 增可选 tenant——非 default 三元组
 *      独立 kv 键；default/缺省保持旧键（旧行为/调用形状不变，重启不失忆语义保持）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { CoreTenant } from "../types.js";

const TENANT_A: CoreTenant = { teamId: "teamA", userId: "userA", agentId: "agentA" };
const TENANT_B: CoreTenant = { teamId: "teamB", userId: "userB", agentId: "agentB" };
const TENANT_C: CoreTenant = { teamId: "teamC", userId: "userC", agentId: "agentC" };

function mkRecord(id: string, content: string, tenant: CoreTenant): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 0,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
    teamId: tenant.teamId,
    userId: tenant.userId,
    agentId: tenant.agentId,
  } as MemoryRecord;
}

function makeStore(name: string): { store: VectorStore; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `values-per-agent-${name}-`));
  const dbPath = path.join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return { store, dir, dbPath };
}

function cleanup(store: VectorStore, dir: string): void {
  try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
}

describe("PA 第 1 步：listValues 严格无兜底（推翻 spec §5.1 裁决 2）", () => {
  it("非 default 租户空桶 → 严格返回 []（不回退 default 桶锚）", () => {
    const { store, dir } = makeStore("no-fallback");
    try {
      // default 桶有锚 + agent A 有记忆（有记忆也不兜底——无锚 agent 就是空桶）
      store.upsertValue("honesty", "诚实", 0.9, "seed", undefined, undefined, "seed");
      store.upsertL1(mkRecord("a1", "A 的记忆", TENANT_A), undefined);

      const empty = store.listValues(TENANT_B);
      expect(empty).toEqual([]);
      const withMemoryNoAnchors = store.listValues(TENANT_A);
      expect(withMemoryNoAnchors).toEqual([]);
      // default 桶自身照常可见
      expect(store.listValues().map((v) => v.value_id)).toEqual(["honesty"]);
    } finally { cleanup(store, dir); }
  });
});

describe("PA 第 2 步：default 锚扇出迁移（幂等，SEC-1 模式）", () => {
  function seedFanoutFixture(dbPath: string): void {
    const store = new VectorStore(dbPath, 0);
    store.init();
    // default 桶锚：3 条覆盖 pinned/valence/retired 状态
    store.upsertValue("honesty", "诚实", 0.9, "seed", undefined, 1, "seed");
    store.setValuePinned("honesty", true);
    store.upsertValue("candor", "坦率", 0.7, "manual", undefined, -1);
    store.upsertValue("retired-one", "退休锚", 0.5, "manual");
    store.retireValue("retired-one");
    // 有记忆的 agent：A、B；C 有锚无记忆；default 也有记忆
    store.upsertL1(mkRecord("a1", "A 的记忆", TENANT_A), undefined);
    store.upsertL1(mkRecord("a2", "A 的记忆 2", TENANT_A), undefined);
    store.upsertL1(mkRecord("b1", "B 的记忆", TENANT_B), undefined);
    store.upsertL1(mkRecord("d1", "default 的记忆", { teamId: "default", userId: "default", agentId: "default" }), undefined);
    // C 预置自己的锚（同 value_id 'honesty'，weight 不同——扇出不得改写）
    store.upsertValue("honesty", "C 自己的诚实", 0.4, "manual", TENANT_C);
    store.close();
  }

  it("扇出：有记忆的 agent 桶各得 default 全部锚（origin='seed'、pinned/valence/weight 沿用）", () => {
    const { store, dir, dbPath } = makeStore("fanout");
    try {
      seedFanoutFixture(dbPath);
      // 重新打开 = 二次 init → 扇出发生
      const store2 = new VectorStore(dbPath, 0);
      const res = store2.init();
      if (store2.isDegraded()) throw new Error(`临时库初始化降级：${res.reason}`);
      try {
        const a = store2.listValuesAnyState(TENANT_A);
        expect(a.map((v) => v.value_id).sort()).toEqual(["candor", "honesty", "retired-one"]);
        const honesty = a.find((v) => v.value_id === "honesty")!;
        expect(honesty.origin).toBe("seed"); // 扇出副本统一 origin='seed'
        expect(honesty.pinned).toBe(1);      // pinned 沿用
        expect(honesty.valence).toBe(1);     // valence 沿用
        expect(honesty.weight).toBe(0.9);    // weight 沿用
        expect(honesty.state).toBe("active");
        const candor = a.find((v) => v.value_id === "candor")!;
        expect(candor.origin).toBe("seed");
        expect(candor.valence).toBe(-1);
        // retired 锚也扇出（全态），state 沿用
        expect(a.find((v) => v.value_id === "retired-one")!.state).toBe("retired");
        // B 桶同样扇出
        expect(store2.listValuesAnyState(TENANT_B).map((v) => v.value_id).sort()).toEqual(["candor", "honesty", "retired-one"]);
        // default 桶原样不动（3 行，origin 不被改写）
        const d = store2.listValuesAnyState();
        expect(d.length).toBe(3);
        expect(d.find((v) => v.value_id === "candor")!.origin).toBe("manual");
        // 无记忆 agent C：不扇出，只保留自己那行（不被改写）
        const c = store2.listValuesAnyState(TENANT_C);
        expect(c.length).toBe(1);
        expect(c[0]!.label).toBe("C 自己的诚实");
        expect(c[0]!.weight).toBe(0.4);
      } finally { store2.close(); }
    } finally { cleanup(store, dir); }
  });

  it("幂等：三次 init 零重复；无记忆 agent 不扇出", () => {
    const { store, dir, dbPath } = makeStore("fanout-idempotent");
    try {
      seedFanoutFixture(dbPath);
      const store2 = new VectorStore(dbPath, 0);
      store2.init();
      const countAfterFirst = (store2.getRawDb().prepare("SELECT COUNT(*) AS n FROM core_values").get() as { n: number }).n;
      store2.close();
      const store3 = new VectorStore(dbPath, 0);
      store3.init();
      try {
        const countAfterSecond = (store3.getRawDb().prepare("SELECT COUNT(*) AS n FROM core_values").get() as { n: number }).n;
        expect(countAfterSecond).toBe(countAfterFirst);
        // 行数 = default 3 + A 3 + B 3 + C 1 = 10（无记忆 agent 不扇出）
        expect(countAfterSecond).toBe(10);
      } finally { store3.close(); }
    } finally { cleanup(store, dir); }
  });
});

describe("PA 第 3 步：listL1TenantTriplets（迁移与自生长共用的 distinct 三元组来源）", () => {
  it("返回 l1_records 的 distinct (team,user,agent)，无记忆 → []", () => {
    const { store, dir } = makeStore("triplets");
    try {
      expect(store.listL1TenantTriplets!()).toEqual([]);
      store.upsertL1(mkRecord("a1", "A1", TENANT_A), undefined);
      store.upsertL1(mkRecord("a2", "A2", TENANT_A), undefined);
      store.upsertL1(mkRecord("b1", "B1", TENANT_B), undefined);
      const triplets = store.listL1TenantTriplets!();
      const sorted = [...triplets].sort((x, y) => (x.agentId ?? "").localeCompare(y.agentId ?? ""));
      expect(sorted).toEqual([TENANT_A, TENANT_B]);
    } finally { cleanup(store, dir); }
  });
});

describe("PA 第 4 步：anchor growth state per-tenant（自生长双门的 per-agent 基线）", () => {
  it("非 default 三元组各自独立 kv；default/缺省保持旧键旧形状", () => {
    const { store, dir } = makeStore("growth-state");
    try {
      // default（无参）旧形状
      store.setAnchorGrowthState({ lastDiscoveryAt: "2026-09-10T00:00:00.000Z", lastCorpusCount: 9 });
      // A / B 独立
      store.setAnchorGrowthState!({ lastDiscoveryAt: "2026-09-11T00:00:00.000Z", lastCorpusCount: 5 }, TENANT_A);
      store.setAnchorGrowthState!({ lastDiscoveryAt: "2026-09-12T00:00:00.000Z", lastCorpusCount: 7 }, TENANT_B);
      expect(store.getAnchorGrowthState()).toEqual({ lastDiscoveryAt: "2026-09-10T00:00:00.000Z", lastCorpusCount: 9, lastAttemptAt: null, lastAdoptedAt: null, lastMaintAt: null });
      expect(store.getAnchorGrowthState!(TENANT_A)).toEqual({ lastDiscoveryAt: "2026-09-11T00:00:00.000Z", lastCorpusCount: 5, lastAttemptAt: null, lastAdoptedAt: null, lastMaintAt: null });
      expect(store.getAnchorGrowthState!(TENANT_B)).toEqual({ lastDiscoveryAt: "2026-09-12T00:00:00.000Z", lastCorpusCount: 7, lastAttemptAt: null, lastAdoptedAt: null, lastMaintAt: null });
      // 未写过的租户 → 空状态
      const empty = store.getAnchorGrowthState!(TENANT_C);
      expect(empty).toEqual({ lastDiscoveryAt: null, lastCorpusCount: null, lastAttemptAt: null, lastAdoptedAt: null, lastMaintAt: null });
      // 持久化在 kv 表（重启不失忆语义保持）：显式键可见
      const rawKeys = (store.getRawDb().prepare("SELECT k FROM anchor_growth_state ORDER BY k").all() as Array<{ k: string }>).map((r) => r.k);
      expect(rawKeys).toContain("last_discovery_at"); // 旧键保留
      expect(rawKeys.some((k) => k.includes("agentA"))).toBe(true);
    } finally { cleanup(store, dir); }
  });
});
