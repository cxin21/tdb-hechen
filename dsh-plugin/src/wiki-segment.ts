import type { LoggerLike } from './types.js';
import type { SegmentHealth } from './segment-health.js';
/**
 * Team-wiki recall segment for the volatile injection channel.
 *
 * The core exposes two thin forwarders (task-73):
 *   POST /v3/wiki/list   {team_id, user_id?, limit, offset}
 *   POST /v3/wiki/search {query, team_id, wiki_ids?, top_k?, per_wiki_limit?, min_score?, user_id?}
 * -> data = {query, results[], meta{..., failed[], deadlineHit}} (MemoryCore/src/gateway/wiki-handlers.ts:431-526).
 *
 * Three contract rules this module encodes, all of them load-bearing:
 *
 * 1. ORDER BY absScore, never by score. The engine's score is a per-wiki
 *    normalised value that legitimately reads 0 for a strong hit while
 *    absScore (= score x corpus weight) stays ~1.27; sorting or gating on
 *    score drops exactly the entries the caller wanted.
 *    See MemoryCore/src/gateway/wiki-client.ts:41-43 and mergeHits at
 *    MemoryCore/src/gateway/wiki-handlers.ts:321-331.
 * 2. meta.deadlineHit === true is a PARTIAL SUCCESS, not a failure: some wiki
 *    was skipped by the global deadline, yet results still holds what did
 *    answer. Dropping the block there throws away real recall
 *    (wiki-handlers.ts:480-504).
 * 3. Every failure is fail-open: an empty string plus a structured diagnostic,
 *    never a throw, never a partial block. A memory outage must not break the
 *    host turn (same discipline as memory-client.ts).
 *
 * Transport is injected (`call` = MemoryClient's public `v3()` seam, the same
 * pattern src/skill-client.ts uses), so identity headers, timeout and envelope
 * unwrapping stay in one place and this module is unit-testable without a core.
 */

/** Opening tag of the injected block (kept stable: the prompt shape is a contract). */
export const WIKI_SEGMENT_OPEN = '<team-wiki>';
/** Closing tag of the injected block. */
export const WIKI_SEGMENT_CLOSE = '</team-wiki>';

/** One hit as the core serializes it (MemoryCore/src/gateway/wiki-client.ts:33-45). */
export interface WikiSearchHit {
  wikiId: string;
  wikiName: string;
  path: string;
  title: string;
  snippet?: string | null;
  type?: string | null;
  /** Per-wiki normalised relevance (0..1). Display only: never sort or gate on it. */
  score?: number;
  /** Cross-wiki comparable scale (score x corpus weight). The only ranking key. */
  absScore: number;
  hop?: number | null;
}

/** Result metadata as returned by /v3/wiki/search (wiki-handlers.ts:134-150). */
export interface WikiSearchMeta {
  wikisConsidered?: number;
  wikisQueried?: number;
  wikisFailed?: number;
  failed?: Array<{ wikiId?: string; name?: string; error?: string }>;
  skipped?: Array<{ wikiId?: string; reason?: string }>;
  topK?: number;
  perWikiLimit?: number;
  minScore?: number;
  tookMs?: number;
  deadlineHit?: boolean;
}

export interface WikiSearchData {
  query?: string;
  results?: WikiSearchHit[];
  meta?: WikiSearchMeta;
}

export interface WikiSegmentConfig {
  enabled: boolean;
  /** How many merged hits survive into the block (1..20). */
  topK: number;
  /** Per-wiki fan-out asked from the core (1..20). */
  perWikiLimit: number;
  /** Relevance floor handed to the core (0..10). The client never re-gates. */
  minScore: number;
  /** Hard cap for the whole block in code points; 0 = do not inject. */
  maxChars: number;
  /** Per-call budget for the HTTP round trip. */
  timeoutMs: number;
}

/**
 * Defaults match the ticket: enabled, 3 entries, 4 per wiki, minScore 0.02,
 * 800 chars, 2.5 s. Deliberately NOT in src/config.ts: the segment is wired by
 * dsh-plugin, which passes its resolved volatile.wiki subtree here.
 */
export const DEFAULT_WIKI_SEGMENT_CONFIG: WikiSegmentConfig = {
  enabled: true,
  topK: 3,
  perWikiLimit: 4,
  minScore: 0.02,
  maxChars: 800,
  timeoutMs: 2500,
};

/** Clamp windows. Anything outside silently snaps (a bad config must not break a turn). */
export const WIKI_SEGMENT_LIMITS = {
  topK: { min: 1, max: 20 },
  perWikiLimit: { min: 1, max: 20 },
  minScore: { min: 0, max: 10 },
  maxChars: { min: 0, max: 4000 },
  timeoutMs: { min: 100, max: 30_000 },
} as const;

