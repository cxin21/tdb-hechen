/**
 * Memory Store Abstraction Layer — Core Types & Interfaces.
 *
 * This module defines the storage contracts that all backend implementations
 * (SQLite local, Tencent Cloud VectorDB, etc.) must satisfy.
 *
 * Design principles:
 * 1. **Backend-agnostic**: Upper-layer modules (hooks, tools, pipeline, record)
 *    depend only on these interfaces — never on concrete implementations.
 * 2. **Capability-based**: Features like vector search, FTS, and hybrid search
 *    are expressed as capability flags so callers can gracefully degrade.
 * 3. **Fault-tolerant**: All methods return empty results or `false` on
 *    failure rather than throwing, unless explicitly documented otherwise.
 * 4. **Sync-first**: Matches current SQLite DatabaseSync usage. TCVDB backend
 *    adapts internally without changing these signatures.
 */

import type { MemoryRecord } from "../record/l1-writer.js";
import type { TaskSourceType } from "./task-source-type.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type { Logger } from "../types.js";
import type { IsolationFilter } from "./isolation.js";
import { DEFAULT_ISOLATION_ID } from "./isolation.js";
import type { MemoryPromptStore } from "../memory-prompt/types.js";
import type { MemoryGenerationRefStore } from "../memory-generation-log/types.js";
import type {
  PersonaItem,
  SoulEmotionRecord,
  SoulEpisode,
  SoulEpisodeQuery,
  SoulGateStat,
  SoulGateStatBump,
  SoulLedgerEntry,
  SoulRejectionStat,
} from "../soul/types.js";
import type { AxisVector } from "../soul/traits.js";
import type { TraitLabelRow } from "../soul/trait-drift.js";
import type { SoulPerson, SoulPersonUpsert } from "../person/types.js";
// P0-C：事件底座（soul_events）的类型只在 store 契约里出现一次，实现侧（sqlite.ts）与
// 迁移脚本共用 store 模块导出的同一份定义——这里 type-only 引入，避免运行期循环依赖。
import type { SoulEventListFilter, SoulEventWrite, SoulPrivateQuoteRow } from "./soul-event-store.js";
import type {
  SoulEventRow,
  SoulMoodEventInsert,
  SoulMoodEventRow,
  SoulMoodStateInsert,
  SoulMoodStateRow,
  SoulCalibrationInsert,
  SoulCalibrationRow,
  SoulEventReflectionInsert,
  SoulSelfModelInsert,
  SoulSelfModelRow,
  SoulGoalDepRow,
  SoulGoalEventInsert,
  SoulGoalEventRow,
  SoulGoalInsert,
  SoulGoalRow,
  SoulGoalStatus,
  SoulPersonStateEventInsert,
  SoulPersonStateEventRow,
  SoulPersonStateInsert,
  SoulPersonStateRow,
  SoulWorkingStateRow,
  SoulWorkingStateUpsert,
  SoulNarrativeEvidenceInsert,
  SoulNarrativeEvidenceRow,
  SoulNarrativeInsert,
  SoulNarrativeRow,
  SoulDilemmaInsert,
  SoulDilemmaRow,
  SoulGateDecision,
  SoulGateLogInsert,
  SoulGateLogRow,
  SoulGateStage,
  SoulValueInsert,
  SoulValueRow,
  SoulValueSource,
  SoulValueStatus,
} from "./soul-event-types.js";
import type { SoulNarrativeCommitInput, SoulNarrativeCommitResult, SoulNarrativeListFilter } from "./soul-narrative-store.js";
import type { SoulGateLogStats } from "./soul-value-store.js";

// Re-export so consumers can import everything from types.ts
export type { MemoryRecord, EmbeddingProviderInfo };

// Re-export isolation primitives so all store consumers import from here.
export type { IsolationContext, IsolationFilter, IsolationConfig } from "./isolation.js";
export {
  DEFAULT_ISOLATION_ID,
  LEGACY_ISOLATION_PLACEHOLDER,
  DEFAULT_ISOLATION_CONFIG,
  assertIsolation,
  buildIsolationWhere,
  rowMatchesIsolation,
  IsolationError,
} from "./isolation.js";

/**
 * P2-T12（K1）：core_memory 系的租户归属三元组（全必填，无"不筛"语义）。
 * core 是身份层信任边界 —— 不允许像 L1 filter 那样"缺维度=跨租户读"。
 */
export interface CoreTenant {
  teamId: string;
  userId: string;
  agentId: string;
}

/** core 租户化 default 桶：与 DEFAULT_ISOLATION_ID 家族一致（拍板⑤回填值同源）。 */
export const DEFAULT_CORE_TENANT: CoreTenant = {
  teamId: DEFAULT_ISOLATION_ID,
  userId: DEFAULT_ISOLATION_ID,
  agentId: DEFAULT_ISOLATION_ID,
};

/** 归一化：缺省/半缺省的三元组补齐为 default 桶（仅实例级内部调用方会走到这里）。 */
export function normalizeCoreTenant(tenant?: CoreTenant): CoreTenant {
  if (!tenant) return { ...DEFAULT_CORE_TENANT };
  return {
    teamId: tenant.teamId || DEFAULT_ISOLATION_ID,
    userId: tenant.userId || DEFAULT_ISOLATION_ID,
    agentId: tenant.agentId || DEFAULT_ISOLATION_ID,
  };
}

// ============================
// Common Types
// ============================

/** Minimal logger interface accepted by store implementations. */
export type StoreLogger = Logger;

// ============================
// L1 Types (Structured Memories)
// ============================

/** Result from an L1 vector similarity search. */
export interface L1SearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /**
   * Relevance score. Scale depends on the backend and MUST NOT be compared
   * against a fixed absolute threshold: TCVDB native hybrid returns a fused
   * RRF score (rerank k=60, rank-only: single-channel top-1 ≈ 1/61 ≈ 0.0164,
   * dual-channel top-1 ≈ 0.0328), while SQLite/vector fallback paths return a
   * similarity in 0–1. Use backend-specific thresholds (recall.scoreThreshold
   * for fallback paths, recall.nativeMinRRF for the native hybrid path).
   */
  score: number;
  timestamp_str: string;
  /**
   * @deprecated ADR-0025 C3（2026-11-04）：l1_records.timestamp_start 列已删
   * （与 timestamp_str 4225/4225 逐位相等）。字段保留仅为类型兼容，读回值恒等于 timestamp_str。
   */
  timestamp_start: string;
  timestamp_end: string;
  version: number;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  metadata_json: string;
  /** P1-T7：创建时间（getL1ByIds 精确读回；native 路径可能缺省 → 消费方回退 timestamp_str）。 */
  created_time?: string;
  /**
   * B 项（ADR-0025 决定 9，2026-11-04）：行最近更新时间（l1_records.updated_time）。
   * 与 timestamp_end（事件结束时刻）是两件事：memory_search 的 updated_at 取本列，
   * event_end_at 取 timestamp_end。旧后端/未补列路径缺省 → 消费方回退 timestamp_end。
   */
  updated_time?: string;

  // ── 灵魂记忆字段（P2a，读回）：时空/观察推断/情感 ──
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  /**
   * @deprecated ADR-0025 C2（2026-11-04）：l1_records.source 列已删（零判定读点）。
   * 字段保留仅为类型兼容，读回值恒为 undefined；凭据由 source_message_ids + memory_audit 承担。
   */
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
  /** D-3：敏感性枚举（none/health/finance/relationship）。 */
  sensitivity?: string;
  /** P1-T7：importance 1-10（null/缺省=未评分=召回面永不降权）。 */
  importance?: number | null;
  /**
   * 行级原话溯源（l1_records.source_message_ids JSON 列的解析值，已解析成数组）。
   * 读侧对非法 JSON/空串/NULL 一律回落 []（不抛）。
   * v2 编辑/人工调整/失效链取行重建 MemoryRecord 时必须原样透传，否则 upsert 整行覆盖会刷空。
   */
  source_message_ids?: string[];
}

/** Result from an L1 FTS keyword search. */
export interface L1FtsResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** BM25-derived score (0–1, higher is better). */
  score: number;
  /**
   * R71-A1（2026-10-19）：FTS5 raw rank（负=更相关，bm25() 刻度）。结论候选 bm25
   * 预地板数据源（auto-recall 透传为 bm25Rel=-rank）；后端未提供 = undefined = 地板豁免。
   */
  rank?: number;
  timestamp_str: string;
  /**
   * @deprecated ADR-0025 C3（2026-11-04）：l1_records.timestamp_start 列已删
   * （与 timestamp_str 4225/4225 逐位相等）。字段保留仅为类型兼容，读回值恒等于 timestamp_str。
   */
  timestamp_start: string;
  timestamp_end: string;
  version: number;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  metadata_json: string;
  // soul 9 字段（P1-T7 / W1）：列名以 soul-columns.ts SOUL_COL_NAMES 为单一事实源（ADR-0025 C2 删 source），
  // 类型口径与 L1RecordRow 的 soul 字段一致（occurred_at?: string / valence?: number…）。
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  /**
   * @deprecated ADR-0025 C2（2026-11-04）：l1_records.source 列已删（零判定读点）。
   * 字段保留仅为类型兼容，读回值恒为 undefined；凭据由 source_message_ids + memory_audit 承担。
   */
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
  /**
   * D-3 敏感性枚举（none/health/finance/relationship）。FTS SELECT 由
   * SOUL_SELECT_FRAGMENT 展开自动带出；结论层敏感门消费它（P0-1，2026-11-04）——
   * work_fact 结论是原文直出，必须与经验行同一道门。
   */
  sensitivity?: string;
  /** P1-T7：importance（FTS SELECT 由 SOUL_SELECT_FRAGMENT 展开，自动带出）。 */
  importance?: number | null;
  /**
   * 溯源（P0-1，2026-11-04）：l1_fts 表**不存**该列——检索 SELECT 用相关子查询
   * （`SELECT lr.source_message_ids FROM l1_records lr WHERE lr.record_id = l1_fts.record_id`）
   * 从主表带出。ADR-0025 C2 删 source 列后，这是 FTS 命中行唯一的溯源入口。
   */
  source_message_ids?: string[];
  /**
   * B 项（ADR-0025 决定 9，2026-11-04）：行最近更新时间。l1_fts 不存该列——同 source_message_ids
   * 走相关子查询从 l1_records 带出（updated_time 不在 SOUL_COLUMNS 里，FTS SELECT 不会自动带）。
   */
  updated_time?: string;
}

/** Filter options for querying L1 records. */
export interface L1QueryFilter {
  /** Query by document primary keys (maps to VDB `documentIds`, max 20). */
  recordIds?: string[];
  sessionKey?: string;
  sessionId?: string;
  taskId?: string;
  /** Isolation dimensions (any subset). */
  teamId?: string;
  userId?: string;
  agentId?: string;
  /** Only return records with updated_time strictly after this ISO 8601 UTC timestamp. */
  updatedAfter?: string;
}

/** Row shape returned by L1 query methods. */
export interface L1RecordRow {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  version: number;
  timestamp_str: string;
  /**
   * @deprecated ADR-0025 C3（2026-11-04）：l1_records.timestamp_start 列已删
   * （与 timestamp_str 4225/4225 逐位相等）。字段保留仅为类型兼容，读回值恒等于 timestamp_str。
   */
  timestamp_start: string;
  timestamp_end: string;
  created_time: string;
  updated_time: string;
  metadata_json: string;
  /** soul 9 列（P4a：rowToMemoryRecord 的 valid_end 透传所需；SELECT 已带出、类型此前未声明；ADR-0025 C2 删 source） */
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  /**
   * @deprecated ADR-0025 C2（2026-11-04）：l1_records.source 列已删（零判定读点）。
   * 字段保留仅为类型兼容，读回值恒为 undefined；凭据由 source_message_ids + memory_audit 承担。
   */
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
  sensitivity?: string;
  /** P1-T7：importance 1-10（NULL=未评分）。 */
  importance?: number | null;
  /**
   * L1 行级原话溯源（2026-11-04）：JSON 数组文本（TEXT NOT NULL DEFAULT '[]'）。
   * 读侧 rowToMemoryRecord 解析成 string[]；非法/空/NULL → []。缺省仅出现在
   * 未走 l1QueryCols 的旧 SELECT（如外部只读视图），消费方需自行兜底。
   */
  source_message_ids?: string;
}

