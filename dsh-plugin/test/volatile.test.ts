import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VOLATILE_MAX_CHARS,
  VOLATILE_SOURCE_KIND,
  extractTurnText,
  formatVolatileBlock,
  installVolatile,
  volatileMessageId,
} from '../src/volatile.js';
import { createFakeContext, runPreStep } from './helpers/fake-ctx.js';
import { userMessage } from './helpers/messages.js';

function setup(overrides?: { getBlock?: (text: string, context?: any) => Promise<string | undefined>; maxChars?: number; timeoutMs?: number }) {
  const fake = createFakeContext();
  const getBlock = overrides?.getBlock ?? vi.fn(async () => 'BLOCK');
  installVolatile(fake.ctx, {
    enabled: true,
    maxChars: overrides?.maxChars,
    timeoutMs: overrides?.timeoutMs ?? 50,
    getBlock,
    log: fake.ctx.logger,
  });
  const listener = fake.firstListener('agent/pre-step');
  if (!listener) throw new Error('pre-step listener not installed');
  return { fake, listener, getBlock };
}

function preStep(listener: (...args: any[]) => unknown, turn: number, messages: any[]) {
  return runPreStep(listener, { agent: { session: { id: 's1' } }, turn, step: 1 }, { kind: 'enter', messages });
}

