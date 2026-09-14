/**
 * I-1（P2-T11+13 复核修补）：CoreSkillClient Bearer token env 兜底单测。
 *
 * 鉴权翻转后（网关 "apiKey 缺失即生成临时密钥"），skill 链路原先只读
 * `skill.serviceToken`（默认空），不在 `TDAI_GATEWAY_APIKEY` 透传范围内 ——
 * 部署侧配了 env 也会 401 断供。本单测锁定 resolveBearerToken 三级语义：
 *   1. env 设置 + serviceToken 为空 → 请求头带 `Bearer <env 值>`
 *   2. env 优先于 serviceToken（显式链路配置不被覆盖？否 —— env 最高，
 *      与 MemoryPanel "env 覆盖全部实例" 同惯例）
 *   3. 两者皆空/仅 serviceToken → 历史行为不变
 */
import { afterEach, describe, expect, it, vi } from "vitest";

function makeConfig(serviceToken = "") {
  return {
    endpoint: "http://127.0.0.1:8420",
    serviceToken,
    serviceId: "context-proxy",
    timeoutMs: 1000,
  };
}

/** 注入 fetcher：捕获请求头，返回合法 envelope（不走 globalThis.fetch）。 */
function stubFetcherCapture(): { headers: Record<string, string>; fetcher: typeof fetch } {
  const captured: Record<string, string> = {};
  const fetcher = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    Object.assign(captured, init?.headers ?? {});
    return {
      ok: true,
      json: async () => ({ code: 0, data: { hits: [] } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { headers: captured, fetcher };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TDAI_GATEWAY_APIKEY;
});

/**
 * S2 缓存键碰撞收敛：单例 configKey（`::` 分隔符拼接）改 JSON.stringify
 * 数组序列化（与 coreTenantCacheKey T12 fix1 同模式）。分隔符歧义配置组合
 * 必须各自拿到自己的实例。
 */
import { CoreSkillClient, getCoreSkillClient, setCoreSkillClient } from "../core-client.js";

describe("S2 缓存键碰撞收敛 — getCoreSkillClient 单例键", () => {
  afterEach(() => {
    setCoreSkillClient(null);
  });

  it("endpoint/serviceToken 含 :: 的歧义组合 → 不同实例；同配置 → 同实例", () => {
    // 旧键 `http://e::a::b::s::1000` 两组相同 → 旧代码复用错误配置实例
    const cfg1 = { endpoint: "http://e", serviceToken: "a::b", serviceId: "s", timeoutMs: 1000 };
    const cfg2 = { endpoint: "http://e::a", serviceToken: "b", serviceId: "s", timeoutMs: 1000 };

    const c1 = getCoreSkillClient(cfg1);
    const c2 = getCoreSkillClient(cfg2);
    expect(c2).not.toBe(c1);

    // 缓存语义保持（单槽）：当前 key 的同配置再次获取 → 复用实例
    expect(getCoreSkillClient(cfg2)).toBe(c2);
  });
});

describe("CoreSkillClient bearer token env 兜底（I-1）", () => {
  it("env 设置 + serviceToken 空 → Bearer <env>；env 优先于 serviceToken；皆空 → 原值不变", async () => {
    // 1) env 设置 + serviceToken 为空 → Bearer <env>（trim 过）
    process.env.TDAI_GATEWAY_APIKEY = " env-secret-key ";
    let { headers, fetcher } = stubFetcherCapture();
    await new CoreSkillClient(makeConfig(), fetcher).post("/v3/skill/search", { query: "x" });
    expect(headers["Authorization"]).toBe("Bearer env-secret-key");

    // 2) env 优先于 serviceToken（env 最高优先级）
    ({ headers, fetcher } = stubFetcherCapture());
    await new CoreSkillClient(makeConfig("svc-token"), fetcher).post("/v3/skill/search", { query: "x" });
    expect(headers["Authorization"]).toBe("Bearer env-secret-key");

    // 3) env 未设置 → 历史行为不变（Bearer <serviceToken>）
    delete process.env.TDAI_GATEWAY_APIKEY;
    ({ headers, fetcher } = stubFetcherCapture());
    await new CoreSkillClient(makeConfig("svc-token"), fetcher).post("/v3/skill/search", { query: "x" });
    expect(headers["Authorization"]).toBe("Bearer svc-token");
  });
});
