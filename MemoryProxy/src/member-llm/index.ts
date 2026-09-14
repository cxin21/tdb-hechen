/**
 * member-llm — factory for the member LLM provider store + TTL cache.
 *
 * `getLlmProviderStore(config)` returns a process-level memoized singleton: the
 * `LlmProviderStore` contract wired to a write-through cache. `get` serves from
 * cache on hit and backfills from the ProxyStorage repo on miss; `set` / `del`
 * write through and invalidate the cached entry so a provider change takes
 * effect immediately (no restart, no ≤30s TTL wait) because all callers (route +
 * handlers) share the same cache instance. `cache` is exposed for explicit
 * invalidation by writers.
 *
 * Caching is process-scoped (matching the binding / rate-limit TTL pattern in
 * the spec §3.3); the memoized repo wraps the shared process-level ProxyStorage
 * singleton.

 * Interfaces live in provider-repo.ts / provider-cache.ts; see
 * docs/superpowers/plans/2026-09-04-member-llm-provider.md Task 1.
 */
import type { ProxyConfig } from "../types.js";
import { getProxyStorage } from "../storage/factory.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import type { LlmProvider, LlmProviderSubjectType } from "./types.js";
import {
  LlmProviderRepo,
  type LlmProviderStore,
} from "./provider-repo.js";
import { LlmProviderCache } from "./provider-cache.js";

export type { LlmProvider, LlmProviderSubjectType } from "./types.js";
export {
  LlmProviderRepo,
  LLM_PROVIDER_SUBJECT_TYPES,
  type LlmProviderStore,
} from "./provider-repo.js";
export {
  LlmProviderCache,
  DEFAULT_PROVIDER_CACHE_TTL_MS,
} from "./provider-cache.js";

/** `LlmProviderStore` + the attached TTL cache. */
export interface LlmProviderStoreWithCache extends LlmProviderStore {
  cache: LlmProviderCache;
}

/**
 * 进程级 memoized 单例:同一进程内多次调用返回**同一实例**(共享同一个
 * LlmProviderCache)。这样路由写接口(server.ts)与 4 类 handler 转发缝调用本函数
 * 都拿到同一 cache → put/del 后的 `cache.invalidate` 对全局立即生效,消除
 * spec §3.3 "最迟 ≤30s TTL 收敛"的取舍(配置变更严格"下一次请求生效")。
 *
 * 底层 {@link getProxyStorage} 本身是进程单例;本 memo 额外记录其 storage 实例。
 * 当测试调用 `__resetProxyStorageForTests()` 使 storage 实例变换时(storage != memo
 * 内记录的引用),自动失效并重建,保证单测文件内各用例隔离(无需每个测试文件都
 * 手动重置 store 单例)。
 */
let _memo: { store: LlmProviderStoreWithCache; storage: ProxyStorage } | null = null;

/** 测试专用:清空进程级 memoize 单例(对齐 `__resetProxyStorageForTests` 用法)。 */
export function __resetLlmProviderStoreForTests(): void {
  _memo = null;
}

export function getLlmProviderStore(config: ProxyConfig): LlmProviderStoreWithCache {
  const storage = getProxyStorage(config.storage);
  if (_memo && _memo.storage === storage) return _memo.store;

  const repo = new LlmProviderRepo(storage);
  const cache = new LlmProviderCache();
  const store: LlmProviderStoreWithCache = {
    async get(type: LlmProviderSubjectType, id: string): Promise<LlmProvider | null> {
      const hit = cache.get(type, id);
      if (hit) return hit;
      const entry = await repo.get(type, id);
      if (entry) cache.set(type, id, entry);
      return entry;
    },
    async set(entry: LlmProvider): Promise<void> {
      await repo.set(entry);
      // Invalidate on write so a stale cached copy is never served afterwards.
      cache.invalidate(entry.subject_type, entry.subject_id);
    },
    async del(type: LlmProviderSubjectType, id: string): Promise<void> {
      await repo.del(type, id);
      cache.invalidate(type, id);
    },
    list: (type: LlmProviderSubjectType): Promise<LlmProvider[]> => repo.list(type),
    cache,
  };
  _memo = { store, storage };
  return store;
}