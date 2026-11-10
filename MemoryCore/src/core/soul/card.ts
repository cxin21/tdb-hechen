import {
  REDLINE_LINE_MAX_CHARS,
  REDLINE_MAX_ROWS,
  REDLINE_TOTAL_MAX_CHARS,
} from "./traits.js";

/**
 * 红线与两段载荷的共用口径（v13 阶段 4 之后只留这些）。
 *
 * 卡的正文渲染已整体迁到 card-v13.ts：这里不再有 11 块顺序、整卡/身份段/末尾锚的
 * 预算与丢块序，也没有 v12 的 renderPersonaCard/buildCardSegments。保留的是
 * v13 仍在用的两样东西：
 *  - 红线截断（clampRedlines）与去重（mergeDuplicateRedlines）：写侧（worker）
 *    与渲染侧都靠它保证红线逐字、按「更早声明优先」保留；
 *  - CardSegment 形状：身份段/末尾锚的 text/chars/hash/warnings 四元组。
 */

export interface CardRedline {
  text: string;
  active?: boolean;
  createdAt?: string;
}

/**
 * 一段载荷（P1-2）。三口径互相自洽：
 *  - `chars` = `text.length`（UTF-16 码元，与整卡 `chars` 同口径）；
 *  - `hash` = sha256(`text`)（UTF-8；**不**加 CARD_READER_NOTE 前缀，也不带卡尾注释）；
 *  - 空段一律 `text=""`、`chars=0`、`hash=""`，原因写进 `warnings`（不塞占位标题）。
 * 整卡 hash 仍是既有口径 sha256(READER_NOTE + 整卡正文)，两段 hash 不替代它。
 */
export interface CardSegment {
  text: string;
  chars: number;
  hash: string;
  warnings: string[];
}

/** 红线相似合并阈值（spec §5 超限处理①）。 */
export const REDLINE_MERGE_SIM = 0.85;

/** 比较用的归一文本：去掉空白与标点符号（全角/半角都算），只留字。 */
export function normalizeRedlineForCompare(text: string): string {
  return String(text ?? "").replace(/[\s\p{P}\p{S}]/gu, "");
}

function redlineBigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 相似度：相等/互为连续子串 → 1；否则字符二元组 Dice 系数。 */
export function redlineSimilarity(a: string, b: string): number {
  const x = normalizeRedlineForCompare(a);
  const y = normalizeRedlineForCompare(b);
  if (!x || !y) return 0;
  if (x === y || x.includes(y) || y.includes(x)) return 1;
  const A = redlineBigrams(x);
  const B = redlineBigrams(y);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return (2 * hit) / (A.size + B.size);
}

export interface RedlineMergeOutcome {
  /** 合并后的生效行（正文逐字保留，只去掉被并掉的重复行）。 */
  rows: CardRedline[];
  /** 每一条并掉的来源（写账本用；不进卡、不改正文）。 */
  merged: Array<{ kept: string; dropped: string; sim: number }>;
}

/**
 * 红线去重（spec §5 超限处理①）：与已有行去标点空白后相等、二元组相似 ≥0.85、
 * 或一条是另一条的连续子串 → 并入更早的那条（保留更早的 createdAt），不新增行。
 *
 * 合并只丟「重复的那一行」，不动留用行正文：判据 2 要求红线逐字覆盖 100%，
 * 往正文里追加「来源」标记会让它不再逐字；来源改记账本（可审计、可回放）。
 */
export function mergeDuplicateRedlines(redlines: CardRedline[], simThreshold = REDLINE_MERGE_SIM): RedlineMergeOutcome {
  const rows: CardRedline[] = [];
  const merged: Array<{ kept: string; dropped: string; sim: number }> = [];
  for (const raw of redlines) {
    const text = cls(raw.text).trim();
    if (!text || raw.active === false) continue;
    const hit = rows.find((r) => redlineSimilarity(r.text, text) >= simThreshold);
    if (!hit) {
      rows.push({ text, active: true, createdAt: raw.createdAt ?? "" });
      continue;
    }
    const hitAt = Date.parse(hit.createdAt || "");
    const rawAt = Date.parse(raw.createdAt || "");
    if (Number.isFinite(rawAt) && (!Number.isFinite(hitAt) || rawAt < hitAt)) hit.createdAt = raw.createdAt ?? "";
    merged.push({ kept: hit.text, dropped: text, sim: redlineSimilarity(hit.text, text) });
  }
  return { rows, merged };
}

/**
 * 红线截断：单行 ≤120、≤30 行、总字符 ≤2600。
 * 超限时保留「更早声明」的条目（列表头部优先），新增行一律拒收并记 warning：
 * 红线是用户最早立的边界，越新追加的越该先让步；此前按尾部保留截断，等于先丢用户最早的设定。
 * 输出仍按原顺序；每次截断都记 warning（不静默）。
 */
export function clampRedlines(redlines: CardRedline[], warnings: string[] = []): string[] {
  const active = redlines
    .map((r, i) => ({ text: cls(r.text).trim(), i, active: r.active !== false, createdAt: r.createdAt ?? "" }))
    .filter((r) => r.active && r.text.length > 0);
  let kept = [...active];
  if (kept.length > REDLINE_MAX_ROWS) {
    const rejected = kept.length - REDLINE_MAX_ROWS;
    kept = kept.slice(0, REDLINE_MAX_ROWS);
    warnings.push(`红线超过 ${REDLINE_MAX_ROWS} 行，保留更早的声明、拒收最新 ${rejected} 行`);
  }
  let total = kept.reduce((s, r) => s + r.text.length, 0);
  while (total > REDLINE_TOTAL_MAX_CHARS && kept.length > 1) {
    const dropped = kept.pop()!;
    total -= dropped.text.length;
    warnings.push(`红线总字符超过 ${REDLINE_TOTAL_MAX_CHARS}，拒收最新一条的渲染`);
  }
  const out: string[] = [];
  for (const r of kept) {
    if (r.text.length > REDLINE_LINE_MAX_CHARS) {
      warnings.push(`红线单行超过 ${REDLINE_LINE_MAX_CHARS} 字，已截断渲染`);
      out.push(r.text.slice(0, REDLINE_LINE_MAX_CHARS));
    } else {
      out.push(r.text);
    }
  }
  return out;
}

function cls(v: string | undefined | null): string {
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n") : "";
}
