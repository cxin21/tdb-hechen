import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WIKI_SEGMENT_CONFIG,
  WIKI_ENTRY_MAX_CHARS,
  WIKI_QUERY_MAX_CHARS,
  WIKI_SEGMENT_CLOSE,
  WIKI_SEGMENT_OPEN,
  describeWikiDiagnostic,
  fetchWikiSegment,
  registerVolatileWikiSegment,
  renderWikiBlock,
  renderWikiEntry,
  resolveWikiSegmentConfig,
  selectWikiEntries,
  type WikiCallResult,
  type WikiSearchData,
} from '../src/wiki-segment.js';

/** One recorded call, so tests can assert both "was not called" and the wire body. */
interface CallRecord {
  path: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
}

function recorder(handler: (body: Record<string, unknown>) => WikiCallResult<WikiSearchData> | Promise<WikiCallResult<WikiSearchData>>) {
  const calls: CallRecord[] = [];
  const call = async <T>(path: string, body: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<WikiCallResult<T>> => {
    calls.push({ path, body, timeoutMs: options?.timeoutMs });
    return (await handler(body)) as WikiCallResult<T>;
  };
  return { calls, call };
}

function hit(overrides: Partial<{
  wikiId: string;
  wikiName: string;
  path: string;
  title: string;
  snippet: string | null;
  type: string | null;
  score: number;
  absScore: number;
  hop: number | null;
}> = {}) {
  return {
    wikiId: 'w1',
    wikiName: 'Coding-WiKi',
    path: 'docs/a.md',
    title: '标题',
    snippet: '片段',
    type: 'concept',
    score: 0.5,
    absScore: 0.5,
    hop: 0,
    ...overrides,
  };
}

const IDENTITY = { teamId: 'team-1', userId: 'user-1' };
const okData = (results: unknown[], meta: Record<string, unknown> = {}): WikiCallResult<WikiSearchData> => ({
  ok: true,
  data: { query: 'q', results: results as never, meta: meta as never },
});
const codePointLength = (text: string): number => Array.from(text).length;

describe('selectWikiEntries', () => {
  it('ranks by absScore, not by score — a zero score with a real absScore is NOT dropped', () => {
    // The live shape that motivated the rule: {score: 0, absScore: 1.2665}.
    const results = [
      hit({ wikiId: 'w-a', path: 'a.md', title: 'low-score-high-abs', score: 0, absScore: 1.2665 }),
      hit({ wikiId: 'w-b', path: 'b.md', title: 'high-score-low-abs', score: 0.9, absScore: 0.8 }),
    ];
    const selected = selectWikiEntries(results, 3);
    expect(selected).toHaveLength(2);
    expect(selected[0].title).toBe('low-score-high-abs');
    expect(selected[0].score).toBe(0);
    expect(selected[0].absScore).toBe(1.2665);
    expect(selected[1].title).toBe('high-score-low-abs');
  });

  it('dedupes on wikiId + path, keeping the higher absScore', () => {
    const selected = selectWikiEntries(
      [
        hit({ wikiId: 'w-a', path: 'same.md', title: 'weak', absScore: 0.2 }),
        hit({ wikiId: 'w-a', path: 'same.md', title: 'strong', absScore: 0.7 }),
        hit({ wikiId: 'w-b', path: 'same.md', title: 'other-wiki', absScore: 0.4 }),
      ],
      5,
    );
    expect(selected.map((h) => h.title)).toEqual(['strong', 'other-wiki']);
  });

  it('drops entries without a finite absScore and respects topK', () => {
    const selected = selectWikiEntries(
      [
        hit({ path: 'a.md', absScore: 0.3 }),
        hit({ path: 'b.md', absScore: Number.NaN }),
        hit({ path: 'c.md', absScore: 0.9 }),
        hit({ path: 'd.md', absScore: 0.1 }),
      ],
      2,
    );
    expect(selected.map((h) => h.path)).toEqual(['c.md', 'a.md']);
  });

  it('returns [] for a non-array payload', () => {
    expect(selectWikiEntries(undefined, 3)).toEqual([]);
    expect(selectWikiEntries({ results: [] }, 3)).toEqual([]);
  });
});

describe('renderWikiBlock', () => {
  it('renders the team-wiki block with sourced, one-line entries', () => {
    const block = renderWikiBlock({
      results: [hit({ wikiName: 'Coding-WiKi', path: 'guides/结算.md', title: '结算规则', snippet: '第一行\n第二行' })],
      maxChars: 800,
      topK: 3,
    });
    expect(block.startsWith(WIKI_SEGMENT_OPEN)).toBe(true);
    expect(block.endsWith(WIKI_SEGMENT_CLOSE)).toBe(true);
    expect(block).toContain('- [wiki:Coding-WiKi/guides/结算.md] 结算规则 — 第一行 第二行');
    expect(codePointLength(block)).toBeLessThanOrEqual(800);
  });

  it('keeps the tags and drops whole lines when the budget is tight', () => {
    const results = [
      hit({ path: 'a.md', title: 'T-A', snippet: 'A'.repeat(200), absScore: 0.9 }),
      hit({ path: 'b.md', title: 'T-B', snippet: 'B'.repeat(200), absScore: 0.8 }),
      hit({ path: 'c.md', title: 'T-C', snippet: 'C'.repeat(200), absScore: 0.7 }),
    ];
    const block = renderWikiBlock({ results, maxChars: 400, topK: 3 });
    expect(block.startsWith(WIKI_SEGMENT_OPEN)).toBe(true);
    expect(block.endsWith(WIKI_SEGMENT_CLOSE)).toBe(true);
    expect(codePointLength(block)).toBeLessThanOrEqual(400);
    // 260 leaves room for one entry line only -> the rest is dropped whole, not cut.
    const tiny = renderWikiBlock({ results, maxChars: 260, topK: 3 });
    expect(tiny).toBe('');
    // Whole lines only: every injected entry line is complete (has its closing bracket).
    for (const line of block.split('\n').filter((l) => l.startsWith('- '))) {
      expect(line).toMatch(/^- \[wiki:[^\]]+\] /);
    }
  });

  it('returns an empty string when maxChars is 0 or no entry fits', () => {
    expect(renderWikiBlock({ results: [hit()], maxChars: 0 })).toBe('');
    expect(renderWikiBlock({ results: [], maxChars: 800 })).toBe('');
    // Tags alone (~23 code points) are not recall: a hint-only block renders ''.
    expect(renderWikiBlock({ results: [hit({ snippet: 'x'.repeat(50) })], maxChars: 60 })).toBe('');
  });

  it('crops the snippet by code points without splitting a surrogate pair', () => {
    const line = renderWikiEntry(
      hit({ title: '长标题😀', snippet: '😀'.repeat(400) }),
      WIKI_ENTRY_MAX_CHARS,
    );
    expect(codePointLength(line)).toBeLessThanOrEqual(WIKI_ENTRY_MAX_CHARS);
    expect(line.endsWith('…')).toBe(true);
    expect(line.startsWith('- [wiki:Coding-WiKi/docs/a.md] 长标题😀 — ')).toBe(true);
  });
});

