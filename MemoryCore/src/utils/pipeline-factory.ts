/**
 * Pipeline factory: shared infrastructure for creating and wiring
 * MemoryPipelineManager instances with VectorStore, EmbeddingService,
 * L1 runner, L2 runner, L3 runner, and persister.
 *
 * Used by both:
 * - `index.ts` (live plugin runtime)
 * - `seed-runtime.ts` (standalone seed CLI command)
 *
 * This avoids duplicating VectorStore init, L1/L2/L3 extraction logic,
 * persister wiring, and destroy sequences across multiple callers.
 */

import fs from "node:fs";
import path from "node:path";
import type { MemoryTdaiConfig } from "../config.js";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { L2Runner, L3Runner } from "./pipeline-manager.js";
import { SessionFilter } from "./session-filter.js";
import { extractL1Memories } from "../core/record/l1-extractor.js";
import { extractSceneBatches } from "./scene-batch-split.js";
import { readConversationMessagesGroupedBySessionId } from "../core/conversation/l0-recorder.js";
import type { ConversationMessage } from "../core/conversation/l0-recorder.js";
import { CheckpointManager } from "./checkpoint.js";
import { metricProducer } from "../core/report/kafka-metric-producer.js";
import { compileSessionIgnorePatterns, DEFAULT_IGNORE_SESSION_PATTERNS } from "./session-ignore.js";
import type { PipelineSessionState } from "./checkpoint.js";
import { createStoreBundle } from "../core/store/factory.js";
import type { IMemoryStore } from "../core/store/types.js";
import { memoryPromptResolveKey, resolveMemoryPrompts } from "../core/memory-prompt/resolver.js";
import {
  buildGenerationLogIdentity,
  buildGenerationProvenance,
  buildPromptGenerationRef,
  MemoryGenerationLogStore,
} from "../core/memory-generation-log/store.js";
import {
  buildMemoryGenerationRefId,
  type MemoryGenerationLog,
} from "../core/memory-generation-log/types.js";
import { writeGenerationProvenanceBestEffort } from "../core/memory-generation-log/best-effort.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import { scheduleReindex } from "./reindex-state.js";
import {
  readManifest,
  writeManifest,
  buildStoreInfo,
  diffStoreBinding,
  type Manifest,
} from "./manifest.js";
import { SceneExtractor } from "../core/scene/scene-extractor.js";
import { PersonaTrigger } from "../core/persona/persona-trigger.js";
import { PersonaGenerator } from "../core/persona/persona-generator.js";
import {
  DEFAULT_PROFILE_SCOPE,
  buildProfileIsolationScope,
  parseProfileIsolationScope,
  pullProfilesToLocal,
  listLocalProfiles,
  syncLocalProfilesToStore,
  type ProfileIsolation,
  type ProfileScopeOptions,
} from "../core/profile/profile-sync.js";
import { createScopedStorageAdapter, StorageAdapter } from "../core/storage/adapter.js";
import type { Logger } from "../core/types.js";
import { isContentBearingScaffoldText, isNonRealL0Classification } from "./sanitize.js";

const TAG = "[memory-tdai] [pipeline-factory]";

// ============================
// L1 batch sizing constants
// ============================
//
// Each L1 run consumes at most `L1_BATCH_PROCESS` L0 rows past the cursor.
// The runner over-fetches `L1_BATCH_QUERY` (= 2 * L1_BATCH_PROCESS) rows so
// it can detect backlog from the query result without an extra round-trip:
//   - returned R == L1_BATCH_QUERY → DB very likely has many more rows;
//     pipeline-manager / executor immediately enqueues the next L1 round.
//   - L1_BATCH_PROCESS < R < L1_BATCH_QUERY → small tail; pipeline-manager
//     defers via the existing l1Idle timer (reuses the standard idle path).
//   - R <= L1_BATCH_PROCESS → fully consumed; nothing to do.
//
// Constants live here because both the standalone runner (this file) and
// the service-mode worker (gateway/server.ts) depend on the same
// over-fetch-by-1x semantic to recognize backlog.
// Aligned with l1-extractor's maxMessagesPerExtraction (default 10) so that
// every L0 row in the batch is seen by the LLM as a "new" message.
// Previous value of 20 caused the extractor's slice(-10) to silently
// truncate the first 5 rows per batch. Trade-off: drain rounds double
// under backlog, but zero data loss.
export const L1_BATCH_PROCESS = 10;
export const L1_BATCH_QUERY = L1_BATCH_PROCESS * 2;

/**
 * #137（W1 双通道）：三开关联动护栏。
 *
 * 事实通道的写读是三个独立开关（extraction.facts / write.factKey.mode / recall.factChannel），
 * 任一错配都是**静默空跑**：写侧建了索引读侧不查（空转），或读侧开了但库里没向量（空查）。
 * 这里只在真错配时 warn 一次；不改任何行为（config-first：不替用户改配置）。
 */
let factChannelMismatchWarned = false;
function warnFactChannelMismatch(cfg: MemoryTdaiConfig, logger: PipelineLogger): void {
  if (factChannelMismatchWarned) return;
  const channelWrite = cfg.write?.factKey?.enabled === true && (cfg.write.factKey.mode ?? "replace") === "channel";
  const readOn = cfg.recall?.factChannel?.enabled === true;
  if (channelWrite === readOn) return;
  factChannelMismatchWarned = true;
  const msg = channelWrite
    ? "write.factKey.mode=channel 已开但 recall.factChannel.enabled=false——事实通道向量会写入但召回不走（索引空转）"
    : "recall.factChannel.enabled=true 但写侧不是 channel 模式——库里没有事实通道向量，通道只会空查";
  logger.warn?.(`${TAG} [fact-channel] 开关不一致：${msg}（#137 提示，不改行为）`);
}

function supportsProfileSyncWrite(store?: IMemoryStore): boolean {
  return !!(store?.syncProfiles || store?.deleteProfiles);
}

export const PROFILE_L2_KEY_PREFIX = "profile:";

function buildIsolationScope(ctx?: ProfileIsolation): string {
  return buildProfileIsolationScope(ctx);
}

export function buildProfileL2Key(ctx?: ProfileIsolation): string {
  const sourceSession = ctx?.sessionId ? `|session:${encodeURIComponent(ctx.sessionId)}` : "";
  return `${PROFILE_L2_KEY_PREFIX}${buildIsolationScope(ctx)}${sourceSession}`;
}

function parseProfileL2Key(key: string): ProfileIsolation | undefined {
  if (!key.startsWith(PROFILE_L2_KEY_PREFIX)) return undefined;
  return parseProfileIsolationScope(key.slice(PROFILE_L2_KEY_PREFIX.length));
}

function profileStoragePrefixForScope(scope: string): string {
  return `profiles/${encodeURIComponent(scope)}/`;
}

function scopedStorage(storage: StorageAdapter | undefined, ctx?: ProfileIsolation): StorageAdapter | undefined {
  return storage ? createScopedStorageAdapter(storage, profileStoragePrefixForScope(buildIsolationScope(ctx))) : undefined;
}

function scopedStorageForScope(storage: StorageAdapter | undefined, scope: string): StorageAdapter | undefined {
  if (!storage || scope === DEFAULT_PROFILE_SCOPE) return storage;
  return createScopedStorageAdapter(storage, profileStoragePrefixForScope(scope));
}

function scopedDataDir(dataDir: string, ctx?: ProfileIsolation): string {
  return scopedDataDirForScope(dataDir, buildIsolationScope(ctx));
}

function scopedDataDirForScope(dataDir: string, scope: string): string {
  return scope === DEFAULT_PROFILE_SCOPE ? dataDir : path.join(dataDir, "profiles", encodeURIComponent(scope));
}

function profileOptionsForScope(scope: string): ProfileScopeOptions | undefined {
  if (scope === DEFAULT_PROFILE_SCOPE) return undefined;
  return { scope, isolation: parseProfileIsolationScope(scope) };
}

