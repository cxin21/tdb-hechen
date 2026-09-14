/**
 * TcvdbMemoryStore: Tencent Cloud VectorDB backend implementing IMemoryStore.
 *
 * Features:
 * - Optional server-side dense embedding (embeddingItems via Collection embedding config)
 * - Client-side sparse vectors (BM25 local encoder; can run BM25-only without dense embedding)
 * - Native hybridSearch (dense + sparse + RRFRerank) when dense embedding is enabled
 * - Filter expressions for scalar field queries
 * - Time fields stored as uint64 epoch ms (ISO ↔ epoch conversion internal)
 *
 * All methods are fault-tolerant: return empty/false on error, never throw.
 */

import type { MemoryRecord } from "../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type {
  IMemoryStore,
  StoreCapabilities,
  StoreInitResult,
  L1SearchResult,
  L1FtsResult,
  L1RecordRow,
  L1QueryFilter,
  L0SearchResult,
  L0FtsResult,
  L0QueryRow,
  L0SessionGroup,
  ProfileRecord,
  ProfileSyncRecord,
  StoreLogger,
  L0PaginatedFilter,
  L0PaginatedResult,
  L0CountFilter,
  L1CountFilter,
  L1PaginatedFilter,
  L1PaginatedResult,
  ProfileCountFilter,
  IsolationFilter,
  L0Record,
  AuditEntry,
  AuditQueryFilter,
  KnowledgeEntity,
  KnowledgeType,
  KnowledgeListResult,
  BatchDeleteResult,
  MemoryContentClearFilter,
  MemoryContentClearResult,
} from "./types.js";
import { DEFAULT_ISOLATION_ID, normalizeCoreTenant, rowMatchesIsolation, type CoreTenant } from "./types.js";
import { VectorStore } from "./sqlite.js";
import { TcvdbClient, TcvdbApiError } from "./tcvdb-client.js";
import type { BM25LocalEncoder } from "./bm25-local.js";
import type { SparseVector } from "@tencentdb-agent-memory/tcvdb-text";
import type {
  MemoryPromptListFilter,
  MemoryPromptRecord,
  MemoryPromptSettingListFilter,
  MemoryPromptSettingLogFilter,
  MemoryPromptSettingLogRecord,
  MemoryPromptSettingRecord,
  MemoryPromptTargetType,
} from "../memory-prompt/types.js";
import {
  buildMemoryGenerationRefId,
  type MemoryGenerationLayer,
  type MemoryGenerationRefRecord,
} from "../memory-generation-log/types.js";

// ============================
// Config & Constants
// ============================

export interface TcvdbMemoryStoreConfig {
  url: string;
  username: string;
  apiKey: string;
  database: string;
  /** Enable VectorDB server-side dense embedding/vector index. Default false: BM25 sparse-only. */
  embeddingEnabled?: boolean;
  embeddingModel: string;
  timeout: number;
  /** Path to CA certificate PEM file (for HTTPS connections) */
  caPemPath?: string;
  /**
   * T2（伴生 SQLite 模式）：辅助表（l1_links / l1_archive / core_memory / core_values）
   * 的伴生 sqlite 库路径（惯例 `<dataDir>/tcvdb-aux.db`）。tcvdb 是向量库，装不下辅助表；
   * 伴生库直接实例化 sqlite.ts 的 VectorStore（dims=0 元数据模式），辅助表 DDL/CRUD 全部
   * 逐字复用既有实现（单一事实源，禁止第二份手写 SQL）。缺省不开启（该实例不提供
   * 图/归档/core 可选方法语义，调用方 feature-detect）；生产由 factory 按 dataDir 推导注入。
   */
  auxPath?: string;
  logger?: StoreLogger;
  bm25Encoder?: BM25LocalEncoder;
}

const TAG = "[memory-tdai][tcvdb]";

/** Base collection suffixes (prefixed with database name at construction time). */
const L1_COLLECTION_SUFFIX = "l1_memories";
const L0_COLLECTION_SUFFIX = "l0_conversations";
const PROFILES_COLLECTION_SUFFIX = "profiles";
const AUDIT_COLLECTION_SUFFIX = "memory_audit";
/** entity_knowledge 明细注册表（见 docs/design/vdb-knowledge-collection.md）。 */
const KNOWLEDGE_COLLECTION_SUFFIX = "knowledge";
const MEMORY_PROMPTS_COLLECTION_SUFFIX = "memory_prompts";
const MEMORY_PROMPT_SETTINGS_COLLECTION_SUFFIX = "memory_prompt_settings";
const MEMORY_PROMPT_SETTING_LOGS_COLLECTION_SUFFIX = "memory_prompt_setting_logs";
const MEMORY_GENERATION_REFS_COLLECTION_SUFFIX = "memory_generation_refs";

const MEMORY_GENERATION_REF_OUTPUT_FIELDS = [
  "id", "layer", "memory_id", "generation_id", "generation_log_id", "generation_log_key",
  "memory_prompt_id", "memory_prompt_version", "memory_prompt_source", "created_at_ms",
];

const MEMORY_PROMPT_OUTPUT_FIELDS = [
  "id", "name", "layer", "prompt", "version", "status",
  "created_by", "updated_by", "created_at_ms", "updated_at_ms",
];
const MEMORY_PROMPT_SETTING_OUTPUT_FIELDS = [
  "id", "target_type", "team_id", "agent_id", "layer",
  "memory_prompt_id", "updated_by", "updated_at_ms",
];
const MEMORY_PROMPT_SETTING_LOG_OUTPUT_FIELDS = [
  "id", "target_type", "team_id", "agent_id", "layer", "action", "reason",
  "before_memory_prompt_id", "after_memory_prompt_id", "operator_id", "operated_at_ms",
];

const KNOWLEDGE_OUTPUT_FIELDS = [
  "id", "type", "team_id", "agent_id", "name", "user_id",
  "service_url", "summary", "metadata", "created_at_ms", "updated_at_ms",
];

/**
 * Memory type 预埋字段默认值。预留给后续区分同 agent 不同记忆类型（如对话、技能、偏好等），
 * 当前所有 L1/profile 写入都填这个默认值，读路径暂不消费 memory_type 字段。
 */
const DEFAULT_MEMORY_TYPE = "default";

/** Max documents per /document/query page (VectorDB API limit). */
const QUERY_PAGE_SIZE = 100;

/** All L1 output fields returned by query/search (excludes vector/sparse_vector). */
const L1_OUTPUT_FIELDS = [
  "id", "text", "type", "priority", "scene_name",
  "team_id", "user_id", "agent_id", "session_key", "session_id", "task_id", "version", "timestamp_str", "timestamp_start",
  "timestamp_end", "metadata_json", "created_time_ms", "updated_time_ms",
  "occurred_at", "valid_start", "valid_end", "certainty", "source", "valence", "arousal", "significance",
];

/** All L0 output fields returned by query/search. */
const L0_OUTPUT_FIELDS = [
  "id", "message_text", "team_id", "user_id", "agent_id", "session_key", "session_id", "task_id", "role",
  "recorded_at_ms", "timestamp",
];

const PROFILE_OUTPUT_FIELDS = [
  "id", "type", "filename", "content", "content_md5", "team_id", "user_id", "agent_id",
  "version", "created_at_ms", "updated_at_ms",
];

const PROFILE_METADATA_OUTPUT_FIELDS = [
  "id", "type", "filename", "content_md5", "team_id", "user_id", "agent_id",
  "version", "created_at_ms", "updated_at_ms",
];

/** memory_audit 字段：每行一条修改事件（L1/L2/L3 的 update/delete）。 */
const AUDIT_OUTPUT_FIELDS = [
  "id", "record_id", "layer", "action",
  "team_id", "agent_id", "user_id", "task_id",
  "version", "updated_at_ms", "request_id",
];

// ============================
// Helpers
// ============================

function isoToEpochMs(iso: string): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function epochMsToIso(ms: number): string {
  if (!ms || ms <= 0) return "";
  return new Date(ms).toISOString();
}

function escapeFilterString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function eqFilter(field: string, value: string): string {
  return `${field} = "${escapeFilterString(value)}"`;
}

function buildIsolationConditions(filter?: IsolationFilter): string[] {
  const conditions: string[] = [];
  if (!filter) return conditions;
  // teamId 与 isolation.ts buildIsolationWhere 对齐：team 级隔离过滤必须最先出现，
  // 否则跨 team 的 L0/L1 记录会在 search/query 时漏过滤（团队记忆隔离失效）。
  if (filter.teamId !== undefined) conditions.push(eqFilter("team_id", filter.teamId));
  if (filter.userId !== undefined) conditions.push(eqFilter("user_id", filter.userId));
  if (filter.agentId !== undefined) conditions.push(eqFilter("agent_id", filter.agentId));
  if (filter.sessionId !== undefined) conditions.push(eqFilter("session_id", filter.sessionId));
  if (filter.taskId !== undefined) conditions.push(eqFilter("task_id", filter.taskId));
  if (filter.sessionKey !== undefined) conditions.push(eqFilter("session_key", filter.sessionKey));
  return conditions;
}

function joinFilter(conditions: string[]): string | undefined {
  return conditions.length > 0 ? conditions.join(" and ") : undefined;
}

/**
 * 破坏性删除前的护栏：确认 filter 表达式非空且含所有必需的隔离字段。
 *
 * 背景：TCVDB `/document/delete` 在 filter 为空时会删掉**整个 collection**。
 * 任何按条件批量删除的调用都必须先过这一关—— 与其在生产上静默清库，
 * 不如在发请求前抛错。
 *
 * @param filter        joinFilter 的结果（可能是 undefined）
 * @param op            操作名，用于错误信息定位
 * @param requiredFields 必须出现在 filter 里的字段名（如 team_id / agent_id）
 */
function assertDeleteFilterSafe(
  filter: string | undefined,
  op: string,
  requiredFields: string[],
): void {
  if (typeof filter !== "string" || filter.trim().length === 0) {
    throw new Error(
      `[tcvdb] refusing ${op}: empty delete filter would wipe the whole collection`,
    );
  }
  for (const field of requiredFields) {
    if (!filter.includes(`${field} = "`)) {
      throw new Error(
        `[tcvdb] refusing ${op}: delete filter missing required scope field "${field}"`,
      );
    }
  }
}

// ============================
// 重巩固（reconsolidation）：metadata 读-改-写辅助
// ============================

/**
 * 损坏 metadata_json 行 warn 去重（T1-B，对齐 sqlite.ts warnCorruptMetadataJsonOnce）：
 * 同一 record_id 只 warn 一次；唯一 id 超 CORRUPT_JSON_WARN_MAX_IDS 后不再记录 id
 * （防 Set 无界膨胀），改为计数，每 CORRUPT_JSON_SUMMARY_EVERY 行输出一条计数汇总。
 */
const corruptJsonWarnedIds = new Set<string>();
let corruptJsonOverflowCount = 0;
const CORRUPT_JSON_WARN_MAX_IDS = 100;
const CORRUPT_JSON_SUMMARY_EVERY = 50;

/**
 * metadata_json 宽松解析（对齐 sqlite updateL1Metadata :2555 的 catch→{} 语义）：
 * 损坏/非对象 → {}，不造假值。仅供 updateL1Metadata 的宽容合并路径使用；
 * bumpRecallCount 走严格裁决（见其方法注释），不走这里。
 */
