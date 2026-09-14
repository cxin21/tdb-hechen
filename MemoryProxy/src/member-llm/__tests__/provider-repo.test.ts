import { beforeEach, describe, expect, it } from "vitest";
import { getLlmProviderStore, __resetLlmProviderStoreForTests } from "../index.js";
import { DEFAULT_CONFIG } from "../../config.js";
import { __resetProxyStorageForTests } from "../../storage/factory.js";
import type { ProxyConfig } from "../../types.js";
import type { LlmProvider } from "../types.js";

function audit(over: Partial<LlmProvider>): LlmProvider {
  return {
    subject_type: "user",
    subject_id: "usr-x",
    url: "u",
    apiKey: "k",
    model: "m",
    created_by: "usr-x",
    created_at: "c1",
    updated_by: "usr-x",
    updated_at: "t",
    ...over,
  };
}

/**
 * Memory-backed ProxyConfig for unit tests — in-process, nothing lands on disk.
 */
function config(): ProxyConfig {
  return {
    ...DEFAULT_CONFIG,
    storage: { ...DEFAULT_CONFIG.storage, enabled: true, backend: "memory" },
  };
}

describe("LlmProviderStore", () => {
  beforeEach(() => {
    // ProxyStorage is a process-level singleton; reset it so each test gets a
    // clean memory backend (otherwise entries leak across cases).
    __resetProxyStorageForTests();
    // getLlmProviderStore is now a process-level memoized singleton (same
    // process returns the same store + cache). Reset the memo too so test
    // cases don't share cache/entries with each other.
    __resetLlmProviderStoreForTests();
  });

  it("stores and retrieves by (type, id)", async () => {
    const store = getLlmProviderStore(config());
    await store.set(audit({ subject_type: "user", subject_id: "usr-a", url: "http://a/v1", model: "m1" }));
    const got = await store.get("user", "usr-a");
    expect(got?.url).toBe("http://a/v1");
    expect(got?.model).toBe("m1");
    expect(got?.created_by).toBe("usr-x");
  });

  it("returns null for missing entry", async () => {
    const store = getLlmProviderStore(config());
    expect(await store.get("agent", "agt-x")).toBeNull();
  });

  it("deletes an entry", async () => {
    const store = getLlmProviderStore(config());
    await store.set(audit({ subject_type: "user", subject_id: "usr-a" }));
    await store.del("user", "usr-a");
    expect(await store.get("user", "usr-a")).toBeNull();
  });

  it("lists only entries of the requested type", async () => {
    const store = getLlmProviderStore(config());
    await store.set(audit({ subject_type: "user", subject_id: "usr-a" }));
    await store.set(audit({ subject_type: "agent", subject_id: "agt-9", url: "u9" }));
    const agents = await store.list("agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.subject_id).toBe("agt-9");
  });

  it("overwrites an existing (type, id) entry (uniqueness by composite key)", async () => {
    const store = getLlmProviderStore(config());
    await store.set(audit({ subject_type: "user", subject_id: "usr-a", url: "old", model: "m", updated_at: "t1" }));
    await store.set(audit({ subject_type: "user", subject_id: "usr-a", url: "new", model: "m2", updated_by: "usr-z", updated_at: "t2" }));
    const got = await store.get("user", "usr-a");
    expect(got?.url).toBe("new");
    expect(await store.list("user")).toHaveLength(1);
    expect(got?.updated_by).toBe("usr-z");
  });

  it("yields the same values through the TTL cache and after invalidation", async () => {
    const store = getLlmProviderStore(config());
    await store.set(audit({ subject_type: "agent", subject_id: "agt-c" }));
    // First read populates the cache.
    expect((await store.get("agent", "agt-c"))?.model).toBe("m");
    // Second read serves from cache.
    expect((await store.get("agent", "agt-c"))?.model).toBe("m");
    // Invalidation clears the cached entry (source unchanged).
    store.cache.invalidate("agent", "agt-c");
    expect((await store.get("agent", "agt-c"))?.model).toBe("m");
  });

  it("同一进程内多次调用 getLlmProviderStore 返回同一实例(===)", async () => {
    const a = getLlmProviderStore(config());
    const b = getLlmProviderStore(config());
    expect(a).toBe(b); // 进程级 memoize:共享同一 store + cache
    expect(a.cache).toBe(b.cache);
  });

  it("共享同一 cache:经一个 store set 后另一 store 立即 get 到新值,del 后立即为 null", async () => {
    const a = getLlmProviderStore(config());
    const b = getLlmProviderStore(config());
    expect(a).toBe(b); // 回归保护:必须是同一实例才能"立即全局生效"
    await a.set(audit({ subject_type: "user", subject_id: "usr-a", url: "http://a/v1", model: "m1" }));
    // 同一 cache → 经 b 立即读取到 a 写入的值(无需等 TTL)
    expect((await b.get("user", "usr-a"))?.url).toBe("http://a/v1");
    // b.del 同时清除共享 cache → 经 a 立即看到删除
    await b.del("user", "usr-a");
    expect(await a.get("user", "usr-a")).toBeNull();
  });
});