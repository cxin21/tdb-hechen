/**
 * ④ wiki 摘要 maxOutputTokens 可配置（默认 4096）：
 * 2026-10-15 实锤：summary 固定 maxOutputTokens:1024，glm-5.3-flash 思考 token 计入
 * completion_tokens → 1024 全被思考吃满（usage.completion_tokens===1024、finishReason=length、
 * 正文 0 字符）→ 摘要静默为空。
 * 合同：llm.summaryMaxOutputTokens 未配置 → 4096；配置 → 原样透传。
 */
import { test, expect, afterAll } from "vitest";
import http from "node:http";
import { generateWikiSummary } from "../src/callback.js";
import type { LlmConfig } from "../src/config.js";

const bodies: any[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString("utf-8")));
  req.on("end", () => {
    bodies.push(JSON.parse(body || "{}"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "短摘要" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
});
server.listen(0, "127.0.0.1");

afterAll(() => {
  server.close();
});

function llmCfg(extra: Record<string, unknown> = {}): LlmConfig {
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("server not listening");
  return {
    mode: "custom",
    protocol: "openai",
    provider: "openai",
    apiKey: "test-key",
    model: "test-model",
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    ...extra,
  } as LlmConfig;
}

test("未配置 summaryMaxOutputTokens → 默认 4096", { timeout: 30000 }, async () => {
  bodies.length = 0;
  const text = await generateWikiSummary("wiki-x", "标准库", [{ title: "页A" }], llmCfg());
  expect(text).toBe("短摘要");
  expect(bodies.length).toBe(1);
  const sent = bodies[0].max_output_tokens ?? bodies[0].max_tokens;
  expect(sent).toBe(4096);
});

test("summaryMaxOutputTokens:777 → 原样透传", { timeout: 30000 }, async () => {
  bodies.length = 0;
  await generateWikiSummary("wiki-x", "标准库", [{ title: "页A" }], llmCfg({ summaryMaxOutputTokens: 777 }));
  const sent = bodies[0].max_output_tokens ?? bodies[0].max_tokens;
  expect(sent).toBe(777);
});
