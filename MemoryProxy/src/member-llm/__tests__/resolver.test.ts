import { beforeEach, describe, expect, it } from "vitest";
import { resolveMemberUpstream, applyMemberModel, type MemberUpstream } from "../resolver.js";
import { getLlmProviderStore, type LlmProviderStoreWithCache } from "../index.js";
import { LlmProviderRepo } from "../provider-repo.js";
import { LlmProviderCache } from "../provider-cache.js";
import { DEFAULT_CONFIG } from "../../config.js";
import { __resetProxyStorageForTests, getProxyStorage } from "../../storage/factory.js";
import type { ProxyConfig } from "../../types.js";

type Store = LlmProviderStoreWithCache;

/** Memory-backed config —— 单测不落盘。 */
function cfg(): ProxyConfig {
  return {
    ...DEFAULT_CONFIG,
    storage: { ...DEFAULT_CONFIG.storage, enabled: true, backend: "memory" },
  };
}

/**
 * 构造一个有**独立 cache** 的 store,但共享底层进程级 ProxyStorage。
 *
 * 说明:`getLlmProviderStore` 已按 TSingle 决策成为"进程级 memoized 单例"——同一存储实例
 * 下多次调用返回同一 store(同一 cache),这正是"配置变更立即全局生效"的机制。因此本文件的
 * 缓存语义测试不能依赖该工厂造出两个独立 cache;这里手动 new `LlmProviderRepo` +
 * `LlmProviderCache`,仅用于验证 `resolveMemberUpstream` 本身"按传入 store.get 缓存门面
 * 工作(miss 回源→写缓存→命中直接返回、不回源)",与单例工厂无关。
 */
function makeIndependentStore(): Store {
  const storage = getProxyStorage(cfg().storage);
  const repo = new LlmProviderRepo(storage);
  const cache = new LlmProviderCache();
  return {
    async get(type, id) {
      const hit = cache.get(type, id);
      if (hit) return hit;
      const entry = await repo.get(type, id);
      if (entry) cache.set(type, id, entry);
      return entry;
    },
    async set(entry) {
      await repo.set(entry);
      cache.invalidate(entry.subject_type, entry.subject_id);
    },
    async del(type, id) {
      await repo.del(type, id);
      cache.invalidate(type, id);
    },
    list: (type) => repo.list(type),
    cache,
  };
}

const audit = {
  created_by: "usr",
  created_at: "c1",
  updated_by: "usr",
  updated_at: "u1",
};

async function seedUser(store: Store, id: string, url: string, model: string, apiKey = "k"): Promise<void> {
  await store.set({ subject_type: "user", subject_id: id, url, apiKey, model, ...audit });
}

async function seedAgent(store: Store, id: string, url: string, model: string, apiKey = "k"): Promise<void> {
  await store.set({ subject_type: "agent", subject_id: id, url, apiKey, model, ...audit });
}

describe("resolveMemberUpstream", () => {
  beforeEach(() => {
    __resetProxyStorageForTests();
  });

  it("agent 覆盖压过 user 默认(优先级:agent > user)", async () => {
    const store = getLlmProviderStore(cfg());
    await seedUser(store, "usr-a", "http://user/v1", "user-model");
    await seedAgent(store, "agt-9", "http://agent/v1", "agent-model", "agent-key");
    const got = await resolveMemberUpstream(store, { userId: "usr-a", agentId: "agt-9" });
    expect(got).toEqual({ url: "http://agent/v1", apiKey: "agent-key", model: "agent-model" });
  });

  it("agent 未配置时回退到 user 默认", async () => {
    const store = getLlmProviderStore(cfg());
    await seedUser(store, "usr-a", "http://user/v1", "user-model");
    // agt-9 未配置
    const got = await resolveMemberUpstream(store, { userId: "usr-a", agentId: "agt-9" });
    expect(got).toEqual({ url: "http://user/v1", apiKey: "k", model: "user-model" });
  });

  it("双未配返回 null", async () => {
    const store = getLlmProviderStore(cfg());
    expect(await resolveMemberUpstream(store, { userId: "usr-x", agentId: "agt-y" })).toBeNull();
  });

  it("agentId 为空/null/undefined 时不查 agent,直接回退 user;全空 → null", async () => {
    const store = getLlmProviderStore(cfg());
    await seedUser(store, "usr-a", "http://user/v1", "user-model");
    for (const agentId of [undefined, null, ""]) {
      const got = await resolveMemberUpstream(store, { userId: "usr-a", agentId });
      expect(got?.url).toBe("http://user/v1");
    }
    expect(await resolveMemberUpstream(store, { userId: null, agentId: null })).toBeNull();
  });

  it("解析走传入 store 的缓存(miss 回源后写缓存,命中直接返回缓存、不回源)", async () => {
    // 用独立 cache 的两个 store(共享底层 ProxyStorage)测解析器的缓存门面语义,
    // 不依赖 getLlmProviderStore 的单例工厂(其单例=进程级共享 cache 是本设计要点)。
    const storeA = makeIndependentStore();
    const storeB = makeIndependentStore();
    await seedUser(storeA, "usr-a", "http://a/v1", "m-a");
    // 首次 resolve:storeA cache miss → 回源 + 写缓存
    expect((await resolveMemberUpstream(storeA, { userId: "usr-a" }))?.model).toBe("m-a");
    // storeB 与 storeA 共享底层 ProxyStorage,但 cache 各自独立:
    // storeB 删除同一 entry → 移除存储 + 仅失效 storeB 缓存
    await storeB.del("user", "usr-a");
    // storeA 缓存仍持旧值 → 命中缓存直接返回(不再回源),证明解析经由 store.get 门面
    expect((await resolveMemberUpstream(storeA, { userId: "usr-a" }))?.model).toBe("m-a");
  });
});

describe("applyMemberModel", () => {
  it("命中时仅替换 body.model 顶层字段,不动其它", () => {
    const body: Record<string, unknown> = { model: "client-model", temperature: 0.7, messages: [] };
    const upstream: MemberUpstream = { url: "u", apiKey: "k", model: "server-model" };
    applyMemberModel(body, upstream);
    expect(body.model).toBe("server-model");
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toEqual([]);
  });
});