/**
 * L1 Memory Writer: writes extracted memories to JSONL files.
 *
 * File naming: records/YYYY-MM-DD.jsonl (daily shards, all sessions merged).
 * Each record includes sessionKey for traceability.
 *
 * Write strategy:
 * - JSONL is the append-only persistent store (source of truth for backup/recovery).
 * - VectorStore (SQLite) is the primary retrieval engine.
 * - On update/merge, old records are deleted from VectorStore in real-time;
 *   JSONL is append-only and cleaned up periodically by memory-cleaner.
 *
 * Supports store (append), update, merge, and skip operations.
 *
 * v3: Aligned with Kenty's prompt output format — 3 memory types (persona/episodic/instruction),
 * numeric priority, scene_name, source_message_ids, metadata, timestamps.
 */

import crypto from "node:crypto";
import { patchSoulFromContent } from "../lifecycle/consolidation/content-soul.js";
import { DEFAULT_ISOLATION_ID, type IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import type { Logger } from "../types.js";

// ============================
// Types
// ============================

/** L1 memory types: chat-mode legacy types + code/work-mode team memory types. */
export type MemoryType =
  | "persona"
  | "episodic"
  | "instruction"
  | "work_fact"
  | "work_task"
  | "work_method"
  | "work_artifact";

/** Metadata for episodic memories (activity time range) */
export interface EpisodicMetadata {
  activity_start_time?: string; // ISO 8601
  activity_end_time?: string; // ISO 8601
}

/**
 * A persisted memory record in L1 JSONL files.
 *
 * v3 changes from v2:
 * - `importance: "high"|"medium"|"low"` → `priority: number` (0-100, -1 for strict global instructions)
 * - Added `scene_name`, `source_message_ids`, `metadata`, `timestamps`
 * - Removed `keywords` (will be rebuilt from content for search)
 * - MemoryType reduced from 4 to 3 (removed "preference", folded into "persona")
 */
export interface MemoryRecord {
  /** Unique ID for dedup updates */
  id: string;
  /** Memory content */
  content: string;
  /** Memory type: persona / episodic / instruction */
  type: MemoryType;
  /** Priority score: 0-100 (higher = more important), -1 = strict global instruction */
  priority: number;
  /** Scene name this memory belongs to */
  scene_name: string;
  /** Source message IDs that contributed to this memory */
  source_message_ids: string[];
  /** Type-specific metadata (e.g., activity_start_time for episodic) */
  metadata: EpisodicMetadata | Record<string, never>;
  /** Timestamp trail: all timestamps related to this memory (for merge history tracking) */
  timestamps: string[];
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** Last update timestamp (ISO) */
  updatedAt: string;
  /** Monotonic version. New memories start at 1; update/merge increments by 1. */
  version?: number;
  /** Source session key (conversation channel identifier) */
  sessionKey: string;
  /** Source session ID (single conversation instance identifier) */
  sessionId: string;
  /** Optional task dimension for L0/L1 filtering. */
  taskId?: string;
  /**
   * Three-dim tenancy isolation (new in this branch).
   *
   * `userId` / `agentId` are mandatory for new writes once gateway-level
   * isolation enforcement is on, but kept optional on the type to avoid
   * breaking pre-isolation call sites and tests during rollout. The SQLite
   * upsert defaults them to '' if missing; the migration script backfills
   * existing rows with `__legacy__`.
   *
   * See `docs/l0l3-tenant-isolation-design.md`.
   */
  teamId?: string;
  userId?: string;
  agentId?: string;

  // ── 灵魂记忆字段（P2a，全部 optional；空闲则由提取/写入给默认）──
  /** 发生时刻（ISO）—— 时空性 */
  occurred_at?: string;
  /** 有效时段起（ISO）—— 持续性 */
  valid_start?: string;
  /** 有效时段止（ISO） */
  valid_end?: string;
  /** 观察 vs 推断 —— 信任边界（推断不冒充事实） */
  certainty?: "observed" | "inferred";
  /** 来源标记（如消息 id / 工具调用） */
  source?: string;
  /** 情感色调 -1..1 */
  valence?: number;
  /** 情绪强度 0..1 */
  arousal?: number;
  /** 对核心价值的意义 0..1 */
  significance?: number;
}

/**
 * A memory as extracted by LLM (before dedup / persistence).
 * Matches the output format of Kenty's extraction prompt.
 */
export interface ExtractedMemory {
  content: string;
  type: MemoryType;
  priority: number;
  source_message_ids: string[];
  metadata: EpisodicMetadata | Record<string, never>;
  /** Scene name this memory was extracted in */
  scene_name: string;
  /** 发生时刻 / 持续时段 / 观察推断 / 情感（可选，来自提取） */
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: "observed" | "inferred";
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
}

export type DedupAction = "store" | "update" | "merge" | "skip" | "conflict";

/**
 * v3 batch dedup decision — one per new memory, aligned with Kenty's conflict detection prompt.
 *
 * Key changes:
 * - `targetId` → `target_ids` (array, supports multi-target merge/update)
 * - Added `merged_type`, `merged_priority`, `merged_timestamps` for cross-type merge
 */
export interface DedupDecision {
  /** Which new memory this decision is about */
  record_id: string;
  action: DedupAction;
  /** IDs of existing records to replace/remove (for update/merge) */
  target_ids: string[];
  /** Merged/updated content text (for update/merge) */
  merged_content?: string;
  /** Best type after merge (for update/merge, may differ from original) */
  merged_type?: MemoryType;
  /** Priority after merge (for update/merge) */
  merged_priority?: number;
  /** Union of all related timestamps (for update/merge) */
  merged_timestamps?: string[];
  /**
   * P3-T17（H1，拍板④）：dedup LLM 顺带抽取的归一化主题词（归组键）。
   * 零额外 LLM 成本——dedup 判定本就有全文上下文。extractor 在 writeMemory 前
   * attach 到源记忆 metadata.subject，供 consolidation subjectOfLlm 语义归组；
   * 缺省/空串 = 无（走词法兜底）。
   */
  subject?: string;
  /**
   * C1（灵魂记忆 spec §2.1）：dedup LLM 顺带标注的价值锚引用（label 列表）。
   * 零额外 LLM 成本（与 subject 同款顺风车）；parse 侧已按候选清单过滤幻觉 id，
   * 无命中为空/缺省 = 不标注（宁缺毋滥）。extractor 在 writeMemory 前 attach 到
   * 源记忆 metadata.coreRefs，召回排序/展示/遗忘三层消费（检索层不参与——红线）。
   */
  coreRefs?: string[];
  /**
   * 记忆图（G 设计§3）：向量/FTS 召回的 top-1 相似旧记忆（仅 store 决策带）。
   * LLM 判 store 不代表"无关联"——只代表"无需合并/更新"；关联仍应建 similar 边，
   * 让记忆成为网络而非孤点。applyDecisions 依此建边。
   */
  top_candidate?: { record_id: string; score: number };
}

const TAG = "[memory-tdai][l1-writer]";

// ============================
// Core functions
// ============================

/**
 * Generate a unique memory ID.
 */
export function generateMemoryId(): string {
  return `m_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Write a memory record according to the dedup decision.
 *
 * - store: append new record
 * - update: remove target records + append updated record
 * - merge: remove target records + append merged record
 * - skip: do nothing
 *
 * v3: supports multi-target removal for update/merge.
 * v3.1: optional VectorStore + EmbeddingService for dual-write (JSONL + vector).
 */
export async function writeMemory(params: {
  memory: ExtractedMemory;
  decision: DedupDecision;
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  /** Tenancy isolation propagated into MemoryRecord and downstream store. */
  teamId?: string;
  userId?: string;
  agentId?: string;
  logger?: Logger;
  /** Optional vector store for dual-write (JSONL + vector DB) */
  vectorStore?: IMemoryStore;
  /** Optional embedding service (required when vectorStore is provided) */
  embeddingService?: EmbeddingService;
  /** StorageAdapter for file operations (COS/local). Falls back to fs when absent. */
  storage?: StorageAdapter;
}): Promise<MemoryRecord | null> {
  const { memory, decision, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, vectorStore, embeddingService, storage } = params;

  if (decision.action === "skip") {
    logger?.debug?.(`${TAG} Skipping memory: ${memory.content.slice(0, 50)}...`);
    return null;
  }

  const now = new Date().toISOString();

  let nextVersion = 0;
  if ((decision.action === "update" || decision.action === "merge") && decision.target_ids.length > 0 && vectorStore) {
    try {
      const existing = await vectorStore.queryL1Records({ recordIds: decision.target_ids });
      const maxVersion = existing.reduce((max, row) => Math.max(max, row.version ?? 0), 0);
      nextVersion = maxVersion + 1;
    } catch (err) {
      logger?.warn?.(`${TAG} Failed to read existing memory version, defaulting to v0: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Determine final content, type, priority based on action
  let finalContent: string;
  let finalType: MemoryType;
  let finalPriority: number;
  let finalTimestamps: string[];

  if (decision.action === "merge" || decision.action === "update") {
    finalContent = decision.merged_content ?? memory.content;
    finalType = decision.merged_type ?? memory.type;
    finalPriority = decision.merged_priority ?? memory.priority;
    finalTimestamps = decision.merged_timestamps ?? [now];
  } else {
    // store
    finalContent = memory.content;
    finalType = memory.type;
    finalPriority = memory.priority;
    finalTimestamps = [now];
  }

  const record: MemoryRecord = {
    id: decision.record_id || generateMemoryId(),
    content: finalContent,
    type: finalType,
    priority: finalPriority,
    scene_name: memory.scene_name,
    source_message_ids: memory.source_message_ids,
    metadata: memory.metadata,
    timestamps: finalTimestamps,
    createdAt: now,
    updatedAt: now,
    version: nextVersion,
    sessionKey,
    sessionId: sessionId || DEFAULT_ISOLATION_ID,
    taskId,
    teamId,
    // Tenancy isolation — propagated end-to-end so SQLite / TCVDB upsert
    // can persist the row's owner. Empty strings preserve pre-isolation
    // behaviour for callers that haven't been updated yet.
    userId: userId || DEFAULT_ISOLATION_ID,
    agentId: agentId || DEFAULT_ISOLATION_ID,
    // 灵魂记忆字段：捕获进权威 JSONL（observed 缺省，守住"推断不冒充事实"）
    occurred_at: memory.occurred_at,
    valid_start: memory.valid_start,
    valid_end: memory.valid_end,
    certainty: memory.certainty ?? "observed",
    source: memory.source,
    valence: memory.valence,
    arousal: memory.arousal,
    significance: memory.significance,
  };

  // 数据可靠性兜底（确定性规则，零 LLM）：模型没吐时从 content 抽时间锚/情感/重要性，只填空字段。
  // 放在写入唯一 choke point，保证每条都兜底——不依赖管道路由/异步/LLM 稳定性。
  const soulPatch = patchSoulFromContent(record.content ?? "", record);
  if (soulPatch.occurred_at) record.occurred_at = soulPatch.occurred_at;
  if (soulPatch.valence != null) record.valence = soulPatch.valence;
  if (soulPatch.arousal != null) record.arousal = soulPatch.arousal;
  if (soulPatch.significance != null) record.significance = soulPatch.significance;

  // P0 · soul 字段 100% 合标（设计 §7 要求每条必填）：无显式时间→取提取时刻；
  // source 缺→'extraction'；情感/重要度缺→中性默认。放在写入唯一 choke point，保证满列。
  if (!record.occurred_at) record.occurred_at = record.createdAt || new Date().toISOString();
  if (!record.certainty) record.certainty = "observed";
  if (!record.source) record.source = (record as { source?: string }).source || "extraction";
  if (record.valence == null) record.valence = 0;
  if (record.arousal == null) record.arousal = 0;
  if (record.significance == null) record.significance = 0.5;

  const shardDate = formatLocalDate(new Date());
  const recordKey = StoragePaths.record(shardDate);

  // Helper: append a JSONL line
  // - standalone (no storage): write to local fs
  // - service (storage provided): write via StorageAdapter, no fs fallback
  //
  // Guard log (CR-2 fix, 2026-05-19): if storage is absent, emit a warn so any
  // missed wiring (e.g. caller forgot to pass storage in service mode) is
  // immediately visible instead of silently writing to ephemeral pod fs.
  // In standalone mode this warn is benign — the gateway auto-wires a
  // LocalStorageBackend at startup (server.ts:199-203), so storage should
  // normally be defined. Seeing this warn = caller forgot to pass it.
  const appendRecord = async (line: string) => {
    if (storage) {
      await storage.appendFile(recordKey, line);
    } else {
      logger?.warn?.(
        `${TAG} [CR-2 guard] writeMemory called without storage adapter; ` +
        `falling back to local fs at ${baseDir}/records/${shardDate}.jsonl. ` +
        `In service mode this means JSONL is written to ephemeral pod fs and ` +
        `will be lost on restart. Caller must pass 'storage' to writeMemory.`,
      );
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const recordsDir = path.default.join(baseDir, "records");
      await fs.default.mkdir(recordsDir, { recursive: true });
      await fs.default.appendFile(path.default.join(recordsDir, `${shardDate}.jsonl`), line, "utf-8");
    }
  };

  if ((decision.action === "update" || decision.action === "merge") && decision.target_ids.length > 0) {
    // 审计修复 B3：update/merge 的旧目标记忆从"硬删"改为"归档软删"（归档优先于删除红线）。
    // 原实现在向量库硬删 target，但 applyDecisions 随后建的 evolve/similar 边仍指向它们
    // → 孤儿边、证据链断裂。归档保留整行（l1_archive），getL1ByIdsWithArchive 可回溯；
    // 同时 archiveL1 会级联清掉向量/FTS——归档的旧证据不再进入检索面，不污染召回。
    // 检索准确性不受影响（旧内容不再可召回），而演进链/证据链仍可从归档解析。
    if (vectorStore) {
      try {
        let archived = 0;
        for (const tid of decision.target_ids) {
          const ok = await vectorStore.archiveL1?.(tid, `dedup-${decision.action}`);
          if (ok) archived++;
        }
        // 兜底（F7 收官，T2 后仅防御保留）：store 不支持 archive（可选方法 feature-detect
        // 落空的旧后端）时回退硬删，保住"旧证据不进检索面"。T2 起两大在册后端（sqlite 原生、
        // tcvdb 伴生 SQLite 模式）的 archiveL1 均必然成功——本分支在在册后端上 unreachable，
        // 触达即说明接线/后端能力异常，loud warn 登记而不是静默硬删。
        if (archived < decision.target_ids.length) {
          const rest = decision.target_ids.slice(archived);
          logger?.warn?.(
            `${TAG} [F7-defensive] archiveL1 archived ${archived}/${decision.target_ids.length} — falling back to HARD DELETE for ${rest.length} record(s). ` +
            `Unreachable on in-registry backends (sqlite native / tcvdb companion-sqlite since T2); if you see this, the backend lacks archive support or archive is failing.`,
          );
          const deleteFilter = teamId || userId || agentId || sessionId
            ? { teamId, userId, agentId, sessionId: sessionId || undefined, sessionKey }
            : undefined;
          if (deleteFilter) await vectorStore.deleteL1Batch(rest, deleteFilter);
          else await vectorStore.deleteL1Batch(rest);
          logger?.debug?.(`${TAG} VectorStore: archived ${archived}, hard-deleted ${rest.length} target record(s) for ${decision.action}`);
        } else {
          logger?.debug?.(`${TAG} VectorStore: archived ${archived} target record(s) for ${decision.action} (evidence preserved in l1_archive)`);
        }
      } catch (err) {
        logger?.warn?.(
          `${TAG} VectorStore archive/delete failed for ${decision.action}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      await appendRecord(JSON.stringify(record) + "\n");
    } catch (err) {
      logger?.warn?.(`${TAG} JSONL append failed (non-fatal, VDB write continues): ${err instanceof Error ? err.message : String(err)}`);
    }
    logger?.debug?.(`${TAG} ${decision.action} memory: removed [${decision.target_ids.join(",")}] from VectorStore → ${record.id}: ${finalContent.slice(0, 80)}...`);
  } else {
    // store: append a new line
    try {
      await appendRecord(JSON.stringify(record) + "\n");
    } catch (err) {
      logger?.warn?.(`${TAG} JSONL append failed (non-fatal, VDB write continues): ${err instanceof Error ? err.message : String(err)}`);
    }
    logger?.debug?.(`${TAG} Stored memory ${record.id}: ${finalContent.slice(0, 80)}...`);
  }

  // === Vector Store dual-write ===
  if (vectorStore) {
    try {
      logger?.debug?.(
        `${TAG} [vec-dual-write] START id=${record.id}, contentLen=${record.content.length}, ` +
        `content="${record.content.slice(0, 80)}..."`,
      );

      let embedding: Float32Array | undefined;

      if (embeddingService) {
        try {
          embedding = await embeddingService.embed(record.content);
          logger?.debug?.(
            `${TAG} [vec-dual-write] Embedding OK: dims=${embedding.length}, ` +
            `norm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
          );
        } catch (embedErr) {
          // Embedding failed — pass undefined to upsert() which writes
          // metadata + FTS only, skipping the vec0 table.
          logger?.warn(
            `${TAG} [vec-dual-write] Embedding FAILED for id=${record.id}, ` +
            `will write metadata only: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
          );
        }
      }

      const upsertOk = await vectorStore.upsertL1(record, embedding);
      logger?.debug?.(`${TAG} [vec-dual-write] upsert result=${upsertOk} id=${record.id}`);
    } catch (err) {
      // Vector write failure should NOT block the main JSONL write
      logger?.warn?.(
        `${TAG} [vec-dual-write] FAILED (JSONL already written) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    logger?.debug?.(
      `${TAG} [vec-dual-write] SKIPPED id=${record.id}: vectorStore=${!!vectorStore}`,
    );
  }

  return record;
}

// ============================
// Helpers
// ============================

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}