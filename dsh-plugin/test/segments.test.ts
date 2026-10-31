import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgememConfig } from '../src/config.js';
import { normalizeConfig } from '../src/config.js';
import type { MemoryClient } from '../src/memory-client.js';
import {
  headPackSegmentSpecs,
  registerHeadPackSegment,
  registerVolatileSegment,
  resetSegmentsForTests,
  runHeadPackSegments,
  runVolatileSegments,
  segmentSummary,
  volatileSegmentSpecs,
} from '../src/segments/index.js';

// `normalizeConfig` returns `{ config, warnings }`; passing the wrapper around
// makes `config.headPack` undefined and every `enabled()` provider throw.
const config = (patch: Record<string, unknown> = {}): AgememConfig => normalizeConfig(patch).config;
const fakeClient = {} as unknown as MemoryClient;
const LF = String.fromCharCode(10);

function deps(overrides: Record<string, unknown> = {}) {
  return { client: fakeClient, config: config(), ...overrides } as any;
}

afterEach(() => resetSegmentsForTests());

describe('head pack segment registry', () => {
  // Registry semantics are tested in isolation: the barrel's own segments would
  // otherwise consume part of the total budget the cases below assert on.
  beforeEach(() => resetSegmentsForTests({ keepBuiltins: false }));

  it('replaces a spec registered under the same name instead of rendering it twice', () => {
    registerHeadPackSegment({ name: 'wiki', cap: 100, fetch: async () => ({ text: 'a', chars: 1 }) });
    registerHeadPackSegment({ name: 'wiki', cap: 200, fetch: async () => ({ text: 'b', chars: 1 }) });

    // A plugin reload must not double every segment; the newest definition wins.
    expect(headPackSegmentSpecs().filter((spec) => spec.name === 'wiki')).toHaveLength(1);
    expect(headPackSegmentSpecs().find((spec) => spec.name === 'wiki')?.cap).toBe(200);
  });

  it('rejects malformed specs at registration time, not at render time', () => {
    expect(() => registerHeadPackSegment({ name: '', cap: 10, fetch: async () => null })).toThrow();
    expect(() => registerHeadPackSegment({ name: 'x', cap: -1, fetch: async () => null })).toThrow();
    expect(() => registerHeadPackSegment({ name: 'x', cap: 10, fetch: undefined as any })).toThrow();
    expect(() => registerVolatileSegment({ name: '', fetch: async () => null })).toThrow();
  });

  it('joins segments in declared order and honours every cap', async () => {
    registerHeadPackSegment({ name: 'second', order: 20, cap: 10, fetch: async () => ({ text: 'B'.repeat(20), chars: 20 }) });
    registerHeadPackSegment({ name: 'first', order: 10, cap: 5, fetch: async () => ({ text: 'AAAAA', chars: 5 }) });

    const result = await runHeadPackSegments(deps(), 100);

    expect(result.text.startsWith('AAAAA')).toBe(true);
    expect(result.text).toContain('B'.repeat(10));
    // Over-cap text is clamped, and the clamp is visible in the status row.
    expect(result.segments.find((row) => row.name === 'second')?.truncated).toBe(true);
    expect(result.segments.find((row) => row.name === 'first')?.truncated).toBe(false);
  });

  it('gives the remainder segment whatever the fixed caps leave', async () => {
    registerHeadPackSegment({ name: 'fixed', order: 10, cap: 100, fetch: async () => ({ text: 'x'.repeat(100), chars: 100 }) });
    registerHeadPackSegment({ name: 'rest', order: 20, cap: 'remainder', fetch: async () => ({ text: 'R'.repeat(1000), chars: 1000 }) });

    const result = await runHeadPackSegments(deps(), 300);

    // 300 - 100 (fixed) - 2 (separator) = 198 for the remainder segment. The
    // provider is not told the budget (it only renders), so assert the outcome.
    expect(result.text.length).toBeLessThanOrEqual(300);
    expect(result.segments.find((row) => row.name === 'rest')?.chars).toBe(198);
  });

  it('keeps the <tag> wrappers when a tag-safe segment is truncated', async () => {
    const listing = ['<available_skills>', '- skill-a', '- skill-b', '- skill-c', '</available_skills>'].join(LF);
    registerHeadPackSegment({
      name: 'skills',
      order: 10,
      cap: 40,
      truncate: 'tag-safe',
      fetch: async () => ({ text: listing, chars: listing.length }),
    });

    const result = await runHeadPackSegments(deps(), 1000);

    // An unclosed <available_skills> would make the model read the rest of the
    // system prompt as skill text, so both tags survive any clamp.
    expect(result.text.startsWith('<available_skills>')).toBe(true);
    expect(result.text.trimEnd().endsWith('</available_skills>')).toBe(true);
    // 40 chars leaves room for the tags only; the marker is the first thing to go.
    expect(result.text.length).toBeLessThanOrEqual(40);

    // One character short of the whole block: the cut has room for the marker.
    registerHeadPackSegment({
      name: 'skills-wide',
      order: 10,
      cap: listing.length - 1,
      truncate: 'tag-safe',
      fetch: async () => ({ text: listing, chars: listing.length }),
    });
    const roomy = await runHeadPackSegments(deps(), 1000);
    expect(roomy.text).toContain('[agemem segment truncated]');
    expect(roomy.text.startsWith('<available_skills>')).toBe(true);
    expect(roomy.text.trimEnd().endsWith('</available_skills>')).toBe(true);
  });

  it('isolates a failing segment: zero characters, the rest still renders', async () => {
    registerHeadPackSegment({ name: 'dead', order: 10, cap: 50, fetch: async () => { throw new Error('boom'); } });
    registerHeadPackSegment({ name: 'live', order: 20, cap: 50, fetch: async () => ({ text: 'alive', chars: 5 }) });

    const result = await runHeadPackSegments(deps(), 100);

    expect(result.text).toBe('alive');
    expect(result.segments.find((row) => row.name === 'dead')).toMatchObject({ status: 'failed', chars: 0 });
  });

  it('skips a segment that would not fit at all, keeping the full text under budget', async () => {
    registerHeadPackSegment({ name: 'a', order: 10, cap: 60, fetch: async () => ({ text: 'a'.repeat(60), chars: 60 }) });
    registerHeadPackSegment({ name: 'b', order: 20, cap: 60, fetch: async () => ({ text: 'b'.repeat(60), chars: 60 }) });

    const result = await runHeadPackSegments(deps(), 100);

    expect(result.text.length).toBeLessThanOrEqual(100);
    // Nothing is silently clamped to nothing: the dropped segment says so.
    expect(result.segments.find((row) => row.name === 'b')?.status).toBe('skipped');
  });

  it('honours enabled(config) without calling the provider', async () => {
    const fetch = vi.fn(async () => ({ text: 'x', chars: 1 }));
    registerHeadPackSegment({ name: 'off', cap: 10, enabled: (cfg) => cfg.skill.enabled === false, fetch });

    const result = await runHeadPackSegments(deps(), 100);

    expect(fetch).not.toHaveBeenCalled();
    expect(result.text).toBe('');
  });
});

