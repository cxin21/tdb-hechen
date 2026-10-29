/**
 * B2-b（bench/recall-opt）：MMR（Maximal Marginal Relevance）多样性重排。
 *
 * 动机：同 session 多条近重复 turn 挤占 top-k 槽位，是 hits 高而 session/turn 覆盖低的
 * 直接原因之一（docs/optimization-plan.md §B2-b）。λ=0.7 为方案拍板缺省。
 *
 * 语义合同：
 *  - 输入 = 精排 pass 池的原始索引 + 对应文档文本；输出 = 同一索引集合的**置换**（不减员）。
 *    垫尾/预算切分/门槛语义全部不变——调用方拿到的仍是「按展示优先级排序的全量 pass 池」。
 *  - 相关度 = 精排名次（monotonic 1 - rank/n）；相似度 = 字符 bigram Jaccard（确定性、零外呼、
 *    与 foldNearDuplicates 同族的近重复判据）。
 *  - n ≤ 100（rerank candidates clamp 上限），O(n²·bigram) 完全可忽略。
 */
export function mmrReorder(idxs: number[], docs: string[], lambda: number): number[] {
  if (idxs.length <= 1) return [...idxs];
  const lam = Math.min(1, Math.max(0, lambda));
  const bigrams = (s: string): Set<string> => {
    const t = String(s ?? "").replace(/\s+/g, "").toLowerCase();
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const sets = idxs.map((i) => bigrams(docs[i] ?? ""));
  const jacc = (a: Set<string>, b: Set<string>): number => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const g of a) if (b.has(g)) inter++;
    return inter / (a.size + b.size - inter);
  };
  const rel = (k: number): number => (idxs.length <= 1 ? 1 : 1 - k / idxs.length);
  const pool = idxs.map((_, k) => k);
  const out: number[] = [];
  while (pool.length) {
    let bestP = 0;
    let bestV = -Infinity;
    for (let p = 0; p < pool.length; p++) {
      const k = pool[p];
      let maxSim = 0;
      for (const c of out) {
        const s = jacc(sets[c], sets[k]);
        if (s > maxSim) maxSim = s;
      }
      const v = lam * rel(k) - (1 - lam) * maxSim;
      if (v > bestV) {
        bestV = v;
        bestP = p;
      }
    }
    out.push(idxs[pool[bestP]]);
    pool.splice(bestP, 1);
  }
  return out;
}
