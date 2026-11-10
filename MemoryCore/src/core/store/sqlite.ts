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
// 读侧归一化与 l1-reader.rowToMemoryRecord 共用同一实现（空串/NULL/脏 JSON 口径一致）。
import { optionalNumber, optionalText, parseSourceMessageIds } from "./l1-column-coerce.js";
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
  L0ByIdsFilter,
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
  SoulEventParityDiff,
  SoulEventParityReport,
} from "./types.js";
import {
  DEFAULT_ISOLATION_ID,
  LINK_TYPES,
  normalizeCoreTenant,
  rowMatchesIsolation,
  type CoreTenant,
  type SoulSnapshotRow,
  type SoulPersonRelationRow,
  type SoulPersonRelationBackfillResult,
  type SoulPersonRelationProvisionResult,
  type SoulEpisodeProvisionResult,
  type PromiseTransitionSource,
  type SoulPromiseEvent,
  type SoulPromiseRecord,
  type SoulPromiseStatus,
  type LinkType,
} from "./types.js";
import { buildIsolationWhere } from "./isolation.js";
import { normalizeTaskSourceType } from "./task-source-type.js";
import { SOUL_COLUMNS, SOUL_COL_NAMES, SOUL_SELECT_FRAGMENT, type SoulColumnName } from "./soul-columns.js";
import { SKILLS_DDL, SKILL_FTS_DDL } from "../skill/skill-store-ddl.js";
import { canTransitionPromise } from "../hooks/soul-promise.js";
import { SOUL_EPISODE_KINDS, SOUL_LAYERS } from "../soul/types.js";
import { SOUL_PERSON_DDL, SOUL_PERSON_MIGRATION_DDL } from "./soul-person-ddl.js";
// P0-C：事件底座（soul_events）的 DDL 与读写都只从 P0-A/P0-B 的单一事实源来，禁止在本文件手抄列名。
// DDL 常量与 P0-D 迁移脚本共用同一份；读写函数不 BEGIN（调用方持有事务），见 upsertSoulEventInTransaction。
import {
  SOUL_EVENT_DDL,
  SOUL_EVENT_MIGRATION_DDL,
  SOUL_NARRATIVE_ACTIVE_PERIOD_UNIQUE_INDEX_DDL,
} from "./soul-event-ddl.js";
// P6 §4.8：叙事的读写收口在 soul-narrative-store.ts；本文件只委派 + 降级（读空、写失败不阻断 tick）。
import {
  commitSoulNarrativeChapter as commitSoulNarrativeChapterImpl,
  getSoulNarrativeChapter as getSoulNarrativeChapterRow,
  listSoulNarrativeChapters as listSoulNarrativeChapterRows,
  listSoulNarrativeEvidenceRows,
  touchSoulNarrativeAccess as touchSoulNarrativeAccessImpl,
  type SoulNarrativeCommitInput,
  type SoulNarrativeCommitResult,
  type SoulNarrativeListFilter,
} from "./soul-narrative-store.js";
import {
  composeSoulEventDedupeKey,
  deleteSoulEventInTransaction,
  findSoulEventIdByDedupeKey,
  getSoulEventDetail as getSoulEventDetailRow,
  insertSoulEvent,
  listSoulEventEvidence,
  listSoulEvents as listSoulEventRows,
  listSoulPrivateEventQuotes,
  upsertSoulEventInTransaction,
  upsertSoulEventReflection as upsertSoulEventReflectionRow,
  type SoulEventDetail,
  type SoulEventListFilter,
  type SoulEventWrite,
  type SoulPrivateQuoteRow,
} from "./soul-event-store.js";
// P1-A：一条消息 → 根事件 + 行动子事件。切分是纯函数，写库仍由本文件的事务负责。
import { splitChatActionEvents, type SoulActionSourceMessage } from "../soul/event-splitter.js";
// P6 / t20：老库 episode 没有对应事件时，按引文在 L0 唯一命中补一条 chat 事件（与关系线同一套确定性判定）。
import { EPISODE_PROVISION_MAX_PER_TICK } from "../soul/episode-provision.js";
// P2 §4.4：关系状态层（soul_person_state / soul_person_state_events）的读写同样是纯 store 函数，
// 本文件只做实例方法委派，不手抄第二份 SQL。
import {
  getSoulPersonState as getSoulPersonStateRow,
  insertSoulPersonStateEvents as insertSoulPersonStateEventRows,
  listSoulPersonStateEvents as listSoulPersonStateEventRows,
  listSoulPersonStates as listSoulPersonStateRows,
  upsertSoulPersonState as upsertSoulPersonStateRow,
} from "./soul-person-state-store.js";
// P3 §4.5：目标层（soul_goals / goal_events / goal_deps）与 working 锚同样是纯 store 函数，
// 本文件只做实例委派——目标状态机的规则不许在 SQL 层与派生层各写一份。
import {
  clearSoulWorkingState as clearSoulWorkingStateRow,
  getSoulGoal as getSoulGoalRow,
  getSoulWorkingState as getSoulWorkingStateRow,
  insertSoulGoalDep as insertSoulGoalDepRow,
  insertSoulGoalEvents as insertSoulGoalEventRows,
  listSoulGoalDeps as listSoulGoalDepRows,
  listSoulGoalEvents as listSoulGoalEventRows,
  listSoulGoals as listSoulGoalRows,
  transitionSoulGoal as transitionSoulGoalRow,
  upsertSoulGoal as upsertSoulGoalRow,
  upsertSoulWorkingState as upsertSoulWorkingStateRow,
  type GoalTransitionOptions,
  type GoalTransitionResult,
} from "./soul-goal-store.js";
import {
  commitSoulMoodEvents as commitSoulMoodEventsImpl,
  getSoulMoodState,
  listSoulMoodEvents as listSoulMoodEventsImpl,
  upsertSoulMoodState,
} from "./soul-mood-store.js";
// P7 §4.9：价值（soul_values）、红线审计（soul_gate_log）、两难（soul_dilemma）的读写收口在
// soul-value-store.ts；判定本身在 core/soul/value-gate.ts，SQL 里不许再写一份「什么算命中」。
import {
  insertSoulDilemma as insertSoulDilemmaRow,
  insertSoulGateLog as insertSoulGateLogRows,
  listSoulDilemmas as listSoulDilemmaRows,
  listSoulGateLog as listSoulGateLogRows,
  listSoulValues as listSoulValueRows,
  retireSoulValue as retireSoulValueRow,
  reviewSoulDilemma as reviewSoulDilemmaRow,
  summarizeSoulGateLog as summarizeSoulGateLogRows,
  upsertSoulValue as upsertSoulValueRow,
  type SoulGateLogStats,
  type SoulGateRuleStat,
} from "./soul-value-store.js";
// P4 §4.6：自我模型（soul_self_model）与校准（soul_calibration）同样是纯 store 函数，
// 本文件只做实例方法委派与错误降级——「什么算一次没成、误差怎么算」不许在 SQL 层再写一份。
import {
  commitSoulCalibration as commitSoulCalibrationImpl,
  getSoulSelfModel as getSoulSelfModelRow,
  listSoulCalibration as listSoulCalibrationRows,
  listSoulSelfModel as listSoulSelfModelRows,
  upsertSoulSelfModel as upsertSoulSelfModelRow,
} from "./soul-self-store.js";
import type {
  SoulEventChatInsert,
  SoulEventEvidenceInsert,
  SoulEventInsert,
  SoulEventRow,
  SoulPersonStateEventInsert,
  SoulPersonStateEventRow,
  SoulPersonStateInsert,
  SoulPersonStateRow,
  SoulGoalDepInsert,
  SoulGoalDepRow,
  SoulGoalEventInsert,
  SoulGoalEventRow,
  SoulGoalInsert,
  SoulGoalRow,
  SoulGoalStatus,
  SoulWorkingStateRow,
  SoulWorkingStateUpsert,
  SoulMoodEventInsert,
  SoulMoodEventRow,
  SoulMoodStateInsert,
  SoulMoodStateRow,
  SoulCalibrationInsert,
  SoulCalibrationRow,
  SoulEventReflectionInsert,
  SoulSelfModelInsert,
  SoulSelfModelRow,
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
import { SOUL_AXES, axisVectorToArray, emptyAxisVector, toAxisVector, type AxisVector } from "../soul/traits.js";
import type { TraitLabelRow } from "../soul/trait-drift.js";
import type {
  PersonaItem,
  SoulEmotionRecord,
  SoulEpisode,
  SoulEpisodeQuote,
  SoulGateStat,
  SoulGateStatBump,
  SoulLedgerEntry,
  SoulRejectionStat,
  SoulLayer,
} from "../soul/types.js";
import type { Logger } from "../types.js";
import type { SoulPerson, SoulPersonUpsert } from "../person/types.js";
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

/** l1_fts 基础 16 列 DDL（soul 列之前的固定部分；content 是唯一全文索引主列）。
 *  ADR-0025 C3（2026-11-04）：原 `timestamp_start` 列已删——与 timestamp_str 4225/4225 逐位相等，
 *  保留它等于给同一事实存两份副本（读侧还各自 fallback，制造了两个可能不一致的"创建时间"）。 */
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
  "timestamp_end UNINDEXED",
  "metadata_json UNINDEXED",
] as const;

/** soul 8 列 DDL 片段：`name ftsSuffix`（ftsSuffix=UNINDEXED —— soul 是过滤元数据不参与全文索引） */
const L1_FTS_SOUL_COLUMN_DEFS = SOUL_COLUMNS.map((c) => `${c.name} ${c.ftsSuffix}`);

/** l1_fts 建表列定义（25 列 = 基础 16 + soul 9） */
const L1_FTS_TABLE_DDL = [...L1_FTS_BASE_COLUMN_DEFS, ...L1_FTS_SOUL_COLUMN_DEFS];

/** l1_fts 全部列名（25 个，INSERT 列清单/迁移共用；顺序与建表一致） */
const L1_FTS_ALL_COL_NAMES = [...L1_FTS_BASE_COLUMN_DEFS.map((d) => d.split(" ")[0]), ...SOUL_COL_NAMES];

/** soul 9 字段（ADR-0025 C2 删 source 后）写入缺省值（与 l1_records 建表默认一致；主表/FTS/restore 共用）。
 *  P1-T7：importance 缺省 null = 未评分 = 召回面永不降权（宁缺毋滥，不伪造默认分）。 */
const SOUL_FIELD_DEFAULTS: Record<SoulColumnName, string | number | null> = {
  occurred_at: "",
  valid_start: "",
  valid_end: "",
  certainty: "observed",
  valence: null,
  arousal: null,
  significance: null,
  sensitivity: "none",
  importance: null,
};

/**
 * soul 9 字段绑定值（单一取值源）：主表 stmtUpsertMeta / FTS stmtL1FtsInsert /
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
  /** @deprecated ADR-0025 C3（2026-11-04）：列已删，映射为 timestamp_str 的派生副本
   *  （历史值 4225/4225 逐位相等）。对外 created_at 口径不变；新代码请直接用 timestamp_str。 */
  timestamp_start: string;
  timestamp_end: string;
  version: number;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  /**
   * B 项（ADR-0025 决定 9，2026-11-04）：行最近更新时间（l1_records.updated_time）。
   * 与 timestamp_end（事件结束时刻）语义不同；消费方 updated_at 取本列。
   */
  updated_time?: string;
  /** Raw metadata JSON string (e.g., contains activity_start_time / activity_end_time for episodic) */
  metadata_json: string;
  // soul 9 字段 + 溯源列（P0-1，2026-11-04）：向量路此前只声明 16 个基础字段，
  // searchL1Vector 的 push 已塞入 soul 值 → 类型漂移（TS2353）且消费方拿不到 sensitivity。
  // 列口径以 soul-columns.ts SOUL_COL_NAMES 为单一事实源。
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
  /** D-3 敏感注入门的判定输入（health/finance/relationship → 仅私有上下文注入）。 */
  sensitivity?: string;
  /** P1-T7：importance 1-10（null=未评分=不罚）。 */
  importance?: number | null;
  /** 溯源：该行由哪些 L0 消息蒸馏而来（原 source 列删除后的唯一溯源字段）。 */
  source_message_ids?: string[];
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
  /** #83 入口单点定源：行级分类标签（存量行=unclassified） */
  classification?: string;
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
  "的",
  "了",
  "在",
  "是",
  "我",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "一个",
  "上",
  "也",
  "很",
  "到",
  "说",
  "要",
  "去",
  "你",
  "会",
  "着",
  "没有",
  "看",
  "好",
  "自己",
  "这",
  "他",
  "她",
  "它",
  "们",
  "那",
  "吗",
  "吧",
  "呢",
  "啊",
  "呀",
  "哦",
  "嗯",
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
 * Whether the jieba singleton is currently loaded with a real instance
 * (i.e. the require + dict load has succeeded and been cached).
 * Exported for testing only (#68 S0 boot-warmup preload contract: after a
 * listen-time `tokenizeForFts` preload, later `buildFtsQuery` calls must
 * consult the cached singleton instead of re-initialising).
 * @internal
 */
export function _isJiebaLoadedForTest(): boolean {
  return _jieba !== undefined && _jieba !== null;
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
  /** R71-A1（2026-10-19）：FTS5 raw rank（负=更相关）；L1 行透传（L0 行不透传）。 */
  rank?: number;
  timestamp_str: string;
  /** @deprecated ADR-0025 C3（2026-11-04）：列已删，映射为 timestamp_str（派生副本）。 */
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
  /**
   * B 项（ADR-0025 决定 9，2026-11-04）：行最近更新时间。l1_fts 表**不存**该列——检索
   * SELECT 与 source_message_ids 同款走相关子查询从 l1_records 带出。
   */
  updated_time?: string;
  // soul 9 字段（P1-T7 / W1）：列名以 soul-columns.ts SOUL_COL_NAMES 为单一事实源（ADR-0025 C2 删 source），
  // 列清单/建表/绑定值均由其展开；此处为类型声明（类型无法由字符串数组推导），
  // 类型口径与 L1RecordRow 的 soul 字段一致。新增字段：先改 soul-columns.ts，这里会漏 → verify-p1-t7 断言组 2 红。
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  /** @deprecated ADR-0025 C2（2026-11-04）：source 列已删，运行时恒 undefined；字段仅为兼容旧
   *  取值方保留。新代码用 source_message_ids 溯源。 */
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
  /** P1-T7：importance 1-10（null=未评分=不罚）。 */
  importance?: number | null;
  /** D-3 敏感注入门的判定输入（P0-1，2026-11-04）：此前读投影漏掉该列。 */
  sensitivity?: string;
  /** 溯源（P0-1）：l1_fts 不存该列，检索 SELECT 用相关子查询回 l1_records 取。 */
  source_message_ids?: string[];
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
  private stmtDeleteVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtInsertVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtDeleteMeta!: StatementSync;
  private stmtGetMeta!: StatementSync;
  private stmtSearchVec?: StatementSync; // optional — only set when vecTablesReady
  // #137 W1/C：事实键平行向量通道（l1_fact_vec）——独立 vec0 表，与 l1_vec 同维同度量；
  // 主索引 l1_vec 完全不动。老三件套（delete/insert/search）同样只在 vecTablesReady 时绑定。
  private stmtDeleteFactVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtInsertFactVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtSearchFactVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtQueryBySessionId!: StatementSync;
  private stmtQueryBySessionIdSince!: StatementSync;
  private stmtQueryBySessionKey!: StatementSync;
  private stmtQueryBySessionKeySince!: StatementSync;
  private stmtQueryAll!: StatementSync;
  private stmtQueryAllSince!: StatementSync;

  // Prepared statements — L0 (initialized in init())
  private stmtL0UpsertMeta!: StatementSync;
  private stmtL0DeleteVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtL0InsertVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtL0DeleteMeta!: StatementSync;
  private stmtL0GetMeta!: StatementSync;
  private stmtL0SearchVec?: StatementSync; // optional — only set when vecTablesReady
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

  // S8：core_values 已删除（原 R-A3 listValues 租户级缓存一并移除）。

  // Prepared statements — FTS5 L1 (initialized in init())
  private stmtL1FtsInsert!: StatementSync;
  private stmtL1FtsDelete!: StatementSync;
  private stmtL1FtsSearch!: StatementSync;
  /** 类型收窄版（2026-11-03）：结论层候选只要 work_fact，先过滤再 LIMIT。 */
  private stmtL1FtsSearchByType?: StatementSync;

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
      this.logger?.error(`${TAG} Schema initialization failed: ${message}. ` + `VectorStore entering degraded mode.`);
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
            `${TAG} Embedding config changed (${reindexReason}). ` + `Dropping vector tables for rebuild...`,
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
        -- ADR-0025 C3（2026-11-04）：timestamp_start 已删（恒等于 timestamp_str，见幂等 DROP COLUMN 段）
        timestamp_str TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}',
        -- 原话溯源（行级）：JSON 数组文本，缺省 '[]'（老库幂等 ALTER 见下）
        source_message_ids TEXT NOT NULL DEFAULT '[]'
      )
    `);

    // Online migration: pre-isolation DBs lack user_id/agent_id columns. ALTER ADD is
    // idempotent-safe: a try/catch around each statement is the SQLite-3 standard idiom.
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN team_id TEXT DEFAULT 'default'");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN task_id TEXT DEFAULT ''");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* exists */
    }
    this.db
      .prepare("UPDATE l1_records SET team_id = ? WHERE team_id = '' OR team_id IS NULL")
      .run(DEFAULT_ISOLATION_ID);
    this.db
      .prepare("UPDATE l1_records SET user_id = ? WHERE user_id = '' OR user_id IS NULL")
      .run(DEFAULT_ISOLATION_ID);
    this.db
      .prepare("UPDATE l1_records SET agent_id = ? WHERE agent_id = '' OR agent_id IS NULL")
      .run(DEFAULT_ISOLATION_ID);
    this.db
      .prepare("UPDATE l1_records SET session_id = ? WHERE session_id = '' OR session_id IS NULL")
      .run(DEFAULT_ISOLATION_ID);
    this.db.exec("UPDATE l1_records SET version = 0 WHERE version IS NULL OR version < 0");
    // ── 灵魂记忆字段（P2a）：时空 / 观察推断 / 情感 —— 幂等 ALTER，已有库在线加列 ──
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN occurred_at TEXT DEFAULT ''");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN valid_start TEXT DEFAULT ''");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN valid_end TEXT DEFAULT ''");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN certainty TEXT DEFAULT 'observed'");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN valence REAL");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN arousal REAL");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN significance REAL");
    } catch {
      /* exists */
    }
    // D-3（2026-09-21）：敏感性第 9 soul 列（幂等 ALTER；缺省 none=逐位现状）
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN sensitivity TEXT DEFAULT 'none'");
    } catch {
      /* exists */
    }
    // P1-T7（2026-10-13，worthiness importance）：第 10 soul 列。TINYINT 无 DEFAULT →
    // 既有行 NULL = 未评分 = 召回降权门永不命中（宁缺毋滥；spec §6 shadow-first）。
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN importance TINYINT");
    } catch {
      /* exists */
    }
    // 原话溯源（行级 source_message_ids）：JSON 数组文本。老行经 ADD COLUMN 的常量 DEFAULT 回填 '[]'，
    // 与读侧「非法/空/NULL → []」兜底同语义；不用可空列，避免存量行出现 NULL 三态。
    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN source_message_ids TEXT NOT NULL DEFAULT '[]'");
    } catch {
      /* exists */
    }

    // ── ADR-0025 C2/C3/C4（2026-11-04）：L1 死列与死索引剪除（幂等在线迁移） ──
    // C3 timestamp_start：与 timestamp_str 4225/4225 逐位相等（写入侧只差一次 min 归约），
    //   读侧投影一律改取 timestamp_str，对外 created_at 值逐位不变。
    // C2 source：全仓零判定读点（详见 soul-columns.ts 注释），行级原话溯源由 source_message_ids
    //   + memory_audit 承担。
    // C4 两条单列索引（idx_l1_ts_start / idx_l1_ts_end）无任何 WHERE/ORDER BY 命中 → 一并清掉。
    // 顺序硬约束：先 DROP INDEX 再 DROP COLUMN（SQLite 不允许删除被索引引用的列）；
    // 列/索引已不在时 ALTER/DROP 抛错由 catch 吞掉 = 天然幂等。
    try {
      this.db.exec("DROP INDEX IF EXISTS idx_l1_ts_start");
    } catch {
      /* 已不在 */
    }
    try {
      this.db.exec("DROP INDEX IF EXISTS idx_l1_ts_end");
    } catch {
      /* 已不在 */
    }
    try {
      this.db.exec("ALTER TABLE l1_records DROP COLUMN timestamp_start");
    } catch {
      /* 列已不在 */
    }
    try {
      this.db.exec("ALTER TABLE l1_records DROP COLUMN source");
    } catch {
      /* 列已不在 */
    }

    // Indexes for common queries
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_type ON l1_records(type)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_key ON l1_records(session_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_id ON l1_records(session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_scene ON l1_records(scene_name)");
    // ADR-0025 C4：idx_l1_ts_start / idx_l1_ts_end 两条死索引已删（无查询命中，只增写入放大）。
    // Composite index: session_id exact match + updated_time range scan (for incremental L2 queries)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_updated ON l1_records(session_id, updated_time)");
    // Composite index: session_key exact match + updated_time range scan (for pipeline cursor queries)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_sessionkey_updated ON l1_records(session_key, updated_time)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_task_updated ON l1_records(task_id, updated_time)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_team_agent_updated ON l1_records(team_id, agent_id, updated_time)");
    // #146（事实级双时态）：写面按 metadata_json.fact_key 找"同（实体,属性）的旧事实行"。
    // metadata_json 是 UNINDEXED 列，没有表达式索引时每条单值事实写入都全表扫描一次。
    // 两个坑必须一起绕：① 老库可能没有 JSON1（json_extract 不存在）→ 建索引失败不致命，只退化成扫描；
    // ② 本仓**容忍损坏的 metadata_json**（历史坏行会留下 '{broken' 这类残值）——
    //    裸 json_extract 在写坏行时会抛 malformed JSON，把"坏行只跳过"变成"坏行写不进"，
    //    所以索引用 json_valid 守卫：坏行索引值为 NULL，不进索引也不抛错。
    try {
      // 旧定义（无守卫）如有则以新名字重建，避免 IF NOT EXISTS 留着一个会抛错的索引。
      this.db.exec("DROP INDEX IF EXISTS idx_l1_fact_key");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_l1_fact_key_valid ON l1_records(" +
          "json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json END, '$.fact_key'))",
      );
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [W2b-fact-rows] fact_key expression index unavailable (falling back to table scan): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    // ── 核心记忆（K，设计§2/§3：stable 稳定锚定，agent 可维护，信任边界）──
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
    // P2-T12：core_memory 租户化 + 复合唯一索引（idx_core_memory_tenant）。
    // S8 删 core_values 时这段调用被误删过 → 新库缺唯一索引，commitSoulPersona 的
    // ON CONFLICT(slot,team,user,agent) 直接抛 "ON CONFLICT clause does not match"。已恢复。
    this.migrateCoreTenantTables();
    // #30（S9/R5，2026-10-16）：soul 快照 append-only 账本——双时态状态史（Graphiti bi-temporal
    // 同构；禁删哲学=只追加不更新不删除）。capture point=渲染路径（buildSoulPrefix）：指纹变化后
    // 首次渲染落行（at-least-once），last-hash 去重=指纹不变零落行（防膨胀）。payload_json=soul
    // 渲染全文，时间旅行=按 ts 取 payload 重建任一时点全文。
    this.db.exec(`CREATE TABLE IF NOT EXISTS soul_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      ts TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      "trigger" TEXT NOT NULL DEFAULT 'render',
      version INTEGER NOT NULL DEFAULT 0,
      parent_hash TEXT,
      reason_detail TEXT NOT NULL DEFAULT '',
      slots_json TEXT NOT NULL DEFAULT '{}'
    )`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_soul_snapshots_tenant_ts ON soul_snapshots(team_id, user_id, agent_id, ts)",
    );
    // 缺口 A（2026-11-04）：版本链与漂移审计四列——幂等 ALTER（T12 模式），存量库补列。
    // 语义：version=该 tenant 维度单调递增（旧行缺省 0=反填前，读侧按行序补位）；
    // parent_hash=上一版 content_hash（首版 NULL）；reason_detail=归因细节；
    // slots_json=slot 图（键级 diff 源，payload_json 仍是渲染全文，时间旅行合同不变）。
    // 回滚策略=列保留无害：旧读侧 SELECT 白名单不含新列，缺省值即现状。
    try {
      this.db.exec("ALTER TABLE soul_snapshots ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE soul_snapshots ADD COLUMN parent_hash TEXT");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE soul_snapshots ADD COLUMN reason_detail TEXT NOT NULL DEFAULT ''");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE soul_snapshots ADD COLUMN slots_json TEXT NOT NULL DEFAULT '{}'");
    } catch {
      /* exists */
    }
    // #28（R5）：soul_state——会话级当下 state 单行存储（每 agent 一行，upsert 覆盖；
    // 历史轨迹重建走 soul_snapshots/时间旅行，本表只存当前值）。
    this.db.exec(`CREATE TABLE IF NOT EXISTS soul_state (
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      valence REAL NOT NULL DEFAULT 0,
      arousal REAL NOT NULL DEFAULT 0,
      top_value TEXT,
      turn_seq INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id, agent_id)
    )`);
    // m00527：心境基线列（幂等 ALTER）——旧行无基线时读侧按「当前值即基线」处理（不伪造偏移）。
    for (const ddl of [
      "ALTER TABLE soul_state ADD COLUMN baseline_valence REAL",
      "ALTER TABLE soul_state ADD COLUMN baseline_arousal REAL",
      "ALTER TABLE soul_state ADD COLUMN sample_count INTEGER",
      // 2026-11-05：心境原因列（幂等）——旧行无值=只写偏移不写原因，不伪造「因为 X」。
      // 2026-11-06：支配感（PAD 第三维）列（幂等）——旧行无值=不写「撑不撑得住」半句。
      "ALTER TABLE soul_state ADD COLUMN dominance REAL",
      "ALTER TABLE soul_state ADD COLUMN baseline_dominance REAL",
      "ALTER TABLE soul_state ADD COLUMN emotion_object TEXT",
      "ALTER TABLE soul_state ADD COLUMN emotion_label TEXT",
      "ALTER TABLE soul_state ADD COLUMN emotion_intensity REAL",
      "ALTER TABLE soul_state ADD COLUMN emotion_at TEXT",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* exists */
      }
    }
    // 自维护人格层（2026-11-05）：条目表 + append-only 账本。只增不减——冻结不删除、
    // 合并留 merged_into 指针，账本 before_json 保留完整快照以支持回滚。
    this.db.exec(`CREATE TABLE IF NOT EXISTS soul_persona (
      item_id TEXT NOT NULL,
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      layer TEXT NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      weight REAL NOT NULL DEFAULT 0.5,
      evidence_json TEXT,
      days_json TEXT,
      origins_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_evidence_at TEXT NOT NULL,
      merged_into TEXT,
      aliases_json TEXT,
      contradictions INTEGER NOT NULL DEFAULT 0,
      drift_json TEXT,
      meta_json TEXT,
      PRIMARY KEY (item_id, team_id, user_id, agent_id)
    )`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_soul_persona_tenant ON soul_persona(team_id, user_id, agent_id, layer, state)",
    );
    // 人格层 v3.7 特质存储：6 轴状态是漂移唯一载体；标签是「空间里的方向」视图，不存权重。
    // 轴固定 6 根（加轴必须升 schema/协议版本），故用定长 JSON 数组而非宽表：
    // axis_json / seed_state_json 均为 6 个 [-1,1] 数值，顺序同 SOUL_AXES。
    this.db.exec(`CREATE TABLE IF NOT EXISTS soul_trait_state (
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      axis_json TEXT NOT NULL DEFAULT '[0,0,0,0,0,0]',
      seed_state_json TEXT NOT NULL DEFAULT '[0,0,0,0,0,0]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id, agent_id)
    )`);
    // 标签表：direction 为六轴单位向量（spec §9 写作 direction[5]，与 §3 的 direction[6] 冲突，
    // 以 §3 六轴为准）；gloss/anchor 是 §3.2 的读侧/判侧文本，§9 列清单漏列，按判据 8 补齐；
    // protocol_version 供判据 13 归因。
    this.db.exec(`CREATE TABLE IF NOT EXISTS soul_trait_label (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      label TEXT NOT NULL,
      definition TEXT NOT NULL DEFAULT '',
      gloss TEXT NOT NULL DEFAULT '',
      anchor TEXT NOT NULL DEFAULT '',
      direction_json TEXT NOT NULL DEFAULT '[0,0,0,0,0,0]',
      evidence INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      protocol_version TEXT NOT NULL DEFAULT 'v1',
      PRIMARY KEY (tenant_id, label)
    )`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_soul_trait_label_status ON soul_trait_label(tenant_id, status, last_seen)",
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS soul_ledger (
      entry_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      at TEXT NOT NULL,
      trigger TEXT NOT NULL,
      layer TEXT,
      item_id TEXT,
      action TEXT NOT NULL,
      before_hash TEXT,
      after_hash TEXT,
      gates_json TEXT,
      reason TEXT NOT NULL DEFAULT '',
      evidence_json TEXT,
      prompt_version TEXT,
      model TEXT,
      before_json TEXT,
      protocol_version TEXT
    )`);
    // S3/判据 13：账本带判定协议版本，漂移与事件史据此可追溯是「哪版规则判的」。
    try {
      this.db.exec("ALTER TABLE soul_ledger ADD COLUMN protocol_version TEXT");
    } catch {
      /* 列已存在 */
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_soul_ledger_tenant ON soul_ledger(team_id, user_id, agent_id, at)");
    // P0-2：门拒计数从账本移出。拒绝是判据的统计量（同一候选每 tick 都可能被拒），
    // 逐条落账本会把 24h 账本推到 785 行、并把同 code 的告警抑制窗口淹没。
    // 这里按 (day, code, layer) 聚合 +1；账本只留真正的条目变更与告警。
    this.db.exec(`CREATE TABLE IF NOT EXISTS soul_gate_stats (
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      day TEXT NOT NULL,
      code TEXT NOT NULL,
      layer TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      last_at TEXT,
      PRIMARY KEY (team_id, user_id, agent_id, day, code, layer)
    )`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_soul_gate_stats_tenant_day ON soul_gate_stats(team_id, user_id, agent_id, day)",
    );
    // 事件层（2026-11-05）：人格的事实底座。旧管线只从 L1 摘要长人格，摘要把
    // 「为什么恼火、对谁、放弃了什么」蒸发了；episode 保留逐字摘句与四元上下文。
    // episode_id 由会话+触发记录决定，重跑幂等；quote_json 与 evidence_json 都带 record_id 可回溯。
    this.db.exec(`CREATE TABLE IF NOT EXISTS soul_episodes (
      episode_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      at TEXT NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      object TEXT NOT NULL DEFAULT '',
      participants_json TEXT,
      user_stance TEXT NOT NULL DEFAULT '',
      agent_stance TEXT NOT NULL DEFAULT '',
      cost TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT '',
      valence REAL NOT NULL DEFAULT 0,
      arousal REAL NOT NULL DEFAULT 0,
      intensity REAL NOT NULL DEFAULT 0,
      affect_source TEXT NOT NULL DEFAULT 'lexicon',
      evidence_json TEXT,
      session_id TEXT NOT NULL DEFAULT '',
      quote_json TEXT,
      signals_json TEXT,
      layers_json TEXT,
      archived_at TEXT,
      mood_integrated_at TEXT,
      -- P2-E：这条事件里在场的自然人（person_key 数组）。与 participants_json
      -- （展示名/角色名）分工不同：按人过滤人格行要的是稳定键，不是「何晨」这种会改的串。
      persons_json TEXT
    )`);
    // S3：删除改为归档。旧库幂等补列；归档行默认不参与挖掘/注入，派生历史时显式包含。
    try {
      this.db.exec("ALTER TABLE soul_episodes ADD COLUMN archived_at TEXT");
    } catch {
      /* 列已存在 */
    }
    // P0-2：事件落盘带上它自己站住的层（identity/boundary/...），供 report 与审计区分
    // 「人格候选事件」与「只作上下文的 work 事件」。旧库幂等补列。
    try {
      this.db.exec("ALTER TABLE soul_episodes ADD COLUMN layers_json TEXT");
    } catch {
      /* 列已存在 */
    }
    // 心境积分：按事件打标（见 SoulEpisode.moodIntegratedAt 的注释：水位用处理时刻会
    // 把迟到事件永久饿死）。旧库幂等补列。
    try {
      this.db.exec("ALTER TABLE soul_episodes ADD COLUMN mood_integrated_at TEXT");
    } catch {
      /* 列已存在 */
    }
    // P2-E：事件挂人。旧库幂等补列；解析不出自然人时写 NULL（不是空数组），
    // 读回是 undefined——「这条事件没有可识别的人」与「它有一个人都没有的名单」不是一回事。
    try {
      this.db.exec("ALTER TABLE soul_episodes ADD COLUMN persons_json TEXT");
    } catch {
      /* 列已存在 */
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_soul_episodes_tenant_at ON soul_episodes(team_id, user_id, agent_id, at)",
    );
    // 情绪史（2026-11-06）：soul_state 只留「此刻」一个快照，写一次就把上一次覆盖，
    // 于是「因为什么、对谁、多强、多久消退」无法回放。这里按「事件 × 模板版本」逐行留档：
    // 判据改了（标签扩容/路由调整）就换 template_version，旧行不被静默改写，审计能看出
    // 当时按哪版规则判的。intensity 存事件原值，读侧按标签半衰期重算衰减。
    this.db.exec(`CREATE TABLE IF NOT EXISTS soul_emotions (
      episode_id TEXT NOT NULL,
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      at TEXT NOT NULL,
      object TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL,
      valence REAL NOT NULL DEFAULT 0,
      arousal REAL NOT NULL DEFAULT 0,
      dominance REAL,
      intensity REAL NOT NULL DEFAULT 0,
      appraisal_json TEXT,
      template_version TEXT NOT NULL DEFAULT '',
      appraised_at TEXT NOT NULL,
      PRIMARY KEY (episode_id, team_id, user_id, agent_id, template_version)
    )`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_soul_emotions_tenant_at ON soul_emotions(team_id, user_id, agent_id, at)",
    );
    // §5 P3-A：归因 / 把握度 / 情绪对象挂在谁身上。旧库幂等补列；旧行读回 null
    // （null = 当时没这一维，不伪造成 "environment" 或 0）。
    for (const ddl of [
      "ALTER TABLE soul_emotions ADD COLUMN agency TEXT",
      "ALTER TABLE soul_emotions ADD COLUMN confidence REAL",
      "ALTER TABLE soul_emotions ADD COLUMN object_person TEXT",
      // P5：情绪回指底座事件与目标。SOUL_EVENT_MIGRATION_DDL 里也有同样三条；
      // 放在建表旁边是为了让「新库也一定有这三列」与建表语句同屏，不依赖迁移顺序。
      "ALTER TABLE soul_emotions ADD COLUMN event_id TEXT",
      "ALTER TABLE soul_emotions ADD COLUMN goal_id TEXT",
      "ALTER TABLE soul_emotions ADD COLUMN dimensions_json TEXT",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* 列已存在 */
      }
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_soul_episodes_tenant_kind ON soul_episodes(team_id, user_id, agent_id, kind, at)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_soul_episodes_tenant_object ON soul_episodes(team_id, user_id, agent_id, object)",
    );
    // #35（R5）：promise 承诺层——义务≠倾向，独立于倾向层生命周期（排除条款
    // 见 soul-promise.ts）。当前态表 + 事件 append-only 表（双时态留痕，只增不改）。
    this.db.exec(`CREATE TABLE IF NOT EXISTS soul_promises (
      promise_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT NOT NULL DEFAULT 'user',
      ref_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      updated_at TEXT NOT NULL
    )`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_soul_promises_tenant ON soul_promises(team_id, user_id, agent_id, status)",
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS soul_promise_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promise_id TEXT NOT NULL,
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      from_status TEXT,
      to_status TEXT NOT NULL,
      at TEXT NOT NULL,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'manual'
    )`);
    // #41（ADR0003-P3 实施票 C）：#35 库增量列迁移（幂等 try/ALTER 惯例）——
    // soul_promises.ref_key（证据关联键）+ soul_promise_events.source（判定来源溯源）。
    try {
      this.db.exec("ALTER TABLE soul_promises ADD COLUMN ref_key TEXT NOT NULL DEFAULT ''");
    } catch {
      /* 列已存在 */
    }
    try {
      this.db.exec("ALTER TABLE soul_promise_events ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    } catch {
      /* 列已存在 */
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_soul_promise_events_promise ON soul_promise_events(promise_id, id)");
    // ── 人物身份层（soul_person，2026-11-08 人格系统 v3 阶段 1 / §3-B）──
    // 「谁」的稳定主键：L1 只存 {key, role} 引用，昵称变了不会分裂成第二个人。
    // 主键生成规则见 src/core/person/resolve.ts 的 personKeyOf（p_<sha1…12> / p_name_<sha1…12>）。
    // DDL 与 scripts/migrate-person-refs.mjs 共用同一份常量（store/soul-person-ddl.ts），禁止手抄第二份。
    for (const ddl of SOUL_PERSON_DDL) this.db.exec(ddl);
    // P2-H §5.3：`soul_person.profile_at` 与 `soul_person_relation.evidence_json` 都是后加的列，
    // `CREATE TABLE IF NOT EXISTS` 对已存在的表不补列，所以必须显式 ALTER 一次。
    // 只吞「列已存在」这一种（幂等重入）；其它错误要冒泡——把真错当已迁移会让水位静默不落。
    for (const ddl of SOUL_PERSON_MIGRATION_DDL) {
      try {
        this.db.exec(ddl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) throw err;
      }
    }
    // ── 事件底座（soul_events，P0-A §4.1–§4.10，2026-11-10）──
    // 位置在 soul_person 段落之后：SOUL_EVENT_MIGRATION_DDL 里有 ALTER soul_person_relation 的语句，
    // 该表由 SOUL_PERSON_DDL 建（上一段），顺序颠倒会报 no such table。
    // DDL 与 P0-D 迁移脚本共用 store/soul-event-ddl.ts 这一份常量，禁止手抄第二份。
    // SOUL_EVENT_DDL 全是 CREATE TABLE/INDEX IF NOT EXISTS，逐条 exec 即幂等；
    // SOUL_EVENT_MIGRATION_DDL 是给既有表补列的 ALTER，重入报 duplicate column name——只吞这一种。
    for (const ddl of SOUL_EVENT_DDL) this.db.exec(ddl);
    for (const ddl of SOUL_EVENT_MIGRATION_DDL) {
      try {
        this.db.exec(ddl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) throw err;
      }
    }
    // P2 §10.8：status 四值（含 unverifiable）——ALTER 加列带不了这个值，存量库要重建一次 CHECK。
    this.migrateSoulPersonRelationStatusEnum();
    // P6 §4.8：同一时段只许一条 active 章节（部分唯一索引）。放在这里而不是 SOUL_EVENT_DDL 里，
    // 是因为存量库可能有 P6 之前的重复 active：建索引失败只 warn，不让一条历史脏行搞崩进程。
    try {
      this.db.exec(SOUL_NARRATIVE_ACTIVE_PERIOD_UNIQUE_INDEX_DDL);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_narrative] active-period unique index skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // 2026-11-07（T1 提案/pending 通道清除）：core_pending 表与其 5 条幂等 ALTER（label/description/
    // attrs_json/recurrence_json/embedding_json）已删除——提案制与人工采纳通道整体下线，不再有写入者。
    // 存量生产库中的旧表由数据清理任务（T3）删除，本进程不再创建、不再读写。
    // GROW 调度状态 kv（anchor_growth_state）的建表已移除（2026-11-07 复验 P1-5）：
    // get/setIdentityDiscoveryState、get/setSelfObsBaseline 全仓 0 生产调用方（只剩一个 golden
    // fixture stub 与一个 store 单测），这张表没有写入者；继续建表会让「读空就重启一次发现」的
    // 死渠道看起来仍然可达。已有库里的旧表不 DROP（历史数据留给数据清理任务）。
    // PA（推翻 spec §5.1 裁决 2）：default 锚扇出迁移（幂等，SEC-1 模式）。
    // 位置在 migrateCoreTenantTables（唯一索引就位）+ origin/pinned/state ALTER 之后，
    // 保证存量库先完成租户化与三列补齐再扇出。
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
      // #137 W1/C：事实键平行向量通道表（与 l1_vec 同维、同余弦度量；主索引不动）。
      // IF NOT EXISTS 即老库自愈，无需迁移脚本。
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_fact_vec USING vec0(
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
        team_id, task_id, version, timestamp_str, timestamp_end,
        created_time, updated_time, metadata_json,
        user_id, agent_id,
        occurred_at, valid_start, valid_end, certainty, valence, arousal, significance, sensitivity,
        importance, source_message_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        content=excluded.content,
        type=excluded.type,
        priority=excluded.priority,
        scene_name=excluded.scene_name,
        team_id=excluded.team_id,
        -- ADR-0025 D3/C1（2026-11-04）：隔离轴与溯源是"粘性"列——同 record_id 的整行重写
        -- （编辑/重要度/失效三条重建链）可能不带这些字段，直接 excluded 覆盖会把已存值刷成
        -- ''/'[]'，等于把记忆从它的隔离桶里抹掉、把证据链抹掉。取 NULLIF 后 COALESCE：
        -- 新值非空则用新值，空则保留库中旧值；INSERT 分支仍是缺省空串。
        task_id=COALESCE(NULLIF(excluded.task_id, ''), task_id),
        version=excluded.version,
        timestamp_str=excluded.timestamp_str,
        timestamp_end=excluded.timestamp_end,
        updated_time=excluded.updated_time,
        metadata_json=excluded.metadata_json,
        user_id=excluded.user_id,
        agent_id=excluded.agent_id,
        occurred_at=excluded.occurred_at,
        valid_start=excluded.valid_start,
        -- 粘性列（task-2 / ADR-0025 D3 家族）：valid_end 的"空串"与"没带"不可区分
        -- （SOUL_FIELD_DEFAULTS.valid_end = ''），excluded 直覆盖 = 已失效行被编辑链复活
        -- （下游效期策略把它当 active 召回）。空 → 保留库中旧值；显式时间仍以新值为准。
        valid_end=COALESCE(NULLIF(excluded.valid_end, ''), valid_end),
        certainty=excluded.certainty,
        valence=excluded.valence,
        arousal=excluded.arousal,
        significance=excluded.significance,
        -- 粘性列：sensitivity 是"注入门"而非可覆盖属性。整行重写链（编辑/重要度/失效）
        -- 一律送缺省 'none'，若直覆盖就把 health/finance/relationship 降级成可注；
        -- 而提取侧缺省也是 'none'，无法区分"本次判定为不敏感"与"本次没判定"——宁可多拦：
        -- 新值为空/NULL/'none' 时保留库中旧值，只有明确的具体类才覆盖（fail-closed）。
        sensitivity=CASE
          WHEN excluded.sensitivity IS NULL
            OR excluded.sensitivity = ''
            OR lower(trim(excluded.sensitivity)) = 'none'
          THEN sensitivity
          ELSE excluded.sensitivity
        END,
        importance=excluded.importance,
        -- 同 task_id：溯源只增不减。空数组视为"本次没带"，而不是"清空证据"。
        source_message_ids=COALESCE(NULLIF(excluded.source_message_ids, '[]'), source_message_ids)
    `);

    if (this.dimensions > 0) {
      this.stmtDeleteVec = this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?");
      this.stmtInsertVec = this.db.prepare("INSERT INTO l1_vec (record_id, embedding, updated_time) VALUES (?, ?, ?)");
      // #137 W1/C：事实键通道平行语句（与主索引用同一 delete+insert 模式，vec0 无 ON CONFLICT）
      this.stmtDeleteFactVec = this.db.prepare("DELETE FROM l1_fact_vec WHERE record_id = ?");
      this.stmtInsertFactVec = this.db.prepare(
        "INSERT INTO l1_fact_vec (record_id, embedding, updated_time) VALUES (?, ?, ?)",
      );
    }
    this.stmtDeleteMeta = this.db.prepare("DELETE FROM l1_records WHERE record_id = ?");

    this.stmtGetMeta = this.db.prepare(`
      SELECT content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id,
             version, timestamp_str, timestamp_end, metadata_json, created_time,
             occurred_at, valid_start, valid_end, certainty, valence, arousal, significance, sensitivity,
             importance, source_message_ids,
             -- B 项（ADR-0025 决定 9，2026-11-04）：行最近更新时间。getL1ByIds / searchL1Vector /
             -- searchL1FactVector 的 updated_time 都由本语句带出——漏这一列会让 updated_at 静默回退
             -- timestamp_end（2026-11-04 真库探针实测发现并补齐）。
             updated_time
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
      // #137 W1/C：事实键通道 KNN（同形 SQL，只换表名）
      this.stmtSearchFactVec = this.db.prepare(`
        SELECT record_id, distance
        FROM l1_fact_vec
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
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l0_conversations ADD COLUMN team_id TEXT DEFAULT 'default'");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l0_conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l0_conversations ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE l0_conversations ADD COLUMN task_id TEXT DEFAULT ''");
    } catch {
      /* exists */
    }
    // #83 入口单点定源：L0 行级分类标签（real/artifact/echo/scaffold/dup/unknown）。
    // 存量行缺省 'unclassified'；#84 存量回填走 UPDATE-only（零删除红线内）。
    try {
      this.db.exec("ALTER TABLE l0_conversations ADD COLUMN classification TEXT NOT NULL DEFAULT 'unclassified'");
      this.logger?.debug?.(`${TAG} Migrated l0_conversations: added classification column`);
    } catch {
      /* exists */
    }
    this.db
      .prepare("UPDATE l0_conversations SET team_id = ? WHERE team_id = '' OR team_id IS NULL")
      .run(DEFAULT_ISOLATION_ID);
    this.db
      .prepare("UPDATE l0_conversations SET user_id = ? WHERE user_id = '' OR user_id IS NULL")
      .run(DEFAULT_ISOLATION_ID);
    this.db
      .prepare("UPDATE l0_conversations SET agent_id = ? WHERE agent_id = '' OR agent_id IS NULL")
      .run(DEFAULT_ISOLATION_ID);
    this.db
      .prepare("UPDATE l0_conversations SET session_id = ? WHERE session_id = '' OR session_id IS NULL")
      .run(DEFAULT_ISOLATION_ID);

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
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l0_user_agent_session ON l0_conversations(user_id, agent_id, session_id)",
    );
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
        user_id, agent_id, classification
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        message_text=excluded.message_text,
        recorded_at=excluded.recorded_at,
        timestamp=excluded.timestamp,
        team_id=excluded.team_id,
        -- 同 L1：同一条消息被重放时不因本侧缺 taskId 抹掉隔离轴（ADR-0025 D3）。
        task_id=COALESCE(NULLIF(excluded.task_id, ''), task_id),
        user_id=excluded.user_id,
        agent_id=excluded.agent_id
    `);

    if (this.dimensions > 0) {
      this.stmtL0DeleteVec = this.db.prepare("DELETE FROM l0_vec WHERE record_id = ?");
      this.stmtL0InsertVec = this.db.prepare("INSERT INTO l0_vec (record_id, embedding, recorded_at) VALUES (?, ?, ?)");
    }
    this.stmtL0DeleteMeta = this.db.prepare("DELETE FROM l0_conversations WHERE record_id = ?");

    this.stmtL0GetMeta = this.db.prepare(`
      SELECT session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp, classification
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
    // classification（proxy #83 行级标签）随行返回：L1 批次据此结构性挡掉
    // scaffold/artifact/echo/dup，见 utils/sanitize.ts isNonRealL0Classification。
    this.stmtL0QueryAll = this.db.prepare(`
      SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp, classification
      FROM l0_conversations
      WHERE session_key = ?
      ORDER BY recorded_at ASC
      LIMIT ?
    `);

    this.stmtL0QueryAfter = this.db.prepare(`
      SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp, classification
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
    try {
      this.db.exec("ALTER TABLE entity_knowledge ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE entity_teams ADD COLUMN user_ids_json TEXT NOT NULL DEFAULT '[]'");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE entity_teams ADD COLUMN agent_ids_json TEXT NOT NULL DEFAULT '[]'");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE entity_tasks ADD COLUMN user_ids_json TEXT NOT NULL DEFAULT '[]'");
    } catch {
      /* exists */
    }
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
        -- action 枚举必须与 store/types.ts 的 AuditEntry['action'] 保持同一集合：
        -- 'sensitivity'（ADR-0025 决定 10：显式降敏）与 update/delete 同等留痕。
        action        TEXT NOT NULL CHECK (action IN ('update','delete','sensitivity')),
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
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_memory_audit_isolation ON memory_audit(team_id, agent_id, user_id, task_id)",
    );
    // 存量库的 CHECK 枚举（只有 update/delete）会把新 action 写成异常 → recordAudit 的
    // catch 吞掉 → 审计静默丢失（A 项 wire 用例实测复现）。SQLite 无法 ALTER CHECK，
    // 只能轻量重建（CREATE new + INSERT SELECT + DROP + RENAME，同 T12/FTS 迁移模式）。
    this.migrateMemoryAuditActionEnum();

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
               timestamp_str, timestamp_end,
               metadata_json,
               ${SOUL_SELECT_FRAGMENT},
               (SELECT lr.source_message_ids FROM l1_records lr WHERE lr.record_id = l1_fts.record_id) AS source_message_ids,
               (SELECT lr.updated_time FROM l1_records lr WHERE lr.record_id = l1_fts.record_id) AS updated_time,
               bm25(l1_fts) AS rank
        FROM l1_fts
        WHERE l1_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);

      // 类型收窄版（2026-11-03）：**先过滤再 LIMIT**。结论层只消费 work_fact，但旧写法把
      // episodic（短、词频高）与 work_fact 放在同一池子里按 bm25 竞争 top-N，长文 consolidated
      // 卡被系统性挤出榜外（生产实测：4021 行里 #37/50，按 type 收窄后 #5/9）。
      // type 是 l1_fts 的 UNINDEXED 列，SQL 层过滤 + 同一 bm25 排序，排名语义不变。
      this.stmtL1FtsSearchByType = this.db.prepare(`
        SELECT record_id, content_original AS content, type, priority, scene_name,
               session_key, session_id, team_id, task_id, user_id, agent_id, version,
               timestamp_str, timestamp_end,
               metadata_json,
               ${SOUL_SELECT_FRAGMENT},
               (SELECT lr.source_message_ids FROM l1_records lr WHERE lr.record_id = l1_fts.record_id) AS source_message_ids,
               (SELECT lr.updated_time FROM l1_records lr WHERE lr.record_id = l1_fts.record_id) AS updated_time,
               bm25(l1_fts) AS rank
        FROM l1_fts
        WHERE l1_fts MATCH ? AND type = ?
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
      timestamp_str, timestamp_end,
      created_time, updated_time, metadata_json,
      occurred_at, valid_start, valid_end, certainty, valence, arousal, significance,
      sensitivity, importance,
      source_message_ids`;

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
      const row = this.db.prepare("SELECT value FROM embedding_meta WHERE key = ?").get("embedding_provider_info") as
        { value: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.value) as EmbeddingMeta;
    } catch {
      return null;
    }
  }

  private writeEmbeddingMeta(meta: EmbeddingMeta): void {
    this.db
      .prepare(
        "INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run("embedding_provider_info", JSON.stringify(meta));
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
      const row = this.db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number } | undefined;
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
      const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get("l1_vec") as
        { sql: string } | undefined;
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
    // #137：维度/模型变更时必须一并重建事实键通道表，否则 IF NOT EXISTS 会保留旧维度表。
    this.db.exec("DROP TABLE IF EXISTS l1_fact_vec");
    this.logger?.info(`${TAG} Dropped vector tables (l1_vec, l0_vec, l1_fact_vec)`);
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
      // ADR-0025 C3（2026-11-04）：只留区间右端。原 tsStart=min(timestamps) 在生产 4225/4225 行
      // 与 tsStr 逐位相等（timestamps 首值即最小），已随列删除。
      const tsEnd = timestamps.length > 0 ? timestamps.reduce((a, b) => (a > b ? a : b)) : tsStr;

      const skipVec = !embedding || embedding.every((v) => v === 0) || !this.vecTablesReady;

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
          tsEnd,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record.metadata),
          (record as MemoryRecord & { userId?: string }).userId || DEFAULT_ISOLATION_ID,
          (record as MemoryRecord & { agentId?: string }).agentId || DEFAULT_ISOLATION_ID,
          // 灵魂记忆字段（P2a）：末尾追加，与预处理语句列序一致（P1-T7 收敛为 soulBindValues 单一取值源）
          ...soulBindValues(record as unknown as Record<string, unknown>),
          // 原话溯源（行级）：必须显式绑定——列缺省只在 INSERT 缺列时生效，
          // 而本语句是「全列 upsert + ON CONFLICT DO UPDATE」，漏绑=老值被 excluded 覆盖成空。
          JSON.stringify(Array.isArray(record.source_message_ids) ? record.source_message_ids : []),
        );

        if (!skipVec) {
          // vec0 does not support ON CONFLICT → delete then insert
          this.stmtDeleteVec!.run(recordId);
          this.stmtInsertVec!.run(
            recordId,
            Buffer.from(embedding!.buffer, embedding!.byteOffset, embedding!.byteLength),
            record.updatedAt,
          );
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
            // task-2：FTS 是 delete+insert 的整行投影。若按调用方入参绑定，主表刚被
            // ON CONFLICT 保住的粘性列（valid_end / sensitivity / task_id）会在镜像里
            // 写成缺省 ''/'none' —— 已失效/已判敏感的行由此在 FTS 腿复活（同一条记忆
            // 在两条召回腿给出两种判定）。故镜像一律以 upsert 后的主表权威值为准。
            const authoritative = this.stmtGetMeta.get(recordId) as
              { task_id?: string | null; valid_end?: string | null; sensitivity?: string | null } | undefined;
            const soulSrc: Record<string, unknown> = { ...(record as unknown as Record<string, unknown>) };
            if (authoritative) {
              soulSrc.task_id = authoritative.task_id ?? "";
              soulSrc.valid_end = authoritative.valid_end ?? "";
              soulSrc.sensitivity = authoritative.sensitivity ?? "";
            }
            this.stmtL1FtsDelete.run(recordId);
            this.stmtL1FtsInsert.run(
              tokenizeForFts(record.content), // content — segmented for indexing
              record.content, // content_original — raw for display
              recordId,
              record.type,
              record.priority,
              record.scene_name,
              record.sessionKey,
              record.sessionId || DEFAULT_ISOLATION_ID,
              (record as MemoryRecord & { teamId?: string }).teamId || DEFAULT_ISOLATION_ID,
              ((soulSrc.task_id as string | undefined) ?? "") || "",
              (record as MemoryRecord & { userId?: string }).userId || DEFAULT_ISOLATION_ID,
              (record as MemoryRecord & { agentId?: string }).agentId || DEFAULT_ISOLATION_ID,
              record.version ?? 0,
              tsStr,
              tsEnd,
              JSON.stringify(record.metadata),
              // soul 字段（P1-T7）：soulSrc = 入参 + 主表权威粘性列覆盖，单一取值源仍是 soulBindValues
              ...soulBindValues(soulSrc),
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
        } catch {
          /* ignore rollback errors */
        }
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
  addLink(sourceId: string, targetId: string, type: LinkType, strength = 1, now = new Date().toISOString()): boolean {
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
  getNeighbors(
    id: string,
    types?: string[],
    maxHop = 1,
    filter?: IsolationFilter,
  ): Array<{ id: string; type: string; strength: number; hop: number }> {
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
          const okIds = new Set(recs.filter((rec) => rowMatchesIsolation(rec, filter)).map((rec) => rec.record_id));
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
  getLinksByTarget(
    targetId: string,
    type?: string,
  ): Array<{ sourceId: string; type: string; strength: number; createdAt: string }> {
    try {
      const rows = (
        type
          ? this.db
              .prepare(
                "SELECT source_id, type, strength, created_at FROM l1_links WHERE target_id = ? AND type = ? ORDER BY created_at",
              )
              .all(targetId, type)
          : this.db
              .prepare(
                "SELECT source_id, type, strength, created_at FROM l1_links WHERE target_id = ? ORDER BY created_at",
              )
              .all(targetId)
      ) as Array<{ source_id: string; type: string; strength: number; created_at: string }>;
      return rows.map((r) => ({ sourceId: r.source_id, type: r.type, strength: r.strength, createdAt: r.created_at }));
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [l1_links] getLinksByTarget failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * 记忆图：沿边正查（G）。返回 sourceId 发出的边（它指向谁）；可选 type 过滤。
   * 与 getLinksByTarget 对偶——L2 侧身世查询："这个 scene block 由哪些 L1 蒸馏而来"。
   */
  getLinksBySource(
    sourceId: string,
    type?: string,
  ): Array<{ targetId: string; type: string; strength: number; createdAt: string }> {
    try {
      const rows = (
        type
          ? this.db
              .prepare(
                "SELECT target_id, type, strength, created_at FROM l1_links WHERE source_id = ? AND type = ? ORDER BY created_at",
              )
              .all(sourceId, type)
          : this.db
              .prepare(
                "SELECT target_id, type, strength, created_at FROM l1_links WHERE source_id = ? ORDER BY created_at",
              )
              .all(sourceId)
      ) as Array<{ target_id: string; type: string; strength: number; created_at: string }>;
      return rows.map((r) => ({ targetId: r.target_id, type: r.type, strength: r.strength, createdAt: r.created_at }));
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [l1_links] getLinksBySource failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * P0-1（2026-11-04 L1 属性复核）：L2 块的 derived_from 溯源敏感画像——按块 id 一次
   * GROUP BY，返回该块蒸馏过的**仍在主表**的行数与其中敏感行数。
   *
   * 为什么要这个查询：结论层注入的是场景块**摘要**（N 行蒸馏后的聚合），要判定"这段聚合
   * 里有没有健康/财务/关系类内容"只能回到它的派生来源。链接对是 (profile:v1:…, L1 id)，
   * 生产单块可达 3400+ 条 —— 逐块 getLinksBySource + 逐行回读会把召回拖成秒级，故此处
   * 由 SQL 聚合，只回两个整数。已归档行（l1_archive）不计入 targets：主表没有它，就既
   * 不能证其敏感、也不该算作覆盖（调用方按 targets=0 走"不可判定"分支）。
   */
  getDerivedSensitivityStats(sourceIds: string[]): Record<string, { targets: number; sensitive: number }> {
    const ids = (sourceIds ?? []).filter((s): s is string => typeof s === "string" && s.length > 0);
    if (ids.length === 0) return {};
    if (this.degraded) return {};
    try {
      const placeholders = ids.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT l.source_id AS sid,
                  COUNT(DISTINCT l.target_id) AS targets,
                  COUNT(DISTINCT CASE WHEN lower(COALESCE(r.sensitivity, 'none')) <> 'none' THEN l.target_id END) AS sensitive
             FROM l1_links l
             JOIN l1_records r ON r.record_id = l.target_id
            WHERE l.type = 'derived_from' AND l.source_id IN (${placeholders})
            GROUP BY l.source_id`,
        )
        .all(...ids) as Array<{ sid: string; targets: number; sensitive: number }>;
      const out: Record<string, { targets: number; sensitive: number }> = {};
      for (const r of rows) out[r.sid] = { targets: Number(r.targets) || 0, sensitive: Number(r.sensitive) || 0 };
      return out;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [l1_links] getDerivedSensitivityStats failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    }
  }

  /**
   * P4b（GROW-EVO §4，REG-REMAINING-005 #1）：按 type 全量取边——evolution-worker 的
   * conflict 边扫描底座。单条索引查询（O(边数)），取代"逐 id getLinksByTarget/Source"
   * 的 O(N) 逐条扫描（设计最优性审查定案 #3）。与上两方法同款模式。
   */
  getLinksByType(
    type: LinkType,
  ): Array<{ sourceId: string; targetId: string; type: string; strength: number; createdAt: string }> {
    try {
      const rows = this.db
        .prepare(
          "SELECT source_id, target_id, type, strength, created_at FROM l1_links WHERE type = ? ORDER BY created_at",
        )
        .all(type) as Array<{
        source_id: string;
        target_id: string;
        type: string;
        strength: number;
        created_at: string;
      }>;
      return rows.map((r) => ({
        sourceId: r.source_id,
        targetId: r.target_id,
        type: r.type,
        strength: r.strength,
        createdAt: r.created_at,
      }));
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [l1_links] getLinksByType failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
  getPath(
    startId: string,
    endId: string,
    maxHop = 3,
    types?: string[],
    filter?: IsolationFilter,
  ): Array<{ id: string; type: string; strength: number; hop: number }> | null {
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
          const okIds = new Set(recs.filter((rec) => rowMatchesIsolation(rec, filter)).map((rec) => rec.record_id));
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
      this.logger?.warn?.(
        `${TAG} [l1_links] deleteLinksFor failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      const result = this.db
        .prepare(
          `DELETE FROM l1_links
         WHERE (source_id NOT IN (SELECT record_id FROM l1_records) AND source_id NOT IN (SELECT record_id FROM l1_archive))
            OR (target_id NOT IN (SELECT record_id FROM l1_records) AND target_id NOT IN (SELECT record_id FROM l1_archive))`,
        )
        .run();
      const pruned = (result as any)?.changes ?? 0;
      if (pruned > 0) this.logger?.info?.(`${TAG} [l1_links] pruned ${pruned} orphan edge(s)`);
      return pruned;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [l1_links] pruneOrphanLinks failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      const row = this.db
        .prepare(
          // P1-T7：importance 入档（归档→恢复 roundtrip 保值；P0-T3 家族"漏拷=刷空"合同）。
          // T7 审稿 M-3：sensitivity 补入清单（整行 JSON.stringify 入档，SELECT 列=归档键），
          // 闭环 restoreL1 既有 d.sensitivity ?? "none" 回填——归档/恢复 roundtrip 全 soul 列保值。
          // ADR-0025 C2/C3：归档 SELECT 同步收窄（timestamp_start / source 已删列；少拷=不必要的死字段）。
          `SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_end, created_time, updated_time, metadata_json, occurred_at, valid_start, valid_end, certainty, valence, arousal, significance, sensitivity, importance, source_message_ids FROM l1_records WHERE record_id = ?`,
        )
        .get(id);
      if (!row) return false;
      this.db.exec("BEGIN");
      try {
        // SEC-1：INSERT 带租户三列（从被归档 l1_records 行取——归档行必须带归属；
        // 缺省兜 default 桶，与 l1_records 存量归一口径一致）。
        const r = row as Record<string, unknown>;
        this.db
          .prepare(
            "INSERT INTO l1_archive (record_id, data, archived_at, reason, team_id, user_id, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            JSON.stringify(row),
            new Date().toISOString(),
            reason,
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
        // #137：归档同时清掉事实键通道向量（否则 fact 通道留孤儿行）
        if (this.stmtDeleteFactVec) this.stmtDeleteFactVec.run(id);
        if (this.ftsAvailable) this.stmtL1FtsDelete.run(id);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      this.logger?.debug?.(`${TAG} [l1_archive] archived ${id} (${reason})`);
      return true;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [l1_archive] archive failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      const row = this.db
        .prepare("SELECT data, team_id, user_id, agent_id FROM l1_archive WHERE record_id = ?")
        .get(id) as { data: string; team_id?: string; user_id?: string; agent_id?: string } | undefined;
      if (!row) return false;
      if (
        filter &&
        !rowMatchesIsolation(
          {
            team_id: row.team_id || DEFAULT_ISOLATION_ID,
            user_id: row.user_id || DEFAULT_ISOLATION_ID,
            agent_id: row.agent_id || DEFAULT_ISOLATION_ID,
          },
          filter,
        )
      ) {
        this.logger?.warn?.(
          `${TAG} [l1_archive] restore ${id} rejected: archive tenant <${row.team_id}/${row.user_id}/${row.agent_id}> does not match requester isolation`,
        );
        return false;
      }
      const d = JSON.parse(row.data) as Record<string, unknown>;
      this.db.exec("BEGIN");
      try {
        // 注意：27 列 ↔ 27 个 ?（P2a 加 soul 列时占位符数与列清单曾失配 → restoreL1 恒失败，
        // 审计 F5 修复：数齐。P1-T7 加 importance，2026-11-04 加 source_message_ids，
        // ADR-0025 C2/C3 删 timestamp_start/source 后回到 27 列——改列清单必须同步数 ?）。
        // 老归档行（含已删列）多出的键在 JSON 里被忽略，读回靠 d.timestamp_str 单一来源。
        // FTS 重建见下方 F5 块。）
        this.db
          .prepare(
            `INSERT OR REPLACE INTO l1_records (record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_end, created_time, updated_time, metadata_json, occurred_at, valid_start, valid_end, certainty, valence, arousal, significance, sensitivity, importance, source_message_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            d.record_id,
            d.content,
            d.type,
            d.priority,
            d.scene_name,
            d.session_key,
            d.session_id,
            d.team_id,
            d.task_id,
            d.user_id,
            d.agent_id,
            d.version,
            d.timestamp_str,
            d.timestamp_end,
            d.created_time,
            d.updated_time,
            d.metadata_json,
            d.occurred_at,
            d.valid_start,
            d.valid_end,
            d.certainty,
            d.valence,
            d.arousal,
            d.significance,
            d.sensitivity ?? "none",
            d.importance ?? null,
            // 原话溯源（行级）：归档行缺字段（老归档）→ '[]'，与列缺省同语义。
            typeof d.source_message_ids === "string" ? d.source_message_ids : "[]",
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
              d.content,
              d.record_id,
              d.type,
              d.priority,
              d.scene_name,
              d.session_key,
              d.session_id,
              d.team_id ?? "",
              d.task_id ?? "",
              d.user_id ?? "",
              d.agent_id ?? "",
              d.version ?? 0,
              d.timestamp_str,
              d.timestamp_end,
              d.metadata_json ?? "{}",
              // soul 9 字段（P1-T7）：与写入侧同源取值（ADR-0025 C2 已删 source）（缺省语义一致）
              ...soulBindValues(d),
            );
          } catch (err) {
            this.logger?.warn?.(
              `${TAG} [l1_archive] restoreL1 FTS rebuild failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      return true;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [l1_archive] restore failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
  listArchived(
    limit = 100,
    offset = 0,
    filter?: IsolationFilter,
  ): Array<{
    record_id: string;
    archived_at: string;
    reason: string;
    content: string;
    occurred_at?: string;
    team_id: string;
    user_id: string;
    agent_id: string;
  }> {
    try {
      const where = buildIsolationWhere(filter, "a.");
      const rows = this.db
        .prepare(
          `SELECT a.record_id, a.archived_at, a.reason,
                COALESCE(NULLIF(a.team_id,''),'${DEFAULT_ISOLATION_ID}') AS team_id,
                COALESCE(NULLIF(a.user_id,''),'${DEFAULT_ISOLATION_ID}') AS user_id,
                COALESCE(NULLIF(a.agent_id,''),'${DEFAULT_ISOLATION_ID}') AS agent_id,
                CAST(json_extract(a.data,'$.content') AS TEXT) AS content, json_extract(a.data,'$.occurred_at') AS occurred_at
         FROM l1_archive a${where.clause ? ` WHERE ${where.clause}` : ""} ORDER BY a.archived_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...where.params, limit, offset) as unknown as Array<{
        record_id: string;
        archived_at: string;
        reason: string;
        content: string;
        occurred_at?: string;
        team_id: string;
        user_id: string;
        agent_id: string;
      }>;
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
            try {
              this.db.exec(`ALTER TABLE l1_archive ADD COLUMN ${col} TEXT NOT NULL DEFAULT '${dflt}'`);
            } catch {
              /* exists */
            }
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
          this.logger?.warn?.(
            `${TAG} [archive-tenant-migrate] 防御回填 l1_archive 租户列：${backfilled} 行（损坏 ${corrupted} 行 → default）`,
          );
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
    const rows = (
      allRows
        ? this.db.prepare("SELECT record_id, data FROM l1_archive")
        : this.db.prepare(
            "SELECT record_id, data FROM l1_archive WHERE team_id IS NULL OR team_id = '' OR user_id IS NULL OR user_id = '' OR agent_id IS NULL OR agent_id = ''",
          )
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
   * A 项（ADR-0025 决定 10）后置迁移：memory_audit.action 的 CHECK 枚举扩容。
   *
   * 为什么必须迁移而不是只改 TS union：CHECK 是**库级**约束，老库（生产 vectors.db 的
   * memory_audit 建于本批之前）里只有 ('update','delete')。写入 'sensitivity' 会被 CHECK
   * 拒绝 → recordAudit 的 catch 只 warn（审计失败不得影响用户写操作）→ 结果是降敏成功但
   * 审计静默丢失。A 项 wire 用例 ① 就是这么抓到的（audit.length === 0）。
   *
   * SQLite 不支持 ALTER CHECK ⇒ 轻量重建（12-step 简化版，本表无外键/触发器）：
   * 建新表 → 整表 INSERT SELECT → DROP 旧表 → RENAME → 重建两个索引。
   * 幂等判据：sqlite_master 里的 DDL 已含 'sensitivity' 就跳过（新库 / 已迁移库）。
   * 失败：warn 后继续（与 T12 迁移同策，不 degrade 整个 store），下次 init 重试；
   * 期间新 action 的审计会被库级 CHECK 拒绝，日志明写后果，不静默。
   */
  private migrateMemoryAuditActionEnum(): void {
    try {
      const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_audit'").get() as
        { sql?: string } | undefined;
      if (!row?.sql || row.sql.includes("'sensitivity'")) return;
      let count = 0;
      this.db.exec("BEGIN");
      try {
        this.db.exec(`
        CREATE TABLE memory_audit_t12 (
          audit_id      TEXT PRIMARY KEY,
          record_id     TEXT NOT NULL,
          layer         TEXT NOT NULL CHECK (layer IN ('L1','L2','L3')),
          action        TEXT NOT NULL CHECK (action IN ('update','delete','sensitivity')),
          team_id       TEXT,
          agent_id      TEXT,
          user_id       TEXT,
          task_id       TEXT,
          version       INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          request_id    TEXT
        )
      `);
        this.db.exec(`
        INSERT OR REPLACE INTO memory_audit_t12
          (audit_id, record_id, layer, action, team_id, agent_id, user_id, task_id, version, updated_at_ms, request_id)
        SELECT audit_id, record_id, layer, action, team_id, agent_id, user_id, task_id, version, updated_at_ms, request_id
        FROM memory_audit
      `);
        count = (this.db.prepare("SELECT COUNT(*) AS n FROM memory_audit_t12").get() as { n: number }).n;
        this.db.exec("DROP TABLE memory_audit");
        this.db.exec("ALTER TABLE memory_audit_t12 RENAME TO memory_audit");
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_audit_record    ON memory_audit(record_id, updated_at_ms)");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_memory_audit_isolation ON memory_audit(team_id, agent_id, user_id, task_id)",
      );
      this.logger?.warn?.(
        `${TAG} [audit-action-migrate] memory_audit.action 枚举已扩容至 update/delete/sensitivity：重建保留 ${count} 行。`,
      );
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [audit-action-migrate] memory_audit.action 枚举扩容失败（幂等，下次 init 重试；` +
          `期间 action='sensitivity' 的审计会被库级 CHECK 拒绝并丢失）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * P2（spec §10.8）：soul_person_relation.status 需要第 4 个值 'unverifiable'——回指零命中或不唯一时
   * 保留事实、但不让未验证的边进卡。SQLite 不能 ALTER CHECK，只能轻量重建（同
   * migrateMemoryAuditActionEnum 的 12-step 简化版）：
   *   从 sqlite_master 取当前 DDL（列顺序/默认值/其它约束原样保留）→ 只把 status 的 CHECK 扩成四值
   *   → 建 soul_person_relation_p2 → INSERT SELECT（行内容不变）→ DROP → RENAME → 重建原索引。
   * 幂等判据：DDL 已含 'unverifiable' 就跳过（新库 / 已迁移库）。
   * 失败：warn 后继续（下次 init 重试）；期间回指任务写不进去只会保持 event_id=NULL，不猜、不进卡。
   */
  private migrateSoulPersonRelationStatusEnum(): void {
    try {
      const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='soul_person_relation'").get() as
        { sql?: string } | undefined;
      if (!row?.sql || row.sql.includes("'unverifiable'")) return;
      const oldCheck = "CHECK (status IN ('active','ended','disputed'))";
      if (!row.sql.includes(oldCheck)) {
        this.logger?.warn?.(
          `${TAG} [soul-relation-status-migrate] 关系表 DDL 里找不到预期 status CHECK，跳过重建（不猜结构）。`,
        );
        return;
      }
      const newSql = row.sql
        .replace(oldCheck, "CHECK (status IN ('active','ended','disputed','unverifiable'))")
        .replace(/^CREATE TABLE\s+soul_person_relation/i, "CREATE TABLE soul_person_relation_p2");
      const indexSql = (
        this.db
          .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='soul_person_relation' AND sql IS NOT NULL")
          .all() as Array<{ sql: string }>
      ).map((r) => r.sql);
      let count = 0;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(newSql);
        this.db.exec("INSERT INTO soul_person_relation_p2 SELECT * FROM soul_person_relation");
        count = (this.db.prepare("SELECT COUNT(*) AS n FROM soul_person_relation_p2").get() as { n: number }).n;
        this.db.exec("DROP TABLE soul_person_relation");
        this.db.exec("ALTER TABLE soul_person_relation_p2 RENAME TO soul_person_relation");
        this.db.exec("COMMIT");
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* COMMIT 失败时引擎可能已自动回滚 */
        }
        throw e;
      }
      for (const sql of indexSql) this.db.exec(sql);
      this.logger?.warn?.(
        `${TAG} [soul-relation-status-migrate] soul_person_relation.status 枚举已扩容至 active/ended/disputed/unverifiable：重建保留 ${count} 行。`,
      );
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul-relation-status-migrate] status 枚举扩容失败（幂等，下次 init 重试；期间回指失败的边保持 event_id=NULL，不进卡）: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * P2-T12（K1）core 两表租户化迁移（幂等，init 时自动执行）。
   *
   * - 新库：DDL 已带租户列且无单列 PK → 本方法只补建复合唯一索引（IF NOT EXISTS）。
   * - 存量库（缺 team_id 列 或 仍是 slot/value_id 单列 PK）：轻量重建
   *   （CREATE new + INSERT SELECT + DROP + rename，同 FTS 迁移模式）—— 单列 PK
   *   会阻塞"同 slot 不同租户并存"，SQLite 又无法 ALTER PK，必须重建解除；
   *   生产仅 core_memory 存量行，重建成本可忽略（执行裁决登记：
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
        const dataSel = spec.dataCols.join(", ");
        const teamSel = hasTeamId ? "COALESCE(NULLIF(team_id, ''), ?)" : "?";
        this.db.exec("BEGIN");
        try {
          this.db.exec(`
            CREATE TABLE ${spec.table}_t12 (
              ${spec.pkCol} TEXT NOT NULL,
              ${
                spec.table === "core_memory"
                  ? "content TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT ''"
                  : "label TEXT NOT NULL DEFAULT '', weight REAL NOT NULL DEFAULT 0.5, created_by TEXT NOT NULL DEFAULT ''"
              },
              team_id TEXT NOT NULL DEFAULT '${DEFAULT_ISOLATION_ID}',
              user_id TEXT NOT NULL DEFAULT '${DEFAULT_ISOLATION_ID}',
              agent_id TEXT NOT NULL DEFAULT '${DEFAULT_ISOLATION_ID}'
            )
          `);
          this.db
            .prepare(
              `INSERT INTO ${spec.table}_t12 (${dataSel}, team_id, user_id, agent_id) SELECT ${dataSel}, ${teamSel}, ?, ? FROM ${spec.table}`,
            )
            .run(backfill, backfill, backfill);
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
   * P2-T12（K1）：按租户 upsert —— 冲突目标为复合唯一索引 (slot, team_id, user_id, agent_id)，
   * 同 (slot,tenant) 幂等递增 version，不同租户同 slot 并存。
   * tenant 缺省 = default 桶（仅实例级内部调用方；HTTP handler 必须显式传入）。
   */
  upsertCore(slot: string, content: string, source = "manual", tenant?: CoreTenant): boolean {
    const t = normalizeCoreTenant(tenant);
    try {
      const prev = this.db
        .prepare("SELECT version FROM core_memory WHERE slot = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
        .get(slot, t.teamId, t.userId, t.agentId) as { version?: number } | undefined;
      const version = (prev?.version ?? 0) + 1;
      this.db
        .prepare(
          "INSERT INTO core_memory (slot, content, source, version, updated_at, team_id, user_id, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(slot, team_id, user_id, agent_id) DO UPDATE SET content=excluded.content, source=excluded.source, version=excluded.version, updated_at=excluded.updated_at",
        )
        .run(slot, content, source, version, new Date().toISOString(), t.teamId, t.userId, t.agentId);
      return true;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [core_memory] upsertCore failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** P2-T12（K1）：按租户读 —— 只返回本租户的 slots；返回结构不变（slots 数组）。 */
  readCore(
    tenant?: CoreTenant,
  ): Array<{ slot: string; content: string; source: string; version: number; updated_at: string }> {
    const t = normalizeCoreTenant(tenant);
    try {
      return (
        (this.db
          .prepare(
            "SELECT slot, content, source, version, updated_at FROM core_memory WHERE team_id = ? AND user_id = ? AND agent_id = ? ORDER BY slot",
          )
          .all(t.teamId, t.userId, t.agentId) as unknown as Array<{
          slot: string;
          content: string;
          source: string;
          version: number;
          updated_at: string;
        }>) ?? []
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 2026-11-07（T1）：数据清除阶段可能 DROP core_memory——表缺失按空结果处理（Panel values/list 不 500）。
      if (!/no such table/i.test(msg)) this.logger?.warn?.(`${TAG} [core_memory] readCore failed: ${msg}`);
      return [];
    }
  }

  /**
   * 自维护人格（m00527）：枚举有数据的租户。
   * 并集覆盖两条来源：已写槽的租户（core_memory）与已有人格条目的租户（soul_persona）——
   * 后者保证「槽被清空但人格已建」的 agent 仍继续跑生命周期与漂移判定。
   */
  listCoreTenants(): CoreTenant[] {
    try {
      const rows = this.db
        .prepare(
          // S10（2026-11-07）：清库后 core_memory / soul_persona 都是空的，若只按这两张表
          // 枚举租户，人格永远等不到第一个 tick（生产实测：重启后 skipped「无带数据的租户」）。
          // 有对话就有租户——新对话是重生的唯一入口，必须进枚举。
          "SELECT team_id, user_id, agent_id FROM core_memory " +
            "UNION SELECT team_id, user_id, agent_id FROM soul_persona " +
            "UNION SELECT team_id, user_id, agent_id FROM l0_conversations " +
            "ORDER BY team_id, user_id, agent_id",
        )
        .all() as unknown as Array<{ team_id: string; user_id: string; agent_id: string }>;
      return (rows ?? []).map((r) => ({ teamId: r.team_id, userId: r.user_id, agentId: r.agent_id }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such table/i.test(msg)) this.logger?.warn?.(`${TAG} [core_memory] listCoreTenants failed: ${msg}`);
      return [];
    }
  }

  /** S-FEEL-1（M1/IF-1）：近期情感信号只读查询——M1 近期基调行数据源（单一源聚合在 mood-line.ts，本方法只做取数）。
   *  只读零写库；租户三元组硬隔离（F18 同款）；occurred_at ≥ now−windowHours（UTC ISO 字典序）DESC 取 ≤maxSamples；
   *  valence IS NOT NULL（全 NULL 租户返回 []=基调行静默省略）。 */
  recentAffectSignals(
    tenant?: CoreTenant,
    opts?: { windowHours: number; maxSamples: number },
  ): Array<{ valence: number; arousal: number | null; occurred_at: string; excerpt?: string | null }> {
    const t = normalizeCoreTenant(tenant);
    const windowHours = Number(opts?.windowHours) > 0 ? Number(opts?.windowHours) : 72;
    const maxSamples = Number(opts?.maxSamples) > 0 ? Math.min(500, Math.floor(Number(opts?.maxSamples))) : 20;
    const sinceIso = new Date(Date.now() - windowHours * 3600e3).toISOString();
    try {
      return (
        (this.db
          .prepare(
            "SELECT valence, arousal, occurred_at, substr(COALESCE(content, ''), 1, 60) AS excerpt FROM l1_records WHERE team_id = ? AND user_id = ? AND agent_id = ? AND valence IS NOT NULL AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?",
          )
          .all(t.teamId, t.userId, t.agentId, sinceIso, maxSamples) as unknown as Array<{
          valence: number;
          arousal: number | null;
          occurred_at: string;
          excerpt: string | null;
        }>) ?? []
      );
    } catch (err) {
      this.logger?.warn?.(`${TAG} [recentAffectSignals] failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  /** #28（R5）：soul_state 单行 upsert/读（F18 三元组隔离；soul_snapshots 同款范式；
   *  抽取扩展门 on 才写——本方法本身不做门判断，门在调用方 l1-extractor）。 */
  writeSoulState(
    tenant: CoreTenant,
    state: {
      valence: number;
      arousal: number;
      baselineValence?: number | null;
      baselineArousal?: number | null;
      dominance?: number | null;
      baselineDominance?: number | null;
      sampleCount?: number | null;
      topValue?: string | null;
      turnSeq?: number | null;
      emotionObject?: string | null;
      emotionLabel?: string | null;
      emotionIntensity?: number | null;
      emotionAt?: string | null;
      updatedAt: string;
    },
  ): void {
    const t = normalizeCoreTenant(tenant);
    // 部分更新：undefined=本次不写（保留旧值），null=明确清空。
    // 旧实现用 INSERT OR REPLACE 把未传列写成 NULL。抽取旁路（l1-extractor，只写
    // valence/arousal/top_value/turn_seq）因此每轮都会把 emotion_*/baseline_*/
    // dominance/sample_count 抹掉——心境原因写下去就被另一个写者清空。
    // 改成单条 UPSERT 只更新调用方点名的列：无读-改-写竞态，也不会误清别人的列。
    const cols: Array<[string, SQLInputValue]> = [
      ["valence", state.valence],
      ["arousal", state.arousal],
      ["updated_at", state.updatedAt],
    ];
    const optional: Array<[string, SQLInputValue | undefined]> = [
      ["baseline_valence", state.baselineValence],
      ["baseline_arousal", state.baselineArousal],
      ["dominance", state.dominance],
      ["baseline_dominance", state.baselineDominance],
      ["sample_count", state.sampleCount],
      ["top_value", state.topValue],
      ["turn_seq", state.turnSeq],
      ["emotion_object", state.emotionObject],
      ["emotion_label", state.emotionLabel],
      ["emotion_intensity", state.emotionIntensity],
      ["emotion_at", state.emotionAt],
    ];
    for (const [col, v] of optional) if (v !== undefined) cols.push([col, v]);
    const keys = cols.map(([col]) => col);
    const marks = keys.map(() => "?").join(", ");
    const sets = keys.map((col) => `${col} = excluded.${col}`).join(", ");
    this.db
      .prepare(
        `INSERT INTO soul_state (team_id, user_id, agent_id, ${keys.join(", ")}) VALUES (?, ?, ?, ${marks}) ON CONFLICT(team_id, user_id, agent_id) DO UPDATE SET ${sets}`,
      )
      .run(t.teamId, t.userId, t.agentId, ...cols.map(([, v]) => v));
  }
  readSoulState(tenant: CoreTenant): {
    valence: number;
    arousal: number;
    baselineValence?: number | null;
    baselineArousal?: number | null;
    dominance?: number | null;
    baselineDominance?: number | null;
    sampleCount?: number | null;
    topValue?: string | null;
    turnSeq?: number | null;
    emotionObject?: string | null;
    emotionLabel?: string | null;
    emotionIntensity?: number | null;
    emotionAt?: string | null;
    updatedAt: string;
  } | null {
    const t = normalizeCoreTenant(tenant);
    const row = this.db
      .prepare(
        "SELECT valence, arousal, baseline_valence, baseline_arousal, dominance, baseline_dominance, sample_count, top_value, turn_seq, emotion_object, emotion_label, emotion_intensity, emotion_at, updated_at FROM soul_state WHERE team_id = ? AND user_id = ? AND agent_id = ?",
      )
      .get(t.teamId, t.userId, t.agentId) as unknown as
      | {
          valence: number;
          arousal: number;
          baseline_valence: number | null;
          baseline_arousal: number | null;
          dominance: number | null;
          baseline_dominance: number | null;
          sample_count: number | null;
          top_value: string | null;
          turn_seq: number | null;
          emotion_object: string | null;
          emotion_label: string | null;
          emotion_intensity: number | null;
          emotion_at: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      valence: row.valence,
      arousal: row.arousal,
      baselineValence: row.baseline_valence,
      baselineArousal: row.baseline_arousal,
      dominance: row.dominance,
      baselineDominance: row.baseline_dominance,
      sampleCount: row.sample_count,
      topValue: row.top_value,
      turnSeq: row.turn_seq,
      emotionObject: row.emotion_object,
      emotionLabel: row.emotion_label,
      emotionIntensity: row.emotion_intensity,
      emotionAt: row.emotion_at,
      updatedAt: row.updated_at,
    };
  }

  /* —— 自维护人格层（2026-11-05）：条目读/事务化提交/账本读 ——
   * 写面单点 commitSoulPersona：条目 upsert 与账本 append 同事务（半写状态不可接受，
   * 否则「账本说变了、库却没变」会让漂移与回滚全失真）；账本 INSERT OR IGNORE 幂等。
   * 读面容忍缺失（返回空数组），与既有 store 容错约定一致。 */
  listSoulPersona(tenant?: CoreTenant, opts?: { includeSuperseded?: boolean }): PersonaItem[] {
    const t = normalizeCoreTenant(tenant);
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM soul_persona WHERE team_id = ? AND user_id = ? AND agent_id = ? ORDER BY layer, item_id",
        )
        .all(t.teamId, t.userId, t.agentId) as unknown as Array<Record<string, unknown>>;
      const items = (rows ?? []).map(mapSoulPersonaRow);
      // 结论合并（P1-1）取代的行默认不出队：注入/组装/回流都只该看当前有效的结论。
      // 审计与回放显式要全量（includeSuperseded），不靠猜。
      // 注意判据带 state：frozen/merged 仍按原口径返回（既有测试与回滚路径都依赖它们可见）。
      if (opts?.includeSuperseded) return items;
      return items.filter((it) => !isSupersededItem(it));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_persona] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async commitSoulPersona(
    tenant: CoreTenant | undefined,
    plan: { upsert: PersonaItem[]; ledger: SoulLedgerEntry[] },
    opts?: { strictRule?: string; strictRuleSource?: string },
  ): Promise<{ upserted: number; ledgered: number; strictRule?: boolean; skippedHuman?: number }> {
    const t = normalizeCoreTenant(tenant);
    const upsert = this.db.prepare(`INSERT INTO soul_persona (
      item_id, team_id, user_id, agent_id, layer, text, state, weight, evidence_json, days_json,
      origins_json, created_at, updated_at, last_evidence_at, merged_into, aliases_json,
      contradictions, drift_json, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id, team_id, user_id, agent_id) DO UPDATE SET
      layer = excluded.layer, text = excluded.text, state = excluded.state,
      weight = excluded.weight, evidence_json = excluded.evidence_json,
      days_json = excluded.days_json, origins_json = excluded.origins_json,
      updated_at = excluded.updated_at, last_evidence_at = excluded.last_evidence_at,
      merged_into = excluded.merged_into, aliases_json = excluded.aliases_json,
      contradictions = excluded.contradictions, drift_json = excluded.drift_json,
      meta_json = excluded.meta_json`);
    const led = this.db.prepare(`INSERT OR IGNORE INTO soul_ledger (
      entry_id, team_id, user_id, agent_id, at, trigger, layer, item_id, action,
      before_hash, after_hash, gates_json, reason, evidence_json, prompt_version, model, before_json, protocol_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // 单写者（2026-11-08）：human 层只能由人物档案提炼器写，而它的每条行都带 meta.person.key。
    // 这里是最后一道门：没有主人的 human 行一律不落库（跳过而不是抛错，避免一条脏候选毁掉整轮提交），
    // 计数回给调用方，让「第二个写者又回来了」这件事在报表里可见，而不是静默生效。
    const ownedUpsert = plan.upsert.filter((it) => it.layer !== "human" || personKeyOfPersonaItem(it) !== "");
    const skippedHuman = plan.upsert.length - ownedUpsert.length;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const it of ownedUpsert) {
        upsert.run(
          it.itemId,
          t.teamId,
          t.userId,
          t.agentId,
          it.layer,
          it.text,
          it.state,
          it.weight,
          JSON.stringify(it.evidenceIds ?? []),
          JSON.stringify(it.evidenceDays ?? []),
          JSON.stringify(it.evidenceOrigins ?? []),
          it.createdAt,
          it.updatedAt,
          it.lastEvidenceAt,
          it.mergedInto ?? null,
          it.aliases ? JSON.stringify(it.aliases) : null,
          it.contradictions ?? 0,
          it.driftHistory ? JSON.stringify(it.driftHistory) : null,
          personaMetaJson(it),
        );
      }
      let ledgered = 0;
      for (const e of plan.ledger) {
        // 只数真正新落库的行（INSERT OR IGNORE 幂等）：重复 entryId 不算写入，
        // 否则「账本说写了 N 条」会被重放/重试虚增。
        const info = led.run(
          e.entryId,
          t.teamId,
          t.userId,
          t.agentId,
          e.at,
          e.trigger,
          e.layer ?? null,
          e.itemId ?? null,
          e.action,
          e.beforeHash ?? null,
          e.afterHash ?? null,
          JSON.stringify(e.gates ?? []),
          e.reason ?? "",
          JSON.stringify(e.evidenceIds ?? []),
          e.promptVersion ?? null,
          e.model ?? null,
          e.before ? JSON.stringify(e.before) : null,
          // 判据 13：账本必须能追「哪版规则判的」。漂移/准入/冻结等生产方显式给
          // TRAIT_PROTOCOL_VERSION；cadence/alert 这类运营行不带，落当前协议版本兜底，
          // 避免 NULL 让「按版本归因」出现空洞（生产实测 18 行 NULL 全是 cadence）。
          e.protocolVersion ?? "v1",
        );
        ledgered += Number(info.changes ?? 0) > 0 ? 1 : 0;
      }
      // S6：红线投影（strict_rule）与 persona/账本同事务——要么都落，要么都不落。
      // 与 upsertCore 同款 SQL（:3321-3341），version 幂等递增；内容逐字（判据 2 要求 100% 覆盖）。
      let strictRule = false;
      if (typeof opts?.strictRule === "string") {
        const prev = this.db
          .prepare("SELECT version FROM core_memory WHERE slot = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
          .get("strict_rule", t.teamId, t.userId, t.agentId) as { version?: number } | undefined;
        this.db
          .prepare(
            "INSERT INTO core_memory (slot, content, source, version, updated_at, team_id, user_id, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
              "ON CONFLICT(slot, team_id, user_id, agent_id) DO UPDATE SET content=excluded.content, source=excluded.source, version=excluded.version, updated_at=excluded.updated_at",
          )
          .run(
            "strict_rule",
            opts.strictRule,
            opts.strictRuleSource ?? "soul-redline",
            (prev?.version ?? 0) + 1,
            new Date().toISOString(),
            t.teamId,
            t.userId,
            t.agentId,
          );
        strictRule = true;
      }
      this.db.exec("COMMIT");
      return {
        upserted: ownedUpsert.length,
        ledgered,
        ...(strictRule ? { strictRule } : {}),
        ...(skippedHuman > 0 ? { skippedHuman } : {}),
      };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 已在回滚态 */
      }
      throw err;
    }
  }

  /** 条目级回滚（A7 回滚演练的落点）：只回滚点名的 itemId，每次写一条 action=rollback 账本。
   *  语义 = 把条目恢复到「最近一次非回滚变更之前」的快照；该变更若原本是新建（before=null），
   *  回滚即删除该条目。全程单事务；不改其它租户/条目；重复回滚幂等为空操作（无变更可找）。
   *  不提供「一键全量回滚」：那等于把人格历史整段抹掉，回滚也必须可审计、可点名。 */
  rollbackSoulPersona(
    tenant: CoreTenant | undefined,
    itemIds: string[],
    opts?: { now?: string; reason?: string; gate?: string },
  ): { restored: number; removed: number; skipped: number } {
    const t = normalizeCoreTenant(tenant);
    const now = opts?.now ?? new Date().toISOString();
    const ids = [...new Set((itemIds ?? []).map((s) => String(s).trim()).filter(Boolean))];
    let restored = 0;
    let removed = 0;
    let skipped = 0;
    if (ids.length === 0) return { restored, removed, skipped };
    const latest = this.db.prepare(
      `SELECT * FROM soul_ledger WHERE team_id = ? AND user_id = ? AND agent_id = ? AND item_id = ?
       AND action <> 'rollback' ORDER BY at DESC, entry_id DESC LIMIT 1`,
    );
    const current = this.db.prepare(
      "SELECT * FROM soul_persona WHERE item_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
    );
    const del = this.db.prepare(
      "DELETE FROM soul_persona WHERE item_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
    );
    const upsert = this.db.prepare(`INSERT INTO soul_persona (
      item_id, team_id, user_id, agent_id, layer, text, state, weight, evidence_json, days_json,
      origins_json, created_at, updated_at, last_evidence_at, merged_into, aliases_json,
      contradictions, drift_json, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id, team_id, user_id, agent_id) DO UPDATE SET
      layer = excluded.layer, text = excluded.text, state = excluded.state,
      weight = excluded.weight, evidence_json = excluded.evidence_json,
      days_json = excluded.days_json, origins_json = excluded.origins_json,
      updated_at = excluded.updated_at, last_evidence_at = excluded.last_evidence_at,
      merged_into = excluded.merged_into, aliases_json = excluded.aliases_json,
      contradictions = excluded.contradictions, drift_json = excluded.drift_json,
      meta_json = excluded.meta_json`);
    const led = this.db.prepare(`INSERT OR IGNORE INTO soul_ledger (
      entry_id, team_id, user_id, agent_id, at, trigger, layer, item_id, action,
      before_hash, after_hash, gates_json, reason, evidence_json, prompt_version, model, before_json, protocol_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const hash = (v: unknown): string => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        const row = latest.get(t.teamId, t.userId, t.agentId, id) as Record<string, unknown> | undefined;
        if (!row) {
          skipped += 1;
          continue;
        }
        const raw = row.before_json;
        const before = typeof raw === "string" && raw !== "" ? (JSON.parse(raw) as PersonaItem) : null;
        const curRow = current.get(id, t.teamId, t.userId, t.agentId) as Record<string, unknown> | undefined;
        const cur = curRow ? mapSoulPersonaRow(curRow) : null;
        if (before) {
          upsert.run(
            before.itemId,
            t.teamId,
            t.userId,
            t.agentId,
            before.layer,
            before.text,
            before.state,
            before.weight,
            JSON.stringify(before.evidenceIds ?? []),
            JSON.stringify(before.evidenceDays ?? []),
            JSON.stringify(before.evidenceOrigins ?? []),
            before.createdAt,
            now,
            before.lastEvidenceAt,
            before.mergedInto ?? null,
            before.aliases ? JSON.stringify(before.aliases) : null,
            before.contradictions ?? 0,
            before.driftHistory ? JSON.stringify(before.driftHistory) : null,
            before.meta ? JSON.stringify(before.meta) : null,
          );
          restored += 1;
        } else {
          del.run(id, t.teamId, t.userId, t.agentId);
          removed += 1;
        }
        led.run(
          `rb-${hash({ id, now, before: before?.itemId ?? null })}`,
          t.teamId,
          t.userId,
          t.agentId,
          now,
          "rollback",
          before?.layer ?? cur?.layer ?? null,
          id,
          "rollback",
          cur ? hash(cur) : null,
          before ? hash(before) : null,
          JSON.stringify([opts?.gate ?? "manual_rollback"]),
          opts?.reason ?? "条目级回滚：恢复到最近一次变更前的快照",
          JSON.stringify(before?.evidenceIds ?? cur?.evidenceIds ?? []),
          null,
          null,
          cur ? JSON.stringify(cur) : null,
          null,
        );
      }
      this.db.exec("COMMIT");
      return { restored, removed, skipped };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 已在回滚态 */
      }
      throw err;
    }
  }

  listSoulLedger(tenant?: CoreTenant, limit = 100): SoulLedgerEntry[] {
    const t = normalizeCoreTenant(tenant);
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM soul_ledger WHERE team_id = ? AND user_id = ? AND agent_id = ? ORDER BY at DESC, entry_id DESC LIMIT ?",
        )
        .all(t.teamId, t.userId, t.agentId, n) as unknown as Array<Record<string, unknown>>;
      return (rows ?? []).map(mapSoulLedgerRow);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_ledger] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  /* —— 特质层（soul_trait_state / soul_trait_label，2026-11-07 S1/S4）——
   * 六轴 state 是人格漂移的唯一事实源；标签是方向视图，不存独立权重。
   * 读面容忍缺失（未初始化=零向量），写面整体覆盖（单行/租户）。 */
  readSoulTraitState(tenant?: CoreTenant): { state: AxisVector; seedState: AxisVector; updatedAt: string } | null {
    const t = normalizeCoreTenant(tenant);
    try {
      const row = this.db
        .prepare(
          "SELECT axis_json, seed_state_json, updated_at FROM soul_trait_state WHERE team_id = ? AND user_id = ? AND agent_id = ?",
        )
        .get(t.teamId, t.userId, t.agentId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        state: toAxisVector(row.axis_json),
        seedState: toAxisVector(row.seed_state_json),
        updatedAt: String(row.updated_at ?? ""),
      };
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_trait_state] read failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  writeSoulTraitState(
    tenant: CoreTenant | undefined,
    input: { state: AxisVector; seedState?: AxisVector; updatedAt?: string },
  ): void {
    const t = normalizeCoreTenant(tenant);
    const now = input.updatedAt ?? new Date().toISOString();
    const prev = this.readSoulTraitState(tenant);
    const seed = input.seedState ?? prev?.seedState ?? emptyAxisVector();
    this.db
      .prepare(
        `INSERT INTO soul_trait_state (team_id, user_id, agent_id, axis_json, seed_state_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, user_id, agent_id) DO UPDATE SET
           axis_json = excluded.axis_json, seed_state_json = excluded.seed_state_json, updated_at = excluded.updated_at`,
      )
      .run(
        t.teamId,
        t.userId,
        t.agentId,
        JSON.stringify(axisVectorToArray(input.state)),
        JSON.stringify(axisVectorToArray(seed)),
        now,
      );
  }

  listSoulTraitLabels(tenant?: CoreTenant): TraitLabelRow[] {
    const t = normalizeCoreTenant(tenant);
    try {
      const rows = this.db
        .prepare("SELECT * FROM soul_trait_label WHERE tenant_id = ? ORDER BY label")
        .all(t.teamId) as unknown as Array<Record<string, unknown>>;
      return (rows ?? []).map(mapSoulTraitLabelRow);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_trait_label] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  commitSoulTraitLabels(tenant: CoreTenant | undefined, rows: TraitLabelRow[]): { upserted: number } {
    const t = normalizeCoreTenant(tenant);
    if (!rows || rows.length === 0) return { upserted: 0 };
    const stmt = this.db.prepare(
      `INSERT INTO soul_trait_label (tenant_id, label, definition, gloss, anchor, direction_json, evidence, status, first_seen, last_seen, aliases_json, protocol_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, label) DO UPDATE SET
         definition = excluded.definition, gloss = excluded.gloss, anchor = excluded.anchor,
         direction_json = excluded.direction_json, evidence = excluded.evidence, status = excluded.status,
         last_seen = excluded.last_seen, aliases_json = excluded.aliases_json, protocol_version = excluded.protocol_version`,
    );
    let upserted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) {
        stmt.run(
          t.teamId,
          r.label,
          r.definition,
          r.gloss,
          r.anchor,
          JSON.stringify(axisVectorToArray(r.direction)),
          r.evidence,
          r.status,
          r.firstSeen,
          r.lastSeen,
          JSON.stringify(r.aliases ?? []),
          r.protocolVersion,
        );
        upserted += 1;
      }
      this.db.exec("COMMIT");
      return { upserted };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 已在回滚态 */
      }
      throw err;
    }
  }

  /* —— 事件层（soul_episodes，2026-11-05）——
   * 写幂等（episode_id 主键，重跑同一天不翻倍）；读按时间倒序；检索用 LIKE 覆盖
   * 标题/对象/双方立场/代价/原话——「上次因为什么恼火、对谁、多强」四问都能碰。
   * 拒绝统计自 P0-2 起走 soul_gate_stats（按 day/code/layer 聚合），不再逐条落账本。 */
  commitSoulEpisodes(tenant: CoreTenant | undefined, episodes: SoulEpisode[]): { inserted: number } {
    const t = normalizeCoreTenant(tenant);
    if (!episodes || episodes.length === 0) return { inserted: 0 };
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO soul_episodes (
      episode_id, team_id, user_id, agent_id, at, day, kind, title, object, participants_json,
      user_stance, agent_stance, cost, outcome, valence, arousal, intensity, affect_source,
      evidence_json, session_id, quote_json, signals_json, layers_json, persons_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // 事件是 L0 的派生缓存：同一条 record 重新挖出来时，立场/原话/强度都应按当前判据刷新。
    // 旧版本用「不覆盖原话」保历史，结果早期挖掘把助手自己的话写进 user_stance 后永远洗不掉，
    // 自我史就会把「我怀疑接口有问题」当成「他当面否定我」。只刷新本轮重新挖到的行（不在本轮窗口的行不动）。
    const refresh = this.db.prepare(
      "UPDATE soul_episodes SET kind = ?, title = ?, participants_json = ?, user_stance = ?, agent_stance = ?, cost = ?, outcome = ?, valence = ?, arousal = ?, intensity = ?, affect_source = ?, evidence_json = ?, quote_json = ?, signals_json = ?, layers_json = ?, persons_json = ?, archived_at = NULL WHERE episode_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
    );
    // 对象另走一条：只在新对象是稳定原因、旧对象不是时更新，避免把短噪声写回去。
    const refine = this.db.prepare(
      "UPDATE soul_episodes SET object = ? WHERE episode_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND object <> ? AND length(object) > 20",
    );
    let inserted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const e of episodes) {
        const info = stmt.run(
          e.episodeId,
          t.teamId,
          t.userId,
          t.agentId,
          e.at,
          e.day,
          e.kind,
          e.title ?? "",
          e.object ?? "",
          JSON.stringify(e.participants ?? []),
          e.userStance ?? "",
          e.agentStance ?? "",
          e.cost ?? "",
          e.outcome ?? "",
          e.valence ?? 0,
          e.arousal ?? 0,
          e.intensity ?? 0,
          e.affectSource ?? "lexicon",
          JSON.stringify(e.evidenceIds ?? []),
          e.sessionId ?? "",
          e.quote ? JSON.stringify(e.quote) : null,
          JSON.stringify(e.signals ?? []),
          e.layers && e.layers.length > 0 ? JSON.stringify(e.layers) : null,
          // 空数组写 NULL：读回 undefined（「解析不出人」），而不是 []（「有名单但空」）。
          e.persons && e.persons.length > 0 ? JSON.stringify(e.persons) : null,
        );
        inserted += Number(info.changes ?? 0) > 0 ? 1 : 0;
        const next = (e.object ?? "").trim();
        if (Number(info.changes ?? 0) === 0) {
          refresh.run(
            e.kind,
            e.title ?? "",
            JSON.stringify(e.participants ?? []),
            e.userStance ?? "",
            e.agentStance ?? "",
            e.cost ?? "",
            e.outcome ?? "",
            e.valence ?? 0,
            e.arousal ?? 0,
            e.intensity ?? 0,
            e.affectSource ?? "lexicon",
            JSON.stringify(e.evidenceIds ?? []),
            e.quote ? JSON.stringify(e.quote) : null,
            JSON.stringify(e.signals ?? []),
            // 层是当前判据的判定结果：本轮判为「无层」（纯上下文）就把旧值清空，不留陈旧层。
            e.layers && e.layers.length > 0 ? JSON.stringify(e.layers) : null,
            // 人员名单同理：本轮解析不出人就把旧名单清空，不把上一轮的人留在事件上。
            e.persons && e.persons.length > 0 ? JSON.stringify(e.persons) : null,
            e.episodeId,
            t.teamId,
            t.userId,
            t.agentId,
          );
          if (next !== "" && next.length <= 20) refine.run(next, e.episodeId, t.teamId, t.userId, t.agentId, next);
        }
        // P0-C/P1-A 双写（spec §5.1–§5.2）：同一事务内把这条 episode 落成「根事件 + 行动子事件」。
        // 用 upsert 不用 insert：refresh 路径（同 episodeId 重挖）要整行覆盖；insert 会撞主键报错。
        // 这里不 try/catch——双写失败必须让整个 commitSoulEpisodes 回滚，否则旧表会留下单边写入，
        // 而单边写入正是对账（soulEventParity）要抓的那种不一致。
        const writes = soulEventWritesFromEpisode(e, this.soulActionSourceMessages(t, e));
        // 重挖后某个动作可能不再成立（判据收紧/引文改变）：旧子事件不能留成孤儿。
        // 只删「这次不再产出的」子事件；同 id 的交给 upsert 覆盖，避免无谓删掉已有反思引用。
        const keepChildIds = new Set(writes.slice(1).map((w) => w.event.event_id));
        const staleChildren = this.db
          .prepare(
            "SELECT event_id FROM soul_events WHERE team_id = ? AND user_id = ? AND agent_id = ? AND parent_event_id = ? AND source_kind IN ('tool','test','commit','rollback')",
          )
          .all(t.teamId, t.userId, t.agentId, e.episodeId) as Array<{ event_id?: string }>;
        for (const row of staleChildren) {
          const childId = String(row.event_id ?? "");
          if (childId !== "" && !keepChildIds.has(childId)) {
            deleteSoulEventInTransaction(this.db, t, childId);
          }
        }
        for (const write of writes) upsertSoulEventInTransaction(this.db, t, write);
      }
      this.db.exec("COMMIT");
      return { inserted };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 已在回滚态 */
      }
      throw err;
    }
  }

  /**
   * S3：删除改为归档（archived_at）。事件是派生视图，判据收紧时让行退出使用，
   * 但保留可回溯——「上次因为什么」的账不能物理消失。返回 archived 计数。
   */
  deleteSoulEpisodes(tenant: CoreTenant | undefined, episodeIds: string[]): { deleted: number; archived: number } {
    const t = normalizeCoreTenant(tenant);
    const ids = (episodeIds ?? []).filter((id) => typeof id === "string" && id.startsWith("ep-"));
    if (ids.length === 0) return { deleted: 0, archived: 0 };
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE soul_episodes SET archived_at = ? WHERE episode_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND archived_at IS NULL",
    );
    // P0-C2：归档只写旧表会让 new 读（soul_events.archived_at）看不见归档——同一条事务里同步新表，
    // 否则切读那天「删掉的事件」会在新读法里复活。新表没有对应行时 changes=0，不报错（过渡期常见）。
    const eventStmt = this.db.prepare(
      "UPDATE soul_events SET archived_at = ? WHERE event_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND archived_at IS NULL",
    );
    // P1-A：归档父事件时子事件一起退出使用；否则 new 读虽过滤 chat，listSoulEvents 仍会把子事件
    // 当活事件返回（查询/对账/未来 UI 都会看见已归档父事件的行动残片）。
    const childEventStmt = this.db.prepare(
      "UPDATE soul_events SET archived_at = ? WHERE parent_event_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND archived_at IS NULL",
    );
    let archived = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        archived += Number(stmt.run(now, id, t.teamId, t.userId, t.agentId).changes ?? 0);
        eventStmt.run(now, id, t.teamId, t.userId, t.agentId);
        childEventStmt.run(now, id, t.teamId, t.userId, t.agentId);
      }
      this.db.exec("COMMIT");
      return { deleted: 0, archived };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 已在回滚态 */
      }
      throw err;
    }
  }

  /**
   * 把事件标记为「已积进心境」。只在心境落库成功之后调用，失败就停在未标记态，
   * 下一 tick 会重试（宁可重复积一次，也不丢事件——重复的代价是权重偏一点）。
   */
  markSoulEpisodesMoodIntegrated(
    tenant: CoreTenant | undefined,
    episodeIds: string[],
    at: string,
  ): { updated: number } {
    const t = normalizeCoreTenant(tenant);
    const ids = (episodeIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return { updated: 0 };
    const stmt = this.db.prepare(
      "UPDATE soul_episodes SET mood_integrated_at = ? WHERE episode_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND mood_integrated_at IS NULL",
    );
    // P0-C2：同一事务同步 chat 子表（事件级标记在旧表，展示字段在新表 chat）。
    // 旧表没有任何新行时不报错（过渡期：只有旧表的 episode 也要能正常标记）。
    const chatStmt = this.db.prepare(
      "UPDATE soul_event_chat SET mood_integrated_at = ? WHERE event_id = ? AND mood_integrated_at IS NULL",
    );
    let updated = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        const info = stmt.run(at, id, t.teamId, t.userId, t.agentId);
        updated += Number(info.changes ?? 0) > 0 ? 1 : 0;
        chatStmt.run(at, id);
      }
      this.db.exec("COMMIT");
      return { updated };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 已在回滚态 */
      }
      throw err;
    }
  }

  listSoulEpisodes(
    tenant?: CoreTenant,
    opts?: { since?: string; limit?: number; kind?: SoulEpisode["kind"]; includeArchived?: boolean },
  ): SoulEpisode[] {
    const t = normalizeCoreTenant(tenant);
    // P0-C 切读开关（只影响读，不影响写）：缺省/legacy 原样走旧表读法——这是默认读面与回滚路径，
    // 逐字节不改；TDB_SOUL_EVENT_READ_MODE=new 才读 soul_events + chat + evidence。
    if (currentSoulEventReadMode() === "new") {
      const viaEvents = this.readSoulEpisodesViaEvents(t, opts);
      // null = 新表拼不回一条完整的 SoulEpisode（缺 chat 行，或缺 participants 展示名——新表没有
      // participants 列，展示名只能按 event_id 回旧表 join）。这时整次回落 legacy：
      // 宁可读旧表，也不用空数组/角色名伪造「谁在场」；等 P2 迁移把展示名搬进新表再全切。
      if (viaEvents !== null) return viaEvents;
      this.logger?.warn?.(
        `${TAG} [soul_episodes] 新表映射不完整（缺 chat 行或 participants 展示名），本次回落 legacy 读`,
      );
    }
    return this.listSoulEpisodesLegacy(t, opts);
  }

  /** 旧表读法：P0-C 之前 listSoulEpisodes 的原样实现，**逐字节保留**（默认读面 + 回滚路径）。 */
  private listSoulEpisodesLegacy(
    t: CoreTenant,
    opts?: { since?: string; limit?: number; kind?: SoulEpisode["kind"]; includeArchived?: boolean },
  ): SoulEpisode[] {
    const limit = Math.max(1, Math.min(2000, Math.floor(opts?.limit ?? 200)));
    try {
      const where = ["team_id = ?", "user_id = ?", "agent_id = ?"];
      const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
      // 归档行默认退出使用；只有派生历史（S3）显式要求 includeArchived 时才读。
      if (!opts?.includeArchived) where.push("archived_at IS NULL");
      if (opts?.since) {
        where.push("at >= ?");
        args.push(opts.since);
      }
      if (opts?.kind) {
        where.push("kind = ?");
        args.push(opts.kind);
      }
      args.push(limit);
      const rows = this.db
        .prepare(`SELECT * FROM soul_episodes WHERE ${where.join(" AND ")} ORDER BY at DESC, episode_id DESC LIMIT ?`)
        .all(...(args as SQLInputValue[])) as unknown as Array<Record<string, unknown>>;
      return (rows ?? []).map(mapSoulEpisodeRow);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_episodes] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * P0-C 新表读法：soul_events + soul_event_chat + soul_event_evidence 拼回 SoulEpisode。
   *
   * 拼装策略是「把新表读成旧表的行形态，再交给同一个 mapSoulEpisodeRow」——不写第二套 mapper，
   * 所以 kind 白名单回落、affectSource 归一、空数组 vs NULL（signals/layers/persons/quote）这些口径
   * 与 legacy 读逐条一致。这正是 soul-event-dualwrite 里「new 读与 legacy 深等」能成立的原因。
   *
   * 两处**过渡态**限制（P0 阶段新表信息不足以自洽，宁可回落也不编）：
   *  1. participants（谁在场）新表没有列，只能 join 旧表 participants_json；join 不到返回 null。
   *  2. evidenceIds 的顺序：旧表保留挖掘时的原数组顺序，新表只能按 evidence 行的
   *     (at, record_id, role) 读回，即同 at 下按 record_id 升序。两者仅当原顺序本就是
   *     record_id 升序时逐字节一致；顺序差异不影响成员集合（对账比的是集合）。
   *
   * 返回 null = 本次读不出完整事件，调用方回落 legacy。
   */
  private readSoulEpisodesViaEvents(
    t: CoreTenant,
    opts?: { since?: string; limit?: number; kind?: SoulEpisode["kind"]; includeArchived?: boolean },
  ): SoulEpisode[] | null {
    const limit = Math.max(1, Math.min(2000, Math.floor(opts?.limit ?? 200)));
    const where = ["e.team_id = ?", "e.user_id = ?", "e.agent_id = ?"];
    const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
    if (!opts?.includeArchived) where.push("e.archived_at IS NULL");
    if (opts?.since) {
      where.push("e.at >= ?");
      args.push(opts.since);
    }
    if (opts?.kind) {
      where.push("c.kind = ?");
      args.push(opts.kind);
    }
    return this.querySoulEpisodesViaEvents(where, args, limit);
  }

  /**
   * 新表读法的共用内核：list 与 search 都走这里，只有 WHERE 不同。
   * 单独抽出来是为了**不出现第二套 mapper**——两套 mapper 迟早口径分叉，
   * 而「new 读与 legacy 深等」正是靠共用 mapSoulEpisodeRow 才成立的。
   *
   * where 里的列名必须带 e./c. 前缀（join 后同名列会歧义）。返回 null = 本次拼不回完整事件。
   */
  private querySoulEpisodesViaEvents(
    where: string[],
    args: Array<string | number>,
    limit: number,
  ): SoulEpisode[] | null {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = this.db
        .prepare(
          `SELECT e.event_id AS event_id, e.at AS at, e.day AS day, e.object AS object, e.outcome AS outcome,
                  e.session_id AS session_id, e.persons_json AS persons_json, e.archived_at AS archived_at,
                  c.kind AS chat_kind, c.title AS chat_title, c.user_stance AS user_stance,
                  c.agent_stance AS agent_stance, c.cost AS cost, c.valence AS valence,
                  c.arousal AS arousal, c.intensity AS intensity, c.affect_source AS affect_source,
                  c.quote_json AS quote_json, c.signals_json AS signals_json, c.layers_json AS layers_json,
                  c.mood_integrated_at AS mood_integrated_at, p.participants_json AS participants_json
             FROM soul_events e
             LEFT JOIN soul_event_chat c ON c.event_id = e.event_id
             LEFT JOIN soul_episodes p
                    ON p.episode_id = e.event_id
                   AND p.team_id = e.team_id AND p.user_id = e.user_id AND p.agent_id = e.agent_id
            WHERE e.source_kind = 'chat' AND ${where.join(" AND ")}
            ORDER BY e.at DESC, e.event_id DESC
            LIMIT ?`,
        )
        .all(...(args as SQLInputValue[]), limit) as unknown as Array<Record<string, unknown>>;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_events] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const episodes: SoulEpisode[] = [];
    for (const row of rows ?? []) {
      if (row.chat_kind === null || row.chat_kind === undefined) return null;
      if (row.participants_json === null || row.participants_json === undefined) return null;
      const eventId = String(row.event_id ?? "");
      const evidenceIds = listSoulEventEvidence(this.db, eventId).map((e) => String(e.record_id));
      episodes.push(
        mapSoulEpisodeRow({
          episode_id: eventId,
          at: row.at,
          day: row.day,
          kind: row.chat_kind,
          title: row.chat_title,
          object: row.object,
          participants_json: row.participants_json,
          user_stance: row.user_stance,
          agent_stance: row.agent_stance,
          cost: row.cost,
          outcome: row.outcome,
          valence: row.valence,
          arousal: row.arousal,
          intensity: row.intensity,
          affect_source: row.affect_source,
          evidence_json: JSON.stringify(evidenceIds),
          session_id: row.session_id,
          quote_json: row.quote_json,
          signals_json: row.signals_json,
          layers_json: row.layers_json,
          persons_json: row.persons_json,
          archived_at: row.archived_at,
          mood_integrated_at: row.mood_integrated_at,
        }),
      );
    }
    return episodes;
  }

  /**
   * 新表搜法：过滤口径与 legacy searchSoulEpisodes 一一对应（text 覆盖 7 个字段、object/kind/since、
   * archived_at IS NULL、ORDER BY at DESC, episode_id DESC、limit），只是把列换成 e./c. 前缀，
   * 再交给同一个 querySoulEpisodesViaEvents 拼装——所以结果与 legacy 深等。
   */
  private searchSoulEpisodesViaEvents(
    t: CoreTenant,
    query: { text?: string; object?: string; kind?: SoulEpisode["kind"]; since?: string; limit?: number },
    limit: number,
  ): SoulEpisode[] | null {
    const where = ["e.team_id = ?", "e.user_id = ?", "e.agent_id = ?", "e.archived_at IS NULL"];
    const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
    if (query?.object) {
      where.push("e.object LIKE ?");
      args.push(`%${query.object}%`);
    }
    if (query?.kind) {
      where.push("c.kind = ?");
      args.push(query.kind);
    }
    if (query?.since) {
      where.push("e.at >= ?");
      args.push(query.since);
    }
    const text = (query?.text ?? "").trim();
    if (text !== "") {
      const like = `%${text}%`;
      where.push(
        "(c.title LIKE ? OR e.object LIKE ? OR c.user_stance LIKE ? OR c.agent_stance LIKE ? OR c.cost LIKE ? OR e.outcome LIKE ? OR c.quote_json LIKE ?)",
      );
      args.push(like, like, like, like, like, like, like);
    }
    return this.querySoulEpisodesViaEvents(where, args, limit);
  }

  searchSoulEpisodes(
    tenant: CoreTenant | undefined,
    query: { text?: string; object?: string; kind?: SoulEpisode["kind"]; since?: string; limit?: number },
  ): SoulEpisode[] {
    const t = normalizeCoreTenant(tenant);
    const limit = Math.max(1, Math.min(200, Math.floor(query?.limit ?? 20)));
    // P0-C2：切读开关同样管 search——否则 new 模式下「列表读新表、搜索读旧表」，
    // 两条读面口径分叉，切读等于没切。
    if (currentSoulEventReadMode() === "new") {
      const viaEvents = this.searchSoulEpisodesViaEvents(t, query, limit);
      if (viaEvents !== null) return viaEvents;
      this.logger?.warn?.(
        `${TAG} [soul_episodes] 搜索的新表映射不完整（缺 chat 行或 participants 展示名），本次回落 legacy 搜`,
      );
    }
    return this.searchSoulEpisodesLegacy(t, query, limit);
  }

  /** 旧表搜法：P0-C2 之前 searchSoulEpisodes 的原样实现，口径逐字节保留（默认读面 + 回滚路径）。 */
  private searchSoulEpisodesLegacy(
    t: CoreTenant,
    query: { text?: string; object?: string; kind?: SoulEpisode["kind"]; since?: string; limit?: number },
    limit: number,
  ): SoulEpisode[] {
    try {
      const where = ["team_id = ?", "user_id = ?", "agent_id = ?", "archived_at IS NULL"];
      const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
      if (query?.object) {
        where.push("object LIKE ?");
        args.push(`%${query.object}%`);
      }
      if (query?.kind) {
        where.push("kind = ?");
        args.push(query.kind);
      }
      if (query?.since) {
        where.push("at >= ?");
        args.push(query.since);
      }
      const text = (query?.text ?? "").trim();
      if (text !== "") {
        const like = `%${text}%`;
        where.push(
          "(title LIKE ? OR object LIKE ? OR user_stance LIKE ? OR agent_stance LIKE ? OR cost LIKE ? OR outcome LIKE ? OR quote_json LIKE ?)",
        );
        args.push(like, like, like, like, like, like, like);
      }
      args.push(limit);
      const rows = this.db
        .prepare(`SELECT * FROM soul_episodes WHERE ${where.join(" AND ")} ORDER BY at DESC, episode_id DESC LIMIT ?`)
        .all(...(args as SQLInputValue[])) as unknown as Array<Record<string, unknown>>;
      return (rows ?? []).map(mapSoulEpisodeRow);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_episodes] search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /* —— 事件底座（soul_events，P0-C 2026-11-10）——
   * 读写都直接转调 P0-B 的纯 store（同一 db 句柄、同一套列清单与校验）。
   * 这里只做两件事：补上 MemoryCore 的租户归一化（CoreTenant|undefined），以及
   * 「读失败给空、写失败抛错」的容错口径（与旧表方法一致）。 */
  listSoulEvents(tenant?: CoreTenant, filter?: SoulEventListFilter): SoulEventRow[] {
    const t = normalizeCoreTenant(tenant);
    try {
      return listSoulEventRows(this.db, t, filter);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_events] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** 一批事件一个事务：全落或全不落（P1 直接用；refresh 语义走 upsert，不撞主键）。 */
  commitSoulEvents(tenant: CoreTenant | undefined, writes: SoulEventWrite[]): { upserted: number } {
    const t = normalizeCoreTenant(tenant);
    if (!writes || writes.length === 0) return { upserted: 0 };
    let upserted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const write of writes) {
        upsertSoulEventInTransaction(this.db, t, write);
        upserted += 1;
      }
      this.db.exec("COMMIT");
      return { upserted };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 已在回滚态 */
      }
      throw err;
    }
  }

  /** 一条事件的完整投影（基表 + 三张子表 + 证据）；读失败返回 null，与其它读面「读空不抛」一致。 */
  getSoulEventDetail(tenant: CoreTenant | undefined, eventId: string): SoulEventDetail | null {
    const t = normalizeCoreTenant(tenant);
    try {
      return getSoulEventDetailRow(this.db, t, eventId);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_events] detail failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * P1-A：行动切分只认 assistant 原话。episode.quote 在生产里是 user 那一侧（契機句），
   * 所以从 evidenceIds 回查 L0，按租户过滤，只把 role=assistant 的行交给切分器。
   *
   * 这一层不猜 record_id：查不到 assistant 行就返回空，宁可不产行动事件，也不拿用户原话
   * 冒充「我说过/我做过」的证据。
   */
  private soulActionSourceMessages(t: CoreTenant, e: SoulEpisode): SoulActionSourceMessage[] {
    const ids = Array.from(
      new Set((e.evidenceIds ?? []).map((id) => String(id ?? "").trim()).filter((id) => id !== "")),
    );
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    try {
      const rows = this.db
        .prepare(
          `SELECT record_id, message_text, recorded_at FROM l0_conversations
            WHERE record_id IN (${placeholders}) AND team_id = ? AND user_id = ? AND agent_id = ? AND role = 'assistant'`,
        )
        .all(...(ids as SQLInputValue[]), t.teamId, t.userId, t.agentId) as Array<{
        record_id?: string;
        message_text?: string;
        recorded_at?: string;
      }>;
      return rows
        .map((row) => ({
          recordId: String(row.record_id ?? "").trim(),
          text: String(row.message_text ?? "").trim(),
          at: String(row.recorded_at ?? "").trim() || e.at,
          role: "assistant",
        }))
        .filter((row) => row.recordId !== "" && row.text !== "");
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_events] 取 assistant 原话失败，本次不切行动子事件: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * 双写对账（spec §5.3）：只读，不修旧行——对不上就报出来，改数据是人的决定。
   *
   * 比的是「同一件事在两个表里是否还是同一件事」：event_id 对得上、chat 行在、
   * 基础字段（at/day/kind/title/object/outcome/session_id/persons/archived）逐个相等、
   * 每条事件至少一条证据。digests 是两侧按 event_id 排序后的整体摘要，0 差异时必然相等。
   *
   * P1-A 起 soul_events 里还有行动子事件（source_kind=tool/test/commit/rollback），它们没有
   * 旧表对应行。逐字段对账和 missing_episode 只看 source_kind='chat'；counts.events 仍是
   * 全表总数（含子事件），所以 events > episodes 是正常形态，不是差异。
   */
  soulEventParity(tenant?: CoreTenant): SoulEventParityReport {
    const t = normalizeCoreTenant(tenant);
    const tenantArgs: SQLInputValue[] = [t.teamId, t.userId, t.agentId];
    const count = (sql: string): number => {
      const row = this.db.prepare(sql).get(...tenantArgs) as { n?: number | bigint } | undefined;
      return Number(row?.n ?? 0);
    };
    const legacyRows = this.db
      .prepare(
        `SELECT episode_id AS eventId, at, day, kind, title, object, outcome, session_id AS sessionId,
                persons_json AS personsJson, archived_at AS archivedAt
           FROM soul_episodes WHERE team_id = ? AND user_id = ? AND agent_id = ?`,
      )
      .all(...tenantArgs) as Array<Record<string, unknown>>;
    const eventRows = this.db
      .prepare(
        `SELECT e.event_id AS eventId, e.at, e.day, e.object, e.outcome, e.session_id AS sessionId,
                e.persons_json AS personsJson, e.archived_at AS archivedAt,
                c.kind AS chatKind, c.title AS chatTitle
           FROM soul_events e
           LEFT JOIN soul_event_chat c ON c.event_id = e.event_id
          WHERE e.team_id = ? AND e.user_id = ? AND e.agent_id = ? AND e.source_kind = 'chat'`,
      )
      .all(...tenantArgs) as Array<Record<string, unknown>>;
    // 「零证据」不等于「缺证据」：§4.2 允许无 evidenceIds 的事件写 inferred + evidence=[]。
    // 只有当旧表 evidence_json 有内容、新表一条证据都没有时才是不一致；两侧都空视为一致，
    // 否则合法的无证据事件会永远对账失败（ok 永远 false）。
    const missingEvidenceIds = (
      this.db
        .prepare(
          `SELECT e.event_id AS eventId FROM soul_events e
             JOIN soul_episodes p
               ON p.episode_id = e.event_id
              AND p.team_id = e.team_id AND p.user_id = e.user_id AND p.agent_id = e.agent_id
             LEFT JOIN soul_event_evidence v ON v.event_id = e.event_id
            WHERE e.team_id = ? AND e.user_id = ? AND e.agent_id = ? AND e.source_kind = 'chat'
              AND p.evidence_json IS NOT NULL
              AND TRIM(p.evidence_json) NOT IN ('', '[]')
            GROUP BY e.event_id HAVING COUNT(v.record_id) = 0`,
        )
        .all(...tenantArgs) as Array<{ eventId?: string }>
    ).map((row) => String(row.eventId ?? ""));

    // 空集合 = 「这个维度当时没有」：旧表写 NULL，新表可能写 NULL 也可能写 '[]'，比较时统一成 null。
    const norm = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      const s = String(v);
      return s === "" || s === "[]" ? null : s;
    };
    const FIELDS = [
      "at",
      "day",
      "kind",
      "title",
      "object",
      "outcome",
      "sessionId",
      "personsJson",
      "archivedAt",
    ] as const;
    const legacyById = new Map<string, Record<string, unknown>>();
    for (const row of legacyRows) legacyById.set(String(row.eventId ?? ""), row);
    const eventById = new Map<string, Record<string, unknown>>();
    for (const row of eventRows) eventById.set(String(row.eventId ?? ""), row);
    // 新表一侧的字段名不同（kind/title 在 chat 行上）：映射成与旧表同名的比较视图。
    const eventView = (row: Record<string, unknown>): Record<string, unknown> => ({
      at: row.at,
      day: row.day,
      kind: row.chatKind,
      title: row.chatTitle,
      object: row.object,
      outcome: row.outcome,
      sessionId: row.sessionId,
      personsJson: row.personsJson,
      archivedAt: row.archivedAt,
    });
    // 摘要按 event_id 排序后逐条折叠：id + 每个字段的归一化值，用 \u0001 分隔（避免 concat 碰撞）。
    const digestOf = (
      byId: Map<string, Record<string, unknown>>,
      ids: string[],
      view: (row: Record<string, unknown>) => Record<string, unknown>,
    ): string => {
      const hash = createHash("sha1");
      for (const id of ids) {
        hash.update(id).update("\u0001");
        const row = byId.get(id) ?? {};
        const fields = view(row);
        for (const f of FIELDS) hash.update(String(norm(fields[f]) ?? "")).update("\u0001");
      }
      return hash.digest("hex");
    };

    const diffs: SoulEventParityDiff[] = [];
    for (const [eventId, legacy] of legacyById) {
      const event = eventById.get(eventId);
      if (!event) {
        diffs.push({ eventId, kind: "missing_event", legacy: null, event: null });
        continue;
      }
      if (event.chatKind === null || event.chatKind === undefined) {
        diffs.push({ eventId, kind: "missing_chat", legacy: null, event: null });
      }
      const view = eventView(event);
      for (const f of FIELDS) {
        const left = norm(legacy[f]);
        const right = norm(view[f]);
        if (left !== right) diffs.push({ eventId, kind: "field_mismatch", field: f, legacy: left, event: right });
      }
    }
    for (const eventId of eventById.keys()) {
      if (!legacyById.has(eventId)) diffs.push({ eventId, kind: "missing_episode", legacy: null, event: null });
    }
    for (const eventId of missingEvidenceIds) {
      diffs.push({ eventId, kind: "missing_evidence", legacy: null, event: null });
    }

    const legacyIds = [...legacyById.keys()].sort();
    const eventIds = [...eventById.keys()].sort();
    const counts = {
      episodes: legacyRows.length,
      events: count("SELECT COUNT(*) AS n FROM soul_events WHERE team_id = ? AND user_id = ? AND agent_id = ?"),
      chat: count(
        `SELECT COUNT(*) AS n FROM soul_event_chat c JOIN soul_events e ON e.event_id = c.event_id
          WHERE e.team_id = ? AND e.user_id = ? AND e.agent_id = ?`,
      ),
      evidence: count(
        `SELECT COUNT(*) AS n FROM soul_event_evidence v JOIN soul_events e ON e.event_id = v.event_id
          WHERE e.team_id = ? AND e.user_id = ? AND e.agent_id = ?`,
      ),
      missingEvidence: missingEvidenceIds.length,
    };
    return {
      ok: diffs.length === 0,
      tenant: { teamId: t.teamId, userId: t.userId, agentId: t.agentId },
      counts,
      digests: {
        legacy: digestOf(legacyById, legacyIds, (row) => row),
        event: digestOf(eventById, eventIds, eventView),
      },
      diffs,
    };
  }

  /* —— 情绪史（soul_emotions，2026-11-06）——
   * soul_state 每次写入都覆盖「此刻」，情绪本体因此无法回放。这里按「事件 × 模板版本」
   * 逐行留档：同一事件换判据重判会多一行（不覆盖旧行），审计能看出当时按哪版规则判的。
   * intensity 存事件原值，读侧按标签半衰期重算衰减——写侧衰减会让「多久消退」不可复算。 */
  commitSoulEmotions(tenant: CoreTenant | undefined, rows: SoulEmotionRecord[]): { inserted: number } {
    const t = normalizeCoreTenant(tenant);
    if (!rows || rows.length === 0) return { inserted: 0 };
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO soul_emotions (
      episode_id, team_id, user_id, agent_id, at, object, label, valence, arousal,
      dominance, intensity, appraisal_json, template_version, appraised_at,
      agency, confidence, object_person, event_id, goal_id, dimensions_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let inserted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) {
        const info = stmt.run(
          r.episodeId,
          t.teamId,
          t.userId,
          t.agentId,
          r.at,
          r.object ?? "",
          r.label,
          r.valence ?? 0,
          r.arousal ?? 0,
          typeof r.dominance === "number" ? r.dominance : null,
          r.intensity ?? 0,
          r.appraisal === undefined ? null : JSON.stringify(r.appraisal),
          r.templateVersion,
          r.appraisedAt,
          // §5 P3-A：三列缺省 null——「没算过」不该写成 "environment"/0。
          r.agency === "self" || r.agency === "other" || r.agency === "environment" ? r.agency : null,
          typeof r.confidence === "number" && Number.isFinite(r.confidence) ? r.confidence : null,
          typeof r.objectPerson === "string" && r.objectPerson !== "" ? r.objectPerson : null,
          // P5：回指底座事件（soul_events.event_id = episode_id）与被这件事牵动的目标。
          // 缺省 null——「没接上」与「接上了空串」不是一回事，读侧按 null 跳过。
          typeof r.eventId === "string" && r.eventId !== "" ? r.eventId : null,
          typeof r.goalId === "string" && r.goalId !== "" ? r.goalId : null,
          r.dimensions === undefined ? null : JSON.stringify(r.dimensions),
        );
        // 只数真正新写入的行：同一事件同版本重跑是幂等的，不能虚增「记了多少条情绪」。
        inserted += Number(info.changes ?? 0) > 0 ? 1 : 0;
      }
      this.db.exec("COMMIT");
      return { inserted };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 已在回滚态 */
      }
      throw err;
    }
  }

  listSoulEmotions(
    tenant?: CoreTenant,
    opts?: { limit?: number; object?: string; since?: string },
  ): SoulEmotionRecord[] {
    const t = normalizeCoreTenant(tenant);
    const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 500)));
    try {
      const where = ["team_id = ?", "user_id = ?", "agent_id = ?"];
      const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
      if (opts?.object) {
        where.push("object = ?");
        args.push(opts.object);
      }
      if (opts?.since) {
        where.push("at >= ?");
        args.push(opts.since);
      }
      args.push(limit);
      const rows = this.db
        // 同一事件换判据重判会多一行（按 template_version 留档）。读侧先看最新一次判定，
        // 否则旧模板的行会和当前判据的行混排，注入可能引用已被替换的旧标签。
        .prepare(
          `SELECT * FROM soul_emotions WHERE ${where.join(" AND ")} ORDER BY appraised_at DESC, at DESC, episode_id DESC LIMIT ?`,
        )
        .all(...(args as SQLInputValue[])) as unknown as Array<Record<string, unknown>>;
      return (rows ?? []).map(mapSoulEmotionRow);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_emotions] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /* —— P5 心境层（soul_mood_state / soul_mood_events）——
   * 读写收口在 soul-mood-store.ts 的纯函数里；本类只做实例委派与错误降级，
   * 与 person-state / goal-store 同款。心境写失败不许让整轮 tick 失败。 */
  readSoulMoodState(tenant: CoreTenant | undefined): SoulMoodStateRow | null {
    try {
      return getSoulMoodState(this.db, tenant);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_mood_state] read failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  writeSoulMoodState(tenant: CoreTenant | undefined, insert: SoulMoodStateInsert): SoulMoodStateRow | null {
    try {
      return upsertSoulMoodState(this.db, tenant, insert);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_mood_state] write failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  commitSoulMoodEvents(tenant: CoreTenant | undefined, rows: SoulMoodEventInsert[]): { inserted: number } {
    try {
      return commitSoulMoodEventsImpl(this.db, tenant, rows);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_mood_events] commit failed: ${err instanceof Error ? err.message : String(err)}`);
      return { inserted: 0 };
    }
  }

  listSoulMoodEvents(
    tenant: CoreTenant | undefined,
    opts?: { limit?: number; kind?: SoulMoodEventRow["kind"] },
  ): SoulMoodEventRow[] {
    try {
      return listSoulMoodEventsImpl(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_mood_events] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  /* —— P7 价值层（soul_values / soul_gate_log / soul_dilemma）——
   * 判定在 core/soul/value-gate.ts，本类只做实例委派与降级。
   * 教训沿用 P5/P6：写判定日志失败不许让整轮 tick 失败（红线是记录，不是地雷）。 */
  upsertSoulValue(tenant: CoreTenant | undefined, insert: SoulValueInsert): SoulValueRow | null {
    try {
      return upsertSoulValueRow(this.db, tenant, insert);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_values] write failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  retireSoulValue(tenant: CoreTenant | undefined, valueId: string, at?: string): boolean {
    try {
      return retireSoulValueRow(this.db, tenant, valueId, at);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_values] retire failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  listSoulValues(
    tenant: CoreTenant | undefined,
    opts?: { status?: SoulValueStatus; source?: SoulValueSource; limit?: number },
  ): SoulValueRow[] {
    try {
      return listSoulValueRows(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_values] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  insertSoulGateLog(tenant: CoreTenant | undefined, rows: SoulGateLogInsert[]): { inserted: number } {
    try {
      return insertSoulGateLogRows(this.db, tenant, rows);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_gate_log] insert failed: ${err instanceof Error ? err.message : String(err)}`);
      return { inserted: 0 };
    }
  }

  listSoulGateLog(
    tenant: CoreTenant | undefined,
    opts?: {
      decision?: SoulGateDecision;
      stage?: SoulGateStage;
      ruleId?: string;
      sinceIso?: string;
      shadowOnly?: boolean;
      limit?: number;
      offset?: number;
    },
  ): SoulGateLogRow[] {
    try {
      return listSoulGateLogRows(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_gate_log] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  summarizeSoulGateLog(tenant: CoreTenant | undefined, opts?: { sinceIso?: string }): SoulGateLogStats {
    try {
      return summarizeSoulGateLogRows(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_gate_log] summarize failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        total: 0,
        shadow: 0,
        enforced: 0,
        wouldBlock: 0,
        wouldBlockRate: 0,
        byDecision: { allow: 0, deny: 0, rewrite: 0, ask: 0 },
        byRule: [] as SoulGateRuleStat[],
        hitRows: 0,
      };
    }
  }

  insertSoulDilemma(tenant: CoreTenant | undefined, insert: SoulDilemmaInsert): SoulDilemmaRow | null {
    try {
      return insertSoulDilemmaRow(this.db, tenant, insert);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_dilemma] insert failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  listSoulDilemmas(tenant: CoreTenant | undefined, opts?: { limit?: number; dueBefore?: string }): SoulDilemmaRow[] {
    try {
      return listSoulDilemmaRows(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_dilemma] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  reviewSoulDilemma(
    tenant: CoreTenant | undefined,
    id: string,
    patch: { regret?: number; outcomeEventId?: string | null; reviewAt?: string },
  ): SoulDilemmaRow | null {
    try {
      return reviewSoulDilemmaRow(this.db, tenant, id, patch);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_dilemma] review failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** 有边界的原话（privacy 规则判「隔墙有耳」时用）。读不到就给空——宁可少拦，不可让 gate 抛死。 */
  listSoulPrivateEventQuotes(
    tenant: CoreTenant | undefined,
    opts?: { limit?: number; minChars?: number },
  ): SoulPrivateQuoteRow[] {
    try {
      return listSoulPrivateEventQuotes(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_event_evidence] private quotes failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /* —— P6 叙事层（soul_narrative / soul_narrative_evidence）——
   * 派生与衰减在 core/soul/narrative.ts；这里只存事实。
   * 写章失败降级成「这章没写」（inserted:false），读失败给空——自传没长出来不许让整轮 tick 失败。 */
  listSoulNarrativeChapters(tenant: CoreTenant | undefined, filter?: SoulNarrativeListFilter): SoulNarrativeRow[] {
    try {
      return listSoulNarrativeChapterRows(this.db, tenant, filter);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_narrative] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  getSoulNarrativeChapter(tenant: CoreTenant | undefined, chapterId: string): SoulNarrativeRow | null {
    try {
      return getSoulNarrativeChapterRow(this.db, tenant, chapterId);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_narrative] get failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  listSoulNarrativeEvidence(tenant: CoreTenant | undefined, chapterId: string): SoulNarrativeEvidenceRow[] {
    try {
      return listSoulNarrativeEvidenceRows(this.db, tenant, chapterId);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_narrative_evidence] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  commitSoulNarrativeChapter(
    tenant: CoreTenant | undefined,
    input: SoulNarrativeCommitInput,
  ): SoulNarrativeCommitResult {
    try {
      return commitSoulNarrativeChapterImpl(this.db, tenant, input);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_narrative] commit failed: ${err instanceof Error ? err.message : String(err)}`);
      return { inserted: false, superseded: 0 };
    }
  }

  touchSoulNarrativeAccess(
    tenant: CoreTenant | undefined,
    chapterIds: string[],
    opts?: { now?: string },
  ): { updated: number } {
    try {
      return touchSoulNarrativeAccessImpl(this.db, tenant, chapterIds, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_narrative] access touch failed: ${err instanceof Error ? err.message : String(err)}`);
      return { updated: 0 };
    }
  }

  /* —— P4 自我模型与校准（soul_self_model / soul_calibration / soul_event_reflection）——
   * 与 mood 同款：写失败只降级（null / {inserted:0}），自我认识没更新不许让整轮 tick 失败。
   * 反例合并、probation/retired 的判定都在 core/soul/self-model.ts；这里只存事实。 */
  getSoulSelfModel(tenant: CoreTenant | undefined, id: string): SoulSelfModelRow | null {
    try {
      return getSoulSelfModelRow(this.db, tenant, id);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_self_model] read failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  listSoulSelfModel(
    tenant: CoreTenant | undefined,
    opts?: { limit?: number; kinds?: SoulSelfModelRow["kind"][]; statuses?: SoulSelfModelRow["status"][] },
  ): SoulSelfModelRow[] {
    try {
      return listSoulSelfModelRows(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_self_model] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  upsertSoulSelfModel(tenant: CoreTenant | undefined, insert: SoulSelfModelInsert): SoulSelfModelRow | null {
    try {
      return upsertSoulSelfModelRow(this.db, tenant, insert);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_self_model] write failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  commitSoulCalibration(
    tenant: CoreTenant | undefined,
    rows: SoulCalibrationInsert[],
  ): { inserted: number } {
    try {
      return commitSoulCalibrationImpl(this.db, tenant, rows);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_calibration] commit failed: ${err instanceof Error ? err.message : String(err)}`);
      return { inserted: 0 };
    }
  }

  listSoulCalibration(
    tenant: CoreTenant | undefined,
    opts?: { limit?: number; domain?: string },
  ): SoulCalibrationRow[] {
    try {
      return listSoulCalibrationRows(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_calibration] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  upsertSoulEventReflection(
    tenant: CoreTenant | undefined,
    reflection: SoulEventReflectionInsert,
  ): { upserted: number } {
    try {
      return upsertSoulEventReflectionRow(this.db, reflection, tenant);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_event_reflection] upsert failed: ${err instanceof Error ? err.message : String(err)}`);
      return { upserted: 0 };
    }
  }

  /* —— 人物身份层（soul_person，2026-11-08 阶段 1）——
   * person_key 是「谁」的唯一事实源；判定（平台 id → 归一化名唯一 → 新建）在
   * src/core/person/resolve.ts，这里只做落库。方法本身吞掉错误返回既有效值：
   * 挂人失败不许让 L1 写入中断（宁可这一条记忆不挂人，也不能丢记忆）。 */

  /**
   * 建/更新一个人。
   *
   * 语义：**主键优先**。同一 person_key 再来一次只刷新展示面（platform/display_name/
   * aliases），created_at 与 merged_into 不动——合并是显式操作（mergeSoulPerson），
   * 不能被一次 upsert 静默撤销。
   *
   * aliases 是并集，不是覆盖：调用方每次只带这次看到的称呼，覆盖会把旧昵称丢掉。
   *
   * 若插入撞上 partial 唯一索引（同平台 id 已有另一行：并发或改名后重解析），
   * 返回值挂到既有行上（personKey !== 入参 key），由调用方按返回值落 persons。
   */
  upsertSoulPerson(tenant: CoreTenant | undefined, person: SoulPersonUpsert): { personKey: string; created: boolean } {
    const t = normalizeCoreTenant(tenant);
    const key = typeof person?.personKey === "string" ? person.personKey.trim() : "";
    if (key === "") return { personKey: "", created: false };
    const now = new Date().toISOString();
    const platform = (person.platform ?? "").trim();
    const platformId =
      typeof person.platformId === "string" && person.platformId.trim() !== "" ? person.platformId.trim() : null;
    const displayName = (person.displayName ?? "").trim();
    const aliases = Array.isArray(person.aliases)
      ? person.aliases.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim())
      : [];
    try {
      const existing = this.db
        .prepare("SELECT person_key, aliases_json FROM soul_person WHERE person_key = ? AND merged_into IS NULL")
        .get(key) as unknown as { person_key?: string; aliases_json?: string } | undefined;
      if (existing) {
        const nextAliases = mergeAliases(jsonArray<string>(existing.aliases_json), aliases);
        this.db
          .prepare(
            "UPDATE soul_person SET platform = ?, platform_id = ?, display_name = ?, aliases_json = ?, updated_at = ? WHERE person_key = ? AND merged_into IS NULL",
          )
          .run(platform, platformId, displayName, JSON.stringify(nextAliases), now, key);
        return { personKey: key, created: false };
      }
      this.db
        .prepare(
          `INSERT INTO soul_person
            (person_key, team_id, user_id, agent_id, platform, platform_id, display_name, aliases_json, merged_into, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(key, t.teamId, t.userId, t.agentId, platform, platformId, displayName, JSON.stringify(aliases), now, now);
      return { personKey: key, created: true };
    } catch (err) {
      // 撞 partial 唯一索引 = 同一平台身份已有未合并的行：挂过去而不是造第二个人。
      if (platformId !== null) {
        const owner = this.db
          .prepare(
            `SELECT person_key, aliases_json FROM soul_person
             WHERE team_id = ? AND user_id = ? AND agent_id = ? AND platform = ? AND platform_id = ?
               AND merged_into IS NULL LIMIT 1`,
          )
          .get(t.teamId, t.userId, t.agentId, platform, platformId) as unknown as
          { person_key?: string; aliases_json?: string } | undefined;
        if (owner && typeof owner.person_key === "string") {
          const nextAliases = mergeAliases(jsonArray<string>(owner.aliases_json), aliases);
          try {
            this.db
              .prepare(
                "UPDATE soul_person SET display_name = ?, aliases_json = ?, updated_at = ? WHERE person_key = ? AND merged_into IS NULL",
              )
              .run(displayName, JSON.stringify(nextAliases), now, owner.person_key);
          } catch {
            /* 展示面刷新失败不影响归属结论 */
          }
          return { personKey: owner.person_key, created: false };
        }
      }
      this.logger?.warn?.(
        `${TAG} [soul_person] upsert failed key=${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { personKey: key, created: false };
    }
  }

  /** 平台 id 精确查（partial 唯一索引的读面）。platform 参与键，空串按其精确值匹配。 */
  getSoulPersonByPlatform(
    tenant: CoreTenant | undefined,
    hint: { platform: string; platformId: string },
  ): SoulPerson | null {
    const t = normalizeCoreTenant(tenant);
    const platform = (hint?.platform ?? "").trim();
    const platformId = (hint?.platformId ?? "").trim();
    if (platformId === "") return null;
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM soul_person
           WHERE team_id = ? AND user_id = ? AND agent_id = ? AND platform = ? AND platform_id = ?
             AND merged_into IS NULL LIMIT 1`,
        )
        .get(t.teamId, t.userId, t.agentId, platform, platformId) as unknown as Record<string, unknown> | undefined;
      return row ? mapSoulPersonRow(row) : null;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_person] getByPlatform failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** 租户内所有未合并的人（按展示名排序）。按名解析的唯一命中判定用它。 */
  listSoulPersons(tenant?: CoreTenant): SoulPerson[] {
    const t = normalizeCoreTenant(tenant);
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM soul_person WHERE team_id = ? AND user_id = ? AND agent_id = ? AND merged_into IS NULL ORDER BY display_name ASC, person_key ASC",
        )
        .all(t.teamId, t.userId, t.agentId) as unknown as Array<Record<string, unknown>>;
      return (rows ?? []).map(mapSoulPersonRow);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_person] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * P2-H（A1）：这个人最近被提到/说话的 N 条 L1。
   *
   * 过滤在 SQL 里做（`json_each` 展开 `metadata_json.persons`，按 `$.key` 命中），
   * 不允许把全库行拉进内存再 filter——库里是百万级 L1，那样会把每个 tick 的延迟
   * 从毫秒级推到秒级，而且租户过滤之外再叠一层内存过滤容易漏掉隔离条件。
   *
   * 只回 `role ∈ {subject, speaker}`：`mentioned`（别人提到他）不进档案输入（§1.2），
   * 在这里就滤掉，免得调用侧再滤一遍、两边判据漂移。
   */
  listL1ByPerson(
    tenant: CoreTenant | undefined,
    personKey: string,
    limit: number,
  ): Array<{
    recordId: string;
    at: string;
    content: string;
    userId?: string;
    roleInRecord?: "subject" | "speaker" | "mentioned";
    /** 这条记忆是从哪几条 L0 原话抽出来的（供提炼器取原话做逐字引文校验）。 */
    sourceMessageIds?: string[];
  }> {
    const t = normalizeCoreTenant(tenant);
    const key = typeof personKey === "string" ? personKey.trim() : "";
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
    if (key === "" || max <= 0) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT r.record_id AS record_id,
                  COALESCE(NULLIF(r.created_time, ''), r.updated_time, '') AS at,
                  r.content AS content,
                  r.user_id AS user_id,
                  r.source_message_ids AS source_message_ids,
                  json_extract(je.value, '$.role') AS role
             FROM l1_records r, json_each(json_extract(r.metadata_json, '$.persons')) je
            WHERE r.team_id = ? AND r.user_id = ? AND r.agent_id = ?
              AND json_extract(je.value, '$.key') = ?
              AND COALESCE(json_extract(je.value, '$.role'), '') IN ('subject', 'speaker')
            ORDER BY at DESC
            LIMIT ?`,
        )
        .all(t.teamId, t.userId, t.agentId, key, max) as unknown as Array<Record<string, unknown>>;
      return (rows ?? []).map((row) => {
        const role = String(row.role ?? "");
        const idsRaw = row.source_message_ids;
        const ids: string[] = [];
        if (typeof idsRaw === "string" && idsRaw.trim() !== "") {
          try {
            const parsed: unknown = JSON.parse(idsRaw);
            if (Array.isArray(parsed)) {
              for (const v of parsed) {
                const s = typeof v === "string" ? v.trim() : "";
                if (s !== "") ids.push(s);
              }
            }
          } catch {
            // 老数据可能是逗号分隔；按逗号再试一次，解析不了就当作没有原话。
            for (const v of idsRaw.split(",")) {
              const s = v.trim();
              if (s !== "") ids.push(s);
            }
          }
        }
        return {
          recordId: String(row.record_id ?? ""),
          at: String(row.at ?? ""),
          content: String(row.content ?? ""),
          userId: typeof row.user_id === "string" ? row.user_id : undefined,
          ...(ids.length > 0 ? { sourceMessageIds: ids } : {}),
          roleInRecord:
            role === "subject" || role === "speaker" || role === "mentioned"
              ? (role as "subject" | "speaker" | "mentioned")
              : undefined,
        };
      });
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_person] listL1ByPerson failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * P2-H（A1）：租户内「够格提炼」的人 + 各自记忆数/最新时间。
   *
   * 聚合在 SQL 里做（`GROUP BY ... HAVING COUNT(*) >= 3`）：候选筛选不该把全库
   * `persons` 展开到 JS 再数，那样每个 tick 都要序列化几十万行 JSON。
   */
  listPersonProfileStats(tenant: CoreTenant | undefined): Array<{
    personKey: string;
    memories: number;
    lastAt: string;
  }> {
    const t = normalizeCoreTenant(tenant);
    try {
      const rows = this.db
        .prepare(
          `SELECT json_extract(je.value, '$.key') AS person_key,
                  COUNT(*) AS memories,
                  MAX(COALESCE(NULLIF(r.created_time, ''), r.updated_time, '')) AS last_at
             FROM l1_records r, json_each(json_extract(r.metadata_json, '$.persons')) je
            WHERE r.team_id = ? AND r.user_id = ? AND r.agent_id = ?
              AND json_extract(je.value, '$.key') IS NOT NULL
              AND COALESCE(json_extract(je.value, '$.role'), '') IN ('subject', 'speaker')
            GROUP BY json_extract(je.value, '$.key')
           HAVING COUNT(*) >= 3
            ORDER BY last_at ASC, person_key ASC`,
        )
        .all(t.teamId, t.userId, t.agentId) as unknown as Array<Record<string, unknown>>;
      return (rows ?? []).map((row) => ({
        personKey: String(row.person_key ?? ""),
        memories: Number(row.memories ?? 0),
        lastAt: String(row.last_at ?? ""),
      }));
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_person] listPersonProfileStats failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /** P2-H（A8）：提炼水位（`profile_at` 为 NULL = 从未跑过）。只读两列，不拉整行。 */
  listSoulPersonProfileWatermarks(tenant?: CoreTenant): Array<{ personKey: string; profileAt: string | null }> {
    const t = normalizeCoreTenant(tenant);
    try {
      const rows = this.db
        .prepare(
          "SELECT person_key, profile_at FROM soul_person WHERE team_id = ? AND user_id = ? AND agent_id = ? AND merged_into IS NULL",
        )
        .all(t.teamId, t.userId, t.agentId) as unknown as Array<Record<string, unknown>>;
      return (rows ?? []).map((row) => ({
        personKey: String(row.person_key ?? ""),
        profileAt: typeof row.profile_at === "string" && row.profile_at !== "" ? row.profile_at : null,
      }));
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_person] listProfileWatermarks failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * P2-H（A8）：写提炼水位。
   *
   * 只有提炼**成功**才调（模型报错/解析失败不写 → 下一 tick 重试）。返回值给调用侧
   * 区分「写了」与「人不存在/已合并」，不要让水位静默丢失。
   */
  markSoulPersonProfileAt(tenant: CoreTenant | undefined, personKey: string, at: string): { updated: boolean } {
    const t = normalizeCoreTenant(tenant);
    const key = typeof personKey === "string" ? personKey.trim() : "";
    if (key === "" || typeof at !== "string" || at === "") return { updated: false };
    try {
      const info = this.db
        .prepare(
          "UPDATE soul_person SET profile_at = ?, updated_at = ? WHERE person_key = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND merged_into IS NULL",
        )
        .run(at, at, key, t.teamId, t.userId, t.agentId);
      return { updated: Number(info.changes ?? 0) > 0 };
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_person] markProfileAt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { updated: false };
    }
  }

  /**
   * P2-H（A6）：关系边两向可查。
   *
   * `subjKey` 与 `objKey` 可同时给（只留两个条件都成立的行）或分别给（出边/入边）。
   * 缺省只回现行边（`valid_to IS NULL`）；`includeClosed` 给运维/审计看「曾经」。
   */
  listSoulPersonRelations(
    tenant?: CoreTenant,
    opts?: { subjKey?: string; objKey?: string; includeClosed?: boolean },
  ): SoulPersonRelationRow[] {
    const t = normalizeCoreTenant(tenant);
    const conds = ["team_id = ?", "user_id = ?", "agent_id = ?"];
    const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
    const subj = typeof opts?.subjKey === "string" ? opts.subjKey.trim() : "";
    const obj = typeof opts?.objKey === "string" ? opts.objKey.trim() : "";
    if (subj !== "") {
      conds.push("subj_key = ?");
      args.push(subj);
    }
    if (obj !== "") {
      conds.push("obj_key = ?");
      args.push(obj);
    }
    if (!opts?.includeClosed) conds.push("valid_to IS NULL");
    try {
      const rows = this.db
        .prepare(`SELECT * FROM soul_person_relation WHERE ${conds.join(" AND ")} ORDER BY valid_from DESC, rel_id ASC`)
        .all(...args) as unknown as Array<Record<string, unknown>>;
      return (rows ?? []).map(mapSoulPersonRelationRow);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_person_relation] list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /* —— P2 §4.4：关系状态层（soul_person_state / state_events）——
   * 读写都在 soul-person-state-store.ts 的纯函数里收口，本类只做实例委派。
   * 读失败返回空/null（卡与面板不该因为状态层读失败整页消失）；
   * upsert 不吞错：CHECK/主键冲突要让写者看见（维护 tick 按人 catch 并 warn）。 */

  getSoulPersonState(tenant: CoreTenant | undefined, personKey: string): SoulPersonStateRow | null {
    try {
      return getSoulPersonStateRow(this.db, tenant, personKey);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_person_state] get failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  listSoulPersonStates(tenant?: CoreTenant, opts?: { limit?: number }): SoulPersonStateRow[] {
    try {
      return listSoulPersonStateRows(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_person_state] list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  upsertSoulPersonState(tenant: CoreTenant | undefined, insert: SoulPersonStateInsert): SoulPersonStateRow {
    return upsertSoulPersonStateRow(this.db, tenant, insert);
  }

  insertSoulPersonStateEvents(
    tenant: CoreTenant | undefined,
    events: SoulPersonStateEventInsert[],
  ): { inserted: number } {
    try {
      return insertSoulPersonStateEventRows(this.db, tenant, events);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_person_state_events] insert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { inserted: 0 };
    }
  }

  listSoulPersonStateEvents(
    tenant?: CoreTenant,
    opts?: { personKey?: string; limit?: number },
  ): SoulPersonStateEventRow[] {
    try {
      return listSoulPersonStateEventRows(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_person_state_events] list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
  /**
   * P2-H（A4/A5）：一次事务内写关系边——新增 / 追加证据 / 失效。
   *
   * 三条语义都在 store 里收口，而不是调用方分别调三个方法：
   *   - 新增：`INSERT OR IGNORE`（rel_id 带 valid_from，同一 tick 重放幂等）；
   *   - 合并证据：反向边已存在时不插新行，把 `{recordId,at,quote}` 并进既有边；
   *   - 失效：`op=outdated` 给旧边写 `valid_to`（行不删，图上看得到「曾经」）。
   */
  commitSoulPersonRelations(
    tenant: CoreTenant | undefined,
    plan: {
      insert?: SoulPersonRelationRow[];
      appendEvidence?: Array<{ relId: string; items: Array<{ recordId: string; at: string; quote: string }> }>;
      close?: Array<{ relId: string; at: string }>;
    },
  ): { inserted: number; merged: number; closed: number } {
    const t = normalizeCoreTenant(tenant);
    const insert = plan?.insert ?? [];
    const append = plan?.appendEvidence ?? [];
    const close = plan?.close ?? [];
    if (insert.length === 0 && append.length === 0 && close.length === 0) {
      return { inserted: 0, merged: 0, closed: 0 };
    }
    const stmtInsert = this.db.prepare(`INSERT OR IGNORE INTO soul_person_relation (
      rel_id, team_id, user_id, agent_id, subj_key, pred, inverse_pred, obj_key, obj_name, direction,
      quote, record_id, valid_from, valid_to, created_at, updated_at, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let inserted = 0;
    let merged = 0;
    let closed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of insert) {
        const evidence =
          row.evidence && row.evidence.length > 0
            ? row.evidence
            : [{ recordId: row.recordId, at: row.validFrom, quote: row.quote }];
        // 时间戳缺省补当前时间：少一个字段不该让整批 insert 因 NOT NULL 回滚（静默丢边）。
        const at = new Date().toISOString();
        const info = stmtInsert.run(
          row.relId,
          t.teamId,
          t.userId,
          t.agentId,
          row.subjKey,
          row.pred,
          row.inversePred ?? null,
          row.objKey ?? null,
          row.objName ?? null,
          row.direction ?? "out",
          row.quote,
          row.recordId,
          row.validFrom,
          row.validTo ?? null,
          row.createdAt ?? at,
          row.updatedAt ?? at,
          JSON.stringify(evidence),
        );
        if (Number(info.changes ?? 0) > 0) inserted += 1;
      }
      for (const patch of append) {
        if (patch.items.length === 0) continue;
        const current = this.db
          .prepare(
            "SELECT evidence_json FROM soul_person_relation WHERE rel_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
          )
          .get(patch.relId, t.teamId, t.userId, t.agentId) as { evidence_json?: string } | undefined;
        if (!current) continue;
        const existing = jsonArray<{ recordId: string; at: string; quote: string }>(current.evidence_json);
        // 同一 recordId+quote 不重复入账：重放同一 tick 不该让证据数虚增。
        const seen = new Set(existing.map((e) => `${e.recordId}|${e.quote}`));
        const next = [...existing];
        for (const item of patch.items) {
          const k = `${item.recordId}|${item.quote}`;
          if (seen.has(k)) continue;
          seen.add(k);
          next.push(item);
        }
        if (next.length === existing.length) continue;
        const info = this.db
          .prepare(
            "UPDATE soul_person_relation SET evidence_json = ?, updated_at = ? WHERE rel_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
          )
          .run(JSON.stringify(next), new Date().toISOString(), patch.relId, t.teamId, t.userId, t.agentId);
        if (Number(info.changes ?? 0) > 0) merged += 1;
      }
      for (const patch of close) {
        // P2 §4.4：失效的三件事必须一起写——valid_to（时间）、status=ended（语义）、
        // tense=past（「曾经」）。只写 valid_to 会让读面在 includeClosed 时把一条已经结束的
        // 关系当 active；S13d 的验收要求就是「结束的关系有 valid_to 且不再进卡」。
        const info = this.db
          .prepare(
            "UPDATE soul_person_relation SET valid_to = ?, status = 'ended', tense = 'past', updated_at = ? WHERE rel_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND valid_to IS NULL",
          )
          .run(patch.at, patch.at, patch.relId, t.teamId, t.userId, t.agentId);
        if (Number(info.changes ?? 0) > 0) closed += 1;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* COMMIT 失败时引擎可能已自动回滚，ROLLBACK 自兜底 */
      }
      this.logger?.warn?.(
        `${TAG} [soul_person_relation] commit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { inserted: 0, merged: 0, closed: 0 };
    }
    return { inserted, merged, closed };
  }

  /**
   * 关系引文 → L0 唯一命中行（P2 §10.8 回指与 t13 补事件的同一份判定）。
   * 精确匹配 message_text 唯一 → 命中；精确也多条 → ambiguous；否则唯一子串匹配 → 命中；
   * 子串也多条 → ambiguous（不猜）。零命中返回 recordId=null、ambiguous=false。
   */
  private resolveRelationQuoteRecord(
    t: CoreTenant,
    quote: string,
  ): { recordId: string | null; ambiguous: boolean } {
    const q = typeof quote === "string" ? quote.trim() : "";
    if (q === "") return { recordId: null, ambiguous: false };
    const exact = this.db
      .prepare(
        "SELECT record_id FROM l0_conversations WHERE team_id=? AND user_id=? AND agent_id=? AND message_text = ?",
      )
      .all(t.teamId, t.userId, t.agentId, q) as Array<{ record_id: string }>;
    if (exact.length === 1) return { recordId: exact[0].record_id, ambiguous: false };
    if (exact.length > 1) return { recordId: null, ambiguous: true };
    const sub = this.db
      .prepare(
        "SELECT record_id FROM l0_conversations WHERE team_id=? AND user_id=? AND agent_id=? AND instr(message_text, ?) > 0 LIMIT 2",
      )
      .all(t.teamId, t.userId, t.agentId, q) as Array<{ record_id: string }>;
    if (sub.length === 1) return { recordId: sub[0].record_id, ambiguous: false };
    return { recordId: null, ambiguous: sub.length > 1 };
  }

  /**
   * P6 / t20：episode 的逐字引文 → L0 唯一命中行。
   *
   * 与关系线（resolveRelationQuoteRecord）共用最后一段「全租户精确 → 唯一子串」判定，
   * 但多一层次序：episode 自己记了证据记录（quote.recordId / evidenceIds），先在这批记录里判。
   *  - 候选行里精确命中恰好一条 → 用它；
   *  - 精确命中多条但引文自带 recordId → 用 recordId 消歧（episode 当时就是从这条抽的，不是猜）；
   *  - 候选行里逐字子串唯一 → 用它；多条 → 多命中（不猜）；
   *  - 候选记录都没中（被删除/引文漂移）→ 回落到全租户唯一命中。
   * 返回 candidates 供证据落库：只含真实存在的 L0 行，不写悬空 record_id。
   */
  private resolveEpisodeQuoteRecord(
    t: CoreTenant,
    text: string,
    quoteRecordId: string | null,
    evidenceIds: readonly string[],
  ): {
    recordId: string | null;
    ambiguous: boolean;
    candidates: Array<{ record_id: string; role: string; recorded_at: string | null }>;
  } {
    const q = typeof text === "string" ? text.trim() : "";
    if (q === "") return { recordId: null, ambiguous: false, candidates: [] };
    const ids: string[] = [];
    for (const id of [quoteRecordId ?? "", ...(evidenceIds ?? [])]) {
      if (typeof id !== "string" || id === "" || ids.includes(id)) continue;
      ids.push(id);
    }
    const rows =
      ids.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT record_id, role, recorded_at, message_text FROM l0_conversations
                WHERE team_id=? AND user_id=? AND agent_id=? AND record_id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(t.teamId, t.userId, t.agentId, ...ids) as Array<{
            record_id: string;
            role: string;
            recorded_at: string | null;
            message_text: string;
          }>);
    const candidates = rows.map((r) => ({
      record_id: String(r.record_id),
      role: String(r.role ?? ""),
      recorded_at: typeof r.recorded_at === "string" ? r.recorded_at : null,
      text: String(r.message_text ?? ""),
    }));
    const exact = candidates.filter((c) => c.text.trim() === q);
    if (exact.length === 1) {
      return { recordId: exact[0].record_id, ambiguous: false, candidates: candidates.map(stripEpisodeCandidate) };
    }
    if (exact.length > 1) {
      const pinned = quoteRecordId ? exact.find((c) => c.record_id === quoteRecordId) : undefined;
      if (pinned) {
        return { recordId: pinned.record_id, ambiguous: false, candidates: candidates.map(stripEpisodeCandidate) };
      }
      return { recordId: null, ambiguous: true, candidates: candidates.map(stripEpisodeCandidate) };
    }
    const pinnedRow = quoteRecordId ? candidates.find((c) => c.record_id === quoteRecordId) : undefined;
    if (pinnedRow && pinnedRow.text.includes(q)) {
      return { recordId: pinnedRow.record_id, ambiguous: false, candidates: candidates.map(stripEpisodeCandidate) };
    }
    const sub = candidates.filter((c) => c.text.includes(q));
    if (sub.length === 1) {
      return { recordId: sub[0].record_id, ambiguous: false, candidates: candidates.map(stripEpisodeCandidate) };
    }
    if (sub.length > 1) {
      return { recordId: null, ambiguous: true, candidates: candidates.map(stripEpisodeCandidate) };
    }
    const resolved = this.resolveRelationQuoteRecord(t, q);
    return { ...resolved, candidates: candidates.map(stripEpisodeCandidate) };
  }

  /**
   * P2（spec §10.8）：给 event_id 为 NULL 的关系边做**确定性**回指，唯一命中才写，不猜。
   *
   * 判定顺序（任一命中即停，两条路径都要收敛到「恰好 1 个事件」）：
   *  ① record_id 当 L1 id：l1_records.source_message_ids → 每条 L0 原话 → soul_event_evidence → 事件；
   *  ② 否则用 quote 在 L0 同租户里「精确匹配 message_text」→「唯一子串匹配」→ 同一条证据链。
   * 恰好 1 个事件写 event_id（status 保持 active）；0 个或 >1 个写 status='unverifiable'
   * （保留事实、不进卡）。已有 event_id 或已 unverifiable 的边不再扫（幂等）。
   * 失败只 warn 返空账——回指是派生修复，不该阻断 tick。
   */
  backfillSoulPersonRelationEventIds(
    tenant?: CoreTenant,
    opts?: { now?: string },
  ): SoulPersonRelationBackfillResult {
    const t = normalizeCoreTenant(tenant);
    const at = opts?.now ?? new Date().toISOString();
    const empty: SoulPersonRelationBackfillResult = { scanned: 0, linked: 0, unverifiable: 0 };
    const eventsForRecord = (recordId: string): Set<string> => {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT e.event_id AS id FROM soul_event_evidence e
             JOIN soul_events ev ON ev.event_id = e.event_id
            WHERE e.record_id = ? AND ev.team_id = ? AND ev.user_id = ? AND ev.agent_id = ?`,
        )
        .all(recordId, t.teamId, t.userId, t.agentId) as Array<{ id: string }>;
      return new Set(rows.map((r) => r.id));
    };
    const resolveQuoteRecord = (quote: string): { recordId: string | null; ambiguous: boolean } =>
      this.resolveRelationQuoteRecord(t, quote);
    try {
      const rows = this.db
        .prepare(
          `SELECT rel_id, quote, record_id FROM soul_person_relation
            WHERE team_id=? AND user_id=? AND agent_id=? AND event_id IS NULL AND status='active'`,
        )
        .all(t.teamId, t.userId, t.agentId) as Array<{ rel_id: string; quote: string; record_id: string }>;
      if (rows.length === 0) return empty;
      const decisions: Array<{ relId: string; eventId: string | null }> = [];
      for (const row of rows) {
        const events = new Set<string>();
        const l1 = this.db
          .prepare(
            "SELECT source_message_ids FROM l1_records WHERE record_id=? AND team_id=? AND user_id=? AND agent_id=?",
          )
          .get(row.record_id, t.teamId, t.userId, t.agentId) as { source_message_ids?: string } | undefined;
        if (l1) {
          for (const msgId of jsonArray<string>(l1.source_message_ids)) {
            for (const id of eventsForRecord(msgId)) events.add(id);
          }
        }
        if (events.size === 0) {
          const record = resolveQuoteRecord(row.quote).recordId;
          if (record) for (const id of eventsForRecord(record)) events.add(id);
        }
        decisions.push({ relId: row.rel_id, eventId: events.size === 1 ? [...events][0] : null });
      }
      const updLink = this.db.prepare(
        `UPDATE soul_person_relation SET event_id=?, updated_at=?
          WHERE rel_id=? AND team_id=? AND user_id=? AND agent_id=? AND event_id IS NULL AND status='active'`,
      );
      const updUnverifiable = this.db.prepare(
        `UPDATE soul_person_relation SET status='unverifiable', updated_at=?
          WHERE rel_id=? AND team_id=? AND user_id=? AND agent_id=? AND event_id IS NULL AND status='active'`,
      );
      let linked = 0;
      let unverifiable = 0;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const d of decisions) {
          if (d.eventId) {
            const info = updLink.run(d.eventId, at, d.relId, t.teamId, t.userId, t.agentId);
            if (Number(info.changes ?? 0) > 0) linked += 1;
            continue;
          }
          try {
            const info = updUnverifiable.run(at, d.relId, t.teamId, t.userId, t.agentId);
            if (Number(info.changes ?? 0) > 0) unverifiable += 1;
          } catch (err) {
            // CHECK 还没扩容（迁移失败/旧库）：这一条保持 event_id=NULL——不猜、不进卡，下次 init 重试。
            this.logger?.warn?.(
              `${TAG} [soul-relation-backfill] 标记 unverifiable 被库约束拒绝（保持 NULL）: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* COMMIT 失败时引擎可能已自动回滚 */
        }
        throw err;
      }
      return { scanned: rows.length, linked, unverifiable };
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul-relation-backfill] 回指失败（本轮跳过，下 tick 重试）: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    }
  }


  /**
   * P6 / t20：episode 的确定性补事件——让「引文在 L0 能回到原话、但当时没建事件」的 episode 重新可成章。
   *
   * 为什么不放宽章节准入：narrative 的证据必须回指真实 soul_events（narrative.ts:218-230）。
   * 老库（90 天全量库）里 87 条 episode 一条事件都没有，章节因此恒为 0——规则本身对，
   * 缺的是「当时没建事件」这件事的补偿。与关系线（provisionSoulRelationEvents）同构：
   *  ① 只扫「还没有同 episode_id 事件」的 episode；
   *  ② 用 episode 的逐字引文（quote.text，缺则 user_stance）回到 L0：
   *     引文自带的 recordId / evidenceIds 里逐字命中优先，回不到再按全租户唯一命中；
   *  ③ 命中唯一才建一条 chat 事件：event_id = episodeId（与双写同口径，天然幂等），
   *     dedupe_key = soul-episode:<episodeId>，证据 = 命中记录 + 该 episode 现存证据记录；
   *  ④ 零命中/多命中/没有可匹配原文/work 类一律不建，计入 skippedUnprovisionable 并留示例。
   * 不调模型、不生成 L0 之外的内容、不改 narrative 的成章判据。
   */
  provisionSoulEpisodeEvents(
    tenant?: CoreTenant,
    opts?: { now?: string; limit?: number },
  ): SoulEpisodeProvisionResult {
    const t = normalizeCoreTenant(tenant);
    const limit = Math.max(1, Math.min(500, Math.trunc(opts?.limit ?? EPISODE_PROVISION_MAX_PER_TICK)));
    const empty: SoulEpisodeProvisionResult = {
      scanned: 0,
      created: 0,
      ambiguous: 0,
      notFound: 0,
      noSource: 0,
      skippedWork: 0,
      skippedUnprovisionable: 0,
      skippedExisting: 0,
      failed: 0,
      exampleEpisodeId: null,
      exampleReason: null,
      limitReached: false,
    };
    try {
      // 判据只看「这条 episode 有没有自己的事件行」：双写、补写都用 event_id = episodeId。
      const where =
        "e.team_id = ? AND e.user_id = ? AND e.agent_id = ? AND NOT EXISTS (" +
        "SELECT 1 FROM soul_events v WHERE v.event_id = e.episode_id " +
        "AND v.team_id = e.team_id AND v.user_id = e.user_id AND v.agent_id = e.agent_id)";
      const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
      const totalRow = this.db
        .prepare("SELECT COUNT(*) AS n FROM soul_episodes e WHERE " + where)
        .get(...args) as { n?: number } | undefined;
      const scanned = Number(totalRow?.n ?? 0);
      if (scanned === 0) return empty;
      const rows = this.db
        .prepare(
          "SELECT e.* FROM soul_episodes e WHERE " + where + " ORDER BY e.at ASC, e.episode_id ASC LIMIT ?",
        )
        .all(...args, limit) as Array<Record<string, unknown>>;
      let created = 0;
      let ambiguous = 0;
      let notFound = 0;
      let noSource = 0;
      let skippedWork = 0;
      let skippedExisting = 0;
      let failed = 0;
      let exampleEpisodeId: string | null = null;
      let exampleReason: SoulEpisodeProvisionResult["exampleReason"] = null;
      const note = (id: string, reason: NonNullable<SoulEpisodeProvisionResult["exampleReason"]>): void => {
        if (exampleEpisodeId === null) {
          exampleEpisodeId = id;
          exampleReason = reason;
        }
      };
      for (const row of rows) {
        const episode = mapSoulEpisodeRow(row);
        const episodeId = episode.episodeId;
        if (episodeId === "") continue;
        // work 只给特质/自我史供料，不伪造「他说了什么」的 chat 事件。
        if (episode.kind === "work") {
          skippedWork += 1;
          note(episodeId, "work");
          continue;
        }
        const quoteText = (episode.quote?.text ?? "").trim() !== "" ? episode.quote?.text ?? "" : episode.userStance;
        const text = typeof quoteText === "string" ? quoteText.trim() : "";
        if (text === "") {
          noSource += 1;
          note(episodeId, "no_source");
          continue;
        }
        const resolved = this.resolveEpisodeQuoteRecord(
          t,
          text,
          episode.quote?.recordId ?? null,
          episode.evidenceIds ?? [],
        );
        if (!resolved.recordId) {
          if (resolved.ambiguous) {
            ambiguous += 1;
            note(episodeId, "ambiguous");
          } else {
            notFound += 1;
            note(episodeId, "not_found");
          }
          continue;
        }
        const matched = resolved.candidates.find((c) => c.record_id === resolved.recordId);
        const role = matched?.role === "assistant" ? "assistant" : matched?.role === "user" ? "user" : "";
        // 不知道是谁说的话，就不假装知道（spec §4.2）：没有确定角色等于回不到这条引文。
        if (role === "") {
          notFound += 1;
          note(episodeId, "not_found");
          continue;
        }
        // 证据只收真实存在的 L0 行：candidates 已经过存在性过滤，不再回填证据串里的悬空 id。
        const memberIds: string[] = [];
        for (const candidate of [resolved.recordId, ...resolved.candidates.map((c) => c.record_id)]) {
          if (typeof candidate === "string" && candidate !== "" && !memberIds.includes(candidate)) {
            memberIds.push(candidate);
          }
        }
        const dedupeKey = composeSoulEventDedupeKey(t, "soul-episode:" + episodeId);
        if (findSoulEventIdByDedupeKey(this.db, t, dedupeKey)) {
          skippedExisting += 1;
          continue;
        }
        const writable: SoulEpisode = {
          ...episode,
          quote: { text, role, recordId: resolved.recordId, at: matched?.recorded_at ?? episode.at },
          evidenceIds: memberIds,
        };
        try {
          insertSoulEvent(this.db, t, soulEventWriteFromEpisode(writable));
          created += 1;
        } catch (err) {
          failed += 1;
          this.logger?.warn?.(
            TAG + " [soul-episode-provision] 补事件失败（下 tick 重试）：" + episodeId + " → " +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
      return {
        scanned,
        created,
        ambiguous,
        notFound,
        noSource,
        skippedWork,
        skippedUnprovisionable: ambiguous + notFound + noSource + skippedWork,
        skippedExisting,
        failed,
        exampleEpisodeId,
        exampleReason,
        limitReached: scanned > rows.length,
      };
    } catch (err) {
      this.logger?.warn?.(
        TAG + " [soul-episode-provision] 本轮跳过（下 tick 重试）：" +
          (err instanceof Error ? err.message : String(err)),
      );
      return empty;
    }
  }

  /**
   * P2 §10.8 / t13：确定性补事件——让「引文在 L0 唯一命中、但当时没有对应事件」的关系重新可验证。
   *
   * 只做三件事，不调模型、不生成 L0 之外的内容：
   *  ① 扫 event_id IS NULL 且 status=active 的关系边；
   *  ② 用 quote 在同租户 L0 里找唯一命中行（精确优先、再唯一子串；多命中=不猜）；
   *  ③ 唯一命中才建一条 chat 事件：source_ref/证据 record_id = 该 L0 行，证据 quote = 关系引文逐字，
   *     role 取 L0 行的 role；dedupe_key = relation-backfill:<rel_id>（重复执行不产生第二行）。
   * 零命中/多命中一律不建——由回指把它标 unverifiable，语义与 t2 一致。
   * 该 L0 行已经有事件时不补：回指会按「唯一证据 → 恰好 1 个事件」直接链上，补第二条会把唯一变多命中。
   * event_id = ev-rel-<rel_id>：由关系主键确定性派生，重复执行撞同一条（且 dedupe 先跳过）。
   */
  provisionSoulRelationEvents(
    tenant?: CoreTenant,
    opts?: { now?: string },
  ): SoulPersonRelationProvisionResult {
    const t = normalizeCoreTenant(tenant);
    const now = opts?.now ?? new Date().toISOString();
    const empty: SoulPersonRelationProvisionResult = { scanned: 0, created: 0, ambiguous: 0, skipped: 0 };
    try {
      const rows = this.db
        .prepare(
          `SELECT rel_id, subj_key, obj_key, pred, quote FROM soul_person_relation
            WHERE team_id=? AND user_id=? AND agent_id=? AND event_id IS NULL AND status='active'`,
        )
        .all(t.teamId, t.userId, t.agentId) as Array<{
        rel_id: string;
        subj_key: string;
        obj_key: string | null;
        pred: string;
        quote: string;
      }>;
      if (rows.length === 0) return empty;
      let created = 0;
      let ambiguous = 0;
      let skipped = 0;
      for (const row of rows) {
        const resolved = this.resolveRelationQuoteRecord(t, row.quote);
        if (!resolved.recordId) {
          if (resolved.ambiguous) ambiguous += 1;
          else skipped += 1;
          continue;
        }
        // 该 L0 行已经有事件（本 tick 挖出来的 episode 事件，或更早的双写）时不再补：
        // 回指会按「证据 → 恰好 1 个事件」直接链上；补第二条反而把本来唯一的边变成多命中。
        const existing = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM soul_event_evidence e
               JOIN soul_events v ON v.event_id = e.event_id
              WHERE e.record_id=? AND v.team_id=? AND v.user_id=? AND v.agent_id=?`,
          )
          .get(resolved.recordId, t.teamId, t.userId, t.agentId) as { n: number } | undefined;
        if (Number(existing?.n ?? 0) > 0) {
          skipped += 1;
          continue;
        }
        const dedupeKey = composeSoulEventDedupeKey(t, `relation-backfill:${row.rel_id}`);
        if (findSoulEventIdByDedupeKey(this.db, t, dedupeKey)) {
          // 事件已建过（上次崩在「建事件」与「回指」之间）：不重复建，留给回指去链。
          skipped += 1;
          continue;
        }
        const l0 = this.db
          .prepare(
            "SELECT role, session_id, recorded_at FROM l0_conversations WHERE record_id=? AND team_id=? AND user_id=? AND agent_id=?",
          )
          .get(resolved.recordId, t.teamId, t.userId, t.agentId) as
          | { role?: string; session_id?: string; recorded_at?: string }
          | undefined;
        const role: "user" | "assistant" = l0?.role === "assistant" ? "assistant" : "user";
        const saidAt =
          typeof l0?.recorded_at === "string" && l0.recorded_at.trim() !== "" ? l0.recorded_at : now;
        const eventId = `ev-rel-${row.rel_id}`;
        try {
          insertSoulEvent(this.db, t, {
            event: {
              event_id: eventId,
              at: saidAt,
              day: saidAt.slice(0, 10),
              valid_from: saidAt,
              actor: role === "assistant" ? "self" : "user",
              action: "said",
              object: row.obj_key ?? "",
              intent: row.pred,
              outcome: "",
              status: "unknown",
              source_kind: "chat",
              source_ref: resolved.recordId,
              ownership: "theirs",
              epistemic: "observed",
              confidence: 0.8,
              visibility: "shared",
              session_id: l0?.session_id ?? "",
              persons_json: row.subj_key ? JSON.stringify([row.subj_key]) : null,
              dedupe_key: dedupeKey,
              salience: 0.5,
              created_at: now,
            },
            evidence: [
              {
                event_id: eventId,
                record_id: resolved.recordId,
                role,
                quote: row.quote,
                at: saidAt,
                confidence: 1,
              },
            ],
            chat: {
              event_id: eventId,
              kind: "relation",
              title: row.pred,
              quote_json: JSON.stringify({ text: row.quote, role, recordId: resolved.recordId, at: saidAt }),
            },
          });
          created += 1;
        } catch (err) {
          skipped += 1;
          this.logger?.warn?.(
            `${TAG} [soul-relation-provision] 建事件失败（关系 ${row.rel_id} 保持 NULL，下 tick 重试）: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return { scanned: rows.length, created, ambiguous, skipped };
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul-relation-provision] 补事件失败（本轮跳过，下 tick 重试）: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    }
  }

  /**
   * 合并（from → into）：只写指针，不搬任何数据，可原地撤销（把 merged_into 置 NULL）。
   * 拒绝自合并、目标已被合并、以及会形成环的合并（沿 into 的指针最多走 32 跳）。
   */
  mergeSoulPerson(
    tenant: CoreTenant | undefined,
    fromKey: string,
    intoKey: string,
  ): { merged: boolean; reason?: string } {
    const t = normalizeCoreTenant(tenant);
    const from = typeof fromKey === "string" ? fromKey.trim() : "";
    const into = typeof intoKey === "string" ? intoKey.trim() : "";
    if (from === "" || into === "") return { merged: false, reason: "empty_key" };
    if (from === into) return { merged: false, reason: "same_key" };
    const lookup = (key: string): { merged_into?: string | null } | undefined =>
      this.db
        .prepare(
          "SELECT merged_into FROM soul_person WHERE person_key = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
        )
        .get(key, t.teamId, t.userId, t.agentId) as unknown as { merged_into?: string | null } | undefined;
    try {
      const fromRow = lookup(from);
      if (!fromRow) return { merged: false, reason: "from_not_found" };
      if (fromRow.merged_into) return { merged: false, reason: "from_already_merged" };
      const intoRow = lookup(into);
      if (!intoRow) return { merged: false, reason: "into_not_found" };
      if (intoRow.merged_into) return { merged: false, reason: "into_merged" };
      // 环检测：into 一路向上若能走回 from，合并会造出闭环（读面跟随指针会死循环）。
      let cursor: string | null = intoRow.merged_into ?? null;
      for (let i = 0; i < 32 && cursor; i += 1) {
        if (cursor === from) return { merged: false, reason: "cycle" };
        cursor = lookup(cursor)?.merged_into ?? null;
      }
      const res = this.db
        .prepare(
          "UPDATE soul_person SET merged_into = ?, updated_at = ? WHERE person_key = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND merged_into IS NULL",
        )
        .run(into, new Date().toISOString(), from, t.teamId, t.userId, t.agentId);
      return Number(res.changes ?? 0) > 0 ? { merged: true } : { merged: false, reason: "not_updated" };
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_person] merge ${from}→${into} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { merged: false, reason: "error" };
    }
  }

  /**
   * P0-2：拒绝统计改读 soul_gate_stats（账本不再写 reject 行）。
   * 历史 reject 账本行保留可审计，但不并入这里——部署时刻是口径切换点，
   * 切换后从 0 重新累计，避免「账本历史 + 新计数」两套来源重叠。
   */
  soulRejectionStats(tenant?: CoreTenant, opts?: { sinceDays?: number }): SoulRejectionStat[] {
    const t = normalizeCoreTenant(tenant);
    const days = Math.max(1, Math.min(365, Math.floor(opts?.sinceDays ?? 30)));
    const sinceDay = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    try {
      const rows = this.db
        .prepare(
          "SELECT code, SUM(count) AS c, MAX(last_at) AS last_at FROM soul_gate_stats WHERE team_id = ? AND user_id = ? AND agent_id = ? AND day >= ? GROUP BY code ORDER BY c DESC, code ASC LIMIT 200",
        )
        .all(t.teamId, t.userId, t.agentId, sinceDay) as unknown as Array<{
        code: string;
        c: number | null;
        last_at: string | null;
      }>;
      return (rows ?? []).map((row) => ({
        code: String(row.code),
        count: Number(row.c ?? 0),
        ...(typeof row.last_at === "string" && row.last_at !== "" ? { lastAt: row.last_at } : {}),
      }));
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_gate_stats] rejection stats failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /** P0-2：门拒按 (day, code, layer) 聚合 +1（幂等 upsert）。统计失败不得影响准入。 */
  bumpSoulGateStats(tenant: CoreTenant | undefined, rows: SoulGateStatBump[]): { bumped: number } {
    const t = normalizeCoreTenant(tenant);
    const list = (rows ?? []).filter(
      (r) =>
        r &&
        typeof r.code === "string" &&
        r.code !== "" &&
        typeof r.layer === "string" &&
        r.layer !== "" &&
        typeof r.day === "string" &&
        r.day.length >= 10 &&
        Number.isFinite(r.count) &&
        r.count > 0,
    );
    if (list.length === 0) return { bumped: 0 };
    const stmt = this.db.prepare(
      `INSERT INTO soul_gate_stats (team_id, user_id, agent_id, day, code, layer, count, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(team_id, user_id, agent_id, day, code, layer)
       DO UPDATE SET count = count + excluded.count, last_at = excluded.last_at`,
    );
    let bumped = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of list) {
        stmt.run(t.teamId, t.userId, t.agentId, r.day.slice(0, 10), r.code, r.layer, Math.floor(r.count), r.at);
        bumped += 1;
      }
      this.db.exec("COMMIT");
      return { bumped };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 已在回滚态 */
      }
      throw err;
    }
  }

  listSoulGateStats(tenant?: CoreTenant, opts?: { sinceDay?: string; code?: string; limit?: number }): SoulGateStat[] {
    const t = normalizeCoreTenant(tenant);
    const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 500)));
    try {
      const where = ["team_id = ?", "user_id = ?", "agent_id = ?"];
      const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
      if (opts?.sinceDay) {
        where.push("day >= ?");
        args.push(opts.sinceDay);
      }
      if (opts?.code) {
        where.push("code = ?");
        args.push(opts.code);
      }
      args.push(limit);
      const rows = this.db
        .prepare(
          `SELECT day, code, layer, count, last_at FROM soul_gate_stats WHERE ${where.join(" AND ")} ORDER BY day DESC, count DESC, code ASC LIMIT ?`,
        )
        .all(...(args as SQLInputValue[])) as unknown as Array<{
        day: string;
        code: string;
        layer: string;
        count: number | null;
        last_at: string | null;
      }>;
      return (rows ?? []).map((row) => ({
        day: String(row.day),
        code: String(row.code),
        layer: String(row.layer),
        count: Number(row.count ?? 0),
        ...(typeof row.last_at === "string" && row.last_at !== "" ? { lastAt: row.last_at } : {}),
      }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_gate_stats] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 告警抑制的唯一判据：该 code 在 sinceIso 之后是否已有 alert 账本行。
   * 不再依赖 listSoulLedger(200) 的窗口——200 行只覆盖约 3.6h，短于 6h 抑制窗，
   * 生产上同一 code 13h 落 14 条。gates_json 在 JS 里解析，避免 LIKE 的转义问题。
   */
  hasSoulAlertSince(tenant: CoreTenant | undefined, code: string, sinceIso: string): boolean {
    const t = normalizeCoreTenant(tenant);
    if (!code || !sinceIso) return false;
    try {
      const rows = this.db
        .prepare(
          "SELECT gates_json FROM soul_ledger WHERE team_id = ? AND user_id = ? AND agent_id = ? AND action = 'alert' AND at >= ? ORDER BY at DESC LIMIT 200",
        )
        .all(t.teamId, t.userId, t.agentId, sinceIso) as unknown as Array<{ gates_json: string | null }>;
      return (rows ?? []).some((row) => {
        try {
          const gates = JSON.parse(row.gates_json ?? "[]");
          return Array.isArray(gates) && gates.includes(code);
        } catch {
          return false;
        }
      });
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_ledger] alert lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /* —— #35（R5）：promise 承诺层四方法 ——
   * F18 三元组隔离；写面（upsert/transition）不吞错直接抛（R5-F5 约定：吞错单点上移
   * 调用方）；transition 的业务拒绝（非法迁移/他租户 promiseId）走 { ok:false }
   * 裁决返回（零写入、不抛），状态机判定复用 canTransitionPromise 单一源。 */

  upsertSoulPromise(
    tenant: CoreTenant,
    input: { content: string; source: string; createdAt?: string; refKey?: string },
  ): { promiseId: string } {
    const t = normalizeCoreTenant(tenant);
    const now = new Date().toISOString();
    const promiseId = `pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = input.createdAt ?? now;
    // #44（D-44-2 refKey 显式契约）：trim 归一；纯空白=无关联（''），不落垃圾指涉物。
    const refKey = typeof input.refKey === "string" && input.refKey.trim().length > 0 ? input.refKey.trim() : "";
    // #45（D8 存储加固）：promise 行与创建事件行同事务——第二步故障整体回滚，无半写。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO soul_promises (promise_id, team_id, user_id, agent_id, content, status, source, ref_key, created_at, resolved_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, ?)",
        )
        .run(promiseId, t.teamId, t.userId, t.agentId, input.content, input.source, refKey, createdAt, now);
      this.db
        .prepare(
          "INSERT INTO soul_promise_events (promise_id, team_id, user_id, agent_id, from_status, to_status, at, note, source) VALUES (?, ?, ?, ?, NULL, 'open', ?, ?, 'manual')",
        )
        .run(promiseId, t.teamId, t.userId, t.agentId, createdAt, `created via ${input.source}`);
      this.db.exec("COMMIT");
    } catch (err) {
      // 审查 A-low：COMMIT 失败时引擎可能已自动回滚——ROLLBACK 需自兜底，不掩蔽原始错误（:2908 先例同款）。
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 事务已不存在 */
      }
      throw err;
    }
    return { promiseId };
  }

  transitionSoulPromise(
    tenant: CoreTenant,
    promiseId: string,
    to: SoulPromiseStatus,
    opts?: { at?: string; note?: string; source?: PromiseTransitionSource },
  ): { ok: true } | { ok: false; reason: string } {
    const t = normalizeCoreTenant(tenant);
    const row = this.db
      .prepare("SELECT status FROM soul_promises WHERE promise_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
      .get(promiseId, t.teamId, t.userId, t.agentId) as unknown as { status: string } | undefined;
    if (!row) return { ok: false, reason: `promise-not-found:${promiseId}` };
    const from = row.status as SoulPromiseStatus;
    if (!canTransitionPromise(from, to)) return { ok: false, reason: `invalid-transition:${from}->${to}` };
    const at = opts?.at ?? new Date().toISOString();
    // #45（D8 存储加固）：UPDATE 与事件 INSERT 同事务——事件写入故障整体回滚，
    // 状态行与事件行要么同存要么同无（事件溯源不断链）；业务拒绝已在上方零写入返回。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE soul_promises SET status = ?, resolved_at = ?, updated_at = ? WHERE promise_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
        )
        .run(to, at, at, promiseId, t.teamId, t.userId, t.agentId);
      // #41：事件溯源列 source（判定来源 manual/evidence/proposal，缺省 manual）。
      this.db
        .prepare(
          "INSERT INTO soul_promise_events (promise_id, team_id, user_id, agent_id, from_status, to_status, at, note, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(promiseId, t.teamId, t.userId, t.agentId, from, to, at, opts?.note ?? null, opts?.source ?? "manual");
      this.db.exec("COMMIT");
    } catch (err) {
      // 审查 A-low：同上，ROLLBACK 自兜底（:2908 先例同款）。
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 事务已不存在 */
      }
      throw err;
    }
    return { ok: true };
  }

  listSoulPromises(tenant: CoreTenant, opts?: { status?: SoulPromiseStatus; limit?: number }): SoulPromiseRecord[] {
    const t = normalizeCoreTenant(tenant);
    const limit = Math.max(1, Math.min(opts?.limit ?? 200, 1000));
    try {
      // T6-F2（2026-10-17）：created_at DESC——limit 截断保最新（open 超上限时旧承诺
      // 让位；「最新在前」合同在 list 层成立，渲染层再 desc 重排为幂等）。
      const rows = (opts?.status
        ? this.db.prepare(
            `SELECT promise_id, content, status, source, ref_key, created_at, resolved_at, updated_at FROM soul_promises WHERE team_id = ? AND user_id = ? AND agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT ${limit}`,
          )
        : this.db.prepare(
            `SELECT promise_id, content, status, source, ref_key, created_at, resolved_at, updated_at FROM soul_promises WHERE team_id = ? AND user_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT ${limit}`,
          )
      ).all(t.teamId, t.userId, t.agentId, ...(opts?.status ? [opts.status] : [])) as unknown as Array<{
        promise_id: string;
        content: string;
        status: string;
        source: string;
        ref_key: string | null;
        created_at: string;
        resolved_at: string | null;
        updated_at: string;
      }>;
      return rows.map((r) => ({
        promiseId: r.promise_id,
        content: r.content,
        status: r.status as SoulPromiseStatus,
        source: r.source,
        refKey: r.ref_key ?? "",
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
        updatedAt: r.updated_at,
      }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_promises] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  readSoulPromiseEvents(tenant: CoreTenant, promiseId: string): SoulPromiseEvent[] {
    const t = normalizeCoreTenant(tenant);
    try {
      const rows = this.db
        .prepare(
          "SELECT promise_id, from_status, to_status, at, note, source FROM soul_promise_events WHERE promise_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? ORDER BY id ASC",
        )
        .all(promiseId, t.teamId, t.userId, t.agentId) as unknown as Array<{
        promise_id: string;
        from_status: string | null;
        to_status: string;
        at: string;
        note: string | null;
        source: string | null;
      }>;
      return rows.map((r) => ({
        promiseId: r.promise_id,
        fromStatus: (r.from_status ?? null) as SoulPromiseEvent["fromStatus"],
        toStatus: r.to_status as SoulPromiseStatus,
        at: r.at,
        note: r.note,
        source: (r.source ?? "manual") as PromiseTransitionSource,
      }));
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_promise_events] read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /* —— P3 §4.5：目标层（soul_goals / goal_events / goal_deps）+ working 锚 ——
   * 读写都在 soul-goal-store.ts 的纯函数里收口，本类只做实例委派（person-state 同款）。
   * 读失败返回空/null（卡与面板不该因为目标层读失败整页消失）；写面不吞错
   * （维护 tick 逐条 catch+warn——CHECK/主键问题必须看得见）。 */

  getSoulGoal(tenant: CoreTenant | undefined, goalId: string): SoulGoalRow | null {
    try {
      return getSoulGoalRow(this.db, tenant, goalId);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_goals] get failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  listSoulGoals(
    tenant?: CoreTenant,
    opts?: { status?: SoulGoalStatus; kind?: SoulGoalRow["kind"]; owner?: SoulGoalRow["owner"]; dueBefore?: string; limit?: number },
  ): SoulGoalRow[] {
    try {
      return listSoulGoalRows(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_goals] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  upsertSoulGoal(tenant: CoreTenant | undefined, insert: SoulGoalInsert): { row: SoulGoalRow; created: boolean } {
    return upsertSoulGoalRow(this.db, tenant, insert);
  }

  transitionSoulGoal(
    tenant: CoreTenant | undefined,
    goalId: string,
    to: SoulGoalStatus,
    opts?: GoalTransitionOptions,
  ): GoalTransitionResult {
    return transitionSoulGoalRow(this.db, tenant, goalId, to, opts);
  }

  insertSoulGoalEvents(tenant: CoreTenant | undefined, events: SoulGoalEventInsert[]): { inserted: number } {
    try {
      return insertSoulGoalEventRows(this.db, tenant, events);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_goal_events] insert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { inserted: 0 };
    }
  }

  listSoulGoalEvents(
    tenant?: CoreTenant,
    opts?: { goalId?: string; limit?: number },
  ): SoulGoalEventRow[] {
    try {
      return listSoulGoalEventRows(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_goal_events] list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  insertSoulGoalDep(tenant: CoreTenant | undefined, dep: SoulGoalDepInsert): { inserted: number } {
    try {
      return insertSoulGoalDepRow(this.db, tenant, dep);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_goal_deps] insert failed: ${err instanceof Error ? err.message : String(err)}`);
      return { inserted: 0 };
    }
  }

  listSoulGoalDeps(tenant?: CoreTenant, opts?: { goalId?: string }): SoulGoalDepRow[] {
    try {
      return listSoulGoalDepRows(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_goal_deps] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** 承诺 ↔ 目标：把 soul_promises.goal_id 挂上（P0 迁移已加列）。幂等——已挂同一目标返回 updated:false。 */
  setSoulPromiseGoal(tenant: CoreTenant | undefined, promiseId: string, goalId: string): { updated: boolean } {
    const t = normalizeCoreTenant(tenant);
    const pid = String(promiseId ?? "").trim();
    const gid = String(goalId ?? "").trim();
    if (pid === "" || gid === "") return { updated: false };
    const info = this.db
      .prepare(
        "UPDATE soul_promises SET goal_id = ?, updated_at = ? WHERE promise_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND (goal_id IS NULL OR goal_id <> ?)",
      )
      .run(gid, new Date().toISOString(), pid, t.teamId, t.userId, t.agentId, gid);
    return { updated: Number(info.changes ?? 0) > 0 };
  }

  upsertSoulWorkingState(
    tenant: CoreTenant | undefined,
    row: SoulWorkingStateUpsert,
  ): SoulWorkingStateRow {
    return upsertSoulWorkingStateRow(this.db, tenant, row);
  }

  getSoulWorkingState(
    tenant?: CoreTenant,
    opts?: { sessionId?: string; now?: string },
  ): SoulWorkingStateRow | null {
    try {
      return getSoulWorkingStateRow(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_working_state] get failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  clearSoulWorkingState(tenant?: CoreTenant, opts?: { sessionId?: string }): { deleted: number } {
    try {
      return clearSoulWorkingStateRow(this.db, tenant, opts);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_working_state] clear failed: ${err instanceof Error ? err.message : String(err)}`);
      return { deleted: 0 };
    }
  }

  /** #30（S9/R5）：soul 快照三方法——append-only 落行 / last-hash 去重读 / 时间旅行读。
   *  租户三元组硬隔离（F18 同款）。R5-F5：write/readLast 不吞错——吞错单点在调用方
   *  （soul-assembler 捕获后 warn+不置旗标，下次渲染自动补账）；list 为 Panel 读取面，
   *  warn+安全返回。 */
  writeSoulSnapshot(
    tenant: CoreTenant,
    snap: {
      ts: string;
      contentHash: string;
      payloadJson: string;
      /** 受控枚举（soul-versioning.SOUL_CHANGE_REASONS）；缺省回落 layout。 */
      reasonCode?: string;
      reasonDetail?: string;
      /** slot 图 JSON（键级 diff 源）；缺省 '{}'。 */
      slotsJson?: string;
      /** @deprecated 旧自由文本列（历史调用方传 "render"）；内部等价 reasonCode。 */
      trigger?: string;
    },
  ): void {
    const t = normalizeCoreTenant(tenant);
    const reason = (snap.reasonCode ?? snap.trigger ?? "layout").trim() || "layout";
    const slotsJson = snap.slotsJson ?? "{}";
    // 版本链与幂等在同一写事务内完成：先读上一版，再判同内容零落行，最后定 version/parent_hash。
    // 不吞错（R5-F5 同款：吞错单点在调用方 soul-assembler）。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db
        .prepare(
          "SELECT content_hash, version FROM soul_snapshots WHERE team_id = ? AND user_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(t.teamId, t.userId, t.agentId) as unknown as { content_hash: string; version: number } | undefined;
      if (last && last.content_hash === snap.contentHash) {
        this.db.exec("COMMIT");
        return; // 内容未变：零落行，不刷版本号
      }
      // 旧行（迁移前）version 缺省 0 → 用行数续号，保证单调且不撞号。
      const agg = this.db
        .prepare(
          "SELECT COUNT(*) AS c, MAX(version) AS m FROM soul_snapshots WHERE team_id = ? AND user_id = ? AND agent_id = ?",
        )
        .get(t.teamId, t.userId, t.agentId) as unknown as { c: number; m: number | null } | undefined;
      const maxVersion = Number(agg?.m ?? 0);
      const count = Number(agg?.c ?? 0);
      const version = maxVersion > 0 ? maxVersion + 1 : count + 1;
      this.db
        .prepare(
          'INSERT INTO soul_snapshots (team_id, user_id, agent_id, ts, content_hash, payload_json, "trigger", version, parent_hash, reason_detail, slots_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          t.teamId,
          t.userId,
          t.agentId,
          snap.ts,
          snap.contentHash,
          snap.payloadJson,
          reason,
          version,
          last?.content_hash ?? null,
          snap.reasonDetail ?? "",
          slotsJson,
        );
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 事务已结束 */
      }
      throw err;
    }
  }
  readLastSoulSnapshotHash(tenant: CoreTenant): string | null {
    const t = normalizeCoreTenant(tenant);
    const row = this.db
      .prepare(
        "SELECT content_hash FROM soul_snapshots WHERE team_id = ? AND user_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(t.teamId, t.userId, t.agentId) as unknown as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }
  /** 缺口 A：最近一版整行（版本链判据 + 上一版 slot 图 diff 源）；空库 null。 */
  readLastSoulSnapshot(tenant: CoreTenant): SoulSnapshotRow | null {
    const t = normalizeCoreTenant(tenant);
    try {
      const row = this.db
        .prepare(
          'SELECT ts, content_hash, payload_json, "trigger", version, parent_hash, reason_detail, slots_json FROM soul_snapshots WHERE team_id = ? AND user_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(t.teamId, t.userId, t.agentId) as unknown as SoulSnapshotRow | undefined;
      return row ?? null;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [soul_snapshots] readLast failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
  /**
   * 最近 N 次快照（按 id 升序返回，即"从旧到新"的窗口末端）。
   *
   * 修正（2026-11-04 复核 P2）：原实现是 `ORDER BY id ASC LIMIT ?`——取的是**最早** N 条。
   * 生产 soul_snapshots 已有 1619 行，默认 limit=20 时面板"版本链"看到的是最初 20 次渲染，
   * 最近变更一次都看不到；上层 `tail = all.slice(-limit)` 是 no-op（就是全部），
   * 于是 `soul-introspect.ts:7`「最近 N 次快照」的自述与实现不符。
   * 现在改为子查询取最新 N 条、外层再按 id 升序——输出仍是升序（相邻行 diff 的 prev 语义不变），
   * 但窗口落在末端。
   */
  listSoulSnapshots(tenant: CoreTenant, limit?: number): SoulSnapshotRow[] {
    const t = normalizeCoreTenant(tenant);
    const lim = Number(limit) > 0 ? Math.min(1000, Math.floor(Number(limit))) : 100;
    try {
      return (
        (this.db
          .prepare(
            'SELECT ts, content_hash, payload_json, "trigger", version, parent_hash, reason_detail, slots_json FROM (SELECT * FROM soul_snapshots WHERE team_id = ? AND user_id = ? AND agent_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
          )
          .all(t.teamId, t.userId, t.agentId, lim) as unknown as SoulSnapshotRow[]) ?? []
      );
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul_snapshots] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  /**
   * GROW：自生长调度状态读（last_discovery_at / last_corpus_count）。未初始化 → null 基线。
   * PA：tenant 可选——default/缺省保持旧键（last_discovery_at / last_corpus_count，旧行为
   * 与旧调用形状不变）；非 default 三元组用 per-tenant 独立键（双门基线按 agent 隔离）。
   */
  /** 自维护观测（D8）：一次查询返回全部自计数（每 tick 一次，成本可忽略）。 */
  getSelfObsStats(): {
    l1: number;
    conflict: number;
    evolve: number;
    similar: number;
    archived: number;
    anchors: number;
  } {
    try {
      const one = (sql: string) => Number(this.db.prepare(sql).get()?.n ?? 0);
      return {
        l1: one("SELECT COUNT(*) AS n FROM l1_records"),
        conflict: one(`SELECT COUNT(*) AS n FROM l1_links WHERE type = '${LINK_TYPES.CONFLICT}'`),
        evolve: one(`SELECT COUNT(*) AS n FROM l1_links WHERE type = '${LINK_TYPES.EVOLVE}'`),
        similar: one(`SELECT COUNT(*) AS n FROM l1_links WHERE type = '${LINK_TYPES.SIMILAR}'`),
        archived: one("SELECT COUNT(*) AS n FROM l1_archive"),
        anchors: 0, // S8：core_values 已删除，自观测恒 0
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
  backfillMemoryRef(
    recordId: string,
    key: "coreRefs" | "personRefs" | "identityRefs",
    label: string,
    tenant?: CoreTenant,
  ): boolean {
    try {
      const t = normalizeCoreTenant(tenant);
      const row = this.db
        .prepare(
          "SELECT metadata_json FROM l1_records WHERE record_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
        )
        .get(recordId, t.teamId, t.userId, t.agentId) as { metadata_json?: string } | undefined;
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
      this.logger?.warn?.(
        `${TAG} [coreRef] backfillMemoryRef failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  // 2026-11-07（T1 提案/pending 通道清除）：core_pending 的 12 个读写方法一律删除
  // （写入/列表/裁决/复现计票/到期清扫/流量计数/ready 查询/自动采纳落账/拒绝查询/提交与回滚/状态读）。
  // 读侧唯一残留：core/soul/replay.ts 的回放集构造（T2 域），删其调用后 types.ts 的读声明可一并删。

  // 2026-11-07（复验 P1-5 收尾）：anchor_growth_state 的 4 个读者已删除——
  // get/setIdentityDiscoveryState（identity_* 三键）与 get/setSelfObsBaseline（obs_* 两键）
  // 全仓 0 生产调用方（写入方 self-obs / 身份自发现在此前已下线），表也不再创建。
  // 保留但不建表会让任何一次误调用变成 no such table 的运行时炸弹；直接删干净，
  // 旧库里的 anchor_growth_state 由数据清理任务 DROP。

  /**
   * PA：l1_records 的 distinct (team_id,user_id,agent_id) 三元组——价值锚扇出迁移与
   * 自生长 per-agent 化共用的"有记忆的 agent"清单来源（SELECT DISTINCT，单源禁第二份）。
   * 空串维度归一为 default（与 init 早期归一 UPDATE 同口径，双保险）；失败容错返 []。
   */
  listL1TenantTriplets(): CoreTenant[] {
    if (this.degraded) return [];
    try {
      const rows = this.db
        .prepare(
          "SELECT DISTINCT COALESCE(NULLIF(team_id,''),'default') AS team_id, COALESCE(NULLIF(user_id,''),'default') AS user_id, COALESCE(NULLIF(agent_id,''),'default') AS agent_id FROM l1_records",
        )
        .all() as Array<{ team_id: string; user_id: string; agent_id: string }>;
      return rows.map((r) => normalizeCoreTenant({ teamId: r.team_id, userId: r.user_id, agentId: r.agent_id }));
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [L1-tenant-triplets] failed (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
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
        const meta = this.stmtGetMeta.get(rid) as
          | {
              content: string;
              type: string;
              priority: number;
              scene_name: string;
              timestamp_str?: string;
              timestamp_end: string;
              occurred_at?: string;
              valid_start?: string;
              certainty?: string;
              valence?: number;
              arousal?: number;
              significance?: number;
              importance?: number | null;
              sensitivity?: string;
              source_message_ids?: string;
              /** B 项：stmtGetMeta 已 SELECT updated_time（行最近更新时间）。 */
              updated_time?: string;
            }
          | undefined;
        if (!meta) continue;
        out.push({
          record_id: rid,
          content: meta.content,
          type: meta.type,
          priority: meta.priority,
          scene_name: meta.scene_name,
          score: 0,
          timestamp_str: meta.timestamp_str ?? "",
          // ADR-0025 C3：列已删，对外字段取 timestamp_str（历史值逐位相等）
          timestamp_start: meta.timestamp_str ?? "",
          timestamp_end: meta.timestamp_end,
          version: 0,
          session_key: (meta as { session_key?: string }).session_key ?? "",
          session_id: (meta as { session_id?: string }).session_id ?? "",
          team_id: (meta as { team_id?: string }).team_id ?? "",
          task_id: (meta as { task_id?: string }).task_id ?? "",
          user_id: (meta as { user_id?: string }).user_id ?? "",
          agent_id: (meta as { agent_id?: string }).agent_id ?? "",
          metadata_json: (meta as { metadata_json?: string }).metadata_json ?? "{}",
          // P1-T7：created_time 读回——v2 编辑/人工调整链 upsert 时 createdAt 需要原值，
          // 否则每次编辑把 created_time 列刷空（node:sqlite undefined 绑定行为依赖实现细节）。
          created_time: (meta as { created_time?: string }).created_time ?? "",
          occurred_at: optionalText(meta.occurred_at),
          valid_start: optionalText(meta.valid_start),
          valid_end: optionalText((meta as { valid_end?: string }).valid_end),
          certainty: optionalText(meta.certainty),
          valence: optionalNumber(meta.valence),
          arousal: optionalNumber(meta.arousal),
          significance: optionalNumber(meta.significance),
          // D-3：敏感性透传（getL1ByIds 精确读回——v2 编辑链/人工调整链以本方法取 soul 全量，
          // 漏映射会在 excluded.* 重写时把既有 sensitivity 刷回默认；与向量路 3529 同口径）。
          sensitivity: optionalText(meta.sensitivity),
          importance: meta.importance ?? null,
          // P0：行级原话溯源——v2 编辑/人工调整链以本方法取行后原样重建再 upsertL1
          // （ON CONFLICT 对 soul 列 excluded.* 整行覆盖），此处漏映射 = 编辑一次刷空。
          source_message_ids: parseSourceMessageIds(meta.source_message_ids),
          // B 项：行最近更新时间（stmtGetMeta 已 SELECT updated_time）
          updated_time: meta.updated_time || undefined,
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
        const row = this.db.prepare("SELECT data FROM l1_archive WHERE record_id = ?").get(id) as
          { data: string } | undefined;
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
          // ADR-0025 C3：老归档 JSON 里的 timestamp_start 键被忽略，统一取 timestamp_str
          timestamp_start: String(d.timestamp_str ?? ""),
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
          valence: (d.valence as number) ?? undefined,
          arousal: (d.arousal as number) ?? undefined,
          significance: (d.significance as number) ?? undefined,
          importance: (d.importance as number | null | undefined) ?? null,
          // B 项：归档 JSON 里若带 updated_time 则原样带回（缺省/空串 → undefined，消费方回退 timestamp_end）
          updated_time: (d.updated_time as string) || undefined,
        });
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [l1_links] getL1ByIdsWithArchive failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
  searchL1ByCoreRefs(
    labels: string[],
    limit = 10,
    filter?: IsolationFilter,
  ): Array<import("./types.js").L1SearchResult> {
    if (!labels || labels.length === 0 || limit <= 0) return [];
    const wanted = new Set(labels.filter((l) => typeof l === "string" && l.trim().length > 0));
    if (wanted.size === 0) return [];
    try {
      const retrieveLimit = Math.min(Math.max(limit * 20, 100), 500);
      const rows = this.db
        .prepare(
          `SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id,
                  version, timestamp_str, timestamp_end, metadata_json, source_message_ids, updated_time,
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
        /** @deprecated ADR-0025 C3：列已删，恒取 timestamp_str。 */
        timestamp_start: string;
        timestamp_end: string;
        metadata_json: string;
        occurred_at?: string | null;
        valid_start?: string | null;
        valid_end?: string | null;
        certainty?: string | null;
        sensitivity?: string | null;
        valence?: number | null;
        arousal?: number | null;
        significance?: number | null;
        importance?: number | null;
        source_message_ids?: string | null;
        updated_time?: string | null;
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
          timestamp_start: r.timestamp_str,
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
          sensitivity: r.sensitivity ?? undefined,
          valence: r.valence ?? undefined,
          arousal: r.arousal ?? undefined,
          significance: r.significance ?? undefined,
          importance: r.importance ?? null,
          source_message_ids: parseSourceMessageIds(r.source_message_ids),
          // B 项：行最近更新时间（l1_records.updated_time 直取）
          updated_time: r.updated_time || undefined,
        });
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [coreRef] searchL1ByCoreRefs failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * task-9（2026-11-04，来源证据主键）：按 source_message_ids（L0 原话 id）反查 L1 记忆。
   * LIKE 预筛（id 子串命中，粗读成本有界）+ parseSourceMessageIds 精确集合复核（宁缺毋滥：
   * 无交集/坏 JSON 行不返回）+ rowMatchesIsolation 租户复核（filter 缺省=旧行为，不窄化）。
   * 返回按 updated_time DESC 的至多 limit 行；limit 硬上限 50（提取期只需「存在覆盖者」）。
   */
  findL1BySourceMessageIds(
    ids: string[],
    filter?: IsolationFilter,
    limit = 50,
  ): Array<{ record_id: string; source_message_ids: string[] }> {
    const wanted = Array.from(
      new Set((Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === "string" && id.length > 0)),
    ).slice(0, 20);
    if (wanted.length === 0) return [];
    const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : 50;
    try {
      // LIKE 通配符转义：id 里的 %/_/反斜杠 按字面匹配（JS 侧仍做精确复核，转义只为少读）。
      const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (ch) => "\\" + ch);
      const retrieveLimit = Math.min(Math.max(cap * 20, 100), 500);
      const where = wanted.map(() => "source_message_ids LIKE ? ESCAPE '\\'").join(" OR ");
      const rows = this.db
        .prepare(
          `SELECT record_id, source_message_ids, team_id, user_id, agent_id, session_id, task_id, session_key, updated_time
           FROM l1_records WHERE (${where}) ORDER BY updated_time DESC LIMIT ?`,
        )
        .all(...wanted.map((id) => `%${escapeLike(id)}%`), retrieveLimit) as Array<{
        record_id: string;
        source_message_ids: string | null;
        team_id: string;
        user_id: string;
        agent_id: string;
        session_id: string;
        task_id: string;
        session_key: string;
        updated_time?: string | null;
      }>;
      const wantedSet = new Set(wanted);
      const out: Array<{ record_id: string; source_message_ids: string[] }> = [];
      for (const row of rows) {
        if (out.length >= cap) break;
        if (!rowMatchesIsolation(row, filter)) continue;
        const parsed = parseSourceMessageIds(row.source_message_ids);
        if (parsed.length === 0) continue;
        if (!parsed.some((id) => wantedSet.has(id))) continue;
        out.push({ record_id: row.record_id, source_message_ids: parsed });
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [source_ids] findL1BySourceMessageIds failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
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
  searchL1ByScene(
    sceneNames: string[],
    limit = 10,
    filter?: IsolationFilter,
  ): Array<import("./types.js").L1SearchResult> {
    if (!sceneNames || sceneNames.length === 0 || limit <= 0) return [];
    const wanted = [
      ...new Set(
        sceneNames.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()),
      ),
    ];
    if (wanted.length === 0) return [];
    try {
      const conds = wanted.map(() => "(scene_name = ? OR scene_name LIKE ? || '/%')").join(" OR ");
      const args: Array<string | number> = [];
      for (const s of wanted) args.push(s, s);
      const rows = this.db
        .prepare(
          `SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id,
                  version, timestamp_str, timestamp_end, metadata_json, source_message_ids, updated_time,
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
        /** @deprecated ADR-0025 C3：列已删，恒取 timestamp_str。 */
        timestamp_start: string;
        timestamp_end: string;
        metadata_json: string;
        occurred_at?: string | null;
        valid_start?: string | null;
        valid_end?: string | null;
        certainty?: string | null;
        sensitivity?: string | null;
        valence?: number | null;
        arousal?: number | null;
        significance?: number | null;
        importance?: number | null;
        source_message_ids?: string | null;
        updated_time?: string | null;
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
          timestamp_start: r.timestamp_str,
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
          sensitivity: r.sensitivity ?? undefined,
          valence: r.valence ?? undefined,
          arousal: r.arousal ?? undefined,
          significance: r.significance ?? undefined,
          importance: r.importance ?? null,
          source_message_ids: parseSourceMessageIds(r.source_message_ids),
          // B 项：行最近更新时间（l1_records.updated_time 直取）
          updated_time: r.updated_time || undefined,
        });
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [scene] searchL1ByScene failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
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
                  version, timestamp_str, timestamp_end, metadata_json, source_message_ids, updated_time,
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
        /** @deprecated ADR-0025 C3：列已删，恒取 timestamp_str。 */
        timestamp_start: string;
        timestamp_end: string;
        metadata_json: string;
        occurred_at?: string | null;
        valid_start?: string | null;
        valid_end?: string | null;
        certainty?: string | null;
        sensitivity?: string | null;
        valence?: number | null;
        arousal?: number | null;
        significance?: number | null;
        importance?: number | null;
        source_message_ids?: string | null;
        updated_time?: string | null;
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
          timestamp_start: r.timestamp_str,
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
          sensitivity: r.sensitivity ?? undefined,
          valence: r.valence ?? undefined,
          arousal: r.arousal ?? undefined,
          significance: r.significance ?? undefined,
          importance: r.importance ?? null,
          source_message_ids: parseSourceMessageIds(r.source_message_ids),
          // B 项：行最近更新时间（l1_records.updated_time 直取）
          updated_time: r.updated_time || undefined,
        });
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [recall] searchL1ByType failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
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
  /**
   * B1 修正（2026-11-02）：按 record_id 批量读 l1_vec 的已入库向量。
   *
   * 为什么需要：巩固层属性归组的 embedding 兜底曾对池内记录逐条 `embed()`——生产实证
   * （3861 行进池 1903 条）→ 88 次 429/分钟、lifecycle tick 10 分钟不结束、L1 写入与召回
   * 全线降级。库里本来就有这些向量，重嵌是纯浪费配额。
   *
   * 合同：分片 IN 查询（避开 SQLITE 变量上限）；维度不符/空向量/未就绪 → 跳过该行；
   * 任何异常 → 返回尽力而为的 Map（warn 一次），绝不抛给调用方。
   */
  getL1VectorsByIds(ids: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    if (this.degraded || !this.vecTablesReady || this.dimensions <= 0) return out;
    const uniq = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)));
    if (uniq.length === 0) return out;
    const CHUNK = 400;
    try {
      for (let i = 0; i < uniq.length; i += CHUNK) {
        const chunk = uniq.slice(i, i + CHUNK);
        const sql = `SELECT record_id, embedding FROM l1_vec WHERE record_id IN (${chunk.map(() => "?").join(",")})`;
        const rows = this.db.prepare(sql).all(...chunk) as Array<{ record_id: string; embedding: Uint8Array }>;
        for (const row of rows) {
          const raw = row.embedding as unknown as Uint8Array | null;
          if (!raw || typeof raw.byteLength !== "number" || raw.byteLength !== this.dimensions * 4) continue;
          const buf = Buffer.from(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength);
          const vec = new Float32Array(this.dimensions);
          for (let k = 0; k < this.dimensions; k++) vec[k] = buf.readFloatLE(k * 4);
          out.set(String(row.record_id), vec);
        }
      }
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-vectors] batch read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out;
  }

  searchL1Vector(
    queryEmbedding: Float32Array,
    topK = 5,
    _queryText?: string,
    filter?: IsolationFilter,
  ): VectorSearchResult[] {
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
        Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength),
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
              /** @deprecated ADR-0025 C3：列已删，恒取 timestamp_str。 */
              timestamp_start: string;
              timestamp_end: string;
              metadata_json: string;
              occurred_at?: string;
              valid_start?: string;
              valid_end?: string;
              certainty?: string;
              valence?: number;
              arousal?: number;
              significance?: number;
              sensitivity?: string;
              importance?: number | null;
              source_message_ids?: string | null;
              /** B 项：stmtGetMeta 已 SELECT updated_time（行最近更新时间）。 */
              updated_time?: string;
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
          timestamp_start: meta.timestamp_str,
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
          valence: meta.valence ?? undefined,
          arousal: meta.arousal ?? undefined,
          significance: meta.significance ?? undefined,
          // D-3：敏感性透传（向量路 L1SearchResult 数据面——徽章/R11 信号源）
          sensitivity: meta.sensitivity ?? undefined,
          // P1-T7：importance 透传（NULL→null，未评分=召回面永不降权）
          importance: meta.importance ?? null,
          // P0-1：溯源列透传（stmtGetMeta 已 SELECT source_message_ids）
          source_message_ids: parseSourceMessageIds(meta.source_message_ids),
          // B 项：行最近更新时间透传（stmtGetMeta 已 SELECT updated_time）
          updated_time: meta.updated_time || undefined,
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
   * W1/C（#137）：写入「事实短语键」的平行向量（l1_fact_vec）。
   *
   * 事实键通道与原文主索引 l1_vec 完全解耦：本方法只碰 l1_fact_vec，
   * 不读不写 l1_vec / l1_records。vec0 无 ON CONFLICT → delete + insert。
   *
   * **Fault-tolerant**：degraded / vec 表未就绪 / 空向量 / 全零向量 / 维度不符 →
   * `false`（不写）；任何异常 log warn 后返回 false，绝不抛。
   */
  upsertL1FactVector(recordId: string, embedding: Float32Array, updatedTime?: string): boolean {
    if (this.degraded) return false;
    if (!this.vecTablesReady || !this.stmtDeleteFactVec || !this.stmtInsertFactVec) return false;
    if (!embedding || embedding.length === 0) {
      this.logger?.debug?.(`${TAG} [L1-fact-vec] skip empty embedding id=${recordId}`);
      return false;
    }
    if (embedding.length !== this.dimensions) {
      this.logger?.warn(
        `${TAG} [L1-fact-vec] dimension mismatch id=${recordId} (${embedding.length} != ${this.dimensions}) — skipped`,
      );
      return false;
    }
    // 零向量：cosine 未定义（vec0 返回 null distance），与 upsertL1 同口径不写入。
    let nonZero = false;
    for (let i = 0; i < embedding.length; i++) {
      if (embedding[i] !== 0) {
        nonZero = true;
        break;
      }
    }
    if (!nonZero) {
      this.logger?.debug?.(`${TAG} [L1-fact-vec] skip zero vector id=${recordId}`);
      return false;
    }
    try {
      const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
      const ts = updatedTime ?? this.getL1UpdatedTime(recordId) ?? new Date().toISOString();
      this.db.exec("BEGIN");
      try {
        this.stmtDeleteFactVec.run(recordId);
        this.stmtInsertFactVec.run(recordId, buf, ts);
        this.db.exec("COMMIT");
      } catch (txErr) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw txErr;
      }
      this.logger?.debug?.(`${TAG} [L1-fact-vec] OK id=${recordId} dims=${embedding.length}`);
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-fact-vec] upsert failed (non-fatal) id=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * W1/C（#137）：按事实键向量检索（KNN over l1_fact_vec）。
   *
   * 逐位镜像 searchL1Vector 的容错/映射：over-retrieve（topK + 10，带 filter 时
   * max(topK*5, topK+10)）→ null/NaN distance 跳过（零向量残留）→ 缺 metadata 的
   * orphan 跳过 → rowMatchesIsolation 两步过滤 → score = 1 - cosine distance。
   * degraded / vec 表未就绪 / 任何异常 → []（非致命）。
   */
  searchL1FactVector(queryEmbedding: Float32Array, topK = 5, filter?: IsolationFilter): L1SearchResult[] {
    if (this.degraded || !this.vecTablesReady || !this.stmtSearchFactVec) {
      if (this.degraded) this.logger?.warn(`${TAG} [L1-fact-search] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      const ZERO_VEC_BUFFER = 10;
      const retrieveCount = filter ? Math.max(topK * 5, topK + ZERO_VEC_BUFFER) : topK + ZERO_VEC_BUFFER;

      this.logger?.debug?.(
        `${TAG} [L1-fact-search] START topK=${topK}, retrieveCount=${retrieveCount}, queryEmbeddingDims=${queryEmbedding.length}`,
      );

      const rows = this.stmtSearchFactVec.all(
        Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength),
        retrieveCount,
      ) as Array<{ record_id: string; distance: number }>;

      this.logger?.debug?.(`${TAG} [L1-fact-search] vec0 returned ${rows.length} candidate(s)`);

      if (rows.length === 0) return [];

      const results: L1SearchResult[] = [];

      for (const { record_id, distance } of rows) {
        if (distance == null || Number.isNaN(distance)) {
          this.logger?.warn(
            `${TAG} [L1-fact-search] record_id=${record_id} has null/NaN distance (likely zero vector) — skipping`,
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
              /** @deprecated ADR-0025 C3：列已删，恒取 timestamp_str。 */
              timestamp_start: string;
              timestamp_end: string;
              metadata_json: string;
              occurred_at?: string;
              valid_start?: string;
              valid_end?: string;
              certainty?: string;
              valence?: number;
              arousal?: number;
              significance?: number;
              sensitivity?: string;
              importance?: number | null;
              source_message_ids?: string | null;
              /** B 项：stmtGetMeta 已 SELECT updated_time（行最近更新时间）。 */
              updated_time?: string;
            }
          | undefined;

        if (!meta) {
          this.logger?.warn(`${TAG} [L1-fact-search] record_id=${record_id} has fact vector but NO metadata (orphan)`);
          continue;
        }
        if (!rowMatchesIsolation(meta, filter)) {
          continue;
        }

        const score = 1.0 - distance;
        results.push({
          record_id,
          content: meta.content,
          type: meta.type,
          priority: meta.priority,
          scene_name: meta.scene_name,
          score,
          timestamp_str: meta.timestamp_str,
          timestamp_start: meta.timestamp_str,
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
          valence: meta.valence ?? undefined,
          arousal: meta.arousal ?? undefined,
          significance: meta.significance ?? undefined,
          sensitivity: meta.sensitivity ?? undefined,
          importance: meta.importance ?? null,
          // P0-1：溯源列透传（stmtGetMeta 已 SELECT source_message_ids）
          source_message_ids: parseSourceMessageIds(meta.source_message_ids),
          // B 项：行最近更新时间透传（stmtGetMeta 已 SELECT updated_time）
          updated_time: meta.updated_time || undefined,
        });
      }

      const trimmed = results.slice(0, topK);
      this.logger?.info(
        `${TAG} [L1-fact-search] DONE returning ${trimmed.length} result(s) (from ${results.length} valid, ${rows.length} raw)`,
      );
      return trimmed;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-fact-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /** #137：读 l1_records.updated_time（fact 通道写入缺省沿用它，保证 deleteL1Expired 口径一致）。 */
  private getL1UpdatedTime(recordId: string): string | undefined {
    try {
      const row = this.db.prepare("SELECT updated_time FROM l1_records WHERE record_id = ?").get(recordId) as
        { updated_time?: string } | undefined;
      const ts = row?.updated_time;
      return typeof ts === "string" && ts !== "" ? ts : undefined;
    } catch {
      return undefined;
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
        const meta = this.stmtGetMeta.get(recordId) as
          { user_id?: string; agent_id?: string; session_id?: string; session_key?: string } | undefined;
        if (!meta || !rowMatchesIsolation(meta, filter)) return false;
      }
      this.db.exec("BEGIN");
      try {
        const result = this.stmtDeleteMeta.run(recordId);
        const deleted = (result as any)?.changes > 0;
        if (this.vecTablesReady) this.stmtDeleteVec!.run(recordId);
        // #137：硬删同步清事实键通道向量
        if (this.stmtDeleteFactVec) this.stmtDeleteFactVec.run(recordId);
        if (this.ftsAvailable) {
          try {
            this.stmtL1FtsDelete.run(recordId);
          } catch {
            /* non-fatal */
          }
        }
        // 图设计 §5：删除时级联删除其边（硬删路径；archive 路径不删——边指向归档记录合法）。
        try {
          this.deleteLinksFor(recordId);
        } catch {
          /* non-fatal */
        }
        this.db.exec("COMMIT");
        return deleted;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(`${TAG} delete failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
            const meta = this.stmtGetMeta.get(id) as
              { user_id?: string; agent_id?: string; session_id?: string; session_key?: string } | undefined;
            if (!meta || !rowMatchesIsolation(meta, filter)) continue;
          }
          this.stmtDeleteMeta.run(id);
          if (this.vecTablesReady) this.stmtDeleteVec!.run(id);
          // #137：批量硬删同步清事实键通道向量
          if (this.stmtDeleteFactVec) this.stmtDeleteFactVec.run(id);
          if (this.ftsAvailable) {
            try {
              this.stmtL1FtsDelete.run(id);
            } catch {
              /* non-fatal */
            }
          }
          // 图设计 §5：硬删批量时也级联删边。
          try {
            this.deleteLinksFor(id);
          } catch {
            /* non-fatal */
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} deleteBatch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
      const row = this.db.prepare("SELECT metadata_json FROM l1_records WHERE record_id = ?").get(id) as
        { metadata_json?: string } | undefined;
      if (!row) return false;
      let meta: Record<string, unknown> = {};
      try {
        meta = row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {};
      } catch {
        meta = {};
      }
      const merged = JSON.stringify({ ...meta, ...patch });
      const res = this.db
        .prepare("UPDATE l1_records SET metadata_json = ?, updated_time = ? WHERE record_id = ?")
        .run(merged, new Date().toISOString(), id);
      return ((res as unknown as { changes?: number }).changes ?? 0) > 0;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [reconsolidation] updateL1Metadata failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      this.logger?.warn?.(
        `${TAG} [reconsolidation] bumpRecallCount 跳过损坏 metadata_json（每行仅 warn 一次）record_id=${id}: ${detail}`,
      );
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
      const cur = this.db.prepare("SELECT metadata_json FROM l1_records WHERE record_id = ?").get(id) as
        { metadata_json?: string | null } | undefined;
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
      this.logger?.warn?.(
        `${TAG} [reconsolidation] bumpRecallCount failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      const res = this.db
        .prepare(
          "UPDATE l1_records SET valid_end = ?, updated_time = ? WHERE record_id = ? AND (valid_end IS NULL OR valid_end = '')",
        )
        .run(validEndIso, new Date().toISOString(), id);
      if (((res as unknown as { changes?: number }).changes ?? 0) === 0) return false;
      this.db
        .prepare("UPDATE l1_fts SET valid_end = ? WHERE record_id = ? AND (valid_end IS NULL OR valid_end = '')")
        .run(validEndIso, id);
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
      } catch {
        /* 定位失败不影响失效回写 */
      }
      return true;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [invalidation] invalidateL1 failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * A 项（ADR-0025 决定 10，2026-11-04）：显式降敏——L1 行 sensitivity 单向棘轮下调。
   *
   * 与 upsertL1 的分工：upsert 的粘性 CASE（:1358-1371）把 'none'/'' 当作「本次未判定」，
   * 只能用新值**升**级或继承旧值，永远无法把已分类行降回 none——所以降敏必须走单条
   * UPDATE（CAS：AND sensitivity = expect）。
   *
   * 三件必做事（缺一即错）：
   *   1. CAS 条件带 expect，changes === 0 → false（行不存在 / expect 不符 / 并发已改，
   *      三者不区分，不泄漏行存在性；调用方映射 409）；
   *   2. l1_fts 双写——sensitivity 是 soul 列，FTS 表存 UNINDEXED 副本，只改主表会让
   *      FTS 召回路读到 stale 敏感标注（invalidateL1 踩过同款，P2 实测）；
   *   3. bump updated_time——否则「最近更新」看不出这次人工动作（L2 增量游标也随之漏）。
   *
   * 单向棘轮的下限不带任何「升级」逻辑：value 由调用方给出（网关侧白名单四项枚举），
   * 本方法只负责「把值写下去且并发安全」，判定权在网关 + 面板二次确认。
   * 返回值语义（2026-11-04 对抗评审 P1 修复）：
   *   - `true`  = 主表 + l1_fts 同一事务提交成功；
   *   - `false` = 纯 CAS 未命中（行不存在 / expect 不符 / 并发已改）——调用方映射 409；
   *   - **抛错** = degraded / SQL 失败——调用方映射 503。此前两类都返回 false，网关一律回
   *     409「CAS 未命中」，且主表已 commit、FTS 写失败时客户端按并发冲突重试永远失败、
   *     审计也没有行（三方分裂）。异常必须能区分，故用 throw 而不是 false。
   *
   * 原子性：两条 UPDATE 不在一个事务里时，第二条失败会留下「主表已降、FTS 仍敏感」的
   * 半写状态（FTS 是 UNINDEXED 副本，召回走 FTS 腿仍拦），因此整体 BEGIN IMMEDIATE。
   */
  setL1Sensitivity(recordId: string, value: string, expect: string): boolean {
    if (this.degraded) throw new Error("store degraded（无法执行显式降敏）");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      // COALESCE(sensitivity,'none')：存量行（#83 之前）列值为 NULL，语义等同 none；
      // 其余脏值（如 'unclassified' 以外的任意串）严格相等才命中——脏行改不了，留给人工修。
      const res = this.db
        .prepare(
          "UPDATE l1_records SET sensitivity = ?, updated_time = ? WHERE record_id = ? AND COALESCE(sensitivity, 'none') = ?",
        )
        .run(value, now, recordId, expect);
      if (((res as unknown as { changes?: number }).changes ?? 0) === 0) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare("UPDATE l1_fts SET sensitivity = ? WHERE record_id = ?").run(value, recordId);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 事务可能已结束 */
      }
      this.logger?.warn?.(
        `${TAG} [sensitivity] setL1Sensitivity failed for ${recordId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * #146（W2b 事实级双时态）：按事实键（metadata_json.fact_key）批量失效同（实体,属性）的事实行。
   *
   * 与 invalidateL1 的分工：invalidateL1 是"已知行 id"的单行回写；本方法把
   * "同实体同属性的旧事实"这一语义查询下沉到写面（L1QueryFilter 没有 metadata 过滤能力，
   * 故用 JSON1 直查）。只写 valid_end（失效不删除、不改写正文），已失效行不重复命中；
   * 命中行仍逐条走 invalidateL1 主表 + l1_fts 双写，FTS 路不读到 stale valid_end。
   * filter 缺省 = 实例级全量（旧后端/单机兼容）；生产写侧传 team/user/agent 三元组。
   */
  invalidateL1ByFactKey(filter: IsolationFilter | undefined, factKey: string, validEndIso: string): number {
    if (this.degraded) {
      // 事实行模式下这是**唯一**的失效通道：静默 0 = 失效永久不生效且无任何线索，
      // 对齐 deleteL1Expired 的 loud warn 口径。
      this.logger?.warn?.(`${TAG} [W2b-fact-rows] invalidateL1ByFactKey SKIPPED (degraded mode) key=${factKey}`);
      return 0;
    }
    const key = typeof factKey === "string" ? factKey.trim() : "";
    if (!key) return 0;
    try {
      const where = buildIsolationWhere(filter, "");
      const rows = this.db
        .prepare(
          // WHERE 表达式必须与 idx_l1_fact_key_valid 的定义**逐字一致**，否则规划器不选索引（实测
          // 改成裸 json_extract + json_valid 断言会退化成全表扫描）；json_valid 守卫同时保证
          // 损坏的 metadata_json 行只被跳过、不会让本语句抛 malformed JSON。
          `SELECT record_id FROM l1_records
          WHERE json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json END, '$.fact_key') = ?
            AND (valid_end IS NULL OR valid_end = '')` + (where.clause ? ` AND ${where.clause}` : ""),
        )
        .all(key, ...where.params) as unknown as Array<{ record_id: string }>;
      let invalidated = 0;
      for (const row of rows) {
        if (this.invalidateL1(row.record_id, validEndIso)) invalidated++;
      }
      if (invalidated > 0) {
        this.logger?.info?.(
          `${TAG} [W2b-fact-rows] fact_key invalidation: ${invalidated}/${rows.length} row(s) marked valid_end=${validEndIso}`,
        );
      }
      return invalidated;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [W2b-fact-rows] invalidateL1ByFactKey failed for key=${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  deleteL1Expired(cutoffIso: string): number {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [deleteExpired] SKIPPED (degraded mode)`);
      return 0;
    }
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM l1_records WHERE updated_time != '' AND updated_time < ?")
        .get(cutoffIso) as { cnt: number } | undefined;
      const expiredCount = row?.cnt ?? 0;
      if (expiredCount <= 0) return 0;

      // Ratio protection: refuse to delete > 80% in one pass
      const totalRow = this.db.prepare("SELECT COUNT(*) AS cnt FROM l1_records").get() as { cnt: number };
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
          this.db.prepare("DELETE FROM l1_vec WHERE updated_time != '' AND updated_time < ?").run(cutoffIso);
          // #137：过期清理同步清事实键通道（同 updated_time 口径；表可能尚未建立 → 容错）
          try {
            this.db.prepare("DELETE FROM l1_fact_vec WHERE updated_time != '' AND updated_time < ?").run(cutoffIso);
          } catch {
            /* fact 表可能未建，非致命 */
          }
        }
        this.db.prepare("DELETE FROM l1_records WHERE updated_time != '' AND updated_time < ?").run(cutoffIso);
        this.db.exec("COMMIT");
        this.logger?.info?.(`${TAG} [L1-deleteExpired] Deleted ${expiredCount}/${total} records (cutoff=${cutoffIso})`);
        return expiredCount;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
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

  /**
   * EMBED-BACKFILL R2（09-27 根治）：向量缺口补偿器。
   * 列出无向量 L1（metadata-only 行）→ 逐条 embed → 事务 delete+insert vec → 销账。
   * 失败行保留待下轮重试；维度不匹配拒写（防脏向量入库）。
   * 根因登记：reflection/consolidation/evolution 写链结构性不传 embedding（缺口 380 行全 rf_/consolidated）。
   */
  async backfillL1Vectors(
    embedFn: (text: string) => Promise<Float32Array>,
    limit = 50,
  ): Promise<{ scanned: number; backfilled: number; failed: number }> {
    if (this.degraded || !this.vecTablesReady) return { scanned: 0, backfilled: 0, failed: 0 };
    const rows = this.db
      .prepare(
        "SELECT record_id, content, updated_time FROM l1_records WHERE record_id NOT IN (SELECT id FROM l1_vec_rowids) LIMIT ?",
      )
      .all(limit) as Array<{ record_id: string; content: string; updated_time: string }>;
    let backfilled = 0;
    let failed = 0;
    for (const { record_id, content, updated_time } of rows) {
      try {
        const embedding = await embedFn(content);
        if (!embedding || embedding.length !== this.dimensions) {
          failed++;
          continue;
        }
        this.db.exec("BEGIN");
        try {
          this.stmtDeleteVec!.run(record_id);
          this.stmtInsertVec!.run(
            record_id,
            Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
            updated_time,
          );
          // #137：这里只补**主索引**向量（content 重嵌），事实键通道向量不是它的副产品——
          // 不许顺手删（否则「主向量缺失但事实向量已在」的行会被无谓清空，且不会自动回填）。
          // 维度/模型换代的全量重建走 reindexAll（那里才删）。
          this.db.exec("COMMIT");
          backfilled++;
        } catch (txErr) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            /* ignore */
          }
          failed++;
        }
      } catch {
        failed++;
      }
    }
    return { scanned: rows.length, backfilled, failed };
  }

  /** EMBED-BACKFILL R2-2（09-27 口径根治）：有向量的 L1 条数（记录粒度，多 chunk 不重复计）。 */
  countL1WithVectors(): number {
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS n FROM l1_records WHERE record_id IN (SELECT DISTINCT id FROM l1_vec_rowids)")
        .get() as { n: number };
      return row?.n ?? 0;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} countL1WithVectors failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
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
      const row = this.db.prepare(`SELECT COUNT(*) AS cnt FROM l1_records ${where}`).get(...params) as
        { cnt: number } | undefined;
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
        `${TAG} [L1-query] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
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
      const skipVec = !embedding || embedding.every((v) => v === 0) || !this.vecTablesReady;

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
          // #83：行级分类标签（未传=unclassified；冲突时保留原值——classification
          // 刻意不在 ON CONFLICT UPDATE SET 中，防止旧写入把已回填标签降级）
          (record as L0Record & { classification?: string }).classification ?? "unclassified",
        );

        if (!skipVec) {
          // vec0 does not support ON CONFLICT → delete then insert
          this.stmtL0DeleteVec!.run(record.id);
          this.stmtL0InsertVec!.run(
            record.id,
            Buffer.from(embedding!.buffer, embedding!.byteOffset, embedding!.byteLength),
            record.recordedAt,
          );
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
              record.messageText, // message_text_original — raw for display
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
        } catch {
          /* ignore rollback errors */
        }
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
    if (!embedding || embedding.every((v) => v === 0)) {
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
        this.stmtL0InsertVec!.run(
          recordId,
          Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
          meta.recorded_at,
        );
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
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
  searchL0Vector(
    queryEmbedding: Float32Array,
    topK = 5,
    _queryText?: string,
    filter?: IsolationFilter,
  ): L0VectorSearchResult[] {
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
      const retrieveCount = filter
        ? Math.max(topK * 5, topK + VectorStore.ZERO_VEC_BUFFER)
        : topK + VectorStore.ZERO_VEC_BUFFER;

      this.logger?.debug?.(
        `${TAG} [L0-search] START topK=${topK}, retrieveCount=${retrieveCount}, ` +
          `queryEmbeddingDims=${queryEmbedding.length}, ` +
          `queryNorm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
      );

      const rows = this.stmtL0SearchVec!.all(
        Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength),
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
        const meta = this.stmtL0GetMeta.get(recordId) as
          { user_id?: string; agent_id?: string; session_id?: string; session_key?: string } | undefined;
        if (!meta || !rowMatchesIsolation(meta, filter)) return false;
      }
      this.db.exec("BEGIN");
      try {
        const result = this.stmtL0DeleteMeta.run(recordId);
        const deleted = (result as any)?.changes > 0;
        if (this.vecTablesReady) this.stmtL0DeleteVec!.run(recordId);
        if (this.ftsAvailable) {
          try {
            this.stmtL0FtsDelete.run(recordId);
          } catch {
            /* non-fatal */
          }
        }
        this.db.exec("COMMIT");
        return deleted;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(`${TAG} deleteL0 failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
      const row = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM l0_conversations WHERE recorded_at != '' AND recorded_at < ?")
        .get(cutoffIso) as { cnt: number } | undefined;
      const expiredCount = row?.cnt ?? 0;
      if (expiredCount <= 0) return 0;

      // Ratio protection: refuse to delete > 80% in one pass
      const totalRow = this.db.prepare("SELECT COUNT(*) AS cnt FROM l0_conversations").get() as { cnt: number };
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
          this.db.prepare("DELETE FROM l0_vec WHERE recorded_at != '' AND recorded_at < ?").run(cutoffIso);
        }
        this.db.prepare("DELETE FROM l0_conversations WHERE recorded_at != '' AND recorded_at < ?").run(cutoffIso);
        this.db.exec("COMMIT");
        this.logger?.info?.(`${TAG} [L0-deleteExpired] Deleted ${expiredCount}/${total} records (cutoff=${cutoffIso})`);
        return expiredCount;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
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
      const row = this.db.prepare(`SELECT COUNT(*) AS cnt FROM l0_conversations ${where}`).get(...params) as
        { cnt: number } | undefined;
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
      return this.db.prepare("SELECT record_id, content, updated_time FROM l1_records").all() as Array<{
        record_id: string;
        content: string;
        updated_time: string;
      }>;
    } catch (err) {
      this.logger?.warn(`${TAG} getAllL1Texts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
      return this.db.prepare("SELECT record_id, message_text, recorded_at FROM l0_conversations").all() as Array<{
        record_id: string;
        message_text: string;
        recorded_at: string;
      }>;
    } catch (err) {
      this.logger?.warn(`${TAG} getAllL0Texts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
            this.stmtInsertVec!.run(
              record_id,
              Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
              updated_time,
            );
            // #137：全量重建（维度/模型变更）后事实键通道旧向量必然失配 → 一并作废
            if (this.stmtDeleteFactVec) this.stmtDeleteFactVec.run(record_id);
            this.db.exec("COMMIT");
          } catch (txErr) {
            try {
              this.db.exec("ROLLBACK");
            } catch {
              /* ignore */
            }
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
            this.stmtL0InsertVec!.run(
              record_id,
              Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
              recorded_at,
            );
            this.db.exec("COMMIT");
          } catch (txErr) {
            try {
              this.db.exec("ROLLBACK");
            } catch {
              /* ignore */
            }
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

      this.logger?.info(`${TAG} Reindex complete: L1=${l1Done}/${l1Rows.length}, L0=${l0Done}/${l0Rows.length}`);

      return { l1Count: l1Done, l0Count: l0Done };
    } catch (err) {
      this.logger?.error(`${TAG} reindexAll failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
  queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit = 50): L0QueryRow[] {
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
        classification: (r.classification as string) || "",
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
      const rows = this.db
        .prepare("SELECT DISTINCT session_id FROM l0_conversations WHERE session_id != ''")
        .all() as Array<{ session_id: string }>;
      return rows.map((r) => r.session_id);
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-sessions] list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** D-R3-2（任务6，2026-09-24）：L0 会话键存在性查询——boot recovery 死键过滤数据前提。
   *  与 listL0SessionIds 同族语义（session_id 跨租户全局键，无租户参数）；只读零写库；
   *  degraded/空串/异常 → false（宁缺毋滥不误挂定时器）。 */
  hasL0Session(sessionId: string): boolean {
    if (this.degraded) return false;
    const sid = String(sessionId ?? "");
    if (sid === "") return false;
    try {
      const row = this.db.prepare("SELECT 1 FROM l0_conversations WHERE session_id = ? LIMIT 1").get(sid);
      return row !== undefined;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-sessions] hasL0Session failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** F-DUP-1（任务5，2026-09-25）：L0 入口幂等查重——同 session+role+content 在 windowMs
   *  窗口内已有落库行则 true（DSH 插件按每轮 LLM 调用重复提交同条用户消息的污染面修复）。
   *  键=逐字比对（session_key+role+message_text）；时间基准=recorded_at；只读零写库；
   *  degraded/空参数/异常/非法窗口 → false（宁缺毋滥不误跳真实消息）。 */
  hasRecentL0Duplicate(sessionKey: string, role: string, content: string, windowMs: number): boolean {
    if (this.degraded) return false;
    const sk = String(sessionKey ?? "");
    const r = String(role ?? "");
    const c = String(content ?? "");
    if (sk === "" || r === "" || c === "") return false;
    const w = Number(windowMs) > 0 ? Number(windowMs) : 0;
    if (w <= 0) return false;
    const sinceIso = new Date(Date.now() - w).toISOString();
    try {
      const row = this.db
        .prepare(
          "SELECT 1 FROM l0_conversations WHERE session_key = ? AND role = ? AND message_text = ? AND recorded_at >= ? LIMIT 1",
        )
        .get(sk, r, c, sinceIso);
      return row !== undefined;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-dup] hasRecentL0Duplicate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Query L0 messages for a given session key, grouped by session_id.
   * Each group's messages are in chronological order (recorded_at ASC).
   * Groups are sorted by earliest message timestamp.
   *
   * Used by L1 runner to replace readConversationMessagesGroupedBySessionId().
   */
  /** 事件挖掘输入：窗口内原始对话（含 role），按时间正序返回。
   *  只读、零写库；先取最近 N 条再反转，避免窗口大时全表排序。 */
  recentL0Messages(
    tenant?: CoreTenant,
    opts?: { sinceDays?: number; maxMessages?: number; sinceIso?: string },
  ): Array<{
    record_id: string;
    session_id: string;
    role: string;
    message_text: string;
    recorded_at: string;
    timestamp?: number;
    /** 真实说话人/agent 身份（显式列出，不用 SELECT *）。老行缺失时字段不设。 */
    user_id?: string;
    agent_id?: string;
  }> {
    if (this.degraded) return [];
    const t = normalizeCoreTenant(tenant);
    const days = Math.max(1, Math.min(365, Math.floor(opts?.sinceDays ?? 30)));
    const max = Math.max(1, Math.min(20000, Math.floor(opts?.maxMessages ?? 4000)));
    // S10（2026-11-07）：清库重生水位——水位之后的 L0 才参与派生，避免首个 tick 把旧对话
    // 重抽成事件、当天复活旧人格（spec §8）。sinceIso 早于常规窗口时以窗口为准。
    const windowSince = new Date(Date.now() - days * 86_400_000).toISOString();
    const asked = typeof opts?.sinceIso === "string" ? Date.parse(opts.sinceIso) : NaN;
    const since =
      Number.isFinite(asked) && asked > Date.parse(windowSince) ? new Date(asked).toISOString() : windowSince;
    try {
      const rows = this.db
        .prepare(
          `SELECT record_id, session_id, role, message_text, recorded_at, timestamp, user_id, agent_id
             FROM l0_conversations
            WHERE team_id = ? AND user_id = ? AND agent_id = ?
              AND message_text != '' AND recorded_at >= ?
            ORDER BY recorded_at DESC, record_id DESC
            LIMIT ?`,
        )
        .all(t.teamId, t.userId, t.agentId, since, max) as unknown as Array<{
        record_id: string;
        session_id: string | null;
        role: string | null;
        message_text: string | null;
        recorded_at: string | null;
        timestamp: number | null;
        user_id: string | null;
        agent_id: string | null;
      }>;
      return (rows ?? [])
        .map((r) => ({
          record_id: String(r.record_id ?? ""),
          session_id: String(r.session_id ?? ""),
          role: String(r.role ?? ""),
          message_text: String(r.message_text ?? ""),
          recorded_at: String(r.recorded_at ?? ""),
          timestamp: Number(r.timestamp ?? 0),
          // 空串不设字段：调用侧用「有没有 user_id」决定走平台身份还是展示名回退，
          // 给一个 "" 会让两条路径都以为自己拿到了身份。
          ...(String(r.user_id ?? "") !== "" ? { user_id: String(r.user_id) } : {}),
          ...(String(r.agent_id ?? "") !== "" ? { agent_id: String(r.agent_id) } : {}),
        }))
        .reverse();
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-recent] recentL0Messages failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * S10（2026-11-07）：清库重生水位与其它一次性升级标记。
   * 复用 embedding_meta（key/value，同库同连接），不新增表、不新增配置——它是「数据」不是「开关」。
   * 读失败一律返回 undefined（fail-open：宁可多抽一轮，也不能因缺标记崩 tick）。
   */
  soulMetaGet(key: string): string | undefined {
    try {
      const row = this.db.prepare("SELECT value FROM embedding_meta WHERE key = ?").get(`soul.${key}`) as
        { value?: string } | undefined;
      const v = row?.value;
      return typeof v === "string" && v !== "" ? v : undefined;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul-meta] read failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  soulMetaSet(key: string, value: string): void {
    try {
      this.db
        .prepare(
          "INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(`soul.${key}`, value);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [soul-meta] write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  queryL0GroupedBySessionId(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit = 50,
  ): Array<{
    sessionId: string;
    teamId?: string;
    taskId?: string;
    userId: string;
    agentId: string;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      timestamp: number;
      recordedAtMs: number;
      classification?: string;
    }>;
  }> {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-query-grouped] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      const rows = this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit);

      // Group by full isolation tuple + session_id to avoid cross-tenant merging.
      const groupMap = new Map<
        string,
        {
          sessionId: string;
          teamId?: string;
          taskId?: string;
          userId: string;
          agentId: string;
          messages: Array<{
            id: string;
            role: string;
            content: string;
            timestamp: number;
            recordedAtMs: number;
            classification?: string;
          }>;
        }
      >();
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
          classification: row.classification,
        });
      }

      // Convert to array, sorted by earliest message timestamp
      const groups: Array<{
        sessionId: string;
        teamId?: string;
        taskId?: string;
        userId: string;
        agentId: string;
        messages: Array<{
          id: string;
          role: string;
          content: string;
          timestamp: number;
          recordedAtMs: number;
          classification?: string;
        }>;
      }> = [];
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
   * L0 batch read by record_id (ADR-0025 行级溯源：L1.source_message_ids → 原始消息)。
   *
   * 空 ids 直接返回 []（不拼 SQL、不触库）；iso 各轴按 `!== undefined` 收窄
   * ——与 queryL0Paginated 同口径，跨租户 id 因此静默查不到（不泄露存在性）。
   * 返回序按 timestamp 升序（原话按发生顺序读，不是分页倒序）。
   */
  queryL0ByIds(ids: string[], filter: L0ByIdsFilter = {}): L0QueryRow[] {
    if (this.degraded || ids.length === 0) return [];

    try {
      const placeholders = ids.map(() => "?").join(", ");
      const conditions: string[] = [`record_id IN (${placeholders})`];
      const params: SQLInputValue[] = [...ids];

      // Isolation dimensions — same axes as queryL0Paginated.
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

      const dataSql = `SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp FROM l0_conversations WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC, record_id ASC`;
      return this.db.prepare(dataSql).all(...params) as unknown as L0QueryRow[];
    } catch (err) {
      this.logger?.warn(`[sqlite] queryL0ByIds failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
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
      const dataSql = `SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_end, created_time, updated_time, metadata_json, occurred_at, valid_start, valid_end, certainty, valence, arousal, significance, sensitivity, importance, source_message_ids FROM l1_records ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`;
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
      const rows = this.db
        .prepare(
          "SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id FROM l0_conversations WHERE session_key = ? OR session_id = ?",
        )
        .all(sessionIdTrimmed, sessionIdTrimmed) as Array<{
        record_id: string;
        session_key: string;
        session_id: string;
        team_id: string;
        task_id: string;
        user_id: string;
        agent_id: string;
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
            try {
              this.db.prepare("DELETE FROM l0_vec WHERE record_id = ?").run(row.record_id);
            } catch {
              /* vec may not exist */
            }
          }
          if (this.ftsAvailable) {
            try {
              this.db.prepare("DELETE FROM l0_fts WHERE record_id = ?").run(row.record_id);
            } catch {
              /* fts may not exist */
            }
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
      const l0Ids = (
        this.db.prepare(`SELECT record_id FROM l0_conversations WHERE ${where}`).all(...params) as Array<{
          record_id: string;
        }>
      ).map((r) => r.record_id);
      const l1Ids = (
        this.db.prepare(`SELECT record_id FROM l1_records WHERE ${where}`).all(...params) as Array<{
          record_id: string;
        }>
      ).map((r) => r.record_id);

      const derived = this.countAgentDerivedRows(teamId, agentId, userId);
      if (l0Ids.length === 0 && l1Ids.length === 0 && derived === 0) return empty;

      this.db.exec("BEGIN");
      try {
        let l0Deleted = 0;
        for (const id of l0Ids) {
          const res = this.db.prepare("DELETE FROM l0_conversations WHERE record_id = ?").run(id);
          if (((res as any)?.changes ?? 0) <= 0) continue;
          l0Deleted++;
          if (this.vecTablesReady) {
            try {
              this.db.prepare("DELETE FROM l0_vec WHERE record_id = ?").run(id);
            } catch {
              /* vec may not exist */
            }
          }
          if (this.ftsAvailable) {
            try {
              this.db.prepare("DELETE FROM l0_fts WHERE record_id = ?").run(id);
            } catch {
              /* fts may not exist */
            }
          }
        }

        let l1Deleted = 0;
        for (const id of l1Ids) {
          const res = this.db.prepare("DELETE FROM l1_records WHERE record_id = ?").run(id);
          if (((res as any)?.changes ?? 0) <= 0) continue;
          l1Deleted++;
          if (this.vecTablesReady) {
            try {
              this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?").run(id);
            } catch {
              /* vec may not exist */
            }
            // #137：清空租户内容同步清事实键通道向量
            try {
              this.db.prepare("DELETE FROM l1_fact_vec WHERE record_id = ?").run(id);
            } catch {
              /* vec may not exist */
            }
          }
          if (this.ftsAvailable) {
            try {
              this.db.prepare("DELETE FROM l1_fts WHERE record_id = ?").run(id);
            } catch {
              /* fts may not exist */
            }
          }
        }

        this.deleteAgentDerivedRows(teamId, agentId, userId);
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

  /** 删 agent 时要一起清的派生表。顺序无关：都按 team+agent 删。 */
  private agentDerivedTables(): string[] {
    return [
      "soul_persona",
      "soul_episodes",
      "soul_emotions",
      "soul_state",
      "soul_trait_state",
      "soul_ledger",
      "soul_gate_stats",
      "soul_snapshots",
      "soul_promises",
      "soul_promise_events",
      "soul_person",
      "soul_person_relation",
      "core_memory",
      "l1_archive",
      // P0 事件底座：基表按 team+agent 删；四张子表只有 event_id，先按父查询清。
      "soul_events",
      // P0 结构化表：都带 team/user/agent，可直接按租户删；带 goal_id/narrative_id 的子表
      // 在 deleteSoulStructuredChildren 里按父查询清。
      "soul_person_state",
      "soul_person_state_events",
      "soul_goals",
      "soul_self_model",
      "soul_calibration",
      "soul_mood_state",
      "soul_mood_events",
      "soul_narrative",
      "soul_values",
      "soul_gate_log",
      "soul_dilemma",
      "soul_working_state",
    ];
  }

  /**
   * 这张表能不能按 team+agent 删。缺表或缺列返回 null，调用方跳过。
   * userId 给了但表没有 user_id 列时也跳过：不能把「收窄不到人」退化成「删整个 agent」。
   */
  private agentDerivedScope(
    table: string,
    teamId: string,
    agentId: string,
    userId: string | undefined,
  ): { where: string; params: string[] } | null {
    const cols = this.db.prepare("PRAGMA table_info(" + table + ")").all() as Array<{ name: string }>;
    if (cols.length === 0) return null;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("agent_id") || !names.has("team_id")) return null;
    if (userId && !names.has("user_id")) return null;
    const where = "team_id = ? AND agent_id = ?" + (userId ? " AND user_id = ?" : "");
    const params = userId ? [teamId, agentId, userId] : [teamId, agentId];
    return { where, params };
  }

  /** 这个 agent 还有多少派生行。表缺列就跳过，不把缺列当成别的数。 */
  private countAgentDerivedRows(teamId: string, agentId: string, userId: string | undefined): number {
    return this.agentDerivedTables().reduce((sum, table) => {
      const scope = this.agentDerivedScope(table, teamId, agentId, userId);
      if (!scope) return sum;
      const row = this.db
        .prepare("SELECT count(*) AS c FROM " + table + " WHERE " + scope.where)
        .get(...scope.params) as { c: number } | undefined;
      return sum + Number(row?.c ?? 0);
    }, 0);
  }

  /**
   * 删一个 agent 的派生行。只在 clearMemoryContent 的事务里调用，自己不开事务。
   * 不碰 soul_trait_label：它的键是 tenant_id，写侧只用 teamId，清一个 agent 会误删同队其它人的标签。
   * 不碰 embedding_meta 的 episodeWatermark：那是全库一份，改它等于让别的 agent 重抽旧对话。
   */
  private deleteAgentDerivedRows(teamId: string, agentId: string, userId: string | undefined): void {
    // 子表先于父表清。store 没有开 PRAGMA foreign_keys，DDL 的 ON DELETE CASCADE 不生效，
    // 顺序错了就会留下指向已删事件的证据/行动行。
    this.deleteSoulEventChildren(teamId, agentId, userId);
    this.deleteSoulStructuredChildren(teamId, agentId, userId);
    for (const table of this.agentDerivedTables()) {
      const scope = this.agentDerivedScope(table, teamId, agentId, userId);
      if (!scope) continue;
      this.db.prepare("DELETE FROM " + table + " WHERE " + scope.where).run(...scope.params);
    }
  }

  /** 事件子表只有 event_id，按父事件租户范围先清四张。 */
  private deleteSoulEventChildren(teamId: string, agentId: string, userId: string | undefined): void {
    const scope = this.agentDerivedScope("soul_events", teamId, agentId, userId);
    if (!scope) return;
    for (const table of ["soul_event_evidence", "soul_event_chat", "soul_event_action", "soul_event_reflection"]) {
      try {
        this.db
          .prepare(
            "DELETE FROM " + table + " WHERE event_id IN (SELECT event_id FROM soul_events WHERE " + scope.where + ")",
          )
          .run(...scope.params);
      } catch {
        /* 表还没建：跳过，不把缺表当清理成功 */
      }
    }
  }

  /** 目标/叙事子表只有 goal_id / chapter_id，按父表租户范围先清。 */
  private deleteSoulStructuredChildren(teamId: string, agentId: string, userId: string | undefined): void {
    const goalScope = this.agentDerivedScope("soul_goals", teamId, agentId, userId);
    if (goalScope) {
      const goalWhere = "SELECT goal_id FROM soul_goals WHERE " + goalScope.where;
      try {
        this.db.prepare("DELETE FROM soul_goal_events WHERE goal_id IN (" + goalWhere + ")").run(...goalScope.params);
      } catch {
        /* 表还没建 */
      }
      try {
        this.db
          .prepare(
            "DELETE FROM soul_goal_deps WHERE goal_id IN (" +
              goalWhere +
              ") OR depends_on_goal_id IN (" +
              goalWhere +
              ")",
          )
          .run(...goalScope.params, ...goalScope.params);
      } catch {
        /* 表还没建 */
      }
    }
    const narrativeScope = this.agentDerivedScope("soul_narrative", teamId, agentId, userId);
    if (narrativeScope) {
      try {
        this.db
          .prepare(
            "DELETE FROM soul_narrative_evidence WHERE chapter_id IN (SELECT chapter_id FROM soul_narrative WHERE " +
              narrativeScope.where +
              ")",
          )
          .run(...narrativeScope.params);
      } catch {
        /* 表还没建 */
      }
    }
  }

  private entityId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  private jsonArray(value: unknown): string {
    return JSON.stringify(
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [],
    );
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
      const agents = this.db
        .prepare("SELECT agent_id FROM entity_agents WHERE team_id = ? AND status = 'active' ORDER BY agent_id")
        .all(teamId) as any[];
      for (const agent of agents) agentIds.add(String(agent.agent_id));
      team.agent_ids = Array.from(agentIds).sort();
      team.task_ids = (
        this.db.prepare("SELECT task_id FROM entity_tasks WHERE team_id = ? ORDER BY task_id").all(teamId) as any[]
      ).map((r) => String(r.task_id));
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
      const teams = this.db
        .prepare("SELECT team_id, owner_user_id, user_ids_json FROM entity_teams WHERE status = 'active'")
        .all() as any[];
      user.team_ids = teams
        .filter(
          (team) => String(team.owner_user_id ?? "") === userId || this.parseArray(team.user_ids_json).includes(userId),
        )
        .map((team) => String(team.team_id))
        .sort();
      const tasks = this.db
        .prepare("SELECT task_id, creator_user_id, user_ids_json, agent_ids_json FROM entity_tasks ORDER BY task_id")
        .all() as any[];
      const taskIds = new Set<string>();
      const taskAgentIds = new Set<string>();
      for (const task of tasks) {
        const participates =
          String(task.creator_user_id ?? "") === userId || this.parseArray(task.user_ids_json).includes(userId);
        if (!participates) continue;
        taskIds.add(String(task.task_id));
        for (const agentId of this.parseArray(task.agent_ids_json)) taskAgentIds.add(agentId);
      }
      user.task_ids = Array.from(taskIds).sort();
      user.task_agent_ids = Array.from(taskAgentIds).sort();
      user.owned_agent_ids = (
        this.db
          .prepare("SELECT agent_id FROM entity_agents WHERE owner_user_id = ? AND status = 'active' ORDER BY agent_id")
          .all(userId) as any[]
      ).map((r) => String(r.agent_id));
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
      agent.task_ids = tasks
        .filter((task) => this.parseArray(task.agent_ids_json).includes(agentId))
        .map((task) => String(task.task_id));
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
      // #127：库里的历史 github/tapd 读成 external；列为 NOT NULL DEFAULT 'manual'，空值仍退 manual。
      source_type:
        row.source_type == null || row.source_type === "" ? "manual" : normalizeTaskSourceType(row.source_type),
      source_url: String(row.source_url ?? "") || undefined,
      agent_ids: this.parseArray(row.agent_ids_json),
      user_ids: this.parseArray(row.user_ids_json),
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  createTeam(
    input: Omit<TeamEntity, "created_at" | "updated_at" | "status" | "user_ids" | "agent_ids" | "task_ids"> & {
      team_id?: string;
      status?: TeamEntity["status"];
    },
  ): TeamEntity {
    const now = new Date().toISOString();
    const id = input.team_id || this.entityId("team");
    this.db
      .prepare(
        "INSERT INTO entity_teams (team_id, name, description, owner_user_id, user_ids_json, agent_ids_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.name,
        input.description ?? "",
        input.owner_user_id,
        this.jsonArray([input.owner_user_id]),
        this.jsonArray([]),
        input.status ?? "active",
        now,
        now,
      );
    return (
      this.getTeam(id) ?? {
        team_id: id,
        name: input.name,
        owner_user_id: input.owner_user_id,
        status: input.status ?? "active",
        created_at: now,
        updated_at: now,
      }
    );
  }

  getTeam(teamId: string): TeamEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_teams WHERE team_id = ?").get(teamId) as any;
    return row ? this.teamFromRow(row, true) : null;
  }

  updateTeam(
    teamId: string,
    patch: Partial<Pick<TeamEntity, "name" | "description" | "owner_user_id" | "user_ids" | "agent_ids" | "status">>,
  ): TeamEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_teams WHERE team_id = ?").get(teamId) as any;
    if (!row) return null;
    const current = this.teamFromRow(row, true);
    const ownerUserId = patch.owner_user_id ?? current.owner_user_id;
    const userIds =
      patch.user_ids !== undefined
        ? Array.from(new Set([...patch.user_ids, ownerUserId])).sort()
        : this.parseArray(row.user_ids_json);
    if (ownerUserId && !userIds.includes(ownerUserId)) userIds.push(ownerUserId);
    const agentIds = patch.agent_ids !== undefined ? patch.agent_ids : this.parseArray(row.agent_ids_json);
    const next = { ...current, ...patch, owner_user_id: ownerUserId, updated_at: new Date().toISOString() };
    this.db
      .prepare(
        "UPDATE entity_teams SET name = ?, description = ?, owner_user_id = ?, user_ids_json = ?, agent_ids_json = ?, status = ?, updated_at = ? WHERE team_id = ?",
      )
      .run(
        next.name,
        next.description ?? "",
        ownerUserId,
        this.jsonArray(userIds),
        this.jsonArray(agentIds),
        next.status,
        next.updated_at,
        teamId,
      );
    return this.getTeam(teamId);
  }

  deleteTeams(teamIds: string[]): BatchDeleteResult {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of teamIds) {
      const row = this.getTeam(id);
      if (!row) {
        result.failed.push({ id, reason: "not_found" });
        continue;
      }
      this.updateTeam(id, { status: "archived" });
      result.deleted_ids.push(id);
    }
    return result;
  }

  createUser(
    input: Pick<UserEntity, "name"> & Partial<Pick<UserEntity, "job_description" | "status">> & { user_id?: string },
  ): UserEntity {
    const now = new Date().toISOString();
    const id = input.user_id || this.entityId("user");
    this.db
      .prepare(
        "INSERT INTO entity_users (user_id, name, job_description, team_ids_json, task_ids_json, owned_agent_ids_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.name,
        input.job_description ?? "",
        this.jsonArray([]),
        this.jsonArray([]),
        this.jsonArray([]),
        input.status ?? "active",
        now,
        now,
      );
    return (
      this.getUser(id) ?? {
        user_id: id,
        name: input.name,
        team_ids: [],
        task_ids: [],
        owned_agent_ids: [],
        status: input.status ?? "active",
        created_at: now,
        updated_at: now,
      }
    );
  }

  getUser(userId: string): UserEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_users WHERE user_id = ?").get(userId) as any;
    return row ? this.userFromRow(row, true) : null;
  }

  updateUser(
    userId: string,
    patch: Partial<Pick<UserEntity, "name" | "job_description" | "status">>,
  ): UserEntity | null {
    const current = this.getUser(userId);
    if (!current) return null;
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    this.db
      .prepare("UPDATE entity_users SET name = ?, job_description = ?, status = ?, updated_at = ? WHERE user_id = ?")
      .run(next.name, next.job_description ?? "", next.status, next.updated_at, userId);
    return this.getUser(userId);
  }

  deleteUsers(userIds: string[]): BatchDeleteResult {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of userIds) {
      if (!this.getUser(id)) {
        result.failed.push({ id, reason: "not_found" });
        continue;
      }
      this.updateUser(id, { status: "inactive" });
      result.deleted_ids.push(id);
    }
    return result;
  }

  createAgent(
    input: Omit<AgentEntity, "created_at" | "updated_at" | "status" | "visibility" | "task_ids"> & {
      agent_id?: string;
      status?: AgentEntity["status"];
      visibility?: AgentEntity["visibility"];
    },
  ): AgentEntity {
    const now = new Date().toISOString();
    const id = input.agent_id || this.entityId("agent");
    this.db
      .prepare(
        "INSERT INTO entity_agents (agent_id, team_id, name, description, prompt, owner_user_id, visibility, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.team_id,
        input.name,
        input.description ?? "",
        input.prompt ?? "",
        input.owner_user_id ?? "",
        input.visibility ?? "team",
        input.status ?? "active",
        now,
        now,
      );
    const team = this.getTeam(input.team_id);
    if (team && !(team.agent_ids ?? []).includes(id))
      this.updateTeam(input.team_id, { agent_ids: [...(team.agent_ids ?? []), id] });
    return (
      this.getAgent(id) ?? {
        agent_id: id,
        team_id: input.team_id,
        name: input.name,
        visibility: input.visibility ?? "team",
        status: input.status ?? "active",
        created_at: now,
        updated_at: now,
      }
    );
  }

  getAgent(agentId: string): AgentEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_agents WHERE agent_id = ?").get(agentId) as any;
    return row ? this.agentFromRow(row) : null;
  }

  updateAgent(
    agentId: string,
    patch: Partial<Pick<AgentEntity, "name" | "description" | "prompt" | "owner_user_id" | "visibility" | "status">>,
  ): AgentEntity | null {
    const current = this.getAgent(agentId);
    if (!current) return null;
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    this.db
      .prepare(
        "UPDATE entity_agents SET name = ?, description = ?, prompt = ?, owner_user_id = ?, visibility = ?, status = ?, updated_at = ? WHERE agent_id = ?",
      )
      .run(
        next.name,
        next.description ?? "",
        next.prompt ?? "",
        next.owner_user_id ?? "",
        next.visibility,
        next.status,
        next.updated_at,
        agentId,
      );
    return this.getAgent(agentId);
  }

  deleteAgents(agentIds: string[]): BatchDeleteResult {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of agentIds) {
      if (!this.getAgent(id)) {
        result.failed.push({ id, reason: "not_found" });
        continue;
      }
      this.updateAgent(id, { status: "inactive" });
      result.deleted_ids.push(id);
    }
    return result;
  }

  createTask(
    input: Omit<TaskEntity, "created_at" | "updated_at" | "source_type" | "agent_ids" | "user_ids"> & {
      task_id?: string;
      source_type?: TaskEntity["source_type"];
      agent_ids?: string[];
      user_ids?: string[];
    },
  ): TaskEntity {
    const now = new Date().toISOString();
    const id = input.task_id || this.entityId("task");
    // #127：写边界归一，库里只会出现 manual|external|other（调用方误传历史值也不会落四值）。
    const sourceType = input.source_type == null ? "manual" : normalizeTaskSourceType(input.source_type);
    this.db
      .prepare(
        "INSERT INTO entity_tasks (task_id, team_id, creator_user_id, title, description, source_type, source_url, status, auto_assign_floating_assets, risk_level, agent_ids_json, user_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.team_id,
        input.creator_user_id,
        input.title ?? "",
        input.description ?? "",
        sourceType,
        input.source_url ?? "",
        "pending",
        0,
        "low",
        this.jsonArray(input.agent_ids),
        this.jsonArray(input.user_ids),
        now,
        now,
      );
    return (
      this.getTask(id) ?? {
        task_id: id,
        team_id: input.team_id,
        creator_user_id: input.creator_user_id,
        source_type: sourceType,
        agent_ids: input.agent_ids ?? [],
        user_ids: input.user_ids ?? [],
        created_at: now,
        updated_at: now,
      }
    );
  }

  getTask(taskId: string): TaskEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_tasks WHERE task_id = ?").get(taskId) as any;
    return row ? this.taskFromRow(row) : null;
  }

  updateTask(
    taskId: string,
    patch: Partial<Pick<TaskEntity, "title" | "description" | "source_type" | "source_url" | "agent_ids" | "user_ids">>,
  ): TaskEntity | null {
    const current = this.getTask(taskId);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
      // #127：写边界归一（历史值不会回写进库）。
      source_type: patch.source_type == null ? current.source_type : normalizeTaskSourceType(patch.source_type),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        "UPDATE entity_tasks SET title = ?, description = ?, source_type = ?, source_url = ?, agent_ids_json = ?, user_ids_json = ?, updated_at = ? WHERE task_id = ?",
      )
      .run(
        next.title ?? "",
        next.description ?? "",
        next.source_type,
        next.source_url ?? "",
        this.jsonArray(next.agent_ids),
        this.jsonArray(next.user_ids),
        next.updated_at,
        taskId,
      );
    return this.getTask(taskId);
  }

  deleteTasks(taskIds: string[]): BatchDeleteResult {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of taskIds) {
      if (!this.getTask(id)) {
        result.failed.push({ id, reason: "not_found" });
        continue;
      }
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
    const existing = this.db
      .prepare("SELECT created_at FROM entity_knowledge WHERE knowledge_id = ?")
      .get(input.knowledge_id) as any;
    if (existing) {
      this.db
        .prepare(
          "UPDATE entity_knowledge SET type=?, service_url=?, name=?, summary=?, team_id=?, agent_id=?, user_id=?, repo_url=?, branch=?, updated_at=? WHERE knowledge_id=?",
        )
        .run(
          input.type,
          input.service_url,
          input.name,
          input.summary ?? null,
          input.team_id,
          input.agent_id ?? "",
          input.user_id ?? null,
          input.repo_url ?? null,
          input.branch ?? null,
          now,
          input.knowledge_id,
        );
      return this.getKnowledge(input.knowledge_id)!;
    }
    this.db
      .prepare(
        "INSERT INTO entity_knowledge (knowledge_id, type, service_url, name, summary, team_id, agent_id, user_id, repo_url, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.knowledge_id,
        input.type,
        input.service_url,
        input.name,
        input.summary ?? null,
        input.team_id,
        input.agent_id ?? "",
        input.user_id ?? null,
        input.repo_url ?? null,
        input.branch ?? null,
        now,
        now,
      );
    return this.getKnowledge(input.knowledge_id)!;
  }

  getKnowledge(knowledgeId: string): KnowledgeEntity | null {
    const row = this.db.prepare("SELECT * FROM entity_knowledge WHERE knowledge_id = ?").get(knowledgeId) as any;
    return row ? this.knowledgeFromRow(row) : null;
  }

  updateKnowledge(
    knowledgeId: string,
    patch: Partial<Pick<KnowledgeEntity, "name" | "summary" | "service_url" | "repo_url" | "branch">>,
  ): KnowledgeEntity | null {
    const current = this.getKnowledge(knowledgeId);
    if (!current) return null;
    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const args: SQLInputValue[] = [now];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      args.push(patch.name);
    }
    if (patch.summary !== undefined) {
      sets.push("summary = ?");
      args.push(patch.summary);
    }
    if (patch.service_url !== undefined) {
      sets.push("service_url = ?");
      args.push(patch.service_url);
    }
    if (patch.repo_url !== undefined) {
      sets.push("repo_url = ?");
      args.push(patch.repo_url);
    }
    if (patch.branch !== undefined) {
      sets.push("branch = ?");
      args.push(patch.branch);
    }
    args.push(knowledgeId);
    this.db.prepare(`UPDATE entity_knowledge SET ${sets.join(", ")} WHERE knowledge_id = ?`).run(...args);
    return this.getKnowledge(knowledgeId);
  }

  deleteKnowledge(knowledgeIds: string[], teamId?: string): BatchDeleteResult {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of knowledgeIds) {
      const row = this.getKnowledge(id);
      if (!row) {
        result.failed.push({ id, reason: "not_found" });
        continue;
      }
      if (teamId && row.team_id !== teamId) {
        result.failed.push({ id, reason: "team_mismatch" });
        continue;
      }
      this.db.prepare("DELETE FROM entity_knowledge WHERE knowledge_id = ?").run(id);
      result.deleted_ids.push(id);
    }
    return result;
  }

  listKnowledge(input: {
    team_id: string;
    type?: KnowledgeType;
    knowledge_ids?: string[];
    limit?: number;
    offset?: number;
  }): KnowledgeListResult {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 1000);
    const offset = Math.max(input.offset ?? 0, 0);
    // knowledge_ids 过滤（Proxy 按 id 批量联查明细）；空数组 → 空结果
    const ids = input.knowledge_ids;
    if (ids && ids.length === 0) return { items: [], total: 0 };
    const idClause = ids && ids.length > 0 ? ` AND knowledge_id IN (${ids.map(() => "?").join(",")})` : "";

    let sql = "SELECT * FROM entity_knowledge WHERE team_id = ?";
    const args: SQLInputValue[] = [input.team_id];
    if (input.type) {
      sql += " AND type = ?";
      args.push(input.type);
    }
    if (idClause) {
      sql += idClause;
      args.push(...ids!);
    }
    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
    args.push(limit, offset);
    const rows = this.db.prepare(sql).all(...args) as any[];
    const items = rows.map((r) => this.knowledgeFromRow(r));

    let countSql = "SELECT COUNT(*) as total FROM entity_knowledge WHERE team_id = ?";
    const countArgs: SQLInputValue[] = [input.team_id];
    if (input.type) {
      countSql += " AND type = ?";
      countArgs.push(input.type);
    }
    if (idClause) {
      countSql += idClause;
      countArgs.push(...ids!);
    }
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
  searchL1Fts(ftsQuery: string, limit = 20, filter?: IsolationFilter, opts?: { type?: string }): FtsSearchResult[] {
    if (this.degraded || !this.ftsAvailable) return [];
    try {
      // 2026-11-03：类型收窄（结论层只要 work_fact）。先过滤再 LIMIT，排名语义不变；
      // 缺省（不传 opts.type）走原语句 → 逐位等于旧行为。
      const typeScope = typeof opts?.type === "string" && opts.type.length > 0 ? opts.type : undefined;
      if (typeScope && !this.stmtL1FtsSearchByType) {
        // 调用方要求类型收窄却拿不到收窄语句时，**不得**回落到全库语句——那会把
        // episodic 混进只应含该类行的候选池（正是本次修复要消掉的行为）。宁可返回空。
        this.logger?.warn?.(
          `${TAG} [L1-fts-search] type scope "${typeScope}" requested but statement unavailable (FTS off); returning empty`,
        );
        return [];
      }
      const retrieveLimit = filter ? Math.max(limit * 5, limit) : limit;
      const rows = (
        typeScope
          ? this.stmtL1FtsSearchByType!.all(ftsQuery, typeScope, retrieveLimit)
          : this.stmtL1FtsSearch.all(ftsQuery, retrieveLimit)
      ) as Array<{
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
        /** @deprecated ADR-0025 C3：列已删，恒取 timestamp_str。 */
        timestamp_start: string;
        timestamp_end: string;
        metadata_json: string;
        // soul 9 列（P1-T7：SELECT 由 SOUL_SELECT_FRAGMENT 带出；ADR-0025 C2 删 source）
        occurred_at?: string | null;
        valid_start?: string | null;
        valid_end?: string | null;
        certainty?: string | null;
        sensitivity?: string | null;
        valence?: number | null;
        arousal?: number | null;
        significance?: number | null;
        importance?: number | null;
        /** 溯源（P0-1）：SELECT 用相关子查询从 l1_records 带出。 */
        source_message_ids?: string | null;
        /** B 项：SELECT 用相关子查询从 l1_records 带出（l1_fts 不存该列）。 */
        updated_time?: string | null;
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
          rank: r.rank,
          timestamp_str: r.timestamp_str,
          timestamp_start: r.timestamp_str,
          timestamp_end: r.timestamp_end,
          version: r.version ?? 0,
          session_key: r.session_key,
          session_id: r.session_id,
          team_id: r.team_id ?? "",
          task_id: r.task_id ?? "",
          user_id: r.user_id ?? "",
          agent_id: r.agent_id ?? "",
          metadata_json: r.metadata_json,
          // soul 10 字段（W1 兑现点：此前 FTS 行恒 undefined；NULL/缺省归一为 undefined，
          // 口径与 L1RecordRow 读回一致。P1-T7：importance NULL→null，未评分=不罚口径）
          occurred_at: r.occurred_at ?? undefined,
          valid_start: r.valid_start ?? undefined,
          valid_end: r.valid_end ?? undefined,
          certainty: r.certainty ?? undefined,
          sensitivity: r.sensitivity ?? undefined,
          valence: r.valence ?? undefined,
          arousal: r.arousal ?? undefined,
          significance: r.significance ?? undefined,
          importance: r.importance ?? null,
          source_message_ids: parseSourceMessageIds(r.source_message_ids),
          // B 项：行最近更新时间（相关子查询带出；缺列/空值由消费方回退 timestamp_end）
          updated_time: r.updated_time || undefined,
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
   * soul 列迁移（历代扩展）：旧 17 列 `l1_fts` → 当前 soul 列数（现在 27 列，
   * 全 UNINDEXED soul 字段）。D-3 时为 26 列；2026-10-13 P1 Task 7（worthiness
   * importance）起 sentinel 检 `importance`，26 → 27 在线重建。
   *
   * FTS5 virtual tables do NOT support `ALTER TABLE ADD COLUMN`，因此走事务内
   * 重建：建 `l1_fts_new`（27 列）→ 从旧表 17 列原样拷贝（content 列已是分词
   * 产物，不重切）并 LEFT JOIN l1_records 回填 soul → 行数校验（不一致
   * ROLLBACK + throw，不留半建表）→ DROP 旧表 → RENAME。
   *
   * 幂等：`PRAGMA table_info(l1_fts)` 已含 `importance` → 跳过。
   * init() 在 prepare 全列语句之前自动调用；也导出为独立迁移入口供手动脚本调用。
   *
   * @returns `migrated` 是否执行了重建；`rows` 迁移行数（跳过时为当前行数）。
   */
  migrateL1FtsSoul(): { migrated: boolean; rows: number } {
    const tableExists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='l1_fts'").get();
    if (!tableExists) return { migrated: false, rows: 0 };

    const cols = this.db.prepare("SELECT name FROM pragma_table_info('l1_fts')").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "importance")) {
      // 已含全部 soul 列（P1-T7 后=27 列；含则跳过——幂等）
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
        .prepare(
          `
          INSERT INTO l1_fts_new (${L1_FTS_ALL_COL_NAMES.join(", ")})
          SELECT old.${L1_FTS_BASE_COLUMN_DEFS.map((d) => d.split(" ")[0]).join(", old.")},
                 rec.${SOUL_COL_NAMES.join(", rec.")}
          FROM l1_fts AS old
          LEFT JOIN l1_records AS rec ON old.record_id = rec.record_id
        `,
        )
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
        `${TAG} Migrated l1_fts → ${L1_FTS_ALL_COL_NAMES.length} columns (soul backfilled from l1_records): ${newCount} rows`,
      );
      return { migrated: true, rows: newCount };
    } catch (err) {
      // 失败必须 ROLLBACK，不留半建表（旧 17 列表原样保留，可重试）
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore rollback errors */
      }
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
      const l1Exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='l1_fts'").get();
      if (!l1Exists) {
        // Fresh install — tables will be created with v2 schema.
        // Still need rebuild if there's existing data in l1_records.
        const hasData = this.db.prepare("SELECT 1 FROM l1_records LIMIT 1").get();
        return !!hasData;
      }

      // Check if the v2 column `content_original` exists.
      // FTS5 tables appear in pragma_table_info with their column names.
      const cols = this.db.prepare("SELECT name FROM pragma_table_info('l1_fts')").all() as Array<{ name: string }>;
      const hasV2Col = cols.some((c) => c.name === "content_original");
      // v3 marker: isolation columns added (user_id / agent_id).
      const hasV3Col = cols.some((c) => c.name === "user_id") && cols.some((c) => c.name === "agent_id");
      const hasV4Col = cols.some((c) => c.name === "version");
      const hasV5Col = cols.some((c) => c.name === "task_id");
      // v6 marker（ADR-0025 C2/C3）：冗余列必须已消失。
      //  - timestamp_start 与 timestamp_str 曾在存量里 4225/4225 逐位相等（纯重复）；
      //  - source 零判定读点（959 行为空串），凭据由 source_message_ids + memory_audit 承担。
      // 任一列仍在 = 旧版 FTS 表，走 DROP + rebuild 自愈。
      const hasV6Pruned = !cols.some((c) => c.name === "timestamp_start") && !cols.some((c) => c.name === "source");

      if (hasV2Col && hasV3Col && hasV4Col && hasV5Col && hasV6Pruned) {
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
      } else if (!hasV6Pruned) {
        this.logger?.info(`${TAG} Migrating FTS5 tables v5 → v6 (prune timestamp_start / source — ADR-0025 C2/C3)`);
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

    // P0-3（2026-11-04）：重建必须原子。旧实现是 DELETE + 逐行 try/catch warn + 外层
    // catch「non-fatal」——重建中途抛错会留下一张被清空后只灌了一半的**半截索引**，
    // 而且告警不升级（检索静默少命中，比崩掉更难查）。改为「BEGIN → 清空/重灌 →
    // 行数校验 → COMMIT」，任一步失败就 ROLLBACK 到重建前状态并向上抛（fail-loud）：
    // 调用点 init() 的外层 catch 会把 ftsAvailable 置 false（本会话 FTS 明确关闭），
    // 而不是带着残缺索引继续跑。范式同 migrateL1FtsSoul（见本方法上方）。
    try {
      this.logger?.info(`${TAG} Rebuilding FTS5 index with jieba segmentation…`);

      this.db.exec("BEGIN");

      // ── Rebuild L1 FTS ──
      // Clear existing FTS data
      this.db.exec("DELETE FROM l1_fts");

      // Read all L1 records from metadata table.
      // Include user_id / agent_id so the rebuilt FTS rows carry isolation info.
      const l1Rows = this.db
        .prepare(
          `
          SELECT record_id, content, type, priority, scene_name,
                 session_key, session_id, team_id, task_id, user_id, agent_id, version,
                 timestamp_str, timestamp_end, metadata_json,
                 ${SOUL_SELECT_FRAGMENT}
          FROM l1_records
        `,
        )
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
        timestamp_end: string;
        metadata_json: string;
        occurred_at?: string;
        valid_start?: string;
        valid_end?: string;
        certainty?: string;
        sensitivity?: string | null;
        valence?: number | null;
        arousal?: number | null;
        significance?: number | null;
        importance?: number | null;
      }>;

      for (const r of l1Rows) {
        // P0-3：不再逐行吞错——单行失败即整体失败并回滚（半截索引不可接受）
        this.stmtL1FtsInsert.run(
          tokenizeForFts(r.content), // content — segmented
          r.content, // content_original — raw
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
          r.timestamp_end,
          r.metadata_json,
          // soul 9 字段（P1-T7）：与写入侧同源取值（ADR-0025 C2 已删 source）
          ...soulBindValues(r as unknown as Record<string, unknown>),
        );
      }

      // ── Rebuild L0 FTS ──
      this.db.exec("DELETE FROM l0_fts");

      const l0Rows = this.db
        .prepare(
          `
          SELECT record_id, message_text, session_key, session_id, team_id, task_id, user_id, agent_id,
                 role, recorded_at, timestamp
          FROM l0_conversations
        `,
        )
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

      for (const r of l0Rows) {
        // P0-3：同 L1——单行失败即整体失败并回滚
        this.stmtL0FtsInsert.run(
          tokenizeForFts(r.message_text), // message_text — segmented
          r.message_text, // message_text_original — raw
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
      }

      // P0-3：行数校验——插入语句静默丢行（约束/触发器/未来列漂移）不能靠肉眼发现。
      // 期望值=主表行数（本方法不做任何过滤），不符即视为重建失败。
      const l1FtsCount = Number((this.db.prepare("SELECT COUNT(*) AS n FROM l1_fts").get() as { n: number }).n);
      if (l1FtsCount !== l1Rows.length) {
        throw new Error(`FTS rebuild row-count mismatch (L1): l1_fts=${l1FtsCount} vs l1_records=${l1Rows.length}`);
      }
      const l0FtsCount = Number((this.db.prepare("SELECT COUNT(*) AS n FROM l0_fts").get() as { n: number }).n);
      if (l0FtsCount !== l0Rows.length) {
        throw new Error(
          `FTS rebuild row-count mismatch (L0): l0_fts=${l0FtsCount} vs l0_conversations=${l0Rows.length}`,
        );
      }

      this.db.exec("COMMIT");

      this.logger?.info(
        `${TAG} FTS5 rebuild complete: L1=${l1FtsCount}/${l1Rows.length}, L0=${l0FtsCount}/${l0Rows.length}`,
      );
    } catch (err) {
      // P0-3：回滚到重建前状态，并把错误抛给调用点（init 的外层 catch 会关掉本次 FTS）
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 事务可能未开启（BEGIN 前就失败）——无可回滚 */
      }
      this.logger?.warn(
        `${TAG} FTS5 rebuild FAILED — rolled back, index left at pre-rebuild state: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
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
      // #152 ①：本地 sqlite 实现 upsertL1FactVector / searchL1FactVector（l1_fact_vec 表）
      l1FactVec: true,
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
    if (filter.record_id !== undefined) {
      conds.push("record_id = ?");
      args.push(filter.record_id);
    }
    if (filter.layer !== undefined) {
      conds.push("layer = ?");
      args.push(filter.layer);
    }
    if (filter.action !== undefined) {
      conds.push("action = ?");
      args.push(filter.action);
    }
    if (filter.team_id !== undefined) {
      conds.push("team_id = ?");
      args.push(filter.team_id);
    }
    if (filter.agent_id !== undefined) {
      conds.push("agent_id = ?");
      args.push(filter.agent_id);
    }
    if (filter.user_id !== undefined) {
      conds.push("user_id = ?");
      args.push(filter.user_id);
    }
    if (filter.task_id !== undefined) {
      conds.push("task_id = ?");
      args.push(filter.task_id);
    }
    if (filter.since_ms !== undefined) {
      conds.push("updated_at_ms >= ?");
      args.push(filter.since_ms);
    }
    if (filter.until_ms !== undefined) {
      conds.push("updated_at_ms <= ?");
      args.push(filter.until_ms);
    }

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
          record.generation_ref_id,
          record.layer,
          record.memory_id,
          record.generation_id,
          record.generation_log_id,
          record.generation_log_key,
          record.memory_prompt_id,
          record.memory_prompt_version,
          record.memory_prompt_source,
          record.created_at_ms,
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
    return (
      (this.db
        .prepare("SELECT * FROM memory_generation_refs WHERE generation_ref_id = ? AND layer = ? AND memory_id = ?")
        .get(id, layer, memoryId) as unknown as MemoryGenerationRefRecord | undefined) ?? null
    );
  }

  // ─────────────────────────────────────────────────────────
  // Custom Memory Prompt
  // ─────────────────────────────────────────────────────────

  countMemoryPrompts(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM memory_prompts").get() as { total: number };
    return Number(row?.total ?? 0);
  }

  createMemoryPrompt(record: MemoryPromptRecord): MemoryPromptRecord {
    this.db
      .prepare(
        `
      INSERT INTO memory_prompts
        (memory_prompt_id, name, layer, prompt, version, status,
         created_by, updated_by, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        record.memory_prompt_id,
        record.name,
        record.layer,
        record.prompt,
        record.version,
        record.status,
        record.created_by ?? null,
        record.updated_by ?? null,
        record.created_at_ms,
        record.updated_at_ms,
      );
    return record;
  }

  getMemoryPrompts(ids: string[]): MemoryPromptRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM memory_prompts WHERE memory_prompt_id IN (${placeholders})`)
      .all(...ids) as unknown as MemoryPromptRecord[];
  }

  listMemoryPrompts(filter: MemoryPromptListFilter): MemoryPromptRecord[] {
    const conds = ["status = 'active'"];
    const args: SQLInputValue[] = [];
    if (filter.layer) {
      conds.push("layer = ?");
      args.push(filter.layer);
    }
    const order = filter.timeOrder === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.db
      .prepare(
        `
      SELECT * FROM memory_prompts
      WHERE ${conds.join(" AND ")}
      ORDER BY updated_at_ms ${order}, memory_prompt_id ${order}
      LIMIT ? OFFSET ?
    `,
      )
      .all(...args, limit, offset) as unknown as MemoryPromptRecord[];
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
    if (patch.name !== undefined) {
      sets.push("name = ?");
      args.push(patch.name);
    }
    if (patch.prompt !== undefined) {
      sets.push("prompt = ?");
      args.push(patch.prompt);
    }
    args.push(id);
    const result = this.db
      .prepare(`UPDATE memory_prompts SET ${sets.join(", ")} WHERE memory_prompt_id = ? AND status = 'active'`)
      .run(...args);
    if (Number(result.changes ?? 0) === 0) return null;
    return this.getMemoryPrompts([id])[0] ?? null;
  }

  getMemoryPromptSettings(ids: string[]): MemoryPromptSettingRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM memory_prompt_settings WHERE setting_id IN (${placeholders})`)
      .all(...ids) as unknown as MemoryPromptSettingRecord[];
  }

  listMemoryPromptSettings(filter: MemoryPromptSettingListFilter): MemoryPromptSettingRecord[] {
    const conds: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.memoryPromptId) {
      conds.push("memory_prompt_id = ?");
      args.push(filter.memoryPromptId);
    }
    if (filter.targetType) {
      conds.push("target_type = ?");
      args.push(filter.targetType);
    }
    if (filter.teamId) {
      conds.push("team_id = ?");
      args.push(filter.teamId);
    }
    if (filter.agentId) {
      conds.push("agent_id = ?");
      args.push(filter.agentId);
    }
    if (filter.layer) {
      conds.push("layer = ?");
      args.push(filter.layer);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const order = filter.timeOrder === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.db
      .prepare(
        `
      SELECT * FROM memory_prompt_settings ${where}
      ORDER BY updated_at_ms ${order}, setting_id ${order}
      LIMIT ? OFFSET ?
    `,
      )
      .all(...args, limit, offset) as unknown as MemoryPromptSettingRecord[];
  }

  upsertMemoryPromptSettings(records: MemoryPromptSettingRecord[], logs: MemoryPromptSettingLogRecord[]): void {
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
          record.setting_id,
          record.target_type,
          record.team_id ?? null,
          record.agent_id ?? null,
          record.layer,
          record.memory_prompt_id,
          record.updated_by ?? null,
          record.updated_at_ms,
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
        log.setting_log_id,
        log.target_type,
        log.team_id ?? null,
        log.agent_id ?? null,
        log.layer,
        log.action,
        log.reason,
        log.before_memory_prompt_id ?? null,
        log.after_memory_prompt_id ?? null,
        log.operator_id ?? null,
        log.operated_at_ms,
      );
    }
  }

  deleteMemoryPrompts(
    ids: string[],
    operatorId?: string,
  ): {
    deleted_prompt_ids: string[];
    cleared_settings: Record<MemoryPromptTargetType, number>;
  } {
    const prompts = this.getMemoryPrompts(ids);
    if (prompts.length !== ids.length)
      return { deleted_prompt_ids: [], cleared_settings: { instance: 0, team: 0, agent: 0 } };
    const cleared: Record<MemoryPromptTargetType, number> = { instance: 0, team: 0, agent: 0 };
    const placeholders = ids.map(() => "?").join(",");
    const settings = this.db
      .prepare(`SELECT * FROM memory_prompt_settings WHERE memory_prompt_id IN (${placeholders})`)
      .all(...ids) as unknown as MemoryPromptSettingRecord[];
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
      this.db
        .prepare(`UPDATE memory_prompts SET status = 'deleting' WHERE memory_prompt_id IN (${placeholders})`)
        .run(...ids);
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
    if (filter.teamId) {
      conds.push("team_id = ?");
      args.push(filter.teamId);
    }
    if (filter.agentId) {
      conds.push("agent_id = ?");
      args.push(filter.agentId);
    }
    if (filter.action) {
      conds.push("action = ?");
      args.push(filter.action);
    }
    if (filter.startTimeMs !== undefined) {
      conds.push("operated_at_ms >= ?");
      args.push(filter.startTimeMs);
    }
    if (filter.endTimeMs !== undefined) {
      conds.push("operated_at_ms <= ?");
      args.push(filter.endTimeMs);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const order = filter.timeOrder === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.db
      .prepare(
        `
      SELECT * FROM memory_prompt_setting_logs ${where}
      ORDER BY operated_at_ms ${order}, setting_log_id ${order}
      LIMIT ? OFFSET ?
    `,
      )
      .all(...args, limit, offset) as unknown as MemoryPromptSettingLogRecord[];
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
      this.logger?.warn?.(`${TAG} Error closing database: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/* —— 自维护人格层行映射（模块级，避免类方法里重复 JSON 解析） —— */
function jsonArray<T>(v: unknown): T[] {
  if (typeof v !== "string" || v.length === 0) return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function jsonObject(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  try {
    const parsed = JSON.parse(v) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 结构化层字段的落库口径 + 有效期字段的零 DDL 持久化（判据 4 的可验方式）。
 *
 * `validTo`（冻结/失效期末端）与 `supersededBy`（被哪条替代）不是独立列，统一落在
 * `meta_json` 的保留键里：写侧先剥掉层 meta 里的同名键再按顶层字段回填，读侧
 * `mapSoulPersonaRow` 复原成顶层字段。这样零 DDL、旧库无需迁移，且能验：
 *   1) `freezeItem(item, now)` → `commitSoulPersona` → `listSoulPersona`，`validTo === now`；
 *   2) `planRevive` 删掉 validTo 后再提交，同路径读回 `validTo === undefined`（不许残留旧失效期）。
 * 保留键必须从层 meta 里剥掉，否则「复活后 meta 里还留着 validTo」会让读侧把旧失效期捡回来。
 */
const PERSONA_META_RESERVED_KEYS = ["validTo", "validFrom", "expiredAt", "supersededBy", "supersededReason"] as const;

/** human 行必须有主人：返回 meta.person.key（没有就空串）。单写者守卫与读侧共用同一口径。 */
function personKeyOfPersonaItem(it: PersonaItem): string {
  const person = (it.meta as { person?: { key?: unknown } } | undefined)?.person;
  const key = typeof person?.key === "string" ? person.key.trim() : "";
  return key;
}
function personaMetaJson(it: PersonaItem): string | null {
  const merged: Record<string, unknown> = { ...(it.meta ?? {}) };
  for (const k of PERSONA_META_RESERVED_KEYS) delete merged[k];
  // 顶层字段统一回填：只写有值的（undefined/空串=该字段在本行不存在，不许残留旧失效期）。
  const top = it as unknown as Record<string, unknown>;
  for (const k of PERSONA_META_RESERVED_KEYS) {
    const v = top[k];
    if (typeof v === "string" && v !== "") merged[k] = v;
  }
  return Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
}

function mapSoulPersonaRow(row: Record<string, unknown>): PersonaItem {
  const state = String(row.state ?? "active");
  const item: PersonaItem = {
    itemId: String(row.item_id ?? ""),
    layer: String(row.layer ?? "identity") as PersonaItem["layer"],
    text: String(row.text ?? ""),
    state: (["active", "degraded", "frozen", "merged"].includes(state) ? state : "active") as PersonaItem["state"],
    weight: Number(row.weight ?? 0.5),
    evidenceIds: jsonArray<string>(row.evidence_json),
    evidenceDays: jsonArray<string>(row.days_json),
    evidenceOrigins: jsonArray<PersonaItem["evidenceOrigins"][number]>(row.origins_json),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    lastEvidenceAt: String(row.last_evidence_at ?? ""),
    contradictions: Number(row.contradictions ?? 0),
  };
  if (typeof row.merged_into === "string" && row.merged_into.length > 0) item.mergedInto = row.merged_into;
  const aliases = jsonArray<string>(row.aliases_json);
  if (aliases.length > 0) item.aliases = aliases;
  const drift = jsonArray<number>(row.drift_json);
  if (drift.length > 0) item.driftHistory = drift;
  const meta = jsonObject(row.meta_json);
  // 有效期保留键复原到顶层字段（见 personaMetaJson 的可验口径）：读侧只认顶层，
  // 不把 validTo/supersededBy 混进层 meta，避免注入/渲染把内部字段当层专属字段。
  const reserved: Partial<Record<(typeof PERSONA_META_RESERVED_KEYS)[number], string>> = {};
  if (meta) {
    for (const k of PERSONA_META_RESERVED_KEYS) {
      const v = (meta as Record<string, unknown>)[k];
      delete (meta as Record<string, unknown>)[k];
      if (typeof v === "string" && v !== "") reserved[k] = v;
    }
  }
  const top = item as unknown as Record<string, string | undefined>;
  if (reserved.validTo) top.validTo = reserved.validTo;
  if (reserved.supersededBy) top.supersededBy = reserved.supersededBy;
  if (reserved.supersededReason) top.supersededReason = reserved.supersededReason;
  if (reserved.expiredAt) top.expiredAt = reserved.expiredAt;
  // 存量回填（P1-1）：老行没有 validFrom，按 createdAt 补齐；只在读回时补，不改库。
  if (reserved.validFrom) top.validFrom = reserved.validFrom;
  else if (item.createdAt !== "") top.validFrom = item.createdAt;
  if (meta && Object.keys(meta).length > 0) item.meta = meta;
  return item;
}

/** 结论合并（P1-1）取代的条目：state 仍是 active/degraded，只有 validTo 非空。
 *  freeze 的 validTo 不算（它的 state 已变 frozen，出队由 state 负责），所以判据必须带 state。 */
function isSupersededItem(item: PersonaItem): boolean {
  return (
    (item.state === "active" || item.state === "degraded") && typeof item.validTo === "string" && item.validTo !== ""
  );
}

/** P6 / t20：resolver 的候选行去掉 message_text——证据落库只认 record_id / role / at。 */
function stripEpisodeCandidate(c: {
  record_id: string;
  role: string;
  recorded_at: string | null;
  text: string;
}): { record_id: string; role: string; recorded_at: string | null } {
  return { record_id: c.record_id, role: c.role, recorded_at: c.recorded_at };
}

function mapSoulEpisodeRow(row: Record<string, unknown>): SoulEpisode {
  const quote = jsonObject(row.quote_json) as SoulEpisodeQuote | undefined;
  const kind = String(row.kind ?? "decision") as SoulEpisode["kind"];
  const affective = String(row.affect_source ?? "lexicon");
  const rec: SoulEpisode = {
    episodeId: String(row.episode_id ?? ""),
    at: String(row.at ?? ""),
    day: String(row.day ?? ""),
    kind: ((SOUL_EPISODE_KINDS as readonly string[]).includes(kind) ? kind : "decision") as SoulEpisode["kind"],
    title: String(row.title ?? ""),
    object: String(row.object ?? ""),
    participants: jsonArray<string>(row.participants_json),
    userStance: String(row.user_stance ?? ""),
    agentStance: String(row.agent_stance ?? ""),
    cost: String(row.cost ?? ""),
    outcome: String(row.outcome ?? ""),
    valence: Number(row.valence ?? 0),
    arousal: Number(row.arousal ?? 0),
    intensity: Number(row.intensity ?? 0),
    evidenceIds: jsonArray<string>(row.evidence_json),
    sessionId: String(row.session_id ?? ""),
    quote: quote && typeof quote.text === "string" ? quote : null,
    affectSource: affective === "none" ? "none" : "lexicon",
    signals: jsonArray<string>(row.signals_json),
  };
  if (typeof row.archived_at === "string" && row.archived_at.length > 0) rec.archivedAt = row.archived_at;
  // P2-E：人员名单是可选事实。NULL/空数组一律不设字段——「解析不出人」不该伪装成
  // 「有名单但空」，否则按人过滤会把两者当成同一件事。
  const persons = jsonArray<string>(row.persons_json).filter((x): x is string => typeof x === "string" && x !== "");
  if (persons.length > 0) rec.persons = persons;
  if (typeof row.mood_integrated_at === "string" && row.mood_integrated_at.length > 0) {
    rec.moodIntegratedAt = row.mood_integrated_at;
  }
  // P0-2：层是可选事实。空数组/缺列一律不设字段（读回是 undefined，不是 []）——
  // 「这条事件没有站住任何层」和「它的层列表是空的」在语义上不是一回事。
  const layers = jsonArray<string>(row.layers_json).filter((x): x is SoulLayer =>
    (SOUL_LAYERS as readonly string[]).includes(x),
  );
  if (layers.length > 0) rec.layers = layers;
  return rec;
}

/* —— P0-C 事件底座切读开关 ——
 * 只影响读（listSoulEpisodes），不影响写：写永远双写。
 * 缺省 legacy = 旧表读面，逐字节保持 P0-C 之前的行为；new = 读 soul_events + chat + evidence。
 * 回滚方式就是把它改回 legacy（或删掉这个环境变量）并重启。 */
export type SoulEventReadMode = "legacy" | "new";

export const DEFAULT_SOUL_EVENT_READ_MODE: SoulEventReadMode = "legacy";

/** 解析档位：非法值一律回落缺省（读路径不能因配置笔误抛错，更不能 500）。 */
export function resolveSoulEventReadMode(raw?: unknown): SoulEventReadMode {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return value === "new" ? "new" : DEFAULT_SOUL_EVENT_READ_MODE;
}

/** 当前生效档位：每次调用现读环境变量（运行期切换与单测都靠这一点）。 */
export function currentSoulEventReadMode(): SoulEventReadMode {
  return resolveSoulEventReadMode(process.env.TDB_SOUL_EVENT_READ_MODE);
}

/**
 * P0-C 双写：SoulEpisode → 事件底座写入载荷（spec §5.1 的映射表逐字段落地）。
 *
 * 只被 commitSoulEpisodes 调用，且必须在它已开的 BEGIN IMMEDIATE 里执行——上游只用
 * upsertSoulEventInTransaction（内部不 BEGIN），否则撞 cannot start a transaction。
 * 改这里的映射判据，必须同步改 soul-event-dualwrite 测试里的期望值（那是唯一防线）。
 */
/** 一条 episode 的完整事件写入：1 条消息根事件 + 最多 2 条行动子事件（P1-A）。 */
function soulEventWritesFromEpisode(
  e: SoulEpisode,
  actionMessages: readonly SoulActionSourceMessage[] = [],
): SoulEventWrite[] {
  return [soulEventWriteFromEpisode(e), ...splitChatActionEvents(e, actionMessages)];
}

function soulEventWriteFromEpisode(e: SoulEpisode): SoulEventWrite {
  const eventId = e.episodeId;
  const at = e.at;
  const quote = e.quote;
  // evidenceIds 去重去空：新表证据主键是 (event_id, record_id, role)，同一 record 两行会在
  // 一次批量 INSERT 里撞主键；旧表的字符串数组允许重复，这里按首次出现保序保留。
  const recordIds: string[] = [];
  for (const id of e.evidenceIds ?? []) {
    if (typeof id !== "string" || id === "" || recordIds.includes(id)) continue;
    recordIds.push(id);
  }
  const evidence: SoulEventEvidenceInsert[] = recordIds.map((recordId) => {
    // 只有「逐字引文指向的那条 record」才有确定的 role 与 quote；其余证据只知道「是它」，
    // role=unknown、quote=''——不知道是谁说的话就不假装知道（spec §4.2）。
    const fromQuote = quote !== null && quote.recordId === recordId;
    const role = fromQuote ? (quote.role === "assistant" ? "assistant" : "user") : "unknown";
    return { event_id: eventId, record_id: recordId, role, quote: fromQuote ? quote.text : "", at, confidence: 1 };
  });
  // 观察 vs 推测必须按证据实际内容判，不能恒 observed/0.8：
  //  - 至少一条证据带非空逐字引文（且说话人明确是 user/assistant）→ observed + 0.8；
  //  - 只有 record_id、引文全空，或根本没有证据 → inferred + 0.5（§4.2 准入允许无证据的 inferred）。
  // 恒 observed 会让无引文的 episode 被 §4.2 拒写、整批 ROLLBACK——那是把既有写入拖挂的真回归；
  // 反过来为了过准入伪造一条 legacy:episode 假证据，更是把「谁说的」写进账本，绝不允许。
  const observed = evidence.some(
    (row) => (row.role === "user" || row.role === "assistant") && (row.quote ?? "").trim() !== "",
  );
  const event: SoulEventInsert = {
    event_id: eventId,
    at,
    day: e.day,
    valid_from: at,
    actor: "user",
    action: "said",
    object: e.object ?? "",
    intent: e.title ?? "",
    outcome: e.outcome ?? "",
    status: "unknown",
    source_kind: "chat",
    // 引文所在的 record 是最强证据源；没有引文就退到第一条证据；都没有则空串（旧表同样可能为空）。
    source_ref: quote?.recordId ?? recordIds[0] ?? "",
    ownership: "theirs",
    epistemic: observed ? "observed" : "inferred",
    confidence: observed ? 0.8 : 0.5,
    visibility: "shared",
    session_id: e.sessionId ?? "",
    persons_json: e.persons && e.persons.length > 0 ? JSON.stringify(e.persons) : null,
    dedupe_key: `soul-episode:${eventId}`,
    salience: 0.5,
    created_at: at,
    archived_at: e.archivedAt ?? null,
  };
  const chat: SoulEventChatInsert = {
    event_id: eventId,
    kind: e.kind,
    title: e.title ?? "",
    user_stance: e.userStance ?? "",
    agent_stance: e.agentStance ?? "",
    cost: e.cost ?? "",
    valence: e.valence ?? 0,
    arousal: e.arousal ?? 0,
    intensity: e.intensity ?? 0,
    affect_source: e.affectSource ?? "lexicon",
    // 与旧表 quote_json 同一序列化口径（null 表示没有引文，不是 'null' 字符串）。
    quote_json: quote ? JSON.stringify(quote) : null,
    // 旧表 signals_json 永远写 JSON.stringify(e.signals ?? [])：「没有信号」= '[]'，不是 NULL。
    // 新表保持同一口径，切读时才不会一边 [] 一边 undefined。
    signals_json: JSON.stringify(e.signals ?? []),
    layers_json: e.layers && e.layers.length > 0 ? JSON.stringify(e.layers) : null,
    // 过渡态：markSoulEpisodesMoodIntegrated 目前只更新旧表，这一列在 P0 阶段可能落后于旧表。
    mood_integrated_at: e.moodIntegratedAt ?? null,
  };
  return { event, evidence, chat };
}

function mapSoulTraitLabelRow(row: Record<string, unknown>): TraitLabelRow {
  return {
    label: String(row.label ?? ""),
    definition: String(row.definition ?? ""),
    gloss: String(row.gloss ?? ""),
    anchor: String(row.anchor ?? ""),
    direction: toAxisVector(row.direction_json),
    evidence: Number(row.evidence ?? 0),
    status: String(row.status ?? "seed") as TraitLabelRow["status"],
    firstSeen: String(row.first_seen ?? ""),
    lastSeen: String(row.last_seen ?? ""),
    aliases: jsonArray<string>(row.aliases_json),
    protocolVersion: String(row.protocol_version ?? "v1"),
  };
}

function mapSoulPersonRow(row: Record<string, unknown>): SoulPerson {
  const mergedInto = row.merged_into;
  return {
    personKey: String(row.person_key ?? ""),
    teamId: String(row.team_id ?? ""),
    userId: String(row.user_id ?? ""),
    agentId: String(row.agent_id ?? ""),
    platform: String(row.platform ?? ""),
    platformId: row.platform_id === null || row.platform_id === undefined ? null : String(row.platform_id),
    displayName: String(row.display_name ?? ""),
    aliases: jsonArray<string>(row.aliases_json).filter((a): a is string => typeof a === "string"),
    mergedInto: mergedInto === null || mergedInto === undefined ? null : String(mergedInto),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/**
 * aliases 并集，不是覆盖：upsert 每次只带「这次看到的那几个称呼」，覆盖会把旧昵称丢掉，
 * 丢掉别名就等于丢解析路径（同一个人下次换个叫法会被当成第二个人）。
 * 去重按归一化口径（NFKC + 小写 + 空白折叠），否则 "Lead" 与 "lead" 会重复堆在列里。
 */
function mergeAliases(existing: string[], incoming: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...existing, ...incoming]) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value === "") continue;
    const norm = value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(value);
  }
  return out;
}

/** P2-H：关系边读回（`evidence_json` 缺列/脏 JSON 时退回「本条那一份证据」，不造空数组）。 */
function mapSoulPersonRelationRow(row: Record<string, unknown>): SoulPersonRelationRow {
  const recordId = String(row.record_id ?? "");
  const validFrom = String(row.valid_from ?? "");
  const quote = String(row.quote ?? "");
  const evidence = jsonArray<{ recordId: string; at: string; quote: string }>(row.evidence_json);
  const direction = String(row.direction ?? "out") === "mutual" ? "mutual" : "out";
  const out: SoulPersonRelationRow = {
    relId: String(row.rel_id ?? ""),
    subjKey: String(row.subj_key ?? ""),
    pred: String(row.pred ?? ""),
    inversePred: typeof row.inverse_pred === "string" && row.inverse_pred !== "" ? row.inverse_pred : null,
    objKey: typeof row.obj_key === "string" && row.obj_key !== "" ? row.obj_key : null,
    objName: typeof row.obj_name === "string" && row.obj_name !== "" ? row.obj_name : null,
    direction,
    quote,
    recordId,
    evidence: evidence.length > 0 ? evidence : [{ recordId, at: validFrom, quote }],
    validFrom,
    validTo: typeof row.valid_to === "string" && row.valid_to !== "" ? row.valid_to : null,
    // P2 §4.4 新列：旧行读到的是 ALTER 的默认值（NULL/'active'/'present'/0.5/'shared'），
    // 这里逐列兜底，不把 undefined 泄给卡/面板。
    eventId: typeof row.event_id === "string" && row.event_id !== "" ? row.event_id : null,
    // 四态：unverifiable（回指零命中/不唯一）必须原样读回——否则卡读面会把它当 active 渲染出来。
    status:
      row.status === "ended" || row.status === "disputed" || row.status === "unverifiable"
        ? row.status
        : "active",
    tense: row.tense === "past" ? "past" : "present",
    confidence: Number(row.confidence ?? 0.5),
    visibility: typeof row.visibility === "string" && row.visibility !== "" ? row.visibility : "shared",
    endedByEventId:
      typeof row.ended_by_event_id === "string" && row.ended_by_event_id !== "" ? row.ended_by_event_id : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
  return out;
}

function mapSoulEmotionRow(row: Record<string, unknown>): SoulEmotionRecord {
  const rec: SoulEmotionRecord = {
    episodeId: String(row.episode_id ?? ""),
    at: String(row.at ?? ""),
    object: String(row.object ?? ""),
    label: String(row.label ?? ""),
    valence: Number(row.valence ?? 0),
    arousal: Number(row.arousal ?? 0),
    intensity: Number(row.intensity ?? 0),
    templateVersion: String(row.template_version ?? ""),
    appraisedAt: String(row.appraised_at ?? ""),
  };
  const dom = Number(row.dominance);
  if (row.dominance !== null && row.dominance !== undefined && Number.isFinite(dom)) rec.dominance = dom;
  // §5 P3-A：三列旧库/旧行读回 null（「当时没这一维」≠ 取缺省值）。
  const agency = typeof row.agency === "string" ? row.agency.trim() : "";
  rec.agency = agency === "self" || agency === "other" || agency === "environment" ? agency : null;
  const conf = Number(row.confidence);
  rec.confidence = row.confidence !== null && row.confidence !== undefined && Number.isFinite(conf) ? conf : null;
  const person = typeof row.object_person === "string" ? row.object_person.trim() : "";
  rec.objectPerson = person === "" ? null : person;
  const appraisal = jsonObject(row.appraisal_json);
  if (appraisal !== undefined) rec.appraisal = appraisal;
  return rec;
}

function mapSoulLedgerRow(row: Record<string, unknown>): SoulLedgerEntry {
  const entry: SoulLedgerEntry = {
    entryId: String(row.entry_id ?? ""),
    at: String(row.at ?? ""),
    trigger: String(row.trigger ?? ""),
    layer: String(row.layer ?? "all") as SoulLedgerEntry["layer"],
    action: String(row.action ?? "admit") as SoulLedgerEntry["action"],
    gates: jsonArray<string>(row.gates_json),
    reason: String(row.reason ?? ""),
    evidenceIds: jsonArray<string>(row.evidence_json),
  };
  if (typeof row.item_id === "string" && row.item_id.length > 0) entry.itemId = row.item_id;
  if (typeof row.before_hash === "string" && row.before_hash.length > 0) entry.beforeHash = row.before_hash;
  if (typeof row.after_hash === "string" && row.after_hash.length > 0) entry.afterHash = row.after_hash;
  if (typeof row.prompt_version === "string" && row.prompt_version.length > 0) entry.promptVersion = row.prompt_version;
  if (typeof row.protocol_version === "string" && row.protocol_version.length > 0)
    entry.protocolVersion = row.protocol_version;
  if (typeof row.model === "string" && row.model.length > 0) entry.model = row.model;
  const before = jsonObject(row.before_json);
  if (before) entry.before = before as unknown as PersonaItem;
  return entry;
}
