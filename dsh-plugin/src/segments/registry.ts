import type { AgememConfig } from '../config.js';
import type { LoggerLike } from '../types.js';
import type { MemoryClient } from '../memory-client.js';
import type { SkillClient } from '../skill-client.js';

/**
 * Segment / tool registration seams.
 *
 * Why: every memory capability (persona, scene index, skills, knowledge, wiki,
 * redlines) renders into the same two places — the stable head pack section and
 * the per-turn volatile block — and every capability also wants tools. Wiring
 * each one inside `src/index.ts` would serialise all of that work through one
 * file. Here each capability lives in its own module and self-registers:
 *
 *   src/segments/persona.ts   → registerHeadPackSegment(...)
 *   src/segments/skills.ts    → registerHeadPackSegment(...)
 *   src/tools/skills.ts       → registerToolModule(...)
 *
 * `src/index.ts` only runs the registry. Adding a capability therefore means:
 * one new file + one import line in the barrel — never an edit of the entry.
 *
 * Budgets are applied HERE, once, in registration order:
 *   - a segment declares a fixed `cap`, or `'remainder'` (it gets whatever the
 *     fixed caps left over — persona is the only remainder today);
 *   - a segment may declare `truncate: 'tag-safe'` so a cut never leaves an
 *     unclosed `<available_skills>` behind (the model then sees a broken tag);
 *   - the assembled text is clamped to the total budget, dropping from the tail
 *     (later segments are the ones that lose), never mid-prefix.
 */

/** One segment's rendered text. `chars` is the provider's own count. */
export interface SegmentResult {
  text: string;
  chars: number;
  /** The provider itself had to cut (e.g. the core said truncated: true). */
  truncated?: boolean;
  /**
   * The provider reached the capability but the call failed (core 5xx, schema
   * error, …). It still must return zero characters — this flag only keeps the
   * debug summary honest: `skills=failed:0` (core down) instead of
   * `skills=empty:0` (no skills exist), which are different operator actions.
   */
  failed?: boolean;
}

/** Everything a provider may use; all of it is optional except `config`. */
export interface SegmentDeps {
  client: MemoryClient;
  config: AgememConfig;
  log?: LoggerLike;
  /** Present once the skill surface is wired (absent in pure-persona tests). */
  skillClient?: SkillClient;
  /** Current session id, when the host gave us one (tools that need it). */
  sessionId?: () => string | undefined;
  /**
   * This turn's user text, set by the volatile runner only (wiki/knowledge
   * search with it). Head pack runs once per session and has no turn text,
   * so it stays undefined there.
   */
  query?: string;
}

export type HeadPackSegmentProvider = (deps: SegmentDeps) => Promise<SegmentResult | null>;
export type VolatileSegmentProvider = (deps: SegmentDeps) => Promise<SegmentResult | null>;

export interface HeadPackSegmentSpec {
  /** Stable name; also the key in the debug line. */
  name: string;
  /** Fixed character cap, or `'remainder'` for "whatever is left". */
  cap: number | 'remainder';
  /** Keep opening/closing tags intact when the text is cut. */
  truncate?: 'tag-safe';
  /** Sort key; lower renders first. Default 100 (registration order breaks ties). */
  order?: number;
  /** Skip the segment entirely (no fetch, no network) when false. */
  enabled?: (config: AgememConfig) => boolean;
  fetch: HeadPackSegmentProvider;
}

export interface VolatileSegmentSpec {
  name: string;
  /** Sort key inside the volatile block; lower appends first. */
  order?: number;
  /**
   * Own ceiling for this segment, in characters. The runner always clamps it
   * further to what is left of the block budget, so a cap can never starve
   * an earlier segment. Absent = take whatever is left.
   */
  cap?: number;
  enabled?: (config: AgememConfig) => boolean;
  fetch: VolatileSegmentProvider;
}

export interface SegmentStatus {
  name: string;
  /** Rendered characters (0 = disabled, failed, or empty). */
  chars: number;
  truncated: boolean;
  status: 'ok' | 'empty' | 'failed' | 'skipped';
}

interface Registered<T> {
  spec: T;
  /** Registration index; the stable tiebreak for equal `order`. */
  seq: number;
}

const headPackSegments: Array<Registered<HeadPackSegmentSpec>> = [];
const volatileSegments: Array<Registered<VolatileSegmentSpec>> = [];
let sequence = 0;
/** Snapshot of the modules the barrel imports; restored by the test hook below. */
let builtinHeadPack: Array<Registered<HeadPackSegmentSpec>> | undefined;
let builtinVolatile: Array<Registered<VolatileSegmentSpec>> | undefined;

/**
 * Called once by the barrel after its imports ran, so `resetSegmentsForTests`
 * can drop a test's ad-hoc segments WITHOUT also dropping the shipped ones —
 * otherwise every test after the first would render an empty head pack.
 */
export function markBuiltins(): void {
  builtinHeadPack = [...headPackSegments];
  builtinVolatile = [...volatileSegments];
}

