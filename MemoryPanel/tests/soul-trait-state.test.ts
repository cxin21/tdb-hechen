/**
 * spec §5（表单两栏）：特质状态读面 BFF 路由测试 —— GET /api/v1/chat-memory/soul-trait-state。
 *
 * 覆盖：
 *   ① 正常转发：GET、三轴进 query、Authorization 齐备、无 body；
 *      上游**裸对象**（无 {code,message,data} 信封）被正常解析，出参逐行收窄。
 *   ② 三轴缺省：不传/空串/纯空白 → 一律 "default"（与内核 tenantOf 同口径）。
 *   ③ 内核 503 soul_trait_state_unavailable → HTTP 503 且 message 原样（不折成 502）。
 *   ④ 内核纯文本 401 → HTTP 401 原码透传。
 *   ⑤ 上游连不上（fetch reject）→ 502 UPSTREAM_ERROR。
 *   ⑥ 200 但没有 traits 数组 → 503 soul_trait_state_failed（不伪造空两栏）。
 *   ⑦ updatedAt=null（还没有状态行）原样回 null，不补时间。
 *
 * 构造方式照抄 tests/soul-card.test.ts（真实 FetchKernelHttpAdapter + mock globalThis.fetch）。
 * 与 soul-card 的差别：本读面上游是**裸对象**，所以 BFF 走 getRaw；若误走 getEnvelope
 * 会被判成 invalid envelope 折成 502 —— ① 正是这条回归的守门用例。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemorySoulRoutes } from '../src/panel/http/routes/chat-memory-soul.js';
import { FetchKernelHttpAdapter } from '../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';

const CORE_BASE = 'http://core-test:2';
const TRAIT_PATH = '/api/v1/chat-memory/soul-trait-state';

interface Envelope {
  code: number;
  message: string;
  request_id: string;
  data: unknown;
}

function makeDeps(): PanelDeps {
  const invoke = vi.fn(async () => ({
    code: 0,
    message: 'ok',
    request_id: 'test-req',
    data: null,
  }));
  return {
    config: {
      knowledge: { baseUrl: 'http://ks-test:1', authToken: 'ks-tok', timeoutMs: 1000 },
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
  } as unknown as PanelDeps;
}

function buildApp(deps: PanelDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  registerChatMemorySoulRoutes(api, deps);
  app.route('/api/v1', api);
  return app;
}

let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.restoreAllMocks();
});

function mockKernelFetch(payload: { status?: number; body: unknown }) {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload.body), {
        status: payload.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
}

function mockKernelText(status: number, text: string) {
  fetchMock = vi.fn(async () => new Response(text, { status }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
}

async function call(deps: PanelDeps, query?: Record<string, string>): Promise<Response> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  return buildApp(deps).request(`${TRAIT_PATH}${qs}`, {
    method: 'GET',
    headers: {
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'uk-1',
    },
  });
}

function lastKernelCall(): { url: URL; init: RequestInit } {
  const [rawUrl, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  return { url: new URL(rawUrl), init };
}

describe('GET /chat-memory/soul-trait-state', () => {
  it('透传三轴并解析裸对象（GET、无 body、逐行收窄）', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: {
        agentId: 'agt-1',
        updatedAt: '2026-11-07T05:00:00.000Z',
        traits: [
          { label: '严谨', seedWeight: 0.62, nowWeight: 0.71, drifted: true },
          { label: '迷糊', seedWeight: 0.38, nowWeight: 0.3, drifted: false },
          // 缺 label / 权重非有限数的行整行丢弃（不补 0，避免把「没有」伪装成「设定为 0」）
          { seedWeight: 0.5, nowWeight: 0.5, drifted: false },
          { label: '好奇', seedWeight: null, nowWeight: 0.4, drifted: false },
          { label: '直接', seedWeight: 0.2, nowWeight: 'x', drifted: true },
        ],
      },
    });

    const res = await call(deps, { team: 't1', user: 'u1', agent: 'agt-1' });
    expect(res.status).toBe(200);

    const { url, init } = lastKernelCall();
    expect(url.origin + url.pathname).toBe(`${CORE_BASE}/v3/soul/trait-state`);
    expect(url.searchParams.get('team')).toBe('t1');
    expect(url.searchParams.get('user')).toBe('u1');
    expect(url.searchParams.get('agent')).toBe('agt-1');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer core-key');

    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(0);
    const data = env.data as Record<string, unknown>;
    expect(data.agentId).toBe('agt-1');
    expect(data.updatedAt).toBe('2026-11-07T05:00:00.000Z');
    expect(data.traits).toEqual([
      { label: '严谨', seedWeight: 0.62, nowWeight: 0.71, drifted: true },
      { label: '迷糊', seedWeight: 0.38, nowWeight: 0.3, drifted: false },
    ]);
  });

  it('三轴缺省 / 空串 / 纯空白 → 全部 "default"', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { agentId: 'default', updatedAt: null, traits: [] } });
    await call(deps);
    let { url } = lastKernelCall();
    expect(url.searchParams.get('team')).toBe('default');
    expect(url.searchParams.get('user')).toBe('default');
    expect(url.searchParams.get('agent')).toBe('default');

    await call(deps, { team: '', user: '   ', agent: '  ' });
    ({ url } = lastKernelCall());
    expect(url.searchParams.get('team')).toBe('default');
    expect(url.searchParams.get('user')).toBe('default');
    expect(url.searchParams.get('agent')).toBe('default');
  });

  it('updatedAt=null（还没有状态行）原样回 null，不补时间', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: { agentId: 'agt-1', updatedAt: null, traits: [{ label: '严谨', seedWeight: 0.5, nowWeight: 0, drifted: false }] },
    });
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    const data = ((await res.json()) as Envelope).data as Record<string, unknown>;
    expect(data.updatedAt).toBeNull();
    expect((data.traits as Array<Record<string, unknown>>)[0].nowWeight).toBe(0);
  });

  it('内核 503 soul_trait_state_unavailable → HTTP 503 且 message 原样（不折成 502）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ status: 503, body: { error: 'soul_trait_state_unavailable' } });
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    expect(res.status).toBe(503);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(503);
    expect(env.message).toBe('soul_trait_state_unavailable');
    expect(env.data).toBeNull();
  });

  it('内核纯文本 401 → HTTP 401 原码透传', async () => {
    const deps = makeDeps();
    mockKernelText(401, 'unauthorized');
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    expect(res.status).toBe(401);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(401);
    expect(env.message).toBe('unauthorized');
  });

  it('内核纯文本 403 → HTTP 403 原码透传（不折 502）', async () => {
    const deps = makeDeps();
    mockKernelText(403, 'forbidden');
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    expect(res.status).toBe(403);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(403);
    expect(env.message).toBe('forbidden');
  });

  it('内核 503 soul_trait_state_failed → HTTP 503 且 message 原样', async () => {
    const deps = makeDeps();
    mockKernelFetch({ status: 503, body: { error: 'soul_trait_state_failed' } });
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    expect(res.status).toBe(503);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(503);
    expect(env.message).toBe('soul_trait_state_failed');
  });

  it('上游连不上 → 502 UPSTREAM_ERROR', async () => {
    const deps = makeDeps();
    fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    expect(res.status).toBe(502);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(502);
    expect(env.message).toBe('UPSTREAM_ERROR');
  });

  it('200 但没有 traits 数组 → 503 soul_trait_state_failed（不伪造空两栏）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { agentId: 'agt-1', updatedAt: null } });
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    expect(res.status).toBe(503);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(503);
    expect(env.message).toBe('soul_trait_state_failed');
  });
});
