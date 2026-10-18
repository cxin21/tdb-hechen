/**
 * #54（2026-10-19）召回注入动态 topK —— 分数分布 elbow 确定性纯函数。
 *
 * 痛点：R7 经验层按固定条数注入（maxResults/预算切分），对分数分布里的断崖
 * （top 强相关 vs 长尾弱相关）不感知 → 长尾弱相关占满注入预算、稀释下游注意力。
 *
 * 契约：
 *   - 只缩不扩：返回值 ∈ [0, pool.length]（pool=scores 前 maxK 项）——调用方仅在
 *     返回值 < 当前注入条数时收缩，绝不因此扩注入；
 *   - 刻度无关：纯相对落差判定（d(k*) ≥ dropRatio × span），兼容 cosine ~0.x 与
 *     hybrid RRF fallback ~0.0x 两种 scores 刻度（auto-recall.ts:1411/:2439）；
 *   - span<=0（全同分/非降序）不切 = 逐位现状；空池返回 0；
 *   - 非有限分（NaN/±Inf）按 0 参与分布（确定性，不产生异常切点）；
 *   - elbow 定义：候选切点 k ∈ [1, pool.length-1]（k=切后保留条数），落差
 *     d(k)=pool[k-1]-pool[k]，k*=argmax（平手取最小 k=最先出现）；d(k*) 达门槛才切，
 *     切后 clamp 到保底 minTopK（保底是注入下限，不是切点下限）；不达门槛返回 pool.length。
 *
 * 调用方（auto-recall.ts R7 经验层切片后）：scores 缺席（keyword FTS 路只回 lines、
 * 无平行分数）不调用本函数——保留注入现状，宁缺毋滥不做无据收缩。
 */

export interface DynamicTopKOptions {
  /** 保底条数（clamp [1,∞)，floor）；elbow 不会切到低于此值的注入。缺省 2。 */
  minTopK?: number;
  /** elbow 门槛：最大相邻落差 ≥ dropRatio × (首分-末分) 才切（clamp [0.01,1]）。缺省 0.5。 */
  dropRatio?: number;
}

export const DYNAMIC_TOPK_DEFAULT_MIN_TOP_K = 2;
export const DYNAMIC_TOPK_DEFAULT_DROP_RATIO = 0.5;

export function dynamicTopKCount(
  scores: readonly number[],
  maxK: number,
  opts?: DynamicTopKOptions,
): number {
  const minTopK = Math.max(1, Math.floor(Number(opts?.minTopK ?? DYNAMIC_TOPK_DEFAULT_MIN_TOP_K)));
  const dropRatioRaw = Number(opts?.dropRatio ?? DYNAMIC_TOPK_DEFAULT_DROP_RATIO);
  const dropRatio = Math.min(1, Math.max(0.01, Number.isFinite(dropRatioRaw) ? dropRatioRaw : DYNAMIC_TOPK_DEFAULT_DROP_RATIO));
  const limit = Math.max(0, Math.floor(Number(maxK) || 0));
  const pool: number[] = [];
  for (let i = 0; i < limit && i < scores.length; i++) {
    const s = Number(scores[i]);
    pool.push(Number.isFinite(s) ? s : 0);
  }
  if (pool.length <= minTopK) return pool.length;
  const span = pool[0] - pool[pool.length - 1];
  if (span <= 0) return pool.length;
  let bestK = -1;
  let bestDrop = 0;
  for (let k = 1; k <= pool.length - 1; k++) {
    const d = pool[k - 1] - pool[k];
    if (d > bestDrop) { bestDrop = d; bestK = k; }
  }
  if (bestK > 0 && bestDrop >= dropRatio * span) return Math.max(bestK, minTopK);
  return pool.length;
}