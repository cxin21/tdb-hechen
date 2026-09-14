/**
 * I-1（P2-T11+13 复核修补）：MetadataClient Bearer token env 兜底单测。
 *
 * 鉴权翻转后，meta 链路原先只读 `coreSkill.serviceToken`（默认空），
 * 不在 `TDAI_GATEWAY_APIKEY` 透传范围内。锁定 resolveBearerToken 三级语义：
 *   1. env 设置 + serviceToken 为空 → 请求头带 `Bearer <env 值>`
 *   2. env 优先于 serviceToken
 *   3. env 未设置 → 历史行为不变（Bearer <serviceToken>）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataClient } from "../client.js";

function makeConfig(serviceToken = "") {
  return {
    endpoint: "http://127.0.0.1:8420",
    serviceToken,
    timeoutMs: 1000,
  };
}

/** 注入 fetcher：捕获请求头，返回合法分页 envelope（空页 → fetchAll 一次即止）。 */
function stubFetcherCapture(): { headers: Record<string, string>; fetcher: typeof fetch } {
  const captured: Record<string, string> = {};
  const fetcher = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    Object.assign(captured, init?.headers ?? {});
    return {
      ok: true,
      json: async () => ({ code: 0, data: { items: [], total: 0 } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { headers: captured, fetcher };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TDAI_GATEWAY_APIKEY;
});

/**
 * S2 缓存键碰撞收敛：单例 clientKey（`::` 分隔符拼接）改 JSON.stringify
 * 数组序列化（与 coreTenantCacheKey T12 fix1 同模式）。分隔符歧义配置组合
 * 必须各自拿到自己的实例——旧代码会复用错误 endpoint/token 的实例。
 */
import { getMetadataClient, setMetadataClient } from "../client.js";

describe("S2 缓存键碰撞收敛 — getMetadataClient 单例键", () => {
  afterEach(() => {
    setMetadataClient(null);
  });

  it("endpoint/serviceToken 含 :: 的歧义组合 → 不同实例；同配置 → 同实例", () => {
    // 旧键 `http://e::a::b::s::1000::u` 两组相同 → 旧代码复用错误配置实例
    const cfg1 = { endpoint: "http://e", serviceToken: "a::b", timeoutMs: 1000 };
    const cfg2 = { endpoint: "http://e::a", serviceToken: "b", timeoutMs: 1000 };

    const c1 = getMetadataClient(cfg1, "s", "u");
    const c2 = getMetadataClient(cfg2, "s", "u");
    expect(c2).not.toBe(c1);

    // 缓存语义保持（单槽）：当前 key 的同配置再次获取 → 复用实例
    expect(getMetadataClient(cfg2, "s", "u")).toBe(c2);
  });
});

describe("MetadataClient bearer token env 兜底（I-1）", () => {
  it("env 设置 + serviceToken 空 → Bearer <env>；env 优先于 serviceToken；皆空 → 原值不变", async () => {
    // 1) env 设置 + serviceToken 为空 → Bearer <env>（trim 过）
    process.env.TDAI_GATEWAY_APIKEY = " env-secret-key ";
    let { headers, fetcher } = stubFetcherCapture();
    await new MetadataClient(makeConfig(), "mem-001", "user-key", fetcher).listTeams("usr-1");
    expect(headers["Authorization"]).toBe("Bearer env-secret-key");

    // 2) env 优先于 serviceToken（env 最高优先级）
    ({ headers, fetcher } = stubFetcherCapture());
    await new MetadataClient(makeConfig("svc-token"), "mem-001", "user-key", fetcher).listTeams("usr-1");
    expect(headers["Authorization"]).toBe("Bearer env-secret-key");

    // 3) env 未设置 → 历史行为不变（Bearer <serviceToken>）
    delete process.env.TDAI_GATEWAY_APIKEY;
    ({ headers, fetcher } = stubFetcherCapture());
    await new MetadataClient(makeConfig("svc-token"), "mem-001", "user-key", fetcher).listTeams("usr-1");
    expect(headers["Authorization"]).toBe("Bearer svc-token");
  });
});
