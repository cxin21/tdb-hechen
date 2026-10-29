/**
 * #135 R2（检索融合 spec 第三波）：RRF → 加权融合的纯函数特征层。
 *
 * 关键依据（#135 票面）：V1 已证 ageDecay 的 timeProx 乘子在 hybrid RRF 路
 * （rank-based）零差异（0/90）——recency 必须作为显式融合特征才生效。
 * 特征统一为 0..1 归一分，融合分 = w.bm25*rrfKw + w.dense*rrfDense +
 *   w.recency*recencyNorm + w.validity*validityNorm。
 * 关断恒等口径：mode="rrf"（缺省）= 权重 {dense:1, bm25:1, recency:0, validity:0}
 * ——与纯 RRF 求和逐位一致（每通道 rrf 值相同，加权和=RRF 和）。
 */

/** 加权融合通道权重（#137 起含事实通道）。 */
export interface FusionWeights {
  /** dense（原文向量/语义通道）权重。 */
  dense: number;
  /** bm25（FTS5 关键词通道）RRF 权重。 */
  bm25: number;
  /** #137：fact（事实键平行通道）权重。 */
  fact: number;
  /** recency 归一特征权重（0.5^(ageDays/halfLife)，floor 0.05）。 */
  recency: number;
  /** validity 归一特征权重（双时态状态：生效中 1 / 已失效或未生效 0）。 */
  validity: number;
}

/**
 * RRF 恒等权重：加权和与现状逐位一致（关断矩阵）。
 * `fact` 在此为 0：rrf/weighted 的加法路**不读这张表**——事实通道权重唯一 SoT 是
 * `factChannelWeightOf`（fusion.fact > recall.factChannel.weight > 0.6），避免两个权重来源。
 */
export const RRF_IDENTITY_WEIGHTS: FusionWeights = { dense: 1, bm25: 1, fact: 0, recency: 0, validity: 0 };

/** weighted 模式缺省权重（E1 离线拟合落地前的占位；拟合产物经 config 显式覆盖）。 */
export const WEIGHTED_DEFAULT_WEIGHTS: FusionWeights = { dense: 0.4, bm25: 0.3, fact: 0, recency: 0.2, validity: 0.1 };

/**
 * #137 normalized 模式缺省权重：融合发生在**通道内归一化分**（0..1 同量纲）上，
 * 不是 RRF 值上。dense 是原文主序、fact 是补召回（权重低于 dense，避免同主题稀释），
 * bm25 只在字面命中时给一点支撑；recency/validity 缺省不参与（需要时显式配）。
 * `fact` 只在调用方**没有** factChannel 配置时兜底——真实运行时 searchHybrid 用
 * `factChannelWeightOf` 覆盖它（保持与 rrf 档同一权重来源）。
 */
export const NORMALIZED_DEFAULT_WEIGHTS: FusionWeights = { dense: 0.5, bm25: 0.2, fact: 0.3, recency: 0, validity: 0 };

/** cfg.recall.fusion 形状（config 解析产物；缺省 mode="rrf"）。 */
export interface RecallFusionConfig {
  mode: "rrf" | "weighted" | "normalized";
  dense?: number;
  bm25?: number;
  /**
   * #137：事实通道权重。优先级：本键 > `recall.factChannel.weight` > 缺省（rrf 1 / weighted 0.2 /
   * normalized 0.3）。rrf/weighted 档它经 `factChannelWeightOf` 乘进 RRF 贡献；normalized 档
   * 直接作为归一化分权重（`normalizedRelevanceOf`）。
   */
  fact?: number;
  recency?: number;
  validity?: number;
  /** recency 特征半衰期天数（缺省 30，MemOS 对标）。 */
  recencyHalfLifeDays?: number;
}

/** #137：cfg.recall.factChannel 形状（事实键平行召回通道）。 */
export interface RecallFactChannelConfig {
  enabled: boolean;
  /** 融合权重（缺省 0.6）。 */
  weight: number;
  /** 通道上游候选上限（缺省 = candidateK）。 */
  candidateK?: number;
  /** 余弦下限（缺省回落 recall.scoreThreshold）。 */
  minScore?: number;
  /** 只对这些 type 的记录生效（缺省空 = 全类型）。 */
  onlyForTypes?: string[];
}

/** 事实通道权重：fusion.fact 优先，否则 factChannel.weight，缺省 0.6。 */
export function factChannelWeightOf(channel: RecallFactChannelConfig | undefined, fusion?: RecallFusionConfig): number {
  if (isW(fusion?.fact)) return fusion!.fact!;
  if (typeof channel?.weight === "number" && Number.isFinite(channel.weight) && channel.weight >= 0) {
    return channel.weight;
  }
  return 0.6;
}

