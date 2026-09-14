/**
 * Task 2（DS-PANEL-UI-WIKI-SOURCE-001）：wiki 源管理 BFF 透传路由测试。
 *
 * 覆盖 Panel 新增三个透传端点（全部 POST，风格与既有 wiki-routes 一致）：
 *   - POST /api/v1/knowledge/wiki/source/update  → KS PATCH /v3/wiki/:id/source
 *   - POST /api/v1/knowledge/wiki/source/test    → KS POST  /v3/wiki/:id/test
 *   - POST /api/v1/knowledge/wiki/source/refetch → KS POST  /v3/wiki/:id/refetch
 *
 * 构造最小 Hono app（registerKnowledgeWikiRoutes 既有挂载方式），
 * stub deps.metaKernel.invoke（auth/verify + asset/get + acl/check + team-member/get），
 * 全局 fetch 用 vi.spyOn mock —— 不触达真实上游。门控/信封语义与 settings-routes.test.ts 同款。
 *
 * 删除沿用既有 POST /knowledge/wiki/delete（级联 meta_asset），不在本文件重复。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerKnowledgeWikiRoutes } from '../src/panel/http/routes/knowledge/wiki-routes.js';
import { HttpKnowledgeClient } from '../src/panel/kernel/adapters/http-knowledge-client.js';

const KS_BASE = 'http://ks-test:1';

interface InvokeEnvelope {
  code: number;
  message: string;
  request_id: string;
  data: unknown;
}

function okEnvelope(data: unknown): InvokeEnvelope {
  return { code: 0, message: 'ok', request_id: 'test-req', data };
}

/** stub deps：auth/verify 恒有效；asset/get 存在（team t1, owner u1）；acl/check 按 action 放行。 */
function makeDeps(opts?: { aclAllowed?: boolean; assetMissing?: boolean }): {
  deps: PanelDeps;
  invoke: ReturnType<typeof vi.fn>;
} {
  const aclAllowed = opts?.aclAllowed ?? true;
  const assetMissing = opts?.assetMissing ?? false;
  const invoke = vi.fn(async (action: string): Promise<InvokeEnvelope> => {
    if (action === 'auth/verify') {
      return okEnvelope({ valid: true, user: { user_id: 'u1', user_type: 'member' } });
    }
    if (action === 'asset/get') {
      if (assetMissing) return okEnvelope(null);
      return okEnvelope({
        asset_id: 'wiki-1',
        team_id: 't1',
        asset_type: 'llm_wiki',
        name: 'docs',
        owner_user_id: 'u1',
        visibility: 'team',
        status: 'ready',
      });
    }
    if (action === 'acl/check') {
      return okEnvelope({ allowed: aclAllowed });
    }
    if (action === 'team-member/get') {
      return okEnvelope({ team_id: 't1', user_id: 'u1' });
    }
    return okEnvelope(null);
  });
  const deps = {
    config: {
      knowledge: { baseUrl: KS_BASE, authToken: 'ks-tok', timeoutMs: 1000 },
      llmProvider: { proxyBaseUrl: 'http://proxy-test:3' },
      metadataRemoteTimeoutMs: 1000,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    instanceRegistry: {
      resolve: () => ({
        instance_id: 'inst-1',
        gateway_endpoint: 'http://core-test:2',
        api_key: 'core-key',
      }),
    },
    metaKernel: { invoke },
    ingestProgressStore: { get: () => null },
    // 真实 KC adapter：上游 fetch 已被 mock，不触达真实 KS
    knowledgeClientFactory: () =>
      new HttpKnowledgeClient({ baseUrl: KS_BASE, authToken: 'ks-tok', serviceId: 'inst-1', timeoutMs: 1000 }),
  } as unknown as PanelDeps;
  return { deps, invoke };
}

function buildApp(deps: PanelDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  registerKnowledgeWikiRoutes(api, deps);
  app.route('/api/v1', api);
  return app;
}

const WIKI_DETAIL = {
  wiki_id: 'wiki-1',
  team_id: 't1',
  name: 'docs',
  status: 'ready',
  source_type: 'git',
  source_url: 'https://git.example.com/org/repo.git',
  branch: 'main',
  stale: true,
  enabled: true,
};

let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.restoreAllMocks();
});

