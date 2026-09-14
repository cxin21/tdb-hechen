import type { WikiSearchHit } from "./wiki-retrieve-client.js";

const TRUNCATION_SUFFIX = "…";
const TRUNCATION_SUFFIX_LEN = Array.from(TRUNCATION_SUFFIX).length;

export type NormalizedHit = WikiSearchHit & { normScore: number };

export function normalizeScores<T extends WikiSearchHit>(hits: T[]): Array<T & { normScore: number }> {
  if (hits.length === 0) return [];
  const scores = hits.map((h) => h.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return hits.map((h) => ({ ...h, normScore: 1 }));
  return hits.map((h) => ({
    ...h,
    normScore: parseFloat(((h.score - min) / (max - min)).toFixed(3)),
  }));
}

/**
 * Truncate a string by code points (surrogate-pair safe).
 * Reserves the width of the truncation suffix so the result never exceeds `max`
 * code points. Mirrors the memory `truncateRecallLine` (auto-recall.ts) logic.
 */
function truncateByCodePoint(s: string, max: number): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  // Not enough room for the suffix itself → bare slice, no suffix appended.
  if (max <= TRUNCATION_SUFFIX_LEN) {
    return cps.slice(0, max).join("").trimEnd();
  }
  return `${cps
    .slice(0, max - TRUNCATION_SUFFIX_LEN)
    .join("")
    .trimEnd()}${TRUNCATION_SUFFIX}`;
}

/**
 * Keep the top recall lines within a total character budget.
 *
 * @param lines         candidate lines, in priority order
 * @param maxTotalChars total budget in code points (line bodies + 1-char
 *                      separators between them). `<= 0` disables truncation.
 * @param maxHits       maximum number of lines to keep. `<= 0` means unlimited
 *                      (matches the brief's semantics).
 */
export function applyRecallBudget(
  lines: string[],
  maxTotalChars: number,
  maxHits: number,
): string[] {
  const capped = maxHits <= 0 ? lines : lines.slice(0, maxHits);
  if (maxTotalChars <= 0) return capped;
  const out: string[] = [];
  let used = 0;
  for (const line of capped) {
    const sep = out.length > 0 ? 1 : 0;
    const budget = maxTotalChars - used - sep;
    if (budget <= 0) break;
    const truncated = truncateByCodePoint(line, budget);
    // Empty input line (or one that truncated to nothing): skip it and keep
    // going — it must not swallow the remaining lines.
    if (Array.from(truncated).length === 0) continue;
    out.push(truncated);
    used += sep + Array.from(truncated).length;
  }
  return out;
}

/** A single rendered entry for the <tdai_recalled_wiki> block. */
export interface WikiRecallRenderEntry {
  wikiName: string;
  type: string;
  title: string;
  score: number;
  normScore: number;
  snippet: string;
  path: string;
  hop: number;
}

/**
 * Render the <tdai_recalled_wiki> block from a list of recall entries.
 * Returns `null` for an empty/absent list. Each entry is rendered as
 * `i. [wiki:wikiName] [type] score=normScore [图展开] — title` plus indented
 * `path`/`snippet` lines; entries reached in more than one hop are labelled
 * `[图展开]`. Format locked to main spec §3.3.
 */
export function renderWikiRecallBlock(entries: WikiRecallRenderEntry[]): string | null {
  if (!entries || entries.length === 0) return null;
  const lines: string[] = [
    "<tdai_recalled_wiki>",
    "以下是当前轮用户问题自动召回的团队 wiki 片段（按相关度排序）；每条前的 [wiki:xxx] 标注其来源知识库（如 Coding-WiKi / Standards-WiKi / AgentSkill-WiKi），多 wiki 命中时据此区分来源。",
    "仅辅助回答当前这一轮；若需完整正文，请用 <knowledge_tools> 里的 tools/call wiki read_page（path 见下）。",
    "",
  ];
  entries.forEach((e, i) => {
    const hopTag = e.hop > 0 ? " [图展开]" : "";
    lines.push(`${i + 1}. [wiki:${e.wikiName}] [${e.type}] score=${e.normScore.toFixed(2)}${hopTag} — ${e.title}`);
    if (e.path) lines.push(`   path: ${e.path}`);
    if (e.snippet) lines.push(`   ${e.snippet}`);
  });
  lines.push("</tdai_recalled_wiki>");
  return lines.join("\n");
}