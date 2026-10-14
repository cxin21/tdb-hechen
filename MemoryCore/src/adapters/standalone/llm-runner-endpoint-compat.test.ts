import { describe, it, expect, vi, afterEach } from "vitest";
import { StandaloneLLMRunner } from "./llm-runner.js";
import type { StandaloneLLMConfig } from "./llm-runner.js";
import type { LLMRunParams } from "../../core/types.js";

/**
 * 端点兼容契约测试（2026-10-14 根因修复轮）。
 *
 * 背景：不同 OpenAI 兼容端点对请求体顶层 reasoning_effort 兼容性不同——
 * mimo 等推理端点支持（关思考优化有效）；glm-5.3-flash MaaS 网关直接
 * 400 "rejected by an internal MaaS component"，当日 L1 全败 → 只有 L0。
 *
 * 兜底合同（llm-runner.ts 模块级 reasoningEffortUnsupported 缓存）：
 *  1. 带 reasoningEffort 的请求被 400 拒 → 剥参重试一次，成功则记入缓存；
 *  2. 同端点后续调用首次请求即不带 reasoning_effort（零往返降级）；
 *  3. 不带 reasoningEffort 的调用永不触发降级路径；
 *  4. 剥参后仍失败 → 原错误抛出（400 另有原因时不掩盖）。
 */

interface FetchCall {
  url: string;
  body: string;
}

const completionBody = (content: string) =>
  JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });

function makeConfig(baseUrl: string): StandaloneLLMConfig {
  return { baseUrl, apiKey: "test-key", model: "test-model" } as StandaloneLLMConfig;
}

function makeParams(reasoningEffort?: string): LLMRunParams {
  return {
    prompt: "用户消息",
    systemPrompt: "系统提示",
    taskId: "l1-extraction",
    timeoutMs: 5_000,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  } as LLMRunParams;
}

/**
 * mock 端点行为：
 * - rejectAll=true：所有请求一律 400（模拟"400 另有原因"场景）；
 * - 否则：前 rejectCount 个"带 reasoning_effort"的请求被 400 拒（剥参后的请求正常 200）。
 */
function stubEndpoint(rejectCount: number, rejectAll = false) {
  const calls: FetchCall[] = [];
  let rejected = 0;
  const fakeFetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url: String(_url), body });
    const shouldReject = rejectAll || (body.includes("reasoning_effort") && rejected < rejectCount);
    if (shouldReject) {
      rejected += 1;
      return new Response(
        JSON.stringify({ error: { message: "The request is invalid: the request was rejected by an internal MaaS component. Please check the request body, required fields, and request format.", type: "invalid_request_error", code: "400001" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(completionBody("OK-TEXT"), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fakeFetch);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reasoning_effort 端点兼容（400 剥参降级 + 能力缓存）", () => {
  it("首调 400 → 剥参重试成功，第二次调用首发即不带（缓存生效）", async () => {
    const baseUrl = "http://ep-compat-1.test/v1";
    const calls = stubEndpoint(1);
    const runner = new StandaloneLLMRunner({ config: makeConfig(baseUrl) });

    const text = await runner.run(makeParams("none"));
    expect(text).toBe("OK-TEXT");

    // 第一次带 reasoning_effort（400），重试剥参成功
    expect(calls.length).toBe(2);
    expect(calls[0]!.body).toContain("reasoning_effort");
    expect(calls[1]!.body).not.toContain("reasoning_effort");

    // 缓存生效：同端点第二次 run() 首发即不带，零额外往返
    const text2 = await runner.run(makeParams("none"));
    expect(text2).toBe("OK-TEXT");
    expect(calls.length).toBe(3);
    expect(calls[2]!.body).not.toContain("reasoning_effort");
  });

  it("不带 reasoningEffort 的调用永不触发降级路径", async () => {
    const baseUrl = "http://ep-compat-2.test/v1";
    const calls = stubEndpoint(1);
    const runner = new StandaloneLLMRunner({ config: makeConfig(baseUrl) });

    const text = await runner.run(makeParams(undefined));
    expect(text).toBe("OK-TEXT");
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).not.toContain("reasoning_effort");
  });

  it("剥参重试后仍 400 = 错误另有原因，按原错误抛出", async () => {
    const baseUrl = "http://ep-compat-3.test/v1";
    const calls = stubEndpoint(0, true);
    const runner = new StandaloneLLMRunner({ config: makeConfig(baseUrl) });

    await expect(runner.run(makeParams("none"))).rejects.toThrow(/MaaS/);
    // 首发 + 一次剥参重试 = 2 次请求，均失败
    expect(calls.length).toBe(2);
    expect(calls[0]!.body).toContain("reasoning_effort");
    expect(calls[1]!.body).not.toContain("reasoning_effort");
  });

  it("能力缓存按 baseUrl+model 粒度隔离", async () => {
    const baseA = "http://ep-compat-4a.test/v1";
    const baseB = "http://ep-compat-4b.test/v1";
    // A 首发与 B 首发各有一次带 effort 的请求被拒（rejectCount=2）
    const calls = stubEndpoint(2);
    const runnerA = new StandaloneLLMRunner({ config: makeConfig(baseA) });
    const runnerB = new StandaloneLLMRunner({ config: makeConfig(baseB) });

    await runnerA.run(makeParams("none")); // A 触发降级并缓存
    expect(calls.length).toBe(2);

    // B 端点（未缓存）首发仍带 reasoning_effort → 400 → 剥参重试
    await runnerB.run(makeParams("none"));
    expect(calls.length).toBe(4);
    expect(calls[2]!.url).toContain("ep-compat-4b.test");
    expect(calls[2]!.body).toContain("reasoning_effort");
  });
});
