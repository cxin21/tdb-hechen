/**
 * Scene block trigger keywords (缺口 B).
 *
 * 场景块除 META 摘要外再带一组「触发词」：注入侧命中即可越过纯语义门槛条件必注入。
 * 触发词是中文原词短语，不做同义词扩展、不造词——只做归一（NFKC + 小写）与去重。
 */

export const MAX_SCENE_KEYWORDS = 8;
export const MAX_SCENE_KEYWORD_CHARS = 24;

/** 归一化用于匹配的文本：NFKC（全角→半角）+ 小写 + 折叠空白。 */
export function normalizeMatchText(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function splitKeywordInput(input: string): string[] {
  return input.split(/[，,、\n;；]/);
}

/**
 * 规范化触发词数组。
 * - 接受 string[] 或分隔字符串（，,、;；换行）；
 * - trim、去空、按归一结果去重（保留首次出现的原写法）；
 * - 上限 MAX_SCENE_KEYWORDS 个；单条超长直接丢弃（不改写、不截断）；
 * - 非法输入 → []（不抛）。
 */
export function normalizeSceneKeywords(input: unknown): string[] {
  const raw: string[] = [];
  if (typeof input === "string") {
    raw.push(...splitKeywordInput(input));
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item !== "string") continue;
      raw.push(...splitKeywordInput(item));
    }
  } else {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const kw = item.trim();
    if (!kw) continue;
    if (kw.length > MAX_SCENE_KEYWORD_CHARS) continue;
    const key = normalizeMatchText(kw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= MAX_SCENE_KEYWORDS) break;
  }
  return out;
}

/**
 * 判定 query 命中了哪些触发词。
 *
 * 两条通道（任一命中即算）：
 * 1. 归一后包含匹配（中文短语无需分词即命中）；
 * 2. 整词匹配：tokens 由调用侧用仓内既有分词（buildFtsQuery/parseFtsTokens）提供，
 *    与归一后的触发词相等即命中。
 *
 * 返回命中的触发词（保持入参顺序、按归一结果去重）；空数组 = 未命中。
 */
export function matchSceneKeywords(query: string, keywords: readonly string[], tokens?: readonly string[]): string[] {
  const q = normalizeMatchText(query);
  if (!q || keywords.length === 0) return [];
  const tokenSet = new Set((tokens ?? []).map((t) => normalizeMatchText(t)).filter(Boolean));
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const kw of keywords) {
    const key = normalizeMatchText(kw);
    if (!key || seen.has(key)) continue;
    if (q.includes(key) || tokenSet.has(key)) {
      seen.add(key);
      hits.push(kw);
    }
  }
  return hits;
}
