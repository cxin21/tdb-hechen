/**
 * #146（W2b 事实级双时态）：事实行 → turn 的读侧投影。
 *
 * 为什么需要这一层（第一性原理）：
 *   记忆系统里有三个粒度，本来就不该共用一个单位——
 *     · 写/失效：**属性槽** (entity, attribute)，只保留最新有效值；
 *     · 存储：事实行（可审计、可追溯）；
 *     · 召回预算与注入：**turn**（一条证据 = 一轮对话的语境）。
 *   写面切到事实级后，若读面仍按行计 k，同一 turn 的 n 条事实会各吃一个槽（槽位通胀），
 *   同时片段化会丢说话人/时间语境。实测（LME90，b1off 浅档）turnCov@5 78.4→68.0、
 *   偏好桶 93.3→55.6。所以读侧必须把同 turn 的事实行折叠回一条。
 *
 * 语义：同 fact_of 的命中只保留**得分最高**的那一条（其 content 即父 turn 原文，
 * 与整行基线逐位一致）；没有 fact_of 的普通记忆原样保留，零行为变化。
 * 纯函数、无 store 依赖（便于单测与 bench 复用）。
 */

/** 折叠统计（可观测：不静默丢命中）。 */
export interface FactTurnCollapse {
  /** 折叠前条数。 */
  before: number;
  /** 折叠掉（同 turn 低分重复）条数。 */
  collapsed: number;
  /** 折叠后条数。 */
  after: number;
}

/**
 * 按 fact_of 折叠事实行，保留每组最高分的首条；组内顺序取最高分首次出现的位置。
 *
 * @param entries 已排序的候选（打分序由调用方保证）
 * @param factOfOf 取 fact_of（缺省/空 = 普通记忆，不参与折叠）
 * @param scoreOf 取比较分（调用方传主序分，如 relevance ?? rrfScore）
 */
export function collapseFactRowsByTurn<T>(
  entries: readonly T[],
  factOfOf: (entry: T) => string | undefined,
  scoreOf: (entry: T) => number,
): { items: T[]; stats: FactTurnCollapse } {
  const items: T[] = [];
  const indexOfKey = new Map<string, number>();
  let collapsed = 0;
  for (const entry of entries) {
    const parent = factOfOf(entry);
    if (!parent) {
      items.push(entry);
      continue;
    }
    const existingIndex = indexOfKey.get(parent);
    if (existingIndex === undefined) {
      indexOfKey.set(parent, items.length);
      items.push(entry);
      continue;
    }
    collapsed++;
    const existing = items[existingIndex];
    if (scoreOf(entry) > scoreOf(existing)) items[existingIndex] = entry;
  }
  return { items, stats: { before: entries.length, collapsed, after: items.length } };
}
