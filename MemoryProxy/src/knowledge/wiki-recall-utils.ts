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
    lines.push(...renderLegacyEntryLines(e, i));
  });
  lines.push("</tdai_recalled_wiki>");
  return lines.join("\n");
}

/** legacy（Task 6 前）单条渲染：`i. [wiki:x] [type] score=N [图展开] — title` + path/snippet 行。格式锁定 §3.3，勿动。 */
function renderLegacyEntryLines(e: WikiRecallRenderEntry, index: number): string[] {
  const hopTag = e.hop > 0 ? " [图展开]" : "";
  const lines = [`${index + 1}. [wiki:${e.wikiName}] [${e.type}] score=${e.normScore.toFixed(2)}${hopTag} — ${e.title}`];
  if (e.path) lines.push(`   path: ${e.path}`);
  if (e.snippet) lines.push(`   ${e.snippet}`);
  return lines;
}

// ── Task 6（P1 recall-quality）：wiki JIT 瘦身注入 ───────────────────────────
// spec §5：单条 = 标题 + 一行摘要(≤80 chars) + [详情: tool wiki_fetch]，单条
// ≤100、整块 ≤500；例外：候选原文本身就短（≤160 chars）直接注全文（沿用 legacy
// 全格式）；摘要行来源 = WikiSearchHit.snippet（KS 侧已剥 frontmatter，这里兜底
// 再剥一次）。软指引单轮取文 ≤3 次；miss 语义半句（tools.ts 契约：HTTP 200 +
// code 0 + data.isError=true + 可读 error）防止 agent 把 miss 误读成故障。

const JIT_HINT = "[详情: tool wiki_fetch]";
const JIT_ENTRY_MAX_CHARS = 100;
const JIT_BLOCK_MAX_CHARS = 500;
const JIT_SUMMARY_MAX_CHARS = 80;
const JIT_EXCEPTION_FULL_SNIPPET_CHARS = 160;

/** 剥离首部 YAML frontmatter（`---` 围栏块）。非首部或未闭合的原样返回。 */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n").replace(/^\s+/, "");
    }
  }
  return text;
}

/** JIT 摘要行：剥 frontmatter → 折叠为单行 → 码点截断。空输入返回 ""。 */
export function buildJitSummary(snippet: string, maxChars: number): string {
  const oneLine = stripFrontmatter(snippet ?? "").replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return truncateByCodePoint(oneLine, maxChars);
}

function countCps(s: string): number {
  return Array.from(s).length;
}

/** JIT 单条行：`i. [wiki:NAME] title：summary [详情: tool wiki_fetch]`，硬上限 100 码点。 */
function renderJitEntryLine(e: WikiRecallRenderEntry, index: number): string {
  const prefix = `${index + 1}. [wiki:${e.wikiName}] `;
  const hint = ` ${JIT_HINT}`;
  const title = (e.title ?? "").trim();
  const fixed = countCps(prefix) + countCps(hint) + 1; // +1 = "：" 分隔符
  const remaining = JIT_ENTRY_MAX_CHARS - fixed;
  if (remaining <= 0) {
    // 退化：前缀+提示本身就超预算 → 整行硬截断（保 hint 不可达，接受截断尾巴）
    return truncateByCodePoint(
      `${prefix}${title}：${buildJitSummary(e.snippet, JIT_SUMMARY_MAX_CHARS)}${hint}`,
      JIT_ENTRY_MAX_CHARS,
    );
  }
  if (countCps(title) > remaining) {
    // 标题太长：截标题、摘要让位（标题是 wiki_fetch 按 title 取文的主键，尽量保）
    return `${prefix}${truncateByCodePoint(title, remaining)}${hint}`;
  }
  const summaryBudget = Math.min(JIT_SUMMARY_MAX_CHARS, remaining - countCps(title) - 1);
  const summary = summaryBudget > 0 ? buildJitSummary(e.snippet, summaryBudget) : "";
  return summary ? `${prefix}${title}：${summary}${hint}` : `${prefix}${title}${hint}`;
}

/**
 * JIT 瘦身渲染（Task 6，spec §5 目标形态）：header（来源说明 + 一次性的取文指引，
 * 含 doc_path|title、section、≤4000/[truncated]、miss isError=true、单轮 ≤3 次）
 * + 每条 JIT 存根行（例外 ≤160 原文走 legacy 全格式）+ footer，整块 ≤500 码点
 * （装不下的尾部条目裁掉，header/footer 必保）。空列表返回 null。
 */
export function renderWikiRecallBlockJit(entries: WikiRecallRenderEntry[]): string | null {
  if (!entries || entries.length === 0) return null;
  const header: string[] = [
    "<tdai_recalled_wiki>",
    "以下是当前轮用户问题自动召回的团队 wiki 索引（JIT 精简模式，按相关度排序）；每条前的 [wiki:xxx] 标注其来源知识库，多 wiki 命中时据此区分来源。",
    '要看某条完整正文：用 <knowledge_tools> 里的 tools/call 调 wiki 工具 wiki_fetch（入参 doc_path=该条来源页 path，或 title=页面标题；section 可选缩小范围；单次 ≤4000 字符，超长附 [truncated] 标记；未命中返回 isError=true 附原因，可换参重试；单轮取文建议 ≤3 次）。',
    "",
  ];
  const footer = "</tdai_recalled_wiki>";

  const groups: string[][] = entries.map((e, i) => {
    const snippetCps = e.snippet ? countCps(e.snippet) : 0;
    // 例外：原文本身 ≤160 chars → 直接注全文（legacy 全格式），不强制 JIT 存根
    if (snippetCps > 0 && snippetCps <= JIT_EXCEPTION_FULL_SNIPPET_CHARS) {
      return renderLegacyEntryLines(e, i);
    }
    return [renderJitEntryLine(e, i)];
  });

  const footerCps = countCps(footer);
  const totalCps = (gs: string[][]): number => {
    const body = gs.flat();
    const headerCps = header.reduce((acc, l) => acc + countCps(l), 0) + footerCps + body.reduce((acc, l) => acc + countCps(l), 0);
    const seps = header.length + body.length; // join("\n") 的分隔符数（header 4 行 + body n 行 + footer 1 行 → n+4 个）
    return headerCps + seps;
  };

  let kept = groups;
  while (kept.length > 0 && totalCps(kept) > JIT_BLOCK_MAX_CHARS) {
    kept = kept.slice(0, -1);
  }
  const lines = [...header, ...kept.flat(), footer];
  return lines.join("\n");
}
