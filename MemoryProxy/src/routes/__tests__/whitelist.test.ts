import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { matchWhitelistEndpoint } from "../whitelist.js";
import { handleAuxiliaryEndpoint } from "../../auxiliaryHandler.js";
import { DEFAULT_CONFIG } from "../../config.js";
import type { ProxyConfig } from "../../types.js";

/**
 * 回归 #117：dsh 客户端的 aux 端点（count_tokens / embeddings）曾恒 404。
 *
 * 根因：`AGENT_PREFIX_RE`（whitelist.ts）的 agent 名单里缺 `dsh`，
 * `normalizeWhitelistRequestPath` 无法剥掉 `/dsh/{spaceId}` 前缀，
 * 于是 `matchWhitelistEndpoint` 精确后缀匹配失败 → `handleAuxiliaryEndpoint` 返回
 * `{ error: "Unregistered endpoint" }` 404。
 *
 * 本用例既断言白名单匹配（命中的单一原因），也按 server.ts 的注册顺序重建那三条
 * 路由 + aux handler，断言状态码与上游拼接，确保 404 不再复现。重建而非 import 是
 * 因为 `buildApp` 在 server.ts 里不可单独导出——代价是 server.ts 的路由若改名，
 * 这里不会自动失败，需同步本文件的注册形状。
 */

/** 被测的 dsh 请求前缀：`/{agent}/{spaceId}`，spaceId 用固定假值。 */
const DSH = "/dsh/sp-1";

function cfg(): ProxyConfig {
  return {
    ...DEFAULT_CONFIG,
    upstream: { ...DEFAULT_CONFIG.upstream, url: "https://upstream.test/v1", apiKey: "sk-up" },
    creditReport: { ...DEFAULT_CONFIG.creditReport, enabled: false },
  };
}

/** 与 server.ts 的注册形状一致：/dsh 专用路由在前，通用 /:agent 路由在后。 */
function buildApp(config: ProxyConfig) {
  const app = new Hono();
  app.post("/dsh/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  return app;
}

function stubUpstream(body: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("whitelist · dsh aux 端点 (#117)", () => {
  it("matchWhitelistEndpoint 命中 /dsh/{spaceId}/v1/embeddings", () => {
    const entry = matchWhitelistEndpoint(`${DSH}/v1/embeddings`);
    expect(entry?.pathSuffix).toBe("/v1/embeddings");
    expect(entry?.protocol).toBe("openai");
    expect(entry?.isPrimary).toBe(false);
  });

  it("matchWhitelistEndpoint 命中 /dsh/{spaceId}/v1/messages/count_tokens", () => {
    const entry = matchWhitelistEndpoint(`${DSH}/v1/messages/count_tokens`);
    expect(entry?.pathSuffix).toBe("/v1/messages/count_tokens");
    expect(entry?.protocol).toBe("anthropic");
  });

  it("POST /dsh/{spaceId}/v1/embeddings 不再返回 Unregistered endpoint，并转发到上游 /embeddings", async () => {
    const fetchMock = stubUpstream({ data: [{ embedding: [0.1] }], usage: { prompt_tokens: 2 } });
    const res = await buildApp(cfg()).request(`${DSH}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "bge-m3", input: "hi" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ embedding: [0.1] }], usage: { prompt_tokens: 2 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://upstream.test/v1/embeddings");
  });

  it("POST /dsh/{spaceId}/v1/messages/count_tokens 不再返回 Unregistered endpoint", async () => {
    const fetchMock = stubUpstream({ input_tokens: 7 });
    const res = await buildApp(cfg()).request(`${DSH}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude", messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://upstream.test/v1/messages/count_tokens");
  });

  it("未知 agent 前缀仍按未注册端点 404（不外扩 agent 名单）", async () => {
    stubUpstream({});
    const res = await buildApp(cfg()).request("/mystery-agent/sp-1/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unregistered endpoint" });
  });
});
