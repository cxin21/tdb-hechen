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
  const joined = joinWithBudget(kept, sep, opts.maxFactChars);
  return joined ? content + sep + joined : content;
}

// ============================
// #137（W1 双通道）：多事实归一化 + 事实通道键文本
// ============================
//
// 与上面 buildEmbeddingKey（键替换档，bench 口径）的分工：
//  - buildEmbeddingKey：原文 + 事实 → **同一条**embedding 键（W1 旧形态，会稀释原文判别信号）；
//  - 本节的 buildFactChannelKey：只产出**事实通道**的键文本（原文主索引不动），
//    写侧把它单独 embed 成一条向量、存独立向量表，召回时作为平行通道参与融合。
// 归一化（去空白/去重/长度边界/条数上限）是两条路径的公共纪律：抽不好的噪声事实是负收益
//（docs/optimization-results.md B3 警告）。

/** 事实三元组（抽取器可选输出；只用于补全键短语，不单独建索引）。 */
export interface FactTriple {
  subject: string;
  predicate: string;
  value: string;
}

/** 归一化后的事实集合（短语进键文本；三元组仅在 includeTriples 时展开成短语）。 */
export interface NormalizedFacts {
  phrases: string[];
  triples: FactTriple[];
}

/** 事实归一化选项（写侧 memory.write.factKey / 抽取侧 memory.extraction.facts 共用）。 */
export interface FactNormalizeOptions {
  /** 最多保留几条短语（去重后按首见顺序截断）。缺省 5；0/负/非有限 = 不限。 */
  maxFacts?: number;
  /** 单条短语字符上限（超出整条丢弃，不切断——半句话是噪声）。缺省 240。 */
  maxPhraseChars?: number;
  /** 单条短语最小字符数（噪声过滤）。缺省 2。 */
  minPhraseChars?: number;
}

/** 事实条数缺省/上限（config、抽取 parse、提示词预算、写侧共用同一口径）。 */
export const DEFAULT_MAX_FACTS = 5;
export const MAX_FACTS_LIMIT = 12;
const DEFAULT_MAX_PHRASE_CHARS = 240;
const DEFAULT_MIN_PHRASE_CHARS = 2;

/**
 * 事实条数上限唯一 clamp（#137 单一源）：非有限/缺省 → 5；否则 floor 后夹到 [1, 12]。
 * config 解析、抽取 parse、提示词预算、写侧归一化全部走它——不再各自复制 ⋯1..12 的字面量。
 */
export function clampMaxFacts(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_FACTS;
  return Math.min(MAX_FACTS_LIMIT, Math.max(1, Math.floor(raw)));
}
/** 至少含一个字母/数字才算「短语」（纯标点/空白不是事实）。 */
const HAS_WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 去重键：忽略大小写、多余空白与尾随标点（"Likes hiking。" 与 "likes  hiking" 视为同一条）。 */
function factDedupeKeyOf(s: string): string {
  return collapseSpaces(s).toLowerCase().replace(/[。．.，,；;！!？?]+$/u, "");
}

function maxFactsOf(opts: FactNormalizeOptions): number {
  // 缺省/非法（含 0、负数）统一回落 5——全仓只有一套语义，不再有「0 = 不限」的分叉。
  return clampMaxFacts(opts.maxFacts);
}

function phraseOfItem(item: unknown): string | undefined {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const o = item as Record<string, unknown>;
  if (typeof o.phrase === "string" && o.phrase.trim()) return o.phrase;
  const subject = typeof o.subject === "string" ? o.subject.trim() : "";
  const predicate = typeof o.predicate === "string" ? o.predicate.trim() : "";
  if (!subject || !predicate) return undefined;
  const value = typeof o.value === "string" ? o.value.trim() : "";
  return value ? subject + " " + predicate + " " + value : subject + " " + predicate;
}

/**
 * 事实短语归一化：接受 string / {phrase} / {subject,predicate,value} 三种形状的数组
 * （也接受单个值）。规则：折叠空白 → 长度边界（过短/过长整条丢弃）→ 去重（大小写/尾随标点
 * 不敏感）→ 条数上限。抽取器输出的任何脏形状都不会抛错，只被安静丢弃。
 */
export function normalizeFactPhrases(raw: unknown, opts: FactNormalizeOptions = {}): string[] {
  const maxFacts = maxFactsOf(opts);
  const maxChars = typeof opts.maxPhraseChars === "number" && Number.isFinite(opts.maxPhraseChars) && opts.maxPhraseChars > 0
    ? Math.floor(opts.maxPhraseChars)
    : DEFAULT_MAX_PHRASE_CHARS;
  const minChars = typeof opts.minPhraseChars === "number" && Number.isFinite(opts.minPhraseChars) && opts.minPhraseChars >= 0
    ? Math.floor(opts.minPhraseChars)
    : DEFAULT_MIN_PHRASE_CHARS;
  const items = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const phrase = phraseOfItem(item);
    if (typeof phrase !== "string") continue;
    const t = collapseSpaces(phrase);
    if (t.length < minChars || t.length > maxChars) continue;
    if (!HAS_WORD_CHAR_RE.test(t)) continue;
    const key = factDedupeKeyOf(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= maxFacts) break;
  }
  return out;
}

