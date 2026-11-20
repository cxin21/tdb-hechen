/**
 * starmap/cache/resources.ts — 星图数据资源层（S2 第 1 块）
 *
 * 解决现有代码的四件事（都在 docs/specs/2026-11-11-panel-starmap-kit-and-cache.md B 节）：
 *  1. TTL 缓存：同 key 在 ttl 内直接命中，不再每次进云重打 15 串请求；
 *  2. 单飞：同 key 并发只发一次（旧 base.ts 只去重不缓存结果）；
 *  3. 失效标签：写操作后按 tag 精确失效，正确性不依赖 ttl；
 *  4. 泳道并发：soul 串行（实测并发 6 会 15s/504）、read 并发 4。
 *
 * 这里只有纯逻辑，不碰 React、不碰 fetch —— 便于用假时钟做确定性单测。
 * 组件侧用 useResource(key) 包一层（S2b）。
 */

export type Lane = 'soul' | 'read';

export interface ResourceOptions {
  /** 多久算新鲜（毫秒）。ttl 只决定「多久重问」，正确性靠 invalidate。 */
  ttl: number;
  lane?: Lane;
  /** 写入时挂上的失效标签，例如 `memory:agent:<id>`。 */
  tags?: string[];
  /** 跳过 ttl 强制重取（下拉刷新、进入详情）。 */
  force?: boolean;
}

export interface ResourceResult<T> {
  data?: T;
  error?: Error;
  /** true＝返回的是超过 ttl 的旧值（失败时不清旧值）。 */
  stale: boolean;
  /** 上次成功写入的时间戳；从未成功为 0。 */
  updatedAt: number;
}

interface Entry {
  data?: unknown;
  error?: Error;
  updatedAt: number;
  inflight?: Promise<ResourceResult<unknown>>;
  tags: string[];
  lastUsed: number;
}

export interface StoreOptions {
  now?: () => number;
  /** 条目上限，超出按 lastUsed 淘汰（在途条目不淘汰）。 */
  maxEntries?: number;
  laneLimit?: Partial<Record<Lane, number>>;
}

export interface StoreSnapshot {
  size: number;
  hits: number;
  misses: number;
  errors: number;
  evictions: number;
  inflight: number;
  lanes: Record<Lane, { active: number; queued: number }>;
}

const DEFAULT_LIMIT: Record<Lane, number> = { soul: 1, read: 4 };

export class ResourceStore {
  private entries = new Map<string, Entry>();
  private lanes: Record<Lane, { active: number; queue: Array<() => void> }> = {
    soul: { active: 0, queue: [] },
    read: { active: 0, queue: [] },
  };
  private now: () => number;
  private maxEntries: number;
  private laneLimit: Record<Lane, number>;
  private stats = { hits: 0, misses: 0, errors: 0, evictions: 0 };
  /** 单调递增的使用序号。不用时间戳：同一毫秒内的多次 touch 会并列，
   *  LRU 淘汰顺序就变成 Map 插入顺序，行为不可预测。 */
  private seq = 0;

  constructor(opts: StoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.maxEntries = opts.maxEntries ?? 400;
    this.laneLimit = { ...DEFAULT_LIMIT, ...opts.laneLimit };
  }

  /** 只读新鲜值；过期返回 undefined（调用方再走 load）。 */
  peek<T>(key: string, ttl: number): ResourceResult<T> | undefined {
    const e = this.entries.get(key);
    if (!e || e.data === undefined) return undefined;
    if (this.now() - e.updatedAt >= ttl) return undefined;
    this.touch(e);
    return { data: e.data as T, stale: false, updatedAt: e.updatedAt };
  }

  /** 只读任意值（含过期），用于「先画旧值再刷」。 */
  peekAny<T>(key: string): ResourceResult<T> | undefined {
    const e = this.entries.get(key);
    if (!e || e.data === undefined) return undefined;
    return { data: e.data as T, stale: true, updatedAt: e.updatedAt, error: e.error };
  }

