/**
 * #144（2026-10-29）：rerank `mode="filter"` 的判定尺子——单一源。
 *
 * 背景（离线校准 + 实跑，见 docs/optimization-results.md §19）：provider 原始分**题间不可比**。
 * LME90 的 997 个候选里 gold 与噪声的绝对分布重叠极宽（AUC 0.836，gold 中位 +0.12 / 噪声 −6.30），
 * 而题内 top1−bottom 分差 p10/p50/p90 = 3.5 / 11.1 / 15.8 logit——同一个绝对门槛对"宽题"什么都
 * 滤不掉、对"窄题"直接腰斩（minScore −7 误滤 15.8% 池内 gold，−4 达 18.8%）。所以 filter 模式
 * 不能只有绝对 floor，必须能按**题内相对尺度**裁决：
 *  - "floor"    = score ≥ minScore（旧行为，绝对刻度；provider 换版即失效，保留为缺省兼容档）；
 *  - "margin"   = score ≥ 题内 top1 − marginTop（跟随题内整体平移，但仍以 provider 的量纲单位计量）；
 *  - "quantile" = 保留题内分数最高的 ceil(已评分候选数 × keepRatio) 条（对刻度完全免疫）。
 *
 * 本模块只做两件纯事：配置归一到 {@link RerankFilterRuler}，以及算出"保留哪些下标"的集合
 * （{@link relativeKeepIdxSet}）。**不排序**——保原序是 filter 语义，见 auto-recall 的 keepByFilter。
 *
 * 校准脚本 scripts/analyze-r144-rerank-floor.mjs 与本模块同源（直接 import 这里的实现），
 * 避免"离线校准口径"与"生产判定口径"漂移（ADR-0012：口径集中，不各写一套）。
 */

/** filter 模式的判定尺子。 */
export type RerankFilterRule = "floor" | "margin" | "quantile";

/** 尺子 + 参数（三键恒同行，故打包成一个值对象在各层传递）。 */
export interface RerankFilterRuler {
  rule: RerankFilterRule;
  /** margin 尺子：保留「题内 top1 分 − marginTop」以上的候选（provider 分单位；缺省 8）。 */
  marginTop: number;
  /** quantile 尺子：保留题内分数最高的 ceil(已评分候选数 × keepRatio) 条（缺省 0.5）。 */
  keepRatio: number;
}

/** 相对尺子只讨论 margin/quantile；floor 走绝对 minScore（调用方另行判定）。 */
export type RerankRelativeRuler = RerankFilterRuler & { rule: "margin" | "quantile" };

/** 缺省尺子 = floor + marginTop 8 + keepRatio 0.5（= 逐位旧行为，见 ADR-0008 §4）。 */
export const DEFAULT_RERANK_FILTER_RULER: RerankFilterRuler = Object.freeze({
  rule: "floor",
  marginTop: 8,
  keepRatio: 0.5,
});

/** 非法值静默回落 "floor"（config-first 沿 mode 先例）。 */
export function normalizeRerankFilterRule(v: unknown): RerankFilterRule {
  return v === "margin" || v === "quantile" || v === "floor" ? v : "floor";
}

/** 非有限或 ≤0 回落 8（0 = 与 floor 同族但无意义，adapter 也不会给出这种默认）。 */
export function normalizeRerankFilterMarginTop(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_RERANK_FILTER_RULER.marginTop;
}

/**
 * 非有限或 ≤0 回落 0.5；>1 clamp 到 1。
 * 为什么 >1 是 clamp 而不是回落：与邻居 blend 的口径一致（ADR-0008 §F2「越界 clamp、非法回落」），
 * 而 "保留 100%" 是一个有意义的上界（等价不裁），不该被静默改写成 50% 裁量。
 */
export function normalizeRerankFilterKeepRatio(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return DEFAULT_RERANK_FILTER_RULER.keepRatio;
  return Math.min(1, v);
}

/** 把原始配置三键（可能来自 yaml / 直接构造的 config / 测试）归一成尺子值对象。 */
export function normalizeRerankFilterRuler(raw?: {
  filterRule?: unknown;
  filterMarginTop?: unknown;
  filterKeepRatio?: unknown;
}): RerankFilterRuler {
  return {
    rule: normalizeRerankFilterRule(raw?.filterRule),
    marginTop: normalizeRerankFilterMarginTop(raw?.filterMarginTop),
    keepRatio: normalizeRerankFilterKeepRatio(raw?.filterKeepRatio),
  };
}

/**
 * 进 journal gate / score dump 的观测投影：只带**当前生效**那个尺子的参数，
 * 免得"margin 生效但 gate 里还挂着 keepRatio"这种半真观测（归因全靠这几个键）。
 */
export function filterRulerGateObs(ruler: RerankFilterRuler): {
  filterRule: RerankFilterRule;
  filterMarginTop?: number;
  filterKeepRatio?: number;
} {
  return {
    filterRule: ruler.rule,
    ...(ruler.rule === "margin" ? { filterMarginTop: ruler.marginTop } : {}),
    ...(ruler.rule === "quantile" ? { filterKeepRatio: ruler.keepRatio } : {}),
  };
}

/**
 * 题内相对裁量：返回**保留下标集合**（不排序）。
 *  - margin：cut = 题内最高分 − marginTop，保留 score ≥ cut（并列临界值一律保留，宁可多留）；
 *  - quantile：按分数降序保留 ceil(n × keepRatio) 条，下限 1 条（分子分母都只数**已评分**候选；
 *    未评分候选（provider 截断漏排）由调用方无条件保留，见 auto-recall 的 keepByFilter）。
 */
export function relativeKeepIdxSet(
  clean: ReadonlyArray<{ index: number; score: number }>,
  ruler: RerankRelativeRuler,
): Set<number> {
  const pass = new Set<number>();
  if (clean.length === 0) return pass;
  const sorted = [...clean].sort((a, b) => b.score - a.score);
  if (ruler.rule === "margin") {
    const cut = sorted[0].score - ruler.marginTop;
    for (const r of sorted) if (r.score >= cut) pass.add(r.index);
    return pass;
  }
  const nKeep = Math.max(1, Math.ceil(sorted.length * ruler.keepRatio));
  for (const r of sorted.slice(0, nKeep)) pass.add(r.index);
  return pass;
}
