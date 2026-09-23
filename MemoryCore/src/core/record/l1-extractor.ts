/**
 * L1 Memory Extractor: extracts structured memories from L0 conversation messages
 * using a single LLM call with JSON-mode structured output.
 *
 * v3: Aligned with Kenty's prompt — scene segmentation + memory extraction in one call,
 * followed by batch conflict detection.
 *
 * Pipeline:
 * 1. Read recent messages from L0 (split into background + new)
 * 2. Call LLM to extract scene-segmented memories
 * 3. Batch conflict detection against existing records
 * 4. Write to L1 JSONL files
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// D-3（2026-09-21）：敏感性枚举白名单（确定性门——LLM 只提议，非法值裁决为 none）
const SENSITIVITY_ENUM = new Set(["none", "health", "finance", "relationship"]);
/** F-T1-1（2026-09-22 任务1复查发现）：sensitivity 确定性枚举门单一源——
 *  undefined/null/缺失/非法一律归 "none"，禁止串化（此前 String(undefined)="undefined"
 *  落库 4 行污染：生产 2 + ev17e 2）。消费方=主映射 sensitivity 行（写路面）。 */
export function normalizeSensitivity(raw: unknown): "none" | "health" | "finance" | "relationship" {
  const s = typeof raw === "string" ? raw : raw == null ? "none" : String(raw);
  return (SENSITIVITY_ENUM.has(s) ? s : "none") as "none" | "health" | "finance" | "relationship";
}

/** D-4（2026-09-22 拍板）：recurrence 确定性门单一源——LLM 只提议（cadence/anchor/note），
 *  代码裁决：任一形状非法 → 整体 undefined 不落库（宁缺毋滥）。消费方=主映射
 *  metadata.recurrence、遗忘保护守卫 isRecurrenceMeta、徽章渲染 recurrenceLabel。 */
export interface RecurrenceMeta {
  cadence: "weekly" | "biweekly" | "daily" | "monthly" | "quarterly" | "yearly";
  anchor: string | null;
  note: string;
}
const RECURRENCE_CADENCE = new Set(["weekly", "biweekly", "daily", "monthly", "quarterly", "yearly"]);
const WEEKDAY_RE = /^(MON|TUE|WED|THU|FRI|SAT|SUN)$/;
const MONTH_DAY_RE = /^([1-9]|[12]\d|3[01])$/;
const MM_DD_RE = /^\d{2}-\d{2}$/;
export function normalizeRecurrence(raw: unknown): RecurrenceMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { cadence?: unknown; anchor?: unknown; note?: unknown };
  const cadence = typeof r.cadence === "string" ? r.cadence : "";
  if (!RECURRENCE_CADENCE.has(cadence)) return undefined;
  const anchor = typeof r.anchor === "string" && r.anchor.trim() !== "" ? r.anchor.trim() : null;
  const note = typeof r.note === "string" ? r.note.trim() : "";
  if (note.length > 20) return undefined;
  if ((cadence === "weekly" || cadence === "biweekly") && !(anchor && WEEKDAY_RE.test(anchor))) return undefined;
  if (cadence === "monthly" && anchor !== null && !MONTH_DAY_RE.test(anchor)) return undefined;
  if ((cadence === "quarterly" || cadence === "yearly") && anchor !== null && !MM_DD_RE.test(anchor)) return undefined;
  if (cadence === "daily" && anchor !== null) return undefined;
  return { cadence: cadence as RecurrenceMeta["cadence"], anchor, note };
}

/** 形状重验（遗忘保护守卫/徽章渲染共用；防提取侧绕过）。 */
export function isRecurrenceMeta(v: unknown): v is RecurrenceMeta {
  return normalizeRecurrence(v) !== undefined;
}

const WEEKDAY_ZH: Record<string, string> = { MON: "一", TUE: "二", WED: "三", THU: "四", FRI: "五", SAT: "六", SUN: "日" };
/** 徽章文本：note 首选；省略时回退 cadence+anchor 中文映射。 */
export function recurrenceLabel(rec: unknown): string | undefined {
  if (!isRecurrenceMeta(rec)) return undefined;
  const r = rec as RecurrenceMeta;
  if (r.note) return r.note;
  if (r.cadence === "daily") return "每天";
  if (r.cadence === "monthly") return r.anchor ? `每月${r.anchor}日` : "每月";
  if (r.cadence === "quarterly") return "每季度";
  if (r.cadence === "yearly") return "每年";
  if ((r.cadence === "weekly" || r.cadence === "biweekly") && r.anchor && WEEKDAY_ZH[r.anchor])
    return `${r.cadence === "weekly" ? "每周" : "每两周"}${WEEKDAY_ZH[r.anchor]}`;
  return undefined;
}

import { formatExtractionPrompt, getExtractMemoriesSystemPrompt, type MemoryPromptMode } from "../prompts/l1-extraction.js";
import { batchDedup, MIN_SIMILAR_STRENGTH, loadValueCandidates, parseCoreRefs } from "./l1-dedup.js";
import { writeMemory, generateMemoryId } from "./l1-writer.js";
import type { ExtractedMemory, MemoryRecord, MemoryType, DedupDecision } from "./l1-writer.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { sanitizeJsonForParse, shouldExtractL1 } from "../../utils/sanitize.js";
import type { IMemoryStore } from "../store/types.js";
import type { L1SearchResult } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import { report } from "../report/reporter.js";
import { metricProducer } from "../report/kafka-metric-producer.js";
import { reportL1LatencyMetrics } from "../report/metric-tracking-l1-latency.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";
import { StorageAdapter } from "../storage/adapter.js";
import type { ResolvedMemoryPrompt } from "../memory-prompt/types.js";
import { composeMemorySystemPrompt } from "../memory-prompt/composer.js";
import { patchSoulFromContent } from "../lifecycle/consolidation/content-soul.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import {
  buildGenerationLogIdentity,
  buildGenerationProvenance,
  buildPromptGenerationRef,
  MemoryGenerationLogStore,
} from "../memory-generation-log/store.js";
import { writeGenerationProvenanceBestEffort } from "../memory-generation-log/best-effort.js";
import {
  buildMemoryGenerationRefId,
  type MemoryGenerationLog,
} from "../memory-generation-log/types.js";

