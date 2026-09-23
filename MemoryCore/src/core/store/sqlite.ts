/**
 * VectorStore: SQLite-based vector storage using sqlite-vec extension.
 *
 * Manages two layers of vector-indexed data in a single SQLite database:
 *
 * **L1 (structured memories):**
 * 1. `l1_records` — relational metadata table (content, type, priority, scene, timestamps)
 * 2. `l1_vec` — vec0 virtual table for cosine similarity search
 *
 * **L0 (raw conversations):**
 * 3. `l0_conversations` — relational metadata table (session_key, role, message text, timestamps)
 * 4. `l0_vec` — vec0 virtual table for cosine similarity search on individual messages
 *
 * Dependencies: Node.js built-in `node:sqlite` (Node 22+) + `sqlite-vec` (from root workspace).
 *
 * Design:
 * - All operations are synchronous (DatabaseSync API).
 * - Writes use manual BEGIN/COMMIT transactions for atomicity (metadata + vector).
 * - vec0 virtual table does NOT support ON CONFLICT, so upsert = delete + insert.
 * - Thread-safe via WAL mode.
 */

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync, SQLInputValue } from "node:sqlite";
import type { MemoryRecord } from "../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type {
  IMemoryStore,
  StoreCapabilities,
  L0Record,
  L1SearchResult,
  L1FtsResult,
  L0SearchResult,
  L0FtsResult,
  L0QueryRow,
  L1RecordRow,
  L1QueryFilter,
  L0CountFilter,
  L0PaginatedFilter,
  L0PaginatedResult,
  L1CountFilter,
  L1PaginatedFilter,
  L1PaginatedResult,
  IsolationFilter,
  TeamEntity,
  UserEntity,
  AgentEntity,
  TaskEntity,
  KnowledgeEntity,
  KnowledgeType,
  KnowledgeListResult,
  BatchDeleteResult,
  MemoryContentClearFilter,
  MemoryContentClearResult,
  AuditEntry,
  AuditQueryFilter,
} from "./types.js";
import { DEFAULT_ISOLATION_ID, normalizeCoreTenant, rowMatchesIsolation, type CoreTenant } from "./types.js";
import { buildIsolationWhere } from "./isolation.js";
import { SOUL_COLUMNS, SOUL_COL_NAMES, SOUL_SELECT_FRAGMENT, type SoulColumnName } from "./soul-columns.js";
import { SKILLS_DDL, SKILL_FTS_DDL } from "../skill/skill-store-ddl.js";
import type { Logger } from "../types.js";
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

export type { L1RecordRow } from "./types.js";

// ============================
// L1 FTS 列清单（单一事实源：基础 17 列固定 + soul 8 列由 SOUL_COLUMNS 展开）
// 建表 DDL / INSERT 语句 / 旧库迁移全部由这里生成，禁止第三份手抄（R1 教训）。
// ============================

/** l1_fts 基础 17 列 DDL（soul 列之前的固定部分；content 是唯一全文索引主列） */
const L1_FTS_BASE_COLUMN_DEFS = [
  "content",
  "content_original UNINDEXED",
  "record_id UNINDEXED",
  "type UNINDEXED",
  "priority UNINDEXED",
  "scene_name UNINDEXED",
  "session_key UNINDEXED",
  "session_id UNINDEXED",
  "team_id UNINDEXED",
  "task_id UNINDEXED",
  "user_id UNINDEXED",
  "agent_id UNINDEXED",
  "version UNINDEXED",
  "timestamp_str UNINDEXED",
  "timestamp_start UNINDEXED",
  "timestamp_end UNINDEXED",
  "metadata_json UNINDEXED",
] as const;

/** soul 8 列 DDL 片段：`name ftsSuffix`（ftsSuffix=UNINDEXED —— soul 是过滤元数据不参与全文索引） */
const L1_FTS_SOUL_COLUMN_DEFS = SOUL_COLUMNS.map((c) => `${c.name} ${c.ftsSuffix}`);

/** l1_fts 建表列定义（25 列） */
const L1_FTS_TABLE_DDL = [...L1_FTS_BASE_COLUMN_DEFS, ...L1_FTS_SOUL_COLUMN_DEFS];

/** l1_fts 全部列名（25 个，INSERT 列清单/迁移共用；顺序与建表一致） */
const L1_FTS_ALL_COL_NAMES = [
  ...L1_FTS_BASE_COLUMN_DEFS.map((d) => d.split(" ")[0]),
  ...SOUL_COL_NAMES,
];

/** soul 8 字段写入缺省值（与 l1_records 建表默认一致；主表/FTS/restore 共用） */
const SOUL_FIELD_DEFAULTS: Record<SoulColumnName, string | number | null> = {
  occurred_at: "",
  valid_start: "",
  valid_end: "",
  certainty: "observed",
  source: "",
  valence: null,
  arousal: null,
  significance: null,
  sensitivity: "none",
};

/**
 * soul 8 字段绑定值（单一取值源）：主表 stmtUpsertMeta / FTS stmtL1FtsInsert /
 * restoreL1 FTS 重建 / rebuildFtsIndex 共用，序与 SOUL_COL_NAMES 严格一致。
 * @internal
 */
function soulBindValues(src: Record<string, unknown>): SQLInputValue[] {
  return SOUL_COL_NAMES.map((name) => (src[name] ?? SOUL_FIELD_DEFAULTS[name]) as SQLInputValue);
}

// ============================
// Types
// ============================

export interface VectorSearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** Cosine similarity score (1.0 - cosine_distance) */
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
  /** Raw metadata JSON string (e.g., contains activity_start_time / activity_end_time for episodic) */
  metadata_json: string;
}

/** L0 single-message vector search result. */
export interface L0VectorSearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  role: string;
  message_text: string;
  /** Cosine similarity score (1.0 - cosine_distance) */
  score: number;
  recorded_at: string;
  /** Original message timestamp (epoch ms) */
  timestamp: number;
}

export interface L0RecordRow {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  timestamp: number;
}

const TAG = "[memory-tdai][sqlite]";

// ── 损坏 metadata_json 行 warn 去重（P0-T4 复核修补，审查 Minor #1）──
// 进程级状态：同一 record_id 只 warn 一次；唯一 id 超 CORRUPT_JSON_WARN_MAX_IDS
// 后不再向 Set 追加（防 Set 无界膨胀导致内存膨胀），降级为计数，
// 每 CORRUPT_JSON_SUMMARY_EVERY 行输出一条计数汇总。
const corruptJsonWarnedIds = new Set<string>();
let corruptJsonOverflowCount = 0; // 超限后未入 Set 的损坏行 warn 计数
const CORRUPT_JSON_WARN_MAX_IDS = 100;
const CORRUPT_JSON_SUMMARY_EVERY = 50;

/** Persisted metadata about the embedding provider used to generate stored vectors. */
interface EmbeddingMeta {
  provider: string;
  model: string;
  dimensions: number;
}

/** Result of VectorStore.init() — indicates whether a re-embed is needed. */
export interface VectorStoreInitResult {
  /**
   * `true` if the embedding provider/model/dimensions changed since
   * the vectors were last written.  Callers should re-embed all texts
   * (via `reindexAll()`) after receiving this flag.
   */
  needsReindex: boolean;
  /** Human-readable reason (for logging). */
  reason?: string;
}

// Use createRequire to load the experimental node:sqlite module
const require = createRequire(import.meta.url);

function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

// ============================
// FTS5 helpers (adapted from openclaw core hybrid.ts)
// ============================

// ── Chinese word segmentation (jieba) ──
// Lazy-loaded singleton: initialised on first call to `buildFtsQuery`.
// If @node-rs/jieba is unavailable, falls back to Unicode-regex splitting.

interface JiebaInstance {
  cutForSearch(text: string, hmm: boolean): string[];
}

let _jieba: JiebaInstance | null | undefined; // undefined = not yet tried

function getJieba(): JiebaInstance | null {
  if (_jieba !== undefined) return _jieba;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Jieba } = require("@node-rs/jieba");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dict } = require("@node-rs/jieba/dict");
    _jieba = Jieba.withDict(dict) as JiebaInstance;
  } catch {
    _jieba = null; // mark as unavailable — won't retry
  }
  return _jieba;
}

/**
 * Common Chinese stop-words that add noise to FTS5 queries.
 * Kept small on purpose — only high-frequency function words.
 */
const ZH_STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那",
  "吗", "吧", "呢", "啊", "呀", "哦", "嗯",
]);

/**
 * Build an FTS5 MATCH query from raw text.
 *
 * When `@node-rs/jieba` is available, uses jieba's search-engine mode
 * (`cutForSearch`) for accurate Chinese word segmentation, producing
 * much better recall than the previous regex-only approach.
 *
 * Falls back to Unicode-regex splitting (`/[\p{L}\p{N}_]+/gu`) if
 * jieba is not installed.
 *
 * Tokens are OR-joined as quoted FTS5 phrase terms so that a document
 * matching *any* token is returned.  BM25 naturally ranks documents that
 * match more tokens higher, so precision is preserved while recall is
 * significantly improved — especially for longer queries and when running
 * in FTS-only fallback mode (no embedding available).
 *
 * Example (with jieba):
 *   "用户喜欢编程和TypeScript" → '"用户" OR "喜欢" OR "编程" OR "TypeScript"'
 * Example (fallback):
 *   "旅行计划 API" → '"旅行计划" OR "API"'
 */
export function buildFtsQuery(raw: string): string | null {
  const jieba = getJieba();

  let tokens: string[];
  if (jieba) {
    // jieba cutForSearch: splits long words further for better recall
    // e.g. "北京烤鸭" → ["北京", "烤鸭", "北京烤鸭"]
    tokens = jieba
      .cutForSearch(raw, true)
      .map((t) => t.trim())
      .filter((t) => {
        if (!t) return false;
        // Remove pure whitespace / punctuation tokens
        if (!/[\p{L}\p{N}]/u.test(t)) return false;
        // Remove common Chinese stop-words to reduce noise
        if (ZH_STOP_WORDS.has(t)) return false;
        return true;
      });
    // Deduplicate (cutForSearch may produce duplicates for sub-words)
    tokens = [...new Set(tokens)];
  } else {
    // Fallback: simple Unicode regex split
    tokens =
      raw
        .match(/[\p{L}\p{N}_]+/gu)
        ?.map((t) => t.trim())
        .filter(Boolean) ?? [];
  }

  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

/**
 * Tokenize text for FTS5 indexing (write-side).
 *
 * Uses jieba `cutForSearch()` (search-engine mode) to segment Chinese text,
 * then joins tokens with spaces. The resulting string is stored in the FTS5
 * `content` column so that `unicode61` tokenizer can split it into meaningful
 * words — including both full words and their sub-words.
 *
 * Using `cutForSearch` (instead of `cut`) ensures that the index contains
 * the same sub-word tokens that `buildFtsQuery()` produces on the query side.
 * For example, "人工智能" is indexed as "人工 智能 人工智能", so queries for
 * either the full term or sub-words will match.
 *
 * Falls back to the original text if jieba is unavailable.
 *
 * Example (with jieba):
 *   "用户五月去日本旅行" → "用户 五月 去 日本 旅行"
 *   "人工智能的分支"     → "人工 智能 人工智能 的 分支"
 * Example (fallback):
 *   "用户五月去日本旅行" → "用户五月去日本旅行" (unchanged)
 */
export function tokenizeForFts(raw: string): string {
  const jieba = getJieba();
  if (!jieba) return raw;

  // Use `cutForSearch` (search-engine mode) for indexing — it produces both
  // full words AND their sub-word components. This ensures that query-side
  // tokens (also produced by `cutForSearch` in `buildFtsQuery`) will always
  // find a match in the index.
  const tokens = jieba.cutForSearch(raw, true);

  // Join with spaces so `unicode61` tokenizer can split them.
  // Punctuation tokens are kept — unicode61 treats them as separators anyway.
  return tokens.join(" ");
}

/**
 * Reset jieba state so next call to `buildFtsQuery` re-initialises.
 * Exported for testing only.
 * @internal
 */
export function _resetJiebaForTest(): void {
  _jieba = undefined;
}

/**
 * Override jieba instance (or set to `null` to force fallback).
 * Exported for testing only.
 * @internal
 */
export function _setJiebaForTest(instance: JiebaInstance | null): void {
  _jieba = instance;
}

/**
 * Convert a BM25 rank (negative = more relevant) to a 0–1 score.
 * Mirrors the formula in openclaw core `hybrid.ts`.
 */
export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

/** FTS5 search result for L1 records. */
export interface FtsSearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** BM25-derived score (0–1, higher is better) */
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
  // 列清单/建表/绑定值均由其展开；此处为类型声明（类型无法由字符串数组推导），
  // 类型口径与 L1RecordRow 的 soul 字段一致。新增字段：先改 soul-columns.ts，这里会漏 → verify-p1-t7 断言组 2 红。
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
}

/** FTS5 search result for L0 records. */
export interface L0FtsSearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  role: string;
  message_text: string;
  /** BM25-derived score (0–1, higher is better) */
  score: number;
  recorded_at: string;
  timestamp: number;
}

// ============================
// VectorStore class
// ============================

export class VectorStore implements IMemoryStore {
  private db: DatabaseSync;
  private readonly dimensions: number;
  private readonly logger?: Logger;

  /** @see IMemoryStore.supportsDeferredEmbedding */
  readonly supportsDeferredEmbedding = true;

  /**
   * When `true`, the store is in a degraded state (e.g. sqlite-vec failed to
   * load, or init() encountered an unrecoverable error).  All public methods
   * become safe no-ops so the plugin never blocks the main OpenClaw flow.
   */
  private degraded = false;

  /** Tracks whether close() has been called to prevent double-close errors. */
  private closed = false;

  /**
   * `true` when vec0 virtual tables (l1_vec / l0_vec) have been created and
   * their prepared statements are ready.  When `dimensions === 0` (i.e.
   * provider="none"), vec0 tables are deferred and this stays `false`.
   */
  private vecTablesReady = false;

  // Prepared statements — L1 (initialized in init())
  private stmtUpsertMeta!: StatementSync;
  private stmtDeleteVec?: StatementSync;   // optional — only set when vecTablesReady
  private stmtInsertVec?: StatementSync;   // optional — only set when vecTablesReady
  private stmtDeleteMeta!: StatementSync;
  private stmtGetMeta!: StatementSync;
  private stmtSearchVec?: StatementSync;   // optional — only set when vecTablesReady
  private stmtQueryBySessionId!: StatementSync;
  private stmtQueryBySessionIdSince!: StatementSync;
  private stmtQueryBySessionKey!: StatementSync;
  private stmtQueryBySessionKeySince!: StatementSync;
  private stmtQueryAll!: StatementSync;
  private stmtQueryAllSince!: StatementSync;

  // Prepared statements — L0 (initialized in init())
  private stmtL0UpsertMeta!: StatementSync;
  private stmtL0DeleteVec?: StatementSync;   // optional — only set when vecTablesReady
  private stmtL0InsertVec?: StatementSync;   // optional — only set when vecTablesReady
  private stmtL0DeleteMeta!: StatementSync;
  private stmtL0GetMeta!: StatementSync;
  private stmtL0SearchVec?: StatementSync;   // optional — only set when vecTablesReady
  /** L0 query for L1 runner: all messages for a session key */
  private stmtL0QueryAll!: StatementSync;
  /** L0 query for L1 runner: messages after a timestamp cursor */
  private stmtL0QueryAfter!: StatementSync;
  /** L1 cursor-based pagination for migration (by PK) */
  private stmtL1QueryMigrationCursor!: StatementSync;
  /** L0 cursor-based pagination for migration (by PK) */
  private stmtL0QueryMigrationCursor!: StatementSync;

  // FTS5 tables availability flag (created best-effort — may be false if fts5 is not compiled in)
  private ftsAvailable = false;

  /**
   * T15-B（向量健康）：最近一次成功向量写入的 ISO 时间戳（进程内内存值，非持久化）。
   * upsertL1 成功写向量（非 meta-only）时更新；从未写过 / 重启后为 null。
   * 由 /health 的 memory.lastVecWriteAt 经 getLastVecWriteAt() 读取。
   */
  private lastVecWriteAt: string | null = null;

