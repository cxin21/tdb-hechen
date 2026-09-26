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
import type { EmbeddingProviderInfo } from "./embedding.js";
import type { Logger } from "../types.js";
import type { IsolationFilter } from "./isolation.js";
import { DEFAULT_ISOLATION_ID } from "./isolation.js";
import type { MemoryPromptStore } from "../memory-prompt/types.js";
import type { MemoryGenerationRefStore } from "../memory-generation-log/types.js";

// Re-export so consumers can import everything from types.ts
export type { MemoryRecord, EmbeddingProviderInfo };

// Re-export isolation primitives so all store consumers import from here.
export type {
  IsolationContext,
  IsolationFilter,
  IsolationConfig,
} from "./isolation.js";
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
 * P2-T12（K1）：core_memory / core_values 的租户归属三元组（全必填，无"不筛"语义）。
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
  /** Similarity score (0–1, higher is better). */
  score: number;
  timestamp_str: string;
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

  // ── 灵魂记忆字段（P2a，读回）：时空/观察推断/情感 ──
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
  /** D-3：敏感性枚举（none/health/finance/relationship）。 */
  sensitivity?: string;
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
  timestamp_str: string;
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
  // soul 8 字段（P1-T7 / W1）：列名以 soul-columns.ts SOUL_COL_NAMES 为单一事实源，
  // 类型口径与 L1RecordRow 的 soul 字段一致（occurred_at?: string / valence?: number…）。
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
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
  timestamp_start: string;
  timestamp_end: string;
  created_time: string;
  updated_time: string;
  metadata_json: string;
  /** soul 8 列（P4a：rowToMemoryRecord 的 valid_end 透传所需；SELECT 已带出、类型此前未声明） */
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
  sensitivity?: string;
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
export type TaskSourceType = "manual" | "github" | "tapd" | "other";

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
  action: "update" | "delete";
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
  action?: "update" | "delete";
  team_id?: string;
  agent_id?: string;
  user_id?: string;
  task_id?: string;
  /** 只返 updated_at_ms ≥ since_ms 的事件。 */
  since_ms?: number;
  /** 只返 updated_at_ms ≤ until_ms 的事件。 */
  until_ms?: number;
  limit?: number;   // 默认 100，上限 1000
  offset?: number;
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
  /**
   * T15-B（向量健康三件套）：最近一次成功向量写入的 ISO 时间戳。
   * 进程内内存值（非持久化，重启归零为 null）；upsertL1 成功写向量时更新。
   * 供 /health 的 memory.lastVecWriteAt 读取；旧后端可不实现。
   */
  getLastVecWriteAt?(): string | null;
  queryL1Records(filter?: L1QueryFilter): MaybePromise<L1RecordRow[]>;
  getAllL1Texts(): MaybePromise<Array<{ record_id: string; content: string; updated_time: string }>>;

  // ── 记忆图（G）：L1↔L1 显式边 ──
  addLink?(sourceId: string, targetId: string, type: string, strength?: number, now?: string): MaybePromise<boolean>;
  /** GROW-EVO P2（§2.2）：失效回写——只写 valid_end，不覆盖已失效行（失效不删除）。可选：旧后端安静跳过。 */
  invalidateL1?(id: string, validEndIso: string): MaybePromise<boolean>;
  /** P2-T14（G2）：可选租户 filter——缺省 undefined=旧行为；传入时两步过滤（rowMatchesIsolation 复核）。 */
  getNeighbors?(id: string, types?: string[], maxHop?: number, filter?: IsolationFilter): MaybePromise<Array<{ id: string; type: string; strength: number; hop: number }>>;
  /** P4a-P2（层级边，REG-REMAINING-002 #1）：沿边反查（target←sources）/正查（source→targets）；可选 type 过滤。derived_from 边 source=L2 scene block（profile:v1:* 稳定租户唯一）、target=L1 record。可选方法——旧后端可不实现，调用方 feature-detect。 */
  getLinksByTarget?(targetId: string, type?: string): MaybePromise<Array<{ sourceId: string; type: string; strength: number; createdAt: string }>>;
  getLinksBySource?(sourceId: string, type?: string): MaybePromise<Array<{ targetId: string; type: string; strength: number; createdAt: string }>>;
  /** P4b（REG-REMAINING-005 #1）：按 type 全量取边（evolution-worker conflict 扫描底座，单条索引查询）。可选方法——旧后端可不实现，调用方 feature-detect。 */
  getLinksByType?(type: string): MaybePromise<Array<{ sourceId: string; targetId: string; type: string; strength: number; createdAt: string }>>;
  /**
   * C6（graph 设计 §4 / spec §6.4 #1）：两节点间 BFS 最短路径；不可达返回 null，
   * 起点即终点返回 []。可选租户 filter（T14 同形：新图接口第一天即带 isolation）。
   * 可选方法——tcvdb 等后端可不实现（F7 家族先例），调用方 feature-detect。
   */
  getPath?(startId: string, endId: string, maxHop?: number, types?: string[], filter?: IsolationFilter): MaybePromise<Array<{ id: string; type: string; strength: number; hop: number }> | null>;
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
  listArchived?(limit?: number, offset?: number, filter?: IsolationFilter): MaybePromise<Array<{ record_id: string; archived_at: string; reason: string; content: string; occurred_at?: string; team_id: string; user_id: string; agent_id: string }>>;
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
  readCore?(tenant?: CoreTenant): MaybePromise<Array<{ slot: string; content: string; source: string; version: number; updated_at: string }>>;
  /**
   * GROW：origin（seed|manual|auto，来源徽标；缺省 manual）。冲突路径 state='active'
   * （显式重建=撤销退休/否决；自动管道的 veto 不可重提由自生长去重查全态保证）。
   */
  upsertValue?(valueId: string, label: string, weight: number, createdBy?: string, tenant?: CoreTenant, valence?: number, origin?: "seed" | "manual" | "auto", nodeType?: "theme" | "person" | "character", attrs?: { role?: string; aliases?: string[]; source?: string; facts?: string[]; description?: string }): MaybePromise<boolean>;
  /** P2：通用 refs 回填键族（coreRefs/personRefs/identityRefs 单源；旧后端可缺省）。 */
  backfillMemoryRef?(recordId: string, key: "coreRefs" | "personRefs" | "identityRefs", label: string, tenant?: CoreTenant): MaybePromise<boolean>
  /** O13（P2）：core_pending——红线类提案人工采纳落点（三方法，缺省=store 不支持时调用方安静跳过）。 */
  upsertPendingCore?(slot: string, content: string, evidence: number, tenant?: CoreTenant, extra?: { label?: string; description?: string }): MaybePromise<boolean>;
  listPendingCore?(tenant?: CoreTenant, opts?: { includeDecided?: boolean }): MaybePromise<Array<{ pending_id: string; slot: string; content: string; evidence: number; state: string; created_at: string; decided_at: string | null; label?: string | null; description?: string | null }>>;
  decidePendingCore?(pendingId: string, decision: "adopted" | "rejected", tenant?: CoreTenant): MaybePromise<{ slot: string; content: string; label?: string | null; description?: string | null } | null>;
  /**
   * GROW：出参带 origin/pinned/state；默认只回 state='active'（退休/否决锚退出匹配面
   * =预期行为）；opts.includeRetired=true → active+retired（Panel 退休区；vetoed 永不出现在读面）。
   */
  listValues?(tenant?: CoreTenant, opts?: { includeRetired?: boolean }): MaybePromise<Array<{ value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed" }>>;  /** S-FEEL-1（M1/IF-1）：近期情感信号只读查询——M1 近期基调行数据源。可选签名（ILogBackend debug? 先例）：
   *  缺实现时调用侧静默省略基调行（宁缺毋滥）。租户三元组硬隔离（F18 同款）；样本窗=occurred_at ≥ now−windowHours
   *  （UTC ISO 字典序比较），occurred_at DESC 取 ≤maxSamples；valence IS NOT NULL。只读、零写库、零 LLM。 */
  recentAffectSignals?(tenant?: CoreTenant, opts?: { windowHours: number; maxSamples: number }): MaybePromise<Array<{ valence: number; arousal: number | null; occurred_at: string }>>;
  /** S-CHAR-2（M2/P1/IF-1 同族）：锚证据 valence 只读查询——品格张力 T2 数据源。可选签名（recentAffectSignals 同位先例）：
   *  缺实现时调用侧静默省略张力候选（宁缺毋滥）。租户三元组硬隔离（F18 同款）；metadata_json coreRefs/identityRefs
   *  键族展开为 {label, valence, ref_kind} 行（identityRefs=20 字切片弱口径，如实透传由消费方匹配）；只读、零写库、零 LLM。 */
  anchorEvidenceValences?(tenant?: CoreTenant): MaybePromise<Array<{ label: string; valence: number; ref_kind: "coreRefs" | "identityRefs" }>>;

  /** GROW：全态读（自生长去重「veto 永不重提」+ server 种子判空专用；无缓存/无兜底）。 */
  listValuesAnyState?(tenant?: CoreTenant): MaybePromise<Array<{ value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed" }>>;
  /** GROW（钉住）：pinned 翻转；只作用 active|retired（vetoed 拒绝）。 */
  setValuePinned?(valueId: string, pinned: boolean, tenant?: CoreTenant): MaybePromise<boolean>;
  /** GROW（手动退休）：state → 'retired'（退休区可见，可恢复/可钉住）。 */
  retireValue?(valueId: string, tenant?: CoreTenant): MaybePromise<boolean>;
  /** GROW（恢复）：retired → active；vetoed 拒绝。 */
  restoreValue?(valueId: string, tenant?: CoreTenant): MaybePromise<boolean>;
  /**
   * PA：自生长调度状态读（interval/语料基线；重启不失忆）。
   * tenant 缺省/default 桶 = 旧键旧行为；非 default 三元组 = per-agent 独立基线。
   */
  getAnchorGrowthState?(tenant?: CoreTenant): MaybePromise<{ lastDiscoveryAt: string | null; lastCorpusCount: number | null; lastAttemptAt?: string | null; lastAdoptedAt?: string | null; lastMaintAt?: string | null }>;
  /** GROW：自生长调度状态写（发现轮次完成后调用）。PA：tenant 语义同 getAnchorGrowthState。
   *  GROW-MAINT：lastAttemptAt/lastAdoptedAt 可选——冷却分级（0 采纳 1h 短冷却 / 有采纳 intervalHours）。 */
  setAnchorGrowthState?(state: { lastDiscoveryAt: string; lastCorpusCount: number; lastAttemptAt?: string; lastAdoptedAt?: string; lastMaintAt?: string }, tenant?: CoreTenant): MaybePromise<void>;
  /** SOUL：身份自发现状态（identity_* 前缀键族，与锚状态独立） */
  getIdentityDiscoveryState?(tenant?: CoreTenant): MaybePromise<{ lastAttemptAt: string | null; lastCorpusCount: number | null }>;
  setIdentityDiscoveryState?(state: { lastAttemptAt: string; lastCorpusCount: number }, tenant?: CoreTenant): MaybePromise<void>;
  /** 自维护观测（REG-REMAINING-001 D8）：系统自计数（conflict 边/归档/锚/语料）。 */
  getSelfObsStats?(): MaybePromise<{ l1: number; conflict: number; evolve: number; similar: number; archived: number; anchors: number }>;
  /** GROW-EVO P2.1（锚↔记忆双向链路）：锚采纳时把 label 回填进支持记录的 metadata.coreRefs（双表同步）。 */
  backfillCoreRef?(recordId: string, label: string, tenant?: CoreTenant): MaybePromise<boolean>
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
    llmRunner?: { run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number }): Promise<string> },
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
  restoreValueValences?(tenant?: CoreTenant, snapshot?: Array<{ value_id: string; valence: number }>): MaybePromise<number>;
  /**
   * R-A2（R5，结构感知召回 spec §2）：按 coreRefs 价值锚 label 反查 L1 记忆（候选池补池）。
   * 可选方法——tcvdb 等后端可不实现（F7 家族先例，调用方 feature-detect，缺失=补池通道静默关闭）。
   * 返回行 score 恒 0（无相关度实证）；租户 filter 由实现负责（T14 同形）。
   */
  searchL1ByCoreRefs?(labels: string[], limit?: number, filter?: IsolationFilter): MaybePromise<Array<L1SearchResult>>;
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

  searchL1Vector(queryEmbedding: Float32Array, topK?: number, queryText?: string, filter?: IsolationFilter): MaybePromise<L1SearchResult[]>;
  searchL1Fts(ftsQuery: string, limit?: number, filter?: IsolationFilter): MaybePromise<L1FtsResult[]>;
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
  queryL0GroupedBySessionId(sessionKey: string, afterRecordedAtMs?: number, limit?: number): MaybePromise<L0SessionGroup[]>;
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

  searchL0Vector(queryEmbedding: Float32Array, topK?: number, queryText?: string, filter?: IsolationFilter): MaybePromise<L0SearchResult[]>;
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
  createTeam?(input: Omit<TeamEntity, "created_at" | "updated_at" | "status" | "user_ids" | "agent_ids" | "task_ids"> & { team_id?: string; status?: TeamStatus }): MaybePromise<TeamEntity>;
  getTeam?(teamId: string): MaybePromise<TeamEntity | null>;
  updateTeam?(teamId: string, patch: Partial<Pick<TeamEntity, "name" | "description" | "owner_user_id" | "user_ids" | "agent_ids" | "status">>): MaybePromise<TeamEntity | null>;
  deleteTeams?(teamIds: string[]): MaybePromise<BatchDeleteResult>;

  createUser?(input: Pick<UserEntity, "name"> & Partial<Pick<UserEntity, "job_description" | "status">> & { user_id?: string }): MaybePromise<UserEntity>;
  getUser?(userId: string): MaybePromise<UserEntity | null>;
  updateUser?(userId: string, patch: Partial<Pick<UserEntity, "name" | "job_description" | "status">>): MaybePromise<UserEntity | null>;
  deleteUsers?(userIds: string[]): MaybePromise<BatchDeleteResult>;

  createAgent?(input: Omit<AgentEntity, "created_at" | "updated_at" | "status" | "visibility"> & { agent_id?: string; status?: AgentStatus; visibility?: AgentVisibility }): MaybePromise<AgentEntity>;
  getAgent?(agentId: string): MaybePromise<AgentEntity | null>;
  updateAgent?(agentId: string, patch: Partial<Pick<AgentEntity, "name" | "description" | "prompt" | "owner_user_id" | "visibility" | "status">>): MaybePromise<AgentEntity | null>;
  deleteAgents?(agentIds: string[]): MaybePromise<BatchDeleteResult>;

  createTask?(input: Omit<TaskEntity, "created_at" | "updated_at" | "source_type" | "agent_ids" | "user_ids"> & { task_id?: string; source_type?: TaskSourceType; agent_ids?: string[]; user_ids?: string[] }): MaybePromise<TaskEntity>;
  getTask?(taskId: string): MaybePromise<TaskEntity | null>;
  updateTask?(taskId: string, patch: Partial<Pick<TaskEntity, "title" | "description" | "source_type" | "source_url" | "agent_ids" | "user_ids">>): MaybePromise<TaskEntity | null>;
  deleteTasks?(taskIds: string[]): MaybePromise<BatchDeleteResult>;

  // ── Knowledge entity (wiki / code-graph metadata) ───────────
  createKnowledge?(input: Omit<KnowledgeEntity, "created_at" | "updated_at">): MaybePromise<KnowledgeEntity>;
  getKnowledge?(knowledgeId: string): MaybePromise<KnowledgeEntity | null>;
  updateKnowledge?(knowledgeId: string, patch: Partial<Pick<KnowledgeEntity, "name" | "summary" | "service_url" | "repo_url" | "branch">>): MaybePromise<KnowledgeEntity | null>;
  deleteKnowledge?(knowledgeIds: string[], teamId?: string): MaybePromise<BatchDeleteResult>;
  listKnowledge?(input: { team_id: string; type?: KnowledgeType; knowledge_ids?: string[]; limit?: number; offset?: number }): MaybePromise<KnowledgeListResult>;

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
