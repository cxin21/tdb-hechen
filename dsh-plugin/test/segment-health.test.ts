import { describe, expect, it, vi } from 'vitest';
import {
  SEGMENT_HEALTH_DEFAULT_COOLDOWN_MS,
  SEGMENT_HEALTH_DEFAULT_THRESHOLD,
  createSegmentHealth,
  isSegmentFailure,
} from '../src/segment-health.js';
import {
  describeWikiDiagnostic,
  fetchWikiSegment,
  resolveWikiSegmentConfig,
  type WikiCallResult,
  type WikiSearchData,
} from '../src/wiki-segment.js';
import {
  describeKnowledgeDiagnostic,
  executeKnowledgeTool,
  fetchKnowledgeSegment,
  resolveKnowledgeSegmentConfig,
  type KnowledgeCoreResult,
} from '../src/knowledge-segment.js';

/** Deterministic clock so cooldown math is asserted, not slept through. */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function spyLogger() {
  const debug = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  return { logger: { debug, info, warn }, debug, info, warn };
}

const WIKI_IDENTITY = { teamId: 'team-1', userId: 'user-1' };

function wikiRecorder(handler: () => WikiCallResult<WikiSearchData> | Promise<WikiCallResult<WikiSearchData>>) {
  let count = 0;
  const call = async <T>(_path: string, _body: Record<string, unknown>, _options?: { timeoutMs?: number }): Promise<WikiCallResult<T>> => {
    count += 1;
    return (await handler()) as WikiCallResult<T>;
  };
  return { call, count: () => count };
}

const okWikiData = (): WikiCallResult<WikiSearchData> => ({
  ok: true,
  data: {
    query: 'q',
    results: [{
      wikiId: 'w1', wikiName: 'Coding-WiKi', path: 'docs/a.md', title: '标题',
      snippet: '片段', type: 'concept', score: 0, absScore: 1.2, hop: 0,
    }] as never,
    meta: {} as never,
  },
});

const transportFail = (): WikiCallResult<WikiSearchData> => ({
  ok: false,
  status: 0,
  reason: 'ECONNREFUSED',
}) as never;

const notFound = (): WikiCallResult<WikiSearchData> => ({ ok: false, status: 404, reason: 'not found' }) as never;

