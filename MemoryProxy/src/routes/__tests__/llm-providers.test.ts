import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createLlmProviderHandlers, type LlmProviderAuth } from "../llm-providers.js";
import { getLlmProviderStore, type LlmProviderStoreWithCache } from "../../member-llm/index.js";
import { extractBearerToken } from "../../opik.js";
import { DEFAULT_CONFIG } from "../../config.js";
import { __resetProxyStorageForTests } from "../../storage/factory.js";
import type { ProxyConfig } from "../../types.js";
import type { AgentEntity, MetadataClient } from "../../meta/client.js";
import type { Context } from "hono";

/** Memory-backed config —— 单测不落盘。 */
function cfg(): ProxyConfig {
  return {
    ...DEFAULT_CONFIG,
    storage: { ...DEFAULT_CONFIG.storage, enabled: true, backend: "memory" },
  };
}

/** 假的鉴权:token 形如 "k:<userId>" → 解出 userId;无 token → null(401)。 */
async function fakeAuthenticate(c: Context): Promise<LlmProviderAuth | null> {
  const token = extractBearerToken(c.req.header("authorization") ?? "");
  if (!token) return null;
  const idx = token.indexOf(":");
  if (idx < 0) return null;
  return { userId: token.slice(idx + 1), serviceId: "mem-t", userKey: token };
}

/** 假的 MetadataClient:只返回该用户拥有的 agent。 */
class FakeMetaClient {
  constructor(private owned: Record<string, AgentEntity[]>) {}
  async listTeams(): Promise<{ team_id: string; name: string }[]> {
    return [{ team_id: "t1", name: "T1" }];
  }
  async listAgents(_teamId: string, ownerUserId?: string): Promise<AgentEntity[]> {
    return (ownerUserId && this.owned[ownerUserId]) || [];
  }
}

function agent(id: string): AgentEntity {
  return { agent_id: id, team_id: "t1", owner_user_id: "usr-a", name: id, status: "active" };
}

function buildApp(owned: Record<string, AgentEntity[]>) {
  const store = getLlmProviderStore(cfg());
  const app = new Hono();
  const handlers = createLlmProviderHandlers(cfg(), {
    store,
    authenticate: fakeAuthenticate,
    getClient: () => new FakeMetaClient(owned) as unknown as MetadataClient,
    now: () => new Date("2026-09-04T00:00:00.000Z"),
  });
  app.get("/v3/admin/llm-providers", handlers.scoped);
  app.put("/v3/admin/llm-providers", handlers.put);
  app.delete("/v3/admin/llm-providers", handlers.delete);
  return { app, store };
}

type Store = LlmProviderStoreWithCache;

const PUT_URL = "/v3/admin/llm-providers?space_id=mem-t";

