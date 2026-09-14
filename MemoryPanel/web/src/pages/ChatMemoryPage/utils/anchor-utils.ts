/**
 * anchor-utils —— BlockDetail 价值锚/回忆统计纯函数（Task 4，DS-PANEL-UI-WIKI-SOURCE-001 §2.1）。
 *
 * 数据源：L1 行 metadata_json（C1 落库：coreRefs / recall_count）。零 import，
 * 可被根 vitest（node 环境）直接单测。宽松校验：损坏/缺失一律返空态，不造假值
 * （宁缺毋滥——网关今日不返回 metadata 时两个函数都为空，UI 不渲染对应标签）。
 */

/** L1 metadata 的宽松形状（只列 UI 消费的键）。 */
export interface AtomicMetadata {
  coreRefs?: unknown;
  recall_count?: unknown;
  last_recalled_at?: unknown;
}

/** 提取记忆行上标注的价值锚 label 数组；缺失/损坏 → []（不标注 = 不显示）。 */
export function coreRefsOf(m?: AtomicMetadata | null): string[] {
  const refs = m?.coreRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((r): r is string => typeof r === 'string' && r.length > 0);
}

/** 提取回忆计数（重巩固统计）；缺失/非有限数值 → undefined（不显示该行）。 */
export function recallCountOf(m?: AtomicMetadata | null): number | undefined {
  const c = m?.recall_count;
  if (typeof c !== 'number' || !Number.isFinite(c)) return undefined;
  return c;
}
