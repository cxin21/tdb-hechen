/**
 * Recall latency budget: per-turn cache + in-flight reuse.
 *
 * Measured against the local core (/v3/recall), one NEW turn text per round:
 * 1250 / 1396 / 1467 / 1540 / 2002 / 2147 / 2255ms warm, 5067ms cold, with the L1
 * embedding (perfMs.l1) at 97%+ of it. The volatile block is awaited inside
 * agent/pre-step, so every unshielded miss is user-visible.
 *
 * Two defences, both keyed the same way so they cannot drift apart:
 * - a short TTL cache: asking the same question twice in a session costs 0;
 * - an in-flight map: a prefetch and the pre-step await share ONE request.
 *
 * Honest scope of the in-flight map: it prevents a DUPLICATE request for the
 * same key, it does not schedule work earlier. On this host session/event
 * user/message is dispatched after agent/pre-step, so the prefetch never wins
 * the race for the turn it belongs to; `prefetched:false` is the normal
 * reading. The real payoff is a repeated text landing in the cache window.
 */

import type { LoggerLike } from './types.js';

export const RECALL_CACHE_TTL_MS = 10 * 60 * 1000;
export const RECALL_CACHE_MAX_ENTRIES = 50;
export const RECALL_INFLIGHT_MAX_ENTRIES = 32;

/** Cache/prefetch key input: trim, collapse whitespace, keep the head. */
export function normalizeRecallText(text: string): string {
  if (typeof text !== 'string') return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 200 ? collapsed : collapsed.slice(0, 200);
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * One key for both the cache and the in-flight map, and one the pre-step side can
 * compute too: a numeric turn when the host gives one, else a hash of the
 * normalized user text. A mismatch therefore degrades to "fetch now", never to
 * an error or a wrong hit.
 */
export function recallKey(sessionId: string, turn: unknown, text: string): string {
  const turnNumber = Number(turn);
  if (turn !== undefined && turn !== null && turn !== '' && Number.isFinite(turnNumber)) {
    return sessionId + '\u0000turn:' + String(turnNumber);
  }
  return sessionId + '\u0000text:' + fnv1a(normalizeRecallText(text));
}

interface CacheEntry {
  text: string;
  at: number;
}

/** Bounded TTL+LRU cache of rendered volatile blocks. */
export class RecallCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number = RECALL_CACHE_TTL_MS,
    private readonly maxEntries: number = RECALL_CACHE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so Map order stays least-recently-used first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.text;
  }

  set(key: string, text: string): void {
    if (typeof text !== 'string' || text === '') return;
    this.entries.delete(key);
    this.entries.set(key, { text, at: this.now() });
    while (this.entries.size > Math.max(1, this.maxEntries)) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * One in-flight recall per key: whoever asks first starts it (a prefetch and the
 * pre-step await then share that one promise instead of issuing a second
 * request). Settled entries are dropped so a later turn re-fetches, while
 * failures never poison the key.
 */
export class RecallInflight<T = string> {
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly maxEntries: number = RECALL_INFLIGHT_MAX_ENTRIES,
    private readonly log?: LoggerLike,
  ) {}

  /** Existing request for this key, or start one (`undefined` = nothing in flight). */
  peek(key: string): Promise<T> | undefined {
    return this.pending.get(key);
  }

  /** Start (or reuse) the single request allowed for this key. */
  take(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(start());
    } catch (error) {
      this.log?.debug?.('agemem: recall prefetch failed to start', error);
      return Promise.reject(error);
    }
    this.pending.set(key, promise);
    while (this.pending.size > Math.max(1, this.maxEntries)) {
      const oldest = this.pending.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.pending.delete(oldest);
    }
    const settle = (): void => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    };
    void promise.then(settle, settle);
    return promise;
  }

  /** Drop a key (a finished turn no longer needs its prefetch). */
  forget(key: string): void {
    this.pending.delete(key);
  }

  get size(): number {
    return this.pending.size;
  }
}
