/**
 * P7（2026-11-02 记忆分层与提取优化）：记忆内禀指标与召回质量的**纯函数**计算层。
 *
 * 设计口径（为什么是这些数、每个数怎么算都写在这里，避免"指标口径漂移"）：
 *  - 输入只有"行快照"，零 I/O、零 store 依赖 → 可单测、可离线复放、可对任意历史快照重算；
 *  - 生产读数由 scripts/memory-metrics.ts 只读打开 vectors.db 后调用本模块产出（绝不写库）；
 *  - 每个比率都同时给 count 与 rate，分母为 0 时 rate=0（不产 NaN），保证"空库/空批"可读数。
 *
 * 指标的**诚实边界**（写进 docs/ops/memory-metrics.md，不要当成 ground truth）：
 *  - selfNarration 是启发式代理（metadata.actor 精确 + 第一人称主语动词模式），会漏掉无主语的自述；
 *    actorLabeled 单独统计"写侧只打了 metadata.actor='agent' 标签"的行，两者**不合并**（差值=未打标签的自述）；
 *  - semanticDupRate 缺 embedding 时退化为字符 bigram Jaccard 代理（method 字段标明），
 *    它抓的是"近重写"而不是语义等价；
 *  - poolAnchorRate（旧名 recallPrecisionProxy）只统计"候选池行是否带可验证锚"（数字/版本/file:line/哈希），
 *    不判对错，也不是注入行精度——真正的判对率仍以 bench/golden 为准。
 */

import { isAgentNarration } from "../record/agent-narration.js";

const CLAIM_SPLIT = /[。！？!?；;\n]+/;

/**
 * F6③（task-7）：可验证锚。去掉旧的裸 `\d+` —— 它让"数值 42"这种不可核对的裸数字
 * 也算有锚，precisionProxy 因此虚高（生产读数 92.6%）。保留四类真锚：
 * 日期 / 时刻 / file:line / 短哈希（必须含字母，防纯数字串冒充）。
 */
const ANCHOR_PATTERN =
  /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}(?::\d{2})?|[A-Za-z0-9_\-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yaml|yml|py|java):\d+|\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;

