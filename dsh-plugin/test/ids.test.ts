import { describe, expect, it } from 'vitest';
import { agentKey, sessionKey, turnId } from '../src/ids.js';

describe('ids', () => {
  it('prefers the session id and falls back to a stable anonymous key', () => {
    expect(sessionKey({ id: 's1' })).toBe('s1');
    const agent = { session: undefined };
    const first = sessionKey(agent as any);
    expect(first).toMatch(/^anon-/);
    expect(sessionKey(agent as any)).toBe(first);
  });

  it('derives the agent key from its session', () => {
    expect(agentKey({ session: { id: 's2' } })).toBe('s2');
    expect(agentKey(undefined)).toMatch(/^anon-/);
  });

  it('builds a stable per-turn id', () => {
    expect(turnId('s1', 4)).toBe('s1:turn:4');
    expect(turnId('s1', 4)).toBe(turnId('s1', 4));
    expect(turnId('s1', 4)).not.toBe(turnId('s1', 5));
  });
});