/** Core's query schema caps the string at 1024 characters (wiki-handlers.ts search schema). */
export const WIKI_QUERY_MAX_CHARS = 1024;

/** One rendered entry may not exceed this many code points before the snippet is cropped. */
export const WIKI_ENTRY_MAX_CHARS = 240;

const HINT_LINE =
  '以下是当前轮自动召回的团队 wiki 片段（按相关度排序）；[wiki:库名/path] 标注来源页，需要正文时再用 wiki 工具按 path 读取。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Tolerant resolution of a volatile.wiki subtree (or nothing at all).
 *
 * Missing / malformed / out-of-range values fall back to the defaults and snap
 * into the clamp windows: the segment is opt-out by an explicit enabled:false
 * only, never by a typo. Mirrors resolveAssetReflectionPolicy
 * (src/asset-reflection.ts:282).
 */
export function resolveWikiSegmentConfig(raw?: unknown): WikiSegmentConfig {
  const src = isRecord(raw) ? raw : {};
  const d = DEFAULT_WIKI_SEGMENT_CONFIG;
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : d.enabled,
    topK: clampInt(src.topK, d.topK, WIKI_SEGMENT_LIMITS.topK.min, WIKI_SEGMENT_LIMITS.topK.max),
    perWikiLimit: clampInt(
      src.perWikiLimit,
      d.perWikiLimit,
      WIKI_SEGMENT_LIMITS.perWikiLimit.min,
      WIKI_SEGMENT_LIMITS.perWikiLimit.max,
    ),
    minScore: clampNumber(src.minScore, d.minScore, WIKI_SEGMENT_LIMITS.minScore.min, WIKI_SEGMENT_LIMITS.minScore.max),
    maxChars: clampInt(src.maxChars, d.maxChars, WIKI_SEGMENT_LIMITS.maxChars.min, WIKI_SEGMENT_LIMITS.maxChars.max),
    timeoutMs: clampInt(
      src.timeoutMs,
      d.timeoutMs,
      WIKI_SEGMENT_LIMITS.timeoutMs.min,
      WIKI_SEGMENT_LIMITS.timeoutMs.max,
    ),
  };
}

