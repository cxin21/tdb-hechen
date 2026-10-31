import type { LoggerLike } from './types.js';

/**
 * Session head pack: a stable system-prompt section, fetched once and frozen.
 *
 * The section text is read synchronously on every prompt assembly, so the
 * getter never awaits the network. Freshness is handled out of band: the first
 * read after `refreshMs` kicks a background refresh, and an explicit
 * `invalidate()` (compaction) forces the next read to refetch.
 *
 * ## Why the pack is structured, not just truncated
 *
 * The L3 persona (`/v3/core/read` → `data.content`) is ~10k chars on a real
 * profile measured on 2026-10-31 (identity ids omitted on purpose):
 *
 * - 0–3766  `# User Narrative Profile` — Archetype / 基本信息 / 长期偏好 / 红红线 /
 *   Chapter 1–4. Narrative: every sentence carries durable user context.
 * - 3766–10003  `## 🗺️ Scene Navigation (Scene Index)` — 14 sections shaped like
 *   `### Path: scene_blocks/xxx.md` + `**热度**: N | **更新**: ISO` + `Summary: …`.
 *   The Summary bodies are ~70% of these 6.2k chars, but the *path* is the only
 *   actionable part: it is what the model needs in order to know which L2 scene
 *   it may `read`. Bare truncation keeps the narrative and cuts the index
 *   mid-sentence, so **all 14 paths disappear** — the model cannot see that any
 *   L2 scene exists.
 *
 * So the pack is compressed structurally before any clamp:
 *
 * - narrative is kept **verbatim** (no paraphrasing — hallucination risk);
 * - the Scene Index keeps its header and collapses to one line per scene:
 *   `- <path>（热度 N，更新 YYYY-MM-DD）` (Summary bodies dropped);
 * - when the text does not match that structure (shape changed upstream, or a
 *   previous layer already truncated it), we **fail open**: keep the text as
 *   fetched and fall back to the old bare clamp. Never throw, never emit half a
 *   markdown block.
 *
 * Measured on the persona above: 10003 chars → **4565** chars with all 14 paths
 * intact. Budget: the L2 scenario section appended by `composeHeadPack` is
 * budgeted before the persona, so keep `headPack.maxChars` (default 8000,
 * config.ts) comfortably above narrative 3766 + 14 index lines ≈ 4565; a 4000
 * cap cannot hold both (the index tail would be clamped, not the narrative).
 */

/** Scene-index heading (English as produced today, Chinese kept as a tolerance). */
const SCENE_INDEX_HEADING = /^#{1,6}\s.*(?:Scene Navigation|Scene Index|场景索引|场景导航).*$/m;
/** One scene per heading line; the captured group is the L2 path. */
const SCENE_PATH_LINE = /^###\s+Path:\s*(\S[^\n]*?)\s*$/gm;
const SCENE_HEAT = /\*\*热度\*\*:\s*(\d+)/;
const SCENE_UPDATED = /\*\*更新\*\*:\s*(\d{4}-\d{2}-\d{2})/;
/** Marker written by this class (or an earlier layer) — the text is already cut. */
const TRUNCATION_MARKER = /\[agemem head pack truncated at \d+ chars\]/;
/** One line of an ALREADY compressed index: `- <path>（热度 N，更新 YYYY-MM-DD）`. */
const COMPRESSED_SCENE_LINE = /^-\s+\S+（热度 \d+，更新 \d{4}-\d{2}-\d{2}）$/m;

export interface HeadPackScene {
  path: string;
  heat: number;
  updated: string;
}

export interface StructuredHeadPack {
  /** Narrative part, verbatim (trailing blank lines trimmed). */
  narrative: string;
  /** Scene-index heading line, verbatim. */
  heading: string;
  scenes: HeadPackScene[];
  /** Compressed text: narrative + heading + one line per scene. */
  text: string;
}

/**
 * Compress a raw head pack into "narrative verbatim + one line per scene".
 * Returns `undefined` when the text does not match the known structure — the
 * caller then falls back to the bare clamp (fail open).
 */