// ============================
// L0 Types (Raw Conversations)
// ============================

/** An L0 conversation message record for vector indexing. */
export interface L0Record {
  id: string;
  sessionKey: string;
  sessionId: string;
  /**
   * Three-dim isolation (new in this branch).
   *
   * Mandatory for new writes once gateway-level enforcement is on, but kept
   * optional on the type during the rollout window. SQLite upsert defaults to
   * '' when missing; the migration script backfills existing rows to
   * `__legacy__`.
   */
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
  role: string;
  messageText: string;
  recordedAt: string;
  /** #83 入口单点定源：L0 行级分类标签（real/artifact/echo/scaffold/dup/unknown；未传=unclassified） */
  classification?: string;
  /** Original message timestamp (epoch ms). */
  timestamp: number;
}

/** Result from an L0 vector similarity search. */
export interface L0SearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  role: string;
  message_text: string;
  /** Similarity score (0–1, higher is better). */
  score: number;
  recorded_at: string;
  timestamp: number;
}

/** Result from an L0 FTS keyword search. */
export interface L0FtsResult {
  record_id: string;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  role: string;
  message_text: string;
  /** BM25-derived score (0–1, higher is better). */
  score: number;
  recorded_at: string;
  timestamp: number;
}

/** Raw L0 row returned by query methods (used by L1 runner). */
export interface L0QueryRow {
  record_id: string;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  timestamp: number;
  /**
   * 行级分类标签（proxy #83：real/artifact/echo/scaffold/dup/unknown）。
   * 无标签（老行/非 DSH 客户端）= 空串，L1 侧退化为内容闸门
   * （sanitize.ts isHarnessScaffoldText）。
   */
  classification?: string;
}

/** L0 messages grouped by session ID (for L1 runner). */
export interface L0SessionGroup {
  sessionId: string;
  teamId?: string;
  userId: string;
  agentId: string;
  taskId?: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: number;
    /** Epoch ms when this message was recorded into L0 (used by L1 cursor). */
    recordedAtMs: number;
    /** 行级分类标签（见 {@link L0QueryRow.classification}）。 */
    classification?: string;
  }>;
}

// ============================
// Store Init Result
// ============================

/** Result of store initialization. */
export interface StoreInitResult {
  /** Whether embeddings need to be regenerated (provider/model change). */
  needsReindex: boolean;
  /** Human-readable reason (for logging). */
  reason?: string;
}

// ============================
// Capability Flags
// ============================

/**
 * Describes what search capabilities a store backend supports.
 * Callers use this to select search strategies and degrade gracefully.
 */
export interface StoreCapabilities {
  /** Whether vector (embedding) search is available. */
  vectorSearch: boolean;
  /** Whether FTS (full-text keyword) search is available. */
  ftsSearch: boolean;
  /** Whether native hybrid search is supported (e.g., TCVDB hybridSearch). */
  nativeHybridSearch: boolean;
  /** Whether the store supports sparse vectors (BM25 encoding). */
  sparseVectors: boolean;
  /**
   * #152 ①：是否支持 l1_fact_vec 事实向量通道（upsertL1FactVector / searchL1FactVector）。
   *
   * 为什么需要能力位：调用点此前靠「方法是否存在」做 feature-detect，方法缺失时直接跳过，
   * 既不报错也无日志 ⇒ tcvdb 下事实向量写入/检索静默空跑（表现为「有事实记忆但检索不到」）。
   * 能力位让调用点能显式降级 + WARN（见 capability-guard.ts），而不是静默跳过。
   *
   * 可选（非 required）：老 mock / 第三方 store 不回该位时按「不支持」处理，
   * 且不制造 typecheck 破坏。
   */
  l1FactVec?: boolean;
}

// ============================
// L2/L3 Profile Sync Types
// ============================

