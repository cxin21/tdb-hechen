import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { MemoryClient, type MemoryClientDeps } from '../src/memory-client.js';
import { callsTo, coreFixture } from './helpers/core-fixtures.js';

/**
 * Per-session identity (task-117): a session bound through the start-of-session
 * picker sends ITS triple, while an unbound session (or a call with no session
 * id) keeps the configured one. The resolver is synchronous by contract because
 * headers() is not async -- the third case pins that down.
 */

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

const BOUND = { serviceId: 'default', teamId: 'team-2', agentId: 'agt-2', userId: 'usr-2' };

describe('per-session identity (task-117)', () => {
  it('sends the BOUND session triple on recall, L0 and skill', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl, {
      identityFor: (sessionId?: string) => (sessionId === 'sess-1' ? BOUND : undefined),
    });

    await client.recallBlock('采购订单', { sessionId: 'sess-1' });
    await client.addConversationResult('sess-1', [{ role: 'user', content: 'hi', timestamp: '2026-11-01T00:00:00Z' }]);
    await client.skillConversationAdd('sess-1', [{ role: 'user', content: 'hi' }]);

    // Recall echoes no isolation in the body (its schema has no triple); the
    // headers still carry the session's team/agent/user.
    const recall = callsTo(calls, '/v3/recall')[0];
    expect(recall.headers['x-tdai-team-id']).toBe('team-2');
    expect(recall.headers['x-tdai-agent-id']).toBe('agt-2');
    expect(recall.headers['x-tdai-user-id']).toBe('usr-2');
    expect(recall.body).not.toHaveProperty('team_id');

    // The two write routes echo it in the body AND the headers.
    for (const route of ['/v3/conversation/add', '/v3/skill/conversation/add']) {
      const call = callsTo(calls, route)[0];
      expect(call.body).toMatchObject({ team_id: 'team-2', agent_id: 'agt-2', user_id: 'usr-2' });
      expect(call.headers['x-tdai-team-id']).toBe('team-2');
    }
  });

  it('falls back to the configured triple while the session is still unbound', async () => {
    const { fetchImpl, calls } = coreFixture();
    let bound = false;
    const client = createClient(fetchImpl, {
      identityFor: (sessionId?: string) => (bound && sessionId === 'sess-1' ? BOUND : undefined),
    });

    await client.readCore(undefined, 'sess-1');
    expect(callsTo(calls, '/v3/core/read')[0].body).toMatchObject({ team_id: 'team-1', agent_id: 'agt-1', user_id: 'usr-1' });

    // The resolver is read per request, not captured at construction: the next
    // call after binding uses the picked triple.
    bound = true;
    await client.readCore(undefined, 'sess-1');
    expect(callsTo(calls, '/v3/core/read')[1].body).toMatchObject({ team_id: 'team-2', agent_id: 'agt-2', user_id: 'usr-2' });

    // A call with no session id keeps the configured triple even when bound.
    await client.readCore();
    expect(callsTo(calls, '/v3/core/read')[2].body).toMatchObject({ team_id: 'team-1' });
  });

  it('never awaits or throws from the resolver (headers() is synchronous)', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl, {
      identityFor: () => { throw new Error('resolver exploded'); },
    });

    await client.readCore(undefined, 'sess-1');
    expect(callsTo(calls, '/v3/core/read')[0].body).toMatchObject({ team_id: 'team-1' });
  });
});