describe('volatile block', () => {
  it('appends exactly one plugin message at the tail and keeps the prefix intact', async () => {
    const { listener, getBlock } = setup({ maxChars: 1200 });
    const claimed = [userMessage('how do I deploy?')];
    const decision = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 3, step: 1 }, { kind: 'enter', messages: claimed });

    expect(decision.kind).toBe('enter');
    expect(decision.messages).toHaveLength(2);
    expect(decision.messages[0]).toBe(claimed[0]);
    expect(decision.messages[1]).toMatchObject({
      id: volatileMessageId(3),
      role: 'user',
      source: { kind: VOLATILE_SOURCE_KIND },
    });
    // The fetcher now receives the step's session/turn so /v3/recall can carry
    // x-tdai-session-id (the endpoint is session-aware).
    expect(getBlock).toHaveBeenCalledWith('how do I deploy?', { turn: 3, sessionId: 's1' });
  });

  it('keeps injecting when the host sends no turn number (no shared undefined key)', async () => {
    const { listener, getBlock } = setup({ maxChars: 1200 });
    const first = await runPreStep(
      listener,
      { agent: { session: { id: 's1' } }, step: 1 },
      { kind: 'enter', messages: [userMessage('first question', 'host-1')] },
    );
    expect(first.messages).toHaveLength(2);
    // A later turn with no turn number must still inject: the old key was the
    // constant 'agemem-volatile-undefined', which blocked the rest of the session.
    const second = await runPreStep(
      listener,
      { agent: { session: { id: 's1' } }, step: 1 },
      { kind: 'enter', messages: [userMessage('second question', 'host-2')] },
    );
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toMatchObject({ id: volatileMessageId('host-2'), source: { kind: VOLATILE_SOURCE_KIND } });
    expect(getBlock).toHaveBeenCalledTimes(2);
  });

  it('still injects at most once per step when the turn number is missing', async () => {
    const { listener, getBlock } = setup({ maxChars: 1200 });
    const claimed = [userMessage('only question', 'host-9')];
    const first = await runPreStep(listener, { agent: { session: { id: 's1' } }, step: 1 }, { kind: 'enter', messages: claimed });
    expect(first.messages).toHaveLength(2);
    // The pseudo key must be STABLE: the injected message id is derived from it,
    // and that id is what later steps match on (text hashing must not drift).
    expect(first.messages[1]).toMatchObject({ id: volatileMessageId('host-9'), source: { kind: VOLATILE_SOURCE_KIND } });
    const second = await runPreStep(listener, { agent: { session: { id: 's1' } }, step: 2 }, { kind: 'enter', messages: claimed });
    expect(second.messages).toHaveLength(1);
    // Same stability from the history side: the persisted block (same id) is
    // recognised, so replaying that step appends nothing new.
    const replay = await runPreStep(
      listener,
      { agent: { session: { id: 's1' } }, step: 3 },
      { kind: 'enter', messages: [...claimed, first.messages[1]] },
    );
    expect(replay.messages).toHaveLength(2);
    expect(getBlock).toHaveBeenCalledTimes(1);
  });

  it('never appends twice for the same turn', async () => {
    const { listener, getBlock } = setup({ maxChars: 1200 });
    const first = await preStep(listener, 3, [userMessage('a')]);
    expect(first.messages).toHaveLength(2);

    const second = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 3, step: 2 }, { kind: 'enter', messages: [] });
    expect(second.messages).toHaveLength(0);
    expect(getBlock).toHaveBeenCalledTimes(1);
  });

  it('skips an append when the message already exists in the claimed list', async () => {
    const { listener, getBlock } = setup({ maxChars: 1200 });
    const existing = {
      id: volatileMessageId(3),
      role: 'user',
      source: { kind: VOLATILE_SOURCE_KIND },
      content: [{ type: 'text', text: 'old' }],
    };
    const decision = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 3, step: 2 }, { kind: 'enter', messages: [existing] });
    expect(decision.messages).toHaveLength(1);
    expect(getBlock).not.toHaveBeenCalled();
  });

  it('keeps every earlier injected block in history (append-only, KV-cache safe)', async () => {
    const { listener } = setup({ maxChars: 1200, getBlock: async () => 'NEW' });
    const prior = {
      id: volatileMessageId(1),
      role: 'user',
      source: { kind: VOLATILE_SOURCE_KIND },
      content: [{ type: 'text', text: 'old block' }],
    };
    const claimed = [userMessage('next question'), prior];
    const decision = await preStep(listener, 2, claimed);

    // 旧块原样保留（同一个对象），新块只追加在末尾：前缀字节不变。
    expect(decision.messages[0]).toBe(claimed[0]);
    expect(decision.messages[1]).toBe(prior);
    expect(decision.messages).toHaveLength(3);
    expect(decision.messages[2]).toMatchObject({ id: volatileMessageId(2), source: { kind: VOLATILE_SOURCE_KIND } });
  });

  it('suppresses an identical block within the last three turns, then allows it again', async () => {
    const getBlock = vi.fn(async () => 'SAME BLOCK');
    const { listener } = setup({ maxChars: 1200, getBlock });

    const lengths: number[] = [];
    for (const turn of [1, 2, 3, 4, 5]) {
      const decision = await preStep(listener, turn, [userMessage('q' + turn)]);
      lengths.push(decision.messages.length);
    }

    // turn 1 注入；turn 2/3/4 与 turn 1 完全相同且落在 3 轮窗口内 → 跳过；turn 5 窗口外 → 再注入。
    expect(lengths).toEqual([2, 1, 1, 1, 2]);
    expect(getBlock).toHaveBeenCalledTimes(5);
  });

  it('injects different blocks on consecutive turns', async () => {
    let call = 0;
    const { listener } = setup({ maxChars: 1200, getBlock: async () => 'BLOCK ' + (call += 1) });
    const first = await preStep(listener, 1, [userMessage('a')]);
    const second = await preStep(listener, 2, [userMessage('b')]);
    expect(first.messages).toHaveLength(2);
    expect(second.messages).toHaveLength(2);
    expect(first.messages[1].content[0].text).toBe('BLOCK 1');
    expect(second.messages[1].content[0].text).toBe('BLOCK 2');
  });

  it('defaults the block cap to 1200 chars and keeps only whole lines', async () => {
    const fake = createFakeContext();
    const block = 'HEADER' + String.fromCharCode(10)
      + Array.from({ length: 40 }, (_unused, index) => '- [' + String(index).padStart(2, '0') + '] ' + 'x'.repeat(80)).join(String.fromCharCode(10));
    installVolatile(fake.ctx, { enabled: true, timeoutMs: 50, getBlock: async () => block, log: fake.ctx.logger });
    const listener = fake.firstListener('agent/pre-step');
    if (!listener) throw new Error('pre-step listener not installed');
    const decision = await preStep(listener, 6, [userMessage('hi')]);
    const text: string = decision.messages[1].content[0].text;
    expect(DEFAULT_VOLATILE_MAX_CHARS).toBe(1200);
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text.split(String.fromCharCode(10)).slice(1).every((line: string) => line.endsWith('x'.repeat(80)))).toBe(true);
  });

  it('passes a reject decision through untouched', async () => {
    const { listener, getBlock } = setup({ maxChars: 1200 });
    const rejected = { kind: 'reject', messages: [] };
    const decision = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 1, step: 1 }, rejected);
    expect(decision).toBe(rejected);
    expect(getBlock).not.toHaveBeenCalled();
  });

  it('fails open when the block source throws', async () => {
    const { fake, listener } = setup({
      maxChars: 1200,
      getBlock: async () => {
        throw new Error('core down');
      },
    });
    const claimed = [userMessage('hello')];
    const decision = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 1, step: 1 }, { kind: 'enter', messages: claimed });
    expect(decision.messages).toBe(claimed);
    expect(fake.logs.some((line) => line.includes('volatile block skipped'))).toBe(true);
  });

  it('fails open when the block source hangs past the timeout', async () => {
    const hung = vi.fn(() => new Promise<string>(() => {}));
    const { listener, getBlock } = setup({ timeoutMs: 10, getBlock: hung });
    const claimed = [userMessage('hello')];
    const decision = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 1, step: 1 }, { kind: 'enter', messages: claimed });
    expect(decision.messages).toBe(claimed);
    expect(hung).toHaveBeenCalledTimes(1);
  });

  it('skips the append when the recalled block is empty', async () => {
    const { listener } = setup({ maxChars: 1200, getBlock: async () => '' });
    const decision = await preStep(listener, 2, [userMessage('hi')]);
    expect(decision.messages).toHaveLength(1);
  });

  it('clamps an oversized block at a line boundary, never mid-entry', async () => {
    const long = '- [a] ' + 'x'.repeat(60);
    const block = 'HEADER' + String.fromCharCode(10) + long + String.fromCharCode(10) + '- [b] ' + 'y'.repeat(60);
    const { listener } = setup({ maxChars: 80, getBlock: async () => block });
    const decision = await preStep(listener, 4, [userMessage('hi')]);
    const text: string = decision.messages[1].content[0].text;
    expect(text).toBe('HEADER' + String.fromCharCode(10) + long);
    expect(text).not.toContain('yy');
  });

  it('skips the append when the block cannot fit a single line', async () => {
    const { listener } = setup({ maxChars: 5, getBlock: async () => 'abcdefghij' });
    const decision = await preStep(listener, 4, [userMessage('hi')]);
    expect(decision.messages).toHaveLength(1);
  });

  it('extracts the real user text and skips injected messages', () => {
    expect(extractTurnText([userMessage('first', 'u1'), { id: 'x', role: 'user', source: { kind: VOLATILE_SOURCE_KIND }, content: [{ type: 'text', text: 'block' }] } as any])).toBe('first');
    expect(extractTurnText([])).toBe('');
    expect(extractTurnText(undefined)).toBe('');
  });

  it('renders recall hits with a header and honours the cap', () => {
    expect(formatVolatileBlock([], 100)).toBe('');
    const rendered = formatVolatileBlock([{ text: 'a  b', layer: 'L1' }, { text: 'c' }], 1000);
    expect(rendered).toContain('【agemem 记忆提示】');
    expect(rendered).toContain('- [L1] a b');
    expect(rendered).toContain('- c');
  });

  it('drops whole entries instead of slicing the last one mid-text', () => {
    const hits = [{ text: 'a'.repeat(20) }, { text: 'b'.repeat(20) }];
    const rendered = formatVolatileBlock(hits, 80);
    // Only the first entry fits next to the header: no partial 'bb' tail.
    expect(rendered).toContain('- ' + 'a'.repeat(20));
    expect(rendered).not.toContain('bb');
    expect(rendered.endsWith('a'.repeat(20))).toBe(true);
  });

  it('does nothing when disabled', () => {
    const fake = createFakeContext();
    installVolatile(fake.ctx, { enabled: false, maxChars: 10, timeoutMs: 10, getBlock: async () => 'x' });
    expect(fake.listenerCount('agent/pre-step')).toBe(0);
  });
});