async function discoverProfileScopes(dataDir: string, storage: StorageAdapter | undefined, logger: Logger): Promise<string[]> {
  const scopes = new Set<string>();
  if (storage) {
    try {
      const result = await storage.getBackend().listObjects("profiles/", { recursive: true, maxKeys: 10000 });
      for (const entry of result.entries) {
        const rest = entry.key.startsWith("profiles/") ? entry.key.slice("profiles/".length) : "";
        const encoded = rest.split("/")[0];
        if (encoded) scopes.add(decodeURIComponent(encoded));
      }
    } catch (err) {
      logger.debug?.(`${TAG} [L3] Failed to discover storage profile scopes: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    try {
      const entries = await fs.promises.readdir(path.join(dataDir, "profiles"), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) scopes.add(decodeURIComponent(entry.name));
      }
    } catch {
      // No scoped profiles yet; legacy root mode below handles existing unscoped scene files.
    }
  }
  return Array.from(scopes).sort();
}

// ============================
// Logger interface
// ============================

/** @deprecated Use `Logger` from `../core/types.js` directly. */
export type PipelineLogger = Logger;

// ============================
// Factory options
// ============================

export interface PipelineFactoryOptions {
  /** Plugin data directory (L0, records, scene_blocks, vectors.db, etc.). */
  pluginDataDir: string;
  /** Parsed memory-tdai config. */
  cfg: MemoryTdaiConfig;
  /** OpenClaw config object (needed for LLM calls in L1). */
  openclawConfig: unknown;
  /** Logger instance. */
  logger: PipelineLogger;
  /** Session filter (optional, defaults to empty). */
  sessionFilter?: SessionFilter;
  /** Host-neutral LLM runner for L1 extraction (text-only, enableTools=false). */
  l1LlmRunner?: import("../core/types.js").LLMRunner;
  /** Host-neutral LLM runner for L2/L3 (tool-call enabled, enableTools=true). */
  l2l3LlmRunner?: import("../core/types.js").LLMRunner;
}

// ============================
// Factory result
// ============================

export interface PipelineInstance {
  /** The pipeline scheduler. */
  scheduler: MemoryPipelineManager;
  /** VectorStore (undefined if init failed or degraded). */
  vectorStore: IMemoryStore | undefined;
  /** EmbeddingService (undefined if not configured or init failed). */
  embeddingService: EmbeddingService | undefined;
  /**
   * Destroy all resources (scheduler, VectorStore, EmbeddingService).
   * Call this on shutdown / cleanup.
   */
  destroy: () => Promise<void>;
}

// ============================
// Data directory init
// ============================

/**
 * Ensure all required data subdirectories exist under `pluginDataDir`.
 * Safe to call multiple times (mkdirSync with `recursive: true`).
 *
 * When a StorageAdapter is provided, local directory creation is skipped
 * because files are stored remotely (COS). The backend handles path creation.
 */
export function initDataDirectories(dataDir: string, storage?: StorageAdapter): void {
  if (storage) return; // COS mode: no local directories needed
  const dirs = ["conversations", "records", "scene_blocks", ".metadata", ".backup"];
  for (const sub of dirs) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
}

// ============================
// Store init (once-async singleton)
// ============================

export interface StoreInitResult {
  vectorStore: IMemoryStore | undefined;
  embeddingService: EmbeddingService | undefined;
  /** Whether a background re-index is needed (embedding config changed). */
  needsReindex: boolean;
  reindexReason?: string;
}

/**
 * Cached store init promises — keyed by `pluginDataDir` so that different
 * data directories (e.g. live runtime vs. seed output) each get their own
 * store instance, while concurrent callers for the *same* directory share
 * one initialization.
 */
const _storeInitCache = new Map<string, Promise<StoreInitResult>>();

/**
 * Initialize store backend and (optionally) EmbeddingService.
 *
 * **Once-async semantics per dataDir**: the first call for a given
 * `pluginDataDir` creates the store and caches the result; subsequent
 * calls with the same dir return the cached Promise immediately.
 * Call `resetStores()` during shutdown to clear the cache.
 *
 * Supports both SQLite (sync init) and TCVDB (async init) backends.
 */
export function initStores(
  cfg: MemoryTdaiConfig,
  pluginDataDir: string,
  logger: PipelineLogger,
): Promise<StoreInitResult> {
  const key = pluginDataDir;
  if (!_storeInitCache.has(key)) {
    _storeInitCache.set(key, _doInitStores(cfg, pluginDataDir, logger));
  }
  return _storeInitCache.get(key)!;
}

/**
 * Reset the cached store singleton(s).
 *
 * Call this during `gateway_stop` (after closing the actual store/embedding
 * resources) so that a subsequent `register()` on hot-restart can
 * re-initialize fresh instances.
 *
 * @param pluginDataDir  If provided, only clear the cache for that dir.
 *                       If omitted, clear all cached stores.
 */
export function resetStores(pluginDataDir?: string): void {
  if (pluginDataDir) {
    _storeInitCache.delete(pluginDataDir);
  } else {
    _storeInitCache.clear();
  }
}

/**
 * Internal: actual store initialization logic (called once by the cache).
 */
async function _doInitStores(
  cfg: MemoryTdaiConfig,
  pluginDataDir: string,
  logger: PipelineLogger,
): Promise<StoreInitResult> {
  let vectorStore: IMemoryStore | undefined;
  let embeddingService: EmbeddingService | undefined;
  let needsReindex = false;
  let reindexReason: string | undefined;

  try {
    const bundle = createStoreBundle(cfg, {
      dataDir: pluginDataDir,
      logger,
    });
    vectorStore = bundle.store;
    embeddingService = bundle.embedding ?? undefined;

    const providerInfo = embeddingService?.getProviderInfo();
    const initResult = await vectorStore.init(providerInfo);

    if (vectorStore.isDegraded()) {
      throw new Error(`${TAG} VectorStore is in degraded mode — refusing to proceed without functional store`);
    } else {
      logger.debug?.(
        `${TAG} Store initialized: backend=${cfg.storeBackend}, provider=${cfg.embedding.provider}`,
      );
      needsReindex = initResult.needsReindex;
      reindexReason = initResult.reason;

      // spec §6.2：指纹漂移 → 后台全量重建（不阻塞启动；状态经 getReindexState 透出）
      if (needsReindex && vectorStore && embeddingService) {
        logger.warn?.(`${TAG} embedding 配置变更 → 后台全量重建向量索引 (${reindexReason ?? "unknown"})`);
        scheduleReindex(vectorStore as Parameters<typeof scheduleReindex>[0], embeddingService, logger);
      }

      // ── Manifest: first-write + config-drift detection ──
      try {
        const currentStoreInfo = buildStoreInfo(bundle.storeSnapshot);
        const existing = readManifest(pluginDataDir);

        if (!existing) {
          // First init — write manifest
          const manifest: Manifest = {
            version: 1,
            createdAt: new Date().toISOString(),
            store: currentStoreInfo,
            seed: null,
          };
          writeManifest(pluginDataDir, manifest);
          logger.debug?.(`${TAG} Manifest created: ${JSON.stringify(currentStoreInfo)}`);
        } else {
          // Compare persisted store binding against current config
          const diffs = diffStoreBinding(existing.store, currentStoreInfo);
          if (diffs.length > 0) {
            logger.debug?.(
              `${TAG} Store config differs from initial binding recorded in manifest ` +
              `(${diffs.join("; ")}). ` +
              `This is expected if the storage backend was switched intentionally.`,
            );
          }
        }
      } catch (err) {
        logger.warn(`${TAG} Failed to read/write manifest (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logger.warn(
      `${TAG} Store init failed; vector/FTS recall and dedup conflict detection will be unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    vectorStore = undefined;
    embeddingService = undefined;
  }

  return { vectorStore, embeddingService, needsReindex, reindexReason };
}

// ============================
// L1 Runner factory
// ============================

/**
 * Create the standard L1 runner function.
 *
 * Reads L0 messages (from VectorStore DB or JSONL fallback), groups by sessionId,
 * runs extractL1Memories for each group, and updates the checkpoint cursor.
 */
export function createL1Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore | undefined;
  embeddingService: EmbeddingService | undefined;
  logger: PipelineLogger;
  /**
   * Getter for the plugin instance ID used for metric reporting.
   * Called at runner execution time (not at creation time) so that the ID is
   * available even when the runner is wired before instanceId is resolved.
   * Metrics are skipped when the getter returns undefined.
   */
  getInstanceId?: () => string | undefined;
  /** Host-neutral LLM runner for L1 extraction (standalone/gateway mode). */
  llmRunner?: import("../core/types.js").LLMRunner;
  /** StorageAdapter for file operations (COS/local). */
  storage?: StorageAdapter;
  /**
   * 跨节点保护 checkpoint 读改写的分布式锁配置。
   * service 模式下必须提供，否则同 instance 的多节点并发会丢失 L1 游标。
   */
  checkpointLock?: import("./checkpoint.js").CheckpointLockOptions;
}): (params: { sessionKey: string }) => Promise<{
  processedCount: number;
  storedCount: number;
  /** True iff the over-fetch returned > L1_BATCH_PROCESS rows (i.e. there's residual past the cursor). */
  hasMore: boolean;
  /** True iff the over-fetch returned exactly L1_BATCH_QUERY rows (i.e. likely large backlog). */
  hasFullBacklog: boolean;
  profileScopes: string[];
  /**
   * D-6（2026-10-31）：本批**提取失败**（LLM 侧失败，游标未推进）。
   *
   * 旧口径只用 processedCount=0 / hasMore=false 表达，与「没活干」不可区分，
   * 上游 executeL1 便把它当成功返回 → pipeline-worker 记 completed、L2 定时器
   * 继续推进（生产实测 HTTP 402 配额耗尽：tasksCompleted=4/tasksFailed=0）。
   * runner 仍**不抛错**（l1-runner-failure.test.ts 的既有契约），只把失败位交给
   * executor，由 executor 抛 typed error 走统一失败/死信路径。
   */
  failed?: boolean;
  /** D-6：失败原因原文（含供应商 HTTP 状态码），用于分类重试。 */
  failureDetail?: string;
  /**
   * D-7（2026-11-01）：LLM 端点的结构化状态码 / 供应商业务码。
   *
   * 生产 402 的文案里没有 `status=402`（只有供应商中文），只靠 failureDetail 文本分类
   * 必然落 unknown（可重试）。适配器把状态码挂在错误对象上 → l1-extractor 原样透传 →
   * 这里交出去，executor 组成 L1ExtractionFailedError 时一步定罪（quota → 立即死信）。
   */
  failureStatus?: number;
  failureProviderCode?: string;
}> {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, embeddingService, logger, getInstanceId, llmRunner, storage, checkpointLock } = opts;
  const config = openclawConfig as Record<string, unknown> | undefined;
  // #137：写读开关联动护栏（错配 = 静默空跑；只提示一次，不改行为）
  warnFactChannelMismatch(cfg, logger);

  return async ({ sessionKey }) => {
    if (!config && !llmRunner) {
      logger.debug?.(`${TAG} [l1] No OpenClaw config and no LLM runner, skipping L1 extraction`);
      return { processedCount: 0, storedCount: 0, hasMore: false, hasFullBacklog: false, profileScopes: [] };
    }

    const checkpoint = new CheckpointManager(pluginDataDir, logger, storage, checkpointLock);
    const cp = await checkpoint.read();
    const runnerState = checkpoint.getRunnerState(cp, sessionKey);

    logger.info(
      `${TAG} [l1] Session ${sessionKey}: l1_cursor=${runnerState.last_l1_cursor || "(start)"}`,
    );

    try {
      // ── Step 1: over-fetch L0 from DB (or JSONL fallback) ──
      //
      // Pull at most L1_BATCH_QUERY (= 2N) rows past the cursor. We then keep
      // the oldest L1_BATCH_PROCESS (= N) for actual processing and use the
      // remaining rows merely as a *signal* to detect backlog. See file-level
      // comment on L1_BATCH_PROCESS / L1_BATCH_QUERY for rationale.
      type FlatMessage = ConversationMessage & { sessionId: string; teamId?: string; taskId?: string; userId: string; agentId: string; recordedAtMs: number; classification?: string };
      let flat: FlatMessage[] = [];
      let queriedCount = 0;

      if (vectorStore && !vectorStore.isDegraded()) {
        const l1Cursor = runnerState.last_l1_cursor > 0
          ? runnerState.last_l1_cursor
          : undefined;
        const dbGroups = await vectorStore.queryL0GroupedBySessionId(sessionKey, l1Cursor, L1_BATCH_QUERY);
        for (const g of dbGroups) {
          for (const m of g.messages) {
            flat.push({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              timestamp: m.timestamp,
              sessionId: g.sessionId,
              teamId: g.teamId,
              taskId: g.taskId,
              userId: g.userId,
              agentId: g.agentId,
              recordedAtMs: m.recordedAtMs,
              classification: m.classification,
            });
          }
        }
        queriedCount = flat.length;
        logger.debug?.(`${TAG} [l1] L0 data source: VectorStore DB, fetched ${queriedCount} rows (limit=${L1_BATCH_QUERY})`);
      } else {
        logger.debug?.(`${TAG} [l1] L0 data source: JSONL files (VectorStore unavailable)`);
        const jsonlGroups = await readConversationMessagesGroupedBySessionId(
          sessionKey,
          pluginDataDir,
          runnerState.last_l1_cursor || undefined,
          logger,
          L1_BATCH_QUERY,
        );
        // NOTE: readConversationMessagesGroupedBySessionId's `limit` semantic
        // historically retains the **newest** N rows when truncating. That is
        // wrong for our backlog-progress-by-cursor model. Since the JSONL path
        // is a degraded fallback (only hit when VectorStore is unavailable),
        // we accept this minor inconsistency for now and rely on the DB path
        // being the production code path. Resort to oldest-first by sorting +
        // re-slicing here as a best-effort.
        for (const g of jsonlGroups) {
          for (const m of g.messages) {
            flat.push({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              timestamp: m.timestamp,
              sessionId: g.sessionId,
              teamId: undefined,
              taskId: undefined,
              userId: "",
              agentId: "",
              recordedAtMs: m.recordedAtMs,
            });
          }
        }
        // Force chronological (oldest-first) ordering by recordedAtMs ↑ then timestamp ↑.
        flat.sort((a, b) => (a.recordedAtMs - b.recordedAtMs) || (a.timestamp - b.timestamp));
        queriedCount = flat.length;
      }

      if (queriedCount === 0) {
        logger.debug?.(`${TAG} [l1] No new L0 messages for session ${sessionKey}`);
        return { processedCount: 0, storedCount: 0, hasMore: false, hasFullBacklog: false, profileScopes: [], failed: false };
      }

      // Re-sort by recordedAtMs ascending (DB path returns ASC already, but
      // groupBy may have permuted ordering across groups; this is cheap).
      flat.sort((a, b) => (a.recordedAtMs - b.recordedAtMs) || (a.timestamp - b.timestamp));

      // ── Step 2: slice the first L1_BATCH_PROCESS rows + same-ms boundary alignment ──
      //
      // To advance the cursor safely we must NOT split a group of rows that
      // share the same recorded_at_ms. Otherwise the next round's filter
      // `recorded_at_ms > cursor` would skip the trailing siblings of the
      // boundary millisecond. Concretely: if rows 20 and 21 carry the same
      // recordedAtMs, we extend the slice past row 21 (and any further siblings)
      // until we hit a strictly greater recordedAtMs or exhaust the buffer.
      //
      // Cost: at most a handful of extra rows per round (bounded by how many
      // siblings share one millisecond). Benefit: zero data loss across
      // millisecond-collision boundaries (e.g. seed bulk-load, multi-message
      // agent_end where all rows are stamped with one `now`).
      let sliceEnd = Math.min(L1_BATCH_PROCESS, flat.length);
      if (sliceEnd < flat.length) {
        const boundaryMs = flat[sliceEnd - 1].recordedAtMs;
        while (sliceEnd < flat.length && flat[sliceEnd].recordedAtMs === boundaryMs) {
          sliceEnd++;
        }
      }
      const processed = flat.slice(0, sliceEnd);

      // ── Step 3: re-group sliced messages by isolation tuple + sessionId (chronological within each group) ──
      const groupMap = new Map<string, { sessionId: string; teamId?: string; taskId?: string; userId: string; agentId: string; messages: ConversationMessage[] }>();
      let maxRecordedAtMs = 0;
      // ── 分类闸门（2026-10-26）：只在「喂给 LLM」这一侧挡，游标照常推进 ──
      //
      // 生产事故：classified 模式下每轮 L0 = 1 条 real 用户消息 + N 条脚手架
      // （runtime context 快照 / system-reminder / 压缩 nudge / 技能正文），
      // 而旧 L1 链路只读 message_text、从不看 classification → 每批 10 条里 8-9 条
      // 是脚手架，LLM 把它们当用户原话提炼成 instruction 记忆（实测 133 条 L1
      // 中 85 条源自脚手架）。
      //
      // 这里结构性挡掉 scaffold/artifact/echo/dup；无标签的行（classified 上线前
      // 的历史行、非 DSH 客户端）落到 l1-extractor 的内容兜底闸门
      // （shouldExtractL1 → isHarnessScaffoldText）。
      //
      // 关键不变量：maxRecordedAtMs 仍统计**全部** processed 行（含被挡的行），
      // 否则整批都是脚手架时游标不前进 → 同一批被无限重取。
      let gateSkipped = 0;
      const gateSkippedByClass: Record<string, number> = {};
      // ── 会话卫生闸（task-83）：探针/测试会话不参与 L1 蒸馏 ──
      //
      // 生产 L0 里混进 128 行探针数据（session_id `probe-*` / `session-probe-*`，
      // 23 会话 / 905,703 字符）。删生产行需用户授权（红线），故先在抽取侧挡住：
      // 命中的行不进候选、不计入 batch。匹配语义见 utils/session-ignore.ts
      // （前缀 + `*` 通配；行级 session_id 与 sessionKey 双查）。
      //
      // cfg 是手工构造（测试 / seed / 旧调用方）时可能没有本字段 → 回落缺省（不是关闸）；
      // 显式 `[]` 才是关闸（逐位回到 task-83 之前的行为）。
      const ignorePatternsCfg = (cfg.extraction as { ignoreSessionPatterns?: string[] } | undefined)
        ?.ignoreSessionPatterns ?? [...DEFAULT_IGNORE_SESSION_PATTERNS];
      const ignoreMatcher = compileSessionIgnorePatterns(ignorePatternsCfg);
      let ignoredRowCount = 0;
      const ignoredSessions = new Map<string, { pattern: string; matchedOn: "session_id" | "session_key"; rows: number }>();
      /** 被忽略的行：把「不计入 batch」贯彻到会话隔离守卫与 processedCount */
      const ignoredRows = new Set<object>();
      for (const m of processed) {
        if (m.recordedAtMs > maxRecordedAtMs) maxRecordedAtMs = m.recordedAtMs;
        // 「有内容的脚手架」豁免：压缩摘要段 / 后台回执虽被 proxy 归类为 scaffold，
        // 但正文是任务状态与评审结论（生产 L0 回放实测），只挡纯注入物。
        if (isNonRealL0Classification(m.classification) && !isContentBearingScaffoldText(m.content)) {
          gateSkipped++;
          const c = String(m.classification);
          gateSkippedByClass[c] = (gateSkippedByClass[c] ?? 0) + 1;
          continue;
        }
        // 卫生闸：与分类闸同型——先推进 maxRecordedAtMs 再跳过，游标照常前进。
        // （否则探针行会把游标卡在原地 → 同一批被无限重取。）
        const ignoreHit = ignoreMatcher.match(m.sessionId, sessionKey);
        if (ignoreHit) {
          ignoredRowCount++;
          ignoredRows.add(m);
          const seen = ignoredSessions.get(ignoreHit.value);
          if (seen) seen.rows++;
          else ignoredSessions.set(ignoreHit.value, { pattern: ignoreHit.pattern, matchedOn: ignoreHit.matchedOn, rows: 1 });
          continue;
        }
        const groupKey = `${m.userId}\u0000${m.agentId}\u0000${m.sessionId}`;
        let g = groupMap.get(groupKey);
        if (!g) {
          g = { sessionId: m.sessionId, teamId: m.teamId, taskId: m.taskId, userId: m.userId, agentId: m.agentId, messages: [] };
          groupMap.set(groupKey, g);
        }
        g.messages.push({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp });
      }
      const groups: Array<{ sessionId: string; teamId?: string; taskId?: string; userId: string; agentId: string; messages: ConversationMessage[] }> = [];
      for (const group of groupMap.values()) {
        groups.push(group);
      }
      // Sort groups by earliest timestamp so extractL1Memories sees them in
      // the same order they were captured (matches pre-existing behavior).
      groups.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);

      // ── 会话隔离守卫（task-62；用户口径 m02362「检索可以跨会话，抽取不能混」）──
      //
      // 数据事实：store 的 L0 分组键是 (team,user,agent,session_id,task)（sqlite.ts:5617），
      // 而 L1 取数是 `WHERE session_key = ?`（sqlite.ts:1251-1265）——生产里 sessionKey
      // 通常是 1:1 的 session_id（实测 211 会话 / 211 session_id），但**类型上允许**一个
      // sessionKey 下出现多个 session_id（key 复用、跨端合并、历史脏数据）。
      //
      // 不变量：抽取语料（corpus）必须单会话。跨会话只能出现在 dedup 的 reference 段
      // （prompts/l1-dedup.ts 的跨会话参考记忆池，带来源标注）。
      //
      // 处理策略：一批里出现 >1 个 session_id 时，只处理**最靠前的一组**（groups 已按
      // 首条时间排序），其余整组延后到下一轮。游标是 sessionKey 级单标量
      // （checkpoint last_l1_cursor），无法表达多会话水位，因此只推进到
      // 「被延后行的最早 recordedAtMs − 1」——这是唯一安全的推进点
      // （下一轮 `recorded_at_ms > cursor` 仍能捞到被延后的行）。代价：被选中会话里
      // 晚于该水位的行会被重取一次（extraction.enableDedup 兜底，不产生重复记忆），
      // 换「零丢行」。
      //
      // sessionScope 缺省 "session"（单会话抽取）。"profile" 回退到旧的多会话同批行为，
      // 仅供排查/灰度，不建议长开。task-81 已接线：键在 MemoryTdaiConfig["extraction"]
      // （config.ts:ExtractionConfig.sessionScope），缺省与非法值归一在 config 加载层，
      // 这里只需按值分支——不要再做软读取/cast，否则「类型里有、运行时没有」无从对账。
      const sessionScope: "session" | "profile" =
        cfg.extraction?.sessionScope === "profile" ? "profile" : "session";
      // 卫生闸之后「计入 batch」的行（被忽略的行只参与游标推进，不参与会话计
      // 数/延后判定——否则探针行会被当成「被延后的会话」，把游标压回到它之前）。
      const effectiveProcessed = ignoredRows.size > 0 ? processed.filter((m) => !ignoredRows.has(m)) : processed;
      const batchSessionIds = Array.from(
        new Set(effectiveProcessed.map((m) => m.sessionId).filter((s): s is string => typeof s === "string" && s.length > 0)),
      );
      let activeGroups = groups;
      let deferredSessionIds: string[] = [];
      let deferredRowCount = 0;
      let cursorCeilingMs: number | undefined;
      if (sessionScope === "session" && groups.length > 1 && batchSessionIds.length > 1) {
        const chosenSessionId = groups[0].sessionId;
        activeGroups = groups.filter((g) => g.sessionId === chosenSessionId);
        deferredSessionIds = batchSessionIds.filter((s) => s !== chosenSessionId);
        let deferredMinMs = Number.POSITIVE_INFINITY;
        for (const m of effectiveProcessed) {
          if (m.sessionId === chosenSessionId) continue;
          deferredRowCount++;
          if (m.recordedAtMs < deferredMinMs) deferredMinMs = m.recordedAtMs;
        }
        if (Number.isFinite(deferredMinMs)) cursorCeilingMs = deferredMinMs - 1;
        logger.info(
          `${TAG} [l1] session isolation: ${batchSessionIds.length} session_id in one batch — processing only ` +
          `session_id=${chosenSessionId} (${activeGroups.length} group(s)); deferred ${deferredSessionIds.length} ` +
          `session(s) / ${deferredRowCount} L0 row(s), cursor ceiling=${cursorCeilingMs ?? "(none)"} (session=${sessionKey})`,
        );
        try {
          // obs 指标：本批出现几个会话（>1 即命中守卫，供监控判「是否常有跨会话积压」）
          metricProducer.send({
            metric: "l1.batch.session_groups",
            instanceId: getInstanceId?.() ?? "standalone",
            value: batchSessionIds.length,
            source: "core",
          });
        } catch {
          // 观测失败不影响业务（与既有 metric 调用一致）
        }
      }


      if (gateSkipped > 0) {
        logger.info(
          `${TAG} [l1] classification gate: ${gateSkipped}/${processed.length} L0 rows skipped ` +
          `(${JSON.stringify(gateSkippedByClass)}), ${groups.length} group(s) remain`,
        );
      }

      // 卫生闸可观测：命中即留痕（session_id + pattern），并送同族指标。
      if (ignoredRowCount > 0) {
        const detail = Array.from(ignoredSessions.entries())
          .slice(0, 5)
          .map(([sid, v]) => `${v.matchedOn}=${sid}(pattern=${v.pattern}, rows=${v.rows})`)
          .join(", ");
        const more = ignoredSessions.size > 5 ? `, +${ignoredSessions.size - 5} more session(s)` : "";
        logger.info(
          `${TAG} [l1] session hygiene gate: ignored ${ignoredRowCount}/${processed.length} L0 rows from ` +
          `${ignoredSessions.size} session(s): ${detail}${more} (session=${sessionKey}, ` +
          `remaining ${effectiveProcessed.length} row(s) / ${groups.length} group(s))`,
        );
        try {
          // obs 指标：本批被忽略的会话数（与 l1.batch.session_groups 同族）
          metricProducer.send({
            metric: "l1.batch.sessions_ignored",
            instanceId: getInstanceId?.() ?? "standalone",
            value: ignoredSessions.size,
            source: "core",
          });
        } catch {
          // 观测失败不影响业务（与既有 metric 调用一致）
        }
      }

      // ── Step 4: backlog detection ──
      //
      // queriedCount is bounded by LIMIT L1_BATCH_QUERY (= 2N).
      // sliceEnd may exceed L1_BATCH_PROCESS due to boundary alignment but
      // never exceeds queriedCount.
      //
      //   - hasFullBacklog: queriedCount === L1_BATCH_QUERY AND there are
      //     unprocessed rows in this batch (sliceEnd < queriedCount). DB
      //     returned a full page → likely many more rows past the cursor;
      //     pipeline-manager / executor enqueues the next L1 task immediately.
      //   - hasMore: any unprocessed row in this batch (queriedCount > sliceEnd)
      //     that is not also flagged as full backlog → small tail; defer to
      //     the standard l1Idle timer.
      //
      // EDGE CASE: if queriedCount === L1_BATCH_QUERY and ALL 2N rows share a
      // single recordedAtMs, boundary alignment cannot detect siblings beyond
      // the LIMIT and `sliceEnd` will end up at queriedCount (everything
      // processed, no unprocessed rows). The cursor advances to that ms; the
      // next round's `> cursor` filter would skip any further same-ms siblings
      // existing past the LIMIT. This is unreachable under realistic capture
      // patterns (agent_end writes ≤ ~10 rows per `now`; seed assigns a fresh
      // `now` per round). If hit, see TODO below for cursor-tiebreaker fix.
      // TODO(known-issue): switch to (recorded_at, record_id) composite cursor
      //   to defend against ≥2N rows sharing one recorded_at_ms.
      const hasUnprocessedInBatch = queriedCount > sliceEnd;
      const hasFullBacklog = queriedCount === L1_BATCH_QUERY && hasUnprocessedInBatch;
      const hasMore = hasUnprocessedInBatch && !hasFullBacklog;

      const totalMessages = processed.length;
      logger.info(
        `${TAG} [l1] Processing ${effectiveProcessed.length} L0 messages (of ${totalMessages} sliced, ` +
        `${ignoredRowCount} ignored by hygiene gate) across ${activeGroups.length} sessionId group(s) ` +
        `for session ${sessionKey} (queried=${queriedCount}, sliceEnd=${sliceEnd}, ` +
        `hasMore=${hasMore}, hasFullBacklog=${hasFullBacklog})`,
      );

      let totalExtracted = 0;
      let totalStored = 0;
      let lastSceneName: string | undefined;      // F-EV12-1（REG-REMAINING-006 A-1）：LLM 失败批次不得推进游标（批次级旗标）。
      let extractionFailed = false;
      // D-6（2026-10-31）：失败原因原文（含供应商 HTTP 状态码），透传给 executor 判类。
      let extractionFailureDetail: string | undefined;
      // D-7：结构化失败信息（LLM 适配器挂的 statusCode/providerCode）——与 detail 同源透传
      let extractionFailureStatus: number | undefined;
      let extractionFailureProviderCode: string | undefined;
      const profileScopes = new Set<string>();
      const l1PromptTargets = groups.map((group) => ({
        teamId: group.teamId,
        agentId: group.agentId,
        layer: "l1" as const,
      }));
      const l1Prompts = await resolveMemoryPrompts(vectorStore, l1PromptTargets);

      // 毒批自适应拆分（L1-OUTAGE-20261015 定罪修复）：思考型端点延迟∝prompt 体积
      // （生产实测 13K≈298s 贴线、20K>300s 恒超时）→ 大批恒超时 → F-EV12-1 游标不
      // 推进（数据安全设计正确）→ 同批 5min 死循环，积压永不排空。组提取失败且组内
      // >1 条消息时对半递归拆分重试；单条仍失败才向上报败（交给既有 requeue）。
      // 部分成功产出保留，重提取由 extraction.enableDedup 兜底（F-EV12-1 语义不变：
      // 游标仍只在全组成功时推进，拆分保证进展）。
      const extractGroupWithSplit = async (
        group: (typeof groups)[number],
        depth: number,
      ): Promise<Awaited<ReturnType<typeof extractL1Memories>>> => {
        const result = await extractL1Memories({
          messages: group.messages,
          sessionKey,
          sessionId: group.sessionId,
          taskId: group.taskId,
          teamId: group.teamId,
          userId: group.userId,
          agentId: group.agentId,
          baseDir: pluginDataDir,
          config,
          // D-R5-1：MemoryTdaiConfig 权威接线（selfIdentity gating 读取源）——
          // openclawConfig 无 coreMemory 子树（宿主配置），AGENT_ACT_BLOCK 恒死配置。
          memoryConfig: cfg,
          options: {
            enableDedup: cfg.extraction.enableDedup,
            enableMemoryLinks: cfg.links.enabled,
            // #134 写面策略（W1 事实键 / W2 写时 supersession；缺省全关=逐位现状）
            writePolicy: cfg.write,
            // S1（T9 裁决待办收口）：similar 建边门槛配置化透传（memory.links.minSimilarity）
            minSimilarity: cfg.links.minSimilarity,
            maxMemoriesPerSession: cfg.extraction.maxMemoriesPerSession,
            model: cfg.extraction.model,
            promptMode: cfg.extraction.promptMode,
            memoryPrompt: l1Prompts.get(memoryPromptResolveKey({
              teamId: group.teamId,
              agentId: group.agentId,
              layer: "l1",
            })),
            previousSceneName: lastSceneName ?? (runnerState.last_scene_name || undefined),
            vectorStore,
            embeddingService,
            conflictRecallTopK: cfg.embedding.conflictRecallTopK,
            // GROW-EVO P2（§2.2）：durative 效期提取开关透传（此前漏传 → 门恒关，
            // LLM 输出的 valid_start 被丢弃——P2 流程测试实测发现）。
            durativeEnabled: cfg.extraction.durativeEnabled === true,
            embeddingTimeoutMs: cfg.embedding.captureTimeoutMs ?? cfg.embedding.timeoutMs,
            llmRunner,
            // 思考开关 config-first 接线（2026-10-14，对齐 L2 R4 形状）：cfg.persona.
            // reasoningEffort → L1 提取/dedup/enrich 全链透传；不支持的端点由
            // llm-runner 400 剥参降级兜底（两种端点都兼容，yaml 配置语义不变）。
            // persona 段可选（测试/旧形状 config 无 persona）→ 软读取。
            reasoningEffort: cfg.persona?.reasoningEffort,
            // 毒批超时（L1-OUTAGE-20261015，config-first）：缺省 300_000=逐位现状
            extractionTimeoutMs: cfg.extraction.extractionTimeoutMs,
            // #79 dedup 判重超时（config-first）：缺省 300_000=逐位现状
            dedupTimeoutMs: cfg.extraction.dedupTimeoutMs,
          },
          logger,
          instanceId: getInstanceId?.(),
          storage,
        });
        if (result.success !== false || group.messages.length <= 1) return result;
        logger.warn(
          `${TAG} [l1] group extraction failed (${group.messages.length} msgs, depth=${depth}) — splitting in half for retry (poison-batch guard)`,
        );
        const mid = Math.floor(group.messages.length / 2);
        const first = await extractGroupWithSplit({ ...group, messages: group.messages.slice(0, mid) }, depth + 1);
        const second = await extractGroupWithSplit({ ...group, messages: group.messages.slice(mid) }, depth + 1);
        return {
          success: first.success !== false && second.success !== false,
          extractedCount: first.extractedCount + second.extractedCount,
          storedCount: first.storedCount + second.storedCount,
          records: [...first.records, ...second.records],
          sceneNames: [...first.sceneNames, ...second.sceneNames],
          lastSceneName: second.lastSceneName ?? first.lastSceneName,
          // D-6：任一半失败即整组失败，把首个失败原因带回上游。
          error: first.error ?? second.error,
          // D-7：结构化字段同样取首个有值的一半（与 error 同源）
          failureStatus: first.failureStatus ?? second.failureStatus,
          failureProviderCode: first.failureProviderCode ?? second.failureProviderCode,
        };
      };

      for (const group of activeGroups) {
        logger.debug?.(
          `${TAG} [l1] Group sessionId=${group.sessionId || "(empty)"}: ${group.messages.length} messages`,
        );

        const l1Result = await extractGroupWithSplit(group, 0);

        totalExtracted += l1Result.extractedCount;
        totalStored += l1Result.storedCount;
        if (l1Result.success === false) {
          extractionFailed = true;
          extractionFailureDetail = extractionFailureDetail ?? l1Result.error;
          extractionFailureStatus = extractionFailureStatus ?? l1Result.failureStatus;
          extractionFailureProviderCode = extractionFailureProviderCode ?? l1Result.failureProviderCode;
        }
        if (l1Result.storedCount > 0) {
          // L2/L3 output is team+agent scoped, but each L2 extraction input must
          // stay bounded to the source session that just produced L1. Encode the
          // source session in the L2 task key; buildIsolationScope() will ignore
          // it later when choosing the profile output directory.
          profileScopes.add(buildProfileL2Key({
            teamId: group.teamId,
            userId: group.userId,
            agentId: group.agentId,
            sessionId: group.sessionId,
          }));
        }
        if (l1Result.lastSceneName) {
          lastSceneName = l1Result.lastSceneName;
        }
      }

      // Use maxRecordedAtMs (write time) of the **processed** slice as cursor —
      // always positive, TCVDB-safe. Boundary alignment guarantees we will not
      // skip same-ms siblings on the next round.
      // F-EV12-1（REG-REMAINING-006 A-1）：LLM 失败批次不得推进游标。
      // extractL1Memories 吞错返回 success:false（l1-extractor.ts:231）——游标语义 =
      // 「已确定提取成功的消息边界」，失败即不推进：下次对话触发 / l1Idle 600s /
      // boot L1_drain 自愈重试（c35a3e6 机制）。部分成功组的产出保留（重提取由
      // extraction.enableDedup 兜底）。hasMore/hasFullBacklog 压平：防
      // pipeline-manager hasFullBacklog→enqueueL1 立即重入队在配额死期形成重试风暴。
      if (extractionFailed) {
        logger.error(
          `${TAG} [l1] L1 extraction FAILED — cursor NOT advanced (session=${sessionKey}, stored=${totalStored}); retry on next conversation/idle/drain trigger`,
        );
        // D-6：显式 failed 位——旧口径只有 hasMore/hasFullBacklog=false + processedCount=0，
        // 上游（executeL1）无从区分「没活干」与「提取失败」，于是把失败任务记成 completed
        // 并继续推进 L2 定时器（实测 HTTP 402 配额耗尽时 tasksConsumed=4/completed=4/failed=0，
        // l1_records 零新增）。现在由 executor 依据 failed 抛错 → 重试/死信。
        return {
          processedCount: 0,
          storedCount: totalStored,
          hasMore: false,
          hasFullBacklog: false,
          profileScopes: Array.from(profileScopes),
          failed: true,
          failureDetail: extractionFailureDetail ?? "L1 extraction failed (no detail)",
          failureStatus: extractionFailureStatus,
          failureProviderCode: extractionFailureProviderCode,
        };
      }
      // 会话隔离守卫：游标只推进到被延后行的最早 recordedAtMs − 1（见上文守卫注释）。
      const cursorMs = cursorCeilingMs !== undefined && cursorCeilingMs > 0
        ? Math.min(maxRecordedAtMs, cursorCeilingMs)
        : maxRecordedAtMs;
      await checkpoint.markL1ExtractionComplete(sessionKey, totalStored, cursorMs || undefined, lastSceneName);
      logger.info(
        `${TAG} [l1] L1 complete: extracted=${totalExtracted}, stored=${totalStored} (${groups.length} group(s))`,
      );

      return {
        // 守卫命中时 processedCount 只算真正处理过的行（被延后的行留给下一轮）；
        // 卫生闸忽略的行同样「不计入 batch」（task-83），只用于推进游标。
        processedCount: Math.max(0, totalMessages - deferredRowCount - ignoredRowCount),
        storedCount: totalStored,
        // 守卫命中 → 立即再拉一轮（hasFullBacklog 保持压平，避免续批风暴）
        hasMore: hasMore || deferredRowCount > 0,
        hasFullBacklog,
        profileScopes: Array.from(profileScopes),
        failed: false,
      };
    } catch (err) {
      logger.error(`${TAG} [l1] L1 failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      throw err;
    }
  };
}

// ============================
// Persister factory
// ============================

/**
 * Create the standard pipeline state persister.
 * Saves pipeline session states to the checkpoint file.
 */
export function createPersister(
  pluginDataDir: string,
  logger: PipelineLogger,
  storage?: StorageAdapter,
): (states: Record<string, PipelineSessionState>) => Promise<void> {
  return async (states) => {
    const checkpoint = new CheckpointManager(pluginDataDir, logger, storage);
    await checkpoint.mergePipelineStates(states);
  };
}

// ============================
// L2 Runner factory
// ============================

/**
 * Create the standard L2 runner function (scene extraction).
 *
 * Reads L1 memory records (incremental via VectorStore or JSONL fallback),
 * runs SceneExtractor, and returns the latest cursor for pipeline-manager
 * to track incremental progress.
 *
 * Used by both `index.ts` (live runtime) and `seed-runtime.ts` (seed CLI).
 */
export function createL2Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore | undefined;
  logger: PipelineLogger;
  instanceId?: string;
  /** Host-neutral LLM runner for L2 scene extraction (standalone/gateway mode). Must have enableTools=true. */
  llmRunner?: import("../core/types.js").LLMRunner;
  /** StorageAdapter for file operations (COS/local). */
  storage?: StorageAdapter;
  /**
   * 跨节点保护 checkpoint 读改写的分布式锁配置。
   * service 模式下必须提供，否则同instance 的多节点并发会丢失计数器修复结果。
   */
  checkpointLock?: import("./checkpoint.js").CheckpointLockOptions;
}): L2Runner {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, logger, instanceId, llmRunner, storage, checkpointLock } = opts;
  let profileBaseline = new Map<string, { version: number; contentMd5: string; createdAtMs: number }>();

  return async (sessionKey: string, cursor?: string) => {
    const profileFilter = parseProfileL2Key(sessionKey);
    logger.debug?.(
      `${TAG} [L2] session=${sessionKey}, profile=${profileFilter ? buildIsolationScope(profileFilter) : "(legacy-session)"}, updatedAfter=${cursor ?? "(full)"}`,
    );

    if (!openclawConfig && !llmRunner) {
      logger.warn(`${TAG} [L2] No OpenClaw config and no LLM runner, skipping scene extraction`);
      return;
    }

    let records: Array<{ content: string; created_at: string; id: string; updatedAt: string; teamId?: string; userId?: string; agentId?: string; sessionId?: string; taskId?: string; valid_end?: string }>;

    if (vectorStore && !vectorStore.isDegraded()) {
      const { queryMemoryRecords } = await import("../core/record/l1-reader.js");
      const memRecords = await queryMemoryRecords(vectorStore, profileFilter ? {
        teamId: profileFilter.teamId,
        userId: profileFilter.userId,
        agentId: profileFilter.agentId,
        sessionId: profileFilter.sessionId,
        updatedAfter: cursor,
      } : {
        sessionKey,
        updatedAfter: cursor,
      }, logger);

      // P4a-2：失效记忆排除出蒸馏输入——scene_blocks 重写不含失效内容
      // （失效记录经 bump updated_time 进入增量视野，但被过滤 → 触发重跑而内容被剔除）
      const activeRecords = memRecords.filter((r) => !(r as { valid_end?: string }).valid_end);
      if (activeRecords.length === 0) {
        logger.debug?.(
          `${TAG} [L2] All new records invalidated — skipping scene extraction (no active content)`,
        );
        return { skipped: true };
      }

      logger.debug?.(
        `${TAG} [L2] Incremental query returned ${memRecords.length} record(s) (session=${sessionKey})`,
      );

      records = memRecords.map((r) => ({
        content: r.content,
        created_at: r.createdAt,
        id: r.id,
        updatedAt: r.updatedAt,
        teamId: r.teamId,
        userId: r.userId,
        agentId: r.agentId,
        sessionId: r.sessionId,
        taskId: r.taskId,
        valid_end: r.valid_end,
      }));
    } else {
      throw new Error(`${TAG} [L2] VectorStore unavailable — cannot read L1 memories for scene extraction (session=${sessionKey})`);
    }

    if (records.length === 0) {
      logger.debug?.(`${TAG} [L2] No new L1 records found (session=${sessionKey}), skipping scene extraction`);
      return;
    }
    // R4 观测面（UR-3 工程侧）：增量窗口无上界，超大批次是 300s 超时/超长 prompt
    // 的风险源。切片限流涉及 cursor 水位线语义（latestCursor 取全窗口 max(updatedAt)，
    // 切错=丢数据），本轮只告警不改切片，登记为后续工程项。
    if (records.length > 100) {
      logger.warn(`${TAG} [L2] Large incremental batch: ${records.length} records in one L2 run (session=${sessionKey}) — timeout/quality risk, consider cursor backfill paging`);
    }

    const grouped = new Map<string, typeof records>();
    for (const record of records) {
      const key = buildIsolationScope(record);
      const list = grouped.get(key) ?? [];
      list.push(record);
      grouped.set(key, list);
    }

    let processedTotal = 0;
    let anyEmptyExtraction = false;
    const l2PromptTargets = [...grouped.values()].map((groupRecords) => ({
      teamId: groupRecords[0]?.teamId,
      agentId: groupRecords[0]?.agentId,
      layer: "l2" as const,
    }));
    const l2Prompts = await resolveMemoryPrompts(vectorStore, l2PromptTargets);
    for (const groupRecords of grouped.values()) {
      const ctx = groupRecords[0];
      const groupStorage = scopedStorage(storage, ctx);
      const groupDataDir = scopedDataDir(pluginDataDir, ctx);
      const groupScope = buildIsolationScope(ctx);
      const groupProfileOptions = profileOptionsForScope(groupScope);
      const groupBaseline = vectorStore?.pullProfiles && !vectorStore.isDegraded()
        ? await pullProfilesToLocal(groupDataDir, vectorStore, logger, groupStorage, groupProfileOptions)
        : profileBaseline;

      const extractor = new SceneExtractor({
        dataDir: groupDataDir,
        config: openclawConfig!,
        model: cfg.persona.model,
        promptMode: cfg.persona.promptMode,
        memoryPrompt: l2Prompts.get(memoryPromptResolveKey({
          teamId: ctx.teamId,
          agentId: ctx.agentId,
          layer: "l2",
        })),
        maxScenes: cfg.persona.maxScenes,
        // R4：逐调用思考开关 config-first 接线（yaml persona.reasoningEffort；
        // 缺省 undefined=端点默认，A/B 实证后再落产线值）
        reasoningEffort: cfg.persona.reasoningEffort,
        // 毒批超时（L1-OUTAGE-20261015，config-first）：L1/L2 共用键；
        // scene-extractor 内部 opts.timeoutMs ?? 300_000（逐位现状）
        timeoutMs: cfg.extraction.extractionTimeoutMs,
        sceneBackupCount: cfg.persona.sceneBackupCount,
        logger,
        instanceId,
        llmRunner,
        storage: groupStorage,
        // 场景块治理（DS-SCENE-GOV-001）：cfg.sceneGovernance 恒解析，门控 extractor 内部用 .enabled
        sceneGovernance: cfg.sceneGovernance,
        // langfuse: 透传身份四元组，UI 上可按 user/session 列过滤
        traceContext: { teamId: ctx.teamId, userId: ctx.userId, agentId: ctx.agentId, sessionId: ctx.sessionId },
      });

      // P4a-2 修正（REG-REMAINING-002 #1 审查发现）：失效排除此前只挡"全失效早退"，
      // 混合窗口（失效+活跃并存）时失效记录仍混入提取 prompt——scene_blocks 会重新
      // 吸收已失效内容。此处按组过滤，对齐上方注释块自述语义；cursor 仍取全窗口
      // （失效记录 bump 推进游标，不会造成重查询循环）。
      const activeGroupRecords = groupRecords.filter((r) => !r.valid_end);
      if (activeGroupRecords.length === 0) {
        logger.debug?.(`${TAG} [L2] Group all-invalidated (scope=${groupScope}), skipping extraction`);
        continue;
      }
      const memories = activeGroupRecords.map((r) => ({
        content: r.content,
        created_at: r.created_at,
        id: r.id,
      }));

      const preCheckpoint = new CheckpointManager(groupDataDir, logger, groupStorage, checkpointLock);
      const preState = await preCheckpoint.read();
      const preScenesProcessed = preState.scenes_processed;
      const preTotalProcessed = preState.total_processed;

      const l2StartMs = Date.now();
      const resolvedL2Prompt = l2Prompts.get(memoryPromptResolveKey({
        teamId: ctx.teamId,
        agentId: ctx.agentId,
        layer: "l2",
      }));
      // #46 毒批拆分+批次上限（config-first，缺省双关=逐位现状单调用）：scene 批
      // 失败对半递归重试 + memoriesJson 估长预分批，镜像 L1 extractGroupWithSplit
      // 先例（:603-669）；单批未拆分时原样透传 extractor 结果对象。
      const extractResult = await extractSceneBatches({
        extract: (m) => extractor.extract(m),
        memories,
        batchMaxChars: cfg.extraction.sceneBatchMaxChars,
        poisonSplit: cfg.extraction.scenePoisonSplit === true,
        warnLog: (message) => logger.warn(message),
      });
      if (!(extractResult.success && extractResult.memoriesProcessed > 0)) continue;
      if (extractResult.emptyExtraction) {
        anyEmptyExtraction = true;
        logger.warn(`${TAG} [L2] Extraction produced no file changes (empty run), skipping checkpoint increment`);
        continue;
      }

      //⚠️ 这里**不能**用 `checkpoint.write({...postState})`：
      //
      // postState 是跨越了整个 L2 LLM 抽取（数秒~数十秒）的旧快照，而write()
      // 是「整对象覆盖 + 只有进程内锁」。用它写回会把这期间其他节点合法推进的
      // runner_states / pipeline_states 全部抹掉（L1 游标丢失 → 重复抽取）。
      //
      // 正确做法：走 repairMonotonicCounters()，在分布式锁保护的临界区内重读，
      // 只对这两个标量做单调取大，绝不触碰其他字段。
      const checkpoint = new CheckpointManager(groupDataDir, logger, groupStorage, checkpointLock);
      const repaired = await checkpoint.repairMonotonicCounters({
        scenes_processed: preScenesProcessed,
        total_processed: preTotalProcessed,
      });
      if (repaired) {
        logger.warn(
          `${TAG} [L2] ⚠️ Checkpoint counter regression detected and repaired ` +
          `(scenes_processed >= ${preScenesProcessed}, total_processed >= ${preTotalProcessed})`,
        );
      }

      const l2FinishedAt = Date.now();
      const l2PromptRef = buildPromptGenerationRef(resolvedL2Prompt, "l2");
      let changedProfiles = (await listLocalProfiles(groupDataDir, groupStorage, groupProfileOptions))
        .filter((profile) => groupBaseline.get(profile.id)?.contentMd5 !== profile.contentMd5 || !groupBaseline.has(profile.id));
      if (vectorStore && supportsProfileSyncWrite(vectorStore)) {
        changedProfiles = (await syncLocalProfilesToStore(
          groupDataDir, vectorStore, groupBaseline, logger, groupStorage, groupProfileOptions,
        )) ?? changedProfiles;
      }
      if (changedProfiles.length === 0) {
        logger.debug?.(`${TAG} [L2] No changed Scene profiles, skipping generation provenance`);
        await checkpoint.incrementScenesProcessed();
        processedTotal += extractResult.memoriesProcessed;
        continue;
      }

      // P4a-P2（层级边，REG-REMAINING-002 #1）：derived_from —— scene block → 本次
      // 蒸馏输入的 L1 记录。source 用 profile.id（profile:v1:* 稳定、租户唯一）；边
      // 只增不重写：增量蒸馏语义下 scene block 是累积蒸馏，边记录"曾贡献"，失效传播
      // 沿 getLinksByTarget 反查。同 (block,record) 幂等（addLink ON CONFLICT 更新）。
      if (vectorStore?.addLink) {
        // P4a-P2 对抗性审查修正：sqlite（无 pullProfiles）下进程基线恒空，
        // changedProfiles 每轮上报全部块——建边若直接采用会退化为近似完全二部图，
        // 失效传播精确定位被稀释。权威变更集 = extractor 自身正文 diff
        // （changedSceneFiles：created + content-updated）；仅 META 变化不建边。
        const changedSet = new Set(extractResult.changedSceneFiles ?? []);
        const edgeProfiles = extractResult.changedSceneFiles
          ? changedProfiles.filter((p) => changedSet.has(p.filename))
          : changedProfiles;
        let derivedEdges = 0;
        for (const profile of edgeProfiles) {
          for (const r of activeGroupRecords) {
            if (vectorStore.addLink(profile.id, r.id, "derived_from", 1) === true) derivedEdges++;
          }
        }
        if (derivedEdges > 0) {
          logger.debug?.(`${TAG} [L2] derived_from edges: ${derivedEdges} (${edgeProfiles.length}/${changedProfiles.length} block(s) ← ${activeGroupRecords.length} record(s), scope=${groupScope})`);
        }
      }
      const l2Identity = buildGenerationLogIdentity("l2", l2FinishedAt, changedProfiles[0]?.id);
      const l2Provenance = buildGenerationProvenance(l2Identity, l2PromptRef);
      const rootStorage = storage ?? new StorageAdapter(new LocalStorageBackend(pluginDataDir));
      const l2Log: MemoryGenerationLog = {
        schema_version: 1,
        log_id: l2Identity.logId,
        generation_id: l2Identity.generationId,
        instance_id: instanceId ?? "standalone",
        layer: "l2",
        status: "succeeded",
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
        user_id: ctx.userId,
        session_id: ctx.sessionId,
        task_id: ctx.taskId,
        prompt: l2PromptRef,
        anchor_memory_id: changedProfiles[0]?.id,
        input_refs: groupRecords.map((record) => ({ layer: "l1", record_id: record.id })),
        output_refs: changedProfiles.map((profile) => ({ layer: "l2", record_id: profile.id })),
        model: cfg.persona.model,
        prompt_mode: cfg.persona.promptMode,
        started_at_ms: l2StartMs,
        finished_at_ms: l2FinishedAt,
        latency_ms: l2FinishedAt - l2StartMs,
      };
      const l2LogStore = new MemoryGenerationLogStore(rootStorage, instanceId ?? "standalone");
      await writeGenerationProvenanceBestEffort({
        layer: "l2",
        logger,
        writeLog: () => l2LogStore.write(l2Log, l2Identity.key),
        writeRefs: vectorStore?.upsertMemoryGenerationRefs && changedProfiles.length > 0
          ? () => vectorStore.upsertMemoryGenerationRefs!(changedProfiles.map((profile) => ({
              generation_ref_id: buildMemoryGenerationRefId("l2", profile.id),
              layer: "l2" as const,
              memory_id: profile.id,
              ...l2Provenance,
              created_at_ms: l2FinishedAt,
            })))
          : undefined,
      });
      await checkpoint.incrementScenesProcessed();
      processedTotal += extractResult.memoriesProcessed;
    }

    if (processedTotal > 0) {
      const latestCursor = records.reduce((latest, r) => r.updatedAt > latest ? r.updatedAt : latest, "");
      logger.debug?.(`${TAG} [L2] Extraction complete: processed=${processedTotal}, latestCursor=${latestCursor}`);
      return { latestCursor: latestCursor || undefined };
    }
    if (anyEmptyExtraction) return { skipped: true };
  };
}

