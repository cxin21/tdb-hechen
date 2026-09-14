/**
 * Task 3（DS-PANEL-UI-WIKI-SOURCE-001 §2.3）：记忆健康条 BFF 透传 + 纯 UI 状态推导测试。
 *
 * 覆盖：
 *   - POST /api/v1/chat-memory/health → 网关 GET /health（memory 子对象，T15 现成）
 *   - health-utils 纯函数：ok / degraded 两态视图推导（黄条判定 / 覆盖率文案）
 *
 * 构造方式照抄 tests/wiki-source-routes.test.ts：最小 Hono app + stub metaKernel.invoke
 * （auth/verify），全局 fetch spy 模拟网关 /health —— 不触达真实上游。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemoryRoutes } from '../src/panel/http/routes/chat-memory.js';
import { FetchKernelHttpAdapter } from '../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';
import {
  buildMemoryHealthView,
  formatVectorCoverage,
  healthRingTone,
  type MemoryHealthInfo,
} from '../web/src/pages/ChatMemoryPage/utils/health-utils';

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

/** stub deps：auth/verify 可控；kernelHttp 用真实 adapter（fetch 已 mock，不触达真实网关）。 */
function makeDeps(opts?: { authValid?: boolean }): { deps: PanelDeps; invoke: ReturnType<typeof vi.fn> } {
  const authValid = opts?.authValid ?? true;
  const invoke = vi.fn(async (action: string): Promise<InvokeEnvelope> => {
    if (action === 'auth/verify') {
      if (!authValid) return okEnvelope({ valid: false, user: null });
      return okEnvelope({ valid: true, user: { user_id: 'u1', user_type: 'member' } });
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
  return { deps, invoke };
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

/** mock 全局 fetch（网关 /health 为原生 JSON，非信封）。 */
function mockGatewayFetch(payload: { status?: number; body: unknown; throwErr?: Error } = { body: {} }) {
  fetchMock = vi.fn(async () => {
    if (payload.throwErr) throw payload.throwErr;
    return new Response(JSON.stringify(payload.body), {
      status: payload.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
}

async function call(deps: PanelDeps, body: unknown = {}): Promise<Response> {
  const app = buildApp(deps);
  return app.request('/api/v1/chat-memory/health', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'uk-1',
    },
    body: JSON.stringify(body),
  });
}

// ── POST /chat-memory/health → 网关 GET /health（memory 子对象） ──

describe('POST /chat-memory/health', () => {
  it('ok 态：翻译为网关 GET /health，只透出 memory 子对象，注入 service-id + Bearer', async () => {
    const { deps } = makeDeps();
    mockGatewayFetch({
      body: {
        status: 'ok',
        version: '0.1.0',
        memory: {
          vectorCoverage: 0.81,
          vecRows: 104,
          metaRows: 129,
          embedding: 'ok',
          degradedSince: null,
          lastVecWriteAt: '2026-09-10T10:00:00.000Z',
        },
      },
    });
    const res = await call(deps);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CORE_BASE}/health`);
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-tdai-service-id']).toBe('inst-1');
    expect(headers.Authorization).toBe('Bearer core-key');
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.code).toBe(0);
    const data = body.data as { memory: MemoryHealthInfo };
    expect(data.memory.embedding).toBe('ok');
    expect(data.memory.vectorCoverage).toBeCloseTo(0.81);
    expect(data.memory.degradedSince).toBeNull();
  });

  it('degraded 态：embedding=degraded 原样透出（UI 黄条判定依据）', async () => {
    const { deps } = makeDeps();
    mockGatewayFetch({
      body: {
        status: 'ok',
        memory: {
          vectorCoverage: 0.51,
          vecRows: 104,
          metaRows: 203,
          embedding: 'degraded',
          degradedSince: '2026-09-10T08:00:00.000Z',
          lastVecWriteAt: null,
        },
      },
    });
    const res = await call(deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeEnvelope;
    const data = body.data as { memory: MemoryHealthInfo };
    expect(data.memory.embedding).toBe('degraded');
    expect(data.memory.degradedSince).toBe('2026-09-10T08:00:00.000Z');
  });

  it('caller 身份无效返回 401，不触达网关', async () => {
    const { deps } = makeDeps({ authValid: false });
    mockGatewayFetch({ body: {} });
    const res = await call(deps);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('网关不可达映射 502（不吞成 500）', async () => {
    const { deps } = makeDeps();
    mockGatewayFetch({ throwErr: new Error('ECONNREFUSED') });
    const res = await call(deps);
    expect(res.status).toBe(502);
  });

  it('网关返回非 JSON / 缺 memory 子对象 → 502（如实失败，不造默认值）', async () => {
    const { deps } = makeDeps();
    fetchMock = vi.fn(async () => new Response('not-json', { status: 200 }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    const res = await call(deps);
    expect(res.status).toBe(502);
  });
});

// ── health-utils 纯函数：UI 两态视图推导 ──

describe('health-utils', () => {
  it('formatVectorCoverage：0.81 → "81%"，0.5 → "50%"', () => {
    expect(formatVectorCoverage(0.81)).toBe('81%');
    expect(formatVectorCoverage(0.5)).toBe('50%');
  });

  it('buildMemoryHealthView ok 态：degraded=false，展示覆盖率 + 嵌入 ok', () => {
    const view = buildMemoryHealthView({
      vectorCoverage: 0.81,
      vecRows: 104,
      metaRows: 129,
      embedding: 'ok',
      degradedSince: null,
      lastVecWriteAt: null,
    });
    expect(view.hasData).toBe(true);
    expect(view.degraded).toBe(false);
    expect(view.coverageText).toBe('81%');
    expect(view.embeddingOk).toBe(true);
  });

  it('buildMemoryHealthView degraded 态：degraded=true（黄条"向量召回降级"）', () => {
    const view = buildMemoryHealthView({
      vectorCoverage: 0.51,
      vecRows: 104,
      metaRows: 203,
      embedding: 'degraded',
      degradedSince: '2026-09-10T08:00:00.000Z',
      lastVecWriteAt: null,
    });
    expect(view.degraded).toBe(true);
    expect(view.embeddingOk).toBe(false);
  });

  it('memory 子对象缺失：hasData=false（细条展示未知态，不造数据）', () => {
    const view = buildMemoryHealthView(undefined);
    expect(view.hasData).toBe(false);
    expect(view.coveragePct).toBe(0);
    expect(view.degradedSince).toBeNull();
  });
});

// ── U-C1（DS-PANEL-UI-VISUAL-001 §2 S5）：进度环档位 + 视图新字段 ──

describe('health-utils U-C1', () => {
  it('healthRingTone：<70 红 / 70-90 黄 / >90 绿（边界值 70/90/91）', () => {
    expect(healthRingTone(0)).toBe('low');
    expect(healthRingTone(69)).toBe('low');
    expect(healthRingTone(70)).toBe('mid');
    expect(healthRingTone(90)).toBe('mid');
    expect(healthRingTone(91)).toBe('high');
    expect(healthRingTone(100)).toBe('high');
  });

  it('buildMemoryHealthView 补充 coveragePct（与 coverageText 同源取整）与 degradedSince 透传', () => {
    const okView = buildMemoryHealthView({
      vectorCoverage: 0.814,
      vecRows: 1,
      metaRows: 1,
      embedding: 'ok',
      degradedSince: null,
      lastVecWriteAt: null,
    });
    expect(okView.coveragePct).toBe(81);
    expect(okView.coverageText).toBe('81%');
    expect(okView.degradedSince).toBeNull();

    const degradedView = buildMemoryHealthView({
      vectorCoverage: 0.51,
      vecRows: 1,
      metaRows: 1,
      embedding: 'degraded',
      degradedSince: '2026-09-10T08:00:00.000Z',
      lastVecWriteAt: null,
    });
    expect(degradedView.coveragePct).toBe(51);
    expect(degradedView.degradedSince).toBe('2026-09-10T08:00:00.000Z');
  });
});
