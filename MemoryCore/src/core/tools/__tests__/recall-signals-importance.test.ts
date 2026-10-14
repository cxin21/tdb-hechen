/**
 * P1 Task 7（worthiness importance，spec §6）：重要性降权信号 + 观测 gate 纯函数单测。
 * 矩阵：importance NULL/undefined 永不罚（宁缺毋滥——未评分 ≠ 低分）；
 * ≤4 罚（×(1-penalty)）、>4 不罚；penalty 0 = 关断恒等（spec §3 不变式④）。
 * importanceGateStats：raw/penalized 双分量观测纯函数（乘子恒真实生效，shadowMode 已移除）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANK_SIGNALS,
  importanceGateStats,
  importanceMultiplierOf,
  structuralSignalOf,
  ZERO_RANK_SIGNALS,
  type RankSignalItem,
} from "../recall-signals.js";

const item = (over: Partial<RankSignalItem>): RankSignalItem => ({ ...over });

describe("P1 Task 7 importanceMultiplierOf（importance 乘法降权）", () => {
  it("importance ≤ 4 → ×(1 - penalty)", () => {
    expect(importanceMultiplierOf(item({ importance: 1 }), 0.3)).toBeCloseTo(0.7, 12);
    expect(importanceMultiplierOf(item({ importance: 4 }), 0.3)).toBeCloseTo(0.7, 12);
    expect(importanceMultiplierOf(item({ importance: 3 }), 0.5)).toBe(0.5);
  });

  it("importance > 4 → ×1（不罚）", () => {
    expect(importanceMultiplierOf(item({ importance: 5 }), 0.3)).toBe(1);
    expect(importanceMultiplierOf(item({ importance: 10 }), 0.3)).toBe(1);
    expect(importanceMultiplierOf(item({ importance: 7 }), 0.9)).toBe(1);
  });

  it("importance NULL/undefined → ×1（未评分永不罚——现状逐位）", () => {
    expect(importanceMultiplierOf(item({}), 0.3)).toBe(1);
    expect(importanceMultiplierOf(item({ importance: null }), 0.3)).toBe(1);
    expect(importanceMultiplierOf(item({ importance: undefined }), 0.9)).toBe(1);
  });

  it("penalty 0 = 关断恒等（0 = 通道完全退出）", () => {
    expect(importanceMultiplierOf(item({ importance: 1 }), 0)).toBe(1);
    expect(importanceMultiplierOf(item({ importance: 4 }), 0)).toBe(1);
  });

  it("边界：penalty 1 → 乘 0（完全沉底；clamp 上界 0.9 由 config 层负责，此处直传）", () => {
    expect(importanceMultiplierOf(item({ importance: 2 }), 1)).toBe(0);
  });
});

describe("P1 Task 7 RankSignals 常量（缺省关断）", () => {
  it("DEFAULT_RANK_SIGNALS.importancePenalty = 0（缺省关 = 零行为变化）", () => {
    expect(DEFAULT_RANK_SIGNALS.importancePenalty).toBe(0);
    expect(ZERO_RANK_SIGNALS.importancePenalty).toBe(0);
  });

  it("structuralSignalOf 不受 importance 影响（importance 只走乘法分量，非加性）", () => {
    const base = { occurred_at: "2026-09-01T00:00:00Z", metadata: {} };
    const withImp = structuralSignalOf(item({ ...base, importance: 1 }), {
      timeWindow: null,
      moodSign: 0,
      signals: { ...DEFAULT_RANK_SIGNALS },
      now: new Date("2026-09-10T00:00:00Z"),
    });
    const withoutImp = structuralSignalOf(item(base), {
      timeWindow: null,
      moodSign: 0,
      signals: { ...DEFAULT_RANK_SIGNALS },
      now: new Date("2026-09-10T00:00:00Z"),
    });
    expect(withImp).toBe(withoutImp);
  });
});

describe("P1 Task 7 importanceGateStats（journal raw/penalized 双分量观测，纯函数）", () => {
  const spec = { penalty: 0.3 };

  it("生效口径：mult 已含 importance → penalized=rrf×mult，raw 仅对 ≤4 行除回 (1-penalty) 反推", () => {
    const rows = [
      { rrfScore: 1 / 61, mult: 0.7, importance: 2 },
      { rrfScore: 0.9 / 62, mult: 1, importance: 8 },
    ];
    const g = importanceGateStats(rows, spec);
    expect(g.items).toBe(2);
    expect(g.penalized).toBe(1);
    expect(g.penalty).toBe(0.3);
    // penalized = 实际排序分：第二行不罚（0.9/62≈0.01452）压过被罚的第一行（0.7/61≈0.01148）
    expect(g.topPenalized!).toBeCloseTo(0.9 / 62, 12);
    // raw 反推：第一行除回 0.7 → 1/61（≈0.01639）= raw 榜首；第二行原样 0.9/62
    expect(g.topRaw!).toBeCloseTo(1 / 61, 12);
    expect(g.topChanged).toBe(true); // raw 冠军（第一行）被罚掉——降权真实生效的证据
  });

  it("降权翻盘矩阵（≤4 冠军被罚、>4 次名升顶）→ topChanged true（真实生效的证据）", () => {
    const rows = [
      { rrfScore: 0.02, mult: 0.7, importance: 2 },
      { rrfScore: 0.019, mult: 1, importance: 8 },
    ];
    const g = importanceGateStats(rows, spec);
    expect(g.topRaw!).toBeCloseTo(0.02, 12);
    expect(g.topPenalized!).toBeCloseTo(0.019, 12); // 次名不被罚升顶
    expect(g.topChanged).toBe(true);
  });

  it("importance NULL/undefined 永不进 penalized 计数（宁缺毋滥）", () => {
    const rows = [
      { rrfScore: 0.01, mult: 1, importance: null },
      { rrfScore: 0.02, mult: 1 },
      { rrfScore: 0.03, mult: 1, importance: 4 },
    ];
    const g = importanceGateStats(rows, spec);
    expect(g.items).toBe(3);
    expect(g.penalized).toBe(1);
  });

  it("空池 → items 0 / 无 top 分 / topChanged false（调用方零动作）", () => {
    const g = importanceGateStats([], spec);
    expect(g.items).toBe(0);
    expect(g.penalized).toBe(0);
    expect(g.topRaw).toBeUndefined();
    expect(g.topPenalized).toBeUndefined();
    expect(g.topChanged).toBe(false);
  });

  it("冠军不变（降权不翻盘）→ topChanged false", () => {
    const rows = [
      { rrfScore: 0.05, mult: 1, importance: 9 },
      { rrfScore: 0.004, mult: 1, importance: 1 },
    ];
    const g = importanceGateStats(rows, spec);
    expect(g.topChanged).toBe(false);
    expect(g.penalized).toBe(1);
  });
});
