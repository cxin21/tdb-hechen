/**
 * Seam-level tests for the two per-turn capability segments (task-74 wiki,
 * task-97 knowledge).
 *
 * The rendering/fetch logic belongs to `src/wiki-segment.ts` and
 * `src/knowledge-segment.ts` (tested where they live). What is asserted here
 * is only the contract `src/index.ts` relies on: wire path, budget, ordering,
 * and fail-open (a dead capability costs zero characters, never a broken turn).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../src/config.js';
import {
  resetSegmentsForTests,
  runVolatileSegments,
  volatileSegmentSpecs,
} from '../src/segments/index.js';
import { resetWikiSegmentForTests } from '../src/segments/wiki.js';
import { resetKnowledgeSegmentForTests } from '../src/segments/knowledge.js';

const config = (patch: Record<string, unknown> = {}) => normalizeConfig(patch).config;

function deps(patch: Record<string, unknown> = {}, v3?: unknown, query?: string) {
  const client = { v3: v3 ?? vi.fn(async () => ({ ok: false, status: 404 })) };
  return { client, config: config(patch), log: { debug: vi.fn(), warn: vi.fn() }, ...(query !== undefined ? { query } : {}) } as any;
}

const TEAM = { server: { teamId: 'team-1', serviceId: 'svc-1' } };
const KNOWLEDGE_ON = { ...TEAM, volatile: { enabled: true, knowledge: { enabled: true } } };
const WIKI_ON = { ...TEAM, volatile: { enabled: true, wiki: { enabled: true } } };

beforeEach(() => {
  // Start from the shipped segments only, then drop the memoized handles so
  // each case's config and identity actually take effect.
  resetSegmentsForTests();
  resetWikiSegmentForTests();
  resetKnowledgeSegmentForTests();
});
afterEach(() => resetSegmentsForTests());


describe('segment breakers (task-98 wiring)', () => {
  it('opens the knowledge leg after three failures and stops calling the core', async () => {
    const v3 = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const run = () => runVolatileSegments(deps(KNOWLEDGE_ON, v3), 1500);

    await run();
    await run();
    await run();
    const callsAfterThree = v3.mock.calls.length;
    await run();

    // The fourth turn is skipped by the breaker: no fourth request, still empty.
    expect(v3.mock.calls.length).toBe(callsAfterThree);
  });

  it('opens the skills leg after three failures and serves an empty catalogue', async () => {
    const { headPackSegmentSpecs, resetSegmentsForTests: reset } = await import('../src/segments/index.js');
    const { resetSkillsSegmentHealthForTests } = await import('../src/segments/skills.js');
    resetSkillsSegmentHealthForTests();
    const listing = vi.fn(async () => ({ ok: false, status: 404, error: 'HTTP 404' }));
    const spec = headPackSegmentSpecs().find((row) => row.name === 'skills');
    expect(spec).toBeDefined();
    const call = () => spec!.fetch({ client: {}, config: config(), skillClient: { listing } as any, log: { debug: vi.fn() } } as any);

    for (let i = 0; i < 3; i += 1) await call();
    const callsAfterThree = listing.mock.calls.length;
    const skipped = await call();

    expect(listing.mock.calls.length).toBe(callsAfterThree);
    expect(skipped).toMatchObject({ text: '', chars: 0 });
    reset();
  });
});

describe('capability segments: registration and order', () => {
  it('ships wiki before knowledge and inside the volatile seam only', () => {
    const specs = volatileSegmentSpecs();
    const wiki = specs.find((spec) => spec.name === 'wiki');
    const knowledge = specs.find((spec) => spec.name === 'knowledge');
    expect(wiki?.order).toBe(50);
    expect(knowledge?.order).toBe(60);
    // Wiki is OFF by default (no /v3/wiki/search on 8420), knowledge is ON.
    expect(wiki?.enabled?.(config())).toBe(false);
    expect(knowledge?.enabled?.(config())).toBe(true);
    // The per-segment ceilings the seam clamps against.
    expect(wiki?.cap).toBe(800);
    expect(knowledge?.cap).toBe(3000);
  });
});

describe('knowledge segment', () => {
  it('renders the core list into a <knowledge_tools> block', async () => {
    const v3 = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: {
        items: [
          {
            knowledge_id: 'wiki-m6c41uvc',
            service_url: 'http://127.0.0.1:8421/v3',
            type: 'wiki',
            name: 'td-agemem wiki',
            summary: 'memory system docs',
          },
        ],
      },
    }));

    const result = await runVolatileSegments(deps(KNOWLEDGE_ON, v3), 1500);

    expect(result.segments.map((row) => row.name)).toContain('knowledge');
    expect(result.segments.find((row) => row.name === 'knowledge')?.status).toBe('ok');
    expect(result.text).toContain('<knowledge_tools>');
    expect(result.text).toContain('wiki-m6c41uvc');
    expect(v3).toHaveBeenCalledWith('/v3/knowledge/list', expect.objectContaining({ team_id: 'team-1' }), expect.anything());
  });

  it('costs zero characters when the core is down, without failing the block', async () => {
    const v3 = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const log = { debug: vi.fn(), warn: vi.fn() };
    const withLog = { ...deps(KNOWLEDGE_ON, v3), log };

    const result = await runVolatileSegments(withLog, 1500);

    expect(result.text).toBe('');
    expect(result.segments.find((row) => row.name === 'knowledge')).toMatchObject({ status: 'failed', chars: 0 });
    // The module's own diagnostic line still reaches the log.
    expect(log.debug.mock.calls.map((call: unknown[]) => String(call[0])).join(' ')).toContain('knowledge=');
  });

  it('treats an empty team list as a normal empty, not a failure', async () => {
    const v3 = vi.fn(async () => ({ ok: true, status: 200, data: { items: [] } }));

    const result = await runVolatileSegments(deps(KNOWLEDGE_ON, v3), 1500);

    expect(result.text).toBe('');
    expect(result.segments.find((row) => row.name === 'knowledge')?.status).not.toBe('failed');
  });
});

describe('wiki segment', () => {
  it('never touches the wire when the turn text is empty', async () => {
    const v3 = vi.fn(async () => ({ ok: true, status: 200, data: {} }));

    await runVolatileSegments(deps(WIKI_ON, v3, '   '), 1500);

    // Knowledge is ON by default and still runs; the wiki leg must not.
    expect(v3.mock.calls.map((call: unknown[]) => String(call[0]))).not.toContain('/v3/wiki/search');
  });

  it('fails open (zero characters) when the route is missing', async () => {
    const v3 = vi.fn(async () => ({ ok: false, status: 404, reason: 'HTTP 404' }));
    const log = { debug: vi.fn(), warn: vi.fn() };

    const result = await runVolatileSegments({ ...deps(WIKI_ON, v3, '采购订单 行号'), log }, 1500);

    expect(result.text).toBe('');
    // http_404 is not a normal answer (no_hits / empty_query are): the segment
    // says "failed" so an operator flipping wiki on against a 404 core sees it.
    expect(result.segments.find((row) => row.name === 'wiki')).toMatchObject({ status: 'failed', chars: 0 });
    expect(v3).toHaveBeenCalledWith('/v3/wiki/search', expect.anything(), expect.anything());
  });
});
