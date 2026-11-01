/**
 * 元数据存储工厂 + 配置解析 + MetadataStorePool（v3.0 按实例分库）。
 *
 * DSH-only 构建只保留 SQLite 后端（docs/adr/0021「可选后端退场」）：
 * MongoDB 实现（mongodb-adapter.ts）已删除，MySQL 从未实现。配置层面
 * `TDAI_METADATA_MONGO_URI` 非空、或显式要求 mongodb/mysql 时**启动期直接抛错**，
 * 不静默回落 SQLite —— 元数据库静默换库会让「实例配置看起来还在、实际读的是空库」。
 */

import { rm } from "node:fs/promises";
import type { IMetadataStore, MetadataBackend } from "./interface.js";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import {
  DEFAULT_METADATA_DB_PREFIX,
  resolveMetadataDbName,
  resolveSqliteDbDir,
  resolveSqliteDbPath,
} from "./db-name.js";

export interface MetadataStoreConfig {
  backend: MetadataBackend;
  /** SQLite 根目录。每个实例：{baseDir}/tdai_metadata_{id}/metadata.db */
  sqliteBaseDir?: string;
  /** 内存中最多缓存多少个实例 store 连接（LRU 驱逐，仅 close 不删库）。 */
  storeCacheMaxInstances?: number;
  /** 库名前缀，默认 `tdai_metadata`；完整库名 `{prefix}_{instance_id}`。 */
  mongoDbPrefix?: string;
}

export interface PurgeMetadataResult {
  db_name: string;
  dropped: boolean;
}

export type MetadataDeployMode = "standalone" | "service";

const DEFAULT_SQLITE_BASE = "./data/metadata";
const DEFAULT_STORE_CACHE_MAX = 128;

/** 配置里要求已退场元数据后端时抛出的错误。 */
export class RetiredMetadataBackendError extends Error {
  readonly backend: string;

  constructor(backend: string, hint?: string) {
    super(
      `[metadata] backend "${backend}" has been retired in the DSH-only build ` +
        `(MongoDB adapter removed; MySQL was never implemented). ` +
        `Nothing was opened and no silent fallback to sqlite happened. ` +
        `Use the built-in SQLite metadata store instead: unset TDAI_METADATA_MONGO_URI ` +
        `(or TDAI_METADATA_MONGO_* ), keep TDAI_METADATA_SQLITE_BASE_DIR pointing at ` +
        `your metadata root, and copy each instance db from Mongo to ` +
        `{baseDir}/tdai_metadata_{id}/metadata.db — see docs/adr/0021.` +
        (hint ? ` (${hint})` : ""),
    );
    this.name = "RetiredMetadataBackendError";
    this.backend = backend;
  }
}

function hasExplicitMongoUri(env: NodeJS.ProcessEnv): boolean {
  return !!env.TDAI_METADATA_MONGO_URI?.trim();
}

function hasExplicitSqliteBaseDir(env: NodeJS.ProcessEnv): boolean {
  return !!env.TDAI_METADATA_SQLITE_BASE_DIR?.trim();
}

/**
 * Mongo 与 SQLite 根目录不可同时显式配置。
 *
 * MongoDB 退场后这条校验只承担「提醒」作用：一旦设置了 MONGO_URI 就会在
 * loadStoreConfig 里直接抛 RetiredMetadataBackendError，比起「两个都配」的
 * 冲突报错更准确，因此这里只保留 SQLite-only 的宽松分支。
 */
export function assertMetadataStoreConfigExclusive(env: NodeJS.ProcessEnv = process.env): void {
  if (hasExplicitMongoUri(env) && hasExplicitSqliteBaseDir(env)) {
    throw new RetiredMetadataBackendError(
      "mongodb",
      "both TDAI_METADATA_MONGO_URI and TDAI_METADATA_SQLITE_BASE_DIR are set",
    );
  }
}

/**
 * 从环境变量解析存储配置（DSH-only：只有 sqlite）。
 *
 * 推断规则：
 *   - TDAI_METADATA_MONGO_URI 非空 → 抛 RetiredMetadataBackendError（Mongo 已退场）
 *   - 否则 → sqlite（显式 TDAI_METADATA_SQLITE_BASE_DIR 或 fallback）
 *
 * 废弃：TDAI_METADATA_BACKEND、TDAI_METADATA_MONGO_DB、TDAI_METADATA_SQLITE_PATH
 */
