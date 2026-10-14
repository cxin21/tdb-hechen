/**
 * P1 task-7：POST /api/v1/chat-memory/importance 人工重要度调整 BFF 测试。
 *
 * 与 chat-memory-archive.test.ts 同款 harness：最小 Hono app + stub
 * metaKernel.invoke（auth/verify + asset/get）+ 全局 fetch vi.spyOn mock
 * （FetchKernelHttpAdapter，不触达真实网关）。验证：Owner-only 门控、
 * importance 形状校验（1-10 整数）、转发目标 URL/体（reason 可选透传）。
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

function makeDeps(opts?: { callerUserId?: string; assetOwner?: string }): PanelDeps {
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
    kernelHttp: new FetchKernelHttpAdapter(),
    ingestProgressStore: { get: () => null },
  } as unknown as PanelDeps;
}

function buildApp(deps: PanelDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  registerChatMemoryRoutes(api, deps);
  app.route('/api/v1', api);
  return app;
}

function callImportance(
  deps: PanelDeps,
  body: Record<string, unknown>,
): Promise<{ res: Response; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = vi.fn(
    async (_url: string | URL | Request) =>
      new Response(
        JSON.stringify(okEnvelope({ id: 'r1', importance: 8, importance_source: 'manual', version: 'v2' })),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);
  const app = buildApp(deps);
  const res = app.request('/api/v1/chat-memory/importance', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'uk-1',
    },
    body: JSON.stringify(body),
  });
  return res.then((r) => ({ res: r, fetchMock }));
}

describe('POST /chat-memory/importance（P1 task-7 Owner-only 透传）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('owner 调整：转发 /v3/atomic/importance 且体带 idFields + importance + reason', async () => {
    const { res, fetchMock } = await callImportance(
      makeDeps(),
      { block_id: BLOCK_ID, id: 'r1', importance: 8, reason: '客户承诺过交付' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data?: { importance: number } };
    expect(body.code).toBe(0);
    expect(body.data?.importance).toBe(8);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${CORE_BASE}/v3/atomic/importance`);
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      team_id: 't1',
      agent_id: 'agt-1',
      user_id: 'u1',
      session_id: 'default',
      id: 'r1',
      importance: 8,
      reason: '客户承诺过交付',
    });
  });

  it('不带 reason：转发体不含 reason 键', async () => {
    const { fetchMock } = await callImportance(makeDeps(), { block_id: BLOCK_ID, id: 'r1', importance: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect('reason' in sent).toBe(false);
    expect(sent.importance).toBe(3);
  });

  it('importance 非法（0 / 11 / 2.5 / "7" / 缺失）→ 400 且不触达上游', async () => {
    for (const bad of [0, 11, 2.5, '7', undefined]) {
      const { res, fetchMock } = await callImportance(
        makeDeps(),
        bad === undefined ? { block_id: BLOCK_ID, id: 'r1' } : { block_id: BLOCK_ID, id: 'r1', importance: bad },
      );
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('非 owner → 403 NOT_ASSET_OWNER 且不触达上游', async () => {
    const { res, fetchMock } = await callImportance(
      makeDeps({ callerUserId: 'u2', assetOwner: 'u1' }),
      { block_id: BLOCK_ID, id: 'r1', importance: 8 },
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('缺 id → 400 MISSING_ID', async () => {
    const { res } = await callImportance(makeDeps(), { block_id: BLOCK_ID, importance: 8 });
    expect(res.status).toBe(400);
  });
});