/** Canonical L2/L3 profile row shared between local cache and remote store. */
export interface ProfileRecord {
  /** Stable ID: `profile:v1:${sha256(scope + "\0" + type + "\0" + filename)}`. */
  id: string;
  type: "l2" | "l3";
  filename: string;
  content: string;
  contentMd5: string;
  /** L2/L3 profile identity is team+agent scoped. userId/sessionId are optional
   *  for backwards compatibility with old in-memory shapes; new profile writes leave them empty. */
  teamId?: string;
  agentId?: string;
  userId?: string;
  sessionId?: string;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Profile upsert payload with optimistic-lock baseline from the last pull. */
export interface ProfileSyncRecord extends ProfileRecord {
  baselineVersion?: number;
}

export interface ProfileCountFilter {
  type?: ProfileRecord["type"];
  teamId?: string;
  userId?: string;
  agentId?: string;
  pathPrefix?: string;
}

// ============================
// v2 API Paginated Query Types
// ============================

/** Filter for v2 L0 paginated query (`/conversation/query`). */
export interface L0CountFilter {
  /** Filter by session. */
  sessionId?: string;
  /** Isolation dimensions (any subset). */
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
  /** Timestamp >= (epoch ms, inclusive). */
  timeStartMs?: number;
  /** Timestamp <= (epoch ms, inclusive). */
  timeEndMs?: number;
}

export interface L0PaginatedFilter extends L0CountFilter {
  /** Page size. */
  limit: number;
  /** Page offset. */
  offset: number;
}

/**
 * Filter for L0 batch-by-ids read (ADR-0025 行级溯源：L1.source_message_ids → L0 原话)。
 * 只含租户隔离轴；session 刻意不参与——溯源证据天然跨 session（同 L1 跨 session 语义）。
 */
export interface L0ByIdsFilter {
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
}

/** Result of v2 L0 paginated query. */
export interface L0PaginatedResult {
  rows: L0QueryRow[];
  /** Total count matching filters (for pagination). */
  total: number;
}

/** Filter for v2 L1 paginated query (`/atomic/query`). */
export interface L1CountFilter {
  /** Filter by memory type (episodic/persona/instruction). */
  type?: string;
  /** Filter by session. */
  sessionId?: string;
  /** Isolation dimensions (any subset). */
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
  /** Filter by updated_time >= (ISO 8601). */
  timeStart?: string;
  /** Filter by updated_time <= (ISO 8601). */
  timeEnd?: string;
}

export interface L1PaginatedFilter extends L1CountFilter {
  /** Page size. */
  limit: number;
  /** Page offset. */
  offset: number;
}

/** Result of v2 L1 paginated query. */
export interface L1PaginatedResult {
  rows: L1RecordRow[];
  /** Total count matching filters (for pagination). */
  total: number;
}

// ============================
// Entity Metadata Types (Team / User / Agent / Task)
// ============================

export type TeamStatus = "active" | "archived";
export type UserStatus = "active" | "inactive";
export type AgentStatus = "active" | "inactive";
export type AgentVisibility = "team" | "restricted";
/**
 * 任务来源（#127）：三值契约的唯一事实源在 ./task-source-type.ts。
 * 历史值 github/tapd 由读侧 normalizeTaskSourceType 归一到 external。
 */
export type { TaskSourceType };

export interface TeamEntity {
  team_id: string;
  name: string;
  description?: string;
  owner_user_id: string;
  status: TeamStatus;
  user_ids?: string[];
  agent_ids?: string[];
  task_ids?: string[];
  created_at: string;
  updated_at: string;
}

export interface UserEntity {
  user_id: string;
  name: string;
  job_description?: string;
  team_ids: string[];
  task_ids: string[];
  owned_agent_ids: string[];
  task_agent_ids?: string[];
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

export interface AgentEntity {
  agent_id: string;
  team_id: string;
  name: string;
  description?: string;
  prompt?: string;
  owner_user_id?: string;
  visibility: AgentVisibility;
  status: AgentStatus;
  task_ids?: string[];
  created_at: string;
  updated_at: string;
}

export interface TaskEntity {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  title?: string;
  description?: string;
  source_type: TaskSourceType;
  source_url?: string;
  agent_ids: string[];
  user_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface BatchDeleteResult {
  deleted_ids: string[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * 按隔离维度清空某个 memory 下的全部内容（不删除资产本身）。
 *
 * 语义约定（见 `/v3/chat-memory/clear`）：
 *   - 至少要给 teamId + agentId，否则实现必须直接拒绝（避免误删全库）；
 *   - 不带 sessionId：清空该 (team, agent) 下所有 session 的数据；
 *   - 只删内容行（L0/L1 + 向量 / FTS 附属行），不动 meta_* 资产表。
 */
export interface MemoryContentClearFilter {
  teamId: string;
  agentId: string;
  /** 可选：进一步收窄到单个 user。缺省表示该 agent 下所有 user。 */
  userId?: string;
}

/** 清空结果：各层实际删除行数。 */
export interface MemoryContentClearResult {
  l0Deleted: number;
  l1Deleted: number;
  /** L2/L3 profile 行数（VDB / sqlite profiles 表）。 */
  profilesDeleted: number;
}

export type KnowledgeType = "wiki" | "code-graph";

export interface KnowledgeEntity {
  knowledge_id: string;
  type: KnowledgeType;
  service_url: string;
  name: string;
  summary: string | null;
  team_id: string;
  /** 预留：agent 绑定维度（当前写 ""，绑定权威在 meta_assets）。 */
  agent_id?: string;
  user_id: string | null;
  repo_url?: string;
  branch?: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeListResult {
  items: KnowledgeEntity[];
  total: number;
}

// ============================
// IMemoryStore — The Core Abstraction
// ============================

/**
 * Unified memory store interface.
 *
 * Implementations:
 * - `SqliteMemoryStore` (sqlite.ts) — local SQLite + sqlite-vec + FTS5
 * - `TcvdbMemoryStore` (tcvdb.ts) — Tencent Cloud VectorDB (future)
 *
 * All methods are fault-tolerant: they return empty results or `false` on
 * failure rather than throwing, unless explicitly documented otherwise.
 */
/**
 * Helper type: a value that may be sync or async.
 * Callers should always `await` the result — it's safe for both sync and async values.
 */
export type MaybePromise<T> = T | Promise<T>;

// ============================
// #35（R5）Soul Promise 承诺层（义务≠倾向，不参与价值锚生命周期）
// ============================

export type SoulPromiseStatus = "open" | "kept" | "broken" | "withdrawn";

/**
 * #41（ADR0003-P3 实施票 C，D8 事件溯源）：promise 迁移判定来源——
 * manual=人工显式操作（Panel/API）；evidence=确定性证据命中（确认话语白名单/工具回执）；
 * proposal=LLM 提议经人工采纳（#27 提案门范式，LLM 永不直写）。
 */
export type PromiseTransitionSource = "manual" | "evidence" | "proposal";

export interface SoulPromiseRecord {
  promiseId: string;
  content: string;
  status: SoulPromiseStatus;
  source: string;
  /** #41：任务/上下文关联键（确定性证据关联 = 与证据 refKey 严格相等；缺省 ''）。 */
  refKey: string;
  createdAt: string;
  resolvedAt?: string | null;
  updatedAt: string;
}

export interface SoulPromiseEvent {
  promiseId: string;
  fromStatus: SoulPromiseStatus | null;
  toStatus: SoulPromiseStatus;
  at: string;
  note?: string | null;
  /** #41：判定来源（manual/evidence/proposal；创建事件恒 manual）。 */
  source: PromiseTransitionSource;
}

// ============================
// L1 记忆边受控词表（D 项）
// ============================

/**
 * L1 记忆边受控词表（D 项，2026-11-04）。
 *
 * 单一事实源：所有写点（l1-extractor / consolidation-worker / reflection /
 * evolution-worker / pipeline-factory）与读点（getLinksByType 等）都从这里取字面量，
 * 不再散落字符串。词表 = 生产 l1_links 存量实测分布（2026-11-04 只读探针，53964 条）：
 * derived_from / similar / part_of / evolve / evolved_from / conflict（causal 零行，已剔除）。
 *
 * 存量不符型处置见 docs/research 报告；删除/重命名存量边必须走数据迁移，禁止静默删。
 */
export const LINK_TYPES = {
  /** L2 场景块 → L1 记录（pipeline-factory 蒸馏出处的正向溯源）。 */
  DERIVED_FROM: "derived_from",
  /** 语义近邻（去重/合并候选），边权=相似度。 */
  SIMILAR: "similar",
  /** 结论/反思卡 → 证据行（组成关系）。 */
  PART_OF: "part_of",
  /** 相互矛盾的两条记忆（双方都保留）。 */
  CONFLICT: "conflict",
  /** 新旧事实的演进（extractor update 动作）。 */
  EVOLVE: "evolve",
  /** 演化合并边：merged ← 被合并的旧行（evolution-worker）。 */
  EVOLVED_FROM: "evolved_from",
} as const;
export type LinkType = (typeof LINK_TYPES)[keyof typeof LINK_TYPES];
/** 词表全集（测试断言「写点词表 ⊆ LINK_TYPES」用）。 */
export const LINK_TYPE_VALUES: readonly LinkType[] = Object.values(LINK_TYPES);

// ============================
// Memory Audit (修改审计)
// ============================

/**
 * 一次记忆修改事件。原始 L0/L1/L2/L3 表完全不动；这里只追加一行审计。
 *
 * 设计要点（per user 决策）：
 *   - 不存历史 content / 旧值，只记"什么时间、由谁、改了哪条"
 *   - team/agent/user/task 来自外部请求 IdFields（不是 record 原值）
 *   - version = 修改后该记录的新版本号（与原表 version 字段一致）
 *   - L0 不进 audit（不可变流水）；L1/L2/L3 update + delete 各记一条
 */
export interface AuditEntry {
  /** 自动生成主键，建议 audit-{uuid}。 */
  audit_id: string;
  /**
   * 被修改的记录主键：
   *   - L1 → MemoryRecord.id (msg-xxx / mem-xxx)
   *   - L2 → 文件路径 (scene_blocks/xxx.md)
   *   - L3 → "core"（全实例只一份）或 path
   */
  record_id: string;
  layer: "L1" | "L2" | "L3";
  /**
   * 变更类型。'sensitivity'（A 项，2026-11-04）记显式降敏：L1 行 sensitivity 单向棘轮
   * 下调（health/finance/relationship → none）是安全相关动作，必须留痕（旧值/新值在
   * 载荷里由 gateway 写 reason，这里只记「谁在何时调了哪条」）。
   */
  action: "update" | "delete" | "sensitivity";
  /** 外部请求 IdFields 副本，来源是调用方传入的 body / header（resolveIsolation 后）。 */
  team_id?: string;
  agent_id?: string;
  user_id?: string;
  task_id?: string;
  /** 修改后该记录的新版本号。delete 用 0 或上一版本号 + 1。 */
  version: number;
  /** 修改时间（毫秒）。 */
  updated_at_ms: number;
  /** Gateway request_id，便于 trace。 */
  request_id?: string;
}

/** queryAudit 过滤条件，全部可选。 */
export interface AuditQueryFilter {
  record_id?: string;
  layer?: "L1" | "L2" | "L3";
  action?: "update" | "delete" | "sensitivity";
  team_id?: string;
  agent_id?: string;
  user_id?: string;
  task_id?: string;
  /** 只返 updated_at_ms ≥ since_ms 的事件。 */
  since_ms?: number;
  /** 只返 updated_at_ms ≤ until_ms 的事件。 */
  until_ms?: number;
  limit?: number; // 默认 100，上限 1000
  offset?: number;
}

/**
 * P2-H §5.2：人物关系边一行（`soul_person_relation`）。
 *
 * `subjKey/pred/objKey` 是「谁—什么关系—谁」的三段；`objName` 只在绑不到 person_key 时
 * 兜底（「我老婆」）。`evidence` 是 A5 的合并结果：同一对 (A,B) 只留一条边，多份原话都进证据。
 */
export interface SoulPersonRelationRow {
  relId: string;
  subjKey: string;
  pred: string;
  /** 模型给的逆词（对称关系为 null）；判「两条边说同一件事」用，不参与渲染。 */
  inversePred?: string | null;
  objKey: string | null;
  objName: string | null;
  direction: "out" | "mutual";
  quote: string;
  recordId: string;
  evidence: Array<{ recordId: string; at: string; quote: string }>;
  validFrom: string;
  validTo: string | null;
  /** P2 §4.4：产生这条边的 soul_event id（NULL = 旧数据还没有回指，不算孤儿）。 */
  eventId?: string | null;
  /**
   * active=现在成立 / ended=有效期结束 / disputed=有反证 /
   * unverifiable=按 quote 回指 L0 时零命中或不唯一（保留事实，不进卡）。旧行读回默认 active。
   */
  status?: "active" | "ended" | "disputed" | "unverifiable";
  /** present=现在还成立 / past=曾经。 */
  tense?: "present" | "past";
  confidence?: number;
  /** shared=可在卡上展示（当前唯一取值）；更细的可见性留给后续。 */
  visibility?: string;
  /** 让这条关系结束的事件 id。 */
  endedByEventId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * P2（spec §10.8）：关系边 event_id 确定性回指的一轮账。
 * 三态口径：linked=唯一命中并写入 event_id；unverifiable=零命中或多命中（status 标 unverifiable）；
 * scanned 只数本轮参与判定的边（已有 event_id 或已 unverifiable 的不重复扫）。
 */
export interface SoulPersonRelationBackfillResult {
  scanned: number;
  linked: number;
  unverifiable: number;
}

/**
 * P6 / t20：给「一条 soul_events 都没有」的 episode 确定性补一条 chat 事件的一轮账。
 *
 * 口径：created = 引文在 L0 **唯一**命中的记录上建了事件；其余四个计数都是「不建」的原因，
 * 汇总在 skippedUnprovisionable 里。老库（episode 有、事件没有）成 0 章时，调用方必须能从
 * 这里读到「为什么」和「哪一条」——沉默的 0 章与「没有内容」在观测面上无法区分。
 *
 * exampleEpisodeId/exampleReason 取本轮扫描顺序（at 升序）里第一条没补成的 episode。
 */
export interface SoulEpisodeProvisionResult {
  /** 本轮扫到的「没有任何 soul_events 行」的 episode 数（含被上限截掉的候选）。 */
  scanned: number;
  /** 本次新建的事件数（幂等：已有事件的 episode 不再扫，重放 created=0）。 */
  created: number;
  /** 引文在 L0（含 episode 自己的证据记录）命中多条 = 不唯一，不猜、不建。 */
  ambiguous: number;
  /** 有可匹配原文，但 L0 里一条都没命中。 */
  notFound: number;
  /** 没有可匹配的原文（无 quote.text、user_stance 也空）——不是「没匹配上」，是「无从匹配」。 */
  noSource: number;
  /** work 类 episode 不强行造 chat 事件（它只给特质/自我史供料，不是「他说了什么」）。 */
  skippedWork: number;
  /** 以上全部「不建」之和；0 章时必须能在这里看到原因（不是静默）。 */
  skippedUnprovisionable: number;
  /** 第一条没补成的 episode id（给 summary / warn 当日志锚点）。 */
  exampleEpisodeId: string | null;
  /** 对应的原因。 */
  exampleReason: "ambiguous" | "not_found" | "no_source" | "work" | null;
  /** soul_events 里已有同 dedupe_key、但 event_id 不是 episodeId（历史双写异常）：不重复建。 */
  skippedExisting: number;
  /** 建事件抛错（本轮没补成，下轮重试）；与「不建」分开，避免把故障读成规则。 */
  failed: number;
  /** true = 本轮撞到每 tick 上限，剩余的下轮再补（不是失败）。 */
  limitReached: boolean;
}

/** P2 §10.8 补事件（t13）：给缺事件的关系按引文在 L0 唯一命中处补一条 chat 事件。 */
export interface SoulPersonRelationProvisionResult {
  /** 扫到的「event_id IS NULL 且 status=active」关系数。 */
  scanned: number;
  /** 本次新建的事件数（幂等：已有事件跳过）。 */
  created: number;
  /** 引文在 L0 命中多条 = 不唯一，不猜、不建。 */
  ambiguous: number;
  /** 引文在 L0 零命中，或事件已存在（留给回指去链）。 */
  skipped: number;
}

/** 缺口 A：soul 快照行（append-only 账本）。version 单调递增（迁移前旧行缺省 0）、 */
/** parent_hash 指向上一版 content_hash（首版 null）、trigger=受控原因枚举、slots_json=slot 图。 */
export interface SoulSnapshotRow {
  ts: string;
  content_hash: string;
  payload_json: string;
  trigger: string;
  version?: number;
  parent_hash?: string | null;
  reason_detail?: string;
  slots_json?: string;
}

/** P0-C 双写对账的一条差异：能点名到「哪条事件、哪个字段、两边各是什么」。 */
export interface SoulEventParityDiff {
  eventId: string;
  /**
   * missing_event：旧表有、新表没有；
   * missing_chat：新表有基表行但没有 chat 行（映射回 SoulEpisode 会缺 kind/title）；
   * missing_episode：新表有、旧表没有（P1 独写或孤儿 event_id）；
   * missing_evidence：事件一条证据都没有（违反 spec §4.2 准入）；
   * field_mismatch：两边都有，但基础字段对不上。
   */
  kind: "missing_event" | "missing_chat" | "missing_episode" | "missing_evidence" | "field_mismatch";
  field?: string;
  legacy?: string | null;
  event?: string | null;
}

/** P0-C 双写对账报告：只读，不修旧行；ok=true 才允许把读面切到新表。 */
export interface SoulEventParityReport {
  ok: boolean;
  tenant: { teamId: string; userId: string; agentId: string };
  /** episodes=旧表行数；events/chat/evidence=新表三张表的行数；missingEvidence=零证据事件数。 */
  counts: { episodes: number; events: number; chat: number; evidence: number; missingEvidence: number };
  /** 两侧基础字段按 event_id 排序后的整体摘要（sha1）；逐字段 0 差异时两者相等。 */
  digests: { legacy: string; event: string };
  diffs: SoulEventParityDiff[];
}

export interface IMemoryStore extends MemoryPromptStore, MemoryGenerationRefStore {
  // ── Capabilities ───────────────────────────────────────────

  /**
   * Whether this store supports deferred (background) embedding updates.
   *
   * When `true`, auto-capture writes metadata-only via `upsertL0(record, undefined)`
   * and later calls `updateL0Embedding()` in a fire-and-forget background task.
   * When `false` or absent, embedding is computed inline and passed to `upsertL0()`.
   */
  readonly supportsDeferredEmbedding?: boolean;

  // ── Lifecycle (always sync) ──────────────────────────────

  init(providerInfo?: EmbeddingProviderInfo): MaybePromise<StoreInitResult>;
  isDegraded(): boolean;
  getCapabilities(): StoreCapabilities;
  close(): void;

  // ── L1 Write ─────────────────────────────────────────────

  upsertL1(record: MemoryRecord, embedding?: Float32Array): MaybePromise<boolean>;
  deleteL1(recordId: string, filter?: IsolationFilter): MaybePromise<boolean>;
  deleteL1Batch(recordIds: string[], filter?: IsolationFilter): MaybePromise<boolean>;
  deleteL1Expired(cutoffIso: string): MaybePromise<number>;
  /** 重巩固（reconsolidation）：仅更新 L1 的 metadata 字段（召回统计等），不重写 content。best-effort。 */
  updateL1Metadata?(id: string, patch: Record<string, unknown>): MaybePromise<boolean>;
  /**
   * 重巩固（P0-T4，H-B1）：recall_count SQL 原子自增（json_set + json_extract，不读回）。
   * 修复召回 item 不带 metadata 导致 read-then-write prevCount 恒 0 → recall_count 恒 1、
   * `min(c,5)*0.02` 抗遗忘 boost 生产不可达的问题。best-effort；缺失时调用方回退旧路径。
   */
  bumpRecallCount?(id: string, now?: string): MaybePromise<boolean>;

  // ── L1 Read ──────────────────────────────────────────────

  countL1(filter?: L1CountFilter): MaybePromise<number>;
  /**
   * T15-A（向量健康三件套）：vec0 shadow 表 `l1_vec_rowids` 的真实向量行数。
   * 元数据行在向量写入静默失败时仍增长（G1 生产实锤：104 vec / 203 records），
   * 向量可用性判据必须以向量行数为准，不能数 countL1 的元数据行。
   * degraded / vec0 表未就绪时返回 0。旧后端可不实现（调用方 feature-detect 回退 countL1）。
   */
  countL1VectorRows?(): MaybePromise<number>;
  countL1WithVectors?(): MaybePromise<number>;
  backfillL1Vectors?(
    embedFn: (text: string) => Promise<Float32Array>,
    limit?: number,
  ): Promise<{ scanned: number; backfilled: number; failed: number }>;

  /**
   * T15-B（向量健康三件套）：最近一次成功向量写入的 ISO 时间戳。
   * 进程内内存值（非持久化，重启归零为 null）；upsertL1 成功写向量时更新。
   * 供 /health 的 memory.lastVecWriteAt 读取；旧后端可不实现。
   */
  getLastVecWriteAt?(): string | null;
  queryL1Records(filter?: L1QueryFilter): MaybePromise<L1RecordRow[]>;
  getAllL1Texts(): MaybePromise<Array<{ record_id: string; content: string; updated_time: string }>>;

  // ── 记忆图（G）：L1↔L1 显式边 ──
  addLink?(sourceId: string, targetId: string, type: LinkType, strength?: number, now?: string): MaybePromise<boolean>;
  /**
   * A 项（ADR-0025 决定 10，2026-11-04）：显式降敏——L1 行 sensitivity 单向棘轮下调。
   *
   * CAS 语义：SQL 条件里带 AND sensitivity = expect（body 必带 expect，防止盲覆盖并发改写）；
   * changes === 0 → 返回 false（调用方映射 409 CAS_CONFLICT：行不存在 / expect 不符 /
   * 已被别的请求改过，三者不区分——不泄漏行存在性）。
   *
   * 不走 upsertL1：upsert 的粘性 CASE（sqlite.ts:1358-1371）把 'none' 当作「未判定」，
   * 永远无法把已分类行降回 none——棘轮下限只有单条 UPDATE 能表达。
   * 必须同时 UPDATE l1_fts（sensitivity 是 soul 列，FTS 表有 UNINDEXED 副本，
   * 双写模板同 invalidateL1）；updated_time 同步 bump（审计可见"最近更新"）。
   * 两条 UPDATE 在同一事务内（半写会让 FTS 腿继续按旧标注拦/放，见 sqlite.ts 实现注释）。
   * **失败语义**：false = 纯 CAS 未命中（409）；实现异常/degraded 必须抛出（调用方映射 503），
   * 不得把「存储不可用」伪装成「并发冲突」。
   * 可选方法——旧后端/未实现 = 降敏不可用（调用方 fail-loud，不静默降级）。
   */
  setL1Sensitivity?(recordId: string, value: string, expect: string): MaybePromise<boolean>;
  /** GROW-EVO P2（§2.2）：失效回写——只写 valid_end，不覆盖已失效行（失效不删除）。可选：旧后端安静跳过。 */
  invalidateL1?(id: string, validEndIso: string): MaybePromise<boolean>;
  /**
   * #146（W2b 事实级双时态）：按事实键（metadata fact_key）失效同（实体,属性）的事实行，
   * 返回命中行数。事实级粒度下写侧只用它（不回落整行失效/归档）；旧后端未实现时调用方
   * loud warn 并跳过失效（宁可少失效，也不放大爆炸半径）。
   */
  invalidateL1ByFactKey?(
    filter: IsolationFilter | undefined,
    factKey: string,
    validEndIso: string,
  ): MaybePromise<number>;
  /** P2-T14（G2）：可选租户 filter——缺省 undefined=旧行为；传入时两步过滤（rowMatchesIsolation 复核）。 */
  getNeighbors?(
    id: string,
    types?: string[],
    maxHop?: number,
    filter?: IsolationFilter,
  ): MaybePromise<Array<{ id: string; type: string; strength: number; hop: number }>>;
  /** P4a-P2（层级边，REG-REMAINING-002 #1）：沿边反查（target←sources）/正查（source→targets）；可选 type 过滤。derived_from 边 source=L2 scene block（profile:v1:* 稳定租户唯一）、target=L1 record。可选方法——旧后端可不实现，调用方 feature-detect。 */
  getLinksByTarget?(
    targetId: string,
    type?: string,
  ): MaybePromise<Array<{ sourceId: string; type: string; strength: number; createdAt: string }>>;
  getLinksBySource?(
    sourceId: string,
    type?: string,
  ): MaybePromise<Array<{ targetId: string; type: string; strength: number; createdAt: string }>>;
  /**
   * P0-1（2026-11-04 L1 属性复核）：按 L2 块 id 聚合 `derived_from` 溯源画像——该块蒸馏过的
   * **仍在主表**的 L1 行数，以及其中敏感行（sensitivity 非 none）数。一次 GROUP BY，不逐块
   * 扫链接、不把上千个 target 读进内存。语义与消费者见 core/recall/sensitivity-policy.ts
   * `decideDerivedInjection`（结论层敏感门的唯一判定源）。
   * 可选方法——未实现 = 溯源不可判定，门按 fail-closed 处理（非 private 上下文不注入聚合块）。
   */
  getDerivedSensitivityStats?(
    sourceIds: string[],
  ): MaybePromise<Record<string, { targets: number; sensitive: number }>>;
  /** P4b（REG-REMAINING-005 #1）：按 type 全量取边（evolution-worker conflict 扫描底座，单条索引查询）。可选方法——旧后端可不实现，调用方 feature-detect。 */
  getLinksByType?(
    type: LinkType,
  ): MaybePromise<Array<{ sourceId: string; targetId: string; type: string; strength: number; createdAt: string }>>;
  /**
   * C6（graph 设计 §4 / spec §6.4 #1）：两节点间 BFS 最短路径；不可达返回 null，
   * 起点即终点返回 []。可选租户 filter（T14 同形：新图接口第一天即带 isolation）。
   * 可选方法——tcvdb 等后端可不实现（F7 家族先例），调用方 feature-detect。
   */
  getPath?(
    startId: string,
    endId: string,
    maxHop?: number,
    types?: string[],
    filter?: IsolationFilter,
  ): MaybePromise<Array<{ id: string; type: string; strength: number; hop: number }> | null>;
  deleteLinksFor?(id: string): MaybePromise<boolean>;
  /** 审计 F5：清理两端都消失的孤儿边；返回删除数，-1=失败。 */
  pruneOrphanLinks?(): MaybePromise<number>;
  /** fix1 I-4（接线拍板）：放宽为 MaybePromise——tcvdb 实时行取回必须异步（HTTP 批量 query），
   *  sqlite 同步实现不变；消费方统一 await（await 数组零语义变化）。 */
  getL1ByIds?(ids: string[]): MaybePromise<Array<L1SearchResult>>;
  /** 审计修复 B3：解析 ids 时回退到归档桶（演进/合并的旧证据可回溯）。fix1 I-4 同上放宽 MaybePromise。 */
  getL1ByIdsWithArchive?(ids: string[]): MaybePromise<Array<L1SearchResult>>;
  /** 遗忘归档桶（I，设计§3）：软删到 l1_archive，可恢复。 */
  archiveL1?(id: string, reason?: string): MaybePromise<boolean>;
  /**
   * SEC-1（安全级，补 T12 漏网）：可选 IsolationFilter 属主校验——filter 传入时
   * 归档行租户不匹配即拒绝（false）；缺省 = 旧行为（实例级内部调用方/补偿路径）。
   */
  restoreL1?(id: string, filter?: IsolationFilter): MaybePromise<boolean>;
  /**
   * SEC-1：可选 IsolationFilter 租户过滤（filter 缺省 = 旧行为实例级全量）；
   * 出参带 team_id/user_id/agent_id 归属（面板徽标消费）。
   */
  listArchived?(
    limit?: number,
    offset?: number,
    filter?: IsolationFilter,
  ): MaybePromise<
    Array<{
      record_id: string;
      archived_at: string;
      reason: string;
      content: string;
      occurred_at?: string;
      team_id: string;
      user_id: string;
      agent_id: string;
    }>
  >;
  /** 核心记忆 + 价值锚（K，设计§2/§3）：稳定锚定 / agent 可维护 / 情感参照系。
   *
   * P2-T12（K1）core 租户化：四个方法均按 tenant 三元组过滤（team/user/agent）。
   * tenant 为可选参数的约定（有意为之，见 task-12 报告）：
   *   - HTTP handler（咽喉边界）必须显式传入 requestIsolation 派生的三元组；
   *     /v3 严格模式缺三元组已在闸门 422，/v2 匿名 → default 桶。
   *   - 缺省 = default 桶，仅供实例级内部调用方（server 启动种子、遗忘 worker
   *     价值锚）保持旧行为 —— 这些调用无请求上下文，语义上属实例级数据。
   */
  upsertCore?(slot: string, content: string, source?: string, tenant?: CoreTenant): MaybePromise<boolean>;
  readCore?(
    tenant?: CoreTenant,
  ): MaybePromise<Array<{ slot: string; content: string; source: string; version: number; updated_at: string }>>;
  /**
   * 自维护人格（m00527）：枚举有 core/soul 数据的租户三元组。
   * 后台 worker 无请求上下文，必须按租户逐个跑——否则读 core_memory 只能落在 default 桶（生产全空），
   * 人格整合永不发生。旧后端可不实现（调用方回退单桶）。
   */
  listCoreTenants?(): MaybePromise<CoreTenant[]>;
  /** P2：通用 refs 回填键族（coreRefs/personRefs/identityRefs 单源；旧后端可缺省）。 */
  backfillMemoryRef?(
    recordId: string,
    key: "coreRefs" | "personRefs" | "identityRefs",
    label: string,
    tenant?: CoreTenant,
  ): MaybePromise<boolean>;
  /** 2026-11-07（T1 提案/pending 通道清除）：core_pending 的 upsert/decide/复现计票/自动采纳门/
   *  审计回滚/状态读共 12 个可选方法声明已全部删除——提案制与人工采纳通道整体下线，store 侧
   *  已无 core_pending 实现亦无声明（最后残留的 pending 读声明随死代码一并删除）。 */
  /** S-FEEL-1（M1/IF-1）：近期情感信号只读查询——M1 近期基调行数据源。可选签名（ILogBackend debug? 先例）：
   *  缺实现时调用侧静默省略基调行（宁缺毋滥）。租户三元组硬隔离（F18 同款）；样本窗=occurred_at ≥ now−windowHours
   *  （UTC ISO 字典序比较），occurred_at DESC 取 ≤maxSamples；valence IS NOT NULL。只读、零写库、零 LLM。 */
  recentAffectSignals?(
    tenant?: CoreTenant,
    opts?: { windowHours: number; maxSamples: number },
  ): MaybePromise<Array<{ valence: number; arousal: number | null; occurred_at: string; excerpt?: string | null }>>;
  /** #30（S9/R5，2026-10-16）：soul 快照 append-only 账本（三方法可选签名，缺实现=调用侧静默跳过）。
   *  只追加不更新不删除（禁删红线同构）；payload_json=soul 渲染全文，时间旅行可重建任一时点；
   *  capture point=渲染路径，指纹变化后首次渲染落行（at-least-once），last-hash 去重零落行防膨胀。 */
  writeSoulSnapshot?(
    tenant: CoreTenant,
    snap: {
      ts: string;
      contentHash: string;
      payloadJson: string;
      /** 受控枚举（SOUL_CHANGE_REASONS）；缺省回落 layout。 */
      reasonCode?: string;
      reasonDetail?: string;
      slotsJson?: string;
      /** @deprecated 旧自由文本列；等价 reasonCode。 */
      trigger?: string;
    },
  ): MaybePromise<void>;
  /** #30：最近一次快照 content_hash（去重判据；null=该租户无快照史）。 */
  readLastSoulSnapshotHash?(tenant: CoreTenant): MaybePromise<string | null>;
  /** 缺口 A：最近一版整行（版本链判据 + 上一版 slot 图 diff 源）；无可选实现时调用侧回落 readLastSoulSnapshotHash。 */
  readLastSoulSnapshot?(tenant: CoreTenant): MaybePromise<SoulSnapshotRow | null>;
  /** #30：快照时间旅行读（id ASC ≤limit，limit 缺省 100 上限 1000）。 */
  listSoulSnapshots?(tenant: CoreTenant, limit?: number): MaybePromise<SoulSnapshotRow[]>;
  /** #28（R5）：会话级当下 state 单行 upsert/读（观测旁路；抽取扩展门 on 才写；F18 三元组隔离）。 */
  writeSoulState?(
    tenant: CoreTenant,
    state: {
      valence: number;
      arousal: number;
      /** m00527：心境基线（与基线比的读数需要它；缺省=调用方未提供基线）。 */
      baselineValence?: number | null;
      baselineArousal?: number | null;
      sampleCount?: number | null;
      topValue?: string | null;
      turnSeq?: number | null;
      /** 心境原因（2026-11-05）：造成当前心境的事件对象/标签/衰减后强度/时刻。
       *  分开存而不是塞进 topValue——topValue 是意图，情绪对象是解释，混用会出现
       *  「最想推进的是用户拍板」这种把程序性锚名当情绪的荒谬渲染。 */
      emotionObject?: string | null;
      emotionLabel?: string | null;
      emotionIntensity?: number | null;
      emotionAt?: string | null;
      updatedAt: string;
    },
  ): MaybePromise<void>;
  readSoulState?(
    tenant: CoreTenant,
  ): MaybePromise<{
    valence: number;
    arousal: number;
    baselineValence?: number | null;
    baselineArousal?: number | null;
    sampleCount?: number | null;
    topValue?: string | null;
    turnSeq?: number | null;
    emotionObject?: string | null;
    emotionLabel?: string | null;
    emotionIntensity?: number | null;
    emotionAt?: string | null;
    updatedAt: string;
  } | null>;

  /* —— 自维护人格层（soul persona，2026-11-05）——
   * 与 core_memory 并存、不替换：core_memory 仍是人的槽（identity/strict_rule），
   * soul_persona 是「经过判据筛过的取舍层」。写入只经 commitSoulPersona（事务化：
   * 条目 upsert + 账本 append 同生共死），账本只增不改，回滚靠 before_json 快照。 */
  /** 默认只返回「当前有效」的条目（state ∈ active/degraded 且 validTo 为空）；
   *  `includeSuperseded: true` 才带上被结论合并取代的行（审计/回放用）。frozen/merged 不受影响。 */
  listSoulPersona?(tenant?: CoreTenant, opts?: { includeSuperseded?: boolean }): MaybePromise<PersonaItem[]>;
  commitSoulPersona?(
    tenant: CoreTenant | undefined,
    plan: { upsert: PersonaItem[]; ledger: SoulLedgerEntry[] },
    /** S6：strict_rule 投影与 persona upsert/账本同一事务（判据 2 的「≤1 tick 逐字覆盖」）。 */
    opts?: { strictRule?: string; strictRuleSource?: string },
  ): MaybePromise<{ upserted: number; ledgered: number; strictRule?: boolean }>;
  listSoulLedger?(tenant?: CoreTenant, limit?: number): MaybePromise<SoulLedgerEntry[]>;
  /** 条目级回滚（点名、单事务、写 rollback 账本）。回滚演练与事故处置用，不做一键全量。 */
  rollbackSoulPersona?(
    tenant: CoreTenant | undefined,
    itemIds: string[],
    opts?: { now?: string; reason?: string; gate?: string },
  ): MaybePromise<{ restored: number; removed: number; skipped: number }>;

  /* —— 事件层（soul_episodes，2026-11-05）——
   * 人格的「事实底座」：每次分歧/纠正/拍板/取舍都是一行，userStance/agentStance 是逐字摘句。
   * identity/values/narrative 必须挂在 ep-* 上才准入；voice 的 few-shot 也从这里取。
   * 写入幂等（episode_id 主键 + INSERT OR IGNORE）：重跑同一天不会翻倍。 */
  commitSoulEpisodes?(tenant: CoreTenant | undefined, episodes: SoulEpisode[]): MaybePromise<{ inserted: number }>;
  /** 归档「不是他说的话」的事件（注入体/粘贴文档）。S3 起为归档而非物理删除：返回 archived 行数，
   *  历史派生仍可读回；清理的是派生视图，账本不受影响。 */
  deleteSoulEpisodes?(
    tenant: CoreTenant | undefined,
    episodeIds: string[],
  ): MaybePromise<{ deleted: number; archived?: number }>;
  listSoulEpisodes?(
    tenant?: CoreTenant,
    opts?: { since?: string; limit?: number; kind?: SoulEpisode["kind"]; includeArchived?: boolean },
  ): MaybePromise<SoulEpisode[]>;
  /** 把事件标记为「已积进心境」（幂等；写侧以此替代按时间水位过滤，避免迟到事件被永久跳过）。 */
  markSoulEpisodesMoodIntegrated?(
    tenant: CoreTenant | undefined,
    episodeIds: string[],
    at: string,
  ): MaybePromise<{ updated: number }>;
  /** 「上次因为什么恼火、对谁、多强」——确定性 LIKE 检索（标题/对象/双方立场/原话）。 */
  searchSoulEpisodes?(tenant: CoreTenant | undefined, query: SoulEpisodeQuery): MaybePromise<SoulEpisode[]>;

  /* —— 事件底座读面（soul_events，P0-C 2026-11-10）——
   * P0 阶段 soul_episodes 仍是读面真源：双写让两表同源，切读由环境变量
   * TDB_SOUL_EVENT_READ_MODE 控制（缺省 legacy，回滚=写回 legacy 并重启）。
   * 这三个方法是新表的第一等入口，供 P1 与对账脚本复用，不经旧表。 */
  /** 新表读面（租户 + 过滤条件），排序与 soul_episodes 的 at DESC, event_id DESC 对齐。 */
  listSoulEvents?(tenant?: CoreTenant, filter?: SoulEventListFilter): MaybePromise<SoulEventRow[]>;
  /** 新表写面：一批事件一个事务，全落或全不落（P1 直接用，不经过 soul_episodes）。 */
  commitSoulEvents?(tenant: CoreTenant | undefined, writes: SoulEventWrite[]): MaybePromise<{ upserted: number }>;
  /** 双写对账：旧 episode 数 vs 新表 events/chat/evidence 数 + 基础字段差异。只读，不修旧行。 */
  soulEventParity?(tenant?: CoreTenant): MaybePromise<SoulEventParityReport>;
  /* —— 特质层（六轴 state + 标签，2026-11-07）——
   * state 是漂移唯一事实源；标签是方向视图（不存独立权重）。读面缺省=零向量/空表。 */
  readSoulTraitState?(tenant?: CoreTenant): MaybePromise<{ state: AxisVector; seedState: AxisVector; updatedAt: string } | null>;
  writeSoulTraitState?(
    tenant: CoreTenant | undefined,
    input: { state: AxisVector; seedState?: AxisVector; updatedAt?: string },
  ): MaybePromise<void>;
  listSoulTraitLabels?(tenant?: CoreTenant): MaybePromise<TraitLabelRow[]>;
  commitSoulTraitLabels?(tenant: CoreTenant | undefined, rows: TraitLabelRow[]): MaybePromise<{ upserted: number }>;
  /* —— 情绪史（soul_emotions，2026-11-06）——
   * soul_state 只留「此刻」一个快照，下一次写入就覆盖；情绪史按「事件 × 模板版本」逐行留档，
   * 这样「因为什么、对谁、多强、多久消退」有逐条记录可回放，注入侧的心境原因也有出处可查。 */
  commitSoulEmotions?(
    tenant: CoreTenant | undefined,
    rows: SoulEmotionRecord[],
  ): MaybePromise<{ inserted: number }>;
  listSoulEmotions?(
    tenant?: CoreTenant,
    opts?: { limit?: number; object?: string; since?: string },
  ): MaybePromise<SoulEmotionRecord[]>;
  /* —— P5 心境层（soul_mood_state / soul_mood_events，2026-11-10 §4.7）——
   * 心境是「按租户一行」的当前态 + append-only 变化账本（appraisal/regulation/decay）。
   * 读侧按 half_life_hours（36–168，默认 48）算衰减；写侧不改 intensity。全部可选：缺实现时
   * 调用侧静默跳过（不伪造心境），但召回与注入就只剩 soul_state 的即时读数。 */
  readSoulMoodState?(tenant?: CoreTenant): MaybePromise<SoulMoodStateRow | null>;
  writeSoulMoodState?(
    tenant: CoreTenant | undefined,
    insert: SoulMoodStateInsert,
  ): MaybePromise<SoulMoodStateRow | null>;
  commitSoulMoodEvents?(
    tenant: CoreTenant | undefined,
    rows: SoulMoodEventInsert[],
  ): MaybePromise<{ inserted: number; present?: number }>;
  listSoulMoodEvents?(
    tenant?: CoreTenant,
    opts?: { limit?: number; kind?: string },
  ): MaybePromise<SoulMoodEventRow[]>;
  /* —— P4 自我模型与校准（soul_self_model / soul_calibration / soul_event_reflection，2026-11-10 §4.5/§4.6）——
   * 自我模型是「我对自己做事方式的判断」，每条带证据与反例、可被 probation/retired 推翻；
   * 校准只入账有预测有结果的事件，误差由读侧算（bias 正 = 过度自信）。全部可选：
   * 缺实现时派生整体跳过，不伪造自我认识。 */
  getSoulSelfModel?(tenant: CoreTenant | undefined, id: string): MaybePromise<SoulSelfModelRow | null>;
  listSoulSelfModel?(
    tenant?: CoreTenant,
    opts?: { limit?: number; kinds?: SoulSelfModelRow["kind"][]; statuses?: SoulSelfModelRow["status"][] },
  ): MaybePromise<SoulSelfModelRow[]>;
  upsertSoulSelfModel?(
    tenant: CoreTenant | undefined,
    insert: SoulSelfModelInsert,
  ): MaybePromise<SoulSelfModelRow | null>;
  commitSoulCalibration?(
    tenant: CoreTenant | undefined,
    rows: SoulCalibrationInsert[],
  ): MaybePromise<{ inserted: number }>;
  listSoulCalibration?(
    tenant?: CoreTenant,
    opts?: { limit?: number; domain?: string },
  ): MaybePromise<SoulCalibrationRow[]>;
  /** 反思子表：只在重复失败或已有修复成功时写，verified_at 为 null 就是「还没验过」。 */
  upsertSoulEventReflection?(
    tenant: CoreTenant | undefined,
    reflection: SoulEventReflectionInsert,
  ): MaybePromise<{ upserted: number }>;  /* —— P7 价值层（soul_values / soul_gate_log / soul_dilemma，2026-11-10 §4.9）——
   * 价值是「我按什么做取舍」，每条可回指证据、可退休不删；gate_log 是判定审计（decision = 判了什么），
   * shadow 期实际一律放行（reason 带 [shadow] 前缀），两难是「两条轴同时被要求」时留下的当时理由，
   * 一周后回看记后悔度。全部可选：缺实现时价值维护整体跳过，绝不伪造价值；gate 降级为不记录、不改输出。 */
  upsertSoulValue?(
    tenant: CoreTenant | undefined,
    insert: SoulValueInsert,
  ): MaybePromise<SoulValueRow | null>;
  retireSoulValue?(tenant: CoreTenant | undefined, valueId: string, at?: string): MaybePromise<boolean>;
  listSoulValues?(
    tenant?: CoreTenant,
    opts?: { status?: SoulValueStatus; source?: SoulValueSource; limit?: number },
  ): MaybePromise<SoulValueRow[]>;
  insertSoulGateLog?(
    tenant: CoreTenant | undefined,
    rows: SoulGateLogInsert[],
  ): MaybePromise<{ inserted: number }>;
  listSoulGateLog?(
    tenant?: CoreTenant,
    opts?: {
      decision?: SoulGateDecision;
      stage?: SoulGateStage;
      ruleId?: string;
      sinceIso?: string;
      shadowOnly?: boolean;
      limit?: number;
      offset?: number;
    },
  ): MaybePromise<SoulGateLogRow[]>;
  summarizeSoulGateLog?(tenant?: CoreTenant, opts?: { sinceIso?: string }): MaybePromise<SoulGateLogStats>;
  insertSoulDilemma?(
    tenant: CoreTenant | undefined,
    insert: SoulDilemmaInsert,
  ): MaybePromise<SoulDilemmaRow | null>;
  listSoulDilemmas?(
    tenant?: CoreTenant,
    opts?: { limit?: number; dueBefore?: string },
  ): MaybePromise<SoulDilemmaRow[]>;
  /** 事后回看：只改后悔度与后果事件，当时的两侧理由不许改写。 */
  reviewSoulDilemma?(
    tenant: CoreTenant | undefined,
    id: string,
    patch: { regret?: number; outcomeEventId?: string | null; reviewAt?: string },
  ): MaybePromise<SoulDilemmaRow | null>;
  /** 有边界的原话（privacy 规则判「隔墙有耳」时用）。缺实现 = privacy 规则无从判定，只跑其余三条。 */
  listSoulPrivateEventQuotes?(
    tenant?: CoreTenant,
    opts?: { limit?: number; minChars?: number },
  ): MaybePromise<SoulPrivateQuoteRow[]>;
  /* —— P6 叙事层（soul_narrative / soul_narrative_evidence，2026-11-10 §4.8）——
   * 自传是「章节」不是事件列表：每章必须有 1–3 条证据回指 soul_events，同一时段只许一条 active。
   * 遗忘 = 显著度衰减后停止注入，不删行（list 不过滤）。全部可选：缺实现时维护整体跳过，不伪造自传。 */
  listSoulNarrativeChapters?(
    tenant?: CoreTenant,
    filter?: SoulNarrativeListFilter,
  ): MaybePromise<SoulNarrativeRow[]>;
  getSoulNarrativeChapter?(tenant: CoreTenant | undefined, chapterId: string): MaybePromise<SoulNarrativeRow | null>;
  listSoulNarrativeEvidence?(
    tenant: CoreTenant | undefined,
    chapterId: string,
  ): MaybePromise<SoulNarrativeEvidenceRow[]>;
  commitSoulNarrativeChapter?(
    tenant: CoreTenant | undefined,
    input: SoulNarrativeCommitInput,
  ): MaybePromise<SoulNarrativeCommitResult>;
  /** 注入后记一次访问：只影响显著度的 access 加成，不改内容。 */
  touchSoulNarrativeAccess?(
    tenant: CoreTenant | undefined,
    chapterIds: string[],
    opts?: { now?: string },
  ): MaybePromise<{ updated: number }>;
  /* —— 人物身份层（soul_person，2026-11-08 阶段 1）——
   * 「谁」的稳定主键：L1 只存 {key, role} 引用，昵称变了不会分裂成第二个人。
   * 全部可选，兼容既有测试替身；缺失时 resolvePerson 降级为「只算 key、不落库」。 */
  upsertSoulPerson?(
    tenant: CoreTenant | undefined,
    person: SoulPersonUpsert,
  ): MaybePromise<{ personKey: string; created: boolean }>;
  getSoulPersonByPlatform?(
    tenant: CoreTenant | undefined,
    hint: { platform: string; platformId: string },
  ): MaybePromise<SoulPerson | null>;
  listSoulPersons?(tenant?: CoreTenant): MaybePromise<SoulPerson[]>;
  /** 合并只写 merged_into 指针（不搬数据），可原地撤销；拒绝自合并与成环。 */
  mergeSoulPerson?(
    tenant: CoreTenant | undefined,
    fromKey: string,
    intoKey: string,
  ): MaybePromise<{ merged: boolean; reason?: string }>;
  /* —— 人物档案（P2-H，2026-11-08 spec §5/§6/§13-A1/A4/A5/A6/A8）——
   * 档案字段写复用 commitSoulPersona（human 层行），这里只补「按人取记忆 / 候选统计 /
   * 水位 / 关系边」四类能力。全部可选：缺方法时提炼通道整体跳过（fail-open），
   * 不让旧替身因为多一个可选方法就编译不过。 */
  /** A1：最近 N 条把这个 person_key 记为 subject|speaker 的 L1（`mentioned` 不进档案输入）。 */
  listL1ByPerson?(
    tenant: CoreTenant,
    personKey: string,
    limit: number,
  ): MaybePromise<
    Array<{
      recordId: string;
      at: string;
      content: string;
      userId?: string;
      roleInRecord?: "subject" | "speaker" | "mentioned";
      /** 这条记忆是从哪几条 L0 原话抽出来的（提炼器取原话做逐字引文校验）。 */
      sourceMessageIds?: string[];
    }>
  >;
  /** A1：租户内每人被挂了几条记忆 + 最新时间（`HAVING COUNT >= 3` 在 SQL 里做）。 */
  listPersonProfileStats?(
    tenant: CoreTenant,
  ): MaybePromise<Array<{ personKey: string; memories: number; lastAt: string }>>;
  /** A8：提炼水位。`profileAt: null` = 从未跑过。 */
  listSoulPersonProfileWatermarks?(
    tenant?: CoreTenant,
  ): MaybePromise<Array<{ personKey: string; profileAt: string | null }>>;
  /** A8：提炼成功后写水位（失败不调 → 下一 tick 重试）。 */
  markSoulPersonProfileAt?(
    tenant: CoreTenant | undefined,
    personKey: string,
    at: string,
  ): MaybePromise<{ updated: boolean }>;
  /** A6：关系边按 subj/obj 两向查；缺省只回现行边（`valid_to IS NULL`）。 */
  listSoulPersonRelations?(
    tenant?: CoreTenant,
    opts?: { subjKey?: string; objKey?: string; includeClosed?: boolean },
  ): MaybePromise<SoulPersonRelationRow[]>;
  /** A4/A5：关系边一次事务写（新增幂等 / 反向边并证据 / outdated 置 valid_to）。 */
  commitSoulPersonRelations?(
    tenant: CoreTenant | undefined,
    plan: {
      insert?: SoulPersonRelationRow[];
      appendEvidence?: Array<{ relId: string; items: Array<{ recordId: string; at: string; quote: string }> }>;
      close?: Array<{ relId: string; at: string }>;
    },
  ): MaybePromise<{ inserted: number; merged: number; closed: number }>;
  /**
   * P2（spec §10.8）：给 event_id 为 NULL 的关系边做确定性回指。
   * 只认「唯一命中」：record_id 是 L1 id → source_message_ids → 事件证据，或用 quote 在 L0 精确/唯一子串
   * 匹配 → 事件证据；恰好 1 个事件才写 event_id，零命中或多命中写 status='unverifiable'
   * （保留事实、不进卡），不猜、不回退姓名/谓词。幂等：已有 event_id 或已 unverifiable 的不再扫。
   */
  backfillSoulPersonRelationEventIds?(
    tenant?: CoreTenant,
    opts?: { now?: string },
  ): MaybePromise<SoulPersonRelationBackfillResult>;
  /**
   * P2 §10.8 补事件（t13）：给「event_id 为 NULL 且 status=active」的关系，按 quote 在 L0
   * 同租户里唯一命中的那条原话补一条 chat 事件（source_kind=chat，证据 = 该 L0 record_id +
   * 逐字 quote），让回指能把它认成唯一事件。零命中/多命中一律不建（保持 unverifiable 语义）。
   * 幂等：dedupe_key = relation-backfill:<rel_id>，已建过的跳过；不生成任何 L0 之外的内容。
   */
  provisionSoulRelationEvents?(
    tenant?: CoreTenant,
    opts?: { now?: string },
  ): MaybePromise<SoulPersonRelationProvisionResult>;
  /**
   * P6 / t20：给「没有任何事件」的 episode 确定性补一条 chat 事件（老库 / 迁移库的健壮性）。
   *
   * 规则一个字不动：证据必须回指真实 soul_events；这里只是把「老库当时没建事件」这件事补上。
   * 只认唯一命中：引文（quote.text，缺省用 user_stance）先在 episode 自己的证据记录里精确/逐字
   * 子串匹配（恰好一条才算），再回落到全租户 L0。零命中/多命中/work 类/没有原文一律不建，
   * 计入 skippedUnprovisionable 并带 exampleEpisodeId——不允许再静默 0 章。
   * 幂等：event_id = episodeId、dedupe_key = soul-episode:<episodeId>（与双写同形），
   * 已存在 soul_events 行的 episode 不再扫；每 tick 最多 limit 条（缺省 50）。
   */
  provisionSoulEpisodeEvents?(
    tenant?: CoreTenant,
    opts?: { now?: string; limit?: number },
  ): MaybePromise<SoulEpisodeProvisionResult>;
  /* —— 关系状态层（P2 §4.4，2026-11-10）——
   * 事实（谁—谓词—谁）在 soul_person_relation；连续状态（信任/亲近/尊重/亏欠）在这里。
   * 写者只由维护 tick 调用；读面缺省=没有行（不编默认值假行）。全部可选，兼容既有替身。 */
  getSoulPersonState?(tenant: CoreTenant | undefined, personKey: string): MaybePromise<SoulPersonStateRow | null>;
  listSoulPersonStates?(tenant?: CoreTenant, opts?: { limit?: number }): MaybePromise<SoulPersonStateRow[]>;
  upsertSoulPersonState?(
    tenant: CoreTenant | undefined,
    insert: SoulPersonStateInsert,
  ): MaybePromise<SoulPersonStateRow>;
  /** 变化审计：id 幂等（同一事件重放不翻倍）。 */
  insertSoulPersonStateEvents?(
    tenant: CoreTenant | undefined,
    events: SoulPersonStateEventInsert[],
  ): MaybePromise<{ inserted: number }>;
  listSoulPersonStateEvents?(
    tenant?: CoreTenant,
    opts?: { personKey?: string; limit?: number },
  ): MaybePromise<SoulPersonStateEventRow[]>;
  /** 事件挖掘的输入：窗口内 L0 原始对话（user/assistant 都要，按时间正序）。
   *  单列出来的理由：人格要的是「原话」，不是摘要；queryL1Records 已经损失了声口。 */
  recentL0Messages?(
    tenant?: CoreTenant,
    opts?: { sinceDays?: number; maxMessages?: number; sinceIso?: string },
  ): MaybePromise<
    Array<{
      record_id: string;
      session_id: string;
      role: string;
      message_text: string;
      recorded_at: string;
      timestamp?: number;
      /** 真实说话人/agent 身份（L0 的真列）。缺列/老行时为空 → 调用侧走展示名回退。 */
      user_id?: string;
      agent_id?: string;
    }>
  >;
  /** S10：清库重生水位等一次性升级标记（key/value，落在 embedding_meta）。 */
  soulMetaGet?(key: string): MaybePromise<string | undefined>;
  soulMetaSet?(key: string, value: string): MaybePromise<void>;
  /** 拒绝原因分布（观测面：判据调得对不对，先看拒的都是什么）。P0-2 起读 soul_gate_stats。 */
  soulRejectionStats?(
    tenant?: CoreTenant,
    opts?: { sinceDays?: number },
  ): MaybePromise<SoulRejectionStat[]>;
  /** P0-2：门拒计数（按 day/code/layer 聚合 +1），替代逐条 reject 账本。 */
  bumpSoulGateStats?(
    tenant: CoreTenant | undefined,
    rows: SoulGateStatBump[],
  ): MaybePromise<{ bumped: number }>;
  listSoulGateStats?(
    tenant?: CoreTenant,
    opts?: { sinceDay?: string; code?: string; limit?: number },
  ): MaybePromise<SoulGateStat[]>;
  /** P0-2：告警抑制按 code 直查库（sinceIso 之后是否有同 code 的 alert 账本）。 */
  hasSoulAlertSince?(tenant: CoreTenant | undefined, code: string, sinceIso: string): MaybePromise<boolean>;

  /* —— #35（R5）：promise 承诺层数据面 ——
   * 义务不是倾向：promise 不参与价值锚生命周期（无 reweight/decay/形态合并，
   * 见 soul-promise.ts 头注释排除条款）。
   * 状态机单向：open → kept | broken | withdrawn（终态不可再迁，同态迁移亦拒绝）。
   * 双时态留痕：soul_promise_events 逐迁移 append（含创建事件 ∅→open），只增不改。 */
  upsertSoulPromise?(
    tenant: CoreTenant,
    input: { content: string; source: string; createdAt?: string; refKey?: string },
  ): MaybePromise<{ promiseId: string }>;
  /** 非法迁移/他租户 promiseId → { ok:false, reason }，零写入（不抛——裁决面非异常面）。
   *  #41：opts.source 落事件溯源列（manual/evidence/proposal，缺省 manual）。 */
  transitionSoulPromise?(
    tenant: CoreTenant,
    promiseId: string,
    to: SoulPromiseStatus,
    opts?: { at?: string; note?: string; source?: PromiseTransitionSource },
  ): MaybePromise<{ ok: true } | { ok: false; reason: string }>;
  listSoulPromises?(
    tenant: CoreTenant,
    opts?: { status?: SoulPromiseStatus; limit?: number },
  ): MaybePromise<SoulPromiseRecord[]>;
  readSoulPromiseEvents?(tenant: CoreTenant, promiseId: string): MaybePromise<SoulPromiseEvent[]>;
  /** P3：把 soul_promises.goal_id 挂到目标上（幂等；已挂同一目标返回 updated:false）。 */
  setSoulPromiseGoal?(
    tenant: CoreTenant | undefined,
    promiseId: string,
    goalId: string,
  ): MaybePromise<{ updated: boolean }>;

  /* —— 目标层（P3 §4.5，2026-11-10）——
   * 目标不是待办：soul_goals 记「我要/我答应/我计划」的一条，状态机 active→blocked→done|abandoned
   * 单向终态；soul_goal_events 是 append-only 账本（无租户列，读写都按 goal 归属校验）；
   * soul_goal_deps 记「等着谁」；soul_working_state 是每次注入都要读的那 300 字。
   * 写者只由维护 tick 调用；读面缺省=没有行（不写「暂无目标」占位）。全部可选，兼容既有替身。 */
  getSoulGoal?(tenant: CoreTenant | undefined, goalId: string): MaybePromise<SoulGoalRow | null>;
  listSoulGoals?(
    tenant?: CoreTenant,
    opts?: {
      status?: SoulGoalStatus;
      kind?: SoulGoalRow["kind"];
      owner?: SoulGoalRow["owner"];
      dueBefore?: string;
      limit?: number;
    },
  ): MaybePromise<SoulGoalRow[]>;
  upsertSoulGoal?(
    tenant: CoreTenant | undefined,
    insert: SoulGoalInsert,
  ): MaybePromise<{ row: SoulGoalRow; created: boolean }>;
  transitionSoulGoal?(
    tenant: CoreTenant | undefined,
    goalId: string,
    to: SoulGoalStatus,
    opts?: { at?: string; reason?: string; eventId?: string; note?: string },
  ): MaybePromise<{ ok: true; goal: SoulGoalRow; changed: boolean } | { ok: false; reason: string }>;
  insertSoulGoalEvents?(
    tenant: CoreTenant | undefined,
    events: SoulGoalEventInsert[],
  ): MaybePromise<{ inserted: number }>;
  listSoulGoalEvents?(
    tenant?: CoreTenant,
    opts?: { goalId?: string; limit?: number },
  ): MaybePromise<SoulGoalEventRow[]>;
  insertSoulGoalDep?(
    tenant: CoreTenant | undefined,
    dep: { goal_id: string; depends_on_goal_id: string; kind?: string },
  ): MaybePromise<{ inserted: number }>;
  listSoulGoalDeps?(tenant?: CoreTenant, opts?: { goalId?: string }): MaybePromise<SoulGoalDepRow[]>;
  upsertSoulWorkingState?(
    tenant: CoreTenant | undefined,
    row: SoulWorkingStateUpsert,
  ): MaybePromise<SoulWorkingStateRow>;
  getSoulWorkingState?(
    tenant?: CoreTenant,
    opts?: { sessionId?: string; now?: string },
  ): MaybePromise<SoulWorkingStateRow | null>;
  clearSoulWorkingState?(tenant?: CoreTenant, opts?: { sessionId?: string }): MaybePromise<{ deleted: number }>;

  // 2026-11-07：getIdentityDiscoveryState / setIdentityDiscoveryState 随 anchor_growth_state 下线删除，
  // 接口不再提供这两个可选方法（调用方归零）。
  getSelfObsStats?(): MaybePromise<{
    l1: number;
    conflict: number;
    evolve: number;
    similar: number;
    archived: number;
    anchors: number;
  }>;
  /** GROW-EVO P2.1（锚↔记忆双向链路）：锚采纳时把 label 回填进支持记录的 metadata.coreRefs（双表同步）。 */
  backfillCoreRef?(recordId: string, label: string, tenant?: CoreTenant): MaybePromise<boolean>;
  /**
   * PA（价值锚 per-agent 严格独立）：l1_records 的 distinct (team,user,agent) 三元组——
   * "有记忆的 agent"清单（default 锚扇出迁移与自生长 per-agent 化共用来源，单源禁第二份）。
   * 可选方法——旧 store 缺失时自生长回退 default 单桶（feature-detect 家族先例）。
   */
  listL1TenantTriplets?(): MaybePromise<CoreTenant[]>;
  /**
   * C2（spec §3.1 v2）：LLM 批量判定本租户 valence IS NULL 的价值锚（总结初值）。
   * 只判 NULL 行（用户微调优先，LLM 永不覆盖非 NULL；写回 UPDATE 带 `AND valence IS NULL`
   * 守卫，LLM 窗口内微调落库的值不被无条件覆盖）。fire-and-forget 安全。
   * llmRunner 用结构化最小类型（store 不依赖 core/types，避免环）。
   * 重置语义不在本方法（原 opts.reset 已移除）——重判入口用 resetValueValences +
   * apply-after-success 恢复（见 v2-router handleCoreMemoryValuesDerive）。
   */
  deriveValueValences?(
    tenant?: CoreTenant,
    llmRunner?: {
      run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number }): Promise<string>;
    },
  ): MaybePromise<{ derived: number; skipped: number }>;
  /**
   * REG-REMAINING-003 #1：列出存在 valence IS NULL 活跃锚的租户三元组（boot 逐租户 derive 的输入）。
   * 可选方法——旧后端缺失时 boot 回退 default 单桶（feature-detect 家族先例）。
   * 隔离口径：triplet 源与 deriveValueValences 消费过滤同表，消费方按三元组参数回传，无跨租户聚合写。
   */
  listNullValenceTenantTriplets?(): MaybePromise<CoreTenant[]>;
  /**
   * Important-1（C2 复审，apply-after-success）：重置本租户 valence（重判入口专用）。
   * 快照现有非 NULL (value_id, valence) 对并置 NULL，快照由调用方持有；LLM 判定完成后
   * 失败/不可判定行用 restoreValueValences 从快照恢复原值（微调值不永久丢失）。
   * C6 清债裁定：快照只含 state='active' 行——vetoed/retired 行置 NULL 后保持 NULL
   * （否决语义：veto = 用户否决方向，不进快照、不复活，直到重新采纳）。
   */
  resetValueValences?(tenant?: CoreTenant): MaybePromise<Array<{ value_id: string; valence: number }>>;
  /** 从快照恢复仍为 NULL 的 valence（逐行 `valence IS NULL` 守卫），返回真实恢复行数。 */
  restoreValueValences?(
    tenant?: CoreTenant,
    snapshot?: Array<{ value_id: string; valence: number }>,
  ): MaybePromise<number>;
  /**
   * R-A2（R5，结构感知召回 spec §2）：按 coreRefs 价值锚 label 反查 L1 记忆（候选池补池）。
   * 可选方法——tcvdb 等后端可不实现（F7 家族先例，调用方 feature-detect，缺失=补池通道静默关闭）。
   * 返回行 score 恒 0（无相关度实证）；租户 filter 由实现负责（T14 同形）。
   */
  searchL1ByCoreRefs?(labels: string[], limit?: number, filter?: IsolationFilter): MaybePromise<Array<L1SearchResult>>;
  /**
   * task-9（2026-11-04，来源证据主键）：按 source_message_ids（L0 原话 id）反查 L1 记忆。
   * 提取期用它把「同一批原话的再提取」认出来：既有行来源集合 ⊇ 新记忆来源集合 → 决策改 update。
   * 可选方法——tcvdb 等后端可不实现（feature-detect，缺失 = 同源覆盖判定静默关闭，fail-open）。
   * 返回 = 命中行的 record_id + 解析后的来源 id 数组（JSON 文本不泄漏到调用方）；租户 filter 由实现负责。
   */
  findL1BySourceMessageIds?(
    ids: string[],
    filter?: IsolationFilter,
  ): MaybePromise<Array<{ record_id: string; source_message_ids: string[] }>>;
  /**
   * R7-2（分层召回 spec DS-RECALL-LAYERED-R7-001 §2）：按场景名反查 L1 记忆（同 scene 过滤，
   * 层级前缀 `scene = ? OR scene LIKE ? || '/%'` 与 sceneSignalOf 前缀语义对称）。
   * 可选方法——tcvdb 等后端可不实现（feature-detect，缺失 = scene 反查补池通道静默关闭）。
   * 返回行 score 恒 0（无相关度实证）；租户 filter 由实现负责（T14 同形）。
   */
  searchL1ByScene?(sceneNames: string[], limit?: number, filter?: IsolationFilter): MaybePromise<Array<L1SearchResult>>;
  /**
   * V2-3（引擎三 E3.2，DS-RECALL-V2-THREE-ENGINES-001）：按 type 取行，significance DESC
   *（top-significance durative 结论源——分析型 query 结论层放宽）。可选方法——tcvdb 等
   * 后端可不实现（feature-detect，缺失 = 放宽通道退出，宁缺毋滥降级）。
   * 返回行 score 恒 0（位次由调用方赋予）；租户 filter 由实现负责（T14 两步过滤同形）。
   */
  searchL1ByType?(type: string, limit?: number, filter?: IsolationFilter): MaybePromise<Array<L1SearchResult>>;
  /**
   * S1（K7/M-5，agent 可维护价值锚成立）：按租户删价值锚。可选方法——
   * 返回 true = 真删了一行；false = 该租户下不存在（调用方按 404 回报）或 SQL 失败。
   */
  deleteValue?(valueId: string, tenant?: CoreTenant): MaybePromise<boolean>;

  // ── L1 Search ────────────────────────────────────────────

  searchL1Vector(
    queryEmbedding: Float32Array,
    topK?: number,
    queryText?: string,
    filter?: IsolationFilter,
  ): MaybePromise<L1SearchResult[]>;
  /**
   * W1/C（#137）：事实键平行召回通道——把「事实短语键」的 embedding 单独存一张 vec0 表
   * （与 l1_vec 同维、同余弦度量），原文主索引 l1_vec 不动。可选方法——tcvdb 等后端可不实现
   * （调用方 feature-detect，缺失 = 通道静默关闭）。零向量/未就绪/degraded → false（不写）。
   */
  upsertL1FactVector?(recordId: string, embedding: Float32Array, updatedTime?: string): MaybePromise<boolean>;
  /**
   * W1/C（#137）：按事实键向量检索，与 searchL1Vector 同形（score = 1 - cosine distance）；
   * 行形状 = L1SearchResult（metadata 从 l1_records 读，租户 filter 两步过滤，null distance 跳过）。
   */
  searchL1FactVector?(
    queryEmbedding: Float32Array,
    topK?: number,
    filter?: IsolationFilter,
  ): MaybePromise<L1SearchResult[]>;
  /**
   * B1 修正（2026-11-02）：按 record_id 批量读 l1_vec 已入库向量（巩固层属性归组的
   * embedding 兜底复用它们，不再逐条重嵌）。可选方法——未实现 = 调用方只做有上限的补齐；
   * 未就绪/degraded/SQL 失败 → 空 Map（不抛，不重试）。
   */
  getL1VectorsByIds?(ids: string[]): MaybePromise<Map<string, Float32Array>>;
  /**
   * FTS5 关键词检索。
   *
   * `opts.type`（2026-11-03，可选）：**先按 type 过滤再 LIMIT** 的收窄检索。结论层只消费
   * work_fact，旧写法让长文 consolidated 卡与短 episodic 行在同一 bm25 池子里竞争 top-N，
   * 被系统性挤出榜外。不传 opts 时逐位等于旧行为。
   */
  searchL1Fts(
    ftsQuery: string,
    limit?: number,
    filter?: IsolationFilter,
    opts?: { type?: string },
  ): MaybePromise<L1FtsResult[]>;
  searchL1Hybrid?(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: Array<[number, number]>;
    topK?: number;
    filter?: IsolationFilter;
  }): MaybePromise<L1SearchResult[]>;

  // ── L0 Write ─────────────────────────────────────────────

  upsertL0(record: L0Record, embedding?: Float32Array): MaybePromise<boolean>;
  /** Update only the vector embedding for an existing L0 record (sqlite background path). */
  updateL0Embedding?(recordId: string, embedding: Float32Array): MaybePromise<boolean>;
  deleteL0(recordId: string, filter?: IsolationFilter): MaybePromise<boolean>;
  deleteL0Expired(cutoffIso: string): MaybePromise<number>;

  // ── L0 Read ──────────────────────────────────────────────

  countL0(filter?: L0CountFilter): MaybePromise<number>;
  queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit?: number): MaybePromise<L0QueryRow[]>;
  queryL0GroupedBySessionId(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit?: number,
  ): MaybePromise<L0SessionGroup[]>;
  getAllL0Texts(): MaybePromise<Array<{ record_id: string; message_text: string; recorded_at: string }>>;
  /**
   * v4#5 验证轮补口（2026-09-16 深夜）：枚举 L0 会话键（boot recovery 数据源二）。
   * 可选能力：未实现时调用方回退 checkpoint runner_states（现状语义）。
   * 动机：飞行中提取被重启打断的会话游标未落 checkpoint，仅凭 runner_states 不可见
   * （session-h 实锤：12 条全部滞留）。
   */
  listL0SessionIds?(): MaybePromise<string[]>;
  /** D-R3-2（任务6，2026-09-24）：L0 会话键存在性查询——boot recovery 死键过滤数据前提。
   *  与 listL0SessionIds 同族语义（session_id 跨租户全局键，无租户参数）；只读零写库；
   *  可选签名：缺实现时调用侧不过滤=现状语义（少滤不少挂）。 */
  hasL0Session?(sessionId: string): boolean;
  /** F-DUP-1（任务5，2026-09-25）：L0 入口幂等查重——同 session+role+content 在 windowMs
   *  窗口内已有落库行则 true。与 listL0SessionIds/hasL0Session 同族（跨租户键，无租户参数——
   *  session_key 全局唯一）。可选签名：缺实现=调用侧逐条照收（现状语义）。 */
  hasRecentL0Duplicate?(sessionKey: string, role: string, content: string, windowMs: number): MaybePromise<boolean>;

  // ── L0 Search ────────────────────────────────────────────

  searchL0Vector(
    queryEmbedding: Float32Array,
    topK?: number,
    queryText?: string,
    filter?: IsolationFilter,
  ): MaybePromise<L0SearchResult[]>;
  searchL0Fts(ftsQuery: string, limit?: number, filter?: IsolationFilter): MaybePromise<L0FtsResult[]>;
  searchL0Hybrid?(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: Array<[number, number]>;
    topK?: number;
    filter?: IsolationFilter;
  }): MaybePromise<L0SearchResult[]>;

