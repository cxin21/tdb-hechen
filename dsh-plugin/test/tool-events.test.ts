import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyToolEventKind, resultStatusOf, toToolEvents, type ToolCallRecord } from '../src/tool-events.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 一条完整可发的调用（有 callId、有 result、有会话）。 */
function call(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { name: 'ops_bash', callId: 'c1', arguments: { command: 'ls -la' }, result: 'file.txt', ...overrides };
}

/**
 * P1-B W3：DSH 工具调用 → soul 事件。四类来源必须分得开（spec §4.2），
 * 否则「我验证过」和「我改完了」在人格层同权，就没法证伪。
 */
describe('tool event classification (P1-B W3)', () => {
  const kindOf = (name: string, command: string) => classifyToolEventKind(name, command);

  it('git commit 判 commit', () => {
    expect(kindOf('ops_bash', 'git commit -m "feat: soul event"')).toBe('commit');
  });

  it('commit 优先于命令里的 test 字样（提交不是验证）', () => {
    expect(kindOf('ops_bash', 'git commit -m "fix failing test"')).toBe('commit');
  });

  it('git revert 判 rollback', () => {
    expect(kindOf('ops_bash', 'git revert --no-edit HEAD')).toBe('rollback');
  });

  it('git reset --hard / git restore 判 rollback，且优先于 test', () => {
    expect(kindOf('ops_bash', 'git reset --hard HEAD~1')).toBe('rollback');
    expect(kindOf('ops_bash', 'git restore .')).toBe('rollback');
    expect(kindOf('ops_bash', 'git revert HEAD; npm test')).toBe('rollback');
  });

  it('跑测试/类型检查判 test', () => {
    expect(kindOf('ops_bash', 'npx vitest run')).toBe('test');
    expect(kindOf('ops_bash', 'npm test')).toBe('test');
    expect(kindOf('ops_bash', 'python -m pytest -q')).toBe('test');
    expect(kindOf('ops_bash', 'npx tsc --noEmit -p tsconfig.json')).toBe('test');
    expect(kindOf('run_typecheck', '')).toBe('test');
  });

  it('其余判 tool（读文件、列目录、跑无关命令）', () => {
    expect(kindOf('ops_bash', 'ls -la')).toBe('tool');
    expect(kindOf('memory_recall', '')).toBe('tool');
  });

  it('test 只认整词：attestation 这类词不算跑过测试', () => {
    expect(kindOf('ops_bash', 'node -e "console.log(1)" --attestation')).toBe('tool');
  });

  it('arguments 是字符串时也认命令（有些工具直接传命令串）', () => {
    const { events } = toToolEvents([call({ arguments: 'git commit -m x' })], 'sess-1');
    expect(events[0].source_kind).toBe('commit');
  });
});