export function structureHeadPack(text: string): StructuredHeadPack | undefined {
  if (text === '' || TRUNCATION_MARKER.test(text)) return undefined;
  const heading = SCENE_INDEX_HEADING.exec(text);
  if (!heading) return undefined;

  const narrative = text.slice(0, heading.index).trimEnd();
  const body = text.slice(heading.index);
  const paths = [...body.matchAll(SCENE_PATH_LINE)];
  if (paths.length === 0) return undefined;

  const scenes: HeadPackScene[] = [];
  for (let i = 0; i < paths.length; i += 1) {
    const match = paths[i];
    const start = (match.index ?? 0) + match[0].length;
    const next = paths[i + 1]?.index;
    const block = body.slice(start, next ?? body.length);
    const heat = SCENE_HEAT.exec(block);
    const updated = SCENE_UPDATED.exec(block);
    // One unparseable section means the shape changed: do not publish a partial index.
    if (!heat || !updated) return undefined;
    scenes.push({ path: match[1] as string, heat: Number(heat[1]), updated: updated[1] as string });
  }

  const headingLine = heading[0].trim();
  const lines = scenes.map((scene) => `- ${scene.path}（热度 ${scene.heat}，更新 ${scene.updated}）`);
  const parts = [narrative, headingLine + '\n' + lines.join('\n')].filter((part) => part !== '');
  return { narrative, heading: headingLine, scenes, text: parts.join('\n\n') };
}

/**
 * Structuring entry point used by the class (and by callers that would rather
 * compress before their own budget maths). Idempotent: an already-compressed
 * pack has no `### Path:` lines and comes back unchanged.
 */
export function compressHeadPack(text: string): string {
  return structureHeadPack(text)?.text ?? text;
}

/**
 * True when `text` is already the compressed shape this module produces: the
 * scene-index heading plus at least one `- <path>（热度 N，更新 YYYY-MM-DD）`
 * line and no `### Path:` bodies.
 *
 * Production always feeds HeadPack exactly this shape (`index.ts` compresses
 * before its budget maths, see fetchHeadPack), so a second structure pass is
 * guaranteed to fail there — that is idempotence, not a parse error. The
 * diagnostic below has to tell the two apart: the unconditional version fired
 * on every mount of the live e2e profile and read as a real bug.
 */
export function isCompressedHeadPack(text: string): boolean {
  if (text === '') return false;
  if (!SCENE_INDEX_HEADING.test(text)) return false;
  return COMPRESSED_SCENE_LINE.test(text);
}

export interface HeadPackDeps {
  fetchHeadPack: () => Promise<string | undefined>;
  maxChars: number;
  refreshMs: number;
  fallbackText: string;
  log?: LoggerLike;
  now?: () => number;
}

export class HeadPack {
  private text = '';
  /** Structured (+ clamped) rendering of `text`; recomputed on every refresh. */
  private rendered = '';
  private fetchedAt = 0;
  private refreshing: Promise<void> | undefined;
  /** One diagnostic per mount: a structurally unparseable pack is reported once. */
  private warnedUnstructured = false;
  private readonly now: () => number;

  constructor(private readonly deps: HeadPackDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Compress structurally, then clamp what is still too long. */
  private render(text: string): string {
    const structured = structureHeadPack(text);
    // Warn only on a GENUINE parse failure, and only once per mount:
    //  * an already-compressed pack is the production path (idempotence),
    //  * a text carrying our truncation marker was cut by an earlier layer.
    // Neither means the upstream shape changed. The old unconditional debug line
    // fired on every mount and cost a full investigation during the live e2e.
    if (
      !structured
      && text !== ''
      && !TRUNCATION_MARKER.test(text)
      && !isCompressedHeadPack(text)
      && !this.warnedUnstructured
    ) {
      this.warnedUnstructured = true;
      const firstLine = text
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '') ?? '';
      this.deps.log?.warn?.(
        'agemem: head pack has no parseable scene index; falling back to bare truncation',
        {
          rawChars: text.length,
          firstLine: firstLine.slice(0, 60),
          hasHeading: SCENE_INDEX_HEADING.test(text),
        },
      );
    }
    return this.clamp(structured?.text ?? text);
  }

