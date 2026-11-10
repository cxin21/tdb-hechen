import { describe, expect, it } from 'vitest';
import {
  SOUL_GATE_MAX_TEXT_CHARS,
  SOUL_GATE_PATH,
  createSoulGateOnce,
  loggedFromCoreResult,
  soulGateDedupeKey,
  toSoulGateReport,
} from '../src/gate-report.js';
import type { TurnEndPayload } from '../src/memory-client.js';

/** 一条成功回合的收口 payload（形状由 writeback.ts 产出）。 */
function turn(overrides: Partial<TurnEndPayload> = {}): TurnEndPayload {
  return {
    turnId: 'turn-1',
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    turn: 1,
    status: 'completed',
    messages: [],
    assistantText: '全绿，46 个用例通过。',
    toolCalls: [],
    endedAt: '2026-11-10T22:00:00Z',
    ...overrides,
  };
}

/**
 * P7 输出侧：哪些回合该判、请求体长什么样、同一轮怎么只判一次。
 * 契约锚 MemoryCore/src/gateway/soul-gate-endpoint.ts:35（路径）、:38（20000 上限）、
 * :218/:231（text/stage）。
 */
describe('toSoulGateReport (P7 output gate)', () => {
  it('路径与上限与 Core 对齐', () => {
    expect(SOUL_GATE_PATH).toBe('/v3/soul/gate');
    expect(SOUL_GATE_MAX_TEXT_CHARS).toBe(20_000);
  });

  it('成功回合：text + stage=output + sessionId，没有事件 id 时整个键不出现', () => {
    const report = toSoulGateReport(turn());
    expect(report).toEqual({ text: '全绿，46 个用例通过。', stage: 'output', sessionId: 'sess-1' });
    // 「无则省略」：不是 eventId: ''、不是 eventId: null。
    expect(Object.keys(report as Record<string, unknown>)).not.toContain('eventId');
  });

  it('有真实事件 id 才带（不伪造）', () => {
    expect(toSoulGateReport(turn(), { eventId: 'evt-7' })).toMatchObject({ eventId: 'evt-7' });
    expect(Object.keys(toSoulGateReport(turn(), { eventId: '   ' }) as Record<string, unknown>)).not.toContain('eventId');
  });

  it('失败/中断回合不判：半截输出会被判成越权或虚报', () => {
    expect(toSoulGateReport(turn({ status: 'error' }))).toBeUndefined();
  });

  it('没有助手正文（或纯空白）不发：Core 会 400 text is required', () => {
    expect(toSoulGateReport(turn({ assistantText: '' }))).toBeUndefined();
    expect(toSoulGateReport(turn({ assistantText: '  \n\t ' }))).toBeUndefined();
    expect(toSoulGateReport(undefined)).toBeUndefined();
  });

  it('超长按 Core 上限先截再发（超了整条 400，不是被截断）', () => {
    const report = toSoulGateReport(turn({ assistantText: 'x'.repeat(SOUL_GATE_MAX_TEXT_CHARS + 500) }));
    expect(report?.text.length).toBe(SOUL_GATE_MAX_TEXT_CHARS);
  });

  it('空 sessionId 不落成空串', () => {
    const report = toSoulGateReport(turn({ sessionId: '  ' }));
    expect(Object.keys(report as Record<string, unknown>)).not.toContain('sessionId');
  });
});

describe('loggedFromCoreResult (t30 F1：logged 是行数不是布尔)', () => {
  it('inserted=1 判为已落库，inserted=0 判为未落库', () => {
    expect(loggedFromCoreResult({ inserted: 1 })).toBe(true);
    expect(loggedFromCoreResult({ inserted: 0 })).toBe(false);
  });

  it('多行也算落库（>0 而不是 ===1）', () => {
    expect(loggedFromCoreResult({ inserted: 2 })).toBe(true);
  });

  it('布尔形状原样接受（兼容替身/历史实现）', () => {
    expect(loggedFromCoreResult({ inserted: true })).toBe(true);
    expect(loggedFromCoreResult({ inserted: false })).toBe(false);
    expect(loggedFromCoreResult(true)).toBe(true);
  });

  it('不知道就给 undefined：不把缺字段当成「没落库」', () => {
    expect(loggedFromCoreResult(undefined)).toBeUndefined();
    expect(loggedFromCoreResult(null)).toBeUndefined();
    expect(loggedFromCoreResult({})).toBeUndefined();
    expect(loggedFromCoreResult({ inserted: '1' })).toBeUndefined();
    expect(loggedFromCoreResult(1)).toBeUndefined();
  });
});
describe('soulGateDedupeKey / createSoulGateOnce (一回合一次)', () => {
  it('键是 sessionId:turnId，缺 session 退化成 turnId，缺 turnId 就不去重', () => {
    expect(soulGateDedupeKey(turn())).toBe('sess-1:turn-1');
    expect(soulGateDedupeKey(turn({ sessionId: '' }))).toBe('turn-1');
    expect(soulGateDedupeKey(turn({ turnId: ' ' }))).toBeUndefined();
    expect(soulGateDedupeKey(undefined)).toBeUndefined();
  });

  it('firstSeen：第一次 true，之后同一个键都是 false', () => {
    const firstSeen = createSoulGateOnce();
    expect(firstSeen('sess-1:turn-1')).toBe(true);
    expect(firstSeen('sess-1:turn-1')).toBe(false);
    expect(firstSeen('sess-1:turn-2')).toBe(true);
  });

  it('有界：超过上限先丢最旧的键，不会无限长', () => {
    const firstSeen = createSoulGateOnce(2);
    expect(firstSeen('a')).toBe(true);
    expect(firstSeen('b')).toBe(true);
    expect(firstSeen('c')).toBe(true);
    // a 已被挤出：再来一次算「首次」，但 b/c 仍然记着。
    expect(firstSeen('b')).toBe(false);
    expect(firstSeen('a')).toBe(true);
  });
});
