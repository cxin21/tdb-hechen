import { describe, expect, it, vi } from 'vitest';
import {
  createInjectionLog,
  NOOP_INJECTION_LOG,
  resolveInjectionLogPath,
  type InjectionLogEvent,
} from '../src/injection-log.js';
import type { DebugLogSink } from '../src/debug-log.js';

/** In-memory sink: records every append so we can assert on the JSONL lines. */
function makeSink(): DebugLogSink & { lines: string[]; rotations: number } {
  const lines: string[] = [];
  let size = 0;
  const state = {
    lines,
    rotations: 0,
    size: () => size,
    append(text: string) {
      lines.push(text);
      size += text.length;
    },
    rotate() {
      state.rotations += 1;
      size = 0;
    },
  };
  return state as DebugLogSink & { lines: string[]; rotations: number };
}

describe('resolveInjectionLogPath', () => {
  it('honours TDB_PERSONA_LOG verbatim', () => {
    expect(resolveInjectionLogPath({ TDB_PERSONA_LOG: '/tmp/x.jsonl', TDB_DATA_DIR: 'D:/other' })).toBe('/tmp/x.jsonl');
  });

  it('falls back to <TDB_DATA_DIR>/logs/persona-injection.jsonl', () => {
    expect(resolveInjectionLogPath({ TDB_DATA_DIR: 'E:/data' })).toMatch(/logs[\\/]persona-injection\.jsonl$/);
    expect(resolveInjectionLogPath({ TDB_DATA_DIR: 'E:/data' })).toContain('E:');
  });

  it('defaults under D:/TDB/data when nothing is set', () => {
    const p = resolveInjectionLogPath({});
    expect(p).toMatch(/persona-injection\.jsonl$/);
    expect(p.toLowerCase()).toContain('tdb');
  });
});

