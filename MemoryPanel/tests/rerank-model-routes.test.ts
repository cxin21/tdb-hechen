/**
 * P1 task-4：/api/v1/rerank-model/{status,download} 透传路由测试。
 *
 * 与 settings-routes.test.ts 同款 harness：最小 Hono app + stub metaKernel.invoke
 * （auth/verify 按 userType 放行）+ 全局 fetch vi.spyOn mock —— 不触达真实上游。
 * 验证：admin 门控、action 白名单、转发目标 URL 与注入头（Core 网关要求
 * x-tdai-service-id，存在 api_key 时叠加 Bearer）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerSettingsRoutes } from '../src/panel/http/routes/settings.js';

const CORE_BASE = 'http://core-test:2';

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
function makeDeps(userType: string): PanelDeps {
  const invoke = vi.fn(async (action: string): Promise<InvokeEnvelope> => {
    if (action === 'auth/verify') {
      return okEnvelope({ valid: true, user: { user_id: 'u1', user_type: userType } });
    }
    return okEnvelope(null);
  });
  return {
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
  } as unknown as PanelDeps;
}

function buildApp(deps: PanelDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  registerSettingsRoutes(api, deps);
  app.route('/api/v1', api);
  return app;
}

/** callRerankModel 助手：mock 全局 fetch，POST /api/v1/rerank-model/:action。 */
async function callRerankModel(
  deps: PanelDeps,
  action: string,
  opts?: { userType?: string; omitUserKey?: boolean },
): Promise<Response> {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify(
          okEnvelope({ state: 'idle', percent: 0, repo: 'Xenova/bge-reranker-base', files: [] }),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tdai-service-id': 'inst-1',
  };
  if (!opts?.omitUserKey) headers['x-tdai-user-key'] = 'uk-1';
  const app = buildApp(deps);
  const res = await app.request(`/api/v1/rerank-model/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  // expose fetchMock for assertions via the response-attached symbol-free approach
  (res as Response & { __fetchMock?: ReturnType<typeof vi.fn> }).__fetchMock = fetchMock;
  return res;
}

function fetchMockOf(res: Response): ReturnType<typeof vi.fn> {
  return (res as Response & { __fetchMock?: ReturnType<typeof vi.fn> }).__fetchMock ?? vi.fn();
}

describe('rerank-model passthrough（admin 门控）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('非 system_admin 返回 403，不触达上游', async () => {
    const res = await callRerankModel(makeDeps('member'), 'status');
    expect(res.status).toBe(403);
    expect(fetchMockOf(res)).not.toHaveBeenCalled();
  });

  it('admin status 透传到 Core /v3/admin/rerank-model/status 并注入 Bearer', async () => {
    const res = await callRerankModel(makeDeps('system_admin'), 'status');
    expect(res.status).toBe(200);
    const fm = fetchMockOf(res);
    expect(fm).toHaveBeenCalledTimes(1);
    const [url, init] = fm.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CORE_BASE}/v3/admin/rerank-model/status`);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-tdai-service-id']).toBe('inst-1');
    expect(headers.Authorization).toBe('Bearer core-key');
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.code).toBe(0);
    expect((body.data as { state: string }).state).toBe('idle');
  });

  it('admin download 透传到 Core /v3/admin/rerank-model/download', async () => {
    const res = await callRerankModel(makeDeps('system_admin'), 'download');
    expect(res.status).toBe(200);
    const [url] = fetchMockOf(res).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CORE_BASE}/v3/admin/rerank-model/download`);
  });

  it('未知 action 返回 400 INVALID_ACTION，不触达上游', async () => {
    const res = await callRerankModel(makeDeps('system_admin'), 'bogus');
    expect(res.status).toBe(400);
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.code).not.toBe(0);
    expect(String(body.message)).toContain('INVALID_ACTION');
    expect(fetchMockOf(res)).not.toHaveBeenCalled();
  });
});
