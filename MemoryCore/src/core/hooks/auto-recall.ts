/**
 * auto-recall hook (v3): injects relevant memories + persona into agent context
 * before the agent starts processing.
 *
 * - Searches L1 memories using configurable strategy (keyword / embedding / hybrid)
 *   - keyword: FTS5 BM25 (requires FTS5; returns empty if unavailable)
 *   - embedding: VectorStore cosine similarity
 *   - hybrid: keyword + embedding merged with RRF
 * - L3 persona injection
 * - L2 scene navigation (full injection, LLM decides relevance)
 */

import type { MemoryTdaiConfig } from "../../config.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import { RecallErrors, toRecallFailure, type RecallError } from "./recall-errors.js";
import type { MemoryRecord } from "../record/l1-reader.js";
import type { IMemoryStore, L1SearchResult, L1FtsResult, CoreTenant, IsolationFilter } from "../store/types.js";
import { normalizeCoreTenant } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService, EmbeddingCallOptions } from "../store/embedding.js";
import {
  resolveCoreRefBoost,
  cachedQueryEmbedding,
  collectSeedGraph,
  applyCompositeRerank,
  applyExploreSlot,
  DEFAULT_COMPOSITE_WEIGHTS,
  type CompositeWeights,
} from "../tools/memory-search.js";
import {
  expandQuery,
  mergeFtsQueryWithExpansion,
  resolveQueryExpansionRunner,
} from "../recall/query-expand.js";
import { PPR_DEFAULTS, runPPRDetail } from "../recall/ppr.js";
import {
  buildRankContext,
  certaintyMultiplierOf,
  DEFAULT_RANK_SIGNALS,
  detectSceneHit,
  sceneSignalOf,
  structuralSignalOf,
  ZERO_RANK_SIGNALS,
  type RankSignalItem,
  type RankSignals,
  type ValueRowLike,
} from "../tools/recall-signals.js";
import { parseTimeWindow, type TimeWindow } from "../tools/content-time-window.js";
import { sanitizeText } from "../../utils/sanitize.js";
import {
  assembleLayeredLines,
  conclusionFingerprint,
  formatConclusionLine,
  parseFtsTokens,
  resolveIdempotentConclusionLines,
  selectL2Conclusions,
  splitBudget,
  truncateConclusionContent,
  type L2ConclusionCandidate,
} from "./recall-layered.js";
import path from "node:path";
import { createScopedStorageAdapter, type StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import {
  DEFAULT_PROFILE_SCOPE,
  buildProfileIsolationScope,
  type ProfileIsolation,
} from "../profile/profile-sync.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai] [recall]";
const RECALL_TRUNCATION_SUFFIX = "…（已截断；可用 tdai_memory_search 或 tdai_conversation_search 查看详情）";
const MIN_TRUNCATED_RECALL_LINE_CHARS = 40;
const RECALL_LINE_SEPARATOR = "\n";

// V2-1（引擎二 PPR）：候选池上限由 pprTopK 接管（默认 10，与工具路同值——两路同层对齐，
// 单一语义）；旧 R-A2 GRAPH_POOL_CAP/graphKindRank 随一跳补池替换一并退役。

/**
 * V2-3（引擎三 E3.2）：分析型 query 检测（启发式，宁缺毋滥）——query 含分析标记
 *（怎么/为什么/如何/分析/评估/对比/差异）且长度 > 8 字（码点口径）。导出供单测。
 */
const ANALYTICAL_MARKERS = ["怎么", "为什么", "如何", "分析", "评估", "对比", "差异"] as const;
export function isAnalyticalQuery(query: string): boolean {
  if (!query) return false;
  const q = query.trim();
  if (Array.from(q).length <= 8) return false;
  return ANALYTICAL_MARKERS.some((m) => q.includes(m));
}

/**
 * R7（分层召回 spec DS-RECALL-LAYERED-R7-001）：L2 结论层 → L1 经验层的透传上下文。
 * L1 检索九通道排序零变化（spec §3 不变式）——本上下文只做两件事：
 *   1. 经验层防重（R7-1 幂等：结论已收编的 work_fact 不在经验层重复出现）；
 *   2. scene 反查补池数据源（R7-2：part_of 证据链优先 + 同 scene 过滤）。
 * 无 L2 结论 → 调用方传 undefined → 全链与现状逐位一致（退化安全）。
 */
export interface R7LayeredContext {
  /** 结论层已收编的 L1 record ids（经验层防重——命中已存不重组）。 */
  excludeIds: readonly string[];
  /** work_fact 结论引用（id + 场景名；R7-2 part_of 证据链反查源）。 */
  conclusionRefs: ReadonlyArray<{ id: string; sceneName: string }>;
  /** 结论场景名全集（含 scene_block 源；R7-2 同 scene 反查源）。 */
  sceneNames: readonly string[];
}

// ── R-A3（E3 性能速赢）：同 session 同 query 注入块复用缓存 ──
// 确定性纪律：上轮 query 与本轮**全等**才复用（不做模糊匹配）；
// 且 vectorStore / embeddingService 实例同一（verify-s5 C5-2a/2b 教训：同 sessionKey
// 换库复用 = 跨库脏读）；TTL 仅作漂移防御（默认 5min，0=关）；上界 200 session 防膨胀。
interface SessionReuseEntry {
  query: string;
  result: { lines: string[]; timing: SearchTiming; scores?: number[] };
  at: number;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
}
const sessionReuseCache = new Map<string, SessionReuseEntry>();
const SESSION_REUSE_MAX = 200;

/**
 * Memory tools usage guide — injected at the end of memory context so the
 * main agent knows how to actively retrieve deeper information.
 */
const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

当上方注入的记忆片段不足以回答用户问题时，可主动调用以下工具获取更多信息：

- **tdai_memory_search**：搜索结构化记忆（L1），适用于回忆用户偏好、历史事件节点、规则等关键信息。
- **tdai_conversation_search**：搜索原始对话（L0），适用于查找具体消息原文、时间线、上下文细节；也可用于补充或校验 memory_search 的结果。
- **read_file**（Scene Navigation 中的路径）：当已定位到相关情境，且需要该场景的完整画像、事件经过或阶段结论时使用。

### ⚠️ 调用次数限制
每轮对话中，tdai_memory_search 和 tdai_conversation_search **合计最多调用 3 次**。
- 首次搜索无结果时，可换关键词或换工具重试，但总调用次数不要超过 3 次。
- 若 3 次搜索后仍无结果，说明该信息不在记忆中，请直接根据已有信息回复用户，不要继续搜索。
</memory-tools-guide>`

/** A single recalled L1 memory with its search score and type. */
export interface RecalledMemory {
  content: string;
  score: number;
  type: string;
}

/**
 * C5（灵魂记忆 spec §2.2 / C1 拍板①后续项）：coreRef 排序加成信号——与工具侧
 * executeMemorySearch 同一加成（memory.recall.coreRefBoost，默认 0.05，0=关闭）：
 * query 的 appraisal 命中价值（fired）∧ 记忆 metadata.coreRefs 含之 → hybrid RRF
 * 排序 rankKey +boost。检索层冻结：仅排序（同层内位次），不改门槛、不越 work_fact
 * 分层。宁缺毋滥：fired 为空 / 价值锚读取失败 → 无信号（零加成，旧行为）。
 */
export interface RecallCoreRefSignal {
  boost: number;
  firedLabels: readonly string[];
}

/**
 * R-A1（结构感知召回 spec §2 R1/R2/R3/R8/R9）：auto-recall 排序点信号——与工具侧
 * executeMemorySearch 同层（C5 教训：只改一处 = 另一处静默不一致）。在
 * RecallCoreRefSignal 之上追加时间窗 / moodSign / 六开关 / now 快照。
 * 关断恒等：六信号全 0 时 rankKey 与基线逐位一致（(x + 0) * 1 === x，IEEE754）。
 */
export interface RecallRankSignal extends RecallCoreRefSignal {
  /** R9：当前轮 fired valence 均值符号（fired 为空 → 0 → 不加成）。 */
  moodSign: number;
  /** R1：query 时间线索解析窗（解析不出 → null → 无时间信号）。 */
  timeWindow: TimeWindow | null;
  /** R-A1 六开关（memory.recall 下 timeBoost/recencyBoost/sigWeight/inferredPenalty/reinforcementWeight/moodBoost）。 */
  signals: RankSignals;
  /** 确定性锚点：排序时 now 快照（时近性判定）。 */
  now: Date;
  /**
   * R-A2（R4）图通道参数（边强度门槛 + 派生分折扣；缺省 = 通道退出——
   * auto-recall 仅在 cfg.recall.graphDiscount > 0 时携带）。
   * V2-1（引擎二 PPR）：pprDamping/pprTopK/pprIterations 可选透传（缺省回落
   * ppr.ts 默认 0.85/10/30——旧 C5 形状不带 ppr 字段仍兼容）。
   */
  graph?: {
    minStrength: number;
    discount: number;
    pprDamping?: number;
    pprTopK?: number;
    pprIterations?: number;
  };
  /** R-A2（R6）：场景路由加成（tiebreak 层；0/缺省 = 关）。 */
  sceneBoost?: number;
}

export interface RecallResult {
  /** L1 relevant memories — prepended to user prompt text (dynamic, per-turn) */
  prependContext?: string;
  /** Stable recall context appended to system prompt (persona, scene nav, tools guide — cacheable) */
  appendSystemContext?: string;

  // ── Metric payload (for pendingRecallCache in index.ts) ──
  /** L1 memories that were recalled (with scores), for metric reporting */
  recalledL1Memories?: RecalledMemory[];
  /** L3 Persona raw content loaded during recall (null if none) */
  recalledL3Persona?: string | null;
  /** Effective search strategy used */
  recallStrategy?: string;

  // ── H-15: structured failure signal ──
  /**
   * When recall fails, this is populated with a RecallError; success path leaves it undefined.
   * Callers (gateway handlers) should check `result.error` and surface it in the response envelope.
   * The other fields are still populated with safe defaults (empty strings / arrays) so that
   * downstream code that ignores `error` does not NPE.
   */
  error?: RecallError;
  /**
   * Partial success indicator: true when some recall steps succeeded but others failed
   * (e.g. L1 search OK but persona read failed). When true, `error` reflects the failed step.
   */
  partial?: boolean;
}

export async function performAutoRecall(params: {
  userText: string;
  actorId: string;
  sessionKey: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  /** StorageAdapter for file operations (COS/local). Falls back to fs when absent. */
  storage?: StorageAdapter;
  /** L2/L3 profile scope. Defaults to the standalone default team and agent. */
  profileIsolation?: ProfileIsolation;
}): Promise<RecallResult | undefined> {
  const { cfg, logger } = params;
  const timeoutMs = cfg.recall.timeoutMs ?? 5000;

  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    performAutoRecallInner(params).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    // H-15: timeout returns a structured RecallResult.error instead of undefined
    // so the gateway layer can distinguish "no recall results" (undefined) from
    // "recall timed out" (result.error.code === 20001) in the response envelope.
    new Promise<RecallResult>((resolve) => {
      timer = setTimeout(() => {
        logger?.warn?.(
          `${TAG} ⚠️ Recall timed out after ${timeoutMs}ms — surfacing as RecallResult.error`,
        );
        resolve({
          prependContext: "",
          appendSystemContext: "",
          recalledL1Memories: [],
          recalledL3Persona: null,
          error: RecallErrors.dependencyTimeout("recall").recallError,
          partial: false,
        });
      }, timeoutMs);
    }),
  ]);
}

// ============================
// DS-RECALL-MERGE-001（合并召回 · 核心单点）：共享分层召回编排
// ============================

/**
 * 检索 + R7 分层组装产出路径（spec DS-RECALL-MERGE-001 §4.1）——从 auto-recall 钩子
 * 编排层提取的可复用函数。钩子（performAutoRecallCore，链路 B）与 `/v3/recall` 端点
 * （链路 A 新路）共用同一实现，消灭两套组装逻辑。
 *
 * 提取铁律（spec §4.1 / 验收 2）：只提取编排，不改行为——钩子路径输出与提取前逐位一致；
 * 检索层零触碰（打分/门槛/RRF/字典序——5fc7962 语义原样复用）。
 *
 * isolationFilter（可选租户收窄）：钩子路径不传（undefined = 旧行为逐位——auto-recall
 * L1 召回本就是全局路径）；/v3/recall 端点传请求的三元组隔离（(team,user,agent[,task])，
 * 与 /v3/atomic/search 的 handleAtomicSearch 同形）。透传只收窄候选集（store 层既有
 * IsolationFilter 能力，P2-T14 家族），不改任何打分/排序语义。
 */
export interface LayeredRecallOutcome {
  /** 最终注入行（结论层在前 + 经验层在后，预算已应用）——钩子后续 metric 消费。 */
  memoryLines: string[];
  /** 结构化 metric 载荷（与钩子现状同源）。 */
  recalledL1Memories: RecalledMemory[];
  /**
   * `<relevant-memories>` 注入块（与钩子 prependContext 同形同源）。
   * 无内容 → undefined（端点侧归一为 ""，语义 = 本轮无可注入，非失败）。
   */
  block?: string;
  effectiveStrategy: string;
  searchTiming: SearchTiming;
  /** R7 meta（spec §4.1 观测/评估用）：结论行数（含 [结论] 标注行）。 */
  conclusionCount: number;
  /** R7 meta：经验行数（预算切分后实际入块数）。 */
  experienceCount: number;
  /** R7 meta：本轮是否命中复用（幂等结论层复用 ∨ 同 session 同 query 检索复用）。 */
  sessionReused: boolean;
  /** R7 meta：分层组装是否生效（结论层非空）。 */
  layered: boolean;
  /** scene index 条目（钩子后续 scene navigation 复用——一次读取两处消费，现状保持）。 */
  sceneIndexEntries: Awaited<ReturnType<typeof readSceneIndex>>;
  /** profile scope 派生（钩子 persona/scene navigation 消费）。 */
  profileDataDir: string;
  profileStorage?: StorageAdapter;
  profileScope: string;
}

export async function performLayeredRecall(params: {
  userText: string;
  sessionKey: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  storage?: StorageAdapter;
  profileIsolation?: ProfileIsolation;
  isolationFilter?: IsolationFilter;
}): Promise<LayeredRecallOutcome> {
  const { userText, cfg, pluginDataDir, logger, vectorStore, embeddingService, storage } = params;

  // L2/L3 writers scope profile files by team+agent. Recall resolves the same
  // scope and never falls back to the unscoped data root, preventing cross-scope
  // profile reads.
  const profileIsolation = params.profileIsolation ?? { teamId: "default", agentId: "default" };
  const profileScope = buildProfileIsolationScope(profileIsolation);
  const isScopedProfile = profileScope !== DEFAULT_PROFILE_SCOPE;
  const profileDataDir = isScopedProfile
    ? path.join(pluginDataDir, "profiles", encodeURIComponent(profileScope))
    : pluginDataDir;
  const profileStorage = storage && isScopedProfile
    ? createScopedStorageAdapter(storage, `profiles/${encodeURIComponent(profileScope)}/`)
    : storage;

  // ── R7：scene index 一次读取，两处消费 ──
  // ① L2 结论层 scene_block 候选（title+snippet 通道，需在 L1 检索前就位）；
  // ② 现状 scene navigation（钩子 L2 层，行为零变化）。readSceneIndex 自捕获（失败 → []）。
  const sceneIndexEntries = await readSceneIndex(profileDataDir, profileStorage);

  // Search relevant memories (L1 layer) — skip only when userText is empty/undefined
  const tSearchStart = performance.now();
  let memoryLines: string[] = [];
  let effectiveStrategy = "skipped";
  let recalledL1Memories: RecalledMemory[] = [];
  let searchTiming: SearchTiming = { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 };
  let conclusionCount = 0;
  let experienceCount = 0;
  let sessionReused = false;
  let layered = false;
  let block: string | undefined;
  let searchCacheHit = false;
  if (!userText || userText.length === 0) {
    logger?.debug?.(`${TAG} User text empty/undefined, skipping memory search (persona/scene still injected)`);
  } else {
    effectiveStrategy = cfg.recall.strategy ?? "hybrid";
    // ── R7-1（分层召回 spec §2 R7-1）：L2 结论层选择（在 L1 检索上游）──
    // 数据源（spec：既有 L2 通道）：① consolidation 持续态产物 work_fact（FTS 词面命中——
    // 既有文本匹配单一源 buildFtsQuery/searchL1Fts，绕开绝对门槛的结构解）；② scene blocks
    // title+snippet（scene index，历史既有）。命中 = 文本命中 + scene_name 命中（selectL2Conclusions
    // 单一源：detectSceneHit + token 子串）。无命中 → 结论层空 → 全链与现状逐位一致（退化安全）。
    const r7MaxResults = cfg.recall.maxResults ?? 5;
    const r7HalfLimit = Math.floor(r7MaxResults / 2);
    const r7CleanQuery = sanitizeText(userText);
    // ── 审查修补 I①（关断矩阵纪律）：conclusionLayer.enabled 总开关 ──
    // 缺省 true = 现行为；false = 结论层整体退出（候选零收集、选择零执行、V2-3 放宽零触发）
    // → r7Conclusions 恒空 → 下游沿"无 L2 命中退化"同一既有路径（layered=undefined /
    // 结论行空 / 经验层全额 / metric scores 原样），输出与 R7 前基线逐位一致。不另写旁路。
    const r7ConclusionLayerEnabled = cfg.recall?.conclusionLayer?.enabled !== false;
    const r7Candidates: L2ConclusionCandidate[] = [];
    let r7Conclusions: L2ConclusionCandidate[] = [];
    if (r7ConclusionLayerEnabled) {
      const r7FtsTokens = parseFtsTokens(buildFtsQuery(r7CleanQuery));
      try {
        if (vectorStore && typeof vectorStore.isFtsAvailable === "function" && vectorStore.isFtsAvailable()) {
          const wfQuery = buildFtsQuery(r7CleanQuery);
          if (wfQuery) {
            // DS-RECALL-MERGE-001：isolationFilter 透传（undefined = 钩子路旧行为逐位；
            // 端点路 = 三元组收窄，store 层 P2-T14 家族既有能力，不改打分语义）
            const wfRows = await vectorStore.searchL1Fts(wfQuery, r7HalfLimit * 2, params.isolationFilter);
            for (const r of wfRows ?? []) {
              if (r.type === "work_fact") {
                r7Candidates.push({ sceneName: r.scene_name ?? "", content: r.content, source: "work_fact", recordId: r.record_id });
              }
            }
          }
        }
      } catch (err) {
        logger?.debug?.(`${TAG} [layered] work_fact conclusion candidates unavailable (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
      for (const e of sceneIndexEntries) {
        r7Candidates.push({ sceneName: e.filename.replace(/\.md$/i, ""), content: e.summary, source: "scene_block" });
      }
      r7Conclusions = selectL2Conclusions(r7CleanQuery, r7Candidates, { ftsTokens: r7FtsTokens }, r7HalfLimit);
      // ── V2-3（引擎三 E3.2 结论层放宽）：分析型 query → L2 结论层追加 "significance top-5
      // 的 durative 结论"（无需 scene/text 命中——蒸馏结论对分析问题浮出）。数据源 =
      // store.searchL1ByType("work_fact", 5)（significance DESC；可选方法 feature-detect——
      // 未实现的后端通道退出，宁缺毋滥降级）。非分析型 / 开关关断 → 现状逐位。 ──
      if (cfg.recall?.conclusionRelaxedForAnalytical !== false && isAnalyticalQuery(r7CleanQuery) &&
          vectorStore && typeof vectorStore.searchL1ByType === "function") {
        try {
          const relaxedRows = ((await vectorStore.searchL1ByType("work_fact", 5, params.isolationFilter)) ?? []) as L1SearchResult[];
          const selectedIds = new Set(r7Conclusions.map((c) => c.recordId).filter((id): id is string => !!id));
          const relaxed: L2ConclusionCandidate[] = [];
          for (const r of relaxedRows) {
            if (relaxed.length >= 5) break;
            if (!r || typeof r.record_id !== "string" || !r.content?.trim()) continue;
            if (selectedIds.has(r.record_id)) continue;
            relaxed.push({ sceneName: r.scene_name ?? "", content: r.content, source: "work_fact", recordId: r.record_id });
          }
          if (relaxed.length > 0) {
            r7Conclusions = [...r7Conclusions, ...relaxed];
            logger?.debug?.(`${TAG} [layered] V2-3 analytical relaxation: +${relaxed.length} significance-top durative conclusions`);
          }
        } catch (err) {
          logger?.debug?.(`${TAG} [layered] analytical conclusion relaxation unavailable (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // ── 审查修补 Critical（R7 spec §1 预算模型）：结论侧硬上限 = floor(maxResults/2) ──
      // V2-3 分析型放宽会在 selectL2Conclusions 的 halfLimit 之上最多追加 5 条——若不在此
      // 收口，结论行静默突破预算（生产 maxResults=5、无 maxTotalRecallChars 时分析型注入
      // 可达 10 行 = 结论 7 + 经验 3）。取舍：选"组装前裁剪"而非"给放宽通道独立登记上限"
      // （最小侵入：一处 slice，选择器/放宽通道/幂等缓存语义零变化，且指纹/经验层防重/
      // metric 对齐全部与最终注入行同源自洽）；无 V2-3 溢出时 length ≤ halfLimit → slice
      // 恒等（逐位现状）。裁剪保留头部 = 命中结论优先于放宽结论（选择器排序语义保持）。
      r7Conclusions = r7Conclusions.slice(0, r7HalfLimit);
    }
    // Task CAL C1（brief 裁决）：结论层注入前截断——纯注入层，不碰门槛/九通道排序。
    // 巨型场景块摘要（首跑 F1：21,660 字符万词面通用匹配器）按 conclusionLayer.maxCharsPerMemory
    // 截断（默认 2000）+ 尾部标注；0 = 通道关闭（逐位现状）。截断先于幂等指纹（截断态即缓存态）。
    const r7ConclusionMaxChars = cfg.recall?.conclusionLayer?.maxCharsPerMemory ?? 2000;
    if (r7ConclusionMaxChars > 0) {
      r7Conclusions = r7Conclusions.map((c) => ({
        ...c,
        content: truncateConclusionContent(c.content, r7ConclusionMaxChars),
      }));
    }
    // 幂等结论层（spec §2 R7-1，借团队 幂等与防重 模式）：结论未变化 → 复用已存行（不重组，cache 友好）
    // 审查修补 I③（TTL 解耦）：conclusionLayer.cacheTtlMs 独立键——缺省（未配置）回落
    // sessionReuseTtlMs 保持现行为；显式 0 = 关（每次重组，不缓存）。负值/非有限由 config
    // 解析层 clamp 0（同 maxCharsPerMemory 模式）。
    const r7ConclusionTtlMs = cfg.recall?.conclusionLayer?.cacheTtlMs ?? (cfg.recall?.sessionReuseTtlMs ?? 300_000);
    // DS-RECALL-MERGE-001：reused 标志上浮为端点 meta.sessionReused 的一部分（行为零变化）
    const r7ConclusionResolved = resolveIdempotentConclusionLines(
      params.sessionKey,
      conclusionFingerprint(r7Conclusions),
      r7Conclusions.map(formatConclusionLine),
      r7ConclusionTtlMs,
    );
    const r7ConclusionLines = r7ConclusionResolved.lines;
    const conclusionReused = r7ConclusionResolved.reused;
    // R7 经验层上下文（R7-1 防重排除 + R7-2 scene 反查源）；无结论 = undefined = 全链退化现状
    //（DS-RECALL-MERGE-001：原局部名 `layered` 改 `r7LayeredCtx`——外层 let layered 是端点 meta）
    const r7LayeredCtx: R7LayeredContext | undefined = r7Conclusions.length > 0
      ? {
          excludeIds: r7Conclusions.filter((c) => c.recordId).map((c) => c.recordId!),
          conclusionRefs: r7Conclusions
            .filter((c) => c.source === "work_fact" && c.recordId)
            .map((c) => ({ id: c.recordId!, sceneName: c.sceneName })),
          sceneNames: [...new Set(r7Conclusions.map((c) => c.sceneName).filter((s) => typeof s === "string" && s.length > 0))],
        }
      : undefined;
    // R-A3（E3）：同 session 上轮 query 与本轮全等 → 复用上轮搜索结果（免搜索免外呼）。
    // sessionReuseTtlMs<=0 = 通道关；query 变化 / 不同 session / TTL 过期 → 正常搜索。
    const sessionReuseTtlMs = cfg.recall?.sessionReuseTtlMs ?? 300_000;
    let searchResult: { lines: string[]; timing: SearchTiming; scores?: number[] } | undefined;
    if (sessionReuseTtlMs > 0) {
      const entry = sessionReuseCache.get(params.sessionKey);
      if (entry && entry.query === userText && entry.vectorStore === vectorStore && entry.embeddingService === embeddingService &&
          Date.now() - entry.at < sessionReuseTtlMs) {
        searchResult = entry.result;
        searchCacheHit = true;
        logger?.debug?.(`${TAG} [session-reuse] HIT (age=${Date.now() - entry.at}ms) session=${params.sessionKey}`);
      }
    }
    if (!searchResult) {
      // C5/R-A1：coreRef + 结构信号（仅 hybrid——唯一存在 rankKey 合并排序的策略；
      // keyword/embedding 是纯单路名次序，无排序点可加）。best-effort：价值锚读取
      // 失败 / 无价值锚 / appraise 无 fired → 对应信号为零（全链旧行为）。
      const coreRefBoost = cfg.recall?.coreRefBoost ?? 0.05;
      // R-A1 六开关（cfg.recall 解析见 src/config.ts；缺省 = spec §2 默认值）
      const signals: RankSignals = {
        timeBoost: cfg.recall?.timeBoost ?? DEFAULT_RANK_SIGNALS.timeBoost,
        recencyBoost: cfg.recall?.recencyBoost ?? DEFAULT_RANK_SIGNALS.recencyBoost,
        sigWeight: cfg.recall?.sigWeight ?? DEFAULT_RANK_SIGNALS.sigWeight,
        inferredPenalty: cfg.recall?.inferredPenalty ?? DEFAULT_RANK_SIGNALS.inferredPenalty,
        reinforcementWeight: cfg.recall?.reinforcementWeight ?? DEFAULT_RANK_SIGNALS.reinforcementWeight,
        moodBoost: cfg.recall?.moodBoost ?? DEFAULT_RANK_SIGNALS.moodBoost,
      };
      const signalsActive =
        signals.timeBoost > 0 ||
        signals.recencyBoost > 0 ||
        signals.sigWeight > 0 ||
        signals.inferredPenalty > 0 ||
        signals.reinforcementWeight > 0 ||
        signals.moodBoost > 0;
      const needValues = coreRefBoost > 0 || signals.moodBoost > 0;
      // R-A2：候选池通道开关（cfg.recall；缺省 = spec §2 默认值，0 = 通道退出）
      const graphDiscount = cfg.recall?.graphDiscount ?? 0.6;
      const graphMinStrength = cfg.recall?.graphMinStrength ?? 0.5;
      const sceneBoost = cfg.recall?.sceneBoost ?? 0.04;
      let rank: RecallRankSignal | undefined;
      if (effectiveStrategy === "hybrid" && vectorStore && (needValues || signalsActive || graphDiscount > 0 || sceneBoost > 0)) {
        const { firedLabels, moodSign } = needValues
          ? await computeRecallValueSignals(sanitizeText(userText), vectorStore, params.profileIsolation, logger)
          : { firedLabels: [] as string[], moodSign: 0 };
        const now = new Date(); // R-A1 确定性锚点：本轮排序时快照
        rank = {
          boost: coreRefBoost,
          firedLabels,
          moodSign,
          timeWindow: signals.timeBoost > 0 ? parseTimeWindow(sanitizeText(userText), now) : null,
          signals,
          now,
          // R-A2：候选池通道参数透传（graphDiscount=0 时携带 0 —— searchHybrid 内零调用退出）；
          // V2-1：PPR 三旋钮随 cfg 透传（缺省 undefined → ppr.ts 回落默认）
          graph: {
            minStrength: graphMinStrength,
            discount: graphDiscount,
            pprDamping: cfg.recall?.pprDamping,
            pprTopK: cfg.recall?.pprTopK,
            pprIterations: cfg.recall?.pprIterations,
          },
          sceneBoost,
        };
        if (firedLabels.length > 0) {
          logger?.debug?.(`${TAG} [coreRef-boost] fired=${JSON.stringify(firedLabels)}, boost=${coreRefBoost}`);
        }
      }
      searchResult = await searchMemories(userText, pluginDataDir, cfg, logger, effectiveStrategy as "keyword" | "embedding" | "hybrid", vectorStore, embeddingService, rank, r7LayeredCtx, params.isolationFilter);
      // 审查 #3 修补：空结果不入复用缓存——瞬时失败（如外呼抖动/瞬时空召回）不放大成
      // TTL 窗口内的持续空召回；lines.length>0 才视为可用注入块。
      if (sessionReuseTtlMs > 0 && searchResult.lines.length > 0) {
        sessionReuseCache.set(params.sessionKey, { query: userText, result: searchResult, at: Date.now(), vectorStore, embeddingService });
        if (sessionReuseCache.size > SESSION_REUSE_MAX) {
          const oldest = sessionReuseCache.keys().next().value;
          if (oldest !== undefined) sessionReuseCache.delete(oldest);
        }
      }
    }
    memoryLines = searchResult.lines;
    searchTiming = searchResult.timing;
    // ── R7 预算对半切（spec §1）：结论层用剩给经验层。无结论 → experienceLimit 全额 →
    // slice 恒等 + 组装恒等 → applyRecallBudget 输入与现状逐位一致（退化安全）。──
    const r7Budget = splitBudget(r7MaxResults, r7ConclusionLines.length);
    memoryLines = memoryLines.slice(0, r7Budget.experienceLimit);
    // 审查修补（伴随 Critical）：经验行实际条数在 slice 后定格——scores 切片以此为界，
    // 修掉"经验命中不足 experienceLimit 时 scores 多切导致 metric 串位"的潜在错位。
    const r7ExperienceLineCount = memoryLines.length;
    memoryLines = assembleLayeredLines(r7ConclusionLines, memoryLines);
    memoryLines = applyRecallBudget(memoryLines, cfg.recall, logger);

    // Extract structured RecalledMemory from formatted lines for metric reporting
    // R7：结论行前置 → metric scores 数组同步前插 0（结论非相似度命中，score=0 如实）
    const r7MetricScores = r7ConclusionLines.length > 0
      ? [...r7ConclusionLines.map(() => 0), ...(searchResult.scores ?? []).slice(0, r7ExperienceLineCount)]
      : searchResult.scores;
    recalledL1Memories = memoryLines.map((line, i) => {
      const match = line.match(MEMORY_LINE_RE);
      if (match) {
        const tag = match[1];
        const content = match[2].trim();
        const typePart = tag.includes("|") ? tag.split("|")[0] : tag;
        return { content, score: r7MetricScores?.[i] ?? 0, type: typePart };
      }
      return { content: line, score: r7MetricScores?.[i] ?? 0, type: "unknown" };
    });
    // ── DS-RECALL-MERGE-001：R7 meta 定格 + 注入块组装（自钩子原位平移，逐位一致）──
    conclusionCount = r7ConclusionLines.length;
    experienceCount = r7ExperienceLineCount;
    sessionReused = searchCacheHit || conclusionReused;
    layered = r7ConclusionLines.length > 0;
    // T15-C 降级可见：embedding 已配置但本轮命中全部来自 FTS（向量层死亡/无向量命中）
    // → 注入块头部标注 [degraded: fts-only]，用户与 LLM 都要知道在看残废召回。
    // 显式 keyword 策略是用户选择（embedding 未参与），不算降级。
    const recallDegradedFtsOnly =
      !!vectorStore && !!embeddingService &&
      searchTiming.ftsHits > 0 && searchTiming.embeddingHits === 0 &&
      effectiveStrategy !== "keyword";
    if (memoryLines.length > 0) {
      const degradedNote = recallDegradedFtsOnly
        // I-1 复核修补：两义措辞 —— ftsHits>0∧embeddingHits=0 只证明"本轮向量召回无贡献"，
        // 无法区分向量层降级与相关度门滤除，禁止假警报式单因断言。
        ? "[degraded: fts-only] 本轮记忆召回仅来自关键词检索（FTS），向量召回无贡献（向量层降级或相关度门滤除），召回质量可能不完整。\n\n"
        : "";
      block =
        `<relevant-memories>\n${degradedNote}以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${memoryLines.join(RECALL_LINE_SEPARATOR)}\n</relevant-memories>`;
    }
  }

  return {
    memoryLines,
    recalledL1Memories,
    block,
    effectiveStrategy,
    searchTiming,
    conclusionCount,
    experienceCount,
    sessionReused,
    layered,
    sceneIndexEntries,
    profileDataDir,
    profileStorage,
    profileScope,
  };
}

/**
 * Core recall logic — may throw RecallFailure (or any unhandled error) when
 * a fatal failure occurs. Wrapped by `performAutoRecallInner` which catches
 * and translates failures into structured `RecallResult.error`.
 *
 * Returns:
 *   - RecallResult — when recall succeeded and there is content to inject
 *   - undefined    — when recall succeeded but there is nothing to inject
 *                    (empty memory + no persona + no scene navigation)
 *
 * Never returns a RecallResult with `error` populated; that is the wrapper's job.
 *
 * DS-RECALL-MERGE-001：检索 + R7 分层组装已提取为 performLayeredRecall（钩子与
 * /v3/recall 端点共用）；本函数保留 persona（L3）/ scene navigation（L2）编排，
 * 输出与提取前逐位一致。
 */
async function performAutoRecallCore(params: {
  userText: string;
  actorId: string;
  sessionKey: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  storage?: StorageAdapter;
  profileIsolation?: ProfileIsolation;
}): Promise<RecallResult | undefined> {
  const { cfg, logger } = params;
  const tRecallStart = performance.now();
  const tSearchStart = performance.now();

  const layeredOutcome = await performLayeredRecall(params);
  const tSearchEnd = performance.now();
  const memoryLines = layeredOutcome.memoryLines;
  const searchTiming = layeredOutcome.searchTiming;
  const effectiveStrategy = layeredOutcome.effectiveStrategy;
  const recalledL1Memories = layeredOutcome.recalledL1Memories;
  const profileDataDir = layeredOutcome.profileDataDir;
  const profileStorage = layeredOutcome.profileStorage;
  const profileScope = layeredOutcome.profileScope;
  const sceneIndexEntries = layeredOutcome.sceneIndexEntries;

  // Read persona (L3 layer)
  const tPersonaStart = performance.now();
  let personaContent: string | undefined;
  try {
    let raw: string | null = null;
    if (profileStorage) {
      raw = await profileStorage.readFile(StoragePaths.persona);
    } else {
      const fs = await import("node:fs/promises");
      raw = await fs.default.readFile(path.join(profileDataDir, "persona.md"), "utf-8");
    }
    if (raw) {
      personaContent = stripSceneNavigation(raw).trim();
      if (!personaContent) personaContent = undefined;
    }
    logger?.debug?.(`${TAG} Persona loaded: ${personaContent ? `${personaContent.length} chars` : "empty"}`);
  } catch {
    logger?.debug?.(`${TAG} No persona file found (expected for new users)`);
  }
  const tPersonaEnd = performance.now();

  // Load full scene navigation (L2 layer)
  // R7：scene index 已在检索前读取（sceneIndexEntries）——此处仅生成 navigation（行为零变化）
  const tSceneStart = performance.now();
  let sceneNavigation: string | undefined;
  try {
    if (sceneIndexEntries.length > 0) {
      const useCos = profileStorage?.type === "cos";
      sceneNavigation = generateSceneNavigation(sceneIndexEntries, profileDataDir, useCos);
      logger?.debug?.(
        `${TAG} Scene navigation generated: ${sceneIndexEntries.length} scenes ` +
        `(scope=${profileScope}, useCos=${useCos})`,
      );
    }
  } catch {
    logger?.debug?.(`${TAG} No scene index found`);
  }
  const tSceneEnd = performance.now();

  if (memoryLines.length === 0 && !personaContent && !sceneNavigation) {
    const totalMs = performance.now() - tRecallStart;
    logger?.info(
      `${TAG} ⏱ Recall timing: total=${totalMs.toFixed(0)}ms, ` +
      `search=${(tSearchEnd - tSearchStart).toFixed(0)}ms(strategy=${effectiveStrategy},hits=${memoryLines.length},` +
      `fts=${searchTiming.ftsMs.toFixed(0)}ms/${searchTiming.ftsHits}hits,` +
      `vec=${searchTiming.embeddingMs.toFixed(0)}ms/${searchTiming.embeddingHits}hits), ` +
      `persona=${(tPersonaEnd - tPersonaStart).toFixed(0)}ms, ` +
      `scene=${(tSceneEnd - tSceneStart).toFixed(0)}ms — no context to inject`,
    );
    logger?.debug?.(`${TAG} No memories/persona/scenes to inject`);
    return undefined;
  }

  // Split recall context into stable and dynamic parts to optimize prompt caching.
  //
  // appendSystemContext (system prompt end — stable, cacheable):
  //   persona, scene navigation, memory tools guide
  //   These change infrequently; when content is identical across turns,
  //   providers with prompt caching (Anthropic/OpenAI) can cache this region.
  //
  // prependContext (user prompt prefix — dynamic, per-turn):
  //   L1 relevant memories — different every turn, moved out of system prompt
  //   so it doesn't bust the system prompt cache.
  const stableParts: string[] = [];
  if (personaContent) {
    stableParts.push(`<user-persona>\n${personaContent}\n</user-persona>`);
  }
  if (sceneNavigation) {
    stableParts.push(`<scene-navigation>\n${sceneNavigation}\n</scene-navigation>`);
  }

  // Dynamic part: L1 relevant memories (changes every turn) → prependContext (user prompt)
  // DS-RECALL-MERGE-001：注入块构建（含 T15-C 降级标注）已平移进 performLayeredRecall
  // （钩子与端点共用同一实现），此处直接取共享产出——逐位一致。
  const prependContext = layeredOutcome.block;

  // Append memory tools usage guide to the stable part so the agent knows
  // how to actively retrieve deeper context when the injected snippets
  // are not enough. This is static content and benefits from caching.
  if (stableParts.length > 0 || prependContext) {
    stableParts.push(MEMORY_TOOLS_GUIDE);
  }

  const appendSystemContext = stableParts.length > 0 ? stableParts.join("\n\n") : undefined;

  const totalMs = performance.now() - tRecallStart;
  logger?.info(
    `${TAG} ⏱ Recall timing: total=${totalMs.toFixed(0)}ms, ` +
    `search=${(tSearchEnd - tSearchStart).toFixed(0)}ms(strategy=${effectiveStrategy},hits=${memoryLines.length},` +
    `fts=${searchTiming.ftsMs.toFixed(0)}ms/${searchTiming.ftsHits}hits,` +
    `vec=${searchTiming.embeddingMs.toFixed(0)}ms/${searchTiming.embeddingHits}hits), ` +
    `persona=${(tPersonaEnd - tPersonaStart).toFixed(0)}ms(${personaContent ? `${personaContent.length}chars` : "none"}), ` +
    `scene=${(tSceneEnd - tSceneStart).toFixed(0)}ms(${sceneNavigation ? "loaded" : "none"})`,
  );

  if (!appendSystemContext && !prependContext) {
    return undefined;
  }

  return {
    prependContext,
    appendSystemContext,
    recalledL1Memories,
    recalledL3Persona: personaContent ?? null,
    recallStrategy: effectiveStrategy,
  };
}

/**
 * H-15 wrapper: catches errors from performAutoRecallCore and translates them
 * into a structured RecallResult with `error` populated.
 *
 * Contract: this function never throws. Callers can rely on:
 *   - returns RecallResult (possibly with `error` field) — failure with structured info
 *   - returns RecallResult (without `error` field)        — success with content
 *   - returns undefined                                   — success with nothing to inject
 *
 * The hook layer (performAutoRecall) further normalizes timeout into RecallResult.error.
 */
async function performAutoRecallInner(params: {
  userText: string;
  actorId: string;
  sessionKey: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  storage?: StorageAdapter;
  profileIsolation?: ProfileIsolation;
}): Promise<RecallResult | undefined> {
  try {
    return await performAutoRecallCore(params);
  } catch (err) {
    const fail = toRecallFailure(err);
    const re = fail.recallError;
    // Always log at warn; for internal errors, also dump the cause at error level
    // to make root-cause investigation possible.
    params.logger?.warn?.(
      `${TAG} recall failed: code=${re.code} category=${re.category} msg="${re.message}"`,
    );
    if (re.category === "internal" && fail.cause) {
      const causeStr = fail.cause instanceof Error
        ? (fail.cause.stack ?? fail.cause.message)
        : String(fail.cause);
      params.logger?.error?.(`${TAG} unexpected recall error cause: ${causeStr}`);
    }
    return {
      prependContext: "",
      appendSystemContext: "",
      recalledL1Memories: [],
      recalledL3Persona: null,
      recallStrategy: undefined,
      error: re,
      partial: false,
    };
  }
}

// ============================
// Multi-strategy search dispatcher
// ============================

/**
 * C5/R-A1：读当前租户价值锚并算本轮 query 的 appraisal fired labels + moodSign
 *（每次 recall 至多一次）。与工具侧 executeMemorySearch 同形（R-A1 起统一走
 * recall-signals.buildRankContext——fired 判定/valence 并入/moodSign 单一源）；
 * 租户上下文差异：auto-recall 无 requestIsolation /
 * IsolationFilter（L1 召回本就是全局路径），仅有 L2/L3 profileIsolation {teamId,
 * agentId}——生产调用方（tdai-core.handleBeforeRecall）不传 → default 桶，与
 * 工具侧 isolationFilter 缺省（→ default 桶）自洽。best-effort：store 无 listValues /
 * 读失败 → 空 labels + moodSign 0（coreRefBoost/mood 静默关闭，零影响）。
 */
async function computeRecallValueSignals(
  userText: string,
  vectorStore: IMemoryStore,
  profileIsolation?: ProfileIsolation,
  logger?: Logger,
): Promise<{ firedLabels: string[]; moodSign: number }> {
  try {
    const listValues = vectorStore.listValues;
    if (typeof listValues !== "function") return { firedLabels: [], moodSign: 0 };
    const tenant: CoreTenant = normalizeCoreTenant({
      teamId: profileIsolation?.teamId ?? "",
      userId: "",
      agentId: profileIsolation?.agentId ?? "",
    });
    const rows = await listValues.call(vectorStore, tenant);
    const ctx = await buildRankContext(userText, [], {
      readValues: () =>
        ((rows ?? []) as unknown as ValueRowLike[]).filter(
          (v) => v && typeof v.label === "string" && v.label.trim(),
        ),
    });
    return { firedLabels: ctx.firedLabels, moodSign: ctx.moodSign };
  } catch (err) {
    logger?.warn?.(
      `${TAG} coreRef values unavailable (non-fatal, coreRefBoost skipped): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { firedLabels: [], moodSign: 0 };
  }
}

interface ScoredRecord {
  record: MemoryRecord;
  score: number;
  /** R-A1：行原始 soul 字段 + metadata（L1FtsResult 透传，供结构信号消费）。 */
  soul?: RankSignalItem;
}

/** V2-3：mergedMap 值形状（V2-3 起携带 coreRefCount/recallCount 供组合分精排/探索位消费）。 */
interface MergedPoolValue {
  rrfScore: number;
  formatable: FormatableMemory;
  coreRefHit: number;
  signal: number;
  mult: number;
  /** GROW-EVO P1：重巩固白名单 observed-only（工具路红线同款）需要 certainty 随池携带。 */
  certainty?: string;
  /** GROW-EVO P2（§2.3）：失效排除需要 valid_end 随池携带。 */
  validEnd?: string;
  channel?: string;
  coreRefCount: number;
  recallCount: number;
}

/** Timing breakdown from memory search（DS-RECALL-MERGE-001：随 LayeredRecallOutcome 导出） */
export interface SearchTiming {
  ftsMs: number;
  embeddingMs: number;
  ftsHits: number;
  embeddingHits: number;
}

interface SearchResult {
  lines: string[];
  timing: SearchTiming;
  /** Per-line similarity scores (parallel to `lines`). Only populated on TCVDB nativeHybridSearch path. */
  scores?: number[];
}

/**
 * Search memories and return both formatted lines and structured details.
 *
 * This is a thin wrapper around `searchMemories` that also captures
 * the recalled memory metadata for metric reporting (agent_turn event).
 * It parses the returned formatted lines to extract type/content info.
 */
async function searchMemoriesWithDetails(
  userText: string,
  pluginDataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  strategy: "keyword" | "embedding" | "hybrid",
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<{ lines: string[]; memories: RecalledMemory[]; timing: SearchTiming }> {
  const result = await searchMemories(userText, pluginDataDir, cfg, logger, strategy, vectorStore, embeddingService);

  // Extract structured data from formatted memory lines.
  // Format: "- [type|scene] content (活动时间: ...)" or "- [type] content"
  const memories: RecalledMemory[] = result.lines.map((line, i) => {
    const match = line.match(MEMORY_LINE_RE);
    if (match) {
      const tag = match[1];
      const content = match[2].trim();
      const typePart = tag.includes("|") ? tag.split("|")[0] : tag;
      return { content, score: result.scores?.[i] ?? 0, type: typePart };
    }
    return { content: line, score: result.scores?.[i] ?? 0, type: "unknown" };
  });

  return { lines: result.lines, memories, timing: result.timing };
}

/**
 * Search memories using the configured strategy.
 *
 * - "keyword": JSONL keyword-based (Jaccard similarity) — no embedding needed
 * - "embedding": VectorStore cosine similarity — requires vectorStore + embeddingService
 * - "hybrid": merge both keyword and embedding results with RRF (Reciprocal Rank Fusion)
 *
 * Falls back to keyword if embedding resources are unavailable.
 */
async function searchMemories(
  userText: string,
  pluginDataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  strategy: "keyword" | "embedding" | "hybrid",
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
  /** C5/R-A1：排序信号（仅 hybrid 消费——唯一存在 rankKey 合并排序的策略）。 */
  rank?: RecallRankSignal,
  /** R7（分层召回）：L2 结论层上下文（防重排除 + R7-2 scene 反查源）；缺省 = 现状。 */
  layered?: R7LayeredContext,
  /**
   * DS-RECALL-MERGE-001：租户收窄 filter（可选）。钩子路不传（undefined = 旧行为逐位）；
   * /v3/recall 端点传请求三元组（与 /v3/atomic/search 的 handleAtomicSearch 同形）。
   * 仅收窄候选集（store 层 IsolationFilter 既有能力），不改打分/门槛/RRF/字典序。
   */
  isolationFilter?: IsolationFilter,
): Promise<SearchResult> {
  const emptyResult: SearchResult = { lines: [], timing: { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 } };
  // Strip gateway-injected inbound metadata (Sender, timestamps, media markers,
  // base64 image data, etc.) so FTS / embedding queries are based on pure user intent.
  const cleanText = sanitizeText(userText);

  if (cleanText.length < 2) {
    logger?.debug?.(`${TAG} Query too short for memory search (raw=${userText.length}, clean=${cleanText.length})`);
    return emptyResult;
  }

  if (cleanText.length !== userText.length) {
    logger?.debug?.(
      `${TAG} userText sanitized: ${userText.length} → ${cleanText.length} chars`,
    );
  }

  const maxResults = cfg.recall.maxResults ?? 5;
  const threshold = cfg.recall.scoreThreshold ?? 0.3;

  const embeddingAvailable = !!vectorStore && !!embeddingService;

  logger?.debug?.(
    `${TAG} [searchMemories] strategy=${strategy}, embeddingAvailable=${embeddingAvailable}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}, ` +
    `maxResults=${maxResults}, threshold=${threshold}`,
  );

  // Determine effective strategy — no degradation: if embedding is configured but unavailable, fail
  let effectiveStrategy = strategy;
  if ((strategy === "embedding" || strategy === "hybrid") && !embeddingAvailable) {
    // H-15: throw structured RecallFailure so the top-level catch in
    // performAutoRecallInner can translate it into RecallResult.error
    // (preserves fast-fail semantics + observability while keeping the
    // hook contract "always resolves, never rejects").
    throw RecallErrors.configMissingEmbedding(strategy);
  }

  logger?.debug?.(`${TAG} Search strategy: ${effectiveStrategy} (configured: ${strategy})`);

  // Resolve per-call embedding timeout for recall path.
  // Falls back to global embedding.timeoutMs when recallTimeoutMs is not configured.
  const recallEmbeddingTimeoutMs = cfg.embedding?.recallTimeoutMs ?? cfg.embedding?.timeoutMs;
  const embeddingCallOpts: EmbeddingCallOptions = { timeoutMs: recallEmbeddingTimeoutMs };
  // R-A3（E1）：query embedding TTL 缓存（cfg.recall.queryEmbeddingCacheTtlMs，默认 60s，<=0 关）
  const embedCacheTtlMs = cfg.recall?.queryEmbeddingCacheTtlMs ?? 60_000;

  try {
    // ── V2-2（引擎一 查询自动扩展 spec E1.1-E1.3）：LLM 语义邻域扩展——惰性 memo：
    // 仅 FTS 路消费（keyword/hybrid 关键词侧）；embedding 路 / native-hybrid 单调用路
    // 无本地 FTS 构建点 → 零 LLM 调用（E1.3 向量路不动）。失败/超时 → []（E1.4 退化）。
    let expansionTermsCache: string[] | null = null;
    const getExpansionTerms = async (): Promise<string[]> => {
      if (expansionTermsCache) return expansionTermsCache;
      const qeCfg = cfg.recall?.queryExpansion;
      if (!qeCfg?.enabled) return (expansionTermsCache = []);
      const qeRunner = await resolveQueryExpansionRunner(
        cfg.llm,
        (cfg as { instanceId?: string }).instanceId,
        logger,
      );
      // 运行期预算 clamp（E1.4 失败安全优先）：recall 有整体 timeoutMs（默认 5000），
      // 扩展外呼若超出预算会触发整体超时（注入全空，比无扩展更糟）。config 默认 8000
      // 保留给无外层预算的工具路；auto-recall 路 clamp 到 召回预算-1s（至少 1s），留出
      // 真实检索时间。clamp 生效记 debug（配置与真实行为一致性，可追溯）。
      const recallBudget = cfg.recall?.timeoutMs ?? 5000;
      const timeoutMs = Math.min(qeCfg.timeoutMs, Math.max(1000, recallBudget - 1000));
      if (timeoutMs !== qeCfg.timeoutMs) {
        logger?.debug?.(`${TAG} [query-expand] timeoutMs clamped into recall budget: ${qeCfg.timeoutMs} → ${timeoutMs}ms`);
      }
      expansionTermsCache = await expandQuery(cleanText, qeRunner, {
        maxTerms: qeCfg.maxTerms,
        ttlMs: qeCfg.ttlMs,
        timeoutMs,
        logger,
      });
      return expansionTermsCache;
    };

    if (effectiveStrategy === "keyword") {
      const tFts = performance.now();
      const lines = await searchByKeyword(cleanText, pluginDataDir, maxResults, threshold, logger, vectorStore, layered, await getExpansionTerms(), isolationFilter);
      return { lines, timing: { ftsMs: performance.now() - tFts, embeddingMs: 0, ftsHits: lines.length, embeddingHits: 0 } };
    }

    if (effectiveStrategy === "embedding") {
      const tEmb = performance.now();
      const lines = await searchByEmbedding(cleanText, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts, embedCacheTtlMs, layered, isolationFilter);
      return { lines, timing: { ftsMs: 0, embeddingMs: performance.now() - tEmb, ftsHits: 0, embeddingHits: lines.length } };
    }

    // Hybrid: if the store natively supports hybrid search (e.g. TCVDB does
    // server-side dense + sparse + RRF in a single API call), short-circuit
    // to avoid a redundant second HTTP request and a wasted local embed().
    if (vectorStore?.getCapabilities().nativeHybridSearch) {
      const tNative = performance.now();
      // R7-1：结论层已收编的记录从经验层排除（防重——命中已存不重组）
      const excludeIds = layered && layered.excludeIds.length > 0 ? new Set(layered.excludeIds) : null;
      // DS-RECALL-MERGE-001：filter 透传（isolationFilter 缺省 = 旧行为逐位）
      const results = (((await vectorStore.searchL1Hybrid?.({
        query: cleanText,
        topK: maxResults,
        ...(isolationFilter ? { filter: isolationFilter } : {}),
      })) ?? []) as L1SearchResult[]).filter((r) => !excludeIds || !excludeIds.has(r.record_id));
      const nativeMs = performance.now() - tNative;
      logger?.debug?.(`${TAG} [hybrid-native] Single-call hybrid: ${results.length} results in ${nativeMs.toFixed(0)}ms`);
      const lines = results.map((r) => formatMemoryLine(vectorResultToFormatable(r)));
      const scores = results.map((r) => r.score);
      return { lines, scores, timing: { ftsMs: 0, embeddingMs: nativeMs, ftsHits: 0, embeddingHits: results.length } };
    }

    // Fallback: run keyword + embedding in parallel, merge with client-side RRF (SQLite path)
    return await searchHybrid(
      cleanText, pluginDataDir, maxResults, threshold, vectorStore!, embeddingService!, logger,
      embeddingCallOpts, rank, embedCacheTtlMs, layered, await getExpansionTerms(),
      // V2-3（引擎三）：探索位 + 组合分精排（config 透传——缺省默认开/均等权重）
      cfg.recall?.exploreSlot !== false, cfg.recall?.rerankWeights,
      // DS-RECALL-MERGE-001：租户收窄 filter（钩子路缺省 undefined = 旧行为逐位）
      isolationFilter,
      // GROW-EVO P2（§2.3）：失效排除开关（cfg 透传——缺省 true）
      cfg.recall?.excludeInvalidated,
    );
  } catch (err) {
    logger?.warn?.(`${TAG} Memory search failed (strategy=${effectiveStrategy}): ${err instanceof Error ? err.message : String(err)}`);
    return emptyResult;
  }
}

// ============================
// Strategy: Keyword (FTS5 BM25, no in-memory fallback)
// ============================

async function searchByKeyword(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  threshold: number,
  logger?: Logger,
  vectorStore?: IMemoryStore,
  /** R7-1：结论层已收编 ids（经验层防重排除）；缺省 = 现状。 */
  layered?: R7LayeredContext,
  /**
   * V2-2（引擎一 E1.3）：查询扩展词（expandQuery 产物；缺省/空 = 原 query 逐位）。
   * 仅并入 FTS MATCH（词面足迹 widening）；调用方（searchMemories）memo 化保证
   * 每轮至多一次 LLM 外呼，TTL 缓存在 query-expand 模块内（两路同进程同缓存）。
   */
  expansionTerms?: readonly string[],
  /** DS-RECALL-MERGE-001：租户收窄 filter（缺省 undefined = 钩子路旧行为逐位）。 */
  isolationFilter?: IsolationFilter,
): Promise<string[]> {
  // R7-1 防重排除集（空 = 零开销恒等）
  const excludeIds = layered && layered.excludeIds.length > 0 ? new Set(layered.excludeIds) : null;
  // Prefer FTS5 if available
  if (vectorStore?.isFtsAvailable()) {
    // V2-2（E1.3）：扩展词 OR 并入 MATCH（原词在前）；无扩展 → 逐位原 ftsQuery。
    const ftsQuery = mergeFtsQueryWithExpansion(buildFtsQuery(userText), expansionTerms);
    if (ftsQuery) {
      logger?.debug?.(`${TAG} [keyword-fts] Using FTS5 BM25 search: query="${ftsQuery}"`);
      const ftsResults = await vectorStore.searchL1Fts(ftsQuery, maxResults * 2, isolationFilter);
      if (ftsResults.length > 0) {
        logger?.debug?.(
          `${TAG} [keyword-fts] FTS5 raw results (${ftsResults.length}): ` +
          ftsResults.map((r) => `id=${r.record_id} score=${r.score.toFixed(6)}`).join(", "),
        );
        const filtered = ftsResults
          .filter((r) => !excludeIds || !excludeIds.has(r.record_id))
          .filter((r) => r.score >= threshold)
          .slice(0, maxResults);

        if (filtered.length > 0) {
          logger?.debug?.(`${TAG} [keyword-fts] FTS5 found ${filtered.length} results (from ${ftsResults.length} raw, threshold=${threshold})`);
          return filtered.map((r) => formatMemoryLine(ftsResultToFormatable(r)));
        }

        // BM25 absolute scores are unreliable when the document set is very
        // small (e.g. 1–3 records) because IDF approaches 0.  In that case,
        // trust FTS5's MATCH + rank ordering and return the top results anyway.
        if (ftsResults.length <= maxResults) {
          logger?.debug?.(
            `${TAG} [keyword-fts] All ${ftsResults.length} results below threshold=${threshold} ` +
            `but document set is small — returning all matched results`,
          );
          return ftsResults
            .filter((r) => !excludeIds || !excludeIds.has(r.record_id))
            .slice(0, maxResults).map((r) => formatMemoryLine(ftsResultToFormatable(r)));
        }
        logger?.debug?.(`${TAG} [keyword-fts] FTS5 returned 0 results above threshold (from ${ftsResults.length} raw)`);
      }
    }
  }

  // FTS5 not available or returned no results — skip in-memory fallback to avoid O(N) full scan
  logger?.debug?.(`${TAG} [keyword] FTS5 unavailable or no results, skipping keyword search`);
  return [];
}

// ============================
// Strategy: Embedding (VectorStore cosine)
// ============================

async function searchByEmbedding(
  userText: string,
  maxResults: number,
  threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
  /** R-A3（E1）：query embedding TTL 缓存毫秒（缺省 0 = 不缓存——兼容旧调用方）。 */
  embedCacheTtlMs?: number,
  /** R7-1：结论层已收编 ids（经验层防重排除）；缺省 = 现状。 */
  layered?: R7LayeredContext,
  /** DS-RECALL-MERGE-001：租户收窄 filter（缺省 undefined = 钩子路旧行为逐位）。 */
  isolationFilter?: IsolationFilter,
): Promise<string[]> {
  logger?.debug?.(
    `${TAG} [embedding-search] START query="${userText.slice(0, 80)}...", maxResults=${maxResults}, threshold=${threshold}`,
  );
  const queryEmbedding = await cachedQueryEmbedding(embeddingService, userText, embedCacheTtlMs ?? 0, logger, embeddingCallOpts);
  logger?.debug?.(
    `${TAG} [embedding-search] Query embedding OK: dims=${queryEmbedding.length}, ` +
    `norm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}, ` +
    `searching top-${maxResults * 2}...`,
  );
  // Retrieve more candidates for subsequent filtering
  // R7-1：结论层已收编的记录从经验层排除（防重——命中已存不重组）
  const excludeIds = layered && layered.excludeIds.length > 0 ? new Set(layered.excludeIds) : null;
  const vecResults: L1SearchResult[] = ((await vectorStore.searchL1Vector(queryEmbedding, maxResults * 2, undefined, isolationFilter)) ?? []).filter((r) => !excludeIds || !excludeIds.has(r.record_id));

  if (vecResults.length === 0) {
    logger?.debug?.(`${TAG} [embedding-search] Returned 0 results`);
    return [];
  }

  logger?.debug?.(`${TAG} [embedding-search] Got ${vecResults.length} candidates, filtering by threshold=${threshold}`);
  for (const r of vecResults) {
    logger?.debug?.(
      `${TAG} [embedding-search] candidate id=${r.record_id}, score=${r.score.toFixed(4)}, ` +
      `type=${r.type}, content="${r.content.slice(0, 60)}..."`,
    );
  }

  const filtered = vecResults
    .filter((r) => r.score >= threshold)
    .slice(0, maxResults);

  if (filtered.length > 0) {
    logger?.debug?.(`${TAG} [embedding-search] Found ${filtered.length} relevant memories above threshold (from ${vecResults.length} candidates)`);
    return filtered.map((r) => formatMemoryLine(vectorResultToFormatable(r)));
  }

  logger?.debug?.(`${TAG} [embedding-search] No results above threshold ${threshold}`);
  return [];
}

// ============================
// Strategy: Hybrid (Keyword + Embedding + RRF)
// ============================

/**
 * Hybrid search: run keyword (FTS5) and embedding in parallel, merge with
 * Reciprocal Rank Fusion (RRF) to combine rank lists.
 *
 * RRF score for a record at rank r = 1 / (k + r), where k=60 is a constant.
 * If a record appears in both lists, its RRF scores are summed.
 *
 * If FTS5 is unavailable, the keyword side returns empty and RRF uses
 * embedding results only.
 */
export async function searchHybrid(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
  /**
   * C5/R-A1（C1 拍板①后续项）：排序信号（可选；缺省/undefined = 旧行为零加成）。
   * 复用工具侧同一 resolveCoreRefBoost 与 memory.recall.coreRefBoost 常量——命中
   * 当前 appraisal 价值 ∧ 记忆 metadata.coreRefs 含之 → RRF rankKey +boost。
   * R-A1 起同层追加 R1/R2/R3/R8/R9 结构信号（structuralSignalOf + inferred 乘法），
   * 与工具侧 applyCoreRefTiebreak 同族加成（C5 教训：两排序点必须同层对齐）。
   * 仅排序（同层内位次），不改门槛、不越 work_fact 分层；行形状已穷举确认：
   * L1FtsResult / L1SearchResult 均带 metadata_json + soul 字段（R-A1 报告前节）。
   * 兼容（verify-s5 回归抓到的缺口）：旧调用方传入 C5 形状（仅 boost+firedLabels）
   * 时归一化为"结构信号全 0"——旧行为零变化；完整 RecallRankSignal 才消费
   * R1/R2/R3/R8/R9。归一化路径同样不跳过排序（f53b173 教训）。
   */
  rank?: RecallCoreRefSignal | RecallRankSignal,
  /** R-A3（E1）：query embedding TTL 缓存毫秒（缺省 0 = 不缓存——兼容旧调用方）。 */
  embedCacheTtlMs?: number,
  /**
   * R7（分层召回 spec DS-RECALL-LAYERED-R7-001）：L2 结论层上下文（缺省/undefined =
   * 现状逐位一致）。R7-1：excludeIds（结论已收编 → 经验层防重排除）；R7-2：
   * conclusionRefs/sceneNames（scene 反查补池——part_of 证据链优先 + 同 scene 过滤）。
   */
  layered?: R7LayeredContext,
  /**
   * V2-2（引擎一 E1.3）：查询扩展词（expandQuery 产物；缺省/空 = 原 query 逐位）。
   * 仅并入关键词侧 FTS MATCH（原词在前）；embedding 侧保持原 query（语义相似已处理改写）。
   */
  expansionTerms?: readonly string[],
  /**
   * V2-3（引擎三 E3.1）：探索位开关（缺省 true——config 默认开；false = 通道退出）。
   */
  exploreSlot?: boolean,
  /**
   * RV2-2（精排重设计）：组合分四因子权重（relevance/timeProx/significance/coreRef，
   * 默认 0.7/0.15/0.1/0.05——相关度主导；全 0 = 关断恒等；relevance=0 = 纯时间/显著
   * 排序，预期行为变更已登记）。
   */
  rerankWeights?: CompositeWeights,
  /**
   * DS-RECALL-MERGE-001：租户收窄 filter（缺省 undefined = 钩子路旧行为逐位）。
   * 透传到 store 层 IsolationFilter 家族调用（FTS/向量/图邻居/补池反查），与
   * /v3/atomic/search 工具路同形；不改打分/门槛/RRF/字典序。
   */
  isolationFilter?: IsolationFilter,
  /**
   * GROW-EVO P2（§2.3）：失效排除开关（缺省 true = spec 拍板①；false = 通道退出）。
   * 由 searchMemories 自 cfg.recall.excludeInvalidated 透传。
   */
  excludeInvalidated?: boolean,
): Promise<SearchResult> {
  // R-A1 形状归一化：C5 旧形状 → 结构信号全 0（与改动前行为逐位一致）
  const rankSignal: RecallRankSignal | undefined = rank
    ? {
        boost: rank.boost,
        firedLabels: rank.firedLabels,
        moodSign: (rank as RecallRankSignal).moodSign ?? 0,
        timeWindow: (rank as RecallRankSignal).timeWindow ?? null,
        signals: (rank as RecallRankSignal).signals ?? ZERO_RANK_SIGNALS,
        now: (rank as RecallRankSignal).now ?? new Date(),
        // R-A2：候选池通道（缺省 = 通道退出——legacy C5 形状不带 graph/sceneBoost）
        graph: (rank as RecallRankSignal).graph,
        sceneBoost: (rank as RecallRankSignal).sceneBoost ?? 0,
      }
    : undefined;
  // Run keyword and embedding searches in parallel
  const candidateK = maxResults * 3; // retrieve more for merging

  const [keywordResult, embeddingResult] = await Promise.all([
    // Keyword search: FTS5 only (no in-memory fallback)
    (async () => {
      const tStart = performance.now();
      try {
        // Try FTS5 first
        if (vectorStore.isFtsAvailable()) {
          // V2-2（E1.3）：扩展词 OR 并入 MATCH（原词在前）；无扩展 → 逐位原 ftsQuery。
          const ftsQuery = mergeFtsQueryWithExpansion(buildFtsQuery(userText), expansionTerms);
          if (ftsQuery) {
            const ftsResults = await vectorStore.searchL1Fts(ftsQuery, candidateK, isolationFilter);
            if (ftsResults.length > 0) {
              logger?.debug?.(`${TAG} [hybrid-keyword-fts] FTS5 found ${ftsResults.length} candidates`);
              // Convert FtsSearchResult to ScoredRecord for RRF merge
              const records = ftsResults.map((r): ScoredRecord => {
                const metadata: Record<string, unknown> = r.metadata_json
                  ? (() => { try { return JSON.parse(r.metadata_json) as Record<string, unknown>; } catch { return {}; } })()
                  : {};
                return {
                  record: {
                    id: r.record_id,
                    content: r.content,
                    type: r.type as MemoryRecord["type"],
                    priority: r.priority,
                    scene_name: r.scene_name,
                    source_message_ids: [],
                    metadata,
                    timestamps: [r.timestamp_str].filter(Boolean),
                    createdAt: "",
                    updatedAt: "",
                    sessionKey: r.session_key,
                    sessionId: r.session_id,
                  },
                  score: r.score,
                  // R-A1：soul 字段透传（recordToFormatable 不带 soul——信号源单独携带）
                  soul: {
                    occurred_at: r.occurred_at,
                    valid_start: r.valid_start,
                    valid_end: r.valid_end,
                    certainty: r.certainty,
                    valence: r.valence,
                    significance: r.significance,
                    metadata,
                  },
                };
              });
              return { records, ms: performance.now() - tStart };
            }
          }
        }
        // FTS5 not available or returned no results — skip in-memory fallback
        logger?.debug?.(`${TAG} [hybrid-keyword] FTS5 unavailable or no results, skipping keyword part`);
        return { records: [] as ScoredRecord[], ms: performance.now() - tStart };
      } catch (err) {
        logger?.warn?.(`${TAG} Hybrid: keyword part failed: ${err instanceof Error ? err.message : String(err)}`);
        return { records: [] as ScoredRecord[], ms: performance.now() - tStart };
      }
    })(),
    // Embedding search
    (async () => {
      const tStart = performance.now();
      try {
        logger?.debug?.(`${TAG} [hybrid-embedding] Generating query embedding...`);
        const queryEmbedding = await cachedQueryEmbedding(embeddingService, userText, embedCacheTtlMs ?? 0, logger, embeddingCallOpts);
        logger?.debug?.(
          `${TAG} [hybrid-embedding] Embedding OK, dims=${queryEmbedding.length}, searching top-${candidateK}...`,
        );
        const results = await vectorStore.searchL1Vector(queryEmbedding, candidateK, userText, isolationFilter);
        logger?.debug?.(`${TAG} [hybrid-embedding] Got ${results.length} candidates`);
        return { results, ms: performance.now() - tStart };
      } catch (err) {
        logger?.warn?.(`${TAG} Hybrid: embedding part failed: ${err instanceof Error ? err.message : String(err)}`);
        return { results: [] as L1SearchResult[], ms: performance.now() - tStart };
      }
    })(),
  ]);

  const keywordResults = keywordResult.records;
  // L1 向量分是 cosine（0–1，绝对可比）：低于阈值（scoreThreshold，默认 0.3）的候选
  // 不进 RRF 融合——修掉"排名即注入"（原 `_threshold` 被忽略、低相关也进）。宁缺毋滥。
  const embeddingResults = embeddingResult.results.filter((r) => r.score >= threshold);

  // C5：coreRef 排序加成预处理（fired 空 / boost≤0 → 恒 0，零开销路径）
  const coreRefActive = !!rankSignal && rankSignal.boost > 0 && rankSignal.firedLabels.length > 0;
  /** metadata_json 宽松解析（容忍损坏 → {}，不造假值）——C5 coreRefs 读取。 */
  const parseMetadataJson = (json: string | undefined | null): Record<string, unknown> => {
    if (!json) return {};
    try {
      const parsed = JSON.parse(json) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const coreRefHitOf = (metadata: Record<string, unknown> | undefined): number =>
    coreRefActive && metadata
      ? resolveCoreRefBoost({ metadata }, rankSignal!.firedLabels, rankSignal!.boost)
      : 0;
  // R-A1：结构信号预处理（rankSignal 缺席 = 纯基线；在场但全 0 = 关断恒等）
  const signalCtx = rankSignal
    ? { timeWindow: rankSignal.timeWindow, moodSign: rankSignal.moodSign, signals: rankSignal.signals, now: rankSignal.now }
    : undefined;
  const structOf = (src: RankSignalItem | undefined): { signal: number; mult: number } =>
    signalCtx && src
      ? {
          signal: structuralSignalOf(src, signalCtx),
          mult: certaintyMultiplierOf(src, signalCtx.signals.inferredPenalty),
        }
      : { signal: 0, mult: 1 };

  const timing: SearchTiming = {
    ftsMs: keywordResult.ms,
    embeddingMs: embeddingResult.ms,
    ftsHits: keywordResults.length,
    embeddingHits: embeddingResults.length,
  };

  if (keywordResults.length === 0 && embeddingResults.length === 0) {
    logger?.debug?.(`${TAG} Hybrid search: both strategies returned 0 results`);
    return { lines: [], timing };
  }

  // RRF merge: k=60 is a standard constant from the RRF paper
  // RRF K=60：Cormack et al. (2009) 原论文标准常数——协议不变量，硬编码不配置化（GOLD-EVO 判定 2026-09-15）
  const RRF_K = 60;

  // Map: record_id → MergedPoolValue（V2-3：coreRefCount/recallCount 供组合分精排/探索位消费）
  const mergedMap = new Map<string, MergedPoolValue>();
  /** V2-3：coreRef 命中数 = metadata.coreRefs ∩ fired（fired 空 → 0，宁缺毋滥）。 */
  const coreRefCountOf = (metadata: Record<string, unknown> | undefined): number => {
    if (!rankSignal || rankSignal.firedLabels.length === 0 || !metadata) return 0;
    const refs = Array.isArray(metadata.coreRefs) ? metadata.coreRefs : [];
    return refs.filter((s): s is string => typeof s === "string" && rankSignal!.firedLabels.includes(s)).length;
  };
  /** V2-3：recall_count 读取（缺失/非法 → 0——探索位中位数与组合分同口径）。 */
  const recallCountOf = (metadata: Record<string, unknown> | undefined): number => {
    const c = metadata?.recall_count;
    return typeof c === "number" && Number.isFinite(c) && c > 0 ? c : 0;
  };

  // Process keyword results
  for (let rank0 = 0; rank0 < keywordResults.length; rank0++) {
    const r = keywordResults[rank0];
    const id = r.record.id;
    const rrfScore = 1 / (RRF_K + rank0 + 1);
    const { signal, mult } = structOf(r.soul);
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      const kwMeta = (r.record.metadata ?? {}) as Record<string, unknown>;
      mergedMap.set(id, {
        rrfScore,
        certainty: (r.soul as { certainty?: string } | undefined)?.certainty,
        validEnd: (r.soul as { valid_end?: string } | undefined)?.valid_end,
        formatable: recordToFormatable(r.record),
        coreRefHit: coreRefHitOf(r.record.metadata as Record<string, unknown> | undefined),
        signal,
        mult,
        coreRefCount: coreRefCountOf(kwMeta),
        recallCount: recallCountOf(kwMeta),
      });
    }
  }

  // Process embedding results
  for (let rank1 = 0; rank1 < embeddingResults.length; rank1++) {
    const r = embeddingResults[rank1];
    const id = r.record_id;
    const rrfScore = 1 / (RRF_K + rank1 + 1);
    // L1SearchResult 的 metadata 是 metadata_json 字符串——解析后并入信号源
    //（R1 时近性/R8 强化读 metadata.last_recalled_at/recall_count）
    const embMeta = parseMetadataJson(r.metadata_json);
    const { signal, mult } = structOf({
      occurred_at: r.occurred_at,
      valid_start: r.valid_start,
      valid_end: r.valid_end,
      certainty: r.certainty,
      valence: r.valence,
      significance: r.significance,
      metadata: embMeta,
    });
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      mergedMap.set(id, {
        rrfScore,
        certainty: r.certainty,
        validEnd: r.valid_end,
        formatable: vectorResultToFormatable(r),
        coreRefHit: coreRefHitOf(embMeta),
        signal,
        mult,
        coreRefCount: coreRefCountOf(embMeta),
        recallCount: recallCountOf(embMeta),
      });
    }
  }

  // Sort by combined RRF score and take top results
  // ── 重构式回忆（J 设计§5）：双召回线统一——持续态(work_fact)优先（稳定结论 > 零碎点），
  //    同层内仍按 RRF score 排序。与工具侧 formatSearchResponse 的持续态优先对齐。 ──
  // ── R-A2（R6 场景路由）：sceneHit 在候选池（mergedMap）就绪后按池内 scene_name
  // 计算（与工具侧同一 detectSceneHit 实现，单一源）；sceneBoost=0 → null（零开销）。 ──
  const sceneBoostVal = rankSignal?.sceneBoost ?? 0;
  const sceneHit = sceneBoostVal > 0
    ? detectSceneHit(userText, [...mergedMap.values()].map((v) => v.formatable.scene_name))
    : null;
  // ── 排序三刀语义对齐（2026-09-12，5fc7962 工具侧同构）：主序 = 纯 RRF 相关度证据
  //    （score 严格优先——相邻名次差 ~2.8e-4 不可被信号和（可达 ~6e-4）翻越，q9 病灶
  //    同构消除）；coreRefHit / scene / signal / mult（R3 确定性）降为精确平局组内次级
  //    判据（无 epsilon——RRF 1/(60+k) 整数名次保证同名次逐位相等，平局真实存在）。
  //    关断恒等口径更新：信号全 0 → 序 = work_fact 分层 + 纯 rrfScore。两项预期行为变更
  //    登记：①加法混排→字典序（与工具侧三刀同构）；②R3 certainty 从跨档乘法降为平局
  //    组内旗标（mult 仅平局组内生效，与工具侧 R3 平移一致）。 ──
  const sceneSignalOfEntry = (v: FormatableMemory) => sceneSignalOf(v, sceneHit, sceneBoostVal);
  const compareLex = (
    a: { rrfScore: number; coreRefHit: number; signal: number; mult: number; formatable: FormatableMemory },
    b: { rrfScore: number; coreRefHit: number; signal: number; mult: number; formatable: FormatableMemory },
  ): number => {
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    if (b.coreRefHit !== a.coreRefHit) return b.coreRefHit - a.coreRefHit;
    const aScene = sceneSignalOfEntry(a.formatable);
    const bScene = sceneSignalOfEntry(b.formatable);
    if (bScene !== aScene) return bScene - aScene;
    if (b.signal !== a.signal) return b.signal - a.signal;
    return b.mult - a.mult;
  };
  const sortEntries = () =>
    [...mergedMap.entries()]
      .sort((a, b) => {
        const aDur = a[1].formatable.type === "work_fact" ? 0 : 1;
        const bDur = b[1].formatable.type === "work_fact" ? 0 : 1;
        if (aDur !== bDur) return aDur - bDur;
        return compareLex(a[1], b[1]);
      });
  let sorted = sortEntries();
  /** R5 触发判定锚：主检索结果数（R4 扩展前，与工具侧同口径"主检索结果 < limit 一半"）。 */
  const mainHitCount = sorted.length;

  // ── V2-1（引擎二 PPR 全图扩散，spec E2.1）：主检索命中全集为种子（rrfScore 归一化为
  // 种子权重），图 = 种子可达子图（collectSeedGraph 与工具路单一源），PPR 一步覆盖多跳。
  // 候选分 = maxHitScore×discount×pprNorm（非种子天花板 = maxHitScore×discount，折扣语义
  // 保持）+ [graph:ppr:kind] 标注。auto-recall L1 召回为全局路径（无 IsolationFilter，
  // 与主检索现状一致）；graph.discount=0 / rank 缺 graph → 通道退出（getNeighbors 零调用）。 ──
  if (rankSignal?.graph && rankSignal.graph.discount > 0 && mainHitCount > 0 &&
      typeof vectorStore.getNeighbors === "function" &&
      (typeof vectorStore.getL1ByIdsWithArchive === "function" || typeof vectorStore.getL1ByIds === "function")) {
    try {
      const graph = rankSignal.graph;
      const resolveByIds = (ids: string[]) =>
        vectorStore.getL1ByIdsWithArchive
          ? vectorStore.getL1ByIdsWithArchive(ids)
          : vectorStore.getL1ByIds!(ids);
      const seen = new Set(mergedMap.keys());
      const seedScoreSum = sorted.reduce((s, [, v]) => s + (v.rrfScore > 0 ? v.rrfScore : 0), 0);
      if (seedScoreSum > 0) {
        const seeds = new Map<string, number>(sorted.map(([id, v]) => [id, v.rrfScore]));
        const maxIter = Math.max(1, Math.floor(graph.pprIterations ?? PPR_DEFAULTS.maxIterations));
        const edges = await collectSeedGraph(seeds.keys(), {
          store: vectorStore as Parameters<typeof collectSeedGraph>[1]["store"],
          graphMinStrength: graph.minStrength,
          maxIterations: maxIter,
          isolationFilter,
        });
        if (edges.length > 0) {
          const maxHitScore = Math.max(...sorted.map(([, v]) => v.rrfScore));
          const detail = runPPRDetail(seeds, edges, {
            damping: graph.pprDamping ?? PPR_DEFAULTS.damping,
            topK: graph.pprTopK ?? PPR_DEFAULTS.topK,
            maxIterations: maxIter,
          });
          const picked = [...detail.pprNorm.entries()];
          if (picked.length > 0) {
            const rows = ((await resolveByIds(picked.map(([id]) => id))) ?? []) as L1SearchResult[];
            const byId = new Map(rows.map((r) => [r.record_id, r]));
            let added = 0;
            for (const [id, pprNorm] of picked) {
              if (seen.has(id)) continue;
              const nr = byId.get(id);
              if (!nr) continue;
              seen.add(id);
              const kind = detail.kinds.get(id) ?? "related";
              const pprMeta = parseMetadataJson(nr.metadata_json);
              mergedMap.set(id, {
                rrfScore: maxHitScore * graph.discount * pprNorm,
                formatable: { ...vectorResultToFormatable(nr), recall_channel: `graph:ppr:${kind}` },
                coreRefHit: 0,
                signal: 0,
                mult: 1,
                channel: `graph:ppr:${kind}`,
                coreRefCount: coreRefCountOf(pprMeta),
                recallCount: recallCountOf(pprMeta),
              });
              added++;
            }
            if (added > 0) sorted = sortEntries();
            logger?.debug?.(`${TAG} [pool-expand] V2-1 ppr: +${added} graph candidates (edges=${edges.length}, seeds=${seeds.size}), pool=${mergedMap.size}`);
          }
        }
      }
    } catch (err) {
      logger?.warn?.(`${TAG} [pool-expand] V2-1 ppr failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── R-A2（R5 价值反查补池）：主检索结果数 < limit 一半 + fired 锚 → 反查 coreRefs
  // 匹配记忆补池（rrfScore=0 + [value:锚] 标注；位次由 coreRef 通道加成赋予）。
  // boost=0（值通道关）→ 不触发。 ──
  if (rankSignal && rankSignal.boost > 0 && rankSignal.firedLabels.length > 0 &&
      mainHitCount * 2 < maxResults && typeof vectorStore.searchL1ByCoreRefs === "function") {
    try {
      const rows = ((await vectorStore.searchL1ByCoreRefs([...rankSignal.firedLabels], maxResults, isolationFilter)) ?? []) as L1SearchResult[];
      let added = 0;
      for (const r of rows) {
        if (mergedMap.has(r.record_id)) continue;
        const metadata = parseMetadataJson(r.metadata_json);
        const refs = (Array.isArray(metadata.coreRefs) ? metadata.coreRefs : [])
          .filter((s): s is string => typeof s === "string" && rankSignal.firedLabels.includes(s));
        if (refs.length === 0) continue; // store 粗筛结果须复核交集（宁缺毋滥）
        mergedMap.set(r.record_id, {
          rrfScore: 0,
          formatable: { ...vectorResultToFormatable(r), recall_channel: `value:${refs[0]}` },
          coreRefHit: coreRefHitOf(metadata),
          signal: 0,
          mult: 1,
          channel: `value:${refs[0]}`,
          coreRefCount: refs.length,
          recallCount: recallCountOf(metadata),
        });
        added++;
      }
      if (added > 0) sorted = sortEntries();
      logger?.debug?.(`${TAG} [pool-expand] R5 value backfill: fired=${JSON.stringify(rankSignal.firedLabels)}, +${added}`);
    } catch (err) {
      logger?.warn?.(`${TAG} [pool-expand] R5 backfill failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── R7-2（分层召回 spec §2 R7-2）：scene_name 反查补池——part_of 证据链优先 + 同 scene 过滤。
  // 触发：结论层在场（layered 携带 conclusionRefs/sceneNames）∧ 池未满（sorted.length <
  // maxResults——按预算折叠，池满不补，宁缺毋滥）。① part_of 证据链（getNeighbors 单跳 +
  // getL1ByIds[WithArchive]，R4 同款 resolve 模式）；② 同 scene 记录（searchL1ByScene，
  // feature-detect，T14 两步过滤——L1 召回全局路径 filter 缺省）。补池行 rrfScore=0 +
  // [scene:名] 标注（诚实原则自证身份），位次由排序层赋予（同 R5 价值反查补池）。
  // layered 缺省/空 → 通道退出（getNeighbors/searchL1ByScene 零调用——关断矩阵纪律）。──
  if (layered && (layered.conclusionRefs.length > 0 || layered.sceneNames.length > 0) && sorted.length < maxResults) {
    const r7Seen = new Set(mergedMap.keys());
    const r7Excluded = layered.excludeIds.length > 0 ? new Set(layered.excludeIds) : null;
    const r7ResolveByIds = (ids: string[]) =>
      vectorStore.getL1ByIdsWithArchive
        ? vectorStore.getL1ByIdsWithArchive(ids)
        : vectorStore.getL1ByIds!(ids);
    let r7Added = 0;
    const r7AddToPool = (rows: L1SearchResult[], sceneOf: (r: L1SearchResult) => string) => {
      for (const r of rows) {
        if (!r || typeof r.record_id !== "string") continue;
        if (r7Seen.has(r.record_id) || (r7Excluded && r7Excluded.has(r.record_id))) continue;
        const sceneName = sceneOf(r);
        if (!sceneName) continue;
        r7Seen.add(r.record_id);
        const sceneMeta = parseMetadataJson(r.metadata_json);
        mergedMap.set(r.record_id, {
          rrfScore: 0,
          formatable: { ...vectorResultToFormatable(r), recall_channel: `scene:${sceneName}` },
          coreRefHit: 0,
          signal: 0,
          mult: 1,
          channel: `scene:${sceneName}`,
          coreRefCount: coreRefCountOf(sceneMeta),
          recallCount: recallCountOf(sceneMeta),
        });
        r7Added++;
      }
    };
    // ① part_of 证据链优先（consolidation 建的证据边，现成数据）
    if (layered.conclusionRefs.length > 0 && typeof vectorStore.getNeighbors === "function" &&
        (typeof vectorStore.getL1ByIdsWithArchive === "function" || typeof vectorStore.getL1ByIds === "function")) {
      try {
        for (const ref of layered.conclusionRefs) {
          if (sorted.length + r7Added >= maxResults) break;
          const neighbors = ((await vectorStore.getNeighbors(ref.id, ["part_of"], 1, isolationFilter)) ?? []) as Array<{ id: string; type: string; strength: number; hop: number }>;
          const evIds = neighbors
            .map((nb) => nb?.id)
            .filter((id): id is string => typeof id === "string" && !r7Seen.has(id) && !(r7Excluded && r7Excluded.has(id)));
          if (evIds.length === 0) continue;
          const rows = ((await r7ResolveByIds(evIds)) ?? []) as L1SearchResult[];
          r7AddToPool(rows, () => ref.sceneName);
        }
      } catch (err) {
        logger?.warn?.(`${TAG} [pool-expand] R7 part_of evidence backfill failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // ② 同 scene 过滤（补池行标注取自身 scene_name，诚实归属）
    if (layered.sceneNames.length > 0 && sorted.length + r7Added < maxResults &&
        typeof vectorStore.searchL1ByScene === "function") {
      try {
        const remaining = maxResults - sorted.length - r7Added;
        const rows = ((await vectorStore.searchL1ByScene([...layered.sceneNames], remaining, isolationFilter)) ?? []) as L1SearchResult[];
        const fallbackScene = layered.sceneNames[0];
        r7AddToPool(rows, (r) => (typeof r.scene_name === "string" && r.scene_name ? r.scene_name.split("/")[0] : fallbackScene));
      } catch (err) {
        logger?.warn?.(`${TAG} [pool-expand] R7 scene backfill failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (r7Added > 0) {
      sorted = sortEntries();
      logger?.debug?.(`${TAG} [pool-expand] R7 scene backfill: scenes=${JSON.stringify(layered.sceneNames)}, +${r7Added}, pool=${mergedMap.size}`);
    }
  }

  // ── R7-1（分层召回 spec §2 R7-1 幂等防重）：结论层已收编的 work_fact 从经验层排除
  //（命中已存不重组——结论块已注入，经验层不得重复出现）。layered 缺省 / excludeIds 空
  // → filter 恒等跳过（f53b173 教训：空信号不得改变既有排序路径）。──
  if (layered && layered.excludeIds.length > 0) {
    const r7Excluded = new Set(layered.excludeIds);
    sorted = sorted.filter(([id]) => !r7Excluded.has(id));
  }

  // ── RV2-2（精排重设计 + E3.1 探索位）：与工具路 executeMemorySearch 截断前同层
  // 对齐（R-A1 教训）——消费同一单一源纯函数（applyCompositeRerank / applyExploreSlot）。
  // relevanceNorm 池内 max 归一：直接命中 = v.rrfScore（RRF fused）；图候选 = 派生分
  // maxHitScore×discount×pprNorm（同量纲——E2.1 派生分即相关度折扣分）；value/scene
  // 补池 = 0。结构因子（timeProx/significance/coreRef）合计 ≤30%（相关度主导契约）。
  // now 锚点沿 R-A1 纪律（rankSignal.now 快照；缺省 new Date()）。 ──
  const v2Now = rankSignal?.now ?? new Date();
  sorted = applyCompositeRerank(
    sorted,
    ([, v]) => ({
      relevance: v.rrfScore,
      occurredAt: v.formatable.occurred_at,
      significance: v.formatable.significance,
      coreRefCount: v.coreRefCount,
      isWorkFact: v.formatable.type === "work_fact",
    }),
    rerankWeights ?? DEFAULT_COMPOSITE_WEIGHTS,
    v2Now,
  );
  if (exploreSlot !== false) {
    sorted = applyExploreSlot(
      sorted,
      maxResults,
      ([, v]) => ({ channel: v.channel, recallCount: v.recallCount }),
      ([id, v]): [string, MergedPoolValue] => {
        const marked = v.channel ? `${v.channel}:explore` : "explore";
        return [id, { ...v, channel: marked, formatable: { ...v.formatable, recall_channel: marked } }];
      },
    );
  }

  const top = sorted.slice(0, maxResults);

  if (top.length > 0) {
    logger?.debug?.(
      `${TAG} Hybrid search found ${top.length} results ` +
      `(keyword=${keywordResults.length}, embedding=${embeddingResults.length})`,
    );
    // GROW-EVO P2（§2.3）：召回默认排除失效记忆（excludeInvalidated，spec 拍板①缺省
    // true；现存库无失效行 = 逐位不变）。过滤在 bump 之前——失效记忆连 recall_count
    // 都不积累（宁缺毋滥）。解析失败的 valid_end 保留（同 filter-invalidated 口径）。
    const applyExclusion = excludeInvalidated !== false;
    let visibleTop = top;
    if (applyExclusion) {
      const nowMs = Date.now();
      visibleTop = visibleTop.filter(([, v]) => {
        const ve = v.validEnd;
        if (!ve) return true;
        const t = Date.parse(ve);
        return !Number.isFinite(t) || t > nowMs;
      });
    }
    // GROW-EVO P1（R8 数据前提）：钩子路 recall_count 计数补齐——top-3 observed
    // （工具路重巩固白名单同款红线），只加计数、不刷 updated_time（防扰动既有排序）。
    // best-effort：失败静默（计数非排序语义）；bumpRecallCount 缺失的后端安静跳过。
    try {
      const bumpStore = vectorStore as { bumpRecallCount?: (id: string, now?: string, opts?: { touchUpdatedTime?: boolean }) => boolean } | undefined;
      if (bumpStore && typeof bumpStore.bumpRecallCount === "function") {
        const recallNow = new Date().toISOString();
        for (const [bumpId, bumpVal] of visibleTop.slice(0, 3)) {
          if (bumpVal.certainty !== "observed") continue;
          void Promise.resolve(bumpStore.bumpRecallCount(bumpId, recallNow, { touchUpdatedTime: false })).catch(() => {});
        }
      }
    } catch { /* bookkeeping best-effort */ }
    return { lines: visibleTop.map(([, { formatable }]) => formatMemoryLine(formatable)), timing };
  }

  logger?.debug?.(`${TAG} Hybrid search: no results after merge`);
  return { lines: [], timing };
}

// ============================
// Unified memory line formatter
// ============================

/**
 * Format a single memory record into a rich natural-language line for prompt injection.
 *
 * Time semantics:
 *   - timestamp (点时间): when the activity/event happened, e.g. "2025-03-01 mentioned something"
 *   - activity_start_time / activity_end_time (段时间): activity time range, e.g. "trip from 2025-05-01 to 2025-05-10"
 *   - All three time fields may be empty/undefined — handled gracefully.
 *
 * Output examples:
 *   - [persona] 用户叫王小明，30岁，是一名软件工程师。
 *   - [episodic|旅行计划] 用户计划五月去日本旅行。 ·(活动时间: 2025-05-01 ~ 2025-05-10)
 *   - [episodic] 用户今天加班到很晚。 ·(活动时间: 2025-03-01)
 *   - [instruction] 用户要求回答时使用中文，保持简洁。
 *
 * Minor ④ 标注防撞形（2026-09-12）：活动时间标注带 ` ·` 分隔符追加（与 ·[recall_channel]/
 * ·soul[...] 同族）——正文本身以 "(活动时间:…)" 结尾时不再与系统标注撞形（解析正则只剥
 * 带分隔符的系统标注；旧格式裸 ` (活动时间:…)` 行保留一次性兼容剥除，其与正文的固有
 * 歧义为旧格式已知限制）。解析正则统一定义为本文件导出的 MEMORY_LINE_RE（:560/:910 两
 * 处 metric 解析共用单一源）。
 */
interface FormatableMemory {
  type: string;
  content: string;
  scene_name?: string;
  /** Activity time range start (段时间 start), may be empty */
  activity_start_time?: string;
  /** Activity time range end (段时间 end), may be empty */
  activity_end_time?: string;
  /** Activity point-in-time (点时间: when it happened), may be empty */
  timestamp?: string;
  /** 审计 B4：灵魂字段标注（发生时刻/确定性/情感/重要度），与 tdai_memory_search 的回忆片段对齐 */
  occurred_at?: string;
  certainty?: string;
  valence?: number;
  significance?: number;
  /** R-A2：候选池通道标注（"graph:kind" / "value:锚"；主检索命中恒缺省）。 */
  recall_channel?: string;
}

// 审计 B4：导出以便独立验证 soul 标注与 metric 正则兼容性（纯函数、无副作用）
// Minor ④（2026-09-12）：metric 行解析单一源——两处消费点（performAutoRecall metric 映射 /
// searchHybrid 行解析）共用本正则。剥除顺序：先 ` ·(活动时间:…)`（系统标注，分隔符防撞形），
// 再旧格式裸 ` (活动时间:…)`（一次性兼容，旧格式与正文的固有歧义为已知限制）。
export const MEMORY_LINE_RE = /^-\s+\[([^\]]+)\]\s+(.+?)(?:\s*·\(活动时间:[^)]*\))?(?:\s*\(活动时间:[^)]*\))?$/;

// 审计 B4：导出以便独立验证 soul 标注与 metric 正则兼容性（纯函数、无副作用）
export function formatMemoryLine(m: FormatableMemory): string {
  // 1. Type tag + optional scene name
  const tag = m.scene_name ? `${m.type}|${m.scene_name}` : m.type;

  // 2. Content (core)
  let line = `- [${tag}] ${m.content}`;

  // 3. Time info — prefer activity_start/end range; fall back to timestamp as point-in-time
  const start = formatTimestamp(m.activity_start_time);
  const end = formatTimestamp(m.activity_end_time);
  const point = formatTimestamp(m.timestamp);

  if (start && end) {
    // 段时间: both start and end
    line += ` ·(活动时间: ${start} ~ ${end})`;
  } else if (start) {
    // 段时间: only start
    line += ` ·(活动时间: ${start}起)`;
  } else if (end) {
    // 段时间: only end
    line += ` ·(活动时间: 至${end})`;
  } else if (point) {
    // 点时间: single timestamp
    line += ` ·(活动时间: ${point})`;
  }
  // If all three are empty → no time info appended (graceful)

  // 审计 B4：灵魂字段标注（发生时刻/确定性/情感/重要度），与 tdai_memory_search 的回忆片段对齐。
  // 只在有值时追加，宁缺毋滥；保持行首 "- [tag] content" 结构，metric 解析正则（^-\s+\[([^\]]+)\]）不被破坏。
  const soul: string[] = [];
  if (m.occurred_at) soul.push(`发生 ${m.occurred_at.slice(0, 10)}`);
  if (m.certainty) soul.push(m.certainty === "inferred" ? "推断" : "实见");
  if (m.valence != null) soul.push(`情感 ${m.valence.toFixed(1)}`);
  if (m.significance != null) soul.push(`重要度 ${m.significance.toFixed(2)}`);
  if (soul.length > 0) line += ` ·soul[${soul.join(" · ")}]`;

  // R-A2：候选池通道标注（诚实原则——关联召回自证身份，LLM 可见）。
  // 追加在行尾，不破坏行首 "- [tag] content" 结构（metric 解析正则不受影响）。
  if (m.recall_channel) line += ` ·[${m.recall_channel}]`;

  return line;
}

function applyRecallBudget(
  lines: string[],
  recall: MemoryTdaiConfig["recall"],
  logger?: Logger,
): string[] {
  const maxCharsPerMemory = normalizeBudgetLimit(recall.maxCharsPerMemory);
  const maxTotalRecallChars = normalizeBudgetLimit(recall.maxTotalRecallChars);

  if (!maxCharsPerMemory && !maxTotalRecallChars) {
    return lines;
  }

  const budgeted: string[] = [];
  let usedChars = 0;
  let truncatedCount = 0;
  let droppedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const perMemoryBounded = maxCharsPerMemory
      ? truncateRecallLine(line, maxCharsPerMemory)
      : line;
    let wasTruncated = perMemoryBounded !== line;

    if (!maxTotalRecallChars) {
      budgeted.push(perMemoryBounded);
      if (wasTruncated) truncatedCount++;
      continue;
    }

    const separatorChars = budgeted.length > 0 ? RECALL_LINE_SEPARATOR.length : 0;
    const remainingChars = maxTotalRecallChars - usedChars - separatorChars;
    if (remainingChars <= 0) {
      droppedCount += lines.length - i;
      break;
    }

    if (perMemoryBounded.length > remainingChars) {
      const canFit = remainingChars >= MIN_TRUNCATED_RECALL_LINE_CHARS;
      if (canFit) {
        const totalBounded = truncateRecallLine(perMemoryBounded, remainingChars);
        budgeted.push(totalBounded);
        usedChars += separatorChars + totalBounded.length;
        wasTruncated ||= totalBounded !== perMemoryBounded;
        if (wasTruncated) truncatedCount++;
      }
      droppedCount += lines.length - i - (canFit ? 1 : 0);
      break;
    }

    budgeted.push(perMemoryBounded);
    usedChars += separatorChars + perMemoryBounded.length;
    if (wasTruncated) truncatedCount++;
  }

  if (truncatedCount > 0 || droppedCount > 0) {
    logger?.debug?.(
      `${TAG} Recall budget applied: input=${lines.length}, output=${budgeted.length}, ` +
      `truncated=${truncatedCount}, dropped=${droppedCount}, ` +
      `maxCharsPerMemory=${recall.maxCharsPerMemory}, maxTotalRecallChars=${recall.maxTotalRecallChars}`,
    );
  }

  return budgeted;
}

function normalizeBudgetLimit(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function truncateRecallLine(line: string, maxChars: number): string {
  // Count and slice by code point, not UTF-16 code unit, so a cut never lands
  // between the halves of a surrogate pair (which would corrupt a non-BMP
  // character to U+FFFD when the line is UTF-8 encoded for the request).
  const cps = Array.from(line);
  if (cps.length <= maxChars) return line;
  if (maxChars <= RECALL_TRUNCATION_SUFFIX.length) {
    return cps.slice(0, maxChars).join("");
  }
  return `${cps.slice(0, maxChars - RECALL_TRUNCATION_SUFFIX.length).join("").trimEnd()}${RECALL_TRUNCATION_SUFFIX}`;
}

/**
 * Format an ISO 8601 timestamp to a concise date or datetime string.
 * - If the time part is 00:00:00 → show date only (e.g. "2025-03-01")
 * - Otherwise → show date + time (e.g. "2025-03-01 14:30")
 * - Returns undefined for empty/invalid inputs.
 */
function formatTimestamp(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  // Try to parse ISO format: "2025-03-01T14:30:00.000Z" or "2025-03-01"
  const match = ts.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2})?)?/);
  if (!match) return undefined;
  const datePart = match[1];
  const timePart = match[2];
  if (!timePart || timePart === "00:00") {
    return datePart;
  }
  return `${datePart} ${timePart}`;
}

/**
 * Build a FormatableMemory from a full MemoryRecord (keyword search path).
 * Handles empty metadata, empty timestamps array gracefully.
 */
function recordToFormatable(record: MemoryRecord): FormatableMemory {
  const meta = record.metadata as { activity_start_time?: string; activity_end_time?: string } | undefined;
  return {
    type: record.type,
    content: record.content,
    scene_name: record.scene_name || undefined,
    activity_start_time: meta?.activity_start_time || undefined,
    activity_end_time: meta?.activity_end_time || undefined,
    timestamp: (record.timestamps && record.timestamps.length > 0) ? record.timestamps[0] : undefined,
  };
}

/**
 * Build a FormatableMemory from a VectorSearchResult (embedding search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
function vectorResultToFormatable(r: L1SearchResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors — treat as no metadata */ }
  }
  return {
    type: r.type,
    content: r.content,
    scene_name: r.scene_name || undefined,
    activity_start_time: activityStart,
    activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
    // 审计 B4：灵魂字段透传（P2a 顶层列）
    occurred_at: r.occurred_at || undefined,
    certainty: r.certainty || undefined,
    valence: r.valence,
    significance: r.significance,
  };
}

/**
 * Build a FormatableMemory from an FtsSearchResult (FTS5 keyword search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
function ftsResultToFormatable(r: L1FtsResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors — treat as no metadata */ }
  }
  return {
    type: r.type,
    content: r.content,
    scene_name: r.scene_name || undefined,
    activity_start_time: activityStart,
    activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
  };
}