const isW = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/** 解析融合权重：rrf/缺省 = 恒等；weighted/normalized = 各自缺省占位逐项覆盖（非法/负值回落占位）。 */
export function fusionWeightsOf(cfg?: RecallFusionConfig): FusionWeights {
  if (!cfg || cfg.mode === "rrf") return { ...RRF_IDENTITY_WEIGHTS };
  const d = cfg.mode === "normalized" ? NORMALIZED_DEFAULT_WEIGHTS : WEIGHTED_DEFAULT_WEIGHTS;
  return {
    dense: isW(cfg.dense) ? cfg.dense : d.dense,
    bm25: isW(cfg.bm25) ? cfg.bm25 : d.bm25,
    fact: isW(cfg.fact) ? cfg.fact : d.fact,
    recency: isW(cfg.recency) ? cfg.recency : d.recency,
    validity: isW(cfg.validity) ? cfg.validity : d.validity,
  };
}

/** #137：通道内归一化融合是否生效（缺省 false = 逐位 RRF 行为）。 */
export function normalizedFusionEnabled(cfg?: RecallFusionConfig): boolean {
  return cfg?.mode === "normalized";
}

/**
 * #137：余弦类分数的归一化——L1SearchResult.score 在 sqlite/本地向量路就是 1-distance ∈ [0,1]。
 * 缺失/非法 → 0（无实证不加成）；越界 clamp（不同后端刻度可能吃进 [−ε, 1+ε]）。
 */
export function cosineNormOf(score: number | undefined): number {
  if (typeof score !== "number" || !Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}

/**
 * #137：通道内 min-max 归一（BM25 分无绝对刻度，只能在本通道候选里比）。
 * 全部相等（含单条）→ 命中即 1（存在证据=满分位，不虚构相对高低）；
 * 空数组 → 空。NaN/Infinity 当缺失（按最小值处理）。
 */
export function minMaxNormOf(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  const finite = scores.map((s) => (typeof s === "number" && Number.isFinite(s) ? s : 0));
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (!(max > min)) return finite.map(() => 1);
  return finite.map((s) => (s - min) / (max - min));
}

/**
 * #137：归一化融合分 = Σ w_i × norm_i（各 norm 已在通道内归一，同量纲 0..1）。
 * 没命中该通道的候选贡献 0（不是缺失——0 就是"这一路没证据"）。
 */
export function normalizedRelevanceOf(
  parts: { dense?: number; bm25?: number; fact?: number; recency?: number; validity?: number },
  w: FusionWeights,
): number {
  return (
    w.dense * cosineNormOf(parts.dense) +
    w.bm25 * cosineNormOf(parts.bm25) +
    w.fact * cosineNormOf(parts.fact) +
    w.recency * cosineNormOf(parts.recency) +
    w.validity * cosineNormOf(parts.validity)
  );
}

/** recency 特征半衰期（缺省 30；非有限/非正回落 30——与 ageDecay 同口径）。 */
export function recencyHalfLifeDaysOf(cfg?: RecallFusionConfig): number {
  const hl = cfg?.recencyHalfLifeDays;
  return typeof hl === "number" && Number.isFinite(hl) && hl > 0 ? hl : 30;
}

const RECENCY_FLOOR = 0.05;

/**
 * recency 归一特征（0..1，floor 0.05 never-a-filter——ageDecay 同款）：
 * 0.5^(ageDays/halfLifeDays)。缺失/非法 occurred_at → 0（无实证不加成，R1 口径）；
 * 未来时间 clamp 1。
 */
export function recencyNormOf(
  occurredAt: string | undefined,
  now: Date,
  halfLifeDays: number,
  floor: number = RECENCY_FLOOR,
): number {
  if (!occurredAt) return 0;
  const t = Date.parse(occurredAt);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (now.getTime() - t) / 86400000);
  return Math.max(floor, Math.pow(0.5, ageDays / halfLifeDays));
}

/**
 * validity 归一特征（0..1）：生效中（或双时态字段缺失）→ 1；已失效
 * （valid_end <= now）或未生效（valid_start > now）→ 0。与 GROW-EVO P2
 * excludeInvalidated 的判定口径一致（时间旅行时点由调用方 now 决定）。
 */
export function validityNormOf(
  validStart: string | undefined,
  validEnd: string | undefined,
  now: Date,
): number {
  if (validEnd) {
    const end = Date.parse(validEnd);
    if (Number.isFinite(end) && end <= now.getTime()) return 0;
  }
  if (validStart) {
    const start = Date.parse(validStart);
    if (Number.isFinite(start) && start > now.getTime()) return 0;
  }
  return 1;
}
