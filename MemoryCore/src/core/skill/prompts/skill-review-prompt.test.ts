/**
 * SKILL_REVIEW_PROMPT v3 合同测试。
 *
 * 背景：v2 把 v1 的三道闸全部移除并改成 "when in doubt, capture"，生产上
 * （skill.extraction.maxIterations=16）导致单个增长快照的对话被反复抽成大量
 * 一次性排障笔记/重复技能。v3 恢复最小闸门：精度优先默认、复现性测试、
 * 四条 capture gate、每次 pass 新建上限 2 条、空输出 few-shot、反转默认。
 *
 * 本测试锁的是"这些约束不会在后续编辑里悄悄丢失"，不是文案逐字比对。
 */
import { describe, it, expect } from "vitest";
import { SKILL_REVIEW_PROMPT, SKILL_REVIEW_PROMPT_VERSION } from "./skill-review-prompt.js";

const P = SKILL_REVIEW_PROMPT;

describe("SKILL_REVIEW_PROMPT v3 — 结构性合同", () => {
  it("导出非空字符串且版本标记为 v3", () => {
    expect(typeof P).toBe("string");
    expect(P.length).toBeGreaterThan(2000);
    expect(P.length).toBeLessThan(30_000);
    expect(SKILL_REVIEW_PROMPT_VERSION).toMatch(/^v3-/);
  });

  it("模板转义未泄漏：不含字面反斜杠反引号", () => {
    expect(P).not.toContain("\\`");
    expect(P).not.toContain("${");
  });

  it("保留 role isolation 段（skill-extractor 注释以此段名为锚）", () => {
    expect(P).toContain("## Role isolation");
    expect(P).toContain("<<end-of-transcript>>");
    expect(P).toContain("past-assistant");
  });

  it("输出契约仍是二选一，且 Nothing to save. 逐字保留", () => {
    expect(P).toContain("## Output contract");
    expect(P).toContain("Nothing to save.");
    // 句子级精确形态（大小写敏感、单行）必须写明
    expect(P).toMatch(/`Nothing to save.`/);
    for (const tool of ["skill_list", "skill_view", "skill_create", "skill_update", "skill_patch", "skill_files_write"]) {
      expect(P).toContain(tool);
    }
  });
});

describe("SKILL_REVIEW_PROMPT v3 — 精度优先默认（v2 回归防线）", () => {
  it("默认是沉默：when in doubt → Nothing to save.", () => {
    expect(P).toContain("Precision over recall");
    expect(P.toLowerCase()).toContain("when in doubt");
    // 反转后的默认必须落在 Nothing to save 上，而不是 capture
    expect(P).toMatch(/when in doubt[^.]*Nothing to save\./i);
  });

  it("v2 的过度抽取口号已被移除", () => {
    const banned = [
      "default to capturing it",
      "When in doubt whether a candidate",
      "An unused skill is cheap",
      "write it and refine later",
      "prefer write it and refine later",
      "Capture anything the same user / agent scope would plausibly benefit from",
      "Everything else is fair game",
      "0–5 tool calls per pass",
    ];
    for (const s of banned) {
      expect(P, `v2 加速器文案不应残留: ${s}`).not.toContain(s);
    }
  });

  it("空输出 few-shot 至少 4 个（Mem0 式负例校准）", () => {
    const empties = P.match(/Nothing to save\./g) ?? [];
    expect(empties.length).toBeGreaterThanOrEqual(6);
    expect(P).toContain("calibrating examples");
    // 负例要覆盖：一次性 / 单事实 / 瞬时 / 已有覆盖
    expect(P).toMatch(/one-off/i);
    expect(P).toMatch(/transient/i);
    expect(P).toMatch(/already covered/i);
  });
});

describe("SKILL_REVIEW_PROMPT v3 — 闸门与配额", () => {
  it("复现性测试三问齐备", () => {
    expect(P).toContain("recurrence test");
    for (const k of ["Repeatable", "Non-trivial", "Durable"]) {
      expect(P).toContain(k);
    }
  });

  it("四条 capture gate 齐备", () => {
    for (const g of ["G1", "G2", "G3", "G4"]) {
      expect(P, `缺少 ${g}`).toContain(g);
    }
    expect(P).toContain("Recurrence evidence");
    expect(P).toContain("No secrets");
  });

  it("每次 pass 新建技能硬上限 = 2", () => {
    expect(P).toMatch(/at most 2 new skills per pass/i);
    expect(P).toContain("skill_patch");
    // 优先级：patch → update → create
    expect(P).toMatch(/Creating is the last resort/);
  });

  it("三类技能口径保留（窄范围仍算技能），但以闸门为准", () => {
    expect(P).toContain("SOP-type");
    expect(P).toContain("Background-type");
    expect(P).toContain("Preference-type");
    expect(P).toMatch(/narrow scope is fine|Narrow scope is fine/i);
  });

  it("安全规则未被削弱", () => {
    expect(P).toContain("protected: true");
    expect(P).toContain("expected_version");
    expect(P).toMatch(/credentials|tokens/i);
  });
});
