import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../src/index.js';
import { ATOMIC_ITEMS, callsTo, coreFixture } from './helpers/core-fixtures.js';
import { createFakeContext, runPreStep, type FakeContext } from './helpers/fake-ctx.js';
import { userMessage } from './helpers/messages.js';
import { VOLATILE_SOURCE_KIND } from '../src/volatile.js';

/**
 * Cross-module pipeline test: one real turn driven through every seam the
 * plugin touches, asserted at the last observable point (the outbox payload
 * that the writeback layer produces). The per-module suites prove each piece;
 * this one proves they compose — the failure mode that unit tests miss.
 *
 * The core fixture rejects `/v3/conversation/add` so that delivery fails *after*
 * the payload is queued: the entry then stays in the JSONL outbox where the
 * test can read exactly what the plugin would have sent.
 */

const TEST_IDENTITY = { teamId: 'team-test', agentId: 'agt-test', userId: 'usr-test' };
const applied: FakeContext[] = [];
const tempDirs: string[] = [];

function tempOutbox(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agemem-pipeline-'));
  tempDirs.push(dir);
  return path.join(dir, 'outbox.jsonl');
}

function installFetch(options?: Parameters<typeof coreFixture>[0]) {
  const fixture = coreFixture(options);
  vi.stubGlobal('fetch', vi.fn(fixture.fetchImpl));
  return fixture;
}

async function startApp(outboxPath: string): Promise<FakeContext> {
  const fake = createFakeContext();
  applied.push(fake);
  await apply(fake.ctx, { server: TEST_IDENTITY, writeback: { outboxPath } });
  return fake;
}

function undeliveredPayloads(outboxPath: string): any[] {
  try {
    return readFileSync(outboxPath, 'utf8')
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
      .map((entry) => entry.payload)
      .filter((payload) => payload !== undefined && payload !== null);
  } catch {
    return [];
  }
}

/** The skill feed is dead-lettered on the first HTTP answer, so read those rows too. */
function deadPayloads(outboxPath: string): any[] {
  const deadPath = outboxPath.replace(/\.jsonl$/, '.dead.jsonl');
  try {
    return readFileSync(deadPath, 'utf8')
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
      .map((entry) => entry.payload)
      .filter((payload) => payload !== undefined && payload !== null);
  } catch {
    return [];
  }
}

function rejectWrites() {
  // Matches BOTH write faces: /v3/conversation/add and /v3/skill/conversation/add.
  return (endpoint: string) => (endpoint.endsWith('/conversation/add')
    ? new Response('write rejected by fixture', { status: 500 })
    : undefined);
}

