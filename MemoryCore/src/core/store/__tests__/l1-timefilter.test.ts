/**
 * TIMEFIX：L1 时间过滤契约锁定（queryL1Paginated / countL1 同口径 + 无效 ISO 防御）。
 *
 * 背景（task-timefix-brief）：
 *   - 接口 L1CountFilter 声明 timeStart/timeEnd（ISO 8601），实现必须读同键同单位，
 *     SQL 过滤 updated_time（TEXT，UTC ISO 字符串，字典序比较成立）。
 *   - 网关链路：BFF normalizeTimeInput → UTC ISO → /v3|/v2 /atomic/query →
 *     handleAtomicQuery / handleAtomicCount 传 timeStart/timeEnd → store。
 *   - 契约断言（brief verify 第 5 点）：
 *       ① 窗内命中 / 窗外排除；② 无窗 = 全量；
 *       ③ queryL1Paginated 的 total 与 countL1 同口径；
 *       ④ ISO 无效串 = 防御（非法边界被忽略 + warn，不得静默排除/放进全部行）。
 *
 *   ①②③ 是回归锁（键名/单位分裂回归即红）；④ 是本任务修复的 RED 断言。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function makeStore(name: string): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `timefix-${name}-`));
  const dbPath = path.join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${JSON.stringify(initRes)}`);
  return { store, dir };
}

/** 与生产写路径 l1-writer.ts :237 同构：updatedAt = UTC ISO（带 Z）。 */
const mkRecord = (id: string, updatedAt: string): MemoryRecord =>
  ({
    id,
    content: `时间过滤样本 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: [updatedAt],
    createdAt: updatedAt,
    updatedAt,
    // TIMEFIX-v2：occurred_at 为过滤列（业务时间，snake_case 字段名）——测试行必须带
    occurred_at: updatedAt,
    version: 0,
    sessionKey: "k",
    sessionId: "s-timefix",
  }) as MemoryRecord;

// 三条样本：昨天 / 今天窗内 / 明天（BFF 归一化后的形态：UTC ISO 带毫秒 Z）
const D1 = "2026-09-08T10:00:00.000Z";
const D2 = "2026-09-09T12:00:00.000Z";
const D3 = "2026-09-10T10:00:00.000Z";
const WIN_START = "2026-09-09T00:00:00.000Z";
const WIN_END = "2026-09-09T23:59:59.000Z";

async function seedThree(): Promise<{ store: VectorStore; dir: string }> {
  const { store, dir } = makeStore("seed");
  store.upsertL1(mkRecord("t-d1", D1), undefined);
  store.upsertL1(mkRecord("t-d2", D2), undefined);
  store.upsertL1(mkRecord("t-d3", D3), undefined);
  return { store, dir };
}

describe("TIMEFIX：L1 时间窗过滤（updated_time，UTC ISO 字典序）", () => {
  it("① 窗内命中、窗外排除：queryL1Paginated 只返回窗内行", async () => {
    const { store, dir } = await seedThree();
    try {
      const res = store.queryL1Paginated({ timeStart: WIN_START, timeEnd: WIN_END, limit: 10, offset: 0 });
      expect(res.rows.map((r) => r.record_id)).toEqual(["t-d2"]);
      expect(res.total).toBe(1);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("①b countL1 与 queryL1Paginated 同口径：同窗 total 一致", async () => {
    const { store, dir } = await seedThree();
    try {
      const filter = { timeStart: WIN_START, timeEnd: WIN_END };
      expect(store.countL1(filter)).toBe(1);
      expect(store.queryL1Paginated({ ...filter, limit: 10, offset: 0 }).total).toBe(store.countL1(filter));
      // 仅 start / 仅 end 边界也必须同口径
      expect(store.countL1({ timeStart: WIN_START })).toBe(
        store.queryL1Paginated({ timeStart: WIN_START, limit: 10, offset: 0 }).total,
      );
      expect(store.countL1({ timeEnd: WIN_END })).toBe(
        store.queryL1Paginated({ timeEnd: WIN_END, limit: 10, offset: 0 }).total,
      );
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("② 无时间窗 = 全量（3 条）", async () => {
    const { store, dir } = await seedThree();
    try {
      expect(store.queryL1Paginated({ limit: 10, offset: 0 }).total).toBe(3);
      expect(store.countL1()).toBe(3);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("④ 无效 ISO 防御：非法 timeStart 被忽略（warn），不得静默返回 0 行", async () => {
    const { store, dir } = await seedThree();
    try {
      // 修复前：`updated_time >= 'not-a-date'` 字典序恒 false → 0 行（静默错杀）。
      const res = store.queryL1Paginated({ timeStart: "not-a-date", limit: 10, offset: 0 });
      expect(res.total).toBe(3);
      expect(res.rows).toHaveLength(3);
      expect(store.countL1({ timeStart: "not-a-date" })).toBe(3);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("④b 无效 ISO 防御：非法 timeEnd 被忽略；合法+非法混合时合法边界仍生效", async () => {
    const { store, dir } = await seedThree();
    try {
      expect(store.queryL1Paginated({ timeEnd: "not-a-date", limit: 10, offset: 0 }).total).toBe(3);
      expect(store.countL1({ timeEnd: "not-a-date" })).toBe(3);
      // 合法 timeStart + 非法 timeEnd → 只按合法边界过滤（D2/D3 命中，D1 排除）
      const mixed = store.queryL1Paginated({ timeStart: WIN_START, timeEnd: "not-a-date", limit: 10, offset: 0 });
      expect(mixed.rows.map((r) => r.record_id).sort()).toEqual(["t-d2", "t-d3"]);
      expect(store.countL1({ timeStart: WIN_START, timeEnd: "not-a-date" })).toBe(2);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