const PUT = (body: unknown, token: string): RequestInit => ({
  method: "PUT",
  headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

describe("/v3/admin/llm-providers", () => {
  beforeEach(() => {
    __resetProxyStorageForTests();
  });

  it("PUT 用户自己的 user 级 provider → 200,审计列由认证用户填充", async () => {
    const { app, store } = buildApp({});
    const res = await app.request(
            PUT_URL,
            PUT({ subject_type: "user", subject_id: "usr-a", url: "http://a/v1", apiKey: "k", model: "m" }, "k:usr-a"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { subject_type: string; subject_id: string } };
    expect(body.code).toBe(0);
    expect(body.data.subject_type).toBe("user");
    expect(body.data.subject_id).toBe("usr-a");

    const got = await store.get("user", "usr-a");
    expect(got?.url).toBe("http://a/v1");
    expect(got?.model).toBe("m");
    expect(got?.created_by).toBe("usr-a");
    expect(got?.updated_by).toBe("usr-a");
    expect(got?.created_at).toBe("2026-09-04T00:00:00.000Z");
    expect(got?.updated_at).toBe("2026-09-04T00:00:00.000Z");
  });

  it("PUT 写另一个用户的 user 级 → 403", async () => {
    const { app } = buildApp({});
    const res = await app.request(
            PUT_URL,
            PUT({ subject_type: "user", subject_id: "usr-b", url: "http://a/v1", apiKey: "k", model: "m" }, "k:usr-a"),
    );
    expect(res.status).toBe(403);
  });

  it("PUT 不属于该用户的 agent 级 → 403", async () => {
    const { app } = buildApp({ "usr-a": [agent("agt-own")] });
    const res = await app.request(
            PUT_URL,
            PUT({ subject_type: "agent", subject_id: "agt-stranger", url: "http://a/v1", apiKey: "k", model: "m" }, "k:usr-a"),
    );
    expect(res.status).toBe(403);
  });

  it("PUT 属于该用户的 agent 级 → 200 并落库", async () => {
    const { app, store } = buildApp({ "usr-a": [agent("agt-own")] });
    const res = await app.request(
            PUT_URL,
            PUT({ subject_type: "agent", subject_id: "agt-own", url: "http://a/v1", apiKey: "k", model: "m" }, "k:usr-a"),
    );
    expect(res.status).toBe(200);
    expect((await store.get("agent", "agt-own"))?.url).toBe("http://a/v1");
  });

  it("PUT 非法 url / 缺 apiKey / 缺 model / 非法 subject_type → 400 不落库", async () => {
    const { app, store } = buildApp({});
    const cases = [
      { subject_type: "user", subject_id: "usr-a", url: "not-a-url", apiKey: "k", model: "m" },
      { subject_type: "user", subject_id: "usr-a", url: "http://a/v1", apiKey: "", model: "m" },
      { subject_type: "user", subject_id: "usr-a", url: "http://a/v1", apiKey: "k", model: "  " },
      { subject_type: "space", subject_id: "usr-a", url: "http://a/v1", apiKey: "k", model: "m" },
      { subject_type: "user", subject_id: "", url: "http://a/v1", apiKey: "k", model: "m" },
      { subject_type: "user", subject_id: "usr-a", url: "ftp://a/v1", apiKey: "k", model: "m" },
    ];
    for (const body of cases) {
      const res = await app.request(PUT_URL, PUT(body, "k:usr-a"));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await store.get("user", "usr-a")).toBeNull();
  });

  it("PUT 覆盖已有 → 保留 created_*、刷新 updated_*、写后缓存失效立即生效", async () => {
    const { app, store } = buildApp({});
    await app.request(
            PUT_URL,
            PUT({ subject_type: "user", subject_id: "usr-a", url: "http://old/v1", apiKey: "k1", model: "m1" }, "k:usr-a"),
    );
    // 首次读入缓存
    expect((await store.get("user", "usr-a"))?.url).toBe("http://old/v1");
    // 覆盖写入
    await app.request(
            PUT_URL,
            PUT({ subject_type: "user", subject_id: "usr-a", url: "http://new/v1", apiKey: "k2", model: "m2" }, "k:usr-a"),
    );
    // 写后立即读到新值(缓存已显式失效)
    expect((await store.get("user", "usr-a"))?.url).toBe("http://new/v1");
    const got = await store.get("user", "usr-a");
    expect(got?.created_by).toBe("usr-a");
    expect(got?.created_at).toBe("2026-09-04T00:00:00.000Z");
    expect(got?.updated_by).toBe("usr-a");
  });

  it("DELETE 自带 provider → 200;再 GET 为 null", async () => {
    const { app, store } = buildApp({});
    await app.request(
            PUT_URL,
            PUT({ subject_type: "user", subject_id: "usr-a", url: "http://a/v1", apiKey: "k", model: "m" }, "k:usr-a"),
    );
    const res = await app.request(
      "/v3/admin/llm-providers?subject_type=user&subject_id=usr-a&space_id=mem-t",
      { method: "DELETE", headers: { authorization: "Bearer k:usr-a" } },
    );
    expect(res.status).toBe(200);
    expect(await store.get("user", "usr-a")).toBeNull();
  });

  it("DELETE 越权(他人 provider)→ 403", async () => {
    const { app } = buildApp({});
    const res = await app.request(
      "/v3/admin/llm-providers?subject_type=user&subject_id=usr-b&space_id=mem-t",
      { method: "DELETE", headers: { authorization: "Bearer k:usr-a" } },
    );
    expect(res.status).toBe(403);
  });

  it("缺 user_key → 401", async () => {
    const { app } = buildApp({});
    const res = await app.request(
            PUT_URL,
            PUT({ subject_type: "user", subject_id: "usr-a", url: "http://a/v1", apiKey: "k", model: "m" }, ""),
    );
    expect(res.status).toBe(401);
  });

  it("GET scope=me → 返回自身 user 级 + 其拥有的 agent 级 provider", async () => {
    const store: Store = getLlmProviderStore(cfg());
    await store.set({
      subject_type: "user", subject_id: "usr-a", url: "http://my/v1", apiKey: "k", model: "m",
      created_by: "usr-a", created_at: "c", updated_by: "usr-a", updated_at: "u",
    });
    await store.set({
      subject_type: "agent", subject_id: "agt-own", url: "http://my-agent/v1", apiKey: "k", model: "m2",
      created_by: "usr-a", created_at: "c", updated_by: "usr-a", updated_at: "u",
    });
    const { app } = buildApp({ "usr-a": [agent("agt-own")] });
    const res = await app.request(
      "/v3/admin/llm-providers?scope=me&space_id=mem-t",
      { method: "GET", headers: { authorization: "Bearer k:usr-a" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { user: { url: string } | null; agents: { agent_id: string; provider: { url: string } | null }[] };
    };
    expect(body.data.user?.url).toBe("http://my/v1");
    expect(body.data.agents).toHaveLength(1);
    expect(body.data.agents[0]?.agent_id).toBe("agt-own");
    expect(body.data.agents[0]?.provider?.url).toBe("http://my-agent/v1");
  });

  it("GET 指定 subject(自己)→ 返回 provider;他人 → 403", async () => {
    const store: Store = getLlmProviderStore(cfg());
    await store.set({
      subject_type: "user", subject_id: "usr-a", url: "http://my/v1", apiKey: "k", model: "m",
      created_by: "usr-a", created_at: "c", updated_by: "usr-a", updated_at: "u",
    });
    const { app } = buildApp({});
    const mine = await app.request(
      "/v3/admin/llm-providers?subject_type=user&subject_id=usr-a&space_id=mem-t",
      { method: "GET", headers: { authorization: "Bearer k:usr-a" } },
    );
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { data: { provider: { url: string } | null } }).data.provider?.url).toBe("http://my/v1");

    const other = await app.request(
      "/v3/admin/llm-providers?subject_type=user&subject_id=usr-b&space_id=mem-t",
      { method: "GET", headers: { authorization: "Bearer k:usr-a" } },
    );
    expect(other.status).toBe(403);
  });
});