import { describe, expect, it } from "vitest";
import { isOneShotSubagentMessages } from "../one-shot-detect.js";

/** one-shot 子代理判定（C4-dsh Phase 2，2026-10-20 收窄）：标记只出现在 spawn
 * 子代理的 system prompt。历史上全量扫描 messages 导致主会话历史（工具结果/
 * 代码引用）里的字面量把主线请求误判为子代理 → PTC 预检被永久跳过（#72 复盘）。 */
describe("isOneShotSubagentMessages", () => {
  it("system 消息含标记 → true", () => {
    const msgs = [
      { role: "system", content: "You are a subagent. [[one-shot-subagent]]" },
      { role: "user", content: "hi" },
    ];
    expect(isOneShotSubagentMessages(msgs)).toBe(true);
  });

  it("仅 user/tool 历史含标记（主会话代码引用）→ false", () => {
    const msgs = [
      { role: "system", content: "You are the main agent." },
      { role: "user", content: "edit handler" },
      { role: "tool", content: "const m = \"[[one-shot-subagent]]\"; // quoted code" },
      { role: "assistant", content: "patched [[one-shot-subagent]] detection" },
    ];
    expect(isOneShotSubagentMessages(msgs)).toBe(false);
  });

  it("标记在多条 system 时仍命中", () => {
    const msgs = [
      { role: "system", content: "base" },
      { role: "system", content: "spawn ctx [[one-shot-subagent]]" },
    ];
    expect(isOneShotSubagentMessages(msgs)).toBe(true);
  });

  it("content 为分段数组时拼接扫描", () => {
    const msgs = [
      { role: "system", content: [{ type: "text", text: "part1 " }, { type: "text", text: "[[one-shot-subagent]]" }] },
    ];
    expect(isOneShotSubagentMessages(msgs)).toBe(true);
  });

  it("非数组/空入参 → false", () => {
    expect(isOneShotSubagentMessages(undefined)).toBe(false);
    expect(isOneShotSubagentMessages([])).toBe(false);
    expect(isOneShotSubagentMessages("not-an-array" as unknown)).toBe(false);
  });
});