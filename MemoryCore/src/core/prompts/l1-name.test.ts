/**
 * R4-6 修复（TDD）：提取 prompt 姓名归因红线。
 * 依据：spec §1.2 主语三层法（内容主语必须正确）；ev10 实证「用户（林岚）的工作风格…」
 * ——LLM 在用户姓名未知时把上下文中的第三方（导师）名填进（姓名）括号，
 * 污染 L1 → persona 渲染 → 用户身份认知。
 */
import { describe, it, expect } from "vitest";
import { EXTRACT_MEMORIES_SYSTEM_PROMPT } from "./l1-extraction.js";

describe("L1 提取 prompt 姓名归因红线（R4-6）", () => {
  it("存在姓名归因硬约束：第三方姓名不得当作用户姓名", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("不得当作");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("导师");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("姓名未提供");
  });
  it("括号姓名只允许用户自称", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("自称");
  });
});
