import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  PERSONA_ANCHOR_SECTION_NAME,
  PERSONA_IDENTITY_SECTION_NAME,
  createPersonaCard,
  type PersonaCardHandle,
  type PersonaCardRead,
  type PersonaCardSnapshot,
} from '../src/persona-card.js';
import type { InjectionLog, InjectionLogEvent } from '../src/injection-log.js';
import { createFakeContext } from './helpers/fake-ctx.js';

/**
 * Round30（判据 4 的生产者侧缺口）：`section-read` 行必须带上**整卡** `cardHash`，
 * 且与同会话 `card-bound` 行的 `hash` 逐字符相等 —— Core 的 proof 分母就靠这两个
 * 同定义的值对账。此前只有消费端（Core stats）有测试，生产者侧无人断言：
 * 把 cardHash 那行删掉，插件测试全绿而 proof 永远归零。
 */

const SESSION = (id: string) => ({ agent: { id, session: { id } }, scope: undefined, signal: undefined });
const ANCHOR_ORDER = 10303;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function card(identityText: string, anchorText: string, textHash?: string): PersonaCardSnapshot {
  const text = `整卡标题\n${identityText}\n${anchorText}`;
  return {
    version: 7,
    hash: 'material-hash-7',
    ...(textHash === undefined ? {} : { textHash }),
    text,
    chars: text.length,
    dirty: false,
    identity: { text: identityText },
    anchor: { text: anchorText },
  };
}

function harness(read: () => Promise<PersonaCardRead>) {
  const events: InjectionLogEvent[] = [];
  const log: InjectionLog = {
    path: '(test)',
    record: (event: InjectionLogEvent) => { events.push(event); },
    failed: () => false,
  };
  const fake = createFakeContext();
  const handle: PersonaCardHandle = createPersonaCard({
    enabled: true,
    fetchCard: async () => read(),
    fetchTurn: async () => ({ text: '', openLoops: [] }),
    timeoutMs: 50,
    injectionLog: log,
    resolveSession: (context: unknown) => {
      const id = (context as { agent?: { id?: string } } | undefined)?.agent?.id ?? '';
      return id === '' ? undefined : { sessionId: id, source: 'context-agent', field: 'agent.id' };
    },
  });
  handle.installSection(fake.ctx, ANCHOR_ORDER);
  const getter = (name: string, context?: unknown) => {
    const section = fake.sections.find((entry) => entry.name === name);
    if (section === undefined) throw new Error(`section ${name} not installed`);
    return (section.text as (context?: unknown) => string)(context);
  };
  return { handle, events, getter };
}

describe('Round30 · section-read 的 cardHash（proof 生产者侧）', () => {
  it('段读行带整卡 cardHash，且与同会话 card-bound 的 hash 逐字符相等', async () => {
    const identityText = '我是审墨，写法偏克制。';
    const anchorText = '底色：偏冷。';
    const c = card(identityText, anchorText, sha256(`整卡标题\n${identityText}\n${anchorText}`));
    const h = harness(async () => c);
    await h.handle.bind('s1', 'team/user/agentA');
    expect(h.getter(PERSONA_IDENTITY_SECTION_NAME, SESSION('s1'))).toBe(identityText);

    const bound = h.events.filter((e) => e.event === 'card-bound');
    const reads = h.events.filter((e) => e.event === 'section-read' && e.sessionId === 's1' && (e.chars ?? 0) > 0);
    expect(bound).toHaveLength(1);
    expect(reads.length).toBeGreaterThan(0);
    const read = reads[reads.length - 1]!;
    // 段 hash 是该段自己的 sha256（与 Core 段 hash 同算法），不等于整卡 hash。
    expect(read.hash).toBe(sha256(identityText));
    expect(read.cardHash).toBe(sha256(`整卡标题\n${identityText}\n${anchorText}`));
    expect(read.cardHash).not.toBe(read.hash);
    expect(read.cardHash).toBe(bound[0]!.hash);
    expect(read.cardHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('旧 Core 不带 textHash 时用本地 sha256(整卡) 兜底，仍是 64 hex 且与 card-bound 一致', async () => {
    const identityText = '旧卡身份段。';
    const anchorText = '旧卡锚段。';
    const c = card(identityText, anchorText, undefined);
    expect(c.textHash).toBeUndefined();
    const h = harness(async () => c);
    await h.handle.bind('s2', 'team/user/agentB');
    h.getter(PERSONA_ANCHOR_SECTION_NAME, SESSION('s2'));
    const bound = h.events.filter((e) => e.event === 'card-bound');
    const reads = h.events.filter((e) => e.event === 'section-read' && e.sessionId === 's2' && (e.chars ?? 0) > 0);
    const expected = sha256(`整卡标题\n${identityText}\n${anchorText}`);
    expect(reads[reads.length - 1]!.cardHash).toBe(expected);
    expect(bound[0]!.hash).toBe(expected);
  });

  it('没卡的会话（no-card）不伪造 cardHash：proof 分母只算真取到卡的段读', async () => {
    const h = harness(async () => undefined);
    await h.handle.bind('s3', 'team/user/agentC');
    expect(h.getter(PERSONA_IDENTITY_SECTION_NAME, SESSION('s3'))).toBe('');
    const misses = h.events.filter((e) => e.event === 'section-read' && e.reason === 'no-card');
    expect(misses.length).toBeGreaterThan(0);
    for (const miss of misses) expect(miss.cardHash).toBeUndefined();
  });
});
