/**
 * I-1（P2-T11+13 复核修补）：CoreKnowledgeClient Bearer token env 兜底单测。
 *
 * 鉴权翻转后，knowledge 链路原先只读 `knowledge.serviceToken`（默认空），
 * 不在 `TDAI_GATEWAY_APIKEY` 透传范围内。锁定 resolveBearerToken 三级语义：
 *   1. env 设置 + serviceToken 为空 → 请求头带 `Bearer <env 值>`
 *   2. env 优先于 serviceToken
 *   3. env 未设置 → 历史行为不变（Bearer <serviceToken>）
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

/** 注入 fetcher：捕获请求头，返回合法 knowledge list envelope。 */
function stubFetcherCapture(): { headers: Record<string, string>; fetcher: typeof fetch } {
  const captured: Record<string, string> = {};
  const fetcher = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    Object.assign(captured, init?.headers ?? {});
    return {
      ok: true,
      json: async () => ({ code: 0, data: { items: [] } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { headers: captured, fetcher };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TDAI_GATEWAY_APIKEY;
});

/**
 * S2 缓存键碰撞收敛：拼接键（`:`/`::` 分隔符）改 JSON.stringify 数组序列化
 * （与 coreTenantCacheKey T12 fix1 同模式）。分隔符歧义维度组合必须命中
 * 不同缓存条目——跨 team 串读是碰撞的可见后果。
 */
import { CoreKnowledgeClient, getCoreKnowledgeClient, setCoreKnowledgeClient } from "../core-client.js";

/** 按 team_id 分发不同结果的 fetcher（记录调用次数）。 */
function stubTeamDispatch(results: Record<string, unknown[]>) {
  let calls = 0;
  const fetcher = (async (_url: unknown, init?: { body?: unknown }) => {
    calls++;
    const body = JSON.parse(String(init?.body)) as { team_id: string };
    const items = results[body.team_id] ?? [];
    return {
      ok: true,
      json: async () => ({ code: 0, data: { items } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetcher, getCalls: () => calls };
}

describe("S2 缓存键碰撞收敛 — listKnowledge", () => {
  afterEach(() => {
    delete process.env.TDAI_KNOWLEDGE_CACHE_TTL_MS;
  });

  it("分隔符歧义组（teamId 含 : vs 服务Id 含 :）→ 各自条目独立，不跨 team 串读", async () => {
    process.env.TDAI_KNOWLEDGE_CACHE_TTL_MS = "30000";
    // 旧键 `list:a:b:s1` 两组相同 → 旧代码第二次命中第一次的缓存（跨 team 串读）
    const { fetcher } = stubTeamDispatch({
      "a:b": [{ knowledge_id: "k-teamAB", name: "team-a:b" }],
      "a": [{ knowledge_id: "k-teamA", name: "team-a" }],
    });
    const client = new CoreKnowledgeClient({ ...makeConfig(), timeoutMs: 1000 }, fetcher);

    const first = await client.listKnowledge("a:b", { serviceId: "s1" });
    const second = await client.listKnowledge("a", { serviceId: "b:s1" });

    expect(first).toEqual([{ knowledge_id: "k-teamAB", name: "team-a:b" }]);
    // 碰撞断言：不同维度组合必须拿到自己的数据
    expect(second).toEqual([{ knowledge_id: "k-teamA", name: "team-a" }]);
  });

  it("同维度重复调用 → 命中缓存只 fetch 一次（TTL 语义保持）", async () => {
    process.env.TDAI_KNOWLEDGE_CACHE_TTL_MS = "30000";
    const { fetcher, getCalls } = stubTeamDispatch({
      "team-x": [{ knowledge_id: "k1", name: "n1" }],
    });
    const client = new CoreKnowledgeClient(makeConfig(), fetcher);

    const r1 = await client.listKnowledge("team-x", { serviceId: "s1" });
    const r2 = await client.listKnowledge("team-x", { serviceId: "s1" });

    expect(r2).toEqual(r1);
    expect(getCalls()).toBe(1);
  });
});

describe("S2 缓存键碰撞收敛 — listKnowledgeByIds", () => {
  afterEach(() => {
    delete process.env.TDAI_KNOWLEDGE_CACHE_TTL_MS;
  });

  it("分隔符歧义组（teamId 含 : 且 ids 含 : vs 相邻边界移动）→ 各自条目独立", async () => {
    process.env.TDAI_KNOWLEDGE_CACHE_TTL_MS = "30000";
    // 旧键 listByIds:a:b:c:s1 两组相同；另 ids 内 `,` 自歧义也由数组维度一并消除
    const { fetcher } = stubTeamDispatch({
      "a:b": [{ knowledge_id: "c-id" }],
      "a": [{ knowledge_id: "b:c-id" }],
    });
    const client = new CoreKnowledgeClient(makeConfig(), fetcher);

    const first = await client.listKnowledgeByIds("a:b", ["c"], { serviceId: "s1" });
    const second = await client.listKnowledgeByIds("a", ["b:c"], { serviceId: "s1" });

    expect(first).toEqual([{ knowledge_id: "c-id" }]);
    expect(second).toEqual([{ knowledge_id: "b:c-id" }]);
  });
});

describe("S2 缓存键碰撞收敛 — listAgentKnowledgeIds", () => {
  afterEach(() => {
    delete process.env.TDAI_KNOWLEDGE_CACHE_TTL_MS;
  });

  it("分隔符歧义组（agentId 含 : vs 服务Id 含 :）→ 各自条目独立", async () => {
    process.env.TDAI_KNOWLEDGE_CACHE_TTL_MS = "30000";
    const assetFor = (id: string) => [{ asset_id: id, asset_type: "llm_wiki", status: "ok" }];
    // list-with-detail 的 body 是 {agent_id}，按 agent_id 分发
    const fetcher = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { agent_id: string };
      const items = body.agent_id === "a:b" ? assetFor("asset-AB") : assetFor("asset-A");
      return {
        ok: true,
        json: async () => ({ code: 0, data: { items } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = new CoreKnowledgeClient(makeConfig(), fetcher);

    const first = await client.listAgentKnowledgeIds("a:b", "user-key", { serviceId: "s1" });
    const second = await client.listAgentKnowledgeIds("a", "user-key", { serviceId: "b:s1" });

    expect(first).toEqual(["asset-AB"]);
    expect(second).toEqual(["asset-A"]);
  });
});

describe("S2 缓存键碰撞收敛 — getCoreKnowledgeClient 单例键", () => {
  afterEach(() => {
    setCoreKnowledgeClient(null);
  });

  it("endpoint/serviceToken 含 :: 的歧义组合 → 不同实例；同配置 → 同实例", () => {
    // 旧键 `http://e::a::b::s::1000` 两组相同 → 旧代码复用错误配置的实例
    const cfg1 = { endpoint: "http://e", serviceToken: "a::b", serviceId: "s", timeoutMs: 1000 };
    const cfg2 = { endpoint: "http://e::a", serviceToken: "b", serviceId: "s", timeoutMs: 1000 };

    const c1 = getCoreKnowledgeClient(cfg1);
    const c2 = getCoreKnowledgeClient(cfg2);
    expect(c2).not.toBe(c1);

    // 缓存语义保持（单槽）：当前 key 的同配置再次获取 → 复用实例
    expect(getCoreKnowledgeClient(cfg2)).toBe(c2);
  });
});

describe("CoreKnowledgeClient bearer token env 兜底（I-1）", () => {
  it("env 设置 + serviceToken 空 → Bearer <env>；env 优先于 serviceToken；皆空 → 原值不变", async () => {
    // 1) env 设置 + serviceToken 为空 → Bearer <env>（trim 过）
    process.env.TDAI_GATEWAY_APIKEY = " env-secret-key ";
    let { headers, fetcher } = stubFetcherCapture();
    await new CoreKnowledgeClient(makeConfig(), fetcher).listKnowledge("team-x");
    expect(headers["Authorization"]).toBe("Bearer env-secret-key");

    // 2) env 优先于 serviceToken（env 最高优先级）
    ({ headers, fetcher } = stubFetcherCapture());
    await new CoreKnowledgeClient(makeConfig("svc-token"), fetcher).listKnowledge("team-x");
    expect(headers["Authorization"]).toBe("Bearer env-secret-key");

    // 3) env 未设置 → 历史行为不变（Bearer <serviceToken>）
    delete process.env.TDAI_GATEWAY_APIKEY;
    ({ headers, fetcher } = stubFetcherCapture());
    await new CoreKnowledgeClient(makeConfig("svc-token"), fetcher).listKnowledge("team-x");
    expect(headers["Authorization"]).toBe("Bearer svc-token");
  });
});