  pullProfiles?(): Promise<ProfileRecord[]>;
  /**
   * 按 profile stable id 批量查询（轻量，仅查指定 id）。
   * 当 store 支持时，调用方应优先使用此接口而非 pullProfiles() 全量拉取。
   * 不支持的 store 返回 undefined → 调用方 fallback 到 pullProfiles()。
   */
  queryProfilesByIds?(ids: string[]): Promise<ProfileRecord[]>;
  countProfiles?(filter?: ProfileCountFilter): Promise<number>;
  syncProfiles?(records: ProfileSyncRecord[]): Promise<void>;
  deleteProfiles?(recordIds: string[]): Promise<void>;

  // ── Re-index ─────────────────────────────────────────────

  reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }>;

  // ── FTS (always sync — cached flag) ──────────────────────

  isFtsAvailable(): boolean;

  // ── v2 API: Paginated queries (optional — added for Gateway v2) ──

  /**
   * L0 paginated query for v2 API `/conversation/query`.
   * Returns rows matching the filter, paginated by limit/offset,
   * plus the total count of matching rows.
   */
  queryL0Paginated?(filter: L0PaginatedFilter): MaybePromise<L0PaginatedResult>;

  /**
   * L0 batch read by record_id (ADR-0025 行级溯源: L1.source_message_ids → 原始消息).
   * 空 ids 必须直接返回 []（不拼 SQL）；缺失 id 静默跳过；返回序按 timestamp 升序。
   * 可选能力：未实现时网关 503 明示（fail-loud，不静默伪装成空结果）。
   */
  queryL0ByIds?(ids: string[], filter?: L0ByIdsFilter): MaybePromise<L0QueryRow[]>;