describe('resolveWikiSegmentConfig', () => {
  it('falls back to the ticket defaults for a missing or malformed subtree', () => {
    expect(resolveWikiSegmentConfig(undefined)).toEqual(DEFAULT_WIKI_SEGMENT_CONFIG);
    expect(resolveWikiSegmentConfig({ topK: 'three', maxChars: null })).toEqual(DEFAULT_WIKI_SEGMENT_CONFIG);
    expect(resolveWikiSegmentConfig(DEFAULT_WIKI_SEGMENT_CONFIG)).toEqual(DEFAULT_WIKI_SEGMENT_CONFIG);
  });

  it('clamps out-of-range numbers instead of trusting them', () => {
    const resolved = resolveWikiSegmentConfig({
      topK: 99,
      perWikiLimit: 0,
      minScore: -5,
      maxChars: 999_999,
      timeoutMs: 5,
    });
    expect(resolved.topK).toBe(20);
    expect(resolved.perWikiLimit).toBe(1);
    expect(resolved.minScore).toBe(0);
    expect(resolved.maxChars).toBe(4000);
    expect(resolved.timeoutMs).toBe(100);
  });

  it('honours an explicit enabled:false', () => {
    expect(resolveWikiSegmentConfig({ enabled: false }).enabled).toBe(false);
  });
});

