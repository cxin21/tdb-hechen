/**
 * P1 task-8：POST /api/v1/chat-memory/invalidate 标记失效/撤销失效 BFF 测试。
 *
 * 与 chat-memory-importance.test.ts 同款 harness：最小 Hono app + stub
 * metaKernel.invoke（auth/verify + asset/get）+ 全局 fetch vi.spyOn mock
 * （FetchKernelHttpAdapter，不触达真实网关）。验证：Owner-only 门控、
 * mode 校验（invalidate|restore|非法）、缺省 mode=invalidate、
 * 转发目标 URL/体（record_id + mode；面板不透传 valid_end）。
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

function callInvalidate(
  deps: PanelDeps,
  body: Record<string, unknown>,
): Promise<{ res: Response; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = vi.fn(
    async (_url: string | URL | Request) =>
      new Response(
        JSON.stringify(okEnvelope({ id: 'r1', version: 'v2', valid_end: '2026-10-14T02:40:00.000Z' })),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);
  const app = buildApp(deps);
  const res = app.request('/api/v1/chat-memory/invalidate', {
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

describe('POST /chat-memory/invalidate（P1 task-8 Owner-only 透传）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('缺省 mode：转发 /v3/atomic/invalidate 且体带 record_id + mode=invalidate（无 valid_end）', async () => {
    const { res, fetchMock } = await callInvalidate(makeDeps(), { block_id: BLOCK_ID, id: 'r1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data?: { valid_end?: string } };
    expect(body.code).toBe(0);
    expect(body.data?.valid_end).toBe('2026-10-14T02:40:00.000Z');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${CORE_BASE}/v3/atomic/invalidate`);
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      team_id: 't1',
      agent_id: 'agt-1',
      user_id: 'u1',
      session_id: 'default',
      record_id: 'r1',
      mode: 'invalidate',
    });
    expect('valid_end' in sent).toBe(false);
    expect('id' in sent).toBe(false);
  });

  it('显式 mode=restore：转发体 mode=restore', async () => {
    const { fetchMock } = await callInvalidate(
      makeDeps(),
      { block_id: BLOCK_ID, id: 'r1', mode: 'restore' },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.mode).toBe('restore');
    expect(sent.record_id).toBe('r1');
  });

  it('mode 非法（"delete" / 123 / null）→ 400 INVALID_MODE 且不触达上游', async () => {
    for (const bad of ['delete', 123, null]) {
      const { res, fetchMock } = await callInvalidate(
        makeDeps(),
        { block_id: BLOCK_ID, id: 'r1', mode: bad },
      );
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('缺 id / 缺 block_id → 400 且不触达上游', async () => {
    const a = await callInvalidate(makeDeps(), { block_id: BLOCK_ID });
    expect(a.res.status).toBe(400);
    expect(a.fetchMock).not.toHaveBeenCalled();
    const b = await callInvalidate(makeDeps(), { id: 'r1' });
    expect(b.res.status).toBe(400);
    expect(b.fetchMock).not.toHaveBeenCalled();
  });

  it('非 owner → 403 NOT_ASSET_OWNER 且不触达上游', async () => {
    const { res, fetchMock } = await callInvalidate(
      makeDeps({ callerUserId: 'u2', assetOwner: 'u1' }),
      { block_id: BLOCK_ID, id: 'r1' },
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上游失败信封原样透传（不吞码）', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(
          JSON.stringify({ code: 500, message: '失效写入失败（行不存在或已失效不覆盖）: r1', request_id: 'x', data: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);
    const app = buildApp(makeDeps());
    const res = await app.request('/api/v1/chat-memory/invalidate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tdai-service-id': 'inst-1',
        'x-tdai-user-key': 'uk-1',
      },
      body: JSON.stringify({ block_id: BLOCK_ID, id: 'r1' }),
    });
    const body = (await res.json()) as { code: number; message?: string };
    expect(body.code).toBe(500);
    expect(body.message).toContain('失效写入失败');
  });
});
