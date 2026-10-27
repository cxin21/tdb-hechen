/**
 * #137-F：精排 × 融合序位次的混合排序 + 融合锚点契约。
 *
 * 三个钉死的点：α=0 逐位旧行为；α=1 逐位等于融合顺序；锚点保证 cap 内必有融合 top-1。
 */
import { describe, expect, it } from "vitest";
import {
  anchorRerankOrder,
  blendRerankOrder,
  rankPriorScores,
  type RerankScored,
} from "../blend.js";

describe("rankPriorScores", () => {
  it("1 − i/(n−1)：首位 1、末位 0；单条/空集安全", () => {
    expect(rankPriorScores(3)).toEqual([1, 0.5, 0]);
    expect(rankPriorScores(1)).toEqual([1]);
    expect(rankPriorScores(0)).toEqual([]);
  });
});

describe("blendRerankOrder（#137-F）", () => {
  const scored: RerankScored[] = [
    { index: 2, score01: 0.99 },
    { index: 0, score01: 0.05 },
    { index: 1, score01: 0.6 },
  ];

  it("α=0：逐位保留输入顺序（旧行为）", () => {
    expect(blendRerankOrder([2, 0, 1], scored, 3, 0)).toEqual([2, 0, 1]);
    expect(blendRerankOrder([2, 0, 1], scored, 3, -1)).toEqual([2, 0, 1]);
  });

  it("α=1：逐位等于融合顺序（先验 1/0.5/0）", () => {
    expect(blendRerankOrder([2, 0, 1], scored, 3, 1)).toEqual([0, 1, 2]);
  });

  it("α=0.9：精排无法把融合首位挤掉（0.9×1 + 0.1×0.05 > 0.9×0 + 0.1×0.99）", () => {
    expect(blendRerankOrder([2, 0, 1], scored, 3, 0.9)).toEqual([0, 1, 2]);
  });

  it("α=0.3：精排仍可在近距离翻盘（0.3×0 + 0.7×0.99 = 0.693 > 0.3×1 + 0.7×0.05 = 0.335）", () => {
    expect(blendRerankOrder([2, 0, 1], scored, 3, 0.3)).toEqual([2, 1, 0]);
  });

  it("平局确定性：同分按原下标升序（可复现）", () => {
    const flat: RerankScored[] = [
      { index: 0, score01: 0.5 },
      { index: 1, score01: 0.5 },
      { index: 2, score01: 0.5 },
    ];
    expect(blendRerankOrder([2, 1, 0], flat, 3, 0.5)).toEqual([0, 1, 2]);
  });

  it("单元素/空集不炸", () => {
    expect(blendRerankOrder([1], scored, 3, 0.5)).toEqual([1]);
    expect(blendRerankOrder([], scored, 3, 0.5)).toEqual([]);
  });
});

describe("anchorRerankOrder（融合锚点）", () => {
  it("cap 内已有融合 top-1 → 原样返回", () => {
    expect(anchorRerankOrder([0, 2, 1], 2)).toEqual([0, 2, 1]);
    expect(anchorRerankOrder([1, 0, 2], 3)).toEqual([1, 0, 2]);
  });

  it("cap=1 + 精排把别的行排第一 → 强制换成融合 top-1（等价只滤不清排）", () => {
    expect(anchorRerankOrder([2, 1, 0], 1)).toEqual([0, 2, 1]);
  });

  it("cap=2 时融合 top-1 被挤到第 3 → 提到首位，其余保序", () => {
    expect(anchorRerankOrder([2, 1, 0], 2)).toEqual([0, 2, 1]);
  });

  it("cap<=0 / 空序列 → 不做锚定（无注入行时无锚可用）", () => {
    expect(anchorRerankOrder([2, 1, 0], 0)).toEqual([2, 1, 0]);
    expect(anchorRerankOrder([], 3)).toEqual([]);
  });
});
