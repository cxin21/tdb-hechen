/**
 * #39（ADR0003-P3 / 接线票 A，2026-10-16）：tools.before_call 分发层接线。
 *
 * 合同（#37 首交付「接口冻结 + 分发层未接线 owner=proxy 分发层」→ 本票闭合）：
 *   - executionOrder 纳入 "tools.before_call"（置于 user.after 之后——事件块落位最近端）；
 *   - applyByPoint 落位：anthropic 形状尾消息（user 载 tool_result）→ 追加 text 块
 *     （tool_result 在前、text 在后，Claude 生产模式合法形状）；
 *     openai 形状尾消息（role=tool，serialize 只取 tool_result 块会丢附加 text）→
 *     插入新 user 消息承载事件块；
 *   - 同管线同内容 event 块去重（cacheKey 指纹，#34/#32 先例）；
 *   - 缺省（无 hook 产出块）→ 请求逐位现状（serialize round-trip 深等 golden）；
 *   - onHookDone 透传 requestId（#38 请求级唯一 id）。
 */
import { describe, expect, it } from "vitest";
import { InjectionPipeline } from "../pipeline.js";
import { HookRegistryImpl } from "../registry.js";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import { OpenAIAdapter } from "../adapters/openai.js";
import type {
  AgentContextMetadata,
  ContextBlock,
  InjectionHook,
} from "../types.js";
import type { ProtocolAdapter } from "../adapters/interface.js";
import type { InjectionObserver } from "../observer.js";

const REDLINE = '<soul-event kind="redline">\n## 不可逾越（红线）\n- [strict_rule] 测试红线原文\n</soul-event>';

function makeRedlineHook(content = REDLINE, id = "fake-redline-event"): InjectionHook {
  return {
    id,
    point: "tools.before_call",
    priority: 100,
    description: "test fake redline event hook",
    execute: async (): Promise<ContextBlock[]> => [
      { type: "text", content, metadata: { source: id, soulBlockKind: "soul.event" } },
    ],
  };
}

function makeUserAfterHook(): InjectionHook {
  return {
    id: "fake-user-after",
    point: "user.after",
    priority: 100,
    description: "test fake user-after hook",
    execute: async (): Promise<ContextBlock[]> => [{ type: "text", content: "USER_AFTER_BLOCK" }],
  };
}

function makeCacheKeyedHook(content: string, cacheKey: string, id: string): InjectionHook {
  return {
    id,
    point: "tools.before_call",
    priority: 100,
    description: "test cache-keyed redline event hook",
    execute: async (): Promise<ContextBlock[]> => [
      { type: "text", content, metadata: { source: id, soulBlockKind: "soul.event", cacheKey } },
    ],
  };
}

