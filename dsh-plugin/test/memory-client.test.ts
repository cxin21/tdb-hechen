import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { MemoryClient, type MemoryClientDeps } from '../src/memory-client.js';
import { ATOMIC_ITEMS, PERSONA, SCENARIO_ENTRIES, callsTo, coreFixture, envelope } from './helpers/core-fixtures.js';

function createClient(fetchImpl: typeof fetch, overrides: Partial<MemoryClientDeps> = {}): MemoryClient {
  return new MemoryClient({
    baseUrl: 'http://core.local:8420/',
    apiKeyRef: 'TDB_API_KEY',
    identity: { serviceId: 'default', teamId: 'team-1', agentId: 'agt-1', userId: 'usr-1' },
    requestTimeoutMs: 1000,
    paths: DEFAULT_CONFIG.paths,
    resolveApiKey: async () => 'secret-key',
    ...overrides,
    fetchImpl,
  });
}

describe('memory client (v3 data plane)', () => {
  it('posts the isolation triple to /v3/core/read and returns the persona', async () => {
    const { fetchImpl, calls } = coreFixture();
    const result = await createClient(fetchImpl).readCore();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://core.local:8420/v3/core/read');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ team_id: 'team-1', agent_id: 'agt-1', user_id: 'usr-1' });
    expect(calls[0].headers.authorization).toBe('Bearer secret-key');
    expect(calls[0].headers['x-tdai-service-id']).toBe('default');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(result?.content).toContain('# User Narrative Profile');
    expect(result?.updatedAt).toBe('2026-10-31T00:00:00Z');
  });

  it('treats a non-zero envelope code as a soft failure', async () => {
    const log = { debug: vi.fn() };
    const client = createClient((async () => envelope({}, 1001, 'bad key')) as unknown as typeof fetch, { log });
    await expect(client.readCore()).resolves.toBeUndefined();
    expect(log.debug).toHaveBeenCalled();
    expect(String(log.debug.mock.calls[0][0])).toContain('code=1001');
  });

  it('maps the real atomic/search item shape onto RecallHit', async () => {
    const { fetchImpl, calls } = coreFixture();
    const hits = await createClient(fetchImpl).searchAtomic('pnpm 偏好', 5);

    expect(calls[0].path).toBe('/v3/atomic/search');
    expect(calls[0].body).toEqual({ team_id: 'team-1', agent_id: 'agt-1', user_id: 'usr-1', query: 'pnpm 偏好', limit: 5 });
    expect(hits).toEqual([
      { id: 'mem-1', text: ATOMIC_ITEMS[0].content, score: 0.82, layer: 'work_fact', kind: 'work_fact' },
    ]);
  });

  it('skips blank queries, drops hits without content and clamps the limit', async () => {
    const { fetchImpl, calls } = coreFixture({ items: [{ id: 'x', score: 0.1 }, { id: 'y', type: 'episodic', content: 'kept' }] });
    const client = createClient(fetchImpl);

    await expect(client.searchAtomic('   ', 5)).resolves.toEqual([]);
    expect(calls).toHaveLength(0);

    await client.searchAtomic('q', 999);
    expect(callsTo(calls, '/v3/atomic/search')[0].body.limit).toBe(50);
    await client.searchAtomic('q', 0);
    expect(callsTo(calls, '/v3/atomic/search')[1].body.limit).toBe(1);

    const hits = await client.searchAtomic('q', 5);
    expect(hits).toEqual([{ id: 'y', text: 'kept', score: undefined, layer: 'episodic', kind: 'episodic' }]);
  });

  it('parses scenario paths from /v3/scenario/ls and ignores entries without one', async () => {
    const { fetchImpl, calls } = coreFixture({ scenarios: [...SCENARIO_ENTRIES, { summary: 'no path' }, {}] });
    const paths = await createClient(fetchImpl).listScenarios();
    expect(calls[0].path).toBe('/v3/scenario/ls');
    expect(paths).toEqual(['scenes/deploy.md', 'scenes/review.md']);
  });

  it('keeps provenance in the rich scenario read and drops directory entries', async () => {
    const { fetchImpl, calls } = coreFixture({
      scenarios: [
        ...SCENARIO_ENTRIES,
        { path: 'nested/dir/', summary: 'a directory, not a scene' },
        { summary: 'no path' },
      ],
    });
    const outcome = await createClient(fetchImpl).listScenariosRich();

    expect(calls[0].path).toBe('/v3/scenario/ls');
    expect(calls[0].body).toEqual({ team_id: 'team-1', agent_id: 'agt-1', user_id: 'usr-1' });
    expect(outcome).toEqual({
      ok: true,
      // `path` stays the bare filename the endpoint returns; the segment adds the
      // `scene_blocks/` prefix when it renders.
      entries: [
        // Empty string, not undefined: the renderer's `l2Day()` reads '' as
        // 'no date' and sorts those lines last.
        { path: 'scenes/deploy.md', summary: '部署流程', updated: '' },
        { path: 'scenes/review.md', summary: '评审偏好', updated: '' },
      ],
    });
  });

  it('reports why the rich scenario read failed instead of flattening to no scenes', async () => {
    const failing = coreFixture({ fail: () => new Response('nope', { status: 404 }) });
    await expect(createClient(failing.fetchImpl).listScenariosRich()).resolves.toEqual({
      ok: false,
      reason: 'http_404',
    });

    const garbled = coreFixture({ scenarios: { not: 'an array' } as any });
    await expect(createClient(garbled.fetchImpl).listScenariosRich()).resolves.toEqual({
      ok: false,
      reason: 'bad_payload',
    });

    // The legacy read still flattens both cases to [] for its old consumers.
    await expect(createClient(failing.fetchImpl).listScenarios()).resolves.toEqual([]);
  });

  it('combines all three recall legs and survives one failing leg', async () => {
    const { fetchImpl, calls } = coreFixture({
      fail: (path) => (path.endsWith('/v3/atomic/search') ? new Response('boom', { status: 500 }) : undefined),
    });
    const combined = await createClient(fetchImpl).recallCombined('deploy', 5, {
      includePersona: true,
      includeScenarios: true,
    });
    expect(combined.hits).toEqual([]);
    expect(combined.persona).toContain('# User Narrative Profile');
    expect(combined.scenarios).toEqual(['scenes/deploy.md', 'scenes/review.md']);
    expect(calls.map((call) => call.path).sort()).toEqual(['/v3/atomic/search', '/v3/core/read', '/v3/scenario/ls']);
  });

  it('only calls the atomic leg unless persona/scenarios are opted in', async () => {
    const { fetchImpl, calls } = coreFixture();
    const combined = await createClient(fetchImpl).recallCombined('q', 5);
    expect(calls.map((call) => call.path)).toEqual(['/v3/atomic/search']);
    expect(combined.persona).toBeUndefined();
    expect(combined.scenarios).toEqual([]);
    expect(combined.hits).toHaveLength(1);
  });

  it('writes conversations with a string content and ISO timestamps', async () => {
    const { fetchImpl, calls } = coreFixture();
    const ok = await createClient(fetchImpl).addConversation('sess-1', [
      { role: 'user', content: '问题', timestamp: '2026-10-31T10:00:00.000Z' },
      { role: 'assistant', content: '答案', timestamp: '2026-10-31T10:00:05.000Z' },
    ]);
    expect(ok).toBe(true);
    expect(calls[0].path).toBe('/v3/conversation/add');
    expect(calls[0].body).toEqual({
      team_id: 'team-1',
      agent_id: 'agt-1',
      user_id: 'usr-1',
      session_id: 'sess-1',
      messages: [
        { role: 'user', content: '问题', timestamp: '2026-10-31T10:00:00.000Z' },
        { role: 'assistant', content: '答案', timestamp: '2026-10-31T10:00:05.000Z' },
      ],
    });
  });

  it('repairs numeric timestamps and drops empty messages before writing', async () => {
    const { fetchImpl, calls } = coreFixture();
    const ok = await createClient(fetchImpl).addConversation('sess-1', [
      { role: 'assistant', content: 'answer', timestamp: 1_700_000_000 as unknown as string },
      { role: 'user', content: '   ', timestamp: '2026-10-31T10:00:00.000Z' },
    ]);
    expect(ok).toBe(true);
    const messages = calls[0].body.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('answer');
    expect(messages[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('shards a long L0 turn at 100 messages, in order, without losing any', async () => {
    const { fetchImpl, calls } = coreFixture();
    const many = Array.from({ length: 250 }, (_value, index) => ({
      role: 'user' as const,
      content: 'm' + index,
      timestamp: '2026-10-31T10:00:00.000Z',
    }));
    const result = await createClient(fetchImpl).addConversationResult('sess-1', many);
    expect(result.ok).toBe(true);
    expect(result.chunks).toBe(3);
    expect(calls).toHaveLength(3);
    // Every request is inside the core's batch limit…
    for (const call of calls) expect(call.body.messages.length).toBeLessThanOrEqual(100);
    expect(calls.map((call) => call.body.messages.length)).toEqual([100, 100, 50]);
    // …and the union is the original turn, in order.
    const sent = calls.flatMap((call) => call.body.messages.map((message: any) => message.content));
    expect(sent).toEqual(many.map((message) => message.content));
  });

  it('clips an L0 message at 8192 chars before sending it', async () => {
    const { fetchImpl, calls } = coreFixture();
    const result = await createClient(fetchImpl).addConversationResult('sess-1', [
      { role: 'user', content: 'u'.repeat(12000), timestamp: '2026-10-31T10:00:00.000Z' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(1);
    const content = calls[0].body.messages[0].content as string;
    expect(content.length).toBeLessThanOrEqual(8192);
    expect(content).toContain('[truncated: 12000 chars]');
  });

  it('normalizes offset timestamps to UTC and drops only the unparseable rows', async () => {
    const { fetchImpl, calls } = coreFixture();
    const result = await createClient(fetchImpl).addConversationResult('sess-1', [
      { role: 'user', content: '带时区', timestamp: '2026-10-31T18:00:00+08:00' },
      { role: 'assistant', content: '坏时间戳', timestamp: 'not-a-date' },
      { role: 'user', content: '没问题', timestamp: '2026-10-31T10:00:05.000Z' },
    ]);
    expect(result.ok).toBe(true);
    // core only accepts z.iso.datetime(): '+' offsets and numbers are a 400.
    expect(result.invalid).toBe(1);
    const messages = calls[0].body.messages;
    expect(messages.map((message: any) => message.content)).toEqual(['带时区', '没问题']);
    expect(messages[0].timestamp).toBe('2026-10-31T10:00:00.000Z');
    expect(messages[1].timestamp).toBe('2026-10-31T10:00:05.000Z');
  });

  it('treats HTTP 200 with a non-zero business code as a failure', async () => {
    // The skill route answers 200 + code 40001 when validation fails; success
    // must be decided by the envelope, not by the status line.
    const client = createClient((async () => envelope({}, 40001, 'bad payload shape')) as unknown as typeof fetch);
    const result = await client.addConversationResult('sess-1', [
      { role: 'user', content: 'q', timestamp: '2026-10-31T10:00:00.000Z' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(40001);
    expect(result.reason).toContain('40001');
    expect(result.reason).toContain('bad payload shape');
  });

  it('splits a 900KB L0 turn by bytes, not only by message count', async () => {
    const { fetchImpl, calls } = coreFixture();
    // 40 messages x 8000 CJK chars ≈ 960KB of UTF-8 (3 bytes per char): inside
    // the 100-message batch limit but far inside the core's 1 MiB socket wall,
    // where an oversized body is answered with a silent ECONNRESET.
    const cjk = '中'.repeat(8000);
    const many = Array.from({ length: 40 }, () => ({
      role: 'user' as const,
      content: cjk,
      timestamp: '2026-10-31T10:00:00.000Z',
    }));
    const result = await createClient(fetchImpl).addConversationResult('sess-1', many);
    expect(result.ok).toBe(true);
    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(calls).toHaveLength(result.chunks as number);
    for (const call of calls) {
      expect(Buffer.byteLength(JSON.stringify(call.body))).toBeLessThanOrEqual(700000);
    }
    // No turn content is lost: the shards still carry all 40 messages in order.
    const sent = calls.flatMap((call) => call.body.messages);
    expect(sent).toHaveLength(40);
    expect(sent.every((message: any) => message.content === cjk)).toBe(true);
  });

  it('clips a single message that alone exceeds the byte budget', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl, { maxRequestBytes: 4000 });
    const result = await client.addConversationResult('sess-1', [
      { role: 'user', content: '中'.repeat(8000), timestamp: '2026-10-31T10:00:00.000Z' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(1);
    expect(calls).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(calls[0].body))).toBeLessThanOrEqual(4000);
    const content = calls[0].body.messages[0].content as string;
    expect(content).toContain('…[truncated]');
    expect(content.isWellFormed()).toBe(true);
  });

  it('reports the failing shard instead of dropping the whole turn', async () => {
    let seen = 0;
    const { fetchImpl, calls } = coreFixture({
      fail: (endpoint: string) => {
        if (!endpoint.endsWith('/v3/conversation/add')) return undefined;
        seen += 1;
        return seen === 2 ? new Response('boom', { status: 500 }) : undefined;
      },
    });
    const many = Array.from({ length: 150 }, (_value, index) => ({
      role: 'user' as const,
      content: 'm' + index,
      timestamp: '2026-10-31T10:00:00.000Z',
    }));
    const result = await createClient(fetchImpl).addConversationResult('sess-1', many);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.reason).toContain('chunk 2/2');
    expect(calls).toHaveLength(2);
  });

  it('refuses to write without a session id or with nothing to write', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl);
    await expect(client.addConversation('  ', [{ role: 'user', content: 'x', timestamp: '2026-10-31T10:00:00.000Z' }])).resolves.toBe(false);
    await expect(client.addConversation('sess-1', [])).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('deletes a session through /v3/conversation/delete', async () => {
    const { fetchImpl, calls } = coreFixture();
    await expect(createClient(fetchImpl).deleteConversation('sess-1')).resolves.toBe(true);
    expect(calls[0].body).toEqual({ team_id: 'team-1', agent_id: 'agt-1', user_id: 'usr-1', session_ids: ['sess-1'] });
  });

  it('fails open on transport errors, timeouts and non-JSON bodies', async () => {
    const log = { debug: vi.fn() };
    const refused = createClient((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch, { log });
    await expect(refused.readCore()).resolves.toBeUndefined();
    await expect(refused.searchAtomic('q', 5)).resolves.toEqual([]);
    await expect(refused.addConversation('sess-1', [{ role: 'user', content: 'x', timestamp: '2026-10-31T10:00:00.000Z' }])).resolves.toBe(false);

    const timedOut = createClient((async () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch, { log });
    await expect(timedOut.readCore()).resolves.toBeUndefined();
    expect(log.debug.mock.calls.some((call) => String(call[0]).includes('timed out'))).toBe(true);

    const garbage = createClient((async () => new Response('not json', { status: 200 })) as unknown as typeof fetch, { log });
    await expect(garbage.readCore()).resolves.toBeUndefined();
  });


  it('cancels its own request at the budget and tells that apart from a network failure', async () => {
    let seen: AbortSignal | undefined;
    const hanging = createClient((async (_input: any, init: any = {}) => {
      seen = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch);

    const aborted = await hanging.recallBlock('pnpm 用什么?', { timeoutMs: 100 });
    expect(aborted.ok).toBe(false);
    // We cancelled it — the socket is gone, not merely ignored.
    expect(aborted.aborted).toBe(true);
    expect(aborted.reason).toBe('timed out after 100ms');
    expect(seen?.aborted).toBe(true);

    // A dead socket is a different diagnosis and carries no abort flag.
    const refused = createClient((async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    const failed = await refused.recallBlock('q', { timeoutMs: 100 });
    expect(failed.ok).toBe(false);
    expect(failed.aborted).toBeUndefined();
    expect(failed.reason).toContain('transport failure:');
    expect(failed.reason).toContain('ECONNREFUSED');
  });

  it('stays inert when the isolation identity is incomplete', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl, {
      identity: { serviceId: 'default', teamId: '', agentId: 'agt-1', userId: 'usr-1' },
    });
    await expect(client.readCore()).resolves.toBeUndefined();
    await expect(client.searchAtomic('q', 5)).resolves.toEqual([]);
    await expect(client.addConversation('sess-1', [{ role: 'user', content: 'x', timestamp: '2026-10-31T10:00:00.000Z' }])).resolves.toBe(false);
    await expect(client.health()).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('keeps the request alive when credential resolution throws', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl, {
      resolveApiKey: async () => { throw new Error('no keychain'); },
    });
    await expect(client.readCore()).resolves.toBeDefined();
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].headers['x-tdai-service-id']).toBe('default');
  });

  it('answers health from the probe endpoint only', async () => {
    const { fetchImpl, calls } = coreFixture();
    await expect(createClient(fetchImpl).health()).resolves.toBe(true);
    expect(calls[0].path).toBe('/health');
    expect(calls[0].method).toBe('GET');

    const down = createClient((async () => new Response('nope', { status: 503 })) as unknown as typeof fetch);
    await expect(down.health()).resolves.toBe(false);
  });

  it('keeps recall() as the atomic-search alias used by the tool', async () => {
    const { fetchImpl, calls } = coreFixture();
    const hits = await createClient(fetchImpl).recall('deploy', 3, 900);
    expect(hits).toHaveLength(1);
    expect(calls[0].body.limit).toBe(3);
    expect(PERSONA.length).toBeGreaterThan(0);
  });
});

describe('memory client (skill / L2 pipeline)', () => {
  it('writes the skill buffer with epoch-ms timestamps, not ISO', async () => {
    const { fetchImpl, calls } = coreFixture();
    const result = await createClient(fetchImpl).skillConversationAdd('sess-1', [
      { role: 'user', content: '问题', timestamp: 1_793_453_479_606 },
      { role: 'assistant', content: '答案' },
    ]);

    expect(result.ok).toBe(true);
    expect(calls[0].path).toBe('/v3/skill/conversation/add');
    expect(calls[0].body).toEqual({
      team_id: 'team-1',
      agent_id: 'agt-1',
      user_id: 'usr-1',
      session_id: 'sess-1',
      messages: [
        { role: 'user', content: '问题', timestamp: 1_793_453_479_606 },
        { role: 'assistant', content: '答案' },
      ],
    });
    // The L0 face takes ISO; this face must never echo one.
    expect(typeof calls[0].body.messages[0].timestamp).toBe('number');
    expect(JSON.stringify(calls[0].body)).not.toContain('T10:00:00');
  });

  it('converts ISO stamps from the writeback payload into epoch ms', async () => {
    const { fetchImpl, calls } = coreFixture();
    await createClient(fetchImpl).skillConversationAdd('sess-1', [
      { role: 'user', content: 'q', timestamp: '2026-10-31T10:00:00.000Z' as unknown as number },
    ]);
    expect(calls[0].body.messages[0].timestamp).toBe(Date.parse('2026-10-31T10:00:00.000Z'));
  });

  it("refuses ids containing '|' (Redis queue separator) without a request", async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl);

    const piped = await client.skillConversationAdd('sess|1', [{ role: 'user', content: 'x' }]);
    expect(piped).toEqual({ ok: false, reason: "session_id must not contain '|'" });

    const pipedTeam = createClient(fetchImpl, {
      identity: { serviceId: 'default', teamId: 'team|1', agentId: 'agt-1', userId: 'usr-1' },
    });
    const team = await pipedTeam.skillConversationAdd('sess-1', [{ role: 'user', content: 'x' }]);
    expect(team.ok).toBe(false);
    expect(team.reason).toContain('team_id');
    expect(calls).toHaveLength(0);
  });

  it('keeps complete tool pairs and drops half-specified ones instead of inventing ids', async () => {
    const { fetchImpl, calls } = coreFixture();
    await createClient(fetchImpl).skillConversationAdd('sess-1', [
      { role: 'user', content: 'q' },
      { role: 'tool_call', content: '{}', tool_name: 'bash' },
      { role: 'tool_call', content: '{"cmd":"ls"}', tool_name: 'bash', tool_call_id: 'call-1' },
      { role: 'tool_result', content: 'a.txt', tool_name: 'bash', tool_call_id: 'call-1' },
      // 'system' is part of the skill schema, so it must survive.
      { role: 'system', content: 'context' },
    ]);
    expect(calls[0].body.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'tool_call', content: '{"cmd":"ls"}', tool_name: 'bash', tool_call_id: 'call-1' },
      { role: 'tool_result', content: 'a.txt', tool_name: 'bash', tool_call_id: 'call-1' },
      { role: 'system', content: 'context' },
    ]);
  });

  it('reports the HTTP status and marks an answered request as NOT retryable', async () => {
    const client = createClient((async () => new Response('nope', { status: 500 })) as unknown as typeof fetch);
    const result = await client.skillConversationAdd('sess-1', [{ role: 'user', content: 'q' }]);
    expect(result).toMatchObject({ ok: false, status: 500, reason: 'HTTP 500' });
    // The skill buffer has no server-side dedupe: even a 500 may have mutated
    // it, so a replay would double-count the turn.
    expect(result.retryable).toBe(false);
  });

  it('surfaces a 200 + business-code rejection from the skill route', async () => {
    const client = createClient((async () => envelope({}, 40001, 'tool_call_id missing')) as unknown as typeof fetch);
    const result = await client.skillConversationAdd('sess-1', [{ role: 'user', content: 'q' }]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(40001);
    expect(result.reason).toContain('40001');
    expect(result.retryable).toBe(false);
  });

  it('marks a request that never reached the core as retryable', async () => {
    const calls: any[] = [];
    const client = createClient((async (url: string, init: any) => {
      calls.push({ url, init });
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch);
    const result = await client.skillConversationAdd('sess-1', [{ role: 'user', content: 'q' }]);
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.reason).toContain('ECONNREFUSED');
    expect(result.retryable).toBe(true);
  });

  it('shards a long skill batch at 500 in order and never clips it away', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl);
    const many = Array.from({ length: 620 }, (_value, index) => ({ role: 'user' as const, content: 'm' + index }));
    const result = await client.skillConversationAdd('sess-1', many);
    expect(result.ok).toBe(true);
    expect(result.chunks).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.messages).toHaveLength(500);
    expect(calls[1].body.messages).toHaveLength(120);
    // Order is preserved across the boundary.
    expect(calls[1].body.messages[0].content).toBe('m500');

    await expect(client.skillConversationAdd('sess-1', [{ role: 'user', content: '   ' }])).resolves.toEqual({
      ok: false,
      reason: 'nothing to write',
    });
  });

  it('clips an oversized skill message at the 8192-char wire limit, surrogate-safe', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl);
    // 9000 chars ending in an emoji pair right at the cut point.
    const body = 'x'.repeat(8191) + '\u{1F600}' + 'y'.repeat(800);
    await client.skillConversationAdd('sess-1', [{ role: 'user', content: body }]);
    const sent = calls[0].body.messages[0].content as string;
    expect(sent.length).toBeLessThanOrEqual(8192);
    expect(sent).toContain('[truncated: ');
    // No lone surrogate survived the cut.
    expect(sent.isWellFormed()).toBe(true);
  });
});

describe('recall block (DS-RECALL-MERGE-001)', () => {
  it('posts the query plus maxResults and carries the session on both body and header', async () => {
    const { fetchImpl, calls } = coreFixture();
    const result = await createClient(fetchImpl).recallBlock('部署怎么走', { maxResults: 2, sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect(result.block).toContain('<relevant-memories>');
    expect(result.meta?.perfMs).toBe(170);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/v3/recall');
    expect(calls[0].body).toEqual({ query: '部署怎么走', maxResults: 2, session_id: 's1' });
    expect(calls[0].headers['x-tdai-session-id']).toBe('s1');
    expect(calls[0].headers.authorization).toBe('Bearer secret-key');
    // P0-1: every v3 route, recall included, validates the isolation triple from
    // the HEADERS before the handler. Body-only isolation answered 422 forever.
    expect(calls[0].headers['x-tdai-team-id']).toBe('team-1');
    expect(calls[0].headers['x-tdai-agent-id']).toBe('agt-1');
    expect(calls[0].headers['x-tdai-user-id']).toBe('usr-1');
    expect(calls[0].headers['x-tdai-service-id']).toBe('default');
    // …and the recall body stays exactly what its schema declares.
    expect(calls[0].body.team_id).toBeUndefined();
  });

  it('defaults maxResults to 3 and clamps it to 1..10', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl);
    await client.recallBlock('q');
    await client.recallBlock('q', { maxResults: 0 });
    await client.recallBlock('q', { maxResults: 99 });
    expect(calls.map((call) => call.body.maxResults)).toEqual([3, 1, 10]);
    // Stateless call: no session header leaks when the caller has no session.
    expect(calls[0].headers['x-tdai-session-id']).toBeUndefined();
    expect(calls[0].body.session_id).toBeUndefined();
  });

  it('surfaces 404 as "endpoint disabled" and 504 as "upstream timeout" without throwing', async () => {
    for (const status of [404, 504]) {
      const client = createClient((async () => new Response('nope', { status })) as unknown as typeof fetch);
      await expect(client.recallBlock('q')).resolves.toEqual({ ok: false, status, reason: 'HTTP ' + status });
    }
  });

  it('reports an empty block and a transport error as failures, never as an empty success', async () => {
    const empty = createClient((async () => envelope({ block: '   ', meta: {} })) as unknown as typeof fetch);
    await expect(empty.recallBlock('q')).resolves.toEqual({ ok: false, reason: 'empty recall block' });

    const down = createClient((async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    const result = await down.recallBlock('q');
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(String(result.reason)).toContain('ECONNREFUSED');
  });

  it('does not call out for a blank query', async () => {
    const { fetchImpl, calls } = coreFixture();
    await expect(createClient(fetchImpl).recallBlock('   ')).resolves.toEqual({ ok: false, reason: 'empty query' });
    expect(calls).toHaveLength(0);
  });
  describe('identity resolution (metadata routes)', () => {
    /**
     * Local fixture: these routes live outside the data-plane fixture and the
     * shapes matter (items/total envelope, x-tdai-user-key header, no isolation
     * echo), so they get their own tiny router.
     */
    function metaFixture(
      route: (path: string, body: any) => Response | undefined,
    ): { fetchImpl: typeof fetch; calls: { path: string; body: any; headers: Record<string, string> }[] } {
      const calls: { path: string; body: any; headers: Record<string, string> }[] = [];
      const fetchImpl = (async (input: unknown, init: any) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ path: url.pathname, body, headers: (init?.headers ?? {}) as Record<string, string> });
        return route(url.pathname, body) ?? envelope({});
      }) as unknown as typeof fetch;
      return { fetchImpl, calls };
    }

    const emptyIdentity = { serviceId: 'default', teamId: '', agentId: '', userId: '' };

    it('verifies a user key without needing the isolation triple', async () => {
      const { fetchImpl, calls } = metaFixture((path) =>
        path === '/v3/meta/auth/verify'
          ? envelope({ valid: true, user: { user_id: 'usr-9', username: 'alice' } })
          : undefined,
      );
      const client = createClient(fetchImpl, { identity: emptyIdentity });
      const result = await client.verifyUserKey('  user-key-abc  ');

      expect(result).toEqual({ ok: true, valid: true, userId: 'usr-9', username: 'alice' });
      expect(calls).toHaveLength(1);
      expect(calls[0].path).toBe('/v3/meta/auth/verify');
      expect(calls[0].body).toEqual({ user_key: 'user-key-abc' });
      // Bearer + service id are still required; the triple is not (and must not
      // be invented).
      expect(calls[0].headers.authorization).toBe('Bearer secret-key');
      expect(calls[0].headers['x-tdai-service-id']).toBe('default');
      expect(calls[0].headers['x-tdai-team-id']).toBeUndefined();
    });

    it('reports an invalid key as a answered "valid: false", not as an error', async () => {
      const { fetchImpl } = metaFixture(() => envelope({ valid: false, user: null }));
      await expect(createClient(fetchImpl, { identity: emptyIdentity }).verifyUserKey('nope'))
        .resolves.toEqual({ ok: true, valid: false, userId: undefined, username: undefined });
    });

    it('keeps the HTTP status for verify failures and reports 401 as an auth failure', async () => {
      const onAuthFailure = vi.fn();
      const notFound = metaFixture(() => new Response('nope', { status: 404 }));
      await expect(createClient(notFound.fetchImpl, { identity: emptyIdentity }).verifyUserKey('k'))
        .resolves.toEqual({ ok: false, status: 404, reason: 'HTTP 404' });

      const unauthorized = metaFixture(() => new Response('nope', { status: 401 }));
      const client = createClient(unauthorized.fetchImpl, { identity: emptyIdentity, onAuthFailure });
      await expect(client.verifyUserKey('k')).resolves.toEqual({ ok: false, status: 401, reason: 'HTTP 401' });
      // Verify's only 401 cause is the CORE key (Bearer), so it is reported.
      expect(onAuthFailure).toHaveBeenCalledWith({ path: '/v3/meta/auth/verify', status: 401 });
    });

    it('does not call out for a blank user key', async () => {
      const { fetchImpl, calls } = metaFixture(() => undefined);
      await expect(createClient(fetchImpl, { identity: emptyIdentity }).verifyUserKey('   '))
        .resolves.toEqual({ ok: false, reason: 'empty user key' });
      expect(calls).toHaveLength(0);
    });

    it('lists teams with the user key header and maps entity fields', async () => {
      const { fetchImpl, calls } = metaFixture((path) =>
        path === '/v3/meta/team/list'
          ? envelope({ items: [{ team_id: 'team-1', name: 'Alpha', owner_user_id: 'usr-9' }], total: 1, limit: 100, offset: 0 })
          : undefined,
      );
      const result = await createClient(fetchImpl, { identity: emptyIdentity })
        .listTeams('usr-9', { userKey: 'user-key-abc' });

      expect(result).toEqual({ ok: true, items: [{ teamId: 'team-1', name: 'Alpha' }], total: 1 });
      expect(calls[0].path).toBe('/v3/meta/team/list');
      expect(calls[0].body).toEqual({ user_id: 'usr-9', limit: 100 });
      expect(calls[0].headers['x-tdai-user-key']).toBe('user-key-abc');
      // No triple echo: these schemas are strict objects.
      expect(calls[0].body.team_id).toBeUndefined();
    });

    it('returns an empty list without failing when the user belongs to no team', async () => {
      const { fetchImpl } = metaFixture(() => envelope({ items: [], total: 0 }));
      await expect(createClient(fetchImpl, { identity: emptyIdentity }).listTeams('usr-9', { userKey: 'k' }))
        .resolves.toEqual({ ok: true, items: [], total: 0 });
    });

    it('keeps a team-list 401 as a user-key failure, not a core-key one', async () => {
      const onAuthFailure = vi.fn();
      const { fetchImpl } = metaFixture(() => new Response(
        JSON.stringify({ code: 401, message: 'unauthorized: missing_user_key' }),
        { status: 401 },
      ));
      const client = createClient(fetchImpl, { identity: emptyIdentity, onAuthFailure });
      await expect(client.listTeams('usr-9', { userKey: 'bad' }))
        .resolves.toEqual({ ok: false, items: [], status: 401, reason: 'HTTP 401' });
      expect(onAuthFailure).not.toHaveBeenCalled();
    });

    it('lists agents for one team filtered by owner', async () => {
      const { fetchImpl, calls } = metaFixture((path) =>
        path === '/v3/meta/agent/list'
          ? envelope({
            items: [
              { agent_id: 'agt-1', team_id: 'team-1', name: 'Main', owner_user_id: 'usr-9' },
              { agent_id: 'agt-2', team_id: 'team-1', name: 'Side', owner_user_id: 'usr-9' },
            ],
            total: 2,
          })
          : undefined,
      );
      const result = await createClient(fetchImpl, { identity: emptyIdentity })
        .listAgents('team-1', 'usr-9', { userKey: 'user-key-abc' });

      expect(result.ok).toBe(true);
      expect(result.items.map((item) => item.agentId)).toEqual(['agt-1', 'agt-2']);
      expect(result.total).toBe(2);
      expect(calls[0].body).toEqual({ team_id: 'team-1', owner_user_id: 'usr-9', limit: 100 });
      expect(calls[0].headers['x-tdai-user-key']).toBe('user-key-abc');
    });

    it('caps the metadata page size at the core limit of 100', async () => {
      const { fetchImpl, calls } = metaFixture(() => envelope({ items: [] }));
      const client = createClient(fetchImpl, { identity: emptyIdentity });
      await client.listTeams('usr-9', { userKey: 'k', limit: 500 });
      await client.listAgents('team-1', 'usr-9', { userKey: 'k', limit: 0 });
      expect(calls[0].body.limit).toBe(100);
      expect(calls[1].body.limit).toBe(1);
    });

    it('rejects an empty team id for the agent list without calling out', async () => {
      const { fetchImpl, calls } = metaFixture(() => undefined);
      await expect(createClient(fetchImpl, { identity: emptyIdentity }).listAgents('  ', 'usr-9', { userKey: 'k' }))
        .resolves.toEqual({ ok: false, items: [], reason: 'empty team id' });
      expect(calls).toHaveLength(0);
    });
  });
});

/**
 * task-69: the core's ownership check (task-60) keys on x-tdai-user-key. The
 * transport now attaches it to every call that carries the complete isolation
 * triple, and refuses to send an empty one (a blank header would claim
 * "identity supplied, and empty", which is worse than absent).
 */
describe('user-key identity header (task-69)', () => {
  it('attaches x-tdai-user-key from an inline key on data-plane calls', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl, { userKey: 'user-key-abc' });
    await client.recallBlock('部署怎么走');

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/v3/recall');
    expect(calls[0].headers['x-tdai-user-key']).toBe('user-key-abc');
    // The triple it qualifies is still on the same request.
    expect(calls[0].headers['x-tdai-team-id']).toBe('team-1');
    expect(calls[0].headers['x-tdai-user-id']).toBe('usr-1');
  });

  it('falls back to resolveUserKey (the credentials ref) when no inline key is set', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl, {
      userKey: '   ',
      resolveUserKey: async () => '  resolved-key  ',
    });
    await client.readCore();

    expect(calls[0].headers['x-tdai-user-key']).toBe('resolved-key');
  });

  it('omits the header entirely when no key resolves — never sends an empty string', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl);
    await expect(client.recallBlock('q')).resolves.toMatchObject({ ok: true });

    expect(Object.prototype.hasOwnProperty.call(calls[0].headers, 'x-tdai-user-key')).toBe(false);
    expect(calls[0].headers['x-tdai-user-key']).toBeUndefined();
  });

  it('treats a blank resolved key as "not resolved"', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl, { resolveUserKey: async () => '   ' });
    await client.recallBlock('q');

    expect(Object.prototype.hasOwnProperty.call(calls[0].headers, 'x-tdai-user-key')).toBe(false);
  });

  it('degrades to an omitted header when ref resolution throws, and still sends the call', async () => {
    const { fetchImpl, calls } = coreFixture();
    const log = { debug: vi.fn() };
    const client = createClient(fetchImpl, {
      log,
      resolveUserKey: async () => { throw new Error('no keychain'); },
    });
    await expect(client.recallBlock('q')).resolves.toMatchObject({ ok: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].headers['x-tdai-user-key']).toBeUndefined();
    expect(String(log.debug.mock.calls.map((call) => call[0]).join('\n')))
      .toContain('user key resolution failed');
  });

  it('never sends the header while the isolation triple is incomplete', async () => {
    // A metadata route keeps running without the triple (requireIdentity:false),
    // which is exactly the window where an identity header must not appear.
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl, {
      identity: { serviceId: 'default', teamId: 'team-1', agentId: '', userId: 'usr-1' },
      userKey: 'user-key-abc',
    });
    await client.listTeams('usr-9');

    expect(calls).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(calls[0].headers, 'x-tdai-user-key')).toBe(false);
  });

  it('reports presence only — the key value never reaches the debug log', async () => {
    const { fetchImpl } = coreFixture();
    const log = { debug: vi.fn() };
    await createClient(fetchImpl, { log, userKey: 'user-key-abc' }).recallBlock('q');

    const logged = JSON.stringify(log.debug.mock.calls);
    expect(logged).toContain('x-tdai-user-key attached');
    expect(logged).not.toContain('user-key-abc');
  });

  it('resolves the key once per client, not once per request', async () => {
    const { fetchImpl, calls } = coreFixture();
    const resolveUserKey = vi.fn(async () => 'user-key-abc');
    const client = createClient(fetchImpl, { resolveUserKey });
    await client.recallBlock('q1');
    await client.recallBlock('q2');

    expect(calls).toHaveLength(2);
    expect(resolveUserKey).toHaveBeenCalledTimes(1);
    expect(calls[1].headers['x-tdai-user-key']).toBe('user-key-abc');
  });

  it('lets an explicit extra header win over the resolved key (metadata routes)', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl, { userKey: 'from-config' });
    await client.listTeams('usr-9', { userKey: 'explicit-key' });

    expect(calls[0].headers['x-tdai-user-key']).toBe('explicit-key');
  });
});
