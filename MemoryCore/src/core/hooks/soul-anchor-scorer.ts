/**
 * #42（ADR0003-P3 实施票 D / D9）：锚相似度纯函数（2026-11-07 task-12 收口）。
 *
 * 历史：本模块曾是「情境锚相似度打分器」（嵌入缓存 + 并发合并 + MMR 选择），供人格渲染
 * 的锚选取段与跨段去重使用。人格/价值锚渲染随注入链退役后，打分/选择/缓存三个导出
 * 已零生产调用方（其配置门同批删除），只保留仍被消费的确定性 cosine 纯函数。
 *
 * 现存消费方：src/core/lifecycle/consolidation/grouping.ts（聚类增量的近似重复判定）。
 */

/** cosine 相似度纯函数：维数不匹配或零范数 → 0（宁缺毋滥，不抛错不猜）。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
