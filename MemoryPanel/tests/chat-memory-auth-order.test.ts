/**
 * 红队 2026-11-01 §MEDIUM-存在性预言机（task-59 ①）。
 *
 * 缺陷复盘（scratch/probe-red/results-04.json S8/S9）：
 *   - 假 key + 不存在的 block_id → 200 code 0（走完 schema 分支，压根没到鉴权）
 *   - 假 key + 真实的 block_id     → 401 INVALID_USER_KEY
 * 两者响应不同 ⇒ 无凭据即可枚举 asset_id 是否存在。
 *
 * 修复：layer / layer-delete / clear / patch-scope / create 五条路由挂
 * requireChatMemoryCaller，鉴权先于任何 schema 校验与资产查找。
 * 本文件锁死这个顺序：无凭据时五条路由一律 401，且不得触发任何资产查询。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemoryRoutes } from '../src/panel/http/routes/chat-memory.js';

const CORE_BASE = 'http://core-test:2';
const REAL_BLOCK = 'chat_memory-t1-agt-1';
const FAKE_BLOCK = 'chat_memory-t1-agt-doesnotexist';

interface InvokeEnvelope {
  code: number;
  message: string;
  request_id: string;
  data: unknown;
}

function okEnvelope(data: unknown): InvokeEnvelope {
  return { code: 0, message: 'ok', request_id: 'test-req', data };
}

/**
 * 内核 mock：auth/verify 只在 key==='uk-valid' 时放行；
 * asset/get 只认得 REAL_BLOCK，其余 404。
 * 返回值里带回 invoke 的调用记录，用来断言「鉴权失败时没有发生资产查询」。
 */
function makeDeps(): { deps: PanelDeps; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (action: string, body: unknown): Promise<InvokeEnvelope> => {
    if (action === 'auth/verify') {
      const key = (body as { user_key?: string })?.user_key;
      if (key === 'uk-valid') {
        return okEnvelope({ valid: true, user: { user_id: 'u1', user_type: 'member' } });
      }
      return okEnvelope({ valid: false });
    }
    if (action === 'asset/get') {
      const assetId = (body as { asset_id?: string })?.asset_id;
      if (assetId === REAL_BLOCK) {
        return okEnvelope({
          asset_id: REAL_BLOCK,
          team_id: 't1',
          asset_type: 'chat_memory',
          name: 'mem',
          owner_user_id: 'u1',
          visibility: 'private',
          status: 'ready',
        });
      }
      return { code: 404, message: 'not found', request_id: 'test-req', data: null };
    }
    if (action === 'team-member/get') return okEnvelope({ team_id: 't1', user_id: 'u1' });
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
    kernelHttp: { postEnvelope: vi.fn(async () => okEnvelope({})) },
    ingestProgressStore: { get: () => null },
  } as unknown as PanelDeps;
  return { deps, invoke };
}

