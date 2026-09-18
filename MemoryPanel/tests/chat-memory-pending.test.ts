/**
 * T7b（O13 UI）：/chat-memory/pending/list|decide BFF 路由测试。
 * 镜像 tests/chat-memory-identity-read.test.ts 的 makeDeps/buildApp/call/mockKernelFetch。
 *
 * 覆盖：
 *   - list 透传 idFields（owner 借用语义）到 /v3/core-memory/pending/list
 *   - decide 透传 pending_id/decision；非属主 403 NOT_ASSET_OWNER
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemoryRoutes } from '../src/panel/http/routes/chat-memory.js';
import { FetchKernelHttpAdapter } from '../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';

const CORE_BASE = 'http://core-test:2';
const BLOCK_ID = 'chat_memory-t1-agt-1';

interface InvokeEnvelope {
  code: number;
  message: string;
  request_id: string;
  data: unknown;
}

function okEnvelope(data: unknown): InvokeEnvelope {
  return { code: 0, message: 'ok', request_id: 'test-req', data };
}

function makeDeps(opts?: { callerUserId?: string; assetOwner?: string }): { deps: PanelDeps } {
  const callerUserId = opts?.callerUserId ?? 'u1';
  const assetOwner = opts?.assetOwner ?? 'u1';
  const invoke = vi.fn(async (action: string): Promise<InvokeEnvelope> => {
    if (action === 'auth/verify') {
      return okEnvelope({ valid: true, user: { user_id: callerUserId, user_type: 'member' } });
    }
    if (action === 'asset/get') {
      return okEnvelope({
        asset_id: BLOCK_ID,
        team_id: 't1',
        asset_type: 'chat_memory',
        name: 'mem',
        owner_user_id: assetOwner,
        visibility: 'private',
        status: 'ready',
      });
    }
    if (action === 'team-member/get') {
      return okEnvelope({ team_id: 't1', user_id: callerUserId });
    }
    return okEnvelope(null);
  });
  const deps = {
    config: {
      knowledge: { baseUrl: 'http://ks-test:1', authToken: 'ks-tok', timeoutMs: 1000 },
      llmProvider: { proxyBaseUrl: 'http://proxy-test:3' },
      metadataRemoteTimeoutMs: 1000,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    instanceRegistry: {
      resolve: () => ({
        instance_id: 'inst-1',
        gateway_endpoint: CORE_BASE,
        api_key: 'core-key',
      }),
    },
    metaKernel: { invoke },
    kernelHttp: new FetchKernelHttpAdapter(),
    ingestProgressStore: { get: () => null },
  } as unknown as PanelDeps;
  return { deps };
}

function buildApp(deps: PanelDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  registerChatMemoryRoutes(api, deps);
  app.route('/api/v1', api);
  return app;
}

let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.restoreAllMocks();
});

function mockKernelFetch(payload: { status?: number; body: unknown } = { body: { code: 0, message: 'ok', data: {} } }) {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload.body), {
        status: payload.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
}

async function call(deps: PanelDeps, path: string, body: unknown): Promise<Response> {
  const app = buildApp(deps);
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'uk-1',
    },
    body: JSON.stringify(body),
  });
}

async function lastKernelCall(): Promise<{ url: string; init: RequestInit }> {
  const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  return { url, init };
}

describe('POST /chat-memory/pending/list', () => {
  it('透传 idFields（owner 借用语义）到 /v3/core-memory/pending/list', async () => {
    const { deps } = makeDeps();
    const pending = [
      { pending_id: 'pd-1', slot: 'strict_rule', content: '绝不把用户的隐私数据泄露给第三方', version: 1 },
    ];
    mockKernelFetch({ body: okEnvelope({ pending }) });
    const res = await call(deps, '/api/v1/chat-memory/pending/list', { block_id: BLOCK_ID });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { code: number; data?: { pending?: unknown[] } };
    expect(json.code).toBe(0);
    expect(json.data?.pending).toEqual(pending);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/core-memory/pending/list`);
    const sent = JSON.parse(String(init.body)) as Record<string, string>;
    expect(sent.user_id).toBe('u1'); // owner 借用语义
    expect(sent.team_id).toBe('t1');
    expect(sent.agent_id).toBe('agt-1');
  });
});

describe('POST /chat-memory/pending/decide', () => {
  it('透传 pending_id/decision 到 /v3/core-memory/pending/decide', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: okEnvelope({ pending_id: 'pd-1', decision: 'adopted', slot: 'strict_rule' }) });
    const res = await call(deps, '/api/v1/chat-memory/pending/decide', {
      block_id: BLOCK_ID,
      pending_id: 'pd-1',
      decision: 'adopted',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { code: number; data?: { pending_id?: string; decision?: string } };
    expect(json.code).toBe(0);
    expect(json.data?.pending_id).toBe('pd-1');
    expect(json.data?.decision).toBe('adopted');
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/core-memory/pending/decide`);
    const sent = JSON.parse(String(init.body)) as Record<string, string>;
    expect(sent.pending_id).toBe('pd-1');
    expect(sent.decision).toBe('adopted');
    expect(sent.user_id).toBe('u1');
  });

  it('非属主 → 403 NOT_ASSET_OWNER', async () => {
    const { deps } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1' });
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/pending/decide', {
      block_id: BLOCK_ID,
      pending_id: 'pd-1',
      decision: 'adopted',
    });
    expect(res.status).toBe(403);
  });
});
