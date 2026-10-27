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

/** 加权融合四通道权重。 */
export interface FusionWeights {
  /** dense（向量/语义通道）RRF 权重。 */
  dense: number;
  /** bm25（FTS5 关键词通道）RRF 权重。 */
  bm25: number;
  /** recency 归一特征权重（0.5^(ageDays/halfLife)，floor 0.05）。 */
  recency: number;
  /** validity 归一特征权重（双时态状态：生效中 1 / 已失效或未生效 0）。 */
  validity: number;
}

/** RRF 恒等权重：加权和与现状逐位一致（关断矩阵）。 */
export const RRF_IDENTITY_WEIGHTS: FusionWeights = { dense: 1, bm25: 1, recency: 0, validity: 0 };

/** weighted 模式缺省权重（E1 离线拟合落地前的占位；拟合产物经 config 显式覆盖）。 */
export const WEIGHTED_DEFAULT_WEIGHTS: FusionWeights = { dense: 0.4, bm25: 0.3, recency: 0.2, validity: 0.1 };

/** cfg.recall.fusion 形状（config 解析产物；缺省 mode="rrf"）。 */
export interface RecallFusionConfig {
  mode: "rrf" | "weighted";
  dense?: number;
  bm25?: number;
  recency?: number;
  validity?: number;
  /** recency 特征半衰期天数（缺省 30，MemOS 对标）。 */
  recencyHalfLifeDays?: number;
}

const isW = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/** 解析融合权重：rrf/缺省 = 恒等；weighted = 缺省占位逐项覆盖（非法/负值回落占位）。 */
export function fusionWeightsOf(cfg?: RecallFusionConfig): FusionWeights {
  if (!cfg || cfg.mode !== "weighted") return { ...RRF_IDENTITY_WEIGHTS };
  return {
    dense: isW(cfg.dense) ? cfg.dense : WEIGHTED_DEFAULT_WEIGHTS.dense,
    bm25: isW(cfg.bm25) ? cfg.bm25 : WEIGHTED_DEFAULT_WEIGHTS.bm25,
    recency: isW(cfg.recency) ? cfg.recency : WEIGHTED_DEFAULT_WEIGHTS.recency,
    validity: isW(cfg.validity) ? cfg.validity : WEIGHTED_DEFAULT_WEIGHTS.validity,
  };
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