  /**
   * L1 paginated query for v2 API `/atomic/query`.
   * Returns rows matching the filter, paginated by limit/offset,
   * plus the total count of matching rows.
   */
  queryL1Paginated?(filter: L1PaginatedFilter): MaybePromise<L1PaginatedResult>;

  /**
   * Delete all L0 messages belonging to a session.
   * Returns the actual number of rows deleted.
   * Used by v2 API `/conversation/delete` (session mode).
   */
  deleteL0BySession?(sessionId: string, filter?: IsolationFilter): MaybePromise<number>;

  /**
   * 清空某个 (team, agent) 下的全部记忆内容：L0 + L1 + L2/L3 profile 行，
   * 连同它们的向量 / FTS 附属数据。**不触碰** meta_* 资产表 —— 资产 ID、
   * 归属、绑定、ACL、可见性、名称全部保留。
   *
   * 用于 `/v3/chat-memory/clear`。幂等：已清空的 memory 再次调用返回全 0。
   * 实现必须校验 filter.teamId / filter.agentId 非空，否则抛错拒绝执行。
   */
  clearMemoryContent?(filter: MemoryContentClearFilter): MaybePromise<MemoryContentClearResult>;

  // ── Entity metadata (Team / User / Agent / Task) ───────────
  createTeam?(
    input: Omit<TeamEntity, "created_at" | "updated_at" | "status" | "user_ids" | "agent_ids" | "task_ids"> & {
      team_id?: string;
      status?: TeamStatus;
    },
  ): MaybePromise<TeamEntity>;
  getTeam?(teamId: string): MaybePromise<TeamEntity | null>;
  updateTeam?(
    teamId: string,
    patch: Partial<Pick<TeamEntity, "name" | "description" | "owner_user_id" | "user_ids" | "agent_ids" | "status">>,
  ): MaybePromise<TeamEntity | null>;
  deleteTeams?(teamIds: string[]): MaybePromise<BatchDeleteResult>;

