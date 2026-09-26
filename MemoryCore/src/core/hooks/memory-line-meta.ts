/**
 * 记忆行元数据剥离（F-CLUSTER v1，2026-09-26）。
 *
 * 口径约束（必须与 auto-recall.ts foldNearDuplicates 闭包内 stripMeta 保持逐位一致——
 * A2 校准（2026-09-15/16 两轮实测）「非重复 ≤0.04」只在内容口径下成立：
 * 剥离行首 tag（type|session）、行尾 soul 后缀、活动时间段，三者缺一会引入元数据
 * bigram 主导相似度（同 tag 短行对仅凭 tag 即逼近折叠阈值）。
 * 本模块为 F-CLUSTER 折叠线消费；单缀形态与闭包副本的一致性由 recall-fold-cluster.test.ts RED-3 锁定。
 *
 * 与闭包的已声明差异（2026-09-26 复查自纠）：闭包为单遍剥离（Jaccard 场景下尾缀残留不破坏
 * 其 0.25 阈值校准）；本函数为循环剥离到不动点——逐字相等判定要求彻底内容口径
 * （实测 RED-1 失败归因：行尾为活动时间缀时 `·soul[...]$` 不在行尾→soul 段残留→同文三行
 * strip 结果不同）。v2 计划：闭包体迁移到本模块统一为循环剥离（登记 F-CLUSTER 台账）。
 */
export function stripMemoryLineMeta(t: string): string {
  let prev = t.trimEnd();
  for (let i = 0; i < 4; i++) {
    const next = prev
      .replace(/^- \[[^\]]*\]\s*/, "")
      .replace(/·soul\[[^\]]*\]\s*$/, "")
      .replace(/·\(活动时间:[^)]*\)\s*$/, "")
      .trimEnd();
    if (next === prev) break;
    prev = next;
  }
  return prev;
}
