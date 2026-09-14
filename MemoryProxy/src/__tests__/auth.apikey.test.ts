/**
 * auth 链路 Bearer token 兜底单测（拍板③ 配套补漏）。
 *
 * 背景：鉴权翻转（拍板③）后 core gateway 对全路由（含 /v3/meta/auth/verify）
 * 强制 `Authorization: Bearer <server.apiKey>`。I-1（P2-T11+13 复核修补）给
 * skill / knowledge / meta 三条链路补了 resolveBearerToken 兜底，但 auth 链路
 * （verifyUserKey）被遗漏 —— 不带 Authorization 头会被网关中间件 401 秒拒，
 * 导致 proxy 全量断供。本单测锁定 auth 链路同样的三级解析语义：
 *   1. env 设置 → Bearer <env 值>（trim 过，优先级最高）
 *   2. env 未设置 + yaml tdai.apiKey 注入 → Bearer <yaml 值>
 *   3. 皆空 → 与历史行为一致（无 Authorization 头 → 网关按 unauth 处理）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initAuth, verifyUserKey } from "../auth.js";
import { resetTdaiGatewayApiKeyForTest, setTdaiGatewayApiKey } from "../tdai/bearer-token.js";

function stubFetchCapture(): { headers: Record<string, string>; fetcher: ReturnType<typeof vi.fn> } {
  const captured: Record<string, string> = {};
  const fetcher = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    Object.assign(captured, init?.headers ?? {});
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: { valid: true, user: { user_id: "usr-test" } },
      }),
    } as unknown as Response;
  });
  return { headers: captured, fetcher };
}

beforeEach(() => {
  initAuth({ enabled: true, url: "http://127.0.0.1:8420", timeoutMs: 1000 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TDAI_GATEWAY_APIKEY;
  resetTdaiGatewayApiKeyForTest();
});

describe("verifyUserKey Bearer token 兜底（拍板③ auth 链路补漏）", () => {
  it("env 设置 → Bearer <env>（trim 过）；env 优先于 yaml 注入", async () => {
    process.env.TDAI_GATEWAY_APIKEY = " env-secret-key ";
    const { headers, fetcher } = stubFetchCapture();
    vi.stubGlobal("fetch", fetcher);

    await verifyUserKey("user-key-1", "default");
    expect(headers["Authorization"]).toBe("Bearer env-secret-key");
    expect(headers["x-tdai-service-id"]).toBe("default");

    // env 优先级高于 yaml 注入
    setTdaiGatewayApiKey("yaml-secret-key");
    const again = stubFetchCapture();
    vi.stubGlobal("fetch", again.fetcher);
    await verifyUserKey("user-key-2", "default");
    expect(again.headers["Authorization"]).toBe("Bearer env-secret-key");
  });

  it("env 未设置 + yaml tdai.apiKey 注入 → Bearer <yaml 值>", async () => {
    setTdaiGatewayApiKey("yaml-secret-key");
    const { headers, fetcher } = stubFetchCapture();
    vi.stubGlobal("fetch", fetcher);

    const result = await verifyUserKey("user-key-3", "default");
    expect(headers["Authorization"]).toBe("Bearer yaml-secret-key");
    expect(result).toEqual({ userId: "usr-test", rejected: false });
  });

  it("皆空 → 不带 Authorization 头（历史行为不变）", async () => {
    const { headers, fetcher } = stubFetchCapture();
    vi.stubGlobal("fetch", fetcher);

    await verifyUserKey("user-key-4", "default");
    expect(headers["Authorization"]).toBeUndefined();
  });
});
