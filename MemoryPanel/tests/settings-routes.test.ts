/**
 * Task 7（spec §4）：/api/v1/settings/{knowledge,memory}/:action 透传路由测试。
 *
 * 构造最小 Hono app（registerSettingsRoutes + validatePanelMetaHeaders 既有挂载方式），
 * stub deps.metaKernel.invoke（auth/verify 按 userType 返回）与 config，
 * 全局 fetch 用 vi.spyOn mock —— 不触达真实上游。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerSettingsRoutes } from '../src/panel/http/routes/settings.js';

const KS_BASE = 'http://ks-test:1';
const CORE_BASE = 'http://core-test:2';
const PROXY_BASE = 'http://proxy-test:3';
const KS_TOKEN = 'ks-tok';

interface InvokeEnvelope {
  code: number;
  message: string;
  request_id: string;
  data: unknown;
}

function okEnvelope(data: unknown): InvokeEnvelope {
  return { code: 0, message: 'ok', request_id: 'test-req', data };
}

/** 构造 stub deps：auth/verify 按 userType 返回；instanceRegistry 直接放行。 */
function makeDeps(userType: string): { deps: PanelDeps; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (action: string): Promise<InvokeEnvelope> => {
    if (action === 'auth/verify') {
      return okEnvelope({ valid: true, user: { user_id: 'u1', user_type: userType } });
    }
    return okEnvelope(null);
  });
  const deps = {
    config: {
      knowledge: { baseUrl: KS_BASE, authToken: KS_TOKEN, timeoutMs: 1000 },
      llmProvider: { proxyBaseUrl: PROXY_BASE },
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
  } as unknown as PanelDeps;
  return { deps, invoke };
}

function buildApp(deps: PanelDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  registerSettingsRoutes(api, deps);
  app.route('/api/v1', api);
  return app;
}

let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.restoreAllMocks();
});

/** callSettings 助手：mock 全局 fetch，POST /api/v1/settings/{target}/{action}。 */
async function callSettings(
  deps: PanelDeps,
  target: 'knowledge' | 'memory' | 'proxy-pricing',
  action: string,
  opts?: { userType?: string; body?: unknown; omitUserKey?: boolean },
): Promise<Response> {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(okEnvelope({})), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tdai-service-id': 'inst-1',
  };
  if (!opts?.omitUserKey) headers['x-tdai-user-key'] = 'uk-1';
  const app = buildApp(deps);
  return app.request(`/api/v1/settings/${target}/${action}`, {
    method: 'POST',
    headers,
    body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

describe('settings passthrough（admin 门控）', () => {
  it('非 system_admin 返回 403，不触达上游', async () => {
    const { deps, invoke } = makeDeps('member');
    const res = await callSettings(deps, 'knowledge', 'get', { userType: 'member' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    // 门控在 auth/verify 之后即短路，不产生其它内核调用
    const invokedActions = invoke.mock.calls.map((c) => c[0] as string);
    expect(invokedActions).toEqual(['auth/verify']);
  });

  it('缺 user_key 返回 400（validatePanelMetaHeaders）', async () => {
    const { deps } = makeDeps('system_admin');
    const res = await callSettings(deps, 'knowledge', 'get', { omitUserKey: true });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admin knowledge/get 透传到 KS /v3/admin/settings/get 并注入 Bearer', async () => {
    const { deps } = makeDeps('system_admin');
    const res = await callSettings(deps, 'knowledge', 'get', { userType: 'system_admin' });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${KS_BASE}/v3/admin/settings/get`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KS_TOKEN}`);
    expect(headers['content-type']).toBe('application/json');
    const resBody = (await res.json()) as InvokeEnvelope;
    expect(resBody.code).toBe(0);
  });

  it('admin knowledge/set 透传请求体到上游', async () => {
    const { deps } = makeDeps('system_admin');
    const payload = { settings: { wiki_rag_top_k: 8 } };
    const res = await callSettings(deps, 'knowledge', 'set', {
      userType: 'system_admin',
      body: payload,
    });
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v3/admin/settings/set');
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it('admin memory/get 透传到实例 gatewayEndpoint 并注入 gatewayApiKey + x-tdai-service-id', async () => {
    const { deps } = makeDeps('system_admin');
    const res = await callSettings(deps, 'memory', 'get', { userType: 'system_admin' });
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${CORE_BASE}/v3/admin/settings/get`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer core-key');
    // Core 网关强制要求 x-tdai-service-id（缺失 → 401，2026-09-09 UI 切 Memory 页签报错根因）
    expect(headers['x-tdai-service-id']).toBe('inst-1');
  });

  it('memory/revectorize 返回 400（仅 knowledge 支持）', async () => {
    const { deps } = makeDeps('system_admin');
    const res = await callSettings(deps, 'memory', 'revectorize', { userType: 'system_admin' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('未知 action 返回 400', async () => {
    const { deps } = makeDeps('system_admin');
    const res = await callSettings(deps, 'knowledge', 'nope', { userType: 'system_admin' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上游网络失败返回 502 Control envelope', async () => {
    const { deps } = makeDeps('system_admin');
    fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    const app = buildApp(deps);
    const res = await app.request('/api/v1/settings/knowledge/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'inst-1', 'x-tdai-user-key': 'uk-1' },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: number; message: string };
    expect(body.code).toBe(502);
    expect(body.message).toBe('UPSTREAM_ERROR');
  });
});

describe('settings proxy-pricing 透传（spec §9.3）', () => {
  it('非 admin 不可访问 proxy-pricing（403，不触达上游）', async () => {
    const { deps, invoke } = makeDeps('member');
    const res = await callSettings(deps, 'proxy-pricing', 'get', { userType: 'member' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    const invokedActions = invoke.mock.calls.map((c) => c[0] as string);
    expect(invokedActions).toEqual(['auth/verify']);
  });

  it('admin get 透传为上游 GET → proxy /v3/admin/credit-pricing', async () => {
    const { deps } = makeDeps('system_admin');
    const res = await callSettings(deps, 'proxy-pricing', 'get', { userType: 'system_admin' });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(1);
    const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
    expect(url).toContain('/v3/admin/credit-pricing');
    expect(url).toContain(PROXY_BASE);
    // 上游只有 GET/PUT/DELETE —— panel POST 必须翻译为 GET（无 body）
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const resBody = (await res.json()) as InvokeEnvelope;
    expect(resBody.code).toBe(0);
  });

  it('admin set 透传为上游 PUT 且 body 原样透传（{ models }）', async () => {
    const { deps } = makeDeps('system_admin');
    const payload = {
      models: [
        { name: 'model_a', modelName: 'model_a', input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 0.2, cacheWrite1h: 0.3 },
      ],
    };
    const res = await callSettings(deps, 'proxy-pricing', 'set', {
      userType: 'system_admin',
      body: payload,
    });
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
    expect(url).toContain('/v3/admin/credit-pricing');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it('action 限定 get|set，其余 400', async () => {
    const { deps } = makeDeps('system_admin');
    const res = await callSettings(deps, 'proxy-pricing', 'delete', { userType: 'system_admin' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