/**
 * 三元组归一化：subject 与 predicate 都必填（缺一即丢，不猜），value 可空。
 * 去重键 = subject|predicate|value（小写）。条数上限与短语共用 maxFacts。
 */
export function normalizeFactTriples(raw: unknown, opts: FactNormalizeOptions = {}): FactTriple[] {
  const maxFacts = maxFactsOf(opts);
  const items = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const seen = new Set<string>();
  const out: FactTriple[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const subject = typeof o.subject === "string" ? collapseSpaces(o.subject) : "";
    const predicate = typeof o.predicate === "string" ? collapseSpaces(o.predicate) : "";
    if (!subject || !predicate) continue;
    const value = typeof o.value === "string" ? collapseSpaces(o.value) : "";
    const key = (subject + "|" + predicate + "|" + value).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subject, predicate, value });
    if (out.length >= maxFacts) break;
  }
  return out;
}

/**
 * 合并多来源三元组（#137 写侧）：facts[] 内联三元组 ∪ metadata.factTriples，
 * 去重保首见顺序、条数按 maxFacts 封顶。与 normalizeFactTriples 共用同一 key 规则。
 */
export function mergeFactTriples(groups: readonly unknown[], opts: FactNormalizeOptions = {}): FactTriple[] {
  const maxFacts = maxFactsOf(opts);
  const seen = new Set<string>();
  const out: FactTriple[] = [];
  for (const group of groups) {
    for (const t of normalizeFactTriples(group, { ...opts, maxFacts: maxFacts })) {
      const key = (t.subject + "|" + t.predicate + "|" + t.value).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= maxFacts) return out;
    }
  }
  return out;
}

/** 一次性把任意原始事实形状归一化成 {phrases, triples}（同一份输入、同一套上限）。 */
export function normalizeFacts(raw: unknown, opts: FactNormalizeOptions = {}): NormalizedFacts {
  return {
    phrases: normalizeFactPhrases(raw, opts),
    triples: normalizeFactTriples(raw, opts),
  };
}

/** 三元组展开成键短语（subject predicate value），与 phrase 同形自足。 */
export function tripleToPhrase(t: FactTriple): string {
  return t.value ? t.subject + " " + t.predicate + " " + t.value : t.subject + " " + t.predicate;
}

/**
 * 产出「进键的短语」：短语在前、三元组展开文本在后（includeTriples 时），整体再去重。
 * 顺序即抽取顺序（键是拼接文本，顺序影响 embedding 的注意力分布，保持稳定）。
 */
export function factKeyPhrases(
  facts: NormalizedFacts,
  includeTriples = false,
  opts: FactNormalizeOptions = {},
): string[] {
  const merged = includeTriples ? [...facts.phrases, ...facts.triples.map(tripleToPhrase)] : [...facts.phrases];
  return normalizeFactPhrases(merged, opts);
}

/** 按预算拼接短语（#137 唯一实现，buildEmbeddingKey 也走这里）：budget 为 undefined/非有限 → 全拼；
 *  0/负 → 空串（通道退出语义）；整条跳不过预算即停（不切断单条短语）。 */
function joinWithBudget(phrases: readonly string[], sep: string, budget: number | undefined): string {
  if (phrases.length === 0) return "";
  if (typeof budget === "number") {
    if (!Number.isFinite(budget) || budget <= 0) return "";
    const picked: string[] = [];
    let used = 0;
    for (const f of phrases) {
      const add = picked.length === 0 ? f.length : sep.length + f.length;
      if (used + add > budget) break;
      used += add;
      picked.push(f);
    }
    return picked.join(sep);
  }
  return phrases.join(sep);
}

/** buildFactChannelKey 的选项：归一化 + 键文本拼接。 */
export interface FactChannelKeyOptions extends FactNormalizeOptions, EmbeddingKeyOptions {
  /** 是否把三元组展开成短语一起进键（缺省 false）。 */
  includeTriples?: boolean;
}

/** 形状判定：调用方已归一化过（{phrases, triples}）时不再把三元组当短语重复塞一遍。 */
function isNormalizedFactsLike(raw: unknown): raw is NormalizedFacts {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as NormalizedFacts).phrases);
}

/**
 * #137：事实通道的 embedding 键文本。
 *
 * 只含事实短语（**不含原文**）——原文由主索引负责；两条通道各自成向量，召回时融合。
 * facts 接受任意原始抽取形状，或已归一的 {phrases, triples}（写侧从 metadata 取的就是后者）：
 * 短语进键；includeTriples 时再把三元组展开成短语补上（去重后）。
 * 事实为空/被去噪干净/预算 0 → 返回空串（调用方据此零外呼、通道退出）。
 */
export function buildFactChannelKey(facts: unknown, opts: FactChannelKeyOptions = {}): string {
  const normalized = isNormalizedFactsLike(facts)
    ? {
        phrases: normalizeFactPhrases(facts.phrases, opts),
        triples: normalizeFactTriples(facts.triples, opts),
      }
    : normalizeFacts(facts, opts);
  const phrases = factKeyPhrases(normalized, opts.includeTriples === true, opts);
  return joinWithBudget(phrases, opts.separator ?? " | ", opts.maxFactChars);
}
