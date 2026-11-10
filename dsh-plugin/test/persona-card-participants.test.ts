import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  createPersonaCard,
  type PersonaCardDeps,
  type PersonaCardRead,
  type PersonaCardSnapshot,
} from '../src/persona-card.js';

/**
 * P2-C：插件把**会话键**交给 Core，由 Core 反查该会话的在场者决定过滤到谁。
 *
 * 三条判据（规格 P2-C 的测试要求）：
 *  1. 有带参取卡时走带参版本，且 `sessionId` 原样传下去；
 *  2. `participants` 不由插件猜 —— 不传（传展示名会被 Core 丢弃，传空串在 Core
 *     的语义是「只剩全局行」，两者都会把卡切错）；
 *  3. `personsHash` 只在 Core 回显的 `persons` 变化时变化。
 *
 * 这里不碰网络：取卡是注入的依赖，测的是插件的传参与记账。
 */

function snapshot(text: string, persons?: string[], version = 1): PersonaCardSnapshot {
  return {
    version,
    hash: `h${String(version)}`,
    textHash: 'x'.repeat(64),
    text,
    chars: text.length,
    dirty: false,
    identity: { text },
    ...(persons === undefined ? {} : { persons }),
  };
}

function deps(overrides: Partial<PersonaCardDeps> = {}): PersonaCardDeps & {
  fetchCard: ReturnType<typeof vi.fn>;
  fetchCardWithParams: ReturnType<typeof vi.fn>;
} {
  const fetchCard = vi.fn(async (): Promise<PersonaCardRead> => snapshot('卡'));
  const fetchCardWithParams = vi.fn(async (): Promise<PersonaCardRead> => snapshot('卡'));
  return {
    enabled: true,
    fetchCard,
    fetchCardWithParams,
    fetchTurn: async () => undefined,
    timeoutMs: 1000,
    ...overrides,
  } as PersonaCardDeps & {
    fetchCard: ReturnType<typeof vi.fn>;
    fetchCardWithParams: ReturnType<typeof vi.fn>;
  };
}

const sha8 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);

describe('P2-C 按人取卡：会话键透传与在场者回显', () => {
  it('有带参版本时走带参版本，sessionId 原样传下去；不传 participants', async () => {
    const d = deps();
    const card = createPersonaCard(d);
    const outcome = await card.bind('sess-1', 'team/u/a');
    expect(outcome.ok).toBe(true);
    expect(d.fetchCardWithParams).toHaveBeenCalledTimes(1);
    expect(d.fetchCardWithParams).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    // 关键：没有 participants 键 —— 插件不猜人名。
    const arg = d.fetchCardWithParams.mock.calls[0][0] as { participants?: unknown };
    expect(arg.participants).toBeUndefined();
    expect(d.fetchCard).not.toHaveBeenCalled();
  });

  it('没有带参版本时退回旧 fetchCard（老接线逐字不变）', async () => {
    const d = deps();
    const legacy = { ...d, fetchCardWithParams: undefined } as unknown as PersonaCardDeps;
    const card = createPersonaCard(legacy);
    const outcome = await card.bind('sess-2', 'team/u/a');
    expect(outcome.ok).toBe(true);
    expect(d.fetchCard).toHaveBeenCalledWith('sess-2');
  });

  it('persons 原样回传（单人是 person_key）；encode 之后 personsHash 随在场者变化', async () => {
    const single = deps();
    single.fetchCardWithParams = vi.fn(async () => snapshot('卡', ['p_abc']));
    const cardA = createPersonaCard(single);
    const first = await cardA.bind('sess-3', 'team/u/a');
    expect(first.ok && first.persons).toEqual(['p_abc']);

    // 同一会话换一组在场者 → personsHash 变；
    const other = deps();
    other.fetchCardWithParams = vi.fn(async () => snapshot('卡', ['p_abc', 'p_def']));
    const cardB = createPersonaCard(other);
    const second = await cardB.bind('sess-3', 'team/u/a');
    expect(second.ok && second.persons).toEqual(['p_abc', 'p_def']);
    expect(sha8('p_abc')).not.toBe(sha8('p_abc,p_def'));

    // 同样一组在场者 → 同样的 hash（幂等）；整卡文本变了也不改 personsHash。
    expect(sha8('p_abc')).toBe(sha8('p_abc'));
  });

  it('不过滤时不回 persons（老形状）；显式空数组照样回传', async () => {
    const none = deps();
    none.fetchCardWithParams = vi.fn(async () => snapshot('卡'));
    const card = createPersonaCard(none);
    const outcome = await card.bind('sess-4', 'team/u/a');
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && 'persons' in outcome).toBe(false);

    const empty = deps();
    empty.fetchCardWithParams = vi.fn(async () => snapshot('卡', []));
    const cardEmpty = createPersonaCard(empty);
    const emptyOutcome = await cardEmpty.bind('sess-5', 'team/u/a');
    expect(emptyOutcome.ok && emptyOutcome.persons).toEqual([]);
  });
});
