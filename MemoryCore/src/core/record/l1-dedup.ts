/**
 * L1 Memory Conflict Detection (Batch Mode): decides how to handle multiple new
 * memories against existing records in a single LLM call.
 *
 * v4: Removed JSONL-based Jaccard fallback. Candidate recall now relies exclusively
 *     on vector search (primary) and FTS5 BM25 (degraded). If neither is available,
 *     conflict detection is skipped entirely — all memories go straight to store.
 *
 * Two-phase approach:
 * 1. Candidate search per new memory — vector recall or FTS5 keyword recall (fast, no LLM)
 * 2. Batch LLM judgment on all new memories + their candidate pools (single call)
 */

import type { MemoryPromptMode } from "../../config.js";
import type { ExtractedMemory, MemoryRecord, DedupDecision, MemoryType } from "./l1-writer.js";
import { formatBatchConflictPrompt, getConflictDetectionSystemPrompt, type CoreValueCandidate } from "../prompts/l1-dedup.js";
import type { CandidateMatch } from "../prompts/l1-dedup.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { sanitizeJsonForParse } from "../../utils/sanitize.js";
import type { IMemoryStore, IsolationFilter, CoreTenant } from "../store/types.js";
import { normalizeCoreTenant } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";

const TAG = "[memory-tdai][l1-dedup]";

// ── T15-A（向量健康）进程级 warn-once 标记（R3：部分降级也要可见，但不刷屏）──
/** 覆盖率分级 warn（vecRows/metaRows < 0.9）：每进程只发一次。 */
let vectorCoverageWarned = false;
/** 旧后端回退 warn（无 countL1VectorRows 走 countL1）：每进程只发一次。 */
let legacyCountWarned = false;

function warnVectorCoverageOnce(logger: Logger | undefined, vecRows: number, metaRows: number): void {
  if (vectorCoverageWarned) return;
  vectorCoverageWarned = true;
  logger?.warn?.(`${TAG} vector coverage low (${vecRows}/${metaRows}) — dedup 候选可能不全`);
}

function warnLegacyCountFallbackOnce(logger: Logger | undefined): void {
  if (legacyCountWarned) return;
  legacyCountWarned = true;
  logger?.warn?.(
    `${TAG} store 无 countL1VectorRows，回退 countL1() 判据 — 元数据行在向量写入静默失败时仍增长，` +
    `可能误判向量可用（G1：104 vec / 203 records）`,
  );
}

/**
 * similar 边最低相似度门槛（审查 I-1 修补）。
 * score = 1 - cosine distance，可为负；低于此值（含 clamp 后为 0）的 "similar"
 * 关系是假关系，污染记忆图与邻居扩展——宁缺毋滥，不建边。
 * 与 memory.recall.scoreThreshold 默认 0.3 对齐。
 * S1（T9 裁决待办收口）：常量保留为 DEFAULT——memory.links.minSimilarity 配置化后，
 * batchDedup/attachTopCandidates 经参数消费配置值，缺省回落此常量（行为逐位不变）。
 */
export const MIN_SIMILAR_STRENGTH = 0.3;

// ============================
// Core function (batch mode)
// ============================

/**
 * Batch conflict detection: compare all new memories against existing records
 * in a single LLM call.
 *
 * Candidate recall strategy (3-tier degradation):
 * 1. Vector recall (vectorStore + embeddingService) — cosine similarity (best)
 * 2. FTS5 keyword recall (vectorStore with FTS available) — BM25 ranking (degraded)
 * 3. Skip conflict detection entirely — all memories go straight to "store"
 *
 * The old JSONL-based Jaccard fallback has been removed. If neither vector search
 * nor FTS is available, we skip dedup rather than paying the O(N) full-file-scan cost.
 *
 * @param memories - Newly extracted memories (with record_id)
 * @param config - OpenClaw config (for LLM access)
 * @param logger - Optional logger
 * @param model - Optional model override
 * @param vectorStore - Optional vector store for cosine similarity search
 * @param embeddingService - Optional embedding service for computing query vectors
 * @param conflictRecallTopK - Top-K candidates to recall per new memory (default: 5)
 * @returns Array of dedup decisions, one per new memory
 */
