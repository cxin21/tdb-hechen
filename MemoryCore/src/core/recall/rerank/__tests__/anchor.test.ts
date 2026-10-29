/**
 * #137-F：融合锚点契约——cap 内必须保住融合主序 top-1。
 */
import { describe, expect, it } from "vitest";
import { anchorRerankOrder } from "../anchor.js";

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
