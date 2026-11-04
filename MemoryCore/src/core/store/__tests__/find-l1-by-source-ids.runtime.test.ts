/**
 * task-9（2026-11-04）：findL1BySourceMessageIds 的**运行时**覆盖。
 *
 * 缺口实录：l1_records.source_message_ids 自落库起「只写不读」——extractL1Memories 写、
 * l1-writer 取代时并集，但零决策读取（生产当日新增 106 行中 94 行有值，无一参与判定）。
 * 本方法是把它变成提取期证据主键的反查入口（同源完全覆盖 → 决策从 store 改 update）。
 *
 * 覆盖：① id 命中并解析回数组（JSON 文本 → string[]）+ 多 id OR + 无交集不返回（宁缺毋滥）
 * ② 租户 filter 后置复核 ③ 坏格式行不抛且不连累同批 ④ 空 ids 不查库 + limit 上界 50
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const TENANT = { team: "default", user: "u1", agent: "a1" };

function makeStore(): { store: VectorStore; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srcids-"));
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

const mk = (id: string, sourceIds: string[], updatedAt: string, tenant = TENANT): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "t",
    source_message_ids: sourceIds,
    metadata: {} as unknown as Record<string, unknown>,
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

describe("task-9 · findL1BySourceMessageIds 真库运行时", () => {
  it("① id 命中并解析回数组；多 id OR 命中；无交集不返回", () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mk("s1", ["m1", "m2"], "2026-09-01T00:00:00Z"), undefined);
      store.upsertL1(mk("s2", ["m2", "m3"], "2026-09-05T00:00:00Z"), undefined);
      store.upsertL1(mk("s3", ["m9"], "2026-09-03T00:00:00Z"), undefined);

      // 单 id 命中：返回解析后的完整数组（不是 JSON 文本、不是只回命中项）
      expect(store.findL1BySourceMessageIds(["m1"])).toEqual([
        { record_id: "s1", source_message_ids: ["m1", "m2"] },
      ]);
      // 多 id OR（s1/s2 都含 m2，s3 含 m9）+ updated_time DESC：s2(09-05) → s3(09-03) → s1(09-01)
      expect(store.findL1BySourceMessageIds(["m2", "m9"]).map((r) => r.record_id)).toEqual(["s2", "s3", "s1"]);
      // 无交集 → 空（LIKE 预筛到的行必须过 JSON 精确复核）
      expect(store.findL1BySourceMessageIds(["mzz"])).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("② 租户 filter 后置复核：跨桶行不返回，同桶行照常返回", () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mk("t1", ["m1"], "2026-09-01T00:00:00Z"), undefined);
      store.upsertL1(mk("t2", ["m1"], "2026-09-02T00:00:00Z", { team: "default", user: "u2", agent: "a1" }), undefined);

      const scoped = store.findL1BySourceMessageIds(["m1"], { teamId: "default", userId: "u1", agentId: "a1" });
      expect(scoped.map((r) => r.record_id)).toEqual(["t1"]);
      // filter 缺省 = 旧行为（不窄化）
      expect(store.findL1BySourceMessageIds(["m1"]).map((r) => r.record_id).sort()).toEqual(["t1", "t2"]);
    } finally {
      cleanup();
    }
  });

  it("③ 坏格式行跳过且不连累同批（宁缺毋滥，不抛）", () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mk("b1", ["m1"], "2026-09-01T00:00:00Z"), undefined);
      store.upsertL1(mk("b2", ["m1"], "2026-09-02T00:00:00Z"), undefined);
      store.upsertL1(mk("b3", ["m1"], "2026-09-03T00:00:00Z"), undefined);
      // 直接写坏 source_message_ids（保留 m1 子串以通过 LIKE 预筛）：截断 JSON / 非 JSON 文本
      const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
      db.prepare("UPDATE l1_records SET source_message_ids = ? WHERE record_id = ?").run('["m1"', "b2");
      db.prepare("UPDATE l1_records SET source_message_ids = ? WHERE record_id = ?").run("m1,not-json", "b3");

      const hits = store.findL1BySourceMessageIds(["m1"]);
      expect(hits.map((r) => r.record_id)).toEqual(["b1"]);
    } finally {
      cleanup();
    }
  });

  it("④ 空 ids 不查库（返回空）；limit 上界 50", () => {
    const { store, cleanup } = makeStore();
    try {
      expect(store.findL1BySourceMessageIds([])).toEqual([]);
      for (let i = 0; i < 55; i++) {
        const ts = `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`;
        store.upsertL1(mk(`lim-${i}`, ["lim1"], ts), undefined);
      }
      expect(store.findL1BySourceMessageIds(["lim1"]).length).toBe(50);
    } finally {
      cleanup();
    }
  });
});
