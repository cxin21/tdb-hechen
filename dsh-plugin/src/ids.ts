import type { AgentLike, SessionLike } from './types.js';

/**
 * Stable-enough identifiers for idempotent writeback.
 *
 * The host exposes the durable id as `agent.session.id` (see dsh-agent:
 * `if (id !== agent.session.id) throw ...`). When the host shape differs we
 * fall back to a per-process counter so the plugin still dedupes within one
 * run instead of crashing.
 */

let counter = 0;
const agentKeys = new WeakMap<object, string>();
const sessionKeys = new WeakMap<object, string>();

function fallbackKey(): string {
  counter += 1;
  return `anon-${counter}`;
}

export function sessionKey(session: SessionLike | undefined | null): string {
  if (session && typeof session === 'object') {
    const id = session.id;
    if (typeof id === 'string' && id !== '') return id;
    const known = sessionKeys.get(session);
    if (known) return known;
    const fresh = fallbackKey();
    sessionKeys.set(session, fresh);
    return fresh;
  }
  return fallbackKey();
}

export function agentKey(agent: AgentLike | undefined | null): string {
  if (agent && typeof agent === 'object') {
    const viaSession = agent.session;
    if (viaSession && typeof viaSession === 'object') return sessionKey(viaSession);
    const known = agentKeys.get(agent);
    if (known) return known;
    const fresh = fallbackKey();
    agentKeys.set(agent, fresh);
    return fresh;
  }
  return fallbackKey();
}

export function turnId(agentOrSessionKey: string, turn: unknown): string {
  return `${agentOrSessionKey}:turn:${String(turn)}`;
}