  private clamp(text: string): string {
    const limit = Math.max(0, this.deps.maxChars);
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n[agemem head pack truncated at ${limit} chars]`;
  }

  /** Text to inject right now. Never throws, never awaits. */
  current(): string {
    this.ensureFresh();
    if (this.text.trim() !== '') return this.rendered !== '' ? this.rendered : this.clamp(this.text);
    return this.deps.fallbackText.trim();
  }

  /** Current cached text without side effects (used by tests/diagnostics). */
  peek(): string {
    return this.text;
  }

  shouldRefresh(): boolean {
    if (this.text === '') return true;
    return this.now() - this.fetchedAt >= Math.max(1000, this.deps.refreshMs);
  }

  ensureFresh(): void {
    if (!this.shouldRefresh()) return;
    void this.refresh();
  }

  /** Fetch once; concurrent callers share one in-flight request. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const fetched = await this.deps.fetchHeadPack();
        if (typeof fetched === 'string' && fetched.trim() !== '') {
          this.text = fetched;
          this.rendered = this.render(fetched);
          this.fetchedAt = this.now();
        }
      } catch (error) {
        this.deps.log?.debug?.('agemem: head pack refresh failed (keeping previous text)', error);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /** Drop the cached pack; the next assembly reads a fresh one. */
  invalidate(): void {
    this.text = '';
    this.rendered = '';
    this.fetchedAt = 0;
  }
}

// ───────────────────────────── L2 scene segment ─────────────────────────────
//
// Why this lives here: `/v3/core/read` (L3 persona) ships its own trailing
// "Scene Navigation" index (`### Path: scene_blocks/xxx.md` + 热度 + Summary).
// Rendering the L2 section from that tail repeats every path AND has no
// summaries; the endpoint POST /v3/scenario/ls returns the authoritative list
// (bare filename + summary + updated_at) in ONE call. So:
//
//   1. the persona tail is STRIPPED (same semantics as MemoryProxy stripSceneNavigation:
//      the section is last, so "from the heading to EOF");
//   2. the L2 section is rendered from the endpoint only, one line per scene:
//        - scene_blocks/<path>（更新 YYYY-MM-DD）— <summary ≤120>
//      `scene_blocks/` is NOT optional: scripts/verify-installed.mjs:113 anchors
//      the literal `- scene_blocks` marker, and the endpoint returns bare names;
//   3. a failure NEVER renders as "there are no scenes": the caller gets a
//      status label (`l2=fail:http_404` / `l2=ok(14,2213)` / `l2=empty`) so an
//      operator can tell "core down" from "index empty".
//
// Heat is intentionally dropped (decision A, parity with MemoryProxy): reading
// .metadata/scene_index.json for it would be a second source of truth.

/** Header line of the rendered L2 section. */
export const L2_SECTION_HEADER = '## 长期记忆 · 场景索引（L2）';
/** Prefix every rendered L2 line starts with (endpoint returns bare filenames). */
export const L2_SCENE_PREFIX = 'scene_blocks/';
/** Total budget for the section, header and newlines included. */
export const L2_MAX_CHARS = 3000;
/** Per-line summary cap; a longer summary is cut to …120 chars. */
export const L2_MAX_SUMMARY_CHARS = 120;

export interface L2SceneEntry {
  /** Endpoint `path`: a BARE filename (no `scene_blocks/`). */
  path: string;
  summary?: string;
  /** Endpoint `updated_at` (ISO 8601, index value or file mtime). */
  updated?: string;
}

/** Endpoint outcome: either entries, or a reason an operator can act on. */
export type L2FetchOutcome =
  | { ok: true; entries: L2SceneEntry[] }
  | { ok: false; reason: string };

export interface L2Section {
  /** Rendered section ('' when nothing is kept). */
  text: string;
  /** Lines kept, in render order. */
  kept: L2SceneEntry[];
  /** Lines dropped by the budget (never half a line). */
  dropped: number;
  chars: number;
}

/**
 * Drop the trailing Scene Index section from a persona. The section is always
 * last, so this is "from the heading to EOF"; when no heading is present the
 * text is returned unchanged (fail open — a shape change must not lose the
 * narrative). Trailing blank lines never survive.
 */
export function stripSceneNavigation(text: string): string {
  if (typeof text !== 'string' || text === '') return '';
  const heading = SCENE_INDEX_HEADING.exec(text);
  const kept = heading ? text.slice(0, heading.index) : text;
  return kept.replace(/\s+$/, "");
}

/** scene_blocks/<bare> — never prefixed twice. */
export function formatL2Path(path: string): string {
  const trimmed = typeof path === 'string' ? path.trim().replace(/^\/+/, '') : '';
  if (trimmed === '') return '';
  return trimmed.startsWith(L2_SCENE_PREFIX) ? trimmed : L2_SCENE_PREFIX + trimmed;
}

/** YYYY-MM-DD of an ISO timestamp; '' when absent or unparseable. */
export function l2Day(updated: string | undefined): string {
  if (typeof updated !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(updated.trim());
  return match?.[1] ?? '';
}

/** One markdown line: path, update day, flattened summary (≤120 chars). */
export function formatL2Line(entry: L2SceneEntry): string {
  const path = formatL2Path(entry?.path ?? '');
  if (path === '') return '';
  const day = l2Day(entry.updated);
  const summary = (entry.summary ?? '').replace(/\s+/g, ' ').trim();
  const capped =
    summary === ''
      ? ""
      : summary.length <= L2_MAX_SUMMARY_CHARS
        ? summary
        : summary.slice(0, L2_MAX_SUMMARY_CHARS - 1) + '…';
  const head = day === '' ? '- ' + path : '- ' + path + '（更新 ' + day + '）';
  // Dated: `（更新 D）— summary` (no space — the full-width paren closes it).
  // Undated: `- path — summary` (needs the space to stay readable).
  if (capped === '') return head;
  return day === '' ? head + ' — ' + capped : head + '— ' + capped;
}
/**
 * Render the L2 section under a total budget.
 *
 * Order: update day DESC (newest first), undated lines last, path as the tie
 * break — so a budget cut always loses the stalest scene. Dropping is per line:
 * a line that does not fit is skipped whole, never sliced.
 */
export function renderL2Section(
  entries: L2SceneEntry[] | undefined,
  options: { budget?: number; header?: string } = {},
): L2Section {
  const budget = Math.max(0, Math.floor(options.budget ?? L2_MAX_CHARS));
  const header = options.header ?? L2_SECTION_HEADER;
  const list = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({ entry, line: entry === undefined ? "" : formatL2Line(entry) }))
    .filter((item) => item.line !== '');
  list.sort((a, b) => {
    const dayA = l2Day(a.entry.updated);
    const dayB = l2Day(b.entry.updated);
    if (dayA !== dayB) {
      if (dayA === '') return 1;
      if (dayB === '') return -1;
      return dayA < dayB ? 1 : -1;
    }
    return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0;
  });

  const kept: L2SceneEntry[] = [];
  const lines: string[] = [];
  let chars = header.length;
  if (chars > budget) return { text: "", kept, dropped: list.length, chars: 0 };
  for (const item of list) {
    const next = chars + 1 + item.line.length;
    if (next > budget) continue;
    lines.push(item.line);
    kept.push(item.entry);
    chars = next;
  }
  const text = lines.length === 0 ? '' : header + String.fromCharCode(10) + lines.join(String.fromCharCode(10));
  return { text, kept, dropped: list.length - kept.length, chars: text === '' ? 0 : text.length };
}

/** l2=ok(14,2213) / l2=empty / l2=truncated(0,14) / l2=fail:http_404. */
export function l2StatusLabel(outcome: L2FetchOutcome | undefined, section: L2Section): string {
  if (outcome === undefined) return 'l2=fail:no_data';
  if (!outcome.ok) return 'l2=fail:' + normalizeL2Reason(outcome.reason);
  if (outcome.entries.length === 0) return 'l2=empty';
  if (section.kept.length === 0) return 'l2=truncated(0,' + section.dropped + ')';
  return 'l2=ok(' + section.kept.length + ',' + section.chars + ')' + (section.dropped > 0 ? ' dropped=' + section.dropped : '');
}

function normalizeL2Reason(reason: string): string {
  const flat = (typeof reason === 'string' ? reason : String(reason ?? '')).trim().toLowerCase();
  if (flat === '') return 'unknown';
  return flat.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

/**
 * Turn a thrown error into a diagnosable reason. Status numbers are the
 * operator's first split (404 = endpoint disabled, 5xx = core down), then a
 * timeout, then "the payload was not what we expect".
 */
export function classifyL2Failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const status = /\b(4\d\d|5\d\d)\b/.exec(message);
  if (status) return 'http_' + status[1];
  if (/timeout|timed out|aborted|ETIMEDOUT|AbortError/i.test(message)) return 'timeout';
  if (/json|parse|payload|shape|unexpected/i.test(message)) return 'bad_payload';
  return 'error';
}

/**
 * Defensive parse of the endpoint payload ({ data: { entries: [...] } }).
 * Entries without a usable path are dropped; a non-array payload is a FAILURE,
 * not an empty index — that difference is the whole point of the status label.
 */
export function parseL2Outcome(payload: unknown): L2FetchOutcome {
  const data = (payload as { data?: unknown } | undefined)?.data ?? payload;
  const raw = (data as { entries?: unknown } | undefined)?.entries;
  if (!Array.isArray(raw)) return { ok: false, reason: 'bad_payload' };
  const entries: L2SceneEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as { path?: unknown; summary?: unknown; updated_at?: unknown; updated?: unknown };
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    if (path === '') continue;
    const summary = typeof record.summary === 'string' ? record.summary : '';
    const updated =
      typeof record.updated_at === 'string'
        ? record.updated_at
        : typeof record.updated === 'string'
          ? record.updated
          : '';
    entries.push({ path, summary, updated });
  }
  return { ok: true, entries };
}
