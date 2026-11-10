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
import { describeLlmFailure } from "../../utils/task-failure.js";
import { LINK_TYPES } from "../store/types.js";

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

/**
 * P1 Task 7（worthiness importance）：重要度确定性门（镜像 normalizeRecurrence 先例）。
 * LLM 只提议、门裁决（T7 审稿 I-1 修订：宁缺毋滥，不伪造评分）：
 * 有限数字且落在 [1,10] → round 取整（TINYINT 整数口径）；
 * 越界（<1 或 >10，含 0/99/10.4）/NaN/Infinity/字符串/对象/缺省 → undefined
 * ——垃圾分不 clamp 成伪评分（clamp 会在 penalty 开启时把 LLM 幻觉 0 分变成真降权）；
 * 字段缺席 = 现状 = 不罚。
 */
export function normalizeImportance(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  if (raw < 1 || raw > 10) return undefined;
  return Math.round(raw);
}

/** 关闭态的空事实集（共享常量，避免每条 memory 分配）。 */
const NO_FACTS: NormalizedFacts = { phrases: [], triples: [] };

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
import { annotateAgentNarration, reconcileAgentNarrationMetadata } from "./agent-narration.js";
import { nameCandidatesFromContent, sanitizePersonHints } from "./person-hints.js";
import { clampMaxFacts, normalizeFacts, type NormalizedFacts } from "./fact-key.js";
import { batchDedup, MIN_SIMILAR_STRENGTH, loadValueCandidates, parseCoreRefs } from "./l1-dedup.js";
import { writeMemory, generateMemoryId } from "./l1-writer.js";
import type { ExtractedMemory, MemoryRecord, MemoryType, DedupDecision } from "./l1-writer.js";
import { factRowsEnabled, supersessionEligibleForContent, type WritePolicy } from "./write-policy.js";

import { sanitizeJsonForParse, salvageTruncatedJsonArray, shouldExtractL1 } from "../../utils/sanitize.js";
import type { IMemoryStore, IsolationFilter } from "../store/types.js";
import { extractionExtensionsEnabled, rollupStateFromRecords } from "../hooks/soul-state-machine.js";
import { applyPromiseEvidence, collectPromiseEvidenceFromExtraction, promiseEvidenceGateEnabled } from "../hooks/soul-promise-evidence.js";
import type { L1SearchResult } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import { report } from "../report/reporter.js";
import { metricProducer } from "../report/metric-producer.js";
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
    /** P1-T7：重要度 1-10（gated memory.worthiness.extractionEnabled；确定性门 normalizeImportance）。 */
    importance?: number;
  }>;
}

/**
 * #122：0 条提取的原因标签——**闭集**，禁止自由文本。
 * 上游按 label 聚合（7 处日志口径对齐）；新增值必须同时更新本联合与
 * `ParseExtractionOutcome` 的消费方，避免日志里出现无法聚合的临时措辞。
 *
 * - llm_error：LLM 调用本身失败（端点错误/超时），拿不到响应
 * - no_json：响应里既没有数组、也不是别的合法 JSON
 * - parse_fail：抠到了数组片段，但无法解析且无可抢救前缀
 * - not_array：响应是合法 JSON，但顶层不是数组（场景对象 / 标量 / 字符串都归这一类）
 * - empty_scenes：没有产出任何场景——顶层是空数组，或数组里每一项都不是对象
 *
 * 记忆级丢弃（场景壳还在、记忆被 parse 内容/类型门或 flatten 的 normalizeType 门全丢）
 * 归到 `normalized_all_dropped`（见 `L1EmptyReportedReason`）。
 */
export type L1EmptyReason = "llm_error" | "no_json" | "parse_fail" | "not_array" | "empty_scenes";

/** #122：上报用原因 = parse 闭集 + 归一化阶段的全丢弃兜底。 */
export type L1EmptyReportedReason = L1EmptyReason | "normalized_all_dropped";

/** #122：parse 结果——scenes 为空时必须带原因，供最终 0 条路径单行上报。 */
export interface ParseExtractionOutcome {
  scenes: SceneSegment[];
  /** scenes 非空时为 undefined（正常路径不产生噪音字段）。 */
  emptyReason?: L1EmptyReason;
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
  /**
   * D-6（2026-10-31）：失败原因原文（仅 success=false 时填），供上游把
   * 「提取失败」判成非成功任务并按错误类别决定重试/死信。
   */
  error?: string;
  /**
   * D-7（2026-11-01）：LLM 端点的结构化失败信息（HTTP 状态码 / 供应商业务码）。
   *
   * 为什么单独带字段而不只靠 error 文本：生产 402 的文案里只有供应商中文（"当前已达到
   * Token Plan 用量上限…"），没有 `status=402`，下游按文本分类必然落 unknown（可重试）。
   * 这两个字段由适配器挂在错误对象上，本层原样透传，直到 executeL1 组成
   * L1ExtractionFailedError 时再参与分类。
   */
  failureStatus?: number;
  failureProviderCode?: string;
}

// ============================
// Core function
// ============================

