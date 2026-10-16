/**
 * #42（ADR0003-P3 实施票 D / D9）：情境锚相似度打分器单测。
 * 合同：cosine 纯函数（零范数→0、维数不匹配→0 宁缺毋滥）；锚向量缓存=desc 原文精确键
 * （弃 hash 键——键错=静默错分，宁用原文；cap 100 FIFO 镜像 soul-assembler SOUL_CACHE_MAX）；
 * scoreAnchorRows 排序 score desc+并列保声明序；selectAnchorRows=threshold 硬门+top-K（K=maxRows）。
 * 真实性边界：embedder/queryEmbedding 缺席→[]（不造分）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cosineSimilarity,
  scoreAnchorRows,
  selectAnchorRows,
  resetAnchorVectorCacheForTest,
} from "../soul-anchor-scorer.js";

describe("#42 cosineSimilarity", () => {
  it("golden：同向=1 / 正交=0 / 45°≈0.7071", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1, 10);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 10);
    expect(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([1, 0]))).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("零向量→0；维数不匹配→0（宁缺毋滥，不抛错不猜）", () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 0]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([1, 0, 0]), new Float32Array([1, 0]))).toBe(0);
  });
});

describe("#42 scoreAnchorRows（锚向量缓存）", () => {
  beforeEach(() => resetAnchorVectorCacheForTest());

  it("缓存命中不重算：同 desc 二次打分 embed 调用数=0；新 desc 只嵌增量", async () => {
    const vec = (x: number): Float32Array => new Float32Array([x, 1 - x]);
    const embed = vi.fn(async (t: string) => vec(t === "d1" ? 1 : 0));
    const rows = [
      { row: "r1", desc: "d1" },
      { row: "r2", desc: "d2" },
    ];
    const q = new Float32Array([1, 0]);
    const first = await scoreAnchorRows(rows, q, embed);
    expect(first).toEqual([
      { row: "r1", score: expect.any(Number) },
      { row: "r2", score: expect.any(Number) },
    ]);
    expect(embed).toHaveBeenCalledTimes(2);
    const second = await scoreAnchorRows(rows, q, embed);
    expect(embed).toHaveBeenCalledTimes(2); // 缓存命中零新增
    expect(second.map((r) => r.row)).toEqual(["r1", "r2"]);
    const third = await scoreAnchorRows([{ row: "r3", desc: "d3" }], q, embed);
    expect(embed).toHaveBeenCalledTimes(3); // 仅新增条目
    expect(third).toHaveLength(1);
  });

  it("FIFO cap=100：第 101 条挤掉最旧，最旧再打分触发重嵌", async () => {
    const embed = vi.fn(async (t: string) => new Float32Array([Number(t), 1]));
    const all = Array.from({ length: 101 }, (_, i) => ({ row: `r${i}`, desc: String(i) }));
    await scoreAnchorRows(all, new Float32Array([1, 1]), embed);
    expect(embed).toHaveBeenCalledTimes(101);
    await scoreAnchorRows([{ row: "r0", desc: "0" }], new Float32Array([1, 1]), embed);
    expect(embed).toHaveBeenCalledTimes(102); // "0" 已被逐出→重嵌
    await scoreAnchorRows([{ row: "r100", desc: "100" }], new Float32Array([1, 1]), embed);
    expect(embed).toHaveBeenCalledTimes(102); // "100" 仍在缓存
  });

  it("排序 score desc；并列保声明序（稳定）", async () => {
    const embed = async (t: string) => new Float32Array([t === "hi" ? 1 : 0, 1]);
    const rows = [
      { row: "lo-a", desc: "lo" },
      { row: "tie1", desc: "hi" },
      { row: "lo-b", desc: "lo" },
      { row: "tie2", desc: "hi" },
    ];
    const scored = await scoreAnchorRows(rows, new Float32Array([1, 0]), embed);
    expect(scored.map((r) => r.row)).toEqual(["tie1", "tie2", "lo-a", "lo-b"]);
    // vec("hi")=[1,1] 对 query [1,0] 的 cosine=√½（合同工件修正：RED 阶段测试体未运行，
    // 原断言误写为 1；GREEN 前修正契约，不改排序语义）。
    expect(scored[0].score).toBeCloseTo(Math.SQRT1_2, 10);
    expect(scored[2].score).toBeCloseTo(0, 10);
  });

  it("embedder 缺席或 queryEmbedding 缺席→[] 且零 embed 调用（真实性：不造分）", async () => {
    const embed = vi.fn(async () => new Float32Array([1, 0]));
    expect(await scoreAnchorRows([{ row: "r", desc: "d" }], new Float32Array([1, 0]))).toEqual([]);
    expect(await scoreAnchorRows([{ row: "r", desc: "d" }], null, embed)).toEqual([]);
    expect(await scoreAnchorRows([], new Float32Array([1, 0]), embed)).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });
});

describe("#42 selectAnchorRows（转正选择纯函数）", () => {
  it("threshold 硬门 + top-K=maxRows + 并列稳定", () => {
    const scored = [
      { row: "a", score: 0.9 },
      { row: "b", score: 0.6 },
      { row: "c", score: 0.6 },
      { row: "d", score: 0.4 },
    ];
    expect(selectAnchorRows(scored, { maxRows: 2, threshold: 0.5 }).map((r) => r.row)).toEqual(["a", "b"]);
    expect(selectAnchorRows(scored, { maxRows: 10, threshold: 0.5 }).map((r) => r.row)).toEqual(["a", "b", "c"]);
    expect(selectAnchorRows(scored, { maxRows: 3, threshold: 0 })).toHaveLength(3);
    expect(selectAnchorRows(scored, { maxRows: 0, threshold: 0 })).toEqual([]); // maxRows=0=不选择
  });

  it("M-2 回归锁（#42 审查）：threshold 等值边界——score===threshold 保留（>= 语义）", () => {
    const scored = [
      { row: "eq", score: 0.7 },
      { row: "below", score: 0.69 },
    ];
    expect(selectAnchorRows(scored, { maxRows: 10, threshold: 0.7 }).map((r) => r.row)).toEqual(["eq"]);
  });
});
