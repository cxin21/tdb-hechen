/**
 * #141（2026-10-28）：结论层分阶段预算（复合单元槽位记账）+ 表示仲裁。
 *
 * 根因（票面 §9 allon 77.8% = 基线、比只开 W3 的 84.4% 低 6.7pp）：
 *  ① 三机制在**同一阶段**竞争同一份注入预算（maxResults=5，有效证据行只剩 3.5-4.5）；
 *  ② 结论卡与 turn 行是**同一知识的两种表示**——注入结论就必然挤掉承载答案的原文行，
 *     是零和替换，不是信息增益；
 *  ③ 结论卡缺证据链时，「摘要」比「原文」信息更少（#155）。
 *
 * 本模块给出两条与开关无关的机制，让三机制各占一个阶段：
 *  - computeSlotBudget：给「结论 + 必带源证据」这个**复合单元**记 1.5 槽成本
 *    （结论 1 槽 + 证据 0.5 槽），而不是「结论 1 行、证据另算」——今天 additive 模式下
 *    2 张卡 + 2 条证据 + 3 行原文 = 7 行，但证据只占 2 行；槽位记账后同样的 5 行预算里
 *    经验层的保底行数是被显式定价的，不再被结论行静默挤掉。
 *  - arbitrateConclusions：与已选 turn 行语义重复（覆盖率 ≥ 阈值）的结论行让位——
 *    原文既有答案又有时间戳与说话人，比摘要更有信息量；让出来的槽位回到经验层。
 *    这是「同一知识两种表示」的直接解，避免用关掉结论层来回避问题。
 *
 * 纯函数：无时钟、无随机、无外呼、无 store 依赖。
 */

/** 槽成本缺省值：结论 1 槽 + 它必带的 1 条源证据 0.5 槽。 */
export const DEFAULT_SLOT_COST = 1.5;
/** 槽成本合法区间（<1 会让结论比原文还便宜，>3 会让 2 张卡吃光 5 行预算）。 */
export const MIN_SLOT_COST = 1;
export const MAX_SLOT_COST = 3;

export interface SlotBudgetInput {
  /** 注入总行预算（= recall.maxResults）。 */
  maxResults: number;
  /** 入选结论条数（候选上限裁剪后）。 */
  conclusionCount: number;
  /** 每条结论的槽成本（含其必带源证据）；缺省 DEFAULT_SLOT_COST。 */
  slotCost?: number;
  /** 是否要求「结论必带 ≥1 条源证据」；false → 不预留证据槽，成本按 1 槽计。 */
  pairing?: boolean;
  /** 成对证据行总上限；缺省 = 每条结论 1 条。 */
  maxPairing?: number;
}

export interface SlotBudget {
  /** 结论行上限（= 入参结论数，向下取整、非负）。 */
  conclusionLimit: number;
  /** 成对证据行上限（pairing=false 时 0）。 */
  pairingLimit: number;
  /** 经验层（原文 turn 行）行数上限。 */
  experienceLimit: number;
  /** 结论单元占总预算的槽数（浮点，供观测）。 */
  cost: number;
}

/** 数值兜底：非有限/负数 → 0。 */
function nonNeg(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * 复合单元槽位预算。
 *
 * 不变式：
 *  - 结论 0 条 → experienceLimit = maxResults（全链与关闭结论层逐位一致，退化安全）；
 *  - experienceLimit 恒 ≥ 0；结论数超出预算时经验层为 0（结论层仍受 conclusionLimit 约束）；
 *  - pairing=false 时槽成本截到 1（结论只占 1 行，证据不预留）。
 */
export function computeSlotBudget(input: SlotBudgetInput): SlotBudget {
  const maxResults = Math.floor(nonNeg(input?.maxResults));
  const conclusionCount = Math.floor(nonNeg(input?.conclusionCount));
  const pairing = input?.pairing !== false;
  const rawCost = input?.slotCost === undefined ? DEFAULT_SLOT_COST : nonNeg(input.slotCost);
  const clamped = Math.min(MAX_SLOT_COST, Math.max(MIN_SLOT_COST, rawCost));
  const perConclusion = pairing ? clamped : Math.min(1, clamped);
  const cost = conclusionCount * perConclusion;
  const pairingLimit = pairing
    ? Math.min(conclusionCount, Math.floor(nonNeg(input?.maxPairing ?? conclusionCount)))
    : 0;
  return {
    conclusionLimit: conclusionCount,
    pairingLimit,
    experienceLimit: Math.max(0, Math.floor(maxResults - cost)),
    cost,
  };
}

/** 英文停用词（只影响表示仲裁的重叠率，保守起见剔除虚词）。 */
const EN_STOP = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "of", "to", "in", "on",
  "at", "for", "and", "or", "but", "i", "me", "my", "you", "your", "it", "its", "this", "that",
  "these", "those", "with", "as", "by", "from", "do", "did", "does", "have", "has", "had", "not",
  "no", "if", "then", "than", "so", "we", "they", "them", "he", "she", "his", "her", "what",
  "which", "who", "when", "where", "how", "there", "here", "about", "into", "over", "also", "am",
]);

