/**
 * W3（issue #134）：结论层接入召回——结论卡（work_fact）构造前的规范化/校验。
 *
 * 结论卡是「经验层蒸馏产物」，进召回需要可回捞的源证据（part_of 单跳回捞，见
 * auto-recall 的 smallToBig 通道）。因此本模块的红线：**无有效源 turn 的卡一律丢弃**
 * （宁缺毋滥——不可回溯的结论不注入）。
 */

/** 蒸馏器原始输出的一条卡（字段未受信）。 */
export interface RawConclusionCard {
  content?: unknown;
  sourceTurnIds?: unknown;
}

/** 规范化后的结论卡。 */
export interface ConclusionCard {
  content: string;
  /** 源证据 turn id（已知集合内、去重、保序）。 */
  sourceTurnIds: string[];
}

export interface NormalizeConclusionOptions {
  /** 语料里真实存在的 turn id 集合（幻觉 id 丢弃）。 */
  knownTurnIds: ReadonlySet<string>;
  /** 单 case 卡数上限（缺省 4；0/负 = 不产出）。 */
  maxCards?: number;
  /** 内容最短字符数（缺省 12；过短无信息量，丢弃）。 */
  minContentChars?: number;
}

/**
 * 规范化蒸馏输出：容忍 `{cards:[...]}` 或裸数组；逐条校验后截断。
 */
export function normalizeConclusionCards(raw: unknown, opts: NormalizeConclusionOptions): ConclusionCard[] {
  const maxCards = typeof opts.maxCards === "number" && Number.isFinite(opts.maxCards) ? Math.floor(opts.maxCards) : 4;
  if (maxCards <= 0) return [];
  const minChars = typeof opts.minContentChars === "number" && Number.isFinite(opts.minContentChars) ? opts.minContentChars : 12;

  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { cards?: unknown }).cards)
      ? ((raw as { cards: unknown[] }).cards)
      : [];

  const out: ConclusionCard[] = [];
  const seenContent = new Set<string>();
  for (const item of list) {
    if (out.length >= maxCards) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const c = item as RawConclusionCard;
    const content = typeof c.content === "string" ? c.content.trim() : "";
    if (content.length < minChars) continue;
    const rawIds = Array.isArray(c.sourceTurnIds) ? c.sourceTurnIds : [];
    const ids: string[] = [];
    for (const id of rawIds) {
      if (typeof id !== "string") continue;
      const t = id.trim();
      if (!t || !opts.knownTurnIds.has(t) || ids.includes(t)) continue;
      ids.push(t);
    }
    // 红线：无源证据的结论不进召回（不可回溯 ⇒ 不可注入）。
    if (ids.length === 0) continue;
    const dedupeKey = content.replace(/\s+/g, " ").toLowerCase();
    if (seenContent.has(dedupeKey)) continue;
    seenContent.add(dedupeKey);
    out.push({ content, sourceTurnIds: ids });
  }
  return out;
}