const TAG = "[memory-tdai][l1-extractor]";

// ============================
// Types
// ============================

/** A scene segment with its extracted memories (LLM output) */
interface SceneSegment {
  scene_name: string;
  message_ids: string[];
  memories: Array<{
    content: string;
    type: string;
    priority: number;
    source_message_ids: string[];
    metadata: Record<string, unknown>;
    /** soul 记忆字段（P2a，可选；LLM 不省略则输出） */
    occurred_at?: string;
    certainty?: string;
    source?: string;
    valence?: number;
    arousal?: number;
    significance?: number;
    /** D-3：敏感性枚举（提取门缺省关=不输出；开启时经确定性校验）。 */
    sensitivity?: string;
  }>;
}

export interface L1ExtractionResult {
  /** Whether extraction succeeded */
  success: boolean;
  /** Number of memories extracted */
  extractedCount: number;
  /** Number of memories actually stored (after dedup) */
  storedCount: number;
  /** The memory records that were stored */
  records: Array<ExtractedMemory & Record<string, unknown>>;
  /** Scene names detected during extraction */
  sceneNames: string[];
  /** Last scene name (for continuity in next extraction) */
  lastSceneName?: string;
}

// ============================
// Core function
// ============================

/**
 * Run the full L1 extraction pipeline on conversation messages.
 *
 * @param messages - Filtered conversation messages (from L0 or directly from hook)
 * @param sessionKey - The session key
 * @param baseDir - Base data directory (~/.openclaw/memory-tdai/)
 * @param config - OpenClaw config (for LLM access)
 * @param options - Extraction options
 * @param logger - Optional logger
 */
