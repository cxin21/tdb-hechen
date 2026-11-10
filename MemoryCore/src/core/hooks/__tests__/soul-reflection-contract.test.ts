/**
 * 结论卡原子性机械门（#77 Batch D）。
 *
 * 2026-11-07（T1）：身份叙事契约与卡片契约（cardContract/conclusionContract 提示词门）
 * 随「提案 + 人工采纳」通道删除；本套件只保留 validateConclusionCard 的现存契约。
 */
import { describe, expect, it } from "vitest";
import {
  REFLECTION_CONCLUSION_CONTRACT_PROMPT,
  REFLECTION_CONCLUSION_MAX_CHARS,
  validateConclusionCard,
} from "../soul-reflection-contract.js";

describe("#77 Batch D validateConclusionCard（结论卡原子性机械门 · survey F1）", () => {
  it("空串/纯空白 → empty-content", () => {
    expect(validateConclusionCard("")).toMatchObject({ ok: false, reason: "empty-content" });
    expect(validateConclusionCard("   ")).toMatchObject({ ok: false, reason: "empty-content" });
  });

  it("非串（null/undefined/数字）→ empty-content（写入 rec.content 须为串）", () => {
    expect(validateConclusionCard(null)).toMatchObject({ ok: false, reason: "empty-content" });
    expect(validateConclusionCard(undefined)).toMatchObject({ ok: false, reason: "empty-content" });
    expect(validateConclusionCard(123)).toMatchObject({ ok: false, reason: "empty-content" });
  });

  it("300 码点内 → ok", () => {
    expect(validateConclusionCard("一句话结论。")).toMatchObject({ ok: true });
    expect(validateConclusionCard("长".repeat(300))).toMatchObject({ ok: true });
  });

  it("301 码点 → content-too-long（复用 l1-extraction.ts:38 原子性上限同刻度）", () => {
    expect(validateConclusionCard("长".repeat(301))).toMatchObject({ ok: false, reason: "content-too-long" });
  });

  it("码点刻度：emoji（UTF-16 双单元）按码点计——300 个通过、301 拒绝", () => {
    expect(validateConclusionCard("\u{1F600}".repeat(300))).toMatchObject({ ok: true });
    expect(validateConclusionCard("\u{1F600}".repeat(301))).toMatchObject({ ok: false, reason: "content-too-long" });
  });

  it("上限常量 = 300 且契约提示点名拆条要求", () => {
    expect(REFLECTION_CONCLUSION_MAX_CHARS).toBe(300);
    expect(REFLECTION_CONCLUSION_CONTRACT_PROMPT).toContain("一句话一件事");
    expect(REFLECTION_CONCLUSION_CONTRACT_PROMPT).toContain("宁缺毋滥");
  });
});