describe('createSegmentHealth', () => {
  it('starts closed and lets every attempt through', () => {
    const health = createSegmentHealth({ name: 'wiki' });
    expect(health.describe()).toBe('closed');
    expect(health.shouldAttempt()).toBe(true);
    expect(health.snapshot()).toEqual({ state: 'closed', failures: 0, retryInMs: 0, probing: false });
  });

  it('opens on the third consecutive failure and blocks the fourth attempt', () => {
    const t = clock();
    const health = createSegmentHealth({ name: 'wiki', now: t.now });
    health.recordFailure('http_404');
    expect(health.shouldAttempt()).toBe(true);
    health.recordFailure('http_404');
    expect(health.shouldAttempt()).toBe(true);
    health.recordFailure('http_404');
    expect(health.shouldAttempt()).toBe(false);
    expect(health.snapshot().state).toBe('open');
    expect(health.snapshot().failures).toBe(SEGMENT_HEALTH_DEFAULT_THRESHOLD);
  });

  it('describe() carries the reason, threshold and remaining cooldown', () => {
    const t = clock();
    const health = createSegmentHealth({ name: 'wiki', now: t.now });
    health.recordFailure('http_404');
    health.recordFailure('http_404');
    health.recordFailure('http_404');
    expect(health.describe()).toBe('open(http_404, 3, retryIn=600s)');
    t.advance(60_000);
    expect(health.describe()).toBe('open(http_404, 3, retryIn=540s)');
    expect(SEGMENT_HEALTH_DEFAULT_COOLDOWN_MS).toBe(600_000);
  });

  it('lets exactly one probe through after the cooldown, even for 4 concurrent callers', () => {
    const t = clock();
    const health = createSegmentHealth({ name: 'wiki', now: t.now });
    for (let i = 0; i < 3; i += 1) health.recordFailure('transport');
    expect(health.shouldAttempt()).toBe(false);
    t.advance(SEGMENT_HEALTH_DEFAULT_COOLDOWN_MS);
    const attempts = [health.shouldAttempt(), health.shouldAttempt(), health.shouldAttempt(), health.shouldAttempt()];
    expect(attempts).toEqual([true, false, false, false]);
    expect(health.describe()).toBe('open(transport, 3, probing)');
  });

  it('a successful probe closes the circuit and logs one recovery line', () => {
    const t = clock();
    const { logger, info } = spyLogger();
    const health = createSegmentHealth({ name: 'wiki', now: t.now, logger });
    for (let i = 0; i < 3; i += 1) health.recordFailure('http_404');
    t.advance(SEGMENT_HEALTH_DEFAULT_COOLDOWN_MS);
    expect(health.shouldAttempt()).toBe(true);
    health.recordSuccess();
    expect(health.describe()).toBe('closed');
    expect(health.snapshot().failures).toBe(0);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain('closed (recovered)');
  });

  it('a failed probe re-opens and restarts the cooldown from the probe', () => {
    const t = clock();
    const health = createSegmentHealth({ name: 'wiki', now: t.now });
    for (let i = 0; i < 3; i += 1) health.recordFailure('http_404');
    t.advance(SEGMENT_HEALTH_DEFAULT_COOLDOWN_MS);
    expect(health.shouldAttempt()).toBe(true);
    health.recordFailure('transport');
    expect(health.shouldAttempt()).toBe(false);
    expect(health.snapshot().reason).toBe('transport');
    // Cooldown restarted: the full 600s is due again, not 0s.
    expect(health.describe()).toBe('open(transport, 3, retryIn=600s)');
  });

  it('warns once per open episode, not once per failure', () => {
    const t = clock();
    const { logger, warn } = spyLogger();
    const health = createSegmentHealth({ name: 'wiki', now: t.now, logger });
    for (let i = 0; i < 3; i += 1) health.recordFailure('http_404');
    health.recordFailure('http_404');
    t.advance(SEGMENT_HEALTH_DEFAULT_COOLDOWN_MS);
    health.shouldAttempt();
    health.recordFailure('http_404');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('wiki segment open reason=http_404');
    expect(line).toContain('threshold=3');
    expect(line).toContain('cooldown=600s');
  });

  it('a non-failure success between failures resets the counter', () => {
    const health = createSegmentHealth({ name: 'wiki' });
    health.recordFailure('transport');
    health.recordFailure('transport');
    health.recordSuccess();
    health.recordFailure('transport');
    health.recordFailure('transport');
    expect(health.describe()).toBe('closed');
    expect(health.shouldAttempt()).toBe(true);
  });

  it('reclaims a half-open lease the caller never reported back', () => {
    const t = clock();
    const health = createSegmentHealth({ name: 'wiki', now: t.now });
    for (let i = 0; i < 3; i += 1) health.recordFailure('transport');
    t.advance(SEGMENT_HEALTH_DEFAULT_COOLDOWN_MS);
    expect(health.shouldAttempt()).toBe(true); // probe taken, never answered
    expect(health.shouldAttempt()).toBe(false);
    t.advance(SEGMENT_HEALTH_DEFAULT_COOLDOWN_MS);
    expect(health.shouldAttempt()).toBe(true); // lease expired -> new probe
  });

  it('honours a custom threshold and reset() clears everything', () => {
    const health = createSegmentHealth({ name: 'knowledge', threshold: 5 });
    for (let i = 0; i < 4; i += 1) health.recordFailure('transport');
    expect(health.shouldAttempt()).toBe(true);
    health.recordFailure('transport');
    expect(health.shouldAttempt()).toBe(false);
    health.reset();
    expect(health.describe()).toBe('closed');
    expect(health.shouldAttempt()).toBe(true);
  });

  it('classifies only transport/http/envelope/payload/too_large as segment failures', () => {
    for (const reason of ['transport', 'http_404', 'http_500', 'bad_envelope', 'bad_payload', 'too_large']) {
      expect(isSegmentFailure(reason)).toBe(true);
    }
    for (const reason of ['no_hits', 'empty_list', 'budget_zero', 'deadline_empty', 'disabled', 'no_identity', 'circuit_open', undefined]) {
      expect(isSegmentFailure(reason)).toBe(false);
    }
  });
});

describe('wiki segment breaker', () => {
  const config = resolveWikiSegmentConfig({ enabled: true });

  it('stops issuing requests once open and reports circuit_open, distinct from http_404', async () => {
    const t = clock();
    const health = createSegmentHealth({ name: 'wiki', now: t.now });
    const rec = wikiRecorder(notFound);
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await fetchWikiSegment({ call: rec.call, identity: WIKI_IDENTITY, config, query: 'q', health }));
    }
    // Three real attempts (all 404), the fourth never reaches the wire.
    expect(rec.count()).toBe(3);
    expect(results[0].diagnostic.reason).toBe('http_404');
    expect(results[3].diagnostic.reason).toBe('circuit_open');
    expect(results[3].text).toBe('');
    expect(describeWikiDiagnostic(results[3].diagnostic)).toContain('fail=circuit_open');
    expect(describeWikiDiagnostic(results[3].diagnostic)).toContain('circuit=open(http_404, 3');
  });

  it('never opens on a healthy-but-empty endpoint', async () => {
    const health = createSegmentHealth({ name: 'wiki' });
    const rec = wikiRecorder(() => ({ ok: true, data: { query: 'q', results: [], meta: {} } as never }));
    for (let i = 0; i < 5; i += 1) {
      const result = await fetchWikiSegment({ call: rec.call, identity: WIKI_IDENTITY, config, query: 'q', health });
      expect(result.diagnostic.reason).toBe('no_hits');
    }
    expect(rec.count()).toBe(5);
    expect(health.describe()).toBe('closed');
  });

  it('recovers: after the cooldown one probe succeeds and traffic resumes', async () => {
    const t = clock();
    const health = createSegmentHealth({ name: 'wiki', now: t.now });
    const rec = wikiRecorder(transportFail);
    for (let i = 0; i < 3; i += 1) await fetchWikiSegment({ call: rec.call, identity: WIKI_IDENTITY, config, query: 'q', health });
    expect(health.describe()).toMatch(/^open\(transport, 3/u);
    const skipped = await fetchWikiSegment({ call: rec.call, identity: WIKI_IDENTITY, config, query: 'q', health });
    expect(skipped.diagnostic.reason).toBe('circuit_open');
    expect(rec.count()).toBe(3);

    t.advance(SEGMENT_HEALTH_DEFAULT_COOLDOWN_MS);
    const healthy = wikiRecorder(okWikiData);
    const probed = await fetchWikiSegment({ call: healthy.call, identity: WIKI_IDENTITY, config, query: 'q', health });
    expect(probed.diagnostic.ok).toBe(true);
    expect(health.describe()).toBe('closed');
  });

  it('registerVolatileWikiSegment exposes the breaker it feeds', async () => {
    const health = createSegmentHealth({ name: 'wiki' });
    const rec = wikiRecorder(okWikiData);
    const handle = (await import('../src/wiki-segment.js')).registerVolatileWikiSegment({
      call: rec.call, identity: WIKI_IDENTITY, health, logger: undefined,
    });
    expect(handle.health).toBe(health);
    const result = await handle.retrieve('q');
    expect(handle.describe(result)).toContain('circuit=closed');
  });
});