afterEach(() => {
  for (const fake of applied.splice(0)) {
    fake.emit('dispose');
    fake.dispose();
  }
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('turn pipeline (integration)', () => {
  it('carries one turn from pre-step injection to the writeback payload', async () => {
    const fixture = installFetch({ fail: rejectWrites() });
    const outboxPath = tempOutbox();
    const fake = await startApp(outboxPath);

    // 0. Warm-up on agent creation, before any turn exists.
    expect(callsTo(fixture.calls, '/v3/recall')).toHaveLength(0);
    fake.emit('agent/created', { id: 'a1' });
    await vi.waitFor(() => expect(
      callsTo(fixture.calls, '/v3/recall').some((call) => call.body?.query === 'warmup'),
    ).toBe(true));

    // 1. pre-step: exactly one appended block, the claimed history untouched.
    const listener = fake.firstListener('agent/pre-step');
    if (!listener) throw new Error('pre-step listener not installed');
    const claimed = [userMessage('pnpm 用什么?', 'u1')];
    const decision = await runPreStep(
      listener,
      { agent: { session: { id: 's1' } }, turn: 1, step: 1 },
      { kind: 'enter', messages: claimed },
    );
    expect(decision.kind).toBe('enter');
    expect(decision.messages).toHaveLength(2);
    expect(decision.messages[0]).toBe(claimed[0]);
    const injected = decision.messages[1];
    const blockText: string = injected.content[0].text;
    expect(blockText).toContain('【agemem 记忆提示】');
    // Fed by /v3/recall: only the "- [" memory entries survive, the guidance
    // preamble that duplicates the answer-guidance section is stripped.
    expect(blockText).toContain(ATOMIC_ITEMS[0].content);
    // Every line after the header is either soul or a memory entry; the old
    // shape had memory lines only, so count them explicitly instead of
    // demanding that nothing else rides in the block.
    // Soul fragments now lead the block (task-61 stopped dropping them), so the
    // header is no longer guaranteed to be line 0: drop it by content, keep the
    // rest (soul lines + memory entries) and assert on that.
    const bodyLines = blockText
      .split(String.fromCharCode(10))
      .slice(1)
      .filter((line) => line !== '' && !line.startsWith('【agemem 记忆提示】'));
    expect(bodyLines.filter((line) => line.startsWith('- [')).length).toBeGreaterThan(0);
    expect(bodyLines.every((line) => line.startsWith('- [') || line.startsWith('<soul-'))).toBe(true);
    expect(blockText).not.toContain('【币值判定规则】');
    expect(blockText).not.toContain('<relevant-memories>');
    expect(callsTo(fixture.calls, '/v3/atomic/search')).toHaveLength(0);
    // The live query asks for 3 results: entries are clipped to 360 chars first,
    // so 2-3 of them fit the 1200-char budget instead of exactly one.
    const liveRecall = callsTo(fixture.calls, '/v3/recall').find((call) => call.body?.query !== 'warmup');
    expect(liveRecall?.body.maxResults).toBe(3);
    // P0-1: the core validates the isolation triple from the HEADERS, so recall
    // must carry them like every v3 write. Body-only isolation = permanent 422.
    expect(liveRecall?.headers['x-tdai-team-id']).toBe('team-test');
    expect(liveRecall?.headers['x-tdai-agent-id']).toBe('agt-test');
    expect(liveRecall?.headers['x-tdai-user-id']).toBe('usr-test');
    expect(liveRecall?.headers['x-tdai-service-id']).toBe('default');
    expect(liveRecall?.body.team_id).toBeUndefined();
    expect(injected.source.kind).toBe(VOLATILE_SOURCE_KIND);

    // 2. The host persists the real user message AND our injected block; only
    //    the former may reach the writeback payload.
    fake.emit('session/event', { id: 's1' }, {
      type: 'user/message',
      data: { turn: 1, timestamp: '2026-10-31T10:00:00.000Z', message: userMessage('pnpm 用什么?', 'u1') },
    });
    fake.emit('session/event', { id: 's1' }, {
      type: 'user/message',
      data: { turn: 1, timestamp: '2026-10-31T10:00:01.000Z', message: injected },
    });
    fake.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: {
        turn: 1,
        timestamp: '2026-10-31T10:00:05.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '用 pnpm。' }] },
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      },
    });

    // 3. Turn close: queued locally, delivery is fire-and-forget. Both
    //    pipelines are attempted in the same turn (L0 facts + L2 scenes).
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1));
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/skill/conversation/add')).toHaveLength(1));

    // The fixture rejected the writes, so the idempotent entries are still
    // queued — that is what the plugin would retry (nothing silently dropped).
    const payload = await vi.waitFor(() => {
      const found = undeliveredPayloads(outboxPath).find((candidate) => candidate.kind === 'l0' && candidate.sessionId === 's1');
      expect(found).toBeDefined();
      return found;
    });

    expect(payload.turnId).toBe('s1:turn:1');
    expect(payload.sessionId).toBe('s1');
    expect(payload.workspaceId).toBe(process.cwd());
    expect(payload.turn).toBe(1);
    expect(payload.status).toBe('completed');

    // messages: order, string content, ISO timestamps.
    expect(payload.messages.map((message: any) => message.role)).toEqual(['user', 'assistant']);
    expect(payload.messages.map((message: any) => message.content)).toEqual(['pnpm 用什么?', '用 pnpm。']);
    for (const message of payload.messages) {
      expect(typeof message.content).toBe('string');
      expect(message.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Number.isNaN(Date.parse(message.timestamp))).toBe(false);
    }
    expect(payload.messages[0].timestamp).toBe('2026-10-31T10:00:00.000Z');
    expect(payload.messages[1].timestamp).toBe('2026-10-31T10:00:05.000Z');

    // usage is passed through untouched.
    expect(payload.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });

    // The injected block is NOT user history: no marker text, no volatile id.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('【agemem 记忆提示】');
    expect(serialized).not.toContain('agemem-volatile');
    expect(serialized).not.toContain(ATOMIC_ITEMS[0].content);

    // ...and the request body is the payload verbatim (index.ts must not rebuild
    // it: a rebuilt array used to drop the user text entirely).
    const call = callsTo(fixture.calls, '/v3/conversation/add')[0];
    expect(call.body.session_id).toBe('s1');
    expect(call.body.messages).toEqual(payload.messages);

    // --- Second chain: the same turn on the skill / L2 wire shape. ---
    // The fixture answers 500, and an answered skill request is never replayed
    // (the L2 buffer has no dedupe), so the row lands in the dead letter file.
    const skill = await vi.waitFor(() => {
      const found = deadPayloads(outboxPath).find((candidate) => candidate.kind === 'skill');
      expect(found).toBeDefined();
      return found;
    });
    // L0 keeps retrying (server-side idempotent), so only the skill row is parked.
    expect(undeliveredPayloads(outboxPath).some((candidate) => candidate.kind === 'skill')).toBe(false);
    expect(skill.turnId).toBe('s1:turn:1:skill');
    expect(skill.sessionId).toBe('s1');
    expect(skill.status).toBe('completed');
    expect(skill.messages.map((message: any) => message.role)).toEqual(['user', 'assistant']);
    expect(skill.messages.map((message: any) => message.content)).toEqual(['pnpm 用什么?', '用 pnpm。']);
    // Epoch milliseconds here, ISO above: the two endpoints take different shapes.
    expect(skill.messages.map((message: any) => typeof message.timestamp)).toEqual(['number', 'number']);
    expect(skill.messages[0].timestamp).toBe(Date.parse(payload.messages[0].timestamp));
    expect(skill.messages[1].timestamp).toBe(Date.parse(payload.messages[1].timestamp));
    expect(JSON.stringify(skill.messages)).not.toContain('【agemem 记忆提示】');
    expect(JSON.stringify(skill.messages)).not.toContain('agemem-volatile');

    const skillCall = callsTo(fixture.calls, '/v3/skill/conversation/add')[0];
    expect(skillCall.body.session_id).toBe('s1');
    expect(skillCall.body.messages).toEqual(skill.messages);
    expect(skillCall.body.messages.map((message: any) => typeof message.timestamp)).toEqual(['number', 'number']);
  });

  it('passes a core that enforces the isolation headers before every v3 route', async () => {
    // Emulates the live server (v2-router.ts:189-193): a v3 call without the
    // three headers is rejected with 422 before the handler runs. The plugin
    // must never end up in that state — a permanent 422 is what hid the merged
    // recall for an entire release.
    const fixture = installFetch({
      fail: (endpoint, call) => {
        if (!endpoint.startsWith('/v3/')) return undefined;
        const missing = ['x-tdai-team-id', 'x-tdai-agent-id', 'x-tdai-user-id']
          .filter((header) => (call.headers[header] ?? '') === '');
        if (missing.length === 0) return undefined;
        return new Response(
          JSON.stringify({ code: 422, message: '/v3 requires strict isolation: missing team_id, agent_id, user_id' }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const fake = await startApp(tempOutbox());
    const listener = fake.firstListener('agent/pre-step');
    if (!listener) throw new Error('pre-step listener not installed');

    const decision = await runPreStep(
      listener,
      { agent: { session: { id: 's1' } }, turn: 1, step: 1 },
      { kind: 'enter', messages: [userMessage('pnpm 用什么?', 'u1')] },
    );

    // Recall answered 200 (headers present) and fed the block; no fallback, no 422.
    expect(decision.messages).toHaveLength(2);
    expect(String((decision.messages[1] as any).content[0].text)).toContain('【agemem');
    expect(callsTo(fixture.calls, '/v3/recall')).toHaveLength(1);
    expect(callsTo(fixture.calls, '/v3/atomic/search')).toHaveLength(0);
    expect(fake.logs.some((line) => line.startsWith('warn') && line.includes('422'))).toBe(false);
  });

  it('records a failed turn as status=error without throwing', async () => {
    installFetch({ fail: rejectWrites() });
    const outboxPath = tempOutbox();
    const fake = await startApp(outboxPath);

    fake.emit('session/event', { id: 's1' }, {
      type: 'user/message',
      data: { turn: 1, timestamp: '2026-10-31T11:00:00.000Z', message: userMessage('这个问题没答完', 'u1') },
    });
    fake.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, timestamp: '2026-10-31T11:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '半截回答' }] } },
    });

    expect(() => fake.emit('session/event', { id: 's1' }, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error' } },
    })).not.toThrow();

    const payload = await vi.waitFor(() => {
      const found = undeliveredPayloads(outboxPath).find((candidate) => candidate.kind === 'l0');
      expect(found).toBeDefined();
      return found;
    });
    expect(payload.status).toBe('error');
    // A half-finished turn must never reach the skill buffer: it would archive
    // an unanswered question and poison the L2 extractor.
    expect(undeliveredPayloads(outboxPath).some((candidate) => candidate.kind === 'skill')).toBe(false);
    expect(payload.messages.map((message: any) => message.content)).toEqual(['这个问题没答完', '半截回答']);
    expect(payload.usage).toBeUndefined();
  });
});
