import { describe, it, expect } from "vitest";
import { getLastUserMessageText, stripInitArtifacts, type RawMessage } from "../codebuddy/cleaner.js";

/**
 * #175:anthropic 形态的答复回捞。
 *
 * v0.2 的 dsh 把用户选择写在 `role:"user"` 的 `tool_result` block 里
 * (`tool_use_id` 挂在 block 上),而不是 v0.1 的 `role:"tool"` + `tool_call_id`。
 * CB 状态机靠 getLastUserMessageText 取答复,取不到就会原地重弹表单。
 */

const TOOL_USE_ID = "call_dsh_session_init_1729000000000";

const anthropicFormTurn: RawMessage[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "" },
      { type: "tool_use", id: TOOL_USE_ID, name: "ask_user_question", input: { questions: [] } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: TOOL_USE_ID, content: [{ type: "text", text: "是，关联团队资产" }] },
    ],
  },
];

describe("cleaner / anthropic tool_result 答复", () => {
  it("从 role:user 的 tool_result block 取出答复文本", () => {
    expect(getLastUserMessageText(anthropicFormTurn)).toBe("是，关联团队资产");
  });

  it("tool_result 内层是裸字符串时也能取", () => {
    const msgs: RawMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: TOOL_USE_ID, content: "否，本次不关联" }],
      },
    ];
    expect(getLastUserMessageText(msgs)).toBe("否，本次不关联");
  });

  it("v0.1 的 role:tool + tool_call_id 形态仍然可用(回归)", () => {
    const msgs: RawMessage[] = [
      { role: "tool", tool_call_id: TOOL_USE_ID, content: "是，关联团队资产" },
    ];
    expect(getLastUserMessageText(msgs)).toBe("是，关联团队资产");
  });

  it("非 session-init 的 tool_result 不吞(不误判)", () => {
    const msgs: RawMessage[] = [
      { role: "user", content: [{ type: "text", text: "真实提问" }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_other_123", content: "别的工具输出" }],
      },
    ];
    // 命中 tool_result 分支失败 → fallback 到最后一条 user 文本
    expect(getLastUserMessageText(msgs)).toBe("别的工具输出");
  });
});

describe("cleaner / stripInitArtifacts(anthropic 形态)", () => {
  it("剥掉 assistant 的 form tool_use 与 user 的配对 tool_result", () => {
    const out = stripInitArtifacts(structuredClone(anthropicFormTurn));
    // 首条真实 user 文本保留,form 的 assistant/user 帧都剥掉
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("同一 assistant 里还有正常内容时只剥 tool_use block", () => {
    const msgs: RawMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "我先问你一个问题" },
          { type: "tool_use", id: TOOL_USE_ID, name: "ask_user_question", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: TOOL_USE_ID, content: "是，关联团队资产" }],
      },
    ];
    const out = stripInitArtifacts(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([{ type: "text", text: "我先问你一个问题" }]);
  });
});
