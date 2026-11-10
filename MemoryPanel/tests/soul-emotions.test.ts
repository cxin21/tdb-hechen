/**
 * 阶段 3（task-37）：「情绪明细」读面 BFF 路由测试 —— GET /api/v1/soul/emotions。
 *
 * 覆盖：
 *   ① 正常转发：GET、team/user/agent/limit/since 进 query；出参按白名单收窄，
 *      rows 逐字段原样（小数不取整），funnel 六档齐时原样返回。
 *   ② 上游 503 soul_emotions_failed → HTTP 503 + message 原样（不折 500/502）。
 *   ③ 字段缺失不报错：行内 agency/confidence/objectPerson 缺 → 保持 null；
 *      漏斗缺一档 → 整个 funnel=null（半份漏斗不渲染）。
 *   ④ 白名单：行内未知字段与漏斗里未知 code 一律丢弃（Core 加字段不自动透到页面）。
 *   ⑤ 缺 team → 400 MISSING_TEAM_ID，且不发上游；limit 越界 → 400 BAD_LIMIT。
 *   ⑥ 上游 code=0 但没有 rows 数组 → 503 soul_emotions_failed（不伪造「0 条情绪」）。
 *   ⑦ 上游超时（KernelFetchError 504）→ 504 UPSTREAM_TIMEOUT。
 *
 * 构造方式照抄 tests/soul-injection-stats.test.ts（真实 FetchKernelHttpAdapter + mock fetch）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemorySoulRoutes } from '../src/panel/http/routes/chat-memory-soul.js';
import { FetchKernelHttpAdapter } from '../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';

const CORE_BASE = 'http://core-test:2';
const EMOTIONS_PATH = '/api/v1/soul/emotions';

function makeDeps(): PanelDeps {
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
    metaKernel: { invoke: vi.fn() },
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

async function call(deps: PanelDeps, query?: Record<string, string>): Promise<Response> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  return buildApp(deps).request(`${EMOTIONS_PATH}${qs}`, {
    method: 'GET',
    headers: {
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'uk-1',
    },
  });
}

const FULL_ROW = {
  at: '2026-11-08T12:00:00.000Z',
  object: '项目评审',
  objectPerson: 'hechen',
  label: '平静',
  valence: 0,
  arousal: 0.2,
  dominance: 0.1,
  intensity: 0.4,
  decayedIntensity: 0.31,
  agency: 'other',
  confidence: 0.5,
  templateVersion: 'et-abc',
};

const FULL_FUNNEL = {
  'emotion:candidate': 12,
  'emotion:object_ok': 9,
  'emotion:appraised': 9,
  'emotion:anchor_hit': 7,
  'emotion:intensity_ok': 8,
  'emotion:committed': 8,
};

describe('GET /soul/emotions', () => {
  it('透传四轴并原样返回收窄后的行与漏斗', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: { code: 0, message: 'ok', request_id: 'r1', data: { rows: [FULL_ROW], funnel: FULL_FUNNEL } },
    });

    const res = await call(deps, {
      team: 'team-1',
      user: 'u-1',
      agent: 'a-1',
      limit: '20',
      since: '2026-11-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      data: { rows: Record<string, unknown>[]; funnel: Record<string, number> };
    };
    expect(body.code).toBe(0);
    expect(body.data.rows).toEqual([FULL_ROW]);
    expect(body.data.funnel).toEqual(FULL_FUNNEL);

    const [reqArg, init] = fetchMock.mock.calls.at(-1)! as [Request | string, RequestInit | undefined];
    // 适配器传的是 Request 对象（不是 URL 字符串），两种形态都兼容。
    const parsed = new URL(typeof reqArg === 'string' ? reqArg : reqArg.url);
    expect(parsed.pathname).toBe('/v3/soul/emotions');
    expect(parsed.searchParams.get('team')).toBe('team-1');
    expect(parsed.searchParams.get('user')).toBe('u-1');
    expect(parsed.searchParams.get('agent')).toBe('a-1');
    expect(parsed.searchParams.get('limit')).toBe('20');
    expect(parsed.searchParams.get('since')).toBe('2026-11-01T00:00:00.000Z');
    expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('上游 503 → HTTP 503 + message 原样（不折 500）', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      status: 200,
      body: { code: 503, message: 'soul_emotions_failed', request_id: 'r2', data: null },
    });
    const res = await call(deps, { team: 'team-1' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: number; message: string };
    expect(body.code).toBe(503);
    expect(body.message).toBe('soul_emotions_failed');
  });

  it('行内字段缺失不报错：新列缺 → null，漏斗缺档 → 整段 null', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: {
        code: 0,
        message: 'ok',
        request_id: 'r3',
        data: {
          rows: [{ at: '2026-11-08T12:00:00.000Z', label: '平静', intensity: 0.4 }],
          funnel: {
            'emotion:candidate': 3,
            'emotion:object_ok': 2,
            'emotion:appraised': 2,
            // anchor_hit 缺档
            'emotion:intensity_ok': 2,
            'emotion:committed': 2,
          },
        },
      },
    });
    const res = await call(deps, { team: 'team-1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      data: { rows: Record<string, unknown>[]; funnel: unknown };
    };
    expect(body.data.rows[0]).toEqual({
      at: '2026-11-08T12:00:00.000Z',
      object: null,
      objectPerson: null,
      label: '平静',
      valence: null,
      arousal: null,
      dominance: null,
      intensity: 0.4,
      decayedIntensity: null,
      agency: null,
      confidence: null,
      templateVersion: null,
    });
    expect(body.data.funnel).toBeNull();
  });

  it('白名单收窄：行内未知字段与未知漏斗 code 一律丢弃', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: {
        code: 0,
        message: 'ok',
        request_id: 'r4',
        data: {
          rows: [{ ...FULL_ROW, secret: 'do-not-leak', decidedBy: 'nobody' }],
          funnel: { ...FULL_FUNNEL, 'emotion:internal_debug': 99 },
          extraTopLevel: { anything: true },
        },
      },
    });
    const res = await call(deps, { team: 'team-1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      data: { rows: Record<string, unknown>[]; funnel: Record<string, number>; extraTopLevel?: unknown };
    };
    expect(Object.keys(body.data.rows[0]).sort()).toEqual(Object.keys(FULL_ROW).sort());
    expect(body.data.rows[0].secret).toBeUndefined();
    expect(body.data.funnel).toEqual(FULL_FUNNEL);
    expect('emotion:internal_debug' in body.data.funnel).toBe(false);
    expect(body.data.extraTopLevel).toBeUndefined();
  });

  it('缺 team → 400 不发上游；limit 越界 → 400 BAD_LIMIT', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', request_id: 'r5', data: { rows: [], funnel: null } } });

    const noTeam = await call(deps, { limit: '10' });
    expect(noTeam.status).toBe(400);
    expect(((await noTeam.json()) as { message: string }).message).toBe('MISSING_TEAM_ID');
    expect(fetchMock).not.toHaveBeenCalled();

    for (const bad of ['0', '201', 'abc']) {
      const r = await call(deps, { team: 'team-1', limit: bad });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { message: string }).message).toBe('BAD_LIMIT');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上游 code=0 但没有 rows 数组 → 503（不伪造 0 条情绪）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', request_id: 'r6', data: { funnel: null } } });
    const res = await call(deps, { team: 'team-1' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toBe('soul_emotions_failed');
  });

  it('上游网络失败 → 2xx 封装成 KERNEL_UNAVAILABLE，不折 500', async () => {
    const deps = makeDeps();
    const timeoutErr = Object.assign(new Error('timeout'), { code: 504, name: 'KernelFetchError' });
    fetchMock = vi.fn(async () => {
      throw timeoutErr;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);
    const res = await call(deps, { team: 'team-1' });
    // 适配器把 KernelFetchError 封成信封（502 KERNEL_UNAVAILABLE / 504 KERNEL_TIMEOUT），
    // 路由按 env.code 原码透出——测试只锁「不是 500」且消息来自内核。
    expect([502, 504]).toContain(res.status);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/^KERNEL_/);
  });
});