const ANTHROPIC_BODY = {
  model: "claude-x",
  system: "sys",
  messages: [
    { role: "user", content: [{ type: "text", text: "开始任务" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents" }] },
  ],
};

const OPENAI_BODY = {
  model: "gpt-x",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "开始任务" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "tc1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "tc1", content: "file contents" },
  ],
};

function meta(protocol: "anthropic" | "openai"): AgentContextMetadata {
  return {
    protocol,
    traceId: "t",
    keyId: "k",
    modelId: "m",
    stream: false,
    agentSource: "claude-code",
  } as AgentContextMetadata;
}

function makePipeline(hooks: InjectionHook[], observer?: InjectionObserver): InjectionPipeline {
  const registry = new HookRegistryImpl();
  for (const h of hooks) registry.register(h);
  const adapters = new Map<string, ProtocolAdapter>([
    ["anthropic", new AnthropicAdapter()],
    ["openai", new OpenAIAdapter()],
  ]);
  return new InjectionPipeline(registry, adapters, {}, observer);
}

type DoneCall = { hookId: string; point: string; blockCount: number; requestId?: string };

class RecordingObserver implements InjectionObserver {
  done: DoneCall[] = [];
  onPipelineStart(): void {}
  onPipelineEnd(): void {}
  onPipelineError(): void {}
  onHookStart(): void {}
  onHookError(): void {}
  onHookDone(
    hook: InjectionHook,
    _point: string,
    blocks: ContextBlock[],
    _durationMs: number,
    _cacheStrategy?: string,
    requestId?: string,
  ): void {
    this.done.push({ hookId: hook.id, point: _point, blockCount: blocks.length, requestId });
  }
}

describe("#39 tools.before_call 分发层接线", () => {
  it("anthropic 形状：事件块追加到尾消息（tool_result 在前、text 在后）", async () => {
    const pipeline = makePipeline([makeRedlineHook()]);
    const out = await pipeline.process(ANTHROPIC_BODY, meta("anthropic"));

    const tail = (out.messages as Array<Record<string, unknown>>)[2];
    expect(tail.role).toBe("user");
    expect(tail.content).toEqual([
      { type: "tool_result", tool_use_id: "tu1", content: "file contents" },
      { type: "text", text: REDLINE },
    ]);
  });

  it("openai 形状：tool 消息原样保留，事件块以新 user 消息落尾", async () => {
    const pipeline = makePipeline([makeRedlineHook()]);
    const out = await pipeline.process(OPENAI_BODY, meta("openai"));

    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(5);
    expect(messages[3]).toEqual({ role: "tool", content: "file contents", tool_call_id: "tc1" });
    expect(messages[4]).toEqual({ role: "user", content: REDLINE });
  });

  it("同管线重复产出同内容 event 块 → 去重为单块（tool_result 保持单块）", async () => {
    const pipeline = makePipeline([makeRedlineHook(), makeRedlineHook(REDLINE, "fake-redline-event-2")]);
    const out = await pipeline.process(ANTHROPIC_BODY, meta("anthropic"));

    const tail = (out.messages as Array<Record<string, unknown>>)[2];
    const content = tail.content as Array<Record<string, unknown>>;
    const textBlocks = content.filter((b) => b.type === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toEqual({ type: "text", text: REDLINE });
    expect(content.filter((b) => b.type === "tool_result")).toHaveLength(1);
  });

  it("执行序：user.after 先于 tools.before_call（事件块落位最近端）", async () => {
    const pipeline = makePipeline([makeUserAfterHook(), makeRedlineHook()]);
    const out = await pipeline.process(ANTHROPIC_BODY, meta("anthropic"));

    const tail = (out.messages as Array<Record<string, unknown>>)[2];
    const texts = (tail.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text")
      .map((b) => b.text);
    expect(texts).toEqual(["USER_AFTER_BLOCK", REDLINE]);
  });

  it("缺省（零 hook 产出）→ serialize round-trip 逐位现状（golden 深等）", async () => {
    const pipeline = makePipeline([]);
    const out = await pipeline.process(structuredClone(ANTHROPIC_BODY), meta("anthropic"));
    expect(out).toEqual(ANTHROPIC_BODY);

    const outOai = await pipeline.process(structuredClone(OPENAI_BODY), meta("openai"));
    expect(outOai).toEqual(OPENAI_BODY);
  });

  it("观测：onHookDone 透传 point=tools.before_call 与请求级 requestId（#38）", async () => {
    const observer = new RecordingObserver();
    const pipeline = makePipeline([makeRedlineHook()], observer);
    await pipeline.process(ANTHROPIC_BODY, meta("anthropic"));

    expect(observer.done).toHaveLength(1);
    expect(observer.done[0].point).toBe("tools.before_call");
    expect(observer.done[0].blockCount).toBe(1);
    expect(typeof observer.done[0].requestId).toBe("string");
    expect(observer.done[0].requestId!.length).toBeGreaterThan(0);
  });

  // 审查 Minor 1 实证（2026-10-16 迟归独立审查）：同管线顺序执行下，第一个 hook
  // 在 openai 形状插入新 user 消息后，尾消息已翻转为 user —— 第二个 hook 走
  // append 路径并按 cacheKey/内容指纹去重，因此不会产生第二条重复 user 消息
  //（anthropic/openai 去重语义经尾部翻转收敛为一致）。
  it("openai 形状：同管线双 hook 同内容 → 仍单条 user 消息（尾部翻转收敛）", async () => {
    const pipeline = makePipeline([makeRedlineHook(), makeRedlineHook(REDLINE, "fake-redline-event-2")]);
    const out = await pipeline.process(OPENAI_BODY, meta("openai"));

    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(5);
    const redlineUsers = messages.filter((m) => m.role === "user" && m.content === REDLINE);
    expect(redlineUsers).toHaveLength(1);
    expect(messages[4]).toEqual({ role: "user", content: REDLINE });
  });

  it("同消息不同 cacheKey 两块共存不去重（防过度去重）", async () => {
    const pipeline = makePipeline([
      makeCacheKeyedHook("红线内容A", "soul-redline-event:aaaa0001", "fake-a"),
      makeCacheKeyedHook("红线内容B", "soul-redline-event:bbbb0002", "fake-b"),
    ]);
    const out = await pipeline.process(ANTHROPIC_BODY, meta("anthropic"));

    const tail = (out.messages as Array<Record<string, unknown>>)[2];
    const texts = (tail.content as Array<Record<string, unknown>>).filter((b) => b.type === "text");
    expect(texts).toHaveLength(2);
  });
});