describe('createInjectionLog', () => {
  it('writes one JSON object per line with ts first and carries no text body', () => {
    const sink = makeSink();
    const log = createInjectionLog({ path: 'x.jsonl', sink });
    // P1-2：人格卡拆成两个 section，section-read 行带 section 区分是哪一段。
    const event: InjectionLogEvent = {
      event: 'section-read',
      section: 'identity',
      sessionId: 'team:user:agent',
      turn: 7,
      hash: 'deadbeef',
      chars: 412,
    };
    log.record(event);
    expect(sink.lines).toHaveLength(1);
    const line = sink.lines[0]!;
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe('ts');
    expect(parsed.event).toBe('section-read');
    expect(parsed.section).toBe('identity');
    expect(parsed.chars).toBe(412);
    expect(parsed.hash).toBe('deadbeef');
    // 隐私边界：只允许长度/指纹/会话键/写入进程号，不许出现正文。
    expect(Object.keys(parsed).sort()).toEqual(['chars', 'event', 'hash', 'pid', 'section', 'sessionId', 'ts', 'turn']);
  });

  it('keeps identity/anchor section-read lines distinguishable, and old lines without section', () => {
    const sink = makeSink();
    const log = createInjectionLog({ path: 'x.jsonl', sink });
    log.record({ event: 'section-read', section: 'identity', sessionId: 's1', hash: 'aaaa', chars: 774 });
    log.record({ event: 'section-read', section: 'anchor', sessionId: 's1', hash: 'bbbb', chars: 82 });
    // 旧行（拆分前的整卡 section）没有 section 字段：读历史日志时仍要认。
    log.record({ event: 'section-read', sessionId: 's1', hash: 'cccc', chars: 977 });
    const [identity, anchor, legacy] = sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(identity).toMatchObject({ section: 'identity', hash: 'aaaa', chars: 774 });
    expect(anchor).toMatchObject({ section: 'anchor', hash: 'bbbb', chars: 82 });
    expect(legacy?.section).toBeUndefined();
    expect(legacy).toMatchObject({ hash: 'cccc', chars: 977 });
  });

  it('records a skip as chars 0 (a skip must never look like an injection)', () => {
    const sink = makeSink();
    const log = createInjectionLog({ path: 'x.jsonl', sink });
    log.record({ event: 'turn-skip', turn: 8, hash: 'feedface', chars: 0 });
    const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(parsed.event).toBe('turn-skip');
    expect(parsed.chars).toBe(0);
  });

  it('records a card bind and its failure reason (task-32)', () => {
    const sink = makeSink();
    const log = createInjectionLog({ path: 'x.jsonl', sink });
    log.record({ event: 'card-bound', sessionId: 's1', identity: 'team/user/agentA', version: 7, hash: 'h7', chars: 120 });
    log.record({ event: 'card-bound-failed', sessionId: 's1', identity: 'team/user/agentB', reason: 'timeout', keptVersion: 7, chars: 120 });
    const bound = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(bound).toMatchObject({ event: 'card-bound', sessionId: 's1', identity: 'team/user/agentA', version: 7, chars: 120 });
    const failed = JSON.parse(sink.lines[1]!) as Record<string, unknown>;
    // identity 是「这次尝试绑定的身份」，keptVersion 是「实际保留的那份」。
    expect(failed).toMatchObject({ event: 'card-bound-failed', identity: 'team/user/agentB', reason: 'timeout', keptVersion: 7 });
    expect(failed.chars).toBe(120);
  });

  it('records where the section session key came from (task-32)', () => {
    const sink = makeSink();
    const log = createInjectionLog({ path: 'x.jsonl', sink });
    log.record({ event: 'section-read', sessionId: 's1', version: 7, hash: 'h7', chars: 120, sidSource: 'context-agent', sidField: 'agent.id' });
    log.record({ event: 'section-read', chars: 0, sidSource: 'none', sidField: 'none' });
    const ok = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(ok).toMatchObject({ sidSource: 'context-agent', sidField: 'agent.id' });
    const none = JSON.parse(sink.lines[1]!) as Record<string, unknown>;
    expect(none).toMatchObject({ chars: 0, sidSource: 'none' });
    expect(none.sessionId).toBeUndefined();
  });

  it('rotates before the line that would exceed maxBytes', () => {
    const sink = makeSink();
    const log = createInjectionLog({ path: 'x.jsonl', sink, maxBytes: 120 });
    for (let i = 0; i < 5; i += 1) log.record({ event: 'section-read', chars: 10, hash: 'h' + String(i) });
    expect(sink.rotations).toBeGreaterThan(0);
    // 轮转只换文件，不丢行：每一行仍是完整可解析的 JSON。
    for (const line of sink.lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('fail-open: a throwing sink reports once and then goes silent', () => {
    const onError = vi.fn();
    let calls = 0;
    const log = createInjectionLog({
      path: 'x.jsonl',
      onError,
      sink: {
        size: () => 0,
        append: () => {
          calls += 1;
          throw new Error('disk full');
        },
        rotate: () => {},
      },
    });
    expect(() => log.record({ event: 'section-read', chars: 1, hash: 'h' })).not.toThrow();
    expect(() => log.record({ event: 'section-read', chars: 1, hash: 'h' })).not.toThrow();
    expect(calls).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(log.failed()).toBe(true);
  });

  it('NOOP never throws and never claims failure', () => {
    NOOP_INJECTION_LOG.record({ event: 'turn-append', chars: 3, hash: 'h' });
    expect(NOOP_INJECTION_LOG.failed()).toBe(false);
  });

  it('records an agent/created bind probe with its outcome and cost (m06889)', () => {
    const sink = makeSink();
    const log = createInjectionLog({ path: 'x.jsonl', sink });
    log.record({ event: 'bind-probe', sessionId: 's9', chars: 0, reason: 'threw:no active turn', ms: 3 });
    const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    // The probe must carry the two facts that decide the design: did it throw,
    // and did anything end up in the map.
    expect(parsed.event).toBe('bind-probe');
    expect(parsed.reason).toBe('threw:no active turn');
    expect(parsed.chars).toBe(0);
    expect(parsed.ms).toBe(3);
  });
});