describe('fetchWikiSegment', () => {
  it('issues no request for an empty query', async () => {
    const { calls, call } = recorder(() => okData([hit()]));
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: '   ' });
    expect(calls).toHaveLength(0);
    expect(result.text).toBe('');
    expect(result.diagnostic.reason).toBe('empty_query');
    expect(result.diagnostic.ms).toBe(0);
  });

  it('issues no request without a team id (and fails open on a throwing identity)', async () => {
    const { calls, call } = recorder(() => okData([hit()]));
    const noTeam = await fetchWikiSegment({ call, identity: { teamId: '  ' }, query: '结算' });
    expect(noTeam.diagnostic.reason).toBe('no_identity');
    const throwing = await fetchWikiSegment({
      call,
      identity: () => {
        throw new Error('boom');
      },
      query: '结算',
    });
    expect(throwing.diagnostic.reason).toBe('no_identity');
    expect(calls).toHaveLength(0);
  });

  it('issues no request when the segment is disabled', async () => {
    const { calls, call } = recorder(() => okData([hit()]));
    const result = await fetchWikiSegment({
      call,
      identity: IDENTITY,
      config: { ...DEFAULT_WIKI_SEGMENT_CONFIG, enabled: false },
      query: '结算',
    });
    expect(calls).toHaveLength(0);
    expect(result.diagnostic.reason).toBe('disabled');
  });

  it('posts the core contract body and unwraps results into a block', async () => {
    const { calls, call } = recorder(() => okData([hit({ path: 'a.md', absScore: 1.2 })]));
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: ' 结算 规则 ' });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/v3/wiki/search');
    expect(calls[0].timeoutMs).toBe(DEFAULT_WIKI_SEGMENT_CONFIG.timeoutMs);
    expect(calls[0].body).toEqual({
      query: '结算 规则',
      team_id: 'team-1',
      top_k: 3,
      per_wiki_limit: 4,
      min_score: 0.02,
      user_id: 'user-1',
    });
    expect(result.diagnostic.ok).toBe(true);
    expect(result.diagnostic.entries).toBe(1);
    expect(result.diagnostic.chars).toBe(codePointLength(result.text));
    expect(result.text).toContain('[wiki:Coding-WiKi/a.md]');
  });

  it('keeps a score:0 / absScore:1.2665 hit (no score-based drop anywhere)', async () => {
    const { call } = recorder(() =>
      okData([
        hit({ wikiId: 'w-a', path: 'zero.md', title: 'zero-score', score: 0, absScore: 1.2665 }),
        hit({ wikiId: 'w-b', path: 'high.md', title: 'high-score', score: 0.99, absScore: 0.4 }),
      ]),
    );
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: '结算' });
    expect(result.text).toContain('[wiki:Coding-WiKi/zero.md] zero-score');
    expect(result.text.indexOf('zero.md')).toBeLessThan(result.text.indexOf('high.md'));
  });

  it('treats deadlineHit with results as a partial success, not a failure', async () => {
    const { call } = recorder(() =>
      okData([hit({ path: 'a.md' })], {
        deadlineHit: true,
        failed: [{ wikiId: 'w2', name: 'Standards-WiKi', error: 'deadline' }],
      }),
    );
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: '结算' });
    expect(result.diagnostic.ok).toBe(true);
    expect(result.diagnostic.deadlineHit).toBe(true);
    expect(result.diagnostic.partial).toBe(true);
    expect(result.diagnostic.failed).toEqual(['Standards-WiKi']);
    expect(result.text).toContain(WIKI_SEGMENT_OPEN);
  });

  it('reports deadline_empty (no block) when the deadline consumed every wiki', async () => {
    const { call } = recorder(() => okData([], { deadlineHit: true }));
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: '结算' });
    expect(result.text).toBe('');
    expect(result.diagnostic.ok).toBe(false);
    expect(result.diagnostic.reason).toBe('deadline_empty');
    expect(result.diagnostic.deadlineHit).toBe(true);
  });

  it('does not let one failed wiki poison the hits from the others', async () => {
    const { call } = recorder(() =>
      okData([hit({ wikiName: 'Standards-WiKi', path: 'std.md' })], {
        failed: [{ wikiId: 'w9', name: 'Coding-WiKi', error: 'ECONNRESET' }],
        wikisFailed: 1,
      }),
    );
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: '结算' });
    expect(result.diagnostic.ok).toBe(true);
    expect(result.diagnostic.failed).toEqual(['Coding-WiKi']);
    expect(result.text).toContain('Standards-WiKi/std.md');
  });

  it('treats HTTP 200 + code!==0 as a failure (dual-track envelope)', async () => {
    const { call } = recorder(() => ({ ok: false, status: 200, code: 40001, reason: 'code 40001: bad query' }));
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: '结算' });
    expect(result.text).toBe('');
    expect(result.diagnostic.reason).toBe('bad_envelope');
  });

  it('reports a non-2xx status as http_<status>', async () => {
    const { call } = recorder(() => ({ ok: false, status: 403, reason: 'HTTP 403' }));
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: '结算' });
    expect(result.diagnostic.reason).toBe('http_403');
  });

  it('fails open when the transport throws', async () => {
    const call = async () => {
      throw new Error('socket hang up');
    };
    await expect(fetchWikiSegment({ call, identity: IDENTITY, query: '结算' })).resolves.toMatchObject({
      text: '',
    });
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: '结算' });
    expect(result.diagnostic.reason).toBe('transport');
  });

  it('reports bad_payload when data has no results[]', async () => {
    const { call } = recorder(() => ({ ok: true, data: { meta: {} } as WikiSearchData }));
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: '结算' });
    expect(result.diagnostic.reason).toBe('bad_payload');
  });

  it('crops an over-long query to the core schema limit (1024 code points)', async () => {
    const { calls, call } = recorder(() => okData([hit()]));
    const longQuery = '😀'.repeat(WIKI_QUERY_MAX_CHARS + 40);
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: longQuery });
    const sent = String(calls[0].body.query);
    expect(codePointLength(sent)).toBe(WIKI_QUERY_MAX_CHARS);
    expect(result.diagnostic.queryChars).toBe(WIKI_QUERY_MAX_CHARS);
    expect(result.diagnostic.queryTruncated).toBe(true);
  });

  it('honours a caller-supplied remaining budget', async () => {
    const { call } = recorder(() =>
      okData([
        hit({ path: 'a.md', title: 'A', snippet: 'x'.repeat(40), absScore: 0.9 }),
        hit({ path: 'b.md', title: 'B', snippet: 'y'.repeat(40), absScore: 0.8 }),
      ]),
    );
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: '结算', maxChars: 200 });
    expect(result.diagnostic.ok).toBe(true);
    expect(codePointLength(result.text)).toBeLessThanOrEqual(200);
  });

  it('reports budget_zero when maxChars cannot fit even one entry', async () => {
    const { call } = recorder(() => okData([hit()]));
    const result = await fetchWikiSegment({ call, identity: IDENTITY, query: '结算', maxChars: 0 });
    expect(result.text).toBe('');
    expect(result.diagnostic.reason).toBe('budget_zero');
  });
});