/** 行首标签段（- [结论|场景] 的方括号部分）——不参与重叠率，否则同类标签会虚高相似度。 */
const LINE_TAG_RE = /^\s*-?\s*\[[^\]]*\]\s*/;

/**
 * 内容 token 化（与 FTS 分词解耦的轻量确定性版本，供表示仲裁用）：
 *  - 英文/数字：长度 ≥ 2 的词，小写化，去停用词；
 *  - 中文：连续汉字取 bigram（单字整段保留），避免单字噪声。
 * 行首 [tag] 标签先剥掉。空串/非字符串 → []。
 */
export function contentTokens(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const body = text.replace(LINE_TAG_RE, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const m of body.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const word = m[0];
    if (word.length < 2 || EN_STOP.has(word)) continue;
    push(word);
  }
  for (const m of body.matchAll(/\p{Script=Han}+/gu)) {
    const run = m[0];
    if (run.length === 1) {
      push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) push(run.slice(i, i + 2));
  }
  return out;
}

/** 仲裁的最小规模门槛：结论 token 少于这个数就不做冗余判定（短结论按比例判定必然误杀）。 */
const MIN_ARBITRATE_TOKENS = 4;

/** 否定极性探针（中英）：覆盖率相同但极性相反，不能判冗余。 */
const NEGATION_RE = /\b(?:not|no|never|none|cannot|can't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|without)\b|不|没|无|未|别/u;
function hasNegation(text: string): boolean {
  return NEGATION_RE.test(String(text ?? "").toLowerCase());
}

/** a 的 token 被 b 覆盖的比例（|A∩B| / |A|）；a 无 token → 0。 */
export function overlapRatio(a: string, b: string): number {
  const at = contentTokens(a);
  if (at.length === 0) return 0;
  const bt = new Set(contentTokens(b));
  if (bt.size === 0) return 0;
  let hit = 0;
  for (const t of at) if (bt.has(t)) hit++;
  return hit / at.length;
}

export interface ArbitrateInput {
  /** 结论行（已格式化：- [结论|场景] 内容）。 */
  conclusions: readonly string[];
  /** 已选中的经验层原文行（已格式化）。 */
  experienceLines: readonly string[];
  /** 冗余判定阈值（结论 token 被某条原文行覆盖的比例 ≥ 阈值 → 让位）；缺省 0.75，clamp [0,1]。 */
  threshold?: number;
}

export interface ArbitrateResult {
  /** 保留的结论下标（原序）。 */
  kept: number[];
  /** 让位的结论下标（原序）。 */
  dropped: number[];
  /** 与 dropped 对齐的理由串（redundant:<ratio>|redundant-with:<lineIdx>）。 */
  reasons: string[];
}

/**
 * 表示仲裁：与已选 turn 行语义重复的结论行让位（原文信息量更大：内容 + 时间戳 + 说话人）。
 *
 * 语义：
 *  - 无经验行 → 全部保留（结论是唯一表示，让位等于丢知识）；
 *  - 结论为空 → 空结果；
 *  - threshold 非有限 → 0.75；阈值 clamp [0,1]；
 *  - 只与**同一注入批**的原文行比较（不做跨轮/跨题假设，确定性）。
 */
export function arbitrateConclusions(input: ArbitrateInput): ArbitrateResult {
  const conclusions = input?.conclusions ?? [];
  const experienceLines = input?.experienceLines ?? [];
  const rawThreshold = typeof input?.threshold === "number" && Number.isFinite(input.threshold)
    ? input.threshold
    : 0.75;
  const threshold = Math.min(1, Math.max(0, rawThreshold));
  const kept: number[] = [];
  const dropped: number[] = [];
  const reasons: string[] = [];
  if (conclusions.length === 0 || experienceLines.length === 0) {
    return { kept: conclusions.map((_, i) => i), dropped, reasons };
  }
  for (let i = 0; i < conclusions.length; i++) {
    // 短结论（"500 Mbps"、"Mochi"、"我住在柏林"）的 token 集合太小：原文行只要出现那个数字/名字
    // 就 100% 覆盖，按比例判定必然误杀（票面「精确事实答案在原文」的情形反而最容易被丢）。
    // 规模不足 → 不做仲裁，保留（宁缺毋滥）。
    const conclTokens = contentTokens(conclusions[i]);
    if (conclTokens.length < MIN_ARBITRATE_TOKENS) {
      kept.push(i);
      continue;
    }
    let worst = 0;
    let worstLine = -1;
    for (let j = 0; j < experienceLines.length; j++) {
      const ratio = overlapRatio(conclusions[i], experienceLines[j]);
      if (ratio > worst) {
        worst = ratio;
        worstLine = j;
      }
    }
    // 否定极性相反（"doesn't support X" vs "supports X"）token 完全相同，但语义相反——
    // 覆盖率高不代表冗余，让位会丢掉更新后的结论。
    const polarityFlip = worstLine >= 0 && hasNegation(conclusions[i]) !== hasNegation(experienceLines[worstLine]);
    if (worstLine >= 0 && worst >= threshold && !polarityFlip) {
      dropped.push(i);
      reasons.push("redundant:" + worst.toFixed(2) + "|redundant-with:" + worstLine);
    } else {
      kept.push(i);
    }
  }
  return { kept, dropped, reasons };
}
