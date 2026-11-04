/**
 * StorePool — per-instanceId 的 Store 实例池
 *
 * DSH-only 构建只有一个存储模式（docs/adr/0021「可选后端退场」）：
 *   - sqlite: 本地 SQLite（每个 instanceId 一个文件），standalone 部署
 *
 * 历史沿革：这里原本支持 "service" 模式（TCVDB 远端向量库 + 服务端 embedding +
 * 混合检索），配套 VDB 配置指纹、per-instance VDB 连接池、TCVDB Skill store 缓存。
 * TCVDB 整组退场后这些能力一并移除；构造期若仍被要求 tcvdb 模式**直接抛错**，
 * 不静默回落 sqlite。
 *
 * 与 InstanceConfigProvider 的关系保留：per-instance 的 dataDir/存储解析仍走它，
 * 但不再有 VDB 凭据解析。
 */

import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { MemoryTdaiConfig } from "../../config.js";
import type { IMemoryStore, StoreLogger } from "./types.js";
import type { EmbeddingService } from "./embedding.js";
import { createEmbeddingService, NoopEmbeddingService } from "./embedding.js";
import { VectorStore } from "./sqlite.js";
import { createBM25Encoder } from "./bm25-local.js";
import type { BM25LocalEncoder } from "./bm25-local.js";
import type { ISkillStore } from "../skill/skill-store.interface.js";
import { RetiredStoreBackendError } from "./factory.js";

const TAG = "[store-pool]";

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

export interface PooledStore {
  store: IMemoryStore;
  embedding: EmbeddingService;
  bm25Encoder?: BM25LocalEncoder;
}

interface PoolEntry {
  pooledStore: PooledStore;
  /** 配置指纹, 用于检测配置变更 */
  configFingerprint: string;
  lastAccessedAt: number;
}

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** 唯一受支持的存储模式。 */
export type StoreMode = "sqlite";

export interface StorePoolOptions {
  /** 存储模式：DSH-only 构建只有 "sqlite"（其它值构造期抛错） */
  mode?: StoreMode;
  /** 记忆插件配置 (用于 BM25/embedding 设置) */
  memoryCfg: MemoryTdaiConfig;
  /** 数据目录 (SQLite 模式下使用) */
  dataDir?: string;
  /** 最大池化实例数 (Memory store), 默认 100 */
  maxStores?: number;
  /** 最大 Skill store 缓存数, 默认 100 */
  maxSkillStores?: number;
  logger: Logger;
}

// ════════════════════════════════════════════════════════
// StorePool
// ════════════════════════════════════════════════════════

export class StorePool {
  private pool = new Map<string, PoolEntry>();
  private maxStores: number;
  readonly mode: StoreMode;
  private memoryCfg: MemoryTdaiConfig;
  private dataDir: string;
  private logger: Logger;
  /** 全局共享的 BM25 编码器 (避免重复加载 jieba 词典导致 OOM) */
  private sharedBm25Encoder: BM25LocalEncoder | undefined;

  /** Skill store 缓存上限 */
  private maxSkillStores: number;
  /** Skill store 最后访问时间 (LRU 淘汰用) */
  private skillStoreAccessTimes = new Map<string, number>();

  /**
   * Grace-close 跟踪：已从 pool 移除但底层 close 推迟执行的 entries。
   * CR-5 mitigation (2026-05-19): evict / config-change 不立刻 close 底层 store,
   * 而是延迟 graceCloseDelayMs 后再 close, 让 in-flight 请求(同步路径 recall/capture
   * <100ms; 异步 worker 路径 L1/L2/L3 受 maxRetries=3 + 指数退避兜底)有时间完成.
   */
  private pendingCloses = new Set<Promise<void>>();
  /** Grace period 默认 30s, 远大于同步路径墙钟 (recall ~49ms / capture ~54ms),
   *  且 worker 路径即使撞上也有 reEnqueue 重试机制 (5s/15s/45s). */
  private graceCloseDelayMs = 30_000;

  constructor(opts: StorePoolOptions) {
    // fail-loud：TCVDB 模式已退场，任何非 sqlite 的诉求都在构造期断掉
    if (opts.mode !== undefined && opts.mode !== "sqlite") {
      throw new RetiredStoreBackendError(String(opts.mode));
    }
    this.maxStores = opts.maxStores ?? 100;
    this.maxSkillStores = opts.maxSkillStores ?? 100;
    this.mode = "sqlite";
    this.memoryCfg = opts.memoryCfg;
    this.dataDir = opts.dataDir ?? ".";
    this.logger = opts.logger;

    // 初始化时创建一次 BM25 编码器, 所有 Store 共享
    this.sharedBm25Encoder = createBM25Encoder(this.memoryCfg.bm25, this.logger as StoreLogger);

    this.logger.info(`${TAG} Initialized: mode=${this.mode}, maxStores=${this.maxStores}, maxSkillStores=${this.maxSkillStores}, bm25=${this.sharedBm25Encoder ? "shared" : "disabled"}`);
  }

