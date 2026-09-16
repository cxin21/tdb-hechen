/**
 * Task GROW RED 套件：价值锚状态机（origin/pinned/state 三列）+ 软删除 + 钉住/退休/恢复。
 *
 * 契约（task-grow-brief §状态机 + 报告 §0.1 转换表）：
 *   - 幂等迁移：存量行 origin='seed' / pinned=0 / state='active'（存量行全部来自种子）
 *   - deleteValue = 软删除 → state='vetoed'（硬删无法跨发现轮次记住永久否决）；
 *     再删 vetoed → false（观测形态与旧"再删 false"一致）
 *   - listValues 默认只回 active；includeRetired → active+retired（vetoed 永不出现在任何读面）；
 *     出参带 origin/pinned/state
 *   - setValuePinned / retireValue / restoreValue：只作用 active|retired（vetoed 拒绝→false）
 *   - upsert 冲突 → state='active'（显式重建=撤销退休/否决）；origin/pinned 不被 upsert 改写
 *   - listValuesAnyState：全态读（自生长去重 + 种子判空专用）
 *   - includeRetired 与默认读是两个独立缓存变体；新增写路径全部失效缓存
 *   - anchor_growth_state kv 持久化（自生长 interval/语料基线，重启不失忆）
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../sqlite.js";

function makeStore(name = "grow"): { store: VectorStore; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `values-state-${name}-`));
  const dbPath = path.join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return { store, dir, dbPath };
}

function cleanup(store: VectorStore, dir: string): void {
  try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe("GROW 迁移：origin/pinned/state 三列（幂等 ALTER，T12 模式）", () => {
  it("全新库：建表 DDL 直带三列；upsert 默认 origin='manual'/pinned=0/state='active'", () => {
    const { store, dir } = makeStore("fresh");
    try {
      const cols = columns(store.getRawDb(), "core_values");
      expect(cols).toEqual(expect.arrayContaining(["origin", "pinned", "state"]));
      store.upsertValue("v1", "正确性", 0.8);
      const row = store.getRawDb().prepare("SELECT origin, pinned, state FROM core_values WHERE value_id='v1'").get() as { origin: string; pinned: number; state: string };
      expect(row).toEqual({ origin: "manual", pinned: 0, state: "active" });
    } finally { cleanup(store, dir); }
  });

  it("显式 origin 落库（auto 自生长 / seed 种子）", () => {
    const { store, dir } = makeStore("origin");
    try {
      store.upsertValue("a1", "增量对账", 0.6, "auto-growth", undefined, undefined, "auto");
      store.upsertValue("s1", "诚实", 0.9, "config-seed", undefined, undefined, "seed");
      const rows = store.getRawDb().prepare("SELECT value_id, origin FROM core_values ORDER BY value_id").all() as Array<{ value_id: string; origin: string }>;
      expect(rows).toEqual([{ value_id: "a1", origin: "auto" }, { value_id: "s1", origin: "seed" }]);
    } finally { cleanup(store, dir); }
  });

  it("存量库迁移：旧 8 列 core_values → ALTER 补三列，存量行默认 seed/0/active；重复 init 幂等", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "values-state-legacy-"));
    const dbPath = path.join(dir, "legacy.db");
    const raw = new DatabaseSync(dbPath);
    // GROW 前的 core_values 实况（T12 后 8 列）
    raw.exec(`
      CREATE TABLE core_values (
        value_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        weight REAL NOT NULL DEFAULT 0.5,
        created_by TEXT NOT NULL DEFAULT '',
        valence REAL,
        team_id TEXT NOT NULL DEFAULT 'default',
        user_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default'
      )
    `);
    raw.prepare("INSERT INTO core_values (value_id, label, weight, created_by) VALUES (?, ?, ?, ?)").run("honesty", "诚实第一", 0.9, "seed");
    raw.close();

    const store = new VectorStore(dbPath, 0);
    const initRes = store.init();
    if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
    try {
      const cols = columns(store.getRawDb(), "core_values");
      expect(cols).toEqual(expect.arrayContaining(["origin", "pinned", "state"]));
      const row = store.getRawDb().prepare("SELECT origin, pinned, state FROM core_values WHERE value_id='honesty'").get() as { origin: string; pinned: number; state: string };
      expect(row).toEqual({ origin: "seed", pinned: 0, state: "active" });
      // 幂等：重复 init 不炸不重置
      expect(() => store.init()).not.toThrow();
      const row2 = store.getRawDb().prepare("SELECT origin, pinned, state FROM core_values WHERE value_id='honesty'").get() as { state: string };
      expect(row2.state).toBe("active");
    } finally { cleanup(store, dir); }
  });
});

describe("GROW listValues：出参带 origin/pinned/state；默认 active-only；includeRetired 变体", () => {
  it("默认只回 active；retired 经 includeRetired 可见；vetoed 在任何读面都不可见", () => {
    const { store, dir } = makeStore("states");
    try {
      store.upsertValue("v-active", "活跃锚", 0.8);
      store.upsertValue("v-retired", "退休锚", 0.7);
      store.retireValue!("v-retired");
      store.upsertValue("v-vetoed", "否决锚", 0.6);
      store.deleteValue!("v-vetoed");

      const active = store.listValues();
      expect(active.map((r) => r.value_id)).toEqual(["v-active"]);
      expect(active[0]).toMatchObject({ origin: "manual", pinned: 0, state: "active" });

      const withRetired = store.listValues(undefined, { includeRetired: true });
      expect(withRetired.map((r) => r.value_id).sort()).toEqual(["v-active", "v-retired"]);
      expect(withRetired.find((r) => r.value_id === "v-retired")).toMatchObject({ state: "retired" });
      // vetoed 任何读面都不可见
      expect(withRetired.some((r) => r.value_id === "v-vetoed")).toBe(false);
      // any-state 全态读（去重/判空专用）才可见
      const all = store.listValuesAnyState!();
      expect(all.map((r) => r.value_id).sort()).toEqual(["v-active", "v-retired", "v-vetoed"]);
    } finally { cleanup(store, dir); }
  });

  it("includeRetired 与默认读是独立缓存变体：互不脏读，写后双双失效", () => {
    const { store, dir } = makeStore("cache");
    try {
      store.upsertValue("v1", "锚一", 0.8);
      store.listValues();                    // miss（默认变体）
      store.listValues();                    // hit
      expect(store.valuesCacheHits).toBe(1);
      store.listValues(undefined, { includeRetired: true }); // miss（retired 变体，独立 key）
      store.listValues(undefined, { includeRetired: true }); // hit
      expect(store.valuesCacheHits).toBe(2);

      store.retireValue!("v1");              // 写路径失效（全清）
      expect(store.valuesCacheHits).toBe(2);
      const after = store.listValues();      // miss → active 空
      expect(after).toEqual([]);
      const afterR = store.listValues(undefined, { includeRetired: true });
      expect(afterR.map((r) => r.value_id)).toEqual(["v1"]);
      expect(afterR[0].state).toBe("retired");
    } finally { cleanup(store, dir); }
  });
});

describe("GROW 软删除：deleteValue → state='vetoed'", () => {
  it("删 active → true + vetoed；再删 → false；删不存在 → false", () => {
    const { store, dir } = makeStore("veto");
    try {
      store.upsertValue("v1", "锚一", 0.8);
      expect(store.deleteValue!("v1")).toBe(true);
      const row = store.getRawDb().prepare("SELECT state FROM core_values WHERE value_id='v1'").get() as { state: string };
      expect(row.state).toBe("vetoed");           // 行还在（跨轮次记住否决），只是退出读面
      expect(store.deleteValue!("v1")).toBe(false); // 再删 vetoed → 0 行变更 → false
      expect(store.deleteValue!("never-existed")).toBe(false);
    } finally { cleanup(store, dir); }
  });

  it("删 retired → true（vetoed）；读面立即消失", () => {
    const { store, dir } = makeStore("veto2");
    try {
      store.upsertValue("v1", "锚一", 0.8);
      store.retireValue!("v1");
      expect(store.deleteValue!("v1")).toBe(true);
      expect(store.listValues(undefined, { includeRetired: true })).toEqual([]);
    } finally { cleanup(store, dir); }
  });
});

describe("GROW pin/retire/restore 状态机", () => {
  it("retire → restore 全转换；active 行 restore 幂等 false", () => {
    const { store, dir } = makeStore("rr");
    try {
      store.upsertValue("v1", "锚一", 0.8);
      expect(store.retireValue!("v1")).toBe(true);
      expect(store.retireValue!("v1")).toBe(true);   // retired 幂等 → true
      expect(store.restoreValue!("v1")).toBe(true);
      expect(store.listValues()[0]?.state).toBe("active");
      expect(store.restoreValue!("v1")).toBe(false); // active 行 restore → 0 行变更 → false（与 vetoed 再删 false 同型）
      // 恢复不存在的行 → false
      expect(store.restoreValue!("never-existed")).toBe(false);
    } finally { cleanup(store, dir); }
  });

  it("pin true/false 翻转；vetoed 行 pin/retire/restore 全部拒绝（false）", () => {
    const { store, dir } = makeStore("pin");
    try {
      store.upsertValue("v1", "锚一", 0.8);
      expect(store.setValuePinned!("v1", true)).toBe(true);
      expect(store.listValues()[0]?.pinned).toBe(1);
      expect(store.setValuePinned!("v1", false)).toBe(true);
      expect(store.listValues()[0]?.pinned).toBe(0);

      store.deleteValue!("v1"); // → vetoed
      expect(store.setValuePinned!("v1", true)).toBe(false);
      expect(store.retireValue!("v1")).toBe(false);
      expect(store.restoreValue!("v1")).toBe(false);
      // 不存在的行同样 false
      expect(store.setValuePinned!("never-existed", true)).toBe(false);
    } finally { cleanup(store, dir); }
  });

  it("upsert 冲突：retired → active（恢复语义）；vetoed → active（显式撤销否决）；pinned/origin 不被改写", () => {
    const { store, dir } = makeStore("upsert");
    try {
      // retired + pinned 的 auto 锚：面板编辑（upsert）→ active，pinned 保留，origin 保留
      store.upsertValue("v1", "自生长锚", 0.6, "auto-growth", undefined, undefined, "auto");
      store.setValuePinned!("v1", true);
      store.retireValue!("v1");
      store.upsertValue("v1", "自生长锚 v2", 0.7);
      let row = store.getRawDb().prepare("SELECT label, state, pinned, origin FROM core_values WHERE value_id='v1'").get() as { label: string; state: string; pinned: number; origin: string };
      expect(row).toEqual({ label: "自生长锚 v2", state: "active", pinned: 1, origin: "auto" });

      // vetoed → 显式重添 → active（撤销否决）
      store.upsertValue("v2", "否决锚", 0.5);
      store.deleteValue!("v2");
      store.upsertValue("v2", "否决锚", 0.9);
      row = store.getRawDb().prepare("SELECT state FROM core_values WHERE value_id='v2'").get() as { state: string };
      expect(row.state).toBe("active");
    } finally { cleanup(store, dir); }
  });
});

describe("C6 清债：reset 快照排除非 active 行（否决语义对齐——veto 无方向直到重新采纳）", () => {
  it("vetoed/retired 行不进快照；reset 后其 valence 保持 NULL 且 restore 不复活", () => {
    const { store, dir } = makeStore("reset-snapshot");
    try {
      store.upsertValue("v1", "活跃锚一", 0.8, "manual", undefined, 1);
      store.upsertValue("v2", "活跃锚二", 0.7, "manual", undefined, 1);
      store.upsertValue("v3", "否决锚", 0.6, "manual", undefined, -1);
      store.deleteValue!("v3"); // → vetoed（软删除，行保留 valence=-1）
      store.upsertValue("v4", "退休锚", 0.5, "manual", undefined, -1);
      store.retireValue!("v4"); // → retired

      const snapshot = store.resetValueValences();
      // 快照只含 active 行（裁定：reset 快照只含 state='active'）
      expect(snapshot.map((s) => s.value_id).sort()).toEqual(["v1", "v2"]);
      // reset 后全表 valence 置 NULL（含 vetoed/retired——否决语义：无方向）
      const rawValences = () =>
        (store.getRawDb().prepare("SELECT value_id, valence FROM core_values ORDER BY value_id").all() as Array<{ value_id: string; valence: number | null }>);
      expect(rawValences().every((r) => r.valence === null)).toBe(true);
      // 恢复后：active 行复活；vetoed/retired 不在快照 → valence 保持 NULL（不被快照复活）
      const restored = store.restoreValueValences(undefined, snapshot);
      expect(restored).toBe(2);
      const byId = new Map(rawValences().map((r) => [r.value_id, r.valence]));
      expect(byId.get("v1")).toBe(1);
      expect(byId.get("v2")).toBe(1);
      expect(byId.get("v3")).toBe(null); // vetoed 行 reset 后 valence 仍 NULL（否决语义）
      expect(byId.get("v4")).toBe(null); // retired 行同理（无方向直到重新采纳）
    } finally { cleanup(store, dir); }
  });
});

describe("GROW anchor_growth_state kv 持久化", () => {
  it("set → get 回读；重开库仍在（重启不失忆）；get 未初始化 → null 基线", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "values-state-kv-"));
    const dbPath = path.join(dir, "kv.db");
    const store = new VectorStore(dbPath, 0);
    const initRes = store.init();
    if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
    try {
      expect(store.getAnchorGrowthState()).toEqual({ lastDiscoveryAt: null, lastCorpusCount: null, lastAttemptAt: null, lastAdoptedAt: null });
      store.setAnchorGrowthState({ lastDiscoveryAt: "2026-09-10T08:00:00.000Z", lastCorpusCount: 42 });
      expect(store.getAnchorGrowthState()).toEqual({ lastDiscoveryAt: "2026-09-10T08:00:00.000Z", lastCorpusCount: 42, lastAttemptAt: null, lastAdoptedAt: null });
    } finally {
      try { store.close(); } catch { /* 无害 */ }
    }
    const store2 = new VectorStore(dbPath, 0);
    store2.init();
    try {
      expect(store2.getAnchorGrowthState()).toEqual({ lastDiscoveryAt: "2026-09-10T08:00:00.000Z", lastCorpusCount: 42, lastAttemptAt: null, lastAdoptedAt: null });
    } finally { cleanup(store2, dir); }
  });
});
