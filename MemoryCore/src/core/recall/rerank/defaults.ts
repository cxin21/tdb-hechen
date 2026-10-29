/**
 * #145（2026-10-29）：rerank 生产默认值的**单一口径源**。
 *
 * 实测（#135 / docs/optimization-results.md §10，LME90 n=90）：b0base（candidates=12 /
 * minScore=−2）67.1% → deep105（32 / −10.5）84.3%（+16.67pp，CI95[+9.05,+24.29]，p=0.0005）。
 * 伤害源是**剪枝**（kept≥4 的题从 38/90 → 80/90），不是重排本身；只扩池不加 floor（deep4：
 * 32/−4 仍 80.9%）收益有限，因为 −4 依然在分布内侧砍 gold。#144（§19）把分数分布量化后
 * 进一步确认：−10.5 落在本批日志分布左侧 ≈ 不筛——代价是「丢不掉噪声」，收益是不误杀，
 * 而真正的裁剪交给候选池 cap（candidates）与题内相对尺子（filterRule）。
 *
 * 刻度语义（#99 F3 起，见 auto-recall 的 applyRecallRerank）：配置里的 **minScore 恒按
 * provider 原生刻度声明**——local cross-encoder 输出原始 logit，云 provider（siliconflow /
 * dashscope）输出 0..1 相关度；判定前 local 做 sigmoid 归一、门槛同变换。因此「等价缺省」
 * 对概率刻度 provider 必须做 sigmoid 换算：照搬 −10.5 在 0..1 刻度上等于负阈值 = 永不剪枝，
 * 与 local 的语义并不等价（虽然量级上都接近不筛）。
 *
 * 沿用 ADR-0012 / ADR-0013 的「一把尺子只能有一份实现」原则，**运行时**口径在这里是唯一的：
 * config.ts（parse 期物化缺省、clamp）与 auto-recall.ts（wiring 兜底、刻度判定）都从这里取。
 * 离线校准脚本（scripts/analyze-r144-rerank-floor.mjs 等）不在这个口径内——它们复算的是
 * 历史实验的显式阶梯（自带 −10.5 字面量），刻意不随生产缺省漂移，改缺省时别顺手改它们。
 */

/** 送精排的候选池大小缺省（深池档；0..∞ 由 config.ts clamp [1,100] 取整）。 */
export const DEFAULT_RERANK_CANDIDATES = 32;

/**
 * local（cross-encoder logit 刻度）的缺省相关度门槛。
 * −10.5 ≈ sigmoid 后 2.75e-5：在本批实测分布里等于「近不筛」，只有异常低分行会被剔。
 */
export const DEFAULT_RERANK_MIN_SCORE_LOGIT = -10.5;

/** sigmoid：logit → 0..1（与 auto-recall 判定路径同一个变换，避免两处近似值漂移）。 */
export function sigmoid01(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * 概率刻度（0..1）provider 的等价缺省门槛 = sigmoid(−10.5) ≈ 2.7489e-5。
 * 与 local 的 −10.5 落在同一 sigmoid 分位，判定边界单调等价。
 */
export const DEFAULT_RERANK_MIN_SCORE_PROB = sigmoid01(DEFAULT_RERANK_MIN_SCORE_LOGIT);

/** 0..1 概率刻度 provider（原生产生 0..1 相关度，不归一；见 applyRecallRerank 的 logitScale）。 */
const PROB_SCALE_RERANK_PROVIDERS = new Set(["siliconflow", "dashscope"]);

/**
 * 该 provider 是否 logit 刻度（需 sigmoid 归一后再对门槛）。
 *
 * 判定路径（auto-recall 的经验层精排与结论层 r71 gate）必须调它，别各写
 * `provider === "local"`：刻度是「一把尺子」的核心语义，散写就有漂移风险。
 *
 * 注意与 {@link defaultRerankMinScore} 的差别是有意的：这里只回答「要不要归一」，
 * 所以 "none"/未知（off 态，永不走判定）返回 false；那边要给出「展示值+journal 口径」，
 * 因此 "none"/未知回落 logit 缺省 −10.5。
 */
export function isLogitScaleProvider(provider: string | null | undefined): boolean {
  return provider === "local";
}

/**
 * 按 provider 刻度给出 minScore 缺省。
 * - "siliconflow" / "dashscope" → {@link DEFAULT_RERANK_MIN_SCORE_PROB}（0..1 刻度）；
 * - "local"（logit 刻度）与 "none"/未知（off 态，值只用于展示与 journal）→
 *   {@link DEFAULT_RERANK_MIN_SCORE_LOGIT}。
 */
export function defaultRerankMinScore(provider: string | null | undefined): number {
  return provider !== null && provider !== undefined && PROB_SCALE_RERANK_PROVIDERS.has(provider)
    ? DEFAULT_RERANK_MIN_SCORE_PROB
    : DEFAULT_RERANK_MIN_SCORE_LOGIT;
}