  createUser?(
    input: Pick<UserEntity, "name"> & Partial<Pick<UserEntity, "job_description" | "status">> & { user_id?: string },
  ): MaybePromise<UserEntity>;
  getUser?(userId: string): MaybePromise<UserEntity | null>;
  updateUser?(
    userId: string,
    patch: Partial<Pick<UserEntity, "name" | "job_description" | "status">>,
  ): MaybePromise<UserEntity | null>;
  deleteUsers?(userIds: string[]): MaybePromise<BatchDeleteResult>;

  createAgent?(
    input: Omit<AgentEntity, "created_at" | "updated_at" | "status" | "visibility"> & {
      agent_id?: string;
      status?: AgentStatus;
      visibility?: AgentVisibility;
    },
  ): MaybePromise<AgentEntity>;
  getAgent?(agentId: string): MaybePromise<AgentEntity | null>;
  updateAgent?(
    agentId: string,
    patch: Partial<Pick<AgentEntity, "name" | "description" | "prompt" | "owner_user_id" | "visibility" | "status">>,
  ): MaybePromise<AgentEntity | null>;
  deleteAgents?(agentIds: string[]): MaybePromise<BatchDeleteResult>;

  createTask?(
    input: Omit<TaskEntity, "created_at" | "updated_at" | "source_type" | "agent_ids" | "user_ids"> & {
      task_id?: string;
      source_type?: TaskSourceType;
      agent_ids?: string[];
      user_ids?: string[];
    },
  ): MaybePromise<TaskEntity>;
  getTask?(taskId: string): MaybePromise<TaskEntity | null>;
  updateTask?(
    taskId: string,
    patch: Partial<Pick<TaskEntity, "title" | "description" | "source_type" | "source_url" | "agent_ids" | "user_ids">>,
  ): MaybePromise<TaskEntity | null>;
  deleteTasks?(taskIds: string[]): MaybePromise<BatchDeleteResult>;

