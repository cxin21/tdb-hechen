/**
 * W1（issue #134）：事实键双写——embedding 键文本构造。
 *
 * 设计（spec #133「事实键方案」）：embedding 输入 = turn 原文 + 事实短语拼接（K=V+fact），
 * **原文仍是命中载荷**——本函数只产出「键文本」，落库 content 不动；调用方把键文本交给
 * embedding 服务、原始 record.content 照旧写入 store。
 *
 * 缺省行为：无事实 → 逐位返回原文（零行为变化的旁路语义）。
 */

export interface EmbeddingKeyOptions {
  /** 事实短语拼接分隔符（缺省 " | "）。 */
  separator?: string;
  /**
   * 事实部分字符预算（不含原文）：超出即停止追加后续短语（整条截断，不切断单条短语）。
   * 0/负 = 不拼接事实（旁路开关语义，逐位返回原文）；undefined = 不限。
   */
  maxFactChars?: number;
}

/** 事实短语列表（顺序即抽取器输出顺序）。 */
export type FactPhrases = readonly string[];

/**
 * 构造 embedding 键文本。
 *
 * @param content turn 原文（落库内容，键的前半段）
 * @param facts   抽取出的事实短语；空/缺省 → 逐位返回 content
 */
export function buildEmbeddingKey(
  content: string,
  facts: FactPhrases | undefined,
  opts: EmbeddingKeyOptions = {},
): string {
  const sep = opts.separator ?? " | ";
  // 抽取噪声防御：空白短语丢弃、重复短语去重（保留首见顺序；键是拼接文本，
  // 重复短语只稀释语义、不加分——宁缺毋滥，不猜"近似"合并）。
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of facts ?? []) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    kept.push(t);
  }
  if (kept.length === 0) return content;
  const budget = opts.maxFactChars;
  if (typeof budget === "number") {
    if (!Number.isFinite(budget) || budget <= 0) return content;
    const picked: string[] = [];
    let used = 0;
    for (const f of kept) {
      const add = picked.length === 0 ? f.length : sep.length + f.length;
      if (used + add > budget) break;
      used += add;
      picked.push(f);
    }
    if (picked.length === 0) return content;
    return content + sep + picked.join(sep);
  }
  return content + sep + kept.join(sep);
}
