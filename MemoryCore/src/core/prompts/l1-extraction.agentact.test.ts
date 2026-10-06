import { describe, it, expect } from "vitest";
import { getExtractMemoriesSystemPrompt, FINAL_FORMAT_SENTENCE } from "./l1-extraction.js";

describe("l1 提取 prompt 的 agent 行为视角（P1 gated）", () => {
  it("开关关（缺省）：prompt 与现状字符串相等（逐位现状）", () => {
    const legacy = getExtractMemoriesSystemPrompt();
    expect(legacy).not.toContain("agent 行为事实");
    expect(legacy).toBe(getExtractMemoriesSystemPrompt("chat", {}));
  });

  it("开关开（mode=chat）：prompt 含 agent 行为事实指令段（第一人称、宁缺毋滥）", () => {
    const p = getExtractMemoriesSystemPrompt("chat", { selfIdentityEnabled: true });
    expect(p).toContain("agent 行为事实");
    expect(p).toContain("第一人称");
    expect(p).toContain("宁缺毋滥");
    // P1-1 改稿后：块追加在 base 尾部、收口句之前（FINAL 由 selector 统一垫底）
    const plain = getExtractMemoriesSystemPrompt("chat");
    expect(p.startsWith(plain.slice(0, plain.length - FINAL_FORMAT_SENTENCE.length))).toBe(true); // 块=追加，常量体零改动
    expect(p.endsWith(FINAL_FORMAT_SENTENCE)).toBe(true); // 收口句永远是最后一句
  });

  it("mode=code：即使开关开也不注入（work 记忆与自我层无关）", () => {
    expect(getExtractMemoriesSystemPrompt("code", { selfIdentityEnabled: true })).not.toContain("agent 行为事实");
  });
});
