/**
 * R-A3 E2 RED 套件（性能速赢：listValues 租户级缓存，失效点穷举是灵魂）。
 * 计数器语义：valuesCacheMisses = 真实 DB 查询次数；valuesCacheHits = 缓存命中次数。
 * 失效点穷举（brief 五写路径）：upsertValue / deleteValue / deriveValueValences /
 * restoreValueValences / resetValueValences —— 任一写后缓存必须失效，漏一个 = 脏读。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function makeStore(): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "values-cache-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return { store, dir };
}

const mkRecord = (id: string): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "t",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
  }) as MemoryRecord;

describe("E2 listValues 租户级缓存：读两次一次 DB", () => {
  it("首次 miss、二次 hit（同一租户）", () => {
    const { store, dir } = makeStore();
    try {
      store.upsertValue("v1", "正确性", 0.8, "t", undefined, 1);
      const r1 = store.listValues();
      const r2 = store.listValues();
      expect(r1.length).toBe(1);
      expect(r2).toEqual(r1);
      expect(store.valuesCacheMisses).toBe(1);
      expect(store.valuesCacheHits).toBe(1);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("不同租户各自缓存（key 含租户三元组）", () => {
    const { store, dir } = makeStore();
    try {
      store.upsertValue("v1", "正确性", 0.8, "t", { teamId: "t1", userId: "u", agentId: "a" }, 1);
      store.listValues({ teamId: "t1", userId: "u", agentId: "a" });
      store.listValues({ teamId: "t2", userId: "u", agentId: "a" });
      expect(store.valuesCacheMisses).toBe(2);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});

describe("E2 失效点穷举（五写路径逐一挂钩）", () => {
  it("upsertValue 写后失效：下一次读反映新行", () => {
    const { store, dir } = makeStore();
    try {
      store.upsertValue("v1", "正确性", 0.8, "t", undefined, 1);
      store.listValues();
      store.upsertValue("v2", "诚实", 0.7, "t", undefined, -1);
      const rows = store.listValues();
      expect(store.valuesCacheMisses).toBe(2); // 写后失效 → 再次 miss
      expect(rows.some((v) => v.label === "诚实")).toBe(true);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("deleteValue 写后失效：删除立即可见", () => {
    const { store, dir } = makeStore();
    try {
      store.upsertValue("v1", "正确性", 0.8, "t", undefined, 1);
      store.listValues();
      expect(store.deleteValue("v1")).toBe(true);
      const rows = store.listValues();
      expect(store.valuesCacheMisses).toBe(2);
      expect(rows.some((v) => v.label === "正确性")).toBe(false);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("deriveValueValences 写后失效：LLM 判定值立即可见", async () => {
    const { store, dir } = makeStore();
    try {
      store.upsertValue("v1", "正确性", 0.8, "t", undefined); // valence NULL
      const before = store.listValues();
      expect(before[0]?.valence).toBeNull();
      const runner = {
        run: async () => JSON.stringify({ valences: [{ value_id: "v1", valence: 1 }] }),
      };
      const { derived } = await store.deriveValueValences(undefined, runner);
      expect(derived).toBe(1);
      const after = store.listValues();
      expect(store.valuesCacheMisses).toBe(2);
      expect(after[0]?.valence).toBe(1);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("resetValueValences 写后失效：置 NULL 立即可见", () => {
    const { store, dir } = makeStore();
    try {
      store.upsertValue("v1", "正确性", 0.8, "t", undefined, 1);
      store.listValues();
      const snapshot = store.resetValueValences();
      expect(snapshot.length).toBe(1);
      const after = store.listValues();
      expect(store.valuesCacheMisses).toBe(2);
      expect(after[0]?.valence).toBeNull();
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("restoreValueValences 写后失效：快照恢复值立即可见", () => {
    const { store, dir } = makeStore();
    try {
      store.upsertValue("v1", "正确性", 0.8, "t", undefined, 1);
      store.listValues();
      const snapshot = store.resetValueValences();
      store.listValues(); // NULL 态进缓存
      const restored = store.restoreValueValences(undefined, snapshot);
      expect(restored).toBe(1);
      const after = store.listValues();
      expect(store.valuesCacheMisses).toBe(3);
      expect(after[0]?.valence).toBe(1);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});

describe("E2 TTL 与开关", () => {
  it("setValuesCacheTtlMs(0) → 缓存关（每次都查 DB）", () => {
    const { store, dir } = makeStore();
    try {
      store.upsertValue("v1", "正确性", 0.8, "t", undefined, 1);
      store.setValuesCacheTtlMs(0);
      store.listValues();
      store.listValues();
      store.listValues();
      expect(store.valuesCacheMisses).toBe(3);
      expect(store.valuesCacheHits).toBe(0);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("TTL 过期 → 重新查 DB（跨进程写漂移防御）", async () => {
    const { store, dir } = makeStore();
    try {
      store.upsertValue("v1", "正确性", 0.8, "t", undefined, 1);
      store.setValuesCacheTtlMs(20);
      store.listValues();
      store.listValues();
      expect(store.valuesCacheHits).toBe(1);
      await new Promise((r) => setTimeout(r, 40));
      store.listValues();
      expect(store.valuesCacheMisses).toBe(2);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("缓存不破坏 L1 主流程（upsertL1/searchL1Fts 照常）", () => {
    const { store, dir } = makeStore();
    try {
      store.upsertValue("v1", "正确性", 0.8, "t", undefined, 1);
      store.listValues();
      store.upsertL1(mkRecord("r1"), undefined);
      const fts = store.searchL1Fts("条目", 10);
      expect(fts.some((r) => r.record_id === "r1")).toBe(true);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});

// ── S7 第 9 项（批 2 审查 M-6 观测小疵）：key 抗碰撞 + 异常路径计数 ──

describe("E2 租户 cacheKey 抗碰撞（S7：| 裸拼接 → JSON.stringify，沿 S2 模式）", () => {
  it("三元组段含 | 的两个不同租户不得串桶（key 碰撞 → 读到对方缓存行）", () => {
    const { store, dir } = makeStore();
    try {
      // `|` 裸拼接下两租户 key 同为 "t1|x|u|a" → 第二个读吃到第一个的缓存（脏读）
      store.upsertValue("v1", "甲桶锚", 0.8, "t", { teamId: "t1|x", userId: "u", agentId: "a" }, 1);
      store.upsertValue("v2", "乙桶锚", 0.8, "t", { teamId: "t1", userId: "x|u", agentId: "a" }, 1);
      const r1 = store.listValues({ teamId: "t1|x", userId: "u", agentId: "a" });
      const r2 = store.listValues({ teamId: "t1", userId: "x|u", agentId: "a" });
      expect(r1.map((v) => v.label)).toEqual(["甲桶锚"]);
      expect(r2.map((v) => v.label)).toEqual(["乙桶锚"]);
      expect(store.valuesCacheMisses).toBe(2); // 各自真实查库（碰撞修复前：1 miss + 1 脏 hit）
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});

describe("E2 valuesCacheMisses 语义（S7：SQL 异常路径不计数）", () => {
  it("SQL 异常路径不计 miss（valuesCacheMisses = 真实 DB 查询次数）", () => {
    const { store, dir } = makeStore();
    try {
      store.upsertValue("v1", "正确性", 0.8, "t", undefined, 1);
      expect(store.listValues().length).toBe(1);
      expect(store.valuesCacheMisses).toBe(1);
      store.setValuesCacheTtlMs(0); // 关缓存：否则 DROP 后命中缓存走不到 SQL
      store.getRawDb().exec("DROP TABLE core_values"); // 强制 SQL 异常路径
      expect(store.listValues()).toEqual([]); // catch → []（不抛透）
      // 修复前：miss 计数在 try 之前自增，异常路径也 +1（= 2，失真）
      expect(store.valuesCacheMisses).toBe(1);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