describe('tool event payload shape', () => {
  it('dedupe_key 用 dsh:<session>:<callId>，证据的 record_id 记 tool_call_id', () => {
    // 带判据的真实回执：命令输出 + 退出码（结果三态由 resultStatusOf 判）。
    const { events, skipped } = toToolEvents([call({ result: 'file.txt' + String.fromCharCode(10) + '[exit code: 0]' })], 'sess-9');
    expect(skipped).toBe(0);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.dedupe_key).toBe('dsh:sess-9:c1');
    expect(event.session_id).toBe('sess-9');
    expect(event.evidence).toEqual([{ role: 'tool', quote: 'file.txt' + String.fromCharCode(10) + '[exit code: 0]', record_id: 'c1' }]);
    // 工具自报的「观察到了」：有工具证据才允许 observed，但只给 0.9。
    expect(event.epistemic).toBe('observed');
    expect(event.confidence).toBe(0.9);
    expect(event.action).toEqual({
      tool: 'ops_bash',
      tool_call_id: 'c1',
      args_digest: sha256(JSON.stringify({ command: 'ls -la' })),
      result_status: 'success',
    });
  });

  it('summary 只取命令首行，且命令部分截到 120', () => {
    const multiline = toToolEvents([call({ arguments: { command: 'ls -la\necho hi' } })], 'sess-1').events[0];
    expect(multiline.summary).toBe('tool: ops_bash ls -la');
    const long = toToolEvents([call({ arguments: { command: 'x'.repeat(200) } })], 'sess-1').events[0];
    expect(long.summary).toBe('tool: ops_bash ' + 'x'.repeat(120));
  });

  it('evidence.quote 截到 400（Core 侧上限），不上送整份日志', () => {
    const event = toToolEvents([call({ result: 'r'.repeat(900) })], 'sess-1').events[0];
    expect(event.evidence?.[0].quote).toHaveLength(400);
  });

  it('超长 dedupe_key 退化成哈希：仍 ≤200，且同一次调用恒等', () => {
    const longCallId = 'c'.repeat(300);
    const first = toToolEvents([call({ callId: longCallId })], 'sess-1').events[0];
    const again = toToolEvents([call({ callId: longCallId })], 'sess-1').events[0];
    expect(first.dedupe_key.length).toBeLessThanOrEqual(200);
    expect(first.dedupe_key.startsWith('dsh:')).toBe(true);
    expect(first.dedupe_key).toBe(again.dedupe_key);
  });
});

describe('tool calls without evidence are skipped, not invented', () => {
  it('没有 result 的调用跳过，只计数', () => {
    const { events, skipped } = toToolEvents([call({ result: undefined })], 'sess-1');
    expect(events).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('空白 result 也算没有证据', () => {
    const { events, skipped } = toToolEvents([call({ result: '  \n ' })], 'sess-1');
    expect(events).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('没有 callId（无法判重、无 record_id）跳过', () => {
    const { events, skipped } = toToolEvents([call({ callId: undefined })], 'sess-1');
    expect(events).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('没有 sessionId 跳过（事件不该串到别人的会话）', () => {
    const { events, skipped } = toToolEvents([call()], '   ');
    expect(events).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('好坏混在同一批：好的照发，坏的只计数', () => {
    const { events, skipped } = toToolEvents([
      call({ callId: 'c1' }),
      call({ callId: 'c2', result: undefined }),
      call({ callId: 'c3' }),
    ], 'sess-1');
    expect(events.map((event) => event.dedupe_key)).toEqual(['dsh:sess-1:c1', 'dsh:sess-1:c3']);
    expect(skipped).toBe(1);
  });
});

describe('result_status tri-state (success | fail | unknown)', () => {
  it('exit code 0 / passed / ok → success', () => {
    expect(resultStatusOf('[exit code: 0]')).toBe('success');
    expect(resultStatusOf('Tests  46 passed (46)')).toBe('success');
    expect(resultStatusOf('ok')).toBe('success');
    expect(resultStatusOf('{"exitCode":0}')).toBe('success');
  });

  it('exit code 非 0 / failed / error → fail', () => {
    expect(resultStatusOf('[exit code: 1]')).toBe('fail');
    expect(resultStatusOf('1 failed | 45 passed (46)')).toBe('fail');
    expect(resultStatusOf('Error: cannot find module')).toBe('fail');
  });

  it('exit code 压过文字：日志里写着 passed 但最终退出码非 0，就是 fail', () => {
    expect(resultStatusOf('all passed\n[exit code: 2]')).toBe('fail');
  });

  it('「0 failed」这类零数量不算失败', () => {
    expect(resultStatusOf('0 failed, 12 passed')).toBe('success');
  });

  it('看不出结论就是 unknown（不猜）', () => {
    expect(resultStatusOf('compiled 12 files')).toBe('unknown');
    expect(resultStatusOf(undefined)).toBe('unknown');
  });

  it('result_status 落进 payload，且取值是 Core 的 fail（不是 failure）', () => {
    const event = toToolEvents([call({ result: '[exit code: 1]' })], 'sess-1').events[0];
    expect(event.action?.result_status).toBe('fail');
  });
});