describe('knowledge segment breaker', () => {
  const config = resolveKnowledgeSegmentConfig({ enabled: true });
  const coreFail = (): KnowledgeCoreResult => ({ ok: false, status: 0, reason: 'ECONNREFUSED' }) as never;

  it('core leg: three transport failures stop the list requests', async () => {
    const health = createSegmentHealth({ name: 'knowledge-core' });
    let count = 0;
    const call = async (): Promise<KnowledgeCoreResult> => { count += 1; return coreFail(); };
    const out = [];
    for (let i = 0; i < 4; i += 1) {
      out.push(await fetchKnowledgeSegment({ call: call as never, identity: { teamId: 'team-1' }, config, health }));
    }
    expect(count).toBe(3);
    expect(out[0].diagnostic.reason).toBe('transport');
    expect(out[3].diagnostic.reason).toBe('circuit_open');
    expect(describeKnowledgeDiagnostic(out[3].diagnostic)).toContain('circuit=open(transport, 3');
  });

  it('tools leg: three http_500s stop the tools/call requests, with its own breaker', async () => {
    const health = createSegmentHealth({ name: 'knowledge-tools' });
    let count = 0;
    const request = async () => { count += 1; return { status: 500 }; };
    const out = [];
    for (let i = 0; i < 4; i += 1) {
      out.push(await executeKnowledgeTool({
        request: request as never,
        serviceUrl: 'http://127.0.0.1:8421/v3',
        knowledgeId: 'wiki-1',
        toolName: 'search',
        params: { query: 'q' },
        health,
      }));
    }
    expect(count).toBe(3);
    expect(out[0].reason).toBe('http_500');
    expect(out[3].reason).toBe('circuit_open');
    expect(out[3].health).toMatch(/^open\(http_500, 3/u);
  });

  it('the two legs are independent: a tripped core leg leaves the tools leg closed', async () => {
    const coreHealth = createSegmentHealth({ name: 'knowledge-core' });
    const toolsHealth = createSegmentHealth({ name: 'knowledge-tools' });
    for (let i = 0; i < 3; i += 1) {
      await fetchKnowledgeSegment({
        call: (async () => coreFail()) as never,
        identity: { teamId: 'team-1' },
        config,
        health: coreHealth,
      });
    }
    expect(coreHealth.describe()).toMatch(/^open\(/u);
    expect(toolsHealth.describe()).toBe('closed');
    expect(toolsHealth.shouldAttempt()).toBe(true);
  });

  it('bad_tool (no request at all) does not count as a segment failure', async () => {
    const health = createSegmentHealth({ name: 'knowledge-tools', threshold: 1 });
    const result = await executeKnowledgeTool({
      serviceUrl: 'http://127.0.0.1:8421/v3',
      knowledgeId: 'wiki-1',
      toolName: '',
      health,
    });
    expect(result.reason).toBe('bad_tool');
    expect(health.describe()).toBe('closed');
  });

  it('registerVolatileKnowledgeSegment passes the core-leg breaker through', async () => {
    const health = createSegmentHealth({ name: 'knowledge-core' });
    const { registerVolatileKnowledgeSegment } = await import('../src/knowledge-segment.js');
    const handle = registerVolatileKnowledgeSegment({
      call: (async () => coreFail()) as never,
      identity: { teamId: 'team-1' },
      health,
    });
    expect(handle.health).toBe(health);
    for (let i = 0; i < 3; i += 1) await handle.retrieve();
    expect(health.describe()).toMatch(/^open\(transport, 3/u);
    const blocked = await handle.retrieve();
    expect(blocked.diagnostic.reason).toBe('circuit_open');
  });
});
