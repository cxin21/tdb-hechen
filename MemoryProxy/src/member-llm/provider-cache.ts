/**
 * provider-cache — in-process memory TTL cache for member LLM providers.
 *
 * Aligns with the spec §3.3 (a ~30s TTL, matching the binding cache logic) so
 * a provider change is picked up by the next request at the latest, without
 * hitting the KV store on every forwarded request. Keyed by `(type, id)`.
 */
import type { LlmProvider } from "./types.js";

/** Default provider cache lifetime in milliseconds (spec §3.3: ~30s). */
export const DEFAULT_PROVIDER_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  entry: LlmProvider;
  /** Epoch ms at which this entry is considered stale. */
  expiresAt: number;
}

export class LlmProviderCache {
  private readonly data = new Map<string, CacheEntry>();

  constructor(
    /** Per-entry TTL (ms). Defaults to {@link DEFAULT_PROVIDER_CACHE_TTL_MS}. */
    private readonly ttlMs: number = DEFAULT_PROVIDER_CACHE_TTL_MS,
  ) {}

  private key(type: string, id: string): string {
    return `${type}:${id}`;
  }

  /** Returns the cached entry, or null on miss / expired entry (expired is evicted). */
  get(type: string, id: string): LlmProvider | null {
    const item = this.data.get(this.key(type, id));
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.data.delete(this.key(type, id));
      return null;
    }
    return item.entry;
  }

  /** Store (or overwrite) an entry with a fresh TTL. */
  set(type: string, id: string, entry: LlmProvider): void {
    this.data.set(this.key(type, id), {
      entry,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Drop a single cached entry. */
  invalidate(type: string, id: string): void {
    this.data.delete(this.key(type, id));
  }

  /** Drop every cached entry. */
  invalidateAll(): void {
    this.data.clear();
  }
}