/**
 * EMBED-BACKFILL R2（根治轮）：向量缺口补偿器 store 方法测试。
 * 根因（09-27 实锤）：reflection/consolidation/evolution 写链 upsertL1(rec, undefined)
 * → 生命周期产物结构性无向量（缺口 380 行全 rf_/consolidated）。
 * backfillL1Vectors：列缺行→逐条 embed→事务 delete+insert→销账；失败保留重试。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./core/store/sqlite.js";
import type { MemoryRecord } from "./core/store/types.js";

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });

const DIM = 4;
async function makeStore(): Promise<VectorStore> {
  const dir = mkdtempSync(join(tmpdir(), "embed-backfill-"));
  cleanup.push(dir);
  const s = new VectorStore(join(dir, "v.db"), DIM);
  await s.init();
  return s;
}
function mkRecord(id: string, content: string): MemoryRecord {
  return {
    id, content, type: "work_fact", priority: 0.5, certainty: "observed",
    scene_name: "reflection", source_message_ids: [], metadata: {},
    timestamps: ["2026-09-27T00:00:00Z"], createdAt: "2026-09-27T00:00:00Z",
    updatedAt: "2026-09-27T00:00:00Z", occurred_at: null, valid_start: null,
    valid_end: null, certainty_source: undefined, source: undefined,
    valence: null, arousal: null, significance: null,
    version: 0, sessionKey: "k", sessionId: "s", teamId: "t", userId: "u", agentId: "a",
  } as unknown as MemoryRecord;
}
const vec = (): Float32Array => Float32Array.from([0.1, 0.2, 0.3, 0.4]);

describe("backfillL1Vectors（向量缺口补偿器）", () => {
  it("T1 无向量行全部补齐并销账", async () => {
    const s = await makeStore();
    await s.upsertL1(mkRecord("r1", "内容一"), undefined);
    await s.upsertL1(mkRecord("r2", "内容二"), undefined);
    expect(s.countL1VectorRows()).toBe(0);
    let calls = 0;
    const r = await s.backfillL1Vectors!(async () => { calls++; return vec(); });
    expect(r.backfilled).toBe(2);
    expect(r.failed).toBe(0);
    expect(calls).toBe(2);
    expect(s.countL1VectorRows()).toBe(2);
  });

  it("T2 幂等：已有向量的行不重嵌，只补缺失", async () => {
    const s = await makeStore();
    await s.upsertL1(mkRecord("r1", "已有向量"), vec());
    await s.upsertL1(mkRecord("r2", "缺失向量"), undefined);
    let calls = 0;
    const r = await s.backfillL1Vectors!(async () => { calls++; return vec(); });
    expect(r.backfilled).toBe(1);
    expect(calls).toBe(1);
    expect(s.countL1VectorRows()).toBe(2);
  });

  it("T3 单条失败保留待重试，不影响其余补齐", async () => {
    const s = await makeStore();
    await s.upsertL1(mkRecord("r1", "好的"), undefined);
    await s.upsertL1(mkRecord("r2", "坏的"), undefined);
    const r = await s.backfillL1Vectors!(async (text: string) => {
      if (text === "坏的") throw new Error("429 quota");
      return vec();
    });
    expect(r.backfilled).toBe(1);
    expect(r.failed).toBe(1);
    expect(s.countL1VectorRows()).toBe(1);
  });

  it("T4 batchLimit 截断：缺 3 补 2", async () => {
    const s = await makeStore();
    for (const id of ["a", "b", "c"]) await s.upsertL1(mkRecord(id, "内容" + id), undefined);
    const r = await s.backfillL1Vectors!(async () => vec(), 2);
    expect(r.backfilled).toBe(2);
    expect(s.countL1VectorRows()).toBe(2);
  });

  it("T5 空缺 no-op：零调用零写入", async () => {
    const s = await makeStore();
    let calls = 0;
    const r = await s.backfillL1Vectors!(async () => { calls++; return vec(); });
    expect(r.backfilled).toBe(0);
    expect(r.scanned).toBe(0);
    expect(calls).toBe(0);
  });

  it("T6 维度不匹配拒写（防脏向量入库）", async () => {
    const s = await makeStore();
    await s.upsertL1(mkRecord("r1", "维度错"), undefined);
    const r = await s.backfillL1Vectors!(async () => Float32Array.from([0.1, 0.2]));
    expect(r.backfilled).toBe(0);
    expect(r.failed).toBe(1);
    expect(s.countL1VectorRows()).toBe(0);
  });
});