// ============================
// L3 Runner factory
// ============================

/**
 * Create the standard L3 runner function (persona generation).
 *
 * Uses PersonaTrigger to check if generation is needed, then runs
 * PersonaGenerator. Used by both `index.ts` and `seed-runtime.ts`.
 */
export function createL3Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore?: IMemoryStore;
  logger: PipelineLogger;
  instanceId?: string;
  /** Host-neutral LLM runner for L3 persona generation (standalone/gateway mode). Must have enableTools=true. */
  llmRunner?: import("../core/types.js").LLMRunner;
  /** StorageAdapter for file operations (COS/local). */
  storage?: StorageAdapter;
}): L3Runner {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, logger, instanceId, llmRunner, storage } = opts;

  return async () => {
    const scopes = await discoverProfileScopes(pluginDataDir, storage, logger);
    const executionScopes = scopes.length > 0 ? scopes : [DEFAULT_PROFILE_SCOPE];
    let generatedAny = false;
    const l3PromptTargets = executionScopes.map((scope) => {
      const isolation = parseProfileIsolationScope(scope);
      return { teamId: isolation.teamId, agentId: isolation.agentId, layer: "l3" as const };
    });
    const l3Prompts = await resolveMemoryPrompts(vectorStore, l3PromptTargets);

    for (const scope of executionScopes) {
      const scopedDir = scopedDataDirForScope(pluginDataDir, scope);
      const scopedStore = scopedStorageForScope(storage, scope);
      const profileOptions = profileOptionsForScope(scope);

      const trigger = new PersonaTrigger({
        dataDir: scopedDir,
        interval: cfg.persona.triggerEveryN,
        logger,
        storage: scopedStore,
      });

      const { should, reason } = await trigger.shouldGenerate();
      if (!should) {
        logger.debug?.(`${TAG} [L3] Persona generation not needed (scope=${scope})`);
        continue;
      }

      if (!openclawConfig && !llmRunner) {
        logger.warn(`${TAG} [L3] No OpenClaw config and no LLM runner, skipping persona generation`);
        return;
      }

      // Guard: no scene files → nothing to generate from. Skip without marking
      // checkpoint so cold-start trigger remains available for the next attempt.
      const { readSceneIndex } = await import("../core/scene/scene-index.js");
      const sceneIndex = await readSceneIndex(scopedDir, scopedStore);
      if (sceneIndex.length === 0) {
        logger.info(`${TAG} [L3] No scene files available for scope=${scope}, skipping (checkpoint unchanged)`);
        continue;
      }

      // Pull remote profiles to establish fresh baseline before generation.
      // This ensures syncLocalProfilesToStore() has correct baselineVersion
      // for the optimistic-lock check instead of defaulting to 0.
      let profileBaseline = new Map<string, { version: number; contentMd5: string; createdAtMs: number }>();
      if (vectorStore?.pullProfiles && !vectorStore.isDegraded()) {
        profileBaseline = await pullProfilesToLocal(scopedDir, vectorStore, logger, scopedStore, profileOptions);
      }

      logger.info(`${TAG} [L3] Starting persona generation: ${reason} (scope=${scope})`);
      // 反解 scope 拿回 teamId/userId/agentId/sessionId 给 langfuse trace 用
      const scopeIsolation = parseProfileIsolationScope(scope);
      const l3StartMs = Date.now();
      const resolvedL3Prompt = l3Prompts.get(memoryPromptResolveKey({
        teamId: scopeIsolation.teamId,
        agentId: scopeIsolation.agentId,
        layer: "l3",
      }));
      const generator = new PersonaGenerator({
        dataDir: scopedDir,
        config: openclawConfig,
        model: cfg.persona.model,
        promptMode: cfg.persona.promptMode,
        memoryPrompt: resolvedL3Prompt,
        backupCount: cfg.persona.backupCount,
        logger,
        instanceId,
        llmRunner,
        storage: scopedStore,
        traceContext: scopeIsolation,
        // M persona 演进：提供近期持续态（durative work_fact/observed）供反漂移筛选并入画像
        duratives: async () => {
          if (!vectorStore?.queryL1Records) return [];
          const rows = (await vectorStore.queryL1Records()) ?? [];
          return (rows as unknown as Array<{ content?: string; type?: string; significance?: number; certainty?: string; metadata_json?: string }>)
            .filter((r) => r.type === "work_fact" && (r.content ?? "").length > 0)
            .map((r) => {
              // 真实观察计数/确定性从 metadata_json 读（H 巩固持久化时写入 observed_count）
              let obs = 1, cert = "observed" as "observed" | "inferred";
              try {
                const md = JSON.parse(r.metadata_json ?? "{}") as { observed_count?: unknown; certainty?: unknown };
                if (typeof md.observed_count === "number" && md.observed_count >= 1) obs = Math.floor(md.observed_count);
                if (md.certainty === "inferred") cert = "inferred";
              } catch { /* 兜底默认 */ }
              return {
                content: r.content as string,
                significance: typeof r.significance === "number" ? r.significance : 0.5,
                certainty: cert,
                observedCount: obs,
              };
            })
            // 反漂移：inferred 明确排除（reconsolidation 只动 observed 层）
            .filter((d) => d.certainty !== "inferred" && (d.observedCount ?? 1) >= 1);
        },
      });
      const genResult = await generator.generateLocalPersona(reason);

      const checkpoint = new CheckpointManager(scopedDir, logger, scopedStore);
      const cp = await checkpoint.read();
      const personaMarker = cp.total_processed;

      if (!genResult) {
        logger.info(`${TAG} [L3] Persona generation skipped (no changes, scope=${scope})`);
        await checkpoint.markPersonaGenerated(personaMarker);
        continue;
      }

      const l3FinishedAt = Date.now();
      const l3PromptRef = buildPromptGenerationRef(resolvedL3Prompt, "l3");
      let changedProfiles = (await listLocalProfiles(scopedDir, scopedStore, profileOptions))
        .filter((profile) => profileBaseline.get(profile.id)?.contentMd5 !== profile.contentMd5 || !profileBaseline.has(profile.id));
      if (vectorStore && supportsProfileSyncWrite(vectorStore)) {
        changedProfiles = (await syncLocalProfilesToStore(
          scopedDir, vectorStore, profileBaseline, logger, scopedStore, profileOptions,
        )) ?? changedProfiles;
      }
      if (changedProfiles.length === 0) {
        logger.debug?.(`${TAG} [L3] No changed Persona profiles, skipping generation provenance`);
        await checkpoint.markPersonaGenerated(personaMarker);
        generatedAny = true;
        continue;
      }
      const l3Identity = buildGenerationLogIdentity("l3", l3FinishedAt, changedProfiles[0]?.id);
      const l3Provenance = buildGenerationProvenance(l3Identity, l3PromptRef);
      const rootStorage = storage ?? new StorageAdapter(new LocalStorageBackend(pluginDataDir));
      const l3Log: MemoryGenerationLog = {
        schema_version: 1,
        log_id: l3Identity.logId,
        generation_id: l3Identity.generationId,
        instance_id: instanceId ?? "standalone",
        layer: "l3",
        status: "succeeded",
        team_id: scopeIsolation.teamId,
        agent_id: scopeIsolation.agentId,
        user_id: scopeIsolation.userId,
        session_id: scopeIsolation.sessionId,
        prompt: l3PromptRef,
        anchor_memory_id: changedProfiles[0]?.id,
        input_refs: sceneIndex.map((scene) => ({ layer: "l2", record_id: scene.filename })),
        output_refs: changedProfiles.map((profile) => ({ layer: "l3", record_id: profile.id })),
        model: cfg.persona.model,
        prompt_mode: cfg.persona.promptMode,
        started_at_ms: l3StartMs,
        finished_at_ms: l3FinishedAt,
        latency_ms: l3FinishedAt - l3StartMs,
      };
      const l3LogStore = new MemoryGenerationLogStore(rootStorage, instanceId ?? "standalone");
      await writeGenerationProvenanceBestEffort({
        layer: "l3",
        logger,
        writeLog: () => l3LogStore.write(l3Log, l3Identity.key),
        writeRefs: vectorStore?.upsertMemoryGenerationRefs && changedProfiles.length > 0
          ? () => vectorStore.upsertMemoryGenerationRefs!(changedProfiles.map((profile) => ({
              generation_ref_id: buildMemoryGenerationRefId("l3", profile.id),
              layer: "l3" as const,
              memory_id: profile.id,
              ...l3Provenance,
              created_at_ms: l3FinishedAt,
            })))
          : undefined,
      });

      await checkpoint.markPersonaGenerated(personaMarker);
      generatedAny = true;
      logger.info(`${TAG} [L3] Persona generation succeeded (scope=${scope})`);
    }

    if (!generatedAny) {
      logger.debug?.(`${TAG} [L3] No scoped persona generated`);
    }
  };
}