function specName(spec: { name?: unknown }): string {
  const name = typeof spec?.name === 'string' ? spec.name.trim() : '';
  if (name === '') throw new Error('segment name must be a non-empty string');
  return name;
}

export function registerHeadPackSegment(spec: HeadPackSegmentSpec): void {
  const name = specName(spec);
  const cap = spec.cap;
  if (cap !== 'remainder' && !(typeof cap === 'number' && Number.isFinite(cap) && cap >= 0)) {
    throw new Error(`segment ${name}: cap must be a number >= 0 or 'remainder'`);
  }
  if (typeof spec.fetch !== 'function') throw new Error(`segment ${name}: fetch must be a function`);
  // Re-registering a name replaces the previous spec: the host can reload a
  // plugin entry, and a stale duplicate would render the block twice.
  const existing = headPackSegments.findIndex((entry) => entry.spec.name === name);
  if (existing >= 0) headPackSegments.splice(existing, 1);
  headPackSegments.push({ spec: { ...spec, name }, seq: sequence++ });
}

export function registerVolatileSegment(spec: VolatileSegmentSpec): void {
  const name = specName(spec);
  if (typeof spec.fetch !== 'function') throw new Error(`segment ${name}: fetch must be a function`);
  const existing = volatileSegments.findIndex((entry) => entry.spec.name === name);
  if (existing >= 0) volatileSegments.splice(existing, 1);
  volatileSegments.push({ spec: { ...spec, name }, seq: sequence++ });
}

function ordered<T extends { name: string; order?: number }>(entries: Array<Registered<T>>): T[] {
  return [...entries]
    .sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100) || a.seq - b.seq)
    .map((entry) => entry.spec);
}

export function headPackSegmentSpecs(): HeadPackSegmentSpec[] {
  return ordered(headPackSegments);
}

export function volatileSegmentSpecs(): VolatileSegmentSpec[] {
  return ordered(volatileSegments);
}

/**
 * Test hook: drop the test's registrations. By default the modules the barrel
 * imports come back, because they are part of the shipped plugin; a registry
 * test that wants an empty slate passes `{ keepBuiltins: false }`.
 */
export function resetSegmentsForTests(options: { keepBuiltins?: boolean } = {}): void {
  const keepBuiltins = options.keepBuiltins !== false;
  headPackSegments.length = 0;
  volatileSegments.length = 0;
  if (keepBuiltins && builtinHeadPack !== undefined) headPackSegments.push(...builtinHeadPack);
  if (keepBuiltins && builtinVolatile !== undefined) volatileSegments.push(...builtinVolatile);
  // Keep the counter monotonic: the built-ins keep their real seq, and reusing
  // those numbers would let a later registration tie with a shipped segment.
  sequence = [...headPackSegments, ...volatileSegments].reduce((next, entry) => Math.max(next, entry.seq + 1), 0);
}

/**
 * `tag-safe` cut: keep the opening tag (first line, when it is a `<tag>`) and
 * the matching closing tag, and mark the cut in between. A model that receives
 * `<available_skills>` without `</available_skills>` treats the rest of the
 * prompt as skill text, so page boundaries matter more than the last entry.
 */
export function cutTagSafe(text: string, budget: number, marker = '[agemem segment truncated]'): string {
  if (budget <= 0) return '';
  if (text.length <= budget) return text;
  const lines = text.split(String.fromCharCode(10));
  const first = lines[0].trim();
  const opening = /^<([A-Za-z0-9_:-]+)>$/.exec(first)?.[1];
  const closing = opening === undefined ? undefined : '</' + opening + '>';
  if (opening === undefined || closing === undefined || !text.trimEnd().endsWith(closing)) {
    // Not a single tagged block: cut cleanly, no marker games.
    return text.slice(0, budget);
  }
  // Tags first, marker second: a tight budget must still close the block, so
  // the '…truncated' line is only spent when there is room left after the tags.
  const open = '<' + opening + '>';
  const room = budget - open.length - closing.length;
  if (room < 2) return text.slice(0, budget);
  const withMarker = room >= marker.length + 3;
  const bodyBudget = room - (withMarker ? marker.length + 3 : 2);
  const body = bodyBudget > 0 ? text.slice(open.length + 1, open.length + 1 + bodyBudget).trimEnd() : '';
  return withMarker
    ? open + String.fromCharCode(10) + body + String.fromCharCode(10) + marker + String.fromCharCode(10) + closing
    : open + String.fromCharCode(10) + body + String.fromCharCode(10) + closing;
}

/** Cap-aware clamp for one segment; returns the text and whether it was cut. */
export function clampSegment(text: string, budget: number, tagSafe: boolean): { text: string; truncated: boolean } {
  const normalized = text.trim();
  if (normalized === '') return { text: '', truncated: false };
  const cap = Math.max(0, Math.floor(budget));
  if (normalized.length <= cap) return { text: normalized, truncated: false };
  const cut = tagSafe
    ? cutTagSafe(normalized, cap)
    : normalized.slice(0, cap);
  return { text: cut.trim(), truncated: true };
}

export interface HeadPackAssembly {
  text: string;
  segments: SegmentStatus[];
}

