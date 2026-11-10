import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { MemoryClient, type MemoryClientDeps, type SoulEventPayload } from '../src/memory-client.js';
import { callsTo, coreFixture, envelope } from './helpers/core-fixtures.js';

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

/** 一条真实形状的工具事件（由 toToolEvents 产出的样子）。 */
const PAYLOAD: SoulEventPayload = {
  dedupe_key: 'dsh:sess-1:c1',
  source_kind: 'test',
  summary: 'test: ops_bash npx vitest run',
  session_id: 'sess-1',
  evidence: [{ role: 'tool', quote: 'Tests 46 passed (46)', record_id: 'c1' }],
  action: { tool: 'ops_bash', tool_call_id: 'c1', args_digest: 'a'.repeat(64), result_status: 'success' },
  epistemic: 'observed',
  confidence: 0.9,
};

/**
 * P1-B W3：POST /v3/soul/event 的插件侧合同。
 * 租户三元组只走 x-tdai-* 头（Core 从 header 取，缺一 422），body 里不带；
 * 信封 code!==0 必须抛（事实来源不能静默吞），duplicate 不抛。
 */
describe('postSoulEvent (P1-B W3)', () => {
  it('POST /v3/soul/event：身份四头齐全，body 不带三元组，返回 event_id', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl);
    const result = await client.postSoulEvent(PAYLOAD, 'sess-1');

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/v3/soul/event');
    expect(calls[0].method).toBe('POST');
    // 头：service + 三元组（Core 的 422 就是因为缺这几个头）。
    expect(calls[0].headers['x-tdai-service-id']).toBe('default');
    expect(calls[0].headers['x-tdai-team-id']).toBe('team-1');
    expect(calls[0].headers['x-tdai-agent-id']).toBe('agt-1');
    expect(calls[0].headers['x-tdai-user-id']).toBe('usr-1');
    expect(calls[0].headers.authorization).toBe('Bearer secret-key');
    // body：只有事件字段，没有 team_id/agent_id/user_id（那是别的路由的口径）。
    expect(calls[0].body).toEqual(PAYLOAD);
    expect(Object.keys(calls[0].body as Record<string, unknown>)).not.toContain('team_id');
    expect(result).toEqual({ eventId: 'evt-1', duplicate: false });
  });

  it('同 dedupe_key 再投一次：duplicate=true，不抛（重投不是错误）', async () => {
    const { fetchImpl, calls } = coreFixture();
    const client = createClient(fetchImpl);
    const first = await client.postSoulEvent(PAYLOAD, 'sess-1');
    const second = await client.postSoulEvent(PAYLOAD, 'sess-1');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    // 两次都发了请求：判重在 Core 侧，插件不做本地去重（否则重启就丢判重语义）。
    expect(callsTo(calls, '/v3/soul/event')).toHaveLength(2);
    expect(second.eventId).toBe(first.eventId);
  });

  it('信封 code!==0 抛错（400 invalid_field 不能被当成已落库）', async () => {
    const fetchImpl = (async () => envelope({}, 400, 'invalid_field: action.result_status')) as unknown as typeof fetch;
    const client = createClient(fetchImpl);
    await expect(client.postSoulEvent(PAYLOAD, 'sess-1')).rejects.toThrow(/invalid_field/);
  });

  it('非信封应答也抛（200 + 纯文本不是成功）', async () => {
    const fetchImpl = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const client = createClient(fetchImpl);
    await expect(client.postSoulEvent(PAYLOAD, 'sess-1')).rejects.toThrow(/not JSON|not an envelope/);
  });

  it('身份缺失时抛（不发请求，也不假装写成功）', async () => {
    const fetchImpl = vi.fn();
    const client = createClient(fetchImpl as unknown as typeof fetch, {
      identity: { serviceId: 'default', teamId: '', agentId: '', userId: '' },
    });
    await expect(client.postSoulEvent(PAYLOAD, 'sess-1')).rejects.toThrow(/identity missing/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('网络异常向上抛，由 index.ts 的 warnOnce 报一次', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const client = createClient(fetchImpl);
    await expect(client.postSoulEvent(PAYLOAD, 'sess-1')).rejects.toThrow(/ECONNREFUSED/);
  });
});
