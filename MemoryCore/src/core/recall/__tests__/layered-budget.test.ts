/**
 * #141（2026-10-28）：分阶段预算（槽位记账）+ 表示仲裁（结论行让位）单测。
 *
 * 第一性原理修正（票面）：
 *  ② 有效证据只有 3.5-4.5 行（maxResults=5），结论行与 turn 行是同一知识的两种表示 →
 *    零和替换。修法不是关掉结论层，而是给「结论 + 必带源证据」记一个**复合单元**的
 *    槽位成本（1.5），并让与已选 turn 行语义重复的结论行让位（表示仲裁）。
 */
import { describe, expect, it } from "vitest";

import {
  arbitrateConclusions,
  computeSlotBudget,
  contentTokens,
  overlapRatio,
} from "../layered-budget.js";

describe("#141 layered-budget：computeSlotBudget（复合单元槽位记账）", () => {
  it("2 结论 × 1.5 槽 = 3 槽 → 5 行预算剩 2 行经验 + 2 条成对证据", () => {
    const b = computeSlotBudget({ maxResults: 5, conclusionCount: 2, slotCost: 1.5, pairing: true });
    expect(b.conclusionLimit).toBe(2);
    expect(b.pairingLimit).toBe(2);
    expect(b.experienceLimit).toBe(2);
    expect(b.cost).toBe(3);
  });

  it("1 结论 → 1.5 槽 → 3 行经验（floor）", () => {
    const b = computeSlotBudget({ maxResults: 5, conclusionCount: 1, slotCost: 1.5, pairing: true });
    expect(b.experienceLimit).toBe(3);
    expect(b.cost).toBe(1.5);
  });

  it("0 结论 → 全额经验层（退化安全）", () => {
    const b = computeSlotBudget({ maxResults: 5, conclusionCount: 0, slotCost: 1.5, pairing: true });
    expect(b.conclusionLimit).toBe(0);
    expect(b.pairingLimit).toBe(0);
    expect(b.experienceLimit).toBe(5);
    expect(b.cost).toBe(0);
  });

  it("pairing=false → 不预留证据槽，成本按 1 槽记（slotCost 截到 1）", () => {
    const b = computeSlotBudget({ maxResults: 5, conclusionCount: 2, slotCost: 1.5, pairing: false });
    expect(b.pairingLimit).toBe(0);
    expect(b.cost).toBe(2);
    expect(b.experienceLimit).toBe(3);
  });

  it("clamp：slotCost 越界取 [1,3]；负结论数/非有限→0；经验层不为负", () => {
    expect(computeSlotBudget({ maxResults: 5, conclusionCount: 2, slotCost: 9, pairing: true }).cost).toBe(6);
    expect(computeSlotBudget({ maxResults: 5, conclusionCount: 2, slotCost: 0.1, pairing: true }).cost).toBe(2);
    const b = computeSlotBudget({ maxResults: 5, conclusionCount: Number.NaN, slotCost: 1.5, pairing: true });
    expect(b.conclusionLimit).toBe(0);
    expect(b.experienceLimit).toBe(5);
    const big = computeSlotBudget({ maxResults: 5, conclusionCount: 9, slotCost: 1.5, pairing: true });
    expect(big.experienceLimit).toBe(0);
  });
});

describe("#141 layered-budget：contentTokens / overlapRatio", () => {
  it("英文取词、中文取 bigram，单字噪声忽略", () => {
    const t = contentTokens("My new internet plan is 500 Mbps");
    expect(t).toContain("internet");
    expect(t).toContain("plan");
    expect(contentTokens("我用的是千兆宽带")).toContain("千兆");
    expect(contentTokens("")).toEqual([]);
  });

  it("overlapRatio = 结论 token 被 turn 行覆盖的比例", () => {
    const conclusion = "User's new internet plan is 500 Mbps.";
    const turn = "User: My new internet plan is 500 Mbps, installed today.";
    expect(overlapRatio(conclusion, turn)).toBeGreaterThanOrEqual(0.75);
    const unrelated = "Assistant: The vegan eatery is called Greens.";
    expect(overlapRatio(conclusion, unrelated)).toBeLessThan(0.3);
  });
});

describe("#141 layered-budget：arbitrateConclusions（表示仲裁）", () => {
  const experienceLines = [
    "- [episodic|网络] User: My new internet plan is 500 Mbps, installed today.",
    "- [episodic|宠物] User: I adopted a cat named Mochi.",
  ];

  it("与 turn 行语义重复的结论被丢弃（turn 更有信息量）", () => {
    const conclusions = [
      "- [结论|网络] User's new internet plan is 500 Mbps.",
      "- [结论|宠物] User adopted a cat named Mochi last spring and loves it.",
    ];
    const r = arbitrateConclusions({ conclusions, experienceLines, threshold: 0.75 });
    expect(r.kept).toEqual([1]);
    expect(r.dropped).toEqual([0]);
    expect(r.reasons[0]).toMatch(/redundant/);
  });

  it("无重复 → 全部保留；无经验行 → 全部保留", () => {
    const conclusions = ["- [结论|旅行] User visited Kyoto in April 2023."];
    expect(arbitrateConclusions({ conclusions, experienceLines, threshold: 0.75 }).kept).toEqual([0]);
    expect(arbitrateConclusions({ conclusions, experienceLines: [], threshold: 0.75 }).kept).toEqual([0]);
  });

  it("threshold 越界 clamp [0,1]；空结论 → 空结果不抛错", () => {
    const conclusions = ["- [结论|网络] User's new internet plan is 500 Mbps."];
    expect(arbitrateConclusions({ conclusions, experienceLines, threshold: 5 }).dropped).toEqual([0]);
    expect(arbitrateConclusions({ conclusions: [], experienceLines }).kept).toEqual([]);
  });
});

describe("#141 layered-budget：仲裁守卫（短结论 / 否定极性）", () => {
  // 原文行里出现结论的每个 token → 覆盖率 100%；短结论必须靠规模门槛放过，
  // 否则「答案在原文」的精确事实题（右侧最该赢的题）会被率先丢结论。
  const experienceLines = ["- [turn 2026-01-02] User: my internet plan is 500 Mbps now."];

  it("短结论（token < 4）不做冗余判定，直接保留", () => {
    const r = arbitrateConclusions({ conclusions: ["- [结论|网络] 500 Mbps"], experienceLines });
    expect(r.kept).toEqual([0]);
    expect(r.dropped).toEqual([]);
  });

  it("长结论被同义原文行完全覆盖 → 仍然让位", () => {
    const r = arbitrateConclusions({
      conclusions: ["- [结论|网络] User internet plan is 500 Mbps now"],
      experienceLines,
    });
    expect(r.dropped).toEqual([0]);
    expect(r.reasons[0]).toMatch(/^redundant:1\.00\|redundant-with:0$/);
  });

  it("否定极性相反不判冗余（英文）：doesn't support X vs supports X", () => {
    const lines = ["- [turn 2026-02-01] User: the speaker supports bluetooth audio output now"];
    const r = arbitrateConclusions({
      conclusions: ["- [结论|设备] speaker speaker does not support bluetooth audio"],
      experienceLines: lines,
    });
    expect(r.kept).toEqual([0]);
  });

  it("否定极性相反不判冗余（中文）：未支持 vs 支持", () => {
    const lines = ["- [turn 2026-02-01] 用户：这个音箱现在支持蓝牙音频输出"];
    const r = arbitrateConclusions({
      conclusions: ["- [结论|设备] 音箱未支持蓝牙音频输出功能"],
      experienceLines: lines,
    });
    expect(r.kept).toEqual([0]);
  });
});