/** n code points of text, with an ellipsis when it had to cut. */
function cropCodePoints(text: string, max: number): string {
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  if (max <= 1) return max <= 0 ? '' : '…';
  return cps.slice(0, max - 1).join('') + '…';
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

/**
 * Dedupe + rank the merged hits.
 *
 * Key is wikiId + path (same key the core merges on, wiki-handlers.ts:325): the
 * plugin must not invent a second identity, or a wiki whose name collides with
 * another's path silently eats a hit. Ranking is absScore desc with the core's
 * own tie-breaks (score desc, then path) so a response whose order was
 * disturbed still renders in comparable order. Entries without a finite
 * absScore are dropped: they cannot be ranked on the cross-wiki scale.
 */
export function selectWikiEntries(results: unknown, topK: number): WikiSearchHit[] {
  if (!Array.isArray(results)) return [];
  const limit = clampInt(topK, DEFAULT_WIKI_SEGMENT_CONFIG.topK, 0, WIKI_SEGMENT_LIMITS.topK.max);
  if (limit === 0) return [];
  const byKey = new Map<string, WikiSearchHit>();
  for (const raw of results) {
    if (!isRecord(raw)) continue;
    const absScore = typeof raw.absScore === 'number' ? raw.absScore : Number.NaN;
    if (!Number.isFinite(absScore)) continue;
    const wikiId = typeof raw.wikiId === 'string' ? raw.wikiId : '';
    const path = typeof raw.path === 'string' ? raw.path : '';
    const wikiName = typeof raw.wikiName === 'string' && raw.wikiName !== '' ? raw.wikiName : wikiId;
    const title = typeof raw.title === 'string' ? raw.title : '';
    const hit: WikiSearchHit = {
      wikiId,
      wikiName,
      path,
      title,
      snippet: typeof raw.snippet === 'string' ? raw.snippet : null,
      type: typeof raw.type === 'string' ? raw.type : null,
      score: typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : undefined,
      absScore,
      hop: typeof raw.hop === 'number' && Number.isFinite(raw.hop) ? raw.hop : null,
    };
    const key = wikiId + '\u0000' + path;
    const prev = byKey.get(key);
    if (prev === undefined || hit.absScore > prev.absScore) byKey.set(key, hit);
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        b.absScore - a.absScore ||
        (b.score ?? 0) - (a.score ?? 0) ||
        a.path.localeCompare(b.path) ||
        a.wikiName.localeCompare(b.wikiName),
    )
    .slice(0, limit);
}

/**
 * Render one entry line: - [wiki:name/path] title — snippet
 *
 * The whole line (not just the snippet) is capped at WIKI_ENTRY_MAX_CHARS code
 * points, cropped from the snippet side so the source marker and title — the
 * parts the model needs to fetch the page — always survive.
 */
export function renderWikiEntry(hit: WikiSearchHit, maxChars = WIKI_ENTRY_MAX_CHARS): string {
  const source = oneLine(hit.wikiName) + '/' + oneLine(hit.path);
  const prefix = '- [wiki:' + source + '] ';
  const title = oneLine(hit.title);
  const snippet = oneLine(hit.snippet);
  const budget = Math.max(0, maxChars);
  if (codePointLength(prefix) >= budget) return cropCodePoints(prefix, budget);
  const head = prefix + cropCodePoints(title, budget - codePointLength(prefix));
  if (snippet === '') return head;
  const separator = ' — ';
  const room = budget - codePointLength(head) - codePointLength(separator);
  if (room <= 1) return head;
  return head + separator + cropCodePoints(snippet, room);
}

/**
 * Render the team-wiki block.
 *
 * Budget discipline: maxChars is a hard cap in code points and the open/close
 * tags are reserved up front, so a truncated block is still a well-formed
 * block. Lines are dropped WHOLE (never cut in half) once the next one would
 * overflow: half a sentence reads like a broken tool result, a missing tail
 * reads like a short list. Returns '' when even the tags do not fit, or when
 * no entry survived the budget.
 */
export function renderWikiBlock(input: {
  results: unknown;
  maxChars?: number;
  topK?: number;
}): string {
  const maxChars = clampInt(
    input.maxChars,
    DEFAULT_WIKI_SEGMENT_CONFIG.maxChars,
    WIKI_SEGMENT_LIMITS.maxChars.min,
    WIKI_SEGMENT_LIMITS.maxChars.max,
  );
  if (maxChars <= 0) return '';
  const entries = selectWikiEntries(input.results, input.topK ?? DEFAULT_WIKI_SEGMENT_CONFIG.topK);
  if (entries.length === 0) return '';

  const reserved = codePointLength(WIKI_SEGMENT_OPEN) + 1 + codePointLength(WIKI_SEGMENT_CLOSE);
  const lines: string[] = [];
  let used = reserved;
  const hintCost = codePointLength(HINT_LINE) + 1;
  if (used + hintCost <= maxChars) {
    lines.push(HINT_LINE);
    used += hintCost;
  }
  let rendered = 0;
  for (const entry of entries) {
    const line = renderWikiEntry(entry);
    const cost = codePointLength(line) + 1;
    if (used + cost > maxChars) break;
    lines.push(line);
    used += cost;
    rendered += 1;
  }
  // A hint-only block is noise, not recall: if not one entry fits, inject nothing.
  if (rendered === 0) return '';
  return [WIKI_SEGMENT_OPEN, ...lines, WIKI_SEGMENT_CLOSE].join('\n');
}

/** Result of one v3 envelope call (subset of MemoryClient's v3() shape). */
export interface WikiCallResult<T> {
  ok: boolean;
  status?: number;
  reason?: string;
  data?: T;
  code?: number;
  message?: string;
}

/** MemoryClient.v3() seam: one raw v3 route, envelope already unwrapped. */
export type WikiCaller = <T>(
  path: string,
  body: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<WikiCallResult<T>>;

export interface WikiIdentity {
  /** Isolation triple — required: /v3 routes answer 422 without it. */
  teamId: string;
  /** Optional caller scope (body user_id). */
  userId?: string;
}

export type WikiIdentitySource = WikiIdentity | (() => WikiIdentity);

/** Why the segment did or did not inject. Always present, never thrown. */
export interface WikiSegmentDiagnostic {
  ok: boolean;
  /** Machine-readable failure reason (disabled / no_identity / empty_query / transport / ...). */
  reason?: string;
  /** Round-trip milliseconds (0 when no request was made). */
  ms: number;
  /** Entries actually rendered. */
  entries: number;
  /** Code points actually injected. */
  chars: number;
  /** meta.deadlineHit: a partial answer, not a failure. */
  deadlineHit: boolean;
  /** True when some wiki was skipped/failed but the block still shipped. */
  partial: boolean;
  /** Wiki-level failures reported by the core (meta.failed names). */
  failed: string[];
  /** Query length actually sent, in code points (may have been cropped to 1024). */
  queryChars: number;
  /** True when the query had to be cropped to fit the core's schema. */
  queryTruncated: boolean;
  /** Breaker state at completion (createSegmentHealth().describe()); absent when unwired. */
  health?: string;
}

export interface WikiSegmentResult {
  /** Ready-to-inject block, or '' when nothing should be injected. */
  text: string;
  diagnostic: WikiSegmentDiagnostic;
}

const WIKI_SEARCH_PATH = '/v3/wiki/search';

function emptyResult(reason: string, overrides: Partial<WikiSegmentDiagnostic> = {}): WikiSegmentResult {
  return {
    text: '',
    diagnostic: {
      ok: false,
      reason,
      ms: 0,
      entries: 0,
      chars: 0,
      deadlineHit: false,
      partial: false,
      failed: [],
      queryChars: 0,
      queryTruncated: false,
      ...overrides,
    },
  };
}

function identityOf(source: WikiIdentitySource | undefined): WikiIdentity | undefined {
  if (typeof source === 'function') {
    try {
      const resolved = source();
      return resolved !== undefined && resolved !== null ? resolved : undefined;
    } catch {
      return undefined;
    }
  }
  return source;
}

/**
 * Fetch one wiki segment for query.
 *
 * Fail-open by construction: a disabled segment, an empty query, a missing team
 * id, a transport error, a non-zero envelope code, a malformed payload or a zero
 * budget all return {text: '', diagnostic} and never throw. No request is issued
 * unless query AND team id are present (a 422 round trip per turn is pure waste).
 */
export async function fetchWikiSegment(deps: {
  call: WikiCaller;
  identity: WikiIdentitySource | undefined;
  config?: WikiSegmentConfig;
  query: string;
  logger?: LoggerLike;
  maxChars?: number;
  /** Optional segment breaker (task-98). Omitted = no breaker (tests, retrieval-only runs). */
  health?: SegmentHealth;
}): Promise<WikiSegmentResult> {
  const config = deps.config ?? DEFAULT_WIKI_SEGMENT_CONFIG;
  if (!config.enabled) return emptyResult('disabled');
  const rawQuery = typeof deps.query === 'string' ? deps.query.trim() : '';
  if (rawQuery === '') return emptyResult('empty_query');
  const identity = identityOf(deps.identity);
  const teamId = identity !== undefined && typeof identity.teamId === 'string' ? identity.teamId.trim() : '';
  if (teamId === '') return emptyResult('no_identity');
  const userId = identity !== undefined && typeof identity.userId === 'string' ? identity.userId.trim() : '';

  const cropped = cropCodePoints(rawQuery, WIKI_QUERY_MAX_CHARS);
  const queryTruncated = codePointLength(rawQuery) > WIKI_QUERY_MAX_CHARS;
  const queryChars = codePointLength(cropped);

  const body: Record<string, unknown> = {
    query: cropped,
    team_id: teamId,
    top_k: config.topK,
    per_wiki_limit: config.perWikiLimit,
    min_score: config.minScore,
  };
  if (userId !== '') body.user_id = userId;

  const health = deps.health;
  const healthNote = (): { health?: string } => (health !== undefined ? { health: health.describe() } : {});
  if (health !== undefined && !health.shouldAttempt()) {
    deps.logger?.debug?.('agemem: wiki segment circuit open, request skipped');
    return emptyResult('circuit_open', { queryChars, queryTruncated, ...healthNote() });
  }

  const started = Date.now();
  let result: WikiCallResult<WikiSearchData>;
  try {
    result = await deps.call<WikiSearchData>(WIKI_SEARCH_PATH, body, { timeoutMs: config.timeoutMs });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.logger?.debug?.('agemem: wiki search threw', detail);
    health?.recordFailure('transport');
    return emptyResult('transport', { ms: Date.now() - started, queryChars, queryTruncated, ...healthNote() });
  }
  const ms = Date.now() - started;
  if (result === undefined || result === null || result.ok !== true) {
    const status = result !== undefined && result !== null && typeof result.status === 'number' ? result.status : undefined;
    const code = result !== undefined && result !== null && typeof result.code === 'number' ? result.code : undefined;
    const reason = code !== undefined && code !== 0
      ? 'bad_envelope'
      : status !== undefined && status > 0
        ? 'http_' + status
        : 'transport';
    deps.logger?.debug?.(
      'agemem: wiki search failed reason=' + reason + ' status=' + String(status ?? '-') +
      ' code=' + String(code ?? '-') + ' detail=' + String(result?.reason ?? '-'),
    );
    health?.recordFailure(reason);
    return emptyResult(reason, { ms, queryChars, queryTruncated, ...healthNote() });
  }

  const data = result.data;
  const results = isRecord(data) && Array.isArray(data.results) ? data.results : undefined;
  if (results === undefined) {
    deps.logger?.debug?.('agemem: wiki search payload had no results[]');
    health?.recordFailure('bad_payload');
    return emptyResult('bad_payload', { ms, queryChars, queryTruncated, ...healthNote() });
  }
  const meta: WikiSearchMeta = isRecord(data) && isRecord(data.meta) ? (data.meta as WikiSearchMeta) : {};
  const deadlineHit = meta.deadlineHit === true;
  const failed = Array.isArray(meta.failed)
    ? meta.failed.map((f) => (isRecord(f) ? oneLine(f.name) || oneLine(f.wikiId) || 'unknown' : 'unknown'))
    : [];

  const selected = selectWikiEntries(results, config.topK);
  if (selected.length === 0) {
    // A healthy endpoint that simply found nothing must not open the breaker.
    health?.recordSuccess();
    return emptyResult(deadlineHit ? 'deadline_empty' : 'no_hits', {
      ms,
      deadlineHit,
      failed,
      queryChars,
      queryTruncated,
      ...healthNote(),
    });
  }
  const text = renderWikiBlock({
    results: selected,
    maxChars: deps.maxChars ?? config.maxChars,
    topK: selected.length,
  });
  if (text === '') {
    health?.recordSuccess();
    return emptyResult('budget_zero', { ms, deadlineHit, failed, queryChars, queryTruncated, ...healthNote() });
  }

  health?.recordSuccess();
  return {
    text,
    diagnostic: {
      ok: true,
      ms,
      entries: selected.length,
      chars: codePointLength(text),
      deadlineHit,
      partial: deadlineHit || failed.length > 0,
      failed,
      queryChars,
      queryTruncated,
      ...healthNote(),
    },
  };
}

/** The one-line wiring seam: bind transport + identity + config once, then ask per turn. */
export interface WikiSegmentHandle {
  readonly config: WikiSegmentConfig;
  /** Breaker this handle feeds (task-98), when one was wired. */
  readonly health?: SegmentHealth;
  /** Block for query, fail-open ('' means inject nothing). */
  retrieve(query: string, options?: { maxChars?: number }): Promise<WikiSegmentResult>;
  /** wiki=on entries=3 chars=412 ms=37 fail=- — one log line per turn. */
  describe(result: WikiSegmentResult): string;
}

/**
 * Register the volatile wiki segment.
 *
 * dsh-plugin calls this once with its resolved volatile.wiki subtree, the
 * MemoryClient v3() seam and a credential-backed identity, then asks
 * retrieve(query) while assembling the volatile block. Nothing here touches
 * config.ts / index.ts: the wiring is the caller's, this module only owns the
 * shape (see docs/ops/wiki-segment-wiring.md).
 */
export function registerVolatileWikiSegment(deps: {
  call: WikiCaller;
  identity: WikiIdentitySource;
  config?: unknown;
  logger?: LoggerLike;
  health?: SegmentHealth;
}): WikiSegmentHandle {
  const config = resolveWikiSegmentConfig(deps.config);
  return {
    config,
    ...(deps.health !== undefined ? { health: deps.health } : {}),
    async retrieve(query, options = {}) {
      const result = await fetchWikiSegment({
        call: deps.call,
        identity: deps.identity,
        config,
        query,
        logger: deps.logger,
        maxChars: options.maxChars,
        ...(deps.health !== undefined ? { health: deps.health } : {}),
      });
      deps.logger?.debug?.('agemem: ' + describeWikiDiagnostic(result.diagnostic));
      return result;
    },
    describe(result) {
      return describeWikiDiagnostic(result.diagnostic);
    },
  };
}

/** Stable one-line diagnostic shared by the log and the wiring doc. */
export function describeWikiDiagnostic(diagnostic: WikiSegmentDiagnostic): string {
  const state = diagnostic.ok ? 'on' : 'off';
  const fail = diagnostic.ok
    ? (diagnostic.failed.length > 0 ? diagnostic.failed.join(',') : '-')
    : (diagnostic.reason ?? 'unknown');
  const partial = diagnostic.partial ? ' partial=1' : '';
  const circuit = diagnostic.health !== undefined ? ' circuit=' + diagnostic.health : '';
  return 'wiki=' + state + ' entries=' + diagnostic.entries + ' chars=' + diagnostic.chars +
    ' ms=' + diagnostic.ms + ' fail=' + fail + partial + circuit;
}
