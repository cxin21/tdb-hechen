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
import { foldClusterAwareWithMeta } from "./recall-fold-cluster.js";
import { stripMemoryLineMeta } from "./memory-line-meta.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { isIdentityImposition, stripIdentityStateResidue } from "../lifecycle/identity-discovery.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import { computeMoodTierFromStore } from "./mood-line.js";
// #54（2026-10-19）：召回注入动态 topK——分数分布 elbow 确定性纯函数（recall-dynamic-topk.ts）
import { dynamicTopKCount } from "./recall-dynamic-topk.js";
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
  raceWithTimeoutCap,
  resolveQueryExpansionRunner,
} from "../recall/query-expand.js";
import { PPR_DEFAULTS, runPPRDetail } from "../recall/ppr.js";
import { emotionSalienceOf, buildRankContext,
  certaintyMultiplierOf,
  importanceMultiplierOf,
  importanceGateStats,
  sensitivityMultiplierOf,
  DEFAULT_RANK_SIGNALS,
  detectPresentTemporalIntent,
  detectHistoryTemporalIntent,
  detectSceneHit,
  sceneSignalOf,
  structuralSignalOf,
  ZERO_RANK_SIGNALS,
  type ImportanceGateStatInput,
  type RankSignalItem,
  type RankSignals,
  type RecallJournalImportanceGateSpec,
  type ValueRowLike, } from "../tools/recall-signals.js";
import { isOutsideValidityWindow } from "../recall/filter-invalidated.js";
import { collapseFactRowsByTurn } from "../recall/fact-turn.js";
import { factValueOfMeta, parentTurnIdOf } from "../record/fact-row.js";
import { anchorRerankOrder } from "../recall/rerank/anchor.js";
import {
  SOFT_VALIDITY_PENALTY,
  excludeInvalidatedFor,
  selectByValidity,
  shouldHardDropValidity,
  validityEnabled,
  validityStateOf,
  type ExcludeInvalidated,
  type ValidityMode,
} from "../recall/validity-policy.js";
import {
  classifyRecallIntent,
  isAssistantRecallQuery,
  recallIntentPolicy,
  type RecallIntentPolicy,
} from "../recall/query-intent.js";
import { arbitrateConclusions, computeSlotBudget } from "../recall/layered-budget.js";
import { appendRecallJournal, type RecallJournalGates, type RecallJournalPerfMs } from "../recall/recall-journal.js";
import { createReranker } from "../recall/rerank/factory.js";
import {
  DEFAULT_RERANK_FILTER_RULER,
  filterRulerGateObs,
  normalizeRerankFilterRuler,
  relativeKeepIdxSet,
  type RerankFilterRule,
  type RerankFilterRuler,
  type RerankRelativeRuler,
} from "../recall/rerank/filter-ruler.js";
import {
  DEFAULT_RERANK_CANDIDATES,
  defaultRerankMinScore,
  isLogitScaleProvider,
  sigmoid01,
} from "../recall/rerank/defaults.js";
import { mmrReorder } from "../recall/mmr.js";
import { sortLinesByLeadingTimestamp } from "./inject-order.js";
import type { MemoryReranker, RerankResult } from "../recall/rerank/types.js";
import { parseTimeWindow, type TimeWindow } from "../tools/content-time-window.js";
import { sanitizeText } from "../../utils/sanitize.js";
import {
  assembleLayeredLines,
  conclusionFingerprint,
  allocateConclusionPerLineChars,
  evidenceRelevanceScore,
  formatConclusionLine,
  parseFtsTokens,
  resolveIdempotentConclusionLines,
  selectL2Conclusions,
  splitBudget,
  truncateConclusionContent,
  truncateConclusionContentSentences,
  type L2ConclusionCandidate,
} from "./recall-layered.js";
import path from "node:path";
import fs from "node:fs";
import { createScopedStorageAdapter, type StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import {
  DEFAULT_PROFILE_SCOPE,
  buildProfileIsolationScope,
  type ProfileIsolation,
} from "../profile/profile-sync.js";
import type { Logger } from "../types.js";
import type { SoulRenderOptions } from "./soul-assembler.js";
import type { SoulState } from "./soul-state.js";

const TAG = "[memory-tdai] [recall]";

/** #136：软失效硬丢前的"取代者"相关性判定用停用词（高频但不承载事实的词）。 */
const RELATED_STOPWORDS = new Set([
  "user", "users", "have", "that", "this", "with", "their", "from", "about",
  "记忆", "用户", "条目",
]);

/**
 * #136：两行内容是否有可承载事实的公共 token（英文 ≥4 字符 / 中文 ≥3 字）。
 * 只用于"问当下时是否允许硬丢旧行"——判 false 时宁可降权保留（安全方向：不误删）。
 */
function contentTokenOverlap(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const tokensOf = (s: string): Set<string> =>
    new Set((s.toLowerCase().match(/[a-z0-9]{4,}|[\u4e00-\u9fff]{3,}/g) ?? []).filter((t) => !RELATED_STOPWORDS.has(t)));
  const left = tokensOf(a);
  for (const t of tokensOf(b)) if (left.has(t)) return true;
  return false;
}
const RECALL_TRUNCATION_SUFFIX = "…（已截断；可用 tdai_memory_search 或 tdai_conversation_search 查看详情）";
const MIN_TRUNCATED_RECALL_LINE_CHARS = 40;
const RECALL_LINE_SEPARATOR = "\n";

// A2（REG-REMAINING-001）：召回侧近重折叠——写入侧 dedup 相似度阈值未命中的近似重复
// 在注入前折叠：字符 bigram Jaccard ≥ 0.6 视为近似重复，保留排序靠前的首条。
// 纯 CPU 零 I/O；剥离行尾活动时间戳后比较（时间不同不代表内容不同）；
// 阈值保守——真实不同主题记忆的 bigram Jaccard 通常 <0.3。
/**
 * #162（2026-10-29）：装配层近重折叠口径。
 *  - 缺省 / 传数字 = A2 历史口径：字符 bigram Jaccard ≥ threshold，无来源免疫（回归对照用）；
 *  - 传 options = #162 口径：① 同会话免疫——同 session_id 的不同轮次是同一段对话的连续证据，
 *    共享话题是常态，不能按「主题相似」折成 1 行；② 跨来源判重从「主题相似」（Jaccard）改为
 *    「替代关系」（containment ≥ 0.9）——只有一条已被另一条覆盖才算重复。
 *  两种口径都保留「剥元数据后逐字相同 → 折」的去重能力（同一条记忆被重复召回/写入）。
 *  ③（2026-10-29 离线门槛补强）：跨来源 containment 还必须**同序覆盖**——短文本（<200 字）
 *  仅共享话题词就能把 bigram containment 顶到 0.90+（实测 gpt4_b4a80587：风景修图 vs 人像
 *  回复 0.904，属于不同事实），故要求被覆盖行的 bigram 在覆盖行里按序命中 ≥ 0.9（近似子串），
 *  主题词散落但顺序打乱的「同领域不同事」不再折。
 */
export interface FoldNearDupOptions {
  /** 跨来源近重判据：containment = |A∩B| / min(|A|,|B|)，clamp [0.5,1]，缺省 0.9。 */
  containment?: number;
  /** 行 → 来源会话 id；两行同会话且都已知 → 不互相折叠（逐字相同除外）。 */
  sessionOf?: (line: string) => string | undefined;
}

/**
 * #162：bigram 序列（保留顺序，用于「近似子串」判定）。
 */
function bigramSeq(t: string): string[] {
  const seq: string[] = [];
  for (let i = 0; i < t.length - 1; i++) seq.push(t.slice(i, i + 2));
  return seq;
}

/**
 * #162：small 的 bigram 序列在 big 序列里**按序**命中的比例（贪心子序列 + 位置二分，近似 LCS 占比）。
 * 用于区分「一条确实被另一条覆盖（近似子串）」与「同领域话题词散落（containment 虚高）」。
 */
function orderedCoverageRatio(smallSeq: string[], bigSeq: string[]): number {
  if (smallSeq.length === 0 || bigSeq.length === 0) return 0;
  const positions = new Map<string, number[]>();
  for (let i = 0; i < bigSeq.length; i++) {
    const b = bigSeq[i];
    const arr = positions.get(b);
    if (arr) arr.push(i);
    else positions.set(b, [i]);
  }
  let last = -1;
  let matched = 0;
  for (const s of smallSeq) {
    const arr = positions.get(s);
    if (!arr) continue;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] > last) hi = mid;
      else lo = mid + 1;
    }
    if (lo < arr.length) {
      last = arr[lo];
      matched++;
    }
  }
  return matched / smallSeq.length;
}

export function foldNearDuplicates(lines: string[], thresholdOrOptions: number | FoldNearDupOptions = 0.25): string[] {
  const legacyThreshold = typeof thresholdOrOptions === "number" ? thresholdOrOptions : undefined;
  const containment = typeof thresholdOrOptions === "object"
    ? Math.min(1, Math.max(0.5, thresholdOrOptions.containment ?? 0.9))
    : 0.9;
  const sessionOf = typeof thresholdOrOptions === "object" ? thresholdOrOptions.sessionOf : undefined;
  // 阈值 0.25 实测校准（2026-09-15）：重复组内 pairwise Jaccard 0.36-0.49，
  // 非重复 ≤0.04 —— 9 倍分离度。0.6 会被转述措辞稀释（实测 4 重复全部漏过）。
  // A2-R1（2026-09-16 对抗性审查回归修复，两步）：相似度必须在**内容**上比较——
  // ① 原实现剥时间戳的正则锚定 $，行尾为 "·soul[...]" 时时间戳不剥离，同日行的时间+灵魂
  // 后缀公共 bigram 主导相似度（实测：完全异主题同日活动记忆 Jaccard 0.50 ≥ 0.25 被误折）；
  // ② 行首 tag（type|session）也是元数据：同 tag 行恒共享 20+ bigram，短行对仅凭 tag 即逼近
  // 阈值（实测 ④-1 fixture：仅共享"召回专项"3 个内容 bigram 的两行仍被折，jaccard 0.254）。
  // A2 校准"非重复 ≤0.04"只在内容口径下成立——剥离行首 tag、行尾 soul 与时间段后比较。
  // 单一源迁移（2026-09-30，memory-line-meta:13 登记的 v2 计划执行）：循环剥离到不动点 + 折叠注记。
  // A/B 矩阵实证（5 形态近似对，/tmp/jaccard-ab.mjs）：单遍链在生产折叠行（注记顶掉 $ 锚）残留
  // soul+时间段（S4）、短行伪相似误折（S5 分组差异 1/5）；循环侧全剥且纯内容行（S1/S2）两口径
  // 逐位一致——迁移=修正 A2-R1 同类「元数据 bigram 主导」缺陷，非校准漂移。
  const stripMeta = (t: string) => stripMemoryLineMeta(t);
  const grams = (t: string) => {
    const set = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const keptGramSets: Set<string>[] = [];
  const kept: { line: string; content: string; grams: Set<string>; seq: string[]; session: string | undefined }[] = [];
  for (const line of lines) {
    const content = stripMeta(line);
    const g = grams(content);
    const seq = bigramSeq(content);
    const session = sessionOf?.(line);
    let dup = false;
    for (const k of kept) {
      // ① #162 同会话免疫：同会话两轮只有「逐字相同」才算重复（同一条记忆重复出现）；
      //    主题/字面相近的不同轮次各自保留——它们是多轮证据，不是重复。
      if (session !== undefined && k.session !== undefined && session === k.session) {
        if (k.content !== content) continue;
        dup = true;
        break;
      }
      // ② 逐字相同（跨来源）：剥元数据后信息量差为零 → 折（去重能力不因口径切换而丢失）。
      if (k.content === content) {
        dup = true;
        break;
      }
      let inter = 0;
      for (const x of g) if (k.grams.has(x)) inter++;
      if (legacyThreshold !== undefined) {
        // A2 历史口径（无来源信息的调用方 / 回归对照）：Jaccard ≥ threshold。
        if (inter / (g.size + k.grams.size - inter) >= legacyThreshold) {
          dup = true;
          break;
        }
      } else if (
        g.size > 0 && k.grams.size > 0
        && inter / Math.min(g.size, k.grams.size) >= containment
        // ③-a 同序覆盖：小者的 bigram 需在长者里按序命中 ≥0.9（近似子串），拒绝「同领域话题散落」。
        && orderedCoverageRatio(seq.length <= k.seq.length ? seq : k.seq, seq.length <= k.seq.length ? k.seq : seq) >= 0.9
      ) {
        // ③ #162 新口径：containment——「一条已被另一条覆盖」才算重复；主题相近但不互相覆盖的保留。
        dup = true;
        break;
      }
    }
    if (!dup) kept.push({ line, content, grams: g, seq, session });
  }
  return kept.map((k) => k.line);
}

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
  /** 复用缓存存的是召回结果的完整载荷（含 #166 起与 lines 平行的 metas——遮蔽行的 turn 归属靠它）。 */
  result: SearchResult;
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
  /**
   * 该行归属的父 turn id（= 落库 recordId 去掉事实行后缀 `#f<N>`）。
   * #166：present-intent 值级遮蔽把注入文本换成事实短语后，「文本 → turn」反查必然失配
   * （短语不是任何 turn 的原文），度量/观测要能精确落到父 turn，就不能再靠内容反查。
   */
  turnId?: string;
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
  /**
   * P1-T7（worthiness importance）：重要度降权门参数透传——searchHybrid 据此
   * ①消费 signals.importancePenalty（乘子入 mult，平局组内生效——开启即真实降权）；
   * ②gate 在场即产出 gates.importancePenalty 双分量观测日志（penalized=实际分，raw=反推值）。
   * 缺省 undefined = 门未启用 = 无 gates 字段（缺字段=门未启用口径）。
   */
  importanceGate?: RecallJournalImportanceGateSpec;
  /**
   * #135 R3：query 当下时态标记命中（detectPresentTemporalIntent）。缺省 undefined =
   * 未检测 = 关断恒等（presentTemporalBoost > 0 且本标记为 true 才生效）。
   */
  presentTemporal?: boolean;
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
  /** B0 观测（bench/recall-opt）：检索门观测（nativeMinRRF/rerank）；未启用=缺字段。 */
  gates?: SearchResult["gates"];
  /** R7 meta（spec §4.1 观测/评估用）：结论行数（含 [结论] 标注行）。 */
  conclusionCount: number;
  /** R7 meta：经验行数（预算切分后实际入块数）。 */
  experienceCount: number;
  /** R7 meta：本轮是否命中复用（幂等结论层复用 ∨ 同 session 同 query 检索复用）。 */
  sessionReused: boolean;
  /** 立项③：灵魂指纹（双槽∪锚集合 hash；未变化=消费端可复用上轮 soul 字节）。 */
  soulVersion?: string;
  /** S-FEEL-1（M1）：近期情绪基调档位（positive/neutral/strained；enabled=false 时不出键）。 */
  mood?: string;
  /** R7 meta：分层组装是否生效（结论层非空）。 */
  layered: boolean;
  /** scene index 条目（钩子后续 scene navigation 复用——一次读取两处消费，现状保持）。 */
  sceneIndexEntries: Awaited<ReturnType<typeof readSceneIndex>>;
  /** profile scope 派生（钩子 persona/scene navigation 消费）。 */
  profileDataDir: string;
  profileStorage?: StorageAdapter;
  profileScope: string;
  /** #61（2026-10-18）：分段计时观测（毫秒）——v3 端点路 /v3/recall 5000ms 硬超时贴脸
   *  的黑洞定位（journal 时间线显示 L1 ~70ms / soul ~130ms 后静默）。 */
  perfMs: RecallJournalPerfMs;
}

// ═══ P1 召回质量 Task 2（spec §4.5，r3=232a124）：精排接入（rerank wiring）═══
// 语义合同：rerank 插在 searchMemories 之后、预算切分/组装之前；重排恒真实生效
// （用户 2026-10-14 拍板移除 shadowMode），null/throw/熔断一律降级原序，绝不阻塞召回。
// 关 vs 开但不可用：enabled=false 或 provider=none → off（零开销：不建 reranker、零日志、
// journal 无 rerank 键）；enabled 且 configError/工厂 null（如 local 占位）→ unavailable
// （warn 恰一次/调用 + 降级 gate，无 provider 外呼、不扩池）。

/** 熔断器（spec §4.5）：连续 threshold 次失败 → windowMs 内跳过 provider（零外呼零时延，
 *  原序注入）；窗口过后恢复探测（半开：isOpen 归零计数并放行）；成功重置连续失败计数。
 *  clock 可注入（测试确定性）。 */