// ============================
// Pipeline Manager factory
// ============================

/**
 * Create a MemoryPipelineManager with the standard config mapping.
 */
export function createPipelineManager(
  cfg: MemoryTdaiConfig,
  logger: PipelineLogger,
  sessionFilter?: SessionFilter,
): MemoryPipelineManager {
  return new MemoryPipelineManager(
    {
      everyNConversations: cfg.pipeline.everyNConversations,
      enableWarmup: cfg.pipeline.enableWarmup,
      l1: { idleTimeoutSeconds: cfg.pipeline.l1IdleTimeoutSeconds },
      l2: {
        delayAfterL1Seconds: cfg.pipeline.l2DelayAfterL1Seconds,
        minIntervalSeconds: cfg.pipeline.l2MinIntervalSeconds,
        maxIntervalSeconds: cfg.pipeline.l2MaxIntervalSeconds,
        sessionActiveWindowHours: cfg.pipeline.sessionActiveWindowHours,
      },
    },
    logger,
    sessionFilter ?? new SessionFilter([]),
  );
}

// ============================
// Full pipeline factory
// ============================

/**
 * Create a fully wired pipeline instance: VectorStore + EmbeddingService +
 * MemoryPipelineManager with L1 runner and persister attached.
 *
 * This is the high-level entry point used by both `index.ts` and `seed-runtime.ts`.
 * Callers should attach L2/L3 runners after creation using `createL2Runner()`
 * and `createL3Runner()` from this module.
 */
