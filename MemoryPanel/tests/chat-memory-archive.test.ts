/**
 * Task 4（DS-PANEL-UI-WIKI-SOURCE-001 §2.1-2.2）：BlockDetail 扩展 + 归档可见/恢复 BFF 测试。
 *
 * 覆盖：
 *   - POST /api/v1/chat-memory/archive/list    → /v3/atomic/archive/list（读权限 ACL）
 *   - POST /api/v1/chat-memory/archive/restore → /v3/atomic/archive/restore（Owner-only）
 *   - /chat-memory/layer L1 的 metadata 透传（coreRefs / recall_count 前向兼容，见报告 concern-1）
 *   - anchor-utils 纯函数：coreRefs / recall_count 宽松提取
 *
 * 构造方式照抄 tests/wiki-source-routes.test.ts；kernelHttp 用真实 FetchKernelHttpAdapter
 * （fetch 已 mock，不触达真实网关）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemoryRoutes } from '../src/panel/http/routes/chat-memory.js';
import { FetchKernelHttpAdapter } from '../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';
import { coreRefsOf, recallCountOf } from '../web/src/pages/ChatMemoryPage/utils/anchor-utils';

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

function makeDeps(opts?: {
  callerUserId?: string;
  assetOwner?: string;
  visibility?: string;
  assetMissing?: boolean;
}): { deps: PanelDeps; invoke: ReturnType<typeof vi.fn> } {
  const callerUserId = opts?.callerUserId ?? 'u1';
  const assetOwner = opts?.assetOwner ?? 'u1';
  const visibility = opts?.visibility ?? 'private';
  const assetMissing = opts?.assetMissing ?? false;
  const invoke = vi.fn(async (action: string): Promise<InvokeEnvelope> => {
    if (action === 'auth/verify') {
      return okEnvelope({ valid: true, user: { user_id: callerUserId, user_type: 'member' } });
    }
    if (action === 'asset/get') {
      if (assetMissing) return okEnvelope(null);
      return okEnvelope({
        asset_id: BLOCK_ID,
        team_id: 't1',
        asset_type: 'chat_memory',
        name: 'mem',
        owner_user_id: assetOwner,
        visibility,
        status: 'ready',
      });
    }
    if (action === 'team-member/get') {
      return okEnvelope({ team_id: 't1', user_id: callerUserId });
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

function mockKernelFetch(payload: { status?: number; body: unknown } = { body: { code: 0, message: 'ok', data: {} } }) {
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
): Promise<Response> {
  const app = buildApp(deps);
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'uk-1',
    },
    body: JSON.stringify(body),
  });
}

async function lastKernelCall(): Promise<{ url: string; init: RequestInit }> {
  const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  return { url, init };
}

// ── POST /chat-memory/archive/list → /v3/atomic/archive/list ──

describe('POST /chat-memory/archive/list', () => {
  it('透传 idFields 到 /v3/atomic/archive/list，limit/offset 映射，结果原样透出', async () => {
    const { deps } = makeDeps();
    const archived = [
      { record_id: 'r1', archived_at: '2026-09-01T00:00:00Z', reason: 'forget', content: '旧记忆' },
    ];
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { items: archived, total: 1 } } });
    const res = await call(deps, '/api/v1/chat-memory/archive/list', { block_id: BLOCK_ID });
    expect(res.status).toBe(200);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/atomic/archive/list`);
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    // /v3 严格 isolation：三元组必填（v2-router collectV3Missing）
    expect(sent.team_id).toBe('t1');
    expect(sent.agent_id).toBe('agt-1');
    expect(sent.user_id).toBe('u1');
    expect(sent.limit).toBe(100);
    expect(sent.offset).toBe(0);
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.code).toBe(0);
    expect((body.data as { items: unknown[] }).items).toEqual(archived);
  });

  it('缺 block_id 返回 400，不触达上游', async () => {
    const { deps } = makeDeps();
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/archive/list', {});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('读权限不过（非 owner + 非 team 共享 + 无借入）返回 403', async () => {
    const { deps } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1', visibility: 'private' });
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/archive/list', { block_id: BLOCK_ID });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── POST /chat-memory/archive/restore → /v3/atomic/archive/restore ──

describe('POST /chat-memory/archive/restore', () => {
  it('Owner 透传 {id} 到 /v3/atomic/archive/restore（附 idFields 过 /v3 闸门）', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { ok: true, id: 'r1' } } });
    const res = await call(deps, '/api/v1/chat-memory/archive/restore', { block_id: BLOCK_ID, id: 'r1' });
    expect(res.status).toBe(200);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/atomic/archive/restore`);
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.id).toBe('r1');
    expect(sent.team_id).toBe('t1');
    expect(sent.agent_id).toBe('agt-1');
    expect(sent.user_id).toBe('u1');
    const body = (await res.json()) as InvokeEnvelope;
    expect((body.data as { ok: boolean }).ok).toBe(true);
  });

  it('非 Owner（借入方也不得恢复他人记忆）返回 403 NOT_ASSET_OWNER', async () => {
    const { deps } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1', visibility: 'team' });
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/archive/restore', { block_id: BLOCK_ID, id: 'r1' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('NOT_ASSET_OWNER');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('缺 id 返回 400', async () => {
    const { deps } = makeDeps();
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/archive/restore', { block_id: BLOCK_ID });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── /chat-memory/layer L1：metadata（coreRefs / recall_count）前向兼容透传 ──

describe('POST /chat-memory/layer L1 metadata 透传', () => {
  it('内核返回 metadata 时 BFF 原样带出（网关今日不返回 → 前向兼容，见报告 concern-1）', async () => {
    const { deps } = makeDeps();
    const metadata = { coreRefs: ['correctness', 'reliability'], recall_count: 3, last_recalled_at: '2026-09-10T00:00:00Z' };
    mockKernelFetch({
      body: {
        code: 0,
        message: 'ok',
        data: {
          items: [
            { record_id: 'r1', type: 'fact', content: '内容', metadata, valence: 0.8 },
          ],
          total: 1,
        },
      },
    });
    const res = await call(deps, '/api/v1/chat-memory/layer', { block_id: BLOCK_ID, layer: 'L1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeEnvelope;
    const items = (body.data as { items: Array<{ metadata?: unknown }> }).items;
    expect(items[0].metadata).toEqual(metadata);
  });
});

// ── anchor-utils 纯函数：宽松提取（容忍损坏，不造假值） ──

describe('anchor-utils', () => {
  it('coreRefsOf：字符串数组原样返回；缺失/损坏 → 空数组', () => {
    expect(coreRefsOf({ coreRefs: ['correctness'] })).toEqual(['correctness']);
    expect(coreRefsOf({ coreRefs: 'bad' })).toEqual([]);
    expect(coreRefsOf({ coreRefs: [1, 2] })).toEqual([]);
    expect(coreRefsOf(undefined)).toEqual([]);
    expect(coreRefsOf({})).toEqual([]);
  });

  it('recallCountOf：数字原样返回；缺失/非有限数 → undefined', () => {
    expect(recallCountOf({ recall_count: 3 })).toBe(3);
    expect(recallCountOf({ recall_count: 0 })).toBe(0);
    expect(recallCountOf({ recall_count: 'x' })).toBeUndefined();
    expect(recallCountOf({})).toBeUndefined();
    expect(recallCountOf(undefined)).toBeUndefined();
  });
});
