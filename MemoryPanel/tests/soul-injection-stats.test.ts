/**
 * P0-D（task-17）：「注入健康」读面 BFF 路由测试 —— GET /api/v1/soul/injection-stats。
 *
 * 覆盖：
 *   ① 正常转发：GET、team/user/agent/hours 进 query、面板头齐备、无 body；
 *      出参收窄且**算不出的字段保持 null**（lastCard/lastVolatile/failReasons 不补 0）。
 *   ② failReasons 有上报时逐原因计数原样（含 0 的键也出现，表示「上报过、这一类为 0」）。
 *   ③ journal_disabled：200 code=0 + note 透出（不是 500，也不是「没有失败」）。
 *   ④ 缺 team → 400 MISSING_TEAM_ID，且**不发上游请求**（不伪造 default 轴）。
 *   ⑤ hours 非法（0 / 8761 / 非数字）→ 400 BAD_HOURS。
 *   ⑥ 上游 503 soul_injection_stats_failed → HTTP 503 + message 原样，不折成 500/502。
 *   ⑦ 上游 code=0 但没有 rows → 503 soul_injection_stats_failed（不伪造「0 行 = 无注入」）。
 *   ⑧ 内核 checkAuth 的纯文本 401 → HTTP 401 原码透传（不折 502）。
 *
 * 构造方式照抄 tests/soul-card.test.ts（真实 FetchKernelHttpAdapter + mock globalThis.fetch）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemorySoulRoutes } from '../src/panel/http/routes/chat-memory-soul.js';
import { FetchKernelHttpAdapter } from '../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';

const CORE_BASE = 'http://core-test:2';
const STATS_PATH = '/api/v1/soul/injection-stats';

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

function mockKernelText(status: number, text: string) {
  fetchMock = vi.fn(async () => new Response(text, { status }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
}

async function call(deps: PanelDeps, query?: Record<string, string>): Promise<Response> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  return buildApp(deps).request(`${STATS_PATH}${qs}`, {
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

const FULL_STATS = {
  window: { hours: 24, from: '2026-11-06T12:00:00.000Z', to: '2026-11-07T12:00:00.000Z' },
  rows: 12,
  lastAt: '2026-11-07T11:59:00.000Z',
  lastCard: { version: 7, hash: 'a1b2c3d4', chars: 1832 },
  lastVolatile: { chars: 640, hash: 'ff00ee11', skipped: true },
  failReasons: null,
  serverRenderOnly: 2,
  pairs: { matched: 9, charMismatch: 0 },
};

describe('GET /soul/injection-stats', () => {
  it('透传四轴并原样返回收窄后的统计（null 保持 null，不补 0）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', request_id: 'r1', data: FULL_STATS } });

    const res = await call(deps, { team: 'team-1', user: 'u-1', agent: 'a-1', hours: '24' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      data: Record<string, unknown>;
    };
    expect(body.code).toBe(0);

    // 上游调用形状：GET + 四轴 query + 无 body。
    const { url, init } = lastKernelCall();
    expect(url.pathname).toBe('/v3/soul/injection/stats');
    expect(url.searchParams.get('team')).toBe('team-1');
    expect(url.searchParams.get('user')).toBe('u-1');
    expect(url.searchParams.get('agent')).toBe('a-1');
    expect(url.searchParams.get('hours')).toBe('24');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();

    // 出参：结构原样，数值取整，null 保留。
    expect(body.data.window).toEqual(FULL_STATS.window);
    expect(body.data.rows).toBe(12);
    expect(body.data.lastAt).toBe(FULL_STATS.lastAt);
    expect(body.data.lastCard).toEqual({ version: 7, hash: 'a1b2c3d4', chars: 1832 });
    expect(body.data.lastVolatile).toEqual({ chars: 640, hash: 'ff00ee11', skipped: true });
    expect(body.data.failReasons).toBeNull();
    expect(body.data.serverRenderOnly).toBe(2);
    expect(body.data.pairs).toEqual({ matched: 9, charMismatch: 0 });
    expect(body.data.note).toBeUndefined();
  });

  it('failReasons 有上报时逐原因计数原样（0 表示上报过且该类为 0）', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: {
        code: 0,
        message: 'ok',
        request_id: 'r2',
        data: {
          ...FULL_STATS,
          failReasons: { http_status: 2, timeout: 0, empty: 1, parse: 0 },
        },
      },
    });

    const body = (await (await call(deps, { team: 'team-1' })).json()) as {
      data: { failReasons: Record<string, number> | null };
    };
    expect(body.data.failReasons).toEqual({ http_status: 2, timeout: 0, empty: 1, parse: 0 });
  });

  it('journal_disabled：200 + note 透出（不是 500，也不伪造失败原因）', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: {
        code: 0,
        message: 'ok',
        request_id: 'r3',
        data: {
          window: { hours: 24, from: '2026-11-06T12:00:00.000Z', to: '2026-11-07T12:00:00.000Z' },
          rows: 0,
          lastAt: null,
          lastCard: null,
          lastVolatile: null,
          failReasons: null,
          serverRenderOnly: 0,
          pairs: { matched: 0, charMismatch: 0 },
          note: 'journal_disabled',
        },
      },
    });

    const res = await call(deps, { team: 'team-1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: Record<string, unknown> };
    expect(body.code).toBe(0);
    expect(body.data.note).toBe('journal_disabled');
    expect(body.data.rows).toBe(0);
    expect(body.data.lastCard).toBeNull();
    expect(body.data.failReasons).toBeNull();
  });

  it('缺 team → 400 MISSING_TEAM_ID 且不发上游请求（不伪造 default 轴）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', request_id: 'x', data: FULL_STATS } });

    const res = await call(deps, { user: 'u-1' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: number; message: string };
    expect(body.code).toBe(400);
    expect(body.message).toBe('MISSING_TEAM_ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['0', '8761', 'abc'])('hours=%s → 400 BAD_HOURS 且不发上游请求', async (hours) => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', request_id: 'x', data: FULL_STATS } });

    const res = await call(deps, { team: 'team-1', hours });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: number; message: string };
    expect(body.message).toBe('BAD_HOURS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上游 503 soul_injection_stats_failed → HTTP 503 + message 原样', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      status: 503,
      body: { code: 503, message: 'soul_injection_stats_failed', request_id: 'r4' },
    });

    const res = await call(deps, { team: 'team-1' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: number; message: string };
    expect(body.code).toBe(503);
    expect(body.message).toBe('soul_injection_stats_failed');
  });

  it('上游 code=0 但没有 rows → 503（不伪造「0 行 = 无注入」）', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: { code: 0, message: 'ok', request_id: 'r5', data: { window: {}, pairs: {} } },
    });

    const res = await call(deps, { team: 'team-1' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: number; message: string };
    expect(body.message).toBe('soul_injection_stats_failed');
  });

  it('内核纯文本 401 → HTTP 401 原码透传（不折 502）', async () => {
    const deps = makeDeps();
    mockKernelText(401, 'unauthorized');

    const res = await call(deps, { team: 'team-1' });
    expect(res.status).toBe(401);
  });

  it('volatileCounts 原样透传（injected / skipped 两个计数）', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: {
        code: 0,
        message: 'ok',
        request_id: 'r6',
        data: { ...FULL_STATS, volatileCounts: { injected: 9, skipped: 3 } },
      },
    });

    const body = (await (await call(deps, { team: 'team-1' })).json()) as {
      data: { volatileCounts?: { injected: number; skipped: number } };
    };
    expect(body.data.volatileCounts).toEqual({ injected: 9, skipped: 3 });
  });

  it('旧 Core 没有 volatileCounts → 出参里不出现该键（不补 0）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', request_id: 'r7', data: FULL_STATS } });

    const body = (await (await call(deps, { team: 'team-1' })).json()) as {
      data: Record<string, unknown>;
    };
    expect('volatileCounts' in body.data).toBe(false);
  });

  it('volatileCounts 字段非数字 → 整项丢弃（不让 NaN 流到前端）', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: {
        code: 0,
        message: 'ok',
        request_id: 'r8',
        data: { ...FULL_STATS, volatileCounts: { injected: 'many', skipped: null } },
      },
    });

    const body = (await (await call(deps, { team: 'team-1' })).json()) as {
      data: Record<string, unknown>;
    };
    expect('volatileCounts' in body.data).toBe(false);
  });
});