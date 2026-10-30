import { describe, it, expect, vi, afterEach } from "vitest";
import { StandaloneLLMRunner } from "./llm-runner.js";
import type { StandaloneLLMConfig } from "./llm-runner.js";
import type { LLMRunParams, Logger } from "../../core/types.js";

/**
 * #121 8.2 回归：LLM 调用失败时日志必须带 status / url / body 片段。
 *
 * 缺陷：`run()` 的 catch 只打 err.message，OpenAI 兼容端点返回 4xx/5xx 时
 * 日志里看不到上游状态码、实际请求地址与响应体，排障只能靠猜。
 * 契约：APICallError.isInstance(err) 为真时，logger.error 那一行追加
 * ` (status=<code>, url=<url>, body=<前 2048 字符>…(+<剩余字符数>))`；
 * 非 APICallError 保持原样（不引入噪声）。
 */

const shortBody = JSON.stringify({
  error: { message: "model `nope` not found", type: "invalid_request_error", code: "model_not_found" },
});

function makeLogger() {
  const errors: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: unknown) => {
      errors.push(String(msg));
    },
  } as unknown as Logger;
  return { logger, errors };
}

function makeParams(): LLMRunParams {
  return {
    prompt: "用户消息",
    systemPrompt: "系统提示",
    taskId: "l1-extraction",
    timeoutMs: 5_000,
  } as LLMRunParams;
}

function stubStatus(status: number, body: string) {
  const fakeFetch = vi.fn(
    async () => new Response(body, { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fakeFetch);
  return fakeFetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LLM 调用失败日志补 status/url/body（#121 8.2）", () => {
  it("端点 404：error 日志含 status=404、请求 url 与响应体片段", async () => {
    const baseUrl = "http://llm-err-log.test/v1";
    stubStatus(404, shortBody);
    const { logger, errors } = makeLogger();
    const runner = new StandaloneLLMRunner({
      config: { baseUrl, apiKey: "test-key", model: "test-model" } as StandaloneLLMConfig,
      logger,
    });

    await expect(runner.run(makeParams())).rejects.toThrow();

    expect(errors.length).toBeGreaterThan(0);
    const joined = errors.join("\n");
    expect(joined).toContain("run() failed");
    expect(joined).toContain("status=404");
    expect(joined).toContain("llm-err-log.test");
    expect(joined).toContain("model_not_found");
  });

  it("响应体超 2048 字符：只截前 2048 并标注剩余长度", async () => {
    const baseUrl = "http://llm-err-log-long.test/v1";
    const bigBody = JSON.stringify({ error: { message: "x".repeat(3000), code: "boom" } });
    stubStatus(400, bigBody);
    const { logger, errors } = makeLogger();
    const runner = new StandaloneLLMRunner({
      config: { baseUrl, apiKey: "test-key", model: "test-model" } as StandaloneLLMConfig,
      logger,
    });

    await expect(runner.run(makeParams())).rejects.toThrow();

    const joined = errors.join("\n");
    expect(joined).toContain("status=400");
    expect(joined).toMatch(/\(\+\d+\)/);
  });

  it("非 API 错误（本仓自抛的空响应）不受影响：日志保持原格式，无 status/url 噪声", async () => {
    const baseUrl = "http://llm-err-log-plain.test/v1";
    // 200 + 空 content：SDK 调用本身成功，失败来自本仓 fail-loud 的空响应守卫（普通 Error）
    stubStatus(
      200,
      JSON.stringify({
        id: "chatcmpl-empty",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
      }),
    );
    const { logger, errors } = makeLogger();
    const runner = new StandaloneLLMRunner({
      config: { baseUrl, apiKey: "test-key", model: "test-model" } as StandaloneLLMConfig,
      logger,
    });

    await expect(runner.run(makeParams())).rejects.toThrow(/LLM empty response/);
    const joined = errors.join("\n");
    expect(joined).toContain("run() failed");
    // 非 APICallError ⇒ 不追加 status=/url=/body= 片段
    expect(joined).not.toContain("status=");
    expect(joined).not.toContain("url=");
    expect(joined).not.toContain("body=");
  });
});
