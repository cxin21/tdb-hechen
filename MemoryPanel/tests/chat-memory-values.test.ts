/**
 * Task 5（DS-PANEL-UI-WIKI-SOURCE-001 §2.4）：价值锚编辑面板 BFF 透传测试。
 *
 * 覆盖（S1 values upsert|delete + C2 derive，网关现成路由）：
 *   - POST /api/v1/chat-memory/values/list    → /v3/core-memory/read（只取 values，丢 slots）
 *   - POST /api/v1/chat-memory/values/upsert  → /v3/core-memory/values/upsert
 *       微调：显式携带 valence；plain（新建）：不携带 valence 键
 *   - POST /api/v1/chat-memory/values/delete  → /v3/core-memory/values/delete
 *   - POST /api/v1/chat-memory/values/derive  → /v3/core-memory/values/derive（无业务覆写字段）
 *       微调优先语义的后端不变量（derive 只判 NULL 行，永不覆盖非 NULL）在
 *       MemoryCore v2-router handleCoreMemoryValuesDerive 保证（apply-after-success +
 *       `valence IS NULL` 守卫）；Panel 层断言可证的请求形状：derive 请求体不含
 *       valence/label/weight —— 微调（upsert+valence）与 derive 永远是两次独立调用。
 *   - 读 ACL（owner/team-shared/borrowed）与写 Owner-only
 *
 * 构造方式照抄 tests/wiki-source-routes.test.ts。
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
}): { deps: PanelDeps; invoke: ReturnType<typeof vi.fn> } {
  const callerUserId = opts?.callerUserId ?? 'u1';
  const assetOwner = opts?.assetOwner ?? 'u1';
  const visibility = opts?.visibility ?? 'private';
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

async function call(deps: PanelDeps, path: string, body: unknown): Promise<Response> {
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

// ── values/list ──

describe('POST /chat-memory/values/list', () => {
  it('透传 idFields 到 /v3/core-memory/read，只返回 values（丢 slots）', async () => {
    const { deps } = makeDeps();
    const values = [
      { value_id: 'correctness', label: '正确性', weight: 0.8, created_by: 'agent', valence: 1 },
      { value_id: 'frugality', label: '克己', weight: 0.5, created_by: 'agent', valence: null },
    ];
    mockKernelFetch({
      body: { code: 0, message: 'ok', data: { slots: [{ slot: 'persona', content: 'x', version: 1 }], values } },
    });
    const res = await call(deps, '/api/v1/chat-memory/values/list', { block_id: BLOCK_ID });
    expect(res.status).toBe(200);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/core-memory/read`);
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.team_id).toBe('t1');
    expect(sent.agent_id).toBe('agt-1');
    expect(sent.user_id).toBe('u1');
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.data).toEqual({ values });
  });

  it('缺 block_id 返回 400；读权限不过返回 403', async () => {
    const { deps } = makeDeps();
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/values/list', {});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const { deps: deps2 } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1', visibility: 'private' });
    const res2 = await call(deps2, '/api/v1/chat-memory/values/list', { block_id: BLOCK_ID });
    expect(res2.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── values/upsert（微调 vs plain 新建）──

describe('POST /chat-memory/values/upsert', () => {
  it('微调：valence 显式透传（S1 显式 valence 走用户微调路径）', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { ok: true, value_id: 'correctness' } } });
    const res = await call(deps, '/api/v1/chat-memory/values/upsert', {
      block_id: BLOCK_ID,
      value_id: 'correctness',
      label: '正确性',
      weight: 0.9,
      valence: -1,
    });
    expect(res.status).toBe(200);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/core-memory/values/upsert`);
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.value_id).toBe('correctness');
    expect(sent.label).toBe('正确性');
    expect(sent.weight).toBe(0.9);
    expect(sent.valence).toBe(-1);
    expect(sent.team_id).toBe('t1');
    expect(sent.agent_id).toBe('agt-1');
    expect(sent.user_id).toBe('u1');
  });

  it('plain 新建（未选方向）：不携带 valence 键（后端落 NULL 待 LLM 判，不触发 derive 钩子）', async () => {
    const { deps } = makeDeps();
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/values/upsert', {
      block_id: BLOCK_ID,
      value_id: 'candor',
      label: '坦率',
      weight: 0.6,
    });
    expect(res.status).toBe(200);
    const { init } = await lastKernelCall();
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect('valence' in sent).toBe(false);
  });

  it('缺 value_id / label / weight 返回 400，不触达上游', async () => {
    const { deps } = makeDeps();
    mockKernelFetch();
    for (const body of [
      { label: 'x', weight: 0.5 },
      { value_id: 'x', weight: 0.5 },
      { value_id: 'x', label: 'x' },
    ]) {
      const res = await call(deps, '/api/v1/chat-memory/values/upsert', { block_id: BLOCK_ID, ...body });
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非 Owner 返回 403（写 Owner-only，与 layer-delete/clear 同口径）', async () => {
    const { deps } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1', visibility: 'team' });
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/values/upsert', {
      block_id: BLOCK_ID,
      value_id: 'x',
      label: 'x',
      weight: 0.5,
      valence: 1,
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── values/delete ──

describe('POST /chat-memory/values/delete', () => {
  it('透传 {value_id} 到 /v3/core-memory/values/delete；缺 value_id → 400', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { ok: true, value_id: 'candor' } } });
    const res = await call(deps, '/api/v1/chat-memory/values/delete', { block_id: BLOCK_ID, value_id: 'candor' });
    expect(res.status).toBe(200);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/core-memory/values/delete`);
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.value_id).toBe('candor');

    const res2 = await call(deps, '/api/v1/chat-memory/values/delete', { block_id: BLOCK_ID });
    expect(res2.status).toBe(400);
  });

  it('非 Owner 返回 403', async () => {
    const { deps } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1', visibility: 'team' });
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/values/delete', { block_id: BLOCK_ID, value_id: 'candor' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── values/derive（C2 重新总结方向）──

describe('POST /chat-memory/values/derive', () => {
  it('透传到 /v3/core-memory/values/derive；请求体只含 idFields，无 valence/label/weight 覆写', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { derived: 2, skipped: 1 } } });
    const res = await call(deps, '/api/v1/chat-memory/values/derive', { block_id: BLOCK_ID });
    expect(res.status).toBe(200);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/core-memory/values/derive`);
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.team_id).toBe('t1');
    expect(sent.agent_id).toBe('agt-1');
    expect(sent.user_id).toBe('u1');
    // 微调优先（三方语义 1）由后端 `valence IS NULL` 守卫保证；Panel 层可证形状：
    // derive 请求体绝不携带任何方向/内容覆写，微调与重判是两次独立上游调用。
    expect('valence' in sent).toBe(false);
    expect('label' in sent).toBe(false);
    expect('weight' in sent).toBe(false);
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.data).toEqual({ derived: 2, skipped: 1 });
  });

  it('非 Owner 返回 403', async () => {
    const { deps } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1', visibility: 'team' });
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/values/derive', { block_id: BLOCK_ID });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── values/discover（Task DISC 价值锚发现，提议制）──

describe('POST /chat-memory/values/discover', () => {
  it('透传到 /v3/core-memory/values/discover；请求体只含 idFields（无任何提案字段覆写），原样返回 proposals', async () => {
    const { deps } = makeDeps();
    const proposals = [
      { label: '增量对账', rationale: '反复出现', evidenceCount: 3, suggestedWeight: 0.675 },
    ];
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { proposals, sampleSize: 4 } } });
    const res = await call(deps, '/api/v1/chat-memory/values/discover', { block_id: BLOCK_ID });
    expect(res.status).toBe(200);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/core-memory/values/discover`);
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.team_id).toBe('t1');
    expect(sent.agent_id).toBe('agt-1');
    expect(sent.user_id).toBe('u1');
    // K1 信任边界可证形状：discover 是纯只读发现，请求体绝不携带任何提案/落库字段
    //（持久化只能经人点「采纳」走 values/upsert 独立调用）。
    expect('label' in sent).toBe(false);
    expect('weight' in sent).toBe(false);
    expect('proposals' in sent).toBe(false);
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.data).toEqual({ proposals, sampleSize: 4 });
  });

  it('无提议（宁缺毋滥）→ 透传空数组', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { proposals: [], sampleSize: 0 } } });
    const res = await call(deps, '/api/v1/chat-memory/values/discover', { block_id: BLOCK_ID });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.data).toEqual({ proposals: [], sampleSize: 0 });
  });

  it('缺 block_id 返回 400；非 Owner 返回 403', async () => {
    const { deps } = makeDeps();
    mockKernelFetch();
    const res = await call(deps, '/api/v1/chat-memory/values/discover', {});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const { deps: deps2 } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1', visibility: 'private' });
    const res2 = await call(deps2, '/api/v1/chat-memory/values/discover', { block_id: BLOCK_ID });
    expect(res2.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── values/list include_retired（GROW Panel 退休区）──

describe('POST /chat-memory/values/list include_retired（GROW）', () => {
  it('include_retired=true 透传到 /v3/core-memory/read；默认不携带该字段（旧行为）', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({
      body: {
        code: 0, message: 'ok',
        data: {
          slots: [],
          values: [
            { value_id: 'v1', label: '活跃锚', weight: 0.8, created_by: 'agent', valence: null, origin: 'auto', pinned: 0, state: 'active' },
            { value_id: 'v2', label: '退休锚', weight: 0.6, created_by: 'auto-growth', valence: null, origin: 'auto', pinned: 0, state: 'retired' },
          ],
        },
      },
    });
    const res = await call(deps, '/api/v1/chat-memory/values/list', { block_id: BLOCK_ID, include_retired: true });
    expect(res.status).toBe(200);
    const { init } = await lastKernelCall();
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.include_retired).toBe(true);

    const res2 = await call(deps, '/api/v1/chat-memory/values/list', { block_id: BLOCK_ID });
    const { init: init2 } = await lastKernelCall();
    const sent2 = JSON.parse(init2.body as string) as Record<string, unknown>;
    expect('include_retired' in sent2).toBe(false);

    // origin/pinned/state 字段原样透传（Panel 退休区/徽标依赖）
    const body = (await res.json()) as InvokeEnvelope;
    const values = (body.data as { values: Array<Record<string, unknown>> }).values;
    expect(values[1]).toMatchObject({ value_id: 'v2', state: 'retired', origin: 'auto' });
  });
});

// ── values/pin / values/retire / values/restore（GROW 状态机写入口）──

describe('POST /chat-memory/values/pin', () => {
  it('透传 {value_id, pinned} 到 /v3/core-memory/values/pin', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { ok: true, value_id: 'candor', pinned: true } } });
    const res = await call(deps, '/api/v1/chat-memory/values/pin', { block_id: BLOCK_ID, value_id: 'candor', pinned: true });
    expect(res.status).toBe(200);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/core-memory/values/pin`);
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.value_id).toBe('candor');
    expect(sent.pinned).toBe(true);
    expect(sent.team_id).toBe('t1');
    expect(sent.user_id).toBe('u1');
  });

  it('缺 value_id / pinned 非布尔 → 400，不触达上游；非 Owner → 403', async () => {
    const { deps } = makeDeps();
    mockKernelFetch();
    expect((await call(deps, '/api/v1/chat-memory/values/pin', { block_id: BLOCK_ID, pinned: true })).status).toBe(400);
    expect((await call(deps, '/api/v1/chat-memory/values/pin', { block_id: BLOCK_ID, value_id: 'x', pinned: 'yes' })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const { deps: deps2 } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1', visibility: 'team' });
    const res2 = await call(deps2, '/api/v1/chat-memory/values/pin', { block_id: BLOCK_ID, value_id: 'x', pinned: true });
    expect(res2.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /chat-memory/values/retire 与 /restore', () => {
  it('retire 透传 {value_id} 到 /v3/core-memory/values/retire', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { ok: true, value_id: 'candor' } } });
    const res = await call(deps, '/api/v1/chat-memory/values/retire', { block_id: BLOCK_ID, value_id: 'candor' });
    expect(res.status).toBe(200);
    const { url, init } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/core-memory/values/retire`);
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.value_id).toBe('candor');
    expect(sent.agent_id).toBe('agt-1');
  });

  it('restore 透传 {value_id} 到 /v3/core-memory/values/restore', async () => {
    const { deps } = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { ok: true, value_id: 'candor' } } });
    const res = await call(deps, '/api/v1/chat-memory/values/restore', { block_id: BLOCK_ID, value_id: 'candor' });
    expect(res.status).toBe(200);
    const { url } = await lastKernelCall();
    expect(url).toBe(`${CORE_BASE}/v3/core-memory/values/restore`);
  });

  it('缺 value_id → 400；非 Owner → 403（写 Owner-only 同口径）', async () => {
    const { deps } = makeDeps();
    mockKernelFetch();
    expect((await call(deps, '/api/v1/chat-memory/values/retire', { block_id: BLOCK_ID })).status).toBe(400);
    expect((await call(deps, '/api/v1/chat-memory/values/restore', { block_id: BLOCK_ID })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const { deps: deps2 } = makeDeps({ callerUserId: 'u2', assetOwner: 'u1', visibility: 'team' });
    expect((await call(deps2, '/api/v1/chat-memory/values/retire', { block_id: BLOCK_ID, value_id: 'x' })).status).toBe(403);
    expect((await call(deps2, '/api/v1/chat-memory/values/restore', { block_id: BLOCK_ID, value_id: 'x' })).status).toBe(403);
  });
});