  // ── Knowledge entity (wiki / code-graph metadata) ───────────
  createKnowledge?(input: Omit<KnowledgeEntity, "created_at" | "updated_at">): MaybePromise<KnowledgeEntity>;
  getKnowledge?(knowledgeId: string): MaybePromise<KnowledgeEntity | null>;
  updateKnowledge?(
    knowledgeId: string,
    patch: Partial<Pick<KnowledgeEntity, "name" | "summary" | "service_url" | "repo_url" | "branch">>,
  ): MaybePromise<KnowledgeEntity | null>;
  deleteKnowledge?(knowledgeIds: string[], teamId?: string): MaybePromise<BatchDeleteResult>;
  listKnowledge?(input: {
    team_id: string;
    type?: KnowledgeType;
    knowledge_ids?: string[];
    limit?: number;
    offset?: number;
  }): MaybePromise<KnowledgeListResult>;

  // ── Memory Audit（修改审计；optional 让 store 可以选择不实现）──
  appendAudit?(entry: AuditEntry): MaybePromise<void>;
  queryAudit?(filter: AuditQueryFilter): MaybePromise<AuditEntry[]>;
}

// ============================
// IEmbeddingService — re-exported from embedding.ts for convenience
// ============================

/**
 * Re-export EmbeddingService as IEmbeddingService for backward compatibility.
 * The canonical definition lives in `./embedding.ts`. All concrete implementations
 * (LocalEmbeddingService, OpenAIEmbeddingService, NoopEmbeddingService) implement
 * the EmbeddingService interface from embedding.ts.
 */
export type { EmbeddingService as IEmbeddingService } from "./embedding.js";
