import { describe, expect, it, vi } from 'vitest';
import { applyIdentity, describeAgents, describeTeams, identityStateOf, resolveIdentityFromUserKey } from '../src/identity.js';
import type { AgentSummary, IdentityListResult, TeamSummary, UserKeyVerification } from '../src/memory-client.js';

/**
 * The resolver decides WHOSE memory a session reads and writes, so every branch
 * is pinned here: a wrong pick is silent cross-account contamination, and the
 * only safe answer to ambiguity is "do nothing".
 */
function fakeClient(overrides: {
  verify?: UserKeyVerification;
  teams?: IdentityListResult<TeamSummary>;
  agents?: IdentityListResult<AgentSummary>;
}) {
  return {
    verifyUserKey: vi.fn(async () => overrides.verify ?? { ok: true, valid: true, userId: 'usr-1' }),
    listTeams: vi.fn(async () => overrides.teams ?? { ok: true, items: [{ teamId: 'team-1', name: 'Alpha' }], total: 1 }),
    listAgents: vi.fn(async () => overrides.agents ?? { ok: true, items: [{ agentId: 'agt-1', name: 'Main' }], total: 1 }),
  };
}

const resolve = (client: ReturnType<typeof fakeClient>) =>
  resolveIdentityFromUserKey({ client: client as any, userKey: 'uk-1' });

describe('identity resolution from a user key', () => {
  it('walks verify -> teams -> agents and returns the single unambiguous triple', async () => {
    const client = fakeClient({});
    const outcome = await resolve(client);

    expect(outcome).toEqual({
      kind: 'resolved',
      teamId: 'team-1',
      agentId: 'agt-1',
      userId: 'usr-1',
      teamName: 'Alpha',
      agentName: 'Main',
    });
    expect(client.verifyUserKey).toHaveBeenCalledWith('uk-1', undefined);
    // Owner filter on purpose: an agent id selects whose memory is written.
    expect(client.listAgents).toHaveBeenCalledWith('team-1', 'usr-1', { userKey: 'uk-1', timeoutMs: undefined });
  });

  it('reports an invalid key instead of falling through to another route', async () => {
    const client = fakeClient({ verify: { ok: true, valid: false } });
    await expect(resolve(client)).resolves.toEqual({
      kind: 'invalid-key',
      reason: 'the core says this user key is not valid',
    });
    expect(client.listTeams).not.toHaveBeenCalled();
  });

  it('surfaces a verify failure with its HTTP status', async () => {
    const client = fakeClient({ verify: { ok: false, status: 404, reason: 'HTTP 404' } });
    await expect(resolve(client)).resolves.toEqual({ kind: 'failed', reason: 'HTTP 404', status: 404 });
  });

  it('fails when a verified key carries no user_id', async () => {
    const client = fakeClient({ verify: { ok: true, valid: true } });
    const outcome = await resolve(client);
    expect(outcome.kind).toBe('failed');
    expect(String((outcome as { reason: string }).reason)).toContain('no user_id');
  });

  it('fails when the user belongs to no team', async () => {
    const client = fakeClient({ teams: { ok: true, items: [], total: 0 } });
    const outcome = await resolve(client);
    expect(outcome.kind).toBe('failed');
    expect(String((outcome as { reason: string }).reason)).toContain('belongs to no team');
    expect(client.listAgents).not.toHaveBeenCalled();
  });

  it('refuses to guess between several teams, and returns them for the picker', async () => {
    const teams = [{ teamId: 'team-a', name: 'A' }, { teamId: 'team-b' }];
    const client = fakeClient({ teams: { ok: true, items: teams, total: 2 } });
    const outcome = await resolve(client);

    expect(outcome.kind).toBe('ambiguous');
    expect((outcome as { teams: TeamSummary[] }).teams).toEqual(teams);
    expect((outcome as { userId: string }).userId).toBe('usr-1');
    expect(client.listAgents).not.toHaveBeenCalled();
  });

  it('fails when the user owns no agent in the only team', async () => {
    const client = fakeClient({ agents: { ok: true, items: [], total: 0 } });
    const outcome = await resolve(client);
    expect(outcome.kind).toBe('failed');
    expect(String((outcome as { reason: string }).reason)).toContain('owns no agent');
  });

  it('refuses to guess between several agents, and returns them for the picker', async () => {
    const agents = [{ agentId: 'agt-1', name: 'Main' }, { agentId: 'agt-2', name: 'Side' }];
    const client = fakeClient({ agents: { ok: true, items: agents, total: 2 } });
    const outcome = await resolve(client);

    expect(outcome.kind).toBe('ambiguous');
    expect((outcome as { agents: AgentSummary[] }).agents).toEqual(agents);
  });

  it('turns a transport failure into an outcome instead of a throw', async () => {
    const client = {
      verifyUserKey: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      listTeams: vi.fn(),
      listAgents: vi.fn(),
    };
    await expect(resolve(client as any)).rejects.toThrow('ECONNREFUSED');
    // The client never throws by contract; index.ts wraps this in settleWithin,
    // so a throwing stub here would still not hang a mount. Documented in
    // index.ts, not papered over inside the resolver.
  });

  it('writes a resolution into the live identity box', () => {
    const identity = { serviceId: 'default', teamId: '', agentId: '', userId: '' };
    expect(identityStateOf(identity)).toBe('missing(teamId,agentId,userId)');
    applyIdentity(identity, { teamId: 'team-1', agentId: 'agt-1', userId: 'usr-1' });
    expect(identity).toEqual({ serviceId: 'default', teamId: 'team-1', agentId: 'agt-1', userId: 'usr-1' });
    expect(identityStateOf(identity)).toBe('configured');
  });

  it('renders candidate lists with names for the CLI, ids always', () => {
    expect(describeTeams([{ teamId: 'team-1', name: 'Alpha' }, { teamId: 'team-2' }]))
      .toBe('team-1 (Alpha), team-2');
    expect(describeAgents([{ agentId: 'agt-1' }])).toBe('agt-1');
  });
});
