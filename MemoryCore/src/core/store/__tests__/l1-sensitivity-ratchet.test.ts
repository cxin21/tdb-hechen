/**
 * A 项（ADR-0025 决定 10，2026-11-04）：sensitivity 单向棘轮下限 —— store 层。
 *
 * 两个命题：
 *  1) 既有 upsert 路径**不可能**降敏（粘性 CASE 把 'none' 当「本次未判定」）——
 *     这是必须新增 setL1Sensitivity 的实证理由（本用例是现状留档，永绿）。
 *  2) setL1Sensitivity 是本仓唯一降敏写路：CAS（expect 不符 → false）/ 主表+l1_fts 双写 /
 *     bump updated_time / 行不存在显式 false。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function makeStore(): VectorStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-sensitivity-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return store;
}

const mkRecord = (id: string, sensitivity?: string, updatedAt = "2026-09-01T00:00:00Z"): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "t",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    occurred_at: "2026-09-01T00:00:00Z",
    certainty: "observed",
    sensitivity,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt,
    version: 0,
    sessionKey: "k",
    sessionId: "s",
  }) as MemoryRecord;

type Row = { record_id: string; sensitivity: string | null; updated_time: string };
const readMain = (store: VectorStore, id: string): Row | undefined =>
  (store as unknown as { queryL1Records: () => Row[] }).queryL1Records().find((r) => r.record_id === id);
// l1_fts 的 sensitivity 是 UNINDEXED 副本：FTS 召回路读的是它，必须同一事务口径同步
const readFts = (store: VectorStore, id: string): string | null => {
  const db = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db;
  const row = db.prepare("SELECT sensitivity FROM l1_fts WHERE record_id = ?").get(id) as
    | { sensitivity: string | null }
    | undefined;
  return row ? row.sensitivity : null;
};

describe("A-1 现状留档：upsert 路径无法降敏（粘性 CASE）", () => {
  it("已分类行再走 upsert 送 'none' → 库里仍是原分类（fail-closed）", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("r1", "finance"), undefined);
    expect(readMain(store, "r1")?.sensitivity).toBe("finance");
    store.upsertL1(mkRecord("r1", "none", "2026-09-05T00:00:00Z"), undefined);
    expect(readMain(store, "r1")?.sensitivity).toBe("finance");
    expect(readFts(store, "r1")).toBe("finance");
  });
});

describe("A-2 setL1Sensitivity：唯一降敏写路", () => {
  it("CAS 命中 → 主表与 l1_fts 同步降为 none，且 bump updated_time", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("r2", "finance"), undefined);
    const before = readMain(store, "r2")!.updated_time;
    expect(store.setL1Sensitivity("r2", "none", "finance")).toBe(true);
    expect(readMain(store, "r2")?.sensitivity).toBe("none");
    expect(readFts(store, "r2")).toBe("none");
    expect(readMain(store, "r2")!.updated_time > before).toBe(true);
  });

  it("expect 与当前值不符 → false，且一个字节都不写", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("r3", "health"), undefined);
    expect(store.setL1Sensitivity("r3", "none", "finance")).toBe(false);
    expect(readMain(store, "r3")?.sensitivity).toBe("health");
    expect(readFts(store, "r3")).toBe("health");
  });

  it("行不存在 → 显式 false（不静默成功）", () => {
    const store = makeStore();
    expect(store.setL1Sensitivity("ghost", "none", "none")).toBe(false);
  });

  it("降敏后可再用 expect='none' 重放（幂等方向），内容与版本不被改写", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("r4", "relationship"), undefined);
    expect(store.setL1Sensitivity("r4", "none", "relationship")).toBe(true);
    expect(store.setL1Sensitivity("r4", "none", "none")).toBe(true);
    const row = readMain(store, "r4")!;
    expect(row.sensitivity).toBe("none");
    const full = (store as unknown as {
      queryL1Records: () => Array<{ record_id: string; content: string; version: number }>;
    }).queryL1Records().find((r) => r.record_id === "r4")!;
    expect(full.content).toBe("条目 r4");
    expect(full.version).toBe(0); // 降敏不改版本
  });

  it("底层失败必须抛错（不可伪装成 CAS 未命中）——事务整体回滚，不留半写", () => {
    // 对抗评审 P1：此前 catch 里 return false，网关一律回 409，客户端按并发冲突重试
    // 永远失败（值其实已改）、审计也没有行。用「已关闭的库」制造真实 SQL 失败。
    const store = makeStore();
    store.upsertL1(mkRecord("r5", "finance"), undefined);
    store.close();
    expect(() => store.setL1Sensitivity("r5", "none", "finance")).toThrow();
  });
});