export interface RerankBreaker {
  isOpen(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
}

export function createRerankBreaker(opts?: {
  threshold?: number;
  windowMs?: number;
  now?: () => number;
}): RerankBreaker {
  const threshold = opts?.threshold ?? 3;
  const windowMs = opts?.windowMs ?? 60_000;
  const now = opts?.now ?? Date.now;
  let failures = 0;
  let openedAt = -Infinity;
  return {
    isOpen(): boolean {
      if (failures < threshold) return false;
      if (now() - openedAt >= windowMs) {
        failures = 0; // 窗口已过 → 恢复探测
        return false;
      }
      return true;
    },
    recordSuccess(): void {
      failures = 0;
      openedAt = -Infinity;
    },
    recordFailure(): void {
      if (failures === 0) openedAt = now(); // 打点=本串首败时刻
      failures++;
    },
  };
}

// 模块级默认熔断器（进程内跨调用累计；测试用 resetRerankBreakerForTests 归零；
// 注入 deps.breaker 的调用方不经过它）。
let defaultRerankBreaker: RerankBreaker = createRerankBreaker();

/** 测试隔离：重建默认熔断器（仅测试用；生产进程内共享是有意语义）。 */
export function resetRerankBreakerForTests(): void {
  defaultRerankBreaker = createRerankBreaker();
}

interface RerankWiring {
  state: "off" | "unavailable" | "active";
  provider: string;
  reranker?: MemoryReranker;
  breaker?: RerankBreaker;
  minScore: number;
  candidates: number;
  /** #135 R4：作用模式（缺省 "rerank" = 逐位现状；"filter" = 只滤不清排保原序）。 */
  mode: "rerank" | "filter";
  /** #144：filter 模式的判定尺子（floor=绝对 minScore 阈值，现状；margin/quantile=题内相对尺子）。 */
  filterRuler: RerankFilterRuler;
}

/** 每调用解析一次精排接线（off | unavailable | active）。T1 移交：
 *  - 工厂 null（构造期不可用，如 local 占位/关闭）与 rerank() null（本次运行失败）都坍缩为
 *    降级原序，靠 state 区分关/开但不可用；
 *  - timeoutMs=0 非 configError（clamp 语义）→ active，实际每次中止由 adapter 层返回 null，
 *    在此表现为「warn+熔断计败+降级 gate」的永久退化，journal 如实记录；
 *  - adapter 零日志：warn/breaker 全部归本接线层。 */
function resolveRerankWiring(
  cfg: MemoryTdaiConfig,
  deps: { reranker?: MemoryReranker | null; breaker?: RerankBreaker; fetchImpl?: typeof fetch } | undefined,
  logger?: Logger,
): RerankWiring {
  const rc = cfg.recall?.rerank;
  const provider = rc?.provider ?? "none";
  const enabled = rc?.enabled === true;
  if (!rc || !enabled || provider === "none") {
    // off：完全静默零开销（configError 存在但已停用 → 每调用 warn 一次提示配置问题）
    if (rc?.configError) logger?.warn?.(`${TAG} [rerank] 精排已停用（${rc.configError}）`);
    return {
      state: "off",
      provider,
      // #145：off 态这两个值只进展示/journal（不做判定），仍与 parse 期缺省同源，避免两处漂移。
      minScore: defaultRerankMinScore(provider),
      candidates: DEFAULT_RERANK_CANDIDATES,
      mode: "rerank",
      filterRuler: DEFAULT_RERANK_FILTER_RULER,
    };
  }
  // #145：兜底缺省与 config.ts parse 期同源（provider 刻度感知：local −10.5 logit / 云 sigmoid(−10.5)）。
  const minScore =
    typeof rc.minScore === "number" && Number.isFinite(rc.minScore) ? rc.minScore : defaultRerankMinScore(provider);
  const candidates =
    typeof rc.candidates === "number" && Number.isFinite(rc.candidates) && rc.candidates >= 1
      ? Math.floor(rc.candidates)
      : DEFAULT_RERANK_CANDIDATES;
  const reranker = deps?.reranker !== undefined ? deps.reranker : createReranker(rc, { fetchImpl: deps?.fetchImpl });
  if (rc.configError || reranker === null) {
    logger?.warn?.(`${TAG} [rerank] provider=${provider} 不可用（${rc.configError ?? "工厂返回 null"}），降级原序`);
    return {
      state: "unavailable",
      provider,
      minScore,
      candidates,
      mode: rc.mode === "filter" ? "filter" : "rerank",
      filterRuler: normalizeRerankFilterRuler(rc),
    };
  }
  return {
    state: "active",
    provider,
    reranker,
    breaker: deps?.breaker ?? defaultRerankBreaker,
    minScore,
    candidates,
    mode: rc.mode === "filter" ? "filter" : "rerank",
    filterRuler: normalizeRerankFilterRuler(rc),
  };
}

/** #144：filter floor 校准的候选分数转储（诊断专用；缺省零开销）。
 *  打开：`RERANK_SCORE_DUMP=<jsonl 路径>`（bench 侧 `--dump-rerank-scores` 透传该 env）。
 *  每完成一次精排调用落一行 JSONL：**全部候选**的原始 provider 分数（含未达线行）+ recordId + 最终保留序。
 *  为什么连未达线行一起落：filter 模式的 floor 校准要 gold/噪声的**全量**分数分布；result rows 里只剩
 *  kept/dropped 计数，事后无法重建任何其它 floor 的 turnCov（一档一跑 = 每档 90 题白烧一次精排）。 */
export interface RerankScoreDumpRecord {
  query: string;
  provider: string;
  mode: "rerank" | "filter";
  minScore: number;
  candidates: number;
  logitScale: boolean;
  threshold01: number;
  cap: number;
  lineCount: number;
  /** 已评分候选（原始 provider 分量纲；未评分 = provider 截断漏排，不在此列）。 */
  scored: { i: number; score: number }[];
  /** 全候选（精排前原序）：recordId/session 回指召回来源；text 是召回行原文（bench 侧靠它反查 turn id——
   *  sqlite fallback 路 metas 为空，只落 recordId 会解析不出证据，校准就没法按 gold 分层）。 */
  order: { i: number; rec: string | null; session: string | null; text: string }[];
  /** 最终保留的候选下标（filter 模式 = 原序过滤后的子序）。 */
  final: number[];
  /** #144：规则过线条数（cap 之前；与 final.length 的差 = 预算截断掉的条数）。 */
  passCount?: number;
  /** #144：filter 判定尺子（floor/margin/quantile）+ 参数，供事后归因与离线复算。 */
  filterRule?: RerankFilterRule;
  filterMarginTop?: number;
  filterKeepRatio?: number;
  degraded?: "all-below-minScore";
}

/** 追加一行转储。诊断路径：任何 IO 失败都不允许影响召回主流程（宁丢观测不丢召回）。 */
export function appendRerankScoreDump(dumpPath: string | undefined, rec: RerankScoreDumpRecord): void {
  if (!dumpPath) return;
  try {
    fs.appendFileSync(dumpPath, JSON.stringify(rec) + "\n");
  } catch {
    /* 诊断失败静默：不打断召回 */
  }
}

/** P1 Task 2（spec §4.5）：精排主体，原位改写 searchResult（lines/scores/metas/gates）。
 *  - off → 零动作；lines 空 → 零动作（与现状 journal 一致，不产 gate）；
 *  - unavailable / 熔断开 → 降级 gate（kept=池大小 dropped=0 无 topScore，熔断路径 ms=0）；
 *  - adapter null/throw → 熔断计败 + warn 恰一条 + 降级 gate（ms=实际耗时）；
 *  - 成功 → 熔断清零 + 防御性整形（index 去重首见保留/越界剔除/分数降序）+ 选取：
 *    minScore 以下丢弃、provider 截断的未排序候选按原序垫尾（绝不静默丢弃）、
 *    cap=预算经验层额度；重排恒真实生效（用户 2026-10-14 拍板移除 shadowMode），
 *    gate（kept/dropped/topScore）保留作 journal 观测。 */
async function applyRecallRerank(
  query: string,
  searchResult: { lines: string[]; scores?: number[]; metas?: ({ recordId?: string; evidenceIds?: string[]; sessionId?: string } | undefined)[]; lineSessions?: (string | undefined)[]; gates?: RecallJournalGates },
  wiring: RerankWiring,
  cap: number,
  logger?: Logger,
  /** B2-b：精排 pass 池 MMR 多样性重排（缺省 undefined = 逐位现状）。 */
  mmr?: { enabled: boolean; lambda: number },
): Promise<void> {
  if (wiring.state === "off") return;
  const lines = searchResult.lines;
  if (lines.length === 0) return;
  const degradeGate = (ms: number): void => {
    searchResult.gates = {
      ...searchResult.gates,
      rerank: { provider: wiring.provider, ms, kept: lines.length, dropped: 0 },
    };
  };
  if (wiring.state === "unavailable") {
    degradeGate(0);
    return;
  }
  const reranker = wiring.reranker!;
  const breaker = wiring.breaker!;
  if (breaker.isOpen()) {
    logger?.debug?.(`${TAG} [rerank] 熔断开启——跳过 provider 调用（原序注入）`);
    degradeGate(0);
    return;
  }
  // 精排文档 = 剥离注入元数据后的纯内容（tag/·soul/·(活动时间) 不参与语义打分）；
  // 剥空则退回原行（防全元数据行变空串）。
  const docs = lines.map((l) => stripMemoryLineMeta(l) || l);
  const t0 = performance.now();
  let ranked: RerankResult[] | null = null;
  try {
    ranked = await reranker.rerank(query, docs);
  } catch (err) {
    logger?.warn?.(`${TAG} [rerank] provider=${wiring.provider} 抛错（${err instanceof Error ? err.message : String(err)}），降级原序`);
    ranked = null;
  }
  const ms = performance.now() - t0;
  if (ranked === null) {
    breaker.recordFailure();
    logger?.warn?.(`${TAG} [rerank] provider=${wiring.provider} 返回 null，降级原序`);
    degradeGate(ms);
    return;
  }
  breaker.recordSuccess();
  // 防御性整形：非有限 score/非整数或越界 index 剔除 + index 去重（首见保留）+ score 降序
  const seen = new Set<number>();
  const clean: RerankResult[] = [];
  for (const r of ranked) {
    if (!r || !Number.isFinite(r.score) || !Number.isInteger(r.index) || r.index < 0 || r.index >= lines.length) continue;
    if (seen.has(r.index)) continue;
    seen.add(r.index);
    clean.push({ index: r.index, score: r.score });
  }
  clean.sort((a, b) => b.score - a.score);
  // ── #99 F3（2026-10-25）：rerank 刻度校准化 + 全员低于阈值优雅降级 ──
  // local provider 输出原始 logit（bge 系 rank-correct 非校准——ZeroEntropy score-calibration
  // 结论：未校准分数对拍门槛必翻车，P3 实证 topScore −2.82 < −1.0 全杀 12 条）→ sigmoid
  // 归一 0..1 后再对门槛。配置 minScore 仍按 provider 原生刻度声明（local=logit），门槛同
  // 变换 sigmoid(minScore)——单调等价，部分过线场景接受/拒绝边界与旧逐位一致
  // （sigmoid(−1.0)≈0.269，换算出处=生产 config-override rerank.minScore=−1.0 logit 刻度）。
  // journal topScore 恒记 raw（#96 取证口径连续），top01/threshold01/scoreScale 附加归一化观测；
  // 云 provider（siliconflow/dashscope）原生 0..1 相关度不归一（scoreScale 键缺席 = native）。
  const logitScale = isLogitScaleProvider(wiring.provider);
  // sigmoid 变换与缺省门槛同源（recall/rerank/defaults.ts），别在这里另写一份。
  const score01Of = (s: number): number => (logitScale ? sigmoid01(s) : s);
  const threshold01 = score01Of(wiring.minScore);
  const rankedPass = clean.filter((r) => score01Of(r.score) >= threshold01);
  let finalIdxs: number[];
  let degraded: "all-below-minScore" | undefined;
  /** #137-F：融合锚点是否被强制保留（观测用）。 */
  let anchorForced = false;
  // B2-b：MMR 重排耗时（gates 观测；声明提到 if/else 外供 gates 组装读取）
  let mmrMs = 0;
  const scoredSet = new Set(clean.map((r) => r.index));
  /** filter 语义：达线保留；未达线剔除；未被 provider 评分的候选（截断漏排）原样保留。 */
  const keepByFilter = (passSet: Set<number>): number[] => {
    const idxs: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (passSet.has(i) || !scoredSet.has(i)) idxs.push(i);
    }
    return idxs;
  };
  /** #144：filter 的判定尺子（rerank 模式恒 floor 语义，不走题内相对规则）。 */
  const filterRuler = wiring.mode === "filter" ? wiring.filterRuler : DEFAULT_RERANK_FILTER_RULER;
  if (filterRuler.rule !== "floor") {
    // ── #144：题内相对尺子——只比同一题内的分数序，provider 换版/量纲漂移不再整题误杀或整题放行。
    // 绝对 minScore 此时不参与判定（两把尺子互相盖会让「floor 不生效」与「规则生效」混在一起无法归因）。
    const passSet = relativeKeepIdxSet(clean, filterRuler as RerankRelativeRuler);
    finalIdxs = keepByFilter(passSet);
  } else if (rankedPass.length === 0 && clean.length > 0) {
    // F3 优雅降级：全员低于阈值不清零（P3 病灶：经验层 0 行）——回退未重排顺序
    // （与 null/throw/熔断同族「原序注入」语义），journal degraded 归因；预算帽照常生效。
    degraded = "all-below-minScore";
    finalIdxs = lines.map((_, i) => i);
    logger?.debug?.(`${TAG} [rerank] 全员低于阈值（topScore=${clean[0].score} < minScore=${wiring.minScore}）→ 降级原序注入`);
  } else if (wiring.mode === "filter") {
    // #135 R4：floor 档——provider 打分只作绝对门槛，不清排、不改序（保原序注入）。
    finalIdxs = keepByFilter(new Set(rankedPass.map((r) => r.index)));
  } else {
    let passIdxs: number[] = rankedPass.map((r) => r.index);
    // #137-F：精排顺序直接生效——不再叠加任何原序加权（加权混排会稀释精排收益，机制已整体移除，见 docs §21.6）。
    if (mmr?.enabled && passIdxs.length > 1) {
      const tM = performance.now();
      // B2-b：pass 池整体置换（不减员），多样性优先级进序——预算帽照常在 slice 处生效
      passIdxs = mmrReorder(passIdxs, docs, mmr.lambda);
      mmrMs = performance.now() - tM;
    }
    // #137-F：融合锚点——预算收缩到 1~2 行时（W3 结论层占满 maxResults 的实测形态），
    // 单条注入行不允许被精排单方面换掉：融合主序 top-1 必须留在截断窗口内。
    // 有空间（cap≥2）时精排仍可改第 2..cap 名次，锚点只守住最高置信证据。
    const capInner = Math.max(cap, 0);
    // 锚点只在「融合 top-1 自己过了 floor」时生效——floor（minScore）语义不被锚点绕过。
    if (capInner > 0 && lines.length > 1 && passIdxs.includes(0)) {
      const anchored = anchorRerankOrder(passIdxs, capInner);
      if (anchored[0] !== passIdxs[0] || anchored.length !== passIdxs.length || !passIdxs.slice(0, capInner).includes(0)) {
        anchorForced = !passIdxs.slice(0, capInner).includes(0);
      }
      passIdxs = anchored;
    }
    finalIdxs = passIdxs;
    const rankedSet = new Set(clean.map((r) => r.index));
    for (let i = 0; i < lines.length && finalIdxs.length < lines.length; i++) {
      if (!rankedSet.has(i)) finalIdxs.push(i); // 未排序候选（截断漏排）原序垫尾
    }
  }
  /** #144：规则「过线」条数（cap 与 top-up 之前）。与 kept 分开记——否则「规则裁掉多少」与
   *  「预算截断多少」在观测里糊成一团，事后无法判断某次调参到底动了哪一层。 */
  const passCount = finalIdxs.length;
  // #137-F：floor 不饿死小窗口——rerank 模式下降级补位。
  // 实测病灶：cap（经验层预算）常只有 1~2 行，而 minScore 会把融合 top-1 也筛掉
  // （LME90：rerank-on 平均经验行 1.73 < rerank-off 2.33），证据直接变少。
  // 规则：floor 只负责剔除"多余的"候选；若达线行不够 cap，就按**融合原序**把被 floor
  // 剔掉的候选补回，直到填满窗口（补回顺序=融合序，不引入精排偏好）。
  let floorToppedUp = 0;
  const capN = Math.max(cap, 0);
  // #137-F：floor 不允许把窗口饿成"比预算更少"的证据。
  // 实测病灶：W3 结论层把经验层预算压到 1~2 行，而 minScore 又会把融合 top-1 在内的候选筛掉
  // （rerank-on 平均经验行 1.73 < rerank-off 2.33，LME90 cov 77.6% vs 82.6%）——这属于
  // 「用一个校准并不可靠的 logit 门槛决定少给证据」。规则：达线行不够 cap 时，按**融合原序**
  // 把被 floor 剔掉的候选补回填满窗口；floor 仍负责剔除"超出窗口"的尾部噪声。
  if (wiring.mode !== "filter" && capN > 0 && finalIdxs.length < capN) {
    const have = new Set(finalIdxs);
    for (let i = 0; i < lines.length && finalIdxs.length < capN; i++) {
      if (have.has(i)) continue;
      have.add(i);
      finalIdxs.push(i);
      floorToppedUp++;
    }
  }
  const final = finalIdxs.slice(0, Math.max(cap, 0));
  searchResult.gates = {
    ...searchResult.gates,
    rerank: {
      provider: wiring.provider,
      ms,
      kept: final.length,
      dropped: lines.length - final.length,
      ...(clean.length > 0 ? { topScore: clean[0].score } : {}),
      ...(logitScale
        ? {
            scoreScale: "logit-sigmoid" as const,
            threshold01,
            ...(clean.length > 0 ? { top01: sigmoid01(clean[0].score) } : {}),
          }
        : {}),
      ...(degraded ? { degraded } : {}),
      // #144：规则过线条数（cap 前）——kept 含预算截断，单看 kept 分不清是尺子还是预算干的。
      passCount,
      ...(wiring.mode === "filter"
        ? {
            mode: "filter" as const,
            // #144：判定尺子必须进 gate——事后归因「这题是被哪种尺子裁的」全靠它。
            ...filterRulerGateObs(filterRuler),
          }
        : {}),
      ...(anchorForced ? { anchor: true } : {}),
      ...(floorToppedUp > 0 ? { floorToppedUp } : {}),
      ...(mmr?.enabled ? { mmr: { lambda: mmr.lambda, ms: Math.round(mmrMs) } } : {}),
    },
  };
  // #144：候选分数转储（诊断；未设 RERANK_SCORE_DUMP 时零开销）。必须在 metas/lineSessions
  // 重映射之前取，否则落的是「已过滤后的」候选——那正是校准要避免的取样偏差。
  const scoreDumpPath = process.env.RERANK_SCORE_DUMP;
  if (scoreDumpPath) {
    appendRerankScoreDump(scoreDumpPath, {
      query,
      provider: wiring.provider,
      mode: wiring.mode,
      minScore: wiring.minScore,
      candidates: wiring.candidates,
      logitScale,
      threshold01,
      cap: Math.max(cap, 0),
      lineCount: lines.length,
      scored: clean.map((r) => ({ i: r.index, score: r.score })),
      order: lines.map((line, i) => ({
        i,
        rec: searchResult.metas?.[i]?.recordId ?? null,
        session: searchResult.lineSessions?.[i] ?? null,
        text: line,
      })),
      final: final.slice(),
      passCount,
      ...(wiring.mode === "filter" ? filterRulerGateObs(filterRuler) : {}),
      ...(degraded ? { degraded } : {}),
    });
  }
  searchResult.lines = final.map((i) => lines[i]);
  if (searchResult.scores) searchResult.scores = final.map((i) => searchResult.scores![i]);
  if (searchResult.metas) searchResult.metas = final.map((i) => searchResult.metas![i]);
  // #162：来源会话必须与 lines 同步重映射，否则折叠期的「同会话免疫」会张冠李戴。
  if (searchResult.lineSessions) searchResult.lineSessions = final.map((i) => searchResult.lineSessions![i]);
}

/**
 * #42 审查加固（F1/C-1 生产接线）：soul 渲染 anchorSelect 运行时组装——config 门透传 +
 * embedder/queryEmbeddingProvider 运行时注入（config 不携带向量）。provider=懒解析闭包：
 * cachedQueryEmbedding（与 L1 检索路共享 TTL 去重，TTL=cfg.recall.queryEmbeddingCacheTtlMs，
 * 缺省 60_000）；embed 失败→undefined（宁缺毋滥回退现状，不抛错）。queryText=cacheKey
 * 指纹源（query 变→签名键变，防旧选择串复活）。向量仅在 scorer 真正需要时（转正选择/
 * shadow 报告）才解析——缺省配置零 embed。导出仅为单测可见。
 */
