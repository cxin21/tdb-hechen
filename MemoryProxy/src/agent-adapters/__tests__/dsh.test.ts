import { describe, it, expect } from "vitest";
import { dshAdapter } from "../dsh.js";

/**
 * #175:agent-adapters/dsh 必须同时认 v0.1(openai)与 v0.2(anthropic)的 wire shape。
 *
 * 关键回归点:
 *   - title-gen 的 system 提示词在 v0.2 挪到 body.system,漏认 → 标题请求被当
 *     main 吃满注入管线。
 *   - v0.2 的 max/thinking 字段可能与 v0.1 不同(thinking 可能整体缺省),判定
 *     不能要求 `thinking.type === "disabled"`。
 *   - user content 是 block array,text block 才是用户键入的文本。
 */

const TITLE_PREFIX = "Create a concise title for an AI coding-assistant session";

describe("dsh adapter / classifyRequest 双协议", () => {
  it("v0.2 title-gen:system 在 body.system(block array)→ auxiliary", () => {
    expect(dshAdapter.classifyRequest({
      system: [{ type: "text", text: TITLE_PREFIX + " based on the conversation." }],
      messages: [{ role: "user", content: [{ type: "text", text: "帮我改个 bug" }] }],
      tools: [],
      max_tokens: 64,
      // v0.2 可能整体不带 thinking 字段
    })).toBe("auxiliary");
  });

  it("v0.2 title-gen:body.system 是纯字符串 → auxiliary", () => {
    expect(dshAdapter.classifyRequest({
      system: TITLE_PREFIX + " based on the conversation.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      max_tokens: 128,
    })).toBe("auxiliary");
  });

  it("v0.2 主对话(有 tools)→ main", () => {
    expect(dshAdapter.classifyRequest({
      system: [{ type: "text", text: TITLE_PREFIX + " (should not matter)" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "run_code", input_schema: { type: "object" } }],
      max_tokens: 64,
    })).toBe("main");
  });

  it("v0.2 主对话(max_tokens 很大 / thinking enabled)→ main", () => {
    expect(dshAdapter.classifyRequest({
      system: [{ type: "text", text: TITLE_PREFIX }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      max_tokens: 8192,
    })).toBe("main");
    expect(dshAdapter.classifyRequest({
      system: [{ type: "text", text: TITLE_PREFIX }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      max_tokens: 64,
      thinking: { type: "enabled", budget_tokens: 2048 },
    })).toBe("main");
  });

  it("v0.1 title-gen:messages[0].role=system 的老 shape 仍然 auxiliary(回归)", () => {
    expect(dshAdapter.classifyRequest({
      messages: [
        { role: "system", content: TITLE_PREFIX + " based on the conversation." },
        { role: "user", content: "帮我改个 bug" },
      ],
      tools: [],
      max_tokens: 64,
      thinking: { type: "disabled" },
    })).toBe("auxiliary");
  });

  it("compact header 仍然 auxiliary", () => {
    expect(dshAdapter.classifyRequest(
      { messages: [], tools: [{ name: "x" }] },
      "/dsh/1/v1/messages",
      { "x-deepseek-harness-compact": "1" },
    )).toBe("auxiliary");
  });
});

describe("dsh adapter / extractUserText 双协议", () => {
  it("v0.1:content 是字符串", () => {
    expect(dshAdapter.extractUserText("mem:help")).toBe("mem:help");
  });

  it("v0.2:text block array → 拼接文本", () => {
    expect(dshAdapter.extractUserText([
      { type: "text", text: "mem:help" },
    ])).toBe("mem:help");
    expect(dshAdapter.extractUserText([
      { type: "text", text: "第一行" },
      { type: "text", text: "第二行" },
    ])).toBe("第一行\n第二行");
  });

  it("v0.2:system-reminder 之外的 tool_result 被跳过", () => {
    expect(dshAdapter.extractUserText([
      { type: "text", text: "用户真说的话" },
      { type: "tool_result", tool_use_id: "call_x", content: "工具输出" },
      { type: "thinking", thinking: "内部思考" },
    ])).toBe("用户真说的话");
  });

  it("v0.2:只有 tool_result(表单答复)→ null,让调用方继续往前找", () => {
    expect(dshAdapter.extractUserText([
      { type: "tool_result", tool_use_id: "call_dsh_session_init_1", content: "是，关联团队资产" },
    ])).toBeNull();
  });

  it("空字符串 / 非 string 非 array → null", () => {
    expect(dshAdapter.extractUserText("")).toBeNull();
    expect(dshAdapter.extractUserText(42)).toBeNull();
    expect(dshAdapter.extractUserText(null)).toBeNull();
  });
});