  /**
   * 获取指定 instanceId 对应的 Store 实例（SQLite）。
   */
  async getStore(instanceId: string): Promise<PooledStore> {
    const now = Date.now();
    const fingerprint = `sqlite:${instanceId}`;
    const cached = this.pool.get(instanceId);

    // 命中且配置未变
    if (cached && cached.configFingerprint === fingerprint) {
      cached.lastAccessedAt = now;
      return cached.pooledStore;
    }

    // 配置变了 → 关闭旧的
    if (cached) {
      this.logger.info(`${TAG} Config changed for ${instanceId}, recreating store`);
      await this.closeEntry(instanceId, cached);
    }

    // LRU 淘汰
    if (this.pool.size >= this.maxStores) {
      await this.evictLru();
    }

    // 创建新 Store
    const pooledStore = this.createSqliteStore(instanceId);

    this.pool.set(instanceId, {
      pooledStore,
      configFingerprint: fingerprint,
      lastAccessedAt: now,
    });

    this.logger.info(
      `${TAG} Created ${this.mode} store for ${instanceId}: sqlite @ ${this.getSqlitePath(instanceId)} (pool size: ${this.pool.size})`,
    );

    // 初始化 Store (建表/检查连接)
    try {
      await pooledStore.store.init();
    } catch (e) {
      this.logger.warn(`${TAG} Store init failed for ${instanceId}: ${e}`);
    }

    return pooledStore;
  }

  /**
   * 移除指定实例的 Store (实例下线时调用)
   */
  async evict(instanceId: string): Promise<void> {
    const entry = this.pool.get(instanceId);
    if (entry) {
      await this.closeEntry(instanceId, entry);
    }
  }

  /**
   * 关闭所有 Store
   *
   * CR-5: 原 closeAll 直接同步关闭所有 pool 内 store, 会导致 in-flight 请求崩溃.
   * 现在分两步:
   *   1. 把所有 entries 触发 closeEntry (延迟关闭, 加入 pendingCloses)
   *   2. 等待所有 pendingCloses 完成 (含本次新加 + 之前 evict 留下的)
   * 进程关停场景下, 调用方可以选择缩短 grace 时间避免阻塞: setGraceCloseDelay(0)
   */
  async closeAll(): Promise<void> {
    // 关闭 Memory store pool
    const entries = [...this.pool.entries()];
    this.pool.clear();
    // 触发延迟关闭 (这些 promise 会自动加入 pendingCloses)
    for (const [id, entry] of entries) {
      await this.closeEntry(id, entry);  // closeEntry 内部不阻塞, 立即返回
    }

    // 关闭 Skill store 缓存
    for (const [key, store] of this.skillStoreCache) {
      try {
        store.close();
        this.logger.debug?.(`${TAG} Closed skill store: ${key}`);
      } catch (e) {
        this.logger.warn(`${TAG} Error closing skill store ${key}: ${e}`);
      }
    }
    this.skillStoreCache.clear();
    this.skillStoreAccessTimes.clear();

    // 等所有 pending close 完成 (含本次 + 之前 evict 留下的)
    await Promise.allSettled([...this.pendingCloses]);
    this.logger.info(`${TAG} All stores closed (${entries.length} memory + skill caches cleared)`);
  }

  /**
   * 移除指定 instance 的 Skill store (实例销毁时调用).
   * 调用 store.close() 设 degraded=true, 然后从缓存中移除.
   */
  evictSkillStore(instanceId: string): void {
    const key = `skill:${instanceId}`;
    const store = this.skillStoreCache.get(key);
    if (store) {
      try {
        store.close();
      } catch (e) {
        this.logger.warn(`${TAG} Error closing skill store ${key}: ${e}`);
      }
      this.skillStoreCache.delete(key);
      this.skillStoreAccessTimes.delete(key);
      this.logger.info(`${TAG} Evicted skill store for ${instanceId} (cached: ${this.skillStoreCache.size})`);
    }
  }

  /**
   * 设置 grace-close 延迟 (毫秒). 设为 0 时立即关闭, 失去 in-flight 保护.
   * 主要用于测试或进程紧急退出场景.
   */
  setGraceCloseDelay(ms: number): void {
    this.graceCloseDelayMs = Math.max(0, ms);
  }

  get size(): number { return this.pool.size; }
  has(instanceId: string): boolean { return this.pool.has(instanceId); }

  /**
   * 获取指定 instanceId 的 Skill Store。
   *
   * 历史上这是 TCVDB 后端的 per-instance collection（{db}_skills）。TCVDB 退场后
   * skill 数据只走 SqliteSkillStore（见 skill/skill-store.ts），本方法保留签名但
   * **恒抛错**：任何仍在走这条路径的部署都必须显式迁移，而不是拿到一个空 store。
   */
  async getSkillStore(instanceId: string): Promise<ISkillStore> {
    void instanceId;
    throw new RetiredStoreBackendError("tcvdb-skill-store");
  }