export async function createPipeline(opts: PipelineFactoryOptions): Promise<PipelineInstance> {
  const { pluginDataDir, cfg, openclawConfig, logger, sessionFilter, l1LlmRunner } = opts;

  // Ensure data directories exist
  initDataDirectories(pluginDataDir);

  // Initialize stores (once-async: reuses cached result if already initialized)
  const stores = await initStores(cfg, pluginDataDir, logger);
  const { vectorStore, embeddingService } = stores;

  // Create pipeline manager
  const scheduler = createPipelineManager(cfg, logger, sessionFilter);

  // Wire L1 runner
  scheduler.setL1Runner(createL1Runner({
    pluginDataDir,
    cfg,
    openclawConfig,
    vectorStore,
    embeddingService,
    logger,
    llmRunner: l1LlmRunner,
  }));

  // Wire persister
  scheduler.setPersister(createPersister(pluginDataDir, logger));

  // Destroy function
  const destroy = async () => {
    logger.info(`${TAG} Destroying pipeline...`);
    await scheduler.destroy();
    if (vectorStore) {
      logger.info(`${TAG} Closing VectorStore`);
      vectorStore.close();
    }
    if (embeddingService?.close) {
      try {
        logger.info(`${TAG} Closing EmbeddingService`);
        await embeddingService.close();
      } catch (err) {
        logger.warn(`${TAG} Error closing EmbeddingService: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    resetStores(pluginDataDir);
    logger.info(`${TAG} Pipeline destroyed`);
  };

  return { scheduler, vectorStore, embeddingService, destroy };
}

// ============================
// V2: StateBackend-based pipeline factory (需求 #8)
// ============================

import type { IStateBackend } from "../core/state/types.js";
import { StatefulPipelineManager } from "./stateful-pipeline-manager.js";

/**
 * Create a StatefulPipelineManager that uses IStateBackend for all state.
 *
 * Drop-in replacement for createPipelineManager() when running with an
 * externalized state backend.
 */
export function createStatefulPipelineManager(
  cfg: MemoryTdaiConfig,
  stateBackend: IStateBackend,
  instanceId: string,
  logger: PipelineLogger,
  sessionFilter?: SessionFilter,
): StatefulPipelineManager {
  return new StatefulPipelineManager(
    {
      everyNConversations: cfg.pipeline.everyNConversations,
      enableWarmup: cfg.pipeline.enableWarmup,
      l1: { idleTimeoutSeconds: cfg.pipeline.l1IdleTimeoutSeconds },
      l2: {
        delayAfterL1Seconds: cfg.pipeline.l2DelayAfterL1Seconds,
        minIntervalSeconds: cfg.pipeline.l2MinIntervalSeconds,
        maxIntervalSeconds: cfg.pipeline.l2MaxIntervalSeconds,
        sessionActiveWindowHours: cfg.pipeline.sessionActiveWindowHours,
      },
    },
    stateBackend,
    instanceId,
    logger,
    sessionFilter ?? new SessionFilter([]),
  );
}
