import { describe, it, expect } from "vitest";
import {
  buildFormResponse,
  TOOL_NAME,
  TOOLCALL_PREFIX,
  ASSET_CONFIRM_YES,
  ASSET_CONFIRM_NO,
  type FormData,
} from "../dsh/form.js";

/**
 * #175:dsh form 帧的双协议 builder。
 *
 * v0.1.x(openai)= chat.completion(chunk / 单帧),v0.2+(anthropic)= Anthropic
 * Messages(tool_use 六事件 SSE / 单帧 message)。两种都必须能渲染出同一个
 * ask_user_question 表单,且 anthropic 帧要带空 thinking 占位(见 form.ts 头注)。
 */

const ASSET_CONFIRM_FORM: FormData = {
  teams: [],
  stage: "asset_confirm",
  stream: false,
  modelId: "deepseek-chat",
};

type SseEvent = { event: string; data: Record<string, unknown> };

function parseSse(raw: string): SseEvent[] {
  return raw
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = (lines.find((l) => l.startsWith("event: ")) ?? "").slice(7);
      const dataLine = lines.find((l) => l.startsWith("data: ")) ?? "";
      return { event, data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> };
    });
}

describe("dsh form response / anthropic 协议", () => {
  it("non-stream:单帧 message,thinking 占位 + tool_use 表单", async () => {
    const res = buildFormResponse({ ...ASSET_CONFIRM_FORM, protocol: "anthropic" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;

    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.id.startsWith("msg_")).toBe(true);
    expect(body.stop_reason).toBe("tool_use");
    expect(body.usage).toEqual({ input_tokens: 0, output_tokens: 0 });

    // block 0 = 空 thinking 占位(thinking 字段必须存在且是 string)
    expect(body.content[0].type).toBe("thinking");
    expect(typeof body.content[0].thinking).toBe("string");
    expect(body.content[0].signature).toBe("");

    // block 1 = tool_use,id 前缀仍是 proxy 回捞锚点,名字是 dsh 原生 snake_case
    const toolUse = body.content[1];
    expect(toolUse.type).toBe("tool_use");
    expect(toolUse.name).toBe(TOOL_NAME);
    expect(toolUse.id.startsWith(TOOLCALL_PREFIX)).toBe(true);
    // anthropic 的 input 是**对象**(不是 JSON 字符串)
    expect(typeof toolUse.input).toBe("object");
    expect(toolUse.input.questions[0].id).toBe("asset_confirm");
    expect(toolUse.input.questions[0].multi_select).toBe(false);
  });

  it("non-stream:选项目文案是全角逗号(与 extractor 精准匹配)", async () => {
    const res = buildFormResponse({ ...ASSET_CONFIRM_FORM, protocol: "anthropic" });
    const body = await res.json() as Record<string, any>;
    const labels = body.content[1].input.questions[0].options.map((o: any) => o.label);
    expect(labels).toEqual([ASSET_CONFIRM_YES, ASSET_CONFIRM_NO]);
    expect(labels[0]).toContain("，");
    expect(labels[0]).not.toContain(",");
  });

  it("stream:六事件 tool_use SSE,thinking block 0 + tool_use block 1", async () => {
    const res = buildFormResponse({ ...ASSET_CONFIRM_FORM, stream: true, protocol: "anthropic" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await res.text());

    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const start = events[0].data.message as Record<string, any>;
    expect(start.type).toBe("message");
    expect(start.content).toEqual([]);
    expect(start.stop_reason).toBeNull();

    // block 0: thinking 占位
    expect((events[1].data.content_block as any).type).toBe("thinking");
    expect((events[2].data.delta as any).type).toBe("thinking_delta");
    expect((events[2].data.delta as any).thinking).toBe("");

    // block 1: tool_use;input 以 input_json_delta 的 partial_json 下发
    expect(events[4].data.index).toBe(1);
    const block = events[5].data as Record<string, any>;
    expect(block.index).toBe(1);
    expect(block.delta.type).toBe("input_json_delta");
    const parsed = JSON.parse(block.delta.partial_json as string);
    expect(parsed.questions[0].id).toBe("asset_confirm");

    // 收尾:message_delta 报 tool_use,message_stop 收流
    expect((events[7].data.delta as any).stop_reason).toBe("tool_use");
    expect(events[8].data.type).toBe("message_stop");
  });
});

describe("dsh form response / openai 协议(v0.1 回归)", () => {
  it("non-stream:reasoning_content 占位 + tool_calls + finish_reason", async () => {
    const res = buildFormResponse({ ...ASSET_CONFIRM_FORM, protocol: "openai" });
    const body = await res.json() as Record<string, any>;
    expect(body.object).toBe("chat.completion");
    const msg = body.choices[0].message;
    expect(typeof msg.reasoning_content).toBe("string");
    expect(msg.reasoning_content.length).toBeGreaterThan(0);
    expect(msg.tool_calls[0].function.name).toBe(TOOL_NAME);
    expect(msg.tool_calls[0].id.startsWith(TOOLCALL_PREFIX)).toBe(true);
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    // OpenAI 的 arguments 是 **JSON 字符串**
    expect(typeof msg.tool_calls[0].function.arguments).toBe("string");
  });

  it("stream:chunk 序 = role+tool_call / arguments delta / finish / DONE", async () => {
    const res = buildFormResponse({ ...ASSET_CONFIRM_FORM, stream: true, protocol: "openai" });
    const raw = await res.text();
    const chunks = raw
      .split("\n\n")
      .map((c) => c.trim())
      .filter((c) => c.startsWith("data: "))
      .map((c) => c.slice(6));

    expect(chunks[chunks.length - 1]).toBe("[DONE]");
    const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c) as Record<string, any>);
    expect(parsed[0].choices[0].delta.role).toBe("assistant");
    expect(parsed[0].choices[0].delta.tool_calls[0].function.name).toBe(TOOL_NAME);

    // 拼接 arguments delta 后应能解析成同一个表单 input
    const args = parsed
      .map((p) => p.choices[0].delta.tool_calls?.[0]?.function?.arguments ?? "")
      .join("");
    const input = JSON.parse(args);
    expect(input.questions[0].id).toBe("asset_confirm");

    const finish = parsed.find((p) => p.choices[0].finish_reason);
    expect(finish?.choices[0].finish_reason).toBe("tool_calls");
  });
});