  // ── R-A3（E2 性能速赢）：listValues 租户级缓存（GROW 写路径 upsert/delete/pin/
  // retire/restore/derive/restoreValence/resetValence 八处统一失效；TTL 仅作跨进程写
  // 漂移防御，默认 60s，0=缓存关）──
  private valuesCache = new Map<string, { rows: Array<{ value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed"; node_type: "theme" | "person"; attrs_json: string }>; at: number }>();
  private valuesCacheTtlMs = 60_000;
  /** E2 观测计数器（miss=真实 DB 查询次数；hit=缓存命中次数）——测试与运维诊断共用。 */
  valuesCacheHits = 0;
  valuesCacheMisses = 0;

  /** E2：配置 values 缓存 TTL（毫秒；非正数=关）。factory 按 recall.valuesCacheTtlMs 接线。 */
  setValuesCacheTtlMs(ms: number): void {
    this.valuesCacheTtlMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
    this.valuesCache.clear();
  }

  /**
   * E2 失效钩子（GROW 起为八写路径统一调用）：任何 core_values 写入后清全缓存。
   * 清全缓存而非单 key 的原因（登记）：PA 移除 S6 读时兜底后，租户桶已严格独立，
   * 单 key 失效在理论上足够；保留全清是保守选择（写路径低频，全清成本可忽略，
   * 且天然覆盖 fanout 批量写入这类"一次写多租户桶"的路径）。
   */
  private invalidateValuesCache(): void {
    if (this.valuesCache.size > 0) this.valuesCache.clear();
  }

  // Prepared statements — FTS5 L1 (initialized in init())
  private stmtL1FtsInsert!: StatementSync;
  private stmtL1FtsDelete!: StatementSync;
  private stmtL1FtsSearch!: StatementSync;

  // Prepared statements — FTS5 L0 (initialized in init())
  private stmtL0FtsInsert!: StatementSync;
  private stmtL0FtsDelete!: StatementSync;
  private stmtL0FtsSearch!: StatementSync;

  /**
   * Create a VectorStore instance.
   *
   * Note: After construction, you MUST call `init()` to load the sqlite-vec
   * extension and create the schema.
   */
  constructor(dbPath: string, dimensions: number, logger?: Logger) {
    this.dimensions = dimensions;
    this.logger = logger;

    // Ensure parent directory exists (for non-default instance paths)
    const dbDir = path.dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Open database with extension support enabled
    const { DatabaseSync: DbSync } = requireNodeSqlite();
    this.db = new DbSync(dbPath, { allowExtension: true });

    // Set busy timeout so concurrent processes retry instead of failing with SQLITE_BUSY
    this.db.exec("PRAGMA busy_timeout = 5000");

    // Enable WAL mode for better concurrent read performance
    this.db.exec("PRAGMA journal_mode = WAL");

    // Cap page cache at 64 MB
    this.db.exec("PRAGMA cache_size = -65536");

    // Cap memory-mapped I/O at 128 MB to bound RSS growth
    this.db.exec("PRAGMA mmap_size = 134217728");

    // Auto-checkpoint WAL every 1000 pages (~4 MB) to keep WAL file compact
    this.db.exec("PRAGMA wal_autocheckpoint = 1000");
  }

  /**
   * Expose the underlying `DatabaseSync` handle for tightly-coupled co-tenants
   * that need to live in the SAME SQLite connection (skill_meta / skill_fts /
   * skill_vec live alongside l1_records — see SKILL_ENGINEERING_DESIGN §13.3).
   *
   * Intentional escape hatch: do NOT use this for unrelated stores. Sharing
   * the connection is what gives us one sqlite-vec load + one WAL session +
   * cross-table transactions; opening a second connection on `vectors.db`
   * would defeat all three.
   */
  getRawDb(): DatabaseSync {
    return this.db;
  }

  /** Embedding dimension this store was opened with (0 when provider="none"). */
  getEmbeddingDimensions(): number {
    return this.dimensions;
  }

  /**
   * Whether the store is in degraded mode (e.g. sqlite-vec failed to load).
   * When degraded, all write/search operations become safe no-ops.
   */
  isDegraded(): boolean {
    return this.degraded;
  }


  /**
   * Load sqlite-vec extension and initialize database schema.
   * Must be called once after construction.
   *
   * @param providerInfo  Current embedding provider info. When provided,
   *   the store compares it against the persisted metadata. If the provider,
   *   model, or dimensions changed, the vector tables are dropped and
   *   re-created with the new dimensions, and `needsReindex: true` is returned
   *   so the caller can schedule a full re-embed.
   */
  init(providerInfo?: EmbeddingProviderInfo): VectorStoreInitResult {
    // Load sqlite-vec extension only when vector tables are needed.
    // dimensions=0 is a supported metadata/FTS-only mode and must not degrade
    // just because sqlite-vec is unavailable in the local test/runtime build.
    if (this.dimensions > 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sqliteVec = require("sqlite-vec");
        this.db.enableLoadExtension(true);
        sqliteVec.load(this.db);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.error(
          `${TAG} Failed to load sqlite-vec extension: ${message}. ` +
          `VectorStore entering degraded mode — all operations will be no-ops.`,
        );
        this.degraded = true;
        return { needsReindex: false, reason: `sqlite-vec load failed: ${message}` };
      }
    }

    // ── Schema creation & prepared statements ──────────────────────────────
    // Wrapped in try-catch: if anything fails during schema init (e.g. the DB
    // is corrupted, disk full, etc.), we degrade gracefully instead of crashing.
    try {
      return this.initSchema(providerInfo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(
        `${TAG} Schema initialization failed: ${message}. ` +
        `VectorStore entering degraded mode.`,
      );
      this.degraded = true;
      return { needsReindex: false, reason: `schema init failed: ${message}` };
    }
  }

  /**
   * Internal schema initialization — separated from init() so we can
   * catch errors at the top level and degrade gracefully.
   */
  private initSchema(providerInfo?: EmbeddingProviderInfo): VectorStoreInitResult {
    // Tracks which provider/model/dimensions were used to generate vectors.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Detect whether re-index is needed
    let needsReindex = false;
    let reindexReason: string | undefined;

    const savedMeta = this.readEmbeddingMeta();

    if (providerInfo) {
      if (savedMeta) {
        const providerChanged = savedMeta.provider !== providerInfo.provider;
        const modelChanged = savedMeta.model !== providerInfo.model;
        const dimsChanged = savedMeta.dimensions !== this.dimensions;

        if (providerChanged || modelChanged || dimsChanged) {
          const reasons: string[] = [];
          if (providerChanged) reasons.push(`provider: ${savedMeta.provider} → ${providerInfo.provider}`);
          if (modelChanged) reasons.push(`model: ${savedMeta.model} → ${providerInfo.model}`);
          if (dimsChanged) reasons.push(`dimensions: ${savedMeta.dimensions} → ${this.dimensions}`);
          reindexReason = reasons.join(", ");

          this.logger?.info(
            `${TAG} Embedding config changed (${reindexReason}). ` +
            `Dropping vector tables for rebuild...`,
          );

          // Drop and re-create vector tables with new dimensions
          this.dropVectorTables();
          needsReindex = true;
        }
      } else {
        // No saved meta — first run or legacy DB without meta table.
        // Two cases require dropping vector tables:
        // 1. Existing data created without meta tracking (legacy DB) — need re-embed
        // 2. vec0 tables exist with wrong dimensions (e.g. previously created with
        //    provider="none" placeholder 768D, now switching to a real provider
        //    with different dimensions) — must rebuild even if data tables are empty
        const l1Count = this.tableRowCount("l1_records");
        const l0Count = this.tableRowCount("l0_conversations");
        const existingVecDims = this.getVecTableDimensions();

        if (l1Count > 0 || l0Count > 0) {
          this.logger?.info(
            `${TAG} No embedding_meta found but existing data exists ` +
            `(L1=${l1Count}, L0=${l0Count}). Dropping vector tables for safety...`,
          );
          this.dropVectorTables();
          needsReindex = true;
          reindexReason = "legacy DB without embedding_meta — cannot verify vector compatibility";
        } else if (existingVecDims !== null && existingVecDims !== this.dimensions) {
          // vec0 tables exist (from a previous provider="none" placeholder or
          // different config) but with mismatched dimensions.  Drop them so they
          // get re-created with the correct dimensions below.
          this.logger?.info(
            `${TAG} vec0 table dimension mismatch (existing=${existingVecDims}, ` +
            `required=${this.dimensions}). Dropping vector tables for rebuild...`,
          );
          this.dropVectorTables();
          // No needsReindex — there's no data to re-embed
        }
      }
    }

    // ── L1 schema ──────────────────────────────────

    // Metadata table
    // NOTE: user_id / agent_id added for three-dim tenancy isolation
    //       (see docs/l0l3-tenant-isolation-design.md).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l1_records (
        record_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50,
        scene_name TEXT DEFAULT '',
        session_key TEXT DEFAULT '',
        session_id TEXT DEFAULT 'default',
        team_id TEXT DEFAULT 'default',
        task_id TEXT DEFAULT '',
        user_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default',
        version INTEGER NOT NULL DEFAULT 0,
        timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}'
      )
    `);

    // Online migration: pre-isolation DBs lack user_id/agent_id columns. ALTER ADD is
    // idempotent-safe: a try/catch around each statement is the SQLite-3 standard idiom.
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN team_id TEXT DEFAULT 'default'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN task_id TEXT DEFAULT ''"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN version INTEGER NOT NULL DEFAULT 0"); } catch { /* exists */ }
    this.db.prepare("UPDATE l1_records SET team_id = ? WHERE team_id = '' OR team_id IS NULL").run(DEFAULT_ISOLATION_ID);
    this.db.prepare("UPDATE l1_records SET user_id = ? WHERE user_id = '' OR user_id IS NULL").run(DEFAULT_ISOLATION_ID);
    this.db.prepare("UPDATE l1_records SET agent_id = ? WHERE agent_id = '' OR agent_id IS NULL").run(DEFAULT_ISOLATION_ID);
    this.db.prepare("UPDATE l1_records SET session_id = ? WHERE session_id = '' OR session_id IS NULL").run(DEFAULT_ISOLATION_ID);
    this.db.exec("UPDATE l1_records SET version = 0 WHERE version IS NULL OR version < 0");
    // ── 灵魂记忆字段（P2a）：时空 / 观察推断 / 情感 —— 幂等 ALTER，已有库在线加列 ──
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN occurred_at TEXT DEFAULT ''"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN valid_start TEXT DEFAULT ''"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN valid_end TEXT DEFAULT ''"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN certainty TEXT DEFAULT 'observed'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN source TEXT DEFAULT ''"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN valence REAL"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN arousal REAL"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN significance REAL"); } catch { /* exists */ }
    // D-3（2026-09-21）：敏感性第 9 soul 列（幂等 ALTER；缺省 none=逐位现状）
    try { this.db.exec("ALTER TABLE l1_records ADD COLUMN sensitivity TEXT DEFAULT 'none'"); } catch { /* exists */ }

    // Indexes for common queries
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_type ON l1_records(type)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_key ON l1_records(session_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_id ON l1_records(session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_scene ON l1_records(scene_name)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_ts_start ON l1_records(timestamp_start)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_ts_end ON l1_records(timestamp_end)");
    // Composite index: session_id exact match + updated_time range scan (for incremental L2 queries)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_updated ON l1_records(session_id, updated_time)");
    // Composite index: session_key exact match + updated_time range scan (for pipeline cursor queries)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_sessionkey_updated ON l1_records(session_key, updated_time)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_task_updated ON l1_records(task_id, updated_time)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_team_agent_updated ON l1_records(team_id, agent_id, updated_time)");
    // ── 记忆图（G）：L1↔L1 显式语义边 ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l1_links (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'similar',
        strength REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, target_id, type)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_links_source ON l1_links(source_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_links_target ON l1_links(target_id)");
    // ── 遗忘归档桶（I，设计§3：软删可恢复，归档优先于删除）──
    // SEC-1（补 T12 漏网）：l1_archive 带租户三列（default 桶家族，与 core 两表/l1_records
    // 同源 DEFAULT_ISOLATION_ID）—— 归档行也必须有归属，否则任何 agent 可见/恢复全实例归档。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l1_archive (
        record_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        archived_at TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        team_id TEXT NOT NULL DEFAULT '${DEFAULT_ISOLATION_ID}',
        user_id TEXT NOT NULL DEFAULT '${DEFAULT_ISOLATION_ID}',
        agent_id TEXT NOT NULL DEFAULT '${DEFAULT_ISOLATION_ID}'
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_archive_at ON l1_archive(archived_at)");
    this.migrateArchiveTenantTable();
    // ── 核心记忆 + 价值锚（K，设计§2/§3：stable 稳定锚定，agent 可维护，信任边界）──
    // P2-T12（K1）core 租户化：两表带 team_id/user_id/agent_id 三列（default 桶，
    // 与 isolation DEFAULT_ISOLATION_ID 家族一致 —— /v2 匿名读写与拍板⑤回填自洽）。
    // 不设 slot/value_id 单列 PRIMARY KEY（SQLite 无法 ALTER PK，单列 PK 会阻塞
    // 跨租户同 slot 并存）；唯一性由下方复合唯一索引保证（执行裁决：唯一索引方案）。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS core_memory (
        slot TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT '',
        team_id TEXT NOT NULL DEFAULT 'default',
        user_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default'
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS core_values (
        value_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        weight REAL NOT NULL DEFAULT 0.5,
        created_by TEXT NOT NULL DEFAULT '',
        valence REAL,
        origin TEXT NOT NULL DEFAULT 'seed',
        pinned INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'active',
        team_id TEXT NOT NULL DEFAULT 'default',
        user_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default'
      )
    `);
    this.migrateCoreTenantTables();
    // C2（spec §3.1）：动机方向列（幂等 ALTER，T12 模式）。可空，NULL=未判定。
    // 位置在 migrateCoreTenantTables 之后：存量库若走 T12 重建，先重建再补列，
    // 保证 ALTER 不会在建表 DDL 与重建之间被回滚丢失（新库 DDL 已带列，此 ALTER 空转）。
    // +1=趋近推进、-1=审慎回避、0=中性；NULL=未判定（LLM 未判 / 用户未微调）。
    try { this.db.exec("ALTER TABLE core_values ADD COLUMN valence REAL"); } catch { /* exists */ }
    // GROW（价值锚自生长）：origin/pinned/state 三列（幂等 ALTER，T12 模式）。
    // 位置在 migrateCoreTenantTables 之后（同 valence 的理由：存量库先重建再补列）。
    // 存量行默认 seed/0/active —— 存量行全部来自启动种子灌入（B1），origin='seed' 与史实一致。
    try { this.db.exec("ALTER TABLE core_values ADD COLUMN origin TEXT NOT NULL DEFAULT 'seed'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE core_values ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE core_values ADD COLUMN state TEXT NOT NULL DEFAULT 'active'"); } catch { /* exists */ }
    // DS-SOUL-MEMORY-002 P2（spec §2.6）：人物锚双节点列——幂等 ALTER（T12 模式），
    // 缺省 'theme'/'{}' = 逐位现状；sqlite 不可删列，回滚策略=列保留无害、缺省值即现状。
    try { this.db.exec("ALTER TABLE core_values ADD COLUMN node_type TEXT NOT NULL DEFAULT 'theme'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE core_values ADD COLUMN attrs_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* exists */ }
    // DS-SOUL-MEMORY-002 P2（spec §7 O13）：core_pending——红线类提案（core_value/strict_rule）
    // 的人工采纳落点（永不自动写入 core 对象；Panel /v3 pending/decide 采纳）。
    this.db.exec(`CREATE TABLE IF NOT EXISTS core_pending (
      pending_id TEXT PRIMARY KEY,
      slot TEXT NOT NULL,
      content TEXT NOT NULL,
      evidence INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending',
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      decided_at TEXT
    )`);
    // GROW：自生长调度状态 kv（last_discovery_at / last_corpus_count）——重启不失忆，
    // 避免每次重启后 interval 门失效白烧一次发现 LLM 调用。
    this.db.exec("CREATE TABLE IF NOT EXISTS anchor_growth_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    // PA（推翻 spec §5.1 裁决 2）：default 锚扇出迁移（幂等，SEC-1 模式）。
    // 位置在 migrateCoreTenantTables（唯一索引就位）+ origin/pinned/state ALTER 之后，
    // 保证存量库先完成租户化与三列补齐再扇出。
    this.fanoutDefaultValuesToAgents();
    // Isolation indexes (three-dim tenancy)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_user_agent_session ON l1_records(user_id, agent_id, session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_user_updated  ON l1_records(user_id, updated_time)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_agent_updated ON l1_records(agent_id, updated_time)");

    // Vector virtual table (cosine distance) — only created when dimensions > 0.
    // When provider="none", dimensions=0 and vec0 tables are deferred until a
    // real embedding provider is configured.
    if (this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}] distance_metric=cosine,
          updated_time TEXT DEFAULT ''
        )
      `);
    }

    // Prepare statements for reuse
    // NOTE: user_id / agent_id appended at the end of the column list so that
    // existing positional bindings in this file remain in the same relative
    // order; new bindings always come last. See upsertL1() for the call-site.
    this.stmtUpsertMeta = this.db.prepare(`
      INSERT INTO l1_records (
        record_id, content, type, priority, scene_name, session_key, session_id,
        team_id, task_id, version, timestamp_str, timestamp_start, timestamp_end,
        created_time, updated_time, metadata_json,
        user_id, agent_id,
        occurred_at, valid_start, valid_end, certainty, source, valence, arousal, significance, sensitivity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        content=excluded.content,
        type=excluded.type,
        priority=excluded.priority,
        scene_name=excluded.scene_name,
        team_id=excluded.team_id,
        task_id=excluded.task_id,
        version=excluded.version,
        timestamp_str=excluded.timestamp_str,
        timestamp_start=excluded.timestamp_start,
        timestamp_end=excluded.timestamp_end,
        updated_time=excluded.updated_time,
        metadata_json=excluded.metadata_json,
        user_id=excluded.user_id,
        agent_id=excluded.agent_id,
        occurred_at=excluded.occurred_at,
        valid_start=excluded.valid_start,
        valid_end=excluded.valid_end,
        certainty=excluded.certainty,
        source=excluded.source,
        valence=excluded.valence,
        arousal=excluded.arousal,
        significance=excluded.significance,
        sensitivity=excluded.sensitivity
    `);

    if (this.dimensions > 0) {
      this.stmtDeleteVec = this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?");
      this.stmtInsertVec = this.db.prepare("INSERT INTO l1_vec (record_id, embedding, updated_time) VALUES (?, ?, ?)");
    }
    this.stmtDeleteMeta = this.db.prepare("DELETE FROM l1_records WHERE record_id = ?");

    this.stmtGetMeta = this.db.prepare(`
      SELECT content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id,
             version, timestamp_str, timestamp_start, timestamp_end, metadata_json,
             occurred_at, valid_start, valid_end, certainty, source, valence, arousal, significance, sensitivity
      FROM l1_records WHERE record_id = ?
    `);

    if (this.dimensions > 0) {
      this.stmtSearchVec = this.db.prepare(`
        SELECT record_id, distance
        FROM l1_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    }

    // ── L0 schema ──────────────────────────────────

    // L0 metadata table: stores individual messages for vector search.
    // NOTE: user_id / agent_id added for three-dim tenancy isolation
    //       (see docs/l0l3-tenant-isolation-design.md).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l0_conversations (
        record_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_id TEXT DEFAULT 'default',
        team_id TEXT DEFAULT 'default',
        task_id TEXT DEFAULT '',
        user_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0
      )
    `);

    // Online migrations: each ADD COLUMN is wrapped in try/catch so re-running
    // init() on an already-migrated DB is a no-op.
    try {
      this.db.exec("ALTER TABLE l0_conversations ADD COLUMN timestamp INTEGER DEFAULT 0");
      this.logger?.debug?.(`${TAG} Migrated l0_conversations: added timestamp column`);
    } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l0_conversations ADD COLUMN team_id TEXT DEFAULT 'default'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l0_conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l0_conversations ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE l0_conversations ADD COLUMN task_id TEXT DEFAULT ''"); } catch { /* exists */ }
    this.db.prepare("UPDATE l0_conversations SET team_id = ? WHERE team_id = '' OR team_id IS NULL").run(DEFAULT_ISOLATION_ID);
    this.db.prepare("UPDATE l0_conversations SET user_id = ? WHERE user_id = '' OR user_id IS NULL").run(DEFAULT_ISOLATION_ID);
    this.db.prepare("UPDATE l0_conversations SET agent_id = ? WHERE agent_id = '' OR agent_id IS NULL").run(DEFAULT_ISOLATION_ID);
    this.db.prepare("UPDATE l0_conversations SET session_id = ? WHERE session_id = '' OR session_id IS NULL").run(DEFAULT_ISOLATION_ID);

    // Skill schema belongs to the same vectors.db. Initialize its base tables
    // with the SQLite store so a freshly installed in-process OpenClaw plugin
    // has a complete database even when SkillCore is not otherwise activated.
    // SkillCore may call the same idempotent DDL later and initialize skill_vec.
    try {
      this.db.exec(SKILLS_DDL);
      this.db.exec(SKILL_FTS_DDL);
    } catch (err) {
      this.logger?.warn(
        `${TAG} Skill base schema init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Indexes for L0 queries
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_session ON l0_conversations(session_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_session_id ON l0_conversations(session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_task ON l0_conversations(task_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_team_agent ON l0_conversations(team_id, agent_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_recorded ON l0_conversations(recorded_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_timestamp ON l0_conversations(timestamp)");
    // Isolation indexes (three-dim tenancy)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_user_agent_session ON l0_conversations(user_id, agent_id, session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_user_recorded  ON l0_conversations(user_id, recorded_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_agent_recorded ON l0_conversations(agent_id, recorded_at)");

    // L0 vector virtual table (cosine distance, same dimensions as L1) — deferred when dimensions=0
    if (this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}] distance_metric=cosine,
          recorded_at TEXT DEFAULT ''
        )
      `);
    }

    // L0 prepared statements
    // user_id / agent_id appended at the end of the bind list (see upsertL0()).
    this.stmtL0UpsertMeta = this.db.prepare(`
      INSERT INTO l0_conversations (
        record_id, session_key, session_id, team_id, task_id, role, message_text, recorded_at, timestamp,
        user_id, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        message_text=excluded.message_text,
        recorded_at=excluded.recorded_at,
        timestamp=excluded.timestamp,
        team_id=excluded.team_id,
        task_id=excluded.task_id,
        user_id=excluded.user_id,
        agent_id=excluded.agent_id
    `);

    if (this.dimensions > 0) {
      this.stmtL0DeleteVec = this.db.prepare("DELETE FROM l0_vec WHERE record_id = ?");
      this.stmtL0InsertVec = this.db.prepare("INSERT INTO l0_vec (record_id, embedding, recorded_at) VALUES (?, ?, ?)");
    }
    this.stmtL0DeleteMeta = this.db.prepare("DELETE FROM l0_conversations WHERE record_id = ?");

    this.stmtL0GetMeta = this.db.prepare(`
      SELECT session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations WHERE record_id = ?
    `);

    if (this.dimensions > 0) {
      this.stmtL0SearchVec = this.db.prepare(`
        SELECT record_id, distance
        FROM l0_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    }

    // L0 query statements for L1 runner (oldest-first + LIMIT to bound memory).
    //
    // Why ASC: the L1 runner advances `last_l1_cursor` to max(recorded_at) of
    // the batch it just consumed. If we returned newest-first under a backlog,
    // the cursor would jump to the latest record and silently skip the older
    // ones. Returning the oldest `LIMIT` rows above the cursor is the only way
    // to guarantee progress without data loss when there is a backlog.
    //
    // Sort/filter by recorded_at (write time) instead of timestamp (conversation
    // time) because L1 cursor uses recorded_at semantics. ISO 8601 string
    // comparison preserves time order.
    this.stmtL0QueryAll = this.db.prepare(`
      SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE session_key = ?
      ORDER BY recorded_at ASC
      LIMIT ?
    `);

    this.stmtL0QueryAfter = this.db.prepare(`
      SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE session_key = ? AND recorded_at > ?
      ORDER BY recorded_at ASC
      LIMIT ?
    `);

    this.stmtL0QueryMigrationCursor = this.db.prepare(`
      SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE record_id > ?
      ORDER BY record_id ASC
      LIMIT ?
    `);

    // ── Entity metadata tables (Team / User / Agent / Task) ───────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_teams (
        team_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        owner_user_id TEXT NOT NULL,
        user_ids_json TEXT NOT NULL DEFAULT '[]',
        agent_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_users (
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        job_description TEXT DEFAULT '',
        team_ids_json TEXT NOT NULL DEFAULT '[]',
        task_ids_json TEXT NOT NULL DEFAULT '[]',
        owned_agent_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_agents (
        agent_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        prompt TEXT DEFAULT '',
        owner_user_id TEXT DEFAULT '',
        visibility TEXT NOT NULL DEFAULT 'team',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_tasks (
        task_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        creator_user_id TEXT NOT NULL,
        title TEXT DEFAULT '',
        description TEXT DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_url TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        auto_assign_floating_assets INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'low',
        agent_ids_json TEXT NOT NULL DEFAULT '[]',
        user_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_knowledge (
        knowledge_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        service_url TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        user_id TEXT,
        repo_url TEXT,
        branch TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // 在线迁移：老库补 agent_id 列（预留 binding 维度，绑定权威在 meta_assets）
    try { this.db.exec("ALTER TABLE entity_knowledge ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE entity_teams ADD COLUMN user_ids_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE entity_teams ADD COLUMN agent_ids_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE entity_tasks ADD COLUMN user_ids_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* exists */ }
    this.db.exec("DROP INDEX IF EXISTS idx_entity_teams_name");
    this.db.exec("DROP INDEX IF EXISTS idx_entity_agents_team_name");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_entity_teams_name ON entity_teams(name)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_entity_users_status ON entity_users(status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_entity_agents_team_name ON entity_agents(team_id, name)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_entity_agents_team_status ON entity_agents(team_id, status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_entity_tasks_team_status ON entity_tasks(team_id, status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_entity_knowledge_team ON entity_knowledge(team_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_entity_knowledge_team_type ON entity_knowledge(team_id, type)");

    // ── Memory Audit (修改审计) ──
    // 设计要点（per user 决策）：
    //   - 原始 L0/L1/L2/L3 表完全不动，本表只追加事件
    //   - 不存历史 content / 旧值，只记"什么时间、由谁、改了哪条"
    //   - team/agent/user/task 来自外部请求 IdFields（不是 record 原值）
    //   - L0 不参与（不可变流水）；L1/L2/L3 update + delete 各记一条
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_audit (
        audit_id      TEXT PRIMARY KEY,
        record_id     TEXT NOT NULL,
        layer         TEXT NOT NULL CHECK (layer IN ('L1','L2','L3')),
        action        TEXT NOT NULL CHECK (action IN ('update','delete')),
        team_id       TEXT,
        agent_id      TEXT,
        user_id       TEXT,
        task_id       TEXT,
        version       INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        request_id    TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_audit_record    ON memory_audit(record_id, updated_at_ms)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_audit_isolation ON memory_audit(team_id, agent_id, user_id, task_id)");

    // ── Custom Memory Prompt ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_prompts (
        memory_prompt_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        layer TEXT NOT NULL CHECK (layer IN ('l1','l2','l3')),
        prompt TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','deleting')),
        created_by TEXT,
        updated_by TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_prompts_layer_updated
        ON memory_prompts(layer, updated_at_ms);
      CREATE INDEX IF NOT EXISTS idx_memory_prompts_status
        ON memory_prompts(status);

      CREATE TABLE IF NOT EXISTS memory_prompt_settings (
        setting_id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL CHECK (target_type IN ('instance','team','agent')),
        team_id TEXT,
        agent_id TEXT,
        layer TEXT NOT NULL CHECK (layer IN ('l1','l2','l3')),
        memory_prompt_id TEXT NOT NULL,
        updated_by TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_prompt_settings_prompt
        ON memory_prompt_settings(memory_prompt_id);
      CREATE INDEX IF NOT EXISTS idx_memory_prompt_settings_target
        ON memory_prompt_settings(team_id, agent_id, layer);

      CREATE TABLE IF NOT EXISTS memory_prompt_setting_logs (
        setting_log_id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL CHECK (target_type IN ('instance','team','agent')),
        team_id TEXT,
        agent_id TEXT,
        layer TEXT NOT NULL CHECK (layer IN ('l1','l2','l3')),
        action TEXT NOT NULL CHECK (action IN ('apply','replace','clear')),
        reason TEXT NOT NULL CHECK (reason IN ('explicit','prompt_deleted')),
        before_memory_prompt_id TEXT,
        after_memory_prompt_id TEXT,
        operator_id TEXT,
        operated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_prompt_logs_prompt_before
        ON memory_prompt_setting_logs(before_memory_prompt_id, operated_at_ms);
      CREATE INDEX IF NOT EXISTS idx_memory_prompt_logs_prompt_after
        ON memory_prompt_setting_logs(after_memory_prompt_id, operated_at_ms);
      CREATE INDEX IF NOT EXISTS idx_memory_prompt_logs_target
        ON memory_prompt_setting_logs(team_id, agent_id, operated_at_ms);

      CREATE TABLE IF NOT EXISTS memory_generation_refs (
        generation_ref_id TEXT PRIMARY KEY,
        layer TEXT NOT NULL CHECK (layer IN ('l1','l2','l3')),
        memory_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        generation_log_id TEXT NOT NULL,
        generation_log_key TEXT NOT NULL,
        memory_prompt_id TEXT NOT NULL,
        memory_prompt_version INTEGER NOT NULL,
        memory_prompt_source TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_generation_refs_memory
        ON memory_generation_refs(layer, memory_id);
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_audit_time      ON memory_audit(updated_at_ms)");

    // ── FTS5 tables (best-effort — gracefully degrade if fts5 is not compiled in) ──
    // Schema v2: `content` column stores jieba-segmented text (for indexing),
    // `content_original` (UNINDEXED) stores the raw text (for display).
    // If old v1 tables exist (no content_original column), drop + recreate.
    try {
      // ── Migrate old FTS5 tables (v1 → v2) ──
      // v1 tables stored raw text in the `content` column. v2 stores segmented
      // text in `content` and raw text in `content_original` / `message_text_original`.
      // FTS5 virtual tables don't support ALTER TABLE ADD COLUMN, so we must
      // drop and recreate. The data will be repopulated by `rebuildFtsIndex()`.
      const needsFtsRebuild = this.migrateFtsTablesIfNeeded();

      // L1 FTS5 virtual table (v2 schema + isolation columns + soul columns).
      // user_id / agent_id added as UNINDEXED so they're carried alongside
      // every FTS hit without affecting BM25 ranking.
      // soul 8 列（occurred_at…significance）同样 UNINDEXED（过滤元数据不参与
      // BM25）—— 列清单由 SOUL_COLUMNS 单一事实源展开（P1-T7，R1 教训）。
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
          ${L1_FTS_TABLE_DDL.join(",\n          ")}
        )
      `);

      // 旧库迁移：17 列 l1_fts（无 soul）→ 25 列（幂等；含则跳过）。
      // 必须在 prepare 25 列语句之前完成，否则旧表结构下 prepare/写入失配。
      this.migrateL1FtsSoul();

      // L0 FTS5 virtual table (v2 schema + isolation columns).
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_fts USING fts5(
          message_text,
          message_text_original UNINDEXED,
          record_id UNINDEXED,
          session_key UNINDEXED,
          session_id UNINDEXED,
          team_id UNINDEXED,
          task_id UNINDEXED,
          user_id UNINDEXED,
          agent_id UNINDEXED,
          role UNINDEXED,
          recorded_at UNINDEXED,
          timestamp UNINDEXED
        )
      `);

      // L1 FTS prepared statements（25 列 = 基础 17 + soul 8，由单一事实源展开）
      this.stmtL1FtsInsert = this.db.prepare(`
        INSERT INTO l1_fts (${L1_FTS_ALL_COL_NAMES.join(", ")})
        VALUES (${L1_FTS_ALL_COL_NAMES.map(() => "?").join(", ")})
      `);

      this.stmtL1FtsDelete = this.db.prepare("DELETE FROM l1_fts WHERE record_id = ?");

      this.stmtL1FtsSearch = this.db.prepare(`
        SELECT record_id, content_original AS content, type, priority, scene_name,
               session_key, session_id, team_id, task_id, user_id, agent_id, version,
               timestamp_str, timestamp_start, timestamp_end,
               metadata_json,
               ${SOUL_SELECT_FRAGMENT},
               bm25(l1_fts) AS rank
        FROM l1_fts
        WHERE l1_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);

      // L0 FTS prepared statements
      this.stmtL0FtsInsert = this.db.prepare(`
        INSERT INTO l0_fts (message_text, message_text_original, record_id,
          session_key, session_id, team_id, task_id, user_id, agent_id, role, recorded_at, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.stmtL0FtsDelete = this.db.prepare("DELETE FROM l0_fts WHERE record_id = ?");

      this.stmtL0FtsSearch = this.db.prepare(`
        SELECT record_id, message_text_original AS message_text,
               session_key, session_id, team_id, task_id, user_id, agent_id, role, recorded_at, timestamp,
               bm25(l0_fts) AS rank
        FROM l0_fts
        WHERE l0_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);

      this.ftsAvailable = true;
      this.logger?.debug?.(`${TAG} FTS5 tables initialized (l1_fts, l0_fts) [schema v2 — jieba segmented]`);

      // Rebuild FTS index if migrated from v1 or tables were freshly created
      if (needsFtsRebuild) {
        this.rebuildFtsIndex();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ftsAvailable = false;
      this.logger?.warn(
        `${TAG} FTS5 tables NOT available (fts5 may not be compiled in): ${message}. ` +
        `FTS-based keyword search will be unavailable; recall will use in-memory scoring if needed.`,
      );
    }

    // Save current embedding meta (write after schema is ready)
    if (providerInfo) {
      this.writeEmbeddingMeta({
        provider: providerInfo.provider,
        model: providerInfo.model,
        dimensions: this.dimensions,
      });
    }

    // Mark vec0 tables as ready only when they were actually created
    this.vecTablesReady = this.dimensions > 0;
    // L1 query statements (for l1-reader)
    // user_id / agent_id surfaced in every L1 read so callers (router /
    // candidate-pool / l1-reader) can enforce isolation downstream.
    const l1QueryCols = `record_id, content, type, priority, scene_name, session_key, session_id,
      team_id, task_id, user_id, agent_id, version,
      timestamp_str, timestamp_start, timestamp_end,
      created_time, updated_time, metadata_json,
      occurred_at, valid_start, valid_end, certainty, source, valence, arousal, significance`;

    this.stmtQueryBySessionId = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_id = ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionIdSince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_id = ? AND updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionKey = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_key = ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionKeySince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_key = ? AND updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryAll = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      ORDER BY updated_time ASC
    `);

    this.stmtQueryAllSince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtL1QueryMigrationCursor = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE record_id > ?
      ORDER BY record_id ASC
      LIMIT ?
    `);

    this.logger?.debug?.(`${TAG} Initialized (dimensions=${this.dimensions})`);

    return { needsReindex, reason: reindexReason };
  }

  // ── Embedding meta helpers ──────────────────────────────

  private readEmbeddingMeta(): EmbeddingMeta | null {
    try {
      const row = this.db
        .prepare("SELECT value FROM embedding_meta WHERE key = ?")
        .get("embedding_provider_info") as { value: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.value) as EmbeddingMeta;
    } catch {
      return null;
    }
  }

  private writeEmbeddingMeta(meta: EmbeddingMeta): void {
    this.db.prepare(
      "INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run("embedding_provider_info", JSON.stringify(meta));
  }

  /** Allowed table names for row counting (whitelist to prevent SQL injection). */
  private static readonly COUNTABLE_TABLES = new Set(["l1_records", "l0_conversations"]);

  /**
   * Extra rows to retrieve from vec0 KNN search to compensate for legacy
   * zero-vector placeholders that may still linger from older data.
   */
  private static readonly ZERO_VEC_BUFFER = 10;

  /** Default result limit for FTS5 keyword searches. */
  private static readonly FTS_DEFAULT_LIMIT = 20;

  private tableRowCount(table: string): number {
    if (!VectorStore.COUNTABLE_TABLES.has(table)) {
      this.logger?.warn(`${TAG} tableRowCount: rejected unknown table name "${table}"`);
      return 0;
    }
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM ${table}`)
        .get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Detect the embedding dimension of an existing vec0 table by inspecting
   * the DDL stored in sqlite_master.  Returns `null` if the table doesn't
   * exist or the dimension cannot be determined.
   *
   * The vec0 DDL looks like:
   *   CREATE VIRTUAL TABLE l1_vec USING vec0(... embedding float[768] ...)
   * We parse the number inside `float[N]`.
   */
  private getVecTableDimensions(): number | null {
    try {
      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get("l1_vec") as { sql: string } | undefined;
      if (!row?.sql) return null;
      const match = row.sql.match(/float\[(\d+)\]/);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Drop both L1 and L0 vector virtual tables.
   * Metadata tables (l1_records, l0_conversations) are preserved — only
   * the vec0 tables need to be rebuilt with the new dimensions.
   */
  private dropVectorTables(): void {
    this.db.exec("DROP TABLE IF EXISTS l1_vec");
    this.db.exec("DROP TABLE IF EXISTS l0_vec");
    this.logger?.info(`${TAG} Dropped vector tables (l1_vec, l0_vec)`);
  }

  /**
   * Write or update a memory record (metadata + vector).
   * Uses a manual transaction for atomicity.
   *
   * If `embedding` is `undefined` or a zero vector (all elements are 0), only
   * the metadata row is written — the vec0 table is left untouched.  This
   * allows callers without an EmbeddingService to still persist metadata + FTS
   * without constructing a throwaway zero-vector, and prevents placeholder
   * zero vectors (from embedding-service failures) from polluting KNN search
   * results with null / NaN distances.
   *
   * **Fault-tolerant**: catches all errors internally so that a vector store
   * failure never propagates to the caller / main OpenClaw flow.
   * Returns `true` on success, `false` on failure (logged as warning).
   */
  upsertL1(record: MemoryRecord, embedding: Float32Array | undefined): boolean {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L1-upsert] SKIPPED (degraded mode) id=${record.id}`);
      return false;
    }
    try {
      const { id: recordId, timestamps } = record;
      const tsStr = timestamps[0] ?? "";
      const tsStart =
        timestamps.length > 0
          ? timestamps.reduce((a, b) => (a < b ? a : b))
          : tsStr;
      const tsEnd =
        timestamps.length > 0
          ? timestamps.reduce((a, b) => (a > b ? a : b))
          : tsStr;

      const skipVec = !embedding || embedding.every(v => v === 0) || !this.vecTablesReady;

      this.logger?.debug?.(
        `${TAG} [L1-upsert] START id=${recordId}, type=${record.type}, ` +
        `content="${record.content.slice(0, 60)}..."` +
        (embedding
          ? `, embeddingDims=${embedding.length}, ` +
            `embeddingNorm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}` +
            `${skipVec ? " (ZERO VECTOR or vec tables not ready — vec write will be skipped)" : ""}`
          : " (no embedding — metadata-only write)"),
      );

      this.db.exec("BEGIN");
      try {
        // Upsert metadata (INSERT OR UPDATE).
        // user_id / agent_id appended at the end to match the prepared statement
        // column order added by the isolation migration. We tolerate undefined
        // for legacy callers (e.g. older tests or pre-isolation seed scripts):
        // empty string preserves the historic "no-isolation" semantics until the
        // migration backfills.
        this.stmtUpsertMeta.run(
          recordId,
          record.content,
          record.type,
          record.priority,
          record.scene_name,
          record.sessionKey,
          record.sessionId || DEFAULT_ISOLATION_ID,
          (record as MemoryRecord & { teamId?: string }).teamId || DEFAULT_ISOLATION_ID,
          record.taskId || "",
          record.version ?? 0,
          tsStr,
          tsStart,
          tsEnd,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record.metadata),
          (record as MemoryRecord & { userId?: string }).userId || DEFAULT_ISOLATION_ID,
          (record as MemoryRecord & { agentId?: string }).agentId || DEFAULT_ISOLATION_ID,
          // 灵魂记忆字段（P2a）：末尾追加，与预处理语句列序一致（P1-T7 收敛为 soulBindValues 单一取值源）
          ...soulBindValues(record as unknown as Record<string, unknown>),
        );

        if (!skipVec) {
          // vec0 does not support ON CONFLICT → delete then insert
          this.stmtDeleteVec!.run(recordId);
          this.stmtInsertVec!.run(recordId, Buffer.from(embedding!.buffer), record.updatedAt);
        } else {
          this.logger?.debug?.(
            `${TAG} [L1-upsert] Skipping vec write (${embedding ? "zero vector" : "no embedding"}) id=${recordId}`,
          );
        }

        // Sync FTS5 (delete + re-insert to handle updates).
        // user_id / agent_id mirrored into FTS so post-recall isolation
        // filtering doesn't require a join.
        if (this.ftsAvailable) {
          try {
            this.stmtL1FtsDelete.run(recordId);
            this.stmtL1FtsInsert.run(
              tokenizeForFts(record.content), // content — segmented for indexing
              record.content,                 // content_original — raw for display
              recordId,
              record.type,
              record.priority,
              record.scene_name,
              record.sessionKey,
              record.sessionId || DEFAULT_ISOLATION_ID,
              (record as MemoryRecord & { teamId?: string }).teamId || DEFAULT_ISOLATION_ID,
              record.taskId || "",
              (record as MemoryRecord & { userId?: string }).userId || DEFAULT_ISOLATION_ID,
              (record as MemoryRecord & { agentId?: string }).agentId || DEFAULT_ISOLATION_ID,
              record.version ?? 0,
              tsStr,
              tsStart,
              tsEnd,
              JSON.stringify(record.metadata),
              // soul 8 字段（P1-T7）：与主表绑定同源（soulBindValues 单一取值源，避免第三份手抄）
              ...soulBindValues(record as unknown as Record<string, unknown>),
            );
          } catch (ftsErr) {
            // FTS write failure is non-fatal — log and continue
            this.logger?.warn(
              `${TAG} [L1-upsert] FTS write failed (non-fatal) id=${recordId}: ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}`,
            );
          }
        }

        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
      this.logger?.debug?.(`${TAG} [L1-upsert] OK id=${recordId}${skipVec ? " (meta-only)" : ""}`);
      // T15-B（向量健康）：仅真实向量写入成功才推进 lastVecWriteAt（meta-only 不算）。
      if (!skipVec) {
        this.lastVecWriteAt = new Date().toISOString();
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-upsert] FAILED (non-fatal) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * 记忆图：写入一条 L1↔L1 语义边（G）。同 (s,t,type) 幂等，重复建边更新强度/时间。
   */
  addLink(sourceId: string, targetId: string, type: string, strength = 1, now = new Date().toISOString()): boolean {
    try {
      this.db
        .prepare(
          "INSERT INTO l1_links (source_id, target_id, type, strength, created_at) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(source_id, target_id, type) DO UPDATE SET strength = excluded.strength, created_at = excluded.created_at",
        )
        .run(sourceId, targetId, type, strength, now);
      this.logger?.debug?.(`${TAG} [l1_links] addLink ${sourceId} -${type}-> ${targetId} (strength=${strength})`);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] addLink failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 记忆图：邻接查询（G）。返回 {id,type,strength,hop} 数组（BFS maxHop）。
   *
   * P2-T14（G2）：可选 IsolationFilter——两步过滤（改动最小）：BFS 每跳拿到候选
   * 邻居 id 后，用 getL1ByIdsWithArchive 批量取行 + rowMatchesIsolation 复核，
   * 只放行租户匹配的邻居（同时剪枝后续跳的遍历，不穿过跨租户节点）。
   * filter 缺省（undefined）= 旧行为，完全兼容单机/无隔离调用方。
   */
  getNeighbors(id: string, types?: string[], maxHop = 1, filter?: IsolationFilter): Array<{ id: string; type: string; strength: number; hop: number }> {
    try {
      const out: Array<{ id: string; type: string; strength: number; hop: number }> = [];
      const seen = new Set<string>([id]);
      let frontier: string[] = [id];
      for (let hop = 1; hop <= maxHop; hop++) {
        if (frontier.length === 0) break;
        const ph = frontier.map(() => "?").join(",");
        const rows = this.db
          .prepare(
            `SELECT target_id AS nid, type, strength FROM l1_links WHERE source_id IN (${ph}) ` +
            `UNION SELECT source_id AS nid, type, strength FROM l1_links WHERE target_id IN (${ph})`,
          )
          .all(...frontier, ...frontier) as Array<{ nid: string; type: string; strength: number }>;
        let candidates = rows;
        if (filter) {
          // P2-T14（G2）两步过滤：批量取行 + rowMatchesIsolation 复核。
          // 无法解析到行（记录不存在）的边一并丢弃——租户归属不可验证时宁缺毋滥。
          const nids = [...new Set(candidates.map((r) => String(r.nid)))];
          const recs = this.getL1ByIdsWithArchive(nids);
          const okIds = new Set(
            recs.filter((rec) => rowMatchesIsolation(rec, filter)).map((rec) => rec.record_id),
          );
          candidates = candidates.filter((r) => okIds.has(String(r.nid)));
        }
        const next: string[] = [];
        for (const r of candidates) {
          const nid = String(r.nid);
          if (seen.has(nid)) continue;
          if (types && types.length > 0 && !types.includes(r.type)) continue;
          seen.add(nid);
          out.push({ id: nid, type: r.type, strength: r.strength, hop });
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
   * 记忆图：沿边反查（G）。返回指向 targetId 的边（谁指向它）；可选 type 过滤。
   * P4a-P2（层级边，REG-REMAINING-002 #1）：derived_from 边 source=L2 scene block
   * （profile:v1:* 稳定 id，租户唯一）、target=L1 record——失效一条 L1 时由此定位
   * 受影响 scene block（精确失效传播的查询基础）。
   */
  getLinksByTarget(targetId: string, type?: string): Array<{ sourceId: string; type: string; strength: number; createdAt: string }> {
    try {
      const rows = (
        type
          ? this.db.prepare("SELECT source_id, type, strength, created_at FROM l1_links WHERE target_id = ? AND type = ? ORDER BY created_at").all(targetId, type)
          : this.db.prepare("SELECT source_id, type, strength, created_at FROM l1_links WHERE target_id = ? ORDER BY created_at").all(targetId)
      ) as Array<{ source_id: string; type: string; strength: number; created_at: string }>;
      return rows.map((r) => ({ sourceId: r.source_id, type: r.type, strength: r.strength, createdAt: r.created_at }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] getLinksByTarget failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 记忆图：沿边正查（G）。返回 sourceId 发出的边（它指向谁）；可选 type 过滤。
   * 与 getLinksByTarget 对偶——L2 侧身世查询："这个 scene block 由哪些 L1 蒸馏而来"。
   */
  getLinksBySource(sourceId: string, type?: string): Array<{ targetId: string; type: string; strength: number; createdAt: string }> {
    try {
      const rows = (
        type
          ? this.db.prepare("SELECT target_id, type, strength, created_at FROM l1_links WHERE source_id = ? AND type = ? ORDER BY created_at").all(sourceId, type)
          : this.db.prepare("SELECT target_id, type, strength, created_at FROM l1_links WHERE source_id = ? ORDER BY created_at").all(sourceId)
      ) as Array<{ target_id: string; type: string; strength: number; created_at: string }>;
      return rows.map((r) => ({ targetId: r.target_id, type: r.type, strength: r.strength, createdAt: r.created_at }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] getLinksBySource failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * P4b（GROW-EVO §4，REG-REMAINING-005 #1）：按 type 全量取边——evolution-worker 的
   * conflict 边扫描底座。单条索引查询（O(边数)），取代"逐 id getLinksByTarget/Source"
   * 的 O(N) 逐条扫描（设计最优性审查定案 #3）。与上两方法同款模式。
   */
  getLinksByType(type: string): Array<{ sourceId: string; targetId: string; type: string; strength: number; createdAt: string }> {
    try {
      const rows = this.db.prepare("SELECT source_id, target_id, type, strength, created_at FROM l1_links WHERE type = ? ORDER BY created_at").all(type) as Array<{ source_id: string; target_id: string; type: string; strength: number; created_at: string }>;
      return rows.map((r) => ({ sourceId: r.source_id, targetId: r.target_id, type: r.type, strength: r.strength, createdAt: r.created_at }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] getLinksByType failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 记忆图：两节点间最短路径查询（C6，graph 设计 §4 / spec §6.4 #1）。BFS
   * （复用 getNeighbors 的 seen/frontier 双向边扩展 + 父指针回溯），返回起点→终点
   * 路径上的中间+终点节点 [{id,type,strength,hop}]（不含起点，hop 从 1 计）；
   * 不可达返回 null；起点即终点返回 []（平凡可达）。
   *
   * T14 教训（C6 第一天即带 isolation）：filter 传入时三重过滤——起点/终点行
   * rowMatchesIsolation 复核（任一不可见 → null）、BFS 每跳候选两步过滤
   * （getL1ByIdsWithArchive + rowMatchesIsolation，同 getNeighbors，不穿过跨租户节点）。
   * filter 缺省（undefined）= 旧行为，完全兼容单机/无隔离调用方。
   * 环路安全：seen 集合（含起点）防 A→B→A 死循环。
   */
  getPath(startId: string, endId: string, maxHop = 3, types?: string[], filter?: IsolationFilter): Array<{ id: string; type: string; strength: number; hop: number }> | null {
    try {
      if (!startId || !endId) return null;
      if (startId === endId) return [];
      if (filter) {
        // 起点租户复核：起点不可见 = 本租户视角该节点不存在（宁缺毋滥）。
        // 终点无需单独复核——BFS 每跳候选已过滤，终点不可见时永不入队 → 不可达 null。
        const startRows = this.getL1ByIdsWithArchive([startId]);
        if (!startRows.some((rec) => rec.record_id === startId && rowMatchesIsolation(rec, filter))) return null;
      }
      // cameFrom：节点 → {from 父节点, 该跳边}；回溯重建路径。
      const cameFrom = new Map<string, { from: string; type: string; strength: number; hop: number }>();
      const seen = new Set<string>([startId]);
      let frontier: string[] = [startId];
      for (let hop = 1; hop <= maxHop; hop++) {
        if (frontier.length === 0) break;
        const ph = frontier.map(() => "?").join(",");
        // 双向边扩展（同 getNeighbors），额外投影对端 id（other）以记录父指针
        const rows = this.db
          .prepare(
            `SELECT target_id AS nid, source_id AS other, type, strength FROM l1_links WHERE source_id IN (${ph}) ` +
            `UNION SELECT source_id AS nid, target_id AS other, type, strength FROM l1_links WHERE target_id IN (${ph})`,
          )
          .all(...frontier, ...frontier) as Array<{ nid: string; other: string; type: string; strength: number }>;
        let candidates = rows;
        if (filter) {
          // 两步过滤（同 getNeighbors G2）：批量取行 + rowMatchesIsolation 复核；
          // 无法解析到行的边一并丢弃——租户归属不可验证时宁缺毋滥。
          const nids = [...new Set(candidates.map((r) => String(r.nid)))];
          const recs = this.getL1ByIdsWithArchive(nids);
          const okIds = new Set(
            recs.filter((rec) => rowMatchesIsolation(rec, filter)).map((rec) => rec.record_id),
          );
          candidates = candidates.filter((r) => okIds.has(String(r.nid)));
        }
        const frontierIds = new Set(frontier);
        const next: string[] = [];
        for (const r of candidates) {
          const nid = String(r.nid);
          if (seen.has(nid)) continue;
          if (types && types.length > 0 && !types.includes(r.type)) continue;
          const parent = String(r.other);
          if (!frontierIds.has(parent)) continue; // 防御：父指针必须在当前层
          seen.add(nid);
          cameFrom.set(nid, { from: parent, type: r.type, strength: r.strength, hop });
          if (nid === endId) {
            const path: Array<{ id: string; type: string; strength: number; hop: number }> = [];
            let cur = endId;
            while (cur !== startId) {
              const edge = cameFrom.get(cur);
              if (!edge) return null; // 不可能（有父指针才入队）；防御性返回
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

  /**
   * 记忆图：删除某记忆的所有边（记忆删除时级联）。
   */
  deleteLinksFor(id: string): boolean {
    try {
      this.db.prepare("DELETE FROM l1_links WHERE source_id = ? OR target_id = ?").run(id, id);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] deleteLinksFor failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 审计 F5：清理孤儿边（source 与 target 都已不在 l1_records 且不在 l1_archive 的边）。
   * 历史硬删窗口留下的断链边会让邻居召回读到空气；本方法一次性对账。
   * 返回删除的边数。失败返回 -1（区别于 0=没有孤儿）。
   */
  pruneOrphanLinks(): number {
    try {
      const result = this.db.prepare(
        `DELETE FROM l1_links
         WHERE (source_id NOT IN (SELECT record_id FROM l1_records) AND source_id NOT IN (SELECT record_id FROM l1_archive))
            OR (target_id NOT IN (SELECT record_id FROM l1_records) AND target_id NOT IN (SELECT record_id FROM l1_archive))`,
      ).run();
      const pruned = (result as any)?.changes ?? 0;
      if (pruned > 0) this.logger?.info?.(`${TAG} [l1_links] pruned ${pruned} orphan edge(s)`);
      return pruned;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] pruneOrphanLinks failed: ${err instanceof Error ? err.message : String(err)}`);
      return -1;
    }
  }

  /**
   * 遗忘归档桶（I，设计§3：软删可恢复，归档优先于删除）。
   * 把 l1_records 的一行移到 l1_archive（整行存 JSON + archived_at + reason），并从
   * 检索面/向量/FTS/图边级联移除。检索默认读 l1_records → 归档天然被排除，可恢复。
   */
  archiveL1(id: string, reason = "forgetting"): boolean {
    try {
      const row = this.db.prepare(
        `SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_start, timestamp_end, created_time, updated_time, metadata_json, occurred_at, valid_start, valid_end, certainty, source, valence, arousal, significance FROM l1_records WHERE record_id = ?`,
      ).get(id);
      if (!row) return false;
      this.db.exec("BEGIN");
      try {
        // SEC-1：INSERT 带租户三列（从被归档 l1_records 行取——归档行必须带归属；
        // 缺省兜 default 桶，与 l1_records 存量归一口径一致）。
        const r = row as Record<string, unknown>;
        this.db.prepare("INSERT INTO l1_archive (record_id, data, archived_at, reason, team_id, user_id, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(
            id, JSON.stringify(row), new Date().toISOString(), reason,
            typeof r.team_id === "string" && r.team_id.trim() !== "" ? r.team_id : DEFAULT_ISOLATION_ID,
            typeof r.user_id === "string" && r.user_id.trim() !== "" ? r.user_id : DEFAULT_ISOLATION_ID,
            typeof r.agent_id === "string" && r.agent_id.trim() !== "" ? r.agent_id : DEFAULT_ISOLATION_ID,
          );
        this.db.prepare("DELETE FROM l1_records WHERE record_id = ?").run(id);
        // 审计 B3：归档不再级联删边——边是关系事实，指向归档记录合法（getL1ByIdsWithArchive
        // 能解析证据链）；真正的删边留给 deleteL1（硬删）。此前归档删边会误伤 dedup
        // update/merge 刚建的 evolve/similar 边（writeMemory 归档 target 后 applyDecisions
        // 才建边，时序安全，但任何"先建边后归档"的路径都会断链）。
        if (this.stmtDeleteVec) this.stmtDeleteVec.run(id);
        if (this.ftsAvailable) this.stmtL1FtsDelete.run(id);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      this.logger?.debug?.(`${TAG} [l1_archive] archived ${id} (${reason})`);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_archive] archive failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 恢复：把归档行写回 l1_records（字段级回填；向量/嵌入由下次写入或重建补齐）。
   *
   * SEC-1（安全级）：可选 IsolationFilter 属主校验——filter 传入时归档行租户不匹配
   * 即拒绝（false，路由层 404，不泄漏跨租户存在性，宁严勿松）；租户以列为准
   * （SEC-1 迁移后列非空；NULL/'' 防御兜 default）。filter 缺省 = 旧行为（内部
   * 补偿/单机调用方，如 tcvdb restore-compensation）。
   */
  restoreL1(id: string, filter?: IsolationFilter): boolean {
    try {
      const row = this.db.prepare("SELECT data, team_id, user_id, agent_id FROM l1_archive WHERE record_id = ?").get(id) as { data: string; team_id?: string; user_id?: string; agent_id?: string } | undefined;
      if (!row) return false;
      if (filter && !rowMatchesIsolation(
        {
          team_id: row.team_id || DEFAULT_ISOLATION_ID,
          user_id: row.user_id || DEFAULT_ISOLATION_ID,
          agent_id: row.agent_id || DEFAULT_ISOLATION_ID,
        },
        filter,
      )) {
        this.logger?.warn?.(`${TAG} [l1_archive] restore ${id} rejected: archive tenant <${row.team_id}/${row.user_id}/${row.agent_id}> does not match requester isolation`);
        return false;
      }
      const d = JSON.parse(row.data) as Record<string, unknown>;
      this.db.exec("BEGIN");
      try {
        // 注意：26 列 ↔ 26 个 ?（P2a 加 soul 列时占位符数与列清单曾失配 → restoreL1 恒失败，
        // 审计 F5 修复：数齐。FTS 重建见下方 F5 块。）
        this.db.prepare(
          `INSERT OR REPLACE INTO l1_records (record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_start, timestamp_end, created_time, updated_time, metadata_json, occurred_at, valid_start, valid_end, certainty, source, valence, arousal, significance, sensitivity) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          d.record_id, d.content, d.type, d.priority, d.scene_name, d.session_key, d.session_id,
          d.team_id, d.task_id, d.user_id, d.agent_id, d.version, d.timestamp_str,
          d.timestamp_start, d.timestamp_end, d.created_time, d.updated_time, d.metadata_json,
          d.occurred_at, d.valid_start, d.valid_end, d.certainty, d.source, d.valence, d.arousal, d.significance,
          d.sensitivity ?? "none",
        );
        this.db.prepare("DELETE FROM l1_archive WHERE record_id = ?").run(id);
        // 审计 F5：恢复时重建 FTS 行（archive 时被删了）——否则恢复的记忆只能在
        // getL1ByIds/向量侧命中，BM25/FTS 召回不到。向量无法在此重建（需 embedding 服务，
        // 由下次写入或 `reembed` 脚本补齐，见 restoreL1 注释）。
        if (this.ftsAvailable) {
          try {
            this.stmtL1FtsInsert.run(
              // P1-T8（H-B9）：content 必须与写入侧同一函数分词（archive 存的 data.content
              // 是原文），否则恢复的中文记忆在 FTS 里是未分词整串，BM25 搜不到。
              tokenizeForFts(String(d.content ?? "")),
              d.content, d.record_id, d.type, d.priority, d.scene_name,
              d.session_key, d.session_id, d.team_id ?? "", d.task_id ?? "", d.user_id ?? "", d.agent_id ?? "",
              d.version ?? 0, d.timestamp_str, d.timestamp_start, d.timestamp_end,
              d.metadata_json ?? "{}",
              // soul 8 字段（P1-T7）：与写入侧同源取值（缺省语义一致）
              ...soulBindValues(d),
            );
          } catch (err) {
            this.logger?.warn?.(`${TAG} [l1_archive] restoreL1 FTS rebuild failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_archive] restore failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 列出归档（供 UI/审计，可恢复）。
   *
   * SEC-1（安全级）：可选 IsolationFilter 租户过滤——SQL 列级 WHERE（SEC-1 迁移后
   * 行内新列，buildIsolationWhere 同族）；filter 缺省 = 旧行为（实例级全量，单机/
   * verify 调用方兼容）。出参带 team_id/user_id/agent_id（面板归属徽标消费）。
   */
  listArchived(limit = 100, offset = 0, filter?: IsolationFilter): Array<{ record_id: string; archived_at: string; reason: string; content: string; occurred_at?: string; team_id: string; user_id: string; agent_id: string }> {
    try {
      const where = buildIsolationWhere(filter, "a.");
      const rows = this.db.prepare(
        `SELECT a.record_id, a.archived_at, a.reason,
                COALESCE(NULLIF(a.team_id,''),'${DEFAULT_ISOLATION_ID}') AS team_id,
                COALESCE(NULLIF(a.user_id,''),'${DEFAULT_ISOLATION_ID}') AS user_id,
                COALESCE(NULLIF(a.agent_id,''),'${DEFAULT_ISOLATION_ID}') AS agent_id,
                CAST(json_extract(a.data,'$.content') AS TEXT) AS content, json_extract(a.data,'$.occurred_at') AS occurred_at
         FROM l1_archive a${where.clause ? ` WHERE ${where.clause}` : ""} ORDER BY a.archived_at DESC LIMIT ? OFFSET ?`,
      ).all(...where.params, limit, offset) as unknown as Array<{ record_id: string; archived_at: string; reason: string; content: string; occurred_at?: string; team_id: string; user_id: string; agent_id: string }>;
      return rows ?? [];
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_archive] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── 核心记忆 + 价值锚（K）：stable 稳定锚定 / agent 可维护 / 情感参照系 ──

  /**
   * SEC-1（安全级，补 T12 漏网）：l1_archive 租户化迁移（幂等，init 时自动执行）。
   *
   * - 新库：DDL 已带三列 → 本方法只补建租户索引。
   * - 存量库（四列形态）：事务内 ALTER ADD team_id/user_id/agent_id + **全量回填**
   *   —— 注意坑点：SQLite `ADD COLUMN ... DEFAULT 'default'` 会让存量行立即读到
   *   'default'（非 NULL），不能用 IS NULL 检测待回填行；以"本次 init 是否刚加列"
   *   为触发条件（ALTER+回填同事务，崩溃即整体回滚，无半态）。
   * - 回填值来自每行 data JSON（archiveL1 存的 l1_records 全行快照，本就带租户三
   *   字段；JSON 损坏/缺字段 → 回填 default + loud 打印，不静默——安全级纪律）。
   * - 二次 init：列已存在 → 只做防御性 NULL/'' 归一（正常 0 行），幂等不炸。
   */
  private migrateArchiveTenantTable(): void {
    const dflt = DEFAULT_ISOLATION_ID;
    try {
      const info = this.db.prepare("PRAGMA table_info(l1_archive)").all() as Array<{ name: string }>;
      const names = info.map((c) => c.name);
      const missing = (["team_id", "user_id", "agent_id"] as const).filter((c) => !names.includes(c));
      if (missing.length > 0) {
        this.db.exec("BEGIN");
        try {
          for (const col of missing) {
            try { this.db.exec(`ALTER TABLE l1_archive ADD COLUMN ${col} TEXT NOT NULL DEFAULT '${dflt}'`); } catch { /* exists */ }
          }
          const { backfilled, corrupted } = this.backfillArchiveTenantColumns(true);
          this.db.exec("COMMIT");
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l1_archive_tenant ON l1_archive(team_id, user_id, agent_id)`);
          // loud 打印（安全级拍板：存量归属变更须知，T12 同款）
          this.logger?.warn?.(
            `${TAG} [archive-tenant-migrate] 存量 l1_archive 已租户化：${backfilled} 行按 data JSON 回填归属` +
            `${corrupted > 0 ? `（其中 ${corrupted} 行 JSON 损坏/缺字段 → 回填 <${dflt}/${dflt}/${dflt}>）` : ""}。` +
            `如需变更归属请 UPDATE l1_archive SET team_id/user_id/agent_id。`,
          );
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
      } else {
        // 列已存在（新库 / 已迁移库）：防御性归一 NULL/'' 行（正常 0 行，幂等）
        const { backfilled, corrupted } = this.backfillArchiveTenantColumns(false);
        if (backfilled > 0 || corrupted > 0) {
          this.logger?.warn?.(`${TAG} [archive-tenant-migrate] 防御回填 l1_archive 租户列：${backfilled} 行（损坏 ${corrupted} 行 → default）`);
        }
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l1_archive_tenant ON l1_archive(team_id, user_id, agent_id)`);
      }
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [archive-tenant-migrate] l1_archive 租户化迁移失败（幂等，下次 init 重试）: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * SEC-1：l1_archive 存量行回填 team_id/user_id/agent_id（从 data JSON 解析）。
   * @param allRows true=全量行回填（刚 ALTER 完，存量行读到 ADD COLUMN 默认值，无法区分"真 default"）；
   *                false=只回填 NULL/'' 防御行。
   * @returns { backfilled: 实际 UPDATE 的行数, corrupted: JSON 解析失败行数 }
   */
  private backfillArchiveTenantColumns(allRows: boolean): { backfilled: number; corrupted: number } {
    const dflt = DEFAULT_ISOLATION_ID;
    const rows = (allRows
      ? this.db.prepare("SELECT record_id, data FROM l1_archive")
      : this.db.prepare("SELECT record_id, data FROM l1_archive WHERE team_id IS NULL OR team_id = '' OR user_id IS NULL OR user_id = '' OR agent_id IS NULL OR agent_id = ''")
    ).all() as Array<{ record_id: string; data: string }>;
    if (rows.length === 0) return { backfilled: 0, corrupted: 0 };
    const upd = this.db.prepare("UPDATE l1_archive SET team_id = ?, user_id = ?, agent_id = ? WHERE record_id = ?");
    let backfilled = 0;
    let corrupted = 0;
    for (const row of rows) {
      let teamId = dflt;
      let userId = dflt;
      let agentId = dflt;
      try {
        const d = JSON.parse(row.data) as Record<string, unknown>;
        teamId = typeof d.team_id === "string" && d.team_id.trim() !== "" ? d.team_id : dflt;
        userId = typeof d.user_id === "string" && d.user_id.trim() !== "" ? d.user_id : dflt;
        agentId = typeof d.agent_id === "string" && d.agent_id.trim() !== "" ? d.agent_id : dflt;
      } catch {
        corrupted++;
        // loud 打印（安全级纪律：损坏行不静默——回填 default 桶，归属请人工核对）
        this.logger?.warn?.(
          `${TAG} [archive-tenant-migrate] l1_archive 行 ${row.record_id} data JSON 解析失败，租户回填 <${dflt}/${dflt}/${dflt}>（请人工核对该行归属）`,
        );
      }
      upd.run(teamId, userId, agentId, row.record_id);
      backfilled++;
    }
    return { backfilled, corrupted };
  }

  /**
   * P2-T12（K1）core 两表租户化迁移（幂等，init 时自动执行）。
   *
   * - 新库：DDL 已带租户列且无单列 PK → 本方法只补建复合唯一索引（IF NOT EXISTS）。
   * - 存量库（缺 team_id 列 或 仍是 slot/value_id 单列 PK）：轻量重建
   *   （CREATE new + INSERT SELECT + DROP + rename，同 FTS 迁移模式）—— 单列 PK
   *   会阻塞"同 slot 不同租户并存"，SQLite 又无法 ALTER PK，必须重建解除；
   *   生产仅 core_memory 1 行 + core_values 6 行，重建成本可忽略（执行裁决登记：
   *   新库走唯一索引方案，存量库重建只为解除 PK，两表其余结构不变）。
   * - 回填值 = DEFAULT_ISOLATION_ID（"default"，拍板⑤ + 两处裁决对齐：/v2 匿名
   *   读写 default 桶，存量行回填 default 后匿名路径读到原数据，行为连续）。
   *   init 时无请求上下文，无更精确的实例身份来源 —— 如需变更归属请 UPDATE
   *   （迁移完成时 loud 打印提示）。
   * - 失败不 degrade：warn 后继续用旧表（幂等，下次 init 重试）。
   */
  private migrateCoreTenantTables(): void {
    const backfill = DEFAULT_ISOLATION_ID;
    const specs = [
      {
        table: "core_memory",
        pkCol: "slot",
        dataCols: ["slot", "content", "source", "version", "updated_at"],
        index: "idx_core_memory_tenant",
        uniqueCols: "slot, team_id, user_id, agent_id",
      },
      {
        table: "core_values",
        pkCol: "value_id",
        dataCols: ["value_id", "label", "weight", "created_by"],
        index: "idx_core_values_tenant",
        uniqueCols: "value_id, team_id, user_id, agent_id",
      },
    ];
    for (const spec of specs) {
      try {
        const info = this.db.prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string; pk: number }>;
        const names = info.map((c) => c.name);
        const hasTeamId = names.includes("team_id");
        const pkCols = info.filter((c) => c.pk > 0).map((c) => c.name);
        const legacySinglePk = pkCols.length === 1 && pkCols[0] === spec.pkCol;
        if (hasTeamId && !legacySinglePk) {
          // 已是租户化形态（新库 / 已迁移库）→ 只确保唯一索引
          this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${spec.index} ON ${spec.table} (${spec.uniqueCols})`);
          continue;
        }
        // C2：T12 重建路径保留已判定的 valence（列存在才带上；防御 T12 迁移失败
        // 重试的下次 init——先加过 valence 列的库再走重建时不丢列）。
        const hasValence = spec.table === "core_values" && names.includes("valence");
        const dataSel = spec.dataCols.join(", ") + (hasValence ? ", valence" : "");
        const teamSel = hasTeamId ? "COALESCE(NULLIF(team_id, ''), ?)" : "?";
        this.db.exec("BEGIN");
        try {
          this.db.exec(`
            CREATE TABLE ${spec.table}_t12 (
              ${spec.pkCol} TEXT NOT NULL,
              ${spec.table === "core_memory"
                ? "content TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT ''"
                : "label TEXT NOT NULL DEFAULT '', weight REAL NOT NULL DEFAULT 0.5, created_by TEXT NOT NULL DEFAULT ''"}${hasValence ? ",\n              valence REAL" : ""},
              team_id TEXT NOT NULL DEFAULT '${DEFAULT_ISOLATION_ID}',
              user_id TEXT NOT NULL DEFAULT '${DEFAULT_ISOLATION_ID}',
              agent_id TEXT NOT NULL DEFAULT '${DEFAULT_ISOLATION_ID}'
            )
          `);
          this.db.prepare(
            `INSERT INTO ${spec.table}_t12 (${dataSel}, team_id, user_id, agent_id) SELECT ${dataSel}, ${teamSel}, ?, ? FROM ${spec.table}`,
          ).run(backfill, backfill, backfill);
          const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${spec.table}_t12`).get() as { n: number }).n;
          this.db.exec(`DROP TABLE ${spec.table}`);
          this.db.exec(`ALTER TABLE ${spec.table}_t12 RENAME TO ${spec.table}`);
          this.db.exec("COMMIT");
          this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${spec.index} ON ${spec.table} (${spec.uniqueCols})`);
          // loud 打印（拍板⑤升级须知）：存量行归属 + 变更指引
          this.logger?.warn?.(
            `${TAG} [core-tenant-migrate] 存量 ${spec.table} 已租户化：${count} 行回填归属 ` +
            `<${backfill}/${backfill}/${backfill}>（team/user/agent，拍板⑤）。` +
            `如需变更归属请 UPDATE ${spec.table} SET team_id/user_id/agent_id。`,
          );
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
      } catch (err) {
        this.logger?.warn?.(
          `${TAG} [core-tenant-migrate] ${spec.table} 租户化迁移失败（幂等，下次 init 重试）: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * PA（推翻 spec §5.1 裁决 2）：default 锚扇出迁移（幂等，init 时自动执行，SEC-1 模式）。
   *
   * 背景：价值锚从"实例级 default 单桶 + 空桶读时兜底"改为 per-agent 严格独立后，
   * 存量 default 桶的锚必须复制到每个**有记忆的** agent 桶，否则各 agent 全部变空桶。
   *
   * - 扇出源：default 桶全部锚（全态，含 retired/vetoed——state 沿用，语义连续）。
   * - 扇出目标：l1_records 中出现的每个 distinct (team_id,user_id,agent_id) 三元组
   *   （**有记忆的 agent 才扇出**，无记忆 agent 保持空桶；default 三元组自身跳过——
   *   锚本来就在那里）。l1_records 列有 init 早期的 ''→'default' 归一兜底，再用
   *   COALESCE(NULLIF(...)) 双保险。
   * - 复制语义：INSERT OR IGNORE（幂等关键）——已有自己锚的 agent 不受影响（同
   *   (value_id,team,user,agent) 冲突即忽略，不覆盖 agent 自己的微调）；origin 强制
   *   'seed'（扇出副本对每个 agent 而言都是启动种子，史实登记），pinned/valence/
   *   weight/label/created_by/state 全部沿用（created_by 保留源头可追溯性）。
   * - 前提守卫：幂等依赖复合唯一索引 idx_core_values_tenant；索引缺失（存量重复行
   *   阻塞建索引的极端库）→ warn + 跳过（宁可下次重试，不做无幂等保障的写入）。
   * - loud 统计：扇出 agent 数/锚数/新写入行数（仅 inserted>0 时打印，稳态 init 静默）。
   * - 事务：BEGIN/COMMIT，失败 ROLLBACK + warn（非致命，下次 init 重试，T12 同款）。
   */
  private fanoutDefaultValuesToAgents(): void {
    try {
      const idx = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='core_values' AND name='idx_core_values_tenant'",
      ).get() as { name?: string } | undefined;
      if (!idx?.name) {
        this.logger?.warn?.(`${TAG} [values-per-agent-migrate] idx_core_values_tenant 唯一索引缺失，跳过 default 锚扇出（幂等，索引修复后下次 init 重试）`);
        return;
      }
      const defaultAnchors = this.db.prepare(
        "SELECT value_id, label, weight, created_by, valence, origin, pinned, state FROM core_values WHERE team_id = ? AND user_id = ? AND agent_id = ?",
      ).all(DEFAULT_ISOLATION_ID, DEFAULT_ISOLATION_ID, DEFAULT_ISOLATION_ID) as Array<{
        value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: string; pinned: number; state: string;
      }>;
      if (defaultAnchors.length === 0) return;
      const tripletRows = this.db.prepare(
        "SELECT DISTINCT COALESCE(NULLIF(team_id,''),'default') AS team_id, COALESCE(NULLIF(user_id,''),'default') AS user_id, COALESCE(NULLIF(agent_id,''),'default') AS agent_id FROM l1_records",
      ).all() as Array<{ team_id: string; user_id: string; agent_id: string }>;
      const targets = tripletRows.filter(
        (r) => !(r.team_id === DEFAULT_ISOLATION_ID && r.user_id === DEFAULT_ISOLATION_ID && r.agent_id === DEFAULT_ISOLATION_ID),
      );
      if (targets.length === 0) return;
      this.db.exec("BEGIN");
      try {
        let inserted = 0;
        const insert = this.db.prepare(
          "INSERT OR IGNORE INTO core_values (value_id, label, weight, created_by, valence, origin, pinned, state, team_id, user_id, agent_id) " +
          "VALUES (?, ?, ?, ?, ?, 'seed', ?, ?, ?, ?, ?)",
        );
        for (const t of targets) {
          for (const a of defaultAnchors) {
            const res = insert.run(a.value_id, a.label, a.weight, a.created_by, a.valence, a.pinned, a.state, t.team_id, t.user_id, t.agent_id);
            inserted += Number(res.changes);
          }
        }
        this.db.exec("COMMIT");
        if (inserted > 0) {
          this.logger?.warn?.(
            `${TAG} [values-per-agent-migrate] default 锚扇出：有记忆 agent ${targets.length} 个 × default 锚 ${defaultAnchors.length} 条，` +
            `新写入 ${inserted} 行（origin='seed'，pinned/valence/state 沿用；无记忆 agent 不扇出；幂等 INSERT OR IGNORE）。` +
            `生产影响预警：重启后各 agent 锚桶 = default 扇出副本，此后自生长按 agent 分叉演化。`,
          );
        }
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [values-per-agent-migrate] default 锚扇出迁移失败（幂等，下次 init 重试）: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * P2-T12（K1）：按租户 upsert —— 冲突目标为复合唯一索引 (slot, team_id, user_id, agent_id)，
   * 同 (slot,tenant) 幂等递增 version，不同租户同 slot 并存。
   * tenant 缺省 = default 桶（仅实例级内部调用方；HTTP handler 必须显式传入）。
   */
  upsertCore(slot: string, content: string, source = "manual", tenant?: CoreTenant): boolean {
    const t = normalizeCoreTenant(tenant);
    try {
      const prev = this.db.prepare(
        "SELECT version FROM core_memory WHERE slot = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
      ).get(slot, t.teamId, t.userId, t.agentId) as { version?: number } | undefined;
      const version = (prev?.version ?? 0) + 1;
      this.db.prepare(
        "INSERT INTO core_memory (slot, content, source, version, updated_at, team_id, user_id, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(slot, team_id, user_id, agent_id) DO UPDATE SET content=excluded.content, source=excluded.source, version=excluded.version, updated_at=excluded.updated_at",
      ).run(slot, content, source, version, new Date().toISOString(), t.teamId, t.userId, t.agentId);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_memory] upsertCore failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** P2-T12（K1）：按租户读 —— 只返回本租户的 slots；返回结构不变（slots 数组）。 */
  readCore(tenant?: CoreTenant): Array<{ slot: string; content: string; source: string; version: number; updated_at: string }> {
    const t = normalizeCoreTenant(tenant);
    try {
      return (this.db.prepare(
        "SELECT slot, content, source, version, updated_at FROM core_memory WHERE team_id = ? AND user_id = ? AND agent_id = ? ORDER BY slot",
      ).all(t.teamId, t.userId, t.agentId) as unknown as Array<{ slot: string; content: string; source: string; version: number; updated_at: string }>) ?? [];
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_memory] readCore failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * P2-T12（K1）：按租户 upsert 价值锚。
   * C2（spec §3.1）：增可选 valence（动机方向）。clamp 三值：+1/-1/0（round 后 clamp [-1,1]）。
   * GROW：增可选 origin（seed|manual|auto，来源徽标；缺省 manual=人类/agent 写）。
   * 语义（三方优先级）：
   *   - 显式传 valence → 写入（新建落值；冲突覆盖旧值——用户微调永远优先）；
   *   - 未传（undefined）→ 新建落 NULL（待 LLM 判）；冲突时**不触碰** valence 列
   *     （plain upsert 不重置已有方向，LLM/微调值都保留）。
   *   - 冲突路径 state='active'（GROW 裁定，报告 §0.1）：显式重建 = 明确意图
   *     （retired → 即恢复；vetoed → 即撤销否决）；自动管道的 veto 不可重提由
   *     自生长去重查全态保证，与本写路径正交。origin/pinned 冲突不改写（裁定 3）。
   */
  upsertValue(valueId: string, label: string, weight: number, createdBy = "manual", tenant?: CoreTenant, valence?: number, origin: "seed" | "manual" | "auto" = "manual", nodeType: "theme" | "person" = "theme", attrs?: { role?: string; aliases?: string[]; description?: string }): boolean {
    const t = normalizeCoreTenant(tenant);
    const v = valence === undefined ? null : Math.min(1, Math.max(-1, Math.round(valence)));
    // P2（spec §2.6）：attrs_json 序列化单点——role/aliases 可选字段按需并入；
    // DO UPDATE 不碰 node_type（A8：类型归属写定后不随重写漂移），attrs_json 仅显式传入时更新。
    // 立项①（2026-09-23 拍板）：rationale 通道——description 并入 attrs_json（锚语义持久化）
    const attrsJson = attrs === undefined
      ? "{}"
      : JSON.stringify({
          ...(attrs.role === undefined ? {} : { role: attrs.role }),
          ...(attrs.aliases === undefined ? {} : { aliases: attrs.aliases }),
          ...(attrs.description === undefined ? {} : { description: attrs.description }),
        });
    try {
      this.db.prepare(
        "INSERT INTO core_values (value_id, label, weight, created_by, valence, origin, pinned, state, team_id, user_id, agent_id, node_type, attrs_json) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?, ?) " +
        "ON CONFLICT(value_id, team_id, user_id, agent_id) DO UPDATE SET label=excluded.label, weight=excluded.weight, state='active'" +
        (v === null ? "" : ", valence=excluded.valence") +
        (attrs === undefined ? "" : ", attrs_json=excluded.attrs_json"),
      ).run(valueId, label, weight, createdBy, v, origin, t.teamId, t.userId, t.agentId, nodeType, attrsJson);
      this.invalidateValuesCache(); // E2 失效钩子（写路径 1/8）
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] upsertValue failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** P2-T12（K1）：按租户读价值锚。tenant 缺省 = default 桶（遗忘 worker 价值锚语义不变）。
   *  C2：返回行携带 valence（number | null，NULL=未判定）。
   *  GROW：出参带 origin/pinned/state；默认只回 state='active'（退休/否决锚退出匹配面
   *  = 预期行为，报告 §0.2）；opts.includeRetired=true → active+retired（Panel 退休区用；
   *  vetoed 在任何读面都不可见——「永久否决」只活在 any-state 全态读里）。
   *  PA（推翻 spec §5.1 裁决 2）：**严格无兜底**——listValues 只返回该 agent 桶的内容
   *  （可为空）。原 S6 第 5 项"非 default 租户空桶 → 读时回退 default 桶锚"分支已移除；
   *  存量锚经 fanoutDefaultValuesToAgents 扇出到各 agent 桶（有记忆才扇出），空桶 agent
   *  对 appraisal/R9/价值面板显示空（预期行为）。遗忘侧不受影响：forgetting-worker 无
   *  tenant 调用（default 桶，实例级语义）。
   *
   *  R-A3（E2 性能速赢）：租户级 TTL 缓存——key=租户三元组+includeRetired 变体位
   *  （GROW：两个读面是独立缓存条目）；全部 core_values 写路径（八处，见类字段注释）
   *  统一挂 invalidateValuesCache 钩子，TTL 仅作跨进程写漂移防御（默认 60s，0=缓存关）。
   *  缓存命中返回行克隆（防调用方就地改写缓存）。 */
  listValues(tenant?: CoreTenant, opts?: { includeRetired?: boolean }): Array<{ value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed"; node_type: "theme" | "person"; attrs_json: string }> {
    const t = normalizeCoreTenant(tenant);
    const includeRetired = opts?.includeRetired === true;
    // S7 第 9 项（批 2 审查 M-6）：JSON.stringify 取代 `|` 裸拼接（沿 S2 模式）——
    // 三元组段含 `|` 时裸拼接会碰撞（"t1|x"/"u" vs "t1"/"x|u"），命中对方缓存行脏读。
    // GROW：第 4 位 = includeRetired 变体位（默认读与退休区读互不脏读）。
    const cacheKey = JSON.stringify([t.teamId, t.userId, t.agentId, includeRetired ? 1 : 0]);
    if (this.valuesCacheTtlMs > 0) {
      const hit = this.valuesCache.get(cacheKey);
      if (hit && Date.now() - hit.at < this.valuesCacheTtlMs) {
        this.valuesCacheHits++;
        this.logger?.debug?.(`${TAG} [core_values] listValues cache HIT (age=${Date.now() - hit.at}ms) tenant=${cacheKey}`);
        return hit.rows.map((r) => ({ ...r }));
      }
      if (hit) this.valuesCache.delete(cacheKey); // 过期条目清除
    }
    try {
      // GROW：state 过滤（active-only 默认 / active+retired 退休区读）。vetoed 永不出现。
      const stateFilter = includeRetired ? " AND state IN ('active','retired')" : " AND state='active'";
      const readRows = (teamId: string, userId: string, agentId: string) =>
        (this.db.prepare(
          `SELECT value_id, label, weight, created_by, valence, origin, pinned, state, node_type, attrs_json FROM core_values WHERE team_id = ? AND user_id = ? AND agent_id = ?${stateFilter} ORDER BY weight DESC`,
        ).all(teamId, userId, agentId) as unknown as Array<{ value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed"; node_type: "theme" | "person"; attrs_json: string }>) ?? [];
      const rows = readRows(t.teamId, t.userId, t.agentId);
      // PA：严格无兜底——空桶返回 []，不再读时回退 default 桶（原 S6 第 5 项分支移除）。
      // S7 第 9 项（批 2 审查 M-6）：miss 计数移到真实读成功之后——计数器语义是
      // "valuesCacheMisses = 真实 DB 查询次数"，SQL 异常路径（catch → []）不算查询
      // （修复前自增在 try 之前，异常路径也 +1，观测失真）。
      this.valuesCacheMisses++;
      if (this.valuesCacheTtlMs > 0) {
        this.valuesCache.set(cacheKey, { rows: rows, at: Date.now() });
      }
      return rows;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] listValues failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * GROW：全态读（active/retired/vetoed 不过滤、不走缓存、不做 S6 兜底）。
   * 专用两个调用方：① 自生长去重（veto 永不重提 + 名额计数）；② server 种子判空
   * （全种子被 veto 后重启不得复活——active-only 判空会误判空桶重灌）。
   */
  listValuesAnyState(tenant?: CoreTenant): Array<{ value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed"; node_type: "theme" | "person"; attrs_json: string }> {
    const t = normalizeCoreTenant(tenant);
    try {
      return (this.db.prepare(
        "SELECT value_id, label, weight, created_by, valence, origin, pinned, state, node_type, attrs_json FROM core_values WHERE team_id = ? AND user_id = ? AND agent_id = ? ORDER BY weight DESC",
      ).all(t.teamId, t.userId, t.agentId) as unknown as Array<{ value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed"; node_type: "theme" | "person"; attrs_json: string }>) ?? [];
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] listValuesAnyState failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * C2（spec §3.1 v2 / §3.2）：LLM 批量判定本租户 valence IS NULL 的价值锚（总结初值）。
   *
   * 语义（三方优先级的实现锚点）：
   *   - **只判 NULL 行**：fire-and-forget 钩子（启动后 / upsert 新建后）与显式调用共用
   *     本方法，永不触碰非 NULL 值——用户微调优先，LLM 永不覆盖（R3 前提）。
   *   - **写回守卫（Critical-1，C2 复审）**：SELECT 出 NULL 清单后、LLM 30s 窗口内，
   *     用户微调（upsert 带 valence）可能已落库。UPDATE 带 `AND (valence IS NULL)`
   *     守卫，使微调值不可被 LLM 判定无条件覆盖（命中行 UPDATE 变 no-op）；
   *     derived 用真实 `changes` 计数，重复 value_id 也不再双计。
   *   - **重置语义不在本方法**：原 opts.reset（先全租户置 NULL 再判）在 LLM 失败时
   *     会造成微调值永久丢失（Important-1），已移除；重判入口改用 handler 侧
   *     apply-after-success（resetValueValences 快照 + 判定后恢复无效行），
   *     见 v2-router handleCoreMemoryValuesDerive。
   *   - 三值枚举：只接受 -1/0/1；不确定给 0 由 prompt 约定，非枚举值/幻觉 value_id/
   *     解析失败 → 该行保持 NULL（R3：降级可见且无害，宁缺毋滥）。
   *
   * @returns derived=本次真实写出的行数（changes 口径）；skipped=清单行中未由本方法
   *          写出的行数（守卫拦截 / 非法枚举 / 幻觉 id 等）。无 runner / 无 NULL 行
   *          → {0,0}（稳态零成本）。
   */
  async deriveValueValences(
    tenant?: CoreTenant,
    llmRunner?: { run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number; maxTokens?: number }): Promise<string> },
  ): Promise<{ derived: number; skipped: number }> {
    const t = normalizeCoreTenant(tenant);
    try {
      if (!llmRunner) return { derived: 0, skipped: 0 };
      const rows = this.db.prepare(
        "SELECT value_id, label FROM core_values WHERE valence IS NULL AND state='active' AND team_id = ? AND user_id = ? AND agent_id = ? ORDER BY weight DESC",
      ).all(t.teamId, t.userId, t.agentId) as unknown as Array<{ value_id: string; label: string }>;
      if (rows.length === 0) return { derived: 0, skipped: 0 };
      // 判定的是该价值的**语义倾向**（如"正确"→趋近类），不是情绪——渲染措辞保持陈述性（spec §3.1）。
      const systemPrompt =
        "你是价值方向判定器。判定每个团队价值锚的动机方向：1=趋近类（达成它会推动行动，如正确/可靠/高效）；" +
        "-1=审慎回避类（它提醒风险需要谨慎，如安全/风险/合规红线）；0=中性或无法判定。" +
        "只输出 JSON：{\"valences\":[{\"value_id\":\"<id>\",\"valence\":1|-1|0}]}，不要其他文字。" +
        "不确定给 0；严禁输出清单之外的 value_id；宁缺毋滥，拿不准就给 0。";
      const prompt =
        "价值锚清单：\n" +
        rows.map((r) => `- ${r.value_id}（${r.label}）`).join("\n") +
        "\n\n判定每个价值锚的动机方向。";
      const raw = await llmRunner.run({ prompt, systemPrompt, taskId: "core-values-valence-derive", timeoutMs: 0, maxTokens: 0 });
      let parsed: { valences?: unknown };
      try {
        parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, ""));
      } catch {
        return { derived: 0, skipped: rows.length };
      }
      const validIds = new Set(rows.map((r) => r.value_id));
      const items = Array.isArray((parsed as { valences?: unknown }).valences)
        ? (parsed as { valences: Array<{ value_id?: unknown; valence?: unknown }> }).valences
        : [];
      let derived = 0;
      for (const item of items) {
        const id = typeof item?.value_id === "string" ? item.value_id : "";
        const val = item?.valence;
        // 防御（P-D 同族）：过滤清单之外的 value_id（LLM 幻觉）；三值枚举之外一律拒写。
        if (!id || !validIds.has(id)) continue;
        if (val !== -1 && val !== 0 && val !== 1) continue;
        // Critical-1（C2 复审）：`AND (valence IS NULL)` 守卫——SELECT NULL 清单后、
        // LLM 窗口内用户微调落库的值不被无条件覆盖（三方语义 1 的写回侧闭环）。
        // derived 取真实 changes：微调拦截行不计数，重复 value_id 不双计。
        const res = this.db.prepare(
          "UPDATE core_values SET valence = ? WHERE value_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND (valence IS NULL)",
        ).run(val, id, t.teamId, t.userId, t.agentId);
        derived += Number(res.changes);
      }
      if (derived > 0) this.invalidateValuesCache(); // E2 失效钩子（写路径 6/8：有真实写出才失效）
      return { derived, skipped: rows.length - derived };
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] deriveValueValences failed: ${err instanceof Error ? err.message : String(err)}`);
      return { derived: 0, skipped: 0 };
    }
  }

  /**
   * Important-1（C2 复审，apply-after-success）：重置本租户 valence（重判入口专用）。
   * 先快照现有非 NULL (value_id, valence) 对 → 再置 NULL —— 快照由调用方（handler）
   * 持有，LLM 判定完成后：判定成功 → 新值生效（重置语义已提交）；失败/不可判定 →
   * 用 restoreValueValences 从快照恢复原值。与 deriveValueValences 一样按租户三元组过滤。
   *
   * 注意：reset 后到恢复前，这些行处于 NULL（渲染不输出方向行，宁缺毋滥，无害降级）；
   * LLM 窗口内用户微调的行 valence 非 NULL，restoreValueValences 的 `valence IS NULL`
   * 守卫保证其不被快照旧值覆盖（微调优先）。
   *
   * C6 清债（裁定）：**快照只含 state='active' 行**——vetoed（软删除）/retired 行不进
   * 快照、reset 置 NULL 后保持 NULL（否决语义：veto = 用户否决方向，reset/重判
   * 失败恢复都不复活它，无方向直到重新采纳）。置 NULL 的 UPDATE 不过滤 state
   * （vetoed/retired 的旧方向一并清掉）；active 行失败可由快照恢复。
   *
   * @returns 恢复所需快照 [{value_id, valence}]（仅 state='active' 且非 NULL 行；C6 清债裁定）。
   *          S6 第 7 项（C2 fix1 复审 Low 2）：SQL 失败不再静默返回 []（会被调用方误读为
   *          "无值可重置"而以 code=0 假成功放行）——改为抛错，handler catch → 503 明示；
   *          空快照（无值可重置）仍是合法返回 []（调用方继续 derive 只判 NULL 行）。
   */
  resetValueValences(tenant?: CoreTenant): Array<{ value_id: string; valence: number }> {
    const t = normalizeCoreTenant(tenant);
    try {
      const snapshot = (this.db.prepare(
        "SELECT value_id, valence FROM core_values WHERE valence IS NOT NULL AND state = 'active' AND team_id = ? AND user_id = ? AND agent_id = ? ORDER BY value_id",
      ).all(t.teamId, t.userId, t.agentId) as unknown as Array<{ value_id: string; valence: number | null }>)
        .filter((r): r is { value_id: string; valence: number } => typeof r.value_id === "string" && r.value_id !== "" && r.valence !== null)
        .map((r) => ({ value_id: r.value_id, valence: r.valence }));
      if (snapshot.length > 0) {
        this.db.prepare(
          "UPDATE core_values SET valence = NULL WHERE team_id = ? AND user_id = ? AND agent_id = ? AND valence IS NOT NULL",
        ).run(t.teamId, t.userId, t.agentId);
        this.invalidateValuesCache(); // E2 失效钩子（写路径 7/8）
      }
      return snapshot;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] resetValueValences failed (throwing to handler): ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * Important-1（C2 复审，apply-after-success）：从快照恢复仍为 NULL 的 valence。
   * 逐行 `AND (valence IS NULL)` 守卫：LLM 判定已生效的行 / LLM 窗口内用户微调的行
   * 均不恢复（前者已有新值，后者微调优先）；返回真实恢复行数（changes 口径）。
   * 仅供 v2-router 重判入口的失败恢复路径使用。
   *
   * S6 第 6 项（C2 fix1 复审 Low 1）：恢复循环包事务（BEGIN/COMMIT，与文件内既有
   * 写事务模式一致）——中途抛错时原实现已恢复的首行落库、尾部行保持 NULL（半态）
   * 且快照静默丢弃；事务化后任一行失败 → ROLLBACK（无半态，全 NULL 可整批重试）
   * + 重抛，由 handler catch → 503 明示。
   */
  restoreValueValences(tenant?: CoreTenant, snapshot?: Array<{ value_id: string; valence: number }>): number {
    const t = normalizeCoreTenant(tenant);
    if (!Array.isArray(snapshot) || snapshot.length === 0) return 0;
    try {
      this.db.exec("BEGIN");
      let restored = 0;
      for (const s of snapshot) {
        if (typeof s?.value_id !== "string" || s.value_id === "") continue;
        if (s.valence !== -1 && s.valence !== 0 && s.valence !== 1) continue;
        const res = this.db.prepare(
          "UPDATE core_values SET valence = ? WHERE value_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND (valence IS NULL)",
        ).run(s.valence, s.value_id, t.teamId, t.userId, t.agentId);
        restored += Number(res.changes);
      }
      this.db.exec("COMMIT");
      this.invalidateValuesCache(); // E2 失效钩子（写路径 8/8）
      return restored;
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* RAISE(ABORT) 等场景下引擎可能已回滚 */ }
      this.logger?.warn?.(`${TAG} [core_values] restoreValueValences failed (rolled back, throwing to handler): ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * S1（K7/M-5）→ GROW 软删除裁定（报告 §0.1 裁定 1）：按租户否决价值锚。
   * `UPDATE state='vetoed' WHERE … AND state IN ('active','retired')`——硬删除无法跨
   * 发现轮次记住"永久否决"（brief 设计裁定）。行保留在库中，退出一切读面
   * （active-only / includeRetired 均排除 vetoed）；veto 永不重提由自生长去重查全态保证。
   * 返回是否真否决了一行（再删 vetoed → 0 行变更 → false，与旧"再删 false"观测一致）。
   */
  deleteValue(valueId: string, tenant?: CoreTenant): boolean {
    const t = normalizeCoreTenant(tenant);
    try {
      const res = this.db.prepare(
        "UPDATE core_values SET state='vetoed' WHERE value_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND state IN ('active','retired')",
      ).run(valueId, t.teamId, t.userId, t.agentId);
      this.invalidateValuesCache(); // E2 失效钩子（写路径 2/8）
      return Number(res.changes) > 0;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] deleteValue failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** GROW（钉住）：pinned 翻转。只作用 active|retired（vetoed 拒绝——不在任何读面，宁缺毋滥）。 */
  setValuePinned(valueId: string, pinned: boolean, tenant?: CoreTenant): boolean {
    const t = normalizeCoreTenant(tenant);
    try {
      const res = this.db.prepare(
        "UPDATE core_values SET pinned = ? WHERE value_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND state IN ('active','retired')",
      ).run(pinned ? 1 : 0, valueId, t.teamId, t.userId, t.agentId);
      this.invalidateValuesCache(); // E2 失效钩子（写路径 3/8）
      return Number(res.changes) > 0;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] setValuePinned failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** GROW（手动退休）：state → 'retired'（面板退休区可见，可恢复/可钉住）。 */
  retireValue(valueId: string, tenant?: CoreTenant): boolean {
    const t = normalizeCoreTenant(tenant);
    try {
      const res = this.db.prepare(
        "UPDATE core_values SET state='retired' WHERE value_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND state IN ('active','retired')",
      ).run(valueId, t.teamId, t.userId, t.agentId);
      this.invalidateValuesCache(); // E2 失效钩子（写路径 4/8）
      return Number(res.changes) > 0;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] retireValue failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** GROW（恢复）：retired → active。vetoed 拒绝（撤销否决须显式重添 upsert，见裁定 2）。 */
  restoreValue(valueId: string, tenant?: CoreTenant): boolean {
    const t = normalizeCoreTenant(tenant);
    try {
      const res = this.db.prepare(
        "UPDATE core_values SET state='active' WHERE value_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND state = 'retired'",
      ).run(valueId, t.teamId, t.userId, t.agentId);
      this.invalidateValuesCache(); // E2 失效钩子（写路径 5/8）
      return Number(res.changes) > 0;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] restoreValue failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * GROW：自生长调度状态读（last_discovery_at / last_corpus_count）。未初始化 → null 基线。
   * PA：tenant 可选——default/缺省保持旧键（last_discovery_at / last_corpus_count，旧行为
   * 与旧调用形状不变）；非 default 三元组用 per-tenant 独立键（双门基线按 agent 隔离）。
   */
  /** 自维护观测（D8）：一次查询返回全部自计数（每 tick 一次，成本可忽略）。 */
  getSelfObsStats(): { l1: number; conflict: number; evolve: number; similar: number; archived: number; anchors: number } {
    try {
      const one = (sql: string) => Number(this.db.prepare(sql).get()?.n ?? 0);
      return {
        l1: one("SELECT COUNT(*) AS n FROM l1_records"),
        conflict: one("SELECT COUNT(*) AS n FROM l1_links WHERE type = 'conflict'"),
        evolve: one("SELECT COUNT(*) AS n FROM l1_links WHERE type = 'evolve'"),
        similar: one("SELECT COUNT(*) AS n FROM l1_links WHERE type = 'similar'"),
        archived: one("SELECT COUNT(*) AS n FROM l1_archive"),
        anchors: one("SELECT COUNT(*) AS n FROM core_values WHERE state = 'active'"),
      };
    } catch {
      return { l1: 0, conflict: 0, evolve: 0, similar: 0, archived: 0, anchors: 0 };
    }
  }

  /** GROW-EVO P2.1（锚↔记忆双向链路）：coreRefs 回填（读改写 + 双表同步——invalidateL1 教训）。 */
  backfillCoreRef(recordId: string, label: string, tenant?: CoreTenant): boolean {
    return this.backfillMemoryRef(recordId, "coreRefs", label, tenant);
  }

  /**
   * P2（spec §2.6）：通用记忆↔锚/身份 refs 回填键族单源——coreRefs（主题锚）/personRefs
   * （人物锚，F12 证据链）/identityRefs（身份事实 20 字切片弱口径，GROW-MAINT F15/F14 数据前提）。
   * 同键去重（已含 label → 幂等 false）；metadata + l1_fts 双写（与 backfillCoreRef 同款）。
   */
  backfillMemoryRef(recordId: string, key: "coreRefs" | "personRefs" | "identityRefs", label: string, tenant?: CoreTenant): boolean {
    try {
      const t = normalizeCoreTenant(tenant);
      const row = this.db.prepare(
        "SELECT metadata_json FROM l1_records WHERE record_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
      ).get(recordId, t.teamId, t.userId, t.agentId) as { metadata_json?: string } | undefined;
      if (!row) return false;
      const meta = row.metadata_json && row.metadata_json !== "{}" ? JSON.parse(row.metadata_json) : {};
      const refs = Array.isArray(meta[key]) ? meta[key] : [];
      if (refs.includes(label)) return false;
      refs.push(label);
      const updated = JSON.stringify({ ...meta, [key]: refs });
      this.db.prepare("UPDATE l1_records SET metadata_json = ? WHERE record_id = ?").run(updated, recordId);
      if (this.ftsAvailable) {
        this.db.prepare("UPDATE l1_fts SET metadata_json = ? WHERE record_id = ?").run(updated, recordId);
      }
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] backfillMemoryRef failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ── O13（P2）：core_pending 三方法（同步——与 upsertCore/listValues 同款 sqlite 语义）────

  upsertPendingCore(slot: string, content: string, evidence: number, tenant?: CoreTenant): boolean {
    try {
      const teamId = tenant?.teamId || "default";
      const userId = tenant?.userId || "default";
      const agentId = tenant?.agentId || "default";
      const pid = "pd-" + createHash("sha256").update(`${slot}|${content}|${teamId}|${userId}|${agentId}`).digest("hex").slice(0, 16);
      this.db.prepare(`INSERT INTO core_pending (pending_id, slot, content, evidence, state, team_id, user_id, agent_id, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        ON CONFLICT(pending_id) DO UPDATE SET evidence = excluded.evidence, created_at = excluded.created_at
        WHERE core_pending.state = 'pending'`).run(pid, slot, content, Math.max(0, Math.floor(evidence)), teamId, userId, agentId, new Date().toISOString());
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_pending] upsertPendingCore failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  listPendingCore(tenant?: CoreTenant, opts?: { includeDecided?: boolean }): Array<{ pending_id: string; slot: string; content: string; evidence: number; state: string; created_at: string; decided_at: string | null }> {
    try {
      const teamId = tenant?.teamId || "default";
      const userId = tenant?.userId || "default";
      const agentId = tenant?.agentId || "default";
      const stateFilter = opts?.includeDecided ? "" : " AND state = 'pending'";
      return this.db.prepare(`SELECT pending_id, slot, content, evidence, state, created_at, decided_at FROM core_pending WHERE team_id = ? AND user_id = ? AND agent_id = ?${stateFilter} ORDER BY created_at DESC LIMIT 200`).all(teamId, userId, agentId) as Array<{ pending_id: string; slot: string; content: string; evidence: number; state: string; created_at: string; decided_at: string | null }>;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_pending] listPendingCore failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  decidePendingCore(pendingId: string, decision: "adopted" | "rejected", tenant?: CoreTenant): { slot: string; content: string } | null {
    try {
      const row = this.db.prepare("SELECT slot, content, state, team_id, user_id, agent_id FROM core_pending WHERE pending_id = ?").get(pendingId) as { slot: string; content: string; state: string; team_id: string; user_id: string; agent_id: string } | undefined;
      if (!row || row.state !== "pending") return null;
      if (tenant) {
        if (row.team_id !== (tenant.teamId || "default") || row.user_id !== (tenant.userId || "default") || row.agent_id !== (tenant.agentId || "default")) return null;
      }
      const r = this.db.prepare("UPDATE core_pending SET state = ?, decided_at = ? WHERE pending_id = ? AND state = 'pending'").run(decision, new Date().toISOString(), pendingId);
      return Number(r.changes) > 0 ? { slot: row.slot, content: row.content } : null;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_pending] decidePendingCore failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** SOUL：身份自发现状态读（identity_* 前缀键族——与锚状态独立，防互覆盖）。 */
  getIdentityDiscoveryState(tenant?: CoreTenant): { lastAttemptAt: string | null; lastCorpusCount: number | null; supportMap?: Record<string, string[]> } {
    try {
      const t = normalizeCoreTenant(tenant);
      const suffix = (t.teamId === "default" && t.userId === "default" && t.agentId === "default") ? "" : `:${JSON.stringify([t.teamId, t.userId, t.agentId])}`;
      // A-7b：supportMap（事实→支撑 record_ids）随身份状态持久化（第三键 JSON）——此前仅两键，
      // 写入侧 supportMap 被静默丢弃，GROW-MAINT 确定性重验无从读取（ev15 实证）。
      const rows = this.db.prepare("SELECT k, v FROM anchor_growth_state WHERE k IN (?, ?, ?)").all(`identity_last_attempt_at${suffix}`, `identity_last_corpus_count${suffix}`, `identity_support_map${suffix}`) as unknown as Array<{ k: string; v: string }>;
      const map = new Map(rows.map((r) => [r.k, r.v]));
      const countRaw = map.get(`identity_last_corpus_count${suffix}`);
      const count = countRaw !== undefined && countRaw !== "" && Number.isFinite(Number(countRaw)) ? Number(countRaw) : null;
      let supportMap: Record<string, string[]> | undefined;
      try {
        const rawSupport = map.get(`identity_support_map${suffix}`);
        if (rawSupport) supportMap = JSON.parse(rawSupport) as Record<string, string[]>;
      } catch { /* 损坏 supportMap 视同缺失（宁缺毋滥，回退滑窗） */ }
      return { lastAttemptAt: map.get(`identity_last_attempt_at${suffix}`) ?? null, lastCorpusCount: count, supportMap };
    } catch (err) {
      this.logger?.warn?.(`${TAG} [identity_discovery] getState failed: ${err instanceof Error ? err.message : String(err)}`);
      return { lastAttemptAt: null, lastCorpusCount: null };
    }
  }

  /** SOUL：身份自发现状态写（独立键族——与锚状态互不覆盖）。 */
  setIdentityDiscoveryState(state: { lastAttemptAt: string; lastCorpusCount: number; supportMap?: Record<string, string[]> }, tenant?: CoreTenant): void {
    try {
      const t = normalizeCoreTenant(tenant);
      const suffix = (t.teamId === "default" && t.userId === "default" && t.agentId === "default") ? "" : `:${JSON.stringify([t.teamId, t.userId, t.agentId])}`;
      const up = "INSERT INTO anchor_growth_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v";
      this.db.prepare(up).run(`identity_last_attempt_at${suffix}`, state.lastAttemptAt);
      this.db.prepare(up).run(`identity_last_corpus_count${suffix}`, String(Math.max(0, Math.floor(state.lastCorpusCount))));
      if (state.supportMap && Object.keys(state.supportMap).length > 0) {
        this.db.prepare(up).run(`identity_support_map${suffix}`, JSON.stringify(state.supportMap));
      }
    } catch (err) {
      this.logger?.warn?.(`${TAG} [identity_discovery] setState failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getAnchorGrowthState(tenant?: CoreTenant): { lastDiscoveryAt: string | null; lastCorpusCount: number | null; lastAttemptAt?: string | null; lastAdoptedAt?: string | null } {
    try {
      const keys = this.growthStateKeys(tenant);
      const rows = this.db.prepare("SELECT k, v FROM anchor_growth_state WHERE k IN (?, ?, ?, ?)").all(keys.at, keys.count, keys.attempt, keys.adopted) as unknown as Array<{ k: string; v: string }>;
      const map = new Map(rows.map((r) => [r.k, r.v]));
      const countRaw = map.get(keys.count);
      const count = countRaw !== undefined && countRaw !== "" && Number.isFinite(Number(countRaw)) ? Number(countRaw) : null;
      return { lastDiscoveryAt: map.get(keys.at) ?? null, lastCorpusCount: count, lastAttemptAt: map.get(keys.attempt) ?? null, lastAdoptedAt: map.get(keys.adopted) ?? null };
    } catch (err) {
      this.logger?.warn?.(`${TAG} [anchor_growth] getAnchorGrowthState failed: ${err instanceof Error ? err.message : String(err)}`);
      return { lastDiscoveryAt: null, lastCorpusCount: null };
    }
  }

  /** PA：growth state kv 键——default/缺省 = 旧键（兼容存量状态）；非 default 三元组 = per-tenant 后缀键。
   *  后缀用 JSON.stringify 编码三元组（段内含分隔符也不碰撞，同 listValues cacheKey 的 S7 M-6 教训）。 */
  private growthStateKeys(tenant?: CoreTenant): { at: string; count: string; attempt: string; adopted: string } {
    if (!tenant) return { at: "last_discovery_at", count: "last_corpus_count", attempt: "last_attempt_at", adopted: "last_adopted_at" };
    const t = normalizeCoreTenant(tenant);
    if (t.teamId === "default" && t.userId === "default" && t.agentId === "default") {
      return { at: "last_discovery_at", count: "last_corpus_count", attempt: "last_attempt_at", adopted: "last_adopted_at" };
    }
    const suffix = JSON.stringify([t.teamId, t.userId, t.agentId]);
    return { at: `last_discovery_at:${suffix}`, count: `last_corpus_count:${suffix}`, attempt: `last_attempt_at:${suffix}`, adopted: `last_adopted_at:${suffix}` };
  }

  /** GROW：自生长调度状态写（发现轮次完成后调用；失败重抛——由自生长模块整体 catch）。
   *  PA：tenant 语义同 getAnchorGrowthState（default/缺省旧键，非 default per-tenant 键）。 */
  setAnchorGrowthState(state: { lastDiscoveryAt: string; lastCorpusCount: number; lastAttemptAt?: string; lastAdoptedAt?: string }, tenant?: CoreTenant): void {
    try {
      const keys = this.growthStateKeys(tenant);
      this.db.prepare(
        "INSERT INTO anchor_growth_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
      ).run(keys.at, state.lastDiscoveryAt);
      this.db.prepare(
        "INSERT INTO anchor_growth_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
      ).run(keys.count, String(Math.max(0, Math.floor(state.lastCorpusCount))));
      if (state.lastAttemptAt !== undefined) {
        this.db.prepare(
          "INSERT INTO anchor_growth_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        ).run(keys.attempt, state.lastAttemptAt);
      }
      if (state.lastAdoptedAt !== undefined) {
        this.db.prepare(
          "INSERT INTO anchor_growth_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        ).run(keys.adopted, state.lastAdoptedAt);
      }
    } catch (err) {
      this.logger?.warn?.(`${TAG} [anchor_growth] setAnchorGrowthState failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /** GROW-MAINT v2（SOP 2026-09-17）：自维护漂移基线 kv——全局单键组（self-obs 统计为
   *  全局口径，非 per-tenant）。读无行 → null（首轮无基线，drift=0 不误报）。
   *  与 growth state 四键分立：写入方（self-obs 块）不得 clobber 调度状态。 */
  getSelfObsBaseline(): { l1: number; archived: number } | null {
    try {
      const rows = this.db.prepare("SELECT k, v FROM anchor_growth_state WHERE k IN ('obs_l1_total', 'obs_archive_total')").all() as unknown as Array<{ k: string; v: string }>;
      const map = new Map(rows.map((r) => [r.k, r.v]));
      const l1 = Number(map.get("obs_l1_total"));
      const archived = Number(map.get("obs_archive_total"));
      if (!Number.isFinite(l1) || !Number.isFinite(archived)) return null;
      return { l1, archived };
    } catch (err) {
      this.logger?.warn?.(`${TAG} [anchor_growth] getSelfObsBaseline failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  setSelfObsBaseline(baseline: { l1: number; archived: number }): void {
    try {
      for (const pair of [["obs_l1_total", baseline.l1], ["obs_archive_total", baseline.archived]] as const) {
        this.db.prepare(
          "INSERT INTO anchor_growth_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        ).run(pair[0], String(Math.max(0, Math.floor(pair[1]))));
      }
    } catch (err) {
      this.logger?.warn?.(`${TAG} [anchor_growth] setSelfObsBaseline failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * PA：l1_records 的 distinct (team_id,user_id,agent_id) 三元组——价值锚扇出迁移与
   * 自生长 per-agent 化共用的"有记忆的 agent"清单来源（SELECT DISTINCT，单源禁第二份）。
   * 空串维度归一为 default（与 init 早期归一 UPDATE 同口径，双保险）；失败容错返 []。
   */
  listL1TenantTriplets(): CoreTenant[] {
    if (this.degraded) return [];
    try {
      const rows = this.db.prepare(
        "SELECT DISTINCT COALESCE(NULLIF(team_id,''),'default') AS team_id, COALESCE(NULLIF(user_id,''),'default') AS user_id, COALESCE(NULLIF(agent_id,''),'default') AS agent_id FROM l1_records",
      ).all() as Array<{ team_id: string; user_id: string; agent_id: string }>;
      return rows.map((r) => normalizeCoreTenant({ teamId: r.team_id, userId: r.user_id, agentId: r.agent_id }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-tenant-triplets] failed (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * REG-REMAINING-003 #1：列出存在 valence IS NULL 活跃锚的租户三元组。
   * 与 listL1TenantTriplets 同族（degraded → []；SQL COALESCE 归一化空串 → default）；
   * 仅读：跨租户聚合写不存在——消费方（server boot / anchor-growth）逐三元组回传
   * deriveValueValences，其 SQL 按同一三元组过滤，无跨租户泄漏。
   */
  listNullValenceTenantTriplets(): CoreTenant[] {
    if (this.degraded) return [];
    try {
      const rows = this.db.prepare(
        "SELECT DISTINCT COALESCE(NULLIF(team_id,''),'default') AS team_id, COALESCE(NULLIF(user_id,''),'default') AS user_id, COALESCE(NULLIF(agent_id,''),'default') AS agent_id FROM core_values WHERE valence IS NULL AND state='active'",
      ).all() as Array<{ team_id: string; user_id: string; agent_id: string }>;
      return rows.map((r) => normalizeCoreTenant({ teamId: r.team_id, userId: r.user_id, agentId: r.agent_id }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values-null-tenant-triplets] failed (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 重构式回忆（J）：按 id 批量取回 L1 完整记录（含灵魂字段），供邻居扩展组装。
   */
  getL1ByIds(ids: string[]): Array<import("./types.js").L1SearchResult> {
    if (!ids || ids.length === 0) return [];
    const out: Array<import("./types.js").L1SearchResult> = [];
    try {
      for (const rid of ids) {
        const meta = this.stmtGetMeta.get(rid) as { content: string; type: string; priority: number; scene_name: string; timestamp_start: string; timestamp_end: string; occurred_at?: string; valid_start?: string; certainty?: string; source?: string; valence?: number; arousal?: number; significance?: number } | undefined;
        if (!meta) continue;
        out.push({
          record_id: rid,
          content: meta.content,
          type: meta.type,
          priority: meta.priority,
          scene_name: meta.scene_name,
          score: 0,
          timestamp_str: (meta as { timestamp_str?: string }).timestamp_str ?? "",
          timestamp_start: meta.timestamp_start,
          timestamp_end: meta.timestamp_end,
          version: 0,
          session_key: (meta as { session_key?: string }).session_key ?? "",
          session_id: (meta as { session_id?: string }).session_id ?? "",
          team_id: (meta as { team_id?: string }).team_id ?? "",
          task_id: (meta as { task_id?: string }).task_id ?? "",
          user_id: (meta as { user_id?: string }).user_id ?? "",
          agent_id: (meta as { agent_id?: string }).agent_id ?? "",
          metadata_json: (meta as { metadata_json?: string }).metadata_json ?? "{}",
          occurred_at: meta.occurred_at ?? undefined,
          valid_start: meta.valid_start ?? undefined,
          valid_end: (meta as { valid_end?: string }).valid_end ?? undefined,
          certainty: meta.certainty ?? undefined,
          source: meta.source ?? undefined,
          valence: meta.valence ?? undefined,
          arousal: meta.arousal ?? undefined,
          significance: meta.significance ?? undefined,
        });
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] getL1ByIds failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 审计修复 B3：getL1ByIds 的归档桶回退版——
   * 演进(evolve)/合并(similar)的旧证据已被 archiveL1 软删出 l1_records，
   * 证据链回溯（getNeighbors→getL1ByIds）需要能从 l1_archive 读回内容，
   * 否则边是"指向不存在记录的孤儿边"。
   */
  getL1ByIdsWithArchive(ids: string[]): Array<import("./types.js").L1SearchResult> {
    const live = this.getL1ByIds(ids);
    const missing = ids.filter((id) => !live.some((r) => r.record_id === id));
    if (missing.length === 0) return live;
    const out = [...live];
    try {
      for (const id of missing) {
        const row = this.db.prepare("SELECT data FROM l1_archive WHERE record_id = ?").get(id) as { data: string } | undefined;
        if (!row) continue;
        const d = JSON.parse(row.data) as Record<string, unknown>;
        out.push({
          record_id: String(d.record_id ?? id),
          content: String(d.content ?? ""),
          type: String(d.type ?? ""),
          priority: Number(d.priority ?? 0),
          scene_name: String(d.scene_name ?? ""),
          score: 0,
          timestamp_str: String(d.timestamp_str ?? ""),
          timestamp_start: String(d.timestamp_start ?? ""),
          timestamp_end: String(d.timestamp_end ?? ""),
          version: Number(d.version ?? 0),
          session_key: String(d.session_key ?? ""),
          session_id: String(d.session_id ?? ""),
          team_id: String(d.team_id ?? ""),
          task_id: String(d.task_id ?? ""),
          user_id: String(d.user_id ?? ""),
          agent_id: String(d.agent_id ?? ""),
          metadata_json: String(d.metadata_json ?? "{}"),
          occurred_at: (d.occurred_at as string) || undefined,
          valid_start: (d.valid_start as string) || undefined,
          valid_end: (d.valid_end as string) || undefined,
          certainty: (d.certainty as string) || undefined,
          source: (d.source as string) || undefined,
          valence: (d.valence as number) ?? undefined,
          arousal: (d.arousal as number) ?? undefined,
          significance: (d.significance as number) ?? undefined,
        });
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [l1_links] getL1ByIdsWithArchive failed: ${err instanceof Error ? err.message : String(err)}`);
      return out;
    }
  }

  /**
   * R-A2（R5，结构感知召回 spec §2）：按 coreRefs 价值锚 label 反查 L1 记忆（候选池补池）。
   * LIKE 预筛（metadata_json 含 coreRefs 键，粗读成本有界）+ JS 精确交集复核
   * （JSON 数组值无法用 SQL 匹配，多读少漏后复核，宁缺毋滥：无交集行不返回）。
   * 租户 filter 两步过滤（T14 同形：rowMatchesIsolation 复核；filter 缺省=旧行为）。
   * 返回按 updated_time DESC 的至多 limit 行（score 恒 0——相关度由调用方排序层赋予）。
   */
  searchL1ByCoreRefs(labels: string[], limit = 10, filter?: IsolationFilter): Array<import("./types.js").L1SearchResult> {
    if (!labels || labels.length === 0 || limit <= 0) return [];
    const wanted = new Set(labels.filter((l) => typeof l === "string" && l.trim().length > 0));
    if (wanted.size === 0) return [];
    try {
      const retrieveLimit = Math.min(Math.max(limit * 20, 100), 500);
      const rows = this.db
        .prepare(
          `SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id,
                  version, timestamp_str, timestamp_start, timestamp_end, metadata_json,
                  ${SOUL_SELECT_FRAGMENT}
           FROM l1_records WHERE (metadata_json LIKE '%coreRefs%' OR metadata_json LIKE '%personRefs%') ORDER BY updated_time DESC LIMIT ?`,
        )
        .all(retrieveLimit) as Array<{
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
        metadata_json: string;
        occurred_at?: string | null;
        valid_start?: string | null;
        valid_end?: string | null;
        certainty?: string | null;
        source?: string | null;
        valence?: number | null;
        arousal?: number | null;
        significance?: number | null;
      }>;
      const out: Array<import("./types.js").L1SearchResult> = [];
      for (const r of rows) {
        if (out.length >= limit) break;
        if (!rowMatchesIsolation(r, filter)) continue;
        let refs: unknown;
        try {
          const parsed = JSON.parse(r.metadata_json || "{}") as Record<string, unknown>;
          // P0-F7（spec §2.6/S6）：反查键族扩 personRefs——人物锚证据链可反查；
          // identityRefs 不并入（20 字切片语义非 label，消费方=GROW-MAINT/F14）。
          refs = [
            ...(Array.isArray(parsed.coreRefs) ? parsed.coreRefs : []),
            ...(Array.isArray(parsed.personRefs) ? parsed.personRefs : []),
          ];
        } catch {
          continue; // metadata 损坏 → 无法验证归属，宁缺毋滥跳过
        }
        if (!Array.isArray(refs)) continue;
        const hit = refs.some((s) => typeof s === "string" && wanted.has(s));
        if (!hit) continue;
        out.push({
          record_id: r.record_id,
          content: r.content,
          type: r.type,
          priority: r.priority,
          scene_name: r.scene_name,
          score: 0,
          timestamp_str: r.timestamp_str,
          timestamp_start: r.timestamp_start,
          timestamp_end: r.timestamp_end,
          version: r.version ?? 0,
          session_key: r.session_key,
          session_id: r.session_id,
          team_id: r.team_id ?? "",
          task_id: r.task_id ?? "",
          user_id: r.user_id ?? "",
          agent_id: r.agent_id ?? "",
          metadata_json: r.metadata_json,
          occurred_at: r.occurred_at ?? undefined,
          valid_start: r.valid_start ?? undefined,
          valid_end: r.valid_end ?? undefined,
          certainty: r.certainty ?? undefined,
          source: r.source ?? undefined,
          valence: r.valence ?? undefined,
          arousal: r.arousal ?? undefined,
          significance: r.significance ?? undefined,
        });
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] searchL1ByCoreRefs failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * R7-2（分层召回 spec DS-RECALL-LAYERED-R7-001 §2）：按场景名反查 L1 记忆
   * （同 scene 过滤——精确相等 + 层级前缀 `LIKE ? || '/%'`，与 sceneSignalOf 的
   * 层级前缀语义对称；idx_l1_scene 等值命中）。空参 / limit<=0 / 空场景名 → 空数组
   * （宁缺毋滥）。租户 filter 两步过滤（T14 同形：SQL 无租户下推 + rowMatchesIsolation
   * 复核；filter 缺省 = L1 召回全局路径旧行为）。返回按 updated_time DESC 的至多 limit 行
   * （score 恒 0——相关度由调用方排序层赋予）。
   */
  searchL1ByScene(sceneNames: string[], limit = 10, filter?: IsolationFilter): Array<import("./types.js").L1SearchResult> {
    if (!sceneNames || sceneNames.length === 0 || limit <= 0) return [];
    const wanted = [...new Set(
      sceneNames
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim()),
    )];
    if (wanted.length === 0) return [];
    try {
      const conds = wanted.map(() => "(scene_name = ? OR scene_name LIKE ? || '/%')").join(" OR ");
      const args: Array<string | number> = [];
      for (const s of wanted) args.push(s, s);
      const rows = this.db
        .prepare(
          `SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id,
                  version, timestamp_str, timestamp_start, timestamp_end, metadata_json,
                  ${SOUL_SELECT_FRAGMENT}
           FROM l1_records WHERE (${conds}) ORDER BY updated_time DESC LIMIT ?`,
        )
        .all(...args, limit) as Array<{
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
        metadata_json: string;
        occurred_at?: string | null;
        valid_start?: string | null;
        valid_end?: string | null;
        certainty?: string | null;
        source?: string | null;
        valence?: number | null;
        arousal?: number | null;
        significance?: number | null;
      }>;
      const out: Array<import("./types.js").L1SearchResult> = [];
      for (const r of rows) {
        if (out.length >= limit) break;
        if (!rowMatchesIsolation(r, filter)) continue;
        out.push({
          record_id: r.record_id,
          content: r.content,
          type: r.type,
          priority: r.priority,
          scene_name: r.scene_name,
          score: 0,
          timestamp_str: r.timestamp_str,
          timestamp_start: r.timestamp_start,
          timestamp_end: r.timestamp_end,
          version: r.version ?? 0,
          session_key: r.session_key,
          session_id: r.session_id,
          team_id: r.team_id ?? "",
          task_id: r.task_id ?? "",
          user_id: r.user_id ?? "",
          agent_id: r.agent_id ?? "",
          metadata_json: r.metadata_json,
          occurred_at: r.occurred_at ?? undefined,
          valid_start: r.valid_start ?? undefined,
          valid_end: r.valid_end ?? undefined,
          certainty: r.certainty ?? undefined,
          source: r.source ?? undefined,
          valence: r.valence ?? undefined,
          arousal: r.arousal ?? undefined,
          significance: r.significance ?? undefined,
        });
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [scene] searchL1ByScene failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * V2-3（引擎三 E3.2，DS-RECALL-V2-THREE-ENGINES-001）：按 type 取行，significance DESC
   *（SQLite NULL 最小 → NULL 排最后——未标 significance 的行让位给实证高显著行）。
   * 空 type / limit<=0 → []（宁缺毋滥）。返回至多 limit 行（score 恒 0——位次由调用方
   * 赋予）；租户 filter 两步过滤（searchL1ByScene 同形：SQL 无租户下推 + rowMatchesIsolation）。
   */
  searchL1ByType(type: string, limit = 10, filter?: IsolationFilter): Array<import("./types.js").L1SearchResult> {
    if (!type || typeof type !== "string" || !type.trim() || limit <= 0) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id,
                  version, timestamp_str, timestamp_start, timestamp_end, metadata_json,
                  ${SOUL_SELECT_FRAGMENT}
           FROM l1_records WHERE type = ? ORDER BY significance DESC LIMIT ?`,
        )
        .all(type.trim(), limit) as Array<{
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
        metadata_json: string;
        occurred_at?: string | null;
        valid_start?: string | null;
        valid_end?: string | null;
        certainty?: string | null;
        source?: string | null;
        valence?: number | null;
        arousal?: number | null;
        significance?: number | null;
      }>;
      const out: Array<import("./types.js").L1SearchResult> = [];
      for (const r of rows) {
        if (out.length >= limit) break;
        if (!rowMatchesIsolation(r, filter)) continue;
        out.push({
          record_id: r.record_id,
          content: r.content,
          type: r.type,
          priority: r.priority,
          scene_name: r.scene_name,
          score: 0,
          timestamp_str: r.timestamp_str,
          timestamp_start: r.timestamp_start,
          timestamp_end: r.timestamp_end,
          version: r.version ?? 0,
          session_key: r.session_key,
          session_id: r.session_id,
          team_id: r.team_id ?? "",
          task_id: r.task_id ?? "",
          user_id: r.user_id ?? "",
          agent_id: r.agent_id ?? "",
          metadata_json: r.metadata_json,
          occurred_at: r.occurred_at ?? undefined,
          valid_start: r.valid_start ?? undefined,
          valid_end: r.valid_end ?? undefined,
          certainty: r.certainty ?? undefined,
          source: r.source ?? undefined,
          valence: r.valence ?? undefined,
          arousal: r.arousal ?? undefined,
          significance: r.significance ?? undefined,
        });
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [recall] searchL1ByType failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Vector similarity search (cosine distance).
   * Returns top-k results sorted by similarity (highest first).
   *
   * **Fault-tolerant**: returns an empty array on any error (e.g. dimension
   * mismatch, corrupted DB) so callers can fall back to keyword search.
   */
  searchL1Vector(queryEmbedding: Float32Array, topK = 5, _queryText?: string, filter?: IsolationFilter): VectorSearchResult[] {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded) this.logger?.warn(`${TAG} [L1-search] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      // Over-retrieve to compensate for legacy zero-vector placeholders that
      // may still exist in the vec0 table.  New zero vectors are no longer
      // inserted (upsert() skips vec write for zero vectors since v3.x), but
      // older data may still contain them — they surface as NULL/NaN distance
      // in KNN results.  A small buffer of 10 is sufficient for remnants.
      // NOTE: "AND distance IS NOT NULL" is NOT usable because vec0 does not
      // support that constraint — it causes an empty result set.
      const ZERO_VEC_BUFFER = 10;
      const retrieveCount = filter ? Math.max(topK * 5, topK + ZERO_VEC_BUFFER) : topK + ZERO_VEC_BUFFER;

      this.logger?.debug?.(
        `${TAG} [L1-search] START topK=${topK}, retrieveCount=${retrieveCount}, ` +
        `queryEmbeddingDims=${queryEmbedding.length}, ` +
        `queryNorm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
      );

      const rows = this.stmtSearchVec!.all(
        Buffer.from(queryEmbedding.buffer),
        retrieveCount,
      ) as Array<{ record_id: string; distance: number }>;

      this.logger?.debug?.(`${TAG} [L1-search] vec0 returned ${rows.length} candidate(s)`);

      if (rows.length === 0) return [];

      const results: VectorSearchResult[] = [];

      for (const { record_id, distance } of rows) {
        // sqlite-vec returns null distance for zero vectors (cosine undefined when ‖v‖=0).
        // Skip these — they are placeholder vectors from embedding-service-unavailable fallback.
        if (distance == null || Number.isNaN(distance)) {
          this.logger?.warn(
            `${TAG} [L1-search] record_id=${record_id} has null/NaN distance (likely zero vector) — skipping`,
          );
          continue;
        }

        const meta = this.stmtGetMeta.get(record_id) as
          | {
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
              metadata_json: string;
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
          | undefined;

        if (!meta) {
          this.logger?.warn(`${TAG} [L1-search] record_id=${record_id} has vector but NO metadata (orphan)`);
          continue;
        }
        if (!rowMatchesIsolation(meta, filter)) {
          continue;
        }

        const score = 1.0 - distance;
        this.logger?.debug?.(
          `${TAG} [L1-search] HIT id=${record_id}, distance=${distance.toFixed(4)}, score=${score.toFixed(4)}, ` +
          `type=${meta.type}, content="${meta.content.slice(0, 60)}..."`,
        );

        results.push({
          record_id,
          content: meta.content,
          type: meta.type,
          priority: meta.priority,
          scene_name: meta.scene_name,
          score,
          timestamp_str: meta.timestamp_str,
          timestamp_start: meta.timestamp_start,
          timestamp_end: meta.timestamp_end,
          version: meta.version ?? 0,
          session_key: meta.session_key,
          session_id: meta.session_id,
          team_id: meta.team_id ?? "",
          task_id: meta.task_id ?? "",
          user_id: meta.user_id ?? "",
          agent_id: meta.agent_id ?? "",
          metadata_json: meta.metadata_json,
          occurred_at: meta.occurred_at ?? undefined,
          valid_start: meta.valid_start ?? undefined,
          valid_end: meta.valid_end ?? undefined,
          certainty: meta.certainty ?? undefined,
          source: meta.source ?? undefined,
          valence: meta.valence ?? undefined,
          arousal: meta.arousal ?? undefined,
          significance: meta.significance ?? undefined,
          // D-3：敏感性透传（向量路 L1SearchResult 数据面——徽章/R11 信号源）
          sensitivity: meta.sensitivity ?? undefined,
        });
      }

      // Trim back to the caller's requested topK (we over-fetched above).
      const trimmed = results.slice(0, topK);
      this.logger?.info(
        `${TAG} [L1-search] DONE returning ${trimmed.length} result(s) (from ${results.length} valid, ${rows.length} raw)`,
      );
      return trimmed;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Delete a single record (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   */
  deleteL1(recordId: string, filter?: IsolationFilter): boolean {
    if (this.degraded) return false;
    try {
      if (filter) {
        const meta = this.stmtGetMeta.get(recordId) as { user_id?: string; agent_id?: string; session_id?: string; session_key?: string } | undefined;
        if (!meta || !rowMatchesIsolation(meta, filter)) return false;
      }
      this.db.exec("BEGIN");
      try {
        const result = this.stmtDeleteMeta.run(recordId);
        const deleted = (result as any)?.changes > 0;
        if (this.vecTablesReady) this.stmtDeleteVec!.run(recordId);
        if (this.ftsAvailable) {
          try { this.stmtL1FtsDelete.run(recordId); } catch { /* non-fatal */ }
        }
        // 图设计 §5：删除时级联删除其边（硬删路径；archive 路径不删——边指向归档记录合法）。
        try { this.deleteLinksFor(recordId); } catch { /* non-fatal */ }
        this.db.exec("COMMIT");
        return deleted;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} delete failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Delete multiple records (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   */
  deleteL1Batch(recordIds: string[], filter?: IsolationFilter): boolean {
    if (this.degraded) return false;
    if (recordIds.length === 0) return true;

    try {
      this.db.exec("BEGIN");
      try {
        for (const id of recordIds) {
          if (filter) {
            const meta = this.stmtGetMeta.get(id) as { user_id?: string; agent_id?: string; session_id?: string; session_key?: string } | undefined;
            if (!meta || !rowMatchesIsolation(meta, filter)) continue;
          }
          this.stmtDeleteMeta.run(id);
          if (this.vecTablesReady) this.stmtDeleteVec!.run(id);
          if (this.ftsAvailable) {
            try { this.stmtL1FtsDelete.run(id); } catch { /* non-fatal */ }
          }
          // 图设计 §5：硬删批量时也级联删边。
          try { this.deleteLinksFor(id); } catch { /* non-fatal */ }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteBatch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get the total number of L1 records in the store.
   *
   * **Fault-tolerant**: returns 0 on failure.
   * TTL cleanup by updated_time.
   *
   * Deletes expired rows from l1_records and matching vectors from l1_vec
   * in a single transaction to guarantee consistency.
   */
  /**
   * 重巩固（reconsolidation，H 设计§4）：仅更新 L1 行的 metadata_json（合并 patch），
   * 不重写 content/向量——防"越回忆越信自己的编造"。召回统计类字段（recall_count 等）。
   */
  updateL1Metadata(id: string, patch: Record<string, unknown>): boolean {
    if (this.degraded) return false;
    try {
      const row = this.db.prepare("SELECT metadata_json FROM l1_records WHERE record_id = ?").get(id) as { metadata_json?: string } | undefined;
      if (!row) return false;
      let meta: Record<string, unknown> = {};
      try { meta = row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {}; } catch { meta = {}; }
      const merged = JSON.stringify({ ...meta, ...patch });
      const res = this.db.prepare("UPDATE l1_records SET metadata_json = ?, updated_time = ? WHERE record_id = ?")
        .run(merged, new Date().toISOString(), id);
      return ((res as unknown as { changes?: number }).changes ?? 0) > 0;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [reconsolidation] updateL1Metadata failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 损坏 metadata_json 行 warn 去重（审查 Minor #1）：同一 record_id 只 warn 一次。
   * 唯一 id 超 CORRUPT_JSON_WARN_MAX_IDS 后不再记录 id（防 Set 无界膨胀），
   * 改为计数，每 CORRUPT_JSON_SUMMARY_EVERY 行输出一条计数汇总。
   */
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
   * 重巩固（P0-T4，H-B1）：recall_count SQL 原子自增（单语句原子，不读回）。
   * read-then-write（updateL1Metadata）依赖召回 item 上的 metadata 计算 prevCount，
   * 但 MemorySearchResultItem 不带 metadata → prevCount 恒 0 → recall_count 恒 1，
   * `min(c,5)*0.02` 抗遗忘 boost 生产不可达。此方法把累加下推到 SQL：
   * json_extract 现值 + 1，无值从 0 起，天然免读回、免竞态。
   *
   * 失败语义（审查 Minor #2：显式失败，不静默 no-op）：
   *   - 行不存在 / degraded → false；
   *   - metadata_json 损坏（json_valid=false）→ 去重 warn + false（行不被半写，
   *     下方 WHERE 的 json_valid 过滤兜底防竞态半写）；
   *   - metadata_json 合法但非对象态（如 '[]'、'5'）→ 去重 warn + 显式 false（拒绝写入）。
   */
  bumpRecallCount(id: string, now?: string, opts?: { touchUpdatedTime?: boolean }): boolean {
    if (this.degraded) return false;
    try {
      const nowIso = now ?? new Date().toISOString();
      // 写前形态校验（审查 Minor #2）：json_set 对损坏/非对象态会静默 no-op 或抛错，
      // 此处先显式裁决，再由 WHERE json_valid 过滤兜底。
      // 注意：json_type() 对损坏 JSON 会抛错（malformed JSON），必须先单独
      // json_valid 判定、仅对合法 JSON 再取 json_type —— 两者不可合并为一条语句。
      const cur = this.db.prepare("SELECT metadata_json FROM l1_records WHERE record_id = ?")
        .get(id) as { metadata_json?: string | null } | undefined;
      if (!cur) return false;
      const mj = cur.metadata_json;
      if (mj != null) {
        const vres = this.db.prepare("SELECT json_valid(?) AS valid").get(mj) as { valid: number };
        if (!vres.valid) {
          this.warnCorruptMetadataJsonOnce(id, "json_valid=false（损坏 JSON，WHERE 过滤防半写）");
          return false;
        }
        const tres = this.db.prepare("SELECT json_type(?) AS jtype").get(mj) as { jtype: string | null };
        if (tres.jtype !== "object") {
          this.warnCorruptMetadataJsonOnce(id, `json_type=${String(tres.jtype)}（合法但非对象态，显式拒绝）`);
          return false;
        }
      }
      // GROW-EVO P1：touchUpdatedTime 缺省 true = 逐位现状；false = 钩子路只加计数
      // 不刷 updated_time（防扰动 ORDER BY updated_time 的既有排序）。
      const touch = opts?.touchUpdatedTime !== false;
      const updateSql = touch
        ? `UPDATE l1_records SET
          metadata_json = json_set(
            COALESCE(metadata_json,'{}'),
            '$.recall_count', COALESCE(json_extract(metadata_json,'$.recall_count'), 0) + 1,
            '$.last_recalled_at', ?
          ),
          updated_time = ?
        WHERE record_id = ?
          AND (metadata_json IS NULL OR json_valid(metadata_json))`
        : `UPDATE l1_records SET
          metadata_json = json_set(
            COALESCE(metadata_json,'{}'),
            '$.recall_count', COALESCE(json_extract(metadata_json,'$.recall_count'), 0) + 1,
            '$.last_recalled_at', ?
          )
        WHERE record_id = ?
          AND (metadata_json IS NULL OR json_valid(metadata_json))`;
      const res = this.db.prepare(updateSql).run(...(touch ? [nowIso, nowIso, id] : [nowIso, id]));
      return ((res as unknown as { changes?: number }).changes ?? 0) > 0;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [reconsolidation] bumpRecallCount failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * GROW-EVO P2（§2.2）：失效回写——conflict 自动失效与手动失效共用。
   * 只写 valid_end（失效不删除、不改写正文）；已失效行不覆盖（首次失效时间权威，
   * WHERE 过滤防覆盖）；行不存在显式 false（同 bumpRecallCount 纪律，不静默）。
   * P4a（D8 裁决 2026-09-16）：失效 **bump updated_time**——L2 增量（updatedAfter 游标）
   * 由此感知失效并重蒸馏（scene_blocks 陈旧自愈）。安全性：失效记忆已被召回排除
   * （排序扰动无消费者）；L1 增量处理 L0 不受 L1 记录 updated_time 影响（无连锁）。
   */
  invalidateL1(id: string, validEndIso: string): boolean {
    if (this.degraded) return false;
    try {
      // 主表 + l1_fts 副本同步（soul 8 列在 FTS 表有副本，只改主表会让 FTS 路
      // 召回读到 stale valid_end——P2 验证实测踩过）。主表 0 行 = 行不存在/已失效 → false。
      const res = this.db.prepare(
        "UPDATE l1_records SET valid_end = ?, updated_time = ? WHERE record_id = ? AND (valid_end IS NULL OR valid_end = '')",
      ).run(validEndIso, new Date().toISOString(), id);
      if (((res as unknown as { changes?: number }).changes ?? 0) === 0) return false;
      this.db.prepare(
        "UPDATE l1_fts SET valid_end = ? WHERE record_id = ? AND (valid_end IS NULL OR valid_end = '')",
      ).run(validEndIso, id);
      // P4a-P2（层级边，REG-REMAINING-002 #1）：失效沿 derived_from 边定位受影响
      // scene block 并宣告（精确失效传播的定位步）。逐块自动重蒸馏按分析文档分期：
      // 存量块无溯源日志可回填输入史，自动重建会静默丢掉建边前的贡献——等边覆盖
      // 成熟后启用（P4a Phase 2），本步只做 O(边数) 定位 + 日志，不影响失效回写。
      try {
        const affected = this.getLinksByTarget(id, "derived_from");
        if (affected.length > 0) {
          this.logger?.info?.(
            `${TAG} [P4a-P2] invalidation ${id} → ${affected.length} scene block(s) affected: ${affected.map((a) => a.sourceId).join(", ")}`,
          );
        }
      } catch { /* 定位失败不影响失效回写 */ }
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [invalidation] invalidateL1 failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  deleteL1Expired(cutoffIso: string): number {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [deleteExpired] SKIPPED (degraded mode)`);
      return 0;
    }
    try {
      const row = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM l1_records WHERE updated_time != '' AND updated_time < ?",
      ).get(cutoffIso) as { cnt: number } | undefined;
      const expiredCount = row?.cnt ?? 0;
      if (expiredCount <= 0) return 0;

      // Ratio protection: refuse to delete > 80% in one pass
      const totalRow = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM l1_records",
      ).get() as { cnt: number };
      const total = totalRow.cnt;
      const ratio = total > 0 ? expiredCount / total : 0;
      if (ratio > 0.8) {
        this.logger?.warn(
          `${TAG} [L1-deleteExpired] BLOCKED: would delete ${expiredCount}/${total} ` +
          `(${(ratio * 100).toFixed(1)}%) — exceeds 80% safety threshold, cutoff=${cutoffIso}`,
        );
        return 0;
      }

      this.db.exec("BEGIN");
      try {
        if (this.vecTablesReady) {
          this.db.prepare(
            "DELETE FROM l1_vec WHERE updated_time != '' AND updated_time < ?",
          ).run(cutoffIso);
        }
        this.db.prepare(
          "DELETE FROM l1_records WHERE updated_time != '' AND updated_time < ?",
        ).run(cutoffIso);
        this.db.exec("COMMIT");
        this.logger?.info?.(
          `${TAG} [L1-deleteExpired] Deleted ${expiredCount}/${total} records (cutoff=${cutoffIso})`,
        );
        return expiredCount;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL1ExpiredByUpdatedTime failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * T15-A（向量健康三件套）：vec0 shadow 表 `l1_vec_rowids` 的真实向量行数。
   *
   * G1 生产实锤（09-09）：向量写入静默失败时 l1_records 元数据行照常增长
   * （104 vec / 203 records），旧判据 countL1() 数元数据行会误判"向量可用"
   * → dedup 坚持走 Tier1 空转、永不降级 FTS、建边全线静默死。
   * 向量可用性判据必须以本方法（向量行数）为准。
   *
   * degraded / vec0 表未就绪（dimensions=0）→ 0；查询失败（非致命）→ 0。
   */
  countL1VectorRows(): number {
    if (this.degraded || !this.vecTablesReady) return 0;
    try {
      // vec0 虚表 l1_vec 的 shadow 表（列 id），每条成功写入的向量一行
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM l1_vec_rowids").get() as { n: number } | undefined;
      return Number(row?.n ?? 0);
    } catch (err) {
      this.logger?.warn(
        `${TAG} countL1VectorRows failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /** T15-B（向量健康）：最近一次成功向量写入的 ISO 时间（进程内值）；从未写过 → null。 */
  getLastVecWriteAt(): string | null {
    return this.lastVecWriteAt;
  }

  /**
   * TIMEFIX：L1 时间过滤边界防御 + 规范化。
   * - 空/undefined → undefined（不过滤，保持旧行为）；
   * - Date.parse 非法（NaN）→ undefined + warn（防御：非法串进字典序比较会
   *   静默错杀（timeStart）或放行（timeEnd），且两口径可能不一致）；
   * - 合法 → 规范化为 UTC ISO Z（与 l1-writer / updateL1Metadata 的
   *   `new Date().toISOString()` 写入形态同构，保证 TEXT 字典序比较正确）。
   */
  private canonicalIsoBound(bound: string | undefined, label: "timeStart" | "timeEnd"): string | undefined {
    if (!bound) return undefined;
    const ms = Date.parse(bound);
    if (!Number.isFinite(ms)) {
      this.logger?.warn?.(
        `${TAG} [L1-time-filter] invalid ISO "${bound}" for ${label} — ignored (defensive, non-fatal)`,
      );
      return undefined;
    }
    return new Date(ms).toISOString();
  }

  /**
   * Get the total number of L1 records matching optional filters.
   */
  countL1(filter?: L1CountFilter): number {
    if (this.degraded) return 0;
    try {
      const conditions: string[] = [];
      const params: SQLInputValue[] = [];

      if (filter?.type) {
        conditions.push("type = ?");
        params.push(filter.type);
      }
      if (filter?.sessionId) {
        conditions.push("session_id = ?");
        params.push(filter.sessionId);
      }
      if (filter?.teamId !== undefined) {
        conditions.push("team_id = ?");
        params.push(filter.teamId);
      }
      if (filter?.userId !== undefined) {
        conditions.push("user_id = ?");
        params.push(filter.userId);
      }
      if (filter?.agentId !== undefined) {
        conditions.push("agent_id = ?");
        params.push(filter.agentId);
      }
      if (filter?.taskId !== undefined) {
        conditions.push("task_id = ?");
        params.push(filter.taskId);
      }
      // TIMEFIX-v2（2026-09-11）：过滤列同改 occurred_at（与 queryL1Paginated 一致，total 与 rows 同口径）。
      // 原 ISO 边界防御——非法串不得进字典序比较（"not-a-date" 作 timeStart
      // 会静默错杀全部行）；合法但非 Z 形态（如 +08:00）规范化为 UTC Z，保证
      // updated_time（TEXT ISO）字典序比较可靠。两个 L1 过滤点（countL1/queryL1Paginated）同构。
      const timeStart = this.canonicalIsoBound(filter?.timeStart, "timeStart");
      if (timeStart) {
        conditions.push("occurred_at >= ?");
        params.push(timeStart);
      }
      const timeEnd = this.canonicalIsoBound(filter?.timeEnd, "timeEnd");
      if (timeEnd) {
        conditions.push("occurred_at <= ?");
        params.push(timeEnd);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const row = this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM l1_records ${where}`)
        .get(...params) as { cnt: number } | undefined;
      const total = row?.cnt ?? 0;
      this.logger?.debug?.(`${TAG} [L1-count] total=${total}`);
      return total;
    } catch (err) {
      this.logger?.warn(
        `${TAG} count failed (non-fatal, returning 0): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Query L1 records with optional session and time filters.
   *
   * Uses the composite index `idx_l1_session_updated(session_id, updated_time)`
   * for efficient filtering. All timestamps are compared as UTC ISO 8601 strings.
   *
   * **Fault-tolerant**: returns an empty array on any error (degraded mode, DB issues).
   */
  queryL1Records(filter?: L1QueryFilter): L1RecordRow[] {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L1-query] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      const { sessionKey, sessionId, taskId, updatedAfter, recordIds } = filter ?? {};

      let raw: Record<string, unknown>[];

      // Priority: sessionId > sessionKey (sessionId is more specific)
      if (sessionId && updatedAfter) {
        raw = this.stmtQueryBySessionIdSince.all(sessionId, updatedAfter) as Record<string, unknown>[];
      } else if (sessionId) {
        raw = this.stmtQueryBySessionId.all(sessionId) as Record<string, unknown>[];
      } else if (sessionKey && updatedAfter) {
        raw = this.stmtQueryBySessionKeySince.all(sessionKey, updatedAfter) as Record<string, unknown>[];
      } else if (sessionKey) {
        raw = this.stmtQueryBySessionKey.all(sessionKey) as Record<string, unknown>[];
      } else if (updatedAfter) {
        raw = this.stmtQueryAllSince.all(updatedAfter) as Record<string, unknown>[];
      } else {
        raw = this.stmtQueryAll.all() as Record<string, unknown>[];
      }

      // Runtime sanity check: verify first row has expected columns (guards against schema drift)
      if (raw.length > 0 && !("record_id" in raw[0] && "content" in raw[0])) {
        this.logger?.warn(
          `${TAG} [L1-query] Schema mismatch: first row missing expected columns. ` +
          `Got keys: [${Object.keys(raw[0]).join(", ")}]`,
        );
        return [];
      }

      let rows = raw as unknown as L1RecordRow[];
      // Prepared statements above optimize the common session/time predicates.
      // Isolation dimensions are optional and can be combined with any query
      // shape (notably L2 profile queries use teamId+agentId+updatedAfter
      // without sessionKey). Apply them in memory to keep the statement matrix
      // bounded and to match queryL1Paginated semantics.
      if (filter?.teamId !== undefined) rows = rows.filter((r) => r.team_id === filter.teamId);
      if (filter?.userId !== undefined) rows = rows.filter((r) => r.user_id === filter.userId);
      if (filter?.agentId !== undefined) rows = rows.filter((r) => r.agent_id === filter.agentId);
      if (taskId !== undefined) rows = rows.filter((r) => r.task_id === taskId);
      // GROW-EVO P2.1（契约修复）：recordIds 精确过滤——types.ts:150 声明但实现此前忽略，
      // atomic/update 与 dedup-update 取回全表首行（归属 403 误判 + version 虚高的根因）。
      if (recordIds && recordIds.length > 0) {
        const idSet = new Set(recordIds);
        rows = rows.filter((r) => idSet.has(r.record_id));
      }

      this.logger?.info(
        `${TAG} [L1-query] filter={sessionKey=${sessionKey ?? "(all)"}, sessionId=${sessionId ?? "(all)"}, teamId=${filter?.teamId ?? "(all)"}, userId=${filter?.userId ?? "(all)"}, agentId=${filter?.agentId ?? "(all)"}, taskId=${taskId ?? "(all)"}, updatedAfter=${updatedAfter ?? "(none)"}}, ` +
        `returned ${rows.length} record(s)`,
      );
      return rows;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-query] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  // ── L0 operations ──────────────────────────────────

  /**
   * Write or update an L0 single-message record (metadata + vector).
   * Uses a manual transaction for atomicity.
   *
   * If `embedding` is `undefined` or a zero vector (all elements are 0), only
   * the metadata row (`l0_conversations`) is written — the vec0 table
   * (`l0_vec`) is left untouched.  This allows callers without an
   * EmbeddingService to still persist metadata + FTS without constructing a
   * throwaway zero-vector, and prevents placeholder zero vectors (from
   * embedding-service failures) from polluting KNN search results.
   *
   * **Fault-tolerant**: catches all errors internally, never throws.
   * Returns `true` on success, `false` on failure (logged as warning).
   */
  upsertL0(record: L0Record, embedding: Float32Array | undefined): boolean {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-upsert] SKIPPED (degraded mode) id=${record.id}`);
      return false;
    }
    try {
      const skipVec = !embedding || embedding.every(v => v === 0) || !this.vecTablesReady;

      this.logger?.debug?.(
        `${TAG} [L0-upsert] START id=${record.id}, session=${record.sessionKey}, role=${record.role}, ` +
        `text="${record.messageText.slice(0, 60)}..."` +
        (embedding
          ? `, embeddingDims=${embedding.length}, ` +
            `embeddingNorm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}` +
            `${skipVec ? " (ZERO VECTOR or vec tables not ready — vec write will be skipped)" : ""}`
          : " (no embedding — metadata-only write)"),
      );

      this.db.exec("BEGIN");
      try {
        // Legacy callers may omit isolation fields; normalize them to the
        // same default identity used by schema defaults and query filters.
        this.stmtL0UpsertMeta.run(
          record.id,
          record.sessionKey,
          record.sessionId || DEFAULT_ISOLATION_ID,
          (record as L0Record & { teamId?: string }).teamId || DEFAULT_ISOLATION_ID,
          record.taskId || "",
          record.role,
          record.messageText,
          record.recordedAt,
          record.timestamp,
          (record as L0Record & { userId?: string }).userId || DEFAULT_ISOLATION_ID,
          (record as L0Record & { agentId?: string }).agentId || DEFAULT_ISOLATION_ID,
        );

        if (!skipVec) {
          // vec0 does not support ON CONFLICT → delete then insert
          this.stmtL0DeleteVec!.run(record.id);
          this.stmtL0InsertVec!.run(record.id, Buffer.from(embedding!.buffer), record.recordedAt);
        } else {
          this.logger?.debug?.(
            `${TAG} [L0-upsert] Skipping vec write (${embedding ? "zero vector" : "no embedding"}) id=${record.id}`,
          );
        }

        // Sync FTS5 (delete + re-insert to handle updates).
        // user_id / agent_id mirrored into FTS so post-recall isolation
        // filtering doesn't require a join.
        if (this.ftsAvailable) {
          try {
            this.stmtL0FtsDelete.run(record.id);
            this.stmtL0FtsInsert.run(
              tokenizeForFts(record.messageText), // message_text — segmented for indexing
              record.messageText,                 // message_text_original — raw for display
              record.id,
              record.sessionKey,
              record.sessionId || DEFAULT_ISOLATION_ID,
              (record as L0Record & { teamId?: string }).teamId || DEFAULT_ISOLATION_ID,
              record.taskId || "",
              (record as L0Record & { userId?: string }).userId || DEFAULT_ISOLATION_ID,
              (record as L0Record & { agentId?: string }).agentId || DEFAULT_ISOLATION_ID,
              record.role,
              record.recordedAt,
              record.timestamp,
            );
          } catch (ftsErr) {
            // FTS write failure is non-fatal — log and continue
            this.logger?.warn(
              `${TAG} [L0-upsert] FTS write failed (non-fatal) id=${record.id}: ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}`,
            );
          }
        }

        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
      this.logger?.debug?.(`${TAG} [L0-upsert] OK id=${record.id}${skipVec ? " (meta-only)" : ""}`);
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-upsert] FAILED (non-fatal) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Update ONLY the vector embedding for an existing L0 record.
   * The metadata row must already exist in l0_conversations (written by upsertL0).
   *
   * This is used by the background embedding task in auto-capture:
   *   1. upsertL0() writes metadata + FTS synchronously (no embedding)
   *   2. Background task calls embedBatch() then updateL0Embedding() for each record
   *
   * **Fault-tolerant**: catches all errors internally, never throws.
   * Returns `true` on success, `false` on failure.
   */
  updateL0Embedding(recordId: string, embedding: Float32Array): boolean {
    if (this.degraded || !this.vecTablesReady) {
      return false;
    }
    if (!embedding || embedding.every(v => v === 0)) {
      this.logger?.debug?.(`${TAG} [L0-update-embedding] Skipping zero vector for ${recordId}`);
      return false;
    }
    try {
      // Look up recorded_at from metadata for the vec0 row
      const meta = this.stmtL0GetMeta.get(recordId) as { recorded_at: string } | undefined;
      if (!meta) {
        this.logger?.warn(`${TAG} [L0-update-embedding] No metadata found for ${recordId}, skipping`);
        return false;
      }

      this.db.exec("BEGIN");
      try {
        this.stmtL0DeleteVec!.run(recordId);
        this.stmtL0InsertVec!.run(recordId, Buffer.from(embedding.buffer), meta.recorded_at);
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-update-embedding] FAILED (non-fatal) id=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Vector similarity search on L0 individual messages (cosine distance).
   * Returns top-k results sorted by similarity (highest first).
   *
   * **Fault-tolerant**: returns an empty array on any error.
   */
  searchL0Vector(queryEmbedding: Float32Array, topK = 5, _queryText?: string, filter?: IsolationFilter): L0VectorSearchResult[] {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded) this.logger?.warn(`${TAG} [L0-search] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      // Over-retrieve to compensate for legacy zero-vector placeholders that
      // may still exist in the vec0 table.  New zero vectors are no longer
      // inserted (upsertL0() skips vec write for zero vectors since v3.x), but
      // older data may still contain them — they surface as NULL/NaN distance
      // in KNN results.
      // NOTE: "AND distance IS NOT NULL" is NOT usable because vec0 does not
      // support that constraint — it causes an empty result set.
      const retrieveCount = filter ? Math.max(topK * 5, topK + VectorStore.ZERO_VEC_BUFFER) : topK + VectorStore.ZERO_VEC_BUFFER;

      this.logger?.debug?.(
        `${TAG} [L0-search] START topK=${topK}, retrieveCount=${retrieveCount}, ` +
        `queryEmbeddingDims=${queryEmbedding.length}, ` +
        `queryNorm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
      );

      const rows = this.stmtL0SearchVec!.all(
        Buffer.from(queryEmbedding.buffer),
        retrieveCount,
      ) as Array<{ record_id: string; distance: number }>;

      this.logger?.debug?.(`${TAG} [L0-search] vec0 returned ${rows.length} candidate(s)`);

      if (rows.length === 0) return [];

      const results: L0VectorSearchResult[] = [];

      for (const { record_id, distance } of rows) {
        // sqlite-vec returns null distance for zero vectors (cosine undefined when ‖v‖=0).
        // Skip these — they are placeholder vectors from embedding-service-unavailable fallback.
        if (distance == null || Number.isNaN(distance)) {
          this.logger?.warn(
            `${TAG} [L0-search] record_id=${record_id} has null/NaN distance (likely zero vector) — skipping`,
          );
          continue;
        }

        const meta = this.stmtL0GetMeta.get(record_id) as
          | {
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
          | undefined;

        if (!meta) {
          this.logger?.warn(`${TAG} [L0-search] record_id=${record_id} has vector but NO metadata (orphan)`);
          continue;
        }
        if (!rowMatchesIsolation(meta, filter)) {
          continue;
        }

        const score = 1.0 - distance;
        this.logger?.debug?.(
          `${TAG} [L0-search] HIT id=${record_id}, distance=${distance.toFixed(4)}, score=${score.toFixed(4)}, ` +
          `role=${meta.role}, session=${meta.session_key}, text="${meta.message_text.slice(0, 60)}..."`,
        );

        results.push({
          record_id,
          session_key: meta.session_key,
          session_id: meta.session_id,
          team_id: meta.team_id ?? "",
          task_id: meta.task_id ?? "",
          user_id: meta.user_id ?? "",
          agent_id: meta.agent_id ?? "",
          role: meta.role,
          message_text: meta.message_text,
          score,
          recorded_at: meta.recorded_at,
          timestamp: meta.timestamp ?? 0,
        });
      }

      // Trim back to the caller's requested topK (we over-fetched above).
      const trimmed = results.slice(0, topK);
      this.logger?.info(
        `${TAG} [L0-search] DONE returning ${trimmed.length} result(s) (from ${results.length} valid, ${rows.length} raw)`,
      );
      return trimmed;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Delete a single L0 record (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   */
  deleteL0(recordId: string, filter?: IsolationFilter): boolean {
    if (this.degraded) return false;
    try {
      if (filter) {
        const meta = this.stmtL0GetMeta.get(recordId) as { user_id?: string; agent_id?: string; session_id?: string; session_key?: string } | undefined;
        if (!meta || !rowMatchesIsolation(meta, filter)) return false;
      }
      this.db.exec("BEGIN");
      try {
        const result = this.stmtL0DeleteMeta.run(recordId);
        const deleted = (result as any)?.changes > 0;
        if (this.vecTablesReady) this.stmtL0DeleteVec!.run(recordId);
        if (this.ftsAvailable) {
          try { this.stmtL0FtsDelete.run(recordId); } catch { /* non-fatal */ }
        }
        this.db.exec("COMMIT");
        return deleted;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL0 failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * TTL cleanup by recorded_at (ISO string) for L0 records.
   *
   * Deletes expired rows from l0_conversations and matching vectors from l0_vec
   * in a single transaction to guarantee consistency.
   */
  deleteL0Expired(cutoffIso: string): number {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [deleteExpiredL0] SKIPPED (degraded mode)`);
      return 0;
    }

    try {
      const row = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM l0_conversations WHERE recorded_at != '' AND recorded_at < ?",
      ).get(cutoffIso) as { cnt: number } | undefined;
      const expiredCount = row?.cnt ?? 0;
      if (expiredCount <= 0) return 0;

      // Ratio protection: refuse to delete > 80% in one pass
      const totalRow = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM l0_conversations",
      ).get() as { cnt: number };
      const total = totalRow.cnt;
      const ratio = total > 0 ? expiredCount / total : 0;
      if (ratio > 0.8) {
        this.logger?.warn(
          `${TAG} [L0-deleteExpired] BLOCKED: would delete ${expiredCount}/${total} ` +
          `(${(ratio * 100).toFixed(1)}%) — exceeds 80% safety threshold, cutoff=${cutoffIso}`,
        );
        return 0;
      }

      this.db.exec("BEGIN");
      try {
        if (this.vecTablesReady) {
          this.db.prepare(
            "DELETE FROM l0_vec WHERE recorded_at != '' AND recorded_at < ?",
          ).run(cutoffIso);
        }
        this.db.prepare(
          "DELETE FROM l0_conversations WHERE recorded_at != '' AND recorded_at < ?",
        ).run(cutoffIso);
        this.db.exec("COMMIT");
        this.logger?.info?.(
          `${TAG} [L0-deleteExpired] Deleted ${expiredCount}/${total} records (cutoff=${cutoffIso})`,
        );
        return expiredCount;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL0ExpiredByRecordedAt failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Get the total number of L0 message records matching optional filters.
   *
   * **Fault-tolerant**: returns 0 on failure.
   */
  countL0(filter?: L0CountFilter): number {
    if (this.degraded) return 0;
    try {
      const conditions: string[] = [];
      const params: SQLInputValue[] = [];

      if (filter?.sessionId) {
        conditions.push("(session_key = ? OR session_id = ?)");
        params.push(filter.sessionId, filter.sessionId);
      }
      if (filter?.teamId !== undefined) {
        conditions.push("team_id = ?");
        params.push(filter.teamId);
      }
      if (filter?.userId !== undefined) {
        conditions.push("user_id = ?");
        params.push(filter.userId);
      }
      if (filter?.agentId !== undefined) {
        conditions.push("agent_id = ?");
        params.push(filter.agentId);
      }
      if (filter?.taskId !== undefined) {
        conditions.push("task_id = ?");
        params.push(filter.taskId);
      }
      if (filter?.timeStartMs !== undefined) {
        conditions.push("timestamp >= ?");
        params.push(filter.timeStartMs);
      }
      if (filter?.timeEndMs !== undefined) {
        conditions.push("timestamp <= ?");
        params.push(filter.timeEndMs);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const row = this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM l0_conversations ${where}`)
        .get(...params) as { cnt: number } | undefined;
      const total = row?.cnt ?? 0;
      this.logger?.debug?.(`${TAG} [L0-count] total=${total}`);
      return total;
    } catch (err) {
      this.logger?.warn(
        `${TAG} countL0 failed (non-fatal, returning 0): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  // ── Re-index operations ──────────────────────────────────

  /**
   * Get all L1 record texts for re-embedding.
   * Returns record_id → content pairs.
   */
  getAllL1Texts(): Array<{ record_id: string; content: string; updated_time: string }> {
    if (this.degraded) return [];
    try {
      return this.db
        .prepare("SELECT record_id, content, updated_time FROM l1_records")
        .all() as Array<{ record_id: string; content: string; updated_time: string }>;
    } catch (err) {
      this.logger?.warn(
        `${TAG} getAllL1Texts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Get all L0 message texts for re-embedding.
   * Returns record_id → message_text/recorded_at tuples.
   */
  getAllL0Texts(): Array<{ record_id: string; message_text: string; recorded_at: string }> {
    if (this.degraded) return [];
    try {
      return this.db
        .prepare("SELECT record_id, message_text, recorded_at FROM l0_conversations")
        .all() as Array<{ record_id: string; message_text: string; recorded_at: string }>;
    } catch (err) {
      this.logger?.warn(
        `${TAG} getAllL0Texts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Re-embed all existing L1 and L0 texts with a new embedding function.
   *
   * This is called after `init()` returns `needsReindex: true` — the vector
   * tables have already been dropped and re-created with the correct dimensions.
   * This method reads every text from the metadata tables and writes fresh
   * embeddings into the new vector tables.
   *
   * @param embedFn  A function that converts text → Float32Array embedding.
   * @param onProgress  Optional callback for progress reporting.
   */
  async reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }> {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded) this.logger?.warn(`${TAG} reindexAll skipped: VectorStore is in degraded mode`);
      return { l1Count: 0, l0Count: 0 };
    }

    try {
      // ── Re-embed L1 ──
      const l1Rows = this.getAllL1Texts();
      let l1Done = 0;
      for (const { record_id, content, updated_time } of l1Rows) {
        try {
          const embedding = await embedFn(content);
          // Wrap delete+insert in a transaction to prevent orphan vectors
          this.db.exec("BEGIN");
          try {
            this.stmtDeleteVec!.run(record_id);
            this.stmtInsertVec!.run(record_id, Buffer.from(embedding.buffer), updated_time);
            this.db.exec("COMMIT");
          } catch (txErr) {
            try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
            throw txErr;
          }
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} reindex L1 skip ${record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        l1Done++;
        onProgress?.(l1Done, l1Rows.length, "L1");
      }

      // ── Re-embed L0 ──
      const l0Rows = this.getAllL0Texts();
      let l0Done = 0;
      for (const { record_id, message_text, recorded_at } of l0Rows) {
        try {
          const embedding = await embedFn(message_text);
          // Wrap delete+insert in a transaction to prevent orphan vectors
          this.db.exec("BEGIN");
          try {
            this.stmtL0DeleteVec!.run(record_id);
            this.stmtL0InsertVec!.run(record_id, Buffer.from(embedding.buffer), recorded_at);
            this.db.exec("COMMIT");
          } catch (txErr) {
            try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
            throw txErr;
          }
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} reindex L0 skip ${record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        l0Done++;
        onProgress?.(l0Done, l0Rows.length, "L0");
      }

      this.logger?.info(
        `${TAG} Reindex complete: L1=${l1Done}/${l1Rows.length}, L0=${l0Done}/${l0Rows.length}`,
      );

      return { l1Count: l1Done, l0Count: l0Done };
    } catch (err) {
      this.logger?.error(
        `${TAG} reindexAll failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { l1Count: 0, l0Count: 0 };
    }
  }

  // ── L0 query operations (for L1 runner) ──────────────────────────────────

  /**
   * Query L0 messages for a given session key, optionally filtered by recorded_at cursor.
   * Returns up to `limit` rows with `recorded_at > afterRecordedAtMs`, ordered by
   * recorded_at ASC (chronological write order, **oldest-first**).
   *
   * Used by L1 runner to read L0 data from DB. The runner is responsible for
   * batching/slicing the returned rows (e.g. process N, defer the rest).
   */
  queryL0ForL1(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit = 50,
  ): L0QueryRow[] {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-query] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      // Query oldest-first (ASC) with LIMIT — preserves backlog ordering so
      // callers that advance a recorded_at cursor never skip older rows.
      let rows: Array<Record<string, unknown>>;
      if (afterRecordedAtMs && afterRecordedAtMs > 0) {
        // Convert epoch ms to ISO string for recorded_at comparison
        const afterRecordedAtIso = new Date(afterRecordedAtMs).toISOString();
        rows = this.stmtL0QueryAfter.all(sessionKey, afterRecordedAtIso, limit) as Array<Record<string, unknown>>;
      } else {
        rows = this.stmtL0QueryAll.all(sessionKey, limit) as Array<Record<string, unknown>>;
      }

      this.logger?.info(
        `${TAG} [L0-query] session=${sessionKey}, afterRecordedAtMs=${afterRecordedAtMs ?? "(all)"}, ` +
        `limit=${limit}, returned ${rows.length} row(s)`,
      );

      return rows.map((r) => ({
        record_id: r.record_id as string,
        session_key: r.session_key as string,
        session_id: (r.session_id as string) || "",
        team_id: (r.team_id as string) || "",
        task_id: (r.task_id as string) || "",
        user_id: (r.user_id as string) || "",
        agent_id: (r.agent_id as string) || "",
        role: r.role as string,
        message_text: r.message_text as string,
        recorded_at: (r.recorded_at as string) || "",
        timestamp: (r.timestamp as number) || 0,
      }));
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * v4#5 验证轮补口：枚举 L0 会话键（DISTINCT session_id，boot recovery 数据源二）。
   * degraded → []；空串剔除。游标治理保证扩面键空跑零成本。
   */
  listL0SessionIds(): string[] {
    if (this.degraded) return [];
    try {
      const rows = this.db.prepare(
        "SELECT DISTINCT session_id FROM l0_conversations WHERE session_id != ''",
      ).all() as Array<{ session_id: string }>;
      return rows.map((r) => r.session_id);
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-sessions] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Query L0 messages for a given session key, grouped by session_id.
   * Each group's messages are in chronological order (recorded_at ASC).
   * Groups are sorted by earliest message timestamp.
   *
   * Used by L1 runner to replace readConversationMessagesGroupedBySessionId().
   */
  queryL0GroupedBySessionId(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit = 50,
  ): Array<{ sessionId: string; teamId?: string; taskId?: string; userId: string; agentId: string; messages: Array<{ id: string; role: string; content: string; timestamp: number; recordedAtMs: number }> }> {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-query-grouped] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      const rows = this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit);

      // Group by full isolation tuple + session_id to avoid cross-tenant merging.
      const groupMap = new Map<string, {
        sessionId: string;
        teamId?: string;
        taskId?: string;
        userId: string;
        agentId: string;
        messages: Array<{ id: string; role: string; content: string; timestamp: number; recordedAtMs: number }>;
      }>();
      for (const row of rows) {
        const sid = row.session_id || "";
        const teamId = row.team_id || undefined;
        const taskId = row.task_id || undefined;
        const userId = row.user_id || "";
        const agentId = row.agent_id || "";
        const groupKey = `${teamId ?? ""}\u0000${userId}\u0000${agentId}\u0000${sid}\u0000${taskId ?? ""}`;
        let group = groupMap.get(groupKey);
        if (!group) {
          group = { sessionId: sid, teamId, taskId, userId, agentId, messages: [] };
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
      const groups: Array<{ sessionId: string; teamId?: string; taskId?: string; userId: string; agentId: string; messages: Array<{ id: string; role: string; content: string; timestamp: number; recordedAtMs: number }> }> = [];
      for (const group of groupMap.values()) {
        if (group.messages.length > 0) {
          groups.push(group);
        }
      }
      groups.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);

      this.logger?.info(
        `${TAG} [L0-query-grouped] session=${sessionKey}, afterRecordedAtMs=${afterRecordedAtMs ?? "(all)"}, ` +
        `${rows.length} messages across ${groups.length} group(s)`,
      );

      return groups;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query-grouped] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── Cursor-based pagination for migration ──────────────────

  /**
   * Read a page of L1 records using primary key cursor.
   * Returns rows with `record_id > afterId`, ordered by PK, limited to `pageSize`.
   * Pass `""` as `afterId` for the first page.
   */
  queryL1RecordsCursor(afterId: string, pageSize: number): L1RecordRow[] {
    if (this.degraded) return [];
    try {
      return this.stmtL1QueryMigrationCursor.all(afterId, pageSize) as unknown as L1RecordRow[];
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-query-cursor] FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Read a page of L0 records using primary key cursor.
   * Returns rows with `record_id > afterId`, ordered by PK, limited to `pageSize`.
   * Pass `""` as `afterId` for the first page.
   */
  queryL0RecordsCursor(afterId: string, pageSize: number): L0RecordRow[] {
    if (this.degraded) return [];
    try {
      return this.stmtL0QueryMigrationCursor.all(afterId, pageSize) as unknown as L0RecordRow[];
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query-cursor] FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── FTS5 search operations ──────────────────────────────────

  /**
   * Whether FTS5 full-text search is available.
   * When `false`, callers should skip keyword-based recall entirely.
   */
  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  // ── v2 API: Paginated queries ─────────────────────────────

  /**
   * L0 paginated query for v2 `/conversation/query`.
   * Uses SQL WHERE + LIMIT + OFFSET, no full-table scan.
   */
  queryL0Paginated(filter: L0PaginatedFilter): L0PaginatedResult {
    if (this.degraded) return { rows: [], total: 0 };

    try {
      const conditions: string[] = [];
      const params: SQLInputValue[] = [];

      if (filter.sessionId) {
        conditions.push("(session_key = ? OR session_id = ?)");
        params.push(filter.sessionId, filter.sessionId);
      }
      // Isolation dimensions — see docs/l0l3-tenant-isolation-design.md.
      if (filter.teamId !== undefined) {
        conditions.push("team_id = ?");
        params.push(filter.teamId);
      }
      if (filter.userId !== undefined) {
        conditions.push("user_id = ?");
        params.push(filter.userId);
      }
      if (filter.agentId !== undefined) {
        conditions.push("agent_id = ?");
        params.push(filter.agentId);
      }
      if (filter.taskId !== undefined) {
        conditions.push("task_id = ?");
        params.push(filter.taskId);
      }
      if (filter.timeStartMs !== undefined) {
        conditions.push("timestamp >= ?");
        params.push(filter.timeStartMs);
      }
      if (filter.timeEndMs !== undefined) {
        conditions.push("timestamp <= ?");
        params.push(filter.timeEndMs);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Count total
      const countSql = `SELECT COUNT(*) AS cnt FROM l0_conversations ${where}`;
      const countRow = this.db.prepare(countSql).get(...params) as { cnt: number } | undefined;
      const total = countRow?.cnt ?? 0;

      // Fetch page
      const dataSql = `SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp FROM l0_conversations ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
      const rows = this.db.prepare(dataSql).all(...params, filter.limit, filter.offset) as unknown as L0QueryRow[];

      return { rows, total };
    } catch (err) {
      this.logger?.warn(`[sqlite] queryL0Paginated failed: ${err instanceof Error ? err.message : String(err)}`);
      return { rows: [], total: 0 };
    }
  }

  /**
   * L1 paginated query for v2 `/atomic/query`.
   * Uses SQL WHERE + LIMIT + OFFSET, no full-table scan.
   */
  queryL1Paginated(filter: L1PaginatedFilter): L1PaginatedResult {
    if (this.degraded) return { rows: [], total: 0 };

    try {
      const conditions: string[] = [];
      const params: SQLInputValue[] = [];

      if (filter.type) {
        conditions.push("type = ?");
        params.push(filter.type);
      }
      if (filter.sessionId) {
        conditions.push("session_id = ?");
        params.push(filter.sessionId);
      }
      // Isolation dimensions.
      if (filter.teamId !== undefined) {
        conditions.push("team_id = ?");
        params.push(filter.teamId);
      }
      if (filter.userId !== undefined) {
        conditions.push("user_id = ?");
        params.push(filter.userId);
      }
      if (filter.agentId !== undefined) {
        conditions.push("agent_id = ?");
        params.push(filter.agentId);
      }
      if (filter.taskId !== undefined) {
        conditions.push("task_id = ?");
        params.push(filter.taskId);
      }
      // TIMEFIX-v2（2026-09-11）：时间过滤列从 updated_time 改为 occurred_at（业务时间）——
      // 用户"选今天"的语义是记忆的发生时间；updated_time 会被重巩固/元数据回填刷写
      // （H-B12 耦合），用它过滤会让"今天"混入任意旧记忆（用户实测 9.11/9.10/9.7 乱入）。
      // occurred_at 由 l1-writer 以 toISOString()（UTC Z）写入，与 canonicalIsoBound
      // 的规范化形态同构，TEXT 字典序比较可靠。occurred_at 为 NULL 的行在过滤激活时
      // 不命中（宁缺毋滥；无窗查询不过滤不受影响）。
      const timeStart = this.canonicalIsoBound(filter.timeStart, "timeStart");
      if (timeStart) {
        conditions.push("occurred_at >= ?");
        params.push(timeStart);
      }
      const timeEnd = this.canonicalIsoBound(filter.timeEnd, "timeEnd");
      if (timeEnd) {
        conditions.push("occurred_at <= ?");
        params.push(timeEnd);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Count total
      const countSql = `SELECT COUNT(*) AS cnt FROM l1_records ${where}`;
      const countRow = this.db.prepare(countSql).get(...params) as { cnt: number } | undefined;
      const total = countRow?.cnt ?? 0;

      // Fetch page — must include user_id / agent_id so callers can enforce
      // isolation in downstream filters / Coordinator candidate pool.
      // TIMEFIX-v2：排序同改 occurred_at DESC——时间线的排序键与过滤键/显示日期
      // 三者一致（原 updated_time 排序在回填/重巩固刷写后产生 9.11/9.10/9.7 乱序）。
      const dataSql = `SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_start, timestamp_end, created_time, updated_time, metadata_json, occurred_at, valid_start, valid_end, certainty, source, valence, arousal, significance, sensitivity FROM l1_records ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`;
      const rows = this.db.prepare(dataSql).all(...params, filter.limit, filter.offset) as unknown as L1RecordRow[];

      return { rows, total };
    } catch (err) {
      this.logger?.warn(`[sqlite] queryL1Paginated failed: ${err instanceof Error ? err.message : String(err)}`);
      return { rows: [], total: 0 };
    }
  }

  /**
   * Delete all L0 messages belonging to a session.
   * Returns the count of actually deleted rows.
   */
  deleteL0BySession(sessionId: string, filter?: IsolationFilter): number {
    // 空 sessionId 会匹配所有 session_key/session_id 为空的历史 legacy 行，
    // 造成远超预期的删除范围。空 session 不是有效删除目标，直接拒绝。
    const sessionIdTrimmed = (sessionId ?? "").trim();
    if (!sessionIdTrimmed) {
      throw new Error("[sqlite] deleteL0BySession requires a non-empty sessionId");
    }

    if (this.degraded) return 0;

    try {
      // 必须把 rowMatchesIsolation 会检查的**所有**列都取出来
      // （team_id / task_id 早期漏取，导致带 teamId 的 isolation filter
      // 永远判不匹配 → 按session 删除恒返回 0）。
      const rows = this.db.prepare(
        "SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id FROM l0_conversations WHERE session_key = ? OR session_id = ?"
      ).all(sessionIdTrimmed, sessionIdTrimmed) as Array<{
        record_id: string; session_key: string; session_id: string;
        team_id: string; task_id: string; user_id: string; agent_id: string;
      }>;

      if (rows.length === 0) return 0;

      this.db.exec("BEGIN");
      try {
        let deletedCount = 0;
        for (const row of rows) {
          if (filter && !rowMatchesIsolation(row, filter)) continue;
          const result = this.db.prepare("DELETE FROM l0_conversations WHERE record_id = ?").run(row.record_id);
          if (((result as any)?.changes ?? 0) <= 0) continue;
          deletedCount++;
          if (this.vecTablesReady) {
            try { this.db.prepare("DELETE FROM l0_vec WHERE record_id = ?").run(row.record_id); } catch { /* vec may not exist */ }
          }
          if (this.ftsAvailable) {
            try { this.db.prepare("DELETE FROM l0_fts WHERE record_id = ?").run(row.record_id); } catch { /* fts may not exist */ }
          }
        }
        this.db.exec("COMMIT");
        return deletedCount;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    } catch (err) {
      this.logger?.warn(`[sqlite] deleteL0BySession failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /**
   * 清空某个 (team, agent) 下的全部 L0 + L1 内容（含向量 / FTS 附属行）。
   * 不动entity_* / meta_* 资产表 —— 资产 ID 与绑定关系完整保留。
   *
   * sqlite store 不落L2/L3 profile 行（profiles 表只存在于 TCVDB），
   * 所以 profilesDeleted 恒为 0，L2/L3 文件由调用方走 StorageAdapter 清理。
   */
  clearMemoryContent(filter: MemoryContentClearFilter): MemoryContentClearResult {
    const teamId = (filter?.teamId ?? "").trim();
    const agentId = (filter?.agentId ?? "").trim();
    if (!teamId || !agentId) {
      throw new Error("clearMemoryContent requires non-empty teamId and agentId");
    }
    const userId = filter.userId?.trim() || undefined;
    const empty: MemoryContentClearResult = { l0Deleted: 0, l1Deleted: 0, profilesDeleted: 0 };
    if (this.degraded) return empty;

    // 参数绑定，禁止拼接。userId 可选 → 动态追加一段条件 + 一个参数。
    const where = `team_id = ? AND agent_id = ?${userId ? " AND user_id = ?" : ""}`;
    const params: string[] = userId ? [teamId, agentId, userId] : [teamId, agentId];

    try {
      const l0Ids = (this.db.prepare(
        `SELECT record_id FROM l0_conversations WHERE ${where}`,
      ).all(...params) as Array<{ record_id: string }>).map((r) => r.record_id);
      const l1Ids = (this.db.prepare(
        `SELECT record_id FROM l1_records WHERE ${where}`,
      ).all(...params) as Array<{ record_id: string }>).map((r) => r.record_id);

      if (l0Ids.length === 0 && l1Ids.length === 0) return empty;

      this.db.exec("BEGIN");
      try {
        let l0Deleted = 0;
        for (const id of l0Ids) {
          const res = this.db.prepare("DELETE FROM l0_conversations WHERE record_id = ?").run(id);
          if (((res as any)?.changes ?? 0) <= 0) continue;
          l0Deleted++;
          if (this.vecTablesReady) {
            try { this.db.prepare("DELETE FROM l0_vec WHERE record_id = ?").run(id); } catch { /* vec may not exist */ }
          }
          if (this.ftsAvailable) {
            try { this.db.prepare("DELETE FROM l0_fts WHERE record_id = ?").run(id); } catch { /* fts may not exist */ }
          }
        }

        let l1Deleted = 0;
        for (const id of l1Ids) {
          const res = this.db.prepare("DELETE FROM l1_records WHERE record_id = ?").run(id);
          if (((res as any)?.changes ?? 0) <= 0) continue;
          l1Deleted++;
          if (this.vecTablesReady) {
            try { this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?").run(id); } catch { /* vec may not exist */ }
          }
          if (this.ftsAvailable) {
            try { this.db.prepare("DELETE FROM l1_fts WHERE record_id = ?").run(id); } catch { /* fts may not exist */ }
          }
        }

        this.db.exec("COMMIT");
        return { l0Deleted, l1Deleted, profilesDeleted: 0 };
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    } catch (err) {
      this.logger?.warn(`[sqlite] clearMemoryContent failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private entityId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  private jsonArray(value: unknown): string {
    return JSON.stringify(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : []);
  }

  private parseArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    if (typeof value !== "string" || !value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  private teamFromRow(row: any, includeRefs = false): TeamEntity {
    const teamId = String(row.team_id ?? "");
    const ownerUserId = String(row.owner_user_id ?? "");
    const team: TeamEntity = {
      team_id: teamId,
      name: String(row.name ?? ""),
      description: String(row.description ?? "") || undefined,
      owner_user_id: ownerUserId,
      status: (row.status as TeamEntity["status"]) || "active",
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
    if (includeRefs) {
      const userIds = new Set<string>(this.parseArray(row.user_ids_json));
      if (ownerUserId) userIds.add(ownerUserId);
      team.user_ids = Array.from(userIds).sort();
      const agentIds = new Set<string>(this.parseArray(row.agent_ids_json));
      const agents = this.db.prepare("SELECT agent_id FROM entity_agents WHERE team_id = ? AND status = 'active' ORDER BY agent_id").all(teamId) as any[];
      for (const agent of agents) agentIds.add(String(agent.agent_id));
      team.agent_ids = Array.from(agentIds).sort();
      team.task_ids = (this.db.prepare("SELECT task_id FROM entity_tasks WHERE team_id = ? ORDER BY task_id").all(teamId) as any[]).map((r) => String(r.task_id));
    }
    return team;
  }

  private userFromRow(row: any, includeDerived = false): UserEntity {
    const userId = String(row.user_id ?? "");
    const user: UserEntity = {
      user_id: userId,
      name: String(row.name ?? ""),
      job_description: String(row.job_description ?? "") || undefined,
      team_ids: [],
      task_ids: [],
      owned_agent_ids: [],
      status: (row.status as UserEntity["status"]) || "active",
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
    if (includeDerived) {
      const teams = this.db.prepare("SELECT team_id, owner_user_id, user_ids_json FROM entity_teams WHERE status = 'active'").all() as any[];
      user.team_ids = teams
        .filter((team) => String(team.owner_user_id ?? "") === userId || this.parseArray(team.user_ids_json).includes(userId))
        .map((team) => String(team.team_id))
        .sort();
      const tasks = this.db.prepare("SELECT task_id, creator_user_id, user_ids_json, agent_ids_json FROM entity_tasks ORDER BY task_id").all() as any[];
      const taskIds = new Set<string>();
      const taskAgentIds = new Set<string>();
      for (const task of tasks) {
        const participates = String(task.creator_user_id ?? "") === userId || this.parseArray(task.user_ids_json).includes(userId);
        if (!participates) continue;
        taskIds.add(String(task.task_id));
        for (const agentId of this.parseArray(task.agent_ids_json)) taskAgentIds.add(agentId);
      }
      user.task_ids = Array.from(taskIds).sort();
      user.task_agent_ids = Array.from(taskAgentIds).sort();
      user.owned_agent_ids = (this.db.prepare("SELECT agent_id FROM entity_agents WHERE owner_user_id = ? AND status = 'active' ORDER BY agent_id").all(userId) as any[]).map((r) => String(r.agent_id));
    }
    return user;
  }

  private agentFromRow(row: any, includeDerived = true): AgentEntity {
    const agentId = String(row.agent_id ?? "");
    const agent: AgentEntity = {
      agent_id: agentId,
      team_id: String(row.team_id ?? ""),
      name: String(row.name ?? ""),
      description: String(row.description ?? "") || undefined,
      prompt: String(row.prompt ?? "") || undefined,
      owner_user_id: String(row.owner_user_id ?? "") || undefined,
      visibility: (row.visibility as AgentEntity["visibility"]) || "team",
      status: (row.status as AgentEntity["status"]) || "active",
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
    if (includeDerived) {
      const tasks = this.db.prepare("SELECT task_id, agent_ids_json FROM entity_tasks ORDER BY task_id").all() as any[];
      agent.task_ids = tasks.filter((task) => this.parseArray(task.agent_ids_json).includes(agentId)).map((task) => String(task.task_id));
    }
    return agent;
  }

  private taskFromRow(row: any): TaskEntity {
    return {
      task_id: String(row.task_id ?? ""),
      team_id: String(row.team_id ?? ""),
      creator_user_id: String(row.creator_user_id ?? ""),
      title: String(row.title ?? "") || undefined,
      description: String(row.description ?? "") || undefined,
      source_type: (row.source_type as TaskEntity["source_type"]) || "manual",
      source_url: String(row.source_url ?? "") || undefined,
      agent_ids: this.parseArray(row.agent_ids_json),
      user_ids: this.parseArray(row.user_ids_json),
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  createTeam(input: Omit<TeamEntity, "created_at" | "updated_at" | "status" | "user_ids" | "agent_ids" | "task_ids"> & { team_id?: string; status?: TeamEntity["status"] }): TeamEntity {
    const now = new Date().toISOString();
    const id = input.team_id || this.entityId("team");
    this.db.prepare("INSERT INTO entity_teams (team_id, name, description, owner_user_id, user_ids_json, agent_ids_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.name, input.description ?? "", input.owner_user_id, this.jsonArray([input.owner_user_id]), this.jsonArray([]), input.status ?? "active", now, now);
    return this.getTeam(id) ?? { team_id: id, name: input.name, owner_user_id: input.owner_user_id, status: input.status ?? "active", created_at: now, updated_at: now };
  }

  getTeam(teamId: string): TeamEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_teams WHERE team_id = ?").get(teamId) as any;
    return row ? this.teamFromRow(row, true) : null;
  }

  updateTeam(teamId: string, patch: Partial<Pick<TeamEntity, "name" | "description" | "owner_user_id" | "user_ids" | "agent_ids" | "status">>): TeamEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_teams WHERE team_id = ?").get(teamId) as any;
    if (!row) return null;
    const current = this.teamFromRow(row, true);
    const ownerUserId = patch.owner_user_id ?? current.owner_user_id;
    const userIds = patch.user_ids !== undefined ? Array.from(new Set([...patch.user_ids, ownerUserId])).sort() : this.parseArray(row.user_ids_json);
    if (ownerUserId && !userIds.includes(ownerUserId)) userIds.push(ownerUserId);
    const agentIds = patch.agent_ids !== undefined ? patch.agent_ids : this.parseArray(row.agent_ids_json);
    const next = { ...current, ...patch, owner_user_id: ownerUserId, updated_at: new Date().toISOString() };
    this.db.prepare("UPDATE entity_teams SET name = ?, description = ?, owner_user_id = ?, user_ids_json = ?, agent_ids_json = ?, status = ?, updated_at = ? WHERE team_id = ?").run(next.name, next.description ?? "", ownerUserId, this.jsonArray(userIds), this.jsonArray(agentIds), next.status, next.updated_at, teamId);
    return this.getTeam(teamId);
  }

  deleteTeams(teamIds: string[]): BatchDeleteResult {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of teamIds) {
      const row = this.getTeam(id);
      if (!row) { result.failed.push({ id, reason: "not_found" }); continue; }
      this.updateTeam(id, { status: "archived" });
      result.deleted_ids.push(id);
    }
    return result;
  }

  createUser(input: Pick<UserEntity, "name"> & Partial<Pick<UserEntity, "job_description" | "status">> & { user_id?: string }): UserEntity {
    const now = new Date().toISOString();
    const id = input.user_id || this.entityId("user");
    this.db.prepare("INSERT INTO entity_users (user_id, name, job_description, team_ids_json, task_ids_json, owned_agent_ids_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.name, input.job_description ?? "", this.jsonArray([]), this.jsonArray([]), this.jsonArray([]), input.status ?? "active", now, now);
    return this.getUser(id) ?? { user_id: id, name: input.name, team_ids: [], task_ids: [], owned_agent_ids: [], status: input.status ?? "active", created_at: now, updated_at: now };
  }

  getUser(userId: string): UserEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_users WHERE user_id = ?").get(userId) as any;
    return row ? this.userFromRow(row, true) : null;
  }

  updateUser(userId: string, patch: Partial<Pick<UserEntity, "name" | "job_description" | "status">>): UserEntity | null {
    const current = this.getUser(userId);
    if (!current) return null;
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    this.db.prepare("UPDATE entity_users SET name = ?, job_description = ?, status = ?, updated_at = ? WHERE user_id = ?").run(next.name, next.job_description ?? "", next.status, next.updated_at, userId);
    return this.getUser(userId);
  }

  deleteUsers(userIds: string[]): BatchDeleteResult {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of userIds) {
      if (!this.getUser(id)) { result.failed.push({ id, reason: "not_found" }); continue; }
      this.updateUser(id, { status: "inactive" });
      result.deleted_ids.push(id);
    }
    return result;
  }

  createAgent(input: Omit<AgentEntity, "created_at" | "updated_at" | "status" | "visibility" | "task_ids"> & { agent_id?: string; status?: AgentEntity["status"]; visibility?: AgentEntity["visibility"] }): AgentEntity {
    const now = new Date().toISOString();
    const id = input.agent_id || this.entityId("agent");
    this.db.prepare("INSERT INTO entity_agents (agent_id, team_id, name, description, prompt, owner_user_id, visibility, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.team_id, input.name, input.description ?? "", input.prompt ?? "", input.owner_user_id ?? "", input.visibility ?? "team", input.status ?? "active", now, now);
    const team = this.getTeam(input.team_id);
    if (team && !(team.agent_ids ?? []).includes(id)) this.updateTeam(input.team_id, { agent_ids: [...(team.agent_ids ?? []), id] });
    return this.getAgent(id) ?? { agent_id: id, team_id: input.team_id, name: input.name, visibility: input.visibility ?? "team", status: input.status ?? "active", created_at: now, updated_at: now };
  }

  getAgent(agentId: string): AgentEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_agents WHERE agent_id = ?").get(agentId) as any;
    return row ? this.agentFromRow(row) : null;
  }

  updateAgent(agentId: string, patch: Partial<Pick<AgentEntity, "name" | "description" | "prompt" | "owner_user_id" | "visibility" | "status">>): AgentEntity | null {
    const current = this.getAgent(agentId);
    if (!current) return null;
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    this.db.prepare("UPDATE entity_agents SET name = ?, description = ?, prompt = ?, owner_user_id = ?, visibility = ?, status = ?, updated_at = ? WHERE agent_id = ?").run(next.name, next.description ?? "", next.prompt ?? "", next.owner_user_id ?? "", next.visibility, next.status, next.updated_at, agentId);
    return this.getAgent(agentId);
  }

  deleteAgents(agentIds: string[]): BatchDeleteResult {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of agentIds) {
      if (!this.getAgent(id)) { result.failed.push({ id, reason: "not_found" }); continue; }
      this.updateAgent(id, { status: "inactive" });
      result.deleted_ids.push(id);
    }
    return result;
  }

  createTask(input: Omit<TaskEntity, "created_at" | "updated_at" | "source_type" | "agent_ids" | "user_ids"> & { task_id?: string; source_type?: TaskEntity["source_type"]; agent_ids?: string[]; user_ids?: string[] }): TaskEntity {
    const now = new Date().toISOString();
    const id = input.task_id || this.entityId("task");
    this.db.prepare("INSERT INTO entity_tasks (task_id, team_id, creator_user_id, title, description, source_type, source_url, status, auto_assign_floating_assets, risk_level, agent_ids_json, user_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.team_id, input.creator_user_id, input.title ?? "", input.description ?? "", input.source_type ?? "manual", input.source_url ?? "", "pending", 0, "low", this.jsonArray(input.agent_ids), this.jsonArray(input.user_ids), now, now);
    return this.getTask(id) ?? { task_id: id, team_id: input.team_id, creator_user_id: input.creator_user_id, source_type: input.source_type ?? "manual", agent_ids: input.agent_ids ?? [], user_ids: input.user_ids ?? [], created_at: now, updated_at: now };
  }

  getTask(taskId: string): TaskEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_tasks WHERE task_id = ?").get(taskId) as any;
    return row ? this.taskFromRow(row) : null;
  }

  updateTask(taskId: string, patch: Partial<Pick<TaskEntity, "title" | "description" | "source_type" | "source_url" | "agent_ids" | "user_ids">>): TaskEntity | null {
    const current = this.getTask(taskId);
    if (!current) return null;
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    this.db.prepare("UPDATE entity_tasks SET title = ?, description = ?, source_type = ?, source_url = ?, agent_ids_json = ?, user_ids_json = ?, updated_at = ? WHERE task_id = ?").run(next.title ?? "", next.description ?? "", next.source_type, next.source_url ?? "", this.jsonArray(next.agent_ids), this.jsonArray(next.user_ids), next.updated_at, taskId);
    return this.getTask(taskId);
  }

  deleteTasks(taskIds: string[]): BatchDeleteResult {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of taskIds) {
      if (!this.getTask(id)) { result.failed.push({ id, reason: "not_found" }); continue; }
      this.db.prepare("DELETE FROM entity_tasks WHERE task_id = ?").run(id);
      result.deleted_ids.push(id);
    }
    return result;
  }

  // ── Knowledge entity ──

  private knowledgeFromRow(row: any): KnowledgeEntity {
    return {
      knowledge_id: String(row.knowledge_id ?? ""),
      type: (row.type as KnowledgeType) ?? "wiki",
      service_url: String(row.service_url ?? ""),
      name: String(row.name ?? ""),
      summary: row.summary ?? null,
      team_id: String(row.team_id ?? ""),
      agent_id: String(row.agent_id ?? ""),
      user_id: row.user_id ?? null,
      repo_url: row.repo_url ?? undefined,
      branch: row.branch ?? undefined,
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  createKnowledge(input: Omit<KnowledgeEntity, "created_at" | "updated_at">): KnowledgeEntity {
    const now = new Date().toISOString();
    // Upsert: if knowledge_id exists, update; else insert
    const existing = this.db.prepare("SELECT created_at FROM entity_knowledge WHERE knowledge_id = ?").get(input.knowledge_id) as any;
    if (existing) {
      this.db.prepare(
        "UPDATE entity_knowledge SET type=?, service_url=?, name=?, summary=?, team_id=?, agent_id=?, user_id=?, repo_url=?, branch=?, updated_at=? WHERE knowledge_id=?"
      ).run(input.type, input.service_url, input.name, input.summary ?? null, input.team_id, input.agent_id ?? "", input.user_id ?? null, input.repo_url ?? null, input.branch ?? null, now, input.knowledge_id);
      return this.getKnowledge(input.knowledge_id)!;
    }
    this.db.prepare(
      "INSERT INTO entity_knowledge (knowledge_id, type, service_url, name, summary, team_id, agent_id, user_id, repo_url, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(input.knowledge_id, input.type, input.service_url, input.name, input.summary ?? null, input.team_id, input.agent_id ?? "", input.user_id ?? null, input.repo_url ?? null, input.branch ?? null, now, now);
    return this.getKnowledge(input.knowledge_id)!;
  }

  getKnowledge(knowledgeId: string): KnowledgeEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_knowledge WHERE knowledge_id = ?").get(knowledgeId) as any;
    return row ? this.knowledgeFromRow(row) : null;
  }

  updateKnowledge(knowledgeId: string, patch: Partial<Pick<KnowledgeEntity, "name" | "summary" | "service_url" | "repo_url" | "branch">>): KnowledgeEntity | null {
    const current = this.getKnowledge(knowledgeId);
    if (!current) return null;
    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const args: SQLInputValue[] = [now];
    if (patch.name !== undefined) { sets.push("name = ?"); args.push(patch.name); }
    if (patch.summary !== undefined) { sets.push("summary = ?"); args.push(patch.summary); }
    if (patch.service_url !== undefined) { sets.push("service_url = ?"); args.push(patch.service_url); }
    if (patch.repo_url !== undefined) { sets.push("repo_url = ?"); args.push(patch.repo_url); }
    if (patch.branch !== undefined) { sets.push("branch = ?"); args.push(patch.branch); }
    args.push(knowledgeId);
    this.db.prepare(`UPDATE entity_knowledge SET ${sets.join(", ")} WHERE knowledge_id = ?`).run(...args);
    return this.getKnowledge(knowledgeId);
  }

  deleteKnowledge(knowledgeIds: string[], teamId?: string): BatchDeleteResult {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of knowledgeIds) {
      const row = this.getKnowledge(id);
      if (!row) { result.failed.push({ id, reason: "not_found" }); continue; }
      if (teamId && row.team_id !== teamId) { result.failed.push({ id, reason: "team_mismatch" }); continue; }
      this.db.prepare("DELETE FROM entity_knowledge WHERE knowledge_id = ?").run(id);
      result.deleted_ids.push(id);
    }
    return result;
  }

  listKnowledge(input: { team_id: string; type?: KnowledgeType; knowledge_ids?: string[]; limit?: number; offset?: number }): KnowledgeListResult {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 1000);
    const offset = Math.max(input.offset ?? 0, 0);
    // knowledge_ids 过滤（Proxy 按 id 批量联查明细）；空数组 → 空结果
    const ids = input.knowledge_ids;
    if (ids && ids.length === 0) return { items: [], total: 0 };
    const idClause = ids && ids.length > 0 ? ` AND knowledge_id IN (${ids.map(() => "?").join(",")})` : "";

    let sql = "SELECT * FROM entity_knowledge WHERE team_id = ?";
    const args: SQLInputValue[] = [input.team_id];
    if (input.type) { sql += " AND type = ?"; args.push(input.type); }
    if (idClause) { sql += idClause; args.push(...ids!); }
    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
    args.push(limit, offset);
    const rows = this.db.prepare(sql).all(...args) as any[];
    const items = rows.map((r) => this.knowledgeFromRow(r));

    let countSql = "SELECT COUNT(*) as total FROM entity_knowledge WHERE team_id = ?";
    const countArgs: SQLInputValue[] = [input.team_id];
    if (input.type) { countSql += " AND type = ?"; countArgs.push(input.type); }
    if (idClause) { countSql += idClause; countArgs.push(...ids!); }
    const totalRow = this.db.prepare(countSql).get(...countArgs) as any;
    return { items, total: totalRow?.total ?? 0 };
  }

  /**
   * FTS5 keyword search on L1 records.
   * Returns top-`limit` results sorted by BM25 relevance (highest first).
   *
   * @param ftsQuery  A pre-built FTS5 MATCH expression (from `buildFtsQuery()`).
   * @param limit     Maximum number of results to return.
   *
   * **Fault-tolerant**: returns an empty array on any error.
   */
  searchL1Fts(ftsQuery: string, limit = 20, filter?: IsolationFilter): FtsSearchResult[] {
    if (this.degraded || !this.ftsAvailable) return [];
    try {
      const retrieveLimit = filter ? Math.max(limit * 5, limit) : limit;
      const rows = this.stmtL1FtsSearch.all(ftsQuery, retrieveLimit) as Array<{
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
        metadata_json: string;
        // soul 8 列（P1-T7：SELECT 由 SOUL_SELECT_FRAGMENT 带出）
        occurred_at?: string | null;
        valid_start?: string | null;
        valid_end?: string | null;
        certainty?: string | null;
        source?: string | null;
        valence?: number | null;
        arousal?: number | null;
        significance?: number | null;
        rank: number;
      }>;

      return rows
        .filter((r) => rowMatchesIsolation(r, filter))
        .slice(0, limit)
        .map((r) => ({
          record_id: r.record_id,
          content: r.content,
          type: r.type,
          priority: r.priority,
          scene_name: r.scene_name,
          score: bm25RankToScore(r.rank),
          timestamp_str: r.timestamp_str,
          timestamp_start: r.timestamp_start,
          timestamp_end: r.timestamp_end,
          version: r.version ?? 0,
          session_key: r.session_key,
          session_id: r.session_id,
          team_id: r.team_id ?? "",
          task_id: r.task_id ?? "",
          user_id: r.user_id ?? "",
          agent_id: r.agent_id ?? "",
          metadata_json: r.metadata_json,
          // soul 8 字段（W1 兑现点：此前 FTS 行恒 undefined；NULL/缺省归一为 undefined，
          // 口径与 L1RecordRow 读回一致）
          occurred_at: r.occurred_at ?? undefined,
          valid_start: r.valid_start ?? undefined,
          valid_end: r.valid_end ?? undefined,
          certainty: r.certainty ?? undefined,
          source: r.source ?? undefined,
          valence: r.valence ?? undefined,
          arousal: r.arousal ?? undefined,
          significance: r.significance ?? undefined,
        }));
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-fts-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * FTS5 keyword search on L0 conversation messages.
   * Returns top-`limit` results sorted by BM25 relevance (highest first).
   *
   * @param ftsQuery  A pre-built FTS5 MATCH expression (from `buildFtsQuery()`).
   * @param limit     Maximum number of results to return.
   *
   * **Fault-tolerant**: returns an empty array on any error.
   */
  searchL0Fts(ftsQuery: string, limit = VectorStore.FTS_DEFAULT_LIMIT, filter?: IsolationFilter): L0FtsSearchResult[] {
    if (this.degraded || !this.ftsAvailable) return [];
    try {
      const retrieveLimit = filter ? Math.max(limit * 5, limit) : limit;
      const rows = this.stmtL0FtsSearch.all(ftsQuery, retrieveLimit) as Array<{
        record_id: string;
        message_text: string;
        session_key: string;
        session_id: string;
        team_id: string;
        task_id: string;
        user_id: string;
        agent_id: string;
        role: string;
        recorded_at: string;
        timestamp: number;
        rank: number;
      }>;

      return rows
        .filter((r) => rowMatchesIsolation(r, filter))
        .slice(0, limit)
        .map((r) => ({
          record_id: r.record_id,
          session_key: r.session_key,
          session_id: r.session_id,
          team_id: r.team_id ?? "",
          task_id: r.task_id ?? "",
          user_id: r.user_id ?? "",
          agent_id: r.agent_id ?? "",
          role: r.role,
          message_text: r.message_text,
          score: bm25RankToScore(r.rank),
          recorded_at: r.recorded_at,
          timestamp: r.timestamp ?? 0,
        }));
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-fts-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── FTS5 migration & rebuild ──────────────────────────────────────────────

  /**
   * P1-T7（W1）：旧 17 列 `l1_fts` → 25 列（补 soul 8 字段，全 UNINDEXED）。
   *
   * FTS5 virtual tables do NOT support `ALTER TABLE ADD COLUMN`，因此走事务内
   * 重建：建 `l1_fts_new`（25 列）→ 从旧表 17 列原样拷贝（content 列已是分词
   * 产物，不重切）并 LEFT JOIN l1_records 回填 soul → 行数校验（不一致
   * ROLLBACK + throw，不留半建表）→ DROP 旧表 → RENAME。
   *
   * 幂等：`PRAGMA table_info(l1_fts)` 已含 `occurred_at` → 跳过。
   * init() 在 prepare 25 列语句之前自动调用；也导出为独立迁移入口供手动脚本调用。
   *
   * @returns `migrated` 是否执行了重建；`rows` 迁移行数（跳过时为当前行数）。
   */
  migrateL1FtsSoul(): { migrated: boolean; rows: number } {
    const tableExists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='l1_fts'")
      .get();
    if (!tableExists) return { migrated: false, rows: 0 };

    const cols = this.db
      .prepare("SELECT name FROM pragma_table_info('l1_fts')")
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "sensitivity")) {
      // 已含全部 soul 列（D-3 后=26 列；含则跳过——幂等）
      const n = (this.db.prepare("SELECT COUNT(*) AS n FROM l1_fts").get() as { n: number }).n;
      return { migrated: false, rows: n };
    }

    const oldCount = (this.db.prepare("SELECT COUNT(*) AS n FROM l1_fts").get() as { n: number }).n;
    this.db.exec("BEGIN");
    try {
      // 自愈：上次迁移中途崩溃（进程被杀等）可能留下 l1_fts_new 半成品残留，
      // 直接重建会撞 "table l1_fts_new already exists" —— 同事务内先清残留。
      this.db.exec("DROP TABLE IF EXISTS l1_fts_new");
      this.db.exec(`
        CREATE VIRTUAL TABLE l1_fts_new USING fts5(
          ${L1_FTS_TABLE_DDL.join(",\n          ")}
        )
      `);
      // 17 基础列从旧表原样拷贝（content 已是分词产物）；soul 8 列从主表回填，
      // 主表缺行（理论不可能，FTS 与主表同事务写）时 soul 列为 NULL。
      this.db
        .prepare(`
          INSERT INTO l1_fts_new (${L1_FTS_ALL_COL_NAMES.join(", ")})
          SELECT old.${L1_FTS_BASE_COLUMN_DEFS.map((d) => d.split(" ")[0]).join(", old.")},
                 rec.${SOUL_COL_NAMES.join(", rec.")}
          FROM l1_fts AS old
          LEFT JOIN l1_records AS rec ON old.record_id = rec.record_id
        `)
        .run();
      const newCount = (this.db.prepare("SELECT COUNT(*) AS n FROM l1_fts_new").get() as { n: number }).n;
      if (newCount !== oldCount) {
        throw new Error(
          `${TAG} l1_fts soul migration row-count mismatch: old=${oldCount} new=${newCount} — rolling back`,
        );
      }
      this.db.exec("DROP TABLE l1_fts");
      this.db.exec("ALTER TABLE l1_fts_new RENAME TO l1_fts");
      this.db.exec("COMMIT");
      this.logger?.info(
        `${TAG} Migrated l1_fts 17 → 25 columns (soul backfilled from l1_records): ${newCount} rows`,
      );
      return { migrated: true, rows: newCount };
    } catch (err) {
      // 失败必须 ROLLBACK，不留半建表（旧 17 列表原样保留，可重试）
      try {
        this.db.exec("ROLLBACK");
      } catch { /* ignore rollback errors */ }
      this.logger?.warn(
        `${TAG} l1_fts soul migration FAILED (rolled back, FTS will degrade): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Detect old FTS5 v1 schema (no `content_original` column) and drop the
   * tables so they can be recreated with the v2 schema.
   *
   * FTS5 virtual tables do NOT support `ALTER TABLE ADD COLUMN`, so the only
   * migration path is DROP + recreate + repopulate.
   *
   * @returns `true` if migration was performed (= FTS index needs rebuilding).
   * @internal
   */
  private migrateFtsTablesIfNeeded(): boolean {
    try {
      // Check if l1_fts exists at all
      const l1Exists = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='l1_fts'")
        .get();
      if (!l1Exists) {
        // Fresh install — tables will be created with v2 schema.
        // Still need rebuild if there's existing data in l1_records.
        const hasData = this.db.prepare("SELECT 1 FROM l1_records LIMIT 1").get();
        return !!hasData;
      }

      // Check if the v2 column `content_original` exists.
      // FTS5 tables appear in pragma_table_info with their column names.
      const cols = this.db
        .prepare("SELECT name FROM pragma_table_info('l1_fts')")
        .all() as Array<{ name: string }>;
      const hasV2Col = cols.some((c) => c.name === "content_original");
      // v3 marker: isolation columns added (user_id / agent_id).
      const hasV3Col = cols.some((c) => c.name === "user_id")
        && cols.some((c) => c.name === "agent_id");
      const hasV4Col = cols.some((c) => c.name === "version");
      const hasV5Col = cols.some((c) => c.name === "task_id");

      if (hasV2Col && hasV3Col && hasV4Col && hasV5Col) {
        return false; // Already current — no migration needed
      }

      // Migrate forward. FTS5 has no ALTER ADD COLUMN, so any forward step
      // means DROP both FTS tables and rely on rebuildFtsIndex() to repopulate
      // from l0_conversations / l1_records (which now carry user_id/agent_id
      // after the L0/L1 schema migration above).
      if (!hasV2Col) {
        this.logger?.info(`${TAG} Migrating FTS5 tables v1 → v3 (jieba + tenancy isolation)`);
      } else if (!hasV3Col) {
        this.logger?.info(`${TAG} Migrating FTS5 tables v2 → v3 (add user_id / agent_id columns)`);
      } else if (!hasV4Col) {
        this.logger?.info(`${TAG} Migrating FTS5 tables v3 → v4 (add version column)`);
      } else if (!hasV5Col) {
        this.logger?.info(`${TAG} Migrating FTS5 tables v4 → v5 (add task_id column)`);
      }
      this.db.exec("DROP TABLE IF EXISTS l1_fts");
      this.db.exec("DROP TABLE IF EXISTS l0_fts");
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} FTS migration check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Rebuild the FTS5 index from scratch by reading all records from the
   * metadata tables and re-inserting them with jieba-segmented text.
   *
   * Called automatically after:
   *  - Schema migration from v1 to v2
   *  - Fresh table creation when existing data exists
   *
   * Safe to call multiple times (idempotent — clears FTS tables first).
   */
  rebuildFtsIndex(): void {
    if (!this.ftsAvailable) return;

    try {
      this.logger?.info(`${TAG} Rebuilding FTS5 index with jieba segmentation…`);

      // ── Rebuild L1 FTS ──
      // Clear existing FTS data
      this.db.exec("DELETE FROM l1_fts");

      // Read all L1 records from metadata table.
      // Include user_id / agent_id so the rebuilt FTS rows carry isolation info.
      const l1Rows = this.db
        .prepare(`
          SELECT record_id, content, type, priority, scene_name,
                 session_key, session_id, team_id, task_id, user_id, agent_id, version,
                 timestamp_str, timestamp_start, timestamp_end, metadata_json,
                 ${SOUL_SELECT_FRAGMENT}
          FROM l1_records
        `)
        .all() as Array<{
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
          metadata_json: string;
          occurred_at?: string;
          valid_start?: string;
          valid_end?: string;
          certainty?: string;
          source?: string;
          valence?: number | null;
          arousal?: number | null;
          significance?: number | null;
        }>;

      let l1Count = 0;
      for (const r of l1Rows) {
        try {
          this.stmtL1FtsInsert.run(
            tokenizeForFts(r.content),  // content — segmented
            r.content,                   // content_original — raw
            r.record_id,
            r.type,
            r.priority,
            r.scene_name,
            r.session_key,
            r.session_id || DEFAULT_ISOLATION_ID,
            r.team_id || "",
            r.task_id || "",
            r.user_id || DEFAULT_ISOLATION_ID,
            r.agent_id || DEFAULT_ISOLATION_ID,
            r.version ?? 0,
            r.timestamp_str,
            r.timestamp_start,
            r.timestamp_end,
            r.metadata_json,
            // soul 8 字段（P1-T7）：与写入侧同源取值
            ...soulBindValues(r as unknown as Record<string, unknown>),
          );
          l1Count++;
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} FTS rebuild skip L1 ${r.record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // ── Rebuild L0 FTS ──
      this.db.exec("DELETE FROM l0_fts");

      const l0Rows = this.db
        .prepare(`
          SELECT record_id, message_text, session_key, session_id, team_id, task_id, user_id, agent_id,
                 role, recorded_at, timestamp
          FROM l0_conversations
        `)
        .all() as Array<{
          record_id: string;
          message_text: string;
          session_key: string;
          session_id: string;
          team_id: string;
          task_id: string;
          user_id: string;
          agent_id: string;
          role: string;
          recorded_at: string;
          timestamp: number;
        }>;

      let l0Count = 0;
      for (const r of l0Rows) {
        try {
          this.stmtL0FtsInsert.run(
            tokenizeForFts(r.message_text),  // message_text — segmented
            r.message_text,                   // message_text_original — raw
            r.record_id,
            r.session_key,
            r.session_id,
            r.team_id ?? "",
            r.task_id ?? "",
            r.user_id ?? "",
            r.agent_id ?? "",
            r.role,
            r.recorded_at,
            r.timestamp,
          );
          l0Count++;
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} FTS rebuild skip L0 ${r.record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.logger?.info(
        `${TAG} FTS5 rebuild complete: L1=${l1Count}/${l1Rows.length}, L0=${l0Count}/${l0Rows.length}`,
      );
    } catch (err) {
      this.logger?.warn(
        `${TAG} FTS5 rebuild failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ============================
  // IMemoryStore interface implementation
  // ============================

  /** Query the store's search capabilities. */
  getCapabilities(): StoreCapabilities {
    return {
      vectorSearch: this.vecTablesReady,
      ftsSearch: this.ftsAvailable,
      nativeHybridSearch: false,
      sparseVectors: false,
    };
  }

  // ─────────────────────────────────────────────────────────
  // Memory Audit (修改审计)
  // ─────────────────────────────────────────────────────────

  appendAudit(entry: AuditEntry): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_audit
        (audit_id, record_id, layer, action,
         team_id, agent_id, user_id, task_id,
         version, updated_at_ms, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.audit_id,
      entry.record_id,
      entry.layer,
      entry.action,
      entry.team_id ?? null,
      entry.agent_id ?? null,
      entry.user_id ?? null,
      entry.task_id ?? null,
      entry.version,
      entry.updated_at_ms,
      entry.request_id ?? null,
    );
  }

  queryAudit(filter: AuditQueryFilter): AuditEntry[] {
    const conds: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.record_id !== undefined) { conds.push("record_id = ?"); args.push(filter.record_id); }
    if (filter.layer !== undefined)     { conds.push("layer = ?");     args.push(filter.layer); }
    if (filter.action !== undefined)    { conds.push("action = ?");    args.push(filter.action); }
    if (filter.team_id !== undefined)   { conds.push("team_id = ?");   args.push(filter.team_id); }
    if (filter.agent_id !== undefined)  { conds.push("agent_id = ?");  args.push(filter.agent_id); }
    if (filter.user_id !== undefined)   { conds.push("user_id = ?");   args.push(filter.user_id); }
    if (filter.task_id !== undefined)   { conds.push("task_id = ?");   args.push(filter.task_id); }
    if (filter.since_ms !== undefined)  { conds.push("updated_at_ms >= ?"); args.push(filter.since_ms); }
    if (filter.until_ms !== undefined)  { conds.push("updated_at_ms <= ?"); args.push(filter.until_ms); }

    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const offset = Math.max(filter.offset ?? 0, 0);

    const sql = `
      SELECT audit_id, record_id, layer, action,
             team_id, agent_id, user_id, task_id,
             version, updated_at_ms, request_id
      FROM memory_audit
      ${where}
      ORDER BY updated_at_ms DESC, audit_id DESC
      LIMIT ? OFFSET ?
    `;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...args, limit, offset) as Array<{
      audit_id: string;
      record_id: string;
      layer: "L1" | "L2" | "L3";
      action: "update" | "delete";
      team_id: string | null;
      agent_id: string | null;
      user_id: string | null;
      task_id: string | null;
      version: number;
      updated_at_ms: number;
      request_id: string | null;
    }>;
    return rows.map((r) => ({
      audit_id: r.audit_id,
      record_id: r.record_id,
      layer: r.layer,
      action: r.action,
      team_id: r.team_id ?? undefined,
      agent_id: r.agent_id ?? undefined,
      user_id: r.user_id ?? undefined,
      task_id: r.task_id ?? undefined,
      version: r.version,
      updated_at_ms: r.updated_at_ms,
      request_id: r.request_id ?? undefined,
    }));
  }

  // ─────────────────────────────────────────────────────────
  // Memory Generation Provenance References
  // ─────────────────────────────────────────────────────────

  upsertMemoryGenerationRefs(records: MemoryGenerationRefRecord[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO memory_generation_refs
        (generation_ref_id, layer, memory_id, generation_id, generation_log_id,
         generation_log_key, memory_prompt_id, memory_prompt_version,
         memory_prompt_source, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_ref_id) DO UPDATE SET
        memory_id=excluded.memory_id,
        generation_id=excluded.generation_id,
        generation_log_id=excluded.generation_log_id,
        generation_log_key=excluded.generation_log_key,
        memory_prompt_id=excluded.memory_prompt_id,
        memory_prompt_version=excluded.memory_prompt_version,
        memory_prompt_source=excluded.memory_prompt_source,
        created_at_ms=excluded.created_at_ms
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        stmt.run(
          record.generation_ref_id, record.layer, record.memory_id,
          record.generation_id, record.generation_log_id, record.generation_log_key,
          record.memory_prompt_id, record.memory_prompt_version,
          record.memory_prompt_source, record.created_at_ms,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getMemoryGenerationRef(layer: MemoryGenerationLayer, memoryId: string): MemoryGenerationRefRecord | null {
    const id = buildMemoryGenerationRefId(layer, memoryId);
    return (this.db.prepare(
      "SELECT * FROM memory_generation_refs WHERE generation_ref_id = ? AND layer = ? AND memory_id = ?",
    ).get(id, layer, memoryId) as unknown as MemoryGenerationRefRecord | undefined) ?? null;
  }

  // ─────────────────────────────────────────────────────────
  // Custom Memory Prompt
  // ─────────────────────────────────────────────────────────

  countMemoryPrompts(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM memory_prompts").get() as { total: number };
    return Number(row?.total ?? 0);
  }

  createMemoryPrompt(record: MemoryPromptRecord): MemoryPromptRecord {
    this.db.prepare(`
      INSERT INTO memory_prompts
        (memory_prompt_id, name, layer, prompt, version, status,
         created_by, updated_by, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.memory_prompt_id, record.name, record.layer, record.prompt,
      record.version, record.status, record.created_by ?? null,
      record.updated_by ?? null, record.created_at_ms, record.updated_at_ms,
    );
    return record;
  }

  getMemoryPrompts(ids: string[]): MemoryPromptRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT * FROM memory_prompts WHERE memory_prompt_id IN (${placeholders})`,
    ).all(...ids) as unknown as MemoryPromptRecord[];
  }

  listMemoryPrompts(filter: MemoryPromptListFilter): MemoryPromptRecord[] {
    const conds = ["status = 'active'"];
    const args: SQLInputValue[] = [];
    if (filter.layer) { conds.push("layer = ?"); args.push(filter.layer); }
    const order = filter.timeOrder === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.db.prepare(`
      SELECT * FROM memory_prompts
      WHERE ${conds.join(" AND ")}
      ORDER BY updated_at_ms ${order}, memory_prompt_id ${order}
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset) as unknown as MemoryPromptRecord[];
  }

  updateMemoryPrompt(
    id: string,
    patch: { name?: string; prompt?: string; updated_by?: string; updated_at_ms: number },
  ): MemoryPromptRecord | null {
    const current = this.getMemoryPrompts([id])[0];
    if (!current || current.status !== "active") return null;
    const sameName = patch.name === undefined || patch.name === current.name;
    const samePrompt = patch.prompt === undefined || patch.prompt === current.prompt;
    if (sameName && samePrompt) return current;

    const sets = ["version = version + 1", "updated_at_ms = ?", "updated_by = ?"];
    const args: SQLInputValue[] = [patch.updated_at_ms, patch.updated_by ?? null];
    if (patch.name !== undefined) { sets.push("name = ?"); args.push(patch.name); }
    if (patch.prompt !== undefined) { sets.push("prompt = ?"); args.push(patch.prompt); }
    args.push(id);
    const result = this.db.prepare(
      `UPDATE memory_prompts SET ${sets.join(", ")} WHERE memory_prompt_id = ? AND status = 'active'`,
    ).run(...args);
    if (Number(result.changes ?? 0) === 0) return null;
    return this.getMemoryPrompts([id])[0] ?? null;
  }

  getMemoryPromptSettings(ids: string[]): MemoryPromptSettingRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT * FROM memory_prompt_settings WHERE setting_id IN (${placeholders})`,
    ).all(...ids) as unknown as MemoryPromptSettingRecord[];
  }

  listMemoryPromptSettings(filter: MemoryPromptSettingListFilter): MemoryPromptSettingRecord[] {
    const conds: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.memoryPromptId) { conds.push("memory_prompt_id = ?"); args.push(filter.memoryPromptId); }
    if (filter.targetType) { conds.push("target_type = ?"); args.push(filter.targetType); }
    if (filter.teamId) { conds.push("team_id = ?"); args.push(filter.teamId); }
    if (filter.agentId) { conds.push("agent_id = ?"); args.push(filter.agentId); }
    if (filter.layer) { conds.push("layer = ?"); args.push(filter.layer); }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const order = filter.timeOrder === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.db.prepare(`
      SELECT * FROM memory_prompt_settings ${where}
      ORDER BY updated_at_ms ${order}, setting_id ${order}
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset) as unknown as MemoryPromptSettingRecord[];
  }

  upsertMemoryPromptSettings(
    records: MemoryPromptSettingRecord[],
    logs: MemoryPromptSettingLogRecord[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const upsert = this.db.prepare(`
        INSERT INTO memory_prompt_settings
          (setting_id, target_type, team_id, agent_id, layer, memory_prompt_id, updated_by, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(setting_id) DO UPDATE SET
          target_type=excluded.target_type, team_id=excluded.team_id,
          agent_id=excluded.agent_id, layer=excluded.layer,
          memory_prompt_id=excluded.memory_prompt_id, updated_by=excluded.updated_by,
          updated_at_ms=excluded.updated_at_ms
      `);
      for (const record of records) {
        upsert.run(
          record.setting_id, record.target_type, record.team_id ?? null,
          record.agent_id ?? null, record.layer, record.memory_prompt_id,
          record.updated_by ?? null, record.updated_at_ms,
        );
      }
      this.insertMemoryPromptSettingLogs(logs);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  clearMemoryPromptSettings(ids: string[], logs: MemoryPromptSettingLogRecord[]): void {
    if (ids.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const del = this.db.prepare("DELETE FROM memory_prompt_settings WHERE setting_id = ?");
      for (const id of ids) del.run(id);
      this.insertMemoryPromptSettingLogs(logs);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private insertMemoryPromptSettingLogs(logs: MemoryPromptSettingLogRecord[]): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO memory_prompt_setting_logs
        (setting_log_id, target_type, team_id, agent_id, layer, action, reason,
         before_memory_prompt_id, after_memory_prompt_id, operator_id, operated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const log of logs) {
      insert.run(
        log.setting_log_id, log.target_type, log.team_id ?? null,
        log.agent_id ?? null, log.layer, log.action, log.reason,
        log.before_memory_prompt_id ?? null, log.after_memory_prompt_id ?? null,
        log.operator_id ?? null, log.operated_at_ms,
      );
    }
  }

  deleteMemoryPrompts(ids: string[], operatorId?: string): {
    deleted_prompt_ids: string[];
    cleared_settings: Record<MemoryPromptTargetType, number>;
  } {
    const prompts = this.getMemoryPrompts(ids);
    if (prompts.length !== ids.length) return { deleted_prompt_ids: [], cleared_settings: { instance: 0, team: 0, agent: 0 } };
    const cleared: Record<MemoryPromptTargetType, number> = { instance: 0, team: 0, agent: 0 };
    const placeholders = ids.map(() => "?").join(",");
    const settings = this.db.prepare(
      `SELECT * FROM memory_prompt_settings WHERE memory_prompt_id IN (${placeholders})`,
    ).all(...ids) as unknown as MemoryPromptSettingRecord[];
    const now = Date.now();
    const logs: MemoryPromptSettingLogRecord[] = settings.map((setting) => {
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

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE memory_prompts SET status = 'deleting' WHERE memory_prompt_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM memory_prompt_settings WHERE memory_prompt_id IN (${placeholders})`).run(...ids);
      this.insertMemoryPromptSettingLogs(logs);
      this.db.prepare(`DELETE FROM memory_prompts WHERE memory_prompt_id IN (${placeholders})`).run(...ids);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { deleted_prompt_ids: ids, cleared_settings: cleared };
  }

  queryMemoryPromptSettingLogs(filter: MemoryPromptSettingLogFilter): MemoryPromptSettingLogRecord[] {
    const conds: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.memoryPromptId) {
      conds.push("(before_memory_prompt_id = ? OR after_memory_prompt_id = ?)");
      args.push(filter.memoryPromptId, filter.memoryPromptId);
    }
    if (filter.teamId) { conds.push("team_id = ?"); args.push(filter.teamId); }
    if (filter.agentId) { conds.push("agent_id = ?"); args.push(filter.agentId); }
    if (filter.action) { conds.push("action = ?"); args.push(filter.action); }
    if (filter.startTimeMs !== undefined) { conds.push("operated_at_ms >= ?"); args.push(filter.startTimeMs); }
    if (filter.endTimeMs !== undefined) { conds.push("operated_at_ms <= ?"); args.push(filter.endTimeMs); }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const order = filter.timeOrder === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.db.prepare(`
      SELECT * FROM memory_prompt_setting_logs ${where}
      ORDER BY operated_at_ms ${order}, setting_log_id ${order}
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset) as unknown as MemoryPromptSettingLogRecord[];
  }

  /**
   * Close the database connection.
   * Should be called on shutdown. Idempotent — safe to call multiple times.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} Error closing database: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
