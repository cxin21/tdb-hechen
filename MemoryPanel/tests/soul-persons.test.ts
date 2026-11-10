/**
 * 人物档案读面 BFF 路由测试 —— GET /api/v1/soul/persons、GET /api/v1/soul/person。
 *
 * 覆盖：
 *   ① persons 正常转发：GET、三轴进 query、Authorization 齐备、无 body；
 *      上游**裸对象**（{ok,data} 而非 {code,message,data} 信封）被正常解析，出参逐行收窄
 *      （缺 displayName 的人丢行；objKey=null 的边原样保留 null，由前端用 objName 显示）。
 *   ② person 正常转发：query 带 key，九字段/关系逐行收窄。
 *   ③ 本地门：缺 team → 400 MISSING_TEAM_ID；缺 key → 400 person_key_required（不请求上游）。
 *   ④ Core 404 person_not_found → HTTP 404 且 message 原样（不折 500）。
 *   ⑤ Core 503 soul_person_unavailable → HTTP 503 且 message 原样（不折 502）。
 *   ⑥ persons 200 但没有 persons 数组 → 503 soul_persons_failed（不伪造空列表）。
 *
 * 构造方式照抄 tests/soul-trait-state.test.ts（真实 FetchKernelHttpAdapter + mock globalThis.fetch）：
 * 本读面上游同样是裸对象，所以 BFF 走 getRaw；若误走 getEnvelope 会被判成 invalid envelope
 * 折成 502 —— ① 正是这条回归的守门用例。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerSoulPersonsRoutes } from '../src/panel/http/routes/soul-persons.js';
import { FetchKernelHttpAdapter } from '../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';

const CORE_BASE = 'http://core-test:2';
const PERSONS_PATH = '/api/v1/soul/persons';
const PERSON_PATH = '/api/v1/soul/person';

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
  registerSoulPersonsRoutes(api, deps);
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

async function call(
  deps: PanelDeps,
  path: string,
  query?: Record<string, string>,
): Promise<Response> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  return buildApp(deps).request(`${path}${qs}`, {
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

describe('GET /soul/persons', () => {
  it('透传三轴并解析裸对象（GET、无 body、person/edge 逐行收窄）', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: {
        ok: true,
        data: {
          persons: [
            {
              key: 'p_aaa',
              displayName: '老张',
              aliases: ['张工'],
              platform: 'feishu',
              platformId: 'ou_1',
              fieldCount: 0,
              relationCount: 1,
              updatedAt: '2026-11-07T05:00:00.000Z',
            },
            // 缺 displayName 不丢行：关系边要靠 key 连节点，丢了人图就断（生产实测
            // 7 个 platform 行全空名，面板整批看不见人）。给稳定占位，不冒充真名。
            { key: 'p_bbb', fieldCount: 0, relationCount: 0 },
          ],
          edges: [
            {
              relId: 'rel-1',
              subjKey: 'p_aaa',
              subjName: '老张',
              pred: '上级',
              objKey: null,
              objName: '小李',
              direction: 'out',
              quote: '我的上级是小李',
              recordId: 'l1-9',
              validFrom: '2026-11-01T00:00:00.000Z',
            },
            // 缺 subjKey → 整行丢弃
            { relId: 'rel-2', pred: '同事', direction: 'mutual' },
          ],
        },
      },
    });

    const res = await call(deps, PERSONS_PATH, { team: 't1', user: 'u1', agent: 'agt-1' });
    expect(res.status).toBe(200);

    const { url, init } = lastKernelCall();
    expect(url.origin + url.pathname).toBe(`${CORE_BASE}/v3/soul/persons`);
    expect(url.searchParams.get('team')).toBe('t1');
    expect(url.searchParams.get('user')).toBe('u1');
    expect(url.searchParams.get('agent')).toBe('agt-1');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer core-key');

    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(0);
    const data = env.data as { persons: unknown[]; edges: unknown[] };
    expect(data.persons).toEqual([
      {
        key: 'p_aaa',
        displayName: '老张',
        aliases: ['张工'],
        platform: 'feishu',
        platformId: 'ou_1',
        fieldCount: 0,
        relationCount: 1,
        updatedAt: '2026-11-07T05:00:00.000Z',
      },
      {
        key: 'p_bbb',
        displayName: '未命名·pbbb',
        aliases: [],
        platform: '',
        platformId: null,
        fieldCount: 0,
        relationCount: 0,
        updatedAt: null,
      },
    ]);
    // objKey=null 原样保留（前端据此画「未登记」虚线节点），不补造 key。
    expect(data.edges).toEqual([
      {
        relId: 'rel-1',
        subjKey: 'p_aaa',
        subjName: '老张',
        pred: '上级',
        objKey: null,
        objName: '小李',
        direction: 'out',
        quote: '我的上级是小李',
        recordId: 'l1-9',
        validFrom: '2026-11-01T00:00:00.000Z',
      },
    ]);
  });

  it('空列表是正常 200（生产首屏：有人、0 条边不报错）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { ok: true, data: { persons: [], edges: [] } } });
    const res = await call(deps, PERSONS_PATH, { team: 't1' });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as Envelope).data as Record<string, unknown>;
    expect(data.persons).toEqual([]);
    expect(data.edges).toEqual([]);
  });

  it('缺 team → 400 MISSING_TEAM_ID（不请求上游）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { ok: true, data: { persons: [], edges: [] } } });
    const res = await call(deps, PERSONS_PATH);
    expect(res.status).toBe(400);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(400);
    expect(env.message).toBe('MISSING_TEAM_ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Core 503 soul_person_unavailable → HTTP 503 且 message 原样（不折成 502）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ status: 503, body: { code: 503, message: 'soul_person_unavailable' } });
    const res = await call(deps, PERSONS_PATH, { team: 't1' });
    expect(res.status).toBe(503);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(503);
    expect(env.message).toBe('soul_person_unavailable');
    expect(env.data).toBeNull();
  });

  it('200 但没有 persons 数组 → 503 soul_persons_failed（不伪造空列表）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { ok: true, data: {} } });
    const res = await call(deps, PERSONS_PATH, { team: 't1' });
    expect(res.status).toBe(503);
    const env = (await res.json()) as Envelope;
    expect(env.message).toBe('soul_persons_failed');
  });
});

describe('GET /soul/person', () => {
  it('透传 key 并解析裸对象（GET、无 body、fields/relations 收窄）', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: {
        ok: true,
        data: {
          person: { key: 'p_aaa', displayName: '老张', aliases: ['张工'] },
          fields: [
            {
              field: 'role',
              label: '身份',
              text: '后端负责人',
              evidence: [
                { recordId: 'l1-1', at: '2026-11-02T01:00:00.000Z', quote: '我负责后端' },
                { recordId: 'l1-2', at: null, quote: '' },
              ],
              updatedAt: '2026-11-02T01:00:00.000Z',
              stale: false,
            },
            // 缺 label → 丢行
            { field: 'likes', text: '爬山' },
          ],
          relations: [
            {
              relId: 'rel-9',
              pred: '上级',
              objKey: null,
              objName: '老张',
              direction: 'in',
              counterpartKey: 'p_ccc',
              quote: '老张是我的上级',
              recordId: 'l1-3',
              validFrom: '2026-11-01T00:00:00.000Z',
            },
            // 缺 pred → 丢行
            { relId: 'rel-10', objName: '小李', direction: 'out' },
          ],
        },
      },
    });

    const res = await call(deps, PERSON_PATH, { team: 't1', user: 'u1', agent: 'agt-1', key: 'p_aaa' });
    expect(res.status).toBe(200);

    const { url, init } = lastKernelCall();
    expect(url.origin + url.pathname).toBe(`${CORE_BASE}/v3/soul/person`);
    expect(url.searchParams.get('team')).toBe('t1');
    expect(url.searchParams.get('user')).toBe('u1');
    expect(url.searchParams.get('agent')).toBe('agt-1');
    expect(url.searchParams.get('key')).toBe('p_aaa');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer core-key');

    const data = ((await res.json()) as Envelope).data as {
      person: unknown;
      fields: unknown[];
      relations: unknown[];
    };
    expect(data.person).toEqual({ key: 'p_aaa', displayName: '老张', aliases: ['张工'] });
    expect(data.fields).toEqual([
      {
        field: 'role',
        label: '身份',
        text: '后端负责人',
        evidence: [{ recordId: 'l1-1', at: '2026-11-02T01:00:00.000Z', quote: '我负责后端' }],
        updatedAt: '2026-11-02T01:00:00.000Z',
        stale: false,
      },
    ]);
    expect(data.relations).toEqual([
      {
        relId: 'rel-9',
        pred: '上级',
        objKey: null,
        objName: '老张',
        direction: 'in',
        counterpartKey: 'p_ccc',
        quote: '老张是我的上级',
        recordId: 'l1-3',
        validFrom: '2026-11-01T00:00:00.000Z',
      },
    ]);
  });

  it('缺 key → 400 person_key_required（不请求上游）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { ok: true, data: {} } });
    const res = await call(deps, PERSON_PATH, { team: 't1' });
    expect(res.status).toBe(400);
    const env = (await res.json()) as Envelope;
    expect(env.message).toBe('person_key_required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Core 404 person_not_found → HTTP 404 且 message 原样', async () => {
    const deps = makeDeps();
    mockKernelFetch({ status: 404, body: { code: 404, message: 'person_not_found' } });
    const res = await call(deps, PERSON_PATH, { team: 't1', key: 'p_missing' });
    expect(res.status).toBe(404);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(404);
    expect(env.message).toBe('person_not_found');
    expect(env.data).toBeNull();
  });

  it('Core 503 soul_person_unavailable → HTTP 503 且 message 原样（不折成 502）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ status: 503, body: { code: 503, message: 'soul_person_unavailable' } });
    const res = await call(deps, PERSON_PATH, { team: 't1', key: 'p_aaa' });
    expect(res.status).toBe(503);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(503);
    expect(env.message).toBe('soul_person_unavailable');
  });
});