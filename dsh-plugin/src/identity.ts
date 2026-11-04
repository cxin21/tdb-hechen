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
import type { AgentChoice, CandidatesResult, TaskChoice, TeamChoice } from './session-identity.js';
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

/**
 * verify -> teams (-> agents when the team is already known).
 *
 * The session-start picker (src/session-identity.ts) needs the candidate lists
 * WITHOUT committing to a pick: a user in two teams must choose, and a user with
 * one team and one agent is auto-bound. resolveIdentityFromUserKey() above is the
 * mount-time, all-or-nothing path and stays untouched -- other callers depend on
 * its 'ambiguous means inert' semantics.
 */
export async function listCandidates(input: {
  client: Pick<MemoryClient, 'verifyUserKey' | 'listTeams' | 'listAgents' | 'listTasks'>;
  userKey: string;
  /** Scope the agent list to one team (the team the human just picked). */
  teamId?: string;
  timeoutMs?: number;
  log?: LoggerLike;
}): Promise<CandidatesResult> {
  const { client, userKey, timeoutMs, log } = input;
  const verification = await client.verifyUserKey(userKey, timeoutMs);
  if (!verification.ok) return { kind: 'failed', reason: verification.reason ?? 'verify failed' };
  if (verification.valid !== true) return { kind: 'failed', reason: 'the core says this user key is not valid' };
  const userId = verification.userId;
  if (userId === undefined) return { kind: 'failed', reason: 'the core verified the key but returned no user_id' };

  const teams = await client.listTeams(userId, { userKey, timeoutMs });
  if (!teams.ok) return { kind: 'failed', reason: teams.reason ?? 'team list failed' };
  const teamChoices: TeamChoice[] = teams.items.map((team) => ({ teamId: team.teamId, name: team.name }));

  const scope = input.teamId !== undefined && input.teamId.trim() !== ''
    ? input.teamId.trim()
    : teamChoices.length === 1 ? teamChoices[0].teamId : undefined;
  if (scope === undefined) return { kind: 'ok', userId, teams: teamChoices };

  // Agents and tasks are independent legs of the same scope, so they run
  // together. Tasks are the picker's THIRD question (the proxy's task_select):
  // an OPTIONAL scope whose list may legitimately be empty (a team with no
  // running work item), and a failed leg is logged but never sinks the picker.
  const [agents, tasks] = await Promise.all([
    client.listAgents(scope, userId, { userKey, timeoutMs }),
    client.listTasks(scope, { userKey, timeoutMs }),
  ]);
  const taskChoices: TaskChoice[] = tasks.ok
    ? tasks.items.map((task) => ({ taskId: task.taskId, title: task.title }))
    : [];
  if (!tasks.ok) log?.debug?.('agemem: candidate task list failed', tasks.reason);
  if (!agents.ok) {
    // The team list is still useful: a failed agent leg means the picker asks the
    // agent question with no options, which the caller reports as 'no agent'.
    log?.debug?.('agemem: candidate agent list failed', agents.reason);
    return { kind: 'ok', userId, teams: teamChoices, agents: [], tasks: taskChoices };
  }
  return {
    kind: 'ok',
    userId,
    teams: teamChoices,
    agents: agents.items.map((agent) => ({ agentId: agent.agentId, name: agent.name })),
    tasks: taskChoices,
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
