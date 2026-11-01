import { describe, it, expect } from "vitest";
import { MEMORY_TOOLS_GUIDE, MEMORY_TOOLS_GUIDE_VERSION } from "./memory-tools-guide.js";
import {
  ANSWER_CURRENCY_HEADER,
  ANSWER_CURRENCY_RULES,
  ANSWER_PREFERENCE_HEADER,
  ANSWER_PREFERENCE_RULES,
} from "./answer-guidance.js";

/**
 * 单一源文案的**内容纪律**守卫（#146 拒答纪律的读侧收口）。
 *
 * 历史：这条纪律原先由 `__tests__/openclaw-format-parity.test.ts` 守着，但那个测试的
 * 主体是「OpenClaw 插件镜像 ≡ MemoryCore 单一源」的逐字 parity。OpenClaw 宿主已在
 * DSH 特化里退场（插件包与镜像副本一并删除），parity 失去一半主体，于是把「文案本身
 * 不得回到诱导拒答」这半条搬到这里——它属于单一源所在的模块，不属于任何宿主的镜像。
 *
 * 为什么必须守：历史上 guide 曾写成「不足以回答 → 请直接根据已有信息回复」，模型据此
 * 在有记忆的情况下也会拒答。文案回退不会被类型系统发现，只能靠断言。
 */
describe("memory-tools-guide：单一源文案不得回到诱导拒答", () => {
  it("版本号已标注（改动文案必须同步 bump）", () => {
    expect(MEMORY_TOOLS_GUIDE_VERSION).toMatch(/memory-tools-guide-v/);
  });

  it("不含诱导拒答措辞", () => {
    for (const banned of ["不足以回答", "请直接根据已有信息回复", "仅作为参考"]) {
      expect(MEMORY_TOOLS_GUIDE).not.toContain(banned);
    }
  });

  it("纪律的另一半显式写出：有相关记忆就得答", () => {
    expect(MEMORY_TOOLS_GUIDE).toContain("不要因为记忆不完整而拒答");
  });
});

describe("answer-guidance：单一源口径自带标题与规则组", () => {
  it("币值/建议两组标题与规则非空且自成段落", () => {
    expect(ANSWER_CURRENCY_HEADER.length).toBeGreaterThan(0);
    expect(ANSWER_PREFERENCE_HEADER.length).toBeGreaterThan(0);
    expect(ANSWER_CURRENCY_RULES.length).toBeGreaterThan(0);
    expect(ANSWER_PREFERENCE_RULES.length).toBeGreaterThan(0);
    for (const line of [...ANSWER_CURRENCY_RULES, ...ANSWER_PREFERENCE_RULES]) {
      expect(line.trim().length).toBeGreaterThan(0);
      expect(line).not.toContain("不足以回答");
    }
  });
});