/**
 * #137-F（2026-10-28）：融合锚点——截断窗口（cap）内必须保留融合主序 top-1。
 *
 * 动机（实测，docs/optimization-results.md §13.5 锚点那组对比）：W3 结论层开启后经验层预算
 * 常只剩 1 行，精排把这一行换成自己的 top-1，单条证据完全由 cross-encoder 决定；LME90
 * 全开档判对 77.8% vs 关掉精排 86.7%。锚点保证「已验证的融合最高置信证据」不被精排
 * 单方面换掉，同时 cap≥2 时精排仍可改第 2..cap 名次（价值保留），cap=1 时等于
 * 「精排只滤不清排」。
 *
 * 本文件只保留锚点这一件事：它不参与打分，只做窗口内保位。
 */

/**
 * 融合锚点：若融合主序 top-1（恒为下标 0，searchResult.lines 已按融合序排列）不在截断窗口
 * 内，就把它提到首位、其余保序；已在窗口内则原样返回。
 *
 * @param order     精排排序后的下标序列
 * @param cap 截断窗口（注入行数上限）
 */
export function anchorRerankOrder(order: readonly number[], cap: number): number[] {
  const out = [...order];
  if (!(cap > 0) || out.length === 0) return out;
  if (out.slice(0, cap).includes(0)) return out;
  return [0, ...out.filter((i) => i !== 0)];
}
