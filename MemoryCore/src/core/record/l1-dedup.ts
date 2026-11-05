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
import { sanitizeJsonForParse, salvageTruncatedJsonArray } from "../../utils/sanitize.js";
import type { IMemoryStore, IsolationFilter, CoreTenant } from "../store/types.js";
import { normalizeCoreTenant } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";

const TAG = "[memory-tdai][l1-dedup]";

// ── T15-A（向量健康）进程级 warn-once 标记（R3：部分降级也要可见，但不刷屏）──
/** 覆盖率分级 warn（coveredRows/metaRows < 0.9，R2-2 条数口径）：每进程只发一次。 */
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
 * 与 recall.scoreThreshold 的**旧**缺省 0.3 同值（巧合，不是耦合）：§28（2026-11-05）起
 * recall.scoreThreshold 缺省 0 = rank-only，而本常量是**写侧建边**门槛（假关系不进记忆图），
 * 语义独立、读数独立，不随召回的 rank-only 翻转而变。
 * S1（T9 裁决待办收口）：常量保留为 DEFAULT——memory.links.minSimilarity 配置化后，
 * batchDedup/attachTopCandidates 经参数消费配置值，缺省回落此常量（行为逐位不变）。
 */
export const MIN_SIMILAR_STRENGTH = 0.3;

// ── B4（2026-11-02）：dedup 前置 embedding 门槛（config-first，缺省关闭 = 逐位现状）──
/**
 * F4（2026-11-02）实测校准：缺省 0.82（原值 0.9 与本域分布不符）。
 *
 * 只读复测（生产 vectors.db 3913 条 / 2048 维，topScore = 排除本批后 top-1 真实 cosine）：
 * - 应合并对 10 组：min 0.8587 / max 0.9918 —— 0.9 会把最弱真重复（0.8587）误拦，
 *   结果是把重复记忆重新入库（前置门槛的**唯一真实代价**）；
 * - 无关对 10 组：max 0.3630；
 * - 域内同模板换实体的硬负例 9 组：0.5670 ~ 0.8568。
 * 故 0.82 落在 0.363 ~ 0.8587 的干净空窗内（下沿余量 0.039、上沿余量 0.457），
 * 与 lifecycle.consolidation.attributeGrouping.minCos 缺省同值。
 *
 * 口径说明：前置门槛的"错拦"只影响本次是否问 LLM —— 判 store 是**非重复的正确结果**，
 * 所以宁可放行也不可拦掉真重复；0.86 以上开始丢真重复，故不取。
 */
export const DEFAULT_PREFILTER_MIN_COS = 0.82;

/** 非法 minCos（NaN/缺失/超界）→ 缺省 DEFAULT_PREFILTER_MIN_COS；其余 clamp 0..1（cos 取值域）。 */
export function resolvePrefilterMinCos(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PREFILTER_MIN_COS;
  return Math.min(Math.max(value, 0), 1);
}

/** batchDedup 的可读计数（调用方传入对象，原地写；返回值签名保持 DedupDecision[] 不变）。 */
export interface DedupStats {
  /** 本批实际发起的判重 LLM 调用次数（门槛拦空 → 0）。 */
  llmCalls: number;
  /** 被前置门槛拦下、未进 LLM 的记忆条数。 */
  prefiltered: number;
}

/** dedup 前置门槛开关（来自 extraction.dedupPrefilter）。 */
export interface DedupPrefilterOptions {
  enabled?: boolean;
  minCos?: number;
}

/**
 * 纯函数：按 topScore（真实 cosine）把候选匹配分成"进 LLM"与"直接判不重复"两组。
 *
 * fail-open 纪律（宁可多花一次 LLM，也不得漏判重复）：
 * - 关闭 → 原样全 kept；
 * - 候选为空 → skipped（无对可比）；
 * - topScore 缺失/NaN（FTS 召回或旧后端不给分）→ kept；
 * - cos < minCos → skipped；cos === minCos → kept（边界含等号）。
 */
