/**
 * Identity resolution from ONE user key (task-51).
 *
 * A profile can be configured with just `server.userKey`: verify the key, list
 * the teams that user belongs to, list the agents that user OWNS inside the
 * chosen team, and pick. That is what the user asked for ("通过 userkey 找对应
 * 用户然后弹窗选 team 和 agent") — the CLI (scripts/agemem-identity.mjs) walks
 * the same three calls interactively and writes the result into the patch.
 *
 * Two hard rules:
 *
 *  1. Never guess. If the user belongs to two teams, or owns two agents in the
 *     picked team, the answer is "ambiguous" and the profile stays inert until a
 *     human picks. A wrong pick writes this session's memories into somebody
 *     else's pool, which is far worse than doing nothing.
 *  2. Fail open, quietly. Every failure mode returns an outcome; nothing throws.
 *     The plugin resolves at mount (not per turn) and, when it cannot, logs one
 *     line pointing at the CLI.
 *
 * The agent list is filtered by owner on purpose: an agent id selects whose
 * memory is read and written, so listing agents the user merely can SEE would
 * make "the only one" wrong.
 */

import type { MemoryClient, MemoryIdentity, TeamSummary, AgentSummary } from './memory-client.js';
import type { LoggerLike } from './types.js';

export interface IdentityResolutionInput {
  client: Pick<MemoryClient, 'verifyUserKey' | 'listTeams' | 'listAgents'>;
  userKey: string;
  /** Per-call budget; the caller also caps the whole thing (see index.ts). */
  timeoutMs?: number;
  log?: LoggerLike;
}

export type IdentityResolution =
  | { kind: 'resolved'; teamId: string; agentId: string; userId: string; teamName?: string; agentName?: string }
  | { kind: 'invalid-key'; reason: string }
  | { kind: 'ambiguous'; reason: string; teams?: TeamSummary[]; agents?: AgentSummary[]; userId?: string }
  | { kind: 'failed'; reason: string; status?: number };

/** Names are for humans only; ids are what the config stores. */
function label(entity: { teamId?: string; agentId?: string; name?: string }): string {
  const id = entity.teamId ?? entity.agentId ?? '?';
  return entity.name !== undefined && entity.name !== '' ? id + ' (' + entity.name + ')' : id;
}

export function describeTeams(teams: TeamSummary[]): string {
  return teams.map(label).join(', ');
}

export function describeAgents(agents: AgentSummary[]): string {
  return agents.map(label).join(', ');
}

/**
 * verify -> teams -> agents. Returns as soon as one step cannot produce a
 * single unambiguous answer; the caller decides what to log.
 */
export async function resolveIdentityFromUserKey(input: IdentityResolutionInput): Promise<IdentityResolution> {
  const { client, userKey, timeoutMs, log } = input;

  const verification = await client.verifyUserKey(userKey, timeoutMs);
  if (!verification.ok) {
    return { kind: 'failed', reason: verification.reason ?? 'verify failed', status: verification.status };
  }
  if (verification.valid !== true) {
    return { kind: 'invalid-key', reason: 'the core says this user key is not valid' };
  }
  const userId = verification.userId;
  if (userId === undefined) {
    return { kind: 'failed', reason: 'the core verified the key but returned no user_id' };
  }

  const teams = await client.listTeams(userId, { userKey, timeoutMs });
  if (!teams.ok) {
    return { kind: 'failed', reason: teams.reason ?? 'team list failed', status: teams.status };
  }
  if (teams.items.length === 0) {
    return { kind: 'failed', reason: 'this user belongs to no team', status: teams.status };
  }
  if (teams.items.length > 1) {
    return {
      kind: 'ambiguous',
      reason: 'this user belongs to ' + teams.items.length + ' teams',
      teams: teams.items,
      userId,
    };
  }
  const team = teams.items[0];

  const agents = await client.listAgents(team.teamId, userId, { userKey, timeoutMs });
  if (!agents.ok) {
    return { kind: 'failed', reason: agents.reason ?? 'agent list failed', status: agents.status };
  }
  if (agents.items.length === 0) {
    return { kind: 'failed', reason: 'this user owns no agent in team ' + team.teamId };
  }
  if (agents.items.length > 1) {
    return {
      kind: 'ambiguous',
      reason: 'this user owns ' + agents.items.length + ' agents in team ' + team.teamId,
      teams: teams.items,
      agents: agents.items,
      userId,
    };
  }
  const agent = agents.items[0];
  log?.debug?.('agemem: identity resolved from the user key', { teams: 1, agents: 1 });
  return {
    kind: 'resolved',
    teamId: team.teamId,
    agentId: agent.agentId,
    userId,
    teamName: team.name,
    agentName: agent.name,
  };
}

/** Write a resolution into the live identity box (read per request by the client). */
export function applyIdentity(identity: MemoryIdentity, resolution: { teamId: string; agentId: string; userId: string }): void {
  identity.teamId = resolution.teamId;
  identity.agentId = resolution.agentId;
  identity.userId = resolution.userId;
}

/** 'configured' | 'missing(...)' — the ready line's identity field. */
export function identityStateOf(identity: Pick<MemoryIdentity, 'teamId' | 'agentId' | 'userId'>): string {
  const missing = [
    identity.teamId.trim() === '' ? 'teamId' : '',
    identity.agentId.trim() === '' ? 'agentId' : '',
    identity.userId.trim() === '' ? 'userId' : '',
  ].filter((part) => part !== '');
  return missing.length === 0 ? 'configured' : 'missing(' + missing.join(',') + ')';
}
