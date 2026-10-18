/**
 * S19（#57）：锚 shadow 定标行分析器——纯函数单测。
 * 输入行形状=soul-anchor-shadow-sink.ts:17-19 的 jsonl 行：
 * {ts,agentId,threshold,rowsScored:[{valueId,score}],wouldSelect,actuallySelected,agree}。
 * 哲学同 D7 ε 定标：先看分布再定标，不拍脑袋阈值。
 */
import { describe, expect, it } from "vitest";
import { analyzeAnchorShadowRows } from "../anchor-shadow-stats.js";

const r = (score: number, valueId = "v1") => ({ valueId, score });

describe("S19 analyzeAnchorShadowRows", () => {
  it("空输入：全零、无锚、曲线仍是默认档位", () => {
    const s = analyzeAnchorShadowRows([]);
    expect(s.totalLines).toBe(0);
    expect(s.badLines).toBe(0);
    expect(s.agreeCount).toBe(0);
    expect(s.agreeRate).toBe(0);
    expect(s.anchorFrequency).toEqual([]);
    expect(s.scoreQuantiles.p50).toBe(0);
    expect(s.thresholdCurve.length).toBeGreaterThan(0);
    for (const t of s.thresholdCurve) {
      expect(t.avgSelected).toBe(0);
      expect(t.passRate).toBe(0);
    }
  });

  it("坏行跳过并计数：rowsScored 非数组 / 分数非有限 / valueId 非串", () => {
    const rows = [
      {},
      { rowsScored: "x" },
      { rowsScored: [{ valueId: "v1", score: "nan" }] },
      { rowsScored: [{ valueId: 7, score: 0.5 }] },
      { rowsScored: [r(0.8)] },
    ];
    const s = analyzeAnchorShadowRows(rows);
    expect(s.badLines).toBe(4);
    expect(s.totalLines).toBe(1);
    expect(s.scoreQuantiles.p50).toBeCloseTo(0.8);
  });

  it("agree 率只统计带布尔 agree 的行", () => {
    const rows = [
      { rowsScored: [r(0.9)], agree: true },
      { rowsScored: [r(0.1)], agree: false },
      { rowsScored: [r(0.5)] },
      { rowsScored: [r(0.2)], agree: "yes" },
    ];
    const s = analyzeAnchorShadowRows(rows);
    expect(s.agreeCount).toBe(1);
    expect(s.agreeRate).toBeCloseTo(1 / 2);
  });

  it("分数分位数线性插值（平铺全部 rowsScored 分数）", () => {
    const rows = [
      { rowsScored: [r(0.1), r(0.3)] },
      { rowsScored: [r(0.5)] },
      { rowsScored: [r(0.2), r(0.4)] },
    ];
    const s = analyzeAnchorShadowRows(rows);
    expect(s.scoreQuantiles.p50).toBeCloseTo(0.3);
    expect(s.scoreQuantiles.p25).toBeCloseTo(0.2);
    expect(s.scoreQuantiles.p95).toBeCloseTo(0.48);
  });

  it("锚频率计数与排序：wouldSelect desc，再 valueId localeCompare", () => {
    const rows = [
      { rowsScored: [r(0.9, "a"), r(0.8, "b"), r(0.7, "c")], wouldSelect: ["a", "b"], actuallySelected: ["b"] },
      { rowsScored: [r(0.6, "a")], wouldSelect: ["a"], actuallySelected: [] },
      { rowsScored: [r(0.5, "c")], wouldSelect: ["c"], actuallySelected: ["c"] },
    ];
    const s = analyzeAnchorShadowRows(rows);
    expect(s.anchorFrequency.map((x) => x.valueId)).toEqual(["a", "b", "c"]);
    const a = s.anchorFrequency[0];
    expect(a.wouldSelectCount).toBe(2);
    expect(a.actuallySelectedCount).toBe(0);
    expect(a.scoredCount).toBe(2);
  });

  it("thresholdCurve：给定档位的均值选中数与至少一条通过率", () => {
    const rows = [
      { rowsScored: [r(0.9, "a"), r(0.2, "b")], wouldSelect: ["a"], actuallySelected: ["a"] },
      { rowsScored: [r(0.3, "a")], wouldSelect: ["a"], actuallySelected: [] },
    ];
    const s = analyzeAnchorShadowRows(rows, { thresholds: [0.5] });
    expect(s.thresholdCurve).toHaveLength(1);
    const t = s.thresholdCurve[0];
    expect(t.threshold).toBe(0.5);
    expect(t.avgSelected).toBeCloseTo(0.5);
    expect(t.passRate).toBeCloseTo(0.5);
  });

  it("wouldSelect/actuallySelected 非数组 → 整行仍计分但频率不炸", () => {
    const rows = [{ rowsScored: [r(0.5, "a")], wouldSelect: "a", actuallySelected: null }];
    const s = analyzeAnchorShadowRows(rows);
    expect(s.totalLines).toBe(1);
    expect(s.anchorFrequency[0].valueId).toBe("a");
    expect(s.anchorFrequency[0].wouldSelectCount).toBe(0);
  });
});