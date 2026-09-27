/**
 * EMBED-BACKFILL R2-2（口径根治）：buildMemoryHealth vectorCoverage 条数口径测试。
 * 旧行为=vecRows(向量行数,多 chunk 虚增)/metaRows——补齐后 1.197、部分覆盖时高估。
 * 新行为=coveredRows(有向量 L1 条数)/metaRows——恒 ≤1。
 */
import { describe, it, expect } from "vitest";
import { buildMemoryHealth, type MemoryHealthStats } from "./server.js";

function mkStats(over: Partial<MemoryHealthStats> = {}): MemoryHealthStats {
  return {
    vecRows: 0,
    metaRows: 0,
    coveredRows: 0,
    lastVecWriteAt: null,
    embeddingStatus: "ok",
    degradedSince: null,
    ...over,
  } as MemoryHealthStats;
}

describe("buildMemoryHealth（vectorCoverage 条数口径）", () => {
  it("T1 半覆盖：coveredRows=2 metaRows=4 → 0.5（不受 vecRows 影响）", () => {
    const r = buildMemoryHealth(mkStats({ vecRows: 5, metaRows: 4, coveredRows: 2 }));
    expect(r.vectorCoverage).toBeCloseTo(0.5);
  });

  it("T2 全覆盖=1.0；多 chunk 场景 vecRows>metaRows 也不超 1", () => {
    const r = buildMemoryHealth(mkStats({ vecRows: 1124, metaRows: 938, coveredRows: 938 }));
    expect(r.vectorCoverage).toBe(1);
  });

  it("T3 空库：metaRows=0 → 0（除零保护）", () => {
    const r = buildMemoryHealth(mkStats({ vecRows: 0, metaRows: 0, coveredRows: 0 }));
    expect(r.vectorCoverage).toBe(0);
  });

  it("T4 信息字段透传：vecRows/metaRows 原始计数保留", () => {
    const r = buildMemoryHealth(mkStats({ vecRows: 7, metaRows: 10, coveredRows: 6 }));
    expect(r.vecRows).toBe(7);
    expect(r.metaRows).toBe(10);
  });
});