export function buildSoulAnchorSelectRuntime(
  cfg: MemoryTdaiConfig,
  io: { embeddingService?: EmbeddingService; userText: string; logger?: Logger },
): SoulRenderOptions["anchorSelect"] {
  const anchorSelectCfg = cfg.coreMemory?.soulRender?.anchorSelect;
  if (!anchorSelectCfg) return undefined;
  return {
    ...anchorSelectCfg,
    scorer: {
      ...anchorSelectCfg.scorer,
      embedder: io.embeddingService ? (t: string) => io.embeddingService!.embed(t) : undefined,
      queryEmbeddingProvider: io.embeddingService
        ? async () => {
            try {
              return await cachedQueryEmbedding(
                io.embeddingService!,
                io.userText,
                cfg.recall?.queryEmbeddingCacheTtlMs ?? 60_000,
                io.logger,
              );
            } catch {
              return undefined;
            }
          }
        : undefined,
      queryText: io.userText,
    },
  };
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
  /** GROW-EVO P2.1（§2.4 时间旅行）：查询时点——失效排除与时间窗解析以此为"当前"；
   *  缺省 = new Date()。同时旁路会话复用缓存（不同时点的结果不可复用）。 */
  validityNow?: Date;
  /** P1 Task 2（spec §4.5）：精排 DI seam（测试与嵌入调用方）。缺省 = config 工厂路由
   *  （createReranker(cfg.recall.rerank, {fetchImpl})）。reranker 显式 null = 强制不可用
   *  （降级原序 + warn + 降级 gate）；undefined = 走工厂；breaker 缺省 = 模块级默认熔断器。 */
  rerankDeps?: {
    reranker?: MemoryReranker | null;
    breaker?: RerankBreaker;
    fetchImpl?: typeof fetch;
  };
  /** #40（ADR0003-P3 接线票 B）：工具面策展清单（代理侧 /v3/recall body 透传，可选）——
   *  仅在 coreMemory.soulRender.capabilities.enabled 门开时渲染进 soul 前缀
   *  「## 我能做什么」（渲染行=清单 1:1，#32 合同）；门关或未传=现状零渲染。 */
  capabilities?: string[];
}): Promise<LayeredRecallOutcome> {
  const { userText, cfg, pluginDataDir, logger, vectorStore, embeddingService, storage } = params;
  // #136（W2 软失效）：结论层/放宽通道不能重排序，只做"该不该硬丢"的模式判定。
  const validityMode: ValidityMode = cfg.recall?.validity?.mode === "soft" ? "soft" : "hard";
  // ── #61（2026-10-18）：分段计时打点 ──
  // v3 端点路（/v3/recall → 本函数）此前无任何分段日志：生产 5000ms 硬超时 504 时，
  // journal 时间线只显示 L1 hybrid ~70ms、soul ~130ms，其后 ~3.2s 完全静默——黑洞
  // 无从定位。分段口径：scene=scene index 读取；l2=结论层候选收集+选择+放宽+截断
  // （conclusionLayer.enabled=false 恒 0）；l1=L1 检索（FTS/向量/混合+精排+复用缓存）
  // 含 R7 经验行组装（slice/动态 topK/budget，同步微秒级）；soul=mood+state+soul-prefix
  // 渲染全链（含动态 import）。l1/l2/soul 打点在 else 分支内赋值，空 userText 走 if
  // 分支时恒 0（perfMs 仍出，零分支例外）。
  const tPerfStart61 = performance.now();
  let tPerfSceneMs61 = 0;
  let tPerfL2Ms61 = 0;
  let tPerfL1Ms61 = 0;
  let tPerfSoulMs61 = 0;

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
  const tPerfSceneStart61 = performance.now();
  const sceneIndexEntries = await readSceneIndex(profileDataDir, profileStorage);
  tPerfSceneMs61 = Math.round(performance.now() - tPerfSceneStart61);

  // Search relevant memories (L1 layer) — skip only when userText is empty/undefined
  const tSearchStart = performance.now();
  let memoryLines: string[] = [];
  let effectiveStrategy = "skipped";
  let recalledL1Memories: RecalledMemory[] = [];
  let searchTiming: SearchTiming = { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 };
  // P0-2 journal 观测（issue #2，Spec 终审 a1）：门槛淘汰计数（native 分支捕获 →
  // journal gates 字段；缺省 undefined = 门未启用/未淘汰，journal 缺字段同义）。
  let recallGates: SearchResult["gates"];
  let conclusionCount = 0;
  let experienceCount = 0;
  let sessionReused = false;
  let layered = false;
  // 立项③：灵魂指纹（函数级——hook/端点双路共享）
  let soulVersion: string | undefined;
  /** S-FEEL-1（M1）：近期情绪基调档位（enabled=false 或样本不足=undefined=meta 不出键）。 */
  let mood: string | undefined;
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
    // ── #141（2026-10-28）：结论层分阶段路由（routing="intent"）──
    // 票面根因②「三机制同阶段竞争」：结论与 turn 是同一知识的两种表示，同层竞争 ⇒ 零和替换。
    // 解：按查询意图给「表示层」分预算与顺序（INTENT_POLICY 单一源），而不是关掉某个机制。
    // 纯规则无外呼；缺省 routing="off" ⇒ r7Policy=undefined ⇒ 全链逐位现状。
    const r7RoutingMode = cfg.recall?.conclusionLayer?.routing ?? "off";
    const r7Intent = r7RoutingMode === "intent" ? classifyRecallIntent(r7CleanQuery) : undefined;
    const r7Policy: RecallIntentPolicy | undefined = r7Intent ? recallIntentPolicy(r7Intent) : undefined;
    // ── 审查修补 I①（关断矩阵纪律）：conclusionLayer.enabled 总开关 ──
    // 缺省 true = 现行为；false = 结论层整体退出（候选零收集、选择零执行、V2-3 放宽零触发）
    // → r7Conclusions 恒空 → 下游沿"无 L2 命中退化"同一既有路径（layered=undefined /
    // 结论行空 / 经验层全额 / metric scores 原样），输出与 R7 前基线逐位一致。不另写旁路。
    const tPerfL2Start61 = performance.now();
    const r7ConclusionLayerEnabled = cfg.recall?.conclusionLayer?.enabled !== false;
    // #138（2026-10-28）：结论层查询路由——「回忆 assistant 自己先前的输出」的查询整层跳过。
    // 依据（bench 逐桶）：single-session-assistant 的 gold 在 assistant 轮，而结论卡只蒸馏
    // user 侧事实——卡与查询词面重合却不含答案，注入只挤掉答案轮（cov 80→66.7、判对 93.3→80）。
    // 判定纯规则（query-intent.ts）；路由命中时结论层零候选、零 store 调用，预算全给经验层。
    // #141：intent 路由把 assistant-recall 也并进同一张策略表（INTENT_POLICY 里预算 0）。
    const r7ConclusionRoutingOff = (r7RoutingMode === "assistantRecall" && isAssistantRecallQuery(r7CleanQuery))
      || r7Intent === "assistant-recall";
    const r7Candidates: L2ConclusionCandidate[] = [];
    let r7Conclusions: L2ConclusionCandidate[] = [];
    // R71（2026-10-19）：结论层双门 gate 观测（A1 地板 / A2 rerank 门）——入 journal gates
    let r71Bm25Gate: RecallJournalGates["conclusionBm25"] | undefined;
    let r71ConclusionRerankGate: RecallJournalGates["conclusionRerank"] | undefined;
    if (r7ConclusionRoutingOff) {
      logger?.debug?.(`${TAG} [layered] #138 routing: assistantRecall query -> skip conclusion layer (full experience budget)`);
    }
    if (r7ConclusionLayerEnabled && !r7ConclusionRoutingOff) {
      const r7FtsTokens = parseFtsTokens(buildFtsQuery(r7CleanQuery));
      try {
        if (vectorStore && typeof vectorStore.isFtsAvailable === "function" && vectorStore.isFtsAvailable()) {
          const wfQuery = buildFtsQuery(r7CleanQuery);
          if (wfQuery) {
            // DS-RECALL-MERGE-001：isolationFilter 透传（undefined = 钩子路旧行为逐位；
            // 端点路 = 三元组收窄，store 层 P2-T14 家族既有能力，不改打分语义）
            const wfRows = await vectorStore.searchL1Fts(wfQuery, r7HalfLimit * 2, params.isolationFilter);
            for (const r of wfRows ?? []) {
              // GROW-EVO P2（§2.3）+ Task 8（bi-temporal 补口）：失效/未来生效记忆不进结论层候选（流程测试实测泄漏点）
              if (shouldHardDropValidity(r as { valid_start?: string; valid_end?: string }, new Date(), validityMode)) continue;
              if (r.type === "work_fact") {
                // R71-A1（2026-10-19）：FTS5 raw rank（负=更相关）透传为 raw rel（=-rank）——
                // bm25 预地板数据源；后端未提供（undefined）→ 地板豁免（宁缺毋滥不误杀）。
                const r71Rank = (r as L1FtsResult).rank;
                const r71Bm25Rel = typeof r71Rank === "number" && Number.isFinite(r71Rank) ? -r71Rank : undefined;
                r7Candidates.push({
                  sceneName: r.scene_name ?? "",
                  content: r.content,
                  source: "work_fact",
                  recordId: r.record_id,
                  ...(r71Bm25Rel !== undefined ? { bm25Rel: r71Bm25Rel } : {}),
                });
              }
            }
          }
        }
      } catch (err) {
        logger?.debug?.(`${TAG} [layered] work_fact conclusion candidates unavailable (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
      // T-D（第一性原理）：scene_block 注入门——对抗内容三级传播链的最后无门通道
      // （L1 → consolidation 蒸馏[已门] → scene_block 文件 → 注入块）。scene_index.json
      // 的 summary 若含对抗人设/指令/定时状态，直接进注入块（ev11 [结论|日常] 污染实证）。
      // 门 = identity 单一源（isIdentityImposition 拦人设回显；strip 拦状态陈述/指令），
      // 命中即拒收留痕（宁缺毋滥）；与其他 r7 通道（work_fact 已门）语义一致。
      for (const e of sceneIndexEntries) {
        const gateText = `${e.filename}\n${e.summary}`;
        if (isIdentityImposition(gateText) || stripIdentityStateResidue(gateText) === "") {
          logger?.debug?.(`${TAG} [layered] scene_block gate rejected "${e.filename}" (identity gate)`);
          continue;
        }
        r7Candidates.push({ sceneName: e.filename.replace(/\.md$/i, ""), content: e.summary, source: "scene_block" });
      }
      // ── R71-A1（2026-10-19）：work_fact 候选 bm25 rel 预地板（纯分数统计，零词表）──
      // #99 F2（2026-10-25）：绝对地板相对化——BM25 分数是语料相对值（corpus statistics，
      // 非可比绝对值，search-at-depth ch3-s2），库增长会让绝对门语义漂移（l1_archive 已
      // 6444 行）。相对门（优先）：minBm25RelRatio=α（[0,1] clamp），门槛 = α×topRel
      // （topRel=本候选池最大 raw rel）；α∈[0.3,0.5] 起步（票面）。legacy minBm25Rel 绝对分
      // 仍支持（未迁移部署逐位现状）；两键并存时相对门优先。kept-count 上限逻辑不动；
      // bm25Rel 缺席候选（scene_block / V2-3 放宽通道 / 后端未提供 rank）豁免不变——
      // 宁缺毋滥不误杀。gate 观测（minRel/kept/dropped + #95 来源拆分 + mode/alpha/topRel）入 journal。
      // #95（2026-10-25）：kept 语义 = 预选择候选总数（wf 过线 + sb 豁免），非 FTS 池大小——
      // kept/dropped 按来源拆分 keptWorkFact/keptSceneBlock（纯观测，筛选行为零变化）。
      const r71MinBm25RelRatio = cfg.recall?.conclusionLayer?.minBm25RelRatio;
      const r71MinBm25Rel = cfg.recall?.conclusionLayer?.minBm25Rel;
      const r71RatioOn = typeof r71MinBm25RelRatio === "number" && r71MinBm25RelRatio > 0;
      const r71AbsOn = typeof r71MinBm25Rel === "number" && r71MinBm25Rel > 0;
      if ((r71RatioOn || r71AbsOn) && r7Candidates.some((c) => c.bm25Rel !== undefined)) {
        let r71FloorThreshold: number;
        let r71FloorMode: "relative" | "absolute";
        let r71TopRel: number | undefined;
        if (r71RatioOn) {
          r71TopRel = 0;
          for (const c of r7Candidates) {
            if (c.bm25Rel !== undefined && c.bm25Rel > r71TopRel) r71TopRel = c.bm25Rel;
          }
          r71FloorThreshold = r71MinBm25RelRatio! * r71TopRel;
          r71FloorMode = "relative";
        } else {
          r71FloorThreshold = r71MinBm25Rel!;
          r71FloorMode = "absolute";
        }
        const r71BeforeFloor = r7Candidates.length;
        for (let i = r7Candidates.length - 1; i >= 0; i--) {
          const rel = r7Candidates[i].bm25Rel;
          if (rel !== undefined && rel < r71FloorThreshold) r7Candidates.splice(i, 1);
        }
        // #95（2026-10-25）：地板后按来源拆分计数（单遍按 source 累计——来源全集遍历，
        // 新增第三来源时拆分和 < kept 在 journal 可见，而非静默漏计）
        const r71KeptBySource: Record<string, number> = {};
        for (const c of r7Candidates) r71KeptBySource[c.source] = (r71KeptBySource[c.source] ?? 0) + 1;
        r71Bm25Gate = {
          minRel: r71FloorThreshold,
          kept: r7Candidates.length,
          dropped: r71BeforeFloor - r7Candidates.length,
          // 不变式（当前仅两来源）：keptWorkFact + keptSceneBlock === kept（单测锁定）
          keptWorkFact: r71KeptBySource.work_fact ?? 0,
          keptSceneBlock: r71KeptBySource.scene_block ?? 0,
          // #99 F2：地板口径（relative=α×topRel / absolute=legacy 绝对分）
          mode: r71FloorMode,
          ...(r71FloorMode === "relative" ? { alpha: r71MinBm25RelRatio, topRel: r71TopRel } : {}),
        };
        logger?.debug?.(`${TAG} [layered] R71-A1 bm25 floor(${r71FloorMode}): dropped=${r71Bm25Gate.dropped} kept=${r71Bm25Gate.kept} (minRel=${r71FloorThreshold}${r71TopRel !== undefined ? `, topRel=${r71TopRel}` : ""})`);
      }
      // v18-c：minUniqRatio 透传（conclusionLayer.minUniqRatio；undefined/0 = 关逐位现状）
      // #99 F1（2026-10-25）：textHitMaxTokenRatio 万词面剔除门退役——候选经 FTS 预筛天然
      // 含查询 token，候选集占比自指（恒≈1）致最贴题 token 反被剔（P3 结论层 0 行）。
      // 万词面降权回归 BM25 IDF 单一源（#53 idfWeighted 排序消歧），不再裁剪匹配集。
      r7Conclusions = selectL2Conclusions(r7CleanQuery, r7Candidates, {
        ftsTokens: r7FtsTokens,
        minUniqRatio: cfg.recall?.conclusionLayer?.minUniqRatio,
        // #53：textHit IDF 加权排序透传（conclusionLayer.idfWeighted；缺省 false=逐位现状）
        idfWeighted: cfg.recall?.conclusionLayer?.idfWeighted === true,
      }, r7HalfLimit);
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
            // GROW-EVO P2（§2.3）+ Task 8（bi-temporal 补口）：失效/未来生效记忆不进结论层候选（V2-3 放宽通道同款过滤）
            if (shouldHardDropValidity(r as { valid_start?: string; valid_end?: string }, new Date(), validityMode)) continue;
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
      // #138（2026-10-28）：上限改为可配（conclusionLayer.maxConclusions）——缺省仍取
      // floor(maxResults/2)（逐位现状），使「结论条数上限」与 smallToBig.maxExtraLines
      // 成为同一预算的两个可扫旋钮（票面评论 ④）。
      // #141（2026-10-28）：intent 路由档下策略预算与配置上限取 min（策略表是「按题型」更严的那条）：
      // exact-fact=0（精确事实靠原文行）、temporal/preference=1、update/aggregate=2。
      const r7ConclusionCapCfg = cfg.recall?.conclusionLayer?.maxConclusions ?? r7HalfLimit;
      const r7ConclusionCap = r7Policy?.conclusionBudget !== undefined
        ? Math.min(r7ConclusionCapCfg, r7Policy.conclusionBudget)
        : r7ConclusionCapCfg;
      r7Conclusions = r7Conclusions.slice(0, Math.max(0, r7ConclusionCap));
      if (r7Intent) {
        logger?.debug?.(`${TAG} [layered] #141 intent=${r7Intent} cap=${r7ConclusionCap} order=${r7Policy?.order ?? "-"} pairing=${r7Policy?.pairing ?? false} arbitrate=${r7Policy?.arbitrate ?? false}`);
      }
    }
    tPerfL2Ms61 = Math.round(performance.now() - tPerfL2Start61);
    // Task CAL C1（brief 裁决）：结论层注入前截断——纯注入层，不碰门槛/九通道排序。
    // 巨型场景块摘要（首跑 F1：21,660 字符万词面通用匹配器）按 conclusionLayer.maxCharsPerMemory
    // 截断（默认 2000）+ 尾部标注；0 = 通道关闭（逐位现状）。截断先于幂等指纹（截断态即缓存态）。
    const r7ConclusionMaxChars = cfg.recall?.conclusionLayer?.maxCharsPerMemory ?? 2000;
    // Batch B F2（2026-10-20 · issue #76）：总预算分配 + 句界截断模式。perLine =
    // floor(min(maxTotalChars/count, maxCharsPerMemory))；maxTotalChars 缺省/关 →
    // allocate 恒等返回 maxCharsPerMemory（逐位现状）。截断仍先于幂等指纹与 rerank 门
    // （缓存态=截断态）。
    const r7TruncateMode = cfg.recall?.conclusionLayer?.truncateMode ?? "chars";
    const r7PerLineMaxChars = allocateConclusionPerLineChars(
      r7Conclusions.length,
      cfg.recall?.conclusionLayer?.maxTotalChars,
      r7ConclusionMaxChars,
    );
    if (r7PerLineMaxChars > 0) {
      r7Conclusions = r7Conclusions.map((c) => ({
        ...c,
        content: r7TruncateMode === "sentences"
          ? truncateConclusionContentSentences(c.content, r7PerLineMaxChars)
          : truncateConclusionContent(c.content, r7PerLineMaxChars),
      }));
    }
    // ── R71-A2（2026-10-19）：结论层 rerank 语义门（主门）──
    // 选中结论按注入行形态（formatConclusionLine 去 "- " 前缀）统一 rerank，score <
    // rerankGate.minScore（local logits 缺省 -1.0）者剔除。门在幂等指纹缓存前（缓存态=
    // 门控态）。mode 缺省 "shadow"（shadow-first：只记录不过滤，journal 观测定标后切
    // enforce）；"off"=零开销。wiring 与经验层同源（resolveRerankWiring+rerankDeps）：
    // 非 active / 熔断开 → 旁路不误杀（bypass 留痕）；provider null/throw → 熔断计败
    // + bypass=rerank-failed；未覆盖候选不杀（垫尾语义，绝不静默丢弃）。绝对门槛必须
    // 按 provider 刻度定标（listwise softmax 对常数平移不变），禁硬编码。
    {
      const r71GateCfg = cfg.recall?.conclusionLayer?.rerankGate;
      const r71GateMode = r71GateCfg?.mode === "enforce" ? "enforce" : r71GateCfg?.mode === "off" ? "off" : "shadow";
      if (r71GateMode !== "off" && r7Conclusions.length > 0) {
        const r71GateWiring = resolveRerankWiring(cfg, params.rerankDeps, logger);
        if (r71GateWiring.state !== "active" || !r71GateWiring.breaker || r71GateWiring.breaker.isOpen()) {
          const r71Bypass = r71GateWiring.state === "off" ? "rerank-off"
            : r71GateWiring.state === "unavailable" ? "rerank-unavailable" : "breaker-open";
          r71ConclusionRerankGate = { mode: r71GateMode, provider: r71GateWiring.provider, ms: 0, kept: r7Conclusions.length, dropped: 0, bypass: r71Bypass };
        } else {
          const r71GateReranker = r71GateWiring.reranker!;
          const r71GateBreaker = r71GateWiring.breaker;
          const r71GateDocs = r7Conclusions.map((c) => formatConclusionLine(c).replace(/^- /, ""));
          const r71GateT0 = performance.now();
          let r71GateRanked: RerankResult[] | null = null;
          try {
            r71GateRanked = await r71GateReranker.rerank(r7CleanQuery, r71GateDocs);
          } catch (err) {
            logger?.warn?.(`${TAG} [rerank-gate] provider=${r71GateWiring.provider} 抛错（${err instanceof Error ? err.message : String(err)}），结论门降级旁路`);
            r71GateRanked = null;
          }
          const r71GateMs = performance.now() - r71GateT0;
          if (r71GateRanked === null) {
            r71GateBreaker.recordFailure();
            r71ConclusionRerankGate = { mode: r71GateMode, provider: r71GateWiring.provider, ms: r71GateMs, kept: r7Conclusions.length, dropped: 0, bypass: "rerank-failed" };
          } else {
            r71GateBreaker.recordSuccess();
            // 防御性整形（与 applyRecallRerank 同款）：index 去重首见 + 非有限/越界剔除
            const r71GateScoreOf = new Map<number, number>();
            let r71GateTop = -Infinity;
            for (const rr of r71GateRanked) {
              if (!rr || !Number.isFinite(rr.score) || !Number.isInteger(rr.index) || rr.index < 0 || rr.index >= r7Conclusions.length) continue;
              if (!r71GateScoreOf.has(rr.index)) r71GateScoreOf.set(rr.index, rr.score);
              if (rr.score > r71GateTop) r71GateTop = rr.score;
            }
            const r71GateMin = typeof r71GateCfg?.minScore === "number" && Number.isFinite(r71GateCfg.minScore) ? r71GateCfg.minScore : -1;
            // #99 F3（2026-10-25）：与经验层 applyRecallRerank 同款刻度校准——local provider
            // 原始 logit 先 sigmoid 归一 0..1 后对门槛（门槛同变换 sigmoid(minScore)，单调等价
            // 不改接受/拒绝边界）；未覆盖候选恒 Infinity 不杀（垫尾语义不变）。journal
            // scoreScale/top01/threshold01 附加归一化观测（topScore 仍记 raw，取证口径连续）。
            const r71GateLogitScale = isLogitScaleProvider(r71GateWiring.provider);
            const r71GateThreshold01 = r71GateLogitScale ? sigmoid01(r71GateMin) : r71GateMin;
            const r71GateScore01Of = (i: number): number => {
              const raw = r71GateScoreOf.get(i);
              return raw === undefined ? Infinity : r71GateLogitScale ? sigmoid01(raw) : raw;
            };
            const r71WouldDrop = r7Conclusions.reduce((acc, _c, i) => acc + (r71GateScore01Of(i) < r71GateThreshold01 ? 1 : 0), 0);
            const r71GateScaleFields = r71GateLogitScale
              ? {
                  scoreScale: "logit-sigmoid" as const,
                  threshold01: r71GateThreshold01,
                  ...(r71GateRanked.length > 0 && Number.isFinite(r71GateTop) ? { top01: sigmoid01(r71GateTop) } : {}),
                }
              : {};
            r71ConclusionRerankGate = {
              mode: r71GateMode,
              provider: r71GateWiring.provider,
              ms: r71GateMs,
              kept: r7Conclusions.length - r71WouldDrop,
              dropped: r71WouldDrop,
              ...(r71GateRanked.length > 0 && Number.isFinite(r71GateTop) ? { topScore: r71GateTop } : {}),
              ...r71GateScaleFields,
            };
            if (r71GateMode === "enforce" && r71WouldDrop > 0) {
              const r71Kept = r7Conclusions.filter((_c, i) => r71GateScore01Of(i) >= r71GateThreshold01);
              if (r71Kept.length === 0 && r71GateScoreOf.size > 0) {
                // #99 F3（2026-10-25）：全员低于阈值不清零——结论门降级旁路保留原选择
                // （与经验层 applyRecallRerank all-below 降级同族语义），journal degraded 归因。
                r71ConclusionRerankGate = {
                  mode: r71GateMode,
                  provider: r71GateWiring.provider,
                  ms: r71GateMs,
                  kept: r7Conclusions.length,
                  dropped: 0,
                  ...(r71GateRanked.length > 0 && Number.isFinite(r71GateTop) ? { topScore: r71GateTop } : {}),
                  ...r71GateScaleFields,
                  degraded: "all-below-minScore",
                };
                logger?.debug?.(`${TAG} [rerank-gate] enforce all-below → 降级旁路保留 ${r7Conclusions.length} 条结论 (minScore=${r71GateMin})`);
              } else {
                r7Conclusions = r71Kept;
                logger?.debug?.(`${TAG} [rerank-gate] enforce: dropped=${r71WouldDrop} kept=${r7Conclusions.length} (minScore=${r71GateMin})`);
              }
            } else if (r71GateMode === "shadow" && r71WouldDrop > 0) {
              logger?.debug?.(`${TAG} [rerank-gate] shadow: would-drop=${r71WouldDrop}/${r7Conclusions.length} (minScore=${r71GateMin})`);
            }
          }
        }
      }
    }
    // ── #78 R-b（2026-10-25，survey F4 small-to-big 下半段）：结论卡身世回捞（读面独立开关）──
    // 开关 cfg.recall.smallToBig（独立键，不挂 conclusionLayer 语义；代码缺省关=逐位现状，
    // 部署 yaml 显式开——#77 三键同款）。开启时对选中 work_fact 结论（recordId 在场）按
    // recordId 单跳回捞 part_of 证据行作预算内附加「上下文行」注入（行形态 `- [上下文|场景]
    // 内容`，与 formatConclusionLine 同族；每行截到 r7ConclusionMaxChars，截断模式同结论行）。
    // 方向地面真相：part_of 边 source=结论卡→target=证据行 ⇒ 回捞用 getLinksBySource
    // （brief 原文 getLinksByTarget 为 scout 措辞滑差，票评论已注明）。maxExtraLines 全局帽
    // （缺省 2，0=关）；附加行并入结论行序列，r7Budget 按结论行总数（含上下文行）计——
    // 附加行挤经验层配额 ⇒ 注入总行数恒 ≤ maxResults（注入总预算帽不破）。上下文行随结论内容同入幂等
    // 指纹缓存（缓存态=注入态）。关断矩阵：开关关 / 无 work_fact recordId / 缺
    // getLinksBySource 或 getL1ByIds[WithArchive] → 零 store 调用；软失败 warn 不阻塞召回。
    // derived_from 读面语义按 brief 规则留待另行拍板（一期只做 part_of）。
    // R-A 红线：上下文行零 valence/arousal/mood 情绪字段。
    const s2bCfg = cfg.recall?.smallToBig;
    // #141（2026-10-28）：成对约束与槽位记账的生效值——全局键强开 或 intent 策略要求。
    // 成对（pairing）只在回捞开启时生效（否则全体让位 = 关层，不是本票要的语义）。
    const r7PairingRequire = s2bCfg?.enabled === true
      && (cfg.recall?.conclusionLayer?.pairing === "require" || r7Policy?.pairing === true);
    const r7SlotMode = s2bCfg?.budget === "slot";
    let smallToBigLines: string[] = [];
    /** #141：上下文行按「结论卡下标」记账——成对约束丢弃结论时，其证据行必须同步移除。 */
    const s2bCardLines = new Map<number, string[]>();
    // #138（2026-10-28）：回捞可观测化——生产 journal 此前只有「上下文行数」，看不出是
    // 「没触发」还是「触发了但选错证据」。gates.smallToBig 记候选/入选/排名三段。
    let s2bGate: RecallJournalGates["smallToBig"] | undefined;
    if (s2bCfg?.enabled === true && r7Conclusions.length > 0 && vectorStore &&
        typeof vectorStore.getLinksBySource === "function" &&
        (typeof vectorStore.getL1ByIdsWithArchive === "function" || typeof vectorStore.getL1ByIds === "function")) {
      try {
        // #141：slot 模式或成对约束下，每张结论至少 1 条源证据（否则「必带证据」不可能满足）；
        // 其余档位维持 maxExtraLines 帽（逐位现状）。
        const s2bBaseExtra = Math.max(0, Math.floor(s2bCfg.maxExtraLines ?? 2));
        // maxExtraLines=0 = 显式关（尊重用户关断）；>0 时才把帽抬到「每卡 1 条」。
        const s2bMaxExtra = Math.max(
          s2bBaseExtra,
          (r7SlotMode || r7PairingRequire) && s2bBaseExtra > 0 ? r7Conclusions.length : 0,
        );
        const s2bRanked = s2bCfg.relevanceRanked !== false;
        const s2bTokens = s2bRanked ? parseFtsTokens(buildFtsQuery(r7CleanQuery)) : [];
        if (s2bMaxExtra > 0) {
          const s2bSeen = new Set(r7Conclusions.filter((c) => c.recordId).map((c) => c.recordId!));
          const s2bResolveByIds = (ids: string[]) =>
            vectorStore.getL1ByIdsWithArchive
              ? vectorStore.getL1ByIdsWithArchive(ids)
              : vectorStore.getL1ByIds!(ids);
          // ① 收集候选：逐卡拉 part_of 单跳证据，带上「查询 token 命中数」作为相关性分。
          // #138 根因（bench 7161e7e2 实证）：旧实现按 store 返回序填帽，会把前情行
          // （`User: 7 agents`）排在承载答案的 assistant 轮之前，且一张卡的证据就能吃满帽。
          const s2bCandidates: Array<{ ci: number; ord: number; row: L1SearchResult; score: number; sceneName: string }> = [];
          for (let ci = 0; ci < r7Conclusions.length; ci++) {
            const s2bConcl = r7Conclusions[ci];
            if (s2bConcl.source !== "work_fact" || !s2bConcl.recordId) continue;
            const s2bLinks = ((await vectorStore.getLinksBySource(s2bConcl.recordId, "part_of")) ?? []) as Array<{ targetId: string; type: string; strength: number; createdAt: string }>;
            const s2bEvIds = s2bLinks
              .map((l) => l?.targetId)
              .filter((id): id is string => typeof id === "string" && !s2bSeen.has(id));
            if (s2bEvIds.length === 0) continue;
            const s2bRows = ((await s2bResolveByIds(s2bEvIds)) ?? []) as L1SearchResult[];
            let ord = 0;
            for (const s2bRow of s2bRows) {
              if (!s2bRow || typeof s2bRow.record_id !== "string" || s2bSeen.has(s2bRow.record_id)) continue;
              s2bCandidates.push({
                ci,
                ord: ord++,
                row: s2bRow,
                score: s2bRanked ? evidenceRelevanceScore(String(s2bRow.content ?? ""), s2bTokens) : 0,
                sceneName: s2bConcl.sceneName ?? "",
              });
            }
          }
          // ② 排名：相关性降序 → 卡片序 → 边序（全确定性，无外呼）。
          if (s2bRanked) {
            s2bCandidates.sort((a, b) => (b.score - a.score) || (a.ci - b.ci) || (a.ord - b.ord));
          }
          const s2bEmitted = new Set<string>();
          const s2bEmit = (cand: (typeof s2bCandidates)[number]): boolean => {
            if (s2bEmitted.has(cand.row.record_id)) return false;
            const s2bContent = typeof cand.row.content === "string" && cand.row.content.trim()
              ? (r7TruncateMode === "sentences"
                ? truncateConclusionContentSentences(cand.row.content, r7ConclusionMaxChars)
                : truncateConclusionContent(cand.row.content, r7ConclusionMaxChars))
              : "";
            if (!s2bContent) return false;
            s2bEmitted.add(cand.row.record_id);
            const s2bLine = `- [上下文${cand.sceneName ? `|${cand.sceneName}` : ""}] ${s2bContent}`;
            smallToBigLines.push(s2bLine);
            // #141：按卡记账（成对约束丢弃结论行时同步丢弃其证据行）
            const s2bCard = s2bCardLines.get(cand.ci);
            if (s2bCard) s2bCard.push(s2bLine);
            else s2bCardLines.set(cand.ci, [s2bLine]);
            return true;
          };
          if (!s2bRanked) {
            // 回滚档：逐位旧行为（卡片序 → 边序，填满即止）。
            for (const cand of s2bCandidates) {
              if (smallToBigLines.length >= s2bMaxExtra) break;
              s2bEmit(cand);
            }
          } else {
            // ③ 成对回捞：第一轮每卡至多 1 条（摘要必带源证据）；余量按排名补足。
            const s2bUsedPerCard = new Map<number, number>();
            for (const cand of s2bCandidates) {
              if (smallToBigLines.length >= s2bMaxExtra) break;
              if ((s2bUsedPerCard.get(cand.ci) ?? 0) >= 1) continue;
              if (s2bEmit(cand)) s2bUsedPerCard.set(cand.ci, (s2bUsedPerCard.get(cand.ci) ?? 0) + 1);
            }
            for (const cand of s2bCandidates) {
              if (smallToBigLines.length >= s2bMaxExtra) break;
              if (s2bEmitted.has(cand.row.record_id)) continue;
              s2bEmit(cand);
            }
          }
          s2bGate = {
            mode: s2bCfg.budget === "slot" ? "slot" : s2bCfg.budget === "additive" ? "additive" : "shared",
            maxExtraLines: s2bMaxExtra,
            ranked: s2bRanked,
            candidates: s2bCandidates.length,
            kept: smallToBigLines.length,
          };
          if (smallToBigLines.length > 0) {
            logger?.debug?.(`${TAG} [small-to-big] context lines: +${smallToBigLines.length} (cap=${s2bMaxExtra}, candidates=${s2bCandidates.length}, ranked=${s2bRanked})`);
          }
        }
      } catch (err) {
        logger?.warn?.(`${TAG} [small-to-big] context backfill failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // ── #141（2026-10-28）：成对约束执行 ──
    // 入选的 work_fact 结论必须拿到 ≥1 条 part_of 证据行，否则让位给经验层（无源证据的摘要
    // 比原文信息更少，见 #155）。scene 型结论无 part_of 链、不参与本约束。
    // 丢弃结论必须连同它的证据行一起丢（否则留下孤儿上下文行白占注入预算）。
    let r7UnpairedDropped = 0;
    /** #141（评审 #10）：被丢弃结论的样本（recordId + 原因），观测面要能指名到卡。 */
    const r7DroppedSamples: Array<{ recordId: string | null; why: string }> = [];
    const r7PushDropSample = (recordId: string | null | undefined, why: string) => {
      if (r7DroppedSamples.length < 3) r7DroppedSamples.push({ recordId: recordId ?? null, why });
    };
    // #141 修补（评审 #4）：「查不到证据」≠「确实没有证据」。回捞通道没起来（store 无 part_of
    // 读面 / maxExtraLines=0 显式关 / 回捞软失败）时，若照样执行成对约束，会把整层结论静默清空
    // ——这不是票面要的「摘要让位给原文」，而是把能力缺失伪装成内容缺失。通道不可用 → 跳过成对
    // 并记 degraded（结论保留），让观测面能区分两者。
    let r7PairingDegraded: "pairing-unavailable" | undefined;
    const r7PairingAvailable = s2bGate !== undefined && (s2bGate.maxExtraLines ?? 0) > 0;
    if (r7PairingRequire && r7Conclusions.length > 0) {
      if (!r7PairingAvailable) {
        r7PairingDegraded = "pairing-unavailable";
        logger?.warn?.(`${TAG} [small-to-big] #141 pairing skipped: backfill unavailable (store/maxExtraLines=0/soft-fail); keeping ${r7Conclusions.length} conclusion(s)`);
      } else {
        const s2bKeep: number[] = [];
        for (let i = 0; i < r7Conclusions.length; i++) {
          const c = r7Conclusions[i];
          if (c.source !== "work_fact" || !c.recordId) { s2bKeep.push(i); continue; }
          if ((s2bCardLines.get(i)?.length ?? 0) > 0) s2bKeep.push(i);
        }
        r7UnpairedDropped = r7Conclusions.length - s2bKeep.length;
        if (r7UnpairedDropped > 0) {
          const s2bKeptSet = new Set(s2bKeep);
          for (let i = 0; i < r7Conclusions.length; i++) {
            if (!s2bKeptSet.has(i)) r7PushDropSample(r7Conclusions[i]?.recordId, "unpaired");
          }
          r7Conclusions = s2bKeep.map((i) => r7Conclusions[i]);
          smallToBigLines = s2bKeep.flatMap((i) => s2bCardLines.get(i) ?? []);
          if (s2bGate) s2bGate = { ...s2bGate, kept: smallToBigLines.length };
          logger?.debug?.(`${TAG} [small-to-big] #141 pairing: dropped ${r7UnpairedDropped} unpaired conclusion(s) (kept=${r7Conclusions.length}, context=${smallToBigLines.length})`);
        }
      }
    }
    // 幂等结论层（spec §2 R7-1，借团队 幂等与防重 模式）：结论未变化 → 复用已存行（不重组，cache 友好）
    // 审查修补 I③（TTL 解耦）：conclusionLayer.cacheTtlMs 独立键——缺省（未配置）回落
    // sessionReuseTtlMs 保持现行为；显式 0 = 关（每次重组，不缓存）。负值/非有限由 config
    // 解析层 clamp 0（同 maxCharsPerMemory 模式）。
    const r7ConclusionTtlMs = cfg.recall?.conclusionLayer?.cacheTtlMs ?? (cfg.recall?.sessionReuseTtlMs ?? 300_000);
    // DS-RECALL-MERGE-001：reused 标志上浮为端点 meta.sessionReused 的一部分（行为零变化）
    // F-EV12-2-b（REG-REMAINING-006 A-2 硬化）：结论层幂等缓存键并入租户三元组——
    // 端点路 sessionKey 被 resolveIsolation 缺省填充为 "default"（v2-schemas.ts:393，
    // 非其注释宣称的空串），sessionKey 单键会跨租户共享 LRU：命中需 fingerprint 相等
    // （内容良性），但 LRU 互相驱逐 + reused 标志语义失真（活体 P桶-b/Q桶
    // sessionReused=true 实证 2026-09-19）。
    const conclusionCacheKey = params.isolationFilter
      ? `${params.sessionKey}#${params.isolationFilter.teamId ?? ""}#${params.isolationFilter.userId ?? ""}#${params.isolationFilter.agentId ?? ""}`
      : params.sessionKey;
    // #78 R-b：上下文行并入 freshLines（缓存态=注入态；smallToBigLines 空 → 恒等数组=逐位现状）
    const r7FreshLines = smallToBigLines.length > 0
      ? [...r7Conclusions.map(formatConclusionLine), ...smallToBigLines]
      : r7Conclusions.map(formatConclusionLine);
    const r7ConclusionResolved = resolveIdempotentConclusionLines(
      conclusionCacheKey,
      conclusionFingerprint(r7Conclusions),
      r7FreshLines,
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
    // R7 预算对半切（spec §1）——提前到精排之前：rerank cap 消费经验层额度（结论行不入
    // 精排，精排只消费经验池，选出行数不得超过预算给经验层的额度）。
    // #78 R-b（2026-10-25）：smallToBig 开启时附加「上下文行」并入结论行序列，预算按结论行
    // 总数（含上下文行）计——experienceLimit = max(0, maxResults − 结论行总数)，附加行挤
    // 经验层配额 ⇒ 注入总行数恒 ≤ maxResults（「预算内附加」验收口径）。上下文行不入精排
    // 额度语义不变。smallToBig 关（无上下文行）→ splitBudget 原语义逐位现状（既有不变式：
    // 结论行 ≤ halfLimit 恒成立，splitBudget 的 half clamp 不触发）。
    // #138（2026-10-28）：上下文行预算归属——shared（缺省）沿用「附加行并入结论行总数、
    // 共同挤经验层配额」（上下文多 → 经验层 0 行，生产实测 98.4% 的结论层命中题经验层 ≤1 行）；
    // additive = 上下文行只随结论层走、不挤经验层保底：experienceLimit 按「结论行」算，
    // 上下文行在预算外附加（注入总行数 ≤ maxResults + maxExtraLines）——「摘要+源证据」成对
    // 补信息，而不是用摘要换掉原文行。
    const r7ContextLines = smallToBigLines.length;
    // #141（2026-10-28）：slot = 复合单元记账——一条结论 + 它必带的一条源证据记 1.5 槽
    // （conclusionLayer.slotCost，clamp [1,3]）。经验层额度 = floor(maxResults − 复合单元槽位)：
    // 「摘要 + 源证据」成对补信息，代价只按 1.5 行记，而不是把两行都算成挤占经验层。
    const r7SlotCost = Math.min(3, Math.max(1, cfg.recall?.conclusionLayer?.slotCost ?? 1.5));
    const r7Slot = r7SlotMode && r7ConclusionLines.length > 0
      ? computeSlotBudget({
          maxResults: r7MaxResults,
          conclusionCount: r7Conclusions.length,
          slotCost: r7SlotCost,
          // #141 修补（评审 #9）：成对未开时槽位记账按 1 记（复合单元只在「必带证据」时成立），
          // 否则会凭空把经验层额度扣掉 0.5×结论数行。
          pairing: r7PairingRequire,
        })
      : undefined;
    const r7Budget = r7Slot
      ? { conclusionLimit: r7ConclusionLines.length, experienceLimit: r7Slot.experienceLimit }
      : smallToBigLines.length > 0
        ? (s2bCfg?.budget === "additive"
            ? { conclusionLimit: r7ConclusionLines.length, experienceLimit: Math.max(0, r7MaxResults - r7Conclusions.length) }
            : { conclusionLimit: r7ConclusionLines.length, experienceLimit: Math.max(0, r7MaxResults - r7ConclusionLines.length) })
        : splitBudget(r7MaxResults, r7ConclusionLines.length);
    // R-A3（E3）：同 session 上轮 query 与本轮全等 → 复用上轮搜索结果（免搜索免外呼）。
    // sessionReuseTtlMs<=0 = 通道关；query 变化 / 不同 session / TTL 过期 → 正常搜索。
    const sessionReuseTtlMs = cfg.recall?.sessionReuseTtlMs ?? 300_000;
    // F-EV12-2（REG-REMAINING-006 A-2）：E3 缓存租户隔离——
    // ①空 sessionKey（/v3/recall body 缺 session_id 的端点路）→ 通道整体关断
    //   （与 v2-router 端点注释宣称的「空 sessionKey→通道退出」语义对齐；此前仅结论层有守卫）；
    // ②缓存键并入租户三元组——sessionKey 单键会让同 query 的不同租户在 TTL 内
    //   互相复用注入记忆列表（A桶→P桶 跨用户泄漏活体实证 2026-09-19）。
    const reuseCacheKey = params.isolationFilter
      ? JSON.stringify([params.isolationFilter.teamId ?? "", params.isolationFilter.userId ?? "", params.isolationFilter.agentId ?? "", params.sessionKey])
      : params.sessionKey;
    // P0-2 journal 观测：gates 并入 searchResult 载荷类型（与 SearchResult["gates"] 同形）
    let searchResult: SearchResult | undefined;
    if (sessionReuseTtlMs > 0 && !params.validityNow && params.sessionKey) {
      const entry = sessionReuseCache.get(reuseCacheKey);
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
      // P1-T7：重要度降权门（enabled=入乘子真实降权；缺省关断=恒等）。
      const importanceGateCfg = cfg.recall?.importancePenalty;
      const importanceGate: RecallJournalImportanceGateSpec | undefined = importanceGateCfg?.enabled
        ? { penalty: importanceGateCfg.penalty }
        : undefined;
      const signals: RankSignals = {
        timeBoost: cfg.recall?.timeBoost ?? DEFAULT_RANK_SIGNALS.timeBoost,
        recencyBoost: cfg.recall?.recencyBoost ?? DEFAULT_RANK_SIGNALS.recencyBoost,
        sigWeight: cfg.recall?.sigWeight ?? DEFAULT_RANK_SIGNALS.sigWeight,
        inferredPenalty: cfg.recall?.inferredPenalty ?? DEFAULT_RANK_SIGNALS.inferredPenalty,
        reinforcementWeight: cfg.recall?.reinforcementWeight ?? DEFAULT_RANK_SIGNALS.reinforcementWeight,
        moodBoost: cfg.recall?.moodBoost ?? DEFAULT_RANK_SIGNALS.moodBoost,
        emotionSalienceWeight: cfg.recall?.emotionSalienceWeight ?? DEFAULT_RANK_SIGNALS.emotionSalienceWeight,
        // D-3：敏感性降权（缺省 0=关断恒等）
        sensitivityPenalty: cfg.recall?.sensitivityPenalty ?? DEFAULT_RANK_SIGNALS.sensitivityPenalty,
        // P1-T7：重要度降权（enabled 才入乘子；关断恒 0=排序逐位不变）
        importancePenalty: importanceGate ? importanceGate.penalty : 0,
        // #135 R3：查询时间感知（enabled 才加成；缺省关=排序逐位现状）
        presentTemporalBoost: cfg.recall?.presentTemporal?.enabled
          ? (cfg.recall.presentTemporal.boost ?? 0.08)
          : 0,
        presentTemporalDays: cfg.recall?.presentTemporal?.recentDays ?? 30,
      };
      const signalsActive =
        signals.timeBoost > 0 ||
        signals.recencyBoost > 0 ||
        signals.sigWeight > 0 ||
        signals.inferredPenalty > 0 ||
        signals.reinforcementWeight > 0 ||
        signals.moodBoost > 0 ||
        signals.emotionSalienceWeight > 0 ||
        signals.sensitivityPenalty > 0 ||
        signals.importancePenalty > 0 ||
        (signals.presentTemporalBoost ?? 0) > 0;
      const needValues = coreRefBoost > 0 || signals.moodBoost > 0;
      // R-A2：候选池通道开关（cfg.recall；缺省 = spec §2 默认值，0 = 通道退出）
      const graphDiscount = cfg.recall?.graphDiscount ?? 0.6;
      const graphMinStrength = cfg.recall?.graphMinStrength ?? 0.5;
      const sceneBoost = cfg.recall?.sceneBoost ?? 0.04;
      let rank: RecallRankSignal | undefined;
      // P1-T7：importance 降权开启时即使信号全 0 也要建 rank（gate 行采集 = journal 观测前提）
      if (effectiveStrategy === "hybrid" && vectorStore && (needValues || signalsActive || graphDiscount > 0 || sceneBoost > 0 || importanceGate !== undefined)) {
        const { firedLabels, moodSign } = needValues
          ? await computeRecallValueSignals(sanitizeText(userText), vectorStore, params.profileIsolation, logger)
          : { firedLabels: [] as string[], moodSign: 0 };
        const now = params.validityNow ?? new Date(); // R-A1 确定性锚点（P2.1：time_point 时间旅行时=查询时点）
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
          // #135 R3：当下时态检测（boost>0 才 parse——timeWindow 先例；regex 纯函数零 I/O）
          presentTemporal: (signals.presentTemporalBoost ?? 0) > 0 ? detectPresentTemporalIntent(sanitizeText(userText)) : undefined,
          // P1-T7：重要度降权门参数（searchHybrid 消费：active 入乘子 + 双模式影子日志）
          ...(importanceGate ? { importanceGate } : {}),
        };
        if (firedLabels.length > 0) {
          logger?.debug?.(`${TAG} [coreRef-boost] fired=${JSON.stringify(firedLabels)}, boost=${coreRefBoost}`);
        }
      }
      // ── P1 Task 2（spec §4.5）：精排接线 ──
      // wiring 先行（可能 warn：configError/工厂 null）。active 时按 candidates 扩池
      // （浅拷贝 cfg，仅本次 searchMemories 生效；rank/预算/标签仍读原 cfg）——
      // 扩池给精排更大的候选面，精排后由 cap 收回预算经验层额度。
      const rerankWiring = resolveRerankWiring(cfg, params.rerankDeps, logger);
      const baseMaxResults = cfg.recall?.maxResults ?? 5;
      const searchCfg =
        rerankWiring.state === "active" && rerankWiring.candidates > baseMaxResults
          ? ({ ...cfg, recall: { ...cfg.recall, maxResults: rerankWiring.candidates } } as MemoryTdaiConfig)
          : cfg;
      searchResult = await searchMemories(userText, pluginDataDir, searchCfg, logger, effectiveStrategy as "keyword" | "embedding" | "hybrid", vectorStore, embeddingService, rank, r7LayeredCtx, params.isolationFilter, params.validityNow);
      // 精排在复用缓存落位前：缓存持有精排后结果（命中路不再外呼 provider，gate 随缓存复现）。
      await applyRecallRerank(r7CleanQuery, searchResult, rerankWiring, r7Budget.experienceLimit, logger,
      cfg.recall?.mmr?.enabled ? { enabled: true, lambda: cfg.recall.mmr.lambda } : undefined);
      // 审查 #3 修补：空结果不入复用缓存——瞬时失败（如外呼抖动/瞬时空召回）不放大成
      // TTL 窗口内的持续空召回；lines.length>0 才视为可用注入块。
      if (sessionReuseTtlMs > 0 && params.sessionKey && searchResult.lines.length > 0 && !params.validityNow) {
        sessionReuseCache.set(reuseCacheKey, { query: userText, result: searchResult, at: Date.now(), vectorStore, embeddingService });
        if (sessionReuseCache.size > SESSION_REUSE_MAX) {
          const oldest = sessionReuseCache.keys().next().value;
          if (oldest !== undefined) sessionReuseCache.delete(oldest);
        }
      }
    }
    memoryLines = searchResult.lines;
    // ── #162（2026-10-29）：装配层近重折叠的「同会话免疫」数据源 ──
    // 行 → 来源会话：同 session_id 的不同轮次是同一段对话里的连续证据，不能按「主题相似」折掉。
    // 以行字符串为键 → 后续 slice/重排/结论行插入都不需要维护平行数组（行被改写后再折叠无意义）。
    // 无来源（keyword/embedding SELECT 未带出、foldCluster 开启、结论行）→ 该行按跨来源口径判重（降级安全）。
    const sessionByLine = new Map<string, string>();
    const lineSessionsOfSearch = searchResult.lineSessions;
    if (lineSessionsOfSearch) {
      for (let i = 0; i < memoryLines.length && i < lineSessionsOfSearch.length; i++) {
        const sid = lineSessionsOfSearch[i];
        if (sid && !sessionByLine.has(memoryLines[i])) sessionByLine.set(memoryLines[i], sid);
      }
    }
    searchTiming = searchResult.timing;
    recallGates = searchResult.gates;
    // ── #141（2026-10-28）：表示仲裁（arbitrate="redundant"）──
    // 与已选经验层原文行语义重复的结论行让位，槽位还给经验层：原文既有答案又有时间戳与
    // 说话人，比摘要信息量大（票面「同一知识两种表示」的正面解，而不是靠关掉结论层回避）。
    // 比较集 = 本次预算内的经验行（确定性，不做跨轮假设）；让位张数记入 journal gates。
    let r7ConclusionLinesEff = r7ConclusionLines;
    let r7ArbitrateDropped = 0;
    const r7ArbitrateThreshold = Math.min(1, Math.max(0, cfg.recall?.conclusionLayer?.arbitrateThreshold ?? 0.75));
    const r7ArbitrateEnabled = r7ConclusionLines.length > 0
      && (cfg.recall?.conclusionLayer?.arbitrate === "redundant" || r7Policy?.arbitrate === true);
    if (r7ArbitrateEnabled && memoryLines.length > 0) {
      const r7Arb = arbitrateConclusions({
        conclusions: r7ConclusionLines,
        experienceLines: memoryLines.slice(0, r7Budget.experienceLimit),
        threshold: r7ArbitrateThreshold,
      });
      if (r7Arb.dropped.length > 0) {
        r7ArbitrateDropped = r7Arb.dropped.length;
        for (let k = 0; k < r7Arb.dropped.length; k++) {
          const idx = r7Arb.dropped[k];
          r7PushDropSample(r7Conclusions[idx]?.recordId, r7Arb.reasons[k] ?? "redundant");
        }
        r7ConclusionLinesEff = r7Arb.kept.map((i) => r7ConclusionLines[i]);
        logger?.debug?.(`${TAG} [layered] #141 arbitrate: dropped ${r7ArbitrateDropped}/${r7ConclusionLines.length} redundant conclusion(s) (threshold=${r7ArbitrateThreshold})`);
      }
    }
    // R71（2026-10-19）：结论层双门 gate 记录并入 journal（A1 地板 / A2 rerank 门）——
    // 与经验层 rerank gate 并列，观测链同源（logs/recall/*.jsonl gates 段）。
    // #141（2026-10-28）：conclusionRouting 观测门——灰度复核要能区分「没路由到」与
    // 「路由到了但预算 0 / 证据缺失被丢弃」，否则分阶段改动无法归因。
    const r7RoutingGate: RecallJournalGates["conclusionRouting"] | undefined =
      (r7RoutingMode !== "off" || r7PairingRequire || r7Slot || r7ArbitrateEnabled || s2bGate)
        ? {
            intent: r7Intent ?? null,
            mode: r7RoutingMode,
            budget: r7Policy?.conclusionBudget ?? null,
            order: r7Policy?.order ?? "conclusion-first",
            pairing: r7PairingRequire,
            arbitrate: r7ArbitrateEnabled,
            ...(r7UnpairedDropped > 0 ? { unpairedDropped: r7UnpairedDropped } : {}),
            ...(r7ArbitrateEnabled
              ? { arbitrateDropped: r7ArbitrateDropped, arbitrateThreshold: r7ArbitrateThreshold }
              : {}),
            ...(r7Slot ? { slotExperienceLimit: r7Slot.experienceLimit, slotCost: r7SlotCost } : {}),
            ...(r7PairingDegraded ? { degraded: r7PairingDegraded } : {}),
            ...(r7DroppedSamples.length > 0 ? { droppedSamples: r7DroppedSamples } : {}),
          }
        : undefined;
    if (r71Bm25Gate || r71ConclusionRerankGate || s2bGate || r7RoutingGate) {
      recallGates = {
        ...(recallGates ?? {}),
        ...(r71Bm25Gate ? { conclusionBm25: r71Bm25Gate } : {}),
        ...(r71ConclusionRerankGate ? { conclusionRerank: r71ConclusionRerankGate } : {}),
        ...(s2bGate ? { smallToBig: s2bGate } : {}),
        ...(r7RoutingGate ? { conclusionRouting: r7RoutingGate } : {}),
      };
    }
    // ── R7 预算对半切：r7Budget 已在精排接线前计算（rerank cap 消费）——此处只消费。
    // 无结论 → experienceLimit 全额 → slice 恒等 + 组装恒等 → 下游与现状逐位一致（退化安全）。
    // #141：仲裁让位的结论把槽位还给经验层（回补到宽预算；不超 maxResults）。
    const r7ExperienceLimitEff = Math.min(
      r7MaxResults,
      r7Budget.experienceLimit + r7ArbitrateDropped,
    );
    memoryLines = memoryLines.slice(0, r7ExperienceLimitEff);
    // #54（2026-10-19）：召回注入动态 topK——按经验层 scores 分布的 elbow（最大相邻
    // 落差）收缩注入条数（只缩不扩）。缺省 off=逐位现状（固定条数注入）；scores 缺席
    // （keyword FTS 路只回 lines、无平行分数）不调用；span<=0（全同分/非降序）在纯函数
    // 内不切。刻度无关（纯相对落差），兼容 nativeHybrid 相似度与 RRF fallback 两种量纲。
    // 切点在 r7ExperienceLineCount（下方）定格之前 → metric scores 切片自动对齐不串位。
    const dynScores54 = searchResult.scores;
    const dynTopKCfg54 = cfg.recall?.dynamicTopK;
    if (dynTopKCfg54?.enabled === true && dynScores54 !== undefined && dynScores54.length > 0) {
      const dynK54 = dynamicTopKCount(dynScores54, memoryLines.length, dynTopKCfg54);
      if (dynK54 < memoryLines.length) {
        logger?.debug?.(`${TAG} [dynamic-topk] elbow 收缩 ${memoryLines.length}->${dynK54}（minTopK=${dynTopKCfg54.minTopK}, dropRatio=${dynTopKCfg54.dropRatio}）`);
        memoryLines = memoryLines.slice(0, dynK54);
      }
    }
    // 审查修补（伴随 Critical）：经验行实际条数在 slice 后定格——scores 切片以此为界，
    // 修掉"经验命中不足 experienceLimit 时 scores 多切导致 metric 串位"的潜在错位。
    // ── R71-C（2026-10-19）：fts-only 降级注入帽 ──
    // 向量路死（ftsHits>0 ∧ embeddingHits=0 ∧ strategy≠keyword）时注入块（结论+经验合计）
    // 从尾部裁到 recall.ftsOnlyInjectCap 内（结论前置=头部保留优先）。缺省 2（无结果兜底；
    // 0=off=逐位现状）；非降级路径零触碰。帽在 R7 预算/动态 topK 之后（帽=无结果兜底的
    // 最后闸门，只可能更小）。T15-C 降级常量随之上移（degradedNote 消费点不变）。
    const recallDegradedFtsOnly =
      !!vectorStore && !!embeddingService &&
      searchTiming.ftsHits > 0 && searchTiming.embeddingHits === 0 &&
      effectiveStrategy !== "keyword";
    const r71FtsOnlyCap = cfg.recall?.ftsOnlyInjectCap ?? 2;
    // #141 修补（评审 #1）：intent 路由的表示顺序——精确事实/时间推理题 turn 优先（结论在后），
    // 聚合/比较/更新/偏好题结论优先（缺省）。
    // turn-first 下结论行在**尾部**，而下游两条裁剪（字符预算 applyRecallBudget、fts-only 帽）
    // 都是从尾部逐行丢 → 会把整块结论切掉。因此 turn-first 的裁剪必须**只作用于经验层、且在拼接之前**：
    // 结论行整块保留，经验层让出被结论占用的额度（结论行是「表示选择」的结果，不是可选装饰）。
    const r7TurnFirst = r7Policy?.order === "turn-first";
    if (r7TurnFirst) {
      const r7ExpReserve = r7ConclusionLinesEff.length;
      if (recallDegradedFtsOnly && r71FtsOnlyCap > 0) {
        const r7ExpCap = Math.max(0, r71FtsOnlyCap - r7ExpReserve);
        if (memoryLines.length > r7ExpCap) {
          logger?.debug?.(`${TAG} [fts-only-cap] degraded injection exp ${memoryLines.length}->${r7ExpCap} (cap=${r71FtsOnlyCap}, conclusions=${r7ExpReserve})`);
          memoryLines = memoryLines.slice(0, r7ExpCap);
        }
      }
      memoryLines = applyRecallBudget(memoryLines, cfg.recall, logger);
      memoryLines = assembleLayeredLines(memoryLines, r7ConclusionLinesEff);
    } else {
      memoryLines = assembleLayeredLines(r7ConclusionLinesEff, memoryLines);
      memoryLines = applyRecallBudget(memoryLines, cfg.recall, logger);
      if (recallDegradedFtsOnly && r71FtsOnlyCap > 0 && memoryLines.length > r71FtsOnlyCap) {
        logger?.debug?.(`${TAG} [fts-only-cap] degraded injection ${memoryLines.length}->${r71FtsOnlyCap} (cap=${r71FtsOnlyCap})`);
        memoryLines = memoryLines.slice(0, r71FtsOnlyCap);
      }
    }
    // 经验层条数在**裁剪之后**定格：scores 切片以此为界（turn-first 也可能被字符/fts 帽收缩）。
    const r7ExperienceLineCount = Math.min(memoryLines.length, searchResult.lines.length);

    // Extract structured RecalledMemory from formatted lines for metric reporting
    // R7：结论行前置 → metric scores 数组同步前插 0（结论非相似度命中，score=0 如实）
    const r7ExpScores = (searchResult.scores ?? []).slice(0, r7ExperienceLineCount);
    const r7MetricScores = r7ConclusionLinesEff.length > 0
      ? (r7TurnFirst
          ? [...r7ExpScores, ...r7ConclusionLinesEff.map(() => 0)]
          : [...r7ConclusionLinesEff.map(() => 0), ...r7ExpScores])
      : searchResult.scores;
    // #166：经验层的 turn 归属与 scores 同规则切片/前插（结论行不是召回命中，无 turn）。
    // 遮蔽后的行文本是事实短语，反查不出父 turn；recordId 的 `#f<N>` 后缀去掉即父 turn。
    const r7ExpTurnIds = (searchResult.metas ?? [])
      .slice(0, r7ExperienceLineCount)
      .map((m) => (m?.recordId ? parentTurnIdOf(m.recordId) : undefined));
    const r7MetricTurnIds = r7ConclusionLinesEff.length > 0
      ? (r7TurnFirst
          ? [...r7ExpTurnIds, ...r7ConclusionLinesEff.map(() => undefined)]
          : [...r7ConclusionLinesEff.map(() => undefined), ...r7ExpTurnIds])
      : r7ExpTurnIds;
    recalledL1Memories = memoryLines.map((line, i) => {
      const match = line.match(MEMORY_LINE_RE);
      const turnId = r7MetricTurnIds?.[i];
      if (match) {
        const tag = match[1];
        const content = match[2].trim();
        const typePart = tag.includes("|") ? tag.split("|")[0] : tag;
        return { content, score: r7MetricScores?.[i] ?? 0, type: typePart, ...(turnId ? { turnId } : {}) };
      }
      return { content: line, score: r7MetricScores?.[i] ?? 0, type: "unknown", ...(turnId ? { turnId } : {}) };
    });
    // ── DS-RECALL-MERGE-001：R7 meta 定格 + 注入块组装（自钩子原位平移，逐位一致）──
    // R71-C：counts 改注入块实测派生——fts-only 帽 / R7 预算 / 动态 topK 从尾部裁剪时，
    // 条数口径与注入块逐位对齐（此前固定值在裁剪态虚高）。无裁剪路径恒等（min/max 同值）。
    // #141 修补（评审 #1）：本条数不再用「位置推断」（min(结论数, 总行数)）——那在结论行被
    // 局部裁掉时会虚报（例：3 结论 + 2 turn，尾部丢 2 行 → 总行数 3 被读成 3 结论 0 turn）。
    // 改为按注入块里的实际行文本比对结论行多重集（结论行带 `- [结论…]` 标签，与经验行文本不同域）。
    const r7ConclusionLineBag = new Map<string, number>();
    for (const l of r7ConclusionLinesEff) r7ConclusionLineBag.set(l, (r7ConclusionLineBag.get(l) ?? 0) + 1);
    let r7InjectedConclusions = 0;
    for (const l of memoryLines) {
      const n = r7ConclusionLineBag.get(l);
      if (n !== undefined && n > 0) { r7ConclusionLineBag.set(l, n - 1); r7InjectedConclusions++; }
    }
    conclusionCount = r7InjectedConclusions;
    experienceCount = Math.max(0, memoryLines.length - conclusionCount);
    sessionReused = searchCacheHit || conclusionReused;
    layered = r7InjectedConclusions > 0;
    // #61：l1 段终点（tSearchStart 起含检索+精排+复用缓存+R7 经验行组装）；soul 段起点。
    tPerfL1Ms61 = Math.round(performance.now() - tSearchStart);
    const tPerfSoulStart61 = performance.now();
    // SOUL C3（REG-REMAINING-001）：身份段常驻——soul 前缀组装与记忆有无解耦。
    let soulPrefix = "";
    if (params.isolationFilter && vectorStore?.readCore) {
      try {
        const { buildSoulPrefix } = await import("./soul-assembler.js");
        const it = params.isolationFilter;
        // S-FEEL-1（M1）：近期情绪基调——enabled=false 时完全跳过（零行为差异=逐位现状）。
        // #36 保真度补全：store→三档封装下沉 mood-line.computeMoodTierFromStore（消费侧单一入口，
        // 禁第二份内联实现）；store 可选方法缺实现 → null（宁缺毋滥）。
        // 红线 R-A：mood 只进 soul 前缀与 meta.mood，不参与任何召回排序/加权（情绪不得喂自身）。
        let moodTierResult: { tier: "positive" | "neutral" | "strained"; sampleCount: number } | null = null;
        try {
          moodTierResult = await computeMoodTierFromStore(
            vectorStore,
            { teamId: it.teamId ?? "default", userId: it.userId ?? "default", agentId: it.agentId ?? "default" },
            cfg.coreMemory?.moodLine,
          );
        } catch (err) {
          logger?.warn?.(`[soul] mood compute failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
        // #28→#34 生产断层接线（2026-10-17）：#28 状态机已生产写 soul_state（真实租户行在库），
        // #34 渲染通道（opts.state → soul-assembler renderStateLine，soul-feeling 尾块）无人喂入
        // → 状态行永不渲染。此处单一接线点：store 实现可选方法 readSoulState（IMemoryStore
        // types.ts:802，返回 MaybePromise）才读；返回 null/undefined=无状态行 → 不传 opts.state
        //（#34 opt-in 语义：数据在=渲染，无数据=逐位现状，零新配置）。字段映射（store 行
        // camelCase 直接兼容 SoulState，仅 null→缺省归一）：topValue/turnSeq 为 null → 省略
        //（topValue 缺省由 soul-assembler directional 兜底，勿在此重算）；updatedAt → at
        //（渲染不消费，保留状态时刻）。红线 R-A 同款：state 只进 soul 前缀渲染与进程内 cacheKey，
        // 不参与 soulVersion 指纹（soul-assembler 指纹隔离）与任何召回排序。
        let soulState: SoulState | undefined;
        const stateStore = vectorStore;
        if (stateStore && typeof stateStore.readSoulState === "function") {
          try {
            const row = await stateStore.readSoulState?.({
              teamId: it.teamId ?? "default", userId: it.userId ?? "default", agentId: it.agentId ?? "default",
            });
            if (row) {
              soulState = {
                valence: row.valence,
                arousal: row.arousal,
                ...(row.topValue != null ? { topValue: row.topValue } : {}),
                ...(row.turnSeq != null ? { turnSeq: row.turnSeq } : {}),
                ...(row.updatedAt ? { at: row.updatedAt } : {}),
              };
            }
          } catch (err) {
            logger?.warn?.(`[soul] state read failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const soulMeta: { soulVersion?: string } = {};
        soulPrefix = await buildSoulPrefix(
          vectorStore,
          { teamId: it.teamId ?? "default", userId: it.userId ?? "default", agentId: it.agentId ?? "default" },
          logger,
          {
            // DS-SOUL-MEMORY-002 P1（F17）：四段渲染开关与段级预算（缺省 undefined=逐位现状）。
            selfIdentityEnabled: cfg.coreMemory?.selfIdentity?.enabled === true,
            budgetSelfChars: cfg.coreMemory?.soulRender?.budgetSelfChars,
            budgetIdentityChars: cfg.coreMemory?.soulRender?.budgetIdentityChars,
            maxRelationLines: cfg.coreMemory?.soulRender?.maxRelationLines,
            // #10 T4：三行锚列表预算（0=关=逐位现状，config-first）
            budgetAnchorChars: cfg.coreMemory?.soulRender?.budgetAnchorChars,
            budgetPersonChars: cfg.coreMemory?.soulRender?.budgetPersonChars,
            budgetCharacterChars: cfg.coreMemory?.soulRender?.budgetCharacterChars,
            // S-FEEL-1（M1）：近期基调行（null/undefined=不渲染=逐位现状）。
            moodTier: moodTierResult,            // S-CHAR-2（M2/P5）：品格行渲染门（缺省 false=逐位现状：品格锚仍混渲染于价值锚行）。
            // #28→#34（2026-10-17 接线）：当下状态行——soul_state 行非 null 才传（读取点见上，
            // mood 计算后）；缺省 undefined=不渲染=逐位现状；指纹隔离由 soul-assembler 保证
            //（state 只进进程内 cacheKey，不进 soulVersion）。
            ...(soulState ? { state: soulState } : {}),
            characterTensionEnabled: cfg.coreMemory?.characterTension?.enabled === true,
            // #30（R5-F1 接线）：soul 快照旁路落账开关（缺省 true=开；false=运维关闭持久化写）。
            snapshotsEnabled: cfg.coreMemory?.soulRender?.snapshotsEnabled,
            // #52 D3（双通道 slots 去重）：per-turn 身份两行省略门（缺省 true=逐位现状；
            // false=dual 路径跳过（我是谁）/（我心中的他）slots 行——会话头已承载）。
            perTurnSlots: cfg.coreMemory?.soulRender?.perTurnSlots,
            // #67（R3 身份叙事层，2026-10-19）：身份叙事化门——config 门透传（缺省 false=
            // 逐位现状；true=dual 路径身份两行由 renderIdentityNarrative 叙事段替代，
            // cacheKey nv 段隔离，不翻 soulVersion；Park 2411.10109 条目存储+叙事渲染并存）。
            identityNarrative: cfg.coreMemory?.soulRender?.identityNarrative?.enabled === true,
            // #29（R5）+#42（票 D / D9）：情境锚选择门——config 门透传 + 运行时注入
            //（embedder/queryEmbeddingProvider/queryText；F1 生产接线，组装见
            // buildSoulAnchorSelectRuntime：向量缺席=shadow 报告回退原形态/转正回退现状——宁缺毋滥）。
            anchorSelect: buildSoulAnchorSelectRuntime(cfg, { embeddingService, userText: params.userText, logger }),
            // soul 去重门（soul-dedupe，2026-10-19）：config 门透传（缺省 off=逐位现状；
            // dropped 走 buildSoulPrefix 内 debug 日志；cacheKey srd/ad 隔离，不翻 soulVersion）。
            strictRuleDedup: cfg.coreMemory?.soulRender?.strictRuleDedup,
            anchorDedup: cfg.coreMemory?.soulRender?.anchorDedup,
            // #40（ADR0003-P3 接线票 B）：capabilities 渲染门——config 门开且 body 携带
            // 非空清单才传（渲染行=清单 1:1，#32 一致性合同）；门关整链丢弃=逐位现状。
            ...(cfg.coreMemory?.soulRender?.capabilities?.enabled === true && params.capabilities?.length
              ? { capabilities: params.capabilities }
              : {}),
            // T3（未来性渲染面，T6-F1 接线 2026-10-17）：承诺块渲染门——config 门透传
            //（soulRender.promises.enabled 缺省 false=零渲染零查询=逐位现状）。
            promisesEnabled: cfg.coreMemory?.soulRender?.promises?.enabled === true,
          },
          soulMeta,
        );
        soulVersion = soulMeta.soulVersion;
        mood = moodTierResult?.tier;
      } catch (err) {
        logger?.warn?.(`[soul] prefix failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    tPerfSoulMs61 = Math.round(performance.now() - tPerfSoulStart61);
    if (memoryLines.length > 0) {
      const degradedNote = recallDegradedFtsOnly
        // I-1 复核修补：两义措辞 —— ftsHits>0∧embeddingHits=0 只证明"本轮向量召回无贡献"，
        // 无法区分向量层降级与相关度门滤除，禁止假警报式单因断言。
        ? "[degraded: fts-only] 本轮记忆召回仅来自关键词检索（FTS），向量召回无贡献（向量层降级或相关度门滤除），召回质量可能不完整。\n\n"
        : "";
      // G1-a（bench/recall-opt B1 生产化）：注入块时间序打包——config 门
      //（recall.injectTimeSort.enabled，缺省 false=分数序逐位现状）。依据 LME90 配对实验：
      // 语义分数序会把 knowledge-update 的旧值压过新值（hurt 9/23），时间升序后 B1 档判对 +15.6pp。
      const orderedLines =
        cfg.recall?.injectTimeSort?.enabled === true ? sortLinesByLeadingTimestamp(memoryLines) : memoryLines;
      // A2：注入前近重折叠（memoryLines 本体保留给 metric，块内用折叠后行集）
      // #162：同会话免疫 + 跨来源 containment + 同序覆盖（判据与实测见 foldNearDuplicates 注释与 docs §18.7）
      const foldedLines = foldNearDuplicates(orderedLines, { sessionOf: (line) => sessionByLine.get(line) });
      // G1-b：包裹语——neutral 去掉「仅作为参考」贬抑措辞并加如实指引（缺省 legacy=现行文案）
      const wrapperHead =
        cfg.recall?.injectWrapper === "neutral"
          ? "以下是与当前对话可能相关的历史对话记忆（按时间先后排列）。请结合当前对话使用这些记忆；若记忆不足以回答，请如实说明。"
          : "以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：";
      block =
        soulPrefix +
        `<relevant-memories>\n${degradedNote}${wrapperHead}\n\n${foldedLines.join(RECALL_LINE_SEPARATOR)}\n</relevant-memories>`;
    } else if (soulPrefix) {
      // C3：无记忆轮次——身份段常驻（"此刻的我"不因零召回而缺席）
      block = soulPrefix;
    }
  }

  // ── #61：分段计时汇总 + 单行观测日志（钩子与 v3 端点两路统一出口）──
  const perfMs61: RecallJournalPerfMs = {
    total: Math.round(performance.now() - tPerfStart61),
    scene: tPerfSceneMs61,
    // #63：expand 段 = searchTiming.expandMs（getExpansionTerms 计时；旧缓存条目/native 路
    // 缺字段 → 0）——journal 实锤 l1 中 ~4s 为 query-expand LLM 串行阻塞，不拆段必再误诊。
    expand: searchTiming.expandMs ?? 0,
    l2: tPerfL2Ms61,
    l1: tPerfL1Ms61,
    soul: tPerfSoulMs61,
  };
  logger?.info?.(`${TAG} [recall-perf] total=${perfMs61.total}ms scene=${perfMs61.scene} expand=${perfMs61.expand} l2=${perfMs61.l2} l1=${perfMs61.l1}(strategy=${effectiveStrategy},hits=${recalledL1Memories.length}) soul=${perfMs61.soul}`);

  // T5（用户 2026-09-22 拍板定案）：召回/灵魂注入日志——采集点单一源（钩子与路由两路
  // 共用于本函数返回点，禁第二份）。best-effort：writer 自吞错 + 本 try 兜底，零影响主链路。
  try {
    const journalCfg = cfg.recallJournal ?? { enabled: false, rotationSizeMB: 5, maxFiles: 5 };
    if (journalCfg.enabled) {
      appendRecallJournal(
        path.join(pluginDataDir, "logs", "recall"),
        {
          teamId: params.isolationFilter?.teamId ?? profileIsolation.teamId ?? "default",
          agentId: params.isolationFilter?.agentId ?? profileIsolation.agentId ?? "default",
        },
        {
          ts: new Date().toISOString(),
          query: userText,
          strategy: effectiveStrategy,
          teamId: params.isolationFilter?.teamId ?? profileIsolation.teamId ?? "default",
          userId: params.isolationFilter?.userId,
          agentId: params.isolationFilter?.agentId ?? profileIsolation.agentId ?? "default",
          sessionKey: params.sessionKey,
          sessionReused,
          layered,
          conclusionCount,
          experienceCount,
          searchTiming,
          ...(recallGates ? { gates: recallGates } : {}),
          perfMs: perfMs61,
          block,
          memoryLines,
        },
        journalCfg,
      );
    }
  } catch { /* 兜底：writer 已吞错，此处再兜一层 */ }

  return {
    memoryLines,
    recalledL1Memories,
    block,
    effectiveStrategy,
    searchTiming,
    ...(recallGates ? { gates: recallGates } : {}),
    conclusionCount,
    experienceCount,
    sessionReused,
    layered,
    soulVersion,
    mood,
    sceneIndexEntries,
    profileDataDir,
    profileStorage,
    profileScope,
    perfMs: perfMs61,
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
  /**
   * #137（W1 双通道）：通道内归一化融合分（0..1）。仅 fusion.mode="normalized" 时写入——
   * 届时它是**主序**键（#135 实证：合并后的加性小量改不了 rrfScore 主序），
   * rrfScore 退回去重/平局兜底；其余模式 undefined（逐位现状）。
   */
  relevance?: number;
  /** #137：各通道在本候选上的归一化分（dense/fact = 余弦，bm25 = 通道内 min-max）。 */
  channelScores?: { dense?: number; bm25?: number; fact?: number };
  formatable: FormatableMemory;
  coreRefHit: number;
  signal: number;
  mult: number;
  /** GROW-EVO P1：重巩固白名单 observed-only（工具路红线同款）需要 certainty 随池携带。 */
  certainty?: string;
  /** GROW-EVO P2（§2.3）：失效排除需要 valid_end 随池携带。 */
  validEnd?: string;
  /** Task 8（bi-temporal 补口，M4 #6）：未来生效排除需要 valid_start 随池携带（与 validEnd 成对）。 */
  validStart?: string;
  /** GROW-EVO P3 R10（§3.2）：情感显著度需要 valence/arousal 随池携带。 */
  valence?: number;
  arousal?: number;
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
  /** #137：事实通道耗时/命中数（通道关闭时缺字段 = 未打点）。 */
  factMs?: number;
  factHits?: number;
  /**
   * #63（2026-10-18）：V2-2 LLM 查询扩展耗时（仅 keyword/hybrid-fallback 路打点——
   * getExpansionTerms 实际触发时才有值；native/embedding 路与旧构造点缺省缺字段
   * = 未打点，journal 侧 ?? 0 兜底）。
   */
  expandMs?: number;
}

interface SearchResult {
  lines: string[];
  timing: SearchTiming;
  /**
   * 与 lines 平行的行元数据：持续态吸收所需 recordId/evidenceIds/sessionId；#166 起也是
   * 「行 → 父 turn」的唯一可靠来源（遮蔽行文本已换成事实短语，内容反查必失配）。
   * 折叠路径缺某行 meta 时对应位置为 undefined（如持续态吸收的落选兄弟）。
   */
  metas?: ({ recordId?: string; evidenceIds?: string[]; sessionId?: string } | undefined)[];
  /** #162：行级来源会话 id（与 lines 平行；keyword/embedding 路与折叠开启时缺省 = 无来源信息）。 */
  lineSessions?: (string | undefined)[];
  /** Per-line similarity scores (parallel to `lines`). Only populated on TCVDB nativeHybridSearch path. */
  scores?: number[];
  /**
   * P0-2 验证（issue #2，Spec 终审 a1 落实 2026-10-13）：召回门槛观测——门生效且
   * 有淘汰时记录 kept/dropped（journal `gates` 字段数据源，对比挡下率调参用）。
   * 缺省缺字段 = 门未启用或未淘汰（journal 侧同样缺字段 = 无门行为）。
   * P1 Task 2（spec §4.5）：gates 类型统一为 RecallJournalGates（nativeMinRRF + rerank）。
   */
  gates?: RecallJournalGates;
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
  /** GROW-EVO P2.1（§2.4 时间旅行）：查询时点透传（失效排除以该时点为"当前"）。 */
  validityNow?: Date,
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
    // #63（2026-10-18）：扩展段计时——journal 实锤 l1=4305ms 中 ~4s 为 query-expand
    // LLM 串行阻塞（真实 embedding RTT 仅 108ms），不拆段会再次误诊。
    // 灵魂注入性能轮（2026-10-19）：journal expandMs 口径改热路实际等待（waitMs 快照随
    // awaitExpansionTerms 返回值透出）；LLM 完整耗时降为 debug 日志（迟到完成不再污染
    // timing，expandMs > l1 墙钟的 journal 假象随之消除）。
    const getExpansionTerms = async (): Promise<string[]> => {
      const tLlm63 = performance.now();
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
        // 灵魂注入性能轮（2026-10-19）：失败负缓存（negativeTtlMs，缺省 30s，0=关）——
        // journal 实锤 expandQuery 失败/超时不缓存 → 同批新 query 每轮重付 LLM 全额 RTT
        //（实测 2.2-2.4s，clamp 后 4s 黑洞顶满 504）；负缓存期内短路 [] 不再外呼。
        negativeTtlMs: qeCfg.negativeTtlMs,
        logger,
      });
      logger?.debug?.(`${TAG} [query-expand] llm settled in ${Math.round(performance.now() - tLlm63)}ms (cache miss, hot-wait capped)`);
      return expansionTermsCache;
    };

    // 灵魂注入性能轮（2026-10-19）：扩展词热路等待帽（hotPathTimeoutMs，缺省 1500，0=旧行为
    // 全 clamp 等待）——race 兜底：帽内未返回 → 本轮无扩展词检索（[]），LLM 迟到结果照写
    // TTL 缓存（下轮同 query 命中）/失败写负缓存（negativeTtlMs 短路）。expandMs 观测口径
    // 改为热路实际等待（waitMs 快照随返回值透出；旧 expandMsMeasured=完整 LLM 耗时在迟到
    // 完成时会晚于 wait 快照落笔 → 不再作为 timing 源，防 journal expandMs > l1 墙钟假象）。
    // 消费路=keyword / hybrid-fallback 两处（embedding / native-hybrid 不触发扩展，E1.3 不动）。
    const hotPathCapMs = cfg.recall?.queryExpansion?.hotPathTimeoutMs ?? 1500;
    const awaitExpansionTerms = async (): Promise<{ terms: string[]; waitMs: number }> => {
      const tWait = performance.now();
      const terms = await raceWithTimeoutCap(getExpansionTerms(), hotPathCapMs, []);
      return { terms, waitMs: Math.round(performance.now() - tWait) };
    };

    if (effectiveStrategy === "keyword") {
      const tFts = performance.now();
      const { terms: kwTerms, waitMs: kwExpandWaitMs } = await awaitExpansionTerms();
      const kw = await searchByKeyword(cleanText, pluginDataDir, maxResults, threshold, logger, vectorStore, layered, kwTerms, isolationFilter);
      return { lines: kw.lines, lineSessions: kw.lineSessions, timing: { ftsMs: performance.now() - tFts, embeddingMs: 0, ftsHits: kw.lines.length, embeddingHits: 0, expandMs: kwExpandWaitMs } };
    }

    if (effectiveStrategy === "embedding") {
      const tEmb = performance.now();
      const emb = await searchByEmbedding(cleanText, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts, embedCacheTtlMs, layered, isolationFilter);
      return { lines: emb.lines, lineSessions: emb.lineSessions, timing: { ftsMs: 0, embeddingMs: performance.now() - tEmb, ftsHits: 0, embeddingHits: emb.lines.length } };
    }

    // Hybrid: if the store natively supports hybrid search (e.g. TCVDB does
    // server-side dense + sparse + RRF in a single API call), short-circuit
    // to avoid a redundant second HTTP request and a wasted local embed().
    if (vectorStore?.getCapabilities().nativeHybridSearch) {
      const tNative = performance.now();
      // R7-1：结论层已收编的记录从经验层排除（防重——命中已存不重组）
      const excludeIds = layered && layered.excludeIds.length > 0 ? new Set(layered.excludeIds) : null;
      // P0-2（issue #2 打分刻度错配）：native hybrid（TCVDB 服务端 RRF k=60）返回的是
      // rank-only 融合分——单通道 top1≈1/61≈0.0164、双通道 top1≈0.0328，recall.scoreThreshold
      // (0.3，余弦刻度) 对其形同虚设。recall.nativeMinRRF（缺省 0=关=逐位现状，config-first
      // 铁律）生效时丢弃低于门槛的 native 结果（宁缺毋滥）；SQLite fallback 路不在此判，
      // 其 scoreThreshold 全套精排保留。刻度依据 verify-t1.ts:202-203。
      const nativeMinRRF = cfg?.recall?.nativeMinRRF ?? 0;
      // DS-RECALL-MERGE-001：filter 透传（isolationFilter 缺省 = 旧行为逐位）
      const rawNative = (((await vectorStore.searchL1Hybrid?.({
        query: cleanText,
        topK: maxResults,
        ...(isolationFilter ? { filter: isolationFilter } : {}),
      })) ?? []) as L1SearchResult[]);
      const results = rawNative
        .filter((r) => !(nativeMinRRF > 0) || r.score >= nativeMinRRF)
        .filter((r) => !excludeIds || !excludeIds.has(r.record_id));
      // P0-2 可观测性（对抗审查 #7）：门杀召回与"服务端 0 条"不可区分——门槛生效且有
      // 淘汰时升 info 留痕（门前后计数），调参/事故定位数据源。同一计数进 journal
      // gates 字段（Spec 终审 a1：挡下率对比的数据闭环）。
      let nativeGateStat: { gate: number; kept: number; dropped: number } | undefined;
      if (nativeMinRRF > 0 && results.length < rawNative.length) {
        nativeGateStat = { gate: nativeMinRRF, kept: results.length, dropped: rawNative.length - results.length };
        logger?.info?.(`${TAG} [hybrid-native] nativeMinRRF gate: kept=${results.length} dropped=${rawNative.length - results.length}/${rawNative.length} gate=${nativeMinRRF}`);
      }
      const nativeMs = performance.now() - tNative;
      logger?.debug?.(`${TAG} [hybrid-native] Single-call hybrid: ${results.length} results in ${nativeMs.toFixed(0)}ms`);
      const fmts = results.map((r) => vectorResultToFormatable(r));
      const linesRaw = fmts.map((f) => formatMemoryLine(f));
      const linesMeta = fmts.map((f) => ({ recordId: f.recordId, evidenceIds: f.evidenceIds, sessionId: f.sessionId }));
      // #162：行级来源会话（同会话免疫数据源）；折叠开启时行与来源不再平行 → 不透传（降级=旧口径）
      const lineSessionsRaw = fmts.map((f) => f.sessionId);
      const scores = results.map((r) => r.score);
      // F-CLUSTER v2：折叠点=搜索路返回前（budget 之前去冗余，更多信息存活）；cfg.recall.foldClusterEnabled 缺省关
      // #166：折叠改走 meta 版，metas 与折叠后行继续平行——遮蔽行（注入文本已换成事实短语）
      // 只能靠 recordId 回指父 turn，折叠丢弃平行关系会把这类行判成「无来源」。
      const foldedNative = cfg?.recall?.foldClusterEnabled === true
        ? foldClusterAwareWithMeta(linesRaw, linesMeta)
        : undefined;
      const lines = foldedNative ? foldedNative.lines : linesRaw;
      return {
        lines,
        // #162：行级来源会话（同会话免疫数据源）；折叠开启时行与来源不再平行 → 不透传（降级=旧口径）
        ...(foldedNative ? {} : { lineSessions: lineSessionsRaw }),
        metas: foldedNative ? foldedNative.metas : linesMeta,
        scores,
        timing: { ftsMs: 0, embeddingMs: nativeMs, ftsHits: 0, embeddingHits: results.length },
        ...(nativeGateStat ? { gates: { nativeMinRRF: nativeGateStat } } : {}),
      };
    }

    // Fallback: run keyword + embedding in parallel, merge with client-side RRF (SQLite path)
    // 灵魂注入性能轮（2026-10-19）：旧实现 `await getExpansionTerms()` 内联阻塞在 searchHybrid
    // 形参取值处——LLM RTT 2.2-2.4s 全额串行进 l1 计时（journal 实锤 expand=4002/4007ms 顶满
    // clamp=504 直接根因）。改热路等待帽：帽内未返回 → 本轮无扩展词继续检索（宁缺毋滥同构），
    // 迟到 LLM 结果仍落 TTL/负缓存惠及后续轮次（见 awaitExpansionTerms 注释）。
    const { terms: expansionTerms, waitMs: fallbackExpandWaitMs } = await awaitExpansionTerms();
    const hybrid = await searchHybrid(
      cleanText, pluginDataDir, maxResults, threshold, vectorStore!, embeddingService!, logger,
      embeddingCallOpts, rank, embedCacheTtlMs, layered, expansionTerms,
      // V2-3（引擎三）：探索位 + 组合分精排（config 透传——缺省默认开/均等权重）
      cfg.recall?.exploreSlot !== false, cfg.recall?.rerankWeights,
      // DS-RECALL-MERGE-001：租户收窄 filter（钩子路缺省 undefined = 旧行为逐位）
      isolationFilter,
      // GROW-EVO P2（§2.3）：失效排除开关（cfg 透传——缺省 true）；
      // #136：validity.mode=soft 时传 "soft"（效期转为排序特征）
      excludeInvalidatedFor(cfg.recall?.validity?.mode, cfg.recall?.excludeInvalidated),
      validityNow,
      // Batch C C-b（#77 伴生 · survey F6b）：衰减乘子/时间锚回退（cfg 透传——缺省关=逐位现状）
      cfg.recall?.ageDecay?.enabled === true ? { halfLifeDays: cfg.recall.ageDecay.halfLifeDays } : undefined,
      cfg.recall?.timeProxFallbackEnabled === true,
      // #135 R1：候选池上游上限配置化（缺省 undefined = maxResults*3 逐位现状）
      cfg.recall?.candidateK,
      // #135 R2：加权融合配置（缺省 undefined = RRF 恒等逐位现状）
      cfg.recall?.fusion,
      // #137（W1 双通道）：事实键平行召回通道（缺省 undefined / enabled=false = 通道退出）
      cfg.recall?.factChannel,
    );
    // F-CLUSTER v2 折叠接线修复（2026-09-29）：fallback 同 native 分支接折叠；metas 缺失时 foldByDurative 自动跳过（宁漏勿错）
    // 2026-10-14 观测性修复：此前只透传 lines+timing，hybrid.gates（importancePenalty 观测）
    // 与 hybrid.scores/metas 全部丢弃——journal 永远无 gates.importancePenalty 的根因；
    // 精排（applyRecallRerank 551-552）已支持 scores/metas 平行重映射，透传即兼容。
    // #166：折叠改走 meta 版（foldClusterAwareWithMeta），metas 与折叠后行继续平行——遮蔽行
    // 的注入文本是事实短语、内容反查不出父 turn，只能靠 recordId 回指。
    const fallbackFolded = cfg?.recall?.foldClusterEnabled === true
      ? foldClusterAwareWithMeta(hybrid.lines, hybrid.metas)
      : undefined;
    // #162：metas.sessionId → 行级来源会话（与 lines 平行）；折叠开启时不再平行 → 不透传（降级=旧口径）
    const fallbackLineSessions = fallbackFolded ? undefined : hybrid.metas?.map((m) => m?.sessionId);
    const fallbackMetas = fallbackFolded ? fallbackFolded.metas : hybrid.metas;
    return {
      lines: fallbackFolded ? fallbackFolded.lines : hybrid.lines,
      ...(fallbackLineSessions ? { lineSessions: fallbackLineSessions } : {}),
      // #63：expandMs 在 searchMemories 层测得（灵魂注入性能轮 2026-10-19 起口径=热路实际
      // 等待 waitMs 快照），补进 hybrid.timing
      timing: { ...hybrid.timing, expandMs: fallbackExpandWaitMs },
      ...(hybrid.gates ? { gates: hybrid.gates } : {}),
      ...(hybrid.scores ? { scores: hybrid.scores } : {}),
      // #166：折叠也保持 metas 平行（遮蔽行只能靠 recordId 回指父 turn）
      ...(fallbackMetas ? { metas: fallbackMetas } : {}),
    };
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
): Promise<{ lines: string[]; lineSessions: (string | undefined)[] }> {
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
          return {
            lines: filtered.map((r) => formatMemoryLine(ftsResultToFormatable(r))),
            lineSessions: filtered.map((r) => (r as { session_id?: string }).session_id || undefined),
          };
        }

        // BM25 absolute scores are unreliable when the document set is very
        // small (e.g. 1–3 records) because IDF approaches 0.  In that case,
        // trust FTS5's MATCH + rank ordering and return the top results anyway.
        if (ftsResults.length <= maxResults) {
          logger?.debug?.(
            `${TAG} [keyword-fts] All ${ftsResults.length} results below threshold=${threshold} ` +
            `but document set is small — returning all matched results`,
          );
          const smallSet = ftsResults
            .filter((r) => !excludeIds || !excludeIds.has(r.record_id))
            .slice(0, maxResults);
          return {
            lines: smallSet.map((r) => formatMemoryLine(ftsResultToFormatable(r))),
            lineSessions: smallSet.map((r) => (r as { session_id?: string }).session_id || undefined),
          };
        }
        logger?.debug?.(`${TAG} [keyword-fts] FTS5 returned 0 results above threshold (from ${ftsResults.length} raw)`);
      }
    }
  }

  // FTS5 not available or returned no results — skip in-memory fallback to avoid O(N) full scan
  logger?.debug?.(`${TAG} [keyword] FTS5 unavailable or no results, skipping keyword search`);
  return { lines: [], lineSessions: [] };
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
): Promise<{ lines: string[]; lineSessions: (string | undefined)[] }> {
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
    return { lines: [], lineSessions: [] };
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
    return {
      lines: filtered.map((r) => formatMemoryLine(vectorResultToFormatable(r))),
      lineSessions: filtered.map((r) => r.session_id || undefined),
    };
  }

  logger?.debug?.(`${TAG} [embedding-search] No results above threshold ${threshold}`);
  return { lines: [], lineSessions: [] };
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
   * #136（W2 软失效）：新增 "soft" —— 效期不当硬过滤，而在截断预算前把 expired 排到
   * active 之后（问当下且存在更新行时才硬丢）。true/false 语义逐位不变。
   */
  excludeInvalidated?: ExcludeInvalidated,
  /** GROW-EVO P2.1（§2.4 时间旅行）：查询时点——失效排除以该时点为"当前"。 */
  validityNow?: Date,
  /**
   * Batch C C-b（#77 伴生，2026-10-20 · survey F6b）：检索期重算时间衰减乘子
   * （缺省 undefined = 逐位现状）。enabled 时由调用方 cfg.recall.ageDecay 透传；
   * 只乘 timeProx 因子，floor 0.05 never-a-filter。
   */
  ageDecay?: { halfLifeDays: number; floor?: number },
  /** Batch C C-b：timeProx 时间锚回退（缺省 false = 逐位现状；true 时 occurredAt 缺失回退 createdAt）。 */
  timeProxFallbackEnabled?: boolean,
  /**
   * #135 R1（检索融合 spec）：候选池上游上限 candidateK 配置化。缺省 undefined =
   * maxResults*3（逐位现状——T1 实测 pool32 被 3x 上限锁死，kept 仅 +0.16 的根因）。
   * 由 searchMemories 从 cfg.recall.candidateK 透传；正整数才生效（config 层 clamp）。
   */
  candidateKOverride?: number,
  /**
   * #135 R2（检索融合 spec）：加权融合配置（cfg.recall.fusion 透传）。缺省 undefined =
   * RRF 恒等权重（dense/bm25×1，recency/validity×0）= 逐位现状。V1 实证 ageDecay
   * 乘子在 rank-based RRF 路 0/90 零差异——recency/validity 以显式归一特征加入融合分。
   */
  fusion?: RecallFusionConfig,
  /**
   * #137（W1 双通道）：事实键平行召回通道（cfg.recall.factChannel 透传）。
   * 缺省 undefined / enabled=false / store 未实现 searchL1FactVector → 通道退出
   * （零调用、零行为变化——关断矩阵纪律）。
   */
  factChannel?: RecallFactChannelConfig,
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
        // P1-T7：重要度降权门（legacy C5 形状不带 = undefined = 门未启用）
        importanceGate: (rank as RecallRankSignal).importanceGate,
        // #135 R3：当下时态标记（legacy C5 形状不带 = undefined = 关断）
        presentTemporal: (rank as RecallRankSignal).presentTemporal,
      }
    : undefined;
  // Run keyword and embedding searches in parallel
  // #135 R1：candidateK 配置化（缺省 3x = 逐位现状；cfg.recall.candidateK 解锁扩池）
  const candidateK = candidateKOverride ?? maxResults * 3; // retrieve more for merging
  // #135 R2：融合权重（缺省恒等 = 逐位现状）
  const fusionW = fusionWeightsOf(fusion);
  const fusionHalfLifeDays = recencyHalfLifeDaysOf(fusion);
  // #137（W1 双通道）：事实键平行通道——store 未实现（如 tcvdb 服务端 embedding）或未开启
  // → 通道退出（零调用）。normalized 模式下通道分进归一化融合、否则按 RRF 贡献并入池。
  const normalizedMode = normalizedFusionEnabled(fusion);
  const factSearch = factChannel?.enabled === true && typeof vectorStore.searchL1FactVector === "function"
    ? vectorStore.searchL1FactVector.bind(vectorStore)
    : undefined;
  const factWeight = factChannelWeightOf(factChannel, fusion);
  const factTopK = factChannel?.candidateK ?? candidateK;

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
                    // D-3：敏感性透传（分层候选池 soul 源——徽章/R11）
                    sensitivity: (r as { sensitivity?: string }).sensitivity,
                    // P1-T7：重要度透传（降权乘子/影子门信号源——NULL=未评分=不罚）
                    importance: r.importance ?? null,
                    metadata,
                    // D-4：周期性事实透传（分层候选池 soul 源——丢值点⑤同位）
                    recurrence: isRecurrenceMeta((metadata as { recurrence?: unknown } | undefined)?.recurrence)
                      ? (metadata as { recurrence: { cadence: string; anchor: string | null; note: string } }).recurrence
                      : undefined,
                    // V6-1a：唤醒度透传（kw 路 ·强烈 徽章源——RankSignalItem 已扩 arousal）
                    arousal: (r as { arousal?: number }).arousal,
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
        // #137：同一 query 向量再打一次事实通道（原文主索引不动；失败非致命——通道静默退出）
        let factResults: L1SearchResult[] = [];
        let factMs = 0;
        if (factSearch) {
          const tFact = performance.now();
          try {
            factResults = ((await factSearch(queryEmbedding, factTopK, isolationFilter)) ?? []) as L1SearchResult[];
          } catch (err) {
            logger?.warn?.(`${TAG} Hybrid: fact channel failed (non-fatal, channel skipped): ${err instanceof Error ? err.message : String(err)}`);
          }
          factMs = performance.now() - tFact;
          logger?.debug?.(`${TAG} [hybrid-fact] Got ${factResults.length} candidates in ${factMs.toFixed(0)}ms (topK=${factTopK})`);
        }
        return { results, factResults, factMs, ms: performance.now() - tStart };
      } catch (err) {
        logger?.warn?.(`${TAG} Hybrid: embedding part failed: ${err instanceof Error ? err.message : String(err)}`);
        return { results: [] as L1SearchResult[], factResults: [] as L1SearchResult[], factMs: 0, ms: performance.now() - tStart };
      }
    })(),
  ]);

  const keywordResults = keywordResult.records;
  // L1 向量分是 cosine（0–1，绝对可比）：低于阈值（scoreThreshold，默认 0.3）的候选
  // 不进 RRF 融合——修掉"排名即注入"（原 `_threshold` 被忽略、低相关也进）。宁缺毋滥。
  const embeddingResults = embeddingResult.results.filter((r) => r.score >= threshold);
  // #137：事实通道候选——余弦下限（缺省回落 scoreThreshold）、类型门（onlyForTypes）、
  // 同 id 去重留最高分（store 已按距离排序，这里只做防御性归并）。
  const factOnlyTypes =
    factChannel?.onlyForTypes && factChannel.onlyForTypes.length > 0 ? new Set(factChannel.onlyForTypes) : null;
  const factMinScore = typeof factChannel?.minScore === "number" && Number.isFinite(factChannel.minScore)
    ? factChannel.minScore
    : threshold;
  const factByScore = new Map<string, L1SearchResult>();
  for (const r of factSearch ? embeddingResult.factResults : []) {
    if (!r || typeof r.record_id !== "string") continue;
    if (!(typeof r.score === "number" && Number.isFinite(r.score) && r.score >= factMinScore)) continue;
    if (factOnlyTypes && !factOnlyTypes.has(r.type)) continue;
    const prev = factByScore.get(r.record_id);
    if (!prev || r.score > prev.score) factByScore.set(r.record_id, r);
  }
  const factResults = [...factByScore.values()].sort((a, b) => b.score - a.score);

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
    ? {
        timeWindow: rankSignal.timeWindow,
        moodSign: rankSignal.moodSign,
        signals: rankSignal.signals,
        now: rankSignal.now,
        // #135 R3：query 当下时态命中 × 配置开关（关断时恒 false = 零加成）
        presentTemporal:
          (rankSignal.signals.presentTemporalBoost ?? 0) > 0 && rankSignal.presentTemporal,
      }
    : undefined;
  const structOf = (src: RankSignalItem | undefined): { signal: number; mult: number } =>
    signalCtx && src
      ? {
          signal: structuralSignalOf(src, signalCtx),
          mult:
            certaintyMultiplierOf(src, signalCtx.signals.inferredPenalty) *
            sensitivityMultiplierOf(src, signalCtx.signals.sensitivityPenalty ?? 0) *
            // P1-T7：重要度降权乘子（enabled 时非 0；关断恒 0 → 恒 1 = 排序逐位不变）
            importanceMultiplierOf(src, signalCtx.signals.importancePenalty ?? 0),
        }
      : { signal: 0, mult: 1 };

  const timing: SearchTiming = {
    ftsMs: keywordResult.ms,
    embeddingMs: embeddingResult.ms,
    ftsHits: keywordResults.length,
    embeddingHits: embeddingResults.length,
    ...(factSearch ? { factMs: embeddingResult.factMs, factHits: factResults.length } : {}),
  };

  if (keywordResults.length === 0 && embeddingResults.length === 0 && factResults.length === 0) {
    logger?.debug?.(`${TAG} Hybrid search: all channels returned 0 results`);
    return { lines: [], metas: [], timing };
  }

  // #137：normalized 融合需要先在各通道内部归一（BM25 无绝对刻度 → 通道内 min-max；
  // dense/fact 是余弦距离换算的 1-distance，已在 [0,1] 同量纲）。
  const keywordNorms = normalizedMode ? minMaxNormOf(keywordResults.map((r) => r.score)) : [];
  const denseNorms = normalizedMode ? embeddingResults.map((r) => cosineNormOf(r.score)) : [];
  const factNorms = normalizedMode ? factResults.map((r) => cosineNormOf(r.score)) : [];

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
  // P1-T7：观测日志行采集（rrf×mult；mult 已含 importance 乘子，raw 由 stats 反推）
  const importanceGateRows: ImportanceGateStatInput[] = [];
  for (let rank0 = 0; rank0 < keywordResults.length; rank0++) {
    const r = keywordResults[rank0];
    const id = r.record.id;
    const rrfScore = 1 / (RRF_K + rank0 + 1);
    const { signal, mult } = structOf(r.soul);
    importanceGateRows.push({
      rrfScore,
      mult,
      importance: (r.soul as { importance?: number | null } | undefined)?.importance ?? undefined,
    });
    // #135 R2：bm25 通道加权贡献（恒等权重 ×1 = 逐位现状）
    const fusionContribution = fusionW.bm25 * rrfScore;
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += fusionContribution;
      if (normalizedMode) existing.channelScores = { ...existing.channelScores, bm25: keywordNorms[rank0] };
    } else {
      const kwMeta = (r.record.metadata ?? {}) as Record<string, unknown>;
      // A3（REG-REMAINING-001）终极修复：keyword 通道的 soul 单独携带（R-A1 设计）但池插入
      // 只用 r.record 构造 formatable → 分离的 soul 从未并回 → FTS 通道行无 soul 标注。
      // 修复：并回标注所需四字段（与 embedding 通道 vectorResultToFormatable 对齐）。
      const kwSoul = r.soul as { occurred_at?: string; certainty?: string; valence?: number; significance?: number } | undefined;
      mergedMap.set(id, {
        rrfScore: fusionContribution,
        certainty: (r.soul as { certainty?: string } | undefined)?.certainty,
        validEnd: (r.soul as { valid_end?: string } | undefined)?.valid_end,
        validStart: (r.soul as { valid_start?: string } | undefined)?.valid_start,
        valence: (r.soul as { valence?: number } | undefined)?.valence,
        arousal: (r.soul as { arousal?: number } | undefined)?.arousal,
        formatable: {
          ...recordToFormatable(r.record),
          ...(kwSoul ? {
            occurred_at: kwSoul.occurred_at || undefined,
            certainty: kwSoul.certainty || undefined,
            valence: kwSoul.valence,
            significance: kwSoul.significance,
            // F-R12 修补：kwSoul 缺值不再抹掉 recordToFormatable 已透传的 sensitivity/recurrence
            //（原无条件 spread 用 undefined 覆盖=徽章丢失根因）
            ...((kwSoul as { sensitivity?: string }).sensitivity !== undefined
              ? { sensitivity: (kwSoul as { sensitivity?: string }).sensitivity }
              : {}),
            // D-4：周期性事实透传（kwSoul→formatable 徽章链）
            ...((kwSoul as { recurrence?: { cadence: string; anchor: string | null; note: string } }).recurrence !== undefined
              ? { recurrence: (kwSoul as { recurrence?: { cadence: string; anchor: string | null; note: string } }).recurrence }
              : {}),
            // V6-1a：唤醒度/时效起点（分层池 soul 源透传；条件并回防 undefined 抹值——F-R12 同教训）
            ...((kwSoul as { arousal?: number }).arousal !== undefined
              ? { arousal: (kwSoul as { arousal?: number }).arousal }
              : {}),
            ...((kwSoul as { valid_start?: string }).valid_start !== undefined
              ? { valid_start: (kwSoul as { valid_start?: string }).valid_start }
              : {}),
          } : {}),
        },
        coreRefHit: coreRefHitOf(r.record.metadata as Record<string, unknown> | undefined),
        signal,
        mult,
        coreRefCount: coreRefCountOf(kwMeta),
        recallCount: recallCountOf(kwMeta),
        ...(normalizedMode ? { channelScores: { bm25: keywordNorms[rank0] } } : {}),
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
      sensitivity: (r as { sensitivity?: string }).sensitivity,
      // P1-T7：重要度透传（降权乘子信号源——L1SearchResult.importance，NULL=不罚）
      importance: r.importance,
      metadata: embMeta,
    });
    importanceGateRows.push({
      rrfScore,
      mult,
      importance: r.importance ?? undefined,
    });
    // #135 R2：dense 通道加权贡献（恒等权重 ×1 = 逐位现状）
    const fusionContribution = fusionW.dense * rrfScore;
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += fusionContribution;
      if (normalizedMode) existing.channelScores = { ...existing.channelScores, dense: denseNorms[rank1] };
    } else {
      mergedMap.set(id, {
        rrfScore: fusionContribution,
        certainty: r.certainty,
        validEnd: r.valid_end,
        validStart: r.valid_start,
        valence: r.valence,
        arousal: r.arousal,
        formatable: vectorResultToFormatable(r),
        coreRefHit: coreRefHitOf(embMeta),
        signal,
        mult,
        coreRefCount: coreRefCountOf(embMeta),
        recallCount: recallCountOf(embMeta),
        ...(normalizedMode ? { channelScores: { dense: denseNorms[rank1] } } : {}),
      });
    }
  }

  // #137（W1 双通道）：事实通道候选并入池。
  //  - rrf/weighted 模式：**只收新候选**（池里已有的记录不加分）——否则同一记录同时被
  //    dense 低名次与 fact 高名次命中时会累加两份贡献、跨通道反超原文 rank1，违背本票红线
  //    「事实键只扩召回、不裁决排序」。只收新 = 原文命中之间的相对序逐位不变，
  //    事实新候选按 weight × 1/(RRF_K+rank+1) 插入到相应名次段；
  //  - normalized 模式：已有/新候选都只登记通道归一化分，主序由归一化融合分统一裁决
  //    （该模式本来就是「通道内归一化分融合」，与 rrf 档语义不同，见 ADR-0011）。
  for (let rankF = 0; rankF < factResults.length; rankF++) {
    const r = factResults[rankF];
    const id = r.record_id;
    const rrfScore = 1 / (RRF_K + rankF + 1);
    const factMeta = parseMetadataJson(r.metadata_json);
    const { signal, mult } = structOf({
      occurred_at: r.occurred_at,
      valid_start: r.valid_start,
      valid_end: r.valid_end,
      certainty: r.certainty,
      valence: r.valence,
      significance: r.significance,
      sensitivity: (r as { sensitivity?: string }).sensitivity,
      importance: r.importance,
      metadata: factMeta,
    });
    // P1-T7 观测口径：事实通道候选同样进重要度门统计（否则 gates.importancePenalty 漏掉一路）
    importanceGateRows.push({ rrfScore, mult, importance: r.importance ?? undefined });
    const fusionContribution = factWeight * rrfScore;
    const existing = mergedMap.get(id);
    if (existing) {
      if (normalizedMode) existing.channelScores = { ...existing.channelScores, fact: factNorms[rankF] };
      continue;
    }
    mergedMap.set(id, {
      rrfScore: fusionContribution,
      certainty: r.certainty,
      validEnd: r.valid_end,
      validStart: r.valid_start,
      valence: r.valence,
      arousal: r.arousal,
      formatable: { ...vectorResultToFormatable(r), recall_channel: "fact" },
      coreRefHit: coreRefHitOf(factMeta),
      signal,
      mult,
      coreRefCount: coreRefCountOf(factMeta),
      recallCount: recallCountOf(factMeta),
      channel: "fact",
      ...(normalizedMode ? { channelScores: { fact: factNorms[rankF] } } : {}),
    });
  }

  // #135 R2：recency/validity 显式融合特征（恒等权重 0 → 零加成逐位现状）。
  // V1 配对实证：ageDecay 乘子在 rank-based RRF 路零差异（0/90）——时近/有效性
  // 必须以归一特征直接进融合分才生效。特征追加在双通道合并后、池扩展/排序前。
  if (fusionW.recency > 0 || fusionW.validity > 0) {
    const fusionNow = rankSignal?.now ?? new Date();
    for (const [, v] of mergedMap) {
      if (fusionW.recency > 0) {
        v.rrfScore += fusionW.recency * recencyNormOf(v.formatable.occurred_at, fusionNow, fusionHalfLifeDays);
      }
      if (fusionW.validity > 0) {
        v.rrfScore += fusionW.validity * validityNormOf(v.validStart, v.validEnd, fusionNow);
      }
    }
  }

  // #137：normalized 融合——通道内归一化分合成可比的 relevance（主序），
  // rrfScore 退回去重/平局兜底（#135 实证：合并后的加性小量改不了 rrfScore 主序）。
  if (normalizedMode) {
    const fusionNow = rankSignal?.now ?? new Date();
    // 事实权重与 rrf 档同源：fusion.fact > recall.factChannel.weight > 0.6（见 factChannelWeightOf）。
    // 否则 fusionWeightsOf 的 0.3 缺省会静默盖掉用户配的 factChannel.weight（两个 SoT）。
    const normWeights = { ...fusionW, fact: factChannelWeightOf(factChannel, fusion) };
    for (const [, v] of mergedMap) {
      const cs = v.channelScores ?? {};
      v.relevance = normalizedRelevanceOf(
        {
          dense: cs.dense,
          bm25: cs.bm25,
          fact: cs.fact,
          recency: fusionW.recency > 0 ? recencyNormOf(v.formatable.occurred_at, fusionNow, fusionHalfLifeDays) : undefined,
          validity: fusionW.validity > 0 ? validityNormOf(v.validStart, v.validEnd, fusionNow) : undefined,
        },
        normWeights,
      );
    }
  }

  // Sort by combined RRF score and take top results
  // ── 重构式回忆（J 设计§5）：双召回线统一——持续态(work_fact)优先（稳定结论 > 零碎点），
  //    同层内仍按 RRF score 排序。与工具侧 formatSearchResponse 的持续态优先对齐。 ──
  // ── R-A2（R6 场景路由）：sceneHit 在候选池（mergedMap）就绪后按池内 scene_name
  // 计算（与工具侧同一 detectSceneHit 实现，单一源）；sceneBoost=0 → null（零开销）。 ──
  const sceneBoostVal = rankSignal?.sceneBoost ?? 0;
  // GROW-EVO P3 R10（§3.2）：情感显著度权重——缺省 0 = 不计算不比较（可证恒等）。
  const emotionWeight = rankSignal?.signals.emotionSalienceWeight ?? 0;
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
    a: { rrfScore: number; relevance?: number; coreRefHit: number; signal: number; mult: number; valence?: number; arousal?: number; formatable: FormatableMemory },
    b: { rrfScore: number; relevance?: number; coreRefHit: number; signal: number; mult: number; valence?: number; arousal?: number; formatable: FormatableMemory },
  ): number => {
    // #137：normalized 融合模式主序 = 通道内归一化融合分（0..1），rrfScore 只在平局时兜底。
    if (normalizedMode && (b.relevance ?? 0) !== (a.relevance ?? 0)) return (b.relevance ?? 0) - (a.relevance ?? 0);
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    if (b.coreRefHit !== a.coreRefHit) return b.coreRefHit - a.coreRefHit;
    const aScene = sceneSignalOfEntry(a.formatable);
    const bScene = sceneSignalOfEntry(b.formatable);
    if (bScene !== aScene) return bScene - aScene;
    if (b.signal !== a.signal) return b.signal - a.signal;
    if (emotionWeight > 0) {
      const aEmo = emotionSalienceOf({ valence: a.valence, arousal: a.arousal }) * emotionWeight;
      const bEmo = emotionSalienceOf({ valence: b.valence, arousal: b.arousal }) * emotionWeight;
      if (bEmo !== aEmo) return bEmo - aEmo;
    }
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
          // #137：normalized 模式下图扩散分按 relevance 刻度派生（同量纲，不混刻度）
          const maxHitRelevance = normalizedMode
            ? Math.max(...sorted.map(([, v]) => v.relevance ?? v.rrfScore))
            : 0;
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
                ...(normalizedMode ? { relevance: maxHitRelevance * graph.discount * pprNorm } : {}),
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

  // #136（W2 软失效）：future 恒丢；expired **降权保留**——rrfScore × SOFT_VALIDITY_PENALTY
  // 后继续参与组合精排（效期作为融合特征，保留相关度序，不做池级块重排）；
  // 仅当查询显式问"现在/最新"且存在**内容相关**的更新行时才硬丢（related 判定见
  // contentTokenOverlap——任意新记忆不足以成为"取代者"）。
  // #166：present-intent 同时驱动两件事——过期旧行硬丢，以及（见下方折叠块）该 turn 的
  // 注入文本降级为存活事实短语，否则同 turn 兄弟行会把旧值所在的原文带回注入。
  const presentIntent = detectPresentTemporalIntent(userText);
  // #166：值级遮蔽的触发比 presentIntent 更窄——**混合意图**不遮蔽（既问现在又问过去，如
  // 「How many do I lead now? … when I just started」：答案本身横跨旧值与新值，遮蔽会把含旧值的
  // gold turn 整条剔出注入，LME 深池实测该题 turnCov 0.5→0）。口径与 ADR-0015 决定 7 的
  // 「问历史逐位不变」一致：只有纯当下问句才遮蔽。presentIntent 仍原样喂 #136 的过期硬丢。
  const valueMaskIntent = presentIntent && !detectHistoryTemporalIntent(userText);
  // #166：valueMaskIntent 下池内的**过期事实行**（值级泄漏的「污染源」）；非则恒空。
  // 口径为什么对 **池内** 取 expired 而不是取 sel.dropped：
  //   ① 默认配置是 hard（excludeInvalidated=true）——过期行在截断后的 applyExclusion 才被
  //      过滤，折叠发生在其前，兄弟行的父原文照样回流，只覆盖 soft 等于默认档不修；
  //   ② soft 的 related 判定是 contentTokenOverlap，属性更新前后两句原文常无重叠
  //      （「我住在柏林，最近迷上摄影」 vs 「我上个月搬到慕尼黑了」），过期行常只被**降权
  //      保留**（demoted）而不硬丢，只看 dropped 会漏。
  // 故污染源 = 与模式无关的「池内 expired 行」；future 行不算（那是还没生效，不是旧值）。
  let supersededRows: [string, MergedPoolValue][] = [];
  if (validityEnabled(excludeInvalidated) && valueMaskIntent) {
    const staleNow = validityNow ?? new Date();
    // 注意刻度：池条目是 [id, value] 元组，validityStateOf 接受的却是**单个条目**——
    // accessors 必须按 value 写（写成 entry[1] 会重复解元组，拿到 undefined 后在 parseTime 里
    // 静默按 active 处理，遮蔽整条失效）。
    const valueAccessors = {
      validStart: (v: MergedPoolValue) => v.validStart,
      validEnd: (v: MergedPoolValue) => v.validEnd,
    };
    supersededRows = sorted.filter(([, value]) => validityStateOf(value, staleNow, valueAccessors) === "expired");
  }
  if (excludeInvalidated === "soft") {
    const now = validityNow ?? new Date();
    const sel = selectByValidity(sorted, {
      now,
      mode: "soft",
      presentIntent,
      accessors: {
        validStart: (entry) => entry[1].validStart,
        validEnd: (entry) => entry[1].validEnd,
      },
      related: ([, expired], [, active]) =>
        contentTokenOverlap(expired.formatable?.content, active.formatable?.content),
    });
    const droppedIds = new Set(sel.dropped.map(([id]) => id));
    const demotedIds = new Set(sel.demoted.map(([id]) => id));
    sorted = sorted
      .filter(([id]) => !droppedIds.has(id))
      .map(([id, v]) =>
        demotedIds.has(id)
          ? ([id, {
              ...v,
              rrfScore: v.rrfScore * SOFT_VALIDITY_PENALTY,
              // #137：normalized 模式主序是 relevance——降权必须同刻度落在主序上，否则软失效失效
              ...(v.relevance !== undefined ? { relevance: v.relevance * SOFT_VALIDITY_PENALTY } : {}),
            }] as [string, MergedPoolValue])
          : [id, v],
      );
  }

  // ── RV2-2（精排重设计 + E3.1 探索位）：与工具路 executeMemorySearch 截断前同层
  // 对齐（R-A1 教训）——消费同一单一源纯函数（applyCompositeRerank / applyExploreSlot）。
  // relevanceNorm 池内 max 归一：直接命中 = v.rrfScore（RRF fused）；图候选 = 派生分
  // maxHitScore×discount×pprNorm（同量纲——E2.1 派生分即相关度折扣分）；value/scene
  // 补池 = 0。结构因子（timeProx/significance/coreRef）合计 ≤30%（相关度主导契约）。
  // now 锚点沿 R-A1 纪律（rankSignal.now 快照；缺省 new Date()）。 ──
  const v2Now = rankSignal?.now ?? new Date();
  // Batch C C-b（#77 伴生 · survey F6b）：衰减乘子/时间锚回退（缺省 undefined/false = 逐位现状）
  const r7AgeDecay = ageDecay && Number.isFinite(ageDecay.halfLifeDays) && ageDecay.halfLifeDays > 0 ? ageDecay : undefined;
  sorted = applyCompositeRerank(
    sorted,
    ([, v]) => ({
      // #137：normalized 模式下 relevance 已是 0..1 的通道归一化融合分（主序口径）
      relevance: v.relevance ?? v.rrfScore,
      // fallback 锚=formatable.timestamp（记录创建时刻：kw 路 record.timestamps[0] :2938 / 向量路 r.timestamp_str :3010，两 converter 均带）
      occurredAt: v.formatable.occurred_at ?? (timeProxFallbackEnabled === true ? (v.formatable.timestamp ?? null) : null),
      significance: v.formatable.significance,
      coreRefCount: v.coreRefCount,
      isWorkFact: v.formatable.type === "work_fact",
    }),
    rerankWeights ?? DEFAULT_COMPOSITE_WEIGHTS,
    v2Now,
    r7AgeDecay,
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

  // ── #146（W2b 事实级双时态）：事实行 → turn 的读侧投影 ────────────────────────
  // 记忆系统三个粒度不共用一个单位：写/失效=属性槽，存储=事实行，**召回预算与注入=turn**。
  // 事实行模式下若按行计 k，同一 turn 的 n 条事实会各吃一个槽（槽位通胀，实测 turnCov@5
  // 78.4→68.0、偏好桶 93.3→55.6），且片段化丢语境。这里在截断前按 fact_of 折叠，保留每组
  // 最高分的那条——它的 content 就是父 turn 原文（写侧保证），与整行基线逐位同分。
  // 无 fact_of 的普通记忆原样保留（缺省路径零行为变化）。
  // #166（值级泄漏）：行级失效对，文本级不对——单值事实被判过期后，同 turn 的多值兄弟行
  // 仍 active，折叠回 turn 时又把父原文（含旧值）带回注入。这里把池内过期行（不论硬丢/降权）当污染源：
  // 该 turn 的存活行改用**自己的事实短语**注入（metadata.fact_phrase），短语缺失或仍含
  // 任何被取代旧值的行直接剔出注入——宁可少给一条证据，绝不把旧值塞回上下文。
  // 非 present-intent 时 superseded 为空 → 逐位保持 v2 行为（历史回溯仍可看到旧值）。
  if (sorted.some(([, v]) => v.formatable.factOf)) {
    const collapsed = collapseFactRowsByTurn(
      sorted,
      ([, v]) => v.formatable.factOf,
      ([, v]) => v.relevance ?? v.rrfScore,
      {
        superseded: supersededRows,
        phraseOf: ([, v]) => v.formatable.factPhrase,
        valueOf: ([, v]) => v.formatable.factValue,
      },
    );
    sorted = collapsed.displayContent.size > 0
      ? collapsed.items.map((entry) => {
          const safe = collapsed.displayContent.get(entry);
          return safe
            ? ([entry[0], { ...entry[1], formatable: { ...entry[1].formatable, displayContent: safe } }] as [string, MergedPoolValue])
            : entry;
        })
      : collapsed.items;
    if (collapsed.stats.collapsed > 0) {
      logger?.debug?.(
        `${TAG} [W2b-fact-rows] collapsed ${collapsed.stats.collapsed} fact-row hit(s) into parent turns` +
        ` (${collapsed.stats.before}→${collapsed.stats.after})`,
      );
    }
    if (collapsed.stats.maskedRows > 0 || collapsed.stats.droppedRows > 0) {
      logger?.debug?.(
        `${TAG} [W2b-fact-rows] present-intent value masking: ${collapsed.stats.maskedRows} row(s) re-rendered as fact phrase,` +
        ` ${collapsed.stats.droppedRows} turn(s) left with no injectable row (stale values=${collapsed.stats.staleValues})`,
      );
    }
  }

  const top = sorted.slice(0, maxResults);

  if (top.length > 0) {
    logger?.debug?.(
      `${TAG} Hybrid search found ${top.length} results ` +
      `(keyword=${keywordResults.length}, embedding=${embeddingResults.length})`,
    );
    // GROW-EVO P2（§2.3）：召回默认排除失效记忆（excludeInvalidated，spec 拍板①缺省
    // true；现存库无失效行 = 逐位不变）。过滤在 bump 之前——失效记忆连 recall_count
    // 都不积累（宁缺毋滥）。
    // Task 8（bi-temporal 补口，M4 #6）：与工具路 filterByValidity 对齐——改走共享谓词
    // isOutsideValidityWindow 完整区间语义（valid_start 未来生效同样排除；解析失败的
    // valid_start/valid_end 保留不误删）。池携带 validStart/validEnd（keyword soul /
    // embedding 行双通道注入），一致性由 filter-invalidated.test.ts 与
    // bitemporal-two-path.test.ts 钉死。
    // #136：soft 已在截断前处理（排序/硬丢），此处不再二次过滤；true/undefined 逐位不变。
    const applyExclusion = excludeInvalidated !== false && excludeInvalidated !== "soft";
    let visibleTop = top;
    if (applyExclusion) {
      const now = validityNow ?? new Date();
      visibleTop = visibleTop.filter(([, v]) =>
        !isOutsideValidityWindow({ valid_start: v.validStart, valid_end: v.validEnd }, now),
      );
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
    // P1-T7：重要度降权观测日志（rank.importanceGate 在场即产出——penalized=实际分，raw=反推值）。
    // 无 gate = 缺字段 = 门未启用（journal/下游口径）；空池早退不产出（无可观测语义）。
    const importanceGateOut = rankSignal?.importanceGate
      ? { importancePenalty: importanceGateStats(importanceGateRows, rankSignal.importanceGate) }
      : undefined;
    return {
      lines: visibleTop.map(([, { formatable }]) => formatMemoryLine(formatable)),
      metas: visibleTop.map(([, { formatable }]) => ({ recordId: formatable.recordId, evidenceIds: formatable.evidenceIds, sessionId: formatable.sessionId })),
      // 2026-10-14 观测性修复：fallback 消费方（searchMemories 1545）此前丢弃 scores →
      // metric 上报全 0；此处随 metas 一并返回（rrfScore 刻度，与 lines 平行，精排重映射兼容）。
      scores: visibleTop.map(([, v]) => v.relevance ?? v.rrfScore),
      timing,
      ...(importanceGateOut ? { gates: importanceGateOut } : {}),
    };
  }

  logger?.debug?.(`${TAG} Hybrid search: no results after merge`);
  return { lines: [], metas: [], timing };
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
import { isRecurrenceMeta, recurrenceLabel } from "../record/l1-extractor.js";
import {
  cosineNormOf,
  factChannelWeightOf,
  fusionWeightsOf,
  minMaxNormOf,
  normalizedFusionEnabled,
  normalizedRelevanceOf,
  recencyHalfLifeDaysOf,
  recencyNormOf,
  validityNormOf,
  type RecallFactChannelConfig,
  type RecallFusionConfig,
} from "../recall/fusion.js";

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
  /** F-CLUSTER v2：行折叠元数据透传（recordId=记忆 id；evidenceIds=持续态证据源列表） */
  recordId?: string;
  evidenceIds?: string[];
  /** D-3：敏感性（none 不标注；health/finance/relationship → 徽章）。 */
  sensitivity?: string;
  /** D-4：周期性事实（normalize 形状；徽章渲染，note 首选/中文映射）。 */
  recurrence?: { cadence: string; anchor: string | null; note: string } | null;
  /** V6-1a：唤醒度（≥0.7 → ·强烈 徽章；宁缺毋滥）。 */
  arousal?: number;
  /** V6-1a：召回验证次数（≥3 → ·验证×N 徽章）。 */
  recallCount?: number;
  /** V6-1a：身份引用（非空 → ·核心事实 徽章）。 */
  identityRefs?: string[];
  /** V6-1a：演化结论（存在 → ·已演化 徽章；当前管道无产出=徽章休眠）。 */
  evolution?: unknown;
  /** V6-1a：持续状态事实生效起点（→ ·自 date 起 徽章）。 */
  valid_start?: string;
  /** R-A2：候选池通道标注（"graph:kind" / "value:锚"；主检索命中恒缺省）。 */
  recall_channel?: string;
  /** #162（2026-10-29）：写入侧会话 id —— 装配层近重折叠的「同会话免疫」依据（不渲染进行文本）。
   */
  sessionId?: string;
  /**
   * #146：事实行的父记忆 id（metadata.fact_of）。读侧据此把同 turn 的 n 条事实折叠回一条
   * ——召回预算与注入单位是 turn，不是片段（槽位通胀实测见 fact-turn.ts 头注）。
   */
  factOf?: string;
  /** #146：本行承载的单条事实陈述（metadata.fact_phrase；行 content 存父 turn 原文）。 */
  factPhrase?: string;
  /**
   * #166：本行承载的事实值（metadata.fact_value；旧库行回退 factTriples[0].value）。
   * 只在 present-intent 值级遮蔽时用来校验「替换文本是否仍含被取代的旧值」。
   */
  factValue?: string;
  /**
   * #166：注入文本覆盖（present-intent 值级遮蔽后的安全文本）。
   * 父 turn 原文含已被取代的旧值时，读侧把注入降级为该行自己的事实短语；
   * 缺省 = 用 content（零行为变化）。
   */
  displayContent?: string;
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

  // 2. Content (core)。#166：present-intent 值级遮蔽时用 displayContent（事实短语），
  //    避免父 turn 原文把已被取代的旧值带回注入；缺省逐字节不变。
  let line = `- [${tag}] ${m.displayContent ?? m.content}`;

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
  // D-3：敏感性徽章（none/缺失 → 不标注；宁缺毋滥）
  const SENS_LABEL: Record<string, string> = { health: "健康", finance: "财务", relationship: "关系" };
  if (m.sensitivity && m.sensitivity !== "none" && SENS_LABEL[m.sensitivity]) {
    soul.push(`敏感:${SENS_LABEL[m.sensitivity]}`);
  }
  // D-4：周期徽章（normalize 形状重验；note 首选、缺省中文映射；宁缺毋滥）
  const recLabel = recurrenceLabel(m.recurrence);
  if (recLabel) soul.push(`周期:${recLabel}`);
  // V6-1a：属性信号徽章（全部宁缺毋滥、字段缺省输出逐字节不变；顺序固定在周期之后）
  if (m.arousal != null && m.arousal >= 0.7) soul.push("强烈");
  if (m.recallCount != null && m.recallCount >= 3) soul.push(`验证×${m.recallCount}`);
  if (Array.isArray(m.identityRefs) && m.identityRefs.length > 0) soul.push("核心事实");
  if (m.evolution != null) soul.push("已演化");
  if (m.valid_start) soul.push(`自 ${m.valid_start.slice(0, 10)} 起`);
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
export function recordToFormatable(record: MemoryRecord): FormatableMemory {
  const meta = record.metadata as { activity_start_time?: string; activity_end_time?: string } | undefined;
  // V6-1a：属性信号宽松读取（只认合法形状，宁缺毋滥；tsc 修复——meta 是窄类型别名）
  const sigMeta = (meta ?? {}) as Record<string, unknown>;
  const sigRecallCount =
    typeof sigMeta.recall_count === "number" && Number.isFinite(sigMeta.recall_count) && sigMeta.recall_count > 0
      ? sigMeta.recall_count
      : undefined;
  const sigIdentityRefs = Array.isArray(sigMeta.identityRefs)
    ? (sigMeta.identityRefs as unknown[]).filter((s): s is string => typeof s === "string")
    : undefined;
  const sigEvolution = sigMeta.evolution ?? undefined;
  return {
    type: record.type,
    content: record.content,
    scene_name: record.scene_name || undefined,
    activity_start_time: meta?.activity_start_time || undefined,
    activity_end_time: meta?.activity_end_time || undefined,
    timestamp: (record.timestamps && record.timestamps.length > 0) ? record.timestamps[0] : undefined,
    // A3（REG-REMAINING-001）补齐：native-hybrid 路径（merged pool 1520）soul 透传——
    // R-A1 时代信号单独携带，但 B4 行内标注需要 formatable 携带；额外字段不破坏信号路径。
    occurred_at: (record as { occurred_at?: string }).occurred_at || undefined,
    certainty: (record as { certainty?: string }).certainty || undefined,
    valence: (record as { valence?: number }).valence,
    significance: (record as { significance?: number }).significance,
    // F-R12（flowtest 发现）：sensitivity（D-3）+ recurrence（D-4）透传——native-hybrid
    // 是丢值点排查清单外的第三通道（D-3 排查清单漏项，flowtest 活体实锚 finance 行无徽章）。
    sensitivity: (record as { sensitivity?: string }).sensitivity || undefined,
    recurrence: isRecurrenceMeta((meta as { recurrence?: unknown } | undefined)?.recurrence)
      ? (meta as { recurrence: { cadence: string; anchor: string | null; note: string } }).recurrence
      : undefined,
    // V6-1a：属性信号透传（kwSoul 路基座——recall_count/identityRefs/evolution 读 metadata；
    // arousal/valid_start 读 record 顶层，kw 路由 kwSoul 条件并回补齐——F-R12 同教训）
    arousal: (record as { arousal?: number }).arousal,
    valid_start: (record as { valid_start?: string }).valid_start,
    recallCount: sigRecallCount,
    identityRefs: sigIdentityRefs,
    evolution: sigEvolution,
    // #146：事实行聚合信息（native-hybrid/FTS keyword 通道同形透传）
    factOf: (() => {
      const v = sigMeta.fact_of;
      return typeof v === "string" && v.trim() !== "" ? v : undefined;
    })(),
    factPhrase: (() => {
      const v = sigMeta.fact_phrase;
      return typeof v === "string" && v.trim() !== "" ? v : undefined;
    })(),
    factValue: factValueOfMeta(sigMeta),
    // F-CLUSTER 折叠接线（2026-09-29）：FTS keyword 通道补折叠元数据——与
    // vectorResultToFormatable(:2363) 对齐；缺此二字段 foldByDurative 引用图建不起来。
    recordId: record.id,
    evidenceIds: (() => {
      const evs = Array.isArray(sigMeta.evidence_record_ids)
        ? (sigMeta.evidence_record_ids as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      return evs.length > 0 ? evs : undefined;
    })(),
  };
}

/**
 * Build a FormatableMemory from a VectorSearchResult (embedding search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
export function vectorResultToFormatable(r: L1SearchResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  let activityRec: { cadence: string; anchor: string | null; note: string } | undefined;
  // V6-1a：属性信号暂存（metadata 解析后回填；非法/缺失保持 undefined）
  let recCount: number | undefined;
  let identRefs: string[] | undefined;
  let evo: unknown;
  let evIds: string[] | undefined;
  // #146：事实行聚合信息（读侧折叠回 turn 的依据）
  let factOf: string | undefined;
  let factPhrase: string | undefined;
  // #166：本行事实值（值级遮蔽的校验依据）
  let factValue: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
      // D-4：周期性事实透传（normalize 形状重验，防垃圾入库渲染）
      if (isRecurrenceMeta(meta?.recurrence)) activityRec = meta.recurrence;
      // V6-1a：属性信号透传（recall_count 数值合法才收；identityRefs 过滤非字符串、空则不透传）
      if (typeof meta?.recall_count === "number" && Number.isFinite(meta.recall_count) && meta.recall_count > 0) recCount = meta.recall_count;
      if (Array.isArray(meta?.identityRefs)) {
        const refs = (meta.identityRefs as unknown[]).filter((s): s is string => typeof s === "string");
        if (refs.length > 0) identRefs = refs;
      }
      if (meta?.evolution != null) evo = meta.evolution;
      // F-CLUSTER v2：证据源透传（evidence_record_ids=consolidation 持续态源列表，生产 99.2% 覆盖实测）
      if (Array.isArray(meta?.evidence_record_ids)) {
        const evs = (meta.evidence_record_ids as unknown[]).filter((s): s is string => typeof s === "string");
        if (evs.length > 0) evIds = evs;
      }
      // #146：事实行聚合（fact_of）与单条事实陈述（fact_phrase）；非法/空保持 undefined
      if (typeof meta?.fact_of === "string" && meta.fact_of.trim() !== "") factOf = meta.fact_of;
      if (typeof meta?.fact_phrase === "string" && meta.fact_phrase.trim() !== "") factPhrase = meta.fact_phrase;
      factValue = factValueOfMeta(meta);
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
    // F-CLUSTER v2：折叠元数据透传
    recordId: r.record_id,
    evidenceIds: evIds,
    // #162：来源会话透传（装配层同会话免疫；不渲染进行文本）
    sessionId: r.session_id || undefined,
    occurred_at: r.occurred_at || undefined,
    certainty: r.certainty || undefined,
    valence: r.valence,
    significance: r.significance,
    // D-3：敏感性透传（向量路徽章渲染——与 FTS 路 kwSoul spread 对齐）
    sensitivity: (r as { sensitivity?: string }).sensitivity || undefined,
    // D-4：周期性事实透传（向量路徽章）
    recurrence: activityRec || undefined,
    // V6-1a：属性信号徽章源透传（向量路——顶层列 + metadata 解析）
    arousal: r.arousal,
    valid_start: r.valid_start,
    recallCount: recCount,
    identityRefs: identRefs,
    evolution: evo,
    // #146：事实行聚合信息（缺省 undefined = 普通整行记忆，逐位现状）
    factOf,
    factPhrase,
    factValue,
  };
}

/**
 * Build a FormatableMemory from an FtsSearchResult (FTS5 keyword search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
export function ftsResultToFormatable(r: L1FtsResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  let activityRec: { cadence: string; anchor: string | null; note: string } | undefined;
  // V6-1a：属性信号暂存（与向量路成对——丢一个=徽章单通道）
  let recCount: number | undefined;
  let identRefs: string[] | undefined;
  let evo: unknown;
  // #146：事实行聚合信息（FTS 通道同样要让读侧折叠回 turn）
  let factOf: string | undefined;
  let factPhrase: string | undefined;
  // #166：本行事实值（FTS 路与向量路成对——丢一个=遮蔽单通道）
  let factValue: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
      // D-4：周期性事实透传（FTS 路——与向量路成对，丢一个=徽章单通道）
      if (isRecurrenceMeta(meta?.recurrence)) activityRec = meta.recurrence;
      // V6-1a：属性信号透传（与向量路成对）
      if (typeof meta?.recall_count === "number" && Number.isFinite(meta.recall_count) && meta.recall_count > 0) recCount = meta.recall_count;
      if (Array.isArray(meta?.identityRefs)) {
        const refs = (meta.identityRefs as unknown[]).filter((s): s is string => typeof s === "string");
        if (refs.length > 0) identRefs = refs;
      }
      if (meta?.evolution != null) evo = meta.evolution;
      if (typeof meta?.fact_of === "string" && meta.fact_of.trim() !== "") factOf = meta.fact_of;
      if (typeof meta?.fact_phrase === "string" && meta.fact_phrase.trim() !== "") factPhrase = meta.fact_phrase;
      factValue = factValueOfMeta(meta);
    } catch { /* ignore parse errors — treat as no metadata */ }
  }
  return {
    type: r.type,
    content: r.content,
    scene_name: r.scene_name || undefined,
    activity_start_time: activityStart,
    activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
    // #162：来源会话透传（与向量路成对——FTS SELECT 未带出时降级为无来源）
    sessionId: (r as { session_id?: string }).session_id || undefined,
    // A3（REG-REMAINING-001）修复：灵魂字段透传——与 vectorResultToFormatable 对齐。
    // 此前 FTS 通道结果丢失 soul 字段 → soul 标注只在向量通道出现（实测 1/5 行）。
    occurred_at: r.occurred_at || undefined,
    certainty: r.certainty || undefined,
    valence: r.valence,
    significance: r.significance,
    // D-3：敏感性透传（FTS 路 formatable——SELECT 已带出、此前映射丢弃）
    sensitivity: (r as { sensitivity?: string }).sensitivity || undefined,
    // D-4：周期性事实透传（FTS 路徽章）
    recurrence: activityRec || undefined,
    // V6-1a：属性信号徽章源透传（FTS 路——顶层列 + metadata 解析）
    arousal: r.arousal,
    valid_start: r.valid_start,
    recallCount: recCount,
    identityRefs: identRefs,
    evolution: evo,
    // #146：事实行聚合信息（缺省 undefined = 普通整行记忆，逐位现状）
    factOf,
    factPhrase,
    factValue,
  };
}
