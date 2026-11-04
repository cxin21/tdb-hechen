/**
 * E 项（验证缺口，2026-11-04）：searchL1ByCoreRefs 的**运行时**覆盖。
 *
 * 缺口实录：该方法是「按价值锚 label 反查记忆」的候选池补池入口（auto-recall.ts:4592、
 * memory-search.ts:640 两处真调用），但此前只有 mock store 用例（store.personrefs-reverse
 * 用的是内存假实现）——本条 SQL（LIKE 预筛 + JS 精确交集复核 + 租户后置复核 + JSON 损坏
 * 跳过 + updated_time DESC 排序）一行真 SQL 都没跑过。本用例补上真临时 SQLite 运行时。
 *
 * 覆盖：① coreRefs/personRefs 双键族命中 ② 无交集不返回（宁缺毋滥）③ 非法 JSON 行跳过
 * 且不连累同批 ④ updated_time DESC + limit 上界 ⑤ 租户 filter 后置复核 ⑥ 空参不查库
 * ⑦ B 项投影：updated_time 直取 l1_records.updated_time。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const TENANT = { team: "default", user: "u1", agent: "a1" };

function makeStore(): { store: VectorStore; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corerefs-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return {
    store,
    cleanup: () => {
      // Windows：必须先 close 再 rmSync，否则 EBUSY/EPERM
      try {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 无害 */
      }
    },
  };
}

type Refs = { coreRefs?: string[]; personRefs?: string[] };
const mk = (id: string, refs: Refs, updatedAt: string, tenant = TENANT): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "t",
    source_message_ids: [],
    metadata: refs as unknown as Record<string, unknown>,
    timestamps: [updatedAt],
    occurred_at: updatedAt,
    certainty: "observed",
    sensitivity: "none",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt,
    version: 0,
    sessionKey: "k",
    sessionId: "s",
    teamId: tenant.team,
    userId: tenant.user,
    agentId: tenant.agent,
  }) as MemoryRecord;

describe("E 项 · searchL1ByCoreRefs 真库运行时", () => {
  it("① coreRefs 与 personRefs 双键族都能命中", () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mk("c1", { coreRefs: ["可靠"] }, "2026-09-01T00:00:00Z"), undefined);
      store.upsertL1(mk("c2", { personRefs: ["张三"] }, "2026-09-02T00:00:00Z"), undefined);
      store.upsertL1(mk("c3", { coreRefs: ["别的锚"] }, "2026-09-03T00:00:00Z"), undefined);

      expect(store.searchL1ByCoreRefs(["可靠"], 10).map((r) => r.record_id)).toEqual(["c1"]);
      // P0-F7：personRefs 键族同样反查得到（旧口径只认 coreRefs）
      expect(store.searchL1ByCoreRefs(["张三"], 10).map((r) => r.record_id)).toEqual(["c2"]);
      // 无交集 → 空（宁缺毋滥：LIKE 预筛到的行必须过 JS 精确复核）
      expect(store.searchL1ByCoreRefs(["不存在的锚"], 10)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("② 排序与上界：updated_time DESC + limit 生效（且 updated_time 投影=真库值）", () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mk("o1", { coreRefs: ["锚"] }, "2026-09-01T00:00:00Z"), undefined);
      store.upsertL1(mk("o2", { coreRefs: ["锚"] }, "2026-09-05T00:00:00Z"), undefined);
      store.upsertL1(mk("o3", { coreRefs: ["锚"] }, "2026-09-03T00:00:00Z"), undefined);

      const all = store.searchL1ByCoreRefs(["锚"], 10);
      expect(all.map((r) => r.record_id)).toEqual(["o2", "o3", "o1"]);
      expect(store.searchL1ByCoreRefs(["锚"], 2).map((r) => r.record_id)).toEqual(["o2", "o3"]);
      // B 项（ADR-0025 决定 9）：队列读投影带 updated_time，且等于库中 updated_time
      expect(all[0].updated_time).toBe("2026-09-05T00:00:00Z");
    } finally {
      cleanup();
    }
  });

  it("③ metadata_json 损坏的行跳过且不连累同批（宁缺毋滥，不抛）", () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mk("b1", { coreRefs: ["锚"] }, "2026-09-01T00:00:00Z"), undefined);
      store.upsertL1(mk("b2", { coreRefs: ["锚"] }, "2026-09-02T00:00:00Z"), undefined);
      // 直接把 b2 的 metadata_json 写坏（保留 coreRefs 子串以通过 LIKE 预筛）
      const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
      db.prepare("UPDATE l1_records SET metadata_json = ? WHERE record_id = ?").run('{"coreRefs": ["锚"', "b2");

      const hits = store.searchL1ByCoreRefs(["锚"], 10);
      expect(hits.map((r) => r.record_id)).toEqual(["b1"]);
    } finally {
      cleanup();
    }
  });

  it("④ 租户 filter 后置复核：跨桶行不返回，同桶行照常返回", () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mk("t1", { coreRefs: ["锚"] }, "2026-09-01T00:00:00Z"), undefined);
      store.upsertL1(
        mk("t2", { coreRefs: ["锚"] }, "2026-09-02T00:00:00Z", { team: "other", user: "u2", agent: "a2" }),
        undefined,
      );

      const same = store.searchL1ByCoreRefs(["锚"], 10, { teamId: "default", userId: "u1", agentId: "a1" });
      expect(same.map((r) => r.record_id)).toEqual(["t1"]);
      const other = store.searchL1ByCoreRefs(["锚"], 10, { teamId: "other" });
      expect(other.map((r) => r.record_id)).toEqual(["t2"]);
      // 没有任何行满足 → 空数组（不是 null、不是抛错）
      expect(store.searchL1ByCoreRefs(["锚"], 10, { teamId: "nobody" })).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("⑤ 空参/非法 limit 直接返回空（不查库、不抛）", () => {
    const { store, cleanup } = makeStore();
    try {
      expect(store.searchL1ByCoreRefs([], 10)).toEqual([]);
      expect(store.searchL1ByCoreRefs(["  "], 10)).toEqual([]);
      expect(store.searchL1ByCoreRefs(["锚"], 0)).toEqual([]);
      expect(store.searchL1ByCoreRefs(["锚"], -3)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