async function call(deps: PanelDeps, path: string, body: unknown, userKey: string): Promise<Response> {
  const app = new Hono();
  const api = new Hono();
  registerChatMemoryRoutes(api, deps);
  app.route('/api/v1', api);
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': userKey,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 五条路由各自的「合法 body」与「schema 立刻会拒的 body」。
 * 关键点：两条 body 在修复后都必须得到同一个 401 —— 若某条仍返回 400/404/200，
 * 说明它还在鉴权之前做 schema/资产判断，预言机就复活了。
 */
const ROUTES: Array<{
  path: string;
  valid: Record<string, unknown>;
  schemaRejected: Record<string, unknown>;
}> = [
  {
    path: '/api/v1/chat-memory/layer',
    valid: { block_id: REAL_BLOCK, layer: 'L0' },
    schemaRejected: { block_id: REAL_BLOCK, layer: 'NOPE' },
  },
  {
    path: '/api/v1/chat-memory/layer-delete',
    valid: { block_id: REAL_BLOCK, layer: 'L0', message_ids: ['m1'] },
    schemaRejected: { block_id: REAL_BLOCK, layer: 'NOPE' },
  },
  {
    path: '/api/v1/chat-memory/clear',
    valid: { memory_ids: [REAL_BLOCK] },
    schemaRejected: { memory_ids: [] },
  },
  {
    path: '/api/v1/chat-memory/patch-scope',
    valid: { block_id: REAL_BLOCK, scope: 'team' },
    schemaRejected: { block_id: REAL_BLOCK, scope: 'nope' },
  },
  {
    path: '/api/v1/chat-memory/create',
    valid: { team_id: 't1', title: 'probe' },
    schemaRejected: { team_id: 't1', title: '' },
  },
];

describe('鉴权先于 schema / 资产查找（消除存在性预言机）', () => {
  for (const route of ROUTES) {
    it(`${route.path}: 假 key + 真实/虚构 id + 合法/非法 body 一律 401`, async () => {
      const { deps, invoke } = makeDeps();

      const responses = [
        await call(deps, route.path, route.valid, 'uk-bogus'),
        await call(deps, route.path, route.schemaRejected, 'uk-bogus'),
        await call(deps, route.path, { block_id: FAKE_BLOCK, ...route.valid }, 'uk-bogus'),
      ];

      for (const res of responses) {
        expect(res.status).toBe(401);
        const body = (await res.json()) as InvokeEnvelope;
        expect(body.message).toBe('INVALID_USER_KEY');
      }

      // 鉴权失败时只允许打 auth/verify —— 一次资产查询都不该发生。
      const actions = invoke.mock.calls.map((c) => c[0]);
      expect(new Set(actions)).toEqual(new Set(['auth/verify']));
    });
  }

  it('真实 id 与虚构 id 在无凭据时响应完全一致（无可区分字段）', async () => {
    const { deps } = makeDeps();
    const real = await call(deps, '/api/v1/chat-memory/layer', { block_id: REAL_BLOCK, layer: 'L0' }, 'uk-bogus');
    const fake = await call(deps, '/api/v1/chat-memory/layer', { block_id: FAKE_BLOCK, layer: 'L0' }, 'uk-bogus');
    expect(real.status).toBe(fake.status);
    const realBody = (await real.json()) as Record<string, unknown>;
    const fakeBody = (await fake.json()) as Record<string, unknown>;
    // request_id 每次不同，比较其余字段
    delete realBody.request_id;
    delete fakeBody.request_id;
    expect(realBody).toEqual(fakeBody);
  });

  it('有凭据时行为不变：合法 body 不被 401 拦（layer 走通 ACL 分支）', async () => {
    const { deps } = makeDeps();
    const res = await call(deps, '/api/v1/chat-memory/layer', { block_id: REAL_BLOCK, layer: 'L0' }, 'uk-valid');
    expect(res.status).not.toBe(401);
  });

  it('有凭据时 schema 校验仍生效：非法 body 返 400 而不是被吞掉', async () => {
    const { deps } = makeDeps();
    const res = await call(deps, '/api/v1/chat-memory/patch-scope', { block_id: REAL_BLOCK, scope: 'nope' }, 'uk-valid');
    expect(res.status).toBe(400);
    const body = (await res.json()) as InvokeEnvelope;
    expect(body.message).toBe('INVALID_SCOPE');
  });

  it('有凭据时资产查找仍生效：不存在的 id 返 404 而不是 401', async () => {
    const { deps } = makeDeps();
    const res = await call(deps, '/api/v1/chat-memory/layer-delete', {
      block_id: FAKE_BLOCK,
      layer: 'L0',
      message_ids: ['m1'],
    }, 'uk-valid');
    // FAKE_BLOCK 能被 parseChatMemoryAssetId 解析成 agent 型资产 → 走 asset/get → 404
    expect([400, 404]).toContain(res.status);
  });
});