export function loadStoreConfig(
  env: NodeJS.ProcessEnv = process.env,
  fallbackSqliteBaseDir?: string,
): MetadataStoreConfig {
  assertMetadataStoreConfigExclusive(env);

  const cacheMax = parseInt(env.TDAI_METADATA_STORE_CACHE_MAX ?? "", 10);
  const storeCacheMaxInstances =
    Number.isFinite(cacheMax) && cacheMax > 0 ? cacheMax : DEFAULT_STORE_CACHE_MAX;

  const mongoDbPrefix =
    env.TDAI_METADATA_MONGO_DB_PREFIX?.trim() || DEFAULT_METADATA_DB_PREFIX;

  if (hasExplicitMongoUri(env)) {
    throw new RetiredMetadataBackendError(
      "mongodb",
      "TDAI_METADATA_MONGO_URI is still set in the environment",
    );
  }

  return {
    backend: "sqlite",
    sqliteBaseDir: env.TDAI_METADATA_SQLITE_BASE_DIR ?? fallbackSqliteBaseDir ?? DEFAULT_SQLITE_BASE,
    storeCacheMaxInstances,
    mongoDbPrefix,
  };
}

/** 元数据配置校验失败时抛出，Gateway 启动应 fail-fast。 */
export class MetadataStartupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataStartupValidationError";
  }
}

export function validateMetadataStartupConfig(
  deployMode: MetadataDeployMode,
  env: NodeJS.ProcessEnv = process.env,
  fallbackSqliteBaseDir?: string,
): MetadataStoreConfig {
  const config = loadStoreConfig(env, fallbackSqliteBaseDir);
  if (deployMode !== "service") {
    return config;
  }

  // deployMode=service 的全套依赖（TCVDB 内存库 + MongoDB 元数据库 + Redis 状态后端 +
  // 私有 integrations 子模块）已整组退场，service 模式在 DSH-only 构建里无法成立。
  throw new MetadataStartupValidationError(
    "Metadata startup validation failed: deployMode=service requires the MongoDB metadata " +
      "backend and the private integrations submodule, both retired in the DSH-only build. " +
      "Set deployMode=standalone (single-instance, SQLite state + SQLite metadata) — " +
      "see docs/adr/0021.",
  );
}

/**
 * 构造并初始化单个实例库的 IMetadataStore。
 */
export async function createMetadataStore(
  config: MetadataStoreConfig,
  instanceId: string,
): Promise<IMetadataStore> {
  if ((config.backend as string) !== "sqlite") {
    throw new RetiredMetadataBackendError(String(config.backend));
  }

  const baseDir = config.sqliteBaseDir ?? DEFAULT_SQLITE_BASE;
  const dbPath = resolveSqliteDbPath(baseDir, instanceId, config.mongoDbPrefix);
  const store = new SqliteMetadataStore(dbPath);
  await store.init();
  return store;
}

interface CachedStore {
  instanceId: string;
  store: IMetadataStore;
}

/**
 * 按实例懒建库、LRU 缓存、purge 删目录。
 */
export class MetadataStorePool {
  private readonly cache = new Map<string, CachedStore>();
  private readonly config: MetadataStoreConfig;

  constructor(config: MetadataStoreConfig) {
    if ((config.backend as string) !== "sqlite") {
      throw new RetiredMetadataBackendError(String(config.backend));
    }
    this.config = config;
  }

  get backend(): MetadataBackend {
    return this.config.backend;
  }

  private get dbPrefix(): string {
    return this.config.mongoDbPrefix?.trim() || DEFAULT_METADATA_DB_PREFIX;
  }

  private touchLru(instanceId: string, entry: CachedStore): void {
    this.cache.delete(instanceId);
    this.cache.set(instanceId, entry);
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    const max = this.config.storeCacheMaxInstances ?? DEFAULT_STORE_CACHE_MAX;
    while (this.cache.size > max) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      if (oldest) {
        void Promise.resolve(oldest.store.close()).catch(() => {});
      }
    }
  }

  async getStore(instanceId: string): Promise<IMetadataStore> {
    const existing = this.cache.get(instanceId);
    if (existing) {
      this.touchLru(instanceId, existing);
      return existing.store;
    }

    const store = await createMetadataStore(this.config, instanceId);
    const entry: CachedStore = { instanceId, store };
    this.cache.set(instanceId, entry);
    this.evictIfNeeded();
    return store;
  }

  async purgeInstance(instanceId: string): Promise<PurgeMetadataResult> {
    const dbName = resolveMetadataDbName(instanceId, this.dbPrefix);
    const cached = this.cache.get(instanceId);
    if (cached) {
      await Promise.resolve(cached.store.close()).catch(() => {});
      this.cache.delete(instanceId);
    }

    const baseDir = this.config.sqliteBaseDir ?? DEFAULT_SQLITE_BASE;
    const dir = resolveSqliteDbDir(baseDir, instanceId, this.dbPrefix);
    await rm(dir, { recursive: true, force: true });
    return { db_name: dbName, dropped: true };
  }

  async closeAll(): Promise<void> {
    for (const [key, entry] of this.cache) {
      await Promise.resolve(entry.store.close()).catch(() => {});
      this.cache.delete(key);
    }
  }
}

export async function createMetadataStorePool(
  config: MetadataStoreConfig,
): Promise<MetadataStorePool> {
  return new MetadataStorePool(config);
}
