import { describe, expect, it } from 'vitest';
import {
  resolveUserSessionInitDecision,
  SESSION_INIT_MODULE,
  type UserInitDecision,
} from '../src/user-session-init.js';

/**
 * The proxy's decision table (MemoryProxy/src/session/user-session-init-preset.ts:20-40)
 * pinned one row at a time: "does the session-start card appear" is a function of
 * the per-user session_init config ONLY — never of how many teams/agents exist.
 */
describe('resolveUserSessionInitDecision', () => {
  const base = {
    manual_select: '0',
    default_associate: '1',
    default_team_id: 'team-a',
    default_agent_id: 'agt-a',
  };

  it('is the proxy module name', () => {
    expect(SESSION_INIT_MODULE).toBe('session_init');
  });

  it('asks when the config could not be read (null / undefined)', () => {
    expect(resolveUserSessionInitDecision(null)).toEqual({ kind: 'ask' });
    expect(resolveUserSessionInitDecision(undefined)).toEqual({ kind: 'ask' });
  });

  it('asks when the config is empty (a user with no row falls back to the card)', () => {
    expect(resolveUserSessionInitDecision({})).toEqual({ kind: 'ask' });
  });

  it('asks unless manual_select is exactly "0"', () => {
    for (const manual of ['1', '', 'yes', undefined]) {
      const config = { ...base, manual_select: manual as string };
      if (manual === undefined) delete (config as Record<string, string>).manual_select;
      expect(resolveUserSessionInitDecision(config)).toEqual({ kind: 'ask' });
    }
  });

  it('bypasses on default_associate="0" (no card, nothing injected)', () => {
    expect(resolveUserSessionInitDecision({ ...base, default_associate: '0' })).toEqual({ kind: 'bypass' });
  });

  it('prefers bypass when both are set (default_associate wins over a stale team)', () => {
    expect(
      resolveUserSessionInitDecision({ ...base, default_associate: '0', default_team_id: 'team-a' }),
    ).toEqual({ kind: 'bypass' });
  });

  it('asks when the preset has no team (nothing to bind)', () => {
    expect(resolveUserSessionInitDecision({ ...base, default_team_id: '' })).toEqual({ kind: 'ask' });
    expect(resolveUserSessionInitDecision({ ...base, default_team_id: '   ' })).toEqual({ kind: 'ask' });
    const withoutTeam = { ...base };
    delete (withoutTeam as Record<string, string>).default_team_id;
    expect(resolveUserSessionInitDecision(withoutTeam)).toEqual({ kind: 'ask' });
  });

  it('returns a preset identity with the trimmed team and agent', () => {
    const decision: UserInitDecision = resolveUserSessionInitDecision({
      ...base,
      default_team_id: '  team-2k12lgb650  ',
      default_agent_id: ' agt-2m7buribzz ',
    });
    expect(decision).toEqual({ kind: 'preset', teamId: 'team-2k12lgb650', agentId: 'agt-2m7buribzz' });
  });

  it('treats an empty agent as "no agent configured" (the team decides)', () => {
    expect(resolveUserSessionInitDecision({ ...base, default_agent_id: '' })).toEqual({
      kind: 'preset',
      teamId: 'team-a',
      agentId: undefined,
    });
    const withoutAgent = { ...base };
    delete (withoutAgent as Record<string, string>).default_agent_id;
    expect(resolveUserSessionInitDecision(withoutAgent)).toEqual({
      kind: 'preset',
      teamId: 'team-a',
      agentId: undefined,
    });
  });

  it('matches the live profile we measured on this box', () => {
    // POST /v3/meta/config/user/get {user_id: 'usr-2m7b1144d9', module: 'session_init'}
    expect(
      resolveUserSessionInitDecision({
        manual_select: '0',
        default_associate: '1',
        default_team_id: 'team-2k12lgb650',
        default_agent_id: 'agt-2m7buribzz',
      }),
    ).toEqual({ kind: 'preset', teamId: 'team-2k12lgb650', agentId: 'agt-2m7buribzz' });
  });

  it('ignores unrelated params the endpoint may return', () => {
    expect(
      resolveUserSessionInitDecision({ ...base, description: 'x', param_key: 'session_init.default_team_id' }),
    ).toEqual({ kind: 'preset', teamId: 'team-a', agentId: 'agt-a' });
  });
});
