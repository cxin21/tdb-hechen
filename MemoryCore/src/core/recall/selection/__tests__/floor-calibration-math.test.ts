/**
 * #179 标定数学的纯函数合同（卡尔曼式「先钉口径再算数」）：
 * 相似度必须是-1..1 的余弦、分位数必须可复算、样本不足必须诚实 null（不外推、不猜）。
 */
import { describe, expect, it } from "vitest";

import { cosineSimilarity, nullProbeP95, percentileNearestRank } from "../floor-calibration.js";

const v = (...xs: number[]) => new Float32Array(xs);

describe("#179 标定数学", () => {
  it("余弦：同向=1、正交=0、反向=-1", () => {
    expect(cosineSimilarity(v(1, 0, 0), v(2, 0, 0))).toBeCloseTo(1, 10);
    expect(cosineSimilarity(v(1, 0, 0), v(0, 1, 0))).toBeCloseTo(0, 10);
    expect(cosineSimilarity(v(1, 0, 0), v(-1, 0, 0))).toBeCloseTo(-1, 10);
  });

  it("余弦：维度不符 / 空向量 / 零模长 → null（不许拿 0 冒充相似度）", () => {
    expect(cosineSimilarity(v(1, 0), v(1, 0, 0))).toBeNull();
    expect(cosineSimilarity(v(), v())).toBeNull();
    expect(cosineSimilarity(v(0, 0), v(1, 0))).toBeNull();
  });

  it("分位数：最近秩法（1..100 的 p95=95、p0=1、p100=100）", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileNearestRank(xs, 0.95)).toBe(95);
    expect(percentileNearestRank(xs, 0)).toBe(1);
    expect(percentileNearestRank(xs, 1)).toBe(100);
    expect(percentileNearestRank([], 0.95)).toBeNull();
  });

  it("null-probe p95：样本不足（<minSamples）→ null；够了才给值", () => {
    const few = Array.from({ length: 49 }, (_, i) => i / 100);
    expect(nullProbeP95(few)).toBeNull();
    const enough = Array.from({ length: 300 }, (_, i) => i / 300);
    // 最近秩：k = max(1, ceil(0.95×300)) = 285 → 第 285 小的值 = 284/300
    expect(nullProbeP95(enough)).toBeCloseTo(284 / 300, 10);
    expect(nullProbeP95(enough, 10)).toBeCloseTo(284 / 300, 10);
    // 越界（>1 不是合法余弦相似度）→ 不写地板
    expect(nullProbeP95(Array.from({ length: 300 }, (_, i) => 1 + i / 300))).toBeNull();
    // 非有限值先滤掉（NaN/Infinity 不许把分位数拉成 NaN）
    expect(nullProbeP95([...Array(50).fill(0.1), Number.NaN, Number.POSITIVE_INFINITY])).toBeCloseTo(0.1, 10);
  });
});