describe('registerVolatileWikiSegment', () => {
  it('resolves its own config and re-reads the identity on every turn', async () => {
    const { calls, call } = recorder(() => okData([hit()]));
    let team = 'team-a';
    const handle = registerVolatileWikiSegment({
      call,
      identity: () => ({ teamId: team, userId: 'user-1' }),
      config: { topK: 1, maxChars: 400 },
    });
    expect(handle.config.topK).toBe(1);
    await handle.retrieve('第一轮');
    team = 'team-b';
    await handle.retrieve('第二轮');
    expect(calls.map((c) => c.body.team_id)).toEqual(['team-a', 'team-b']);
  });

  it('describes one stable diagnostic line', async () => {
    const { call } = recorder(() => okData([hit()]));
    const handle = registerVolatileWikiSegment({ call, identity: IDENTITY });
    const result = await handle.retrieve('结算');
    expect(handle.describe(result)).toMatch(/^wiki=on entries=1 chars=\d+ ms=\d+ fail=-$/);
    expect(describeWikiDiagnostic({ ...result.diagnostic, ok: false, reason: 'no_hits' })).toBe(
      'wiki=off entries=1 chars=' + result.diagnostic.chars + ' ms=' + result.diagnostic.ms + ' fail=no_hits',
    );
  });
});
