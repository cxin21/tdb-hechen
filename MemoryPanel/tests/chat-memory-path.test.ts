/**
 * U-A3（DS-PANEL-UI-VISUAL-001 §2 S2 关联区 / 计划批 1）：getPath 关联链 BFF 透传测试。
 *
 * POST /api/v1/chat-memory/path → 网关 /v3/atomic/path（C6，生产路由，消费方=0 本批接入）。
 * 内核出参（MemoryCore v2-router handleAtomicPath）：
 *   { startId, endId, path: Array<{id,type,strength,hop,content?,occurred_at?,certainty?,valence?,significance?}> | null }
 *   （store 未实现 getPath → path: null，如实缺省）
 * 读权限与 /chat-memory/neighbors 同一套 ACL（owner / team-shared / borrowed 任一）。
 *
 * 构造方式照抄 tests/chat-memory-archive.test.ts（fetch mock，不触达真实网关）。
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

function makeDeps(opts?: {
  callerUserId?: string;
  assetOwner?: string;
  visibility?: string;
}): { deps: PanelDeps } {
  const callerUserId = opts?.callerUserId ?? 'u1';
  const assetOwner = opts?.assetOwner ?? 'u1';
  const visibility = opts?.visibility ?? 'private';
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
    metaKernel: {
      invoke: vi.fn(async (action: string): Promise<InvokeEnvelope> => {
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
            visibility,
            status: 'ready',
          });
        }
        if (action === 'team-member/get') {
          return okEnvelope({ team_id: 't1', user_id: callerUserId });
        }
        return okEnvelope(null);
      }),
    },
    kernelHttp: new FetchKernelHttpAdapter(),
    ingestProgressStore: { get: () => null },
  } as unknown as PanelDeps;
  return { deps };
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

function mockKernelFetch(payload: { body: unknown }) {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload.body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
}

async function call(deps: PanelDeps, body: unknown): Promise<Response> {
  const app = buildApp(deps);
  return app.request('/api/v1/chat-memory/path', {
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

describe('POST /chat-memory/path → /v3/atomic/path', () => {
  it('透传 idFields + startId/endId/maxHop，结果原样透出（含 path=null 如实缺省）', async () => {
    const { deps } = makeDeps();
    const path = [
      { id: 'a', type: 'evolve', strength: 0.9, hop: 0, content: 'A 内容', valence: 0.8 },
      { id: 'b', type: 'relate', strength: 0.6, hop: 1, content: 'B 内容' },
    ];
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { startId: 'a', endId: 'b', path } } });
    const res = await call(deps, { block_id: BLOCK_ID, startId: 'a', endId: 'b' });
    expect(res.status).toBe(200);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/atomic/path`);
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    // /v3 严格 isolation：三元组必填；startId/endId 原名透传（内核 handleAtomicPath 消费键）
    expect(sent.team_id).toBe('t1');
    expect(sent.agent_id).toBe('agt-1');
    expect(sent.user_id).toBe('u1');
    expect(sent.startId).toBe('a');
    expect(sent.endId).toBe('b');
    expect(sent.maxHop).toBe(3); // 缺省 clamp 上限（与内核 [1,3] 护栏一致）
    const body = (await res.json()) as InvokeEnvelope;
    expect((body.data as { path: unknown }).path).toEqual(path);

    // path=null（store 未实现 getPath）：如实透出，不伪成功不 500
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { startId: 'a', endId: 'b', path: null } } });
    const res2 = await call(deps, { block_id: BLOCK_ID, startId: 'a', endId: 'b' });
    const body2 = (await res2.json()) as InvokeEnvelope;
    expect((body2.data as { path: unknown }).path).toBeNull();
  });

  it('maxHop 显式传入时 clamp 到 [1,3]', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { startId: 'a', endId: 'b', path: null } } });
    await call(deps, { block_id: BLOCK_ID, startId: 'a', endId: 'b', maxHop: 9 });
    const { init } = await lastKernelCall();
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.maxHop).toBe(3);
  });

  it('缺 block_id / startId / endId 返回 400，不触达上游', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: {} } });
    for (const body of [
      { startId: 'a', endId: 'b' },
      { block_id: BLOCK_ID, endId: 'b' },
      { block_id: BLOCK_ID, startId: 'a' },
    ]) {
      const res = await call(deps, body);
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('读权限不过（非 owner + 非 team 共享 + 无借入）返回 403', async () => {
    const { deps } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1', visibility: 'private' });
    mockKernelFetch({ body: { code: 0, message: 'ok', data: {} } });
    const res = await call(deps, { block_id: BLOCK_ID, startId: 'a', endId: 'b' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('自建 UserAsset（无关联 agent）返回空 path（与 layer/neighbors 语义一致）', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: {} } });
    const res = await call(deps, { block_id: 'mem-xyz', startId: 'a', endId: 'b' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeEnvelope;
    expect((body.data as { path: unknown }).path).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