/**
 * Render every enabled head-pack segment, apply the fixed caps, then give the
 * remainder segments what is left and finally clamp the whole block.
 *
 * Failure policy: a throwing/slow provider contributes ZERO characters and is
 * reported as `failed` — the prompt must never break because memory is down.
 */
export async function runHeadPackSegments(
  deps: SegmentDeps,
  totalChars: number,
  specs: HeadPackSegmentSpec[] = headPackSegmentSpecs(),
): Promise<HeadPackAssembly> {
  const total = Math.max(0, Math.floor(totalChars));
  const enabled = specs.filter((spec) => (spec.enabled === undefined ? true : spec.enabled(deps.config)));
  const fixed = enabled.reduce((sum, spec) => sum + (spec.cap === 'remainder' ? 0 : spec.cap), 0);
  const separators = Math.max(0, enabled.length - 1) * 2;
  const remainder = Math.max(0, total - fixed - separators);

  const rendered = await Promise.all(enabled.map(async (spec, index): Promise<{ text: string; status: SegmentStatus }> => {
    try {
      const result = await spec.fetch(deps);
      const text = typeof result?.text === 'string' ? result.text : '';
      if (text.trim() === '') {
        return {
          text: '',
          status: { name: spec.name, chars: 0, truncated: false, status: result?.failed === true ? 'failed' : 'empty' },
        };
      }
      const budget = spec.cap === 'remainder' ? remainder : spec.cap;
      const clamped = clampSegment(text, budget, spec.truncate === 'tag-safe');
      return {
        text: clamped.text,
        status: {
          name: spec.name,
          chars: clamped.text.length,
          truncated: clamped.truncated || result?.truncated === true,
          status: 'ok',
        },
      };
    } catch (error) {
      deps.log?.debug?.(`agemem: head pack segment ${spec.name} failed`, error);
      return { text: '', status: { name: spec.name, chars: 0, truncated: false, status: 'failed' } };
    }
  }));

  // Assemble in registration order, dropping from the TAIL when the total budget
  // is still exceeded: later segments are the ones we can live without.
  const parts: string[] = [];
  let used = 0;
  const segments: SegmentStatus[] = rendered.map((entry) => entry.status);
  for (let index = 0; index < rendered.length; index += 1) {
    const entry = rendered[index];
    if (entry.text === '') continue;
    const separator = parts.length === 0 ? 0 : 2;
    if (used + separator + entry.text.length > total) {
      segments[index] = { ...entry.status, chars: 0, status: 'skipped' };
      continue;
    }
    parts.push(entry.text);
    used += separator + entry.text.length;
  }
  return { text: parts.join(String.fromCharCode(10, 10)).slice(0, total), segments };
}

/**
 * Render the extra volatile segments (registered by capability modules) and
 * join them. `capChars` is what is left of the volatile budget after the core
 * block (soul + memories), so a new segment can never push those out.
 */
export async function runVolatileSegments(
  deps: SegmentDeps,
  capChars: number,
  specs: VolatileSegmentSpec[] = volatileSegmentSpecs(),
): Promise<HeadPackAssembly> {
  const total = Math.max(0, Math.floor(capChars));
  if (total === 0) return { text: '', segments: [] };
  const enabled = specs.filter((spec) => (spec.enabled === undefined ? true : spec.enabled(deps.config)));
  if (enabled.length === 0) return { text: '', segments: [] };
  const parts: string[] = [];
  const segments: SegmentStatus[] = [];
  let used = 0;
  for (const spec of enabled) {
    let text = '';
    let truncated = false;
    let failed = false;
    try {
      const result = await spec.fetch(deps);
      failed = result?.failed === true;
      const raw = typeof result?.text === 'string' ? result.text : '';
      if (raw.trim() !== '') {
        const remaining = Math.max(0, total - used - (parts.length === 0 ? 0 : 2));
        const ownCap = typeof spec.cap === 'number' && Number.isFinite(spec.cap) ? Math.max(0, spec.cap) : Number.POSITIVE_INFINITY;
        const clamped = clampSegment(raw, Math.min(remaining, ownCap), false);
        text = clamped.text;
        truncated = clamped.truncated || result?.truncated === true;
      }
    } catch (error) {
      deps.log?.debug?.(`agemem: volatile segment ${spec.name} failed`, error);
      segments.push({ name: spec.name, chars: 0, truncated: false, status: 'failed' });
      continue;
    }
    if (text === '') {
      segments.push({ name: spec.name, chars: 0, truncated, status: failed ? 'failed' : 'empty' });
      continue;
    }
    used += (parts.length === 0 ? 0 : 2) + text.length;
    parts.push(text);
    segments.push({ name: spec.name, chars: text.length, truncated, status: 'ok' });
  }
  return { text: parts.join(String.fromCharCode(10, 10)), segments };
}

/** One-line debug summary of what the head pack actually rendered. */
export function segmentSummary(segments: SegmentStatus[]): string {
  return segments.map((segment) => `${segment.name}=${segment.status}:${segment.chars}`).join(' ');
}