export interface L1MetricRow {
  recordId: string;
  type: string;
  content: string;
  createdAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * 单行是否为 agent 自述：metadata.actor 精确优先，其次委托 record/agent-narration 的
 * 同一判定（F5：旧第二套正则已删，两处口径必须逐行一致）。
 */
export function isAgentSelfNarration(content: string, metadata?: Record<string, unknown> | null): boolean {
  if (metadata && metadata.actor === "agent") return true;
  if (!content) return false;
  return isAgentNarration(content);
}

/** 一条记忆里包含的可验证断言数（按句末标点切分，空段不计）。 */
export function countClaims(content: string): number {
  if (!content) return 0;
  return content
    .split(CLAIM_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/** 字符 bigram 集合（不含标点与空白；长度 <2 的片段退化为单字集合）。 */
export function bigramSet(text: string): Set<string> {
  const clean = (text ?? "").replace(/[\s\p{P}\p{S}]+/gu, "");
  const out = new Set<string>();
  if (clean.length === 0) return out;
  if (clean.length === 1) {
    out.add(clean);
    return out;
  }
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export interface MetricsOptions {
  /** A3 拆分红线（用于"长度达标"判定；缺省 300；CLI 应经 metrics-config 解析配置）。 */
  atomicMaxChars?: number;
  /** 近重阈值（缺省 0.85）。 */
  dupThreshold?: number;
  /** 精确向量（**采样内每一行都有**才走 cosine，否则整批 jaccard 代理，防混合口径）。 */
  embeddings?: Map<string, readonly number[]>;
  /** 同期归档行数（churn 分子；缺省 0）。 */
  archivedInWindow?: number;
  /**
   * 同窗口内**创建**的存活行数（churn 分母；CLI 走 SQL `COUNT(l1_records WHERE created_time >= windowFrom)`）。
   * 缺省 undefined = 未取得同期分母 → `churn.live/ratio` 均为 null，**绝不用采样行数冒充分母**。
   */
  liveInWindow?: number;
  /** 重复对采样上限（防 O(n^2) 爆；缺省 120 行；随机采样，不再取前 N 行）。 */
  dupSampleLimit?: number;
  /** 采样种子（缺省 20261102；同种子可复现同一批行）。 */
  sampleSeed?: number;
}

export interface MetricCountRate {
  count: number;
  rate: number;
}

/** F6① 同期翻台读数：分子分母必须落在同一窗口，否则 ratio 为 null（不给口径不同的数）。 */
export interface ChurnReport {
  /** 窗口内归档行数（`l1_archive.archived_at >= windowFrom`）。 */
  archived: number;
  /** 窗口内创建的存活行数（`l1_records.created_time >= windowFrom`）；null = 未取得同期分母。 */
  live: number | null;
  /** archived/(archived+live)；null = 分母缺失（不做采样行数回落）。 */
  ratio: number | null;
}

export interface L1MetricsReport {
  total: number;
  avgLen: number;
  selfNarration: MetricCountRate;
  /**
   * 写侧标签口径：metadata.actor === "agent" 的行 / 采样行数。
   * 与 selfNarration（启发式：标签 + 主语/动作词）并列**不合并**：差值 = 未打标签的自述行。
   */
  actorLabeled: MetricCountRate;
  atomicity: { both: number; lenOnly: number; singleClaimOnly: number; rate: number };
  factsCoverage: MetricCountRate;
  semanticDup: {
    method: "cosine" | "jaccard-proxy";
    threshold: number;
    pairs: number;
    /** 统一分母：采样内真正比较过的对数（= C(sampled,2)，不再因缺向量少计）。 */
    compared: number;
    rate: number;
    sampled: number;
    /** 被抽中的 recordId（自证"随机采样"而非前 N 行截断）。 */
    sampleIds: string[];
  };
  /** F6① 同期翻台：archived/(archived+live)，分母与分子同窗口。 */
  churn: ChurnReport;
  typeDistribution: Record<string, number>;
}

function rate(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

/** `--limit` 来源：cli = 显式传参，default = 脚本缺省。 */
export type SamplingLimitSource = "cli" | "default";

export interface SamplingInfo {
  /** 本次实际参与计算的采样行数。 */
  sampledRows: number;
  /** 全库（或 --since 窗口内）总行数。 */
  totalRows: number;
  /** 生效的 --limit。 */
  limit: number;
  /** limit 来源；报告必须显式打印，避免读者把缺省 2000 当全库。 */
  limitSource: SamplingLimitSource;
  /** 采样行 / 总行（总行为 0 时 0）。 */
  coverage: number;
}

/**
 * F6⑥ 采样可解释性：sampledRows / totalRows / limit / limitSource 四件套一起给，
 * 让"2000 是缺省采样"这件事在输出里自证，而不是靠读者猜。
 */
export function describeSampling(input: {
  sampledRows: number;
  totalRows: number;
  limit: number;
  limitSource: SamplingLimitSource;
}): SamplingInfo {
  return {
    sampledRows: input.sampledRows,
    totalRows: input.totalRows,
    limit: input.limit,
    limitSource: input.limitSource,
    coverage: rate(input.sampledRows, input.totalRows),
  };
}

function hasFacts(metadata?: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  const facts = (metadata as { facts?: unknown }).facts;
  if (Array.isArray(facts) && facts.length > 0) return true;
  const triples = (metadata as { factTriples?: unknown }).factTriples;
  if (Array.isArray(triples) && triples.length > 0) return true;
  return false;
}

export function computeL1Metrics(rows: readonly L1MetricRow[], opts: MetricsOptions = {}): L1MetricsReport {
  const total = rows.length;
  const atomicMaxChars = opts.atomicMaxChars ?? 300;
  const dupThreshold = opts.dupThreshold ?? 0.85;
  const sampleLimit = Math.max(2, opts.dupSampleLimit ?? 120);

  let lenSum = 0;
  let selfCount = 0;
  let actorLabeledCount = 0;
  let both = 0;
  let lenOnly = 0;
  let singleOnly = 0;
  let factsCount = 0;
  const typeDistribution: Record<string, number> = {};

  for (const r of rows) {
    const content = r.content ?? "";
    lenSum += content.length;
    if (isAgentSelfNarration(content, r.metadata)) selfCount += 1;
    if (r.metadata?.actor === "agent") actorLabeledCount += 1;
    const lenOk = content.length <= atomicMaxChars;
    const claimOk = countClaims(content) <= 1;
    if (lenOk) lenOnly += 1;
    if (claimOk) singleOnly += 1;
    if (lenOk && claimOk) both += 1;
    if (hasFacts(r.metadata)) factsCount += 1;
    const t = r.type || "unknown";
    typeDistribution[t] = (typeDistribution[t] ?? 0) + 1;
  }

  // F6④：随机采样（不再 rows.slice(0, N) 的前 N 行偏置）。同 seed 可复现。
  const sample = pickSample(rows, sampleLimit, opts.sampleSeed ?? 20261102);
  // 混合口径比"少算分母"更没有意义：只有采样内每行都有向量时才走 cosine。
  const useCosine =
    opts.embeddings !== undefined &&
    sample.length > 0 &&
    sample.every((r) => (opts.embeddings?.get(r.recordId)?.length ?? 0) > 0);
  let pairs = 0;
  let compared = 0;
  for (let i = 0; i < sample.length; i += 1) {
    for (let j = i + 1; j < sample.length; j += 1) {
      compared += 1;
      const sim = useCosine
        ? cosine(opts.embeddings?.get(sample[i].recordId) ?? [], opts.embeddings?.get(sample[j].recordId) ?? [])
        : jaccard(bigramSet(sample[i].content ?? ""), bigramSet(sample[j].content ?? ""));
      if (sim >= dupThreshold) pairs += 1;
    }
  }

  const archived = opts.archivedInWindow ?? 0;
  // A：分母必须是"同窗口创建的存活行数"。缺失时 ratio=null，绝不回落到采样 total。
  const liveInWindow =
    typeof opts.liveInWindow === "number" && Number.isFinite(opts.liveInWindow) ? opts.liveInWindow : null;
  return {
    total,
    avgLen: total > 0 ? lenSum / total : 0,
    selfNarration: { count: selfCount, rate: rate(selfCount, total) },
    actorLabeled: { count: actorLabeledCount, rate: rate(actorLabeledCount, total) },
    atomicity: { both, lenOnly, singleClaimOnly: singleOnly, rate: rate(both, total) },
    factsCoverage: { count: factsCount, rate: rate(factsCount, total) },
    semanticDup: {
      method: useCosine ? "cosine" : "jaccard-proxy",
      threshold: dupThreshold,
      pairs,
      compared,
      rate: rate(pairs, compared),
      sampled: sample.length,
      sampleIds: sample.map((r) => r.recordId),
    },
    churn: {
      archived,
      live: liveInWindow,
      ratio: liveInWindow === null ? null : rate(archived, archived + liveInWindow),
    },
    typeDistribution,
  };
}

/**
 * F6④ 采样：mulberry32 + Fisher-Yates 取前 n 个下标。
 * 不用 Math.random —— 指标必须可复现（同 seed 同采样，便于跨日对比与归因）。
 */
function pickSample<T>(rows: readonly T[], n: number, seed: number): T[] {
  const size = Math.min(rows.length, Math.max(0, n));
  const idx = rows.map((_, i) => i);
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx.slice(0, size).map((i) => rows[i]);
}

export interface RecallJournalEntry {
  selection?: {
    kept?: number;
    injected?: number;
    injectedChars?: number;
    poolChars?: number;
    droppedBy?: Record<string, number>;
    /** 空池轮标记（三路全无命中，选线段没跑）；见 recall-journal.ts 同名说明。 */
    emptyPool?: boolean;
  };
  memoryLines?: string[];
}

export interface RecallMetricsReport {
  /** F6②：**只**统计 selection != null 的轮（无 selection 的轮没有注入口径，进分母就是失真）。 */
  rounds: number;
  /**
   * 其中候选池为空的轮（selection.emptyPool）。2026-11-03 起空池轮也写 selection，
   * 所以 rounds 第一次覆盖到「整轮没召回到任何东西」的场景。
   */
  emptyPoolRounds: number;
  zeroInjectionRounds: number;
  /** 零注入率的分子（分母 = 非空池轮）；与 zeroInjectionRounds 的差值 = 空池导致的零注入。 */
  zeroInjectionRoundsNonEmpty: number;
  /** 零注入率（分母 = rounds，含空池轮）：回答"用户这一轮到底拿到记忆没有"。 */
  zeroInjectionRate: number;
  /** 零注入率（分母 = 非空池轮）：回答"召回到了东西时，选线是否把它全砍掉"。两者不可混读。 */
  zeroInjectionRateNonEmpty: number;
  injectedCharsP50: number;
  injectedCharsMean: number;
  /** 每轮注入行数，取 selection.injected（绝不用候选池 memoryLines.length 冒充）。 */
  avgInjectedLines: number;
  /** 候选池含锚率（precisionProxy 的正名；同值保留旧字段，下游 0 值不断裂）。 */
  poolAnchorRate: number;
  /**
   * @deprecated 用 `poolAnchorRate`：旧名易被读成"注入行精度"，实际取样面是候选池
   * （`precisionScope="candidate-pool"`）。同值保留，仅为向后兼容，勿在新代码引用。
   */
  precisionProxy: number;
  /** F6② 覆盖度单列：多少轮有 selection、多少轮没有。 */
  coverage: { withSelection: number; withoutSelection: number; rate: number };
  anchorLines: number;
  /** 候选池行数（poolAnchorRate 的分母；与 totalInjectedLines 同值但语义是"候选池"）。 */
  totalInjectedLines: number;
  /** poolAnchorRate 的取样面：candidate-pool（候选池），不是注入行。 */
  precisionScope: "candidate-pool";
}

function percentileNearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * 召回侧读数：全部来自 journal（单一事实源）。
 *
 * F6②（task-7）修正三处失真：
 *  - rounds / 分位数 / 均值 / 零注入率只统计 selection != null 的轮，另用 coverage 单列覆盖度；
 *  - avgInjectedLines 取 selection.injected（旧实现拿候选池 memoryLines.length 除以轮数，虚高）；
 *  - poolAnchorRate 的取样面明确标 candidate-pool（候选池有锚 ≠ 注入行有锚），换算法见 docs §3；
 *    precisionProxy 同值保留并标 @deprecated（向后兼容，正名见 poolAnchorRate）。
 */
export function computeRecallMetrics(entries: readonly RecallJournalEntry[]): RecallMetricsReport {
  const withSelection = entries.filter((e) => e.selection != null);
  const rounds = withSelection.length;
  const chars: number[] = [];
  let zero = 0;
  let emptyPool = 0;
  let zeroNonEmpty = 0;
  let injectedLines = 0;
  let poolLines = 0;
  let anchorLines = 0;
  for (const e of entries) {
    const lines = e.memoryLines ?? [];
    poolLines += lines.length;
    for (const line of lines) if (ANCHOR_PATTERN.test(line)) anchorLines += 1;
  }
  for (const e of withSelection) {
    const injected = e.selection?.injectedChars ?? 0;
    chars.push(injected);
    const injectedCount = e.selection?.injected ?? 0;
    injectedLines += injectedCount;
    const isEmptyPool = e.selection?.emptyPool === true;
    if (isEmptyPool) emptyPool += 1;
    if (injectedCount === 0) {
      zero += 1;
      if (!isEmptyPool) zeroNonEmpty += 1;
    }
  }
  const sorted = [...chars].sort((a, b) => a - b);
  const sum = chars.reduce((a, b) => a + b, 0);
  const anchorRate = rate(anchorLines, poolLines);
  return {
    rounds,
    emptyPoolRounds: emptyPool,
    zeroInjectionRounds: zero,
    zeroInjectionRoundsNonEmpty: zeroNonEmpty,
    zeroInjectionRate: rate(zero, rounds),
    zeroInjectionRateNonEmpty: rate(zeroNonEmpty, rounds - emptyPool),
    injectedCharsP50: percentileNearestRank(sorted, 0.5),
    injectedCharsMean: rounds > 0 ? sum / rounds : 0,
    avgInjectedLines: rounds > 0 ? injectedLines / rounds : 0,
    poolAnchorRate: anchorRate,
    precisionProxy: anchorRate,
    coverage: {
      withSelection: rounds,
      withoutSelection: entries.length - rounds,
      rate: rate(rounds, entries.length),
    },
    anchorLines,
    totalInjectedLines: poolLines,
    precisionScope: "candidate-pool",
  };
}
