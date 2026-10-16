/**
 * ② fail-fast（A 类失败根因修复的回归锚）：
 * 2026-10-15 下午实锤：generate 调用 openai_error 后 AI SDK 默认重试（共 3 次），
 * 每次 ≈303s 整被掐 → 单源烧掉 ≈1010s 才报 AI_RetryError。
 * 合同：llm 配置 maxRetries 未配置时默认 0（单次尝试，fail-fast）；显式配置时透传给 AI SDK。
 * 用真实本地 http server 计数请求次数，不 stub SDK 内部。
 */
import { test, expect, afterAll } from "vitest";
import http from "node:http";
import { createLlmClient, normalizeLlmConfig } from "../src/engines/wiki/ingest-v2/llm.js";

const hits: number[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString("utf-8")));
  req.on("end", () => {
    hits.push(body);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "boom", type: "server_error" } }));
  });
});
server.listen(0, "127.0.0.1");

afterAll(() => {
  server.close();
});

function cfgWith(maxRetries?: number) {
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("server not listening");
  return {
    protocol: "openai" as const,
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    apiKey: "test-key",
    model: "test-model",
    ...(maxRetries === undefined ? {} : { maxRetries }),
  };
}

test("maxRetries 未配置 → 默认 0，单次尝试即失败（fail-fast）", { timeout: 30000 }, async () => {
  hits.length = 0;
  const client = createLlmClient(cfgWith());
  await expect(client.chat({ system: "s", prompt: "p" })).rejects.toThrow();
  expect(hits.length).toBe(1);
});

test("maxRetries:2 → 共 3 次尝试（透传 AI SDK）", { timeout: 60000 }, async () => {
  hits.length = 0;
  const client = createLlmClient(cfgWith(2));
  await expect(client.chat({ system: "s", prompt: "p" })).rejects.toThrow();
  expect(hits.length).toBe(3);
});

test("normalizeLlmConfig 默认 maxRetries=0", () => {
  const cfg = normalizeLlmConfig({ protocol: "openai", apiKey: "k", baseUrl: "http://x/v1" });
  expect(cfg.maxRetries).toBe(0);
});

test("normalizeLlmConfig 透传显式 maxRetries", () => {
  const cfg = normalizeLlmConfig({ protocol: "openai", apiKey: "k", baseUrl: "http://x/v1", maxRetries: 2 });
  expect(cfg.maxRetries).toBe(2);
});
