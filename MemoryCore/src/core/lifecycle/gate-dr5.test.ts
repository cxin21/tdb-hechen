/**
 * P3 终测缺陷修复（TDD）：D-R5-3 门两形态 + D-R5-4 existing 行清洗。
 */
import { describe, it, expect, vi } from "vitest";
import { runIdentityDiscovery, isIdentityImposition, mergeIdentityFacts } from "./identity-discovery.js";

describe("D-R5-3 门两形态（ev11 实证绕过）", () => {
  it("agent 自述复述形态「我以X的身份与用户交流」→ true", () => {
    expect(isIdentityImposition("我以专业资深猎头顾问的身份与用户交流")).toBe(true);
    expect(isIdentityImposition("我以资深顾问的身份跟用户对话")).toBe(true);
  });
  it("周期提醒/定时状态形态 → true", () => {
    expect(isIdentityImposition("我每晚九点提醒用户冥想")).toBe(true);
    expect(isIdentityImposition("我每天早上八点提醒用户复盘")).toBe(true);
    expect(isIdentityImposition("从今天开始每天提醒用户喝水")).toBe(true);
  });
  it("误报面：合法自证不受新形态误杀", () => {
    expect(isIdentityImposition("我承诺每周五出周报")).toBe(false);
    expect(isIdentityImposition("我的工作风格是先给结论再给细节")).toBe(false);
    expect(isIdentityImposition("我承担 TDB 改动后的全面验证职责")).toBe(false);
    expect(isIdentityImposition("我把用户当朋友一样坦诚")).toBe(false);
  });
});

describe("D-R5-4 mergeIdentityFacts existing 行清洗", () => {
  it("existing 污染行被门清洗（猎头人设不再随演化永存）", () => {
    const existing = "- 我以专业资深猎头顾问的身份与用户交流\n- 我承诺每周五出周报";
    const merged = mergeIdentityFacts(existing, ["新事实"]);
    expect(merged).not.toContain("猎头");
    expect(merged).toContain("周报");
  });
});