export async function batchDedup(params: {
  memories: Array<ExtractedMemory & { record_id: string }>;
  config: unknown;
  logger?: Logger;
  model?: string;
  /** Prompt family for conflict detection (default: chat). */
  promptMode?: MemoryPromptMode;
  /** Vector store for cosine similarity candidate recall */
  vectorStore?: IMemoryStore;
  /** Embedding service for computing query vectors */
  embeddingService?: EmbeddingService;
  /** Top-K candidates per new memory (default: 5) */
  conflictRecallTopK?: number;
  /** Override embedding timeout for capture-path calls (milliseconds) */
  embeddingTimeoutMs?: number;
  /** Host-neutral LLM runner — when provided, used instead of CleanContextRunner. */
  llmRunner?: LLMRunner;
  /** Isolation filter applied to candidate recall so dedup never crosses tenants. */
  filter?: IsolationFilter;
  /** langfuse 上报身份四元组（team/user/agent/session），透传给 llmRunner。 */
  traceContext?: TraceContext;
  /** S1：similar 边最低相似度门槛（memory.links.minSimilarity），缺省 = MIN_SIMILAR_STRENGTH。 */
  minSimilarity?: number;
}): Promise<DedupDecision[]> {
  const { memories, config, logger, model, promptMode = "chat", vectorStore, embeddingService, llmRunner, filter, traceContext } = params;
  const topK = params.conflictRecallTopK ?? 5;
  const minSimilarity = params.minSimilarity ?? MIN_SIMILAR_STRENGTH;

  if (memories.length === 0) {
    return [];
  }

  const storeAll = () =>
    memories.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));

  // Determine what recall capabilities are available
  //
  // P-C 降级可见（T15-A）：向量可用性以"向量行数"为准（元数据行在向量写入静默失败时
  // 仍增长，旧判据 countL1 会误判可用 —— 09-09 生产实锤 104 vec / 203 records）。
  let hasVectorData = false;
  if (vectorStore) {
    if (typeof vectorStore.countL1VectorRows === "function") {
      const vecRows = await vectorStore.countL1VectorRows();
      hasVectorData = vecRows > 0;
      // 覆盖率分级：vecRows > 0 但 vecRows/metaRows < 0.9（部分死亡）→ 仍走 Tier1，
      // 但 warn 一次/进程（R3：部分降级也要可见——dedup 候选可能不全）。
      if (hasVectorData) {
        const metaRows = await vectorStore.countL1();
        if (metaRows > 0 && vecRows / metaRows < 0.9) {
          warnVectorCoverageOnce(logger, vecRows, metaRows);
        }
      }
    } else {
      hasVectorData = (await vectorStore.countL1()) > 0; // 旧后端回退，warn 一次
      warnLegacyCountFallbackOnce(logger);
    }
  }
  const hasFts = vectorStore?.isFtsAvailable() ?? false;

  // Fast path: no recall capability at all → skip dedup
  if (!hasVectorData && !hasFts) {
    logger?.debug?.(`${TAG} No vector data and no FTS available, skipping conflict detection for ${memories.length} memories`);
    return storeAll();
  }

  // Phase 1: Find candidates
  //
  // Decision tree (after the fast-path guard above, vectorStore is guaranteed non-null):
  //   hasVectorData + embeddingService → Tier 1 vector recall (FTS fallback on error)
  //   otherwise hasFts                → Tier 2 FTS keyword recall
  //   otherwise                       → skip dedup (defensive; shouldn't reach here)
  let matches: CandidateMatch[];

  if (hasVectorData && embeddingService) {
    // === Tier 1: Vector recall mode ===
    logger?.debug?.(`${TAG} Using vector recall mode (topK=${topK})`);
    matches = await findCandidatesByVector(memories, vectorStore!, embeddingService, topK, logger, params.embeddingTimeoutMs, filter);
  } else if (hasFts) {
    // === Tier 2: FTS keyword recall ===
    logger?.debug?.(`${TAG} Using FTS keyword recall mode (no embedding service or no vector data)`);
    matches = await findCandidatesByFts(memories, vectorStore!, logger, filter);
  } else {
    // Shouldn't reach here given the fast-path check above, but be defensive
    logger?.debug?.(`${TAG} No usable recall path, skipping conflict detection`);
    return storeAll();
  }

  // Check if any memory has candidates
  const hasAnyCandidates = matches.some((m) => m.candidates.length > 0);

  if (!hasAnyCandidates) {
    logger?.debug?.(`${TAG} No similar records found for any memory, all will be stored`);
    return storeAll();
  }

  // Phase 2: Batch LLM judgment（结果统一补 store 决策的 top-1 候选，供记忆图建边；
  // 仅向量召回携带真实 cosine，FTS-only 不附候选不建假强度边）
  // C1（灵魂记忆 spec §2.1）：dedup LLM 顺带标注 coreRefs——prompt 注入当前租户
  // 价值锚候选清单（store.listValues(tenant)，identity 从 traceContext 派生），
  // prompt 候选与解析过滤用同一份（防幻觉 id，P-D）。读取失败 → 空清单（LLM 回 []，
  // 宁缺毋滥降级，绝不阻塞写入）。
  const valueCandidates = await loadValueCandidates(vectorStore, traceContext, logger);
  const decisions = await runLlmJudgment(matches, memories, config, logger, model, promptMode, llmRunner, traceContext, valueCandidates);
  return attachTopCandidates(decisions, matches, minSimilarity);
}

