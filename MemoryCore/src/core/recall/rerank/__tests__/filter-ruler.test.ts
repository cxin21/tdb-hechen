/**
 * #144：rerank filter 尺子的纯函数单测（配置归一 + 题内相对裁量）。
 * 这些是 auto-recall 与离线校准脚本共用的唯一实现——两边口径漂移会让「离线调参」
 * 和「生产判定」不是同一件事（ADR-0012）。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RERANK_FILTER_RULER,
  filterRulerGateObs,
  normalizeRerankFilterKeepRatio,
  normalizeRerankFilterMarginTop,
  normalizeRerankFilterRule,
  normalizeRerankFilterRuler,
  relativeKeepIdxSet,
} from "../filter-ruler.js";

describe("#144 · filterRuler 配置归一", () => {
  it("非法 rule 静默回落 floor；缺省整组 = floor/8/0.5", () => {
    for (const bad of [undefined, null, "", "FLOOR", 1, {}, "bogus"]) {
      expect(normalizeRerankFilterRule(bad)).toBe("floor");
    }
    expect(normalizeRerankFilterRule("margin")).toBe("margin");
    expect(normalizeRerankFilterRule("quantile")).toBe("quantile");
    expect(normalizeRerankFilterRuler()).toEqual(DEFAULT_RERANK_FILTER_RULER);
  });

  it("marginTop：非有限或 ≤0 回落 8，正数原样透传", () => {
    for (const bad of [undefined, Number.NaN, Infinity, 0, -3]) expect(normalizeRerankFilterMarginTop(bad)).toBe(8);
    expect(normalizeRerankFilterMarginTop(0.5)).toBe(0.5);
  });

  it("keepRatio：>1 clamp 到 1（有意义的饱和上界），非有限或 ≤0 回落 0.5", () => {
    expect(normalizeRerankFilterKeepRatio(1.5)).toBe(1);
    expect(normalizeRerankFilterKeepRatio(1)).toBe(1);
    expect(normalizeRerankFilterKeepRatio(0.33)).toBe(0.33);
    for (const bad of [undefined, Number.NaN, Infinity, 0, -1]) expect(normalizeRerankFilterKeepRatio(bad)).toBe(0.5);
  });

  it("gate 观测投影只带当前生效尺子的参数（避免半真观测）", () => {
    expect(filterRulerGateObs({ rule: "floor", marginTop: 8, keepRatio: 0.5 })).toEqual({ filterRule: "floor" });
    expect(filterRulerGateObs({ rule: "margin", marginTop: 2, keepRatio: 0.5 })).toEqual({
      filterRule: "margin",
      filterMarginTop: 2,
    });
    expect(filterRulerGateObs({ rule: "quantile", marginTop: 8, keepRatio: 0.25 })).toEqual({
      filterRule: "quantile",
      filterKeepRatio: 0.25,
    });
  });
});

describe("#144 · relativeKeepIdxSet（题内相对裁量，不排序）", () => {
  const ruler = (rule: "margin" | "quantile", marginTop = 8, keepRatio = 0.5) => ({ rule, marginTop, keepRatio });

  it("margin：保留 top1−marginTop 以上；恰好等于 cut 的并列行保留", () => {
    const clean = [
      { index: 3, score: 0.9 },
      { index: 1, score: 0.5 },
      { index: 4, score: 0.4 },
      { index: 0, score: 0.39 },
    ];
    expect([...relativeKeepIdxSet(clean, ruler("margin", 0.5))].sort()).toEqual([1, 3, 4]);
  });

  it("quantile：ceil(n×ratio) 条，下限 1；空池返回空集", () => {
    const clean = [0, 1, 2, 3, 4].map((i) => ({ index: i, score: 10 - i }));
    expect(relativeKeepIdxSet(clean, ruler("quantile", 8, 0.5)).size).toBe(3); // ceil(2.5)
    expect(relativeKeepIdxSet(clean, ruler("quantile", 8, 1)).size).toBe(5);
    expect(relativeKeepIdxSet(clean, ruler("quantile", 8, 0.01)).size).toBe(1);
    expect(relativeKeepIdxSet([], ruler("quantile")).size).toBe(0);
  });

  it("返回的是下标集合而非顺序：调用方保持原序即得 filter 语义", () => {
    const clean = [
      { index: 2, score: 0.9 },
      { index: 0, score: 0.8 },
    ];
    const pass = relativeKeepIdxSet(clean, ruler("quantile", 8, 1));
    expect([...pass]).toEqual([2, 0]); // Set 插入序 = 分数序
    const origOrder = [0, 1, 2].filter((i) => pass.has(i));
    expect(origOrder).toEqual([0, 2]);
  });
});
