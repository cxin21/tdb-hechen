/**
 * Store Factory — creates the storage backend and embedding service based on
 * plugin configuration.
 *
 * DSH-only 构建只保留一个存储实现（docs/adr/0021「可选后端退场」）：
 * - "sqlite"（唯一实现）：local SQLite + sqlite-vec + FTS5
 *
 * TCVDB（腾讯云向量库，服务模式专用）已整组退场。配置里仍写 `storeBackend: "tcvdb"`
 * 时**构造期直接抛错**，不静默回落 sqlite —— 老部署静默降级到本地库会让数据「看起来
 * 还在、实际换了库」，比启动即报错危险得多。
 */

import path from "node:path";
import type { MemoryTdaiConfig } from "../../config.js";
import type { IMemoryStore, IEmbeddingService, StoreLogger } from "./types.js";
import { VectorStore } from "./sqlite.js";
import { createEmbeddingService } from "./embedding.js";
import type { EmbeddingService } from "./embedding.js";
import { createBM25Encoder } from "./bm25-local.js";
import type { BM25LocalEncoder } from "./bm25-local.js";

// Re-export for convenience
export type { IMemoryStore, IEmbeddingService, StoreLogger, BM25LocalEncoder };

const TAG = "[memory-tdai][factory]";

/** 配置里写了已退场存储后端时抛出的错误。 */
export class RetiredStoreBackendError extends Error {
  readonly backend: string;

  constructor(backend: string) {
    super(
      `${TAG} store backend "${backend}" has been retired in the DSH-only build ` +
        `(TCVDB 服务模式已整组退场，服务端 embedding / 混合检索一并移除). ` +
        `Nothing was created and no silent fallback to sqlite happened: set ` +
        `storeBackend: "sqlite" in your gateway config (or drop the key — "sqlite" is the ` +
        `default) and point gateway.dataDir at your existing local vectors.db. ` +
        `Existing TCVDB data is NOT migrated automatically — see docs/adr/0021.`,
    );
    this.name = "RetiredStoreBackendError";
    this.backend = backend;
  }
}

/**
 * 校验存储后端是否仍受支持：只有 sqlite 可用，其余一律抛错。
 * 供网关在启动早期调用（fail-loud，先于任何 IO）。
 */
export function assertStoreBackendSupported(backend: string): void {
  if (backend === "sqlite") return;
  throw new RetiredStoreBackendError(backend);
}

export interface StoreBundle {
  store: IMemoryStore;
  embedding: IEmbeddingService;
  bm25Encoder?: BM25LocalEncoder;
  /** Snapshot of current store config for manifest writing. */
  storeSnapshot: import("../../utils/manifest.js").StoreConfigSnapshot;
}

/**
 * Create the storage backend, embedding service, and optional BM25 encoder
 * based on plugin configuration.
 *
 * @param config       Fully resolved plugin config.
 * @param options.dataDir    Plugin data directory.
 * @param options.logger     Logger instance.
 */
export function createStoreBundle(
  config: MemoryTdaiConfig,
  options: { dataDir: string; logger?: StoreLogger },
): StoreBundle {
  const { logger } = options;

  // fail-loud：已退场的后端在这里就断，不允许走到下面回落到 sqlite
  assertStoreBackendSupported(config.storeBackend);

  // ── BM25 local encoder ──
  const bm25Encoder = createBM25Encoder(config.bm25, logger);

  // ── Embedding service (only when enabled) ──
  let embeddingService: EmbeddingService | undefined;
  if (config.embedding.enabled && config.embedding.provider !== "local" && config.embedding.apiKey) {
    embeddingService = createEmbeddingService({
      provider: config.embedding.provider,
      baseUrl: config.embedding.baseUrl,
      apiKey: config.embedding.apiKey,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      sendDimensions: config.embedding.sendDimensions,
      maxInputChars: config.embedding.maxInputChars,
      // F3：单批条数上限随配置走（生产 ark 端点上限 10 → config 必须设 10，否则整批 400）
      maxBatchSize: config.embedding.maxBatchSize,
    }, logger);
  }

  // dimensions from config (0 when provider="none" → vec0 deferred)
  const dims = config.embedding.dimensions;
  const dbPath = path.join(options.dataDir, "vectors.db");
  const store = new VectorStore(dbPath, dims, logger);

  // R-A3（E2）：listValues 租户级缓存 TTL 接线（recall.valuesCacheTtlMs，<=0 = 缓存关）
  if (typeof (store as VectorStore).setValuesCacheTtlMs === "function") {
    (store as VectorStore).setValuesCacheTtlMs(config.recall?.valuesCacheTtlMs ?? 60_000);
  }

  logger?.debug?.(
    `${TAG} Store created: backend=sqlite, dbPath=${dbPath}, dimensions=${dims}, ` +
    `embedding=${embeddingService ? "enabled" : "disabled"}, ` +
    `bm25=${bm25Encoder ? "enabled" : "disabled"}`,
  );

  return {
    store,
    embedding: embeddingService as unknown as IEmbeddingService,
    bm25Encoder,
    storeSnapshot: {
      type: "sqlite",
      sqlitePath: path.relative(options.dataDir, dbPath),
    },
  };
}