export async function extractL1Memories(params: {
  messages: ConversationMessage[];
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  baseDir: string;
  config: unknown;
  /** host-neutral MemoryTdaiConfig（parsed）——selfIdentity gating 权威读取源（D-R5-1 实证：
   * config 形参收 openclawConfig 无 coreMemory 子树 → AGENT_ACT_BLOCK gating 恒 false）。 */
  memoryConfig?: unknown;
  options?: {
    /** Max new messages to send in one extraction call */
    maxMessagesPerExtraction?: number;
    /** Max background messages for context */
    maxBackgroundMessages?: number;
    /** Enable conflict detection */
    enableDedup?: boolean;
    /** 记忆图（G）：是否在 dedup 决策后建 L1↔L1 边（配置项，默认开） */
    enableMemoryLinks?: boolean;
    /**
     * S1（T9 裁决待办收口）：similar 边最低相似度门槛（memory.links.minSimilarity 透传）。
     * 缺省 = MIN_SIMILAR_STRENGTH（0.3，行为逐位不变）；作用于 dedup 路径
     * （batchDedup → attachTopCandidates）与 no-dedup 路径（storeAllDirectly top-1 边）。
     */
    minSimilarity?: number;
    /** Max memories extracted per call */
    maxMemoriesPerSession?: number;
    /** LLM model override */
    model?: string;
    /** Previous scene name for continuity */
    previousSceneName?: string;
    /** Prompt family for L1 extraction (default: chat). */
    promptMode?: MemoryPromptMode;
    /** Resolved custom strategy. Undefined preserves the current system prompt exactly. */
    memoryPrompt?: ResolvedMemoryPrompt;
    /** Vector store for cosine similarity candidate recall */
    vectorStore?: IMemoryStore;
    /** Embedding service for computing query vectors */
    embeddingService?: EmbeddingService;
    /** Top-K candidates for conflict recall (default: 5) */
    conflictRecallTopK?: number;
    /** GROW-EVO P2（§2.2）：durative 效期提取开关——false = 提取侧不写 valid_start（逐位现状） */
    durativeEnabled?: boolean;
    /** Override embedding timeout for capture-path calls (milliseconds) */
    embeddingTimeoutMs?: number;
    /**
     * Host-neutral LLM runner. When provided, used instead of creating
     * a CleanContextRunner (decouples from OpenClaw runtime).
     */
    llmRunner?: LLMRunner;
  };
  logger?: Logger;
  /** Plugin instance ID for metric reporting (optional — metrics skipped if absent) */
  instanceId?: string;
  /**
   * StorageAdapter for L1 JSONL writes.
   * - service mode: must be provided (CosStorageBackend) — JSONL is the source of
   *   truth for backup/recovery; without storage, writes silently fall back to local
   *   pod fs and are lost on pod restart (CR-2 root cause, fixed 2026-05-19).
   * - standalone mode: caller usually provides LocalStorageBackend; if absent,
   *   writeMemory falls back to fs at `{baseDir}/records/{date}.jsonl`.
   */
  storage?: StorageAdapter;
}): Promise<L1ExtractionResult> {
  const { messages, sessionKey, sessionId, taskId, teamId, userId, agentId, baseDir, config, memoryConfig, logger, instanceId: metricInstanceId, storage } = params;
  const options = params.options ?? {};
  const maxNewMessages = options.maxMessagesPerExtraction ?? 10;
  const maxBgMessages = options.maxBackgroundMessages ?? 5;
  const enableDedup = options.enableDedup ?? true;
  const maxMemoriesPerSession = options.maxMemoriesPerSession ?? 10;

  if (messages.length === 0) {
    logger?.debug?.(`${TAG} No messages to extract from`);
    return { success: true, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  const l1StartMs = Date.now();

  // Quality gate: filter messages through L1 extraction rules (length, symbols,
  // prompt injection, etc.) before sending to the LLM. L0 deliberately captures
  // everything; the strict filtering happens here at L1 stage.
  const qualifiedMessages = messages.filter((m) => shouldExtractL1(m.content));
  if (qualifiedMessages.length < messages.length) {
    logger?.debug?.(
      `${TAG} L1 quality filter: ${messages.length} → ${qualifiedMessages.length} messages ` +
      `(${messages.length - qualifiedMessages.length} filtered out)`,
    );
  }

  if (qualifiedMessages.length === 0) {
    logger?.debug?.(`${TAG} All messages filtered out by L1 quality gate`);
    return { success: true, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  // Split messages into background (older) + new (recent)
  const newMessages = qualifiedMessages.slice(-maxNewMessages);
  const bgEndIdx = qualifiedMessages.length - newMessages.length;
  const backgroundMessages = bgEndIdx > 0
    ? qualifiedMessages.slice(Math.max(0, bgEndIdx - maxBgMessages), bgEndIdx)
    : [];

  logger?.debug?.(`${TAG} Extracting from ${newMessages.length} new messages (+ ${backgroundMessages.length} background) [${qualifiedMessages.length} qualified from ${messages.length} input]`);

  // Step 1: LLM extraction (scene segmentation + memory extraction)
  let scenes: SceneSegment[];
  let llmRaw: { systemPrompt: string; userPrompt: string; rawOutput: string } | undefined;
  try {
    const out = await callLlmExtraction({
      newMessages,
      backgroundMessages,
      previousSceneName: options.previousSceneName,
      memoryConfig,
      config,
      logger,
      model: options.model,
      promptMode: options.promptMode,
      memoryPrompt: options.memoryPrompt,
      traceContext: { teamId, userId, agentId, sessionId },
      llmRunner: options.llmRunner,
      vectorStore: options.vectorStore,
    });
    scenes = out.scenes;
    llmRaw = { systemPrompt: out.systemPrompt, userPrompt: out.userPrompt, rawOutput: out.rawOutput };
    logger?.debug?.(`${TAG} LLM detected ${scenes.length} scene(s)`);
  } catch (err) {
    logger?.error(`${TAG} LLM extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  // Flatten all memories across scenes
  // soul 字段透传（occurred_at/certainty/source/valence/arousal/significance）——
  // ExtractedMemory 基础类型不含这些 optional 字段，用交叉类型放宽（写入时 cast 交给 store）
  const allExtracted: ExtractedMemory[] = [];
  const sceneNames: string[] = [];

  for (const scene of scenes) {
    sceneNames.push(scene.scene_name);
    for (const mem of scene.memories) {
      const memType = normalizeType(mem.type);
      if (!memType) {
        logger?.warn?.(`${TAG} Skipping memory with invalid type "${mem.type}"`);
        continue;
      }
      allExtracted.push({
        content: mem.content,
        type: memType,
        priority: typeof mem.priority === "number" ? mem.priority : 50,
        source_message_ids: Array.isArray(mem.source_message_ids) ? mem.source_message_ids : [],
        metadata: (() => {
          // D-4 确定性门（丢值点 #3 同位）：合法 recurrence 形状才并入 metadata_json（零 schema 变更）
          const rec = normalizeRecurrence((mem as { recurrence?: unknown }).recurrence);
          const base = (mem.metadata ?? {}) as Record<string, unknown>;
          return rec ? { ...base, recurrence: rec } : base;
        })(),
        scene_name: scene.scene_name,
        // 灵魂记忆字段必须透传（此前重建时遗漏，导致写好却全空）
        occurred_at: mem.occurred_at,
        // GROW-EVO P2（§2.2）：valid_start 仅在开关开且 LLM 判 durative 时落库；
        // valid_end 提取侧永不写（只能 conflict/手动失效）——开放区间语义。
        //（cast 访问：scene.memories 推断类型无 soul 字段——预存量口径，不新增错误）
        valid_start: options.durativeEnabled === true && (mem as { durative?: boolean }).durative === true ? ((mem as { valid_start?: string }).valid_start || (mem as { occurred_at?: string }).occurred_at) : undefined,
        valid_end: undefined,
        certainty: (mem.certainty ?? "observed") as "observed" | "inferred",
        source: mem.source,
        valence: mem.valence,
        arousal: mem.arousal,
        significance: mem.significance,
        // D-3 确定性枚举门：仅白名单放行，非法/缺失 → none（LLM 只提议，代码裁决）
        sensitivity: normalizeSensitivity((mem as { sensitivity?: string }).sensitivity),
      });
    }
  }

  logger?.debug?.(`${TAG} Total extracted memories: ${allExtracted.length} across ${scenes.length} scene(s)`);

  // 后置字段补全：模型有时不吐灵魂字段——用一次 LLM 从 content 抽字段回填（best-effort，绝不阻塞）
  try {
    await enrichSoulFields(allExtracted, {
      config,
      logger,
      model: options.model,
      llmRunner: options.llmRunner,
      traceContext: { teamId, userId, agentId, sessionId },
    });
  } catch (err) {
    logger?.warn?.(`${TAG} enrichSoulFields failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  if (allExtracted.length === 0) {
    // ── 评测指标：L1 提取率（提取为空的情况） ──
    if (metricInstanceId) {
      try {
        const l0Count = messages.length;
        metricProducer.send({ metric: "l0_input_count", instanceId: metricInstanceId, value: l0Count, source: "core" });
        metricProducer.send({ metric: "l1_extracted_count", instanceId: metricInstanceId, value: 0, source: "core" });
        if (l0Count > 0) {
          metricProducer.send({ metric: "l1_extraction_rate", instanceId: metricInstanceId, value: 0, source: "core" });
        }
      } catch {
        // 静默忽略，不影响业务逻辑
      }
    }
    return {
      success: true,
      extractedCount: 0,
      storedCount: 0,
      records: [],
      sceneNames,
      lastSceneName: sceneNames[sceneNames.length - 1],
    };
  }

  // Limit per session
  let extracted = allExtracted;
  if (extracted.length > maxMemoriesPerSession) {
    logger?.debug?.(`${TAG} Limiting from ${extracted.length} to ${maxMemoriesPerSession} memories per session`);
    extracted = extracted.slice(0, maxMemoriesPerSession);
  }

  // Assign temporary IDs to extracted memories (needed for batch dedup)
  const memoriesWithIds = extracted.map((m) => ({
    ...m,
    record_id: generateMemoryId(),
  }));

  // Step 2: Batch Conflict Detection + Write
  let storedRecords: MemoryRecord[];
  let dedupLatencyMs: number | null = null;
  const generationFinishedAt = Date.now();
  const generationIdentity = buildGenerationLogIdentity(
    "l1",
    generationFinishedAt,
    memoriesWithIds[0]?.record_id,
  );
  const generationPrompt = buildPromptGenerationRef(options.memoryPrompt, "l1");
  const generation = buildGenerationProvenance(generationIdentity, generationPrompt);

  if (enableDedup) {
    try {
      const dedupStartMs = Date.now();
      const decisions = await batchDedup({
        memories: memoriesWithIds,
        config,
        logger,
        model: options.model,
        promptMode: options.promptMode,
        vectorStore: options.vectorStore,
        embeddingService: options.embeddingService,
        conflictRecallTopK: options.conflictRecallTopK,
        durativeEnabled: options.durativeEnabled,
        embeddingTimeoutMs: options.embeddingTimeoutMs,
        llmRunner: options.llmRunner,
        // S1：similar 建边门槛配置化（memory.links.minSimilarity），缺省 0.3
        minSimilarity: options.minSimilarity,
        traceContext: { teamId, userId, agentId, sessionId },
        // 记忆图/dedup 候选召回：**不带 sessionId** —— L1 关联是 agent 维度语义
        // （与 v2 atomic/search 的 L1 召回同一原则）。带 sessionId 会让每个新会话
        // 看不到其它会话的记忆 → dedup 永远 store 且零候选 → 记忆零关联（生产实锤根因）。
        // 租户隔离仍由 teamId/userId/agentId/taskId 守住（never crosses tenants 语义不变）。
        ...((teamId || userId || agentId || taskId) ? { filter: { teamId, userId, agentId, taskId } } : {}),
      });
      dedupLatencyMs = Date.now() - dedupStartMs;

      // ── 评测指标：去重决策分布 ──
      if (metricInstanceId) {
        try {
          const dedupCounts = { store: 0, update: 0, merge: 0, skip: 0 };
          for (const d of decisions) {
            if (d.action in dedupCounts) {
              dedupCounts[d.action as keyof typeof dedupCounts]++;
            }
          }
          metricProducer.send({ metric: "l1_dedup_store_count", instanceId: metricInstanceId, value: dedupCounts.store, source: "core" });
          metricProducer.send({ metric: "l1_dedup_update_count", instanceId: metricInstanceId, value: dedupCounts.update, source: "core" });
          metricProducer.send({ metric: "l1_dedup_merge_count", instanceId: metricInstanceId, value: dedupCounts.merge, source: "core" });
          metricProducer.send({ metric: "l1_dedup_skip_count", instanceId: metricInstanceId, value: dedupCounts.skip, source: "core" });
        } catch {
          // 静默忽略，不影响业务逻辑
        }
      }

      storedRecords = await applyDecisions({
        memoriesWithIds,
        decisions,
        baseDir,
        sessionKey,
        sessionId,
        taskId,
        teamId,
        userId,
        agentId,
        logger,
        vectorStore: options.vectorStore,
        embeddingService: options.embeddingService,
        storage,
        enableMemoryLinks: options.enableMemoryLinks !== false,
      });

    } catch (err) {
      logger?.warn?.(`${TAG} Batch dedup failed, storing all as new: ${err instanceof Error ? err.message : String(err)}`);
      storedRecords = await storeAllDirectly(memoriesWithIds, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, options.vectorStore, options.embeddingService, storage, options.enableMemoryLinks !== false, options.minSimilarity);
    }
  } else {
    storedRecords = await storeAllDirectly(memoriesWithIds, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, options.vectorStore, options.embeddingService, storage, options.enableMemoryLinks !== false, options.minSimilarity);
  }

  const logStorage = storage ?? new StorageAdapter(new LocalStorageBackend(baseDir));
  const generationLogStore = new MemoryGenerationLogStore(logStorage, metricInstanceId ?? "standalone");
  const generationLog: MemoryGenerationLog = {
    schema_version: 1,
    log_id: generationIdentity.logId,
    generation_id: generationIdentity.generationId,
    instance_id: metricInstanceId ?? "standalone",
    layer: "l1",
    status: "succeeded",
    team_id: teamId,
    agent_id: agentId,
    user_id: userId,
    session_id: sessionId,
    task_id: taskId,
    prompt: generationPrompt,
    prompt_text: llmRaw ? `${llmRaw.systemPrompt}\n---USER_PROMPT---\n${llmRaw.userPrompt}` : undefined,
    raw_output: llmRaw?.rawOutput,
    anchor_memory_id: storedRecords[0]?.id ?? memoriesWithIds[0]?.record_id,
    input_refs: newMessages.map((message) => ({ layer: "l0", record_id: message.id })),
    output_refs: storedRecords.map((record) => ({ layer: "l1", record_id: record.id })),
    model: options.model,
    prompt_mode: options.promptMode ?? "chat",
    started_at_ms: l1StartMs,
    finished_at_ms: generationFinishedAt,
    latency_ms: generationFinishedAt - l1StartMs,
  };
  await (writeGenerationProvenanceBestEffort as unknown as (p: Record<string, unknown>) => Promise<void>)({
    layer: "l1",
    logger,
    writeLog: () => generationLogStore.write(generationLog, generationIdentity.key),
    writeRefs: options.vectorStore?.upsertMemoryGenerationRefs && storedRecords.length > 0
      ? () => options.vectorStore!.upsertMemoryGenerationRefs!(storedRecords.map((record) => ({
          generation_ref_id: buildMemoryGenerationRefId("l1", record.id),
          layer: "l1" as const,
          memory_id: record.id,
          ...generation,
          created_at_ms: generationFinishedAt,
        })))
      : undefined,
  });

  logger?.info(`${TAG} Extraction complete: extracted=${extracted.length}, stored=${storedRecords.length}`);

  // ── l1_extraction metric ──
  if (metricInstanceId && logger) {
    // Build type distribution of stored memories
    const memoriesByType: Record<string, number> = {};
    for (const r of storedRecords) {
      memoriesByType[r.type] = (memoriesByType[r.type] ?? 0) + 1;
    }
    report("l1_extraction", {
      sessionKey,
      inputMessageCount: messages.length,
      memoriesExtracted: extracted.length,
      memoriesStored: storedRecords.length,
      memoriesStoredContent: storedRecords.map((r) => ({
        content: r.content,
        type: r.type,
        scene: r.scene_name ?? null,
      })),
      memoriesByType,
      totalDurationMs: Date.now() - l1StartMs,
      success: true,
      error: null,
    });
  }

  // ── 评测指标：L1 提取率 ──
  if (metricInstanceId) {
    try {
      const l0Count = messages.length;
      const l1Count = extracted.length;
      metricProducer.send({ metric: "l0_input_count", instanceId: metricInstanceId, value: l0Count, source: "core" });
      metricProducer.send({ metric: "l1_extracted_count", instanceId: metricInstanceId, value: l1Count, source: "core" });
      if (l0Count > 0) {
        metricProducer.send({ metric: "l1_extraction_rate", instanceId: metricInstanceId, value: l1Count / l0Count, source: "core" });
      }
    } catch {
      // 静默忽略，不影响业务逻辑
    }
  }

  // ── 评测指标：L1 延迟 ──
  try {
    reportL1LatencyMetrics({
      instanceId: metricInstanceId ?? "",
      extractionLatencyMs: Date.now() - l1StartMs,
      dedupLatencyMs,
      hasError: false,
    });
  } catch {
    // 静默忽略
  }

  return {
    success: true,
    extractedCount: extracted.length,
    storedCount: storedRecords.length,
    records: storedRecords as never,
    sceneNames,
    lastSceneName: sceneNames[sceneNames.length - 1],
  };
}

// ============================
// LLM call
// ============================

/**
 * Call LLM to extract scene-segmented memories from conversation messages.
 */
async function callLlmExtraction(params: {
  newMessages: ConversationMessage[];
  backgroundMessages: ConversationMessage[];
  previousSceneName?: string;
  config: unknown;
  memoryConfig?: unknown;
  logger?: Logger;
  model?: string;
  promptMode?: MemoryPromptMode;
  memoryPrompt?: ResolvedMemoryPrompt;
  /** Host-neutral LLM runner — when provided, used instead of CleanContextRunner. */
  llmRunner?: LLMRunner;
  /** A8：锚候选加载需要 vectorStore（listValues 按租户读锚） */
  vectorStore?: IMemoryStore;
  /** langfuse 上报身份四元组（team/user/agent/session）。 */
  traceContext?: TraceContext;
}): Promise<{ scenes: SceneSegment[]; systemPrompt: string; userPrompt: string; rawOutput: string }> {
  const { newMessages, backgroundMessages, previousSceneName, config, memoryConfig, logger, model, promptMode = "chat", memoryPrompt, llmRunner, traceContext, vectorStore } = params;

  // DS-SOUL-MEMORY-002 P1：agent 行为事实视角（gated）。composeMemorySystemPrompt 的
  // 自定义 memoryPrompt 策略优先级不变——自定义时内置 base 被其覆盖，agentAct 块随之
  // 不生效（自定义策略=用户权威，不篡改）。config 形参为 host-neutral unknown，窄化读取。
  // D-R5-1：memoryConfig（MemoryTdaiConfig）优先——openclawConfig 无 coreMemory 子树
  const selfIdentityEnabled =
    (memoryConfig as { coreMemory?: { selfIdentity?: { enabled?: boolean } } } | undefined)
      ?.coreMemory?.selfIdentity?.enabled === true ||
    (config as { coreMemory?: { selfIdentity?: { enabled?: boolean } } } | undefined)
      ?.coreMemory?.selfIdentity?.enabled === true;
  // D-3（2026-09-21）：敏感性标注（gated，缺省关闭=逐位现状）
  const sensitivityEnabled =
    (memoryConfig as { sensitivity?: { extractionEnabled?: boolean } } | undefined)
      ?.sensitivity?.extractionEnabled === true;
  // D-4（2026-09-22 拍板）：周期性事实提取块（gated，缺省关闭=逐位现状）
  const recurrenceEnabled =
    (memoryConfig as { extraction?: { recurrenceEnabled?: boolean } } | undefined)
      ?.extraction?.recurrenceEnabled === true;
  const systemPrompt = composeMemorySystemPrompt(
    getExtractMemoriesSystemPrompt(promptMode, { selfIdentityEnabled, sensitivityEnabled, recurrenceEnabled }),
    memoryPrompt,
  );
  // A8（REG-REMAINING-001）：锚候选加载——新颖记忆的 coreRefs 标注机会前移到提取
  const valueCandidates = await loadValueCandidates(vectorStore, traceContext, logger);
  const userPrompt = formatExtractionPrompt({
    newMessages,
    backgroundMessages,
    previousSceneName,
    valueCandidates,
  });

  // [l1-debug] ENTRY — what are we about to ask the LLM to extract?
  logger?.debug?.(
    `${TAG} [l1-debug] ENTRY taskId=l1-extraction, promptMode=${promptMode}, newMsgs=${newMessages.length}, bgMsgs=${backgroundMessages.length}, userPromptLen=${userPrompt.length}, sysPromptLen=${systemPrompt.length}, model=${model ?? "(default)"}, previousSceneName=${previousSceneName ? JSON.stringify(previousSceneName) : "(none)"}, runnerKind=${llmRunner ? "llmRunner" : "CleanContextRunner"}`,
  );

  let result: string;

  // langfuse trace 语义：让此次 L1 抽取在 UI 有稳定 name / 顶级 user/session 列
  // / 可筛选 tags。避免所有记忆抽取都显示为 Unnamed trace。
  const traceParams = buildTraceParams("memory.l1-extract", traceContext);

  if (llmRunner) {
    // Use the host-neutral LLMRunner interface
    result = await llmRunner.run({
      prompt: userPrompt,
      systemPrompt,
      taskId: "l1-extraction",
      timeoutMs: 180_000,
      ...traceParams,
    });
  } else {
    // Fallback: create CleanContextRunner (OpenClaw path)
    const runner = new CleanContextRunner({
      config,
      modelRef: model,
      enableTools: false,
      logger,
    });

    result = await runner.run({
      prompt: userPrompt,
      systemPrompt,
      taskId: "l1-extraction",
      timeoutMs: 180_000,
      ...traceParams,
    });
  }

  // [l1-debug] RAW OUTPUT — 定位模型到底吐了哪些字段（用于 R4 实证）
  logger?.debug?.(`${TAG} [l1-debug] RAW_OUTPUT:\n${result}`);

  const _scenes = parseExtractionResult(result, logger, valueCandidates);
  return { scenes: _scenes, systemPrompt, userPrompt, rawOutput: result };
}

/**
 * Parse the LLM's JSON response into SceneSegment array.
 * Expected format: [{scene_name, message_ids, memories: [...]}]
 */
export function parseExtractionResult(raw: string, logger?: Logger, valueCandidates: Array<{ id: string; label: string }> = []): SceneSegment[] {
  try {
    // Strip markdown code block wrappers if present
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Try to extract JSON array
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      logger?.warn?.(`${TAG} No JSON array found in extraction response`);
      // [l1-debug] NO_JSON — dump the full raw so we can see what the LLM actually said
      const rawPreview = raw.slice(0, 2048);
      logger?.warn?.(
        `${TAG} [l1-debug] NO_JSON taskId=l1-extraction, rawLen=${raw.length}, cleanedLen=${cleaned.length}, rawFull=${JSON.stringify(rawPreview)}${raw.length > 2048 ? `…(+${raw.length - 2048})` : ""}`,
      );
      return [];
    }

    // Sanitize control characters inside JSON string literals that LLM may produce.
    // Some weaker OpenAI-compatible models occasionally emit bare identifiers for
    // numeric fields (e.g. `"priority": sheet`). Repair only known safe fields and
    // retry once so one bad scalar does not drop the whole extraction result.
    const sanitized = sanitizeJsonForParse(arrayMatch[0]);
    let parsed: unknown[];
    try {
      parsed = JSON.parse(sanitized) as unknown[];
    } catch (err) {
      const repaired = repairExtractionJson(sanitized);
      if (repaired === sanitized) throw err;
      parsed = JSON.parse(repaired) as unknown[];
      logger?.warn?.(`${TAG} Repaired non-strict extraction JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!Array.isArray(parsed)) {
      logger?.warn?.(`${TAG} Extraction response is not an array`);
      return [];
    }

    const scenes: SceneSegment[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const s = item as Record<string, unknown>;

      scenes.push({
        scene_name: typeof s.scene_name === "string" ? s.scene_name : "未知情境",
        message_ids: Array.isArray(s.message_ids) ? s.message_ids.map(String) : [],
        memories: Array.isArray(s.memories)
          ? (s.memories as Array<Record<string, unknown>>)
              .filter((m) => m && typeof m === "object" && typeof m.content === "string" && (m.content as string).length > 0)
              .map((m) => ({
                content: String(m.content),
                type: String(m.type ?? "episodic"),
                priority: typeof m.priority === "number" ? m.priority : 50,
                source_message_ids: Array.isArray(m.source_message_ids) ? m.source_message_ids.map(String) : [],
                metadata: (() => {
                  const base = (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>;
                  const refs = parseCoreRefs(m.coreRefs, valueCandidates);
                  return refs && refs.length > 0 ? { ...base, coreRefs: refs } : base;
                })(),
                // 灵魂记忆字段（可选，防御解析）：时空 / 观察推断 / 情感
                occurred_at: typeof m.occurred_at === "string" ? m.occurred_at : undefined,
                durative: m.durative === true,
                valid_start: typeof m.valid_start === "string" ? m.valid_start : undefined,
                valid_end: typeof m.valid_end === "string" ? m.valid_end : undefined,
                certainty: m.certainty === "inferred" ? "inferred" : "observed",
                // A8：coreRefs 原样透传（parseCoreRefs 过滤在调用方——候选清单在其作用域）
                source: typeof m.source === "string" ? m.source : undefined,
                valence: typeof m.valence === "number" ? m.valence : undefined,
                arousal: typeof m.arousal === "number" ? m.arousal : undefined,
                significance: typeof m.significance === "number" ? m.significance : undefined,
                // D-3：敏感性透传（枚举门在主映射处统一裁决——此处只带原始值）
                sensitivity: typeof m.sensitivity === "string" ? m.sensitivity : undefined,
              }))
          : [],
      });
    }

    return scenes;
  } catch (err) {
    logger?.warn?.(`${TAG} Failed to parse extraction result: ${err instanceof Error ? err.message : String(err)}`);
    const rawPreview = raw.slice(0, 2048);
    logger?.warn?.(
      `${TAG} [l1-debug] PARSE_FAIL rawLen=${raw.length}, rawFull=${JSON.stringify(rawPreview)}${raw.length > 2048 ? `…(+${raw.length - 2048})` : ""}`,
    );
    return [];
  }
}

function repairExtractionJson(json: string): string {
  return json
    .replace(
      /("priority"\s*:\s*)(?!-?\d+(?:\.\d+)?\s*[,}]|"[^"\\]*(?:\\.[^"\\]*)*"\s*[,}])([\s\S]*?)(?=,\s*"(?:content|type|priority|source_message_ids|metadata)"\s*:|[}\]])/g,
      (_m, prefix: string) => `${prefix}50`,
    )
    .replace(/,\s*([}\]])/g, "$1");
}

// ============================
// Write helpers
// ============================

const ENRICH_SYSTEM =
  "你是记忆字段补全器。从记忆内容里提取5个字段：occurred_at(ISO8601字符串，内容无明确时间就空串)、" +
  "certainty(observed=客观见到的 / inferred=推断)、valence(情感 -1..1)、arousal(强度 0..1)、significance(重要 0..1)。" +
  "只输出JSON数组，每项 {index, occurred_at, certainty, valence, arousal, significance}。";

function buildEnrichPrompt(memories: Array<{ m: ExtractedMemory; i: number }>): string {
  return memories.map(({ m, i }) => `${i}. ${m.content}`).join("\n\n");
}

/**
 * 后置字段补全：对 content 已含时间/情感、但结构化字段因模型省略而缺失的记忆，
 * 用一次 LLM 调用从 content 抽 occurred_at/certainty/valence/arousal/significance 回填。
 * best-effort：任何失败保持原样，不阻塞写入。
 */
async function enrichSoulFields(
  memories: ExtractedMemory[],
  deps: { config: unknown; memoryConfig?: unknown; logger?: Logger; model?: string; llmRunner?: LLMRunner; traceContext?: TraceContext },
): Promise<void> {
  if (!memories || memories.length === 0) return;
  const missing = memories
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !m.occurred_at || !m.certainty || m.valence == null || m.arousal == null || m.significance == null);
  if (missing.length === 0) return;
  deps.logger?.debug?.(`${TAG} [l1-enrich] enriching ${missing.length}/${memories.length} missing soul fields`);

  // ① 确定性规则回填（零 LLM，可靠）：从 content 抽时间锚/情感/重要性，只填空字段。
  //    解决"模型不吐 → 列空"——不依赖不稳的 LLM，先兜底可靠的。
  for (const { m } of missing) {
    const patch = patchSoulFromContent(m.content, m);
    if (patch.occurred_at) m.occurred_at = patch.occurred_at;
    if (patch.certainty) m.certainty = patch.certainty;
    if (patch.valence != null) m.valence = patch.valence;
    if (patch.arousal != null) m.arousal = patch.arousal;
    if (patch.significance != null) m.significance = patch.significance;
  }

  const prompt = buildEnrichPrompt(missing);
  let result: string;
  try {
    if (deps.llmRunner) {
      result = await deps.llmRunner.run({
        prompt, systemPrompt: ENRICH_SYSTEM, taskId: "l1-enrich", timeoutMs: 30_000,
        ...(deps.traceContext ?? {}),
      });
    } else {
      const runner = new CleanContextRunner({ config: deps.config, modelRef: deps.model, enableTools: false, logger: deps.logger });
      result = await runner.run({
        prompt, systemPrompt: ENRICH_SYSTEM, taskId: "l1-enrich", timeoutMs: 30_000,
        ...(deps.traceContext ?? {}),
      });
    }
  } catch (err) {
    deps.logger?.warn?.(`${TAG} enrich LLM call failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let filled: Array<{ index: number; occurred_at?: string; certainty?: string; valence?: number; arousal?: number; significance?: number }> = [];
  try { filled = JSON.parse(result); } catch {
    const m = result.match(/\[[\s\S]*\]/);
    if (m) { try { filled = JSON.parse(m[0]); } catch { filled = []; } }
  }
  const byIndex = new Map(filled.map((f) => [f.index, f]));
  for (const { m, i } of missing) {
    const f = byIndex.get(i);
    if (!f) continue;
    if (!m.occurred_at && f.occurred_at) m.occurred_at = String(f.occurred_at);
    if (!m.certainty && f.certainty) m.certainty = String(f.certainty) === "inferred" ? "inferred" : "observed";
    if (m.valence == null && typeof f.valence === "number") m.valence = f.valence;
    if (m.arousal == null && typeof f.arousal === "number") m.arousal = f.arousal;
    if (m.significance == null && typeof f.significance === "number") m.significance = f.significance;
  }
}

/**
 * Apply batch dedup decisions — write memories according to their decisions.
 */
async function applyDecisions(params: {
  memoriesWithIds: Array<ExtractedMemory & { record_id: string }>;
  decisions: DedupDecision[];
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  storage?: StorageAdapter;
  /** 记忆图（G）：是否在 dedup 决策后建边（配置项，默认开） */
  enableMemoryLinks?: boolean;
}): Promise<MemoryRecord[]> {
  const { memoriesWithIds, decisions, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, vectorStore, embeddingService, storage, enableMemoryLinks = true } = params;
  const storedRecords: MemoryRecord[] = [];

  // Build a map from record_id → decision
  const decisionMap = new Map<string, DedupDecision>();
  for (const d of decisions) {
    decisionMap.set(d.record_id, d);
  }

  for (const memoryWithId of memoriesWithIds) {
    const decision = decisionMap.get(memoryWithId.record_id) ?? {
      record_id: memoryWithId.record_id,
      action: "store" as const,
      target_ids: [],
    };

    try {
      // P3-T17（H1，拍板④）：dedup 决策带 subject（LLM 顺带抽取的语义主题词）时，
      // 在 writeMemory 前 attach 到源记忆 metadata.subject（归组键）。
      // 命名决策：源记忆的 metadata.subject 是"归组键"；durative 的 metadata.subject 是
      // 幂等键（existingDurativeOf 只读 scene_name=consolidated 的行）——同名不同行，不冲突。
      const decisionSubject = typeof decision.subject === "string" && decision.subject.trim() ? decision.subject.trim() : undefined;
      // C1（灵魂记忆 spec §2.1）：dedup 决策带 coreRefs（LLM 顺带标注、parse 侧已按
      // 候选清单过滤幻觉）时，writeMemory 前 attach 到源记忆 metadata.coreRefs——
      // writeMemory 对 memory.metadata 原样透传（l1-writer 落库即全链可达）。
      // 无 coreRefs（缺省/空）不写该键（宁缺毋滥）。
      const decisionCoreRefs = Array.isArray(decision.coreRefs) && decision.coreRefs.length > 0
        ? decision.coreRefs
        : undefined;
      const memoryToWrite = decisionSubject || decisionCoreRefs
        ? {
            ...memoryWithId,
            metadata: {
              ...(memoryWithId.metadata ?? {}),
              ...(decisionSubject ? { subject: decisionSubject } : {}),
              ...(decisionCoreRefs ? { coreRefs: decisionCoreRefs } : {}),
            },
          }
        : memoryWithId;
      const record = await writeMemory({
        memory: memoryToWrite as never,
        decision,
        baseDir,
        sessionKey,
        sessionId,
        taskId,
        teamId,
        userId,
        agentId,
        logger,
        vectorStore,
        embeddingService,
        storage,
      });

      if (record) {
        storedRecords.push(record);
        // 记忆图（G）：按 dedup 决策建边。时序关键：writeMemory 内部已把 update/merge 的
        // 旧 target 归档（archiveL1 会级联清 target 的旧边），此处再建新边——
        // 因此新边不会被误删；真删边只发生在归档/删除记忆的路径上。
        // 证据可回溯：邻居解析侧用 getL1ByIdsWithArchive（审计 B3）。
        if (enableMemoryLinks && vectorStore && decision.target_ids.length > 0) {
          try {
            // G 设计§3/§5 红线：evolve/causal 只允许 observed 层记忆自动建（推断不冒充因果）
            const observedOnly = (record as { certainty?: string }).certainty !== "inferred";
            if (decision.action === "update" && observedOnly) {
              for (const t of decision.target_ids) vectorStore.addLink?.(record.id, t, "evolve", 1);
            } else if (decision.action === "merge") {
              for (const t of decision.target_ids) vectorStore.addLink?.(record.id, t, "similar", 1);
            } else if (decision.action === "conflict") {
              // P4：冲突边（矛盾双方都保留），无 observed 限制——冲突是关系事实
              for (const t of decision.target_ids) vectorStore.addLink?.(record.id, t, "conflict", 1);
              // GROW-EVO P2（§2.2 方向性守卫）：仅新记忆 observed 才自动失效旧记忆；
              // inferred → 只记 conflict 边（推断不许冒充事实——红线对称应用）。
              // 失效 = 写 valid_end（失效不删除）；best-effort 不阻塞写入。
              if ((record as { certainty?: string }).certainty === "observed") {
                const invalidEnd = record.occurred_at || new Date().toISOString();
                for (const t of decision.target_ids) vectorStore.invalidateL1?.(t, invalidEnd);
              }
            }
          } catch (err) {
            logger?.warn?.(`${TAG} Edge creation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // ── 记忆图（G 设计§3）：store 决策也建 top-1 similar 边 ──
        // LLM 判 store = "无需合并/更新"，不代表"无关联"。dedup 召回阶段已找到
        // top-1 相似旧记忆（decision.top_candidate），此处连边让记忆成网而非孤点。
        // 仅 observed 建（入口真实红线）；best-effort 不阻塞写入。
        if (
          enableMemoryLinks && vectorStore?.addLink &&
          decision.action === "store" && decision.top_candidate &&
          (record as { certainty?: string }).certainty !== "inferred"
        ) {
          try {
            vectorStore.addLink(record.id, decision.top_candidate.record_id, "similar", decision.top_candidate.score);
            logger?.debug?.(`${TAG} store-decision similar edge: ${record.id} → ${decision.top_candidate.record_id} (score=${decision.top_candidate.score})`);
          } catch (err) {
            logger?.warn?.(`${TAG} store similar edge failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      logger?.warn?.(
        `${TAG} Write failed for memory "${memoryWithId.content.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return storedRecords;
}

/**
 * Store all memories directly (no dedup).
 */
async function storeAllDirectly(
  memoriesWithIds: Array<ExtractedMemory & { record_id: string }>,
  baseDir: string,
  sessionKey: string,
  sessionId: string | undefined,
  taskId: string | undefined,
  teamId?: string,
  userId?: string,
  agentId?: string,
  logger?: Logger,
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
  storage?: StorageAdapter,
  enableMemoryLinks = true,
  /** S1：similar 边最低相似度门槛（memory.links.minSimilarity），缺省 = MIN_SIMILAR_STRENGTH。 */
  minSimilarity: number = MIN_SIMILAR_STRENGTH,
): Promise<MemoryRecord[]> {
  const storedRecords: MemoryRecord[] = [];
  // G4（T9-B）：同批排除——批内新记忆不互当"最相关旧记忆"（对照 dedup 路径的
  // newRecordIds 过滤）。原实现只排自身（c.record_id !== record.id），先写入的
  // 同批记忆会被后写入者当成 top-1 旧记忆，把真旧记忆挤出 top-3。
  const batchIds = new Set(memoriesWithIds.map((m) => m.record_id));

  for (const memoryWithId of memoriesWithIds) {
    try {
      const wasInLinks = enableMemoryLinks && !!vectorStore?.addLink && !!embeddingService;
      const record = await writeMemory({
        memory: memoryWithId,
        decision: {
          record_id: memoryWithId.record_id,
          action: "store",
          target_ids: [],
        },
        baseDir,
        sessionKey,
        sessionId,
        taskId,
        teamId,
        userId,
        agentId,
        logger,
        vectorStore,
        embeddingService,
        storage,
      });
      if (record) {
        storedRecords.push(record);
        // ── 记忆图（G 设计§3）：no-dedup 路径下，对每条新记忆找最相关 top-1 旧记忆，建 similar 边 ──
        // 「新记忆与最相关 top-1 旧记忆（无 dedup）→ 用现有 RRF 的 top 命中间加 similar 边」。
        // 仅 observed 建 similar（inferred 不自动连，守"入口真实"红线）；best-effort。
        if (wasInLinks && (record as { certainty?: string }).certainty !== "inferred") {
          // topK 扩容 3+批大小：同批排除会消耗召回位，防真旧记忆被挤出
          const candidates: L1SearchResult[] = vectorStore?.searchL1Vector
            ? await vectorStore.searchL1Vector(await embeddingService!.embed(memoryWithId.content), 3 + memoriesWithIds.length, memoryWithId.content, {
                teamId, userId, agentId, taskId,
              } as never)
            : [];
          // 同批排除（G4）：批内记忆（含自身）不作为 top-1 候选
          const top = candidates.find((c) => !batchIds.has(c.record_id));
          // I-1：最低相似度门槛（S1 配置化 memory.links.minSimilarity，缺省 0.3，与
          // dedup 路径同裁决）——score 低于门槛（可为负，clamp 后为 0）的 similar
          // 关系是假关系，宁缺毋滥不建边。
          const aboveThreshold = top && typeof top.score === "number" && top.score >= minSimilarity;
          if (top && aboveThreshold && (top as { certainty?: string }).certainty !== "inferred") {
            try {
              const strength = typeof top.score === "number" ? Math.min(Math.max(top.score, 0), 1) : 0.5;
              vectorStore?.addLink!(record.id, top.record_id, "similar", strength);
            } catch (err) {
              logger?.warn?.(`${TAG} top-1 similar edge failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    } catch (err) {
      logger?.warn?.(
        `${TAG} Write failed for memory "${memoryWithId.content.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return storedRecords;
}

// ============================
// Helpers
// ============================

const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction", "work_fact", "work_task", "work_method", "work_artifact"];

function normalizeType(raw: string): MemoryType | null {
  const lower = raw.toLowerCase().trim();
  if (VALID_TYPES.includes(lower as MemoryType)) {
    return lower as MemoryType;
  }
  // Handle legacy type names
  if (lower === "episode") return "episodic";
  if (lower === "instruct") return "instruction";
  if (lower === "preference") return "persona"; // fold preference into persona
  return null;
}