/**
 * Run the full L1 extraction pipeline on conversation messages.
 *
 * @param messages - Filtered conversation messages (from L0 or directly from hook)
 * @param sessionKey - The session key
 * @param baseDir - Base data directory
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
  /** host-neutral MemoryTdaiConfig（parsed）——selfIdentity / 敏感性 / 周期事实的权威读取源。 */
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
    /** #134 写面策略（W1 事实键 / W2 写时 supersession；缺省全关=逐位现状）。 */
    writePolicy?: WritePolicy;
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
    /**
     * 毒批超时（L1-OUTAGE-20261015 定罪修复，config-first）：单次提取 LLM 调用超时 ms。
     * 缺省 300_000 = 逐位现状。生产实锤思考型端点 20K prompt 恒超 300s → 大批毒批死循环，
     * 可上调配合 pipeline-factory 毒批自适应拆分使用。
     */
    extractionTimeoutMs?: number;
    /**
     * #79 dedup 判重超时（config-first）：cfg.extraction.dedupTimeoutMs 透传至
     * batchDedup 的 LLM 判重调用。缺省 300_000 = 逐位现状。
     */
    dedupTimeoutMs?: number;
    /** Override embedding timeout for capture-path calls (milliseconds) */
    embeddingTimeoutMs?: number;
    /**
     * Host-neutral LLM runner. When provided, used instead of creating
     * the host-injected runner (required, see `requireLlmRunner`).
     */
    llmRunner?: LLMRunner;
    /**
     * 逐调用思考开关（config-first，对齐 L2/scene R4 模式：cfg.persona.reasoningEffort）。
     * 缺省 undefined = 请求不带 reasoning_effort（端点默认）。
     * 2026-10-14 拍板：硬编码 "none"（v21）被当前生产端点（glm-5.3-flash MaaS）拒绝
     * ——请求体 reasoning_effort 直接 400 "rejected by an internal MaaS component"，
     * L1 全败 → cursor 不推进 → 只有 L0（当日根因）。改配置化后端点默认即 200。
     */
    reasoningEffort?: string;
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
  const { messages, sessionKey, sessionId, taskId, teamId, userId, agentId, baseDir, memoryConfig, logger, instanceId: metricInstanceId, storage } = params;
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
  /** #122：parse 阶段给出的 0 条原因（scenes 非空时 undefined）。 */
  let emptyReason: L1EmptyReason | undefined;
  let llmRaw: { systemPrompt: string; userPrompt: string; rawOutput: string } | undefined;
  try {
    const out = await callLlmExtraction({
      newMessages,
      backgroundMessages,
      previousSceneName: options.previousSceneName,
      memoryConfig,
      logger,
      model: options.model,
      promptMode: options.promptMode,
      memoryPrompt: options.memoryPrompt,
      reasoningEffort: options.reasoningEffort,
      extractionTimeoutMs: options.extractionTimeoutMs,
      traceContext: { teamId, userId, agentId, sessionId },
      llmRunner: options.llmRunner,
      vectorStore: options.vectorStore,
    });
    scenes = out.scenes;
    emptyReason = out.emptyReason;
    llmRaw = { systemPrompt: out.systemPrompt, userPrompt: out.userPrompt, rawOutput: out.rawOutput };
    logger?.debug?.(`${TAG} LLM detected ${scenes.length} scene(s)`);
  } catch (err) {
    const failure = describeLlmFailure(err);
    const errMessage = failure.message;
    logger?.error(
      `${TAG} LLM extraction failed: ${errMessage}`
        + ` (status=${failure.statusCode ?? "?"}, providerCode=${failure.providerCode ?? "?"})`,
    );
    // #122：LLM 调用本身失败也是「0 条」的一种——给同一个单行出口，reason=llm_error
    logL1Empty(logger, { reason: "llm_error", sessionKey, scenes: 0, inputMsgs: messages.length });
    // D-6：带上原始错误；D-7：另带结构化状态码/供应商码（文本里常常没有），上游据此区分
    // 「配额耗尽（不可重试）」与「偶发超时（可重试）」，不再把失败一律当成功。
    return {
      success: false,
      extractedCount: 0,
      storedCount: 0,
      records: [],
      sceneNames: [],
      error: errMessage,
      failureStatus: failure.statusCode,
      failureProviderCode: failure.providerCode,
    };
  }

  // L1-OUTAGE-20261015（断流定罪基建）：任务内建 watchdog，每 60s 上报当前阶段。
  // 2026-10-15 事故：旧进程 extraction 在 dedup 降级存储段悬挂 43min 全程静默，
  // 静态排查无法定罪具体 await——此后任何一处悬挂都能在日志中直接定位到阶段。
  // 覆盖范围 = LLM 成功后的全流程（LLM 调用本身有 300s 超时 + ENTRY/RAW_OUTPUT 日志夹逼）。
  // unref：watchdog 不得反撑事件循环（进程退出/测试 teardown 不被 interval 拖住）。
  let l1Stage = "parse";
  const l1Watchdog = setInterval(() => {
    logger?.warn?.(`${TAG} task watchdog: stage=${l1Stage} elapsed=${Date.now() - l1StartMs}ms`);
  }, 60_000);
  l1Watchdog.unref?.();
  const setL1Stage = (s: string) => { l1Stage = s; };
  const stopL1Watchdog = () => clearInterval(l1Watchdog);

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
      // A3-2（2026-11-02）：agent 自述标注（gated extraction.actorTagging，缺省关闭=不改 metadata）
      allExtracted.push(
        annotateAgentNarration({
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
        // ADR-0025 C2：source 列已删，提取侧不再传（信息由 source_message_ids 承担）。
        valence: mem.valence,
        arousal: mem.arousal,
        significance: mem.significance,
        // D-3 确定性枚举门：仅白名单放行，非法/缺失 → none（LLM 只提议，代码裁决）
        sensitivity: normalizeSensitivity((mem as { sensitivity?: string }).sensitivity),
        // P1-T7 确定性门：round(clamp 1..10)；非法/缺省 → undefined（不伪造默认分）
        importance: normalizeImportance((mem as { importance?: unknown }).importance),
        }, memoryConfig),
      );
    }
  }

  logger?.debug?.(`${TAG} Total extracted memories: ${allExtracted.length} across ${scenes.length} scene(s)`);

  // task-9（2026-11-04，来源证据主键）：幻觉 id 剔除。
  // prompt 合同只许引用本批新消息（background 仅作上下文）；越界 id 会让同源覆盖判定
  // 认到不存在/别人的消息，故在归一阶段与当批 id 求交（日志只记计数，不泄露 id 正文）。
  {
    const allowedMessageIds = new Set(
      newMessages.map((message) => message.id).filter((id) => typeof id === "string" && id !== ""),
    );
    if (allowedMessageIds.size > 0) {
      let droppedIds = 0;
      let affected = 0;
      for (const memory of allExtracted) {
        const declared = Array.isArray(memory.source_message_ids) ? memory.source_message_ids : [];
        if (declared.length === 0) continue;
        const kept = declared.filter((id) => typeof id === "string" && allowedMessageIds.has(id));
        if (kept.length === declared.length) continue;
        droppedIds += declared.length - kept.length;
        affected++;
        memory.source_message_ids = kept;
      }
      if (droppedIds > 0) {
        logger?.warn?.(
          `${TAG} source_message_ids: dropped ${droppedIds} hallucinated id(s) not in current batch across ${affected} memory(ies) (batch ids=${allowedMessageIds.size})`,
        );
      }
    }
  }

  setL1Stage("enrich");

  // 后置字段补全：模型有时不吐灵魂字段——用一次 LLM 从 content 抽字段回填（best-effort，绝不阻塞）
  try {
    await enrichSoulFields(allExtracted, {
      logger,
      model: options.model,
      llmRunner: options.llmRunner,
      reasoningEffort: options.reasoningEffort,
      traceContext: { teamId, userId, agentId, sessionId },
    });
  } catch (err) {
    logger?.warn?.(`${TAG} enrichSoulFields failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  setL1Stage("post-extract");

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
    stopL1Watchdog();
    // #122：LLM 之后 0 条的**唯一**单行出口。LLM 调用前置的空输入/质量门全过滤不在此口径
    // （仍是 debug 日志，不产生 parse 原因）。parse 已给出原因就用它；否则 = 场景壳还在、
    // 记忆被归一化阶段全丢弃（parse 内容/类型门、flatten 的 normalizeType 门）→ 闭集兜底。
    logL1Empty(logger, {
      reason: emptyReason ?? "normalized_all_dropped",
      sessionKey,
      scenes: scenes.length,
      inputMsgs: messages.length,
    });
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
  // §17 人名线索校验要能拿到原文：source_message_ids → 消息文本与角色。
  // 角色是必需的：说话人名字必须出现在**用户自己说的话**里，只出现在 assistant
  // 侧的名字（例如 AI 自己的名字）不是说话人的名字。
  const sourceMessagesById = new Map(
    newMessages.map((m) => [String(m.id), { content: String(m.content ?? ""), role: String(m.role ?? "") }]),
  );

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
      setL1Stage("dedup");
      const dedupStartMs = Date.now();
      // B4（2026-11-02）：dedup 前置门槛（gated extraction.dedupPrefilter，缺省关闭=逐位现状）
      const dedupPrefilterCfg = (memoryConfig as {
        extraction?: { dedupPrefilter?: { enabled?: boolean; minCos?: number } };
      } | undefined)?.extraction?.dedupPrefilter;
      const dedupStats = { llmCalls: 0, prefiltered: 0 };
      const decisions = await batchDedup({
        memories: memoriesWithIds,
        logger,
        model: options.model,
        promptMode: options.promptMode,
        vectorStore: options.vectorStore,
        embeddingService: options.embeddingService,
        conflictRecallTopK: options.conflictRecallTopK,
        durativeEnabled: options.durativeEnabled,
        embeddingTimeoutMs: options.embeddingTimeoutMs,
        // #79：dedup 判重超时（config-first），缺省 300_000=逐位现状
        dedupTimeoutMs: options.dedupTimeoutMs,
        llmRunner: options.llmRunner,
        // 思考开关 config-first（2026-10-14）：dedup 主调同 L1 提取，端点默认即可
        reasoningEffort: options.reasoningEffort,
        // S1：similar 建边门槛配置化（memory.links.minSimilarity），缺省 0.3
        minSimilarity: options.minSimilarity,
        traceContext: { teamId, userId, agentId, sessionId },
        // 记忆图/dedup 候选召回：**不带 sessionId** —— L1 关联是 agent 维度语义
        // （与 v2 atomic/search 的 L1 召回同一原则）。带 sessionId 会让每个新会话
        // 看不到其它会话的记忆 → dedup 永远 store 且零候选 → 记忆零关联（生产实锤根因）。
        // 租户隔离仍由 teamId/userId/agentId/taskId 守住（never crosses tenants 语义不变）。
        ...((teamId || userId || agentId || taskId) ? { filter: { teamId, userId, agentId, taskId } } : {}),
        // B4：门槛配置 + 每批 LLM 调用计数（关闭时不打日志，保持现状）
        dedupPrefilter: dedupPrefilterCfg,
        stats: dedupStats,
      });
      dedupLatencyMs = Date.now() - dedupStartMs;
      if (dedupPrefilterCfg?.enabled === true) {
        logger?.info?.(
          `${TAG} dedup prefilter: prefiltered=${dedupStats.prefiltered} llmCalls=${dedupStats.llmCalls} of ${memoriesWithIds.length}`,
        );
      }

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

      // task-9（2026-11-04，来源证据主键）：同源完全覆盖 → store 决策改 update。
      // 放在 dedup 指标块之后：l1_dedup_* 分布口径逐位不变（只改写入决策，不改统计口径）。
      await upgradeFullyCoveredStores({
        memories: memoriesWithIds,
        decisions,
        vectorStore: options.vectorStore,
        // 与 dedup 候选召回同口径：**不带 sessionId**（L1 关联是 agent 维度语义）
        filter: (teamId || userId || agentId || taskId) ? { teamId, userId, agentId, taskId } : undefined,
        logger,
      });

      setL1Stage("store");
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
        writePolicy: options.writePolicy,
        memoryConfig,
        // §17：人名线索校验要拿原文，把「消息 id → 文本」一并交给写侧门
        sourceMessagesById,
      });

    } catch (err) {
      logger?.warn?.(`${TAG} Batch dedup failed, storing all as new: ${err instanceof Error ? err.message : String(err)}`);
      setL1Stage("store-fallback");
      storedRecords = await storeAllDirectly(memoriesWithIds, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, options.vectorStore, options.embeddingService, storage, options.enableMemoryLinks !== false, options.minSimilarity, options.writePolicy);
    }
  } else {
    setL1Stage("store-fallback");
    storedRecords = await storeAllDirectly(memoriesWithIds, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, options.vectorStore, options.embeddingService, storage, options.enableMemoryLinks !== false, options.minSimilarity, options.writePolicy);
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
  setL1Stage("provenance");
  logger?.info?.(`${TAG} writing generation provenance (layer=l1, records=${storedRecords.length})`);
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

    // ── #28（R5 统一抽取扩展门）：state rollup——门 on 时用落库记录 soul 列（连续值观测）
    // 滚约会话 state 并落库 soul_state（F18 三元组隔离）；门 off=零读零写=逐位现状。
    // 观测旁路：store 缺实现/失败 warn 不阻塞（抽取主路径零影响）。
    if (extractionExtensionsEnabled(memoryConfig)) {
      try {
        const vs = options.vectorStore as IMemoryStore | undefined;
        if (vs?.readSoulState && vs.writeSoulState) {
          const next = rollupStateFromRecords(
            (await vs.readSoulState({ teamId, userId, agentId })) ?? null,
            storedRecords,
          );
          if (next) {
            await vs.writeSoulState({ teamId, userId, agentId }, {
              valence: next.valence,
              arousal: next.arousal,
              topValue: next.topValue ?? null,
              turnSeq: next.turnSeq ?? null,
              updatedAt: next.at ?? new Date().toISOString(),
            });
          }
        }
      } catch (err) {
        logger?.warn?.(`${TAG} soul state rollup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── #41（ADR0003-P3 实施票 C，D8 证据门）：promise 确定性证据迁移——user 确认话语
    // 白名单（soul-promise-evidence 单一源，锚定全句+承诺指称，宁缺毋滥）→ refKey 严格
    // 相等的 open promise 迁移（store 侧复判状态机，source=evidence 全链溯源，陈旧证据
    // 守卫防毒批重放）。门 off=零 promise 读零 promise 写=逐位现状；store 缺实现/失败
    // warn 不阻塞（镜像 #28 观测旁路惯例）。
    // 门路径单一源=promiseEvidenceGateEnabled（审查 C1 回归锁）：唯一生产调用点
    // pipeline-factory.ts:619 传 memoryConfig=cfg（MemoryTdaiConfig 扁平接口，soulRender
    // 在 coreMemory 子树），直下钻 soulRender 恒 undefined=死开关——路径契约由
    // config.soulrender-promise-evidence.test.ts 门路径 describe 用 parseConfig 产物钉死。
    if (promiseEvidenceGateEnabled(memoryConfig)) {
      try {
        const items = collectPromiseEvidenceFromExtraction(messages, taskId || undefined);
        if (items.length > 0) {
          const applied = await applyPromiseEvidence(
            items,
            options.vectorStore as IMemoryStore | undefined,
            { teamId, userId, agentId },
          );
          if (applied.applied > 0) {
            logger?.info?.(`${TAG} promise evidence transitions applied=${applied.applied}`);
          }
        }
      } catch (err) {
        logger?.warn?.(`${TAG} promise evidence transition failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  logger?.info(`${TAG} Extraction complete: extracted=${extracted.length}, stored=${storedRecords.length}`);
  setL1Stage("metrics");

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

  stopL1Watchdog();
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
  memoryConfig?: unknown;
  logger?: Logger;
  model?: string;
  promptMode?: MemoryPromptMode;
  memoryPrompt?: ResolvedMemoryPrompt;
  /** Host-injected LLM runner — required, see `requireLlmRunner`. */
  llmRunner?: LLMRunner;
  /** A8：锚候选加载的 store 上下文（价值锚来源已退场，候选恒空，此字段仅为签名兼容保留）。 */
  vectorStore?: IMemoryStore;
  /** 思考开关 config-first（2026-10-14）：undefined = 不带 reasoning_effort（端点默认）。 */
  reasoningEffort?: string;
  /** 毒批超时（L1-OUTAGE-20261015，config-first）：undefined = 300_000（逐位现状）。 */
  extractionTimeoutMs?: number;
  /** langfuse 上报身份四元组（team/user/agent/session）。 */
  traceContext?: TraceContext;
}): Promise<{ scenes: SceneSegment[]; emptyReason?: L1EmptyReason; systemPrompt: string; userPrompt: string; rawOutput: string }> {
  const { newMessages, backgroundMessages, previousSceneName, memoryConfig, logger, model, promptMode = "chat", memoryPrompt, llmRunner, traceContext, vectorStore, reasoningEffort, extractionTimeoutMs } = params;

  // DS-SOUL-MEMORY-002 P1：agent 行为事实视角（gated）。composeMemorySystemPrompt 的
  // 自定义 memoryPrompt 策略优先级不变——自定义时内置 base 被其覆盖，agentAct 块随之
  // 不生效（自定义策略=用户权威，不篡改）。读取源是 host-neutral MemoryTdaiConfig。
  const selfIdentityEnabled =
    (memoryConfig as { coreMemory?: { selfIdentity?: { enabled?: boolean } } } | undefined)
      ?.coreMemory?.selfIdentity?.enabled === true;
  // D-3（2026-09-21）：敏感性标注（gated，缺省关闭=逐位现状）
  const sensitivityEnabled =
    (memoryConfig as { sensitivity?: { extractionEnabled?: boolean } } | undefined)
      ?.sensitivity?.extractionEnabled === true;
  // D-4（2026-09-22 拍板）：周期性事实提取块（gated，缺省关闭=逐位现状）
  const recurrenceEnabled =
    (memoryConfig as { extraction?: { recurrenceEnabled?: boolean } } | undefined)
      ?.extraction?.recurrenceEnabled === true;
  // P1-T7：重要度标注块（gated memory.worthiness.extractionEnabled，缺省关闭=逐位现状）
  const importanceEnabled =
    (memoryConfig as { worthiness?: { extractionEnabled?: boolean } } | undefined)
      ?.worthiness?.extractionEnabled === true;
  // #137（W1 双通道）：多事实输出块（gated memory.extraction.facts.enabled，缺省关闭=逐位现状）
  const factsCfg = (memoryConfig as {
    extraction?: { facts?: { enabled?: boolean; maxFacts?: number; includeTriples?: boolean } };
  } | undefined)?.extraction?.facts;
  const factsEnabled = factsCfg?.enabled === true;
  const factsMaxFacts = clampMaxFacts(factsCfg?.maxFacts);
  const factsIncludeTriples = factsCfg?.includeTriples === true;
  // A3-1（2026-11-02）：原子性拆分红线 + 改写形态（gated，缺省 300/false = 逐位现状）
  const atomicityCfg = (memoryConfig as {
    extraction?: { atomicMaxChars?: number; atomicityRewrite?: boolean };
  } | undefined)?.extraction;
  const systemPrompt = composeMemorySystemPrompt(
    getExtractMemoriesSystemPrompt(promptMode, {
      selfIdentityEnabled,
      sensitivityEnabled,
      recurrenceEnabled,
      importanceEnabled,
      factsEnabled,
      factsMaxFacts,
      factsIncludeTriples,
      // 非法/缺失值由 prompt 侧 resolveAtomicMaxChars 归一到 clamp 区间
      atomicMaxChars: atomicityCfg?.atomicMaxChars,
      atomicityRewrite: atomicityCfg?.atomicityRewrite === true,
    }),
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
    `${TAG} [l1-debug] ENTRY taskId=l1-extraction, promptMode=${promptMode}, newMsgs=${newMessages.length}, bgMsgs=${backgroundMessages.length}, userPromptLen=${userPrompt.length}, sysPromptLen=${systemPrompt.length}, model=${model ?? "(default)"}, previousSceneName=${previousSceneName ? JSON.stringify(previousSceneName) : "(none)"}, runnerKind=${llmRunner ? "llmRunner" : "(none)"}`,
  );

  let result: string;

  // langfuse trace 语义：让此次 L1 抽取在 UI 有稳定 name / 顶级 user/session 列
  // / 可筛选 tags。避免所有记忆抽取都显示为 Unnamed trace。
  const traceParams = buildTraceParams("memory.l1-extract", traceContext);

  // P0-1（2026-10-06）输出预算防线=提示词预算声明（≤20条/≤5情境，l1-extraction.ts 硬规则）
  // + parse 截断抢救（salvageTruncatedJsonArray）。此处不再覆写 maxTokens（回归 runner 缺省
  // config.maxTokens ?? 4096）：曾试 8192，生产首小时出现 2 起 finishReason=length@8192
  // 空响应 + 180s 超时面抬升（重启前 32h 零起 empty-response），按负增益回退铁律撤回。

  if (llmRunner) {
    // Use the host-neutral LLMRunner interface
    result = await llmRunner.run({
      prompt: userPrompt,
      systemPrompt,
      taskId: "l1-extraction",
      // 毒批超时（L1-OUTAGE-20261015，config-first）：缺省 300_000=逐位现状；
      // 思考型端点 20K prompt 恒超 300s（生产实测），配合 pipeline-factory 毒批
      // 自适应拆分可上调本键。
      timeoutMs: extractionTimeoutMs ?? 300_000,
      // 思考开关 config-first（2026-10-14）：原 v21 硬编码 "none" 被当前生产端点
      // （glm-5.3-flash MaaS）拒绝——reasoning_effort 参数直接 400，L1 全败导致
      // "只有 L0"（当日根因）。改为 reasoningEffort 透传（cfg.persona.
      // reasoningEffort 接线，yaml 不配 = 不传 = 端点默认 = 200；不支持该参数的
      // 端点由 llm-runner 400 剥参降级兜底）。OpenClaw 兜底路径（下方
      // CleanContextRunner）不透传该参数，保持端点默认。
      reasoningEffort,
      ...traceParams,
    });
  } else {
    // OpenClaw embedded-runner fallback removed in the DSH-only build: the
    // host-neutral LLMRunner is the single LLM seam (src/core/llm-runner-guard.ts).
    throw new Error("LLMRunner is required but was not injected (OpenClaw fallback removed)");
  }

  // [l1-debug] RAW OUTPUT — 定位模型到底吐了哪些字段（用于 R4 实证）
  logger?.debug?.(`${TAG} [l1-debug] RAW_OUTPUT:\n${result}`);

  const parsedOutcome = parseExtractionResult(result, logger, valueCandidates, {
    promptMode,
    // #137：parse 侧同一道门（关闭时完全忽略 LLM 输出的 facts）
    facts: { enabled: factsEnabled, maxFacts: factsMaxFacts, includeTriples: factsIncludeTriples },
  });
  // #122：emptyReason 透传到 extractL1Memories 的 0 条出口（此处不单独上报）
  return { scenes: parsedOutcome.scenes, emptyReason: parsedOutcome.emptyReason, systemPrompt, userPrompt, rawOutput: result };
}

// P0-3（2026-10-06）：范围钳制 helper——LLM 越界值不再原样落库（此前 priority:150 / valence:-5 直通）
const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
// P0-3：chat 模式跨类型门——work_* 是 code 提示词专属枚举，chat 下属枚举门外泄（生产实锤 1.3% 污染）
const WORK_ONLY_TYPES = new Set(["work_fact", "work_task", "work_method", "work_artifact"]);

/**
 * #122：内联思考块。思考型端点把推理写进 think 标签里，推理中出现方括号（"看 [索引]"）
 * 会让下面的贪婪数组锚 /\[[\s\S]*\]/ 从错误位置起锚 → JSON 片段被污染 → 提取恒 0 条。
 * 只认 think：<thinking> 是另一个标签，不碰。
 * 非贪婪 + 必须配闭合标签：截断的 think（无闭合）不剥离——宁可让数组锚多看几个字符，
 * 也不能把标签之后的正文一起吞掉。代价：截断 think 自身带 `[` 时贪婪锚仍可能失手，
 * 但那条路径不再是静默 0 条，而是可观测的 parse_fail（见回归用例）。
 */
const INLINE_THINK_RE = /<think(?:\s[^>]*)?>[\s\S]*?<\/think\s*>/gi;

/** #122：剥离内联 think（可能多段）；无闭合标签的截断 think 原样保留。 */
export function stripInlineThink(raw: string): string {
  return raw.replace(INLINE_THINK_RE, "");
}

/**
 * #122：0 条唯一的单行可观测出口。闭集 reason + 现场数字（scenes/inputMsgs），
 * 一行即可聚合、可直接 grep，不再靠翻 RAW_OUTPUT 猜「为什么 0 条」。
 */
function logL1Empty(
  logger: Logger | undefined,
  /** scenes = 场景数（日志字段名对齐上游口径 scenes=，不是记忆数）。 */
  params: { reason: L1EmptyReportedReason; sessionKey: string; scenes: number; inputMsgs: number },
): void {
  logger?.warn?.(
    `${TAG} l1-empty reason=${params.reason} sessionKey=${params.sessionKey} scenes=${params.scenes} inputMsgs=${params.inputMsgs}`,
  );
}

/**
 * #122：响应是合法 JSON 但顶层不是数组（典型：只吐了一个场景对象）——报 not_array
 * 比一律报 no_json 更能定位模型到底错在哪一层。
 */
function isNonArrayJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  try {
    return !Array.isArray(JSON.parse(sanitizeJsonForParse(trimmed)) as unknown);
  } catch {
    return false;
  }
}

/**
 * P1-B W1（2026-11-10）：候选序列解析——把「一次性贪婪锚 /\[[\s\S]*\]/」拆成候选集。
 *
 * 实测两类 parse_fail 都源于贪心锚把多段/断尾文本拼成一个不可解析片段：
 *  - rawLen=19 的双 fenced 空数组（"[]\n\n```json\n[]\n\n```"）：锚从首个 '[' 跨到末个 ']'，中间夹围栏文本；
 *  - rawLen=3943 的截断尾：锚把字符串里的 ']' 当数组结尾，截取错位后整批丢。
 * 候选生成两步（顺序即优先级）：
 *  1) 围栏段优先：```lang ... ``` 的内容各自成候选（模型爱在围栏里放真 JSON）；
 *  2) 每段做括号平衡扫描（跳过字符串字面量）取顶层数组；顶层数组未闭合（截断）时
 *     把该段尾巴整体作为候选，交给 salvageTruncatedJsonArray 抢救。
 */
export function makeJsonCandidates(stripped: string): string[] {
  const fenceRe = /```[^\n`]*\n?([\s\S]*?)```/g;
  const segments: string[] = [];
  for (const m of stripped.matchAll(fenceRe)) {
    const inner = m[1];
    if (inner && inner.trim() !== "") segments.push(inner);
  }
  // 围栏剥掉后的正文：旧行为（正文里直接给数组、无围栏）不能丢
  const unfolded = stripped.replace(fenceRe, "\n");
  if (unfolded.trim() !== "") segments.push(unfolded);

  const candidates: string[] = [];
  for (const segment of segments) {
    for (const candidate of scanTopLevelArrays(segment)) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

/** 括号平衡扫描：只认 '[' / ']'（'{}' 不参与深度），字符串字面量内的括号不计数。 */
function scanTopLevelArrays(segment: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "[") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (c === "]") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(segment.slice(start, i + 1));
          start = -1;
        }
      }
      continue;
    }
  }
  // 断尾：顶层数组没闭合，把尾巴整段交给 salvage
  if (depth > 0 && start >= 0) out.push(segment.slice(start));
  return out;
}

export interface JsonCandidateParse {
  parsed: unknown[];
  /** 真正 parse 成功的文本（修复/抢救后可能与候选原文不同） */
  source: string;
  /** 是否经 salvageTruncatedJsonArray 抢救 */
  salvaged: boolean;
}

/**
 * 逐个候选走 sanitize → JSON.parse → repairExtractionJson → salvage：返回第一个解析成功
 * 且满足 accept（缺省=非空数组，即"有场景"）的候选；都满足不了时退化返回第一个解析成功的
 * 数组（→ empty_scenes，`[1,2]`/`[]` 这类真 0 条不再冒报 parse_fail）；
 * 一个都解析不了返回 null（调用方报 parse_fail，与旧口径一致）。
 */
export function tryParseCandidates(
  candidates: string[],
  accept: (parsed: unknown[]) => boolean = (parsed) => parsed.length > 0,
): JsonCandidateParse | null {
  let fallback: JsonCandidateParse | null = null;
  for (const candidate of candidates) {
    const parsed = parseJsonCandidate(candidate);
    if (!parsed) continue;
    if (accept(parsed.parsed)) return parsed;
    if (!fallback) fallback = parsed;
  }
  return fallback;
}

function parseJsonCandidate(candidate: string): JsonCandidateParse | null {
  const sanitized = sanitizeJsonForParse(candidate);
  const direct = tryParseJsonArray(sanitized);
  if (direct) return { parsed: direct, source: sanitized, salvaged: false };

  const repaired = repairExtractionJson(sanitized);
  if (repaired !== sanitized) {
    const fixed = tryParseJsonArray(repaired);
    if (fixed) return { parsed: fixed, source: repaired, salvaged: false };
  }

  // P0-1 截断抢救：整段不可解析（常见于字符串含 ']' 或断尾）→ 前缀抢救
  const salvaged = salvageTruncatedJsonArray(candidate);
  if (salvaged) {
    const fromSalvage = tryParseJsonArray(sanitizeJsonForParse(salvaged));
    if (fromSalvage) return { parsed: fromSalvage, source: salvaged, salvaged: true };
  }
  return null;
}

function tryParseJsonArray(text: string): unknown[] | null {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parse the LLM's JSON response into SceneSegment array.
 * Expected format: [{scene_name, message_ids, memories: [...]}]
 * #122：返回 `{scenes, emptyReason?}`——0 条时必须说明是哪一类 0 条。
 */
export function parseExtractionResult(
  raw: string,
  logger?: Logger,
  valueCandidates: Array<{ id: string; label: string }> = [],
  opts?: {
    promptMode?: MemoryPromptMode;
    /**
     * #137（W1 双通道）：多事实落库门。缺省/关闭 = 完全忽略 LLM 输出的 facts
     * （即使模型意外输出也不落 metadata）；开启 = normalizeFacts 归一化后落
     * metadata.facts（string[]），includeTriples 且三元组非空时另落 metadata.factTriples。
     */
    facts?: { enabled: boolean; maxFacts: number; includeTriples: boolean };
  },
): ParseExtractionOutcome {
  try {
    // Strip markdown code block wrappers if present
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // #122：先剥离内联 think 再做数组锚——think 里的方括号会把贪婪锚带偏（生产实锤 0 条）。
    // raw 保持原样：NO_JSON/PARSE_FAIL dump 与 llmRaw.rawOutput 要留给排查口径。
    const stripped = stripInlineThink(cleaned);

    // P1-B W1（2026-11-10）：候选序列解析取代单次贪婪锚——先按围栏切段、再逐段取顶层数组，
    // 断尾段仍交截断抢救（P0-1）；候选逐个试，取第一个解析成功且非空的。
    const candidates = makeJsonCandidates(stripped);
    if (candidates.length === 0) {
      // #122：区分「压根没有 JSON」与「有 JSON 但不是数组」——后者此前一律误报 no_json
      const reason: L1EmptyReason = isNonArrayJson(stripped) ? "not_array" : "no_json";
      logger?.warn?.(
        `${TAG} No JSON array found in extraction response${reason === "not_array" ? " (top-level JSON is not an array)" : ""}`,
      );
      // [l1-debug] NO_JSON — dump the full raw so we can see what the LLM actually said
      const rawPreview = raw.slice(0, 2048);
      logger?.warn?.(
        `${TAG} [l1-debug] NO_JSON taskId=l1-extraction, rawLen=${raw.length}, cleanedLen=${cleaned.length}, strippedLen=${stripped.length}, rawFull=${JSON.stringify(rawPreview)}${raw.length > 2048 ? `…(+${raw.length - 2048})` : ""}`,
      );
      return { scenes: [], emptyReason: reason };
    }
    // "scenes 非空" = 数组里至少一个对象项（场景只能由对象物化）；纯标量数组不算命中。
    const picked = tryParseCandidates(candidates, (parsed) =>
      parsed.some((item) => item !== null && typeof item === "object"),
    );
    if (!picked) {
      // 候选全不可解析（含无从抢救的断尾）→ 与旧实现同口径报 parse_fail
      logger?.warn?.(`${TAG} Failed to parse extraction result: all ${candidates.length} JSON candidate(s) unparseable`);
      const rawPreview = raw.slice(0, 2048);
      logger?.warn?.(
        `${TAG} [l1-debug] PARSE_FAIL rawLen=${raw.length}, rawFull=${JSON.stringify(rawPreview)}${raw.length > 2048 ? `…(+${raw.length - 2048})` : ""}`,
      );
      return { scenes: [], emptyReason: "parse_fail" };
    }
    if (picked.salvaged) {
      logger?.warn?.(`${TAG} Truncated extraction output salvaged: ${picked.source.length} chars recovered from prefix`);
    }
    const parsed = picked.parsed;

    const scenes: SceneSegment[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const s = item as Record<string, unknown>;

      scenes.push({
        scene_name: typeof s.scene_name === "string" ? s.scene_name : "未知情境",
        message_ids: Array.isArray(s.message_ids) ? s.message_ids.map(String) : [],
        memories: Array.isArray(s.memories)
          ? (s.memories as Array<Record<string, unknown>>)
              .filter((m) => {
                if (!m || typeof m !== "object" || typeof m.content !== "string" || (m.content as string).length === 0) return false;
                // P0-3 chat 跨类型门：提示词枚举门（chat 仅 persona/episodic/instruction）的代码侧双保险
                if (opts?.promptMode === "chat" && WORK_ONLY_TYPES.has(normalizeType(String(m.type)) ?? "")) {
                  logger?.warn?.(`${TAG} chat 模式拒绝 work_* 类型（枚举门外泄）: ${String(m.type)}`);
                  return false;
                }
                return true;
              })
              .map((m) => {
                // P1-T7 确定性门（防御第二层：提示词未开启时 LLM 意外输出同样被钳制/丢弃）
                const importance = normalizeImportance(m.importance);
                // #137 确定性门（同一防御第二层纪律）：关闭时完全忽略 m.facts；开启时由
                // normalizeFacts 归一化（折叠空白/去重/去噪/封顶 maxFacts），脏形状安静丢弃不抛。
                const factsOpts = opts?.facts;
                const factsGate = factsOpts?.enabled === true;
                const facts = factsGate ? normalizeFacts(m.facts, { maxFacts: clampMaxFacts(factsOpts?.maxFacts) }) : NO_FACTS;
                return {
                content: String(m.content),
                type: String(m.type ?? "episodic"),
                // P0-3：priority 钳制到 [-1,100]（-1 仅 instruction 死命令），非数字缺省 50
                priority: typeof m.priority === "number" ? clampNum(m.priority, -1, 100) : 50,
                source_message_ids: Array.isArray(m.source_message_ids) ? m.source_message_ids.map(String) : [],
                metadata: (() => {
                  const rawBase = (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>;
                  // #137：开启时 facts/factTriples 由提取门独占——先摘掉 LLM 可能塞进 metadata 的
                  // 原始值，只落归一化结果（避免脏值绕过确定性门）。关闭时不改既有透传行为。
                  let base = rawBase;
                  if (factsGate) {
                    base = { ...rawBase };
                    delete base.facts;
                    delete base.factTriples;
                  }
                  const refs = parseCoreRefs(m.coreRefs, valueCandidates);
                  const out: Record<string, unknown> = refs && refs.length > 0 ? { ...base, coreRefs: refs } : { ...base };
                  // P1-T7：来源标记（仅在分数合法解析时写入——不伪造评分）
                  // ADR-0025 C5（2026-11-04）：importance_reason 零判定读点（纯审计），停写；
                  // importance_source 保留（区分 manual/llm，是 /atomic/update 唯一防篡改痕迹）。
                  if (importance !== undefined) {
                    out.importance_source = "llm";
                  }
                  // #137 落位：非空短语 → metadata.facts；includeTriples 且非空三元组 → metadata.factTriples
                  // （空集不写键 = 现状形状；写侧 write-policy 读这两个键建事实通道键）。
                  if (facts.phrases.length > 0) out.facts = facts.phrases;
                  if (factsGate && factsOpts?.includeTriples === true && facts.triples.length > 0) {
                    out.factTriples = facts.triples;
                  }
                  return out;
                })(),
                // 灵魂记忆字段（可选，防御解析）：时空 / 观察推断 / 情感
                // P0-2/P2：空串 occurred_at 归 undefined（此前原样保留 → 下游 falsy 判 missing 口径分裂）
                occurred_at: typeof m.occurred_at === "string" && m.occurred_at !== "" ? m.occurred_at : undefined,
                durative: m.durative === true,
                valid_start: typeof m.valid_start === "string" ? m.valid_start : undefined,
                valid_end: typeof m.valid_end === "string" ? m.valid_end : undefined,
                certainty: m.certainty === "inferred" ? "inferred" : "observed",
                // A8：coreRefs 原样透传（parseCoreRefs 过滤在调用方——候选清单在其作用域）
                // ADR-0025 C2：source 列已删，不再透传。
                // P0-3：情感/重要度三值钳制到合法区间（此前 typeof number 即原样放行）
                valence: typeof m.valence === "number" ? clampNum(m.valence, -1, 1) : undefined,
                arousal: typeof m.arousal === "number" ? clampNum(m.arousal, 0, 1) : undefined,
                significance: typeof m.significance === "number" ? clampNum(m.significance, 0, 1) : undefined,
                // D-3：敏感性透传（枚举门在主映射处统一裁决——此处只带原始值）
                sensitivity: typeof m.sensitivity === "string" ? m.sensitivity : undefined,
                // P1-T7：重要度（round(clamp 1..10)；非法 → undefined=字段缺席=现状）
                importance,
                };
              })
          : [],
      });
    }

    if (scenes.length === 0) {
      // 不只是空数组：`[1,2]` / `[null]` 这类每项都不是对象的数组也落到这里（没有场景被物化）。
      return { scenes, emptyReason: "empty_scenes" };
    }
    return { scenes };
  } catch (err) {
    logger?.warn?.(`${TAG} Failed to parse extraction result: ${err instanceof Error ? err.message : String(err)}`);
    const rawPreview = raw.slice(0, 2048);
    logger?.warn?.(
      `${TAG} [l1-debug] PARSE_FAIL rawLen=${raw.length}, rawFull=${JSON.stringify(rawPreview)}${raw.length > 2048 ? `…(+${raw.length - 2048})` : ""}`,
    );
    return { scenes: [], emptyReason: "parse_fail" };
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

// R2（2026-10-06）：salvageTruncatedJsonArray 迁至 utils/sanitize.ts 单一实现
//（dedup 判定链同需，P-A 禁第二份手写）——此处改为 import 复用，行为逐位不变。

// ============================
// Write helpers
// ============================

// R3 收口句（M5，2026-10-06）：对齐 R1 FINAL_FORMAT_SENTENCE / R2 CONFLICT_FINAL_FORMAT_SENTENCE
// 的单源常量纪律，垫在 system prompt 末尾收口输出格式，杜绝解释文本/markdown 围栏包裹。
const ENRICH_FINAL_FORMAT_SENTENCE =
  "只输出一个JSON数组，不含任何解释、markdown代码围栏或其他文本；" +
  "每项恰好6个键：{index, occurred_at, certainty, valence, arousal, significance}。";

const ENRICH_SYSTEM =
  "你是记忆字段补全器。逐行从记忆内容提取5个字段并输出补全结果。\n" +
  // M1：index 数字契约 + 编号不连续说明——缺字段行才进 prompt，编号天然不连续；
  // 字符串键会绕过消费侧 Map.get(数字) 造成整行静默丢（M2 归一为双保险）。
  "输入每行形如「编号. 内容」，编号可能不连续（只送仍缺字段的行）；" +
  "每项必须原样带回该行的数字编号 index（number 类型，不是字符串）。\n" +
  "字段规则：\n" +
  // S4：ISO 示例 + 防幻觉（无明确时间必须空串，不编造）
  "1) occurred_at：ISO8601 字符串，如 2026-10-05T14:30:00；内容无明确时间给空串 \"\"，不要编造时间。\n" +
  // S3：certainty 两句判定（客观陈述/亲见→observed；推断估计可能→inferred）
  "2) certainty：内容明确陈述为客观发生/亲见的事实给 observed；含推断、估计、可能给 inferred。\n" +
  // M4：中性缺省与 l1-writer.ts:322-324 合标层逐字对齐（valence=0/arousal=0/significance=0.5），
  // LLM 给出的中性值与 writer 兜底值相同 → 终值零漂移（最小行为变更）。
  "3) valence：情感 -1..1；中性、无情感色彩给 0。\n" +
  "4) arousal：强度 0..1；平静、常规叙述给 0。\n" +
  "5) significance：重要 0..1；内容无明显重要性给 0.5。\n" +
  "所有数值必须落在各自范围内，越界无效。\n" +
  ENRICH_FINAL_FORMAT_SENTENCE;

function buildEnrichPrompt(memories: Array<{ m: ExtractedMemory; i: number }>): string {
  return memories.map(({ m, i }) => `${i}. ${m.content}`).join("\n\n");
}

/**
 * 后置字段补全：对 content 已含时间/情感、但结构化字段因模型省略而缺失的记忆，
 * 用一次 LLM 调用从 content 抽 occurred_at/certainty/valence/arousal/significance 回填。
 * best-effort：任何失败保持原样，不阻塞写入。
 * 2026-10-06 R3 实施轮加固：规则回填后重过滤（全填行零 LLM）+ 关深度思考（reasoningEffort none）
 * + index 数字归一 + 数值 clamp + occurred_at ISO 门（对齐 R1 clampNum 口径，宁缺勿错）。
 */
export async function enrichSoulFields(
  memories: ExtractedMemory[],
  deps: { memoryConfig?: unknown; logger?: Logger; model?: string; llmRunner?: LLMRunner; reasoningEffort?: string; traceContext?: TraceContext },
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

  // ①.5 重过滤（S1，2026-10-06）：规则回填后字段全齐的行不再送 LLM——消费侧只填空字段，
  //     全填行的 LLM 产值必然被整体丢弃，白跑一次调用。按原序重判，只送仍缺字段的行。
  const stillMissing = missing.filter(
    ({ m }) => !m.occurred_at || !m.certainty || m.valence == null || m.arousal == null || m.significance == null,
  );
  if (stillMissing.length === 0) return;

  const prompt = buildEnrichPrompt(stillMissing);
  let result: string;
  try {
    if (deps.llmRunner) {
      result = await deps.llmRunner.run({
        prompt, systemPrompt: ENRICH_SYSTEM, taskId: "l1-enrich", timeoutMs: 30_000,
        // 思考开关 config-first（2026-10-14）：原 R3 硬编码 "none" 随 R1/R2 一并被当前
        // 生产端点拒绝（reasoning_effort → 400），改 deps.reasoningEffort 透传
        // （yaml 不配 = 不传 = 端点默认）。OpenClaw 兜底路径不透传，保持端点默认。
        reasoningEffort: deps.reasoningEffort,
        ...(deps.traceContext ?? {}),
      });
    } else {
      // OpenClaw embedded-runner fallback removed in the DSH-only build (see src/core/llm-runner-guard.ts).
      throw new Error("LLMRunner is required but was not injected (OpenClaw fallback removed)");
    }
  } catch (err) {
    deps.logger?.warn?.(`${TAG} enrich LLM call failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let filled: Array<{ index?: number | string; occurred_at?: string; certainty?: string; valence?: number; arousal?: number; significance?: number }> = [];
  try { filled = JSON.parse(result); } catch {
    const m = result.match(/\[[\s\S]*\]/);
    if (m) { try { filled = JSON.parse(m[0]); } catch { filled = []; } }
  }
  if (!Array.isArray(filled)) filled = [];
  // M2（2026-10-06）：index 数字归一——模型常回字符串键（"0"），直接进 Map 会让 get(数字)
  // 永远 miss、整行静默丢；Number() 归一 + 非有限键跳过（防 NaN 污染）。prompt 侧 M1 数字
  // 契约为第一道，此处为代码裁决的第二道防线。
  const byIndex = new Map<number, (typeof filled)[number]>();
  for (const f of filled) {
    const k = Number(f.index);
    if (Number.isFinite(k)) byIndex.set(k, f);
  }
  for (const { m, i } of stillMissing) {
    const f = byIndex.get(i);
    if (!f) continue;
    // M3：occurred_at 走 ISO 门——非空且 Date.parse 可解析才回填，宁缺勿错（防"昨天下午"
    // 之类非结构化文本入库）；回填空缺由 l1-writer.ts:319 合标层兜底为提取时刻。
    if (!m.occurred_at && typeof f.occurred_at === "string") {
      const t = f.occurred_at.trim();
      if (t && !Number.isNaN(Date.parse(t))) m.occurred_at = t;
    }
    if (!m.certainty && f.certainty) m.certainty = String(f.certainty) === "inferred" ? "inferred" : "observed";
    // M3：三数值入库前 clamp（复用模块级 clampNum，对齐 R1 消费侧口径）。
    if (m.valence == null && typeof f.valence === "number") m.valence = clampNum(f.valence, -1, 1);
    if (m.arousal == null && typeof f.arousal === "number") m.arousal = clampNum(f.arousal, 0, 1);
    if (m.significance == null && typeof f.significance === "number") m.significance = clampNum(f.significance, 0, 1);
  }
}

/**
 * task-9（2026-11-04，来源证据主键）：同源完全覆盖 → 决策 store 改 update。
 *
 * 动机：source_message_ids 此前只写不读（生产当日新增 106 行中 94 行有值、零决策读取）。
 * 语义：既有行来源集合 ⊇ 新记忆来源集合 = 同一批原话的再提取（不是新事实）——以 update
 * 取代该行（旧行归档/失效、新行接手来源并集），而不是并排复制一行。
 * 边界：只改 action==="store"（LLM 已判 update/merge/skip 不动）；新记忆来源为空不反查
 * （空集被任何集合覆盖，会误吞一切）；多条覆盖取来源集最大者；方法缺失/失败 fail-open。
 */
async function upgradeFullyCoveredStores(params: {
  memories: Array<{ record_id: string; source_message_ids?: string[] }>;
  decisions: DedupDecision[];
  vectorStore?: IMemoryStore;
  filter?: IsolationFilter;
  logger?: Logger;
}): Promise<number> {
  const { memories, decisions, vectorStore, filter, logger } = params;
  const find = vectorStore?.findL1BySourceMessageIds;
  if (typeof find !== "function" || decisions.length === 0) return 0;
  const memoryById = new Map(memories.map((memory) => [memory.record_id, memory]));
  let upgraded = 0;
  for (const decision of decisions) {
    if (decision.action !== "store") continue;
    const declared = memoryById.get(decision.record_id)?.source_message_ids;
    const ids = Array.isArray(declared) ? declared.filter((id) => typeof id === "string" && id !== "") : [];
    if (ids.length === 0) continue;
    try {
      const hits = (await find.call(vectorStore, ids, filter)) ?? [];
      const wanted = new Set(ids);
      let best: { record_id: string; size: number } | null = null;
      for (const hit of hits) {
        if (!hit || hit.record_id === decision.record_id) continue;
        const existing = new Set(Array.isArray(hit.source_message_ids) ? hit.source_message_ids : []);
        if (existing.size === 0) continue;
        let covers = true;
        for (const id of wanted) {
          if (!existing.has(id)) {
            covers = false;
            break;
          }
        }
        if (!covers) continue;
        if (!best || existing.size > best.size) best = { record_id: hit.record_id, size: existing.size };
      }
      if (best) {
        decision.action = "update";
        decision.target_ids = [best.record_id];
        upgraded++;
      }
    } catch (err) {
      logger?.warn?.(
        `${TAG} source-coverage lookup failed (non-fatal, keeping store): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (upgraded > 0) {
    logger?.info?.(
      `${TAG} source-coverage: ${upgraded}/${decisions.length} store decision(s) upgraded to update (same-source supersede)`,
    );
  }
  return upgraded;
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
  /** #134 写面策略（W1/W2；缺省全关）。 */
  writePolicy?: WritePolicy;
  /** 抽取配置（A4：actorTagging 门 —— 复判标签时只看这一位）。 */
  memoryConfig?: unknown;
  /** §17：`source_message_ids` → 原文与角色，用于逐字核对人名线索。 */
  sourceMessagesById?: Map<string, { content: string; role: string }>;
}): Promise<MemoryRecord[]> {
  const {
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
    vectorStore,
    embeddingService,
    storage,
    enableMemoryLinks = true,
    writePolicy,
    memoryConfig,
    sourceMessagesById,
  } = params;
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
      // A4（2026-11-03）：标签必须按**最终落库文本**复判——dedup 的 merge/update 会用
      // merged_content 改写 content（l1-writer：`finalContent = merged_content ?? content`），
      // 而 annotate 是在合并前打的。不复判就会出现「落库文本已变、标签停在旧文本」的
      // 双向错标（自述→非自述仍带标签＝读侧误杀；非自述→自述漏标＝读侧漏过）。
      const finalContent =
        decision.action === "merge" || decision.action === "update"
          ? (decision.merged_content ?? memoryToWrite.content)
          : memoryToWrite.content;
      const reconciledMetadata = reconcileAgentNarrationMetadata(
        finalContent,
        memoryToWrite.metadata as Record<string, unknown> | undefined,
        memoryConfig,
      );
      // 未变化时沿用原对象（零额外分配）；变化才浅拷贝（metadata 是唯一被改的键）。
      let memoryToPersist: typeof memoryToWrite = memoryToWrite;
      if (reconciledMetadata !== memoryToWrite.metadata) {
        memoryToPersist = {
          ...memoryToWrite,
          metadata: reconciledMetadata,
        } as typeof memoryToWrite;
      }
      // §17 人名线索确定性门：模型给的 speaker_name / mentioned 必须被这条记忆的原文证实
      // （逐字出现在 source_message_ids 对应的消息里），证不实的一个都不留——人名会写进
      // 档案、注入到对方面前，猜错的代价比缺名更大。
      //
      // 两处口径与引文校验一致：① **不用 content 当证据**——那是模型自己改写的，
      // 拿它证明自己给的名字等于自证（「用户名叫何晨」这种句子就是模型写的）；
      // 原话全缺时才退回 content，那是降级路径，不是默认路径。
      // ② 模型不肯给键时不放弃：从 content 的「自述句式」抽候选，仍旧要过原话门。
      {
        const rawMeta = (memoryToPersist.metadata ?? {}) as Record<string, unknown>;
        const sourceIds = Array.isArray(memoryToPersist.source_message_ids) ? memoryToPersist.source_message_ids : [];
        const sourceMsgs = sourceIds
          .map((sid) => sourceMessagesById?.get(String(sid)))
          .filter((m): m is { content: string; role: string } => m !== undefined && m.content !== "");
        const originalText = sourceMsgs.map((m) => m.content).join("\n");
        // 说话人名字的证据面只取 user 侧原话：只出现在 assistant 侧的名字
        // （典型是 AI 自己的名字）不是「跟我说话的人」的名字。
        const userSideText = sourceMsgs
          .filter((m) => m.role.toLowerCase() === "user")
          .map((m) => m.content)
          .join("\n");
        const sourceText = originalText !== "" ? originalText : String(memoryToPersist.content ?? "");
        const modelSpeaker = typeof rawMeta.speaker_name === "string" ? rawMeta.speaker_name.trim() : "";
        const candidates = modelSpeaker === "" ? nameCandidatesFromContent(String(memoryToPersist.content ?? "")) : [];
        const hasModelHint = "speaker_name" in rawMeta || "mentioned" in rawMeta;
        if (hasModelHint || candidates.length > 0) {
          const input: Record<string, unknown> = { ...rawMeta };
          if (modelSpeaker === "" && candidates.length > 0) input.speaker_name = candidates[0];
          const hints = sanitizePersonHints(input, sourceText, { speakerSourceText: userSideText });
          const nextMeta = { ...rawMeta };
          delete nextMeta.speaker_name;
          delete nextMeta.mentioned;
          if (hints.speakerName) nextMeta.speaker_name = hints.speakerName;
          if (hints.mentioned && hints.mentioned.length > 0) nextMeta.mentioned = hints.mentioned;
          if (hints.dropped > 0) {
            logger?.warn?.(
              `${TAG} [person-hints] 丢弃 ${hints.dropped} 个无法被原文证实的人名（record=${memoryWithId.record_id}）`,
            );
          }
          memoryToPersist = { ...memoryToPersist, metadata: nextMeta } as typeof memoryToWrite;
        }
      }
      const record = await writeMemory({
        memory: memoryToPersist as never,
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
        writePolicy,
      });

      if (record) {
        storedRecords.push(record);
        // 记忆图（G）：按 dedup 决策建边。时序关键（**整行路径**）：writeMemory 内部已把
        // update/merge 的旧 target 归档（archiveL1 会级联清 target 的旧边），此处再建新边——
        // 因此新边不会被误删；真删边只发生在归档/删除记忆的路径上。
        // ⚠ 事实行模式（#146 factRows）下前提不成立：写面跳过 update/merge 的整行失效与归档
        // （见 l1-writer 事实行分支），旧边**不会**被级联清理，evolve 链会逐轮累积。
        // 且边源恒为 record.id = 第 1 条事实行的 id（factRowIdOf 父 id 归 row 0），
        // 过期的是第 N>1 条时边仍挂在未失效的 row 0 上——属边归属错配，不是失效错配。
        // 读侧兜底有效（效期过滤在池装配末尾 + 最终硬过滤），故列为 ADR-0015 遗留项。
        // 证据可回溯：邻居解析侧用 getL1ByIdsWithArchive（审计 B3）。
        if (enableMemoryLinks && vectorStore && decision.target_ids.length > 0) {
          try {
            // G 设计§3/§5 红线：evolve（演进边）只允许 observed 层记忆自动建（推断不冒充因果）
            // 边型字面量单一源：store/types.ts 的 LINK_TYPES（D 项受控词表）。
            const observedOnly = (record as { certainty?: string }).certainty !== "inferred";
            if (decision.action === "update" && observedOnly) {
              for (const t of decision.target_ids) vectorStore.addLink?.(record.id, t, LINK_TYPES.EVOLVE, 1);
            } else if (decision.action === "merge") {
              for (const t of decision.target_ids) vectorStore.addLink?.(record.id, t, LINK_TYPES.SIMILAR, 1);
            } else if (decision.action === "conflict") {
              // P4：冲突边（矛盾双方都保留），无 observed 限制——冲突是关系事实
              for (const t of decision.target_ids) vectorStore.addLink?.(record.id, t, LINK_TYPES.CONFLICT, 1);
              // GROW-EVO P2（§2.2 方向性守卫）：仅新记忆 observed 才自动失效旧记忆；
              // inferred → 只记 conflict 边（推断不许冒充事实——红线对称应用）。
              // 失效 = 写 valid_end（失效不删除）；best-effort 不阻塞写入。
              // #136 属性契约：多值/模态内容的"冲突"多半是同一属性的两个并存值（考虑 A vs 考虑 B），
              // 不是真矛盾——不失效旧行（conflict 边仍建，读侧软失效决定排序）。
              // #146 事实行粒度：factRows 开启时整行失效一律跳过——旧行里同实体的其它事实
              // （兄弟事实）会随 valid_end 一起退出检索面，正是本票要消除的爆炸半径；
              // 单条事实的失效由写侧 invalidateL1ByFactKey 按 fact_key 精确定位（冲突边照建）。
              const factRowsActive = factRowsEnabled(writePolicy);
              const observed = (record as { certainty?: string }).certainty === "observed";
              const eligible = supersessionEligibleForContent(record.content, writePolicy);
              if (factRowsActive) {
                if (observed) {
                  logger?.debug?.(
                    `${TAG} [W3-fact-rows] fact-level granularity — whole-row invalidation skipped (${decision.target_ids.length} target(s) kept; per-fact handled by fact_key)`,
                  );
                }
              } else if (eligible && observed) {
                const invalidEnd = record.occurred_at || new Date().toISOString();
                for (const t of decision.target_ids) vectorStore.invalidateL1?.(t, invalidEnd);
              } else if (!eligible) {
                logger?.debug?.(
                  `${TAG} [W2-cardinality] multi-valued conflict — keeping ${decision.target_ids.length} target(s) valid (no invalidation)`,
                );
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
            vectorStore.addLink(record.id, decision.top_candidate.record_id, LINK_TYPES.SIMILAR, decision.top_candidate.score);
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
  /** #134 写面策略（W1/W2；缺省全关=逐位现状）。 */
  writePolicy?: WritePolicy,
): Promise<MemoryRecord[]> {
  const storedRecords: MemoryRecord[] = [];
  // G4（T9-B）：同批排除——批内新记忆不互当"最相关旧记忆"（对照 dedup 路径的
  // newRecordIds 过滤）。原实现只排自身（c.record_id !== record.id），先写入的
  // 同批记忆会被后写入者当成 top-1 旧记忆，把真旧记忆挤出 top-3。
  const batchIds = new Set(memoriesWithIds.map((m) => m.record_id));
  // L1-OUTAGE-20261015：dedup 降级存储路径 breadcrumb——事故悬挂点即本函数某条
  // memory 的 writeMemory 内；逐条 INFO 夹逼把悬挂定罪到具体 memory。
  logger?.info?.(`${TAG} storeAllDirectly: storing ${memoriesWithIds.length} memories directly (dedup bypassed)`);

  for (const [memIdx, memoryWithId] of memoriesWithIds.entries()) {
    try {
      logger?.info?.(`${TAG} storeAllDirectly: memory ${memIdx + 1}/${memoriesWithIds.length} writeMemory start id=${memoryWithId.record_id}`);
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
        writePolicy,
      });
      logger?.info?.(`${TAG} storeAllDirectly: memory ${memIdx + 1}/${memoriesWithIds.length} writeMemory done id=${memoryWithId.record_id}`);
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
              vectorStore?.addLink!(record.id, top.record_id, LINK_TYPES.SIMILAR, strength);
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
