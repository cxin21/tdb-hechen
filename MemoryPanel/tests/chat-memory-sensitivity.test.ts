/**
 * task-3 A 项：POST /api/v1/chat-memory/sensitivity 契约测试（BFF 透传）。
 *
 * harness 与 chat-memory-importance.test.ts 同款：最小 Hono app + stub
 * metaKernel.invoke（auth/verify + asset/get）+ 全局 fetch vi.spyOn（不触达真实网关）。
 * 合同来源：MemoryCore 网关 POST /v3/atomic/sensitivity（WRITABLE_SENSITIVITY =
 * none|health|finance|relationship；expect 为 CAS 条件；409 = 并发已改）。
 * 这里钉四件事：转发 URL / 转发体形状（idFields + id + sensitivity + expect）/
 * 白名单校验在 BFF 前置（非法值不发上游）/ Owner-only 门控。
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

function callSensitivity(
  deps: PanelDeps,
  body: Record<string, unknown>,
): Promise<{ res: Response; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = vi.fn(
    async (_url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          okEnvelope({
            id: 'r1',
            sensitivity: 'none',
            previous: 'finance',
            version: 'v2',
            sensitivity_source: 'manual',
          }),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);
  const app = buildApp(deps);
  const res = app.request('/api/v1/chat-memory/sensitivity', {
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

describe('POST /chat-memory/sensitivity（task-3 显式降敏，Owner-only 透传）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('owner 降敏：转发 /v3/atomic/sensitivity，体带 idFields + id + sensitivity + expect + reason', async () => {
    const { res, fetchMock } = await callSensitivity(makeDeps(), {
      block_id: BLOCK_ID,
      id: 'r1',
      sensitivity: 'none',
      expect: 'finance',
      reason: '误判：只是报价单模板',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      data?: { sensitivity?: string; previous?: string; sensitivity_source?: string };
    };
    expect(body.code).toBe(0);
    expect(body.data?.sensitivity).toBe('none');
    expect(body.data?.previous).toBe('finance');
    expect(body.data?.sensitivity_source).toBe('manual');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${CORE_BASE}/v3/atomic/sensitivity`);
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      team_id: 't1',
      agent_id: 'agt-1',
      user_id: 'u1',
      session_id: 'default',
      id: 'r1',
      sensitivity: 'none',
      expect: 'finance',
      reason: '误判：只是报价单模板',
    });
  });

  it('不带 reason：转发体不含 reason 键（不塞空串污染网关审计）', async () => {
    const { fetchMock } = await callSensitivity(makeDeps(), {
      block_id: BLOCK_ID,
      id: 'r1',
      sensitivity: 'none',
      expect: 'health',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect('reason' in sent).toBe(false);
    expect(sent.expect).toBe('health');
  });

  it('大小写/空白归一："None "/"FINANCE" 归一到白名单值后再转发（P2-9 漂移锁）', async () => {
    const { res, fetchMock } = await callSensitivity(makeDeps(), {
      block_id: BLOCK_ID,
      id: 'r1',
      sensitivity: 'None ',
      expect: 'FINANCE',
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    // 转发归一值：内核 v2-router :1695/:1698 对原始串做大小写敏感集合判定
    expect(sent.sensitivity).toBe('none');
    expect(sent.expect).toBe('finance');
  });

  it('sensitivity 非法（unclassified / secret / 空 / 缺失）→ 400 且不触达上游', async () => {
    for (const bad of ['unclassified', 'secret', '', undefined]) {
      const { res, fetchMock } = await callSensitivity(
        makeDeps(),
        bad === undefined
          ? { block_id: BLOCK_ID, id: 'r1', expect: 'finance' }
          : { block_id: BLOCK_ID, id: 'r1', sensitivity: bad, expect: 'finance' },
      );
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('expect 非法（缺失 / unclassified）→ 400 且不触达上游（CAS 必须有可判定条件）', async () => {
    const missing = await callSensitivity(makeDeps(), {
      block_id: BLOCK_ID,
      id: 'r1',
      sensitivity: 'none',
    });
    expect(missing.res.status).toBe(400);
    expect(missing.fetchMock).not.toHaveBeenCalled();

    const bogus = await callSensitivity(makeDeps(), {
      block_id: BLOCK_ID,
      id: 'r1',
      sensitivity: 'none',
      expect: 'unclassified',
    });
    expect(bogus.res.status).toBe(400);
    expect(bogus.fetchMock).not.toHaveBeenCalled();
  });

  it('非 owner → 403 NOT_ASSET_OWNER 且不触达上游', async () => {
    const { res, fetchMock } = await callSensitivity(
      makeDeps({ callerUserId: 'u2', assetOwner: 'u1' }),
      { block_id: BLOCK_ID, id: 'r1', sensitivity: 'none', expect: 'finance' },
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('缺 id → 400 MISSING_ID 且不触达上游', async () => {
    const { res, fetchMock } = await callSensitivity(makeDeps(), {
      block_id: BLOCK_ID,
      sensitivity: 'none',
      expect: 'finance',
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('网关 409 CAS 冲突 → 原样透传 409（不吞成成功）', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(
          JSON.stringify({
            code: 409,
            message: 'sensitivity CAS mismatch',
            request_id: 'test-req',
            data: { id: 'r1', current: 'relationship' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);
    const app = buildApp(makeDeps());
    const res = await app.request('/api/v1/chat-memory/sensitivity', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tdai-service-id': 'inst-1',
        'x-tdai-user-key': 'uk-1',
      },
      body: JSON.stringify({
        block_id: BLOCK_ID,
        id: 'r1',
        sensitivity: 'none',
        expect: 'finance',
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(409);
  });
});