/**
 * C1（spec §2.1）：读当前租户价值锚候选（id+label）。best-effort：store 无 listValues
 * / 读失败 → 空数组（LLM 收到空清单回 []，coreRefs 静默降级为不标注——R3 同款）。
 *
 * BACKFILL（甲路线）：存量回填脚本按记录自身三元组构造 traceContext 调用同源复用
 * （PA 起严格无兜底——无锚 agent 候选为空；P-A 单一实现，禁第二份手写）。
 */
export async function loadValueCandidates(
  vectorStore: IMemoryStore | undefined,
  traceContext: TraceContext | undefined,
  logger?: Logger,
): Promise<CoreValueCandidate[]> {
  try {
    const listValues = vectorStore?.listValues;
    if (typeof listValues !== "function") return [];
    // core 租户三元组（P2-T12 同形）：缺维度 → default 桶（不允许"缺省=跨租户读"）
    const tenant: CoreTenant = normalizeCoreTenant({
      teamId: traceContext?.teamId,
      userId: traceContext?.userId,
      agentId: traceContext?.agentId,
    });
    const rows = await listValues.call(vectorStore, tenant);
    return (rows ?? [])
      .filter((r) => r && typeof r.value_id === "string" && typeof r.label === "string" && r.label.trim())
      .map((r) => ({ id: r.value_id, label: r.label.trim() }));
  } catch (err) {
    logger?.warn?.(
      `${TAG} listValues failed, coreRefs candidates unavailable (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Phase 2: Run batch LLM judgment on candidate matches.
 */
async function runLlmJudgment(
  matches: CandidateMatch[],
  memories: Array<ExtractedMemory & { record_id: string }>,
  config: unknown,
  logger: Logger | undefined,
  model: string | undefined,
  promptMode: MemoryPromptMode,
  llmRunner?: LLMRunner,
  traceContext?: TraceContext,
  /** C1：价值锚候选（prompt 注入与解析过滤同源——防幻觉 id）。 */
  valueCandidates: CoreValueCandidate[] = [],
): Promise<DedupDecision[]> {
  logger?.debug?.(`${TAG} Running batch conflict detection for ${memories.length} memories (promptMode=${promptMode})`);

  try {
    const userPrompt = formatBatchConflictPrompt(matches, valueCandidates);
    const systemPrompt = getConflictDetectionSystemPrompt(promptMode);
    let result: string;

    // langfuse trace 语义：见 l1-extractor.ts 里的说明。dedup 是 L1 的子步骤，
    // 用独立 name 便于在 UI 上区分 "抽取阶段" vs "去重判定阶段"。
    const traceParams = buildTraceParams("memory.l1-dedup", traceContext);

    if (llmRunner) {
      // Use the host-neutral LLMRunner interface
      result = await llmRunner.run({
        prompt: userPrompt,
        systemPrompt,
        taskId: "l1-conflict-detection",
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
        taskId: "l1-conflict-detection",
        timeoutMs: 180_000,
        ...traceParams,
      });
    }

    const decisions = parseBatchResult(result, memories, logger, valueCandidates);
    return decisions;
  } catch (err) {
    logger?.warn?.(
      `${TAG} Batch conflict detection failed, defaulting all to store: ${err instanceof Error ? err.message : String(err)}`,
    );
    return memories.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));
  }
}

// ============================
// Candidate recall strategies
// ============================

/**
 * Vector-based candidate recall (aligned with prototype):
 * batch-embed new memories → cosine search in VectorStore → exclude self-batch → return candidates.
 */
async function findCandidatesByVector(
  memories: Array<ExtractedMemory & { record_id: string }>,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  topK: number,
  logger?: Logger,
  embeddingTimeoutMs?: number,
  filter?: IsolationFilter,
): Promise<CandidateMatch[]> {
  const newRecordIds = new Set(memories.map((m) => m.record_id));

  // Batch-compute embeddings for all new memories
  const texts = memories.map((m) => m.content);
  const embeddings = await embeddingService.embedBatch(texts, embeddingTimeoutMs ? { timeoutMs: embeddingTimeoutMs } : undefined);

  const matches: CandidateMatch[] = [];

  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const queryVec = embeddings[i];

    // Vector search top-K (request extra to account for self-batch filtering)
    const searchResults = filter
      ? await vectorStore.searchL1Vector(queryVec, topK + memories.length, mem.content, filter)
      : await vectorStore.searchL1Vector(queryVec, topK + memories.length, mem.content);

    // Exclude records from current batch, convert to MemoryRecord format
    const excluded = searchResults.filter((r) => !newRecordIds.has(r.record_id));
    // P-D（T9-A）：topScore = 排除本批后 top-1 的真实 cosine。searchL1Vector 返回
    // score = 1 - cosine distance（0..1，越大越近），与 no-dedup 路径（l1-extractor
    // storeAllDirectly top-1 边）完全同语义——不再丢弃，供 attachTopCandidates 透传建边。
    const topScore =
      excluded.length > 0 && typeof excluded[0].score === "number" ? excluded[0].score : undefined;
    const candidates: MemoryRecord[] = excluded
      .slice(0, topK)
      .map((r) => ({
        id: r.record_id,
        content: r.content,
        type: r.type as MemoryRecord["type"],
        priority: r.priority,
        scene_name: r.scene_name,
        source_message_ids: [],
        metadata: {},
        timestamps: [r.timestamp_str].filter(Boolean),
        createdAt: "",
        updatedAt: "",
        sessionKey: r.session_key,
        sessionId: r.session_id,
      }));

    matches.push(topScore === undefined ? { newMemory: mem, candidates } : { newMemory: mem, candidates, topScore });
  }

  logger?.debug?.(
    `${TAG} Vector recall: ${matches.map((m) => `${m.newMemory.record_id}→${m.candidates.length}`).join(", ")}`,
  );

  return matches;
}

/**
 * FTS5-based candidate recall:
 * Uses the FTS index for efficient BM25-ranked keyword matching.
 * This replaces the old Jaccard word-overlap fallback entirely.
 */
async function findCandidatesByFts(
  memories: Array<ExtractedMemory & { record_id: string }>,
  vectorStore: IMemoryStore,
  _logger?: Logger,
  filter?: IsolationFilter,
): Promise<CandidateMatch[]> {
  const newRecordIds = new Set(memories.map((m) => m.record_id));
  const matches: CandidateMatch[] = [];

  for (const mem of memories) {
    const ftsQuery = buildFtsQuery(mem.content);
    if (ftsQuery) {
      const ftsResults = filter
        ? await vectorStore.searchL1Fts(ftsQuery, 10, filter)
        : await vectorStore.searchL1Fts(ftsQuery, 10);
      // Filter out records from the current batch
      const candidates: MemoryRecord[] = ftsResults
        .filter((r) => !newRecordIds.has(r.record_id))
        .slice(0, 5)
        .map((r) => ({
          id: r.record_id,
          content: r.content,
          type: r.type as MemoryRecord["type"],
          priority: r.priority,
          scene_name: r.scene_name,
          source_message_ids: [],
          metadata: r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return {}; } })() : {},
          timestamps: [r.timestamp_str].filter(Boolean),
          createdAt: "",
          updatedAt: "",
          sessionKey: r.session_key,
          sessionId: r.session_id,
        }));
      matches.push({ newMemory: mem, candidates });
    } else {
      matches.push({ newMemory: mem, candidates: [] });
    }
  }

  _logger?.debug?.(`${TAG} FTS keyword recall: ${matches.map((m) => `${m.newMemory.record_id}→${m.candidates.length}`).join(", ")}`);
  return matches;
}

// ============================
// Result parsing
// ============================

const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction", "work_fact", "work_task", "work_method", "work_artifact"];

/**
 * C1（spec §2.1）：宽松解析 LLM 输出的 coreRefs 并**过滤不在候选清单的值**（防幻觉，
 * P-D）。接受 label 或 value_id（LLM 两者都可能回显），归一化为 label 去重；
 * 过滤后为空 → undefined（= 不标注，"无 coreRefs 的记忆不写该键"）。
 *
 * BACKFILL（甲路线）：存量回填脚本同源复用此解析（P-A 单一实现，禁第二份手写）。
 */
export function parseCoreRefs(raw: unknown, valueCandidates: CoreValueCandidate[]): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const labelSet = new Set(valueCandidates.map((v) => v.label));
  const idToLabel = new Map(valueCandidates.map((v) => [v.id, v.label]));
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const token = item.trim();
    if (!token) continue;
    const label = labelSet.has(token) ? token : idToLabel.get(token);
    if (label && !out.includes(label)) out.push(label);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the LLM's batch conflict detection JSON response.
 *
 * Expected format: [{record_id, action, target_ids, merged_content, merged_type, merged_priority, merged_timestamps, subject, coreRefs}]
 *
 * BACKFILL（甲路线）：存量回填脚本同源复用此解析（code-fence 剥离 / sanitize /
 * parseCoreRefs 幻觉过滤全链单源，P-A）。
 */
export function parseBatchResult(
  raw: string,
  memories: Array<ExtractedMemory & { record_id: string }>,
  logger?: Logger,
  /** C1：价值锚候选（与 prompt 注入同源）；缺省 = 不解析 coreRefs（全部丢弃，宁缺毋滥）。 */
  valueCandidates: CoreValueCandidate[] = [],
): DedupDecision[] {
  try {
    // Strip markdown code block wrappers
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Extract JSON array
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      logger?.warn?.(`${TAG} No JSON array found in conflict detection response`);
      return fallbackStoreAll(memories);
    }

    // Sanitize control characters inside JSON string literals that LLM may produce
    const sanitized = sanitizeJsonForParse(arrayMatch[0]);
    const parsed = JSON.parse(sanitized) as unknown[];

    if (!Array.isArray(parsed)) {
      logger?.warn?.(`${TAG} Conflict detection response is not an array`);
      return fallbackStoreAll(memories);
    }

    // Build decisions from LLM output
    const decisions: DedupDecision[] = [];
    const validActions = ["store", "update", "merge", "skip", "conflict"];

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;

      const recordId = String(d.record_id ?? "");
      // Skip entries with empty/missing record_id — they are LLM hallucinations
      if (!recordId) {
        logger?.debug?.(`${TAG} Skipping decision with empty record_id`);
        continue;
      }
      const action = String(d.action ?? "store");

      if (!validActions.includes(action)) {
        logger?.warn?.(`${TAG} Invalid action "${action}" for record ${recordId}, defaulting to store`);
      }

      decisions.push({
        record_id: recordId,
        action: validActions.includes(action) ? (action as DedupDecision["action"]) : "store",
        target_ids: Array.isArray(d.target_ids) ? d.target_ids.map(String) : [],
        merged_content: typeof d.merged_content === "string" ? d.merged_content : undefined,
        merged_type: VALID_TYPES.includes(d.merged_type as MemoryType) ? (d.merged_type as MemoryType) : undefined,
        merged_priority: typeof d.merged_priority === "number" ? d.merged_priority : undefined,
        merged_timestamps: Array.isArray(d.merged_timestamps) ? d.merged_timestamps.map(String) : undefined,
        // P3-T17（H1，拍板④）：dedup LLM 顺带抽取的语义主题词（归组键）。空串/非字符串 = 无。
        subject: typeof d.subject === "string" && d.subject.trim() ? d.subject.trim() : undefined,
        // C1（灵魂记忆 spec §2.1）：顺带标注的价值锚引用，候选清单过滤后attach；
        // 清单为空/LLM 未给/全幻觉 → undefined（不标注）。
        coreRefs: parseCoreRefs(d.coreRefs, valueCandidates),
      });
    }

    // Ensure all memories have a decision (fill missing with "store")
    const decidedIds = new Set(decisions.map((d) => d.record_id));
    for (const mem of memories) {
      if (!decidedIds.has(mem.record_id)) {
        logger?.debug?.(`${TAG} No decision for record ${mem.record_id}, defaulting to store`);
        decisions.push({
          record_id: mem.record_id,
          action: "store",
          target_ids: [],
        });
      }
    }

    return decisions;
  } catch (err) {
    logger?.warn?.(`${TAG} Failed to parse conflict detection result: ${err instanceof Error ? err.message : String(err)}`);
    return fallbackStoreAll(memories);
  }
}

/**
 * Fallback: store all memories when parsing fails.
 */
function fallbackStoreAll(memories: Array<ExtractedMemory & { record_id: string }>): DedupDecision[] {
  return memories.map((m) => ({
    record_id: m.record_id,
    action: "store" as const,
    target_ids: [],
  }));
}

/**
 * 记忆图（G 设计§3）：给 store 决策附上召回阶段的 top-1 相似候选。
 * LLM 判 store 只说明"无需合并/更新"，不代表"无关联"——记忆应连成网络而非孤点。
 * P-D 拒绝伪造真值（T9-A）：向量召回携带真实 cosine（CandidateMatch.topScore）→
 * clamp [0,1] 透传；FTS 的 bm25 rank 与 cosine 不可比 → 不附 top_candidate
 * （FTS-only 下 store 决策不建 similar 边——宁缺毋滥，有意的行为变更；
 * dedup 的 merge/update/conflict 边 strength=1 表"关系存在"，不受影响）。
 */
function attachTopCandidates(
  decisions: DedupDecision[],
  matches: CandidateMatch[],
  /** S1：门槛参数化（memory.links.minSimilarity），缺省 = MIN_SIMILAR_STRENGTH。 */
  minSimilarity: number = MIN_SIMILAR_STRENGTH,
): DedupDecision[] {
  const matchMap = new Map<string, CandidateMatch>();
  for (const m of matches) matchMap.set(m.newMemory.record_id, m);
  return decisions.map((d) => {
    if (d.action !== "store") return d;
    const m = matchMap.get(d.record_id);
    const top = m?.candidates[0];
    // P-D：无真 cosine（FTS-only）→ 不建假强度边
    if (!top?.id || typeof m?.topScore !== "number") return d;
    // I-1：门槛之下不建边——真 cosine < minSimilarity（S1 配置化，缺省 0.3）的 "similar"
    // 关系是假关系（语义无关），宁缺毋滥。
    if (m.topScore < minSimilarity) return d;
    return { ...d, top_candidate: { record_id: top.id, score: Math.min(Math.max(m.topScore, 0), 1) } };
  });
}