describe('volatile segment registry', () => {
  // Same isolation as above: the barrel now self-registers the wiki and
  // knowledge adapters, and those would each cost a (failing) fetch here.
  beforeEach(() => resetSegmentsForTests({ keepBuiltins: false }));

  it('returns nothing at zero cost when no module registered a segment', async () => {
    const result = await runVolatileSegments(deps(), 800);
    expect(result.text).toBe('');
    expect(result.segments).toEqual([]);
  });

  it('appends registered segments after the memory block, sharing one budget', async () => {
    registerVolatileSegment({ name: 'wiki', order: 10, fetch: async () => ({ text: 'W'.repeat(500), chars: 500 }) });
    registerVolatileSegment({ name: 'knowledge', order: 20, fetch: async () => ({ text: 'K'.repeat(500), chars: 500 }) });

    const result = await runVolatileSegments(deps(), 600);

    expect(result.text.length).toBeLessThanOrEqual(600);
    expect(result.text.startsWith('W'.repeat(500))).toBe(true);
    expect(result.segments.map((row) => row.name)).toEqual(['wiki', 'knowledge']);
  });

  it('drops a failing volatile segment without touching the others', async () => {
    registerVolatileSegment({ name: 'dead', order: 10, fetch: async () => { throw new Error('404'); } });
    registerVolatileSegment({ name: 'live', order: 20, fetch: async () => ({ text: 'live', chars: 4 }) });

    const result = await runVolatileSegments(deps(), 100);

    expect(result.text).toBe('live');
    expect(result.segments.find((row) => row.name === 'dead')?.status).toBe('failed');
  });
});

describe('built-in segment modules', () => {
  it('self-register through the barrel (no index.ts wiring needed)', () => {
    const names = headPackSegmentSpecs().map((spec) => spec.name);
    expect(names).toContain('persona');
    expect(names).toContain('skills');
    // Order matters: the persona owns the remainder, so it must not sit last.
    const persona = headPackSegmentSpecs().find((spec) => spec.name === 'persona')!;
    expect(persona.cap).toBe('remainder');
    expect(persona.order).toBeLessThan(headPackSegmentSpecs().find((spec) => spec.name === 'skills')!.order);
  });

  it('summarizes one line for the debug log', () => {
    expect(segmentSummary([
      { name: 'persona', chars: 4600, truncated: false, status: 'ok' },
      { name: 'skills', chars: 0, truncated: false, status: 'failed' },
    ])).toBe('persona=ok:4600 skills=failed:0');
  });
});