function parseL1MetadataLenient(raw: unknown): Record<string, unknown> {
  let meta: Record<string, unknown> = {};
  try {
    meta = raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  return meta;
}

// ============================
// T2（伴生 SQLite 模式）：doc ↔ MemoryRecord ↔ 归档行 映射
// ============================

/**
 * TCVDB L1 doc → MemoryRecord（T2-B archiveL1 归档保真用；是 _upsertL1Async doc 映射的逆）。
 *
 * timestamps 三元组 [tsStr, tsStart, tsEnd]：sqlite upsert 侧按 min/max 重算
 * ts_start/ts_end。写入侧不变式（_upsertL1Async 同款推导）保证 tsStart ≤ tsStr ≤ tsEnd，
 * 因此 min/max 重算回原值（多时间戳记忆的时段信息零损失；tsStr 为空的退化形态三值同为空，
 * 同样成立）。metadata_json 走宽松解析（损坏 → {}，与读取路径同语义）。
 */
function docToMemoryRecord(doc: Record<string, unknown>): MemoryRecord {
  return {
    id: String(doc.id ?? ""),
    content: String(doc.text ?? ""),
    type: String(doc.type ?? "episodic") as MemoryRecord["type"],
    priority: Number(doc.priority ?? 0),
    scene_name: String(doc.scene_name ?? ""),
    source_message_ids: [],
    metadata: parseL1MetadataLenient(doc.metadata_json),
    timestamps: [
      String(doc.timestamp_str ?? ""),
      String(doc.timestamp_start ?? ""),
      String(doc.timestamp_end ?? ""),
    ],
    createdAt: epochMsToIso(Number(doc.created_time_ms ?? 0)),
    updatedAt: epochMsToIso(Number(doc.updated_time_ms ?? 0)),
    version: Number(doc.version ?? 0),
    sessionKey: String(doc.session_key ?? ""),
    sessionId: String(doc.session_id ?? ""),
    taskId: String(doc.task_id ?? "") || undefined,
    teamId: String(doc.team_id ?? "") || undefined,
    userId: String(doc.user_id ?? "") || undefined,
    agentId: String(doc.agent_id ?? "") || undefined,
    occurred_at: (doc.occurred_at as string) || undefined,
    valid_start: (doc.valid_start as string) || undefined,
    valid_end: (doc.valid_end as string) || undefined,
    certainty: (doc.certainty as MemoryRecord["certainty"]) || undefined,
    source: (doc.source as string) || undefined,
    valence: (doc.valence as number) ?? undefined,
    arousal: (doc.arousal as number) ?? undefined,
    significance: (doc.significance as number) ?? undefined,
  };
}

/**
 * l1_archive 行 JSON（26 列 snake_case，sqlite archiveL1 同构）→ MemoryRecord
 * （T2-B restoreL1：归档行写回 tcvdb 用；created_time/updated_time 为 ISO 原值）。
 */
function archiveRowToMemoryRecord(d: Record<string, unknown>): MemoryRecord {
  return {
    id: String(d.record_id ?? ""),
    content: String(d.content ?? ""),
    type: String(d.type ?? "episodic") as MemoryRecord["type"],
    priority: Number(d.priority ?? 0),
    scene_name: String(d.scene_name ?? ""),
    source_message_ids: [],
    metadata: parseL1MetadataLenient(d.metadata_json),
    timestamps: [
      String(d.timestamp_str ?? ""),
      String(d.timestamp_start ?? ""),
      String(d.timestamp_end ?? ""),
    ],
    createdAt: String(d.created_time ?? ""),
    updatedAt: String(d.updated_time ?? ""),
    version: Number(d.version ?? 0),
    sessionKey: String(d.session_key ?? ""),
    sessionId: String(d.session_id ?? ""),
    taskId: String(d.task_id ?? "") || undefined,
    teamId: String(d.team_id ?? "") || undefined,
    userId: String(d.user_id ?? "") || undefined,
    agentId: String(d.agent_id ?? "") || undefined,
    occurred_at: (d.occurred_at as string) || undefined,
    valid_start: (d.valid_start as string) || undefined,
    valid_end: (d.valid_end as string) || undefined,
    certainty: (d.certainty as MemoryRecord["certainty"]) || undefined,
    source: (d.source as string) || undefined,
    valence: (d.valence as number) ?? undefined,
    arousal: (d.arousal as number) ?? undefined,
    significance: (d.significance as number) ?? undefined,
  };
}

// ============================
// TcvdbMemoryStore
// ============================

export class TcvdbMemoryStore implements IMemoryStore {
  private readonly client: TcvdbClient;
  private readonly embeddingEnabled: boolean;
  private readonly embeddingModel: string;
  private readonly logger?: StoreLogger;
  private readonly bm25Encoder?: BM25LocalEncoder;
  private readonly l1Collection: string;
  private readonly l0Collection: string;
  private readonly profilesCollection: string;
  private readonly auditCollection: string;
  private readonly knowledgeCollection: string;
  private readonly memoryPromptsCollection: string;
  private readonly memoryPromptSettingsCollection: string;
  private readonly memoryPromptSettingLogsCollection: string;
  private readonly memoryGenerationRefsCollection: string;
  /** T2（伴生 SQLite 模式）：辅助表伴生库（dims=0 VectorStore；init 打开、close 同步关） */
  private readonly auxPath?: string;
  private aux?: VectorStore;
  private auxWarned = false;
  private degraded = false;

  /** Promise that resolves when async init completes. */
  private _initPromise: Promise<void> | undefined;

  constructor(config: TcvdbMemoryStoreConfig) {
    this.client = new TcvdbClient(Object.fromEntries([
      ["url", config.url],
      ["username", config.username],
      ["apiKey", config.apiKey],
      ["database", config.database],
      ["timeout", config.timeout],
      ["caPemPath", config.caPemPath],
    ]) as ConstructorParameters<typeof TcvdbClient>[0], config.logger);
    this.embeddingEnabled = config.embeddingEnabled === true;
    this.embeddingModel = config.embeddingModel;
    this.logger = config.logger;
    this.bm25Encoder = config.bm25Encoder;
    this.auxPath = config.auxPath;

    // Collection names are globally unique within a TCVDB instance,
    // so prefix with database name to avoid cross-database collisions.
    this.l1Collection = `${config.database}_${L1_COLLECTION_SUFFIX}`;
    this.l0Collection = `${config.database}_${L0_COLLECTION_SUFFIX}`;
    this.profilesCollection = `${config.database}_${PROFILES_COLLECTION_SUFFIX}`;
    this.auditCollection = `${config.database}_${AUDIT_COLLECTION_SUFFIX}`;
    this.knowledgeCollection = `${config.database}_${KNOWLEDGE_COLLECTION_SUFFIX}`;
    this.memoryPromptsCollection = `${config.database}_${MEMORY_PROMPTS_COLLECTION_SUFFIX}`;
    this.memoryPromptSettingsCollection = `${config.database}_${MEMORY_PROMPT_SETTINGS_COLLECTION_SUFFIX}`;
    this.memoryPromptSettingLogsCollection = `${config.database}_${MEMORY_PROMPT_SETTING_LOGS_COLLECTION_SUFFIX}`;
    this.memoryGenerationRefsCollection = `${config.database}_${MEMORY_GENERATION_REFS_COLLECTION_SUFFIX}`;
  }

  // ── Lifecycle ────────────────────────────────────────────

  async init(_providerInfo?: EmbeddingProviderInfo): Promise<StoreInitResult> {
    // TCVDB init is async (HTTP). We store the promise so _ensureInit()
    // can also await it as a defensive fallback in each data method.
    this._initPromise = this._initAsync();
    try {
      await this._initPromise;
    } catch (err) {
      this.logger?.error(`${TAG} Async init failed: ${err instanceof Error ? err.message : String(err)}`);
      this.degraded = true;
    }
    // T2（伴生 SQLite 模式）：辅助表伴生库打开 + 建表（幂等，DDL 逐字复用 sqlite.ts）。
    this._initAux();
    return { needsReindex: false };
  }

  /**
   * T2：打开伴生 sqlite（幂等建表走 VectorStore.init() 的既有 DDL——l1_links/l1_archive/
   * core_memory/core_values 及其唯一索引全部单源复用）。打开失败不致 tcvdb 后端降级：
   * 辅助表能力按可选方法 feature-detect 语义处理（aux 缺位 → 各方法显式 false/空/-1）。
   */
  private _initAux(): void {
    if (!this.auxPath) {
      this.logger?.debug?.(
        `${TAG} auxPath not configured — companion sqlite (graph/archive/core tables, T2) unavailable on this instance`,
      );
      return;
    }
    try {
      this.aux = new VectorStore(this.auxPath, 0, this.logger as never);
      this.aux.init();
      this.logger?.debug?.(
        `${TAG} companion sqlite opened at ${this.auxPath} (T2 aux tables: l1_links/l1_archive/core_memory/core_values)`,
      );
    } catch (err) {
      this.aux = undefined;
      this.logger?.warn(
        `${TAG} companion sqlite open failed (graph/archive/core unavailable): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** T2：伴生库取用（缺位 warn 一次，防刷屏；返回 undefined 时调用方按能力缺失处理）。 */
  private _auxReady(): VectorStore | undefined {
    if (!this.aux) {
      if (!this.auxWarned) {
        this.auxWarned = true;
        this.logger?.warn?.(
          `${TAG} companion sqlite unavailable (auxPath not configured or open failed) — graph/archive/core operations are no-ops (T2)`,
        );
      }
      return undefined;
    }
    return this.aux;
  }

  /**
   * Await async initialization. Call at the start of every async method.
   * If init already completed (or failed → degraded), returns immediately.
   */
  private async _ensureInit(): Promise<void> {
    if (this._initPromise) {
      await this._initPromise;
    }
  }

  // ── Vector index definitions ─────────────────────────────
  //
  // Preferred: DISK_FLAT (lower memory, suitable for large-scale recall).
  // Fallback:  HNSW (for instances whose storage engine doesn't support DISK_FLAT).

  private static readonly VECTOR_INDEX_DISK_FLAT: Record<string, unknown> = {
    fieldName: "vector", fieldType: "vector", indexType: "DISK_FLAT",
    dimension: 1024, metricType: "COSINE",
  };

  private static readonly VECTOR_INDEX_HNSW: Record<string, unknown> = {
    fieldName: "vector", fieldType: "vector", indexType: "HNSW",
    dimension: 1024, metricType: "COSINE",
    params: { M: 16, efConstruction: 200 },
  };

  /**
   * Detect whether a createCollection error indicates DISK_FLAT is unsupported.
   * Matches on apiCode 15113 OR message containing "DISK_FLAT" + "not support".
   */
  private static isDiskFlatUnsupported(err: unknown): boolean {
    if (!(err instanceof TcvdbApiError)) return false;
    if (err.apiCode === 15113) return true;
    const msg = err.message.toLowerCase();
    return msg.includes("disk_flat") && (msg.includes("not support") || msg.includes("unsupported"));
  }

  /**
   * Create a BM25 sparse collection. When embeddingEnabled=true, the dense
   * vector index uses DISK_FLAT → HNSW fallback and VDB server-side embedding.
   * When false, embedding is disabled but a dim=1 placeholder vector index is
   * still required by VDB hybridSearch; semantic signal comes from BM25 only.
   */
  private async _createCollectionWithVectorFallback(
    params: Record<string, unknown>,
    filterIndexes: Array<Record<string, unknown>>,
  ): Promise<void> {
    const buildIndexes = (vectorIndex?: Record<string, unknown>) => [
      { fieldName: "id", fieldType: "string", indexType: "primaryKey" },
      ...(vectorIndex ? [vectorIndex] : []),
      { fieldName: "sparse_vector", fieldType: "sparseVector", indexType: "inverted", metricType: "IP" },
      ...filterIndexes,
    ];

    if (!this.embeddingEnabled) {
      await this.client.createCollection({
        ...params,
        embedding: { status: "disabled" },
        indexes: buildIndexes({
          fieldName: "vector", fieldType: "vector", indexType: "FLAT",
          dimension: 1, metricType: "COSINE",
        }),
      });
      return;
    }

    try {
      await this.client.createCollection({ ...params, indexes: buildIndexes(TcvdbMemoryStore.VECTOR_INDEX_DISK_FLAT) });
    } catch (err) {
      if (TcvdbMemoryStore.isDiskFlatUnsupported(err)) {
        this.logger?.debug?.(`${TAG} DISK_FLAT not supported for ${String(params.collection)}, falling back to HNSW`);
        await this.client.createCollection({ ...params, indexes: buildIndexes(TcvdbMemoryStore.VECTOR_INDEX_HNSW) });
      } else {
        throw err;
      }
    }
  }

  private async _initAsync(): Promise<void> {
    try {
      // Create database (idempotent — returns true if just created, false if already existed)
      const dbCreated = await this.client.createDatabase();

      if (dbCreated) {
        // TCVDB requires ~3s after database creation before collections can be created.
        // TODO: defer collection creation to first use to avoid blocking plugin startup.
        this.logger?.debug?.(`${TAG} Waiting 5s for database to become ready...`);
        await new Promise((r) => setTimeout(r, 5_000));
      }

      // Create L1 collection (DISK_FLAT preferred, HNSW fallback)
      await this._createCollectionWithVectorFallback(
        {
          collection: this.l1Collection,
          shardNum: 1,
          replicaNum: 2,
          description: "L1 结构化记忆",
          embedding: {
            status: "enabled",
            field: "text",
            vectorField: "vector",
            model: this.embeddingModel,
          },
        },
        [
          { fieldName: "type",            fieldType: "string", indexType: "filter" },
          { fieldName: "priority",        fieldType: "uint64", indexType: "filter" },
          { fieldName: "scene_name",      fieldType: "string", indexType: "filter" },
          { fieldName: "team_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "user_id",         fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",        fieldType: "string", indexType: "filter" },
          { fieldName: "session_key",     fieldType: "string", indexType: "filter" },
          { fieldName: "session_id",      fieldType: "string", indexType: "filter" },
          { fieldName: "task_id",         fieldType: "string", indexType: "filter" },
          { fieldName: "version",         fieldType: "uint64", indexType: "filter" },
          { fieldName: "timestamp_start", fieldType: "string", indexType: "filter" },
          { fieldName: "timestamp_end",   fieldType: "string", indexType: "filter" },
          { fieldName: "created_time_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "updated_time_ms", fieldType: "uint64", indexType: "filter" },
          // memory_type: 预埋字段，区分同 agent 不同记忆类型。当前一律 "default"，读路径暂不消费
          { fieldName: "memory_type",     fieldType: "string", indexType: "filter" },
        ],
      );

      // Create L0 collection (DISK_FLAT preferred, HNSW fallback)
      await this._createCollectionWithVectorFallback(
        {
          collection: this.l0Collection,
          shardNum: 1,
          replicaNum: 2,
          description: "L0 原始对话消息",
          embedding: {
            status: "enabled",
            field: "message_text",
            vectorField: "vector",
            model: this.embeddingModel,
          },
        },
        [
          { fieldName: "team_id",        fieldType: "string", indexType: "filter" },
          { fieldName: "user_id",        fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "session_key",    fieldType: "string", indexType: "filter" },
          { fieldName: "session_id",     fieldType: "string", indexType: "filter" },
          { fieldName: "task_id",        fieldType: "string", indexType: "filter" },
          { fieldName: "role",           fieldType: "string", indexType: "filter" },
          { fieldName: "recorded_at_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "timestamp",      fieldType: "int64",  indexType: "filter" },
        ],
      );

      await this.client.createCollection({
        collection: this.profilesCollection,
        shardNum: 1,
        replicaNum: 2,
        description: "L2 场景块 + L3 用户画像",
        embedding: { status: "disabled" },
        indexes: [
          { fieldName: "id",            fieldType: "string", indexType: "primaryKey" },
          { fieldName: "vector",        fieldType: "vector", indexType: "FLAT",
            dimension: 1, metricType: "COSINE" },
          { fieldName: "type",          fieldType: "string", indexType: "filter" },
          { fieldName: "filename",      fieldType: "string", indexType: "filter" },
          { fieldName: "content_md5",   fieldType: "string", indexType: "filter" },
          { fieldName: "team_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "user_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",      fieldType: "string", indexType: "filter" },
          { fieldName: "created_at_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "updated_at_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "version",       fieldType: "uint64", indexType: "filter" },
          // memory_type: 预埋字段，区分同 agent 不同记忆类型。当前一律 "default"，读路径暂不消费
          { fieldName: "memory_type",   fieldType: "string", indexType: "filter" },
        ],
      });

      // memory_audit collection — 修改审计事件流（L1/L2/L3 update/delete）
      // 不需向量检索，固定 dim=1 占位；所有过滤字段建 filter 索引便于查询
      await this.client.createCollection({
        collection: this.auditCollection,
        shardNum: 1,
        replicaNum: 2,
        description: "Memory 修改审计：L1/L2/L3 update/delete 事件流",
        embedding: { status: "disabled" },
        indexes: [
          { fieldName: "id",            fieldType: "string", indexType: "primaryKey" },
          { fieldName: "vector",        fieldType: "vector", indexType: "FLAT",
            dimension: 1, metricType: "COSINE" },
          { fieldName: "record_id",     fieldType: "string", indexType: "filter" },
          { fieldName: "layer",         fieldType: "string", indexType: "filter" },
          { fieldName: "action",        fieldType: "string", indexType: "filter" },
          { fieldName: "team_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",      fieldType: "string", indexType: "filter" },
          { fieldName: "user_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "task_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "version",       fieldType: "uint64", indexType: "filter" },
          { fieldName: "updated_at_ms", fieldType: "uint64", indexType: "filter" },
        ],
      });

      // knowledge_entities registry — 明细表（dim=1 占位；metadata 用 JSON 类型收类型专属字段）
      // 见 docs/design/vdb-knowledge-collection.md
      await this.client.createCollection({
        collection: this.knowledgeCollection,
        shardNum: 1,
        replicaNum: 2,
        description: "Knowledge entity metadata registry",
        embedding: { status: "disabled" },
        indexes: [
          { fieldName: "id",            fieldType: "string", indexType: "primaryKey" },
          { fieldName: "vector",        fieldType: "vector", indexType: "FLAT",
            dimension: 1, metricType: "COSINE" },
          { fieldName: "type",          fieldType: "string", indexType: "filter" },
          { fieldName: "team_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",      fieldType: "string", indexType: "filter" },
          { fieldName: "name",          fieldType: "string", indexType: "filter" },
          { fieldName: "user_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "metadata",      fieldType: "json",   indexType: "filter" },
          { fieldName: "created_at_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "updated_at_ms", fieldType: "uint64", indexType: "filter" },
        ],
      });

      const scalarCollection = async (
        collection: string,
        description: string,
        filterIndexes: Array<Record<string, unknown>>,
      ) => this.client.createCollection({
        collection,
        shardNum: 1,
        replicaNum: 2,
        description,
        embedding: { status: "disabled" },
        indexes: [
          { fieldName: "id", fieldType: "string", indexType: "primaryKey" },
          { fieldName: "vector", fieldType: "vector", indexType: "FLAT", dimension: 1, metricType: "COSINE" },
          ...filterIndexes,
        ],
      });

      await scalarCollection(this.memoryPromptsCollection, "Memory custom prompts", [
        { fieldName: "layer", fieldType: "string", indexType: "filter" },
        { fieldName: "status", fieldType: "string", indexType: "filter" },
        { fieldName: "version", fieldType: "uint64", indexType: "filter" },
        { fieldName: "updated_at_ms", fieldType: "uint64", indexType: "filter" },
      ]);
      await scalarCollection(this.memoryPromptSettingsCollection, "Memory prompt target settings", [
        { fieldName: "target_type", fieldType: "string", indexType: "filter" },
        { fieldName: "team_id", fieldType: "string", indexType: "filter" },
        { fieldName: "agent_id", fieldType: "string", indexType: "filter" },
        { fieldName: "layer", fieldType: "string", indexType: "filter" },
        { fieldName: "memory_prompt_id", fieldType: "string", indexType: "filter" },
        { fieldName: "updated_at_ms", fieldType: "uint64", indexType: "filter" },
      ]);
      await scalarCollection(this.memoryPromptSettingLogsCollection, "Memory prompt setting history", [
        { fieldName: "target_type", fieldType: "string", indexType: "filter" },
        { fieldName: "team_id", fieldType: "string", indexType: "filter" },
        { fieldName: "agent_id", fieldType: "string", indexType: "filter" },
        { fieldName: "layer", fieldType: "string", indexType: "filter" },
        { fieldName: "action", fieldType: "string", indexType: "filter" },
        { fieldName: "before_memory_prompt_id", fieldType: "string", indexType: "filter" },
        { fieldName: "after_memory_prompt_id", fieldType: "string", indexType: "filter" },
        { fieldName: "operated_at_ms", fieldType: "uint64", indexType: "filter" },
      ]);
      await scalarCollection(this.memoryGenerationRefsCollection, "Memory generation provenance references", [
        { fieldName: "layer", fieldType: "string", indexType: "filter" },
        { fieldName: "memory_id", fieldType: "string", indexType: "filter" },
        { fieldName: "generation_id", fieldType: "string", indexType: "filter" },
        { fieldName: "generation_log_id", fieldType: "string", indexType: "filter" },
        { fieldName: "memory_prompt_id", fieldType: "string", indexType: "filter" },
        { fieldName: "created_at_ms", fieldType: "uint64", indexType: "filter" },
      ]);

      this.logger?.debug?.(`${TAG} Initialized: db=${this.client.getDatabase()}, model=${this.embeddingModel}`);
    } catch (err) {
      // 15201 = database already exists — benign race in createDatabase().
      // 15202 (collection already exists) is now handled inside TcvdbClient.createCollection(),
      // so it should no longer reach here.
      if (err instanceof TcvdbApiError && err.apiCode === 15201) {
        this.logger?.debug?.(`${TAG} Init (benign): ${err.message}`);
        return;
      }
      this.logger?.error(`${TAG} Init failed: ${err instanceof Error ? err.message : String(err)}`);
      this.degraded = true;
    }
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): StoreCapabilities {
    const hasBm25 = !!this.bm25Encoder;
    return {
      vectorSearch: this.embeddingEnabled,
      ftsSearch: hasBm25,
      nativeHybridSearch: this.embeddingEnabled && hasBm25,
      sparseVectors: hasBm25,
    };
  }

  close(): void {
    // HTTP client — nothing to close
    // T2：伴生 sqlite 同步关（幂等——VectorStore.close 自带 double-close 防护）
    try {
      this.aux?.close();
    } catch (err) {
      this.logger?.warn?.(`${TAG} companion sqlite close failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.aux = undefined;
    }
  }

  // ── Internal: paginated query helper ────────────────────

  /**
   * Paginated /document/query that fetches all matching docs.
   * TCVDB query API returns at most `limit` docs per call.
   * We loop with offset until fewer docs than page size are returned.
   */
  private async _queryAllDocs(
    collection: string,
    filter?: string,
    outputFields?: string[],
    limit?: number,
    sort?: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const allDocs: Array<Record<string, unknown>> = [];
    let offset = 0;
    const pageSize = limit && limit < QUERY_PAGE_SIZE ? limit : QUERY_PAGE_SIZE;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const queryParams: Record<string, unknown> = {
        retrieveVector: false,
        limit: pageSize,
        offset,
      };
      if (filter) queryParams.filter = filter;
      if (outputFields) queryParams.outputFields = outputFields;
      if (sort) queryParams.sort = sort;

      const resp = await this.client.query(collection, queryParams);
      const docs = resp.documents ?? [];
      allDocs.push(...docs);

      // Stop if: we got fewer than page size (last page), or we hit caller's limit
      if (docs.length < pageSize) break;
      if (limit && allDocs.length >= limit) break;

      offset += docs.length;
    }

    // Trim to caller's limit if specified
    return limit ? allDocs.slice(0, limit) : allDocs;
  }

  // ── L1 Write Operations ──────────────────────────────────

  async upsertL1(record: MemoryRecord, _embedding?: Float32Array): Promise<boolean> {
    try {
      await this._upsertL1Async(record);
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-upsert] FAILED id=${record.id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async _upsertL1Async(record: MemoryRecord): Promise<void> {
    await this._ensureInit();
    if (this.degraded) return;

    const tsStr = record.timestamps[0] ?? "";
    const tsStart = record.timestamps.length > 0
      ? record.timestamps.reduce((a, b) => (a < b ? a : b)) : tsStr;
    const tsEnd = record.timestamps.length > 0
      ? record.timestamps.reduce((a, b) => (a > b ? a : b)) : tsStr;

    const doc: Record<string, unknown> = {
      id: record.id,
      text: record.content,
      type: record.type,
      priority: record.priority,
      scene_name: record.scene_name,
      team_id: record.teamId ?? "",
      user_id: record.userId ?? "",
      agent_id: record.agentId ?? "",
      version: record.version ?? 0,
      session_key: record.sessionKey,
      session_id: record.sessionId,
      task_id: record.taskId ?? "",
      timestamp_str: tsStr,
      timestamp_start: tsStart,
      timestamp_end: tsEnd,
      created_time_ms: isoToEpochMs(record.createdAt),
      updated_time_ms: isoToEpochMs(record.updatedAt),
      metadata_json: JSON.stringify(record.metadata),
      memory_type: DEFAULT_MEMORY_TYPE,
      // 灵魂记忆字段（P2a）透传
      occurred_at: record.occurred_at ?? "",
      valid_start: record.valid_start ?? "",
      valid_end: record.valid_end ?? "",
      certainty: record.certainty ?? "observed",
      source: record.source ?? "",
      valence: record.valence ?? null,
      arousal: record.arousal ?? null,
      significance: record.significance ?? null,
    };
    if (!this.embeddingEnabled) doc.vector = [1];

    // BM25 sparse vector (if sidecar available)
    if (this.bm25Encoder) {
      const sparse = this.bm25Encoder.encodeTexts([record.content]);
      if (sparse.length > 0 && sparse[0].length > 0) {
        doc.sparse_vector = sparse[0];
      }
    }

    await this.client.upsert(this.l1Collection, [doc]);
  }

  /**
   * Batch upsert multiple L1 records in a single API call.
   * Used by migration scripts to reduce request count.
   */
  async upsertL1Batch(records: MemoryRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    try {
      await this._ensureInit();
      if (this.degraded) return 0;

      const docs = records.map((record) => {
        const tsStr = record.timestamps[0] ?? "";
        const tsStart = record.timestamps.length > 0
          ? record.timestamps.reduce((a, b) => (a < b ? a : b)) : tsStr;
        const tsEnd = record.timestamps.length > 0
          ? record.timestamps.reduce((a, b) => (a > b ? a : b)) : tsStr;

        const doc: Record<string, unknown> = {
          id: record.id,
          text: record.content,
          type: record.type,
          priority: record.priority,
          scene_name: record.scene_name,
          team_id: record.teamId ?? "",
          user_id: record.userId ?? "",
          agent_id: record.agentId ?? "",
          version: record.version ?? 0,
          session_key: record.sessionKey,
          session_id: record.sessionId,
          task_id: record.taskId ?? "",
          timestamp_str: tsStr,
          timestamp_start: tsStart,
          timestamp_end: tsEnd,
          created_time_ms: isoToEpochMs(record.createdAt),
          updated_time_ms: isoToEpochMs(record.updatedAt),
          metadata_json: JSON.stringify(record.metadata),
          memory_type: DEFAULT_MEMORY_TYPE,
          occurred_at: record.occurred_at ?? "",
          valid_start: record.valid_start ?? "",
          valid_end: record.valid_end ?? "",
          certainty: record.certainty ?? "observed",
          source: record.source ?? "",
          valence: record.valence ?? null,
          arousal: record.arousal ?? null,
          significance: record.significance ?? null,
        };
        if (!this.embeddingEnabled) doc.vector = [1];

        if (this.bm25Encoder) {
          const sparse = this.bm25Encoder.encodeTexts([record.content]);
          if (sparse.length > 0 && sparse[0].length > 0) {
            doc.sparse_vector = sparse[0];
          }
        }
        return doc;
      });

      await this.client.upsert(this.l1Collection, docs);
      return records.length;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-upsertBatch] FAILED (${records.length} records): ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async deleteL1(recordId: string): Promise<boolean> {
    try {
      await this._ensureInit();
      if (this.degraded) return false;
      const affected = await this.client.deleteDoc(this.l1Collection, {
        query: { documentIds: [recordId] },
      });
      return affected > 0;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-delete] FAILED id=${recordId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async deleteL1Batch(recordIds: string[]): Promise<boolean> {
    if (recordIds.length === 0) return true;
    try {
      await this._ensureInit();
      if (this.degraded) return false;
      await this.client.deleteDoc(this.l1Collection, {
        query: { documentIds: recordIds },
      });
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-deleteBatch] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async deleteL1Expired(cutoffIso: string): Promise<number> {
    const cutoffMs = isoToEpochMs(cutoffIso);
    if (cutoffMs <= 0) return 0;
    try {
      await this._ensureInit();
      if (this.degraded) return 0;

      const filter = `updated_time_ms < ${cutoffMs}`;
      const toDelete = await this.client.count(this.l1Collection, filter);
      if (toDelete === 0) return 0;

      const total = await this.client.count(this.l1Collection);
      const ratio = total > 0 ? toDelete / total : 0;

      if (ratio > 0.8) {
        this.logger?.warn(
          `${TAG} [L1-deleteExpired] BLOCKED: would delete ${toDelete}/${total} ` +
          `(${(ratio * 100).toFixed(1)}%) — exceeds 80% safety threshold, cutoff=${cutoffIso}`,
        );
        return 0;
      }

      await this.client.deleteDoc(this.l1Collection, {
        query: { filter },
      });
      this.logger?.info?.(
        `${TAG} [L1-deleteExpired] Deleted ~${toDelete}/${total} records (cutoff=${cutoffIso})`,
      );
      return toDelete;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-deleteExpired] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  // ── L1 Read Operations ───────────────────────────────────

  async countL1(filter?: L1CountFilter): Promise<number> {
    try {
      await this._ensureInit();
      if (this.degraded) return 0;
      const conditions: string[] = [];
      if (filter?.type) conditions.push(eqFilter("type", filter.type));
      conditions.push(...buildIsolationConditions({
        teamId: filter?.teamId,
        userId: filter?.userId,
        agentId: filter?.agentId,
        sessionId: filter?.sessionId,
        taskId: filter?.taskId,
      }));
      if (filter?.timeStart) {
        const ms = isoToEpochMs(filter.timeStart);
        if (ms > 0) conditions.push(`updated_time_ms >= ${ms}`);
      }
      if (filter?.timeEnd) {
        const ms = isoToEpochMs(filter.timeEnd);
        if (ms > 0) conditions.push(`updated_time_ms <= ${ms}`);
      }
      return await this.client.count(this.l1Collection, joinFilter(conditions));
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-count] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async queryL1Records(filter?: L1QueryFilter): Promise<L1RecordRow[]> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      // Build filter expression
      const conditions = buildIsolationConditions(filter);
      if (filter?.updatedAfter) {
        const afterMs = isoToEpochMs(filter.updatedAfter);
        if (afterMs > 0) conditions.push(`updated_time_ms > ${afterMs}`);
      }
      const filterExpr = joinFilter(conditions);

      // Primary key lookup: use documentIds (fast, no full scan)
      if (filter?.recordIds && filter.recordIds.length > 0) {
        const queryParams: Record<string, unknown> = {
          retrieveVector: false,
          documentIds: filter.recordIds,
          outputFields: L1_OUTPUT_FIELDS,
        };
        if (filterExpr) queryParams.filter = filterExpr;
        const resp = await this.client.query(this.l1Collection, queryParams);
        const docs = resp.documents ?? [];
        return docs.map((doc: Record<string, unknown>) => ({
          record_id: String(doc.id ?? ""),
          content: String(doc.text ?? ""),
          type: String(doc.type ?? ""),
          priority: Number(doc.priority ?? 0),
          scene_name: String(doc.scene_name ?? ""),
          session_key: String(doc.session_key ?? ""),
          session_id: String(doc.session_id ?? ""),
          task_id: String(doc.task_id ?? ""),
          team_id: String(doc.team_id ?? ""),
          user_id: String(doc.user_id ?? ""),
          agent_id: String(doc.agent_id ?? ""),
          version: Number(doc.version ?? 0),
          timestamp_str: String(doc.timestamp_str ?? ""),
          timestamp_start: String(doc.timestamp_start ?? ""),
          timestamp_end: String(doc.timestamp_end ?? ""),
          created_time: epochMsToIso(Number(doc.created_time_ms ?? 0)),
          updated_time: epochMsToIso(Number(doc.updated_time_ms ?? 0)),
          metadata_json: String(doc.metadata_json ?? "{}"),
        }));
      }

      // Full scan with optional filter

      const docs = await this._queryAllDocs(
        this.l1Collection,
        filterExpr,
        L1_OUTPUT_FIELDS,
        undefined, // no limit — fetch all matching
        [{ fieldName: "updated_time_ms", direction: "asc" }],
      );

      return docs.map((doc) => ({
        record_id: String(doc.id ?? ""),
        content: String(doc.text ?? ""),
        type: String(doc.type ?? ""),
        priority: Number(doc.priority ?? 0),
        scene_name: String(doc.scene_name ?? ""),
        session_key: String(doc.session_key ?? ""),
        session_id: String(doc.session_id ?? ""),
        task_id: String(doc.task_id ?? ""),
        team_id: String(doc.team_id ?? ""),
        user_id: String(doc.user_id ?? ""),
        agent_id: String(doc.agent_id ?? ""),
        version: Number(doc.version ?? 0),
        timestamp_str: String(doc.timestamp_str ?? ""),
        timestamp_start: String(doc.timestamp_start ?? ""),
        timestamp_end: String(doc.timestamp_end ?? ""),
        created_time: epochMsToIso(Number(doc.created_time_ms ?? 0)),
        updated_time: epochMsToIso(Number(doc.updated_time_ms ?? 0)),
        metadata_json: String(doc.metadata_json ?? "{}"),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-query] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async getAllL1Texts(): Promise<Array<{ record_id: string; content: string; updated_time: string }>> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const docs = await this._queryAllDocs(
        this.l1Collection,
        undefined,
        ["id", "text", "updated_time_ms"],
      );

      return docs.map((doc) => ({
        record_id: String(doc.id ?? ""),
        content: String(doc.text ?? ""),
        updated_time: epochMsToIso(Number(doc.updated_time_ms ?? 0)),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-getAllTexts] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── L1 Reconsolidation（T1-B：metadata 读-改-写）──────────

  /** 读取单条 L1 doc 全字段（retrieveVector=true 带回 vector，供读-改-写整行回写保向量）。 */
  private async _getL1DocFull(id: string): Promise<Record<string, unknown> | undefined> {
    const resp = await this.client.query(this.l1Collection, {
      retrieveVector: true,
      documentIds: [id],
    });
    const docs = resp.documents ?? [];
    return docs[0];
  }

  /**
   * 读-改-写整行重建（T1-B）：以读回的 doc 为底，覆盖 overrides，
   * 并按集合形态保全向量字段：
   *   - 读回带 vector（数组）→ 原样写回（最忠实，推荐路径）；
   *   - 读不到 vector（API 形态待真机复验）且 embedding 集合 → 省略 vector 字段，
   *     服务端按 text 重新 embedding（text 未变 → 语义等价，多一次 embedding 成本）；
   *   - 非 embedding 集合 → 回填 dim=1 占位向量 [1]（与 upsertL1 同形态）。
   */
  private _rewriteL1Doc(doc: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
    const rewrite: Record<string, unknown> = { ...doc, ...overrides };
    if (Array.isArray(doc.vector)) {
      rewrite.vector = doc.vector;
    } else if (this.embeddingEnabled) {
      delete rewrite.vector;
    } else {
      rewrite.vector = [1];
    }
    return rewrite;
  }

  /**
   * 重巩固（reconsolidation，H 设计§4）：仅更新 L1 行的 metadata（合并 patch），
   * 不重写 content/向量——防"越回忆越信自己的编造"。召回统计类字段（recall_count 等）。
   *
   * 语义对齐 sqlite updateL1Metadata（sqlite.ts:2549）：
   *   - degraded / 行不存在 → false；
   *   - metadata_json 损坏 → 按 {} 宽容合并（sqlite catch→{} 同语义）；
   *   - 成功 → true（patch 合并进 metadata_json，updated_time 刷新）。
   *
   * TCVDB HTTP API 无部分更新/原子 JSON 操作（TcvdbClient 只有 upsert/query），
   * 实现为读-改-写（query 全行 → 合并 → upsert 整行），**非原子**：
   * 并发 updateL1Metadata / bumpRecallCount 间存在丢更新竞态窗口
   * （sqlite 走 SQL 单语句无此窗口；tcvdb 真机原子性行为登记部署时复验）。
   */
  async updateL1Metadata(id: string, patch: Record<string, unknown>): Promise<boolean> {
    try {
      await this._ensureInit();
      if (this.degraded) return false;
      const doc = await this._getL1DocFull(id);
      if (!doc) return false;
      const meta = parseL1MetadataLenient(doc.metadata_json);
      const merged = JSON.stringify({ ...meta, ...patch });
      const nowMs = Date.now();
      await this.client.upsert(this.l1Collection, [
        this._rewriteL1Doc(doc, { metadata_json: merged, updated_time_ms: nowMs }),
      ]);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [reconsolidation] updateL1Metadata failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** 损坏 metadata_json warn 去重（对齐 sqlite warnCorruptMetadataJsonOnce）。 */
  private warnCorruptMetadataJsonOnce(id: string, detail: string): void {
    if (corruptJsonWarnedIds.has(id)) return;
    if (corruptJsonWarnedIds.size < CORRUPT_JSON_WARN_MAX_IDS) {
      corruptJsonWarnedIds.add(id);
      this.logger?.warn?.(`${TAG} [reconsolidation] bumpRecallCount 跳过损坏 metadata_json（每行仅 warn 一次）record_id=${id}: ${detail}`);
      return;
    }
    corruptJsonOverflowCount += 1;
    if (corruptJsonOverflowCount === 1 || corruptJsonOverflowCount % CORRUPT_JSON_SUMMARY_EVERY === 0) {
      this.logger?.warn?.(
        `${TAG} [reconsolidation] bumpRecallCount 损坏 metadata_json 行数超限（唯一 id > ${CORRUPT_JSON_WARN_MAX_IDS}），` +
          `改为计数汇总：已额外计数 ${corruptJsonOverflowCount} 行（当前: ${detail}）`,
      );
    }
  }

  /**
   * 重巩固（P0-T4，H-B1）：recall_count 自增。语义对齐 sqlite bumpRecallCount（sqlite.ts:2600）：
   *   - 行不存在 / degraded → false；
   *   - metadata_json 损坏（非法 JSON）→ 去重 warn + false（拒绝写入，行不被半写）；
   *   - metadata_json 合法但非对象态（如 '[]'、'5'）→ 去重 warn + 显式 false（拒绝写入）；
   *   - 否则 recall_count = 现值（无值/非有限数值从 0 起）+ 1，last_recalled_at = now，
   *     其余 metadata 字段保留（sqlite json_set 只动两键的同语义），updated_time 刷新。
   *
   * sqlite 走 SQL json_set 单语句原子自增（不读回）；TCVDB 无 json_set 等价物 →
   * 应用层读-改-写，**非原子**：并发 bump 存在丢增量竞态窗口（如实登记）。
   * 失败语义与 sqlite 一致：显式 false，不静默 no-op。
   */
  async bumpRecallCount(id: string, now?: string): Promise<boolean> {
    try {
      await this._ensureInit();
      if (this.degraded) return false;
      const nowIso = now ?? new Date().toISOString();
      // 写前形态校验（对齐 sqlite :2608-2623）：先单独裁决 json_valid，
      // 再裁决对象态 —— 损坏/非对象都拒绝写入（应用层等价于 sqlite 的
      // json_valid + json_type 双门 + WHERE json_valid 防半写）。
      const doc = await this._getL1DocFull(id);
      if (!doc) return false;
      const mj = doc.metadata_json;
      if (mj != null && mj !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(mj));
        } catch {
          this.warnCorruptMetadataJsonOnce(id, "json_valid=false（损坏 JSON，拒绝写入防半写）");
          return false;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          this.warnCorruptMetadataJsonOnce(id, `json_type=${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}（合法但非对象态，显式拒绝）`);
          return false;
        }
      }
      const meta = parseL1MetadataLenient(mj);
      const prev = typeof meta.recall_count === "number" && Number.isFinite(meta.recall_count)
        ? meta.recall_count
        : 0;
      const merged = JSON.stringify({
        ...meta,
        recall_count: prev + 1,
        last_recalled_at: nowIso,
      });
      await this.client.upsert(this.l1Collection, [
        this._rewriteL1Doc(doc, { metadata_json: merged, updated_time_ms: Date.now() }),
      ]);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [reconsolidation] bumpRecallCount failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * T15-A（向量健康三件套）tcvdb 版：真实向量行数（T1-C）。
   *
   * TCVDB 的向量内联在文档行里（l1 collection 自带向量索引：embedding 集合为
   * 服务端 embedding 的 vector 字段，非 embedding 集合为 dim=1 占位），
   * 不存在 sqlite vec0 阴影表（l1_vec_rowids）与元数据表分离的结构 ——
   * **文档行即向量行**，计数 = /document/count 全量（无 filter）。
   *
   * 精度如实登记：
   *   - upsert 单文档原子，不存在 sqlite G1（104 vec / 203 records）式
   *     "元数据行涨、向量行静默失败"的滞后 → 计数恒等于文档总数；
   *   - 非 embedding 模式的"向量行"是 dim=1 占位向量（语义上非语义向量，
   *     与 collection 建索引形态一致——向量可用性判据请结合 getCapabilities().vectorSearch）。
   *
   * degraded / 查询失败（非致命）→ 0。l1-dedup 判据经 feature-detect 自动获益。
   */
  async countL1VectorRows(): Promise<number> {
    try {
      await this._ensureInit();
      if (this.degraded) return 0;
      return await this.client.count(this.l1Collection);
    } catch (err) {
      this.logger?.warn(
        `${TAG} countL1VectorRows failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  // ── T2（伴生 SQLite 模式）：图全套 / 归档桶 / core 表 ─────
  //
  // 设计裁决（task-t2-brief）：tcvdb 是向量库，装不下辅助表（links/archive/core）。
  // 辅助表的 DDL 与 CRUD **全部落在伴生 sqlite**（同 dataDir 下 tcvdb-aux.db），
  // 实现方式 = **委托**：伴生库直接实例化 sqlite.ts 的 VectorStore（dims=0 元数据模式），
  // 一切辅助表 SQL 逐字复用既有实现（单一事实源，R1 铁律——本节零第二份手写 SQL；
  // 唯一的读取型例外在 pruneOrphanLinks/restoreL1 注释里逐一登记）。
  // 向量/FTS 侧语义（归档删向量、图边随硬删级联等）由 tcvdb 自身操作补齐，
  // 与 sqlite 后端逐字对齐。真机实证登记为部署时任务（spec §6.4 先例）。

  /**
   * T2 私有：tcvdb 实时行批量取回（HTTP query 分页，doc → L1SearchResult 映射）。
   * **失败抛出**（与 _resolveL1Rows 的"吞错+归档回退"不同）——调用方各自决定 fail 语义：
   * pruneOrphanLinks fail-safe 放弃本轮（审计 I-2）/ getL1ByIds 容错返空 / _resolveL1Rows 归档回退。
   * 返回 { rows: 命中行, missing: 未命中的 id }（未命中 ≠ 失败，行可能只在归档桶）。
   */
  private async _fetchLiveL1Rows(ids: string[]): Promise<{ rows: L1SearchResult[]; missing: string[] }> {
    const rows: L1SearchResult[] = [];
    const live = new Set<string>();
    for (let i = 0; i < ids.length; i += QUERY_PAGE_SIZE) {
      const batch = ids.slice(i, i + QUERY_PAGE_SIZE);
      const resp = await this.client.query(this.l1Collection, {
        retrieveVector: false,
        documentIds: batch,
        outputFields: L1_OUTPUT_FIELDS,
      });
      for (const doc of resp.documents ?? []) {
        const rid = String(doc.id ?? "");
        if (!rid) continue;
        live.add(rid);
        rows.push({
          record_id: rid,
          content: String(doc.text ?? ""),
          type: String(doc.type ?? ""),
          priority: Number(doc.priority ?? 0),
          scene_name: String(doc.scene_name ?? ""),
          score: 0,
          timestamp_str: String(doc.timestamp_str ?? ""),
          timestamp_start: String(doc.timestamp_start ?? ""),
          timestamp_end: String(doc.timestamp_end ?? ""),
          version: Number(doc.version ?? 0),
          session_key: String(doc.session_key ?? ""),
          session_id: String(doc.session_id ?? ""),
          team_id: String(doc.team_id ?? ""),
          task_id: String(doc.task_id ?? ""),
          user_id: String(doc.user_id ?? ""),
          agent_id: String(doc.agent_id ?? ""),
          metadata_json: String(doc.metadata_json ?? "{}"),
          occurred_at: (doc.occurred_at as string) || undefined,
          valid_start: (doc.valid_start as string) || undefined,
          valid_end: (doc.valid_end as string) || undefined,
          certainty: (doc.certainty as string) || undefined,
          source: (doc.source as string) || undefined,
          valence: (doc.valence as number) ?? undefined,
          arousal: (doc.arousal as number) ?? undefined,
          significance: (doc.significance as number) ?? undefined,
        });
      }
    }
    return { rows, missing: ids.filter((id) => !live.has(id)) };
  }

  /** T2 私有：tcvdb 实时行解析（ids → L1SearchResult，含 soul 字段；供图 filter 两步过滤）。 */
  private async _resolveL1Rows(ids: string[]): Promise<L1SearchResult[]> {
    if (!ids || ids.length === 0) return [];
    let rows: L1SearchResult[] = [];
    let missing = ids;
    try {
      const fetched = await this._fetchLiveL1Rows(ids);
      rows = fetched.rows;
      missing = fetched.missing;
    } catch (err) {
      // 实时行解析失败不致命：继续走伴生归档回退（宁缺毋滥语义由 rowMatchesIsolation 兜底）
      this.logger?.warn?.(`${TAG} [l1_links] live row resolve failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const out = [...rows];
    const aux = this._auxReady();
    if (missing.length > 0 && aux) {
      // 审计 B3 同语义：解析不到实时行的 id 回退归档桶（伴生库内逐字复用 sqlite 实现）
      out.push(...aux.getL1ByIdsWithArchive(missing));
    }
    return out;
  }

  /**
   * T2-A（fix1 I-4 接线拍板）：按 id 批量取回 L1 实时记录（含灵魂字段），供邻居扩展/图 BFF 组装。
   * 形状对齐 sqlite.getL1ByIds（score=0、缺字段空串兜底、失败容错返 []）。异步 HTTP 批量取行——
   * types.ts 接口同步放宽为 MaybePromise（与相邻图方法同形），消费方统一 await
   * （sqlite 同步路径 await 数组零语义变化）。只查 tcvdb 实时面，不含归档（归档回退见
   * getL1ByIdsWithArchive，与 sqlite 两版语义逐字对齐）。
   */
  async getL1ByIds(ids: string[]): Promise<Array<L1SearchResult>> {
    try {
      await this._ensureInit();
      if (!ids || ids.length === 0) return [];
      return (await this._fetchLiveL1Rows(ids)).rows;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] getL1ByIds failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * T2-A（fix1 I-4）：getL1ByIds 的归档桶回退版（审计 B3 语义，同 sqlite.getL1ByIdsWithArchive）——
   * 实时面解析不到的 id 回退伴生归档桶（aux.getL1ByIdsWithArchive 逐字复用 sqlite 实现），
   * 演进/合并的旧证据在归档桶也能读回，否则边是"指向不存在记录的孤儿边"。
   */
  async getL1ByIdsWithArchive(ids: string[]): Promise<Array<L1SearchResult>> {
    const live = await this.getL1ByIds(ids);
    const missing = ids.filter((id) => !live.some((r) => r.record_id === id));
    if (missing.length === 0) return live;
    const out = [...live];
    try {
      const aux = this._auxReady();
      if (aux) out.push(...aux.getL1ByIdsWithArchive(missing));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] getL1ByIdsWithArchive failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out;
  }

  /** T2 私有：两步过滤的行复核（批量取行 + rowMatchesIsolation；同 sqlite.ts getNeighbors G2）。 */
  private async _filterOkIds(nids: string[], filter: IsolationFilter): Promise<Set<string>> {
    const uniq = [...new Set(nids.filter((id) => id !== ""))];
    if (uniq.length === 0) return new Set();
    const recs = await this._resolveL1Rows(uniq);
    return new Set(recs.filter((rec) => rowMatchesIsolation(rec, filter)).map((rec) => rec.record_id));
  }

  /**
   * T2-A：记忆图建边。委托伴生库 addLink（sqlite.ts 同一 INSERT ON CONFLICT 语句，
   * 同 (s,t,type) 幂等、重复建边更新强度/时间）。
   */
  async addLink(sourceId: string, targetId: string, type: string, strength = 1, now = new Date().toISOString()): Promise<boolean> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return false;
      return aux.addLink(sourceId, targetId, type, strength, now);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] addLink failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * T2-A：邻接查询（BFS maxHop）。
   *
   * 无 filter → 整体委托伴生库 getNeighbors（sqlite.ts 既有 BFS + 双向边 SQL 逐字复用）。
   * 带 filter（T14 G2 两步过滤）→ 伴生库 BFS 是同步实现、无法回调 tcvdb 异步行解析，
   * 故在本层做 BFS 循环：每跳的**边读取**仍逐节点委托 aux.getNeighbors（同一份 SQL，
   * 只取 hop=1 的直接邻接），行复核走 _resolveL1Rows（tcvdb 实时 + 伴生归档）+
   * rowMatchesIsolation——语义与 sqlite.ts 逐项对齐（不穿过跨租户节点、
   * 租户不可验证的边宁缺毋滥、seen 集合防环路）。
   */
  async getNeighbors(id: string, types?: string[], maxHop = 1, filter?: IsolationFilter): Promise<Array<{ id: string; type: string; strength: number; hop: number }>> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return [];
      if (!filter) return aux.getNeighbors(id, types, maxHop);
      const out: Array<{ id: string; type: string; strength: number; hop: number }> = [];
      const seen = new Set<string>([id]);
      let frontier: string[] = [id];
      for (let hop = 1; hop <= maxHop; hop++) {
        if (frontier.length === 0) break;
        const candidates: Array<{ nid: string; type: string; strength: number }> = [];
        for (const node of frontier) {
          for (const e of aux.getNeighbors(node, undefined, 1)) {
            candidates.push({ nid: e.id, type: e.type, strength: e.strength });
          }
        }
        const okIds = await this._filterOkIds(candidates.map((c) => c.nid), filter);
        const next: string[] = [];
        for (const c of candidates) {
          const nid = c.nid;
          if (seen.has(nid)) continue;
          if (!okIds.has(nid)) continue; // 租户不可验证/跨租户 → 剪枝（不穿过）
          if (types && types.length > 0 && !types.includes(c.type)) continue;
          seen.add(nid);
          out.push({ id: nid, type: c.type, strength: c.strength, hop });
          next.push(nid);
        }
        frontier = next;
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] getNeighbors failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * T2-A / C6：两节点间最短路径（BFS）。无 filter → 整体委托伴生库 getPath（逐字复用）。
   * 带 filter → 本层 BFS（同 getNeighbors 的委托形态），语义对齐 sqlite.ts：
   * 起点/终点行 rowMatchesIsolation 复核（起点不可见 → null；终点不可见 → 永不入队 → null）、
   * 每跳两步过滤不穿跨租户节点、双向边扩展、父指针回溯、起点即终点返回 []。
   */
  async getPath(startId: string, endId: string, maxHop = 3, types?: string[], filter?: IsolationFilter): Promise<Array<{ id: string; type: string; strength: number; hop: number }> | null> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return null;
      if (!startId || !endId) return null;
      if (startId === endId) return [];
      if (!filter) return aux.getPath(startId, endId, maxHop, types);
      const startRows = await this._resolveL1Rows([startId]);
      if (!startRows.some((rec) => rec.record_id === startId && rowMatchesIsolation(rec, filter))) return null;
      const cameFrom = new Map<string, { from: string; type: string; strength: number; hop: number }>();
      const seen = new Set<string>([startId]);
      let frontier: string[] = [startId];
      for (let hop = 1; hop <= maxHop; hop++) {
        if (frontier.length === 0) break;
        const candidates: Array<{ nid: string; other: string; type: string; strength: number }> = [];
        for (const node of frontier) {
          for (const e of aux.getNeighbors(node, undefined, 1)) {
            candidates.push({ nid: e.id, other: node, type: e.type, strength: e.strength });
          }
        }
        const okIds = await this._filterOkIds(candidates.map((c) => c.nid), filter);
        const frontierIds = new Set(frontier);
        const next: string[] = [];
        for (const c of candidates) {
          const nid = c.nid;
          if (seen.has(nid)) continue;
          if (!okIds.has(nid)) continue;
          if (types && types.length > 0 && !types.includes(c.type)) continue;
          const parent = c.other;
          if (!frontierIds.has(parent)) continue; // 防御：父指针必须在当前层（sqlite 同款）
          seen.add(nid);
          cameFrom.set(nid, { from: parent, type: c.type, strength: c.strength, hop });
          if (nid === endId) {
            const path: Array<{ id: string; type: string; strength: number; hop: number }> = [];
            let cur = endId;
            while (cur !== startId) {
              const edge = cameFrom.get(cur);
              if (!edge) return null; // 不可能（有父指针才入队）；防御性返回（sqlite 同款）
              path.unshift({ id: cur, type: edge.type, strength: edge.strength, hop: edge.hop });
              cur = edge.from;
            }
            return path;
          }
          next.push(nid);
        }
        frontier = next;
      }
      return null;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] getPath failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** T2-A：删除某记忆的所有边（记忆硬删级联）。委托伴生库（同一 DELETE 语句）。 */
  async deleteLinksFor(id: string): Promise<boolean> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return false;
      return aux.deleteLinksFor(id);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] deleteLinksFor failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * T2-A（审计 F5）：清理孤儿边（任一端点已不在 tcvdb 实时面且不在伴生归档桶）。
   *
   * **登记的读取型最小内联例外**：sqlite 版是单条 set-based DELETE（IN 子查询查本库
   * l1_records/l1_archive），tcvdb 模式下"实时行"在 tcvdb 侧——跨后端存在性判定无法
   * 用一条 SQL 表达，伴生库也没有公开的边枚举 API。故此处仅一条**只读**枚举语句
   * （SELECT source_id, target_id FROM l1_links，与 sqlite.ts 的表定义同源），
   * 孤儿判定在应用层跨后端对账（tcvdb 实时 + 伴生归档回退），删边仍复用
   * aux.deleteLinksFor 的既有 DELETE 语句。返回删除的边数（与 sqlite changes 口径一致）；
   * 失败返回 -1。
   */
  async pruneOrphanLinks(): Promise<number> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return -1;
      const edgeRows = aux.getRawDb().prepare("SELECT source_id, target_id FROM l1_links").all() as Array<{ source_id: string; target_id: string }>;
      if (edgeRows.length === 0) return 0;
      const endpoints = [...new Set(edgeRows.flatMap((e) => [String(e.source_id), String(e.target_id)]))].filter((id) => id !== "");
      // 审计修复 I-2（fail-safe）：实时行解析失败 → live 集合不可信，若继续会把全量边误判
      // 死边全量删。放弃本轮返回 -1（调用方按失败口径处理），零删边；归档回退仍要（指向
      // 归档记录的边合法，审计 B3），但归档回退前的实时取行失败必须中止。
      let recs: L1SearchResult[];
      try {
        const fetched = await this._fetchLiveL1Rows(endpoints);
        recs = [...fetched.rows];
        if (fetched.missing.length > 0) recs.push(...aux.getL1ByIdsWithArchive(fetched.missing));
      } catch (resolveErr) {
        this.logger?.warn?.(`${TAG} [l1_links] pruneOrphanLinks live row resolve failed — abort this round (fail-safe, zero deletions): ${resolveErr instanceof Error ? resolveErr.message : String(resolveErr)}`);
        return -1;
      }
      const alive = new Set(recs.map((rec) => rec.record_id));
      const prunedCount = edgeRows.filter((e) => !alive.has(String(e.source_id)) || !alive.has(String(e.target_id))).length;
      if (prunedCount === 0) return 0;
      const dead = endpoints.filter((id) => !alive.has(id));
      for (const id of dead) {
        if (!aux.deleteLinksFor(id)) return -1;
      }
      if (prunedCount > 0) this.logger?.info?.(`${TAG} [l1_links] pruned ${prunedCount} orphan edge(s)`);
      return prunedCount;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] pruneOrphanLinks failed: ${err instanceof Error ? err.message : String(err)}`);
      return -1;
    }
  }

  /**
   * T2-B：遗忘归档桶（I，设计§3）。语义对齐 sqlite archiveL1 的「删向量+FTS、留归档行」：
   *   1) 读 tcvdb 全行（含向量字段，_getL1DocFull）——行不存在 → false（sqlite 同语义）；
   *   2) 整行以 MemoryRecord 写入伴生 l1_records（复用 sqlite upsert SQL）→ 委托
   *      aux.archiveL1 完成归档移动（SELECT 行 → INSERT l1_archive → DELETE l1_records，
   *      逐字复用，归档行 = 26 列 snake_case JSON，与 sqlite 完全同构，listArchived 的
   *      json_extract 直接可用）；
   *   3) tcvdb 侧删 doc（向量 + sparse + 标量一体删除 = tcvdb 形态的"删向量+FTS"）。
   *   步骤 3 失败 → 补偿回滚（归档行还原并清场，不留半态），返回 false 供调用方重试。
   *   归档不级联删边（审计 B3：边是关系事实，指向归档记录合法）。
   *   跨系统非原子如实登记：2-3 之间进程崩溃会留下"归档行 + tcvdb 残行"，
   *   重试 archiveL1 幂等收敛（先清旧归档行再归档）；3 之后崩溃则已是目标态。
   */
  async archiveL1(id: string, reason = "forgetting"): Promise<boolean> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux || this.degraded) return false;
      const doc = await this._getL1DocFull(id);
      if (!doc) return false;
      // 幂等收敛：重试场景下先撤掉旧归档行（还原到伴生 l1_records 再硬删清场）
      const stale = aux.getRawDb().prepare("SELECT record_id FROM l1_archive WHERE record_id = ?").get(id) as { record_id?: string } | undefined;
      if (stale?.record_id) {
        if (aux.restoreL1(id)) aux.deleteL1(id);
      }
      if (!aux.upsertL1(docToMemoryRecord(doc), undefined)) {
        this.logger?.warn?.(`${TAG} [l1_archive] companion upsert failed for ${id}`);
        return false;
      }
      if (!aux.archiveL1(id, reason)) {
        aux.deleteL1(id); // 补偿：撤掉暂存行，不留半态
        this.logger?.warn?.(`${TAG} [l1_archive] companion archive move failed for ${id}`);
        return false;
      }
      const delOk = await this.deleteL1(id);
      if (!delOk) {
        // 补偿：归档行还原回伴生 l1_records 后硬删清场（数据不丢——tcvdb 行仍在，可重试）
        try {
          if (aux.restoreL1(id)) aux.deleteL1(id);
        } catch (cmpErr) {
          this.logger?.warn?.(`${TAG} [l1_archive] compensation failed for ${id}: ${cmpErr instanceof Error ? String(cmpErr) : String(cmpErr)}`);
        }
        this.logger?.warn?.(`${TAG} [l1_archive] tcvdb doc delete failed for ${id} — compensated, retry safe`);
        return false;
      }
      this.logger?.debug?.(`${TAG} [l1_archive] archived ${id} (${reason})`);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_archive] archive failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * T2-B：恢复。把归档行写回 tcvdb（字段级回填；向量由 server embedding 按 text 重嵌
   * 或非 embedding 集合回填占位——与 sqlite「向量由下次写入补齐」同语义）。
   *
   * **登记的读取型最小内联例外**：需要归档行 JSON 全量（26 列，含 created/updated 时间与
   * version——L1SearchResult 映射会丢 created/updated），读取语句与 sqlite.ts restoreL1
   * 的 `SELECT data FROM l1_archive WHERE record_id = ?` 逐字相同（经 getRawDb 复用伴生
   * 连接）。归档行的消费仍委托 aux.restoreL1（逐字复用其移动 + FTS 重建），中转行随即
   * aux.deleteL1 清场。写回 tcvdb 失败 → 行送回归档桶（reason=restore-compensation，
   * 宁归档不可失），返回 false。
   * 审计修复 I-1：degraded → false（与 archiveL1 同款守卫）——degraded 下 tcvdb 写入
   * 会被静默跳过，若放行 restore 会"消费归档行+删中转行+tcvdb 写入跳过"= 记录双消失。
   *
   * SEC-1（安全级）：可选 IsolationFilter 属主校验——归档行存在性预读带上租户三列，
   * 委托 aux.restoreL1(id, filter) 做 rowMatchesIsolation 复核（单源：校验逻辑逐字
   * 复用 sqlite 实现，零第二份手写）；不匹配 → false（消费前拒绝，归档行不动）。
   * filter 缺省 = 旧行为（内部补偿路径 restore-compensation 不传 filter）。
   */
  async restoreL1(id: string, filter?: IsolationFilter): Promise<boolean> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux || this.degraded) return false;
      const row = aux.getRawDb().prepare("SELECT data FROM l1_archive WHERE record_id = ?").get(id) as { data: string } | undefined;
      if (!row) return false; // sqlite 同语义：不在归档 → false
      const d = JSON.parse(row.data) as Record<string, unknown>;
      const record = archiveRowToMemoryRecord(d);
      // 消费归档行（委托 sqlite restoreL1：归档行 → 伴生 l1_records + FTS 重建；
      // SEC-1 属主校验在 aux.restoreL1 内部——filter 传入时租户不匹配即 false）
      if (!aux.restoreL1(id, filter)) return false;
      if (!aux.deleteL1(id)) {
        this.logger?.warn?.(`${TAG} [l1_archive] companion temp row cleanup failed for ${id} (benign: aux l1_records is workspace-only)`);
      }
      const ok = await this.upsertL1(record);
      if (!ok) {
        // 写回失败：行送回归档桶（数据不丢，可重试 restore）
        try {
          if (aux.upsertL1(record, undefined)) aux.archiveL1(id, "restore-compensation");
        } catch (cmpErr) {
          this.logger?.warn?.(`${TAG} [l1_archive] restore compensation failed for ${id}: ${cmpErr instanceof Error ? cmpErr.message : String(cmpErr)}`);
        }
        return false;
      }
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_archive] restore failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** T2-B：列出归档（供 UI/审计，可恢复）。委托伴生库（同一 json_extract 查询，逐字复用）。
   * SEC-1：filter 透传（租户过滤在 aux.listArchived SQL 列级实现，单源零复制）。 */
  async listArchived(limit = 100, offset = 0, filter?: IsolationFilter): Promise<Array<{ record_id: string; archived_at: string; reason: string; content: string; occurred_at?: string; team_id: string; user_id: string; agent_id: string }>> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return [];
      return aux.listArchived(limit, offset, filter);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_archive] listArchived failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── T2-C：core 表（P2-T12 全语义：租户三元组/唯一索引/valence）────────
  // 全部单值委托伴生库（sqlite.ts 同一 SQL，零第二份手写）；tenant 语义与 sqlite
  // 逐字一致（缺省 = default 桶，HTTP handler 必须显式传入）。

  async upsertCore(slot: string, content: string, source = "manual", tenant?: CoreTenant): Promise<boolean> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return false;
      return aux.upsertCore(slot, content, source, tenant);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_memory] upsertCore failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async readCore(tenant?: CoreTenant): Promise<Array<{ slot: string; content: string; source: string; version: number; updated_at: string }>> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return [];
      return aux.readCore(tenant);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_memory] readCore failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async upsertValue(valueId: string, label: string, weight: number, createdBy = "manual", tenant?: CoreTenant, valence?: number, origin: "seed" | "manual" | "auto" = "manual"): Promise<boolean> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return false;
      return aux.upsertValue(valueId, label, weight, createdBy, tenant, valence, origin);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] upsertValue failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async listValues(tenant?: CoreTenant, opts?: { includeRetired?: boolean }): Promise<Array<{ value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed" }>> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return [];
      return aux.listValues(tenant, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] listValues failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** GROW：全态读委托伴生库同源实现（自生长去重 + 种子判空专用）。 */
  async listValuesAnyState(tenant?: CoreTenant): Promise<Array<{ value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed" }>> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return [];
      return aux.listValuesAnyState(tenant);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] listValuesAnyState failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** GROW（钉住）委托伴生库同源实现。 */
  async setValuePinned(valueId: string, pinned: boolean, tenant?: CoreTenant): Promise<boolean> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return false;
      return aux.setValuePinned(valueId, pinned, tenant);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] setValuePinned failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** GROW（手动退休）委托伴生库同源实现。 */
  async retireValue(valueId: string, tenant?: CoreTenant): Promise<boolean> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return false;
      return aux.retireValue(valueId, tenant);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] retireValue failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** GROW（恢复）委托伴生库同源实现。 */
  async restoreValue(valueId: string, tenant?: CoreTenant): Promise<boolean> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return false;
      return aux.restoreValue(valueId, tenant);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] restoreValue failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * GROW：自生长调度状态读委托伴生库同源实现。
   * PA：tenant 透传（default/缺省 = aux 旧键；非 default = per-tenant 键）。
   */
  async getAnchorGrowthState(tenant?: CoreTenant): Promise<{ lastDiscoveryAt: string | null; lastCorpusCount: number | null; lastAttemptAt?: string | null; lastAdoptedAt?: string | null }> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return { lastDiscoveryAt: null, lastCorpusCount: null };
      return aux.getAnchorGrowthState(tenant);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [anchor_growth] getAnchorGrowthState failed: ${err instanceof Error ? err.message : String(err)}`);
      return { lastDiscoveryAt: null, lastCorpusCount: null };
    }
  }

  /** GROW：自生长调度状态写委托伴生库同源实现。PA：tenant 透传同读侧。 */
  async setAnchorGrowthState(state: { lastDiscoveryAt: string; lastCorpusCount: number; lastAttemptAt?: string; lastAdoptedAt?: string }, tenant?: CoreTenant): Promise<void> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return;
      aux.setAnchorGrowthState(state, tenant);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [anchor_growth] setAnchorGrowthState failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * PA：l1_records 的 distinct (team,user,agent) 三元组。tcvdb 语料在 VDB（伴生库
   * l1_records 仅 workspace 中转行），故本实现**不委托 aux**——对 VDB 做三字段轻量
   * 扫描（outputFields 只取租户三列）内存去重，与 sqlite 的 SELECT DISTINCT 同语义。
   */
  async listL1TenantTriplets(): Promise<CoreTenant[]> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];
      const docs = await this._queryAllDocs(this.l1Collection, undefined, ["team_id", "user_id", "agent_id"]);
      const seen = new Set<string>();
      const out: CoreTenant[] = [];
      for (const doc of docs) {
        const t = normalizeCoreTenant({
          teamId: String(doc.team_id ?? ""),
          userId: String(doc.user_id ?? ""),
          agentId: String(doc.agent_id ?? ""),
        });
        const key = JSON.stringify([t.teamId, t.userId, t.agentId]);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(t);
        }
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-tenant-triplets] failed (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** T2-C：LLM 批量判定 valence（C2 全语义：只判 NULL 行 + 写回守卫）。委托伴生库同源实现。 */
  async deriveValueValences(
    tenant?: CoreTenant,
    llmRunner?: { run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number }): Promise<string> },
  ): Promise<{ derived: number; skipped: number }> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return { derived: 0, skipped: 0 };
      return await aux.deriveValueValences(tenant, llmRunner);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] deriveValueValences failed: ${err instanceof Error ? err.message : String(err)}`);
      return { derived: 0, skipped: 0 };
    }
  }

  async resetValueValences(tenant?: CoreTenant): Promise<Array<{ value_id: string; valence: number }>> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return [];
      return aux.resetValueValences(tenant);
    } catch (err) {
      // S6 第 7 项（C2 fix1 复审 Low 2）：伴生库 reset SQL 失败不再静默吞成 []——
      // 透传重抛，由 handler catch → 503 明示（空快照无值可重置仍合法返回 []）。
      this.logger?.warn?.(`${TAG} [core_values] resetValueValences failed (propagating to handler): ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async restoreValueValences(tenant?: CoreTenant, snapshot?: Array<{ value_id: string; valence: number }>): Promise<number> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return 0;
      return aux.restoreValueValences(tenant, snapshot);
    } catch (err) {
      // S6 第 6 项（C2 fix1 复审 Low 1）：伴生库恢复循环事务化后失败重抛——
      // 透传（事务已在伴生库 ROLLBACK，无半态），由 handler catch → 503 明示。
      this.logger?.warn?.(`${TAG} [core_values] restoreValueValences failed (propagating to handler): ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async deleteValue(valueId: string, tenant?: CoreTenant): Promise<boolean> {
    try {
      await this._ensureInit();
      const aux = this._auxReady();
      if (!aux) return false;
      return aux.deleteValue(valueId, tenant);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] deleteValue failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ── L1 Search Operations ─────────────────────────────────

  /**
   * T1-A · score 语义刻度实证（代码级权威注释；完整证据链见 docs/tcvdb-score-semantics.md）。
   *
   * 本方法返回的 `L1SearchResult.score` 真实语义——**不是** sqlite 的 `1 - distance`
   * 相似度刻度（sqlite.ts:2408），而是按调用链分两种：
   *
   * ① hybridSearch 路径（存在 BM25 sparse 向量，:1058-1070 附近）：
   *    ann（dense，服务端 embeddingItems on "text"）+ match（sparse BM25）+
   *    rerank {method:"rrf", k:60} → score = TCVDB 服务端 RRF **融合分**，
   *    按腾讯 VDB RRF 公式（score = Σ 1/(k + rank)，rank 从 1 起）推演：
   *    双路均排第一的上限 = 2/(60+1) ≈ 0.0328，单路 1/61 ≈ 0.0164。
   *    **刻度 (0, ~0.0328]，与 sqlite 的 cosine 相似度 (0,1] 绝对不可比**。
   *
   * ② dense-only 回退（embedding 开但无 BM25，:1072-1081 附近）：
   *    /document/search（embeddingItems）→ score 为 TCVDB 稠密检索相似度，
   *    方向"越大越近"（VDB 惯例），精确刻度（cosine 相似度 vs 1-distance）无实例不可证。
   *
   * 对现有绝对门槛的影响（证据行号见 docs 文档）：
   *   - scoreThreshold（默认 0.3）：memory-search.ts:453 gatedVec 与 auto-recall.ts:804
   *     对向量候选做 `score >= threshold` 过滤 —— 任何携带 RRF 融合分的候选（≤0.0328）
   *     会被 100% 滤除（可达形态：!embeddingEnabled + BM25 的 sparse-only hybrid，
   *     nativeHybridSearch=false 时走双路回退）；
   *   - MIN_SIMILAR_STRENGTH（0.3）：l1-dedup.ts:560 `topScore < minSimilarity` 不建边
   *     —— tcvdb 向量召回的 topScore 恒 < 0.3 → similar 边静默建不出；
   *   - native-hybrid 主路径（memory-search.ts:313、auto-recall.ts:584）不做绝对门槛，
   *     score 仅展示（0.0xx 刻度）。
   *
   * **切换前须真机复验**：上述 RRF 公式与 dense score 刻度均为代码级推演
   * （无 tcvdb 实例），部署时以真实实例响应实测为准（spec §6.4 先例）。
   *
   * TCVDB uses server-side embedding — delegate to hybrid search with text
   */
  async searchL1Vector(_queryEmbedding: Float32Array, topK?: number, queryText?: string, filter?: IsolationFilter): Promise<L1SearchResult[]> {
    if (queryText) {
      return this.searchL1HybridAsync({ queryText, topK, filter });
    }
    // No queryText and TCVDB can't use client embeddings directly via embeddingItems
    // Return empty — callers should pass queryText for TCVDB
    return [];
  }

  async searchL1Fts(ftsQuery: string, limit?: number, filter?: IsolationFilter): Promise<L1FtsResult[]> {
    // TCVDB has no pure FTS — use hybrid search with sparse-only path
    // The ftsQuery is raw text, use it as queryText for hybrid
    if (!ftsQuery) return [];
    const results = await this.searchL1HybridAsync({ queryText: ftsQuery, topK: limit, filter });
    // L1SearchResult and L1FtsResult have identical shapes
    return results;
  }

  async searchL1Hybrid(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: SparseVector;
    topK?: number;
    filter?: IsolationFilter;
  }): Promise<L1SearchResult[]> {
    const queryText = params.query;
    if (!queryText) return [];
    return this.searchL1HybridAsync({ queryText, topK: params.topK, filter: params.filter });
  }

  /**
   * Async L1 hybrid search — the real implementation.
   * Call this directly from async contexts (hooks, tools).
   */
  async searchL1HybridAsync(params: {
    queryText: string;
    topK?: number;
    filter?: IsolationFilter;
  }): Promise<L1SearchResult[]> {
    const { queryText, topK = 10, filter } = params;
    if (!queryText) return [];

    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const filterExpr = joinFilter(buildIsolationConditions(filter));

      // Build search params
      const searchParams: Record<string, unknown> = {
        limit: topK,
        outputFields: L1_OUTPUT_FIELDS,
      };
      if (filterExpr) searchParams.filter = filterExpr;

      const sparse = this.bm25Encoder?.encodeQueries([queryText]) ?? [];
      const sparseVec = sparse.length > 0 && sparse[0].length > 0 ? sparse[0] : undefined;

      if (!this.embeddingEnabled) {
        if (!sparseVec) return [];
        searchParams.ann = [{ fieldName: "vector", data: [[1]], limit: topK }];
        searchParams.match = [{
          fieldName: "sparse_vector",
          data: [sparseVec],
          limit: topK,
        }];
        searchParams.rerank = { method: "rrf", k: 60 };
        const resp = await this.client.hybridSearch(this.l1Collection, searchParams);
        return this._parseL1SearchResults(resp.documents);
      }

      // ann: use embedding field name "text" for server-side embedding
      // (per SDK: AnnSearch(field_name="text", data='query string'))
      const ann = [{
        fieldName: "text",
        data: [queryText], // embeddingItems — server-side embedding
        limit: topK,
      }];

      if (sparseVec) {
        // Full hybrid: dense + sparse + RRF
        searchParams.ann = ann;
        searchParams.match = [{
          fieldName: "sparse_vector",
          data: [sparseVec], // hybridSearch wraps single sparse vector in array
          limit: topK,
        }];
        searchParams.rerank = { method: "rrf", k: 60 };

        const resp = await this.client.hybridSearch(this.l1Collection, searchParams);
        return this._parseL1SearchResults(resp.documents);
      }

      // Dense-only fallback (BM25 unavailable) — use /document/search with embeddingItems
      const denseSearch: Record<string, unknown> = {
        embeddingItems: [queryText],
        limit: topK,
        retrieveVector: false,
        outputFields: L1_OUTPUT_FIELDS,
      };
      if (filterExpr) denseSearch.filter = filterExpr;
      const resp = await this.client.search(this.l1Collection, denseSearch);
      return this._parseL1SearchResults(resp.documents);
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-hybridSearch] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── L0 Write Operations ──────────────────────────────────

  async upsertL0(record: L0Record, _embedding?: Float32Array): Promise<boolean> {
    try {
      await this._upsertL0Async(record);
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-upsert] FAILED id=${record.id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async _upsertL0Async(record: L0Record): Promise<void> {
    await this._ensureInit();
    if (this.degraded) return;

    const doc: Record<string, unknown> = {
      id: record.id,
      message_text: record.messageText,
      team_id: record.teamId ?? "",
      user_id: record.userId || DEFAULT_ISOLATION_ID,
      agent_id: record.agentId || DEFAULT_ISOLATION_ID,
      session_key: record.sessionKey,
      session_id: record.sessionId || DEFAULT_ISOLATION_ID,
      task_id: record.taskId ?? "",
      role: record.role,
      recorded_at_ms: isoToEpochMs(record.recordedAt),
      timestamp: record.timestamp,
    };
    if (!this.embeddingEnabled) doc.vector = [1];

    if (this.bm25Encoder) {
      const sparse = this.bm25Encoder.encodeTexts([record.messageText]);
      if (sparse.length > 0 && sparse[0].length > 0) {
        doc.sparse_vector = sparse[0];
      }
    }

    await this.client.upsert(this.l0Collection, [doc]);
  }

  /**
   * Batch upsert multiple L0 records in a single API call.
   * Used by migration scripts to reduce request count.
   */
  async upsertL0Batch(records: L0Record[]): Promise<number> {
    if (records.length === 0) return 0;
    try {
      await this._ensureInit();
      if (this.degraded) return 0;

      const docs = records.map((record) => {
        const doc: Record<string, unknown> = {
          id: record.id,
          message_text: record.messageText,
          team_id: record.teamId ?? "",
          user_id: record.userId || DEFAULT_ISOLATION_ID,
          agent_id: record.agentId || DEFAULT_ISOLATION_ID,
          session_key: record.sessionKey,
          session_id: record.sessionId || DEFAULT_ISOLATION_ID,
          task_id: record.taskId ?? "",
          role: record.role,
          recorded_at_ms: isoToEpochMs(record.recordedAt),
          timestamp: record.timestamp,
        };
        if (!this.embeddingEnabled) doc.vector = [1];

        if (this.bm25Encoder) {
          const sparse = this.bm25Encoder.encodeTexts([record.messageText]);
          if (sparse.length > 0 && sparse[0].length > 0) {
            doc.sparse_vector = sparse[0];
          }
        }
        return doc;
      });

      await this.client.upsert(this.l0Collection, docs);
      return records.length;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-upsertBatch] FAILED (${records.length} records): ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async deleteL0(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    try {
      await this._ensureInit();
      if (this.degraded) return false;
      const filterExpr = joinFilter(buildIsolationConditions(filter));
      const query: Record<string, unknown> = { documentIds: [recordId] };
      if (filterExpr) query.filter = filterExpr;
      const affected = await this.client.deleteDoc(this.l0Collection, {
        query,
      });
      return affected > 0;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-delete] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async deleteL0Expired(cutoffIso: string): Promise<number> {
    const cutoffMs = isoToEpochMs(cutoffIso);
    if (cutoffMs <= 0) return 0;
    try {
      await this._ensureInit();
      if (this.degraded) return 0;

      const filter = `recorded_at_ms < ${cutoffMs}`;
      const toDelete = await this.client.count(this.l0Collection, filter);
      if (toDelete === 0) return 0;

      const total = await this.client.count(this.l0Collection);
      const ratio = total > 0 ? toDelete / total : 0;

      if (ratio > 0.8) {
        this.logger?.warn(
          `${TAG} [L0-deleteExpired] BLOCKED: would delete ${toDelete}/${total} ` +
          `(${(ratio * 100).toFixed(1)}%) — exceeds 80% safety threshold, cutoff=${cutoffIso}`,
        );
        return 0;
      }

      await this.client.deleteDoc(this.l0Collection, {
        query: { filter },
      });
      this.logger?.info?.(
        `${TAG} [L0-deleteExpired] Deleted ~${toDelete}/${total} records (cutoff=${cutoffIso})`,
      );
      return toDelete;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-deleteExpired] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  // ── L0 Read Operations ───────────────────────────────────

  async countL0(filter?: L0CountFilter): Promise<number> {
    try {
      await this._ensureInit();
      if (this.degraded) return 0;
      const conditions: string[] = [];
      if (filter?.sessionId) {
        const sid = escapeFilterString(filter.sessionId);
        conditions.push(`(session_key = "${sid}" or session_id = "${sid}")`);
      }
      conditions.push(...buildIsolationConditions({
        teamId: filter?.teamId,
        userId: filter?.userId,
        agentId: filter?.agentId,
        taskId: filter?.taskId,
      }));
      if (filter?.timeStartMs !== undefined) {
        conditions.push(`recorded_at_ms >= ${filter.timeStartMs}`);
      }
      if (filter?.timeEndMs !== undefined) {
        conditions.push(`recorded_at_ms <= ${filter.timeEndMs}`);
      }
      return await this.client.count(this.l0Collection, joinFilter(conditions));
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-count] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0QueryRow[]> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const conditions: string[] = [eqFilter("session_key", sessionKey)];
      if (afterRecordedAtMs && afterRecordedAtMs > 0) {
        conditions.push(`recorded_at_ms > ${afterRecordedAtMs}`);
      }
      const filterExpr = conditions.join(" and ");

      // Query oldest-first (ASC) — preserves backlog ordering so callers that
      // advance a recorded_at cursor never skip older rows. See sqlite.ts
      // queryL0ForL1 for the full rationale.
      const docs = await this._queryAllDocs(
        this.l0Collection,
        filterExpr,
        L0_OUTPUT_FIELDS,
        limit,
        [{ fieldName: "recorded_at_ms", direction: "asc" }],
      );

      const rows: L0QueryRow[] = docs.map((doc) => ({
        record_id: String(doc.id ?? ""),
        session_key: String(doc.session_key ?? ""),
        // Normalize legacy/imported empty values at the Service L0 read boundary
        // so grouping, L1 writes, and L2 queries share one session identity.
        session_id: String(doc.session_id ?? "").trim() || DEFAULT_ISOLATION_ID,
        team_id: String(doc.team_id ?? ""),
        task_id: String(doc.task_id ?? ""),
        user_id: String(doc.user_id ?? ""),
        agent_id: String(doc.agent_id ?? ""),
        role: String(doc.role ?? ""),
        message_text: String(doc.message_text ?? ""),
        recorded_at: epochMsToIso(Number(doc.recorded_at_ms ?? 0)),
        timestamp: Number(doc.timestamp ?? 0),
      }));

      return rows;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-queryForL1] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async queryL0GroupedBySessionId(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0SessionGroup[]> {
    try {
      const rows = await this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit);

      // Group by full isolation tuple + session_id to avoid cross-tenant merging.
      // 注意：必须把 teamId / taskId 带进 group。L2 scope (team:T|agent:A) 依赖
      // L1 record 的 teamId 正确透传；缺失会退化到 team:${userId}|... 写错位。
      const groupMap = new Map<string, L0SessionGroup>();
      for (const row of rows) {
        const sid = row.session_id || DEFAULT_ISOLATION_ID;
        const teamId = row.team_id || "";
        const userId = row.user_id || "";
        const agentId = row.agent_id || "";
        const taskId = row.task_id || "";
        const groupKey = `${teamId}\u0000${userId}\u0000${agentId}\u0000${taskId}\u0000${sid}`;
        let group = groupMap.get(groupKey);
        if (!group) {
          group = { sessionId: sid, teamId, userId, agentId, taskId, messages: [] };
          groupMap.set(groupKey, group);
        }
        group.messages.push({
          id: row.record_id,
          role: row.role,
          content: row.message_text,
          timestamp: row.timestamp,
          recordedAtMs: row.recorded_at ? Date.parse(row.recorded_at) || 0 : 0,
        });
      }

      // Convert to array, sorted by earliest message timestamp
      const groups: L0SessionGroup[] = [];
      for (const group of groupMap.values()) {
        if (group.messages.length > 0) {
          groups.push(group);
        }
      }
      groups.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);

      return groups;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-queryGrouped] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async getAllL0Texts(): Promise<Array<{ record_id: string; message_text: string; recorded_at: string }>> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const docs = await this._queryAllDocs(
        this.l0Collection,
        undefined,
        ["id", "message_text", "recorded_at_ms"],
      );

      return docs.map((doc) => ({
        record_id: String(doc.id ?? ""),
        message_text: String(doc.message_text ?? ""),
        recorded_at: epochMsToIso(Number(doc.recorded_at_ms ?? 0)),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-getAllTexts] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── L0 Search Operations ─────────────────────────────────

  async searchL0Vector(_queryEmbedding: Float32Array, topK?: number, queryText?: string, filter?: IsolationFilter): Promise<L0SearchResult[]> {
    // TCVDB uses server-side embedding — delegate to hybrid search with text
    if (queryText) {
      return this.searchL0HybridAsync({ queryText, topK, filter });
    }
    return [];
  }

  async searchL0Fts(ftsQuery: string, limit?: number, filter?: IsolationFilter): Promise<L0FtsResult[]> {
    if (!ftsQuery) return [];
    // Use hybrid search; L0SearchResult and L0FtsResult have identical shapes
    return this.searchL0HybridAsync({ queryText: ftsQuery, topK: limit, filter });
  }

  async searchL0Hybrid(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: SparseVector;
    topK?: number;
    filter?: IsolationFilter;
  }): Promise<L0SearchResult[]> {
    const queryText = params.query;
    if (!queryText) return [];
    return this.searchL0HybridAsync({ queryText, topK: params.topK, filter: params.filter });
  }

  /**
   * Async L0 hybrid search.
   */
  async searchL0HybridAsync(params: {
    queryText: string;
    topK?: number;
    filter?: IsolationFilter;
  }): Promise<L0SearchResult[]> {
    const { queryText, topK = 10, filter } = params;
    if (!queryText) return [];

    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const filterExpr = joinFilter(buildIsolationConditions(filter));

      const searchParams: Record<string, unknown> = {
        limit: topK,
        outputFields: L0_OUTPUT_FIELDS,
      };
      if (filterExpr) searchParams.filter = filterExpr;

      const sparse = this.bm25Encoder?.encodeQueries([queryText]) ?? [];
      const sparseVec = sparse.length > 0 && sparse[0].length > 0 ? sparse[0] : undefined;

      if (!this.embeddingEnabled) {
        if (!sparseVec) return [];
        searchParams.ann = [{ fieldName: "vector", data: [[1]], limit: topK }];
        searchParams.match = [{
          fieldName: "sparse_vector",
          data: [sparseVec],
          limit: topK,
        }];
        searchParams.rerank = { method: "rrf", k: 60 };
        const resp = await this.client.hybridSearch(this.l0Collection, searchParams);
        return this._parseL0SearchResults(resp.documents);
      }

      // ann: use embedding field name "message_text" for L0 server-side embedding
      const ann = [{
        fieldName: "message_text",
        data: [queryText],
        limit: topK,
      }];

      if (sparseVec) {
        searchParams.ann = ann;
        searchParams.match = [{
          fieldName: "sparse_vector",
          data: [sparseVec],
          limit: topK,
        }];
        searchParams.rerank = { method: "rrf", k: 60 };
        const resp = await this.client.hybridSearch(this.l0Collection, searchParams);
        return this._parseL0SearchResults(resp.documents);
      }

      const denseSearch: Record<string, unknown> = {
        embeddingItems: [queryText],
        limit: topK,
        retrieveVector: false,
        outputFields: L0_OUTPUT_FIELDS,
      };
      if (filterExpr) denseSearch.filter = filterExpr;
      const resp = await this.client.search(this.l0Collection, denseSearch);
      return this._parseL0SearchResults(resp.documents);
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-hybridSearch] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async pullProfiles(): Promise<ProfileRecord[]> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const docs = await this._queryAllDocs(
        this.profilesCollection,
        undefined,
        PROFILE_OUTPUT_FIELDS,
      );

      return docs.map((doc) => ({
        id: String(doc.id ?? ""),
        type: doc.type === "l3" ? "l3" : "l2",
        filename: String(doc.filename ?? ""),
        content: String(doc.content ?? ""),
        contentMd5: String(doc.content_md5 ?? ""),
        teamId: String(doc.team_id ?? "") || undefined,
        agentId: String(doc.agent_id ?? "") || undefined,
        userId: String(doc.user_id ?? "") || undefined,
        sessionId: undefined,
        version: Number(doc.version ?? 0),
        createdAtMs: Number(doc.created_at_ms ?? 0),
        updatedAtMs: Number(doc.updated_at_ms ?? 0),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-pull] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async queryProfilesByIds(ids: string[]): Promise<ProfileRecord[]> {
    if (ids.length === 0) return [];
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const resp = await this.client.query(this.profilesCollection, {
        retrieveVector: false,
        documentIds: ids,
        outputFields: PROFILE_OUTPUT_FIELDS,
        limit: ids.length,
      });
      const docs = resp.documents ?? [];
      return docs.map((doc) => ({
        id: String(doc.id ?? ""),
        type: doc.type === "l3" ? "l3" : "l2",
        filename: String(doc.filename ?? ""),
        content: String(doc.content ?? ""),
        contentMd5: String(doc.content_md5 ?? ""),
        teamId: String(doc.team_id ?? "") || undefined,
        agentId: String(doc.agent_id ?? "") || undefined,
        userId: String(doc.user_id ?? "") || undefined,
        sessionId: undefined,
        version: Number(doc.version ?? 0),
        createdAtMs: Number(doc.created_at_ms ?? 0),
        updatedAtMs: Number(doc.updated_at_ms ?? 0),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-query-by-ids] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async countProfiles(filter?: ProfileCountFilter): Promise<number> {
    try {
      await this._ensureInit();
      if (this.degraded) return 0;
      const conditions: string[] = [];
      if (filter?.type) conditions.push(eqFilter("type", filter.type));
      if (filter?.teamId !== undefined) conditions.push(eqFilter("team_id", filter.teamId));
      if (filter?.userId !== undefined) conditions.push(eqFilter("user_id", filter.userId));
      if (filter?.agentId !== undefined) conditions.push(eqFilter("agent_id", filter.agentId));
      const filterExpr = joinFilter(conditions);

      if (filter?.pathPrefix) {
        const docs = await this._queryAllDocs(
          this.profilesCollection,
          filterExpr,
          ["id", "filename"],
        );
        return docs.filter((doc) => String(doc.filename ?? "").startsWith(filter.pathPrefix!)).length;
      }

      return await this.client.count(this.profilesCollection, filterExpr);
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-count] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async syncProfiles(records: ProfileSyncRecord[]): Promise<void> {
    if (records.length === 0) return;

    try {
      await this._ensureInit();
      if (this.degraded) return;

      const ids = [...new Set(records.map((record) => record.id).filter(Boolean))];
      const remoteResp = ids.length > 0
        ? await this.client.query(this.profilesCollection, {
          retrieveVector: false,
          documentIds: ids,
          outputFields: PROFILE_METADATA_OUTPUT_FIELDS,
          limit: ids.length,
        })
        : { documents: [] };
      const remoteMap = new Map(
        (remoteResp.documents ?? []).map((doc) => [String(doc.id ?? ""), doc] as const),
      );
      const now = Date.now();
      const upserts: Array<Record<string, unknown>> = [];

      for (const record of records) {
        const current = remoteMap.get(record.id);
        if (!current) {
          const createdAtMs = record.createdAtMs > 0 ? record.createdAtMs : now;
          upserts.push({
            id: record.id,
            vector: [0],
            type: record.type,
            filename: record.filename,
            content: record.content,
            content_md5: record.contentMd5,
            team_id: record.teamId ?? "",
            user_id: record.userId ?? "",
            agent_id: record.agentId ?? "",
            version: record.version ?? 0,
            created_at_ms: createdAtMs,
            updated_at_ms: now,
            memory_type: DEFAULT_MEMORY_TYPE,
          });
          continue;
        }

        const currentMd5 = String(current.content_md5 ?? "");
        const currentVersion = Number(current.version ?? 0);
        const currentCreatedAtMs = Number(current.created_at_ms ?? 0) || now;

        if (currentMd5 === record.contentMd5) {
          continue;
        }

        if ((record.baselineVersion ?? 0) !== currentVersion) {
          this.logger?.warn(
            `${TAG} [profiles-sync] Conflict for ${record.filename}: remote version advanced from ${record.baselineVersion ?? 0} to ${currentVersion}, skipping sync`,
          );
          continue;
        }

        upserts.push({
          id: record.id,
          vector: [0],
          type: record.type,
          filename: record.filename,
          content: record.content,
          content_md5: record.contentMd5,
          team_id: record.teamId ?? "",
          user_id: record.userId ?? "",
          agent_id: record.agentId ?? "",
          version: currentVersion + 1,
          created_at_ms: currentCreatedAtMs,
          updated_at_ms: now,
          memory_type: DEFAULT_MEMORY_TYPE,
        });
      }

      if (upserts.length > 0) {
        await this.client.upsert(this.profilesCollection, upserts);
      }
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-sync] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async deleteProfiles(recordIds: string[]): Promise<void> {
    if (recordIds.length === 0) return;

    try {
      await this._ensureInit();
      if (this.degraded) return;
      await this.client.deleteDoc(this.profilesCollection, {
        query: { documentIds: recordIds },
      });
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-delete] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Knowledge entity (wiki / code-graph metadata) ─────────
  //
  // 明细注册表：Proxy 按 knowledge_id 联查渲染。类型专属字段（repo_url/branch…）
  // 收进 JSON 类型字段 metadata（见 docs/design/vdb-knowledge-collection.md）。

  private _knowledgeToDoc(e: Omit<KnowledgeEntity, "created_at" | "updated_at">, createdAtMs: number, updatedAtMs: number): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    if (e.repo_url !== undefined) metadata.repo_url = e.repo_url;
    if (e.branch !== undefined) metadata.branch = e.branch;
    return {
      id: e.knowledge_id,
      vector: [0],
      type: e.type,
      team_id: e.team_id,
      agent_id: e.agent_id ?? "",
      name: e.name,
      user_id: e.user_id ?? "",
      service_url: e.service_url,
      summary: e.summary ?? "",
      metadata,
      created_at_ms: createdAtMs,
      updated_at_ms: updatedAtMs,
    };
  }

  private _docToKnowledge(doc: Record<string, unknown>): KnowledgeEntity {
    const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
    const repoUrl = metadata.repo_url !== undefined ? String(metadata.repo_url) : undefined;
    const branch = metadata.branch !== undefined ? String(metadata.branch) : undefined;
    return {
      knowledge_id: String(doc.id ?? ""),
      type: (doc.type as KnowledgeType) ?? "wiki",
      service_url: String(doc.service_url ?? ""),
      name: String(doc.name ?? ""),
      summary: doc.summary ? String(doc.summary) : null,
      team_id: String(doc.team_id ?? ""),
      agent_id: String(doc.agent_id ?? ""),
      user_id: doc.user_id ? String(doc.user_id) : null,
      repo_url: repoUrl,
      branch,
      created_at: epochMsToIso(Number(doc.created_at_ms ?? 0)),
      updated_at: epochMsToIso(Number(doc.updated_at_ms ?? 0)),
    };
  }

  async createKnowledge(input: Omit<KnowledgeEntity, "created_at" | "updated_at">): Promise<KnowledgeEntity> {
    await this._ensureInit();
    if (this.degraded) throw new Error("tcvdb store degraded");
    // upsert：保留已有 created_at_ms
    let createdAtMs = Date.now();
    try {
      const existing = await this.client.query(this.knowledgeCollection, {
        retrieveVector: false, documentIds: [input.knowledge_id],
        outputFields: ["id", "created_at_ms"], limit: 1,
      });
      const prev = existing.documents?.[0];
      if (prev?.created_at_ms) createdAtMs = Number(prev.created_at_ms);
    } catch { /* 视为新建 */ }
    const now = Date.now();
    const doc = this._knowledgeToDoc(input, createdAtMs, now);
    await this.client.upsert(this.knowledgeCollection, [doc]);
    return this._docToKnowledge(doc);
  }

  async getKnowledge(knowledgeId: string): Promise<KnowledgeEntity | null> {
    await this._ensureInit();
    if (this.degraded) return null;
    const resp = await this.client.query(this.knowledgeCollection, {
      retrieveVector: false, documentIds: [knowledgeId],
      outputFields: KNOWLEDGE_OUTPUT_FIELDS, limit: 1,
    });
    const doc = resp.documents?.[0];
    return doc ? this._docToKnowledge(doc) : null;
  }

  async updateKnowledge(
    knowledgeId: string,
    patch: Partial<Pick<KnowledgeEntity, "name" | "summary" | "service_url" | "repo_url" | "branch">>,
  ): Promise<KnowledgeEntity | null> {
    const current = await this.getKnowledge(knowledgeId);
    if (!current) return null;
    const merged: Omit<KnowledgeEntity, "created_at" | "updated_at"> = {
      knowledge_id: current.knowledge_id,
      type: current.type,
      service_url: patch.service_url ?? current.service_url,
      name: patch.name ?? current.name,
      summary: patch.summary !== undefined ? patch.summary : current.summary,
      team_id: current.team_id,
      agent_id: current.agent_id ?? "",
      user_id: current.user_id,
      repo_url: patch.repo_url !== undefined ? patch.repo_url : current.repo_url,
      branch: patch.branch !== undefined ? patch.branch : current.branch,
    };
    return this.createKnowledge(merged);
  }

  async deleteKnowledge(knowledgeIds: string[], teamId?: string): Promise<BatchDeleteResult> {
    await this._ensureInit();
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    if (this.degraded) {
      for (const id of knowledgeIds) result.failed.push({ id, reason: "degraded" });
      return result;
    }
    for (const id of knowledgeIds) {
      const row = await this.getKnowledge(id);
      if (!row) { result.failed.push({ id, reason: "not_found" }); continue; }
      if (teamId && row.team_id !== teamId) { result.failed.push({ id, reason: "team_mismatch" }); continue; }
      await this.client.deleteDoc(this.knowledgeCollection, { query: { documentIds: [id] } });
      result.deleted_ids.push(id);
    }
    return result;
  }

  async listKnowledge(input: { team_id: string; type?: KnowledgeType; knowledge_ids?: string[]; limit?: number; offset?: number }): Promise<KnowledgeListResult> {
    await this._ensureInit();
    if (this.degraded) return { items: [], total: 0 };
    if (input.knowledge_ids && input.knowledge_ids.length === 0) return { items: [], total: 0 };

    if (input.knowledge_ids && input.knowledge_ids.length > 0) {
      // TCVDB primary key `id` is not a normal filter field in /document/query;
      // filtering with `id in (...)` fails with "Field Not Found:id".
      // Use documentIds for primary-key lookup, then apply team/type guards in memory
      // to preserve tenant isolation and optional type filtering.
      const resp = await this.client.query(this.knowledgeCollection, {
        retrieveVector: false,
        documentIds: input.knowledge_ids,
        outputFields: KNOWLEDGE_OUTPUT_FIELDS,
        limit: input.knowledge_ids.length,
      });
      const items = (resp.documents ?? [])
        .map((d) => this._docToKnowledge(d))
        .filter((item) => item.team_id === input.team_id)
        .filter((item) => !input.type || item.type === input.type);
      return { items, total: items.length };
    }

    const parts = [`team_id = "${escapeFilterString(input.team_id)}"`];
    if (input.type) parts.push(`type = "${escapeFilterString(input.type)}"`);
    const filter = parts.join(" and ");

    const docs = await this._queryAllDocs(
      this.knowledgeCollection,
      filter,
      KNOWLEDGE_OUTPUT_FIELDS,
      input.limit,
      [{ fieldName: "updated_at_ms", direction: "desc" }],
    );
    let items = docs.map((d) => this._docToKnowledge(d));
    // 分页（_queryAllDocs 不含 offset 语义时在此裁剪）
    const offset = Math.max(input.offset ?? 0, 0);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 1000);
    const total = items.length;
    items = items.slice(offset, offset + limit);
    return { items, total };
  }

  // ── Re-index ─────────────────────────────────────────────

  async reindexAll(
    _embedFn: (text: string) => Promise<Float32Array>,
    _onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }> {
    // TCVDB uses server-side embedding — reindex means rebuild Collection.
    // Not implemented in Phase 2-3 (requires drop + recreate + re-upsert from JSONL).
    this.logger?.info(`${TAG} reindexAll: TCVDB uses server-side embedding, skipping`);
    return { l1Count: 0, l0Count: 0 };
  }

  isFtsAvailable(): boolean {
    return !!this.bm25Encoder;
  }

  // ── v2 API: Paginated queries ─────────────────────────────

  async queryL0Paginated(filter: L0PaginatedFilter): Promise<L0PaginatedResult> {
    await this._ensureInit();
    if (this.degraded) return { rows: [], total: 0 };

    try {
      const conditions: string[] = [];
      if (filter.sessionId) {
        const sid = escapeFilterString(filter.sessionId);
        conditions.push(`(session_key = "${sid}" or session_id = "${sid}")`);
      }
      conditions.push(...buildIsolationConditions({
        teamId: filter.teamId,
        userId: filter.userId,
        agentId: filter.agentId,
        taskId: filter.taskId,
      }));
      if (filter.timeStartMs !== undefined) {
        conditions.push(`recorded_at_ms >= ${filter.timeStartMs}`);
      }
      if (filter.timeEndMs !== undefined) {
        conditions.push(`recorded_at_ms <= ${filter.timeEndMs}`);
      }
      const filterExpr = joinFilter(conditions);

      // Get total count
      const total = await this.client.count(this.l0Collection, filterExpr);

      // Get page
      const resp = await this.client.query(this.l0Collection, {
        retrieveVector: false,
        limit: filter.limit,
        offset: filter.offset,
        filter: filterExpr,
        outputFields: L0_OUTPUT_FIELDS,
        sort: [{ fieldName: "recorded_at_ms", direction: "desc" }],
      });
      const docs = resp.documents ?? [];

      const rows: L0QueryRow[] = docs.map((d: any) => ({
        record_id: d.id,
        session_key: d.session_key ?? "",
        session_id: d.session_id ?? "",
        team_id: d.team_id ?? "",
        task_id: d.task_id ?? "",
        user_id: d.user_id ?? "",
        agent_id: d.agent_id ?? "",
        role: d.role ?? "",
        message_text: d.message_text ?? "",
        recorded_at: d.recorded_at_ms ? new Date(d.recorded_at_ms).toISOString() : "",
        timestamp: d.timestamp ?? d.recorded_at_ms ?? 0,
      }));

      return { rows, total };
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-queryPaginated] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return { rows: [], total: 0 };
    }
  }

  async queryL1Paginated(filter: L1PaginatedFilter): Promise<L1PaginatedResult> {
    await this._ensureInit();
    if (this.degraded) return { rows: [], total: 0 };

    try {
      const conditions: string[] = [];
      if (filter.type) {
        conditions.push(eqFilter("type", filter.type));
      }
      conditions.push(...buildIsolationConditions({
        teamId: filter.teamId,
        userId: filter.userId,
        agentId: filter.agentId,
        sessionId: filter.sessionId,
        taskId: filter.taskId,
      }));
      if (filter.timeStart) {
        const ms = new Date(filter.timeStart).getTime();
        conditions.push(`updated_time_ms >= ${ms}`);
      }
      if (filter.timeEnd) {
        const ms = new Date(filter.timeEnd).getTime();
        conditions.push(`updated_time_ms <= ${ms}`);
      }
      const filterExpr = joinFilter(conditions);

      // Get total count
      const total = await this.client.count(this.l1Collection, filterExpr);

      // Get page
      const resp = await this.client.query(this.l1Collection, {
        retrieveVector: false,
        limit: filter.limit,
        offset: filter.offset,
        filter: filterExpr,
        outputFields: L1_OUTPUT_FIELDS,
        sort: [{ fieldName: "updated_time_ms", direction: "desc" }],
      });
      const docs = resp.documents ?? [];

      const rows: L1RecordRow[] = docs.map((d: any) => ({
        record_id: d.id,
        content: d.text ?? "",
        type: d.type ?? "",
        priority: d.priority ?? 50,
        scene_name: d.scene_name ?? "",
        session_key: d.session_key ?? "",
        session_id: d.session_id ?? "",
        team_id: d.team_id ?? "",
        task_id: d.task_id ?? "",
        user_id: d.user_id ?? "",
        agent_id: d.agent_id ?? "",
        version: Number(d.version ?? 0),
        timestamp_str: d.timestamp_str ?? "",
        timestamp_start: d.timestamp_start ?? "",
        timestamp_end: d.timestamp_end ?? "",
        created_time: d.created_time_ms ? new Date(d.created_time_ms).toISOString() : "",
        updated_time: d.updated_time_ms ? new Date(d.updated_time_ms).toISOString() : "",
        metadata_json: d.metadata_json ?? "{}",
      }));

      return { rows, total };
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-queryPaginated] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return { rows: [], total: 0 };
    }
  }

  async deleteL0BySession(sessionId: string, filter?: IsolationFilter): Promise<number> {
    // 空 sessionId 会生成 `(session_key = "" or session_id = "")` —— 这是个
    // **合法非空** filter，会把所有 session 字段为空的历史/legacy 记录删掉。
    // 空 session 不是有效的删除目标，直接拒绝，不能靠下游护栏兜。
    const sessionIdTrimmed = (sessionId ?? "").trim();
    if (!sessionIdTrimmed) {
      throw new Error("[tcvdb] deleteL0BySession requires a non-empty sessionId");
    }

    await this._ensureInit();
    if (this.degraded) return 0;
    try {
      const sid = escapeFilterString(sessionIdTrimmed);
      const conditions = [`(session_key = "${sid}" or session_id = "${sid}")`, ...buildIsolationConditions(filter)];
      const filterExpr = joinFilter(conditions);
      // 护栏：filter 为空会删掉整个 collection。这里 session 条件恒存在，
      // 但仍显式断言，防止将来重构改坏条件拼装。
      assertDeleteFilterSafe(filterExpr, "deleteL0BySession", []);
      const affected = await this.client.deleteDoc(this.l0Collection, {
        query: { filter: filterExpr },
      });
      return affected;
    } catch (err) {
      this.logger?.warn(`[tcvdb] deleteL0BySession failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /**
   * 清空某个 (team, agent) 下的全部记忆内容：L0 + L1 + L2/L3 profile 行。
   * 向量与 sparse_vector 随文档一起删除，无需单独清理。
   *
   * 不触碰 meta_* 资产表：asset_id、Owner、绑定、ACL、可见性、名称全部保留。
   * 幂等：已清空的 memory 再次调用返回全 0。
   *
   * 失败语义：任一层删除失败直接抛出，由调用方标记该 memory 清空失败，
   * 避免"部分删除但报告成功"。
   */
  async clearMemoryContent(filter: MemoryContentClearFilter): Promise<MemoryContentClearResult> {
    const teamId = (filter?.teamId ?? "").trim();
    const agentId = (filter?.agentId ?? "").trim();
    if (!teamId || !agentId) {
      throw new Error("clearMemoryContent requires non-empty teamId and agentId");
    }
    const userId = filter.userId?.trim() || undefined;

    await this._ensureInit();
    if (this.degraded) return { l0Deleted: 0, l1Deleted: 0, profilesDeleted: 0 };

    // L0/L1 按 (team, agent[, user]) 过滤；不带 session 维度，覆盖该 agent 全部会话。
    const contentFilter = joinFilter(buildIsolationConditions({
      teamId,
      agentId,
      ...(userId ? { userId } : {}),
    }));
    // profiles(L2/L3) 是 team+agent 粒度（见 buildProfileIsolationScope），
    // 不按 user 收窄，否则会漏删 user_id 为空的历史 profile 行。
    const profileFilter = joinFilter([eqFilter("team_id", teamId), eqFilter("agent_id", agentId)]);

    // ⚠️ 最后一道护栏：filter 为空时VDB /document/delete 会删掉**整个
    // collection**。上面的 teamId/agentId 非空校验已能保证 filter 非空，
    // 但那是"间接"保证（依赖 buildIsolationConditions 的实现细节）。
    // 破坏性操作不能依赖间接推导，这里直接断言，任何将来的重构把
    // filter 弄空都会在发请求前炸掉，而不是静默清库。
    assertDeleteFilterSafe(contentFilter, "clearMemoryContent/content", ["team_id", "agent_id"]);
    assertDeleteFilterSafe(profileFilter, "clearMemoryContent/profiles", ["team_id", "agent_id"]);

    const l0Deleted = await this.client.deleteDoc(this.l0Collection, { query: { filter: contentFilter } });
    const l1Deleted = await this.client.deleteDoc(this.l1Collection, { query: { filter: contentFilter } });
    const profilesDeleted = await this.client.deleteDoc(this.profilesCollection, { query: { filter: profileFilter } });

    return { l0Deleted, l1Deleted, profilesDeleted };
  }

  // ── Internal: parse search results ───────────────────────

  private _parseL1SearchResults(docArrays: Array<Array<Record<string, unknown>>>): L1SearchResult[] {
    const results: L1SearchResult[] = [];
    // hybridSearch/search returns [[doc, doc, ...]] (one array per query)
    const docs = docArrays?.[0] ?? [];
    for (const doc of docs) {
      results.push({
        record_id: String(doc.id ?? ""),
        content: String(doc.text ?? ""),
        type: String(doc.type ?? ""),
        priority: Number(doc.priority ?? 0),
        scene_name: String(doc.scene_name ?? ""),
        score: Number(doc.score ?? 0),
        timestamp_str: String(doc.timestamp_str ?? ""),
        timestamp_start: String(doc.timestamp_start ?? ""),
        timestamp_end: String(doc.timestamp_end ?? ""),
        session_key: String(doc.session_key ?? ""),
        session_id: String(doc.session_id ?? ""),
        team_id: String(doc.team_id ?? ""),
        task_id: String(doc.task_id ?? ""),
        user_id: String(doc.user_id ?? ""),
        agent_id: String(doc.agent_id ?? ""),
        version: Number(doc.version ?? 0),
        metadata_json: String(doc.metadata_json ?? "{}"),
        occurred_at: doc.occurred_at ? String(doc.occurred_at) : undefined,
        valid_start: doc.valid_start ? String(doc.valid_start) : undefined,
        valid_end: doc.valid_end ? String(doc.valid_end) : undefined,
        certainty: doc.certainty ? String(doc.certainty) : undefined,
        source: doc.source ? String(doc.source) : undefined,
        valence: doc.valence != null ? Number(doc.valence) : undefined,
        arousal: doc.arousal != null ? Number(doc.arousal) : undefined,
        significance: doc.significance != null ? Number(doc.significance) : undefined,
      });
    }
    return results;
  }

  private _parseL0SearchResults(docArrays: Array<Array<Record<string, unknown>>>): L0SearchResult[] {
    const results: L0SearchResult[] = [];
    const docs = docArrays?.[0] ?? [];
    for (const doc of docs) {
      results.push({
        record_id: String(doc.id ?? ""),
        session_key: String(doc.session_key ?? ""),
        session_id: String(doc.session_id ?? ""),
        team_id: String(doc.team_id ?? ""),
        task_id: String(doc.task_id ?? ""),
        user_id: String(doc.user_id ?? ""),
        agent_id: String(doc.agent_id ?? ""),
        role: String(doc.role ?? ""),
        message_text: String(doc.message_text ?? ""),
        score: Number(doc.score ?? 0),
        recorded_at: epochMsToIso(Number(doc.recorded_at_ms ?? 0)),
        timestamp: Number(doc.timestamp ?? 0),
      });
    }
    return results;
  }

  // ─────────────────────────────────────────────────────────
  // Memory Generation Provenance References
  // ─────────────────────────────────────────────────────────

  async upsertMemoryGenerationRefs(records: MemoryGenerationRefRecord[]): Promise<void> {
    await this._ensureInit();
    for (let offset = 0; offset < records.length; offset += 100) {
      await this.client.upsert(this.memoryGenerationRefsCollection, records.slice(offset, offset + 100).map((record) => ({
        id: record.generation_ref_id,
        vector: [0],
        layer: record.layer,
        memory_id: record.memory_id,
        generation_id: record.generation_id,
        generation_log_id: record.generation_log_id,
        generation_log_key: record.generation_log_key,
        memory_prompt_id: record.memory_prompt_id,
        memory_prompt_version: record.memory_prompt_version,
        memory_prompt_source: record.memory_prompt_source,
        created_at_ms: record.created_at_ms,
      })));
    }
  }

  async getMemoryGenerationRef(layer: MemoryGenerationLayer, memoryId: string): Promise<MemoryGenerationRefRecord | null> {
    await this._ensureInit();
    const id = buildMemoryGenerationRefId(layer, memoryId);
    const resp = await this.client.query(this.memoryGenerationRefsCollection, {
      documentIds: [id],
      retrieveVector: false,
      outputFields: MEMORY_GENERATION_REF_OUTPUT_FIELDS,
      limit: 1,
    });
    const doc = resp.documents?.[0];
    if (!doc || String(doc.memory_id ?? "") !== memoryId || doc.layer !== layer) return null;
    return {
      generation_ref_id: String(doc.id ?? ""),
      layer,
      memory_id: memoryId,
      generation_id: String(doc.generation_id ?? ""),
      generation_log_id: String(doc.generation_log_id ?? ""),
      generation_log_key: String(doc.generation_log_key ?? ""),
      memory_prompt_id: String(doc.memory_prompt_id ?? ""),
      memory_prompt_version: Number(doc.memory_prompt_version ?? 1),
      memory_prompt_source: doc.memory_prompt_source === "agent" || doc.memory_prompt_source === "team" || doc.memory_prompt_source === "instance"
        ? doc.memory_prompt_source
        : "system",
      created_at_ms: Number(doc.created_at_ms ?? 0),
    };
  }

  // ─────────────────────────────────────────────────────────
  // Custom Memory Prompt
  // ─────────────────────────────────────────────────────────

  private promptFromDoc(doc: Record<string, unknown>): MemoryPromptRecord {
    return {
      memory_prompt_id: String(doc.id ?? ""),
      name: String(doc.name ?? ""),
      layer: (doc.layer === "l2" || doc.layer === "l3" ? doc.layer : "l1"),
      prompt: String(doc.prompt ?? ""),
      version: Number(doc.version ?? 1),
      status: doc.status === "deleting" ? "deleting" : "active",
      created_by: String(doc.created_by ?? "") || undefined,
      updated_by: String(doc.updated_by ?? "") || undefined,
      created_at_ms: Number(doc.created_at_ms ?? 0),
      updated_at_ms: Number(doc.updated_at_ms ?? 0),
    };
  }

  private settingFromDoc(doc: Record<string, unknown>): MemoryPromptSettingRecord {
    return {
      setting_id: String(doc.id ?? ""),
      target_type: doc.target_type === "agent" || doc.target_type === "team" ? doc.target_type : "instance",
      team_id: String(doc.team_id ?? "") || undefined,
      agent_id: String(doc.agent_id ?? "") || undefined,
      layer: doc.layer === "l2" || doc.layer === "l3" ? doc.layer : "l1",
      memory_prompt_id: String(doc.memory_prompt_id ?? ""),
      updated_by: String(doc.updated_by ?? "") || undefined,
      updated_at_ms: Number(doc.updated_at_ms ?? 0),
    };
  }

  private promptLogFromDoc(doc: Record<string, unknown>): MemoryPromptSettingLogRecord {
    return {
      setting_log_id: String(doc.id ?? ""),
      target_type: doc.target_type === "agent" || doc.target_type === "team" ? doc.target_type : "instance",
      team_id: String(doc.team_id ?? "") || undefined,
      agent_id: String(doc.agent_id ?? "") || undefined,
      layer: doc.layer === "l2" || doc.layer === "l3" ? doc.layer : "l1",
      action: doc.action === "replace" || doc.action === "clear" ? doc.action : "apply",
      reason: doc.reason === "prompt_deleted" ? "prompt_deleted" : "explicit",
      before_memory_prompt_id: String(doc.before_memory_prompt_id ?? "") || undefined,
      after_memory_prompt_id: String(doc.after_memory_prompt_id ?? "") || undefined,
      operator_id: String(doc.operator_id ?? "") || undefined,
      operated_at_ms: Number(doc.operated_at_ms ?? 0),
    };
  }

  private promptDoc(record: MemoryPromptRecord): Record<string, unknown> {
    return {
      id: record.memory_prompt_id,
      vector: [0],
      name: record.name,
      layer: record.layer,
      prompt: record.prompt,
      version: record.version,
      status: record.status,
      created_by: record.created_by ?? "",
      updated_by: record.updated_by ?? "",
      created_at_ms: record.created_at_ms,
      updated_at_ms: record.updated_at_ms,
    };
  }

  async countMemoryPrompts(): Promise<number> {
    await this._ensureInit();
    return this.client.count(this.memoryPromptsCollection);
  }

  async createMemoryPrompt(record: MemoryPromptRecord): Promise<MemoryPromptRecord> {
    await this._ensureInit();
    await this.client.upsert(this.memoryPromptsCollection, [this.promptDoc(record)]);
    return record;
  }

  async getMemoryPrompts(ids: string[]): Promise<MemoryPromptRecord[]> {
    await this._ensureInit();
    const records: MemoryPromptRecord[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      const resp = await this.client.query(this.memoryPromptsCollection, {
        documentIds: chunk,
        retrieveVector: false,
        outputFields: MEMORY_PROMPT_OUTPUT_FIELDS,
        limit: chunk.length,
      });
      records.push(...(resp.documents ?? []).map((doc) => this.promptFromDoc(doc)));
    }
    return records;
  }

  async listMemoryPrompts(filter: MemoryPromptListFilter): Promise<MemoryPromptRecord[]> {
    await this._ensureInit();
    const conds = [eqFilter("status", "active")];
    if (filter.layer) conds.push(eqFilter("layer", filter.layer));
    const resp = await this.client.query(this.memoryPromptsCollection, {
      filter: joinFilter(conds),
      retrieveVector: false,
      outputFields: MEMORY_PROMPT_OUTPUT_FIELDS,
      limit: Math.min(Math.max(filter.limit ?? 20, 1), 100),
      offset: Math.max(filter.offset ?? 0, 0),
      sort: [{ fieldName: "updated_at_ms", direction: filter.timeOrder === "asc" ? "asc" : "desc" }],
    });
    return (resp.documents ?? []).map((doc) => this.promptFromDoc(doc));
  }

  async updateMemoryPrompt(
    id: string,
    patch: { name?: string; prompt?: string; updated_by?: string; updated_at_ms: number },
  ): Promise<MemoryPromptRecord | null> {
    const current = (await this.getMemoryPrompts([id]))[0];
    if (!current || current.status !== "active") return null;
    const sameName = patch.name === undefined || patch.name === current.name;
    const samePrompt = patch.prompt === undefined || patch.prompt === current.prompt;
    if (sameName && samePrompt) return current;

    const updated: MemoryPromptRecord = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      updated_by: patch.updated_by,
      updated_at_ms: patch.updated_at_ms,
      version: current.version + 1,
    };
    await this.client.upsert(this.memoryPromptsCollection, [this.promptDoc(updated)]);
    return updated;
  }

  async getMemoryPromptSettings(ids: string[]): Promise<MemoryPromptSettingRecord[]> {
    await this._ensureInit();
    const records: MemoryPromptSettingRecord[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      const resp = await this.client.query(this.memoryPromptSettingsCollection, {
        documentIds: chunk,
        retrieveVector: false,
        outputFields: MEMORY_PROMPT_SETTING_OUTPUT_FIELDS,
        limit: chunk.length,
      });
      records.push(...(resp.documents ?? []).map((doc) => this.settingFromDoc(doc)));
    }
    return records;
  }

  async listMemoryPromptSettings(filter: MemoryPromptSettingListFilter): Promise<MemoryPromptSettingRecord[]> {
    await this._ensureInit();
    const conds: string[] = [];
    if (filter.memoryPromptId) conds.push(eqFilter("memory_prompt_id", filter.memoryPromptId));
    if (filter.targetType) conds.push(eqFilter("target_type", filter.targetType));
    if (filter.teamId) conds.push(eqFilter("team_id", filter.teamId));
    if (filter.agentId) conds.push(eqFilter("agent_id", filter.agentId));
    if (filter.layer) conds.push(eqFilter("layer", filter.layer));
    const resp = await this.client.query(this.memoryPromptSettingsCollection, {
      ...(conds.length > 0 ? { filter: joinFilter(conds) } : {}),
      retrieveVector: false,
      outputFields: MEMORY_PROMPT_SETTING_OUTPUT_FIELDS,
      limit: Math.min(Math.max(filter.limit ?? 20, 1), 100),
      offset: Math.max(filter.offset ?? 0, 0),
      sort: [{ fieldName: "updated_at_ms", direction: filter.timeOrder === "asc" ? "asc" : "desc" }],
    });
    return (resp.documents ?? []).map((doc) => this.settingFromDoc(doc));
  }

  private settingDoc(record: MemoryPromptSettingRecord): Record<string, unknown> {
    return {
      id: record.setting_id,
      vector: [0],
      target_type: record.target_type,
      team_id: record.team_id ?? "",
      agent_id: record.agent_id ?? "",
      layer: record.layer,
      memory_prompt_id: record.memory_prompt_id,
      updated_by: record.updated_by ?? "",
      updated_at_ms: record.updated_at_ms,
    };
  }

  private promptLogDoc(log: MemoryPromptSettingLogRecord): Record<string, unknown> {
    return {
      id: log.setting_log_id,
      vector: [0],
      target_type: log.target_type,
      team_id: log.team_id ?? "",
      agent_id: log.agent_id ?? "",
      layer: log.layer,
      action: log.action,
      reason: log.reason,
      before_memory_prompt_id: log.before_memory_prompt_id ?? "",
      after_memory_prompt_id: log.after_memory_prompt_id ?? "",
      operator_id: log.operator_id ?? "",
      operated_at_ms: log.operated_at_ms,
    };
  }

  async upsertMemoryPromptSettings(
    records: MemoryPromptSettingRecord[],
    logs: MemoryPromptSettingLogRecord[],
  ): Promise<void> {
    await this._ensureInit();
    for (let offset = 0; offset < records.length; offset += 100) {
      await this.client.upsert(
        this.memoryPromptSettingsCollection,
        records.slice(offset, offset + 100).map((record) => this.settingDoc(record)),
      );
    }
    for (let offset = 0; offset < logs.length; offset += 100) {
      await this.client.upsert(
        this.memoryPromptSettingLogsCollection,
        logs.slice(offset, offset + 100).map((log) => this.promptLogDoc(log)),
      );
    }
  }

  async clearMemoryPromptSettings(ids: string[], logs: MemoryPromptSettingLogRecord[]): Promise<void> {
    await this._ensureInit();
    for (let offset = 0; offset < ids.length; offset += 100) {
      await this.client.deleteDoc(this.memoryPromptSettingsCollection, {
        query: { documentIds: ids.slice(offset, offset + 100) },
      });
    }
    for (let offset = 0; offset < logs.length; offset += 100) {
      await this.client.upsert(
        this.memoryPromptSettingLogsCollection,
        logs.slice(offset, offset + 100).map((log) => this.promptLogDoc(log)),
      );
    }
  }

  async deleteMemoryPrompts(ids: string[], operatorId?: string): Promise<{
    deleted_prompt_ids: string[];
    cleared_settings: Record<MemoryPromptTargetType, number>;
  }> {
    await this._ensureInit();
    const prompts = await this.getMemoryPrompts(ids);
    if (prompts.length !== ids.length) {
      return { deleted_prompt_ids: [], cleared_settings: { instance: 0, team: 0, agent: 0 } };
    }

    const now = Date.now();
    await this.client.upsert(this.memoryPromptsCollection, prompts.map((prompt) => this.promptDoc({
      ...prompt,
      status: "deleting",
      updated_at_ms: now,
    })));

    const settingFilter = ids.map((id) => eqFilter("memory_prompt_id", id)).join(" or ");
    const settingDocs = await this._queryAllDocs(
      this.memoryPromptSettingsCollection,
      settingFilter,
      MEMORY_PROMPT_SETTING_OUTPUT_FIELDS,
    );
    const settings = settingDocs.map((doc) => this.settingFromDoc(doc));
    const cleared: Record<MemoryPromptTargetType, number> = { instance: 0, team: 0, agent: 0 };
    const logs = settings.map((setting): MemoryPromptSettingLogRecord => {
      cleared[setting.target_type] += 1;
      return {
        setting_log_id: `mpsl:delete:${setting.setting_id}:${setting.memory_prompt_id}`,
        target_type: setting.target_type,
        team_id: setting.team_id,
        agent_id: setting.agent_id,
        layer: setting.layer,
        action: "clear",
        reason: "prompt_deleted",
        before_memory_prompt_id: setting.memory_prompt_id,
        operator_id: operatorId,
        operated_at_ms: now,
      };
    });
    const settingIds = settings.map((setting) => setting.setting_id);
    for (let offset = 0; offset < settingIds.length; offset += 100) {
      await this.client.deleteDoc(this.memoryPromptSettingsCollection, {
        query: { documentIds: settingIds.slice(offset, offset + 100) },
      });
    }
    for (let offset = 0; offset < logs.length; offset += 100) {
      await this.client.upsert(
        this.memoryPromptSettingLogsCollection,
        logs.slice(offset, offset + 100).map((log) => this.promptLogDoc(log)),
      );
    }
    await this.client.deleteDoc(this.memoryPromptsCollection, { query: { documentIds: ids } });
    return { deleted_prompt_ids: ids, cleared_settings: cleared };
  }

  async queryMemoryPromptSettingLogs(filter: MemoryPromptSettingLogFilter): Promise<MemoryPromptSettingLogRecord[]> {
    await this._ensureInit();
    const conds: string[] = [];
    if (filter.memoryPromptId) {
      const id = escapeFilterString(filter.memoryPromptId);
      conds.push(`(before_memory_prompt_id = "${id}" or after_memory_prompt_id = "${id}")`);
    }
    if (filter.teamId) conds.push(eqFilter("team_id", filter.teamId));
    if (filter.agentId) conds.push(eqFilter("agent_id", filter.agentId));
    if (filter.action) conds.push(eqFilter("action", filter.action));
    if (filter.startTimeMs !== undefined) conds.push(`operated_at_ms >= ${filter.startTimeMs}`);
    if (filter.endTimeMs !== undefined) conds.push(`operated_at_ms <= ${filter.endTimeMs}`);
    const resp = await this.client.query(this.memoryPromptSettingLogsCollection, {
      ...(conds.length > 0 ? { filter: joinFilter(conds) } : {}),
      retrieveVector: false,
      outputFields: MEMORY_PROMPT_SETTING_LOG_OUTPUT_FIELDS,
      limit: Math.min(Math.max(filter.limit ?? 20, 1), 100),
      offset: Math.max(filter.offset ?? 0, 0),
      sort: [{ fieldName: "operated_at_ms", direction: filter.timeOrder === "asc" ? "asc" : "desc" }],
    });
    return (resp.documents ?? []).map((doc) => this.promptLogFromDoc(doc));
  }

  // ─────────────────────────────────────────────────────────
  // Memory Audit (修改审计)
  // ─────────────────────────────────────────────────────────

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this._ensureInit();
    if (this.degraded) return;

    // dim=1 占位向量（audit 不需向量检索，仅用 filter 查询）
    const doc: Record<string, unknown> = {
      id:            entry.audit_id,
      vector:        [0],
      record_id:     entry.record_id,
      layer:         entry.layer,
      action:        entry.action,
      team_id:       entry.team_id ?? "",
      agent_id:      entry.agent_id ?? "",
      user_id:       entry.user_id ?? "",
      task_id:       entry.task_id ?? "",
      version:       entry.version,
      updated_at_ms: entry.updated_at_ms,
      request_id:    entry.request_id ?? "",
    };

    try {
      await this.client.upsert(this.auditCollection, [doc]);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [audit-append] FAILED audit_id=${entry.audit_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async queryAudit(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    const conds: string[] = [];
    if (filter.record_id !== undefined) conds.push(eqFilter("record_id", filter.record_id));
    if (filter.layer !== undefined)     conds.push(eqFilter("layer", filter.layer));
    if (filter.action !== undefined)    conds.push(eqFilter("action", filter.action));
    if (filter.team_id !== undefined)   conds.push(eqFilter("team_id", filter.team_id));
    if (filter.agent_id !== undefined)  conds.push(eqFilter("agent_id", filter.agent_id));
    if (filter.user_id !== undefined)   conds.push(eqFilter("user_id", filter.user_id));
    if (filter.task_id !== undefined)   conds.push(eqFilter("task_id", filter.task_id));
    if (filter.since_ms !== undefined)  conds.push(`updated_at_ms >= ${filter.since_ms}`);
    if (filter.until_ms !== undefined)  conds.push(`updated_at_ms <= ${filter.until_ms}`);

    const filterExpr = joinFilter(conds);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);

    try {
      const docs = await this._queryAllDocs(
        this.auditCollection,
        filterExpr,
        AUDIT_OUTPUT_FIELDS,
        limit,
        [{ fieldName: "updated_at_ms", direction: "desc" }],
      );

      return docs.map((doc) => ({
        audit_id:      String(doc.id ?? ""),
        record_id:     String(doc.record_id ?? ""),
        layer:         (doc.layer === "L1" || doc.layer === "L2" || doc.layer === "L3")
                       ? doc.layer : "L1",
        action:        (doc.action === "delete" ? "delete" : "update") as "update" | "delete",
        team_id:       String(doc.team_id ?? "") || undefined,
        agent_id:      String(doc.agent_id ?? "") || undefined,
        user_id:       String(doc.user_id ?? "") || undefined,
        task_id:       String(doc.task_id ?? "") || undefined,
        version:       Number(doc.version ?? 0),
        updated_at_ms: Number(doc.updated_at_ms ?? 0),
        request_id:    String(doc.request_id ?? "") || undefined,
      }));
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [audit-query] FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}
