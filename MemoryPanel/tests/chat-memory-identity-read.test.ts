/**
 * DS-SOUL-MEMORY-002 P1（U1）：/chat-memory/identity/read BFF 透传测试。
 * 镜像 tests/chat-memory-values.test.ts 的构造方式（makeDeps/buildApp/call/mockKernelFetch）。
 *
 * 覆盖：
 *   - POST /api/v1/chat-memory/identity/read → /v3/core-memory/read（只取 slots，零业务覆写）
 *   - idFields 形状（owner 借用语义）与读 ACL 与 values/list 同款
 * 另含 identity-utils 纯函数分组/空态判定（宁缺毋滥）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemoryRoutes } from '../src/panel/http/routes/chat-memory.js';
import { FetchKernelHttpAdapter } from '../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';
import { splitIdentitySlots, identityEmpty } from '../web/src/pages/ChatMemoryPage/components/identity-utils.js';

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

function makeDeps(opts?: { callerUserId?: string; assetOwner?: string; visibility?: string }): {
  deps: PanelDeps;
} {
  const callerUserId = opts?.callerUserId ?? 'u1';
  const assetOwner = opts?.assetOwner ?? 'u1';
  const visibility = opts?.visibility ?? 'private';
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
        visibility,
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

// ── identity/read ──

describe('POST /chat-memory/identity/read', () => {
  it('透传 idFields（owner 借用语义）到 /v3/core-memory/read，只返回 slots', async () => {
    const { deps } = makeDeps();
    const slots = [
      { slot: 'identity', content: '用户是家里的首席厨师', version: 3 },
      { slot: 'self_identity', content: '- 我在这个团队负责技术评审', version: 1 },
    ];
    mockKernelFetch({
      body: { code: 0, message: 'ok', data: { slots, values: [{ value_id: 'x' }] } },
    });
    const res = await call(deps, '/api/v1/chat-memory/identity/read', { block_id: BLOCK_ID });
    expect(res.status).toBe(200);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/core-memory/read`);
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.team_id).toBe('t1');
    expect(sent.agent_id).toBe('agt-1');
    expect(sent.user_id).toBe('u1');
    expect(sent.session_id).toBe('default');
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.data).toEqual({ slots });
  });

  it('缺 block_id 返回 400；读权限不过返回 403', async () => {
    const { deps } = makeDeps();
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/identity/read', {});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const { deps: deps2 } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1', visibility: 'private' });
    const res2 = await call(deps2, '/api/v1/chat-memory/identity/read', { block_id: BLOCK_ID });
    expect(res2.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── identity-utils 纯函数 ──

describe('identity-utils 分组与空态', () => {
  it('self/identity 分组；空内容剔除；双空 → identityEmpty', () => {
    const { self, user } = splitIdentitySlots([
      { slot: 'self_identity', content: '- 我负责技术评审' },
      { slot: 'identity', content: '用户是家里的首席厨师' },
      { slot: 'identity', content: '   ' },
      { slot: 'persona', content: '其他槽不进身份区' },
    ]);
    expect(self).toEqual(['- 我负责技术评审']);
    expect(user).toEqual(['用户是家里的首席厨师']);
    expect(identityEmpty(user, self)).toBe(false);
    expect(identityEmpty([], [])).toBe(true);
  });
});