export function prefilterCandidateMatches(
  matches: CandidateMatch[],
  options?: DedupPrefilterOptions,
): { kept: CandidateMatch[]; skipped: CandidateMatch[] } {
  if (options?.enabled !== true) return { kept: matches, skipped: [] };
  const minCos = resolvePrefilterMinCos(options.minCos);
  const kept: CandidateMatch[] = [];
  const skipped: CandidateMatch[] = [];
  for (const match of matches) {
    if (match.candidates.length === 0) {
      skipped.push(match);
      continue;
    }
    const score = match.topScore;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      kept.push(match);
      continue;
    }
    if (score >= minCos) kept.push(match);
    else skipped.push(match);
  }
  return { kept, skipped };
}

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
 * @param logger - Optional logger
 * @param model - Optional model override
 * @param vectorStore - Optional vector store for cosine similarity search
 * @param embeddingService - Optional embedding service for computing query vectors
 * @param conflictRecallTopK - Top-K candidates to recall per new memory (default: 5)
 * @returns Array of dedup decisions, one per new memory
 */
export async function batchDedup(params: {
  memories: Array<ExtractedMemory & { record_id: string }>;
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
  /** #79 dedup 判重 LLM 调用超时（config-first）：缺省 300_000 = 逐位现状 */
  dedupTimeoutMs?: number;
  /** Host-injected LLM runner — required, see `requireLlmRunner`. */
  llmRunner?: LLMRunner;
  /**
   * 逐调用思考开关（config-first，2026-10-14）：缺省 undefined = 不带 reasoning_effort
   * （端点默认）。原硬编码 "none"（R2）被当前生产端点拒绝（400 rejected by an internal
   * MaaS component，L1 全败 → 只有 L0 的同根因），与 l1-extractor 一并改配置化。
   */
  reasoningEffort?: string;
  /** Isolation filter applied to candidate recall so dedup never crosses tenants. */
  filter?: IsolationFilter;
  /** langfuse 上报身份四元组（team/user/agent/session），透传给 llmRunner。 */
  traceContext?: TraceContext;
  /** S1：similar 边最低相似度门槛（memory.links.minSimilarity），缺省 = MIN_SIMILAR_STRENGTH。 */
  minSimilarity?: number;
  /** B4（2026-11-02）：前置 embedding 门槛（extraction.dedupPrefilter），缺省关闭 = 逐位现状。 */
  dedupPrefilter?: DedupPrefilterOptions;
  /** B4：可读计数（原地写；不传 = 不统计）。 */
  stats?: DedupStats;
}): Promise<DedupDecision[]> {
  const { memories, logger, model, promptMode = "chat", vectorStore, embeddingService, llmRunner, filter, traceContext } = params;
  const topK = params.conflictRecallTopK ?? 5;
  const minSimilarity = params.minSimilarity ?? MIN_SIMILAR_STRENGTH;
  // B4：门槛开关（关闭 = 今天的路径，一次都不多走）
  const prefilterEnabled = params.dedupPrefilter?.enabled === true;
  if (params.stats) {
    params.stats.llmCalls = 0;
    params.stats.prefiltered = 0;
  }

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
        // R2-2 口径根治：部分死亡检测用记录粒度——行数比值在多 chunk 场景漏报
        //（例：300/500 条有向量但 vecRows=450 → 0.9 误判健康）。
        let coveredRows = vecRows;
        if (typeof vectorStore.countL1WithVectors === "function") {
          coveredRows = await vectorStore.countL1WithVectors();
        }
        if (metaRows > 0 && coveredRows / metaRows < 0.9) {
          warnVectorCoverageOnce(logger, coveredRows, metaRows);
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
    if (prefilterEnabled) {
      // B4：门槛开时，向量侧失败不得让整批去重塌成"抛错→上层全 store"，
      // 先降级到 FTS（仍进 LLM，不漏判）；无 FTS 才全 store（=关闭时的降级结果）。
      try {
        matches = await findCandidatesByVector(memories, vectorStore!, embeddingService, topK, logger, params.embeddingTimeoutMs, filter);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!hasFts) {
          logger?.warn?.(`${TAG} dedup prefilter: vector recall failed (${msg}) and no FTS — storing all`);
          return storeAll();
        }
        logger?.warn?.(`${TAG} dedup prefilter: vector recall failed (${msg}), falling back to FTS recall`);
        matches = await findCandidatesByFts(memories, vectorStore!, logger, filter);
      }
    } else {
      // 缺省关闭：保持原语义（异常向上抛，由 l1-extractor 兜 storeAllDirectly）
      matches = await findCandidatesByVector(memories, vectorStore!, embeddingService, topK, logger, params.embeddingTimeoutMs, filter);
    }
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

  // B4：前置门槛——cos < minCos 的候选对不必问 LLM（判"不重复"）。
  // 关闭时 kept === matches、skipped 空 → 与今天逐位一致。
  const { kept, skipped } = prefilterCandidateMatches(matches, params.dedupPrefilter);
  if (params.stats) params.stats.prefiltered = skipped.length;
  if (prefilterEnabled) {
    logger?.debug?.(
      `${TAG} dedup prefilter (minCos=${resolvePrefilterMinCos(params.dedupPrefilter?.minCos)}): ` +
        `kept=${kept.length} prefiltered=${skipped.length} llmCalls=${kept.length > 0 ? 1 : 0}`,
    );
    if (kept.length === 0) {
      return attachTopCandidates(storeAll(), matches, minSimilarity);
    }
  }

  const decisions = await runLlmJudgment(
    kept,
    kept.map((m) => m.newMemory),
    logger,
    model,
    promptMode,
    llmRunner,
    traceContext,
    valueCandidates,
    params.reasoningEffort,
    params.dedupTimeoutMs,
    params.stats,
  );
  if (!prefilterEnabled) return attachTopCandidates(decisions, matches, minSimilarity);

  // 门槛开：被拦下的记忆补 store 决策，并按**原 memories 顺序**合批（下游按数组顺序消费）。
  const byId = new Map(decisions.map((d) => [d.record_id, d] as const));
  const merged: DedupDecision[] = memories.map(
    (m) =>
      byId.get(m.record_id) ?? {
        record_id: m.record_id,
        action: "store" as const,
        target_ids: [],
      },
  );
  // 建边语义与今天一致：用全量 matches（含被拦下的行）补 top_candidate。
  return attachTopCandidates(merged, matches, minSimilarity);
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
      teamId: traceContext?.teamId ?? "",
      userId: traceContext?.userId ?? "",
      agentId: traceContext?.agentId ?? "",
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
  logger: Logger | undefined,
  model: string | undefined,
  promptMode: MemoryPromptMode,
  llmRunner?: LLMRunner,
  traceContext?: TraceContext,
  /** C1：价值锚候选（prompt 注入与解析过滤同源——防幻觉 id）。 */
  valueCandidates: CoreValueCandidate[] = [],
  /** 思考开关 config-first（2026-10-14）：undefined = 不带 reasoning_effort（端点默认）。 */
  reasoningEffort?: string,
  /** #79 dedup 判重超时（config-first）：undefined = 缺省 300_000（逐位现状）。 */
  dedupTimeoutMs?: number,
  /** B4：可读计数（原地写；llmCalls 只在实际发起 LLM 调用前 +1）。 */
  stats?: DedupStats,
): Promise<DedupDecision[]> {
  logger?.debug?.(`${TAG} Running batch conflict detection for ${memories.length} memories (promptMode=${promptMode})`);

  try {
    // task-62：把当前抽取会话作为 corpus 来源传给 prompt——候选池是跨会话 reference，
    // 两段必须物理分区且 reference 每条带 source.session_id/agent_id。
    const userPrompt = formatBatchConflictPrompt(matches, valueCandidates, {
      sessionId: traceContext?.sessionId,
      agentId: traceContext?.agentId,
    });
    const systemPrompt = getConflictDetectionSystemPrompt(promptMode);
    let result: string;

    // langfuse trace 语义：见 l1-extractor.ts 里的说明。dedup 是 L1 的子步骤，
    // 用独立 name 便于在 UI 上区分 "抽取阶段" vs "去重判定阶段"。
    const traceParams = buildTraceParams("memory.l1-dedup", traceContext);

    if (llmRunner) {
      if (stats) stats.llmCalls += 1;
      // Use the host-neutral LLMRunner interface
      // R2 P0-3（关思考）：端点 mimo-v2.6-flash 默认开思考，思考烧时延+输出预算——
      // 生产 10/138 整批超时降级全属思考所致（2026-10-06 取证），R1 v21 十组 A/B
      // 证关思考质量持平、时延 −32% → 主调关思考。2026-10-14 修订：当前生产端点
      //（glm-5.3-flash MaaS）对 reasoning_effort 参数直接 400，硬编码改 config-first
      // 透传（yaml 不配 = 不传 = 端点默认）。CleanContextRunner 兜底分支
      //（OpenClaw 路径，内联参数类型无此字段）不加，维持原样。
      result = await llmRunner.run({
        prompt: userPrompt,
        systemPrompt,
        taskId: "l1-conflict-detection",
        // #79：dedupTimeoutMs 可配置（config-first），缺省 300_000=逐位现状
        timeoutMs: dedupTimeoutMs ?? 300_000,
        reasoningEffort,
        ...traceParams,
      });
    } else {
      // OpenClaw embedded-runner fallback removed in the DSH-only build: the
      // host-neutral LLMRunner is the single LLM seam (src/core/llm-runner-guard.ts).
      throw new Error("LLMRunner is required but was not injected (OpenClaw fallback removed)");
    }

    // R2 P1-3：统一候选记忆池（幻觉 target 过滤的白名单）——与 prompt 注入同源
    //（candidates 全集）。缺省不传 = 不过滤（既有调用兼容）。
    const poolIds = new Set<string>();
    for (const m of matches) for (const c of m.candidates) if (c.id) poolIds.add(c.id);
    const decisions = parseBatchResult(result, memories, logger, valueCandidates, poolIds);
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
  /** R2 P1-3：统一候选记忆池（幻觉 target 白名单）；缺省 = 不过滤（既有调用兼容）。 */
  poolIds?: Set<string>,
): DedupDecision[] {
  // R2 P1-4：硬化统计（任何一条硬化工事发生即在尾部汇总 warn，干净解析保持静默）。
  const stats = {
    salvaged: 0,
    downgraded: 0,
    invalidAction: 0,
    targetDropped: 0,
    priorityFixed: 0,
    subjectTruncated: 0,
    typeBackfilled: 0,
    tsNormalized: 0,
  };
  try {
    // Strip markdown code block wrappers
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    const recordTypeById = new Map(memories.map((m) => [m.record_id, m.type]));

    // Extract JSON array；解析失败（砍尾截断等）→ salvage 抢救前缀中已闭合的决策（R2 P1-1）
    let parsed: unknown[] | undefined;
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const candidate = JSON.parse(sanitizeJsonForParse(arrayMatch[0])) as unknown;
        if (Array.isArray(candidate)) parsed = candidate;
        else {
          logger?.warn?.(`${TAG} Conflict detection response is not an array`);
          return fallbackStoreAll(memories);
        }
      } catch {
        // fall through → salvage
      }
    }
    if (!parsed) {
      const salvaged = salvageTruncatedJsonArray(cleaned);
      if (salvaged) {
        try {
          const candidate = JSON.parse(sanitizeJsonForParse(salvaged)) as unknown;
          if (Array.isArray(candidate)) {
            parsed = candidate;
            stats.salvaged = 1;
            logger?.warn?.(`${TAG} Conflict detection response truncated, salvaged ${parsed.length} complete decision(s)`);
          }
        } catch {
          // salvage 后仍不可解析 → 下方统一 fallback
        }
      }
    }
    if (!parsed) {
      logger?.warn?.(
        arrayMatch
          ? `${TAG} Failed to parse conflict detection result`
          : `${TAG} No JSON array found in conflict detection response`,
      );
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
      let action = String(d.action ?? "store");
      if (!validActions.includes(action)) {
        logger?.warn?.(`${TAG} Invalid action "${action}" for record ${recordId}, defaulting to store`);
        stats.invalidAction++;
        action = "store";
      }

      // R2 P1-3：target_ids ⊆ 候选池过滤（幻觉指向直接丢弃——prompt 端已声明）。
      // 过滤后为空不改变 action（宁重复不丢失；merge 缺 target 的后果由 P0-1 兜）。
      let targetIds = Array.isArray(d.target_ids) ? d.target_ids.map(String) : [];
      if (poolIds) {
        const before = targetIds.length;
        targetIds = targetIds.filter((id) => poolIds.has(id));
        stats.targetDropped += before - targetIds.length;
      }

      const mergedContent = typeof d.merged_content === "string" && d.merged_content.trim() ? d.merged_content : undefined;

      // R2 P0-1 假 merge 阻断：merge/update 缺 merged_content → 强制降级 store 并清空
      // 关联/合并字段——旧记忆不归档（不丢信息），新记忆原样入库；prompt 端已声明违规后果。
      if ((action === "merge" || action === "update") && !mergedContent) {
        logger?.warn?.(
          `${TAG} Decision for record ${recordId} action=${action} missing merged_content, downgraded to store`,
        );
        stats.downgraded++;
        decisions.push({
          record_id: recordId,
          action: "store",
          target_ids: [],
          subject: typeof d.subject === "string" && d.subject.trim() ? truncateSubject(d.subject.trim(), stats) : undefined,
          coreRefs: parseCoreRefs(d.coreRefs, valueCandidates),
        });
        continue;
      }

      // R2 P0-1：merge/update 的 merged_type 非法/缺失 → 回填该记录自身 type
      //（applyDecisions 建边与 writeMemory 版本记录依赖 type，宁回填不落空）。
      let mergedType: MemoryType | undefined = VALID_TYPES.includes(d.merged_type as MemoryType)
        ? (d.merged_type as MemoryType)
        : undefined;
      if ((action === "merge" || action === "update") && !mergedType) {
        const own = recordTypeById.get(recordId);
        if (own) {
          mergedType = own;
          stats.typeBackfilled++;
        }
      }

      // R2 P0-2：merged_priority 有限数门 + 取整 + clamp [0,100]；字段在场但非法/越界 → 计数。
      let mergedPriority: number | undefined;
      if (d.merged_priority !== undefined) {
        if (typeof d.merged_priority === "number" && Number.isFinite(d.merged_priority)) {
          const clamped = Math.round(Math.min(100, Math.max(0, d.merged_priority)));
          if (clamped !== d.merged_priority) stats.priorityFixed++;
          mergedPriority = clamped;
        } else {
          mergedPriority = undefined;
          stats.priorityFixed++;
        }
      }

      // R2 P1-5：merged_timestamps 规范化——ISO 前缀过滤、去重、字典序升序；全非法 → undefined。
      let mergedTimestamps: string[] | undefined;
      if (Array.isArray(d.merged_timestamps)) {
        const rawList = d.merged_timestamps.map(String);
        const out: string[] = [];
        for (const ts of rawList) {
          if (/^\d{4}-\d{2}-\d{2}/.test(ts) && !out.includes(ts)) out.push(ts);
        }
        out.sort();
        if (JSON.stringify(out) !== JSON.stringify(rawList)) stats.tsNormalized++;
        mergedTimestamps = out.length > 0 ? out : undefined;
      }

      decisions.push({
        record_id: recordId,
        action: action as DedupDecision["action"],
        target_ids: targetIds,
        merged_content: mergedContent,
        merged_type: mergedType,
        merged_priority: mergedPriority,
        merged_timestamps: mergedTimestamps,
        // P3-T17（H1，拍板④）：dedup LLM 顺带抽取的语义主题词（归组键）。空串/非字符串 = 无。
        subject: typeof d.subject === "string" && d.subject.trim() ? truncateSubject(d.subject.trim(), stats) : undefined,
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

    // R2 P1-4：硬化统计汇总（任一工事发生才打，干净解析零噪声）。
    const total =
      stats.salvaged + stats.downgraded + stats.invalidAction + stats.targetDropped +
      stats.priorityFixed + stats.subjectTruncated + stats.typeBackfilled + stats.tsNormalized;
    if (total > 0) {
      logger?.warn?.(
        `${TAG} Parse hardening stats: salvaged=${stats.salvaged} downgraded=${stats.downgraded} invalidAction=${stats.invalidAction} targetDropped=${stats.targetDropped} priorityFixed=${stats.priorityFixed} subjectTruncated=${stats.subjectTruncated} typeBackfilled=${stats.typeBackfilled} tsNormalized=${stats.tsNormalized}`,
      );
    }

    return decisions;
  } catch (err) {
    logger?.warn?.(`${TAG} Failed to parse conflict detection result: ${err instanceof Error ? err.message : String(err)}`);
    return fallbackStoreAll(memories);
  }
}

/**
 * R2 P0-2：subject 按 code point 截断 ≤12 字（与提示词「≤12字」声明对齐）；
 * 截断发生时计入 stats（P1-4 观测）。
 */
function truncateSubject(s: string, stats: { subjectTruncated: number }): string {
  const cps = Array.from(s);
  if (cps.length <= 12) return s;
  stats.subjectTruncated++;
  return cps.slice(0, 12).join("");
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