  private skillStoreCache = new Map<string, ISkillStore>();

  // ════════════════════════════════════════════════════════
  // Internal — SQLite Store
  // ════════════════════════════════════════════════════════

  private createSqliteStore(instanceId: string): PooledStore {
    // Embedding service (远端 API, 如 OpenAI text-embedding)
    let embeddingService: EmbeddingService | undefined;
    const embCfg = this.memoryCfg.embedding;
    if (embCfg.enabled && embCfg.provider !== "local" && embCfg.provider !== "none" && embCfg.apiKey) {
      embeddingService = createEmbeddingService({
        provider: embCfg.provider,
        baseUrl: embCfg.baseUrl,
        apiKey: embCfg.apiKey,
        model: embCfg.model,
        dimensions: embCfg.dimensions,
        maxInputChars: embCfg.maxInputChars,
        // F3：单批条数上限随配置走（生产 ark 端点上限 10 → config 必须设 10）
        maxBatchSize: embCfg.maxBatchSize,
          // 2026-11-03 发车节流（缺省 0 = 关 = 逐位现状）
          paceMinIntervalMs: embCfg.paceMinIntervalMs,
          charsPerMinute: embCfg.charsPerMinute,
      }, this.logger as StoreLogger);
    }

    const dims = embCfg.dimensions ?? 0;
    const dbPath = this.getSqlitePath(instanceId);
    // 确保数据库目录存在（对于非 default instance）
    const dbDir = path.dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    const store = new VectorStore(dbPath, dims, this.logger as StoreLogger);

    return {
      store,
      // #123 注入点②（SQLite 兜底）：未配置远端 embedding（disabled / provider=none / 缺 apiKey）
      // 时用 Noop 占位 —— 这是**静默空转真源**：embed() 返回空 Float32Array，L1 永远写不进向量。
      // 保留 Noop（不 fail-fast，生产可用性优先），但可观测性由 gateway 探针兜住：
      // hasClientEmbedding() → false ⇒ /health memory.embedding=degraded + WARN(reason=noop-embedder)。
      embedding: (embeddingService ?? new NoopEmbeddingService()) as unknown as EmbeddingService,
      bm25Encoder: this.sharedBm25Encoder,
    };
  }

  /**
   * SQLite 文件路径:
   *   - "default" → dataDir/vectors.db (兼容原逻辑)
   *   - 其他 instanceId → dataDir/instances/{instanceId}/vectors.db
   */
  private getSqlitePath(instanceId: string): string {
    if (instanceId === "default") {
      return path.join(this.dataDir, "vectors.db");
    }
    return path.join(this.dataDir, "instances", instanceId, "vectors.db");
  }

  private async closeEntry(instanceId: string, entry: PoolEntry): Promise<void> {
    // CR-5 mitigation: 立刻从 pool 移除 (新请求拿不到这个 entry, 会创建一个新 store),
    // 但底层 store.close() 推迟 graceCloseDelayMs 才执行, 让任何持有此 entry 引用
    // 的 in-flight 请求有时间完成. 不加引用计数避免修改所有调用方;
    // worker 路径有 maxRetries=3 重试兜底, 同步路径墙钟远小于 grace period, 双保险.
    this.pool.delete(instanceId);

    const closePromise = (async () => {
      // 等 grace period
      if (this.graceCloseDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.graceCloseDelayMs);
          // unref 避免阻塞进程退出 (closeAll 会主动 await 这些 promise)
          if (typeof (t as { unref?: () => void }).unref === "function") {
            (t as { unref: () => void }).unref();
          }
        });
      }
      try {
        await entry.pooledStore.store.close();
        this.logger.debug?.(`${TAG} Closed store for ${instanceId} (after ${this.graceCloseDelayMs}ms grace)`);
      } catch (e) {
        this.logger.warn(`${TAG} Error closing store for ${instanceId}: ${e}`);
      }
    })();

    this.pendingCloses.add(closePromise);
    closePromise.finally(() => this.pendingCloses.delete(closePromise));
    // 不 await — 调用方立即返回, 真 close 在后台进行
  }

  private async evictLru(): Promise<void> {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.pool) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.pool.get(oldestKey)!;
      await this.closeEntry(oldestKey, entry);
      this.logger.debug?.(`${TAG} LRU evicted store for ${oldestKey}`);
    }
  }

  /** Skill store LRU 淘汰：踢掉最久未访问的 entry. */
  private evictSkillStoreLru(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, time] of this.skillStoreAccessTimes) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const store = this.skillStoreCache.get(oldestKey);
      if (store) {
        try {
          store.close();
        } catch (e) {
          this.logger.warn(`${TAG} Error closing skill store ${oldestKey} during LRU evict: ${e}`);
        }
      }
      this.skillStoreCache.delete(oldestKey);
      this.skillStoreAccessTimes.delete(oldestKey);
      this.logger.debug?.(`${TAG} LRU evicted skill store: ${oldestKey}`);
    }
  }
}
