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

function setup(overrides?: {
  getBlock?: (text: string, context?: any) => Promise<string | undefined>;
  maxChars?: number;
  timeoutMs?: number;
  reportInjection?: (payload: any) => void;
  injectionLog?: { path: string; record: (event: any) => void; failed: () => boolean };
}) {
  const fake = createFakeContext();
  const getBlock = overrides?.getBlock ?? vi.fn(async () => 'BLOCK');
  installVolatile(fake.ctx, {
    enabled: true,
    maxChars: overrides?.maxChars,
    timeoutMs: overrides?.timeoutMs ?? 50,
    getBlock,
    ...(overrides?.reportInjection === undefined ? {} : { reportInjection: overrides.reportInjection }),
    ...(overrides?.injectionLog === undefined ? {} : { injectionLog: overrides.injectionLog }),
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

/**
 * task-13：把「实际注入量」回报给 Core（POST /v3/soul/injection 的 volatile 段）。
 * 这三件事以前是日志里的谎言：跳过的一轮仍按整块字符数记账、上报载荷没有契约、
 * 上报失败会不会拖垮注入没人验过。
 */
describe('volatile injection reporting (task-13)', () => {
  it('append 分支上报真实字节数：chars === clamped.length 且 skipped:false', async () => {
    const reports: any[] = [];
    const { listener } = setup({ maxChars: 1200, reportInjection: (payload) => reports.push(payload) });
    const decision = await preStep(listener, 3, [userMessage('how do I deploy?')]);

    expect(decision.messages).toHaveLength(2);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      sessionKey: 's1',
      turn: 3,
      volatile: { chars: 'BLOCK'.length, skipped: false },
    });
    // hash 是注入块的指纹（8 位十六进制），不是正文。
    expect(reports[0].volatile.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('连续两轮同文本：第二轮上报 skipped:true、chars:0，hash 与首轮一致', async () => {
    const reports: any[] = [];
    const { listener } = setup({ maxChars: 1200, reportInjection: (payload) => reports.push(payload) });
    await preStep(listener, 1, [userMessage('q1')]);
    const second = await preStep(listener, 2, [userMessage('q2')]);

    // 第二轮被近 3 轮同文本抑制：没有 append，但必须如实报「跳过」。
    expect(second.messages).toHaveLength(1);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ turn: 2, volatile: { chars: 0, skipped: true } });
    expect(reports[1].volatile.hash).toBe(reports[0].volatile.hash);
  });

  it('上报载荷只有 sessionKey/turn/volatile，且不含任何正文', async () => {
    const reports: any[] = [];
    const { listener } = setup({ maxChars: 1200, reportInjection: (payload) => reports.push(payload) });
    await preStep(listener, 3, [userMessage('secret-question')]);

    const payload = reports[0];
    expect(Object.keys(payload).sort()).toEqual(['sessionKey', 'turn', 'volatile']);
    expect(Object.keys(payload.volatile).sort()).toEqual(['chars', 'hash', 'skipped']);
    // 正文（块文本、用户问题）绝不上送。
    expect(JSON.stringify(payload)).not.toContain('BLOCK');
    expect(JSON.stringify(payload)).not.toContain('secret-question');
    expect(payload.volatile).not.toHaveProperty('text');
    expect(payload.volatile).not.toHaveProperty('content');
  });

  it('上报抛错时 pre-step 仍返回已追加的消息（fail-open）', async () => {
    const { listener } = setup({
      maxChars: 1200,
      reportInjection: () => {
        throw new Error('report endpoint exploded');
      },
    });
    const decision = await preStep(listener, 3, [userMessage('hi')]);
    expect(decision.messages).toHaveLength(2);
    expect(decision.messages[1]).toMatchObject({ id: volatileMessageId(3), source: { kind: VOLATILE_SOURCE_KIND } });
  });

  it('空块（没注入）不上报：没注入就是没注入', async () => {
    const reports: any[] = [];
    const { listener } = setup({ maxChars: 1200, getBlock: async () => '', reportInjection: (payload) => reports.push(payload) });
    const decision = await preStep(listener, 3, [userMessage('hi')]);
    expect(decision.messages).toHaveLength(1);
    expect(reports).toHaveLength(0);
  });
});

describe('volatile 本地证据日志（injection-log）', () => {
  it('append 记 turn-append 且 chars 等于实际追加长度', async () => {
    const events: any[] = [];
    const { listener } = setup({
      maxChars: 1200,
      injectionLog: { path: 'mem.jsonl', record: (e) => events.push(e), failed: () => false },
    });
    const decision = await preStep(listener, 5, [userMessage('deploy?')]);

    expect(decision.messages).toHaveLength(2);
    expect(events).toHaveLength(1);
    const appended = (decision.messages[1]!.content as Array<{ text: string }>)[0]!.text;
    expect(events[0]).toMatchObject({ event: 'turn-append', sessionId: 's1', turn: 5, chars: appended.length });
    expect(events[0].hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('去重跳过记 turn-skip 且 chars=0（跳过不能看起来像注入）', async () => {
    const events: any[] = [];
    const { listener } = setup({
      maxChars: 1200,
      injectionLog: { path: 'mem.jsonl', record: (e) => events.push(e), failed: () => false },
    });
    await preStep(listener, 1, [userMessage('q1')]);
    const second = await preStep(listener, 2, [userMessage('q2')]);

    expect(second.messages).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ event: 'turn-skip', turn: 2, chars: 0 });
    expect(events[1].hash).toBe(events[0].hash);
  });

  it('日志抛错不影响注入（fail-open）', async () => {
    const { listener } = setup({
      maxChars: 1200,
      injectionLog: {
        path: 'mem.jsonl',
        record: () => {
          throw new Error('disk full');
        },
        failed: () => false,
      },
    });
    const decision = await preStep(listener, 3, [userMessage('hi')]);
    expect(decision.messages).toHaveLength(2);
  });
});
