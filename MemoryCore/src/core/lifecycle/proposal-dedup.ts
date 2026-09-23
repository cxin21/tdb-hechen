/**
 * V6-任务8 P1（2026-09-23 用户令提前开工）：红线提案语义去重单一源。
 *
 * 根因实锚：store 层 upsertPendingCore 已有「同 slot+content+pending」精确守卫
 * （sqlite.ts:2755-2758），生产 102 条 pending 的重复全部是换措辞语义重复——
 * 精确匹配挡不住，identity-discovery 入队前无语义闸门。
 *
 * 方法：字符 bigram Jaccard（确定性、零依赖、零 LLM、纯函数）。
 * 阈值 0.75 用生产 102 条全行实测标定：0.79 区间为真重复（网关簇 pairwise 0.79），
 * 同簇 0.692 为「改写幅度较大的同族规则」——闸门不并（宁漏勿错杀：误杀=真实规则
 * 静默丢失；漏放由 Panel 人工采纳兜底）。更激进的语义合并属 P0 存量清理（数据面，
 * 逐项呈报拍板后执行），不在本闸门。
 */

/** 清洗（去空白/中英文标点，lowercase）后取字符 bigram 集合。 */
export function charBigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[\s，。；：、“”‘’（）【】\[\]…·—!?,.;:'"()]+/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 提案语义相似度：字符 bigram Jaccard（0=完全不重叠，1=逐字等同）。 */
export function proposalSimilarity(a: string, b: string): number {
  const ga = charBigrams(a);
  const gb = charBigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/** 去重阈值（生产 102 条全行标定，见文件头）。 */
export const PROPOSAL_DUP_THRESHOLD = 0.75;

/** 在同类（同 slot）既有提案/已采纳条目中找语义重复项（取最高相似度者；无 → undefined）。 */
export function findDuplicateProposal(
  content: string,
  slot: string,
  existing: Array<{ slot: string; content: string }>,
  threshold: number = PROPOSAL_DUP_THRESHOLD,
): { slot: string; content: string; similarity: number } | undefined {
  let best: { slot: string; content: string; similarity: number } | undefined;
  for (const e of existing) {
    if (e.slot !== slot) continue;
    const sim = proposalSimilarity(content, e.content);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { slot: e.slot, content: e.content, similarity: sim };
    }
  }
  return best;
}
