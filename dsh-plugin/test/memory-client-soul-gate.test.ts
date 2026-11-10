import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { MemoryClient, type MemoryClientDeps } from '../src/memory-client.js';
import type { SoulGateReportPayload } from '../src/gate-report.js';
import { callsTo, coreFixture } from './helpers/core-fixtures.js';

function createClient(fetchImpl: typeof fetch, overrides: Partial<MemoryClientDeps> = {}): MemoryClient {
  return new MemoryClient({
    baseUrl: 'http://core.local:8420/',
    apiKeyRef: 'TDB_API_KEY',
    identity: { serviceId: 'default', teamId: 'team-1', agentId: 'agt-1', userId: 'usr-1' },
    requestTimeoutMs: 1000,
    paths: DEFAULT_CONFIG.paths,
    resolveApiKey: async () => 'secret-key',
    ...overrides,
    fetchImpl,
  });
}

const REPORT: SoulGateReportPayload = { text: '全绿，46 个用例通过。', stage: 'output', sessionId: 'sess-1' };

/**
 * P7 输出侧：POST /v3/soul/gate 的插件侧合同。
 * 租户三元组只走 x-tdai-* 头（缺一 422）；body 只有 text/stage（+ 有则带上的标识）；
 * 失败折成 ok:false（不抛、不重投），由 index.ts 的 warnOnce 报一次。
 */
describe('reportSoulGate (P7 output gate)', () => {
  it('POST /v3/soul/gate：body 带 text 与 stage，身份走三元组头，会话标识双份', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl);
    const outcome = await client.reportSoulGate(REPORT, 'sess-1');

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/v3/soul/gate');
    expect(calls[0].method).toBe('POST');
    // body：Core 只读 text/stage（soul-gate-endpoint.ts:218/:231），三元组不进 body。
    expect(calls[0].body).toEqual({ text: REPORT.text, stage: 'output', sessionId: 'sess-1' });
    expect(Object.keys(calls[0].body as Record<string, unknown>)).not.toContain('team_id');
    // 头：service + 三元组 + 规范会话头 + Bearer。
    expect(calls[0].headers['x-tdai-service-id']).toBe('default');
    expect(calls[0].headers['x-tdai-team-id']).toBe('team-1');
    expect(calls[0].headers['x-tdai-agent-id']).toBe('agt-1');
    expect(calls[0].headers['x-tdai-user-id']).toBe('usr-1');
    expect(calls[0].headers['x-tdai-session-id']).toBe('sess-1');
    expect(calls[0].headers.authorization).toBe('Bearer secret-key');
    // 应答只取事实，decision 恒 allow（shadow）。
    expect(outcome).toEqual({ ok: true, decision: 'allow', shadow: true, logged: true });
  });

  it('没有会话标识时不发空串：body 与头里都不出现 sessionId', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl);
    await client.reportSoulGate({ text: '一句话。', stage: 'output' });

    expect(Object.keys(callsTo(calls, '/v3/soul/gate')[0].body as Record<string, unknown>)).not.toContain('sessionId');
    expect(callsTo(calls, '/v3/soul/gate')[0].headers['x-tdai-session-id']).toBeUndefined();
  });

  it('有真实事件 id 才带', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl);
    await client.reportSoulGate({ ...REPORT, eventId: 'evt-7' }, 'sess-1');
    expect(callsTo(calls, '/v3/soul/gate')[0].body).toMatchObject({ eventId: 'evt-7' });
  });

  it('HTTP 500 折成 ok:false，不抛（shadow 期判定失败不是回合故障）', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const client = createClient(fetchImpl);
    const outcome = await client.reportSoulGate(REPORT, 'sess-1');
    expect(outcome).toMatchObject({ ok: false, status: 500, reason: 'HTTP 500' });
  });

  it('传输异常也折成 ok:false，不抛', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const client = createClient(fetchImpl);
    const outcome = await client.reportSoulGate(REPORT, 'sess-1');
    expect(outcome.ok).toBe(false);
    expect(String(outcome.reason)).toContain('ECONNREFUSED');
  });

  it('身份缺失时不发请求（也不假装判过）', async () => {
    const fetchImpl = vi.fn();
    const client = createClient(fetchImpl as unknown as typeof fetch, {
      identity: { serviceId: 'default', teamId: '', agentId: '', userId: '' },
    });
    const outcome = await client.reportSoulGate(REPORT, 'sess-1');
    expect(outcome.ok).toBe(false);
    expect(String(outcome.reason)).toContain('identity missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /** Core 真实应答形状：logged 是 INSERT OR IGNORE 的行数，不是布尔（t30 F1）。 */
  function gateResponse(logged: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify({ code: 0, message: 'ok', request_id: 'req-1', data: {
        stage: 'output',
        decision: 'allow',
        shadow: true,
        wouldDecision: 'allow',
        matched: false,
        hits: [],
        conflict: 'none',
        digest: 'sha256:deadbeef',
        logged,
        dilemmaId: null,
      } }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  }

  it('logged 按 inserted 数判：Core 回 { inserted: 1 } → 标为已落库', async () => {
    const client = createClient(gateResponse({ inserted: 1 }));
    const outcome = await client.reportSoulGate(REPORT, 'sess-1');
    // index.ts 的 debug 日志只打 {decision, shadow, logged} 三字段，故这里钉整份事实。
    expect(outcome).toEqual({ ok: true, decision: 'allow', shadow: true, logged: true });
  });

  it('logged 按 inserted 数判：Core 回 { inserted: 0 } → 标为未落库（重放已有行）', async () => {
    const client = createClient(gateResponse({ inserted: 0 }));
    const outcome = await client.reportSoulGate(REPORT, 'sess-1');
    expect(outcome).toEqual({ ok: true, decision: 'allow', shadow: true, logged: false });
  });
});
