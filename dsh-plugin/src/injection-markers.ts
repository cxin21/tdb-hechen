/**
 * Injection fingerprints shared by the plugin AND MemoryCore.
 *
 * Why a standalone constant file: the plugin decides "is this persisted message
 * one of our own injected blocks?" (writeback) and the core decides the same
 * question on the way in (MemoryCore/src/gateway/injection-guard.ts). Before
 * this file the two lists drifted: the plugin knew 6 markers, the core knew a
 * different subset, so a block one side recognised the other wrote into L0 and
 * the memory store learned its own prompt as user speech.
 *
 * Rule for both sides: import these literals, never re-type them.
 *
 * TEXT matching rule (task-91: aligned with core, no longer "only line one"):
 *   normalize (CRLF/CR -> LF, per-line trimStart of invisible fill) then
 *   LINE-PREFIX match; a hit counts only when the matching line is among the
 *   first LEADING_NON_EMPTY_LINE_LIMIT non-empty lines, or when the matched
 *   segment holds >= MIN_MATCHED_SEGMENT_RATIO of the non-whitespace chars.
 *   A user who quotes one of these strings mid-sentence or mid-body must still
 *   be written back (task-79) — that is what the two thresholds protect.
 *
 * Why this file owns the rule instead of writeback.ts: core
 * (MemoryCore/src/gateway/injection-guard.ts:99-188) and plugin must answer the
 * same question identically, or a block one side recognises gets written into
 * L0 by the other (self-poisoning). Same literals, same thresholds, one place.
 */
export const INJECTION_TEXT_MARKERS = [
  '【agemem 记忆提示】',
  '<soul-identity>',
  '<soul-feeling>',
  '<relevant-memories>',
  '<team-wiki>',
  '<available_skills>',
  '<core_memory>',
  '【币值判定规则',
  '【建议类问题口径',
] as const;

/** Declared source kind of every message this plugin appends to a turn. */
export const INJECTED_KIND = 'plugin:tdb-agemem-dsh';

/** Every injected message id this plugin emits starts with this prefix. */
export const AGEMEM_MESSAGE_ID_PREFIX = 'agemem-';

/** Marker list as a mutable view (callers never mutate it; tests compare it). */
export function injectionTextMarkers(): readonly string[] {
  return INJECTION_TEXT_MARKERS;
}

// ── detection rule (mirror of MemoryCore/src/gateway/injection-guard.ts) ─────
//
// Every constant and predicate below is deliberately a LINE-FOR-LINE copy of
// the core guard. Do not "improve" one side alone: the two must agree on the
// same payload, which dsh-plugin/test/injection-markers.test.ts asserts by
// importing the core module and comparing verdicts.

/** Hit line must fall within the first N non-empty lines (injected blocks open). */
export const LEADING_NON_EMPTY_LINE_LIMIT = 3;

/** Fallback path: matched segment must cover this share of non-whitespace chars. */
export const MIN_MATCHED_SEGMENT_RATIO = 0.3;

/**
 * Leading "invisible fill": whitespace + zero-width/Cf class.
 *
 * Cf characters (U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+200E LRM, U+200F RLM,
 * U+2060 WORD JOINER) are NOT part of ECMAScript s, so a single ZWSP before a
 * marker used to defeat startsWith. U+FEFF BOM happens to be covered by s but
 * is listed explicitly so the behaviour does not depend on engine details.
 * Same regex as MemoryCore/src/gateway/injection-guard.ts:123.
 */
export const LEADING_INVISIBLE_CHARS_RE = /^[\s\u00a0\u3000\u200b-\u200f\u2060\ufeff]+/u;

/**
 * Uniform newlines + strip leading invisible fill per line (blank lines keep
 * their position — "which non-empty line" depends on them).
 * Mirror of MemoryCore/src/gateway/injection-guard.ts:131-136.
 *
 * Deliberate non-goal (final call by Lead, 2026-11-01): fill is stripped only at
 * line start, never inside a marker. `<soul\u200b-identity>` is not recognised:
 * such text is no longer our block, and accepting it would mean treating a user
 * who discusses the literal string as injected.
 */
export function normalizeInjectionLines(text: string): string[] {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(LEADING_INVISIBLE_CHARS_RE, ''));
}

/** Non-whitespace char count (indentation must not dilute the ratio). */
function countNonWhitespace(text: string): number {
  return String(text).replace(/\s+/g, '').length;
}

/**
 * Non-whitespace chars of the matched segment: the hit line plus the following
 * non-empty lines up to the first blank line. A whole block, not one line —
 * otherwise a long injected block looks like a passing mention.
 * Mirror of MemoryCore/src/gateway/injection-guard.ts:148-156.
 */
function matchedSegmentLength(lines: readonly string[], startIndex: number): number {
  let total = 0;
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i > startIndex && line.trim().length === 0) break;
    total += countNonWhitespace(line);
  }
  return total;
}

/**
 * True when `text` opens with one of our injected blocks. Returns the marker.
 * Mirror of MemoryCore/src/gateway/injection-guard.ts:170-188 (task-91).
 */
export function detectInjectedBlock(text: string): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const lines = normalizeInjectionLines(text);
  const totalChars = countNonWhitespace(text);
  if (totalChars === 0) return undefined;
  let nonEmptySeen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) continue;
    nonEmptySeen += 1;
    for (const marker of INJECTION_TEXT_MARKERS) {
      if (!line.startsWith(marker)) continue;
      if (nonEmptySeen <= LEADING_NON_EMPTY_LINE_LIMIT) return marker;
      const segment = matchedSegmentLength(lines, i);
      if (segment / totalChars >= MIN_MATCHED_SEGMENT_RATIO) return marker;
    }
  }
  return undefined;
}

/** Boolean view used by the writeback gate. */
export function looksLikeInjectedBlock(text: string): boolean {
  return detectInjectedBlock(text) !== undefined;
}