/** mock 全局 fetch 返回 KS 信封；返回 headers 便于断言。 */
function mockKsFetch(payload: { status?: number; body: unknown } = { body: { code: 0, message: 'ok', data: {} } }) {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload.body), {
        status: payload.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
}

async function call(
  deps: PanelDeps,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = buildApp(deps);
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'uk-1',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function lastKsCall(): Promise<{ url: string; init: RequestInit }> {
  const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  return { url, init };
}

// ── POST /knowledge/wiki/source/update → KS PATCH /v3/wiki/:id/source ──

describe('POST /knowledge/wiki/source/update', () => {
  it('透传 url/branch 到 KS PATCH /v3/wiki/:id/source，注入 Bearer + service-id', async () => {
    const { deps } = makeDeps();
    mockKsFetch({ body: { code: 0, message: 'ok', data: WIKI_DETAIL } });
    const res = await call(deps, '/api/v1/knowledge/wiki/source/update', {
      wiki_id: 'wiki-1',
      source_url: 'https://git.example.com/org/new.git',
      branch: 'dev',
    });
    expect(res.status).toBe(200);
    const { url, init } = await lastKsCall();
    expect(url).toBe(`${KS_BASE}/v3/wiki/wiki-1/source`);
    expect(init.method).toBe('PATCH');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ks-tok');
    expect(headers['x-tdai-service-id']).toBe('inst-1');
    expect(JSON.parse(init.body as string)).toEqual({
      source_url: 'https://git.example.com/org/new.git',
      branch: 'dev',
    });
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.code).toBe(0);
    expect(body.data).toEqual(WIKI_DETAIL);
  });

  it('enabled 开关透传为 boolean', async () => {
    const { deps } = makeDeps();
    mockKsFetch({ body: { code: 0, message: 'ok', data: { ...WIKI_DETAIL, enabled: false } } });
    const res = await call(deps, '/api/v1/knowledge/wiki/source/update', {
      wiki_id: 'wiki-1',
      enabled: false,
    });
    expect(res.status).toBe(200);
    const { init } = await lastKsCall();
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
  });

  it('缺 wiki_id 返回 400，不触达上游', async () => {
    const { deps } = makeDeps();
    mockKsFetch();
    const res = await call(deps, '/api/v1/knowledge/wiki/source/update', { enabled: true });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('空补丁（无 source_url/branch/enabled）返回 400，不触达上游', async () => {
    const { deps } = makeDeps();
    mockKsFetch();
    const res = await call(deps, '/api/v1/knowledge/wiki/source/update', { wiki_id: 'wiki-1' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('KS 校验失败（400，如 http:// 私网地址）原样映射 400', async () => {
    const { deps } = makeDeps();
    // 真实 KS wrapError(400) 是 HTTP 400 + 信封 code 400
    mockKsFetch({ status: 400, body: { code: 400, message: 'invalid git source_url: https-only', data: null } });
    const res = await call(deps, '/api/v1/knowledge/wiki/source/update', {
      wiki_id: 'wiki-1',
      source_url: 'http://10.0.0.1/x.git',
    });
    expect(res.status).toBe(400);
  });

  it('无 write 权限返回 403，不触达上游', async () => {
    const { deps } = makeDeps({ aclAllowed: false });
    mockKsFetch();
    const res = await call(deps, '/api/v1/knowledge/wiki/source/update', {
      wiki_id: 'wiki-1',
      enabled: false,
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('meta_asset 不存在返回 404（KNOWLEDGE_NOT_FOUND）', async () => {
    const { deps } = makeDeps({ assetMissing: true });
    mockKsFetch();
    const res = await call(deps, '/api/v1/knowledge/wiki/source/update', {
      wiki_id: 'wiki-1',
      enabled: false,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    // 断言错误码而非裸 404：避免"路由不存在"的 404 虚过本用例。
    expect(body.message).toBe('KNOWLEDGE_NOT_FOUND');
  });
});

// ── POST /knowledge/wiki/source/test → KS POST /v3/wiki/:id/test ──

describe('POST /knowledge/wiki/source/test', () => {
  it('缺省探测已存源：透传到 KS POST /v3/wiki/:id/test（空 body）', async () => {
    const { deps } = makeDeps();
    mockKsFetch({ body: { code: 0, message: 'ok', data: { reachable: true, branches: ['main', 'dev'] } } });
    const res = await call(deps, '/api/v1/knowledge/wiki/source/test', { wiki_id: 'wiki-1' });
    expect(res.status).toBe(200);
    const { url, init } = await lastKsCall();
    expect(url).toBe(`${KS_BASE}/v3/wiki/wiki-1/test`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.data).toEqual({ reachable: true, branches: ['main', 'dev'] });
  });

  it('支持 source_url 覆盖（编辑时预览候选 URL）', async () => {
    const { deps } = makeDeps();
    mockKsFetch({ body: { code: 0, message: 'ok', data: { reachable: false, branches: [], error: 'timeout' } } });
    const res = await call(deps, '/api/v1/knowledge/wiki/source/test', {
      wiki_id: 'wiki-1',
      source_url: 'https://git.example.com/org/candidate.git',
    });
    expect(res.status).toBe(200);
    const { init } = await lastKsCall();
    expect(JSON.parse(init.body as string)).toEqual({
      source_url: 'https://git.example.com/org/candidate.git',
    });
  });

  it('KS 探测"不可达"仍是 200 信封（reachable=false），BFF 原样透传', async () => {
    const { deps } = makeDeps();
    mockKsFetch({ body: { code: 0, message: 'ok', data: { reachable: false, branches: [], error: 'conn refused' } } });
    const res = await call(deps, '/api/v1/knowledge/wiki/source/test', { wiki_id: 'wiki-1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.code).toBe(0);
  });

  it('缺 wiki_id 返回 400', async () => {
    const { deps } = makeDeps();
    mockKsFetch();
    const res = await call(deps, '/api/v1/knowledge/wiki/source/test', {});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── POST /knowledge/wiki/source/refetch → KS POST /v3/wiki/:id/refetch ──

describe('POST /knowledge/wiki/source/refetch', () => {
  it('透传到 KS POST /v3/wiki/:id/refetch；KS 202 信封映射为 Panel 200 data', async () => {
    const { deps } = makeDeps();
    mockKsFetch({ status: 202, body: { code: 0, message: 'ok', data: { wiki_id: 'wiki-1', status: 'pending' } } });
    const res = await call(deps, '/api/v1/knowledge/wiki/source/refetch', { wiki_id: 'wiki-1' });
    expect(res.status).toBe(200);
    const { url, init } = await lastKsCall();
    expect(url).toBe(`${KS_BASE}/v3/wiki/wiki-1/refetch`);
    expect(init.method).toBe('POST');
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ wiki_id: 'wiki-1', status: 'pending' });
  });

  it('KS busy 409 映射为 Panel 409（不吞成 502）', async () => {
    const { deps } = makeDeps();
    mockKsFetch({ status: 409, body: { code: 409, message: 'busy', data: { status: 'processing', step: 'ingesting' } } });
    const res = await call(deps, '/api/v1/knowledge/wiki/source/refetch', { wiki_id: 'wiki-1' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: number; message: string };
    expect(body.message).toBe('busy');
  });

  it('缺 wiki_id 返回 400', async () => {
    const { deps } = makeDeps();
    mockKsFetch();
    const res = await call(deps, '/api/v1/knowledge/wiki/source/refetch', {});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('无 write 权限返回 403', async () => {
    const { deps } = makeDeps({ aclAllowed: false });
    mockKsFetch();
    const res = await call(deps, '/api/v1/knowledge/wiki/source/refetch', { wiki_id: 'wiki-1' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
