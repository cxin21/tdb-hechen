/**
 * B1 生产化（bench/recall-opt G1）：注入块时间序打包——纯函数排序器。
 *
 * 依据：LME90 配对实验（bench/recall-opt，docs/optimization-results.md）——
 * 记忆行按语义分数排序会把 knowledge-update 的旧值压过新值（hurt 9/23 集中该题型）；
 * 按时间升序排列证据行后，B1 档判对 +15.6pp（p=0.001）。
 *
 * 口径（与 bench scripts/lib/bench/llm.mjs buildEvidenceBlock 同一比较器语义）：
 *  - 时间键 = 行首 [YYYY-MM-DD HH:MM(:SS)?] 前缀（秒省略视为 00）；无前缀排最后；
 *  - 升序（旧→新）；同键与无前缀组内保持原相对顺序（稳定）；
 *  - 返回新数组，不修改输入。
 */

/** 行首时间前缀提取：匹配则返回可字典序比较的 "YYYY-MM-DD HH:MM[:SS]"，否则返回哨兵最大值。 */
export function leadingTimestampOf(line: string): string {
  const m = /^[\[](\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)[\]]/.exec(String(line ?? ""));
  return m ? `${m[1]} ${m[2] ?? "00:00"}` : "9999-99-99 99:99";
}

/** 按行首时间戳升序重排（稳定；无前缀排最后）。返回新数组。 */
export function sortLinesByLeadingTimestamp(lines: string[]): string[] {
  return lines
    .map((line, idx) => ({ line, idx, ts: leadingTimestampOf(line) }))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.idx - b.idx)
    .map((x) => x.line);
}