  async load<T>(key: string, fetcher: () => Promise<T>, opts: ResourceOptions): Promise<ResourceResult<T>> {
    const lane: Lane = opts.lane ?? 'read';
    const entry = this.entries.get(key);

    if (entry?.inflight && !opts.force) {
      this.stats.hits += 1;
      return entry.inflight as Promise<ResourceResult<T>>;
    }

    if (entry && !opts.force && entry.data !== undefined && this.now() - entry.updatedAt < opts.ttl) {
      this.stats.hits += 1;
      this.touch(entry);
      return { data: entry.data as T, stale: false, updatedAt: entry.updatedAt };
    }

    const target: Entry = entry ?? { updatedAt: 0, tags: [], lastUsed: 0 };
    target.tags = Array.from(new Set([...(entry?.tags ?? []), ...(opts.tags ?? [])]));
    this.entries.set(key, target);

    const run = async (): Promise<ResourceResult<T>> => {
      try {
        const data = await fetcher();
        target.data = data;
        target.error = undefined;
        target.updatedAt = this.now();
        this.touch(target);
        this.evictIfNeeded();
        return { data, stale: false, updatedAt: target.updatedAt };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.stats.errors += 1;
        target.error = error;
        // 失败不清旧值：宁可显示过期数据并在 UI 标「未刷新」，也不让页面变空白。
        if (target.data !== undefined) {
          return { data: target.data as T, error, stale: true, updatedAt: target.updatedAt };
        }
        return { error, stale: false, updatedAt: 0 };
      } finally {
        target.inflight = undefined;
      }
    };

    this.stats.misses += 1;
    const p = this.withLane(lane, run);
    target.inflight = p as Promise<ResourceResult<unknown>>;
    return p;
  }

  /** 按 tag 精确失效（写操作后调用）。返回被清掉的条目数。 */
  invalidate(tags: string | string[]): number {
    const wanted = new Set(Array.isArray(tags) ? tags : [tags]);
    let removed = 0;
    for (const [key, e] of this.entries) {
      if (e.inflight) continue;
      if (e.tags.some((t) => wanted.has(t))) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 按 key 前缀整片失效。闭包化的写操作只知道「动的是记忆还是技能」，
   * 不知道受影响的每个具体 key（换 agent 后 key 里的 agent 段就变了），
   * 所以给一个前缀入口，比逐个枚举 tag 更不容易漏。
   */
  invalidatePrefix(prefix: string): number {
    let removed = 0;
    for (const [key, e] of this.entries) {
      if (e.inflight) continue;
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  private touch(e: Entry): void {
    this.seq += 1;
    e.lastUsed = this.seq;
  }

  snapshot(): StoreSnapshot {
    let inflight = 0;
    for (const e of this.entries.values()) if (e.inflight) inflight += 1;
    return {
      size: this.entries.size,
      ...this.stats,
      inflight,
      lanes: {
        soul: { active: this.lanes.soul.active, queued: this.lanes.soul.queue.length },
        read: { active: this.lanes.read.active, queued: this.lanes.read.queue.length },
      },
    };
  }

  private withLane<T>(lane: Lane, run: () => Promise<T>): Promise<T> {
    const state = this.lanes[lane];
    const limit = this.laneLimit[lane];

    const start = (): Promise<T> => {
      state.active += 1;
      return run().finally(() => {
        state.active -= 1;
        const next = state.queue.shift();
        if (next) next();
      });
    };

    if (state.active < limit) return start();
    return new Promise<T>((resolve, reject) => {
      state.queue.push(() => {
        start().then(resolve, reject);
      });
    });
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return;
    const victims = Array.from(this.entries.entries())
      .filter(([, e]) => !e.inflight)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key] of victims) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(key);
      this.stats.evictions += 1;
    }
  }
}
