/**
 * #124-B1（epic #124 面板 B1，P0 整片空白）：「固定资产记忆」tab 的取数改为类型下推。
 *
 * 旧实现：拉该 agent 名下**全部**固定资产（FA_PAGE_SIZE=100，hard limit 500 就 break），
 * 再在内存里过滤 asset_type==="chat_memory"。库里 519 个 skill + 1 个 chat_memory 时，
 * chat_memory 排在分页窗口之外 / 撞上 500 硬上限被整片丢弃 → tab 空白。
 *
 * 现实现：把 asset_types:["chat_memory"] 下推给内核
 * （MemoryCore/src/metadata/router/v3-meta-schemas.ts:293-304 → metadata-service.ts:1569-1573），
 * 按 total 自然翻页，不设硬上限。
 *
 * 本测试只断言 BFF 对内核的出参契约与本层行为，不触达真实网关
 * （构造方式照抄 tests/chat-memory-path.test.ts）。
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemoryRoutes } from '../src/panel/http/routes/chat-memory.js';
import { FetchKernelHttpAdapter } from '../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';

const AGENT_ID = 'agt-1';

interface InvokeEnvelope {
  code: number;
  message: string;
  request_id: string;
  data: unknown;
}

function okEnvelope(data: unknown): InvokeEnvelope {
  return { code: 0, message: 'ok', request_id: 'test-req', data };
}

interface ListCall {
  agent_id?: string;
  apply_visibility_filter?: boolean;
  touch_usage?: boolean;
  asset_types?: string[];
  limit?: number;
  offset?: number;
}

/**
 * @param total     内核侧该类资产总数
 * @param statuses  每个 asset 的 status（默认全 ready）
 */
function makeDeps(opts: { total: number; statuses?: (i: number) => string }) {
  const listCalls: ListCall[] = [];
  const total = opts.total;
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
        gateway_endpoint: 'http://core-test:2',
        api_key: 'core-key',
      }),
    },
    metaKernel: {
      invoke: vi.fn(async (action: string, params: Record<string, unknown>): Promise<InvokeEnvelope> => {
        if (action === 'auth/verify') {
          return okEnvelope({ valid: true, user: { user_id: 'u1', user_type: 'member' } });
        }
        if (action === 'agent/get') {
          return okEnvelope({ agent_id: AGENT_ID, owner_user_id: 'u1' });
        }
        if (action === 'agent-fixed-asset/list-with-detail') {
          const call = params as unknown as ListCall;
          listCalls.push(call);
          // 服务端按 asset_types 下推后的等价行为：只返回 chat_memory 且按 offset/limit 切片
          const limit = call.limit ?? 100;
          const offset = call.offset ?? 0;
          const items = [];
          for (let i = offset; i < Math.min(offset + limit, total); i += 1) {
            items.push({
              asset_id: `chat_memory-${i}`,
              asset_type: 'chat_memory',
              name: `mem-${i}`,
              // 故意让一部分落在 archived/deprecated/failed：BFF 仍应过滤（状态过滤保留）
              status: opts.statuses ? opts.statuses(i) : 'ready',
              visibility: 'private',
              created_at: '2026-10-01T00:00:00.000Z',
            });
          }
          return okEnvelope({ items, total });
        }
        if (action === 'asset/get') {
          return okEnvelope({
            asset_id: params.asset_id,
            asset_type: 'chat_memory',
            owner_user_id: 'u1',
            visibility: 'private',
            status: 'ready',
            updated_at: '2026-10-02T00:00:00.000Z',
          });
        }
        return okEnvelope(null);
      }),
    },
    kernelHttp: new FetchKernelHttpAdapter(),
    ingestProgressStore: { get: () => null },
  } as unknown as PanelDeps;
  return { deps, listCalls };
}

function buildApp(deps: PanelDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  registerChatMemoryRoutes(api, deps);
  app.route('/api/v1', api);
  return app;
}

async function callAgentFixed(deps: PanelDeps): Promise<Response> {
  const app = buildApp(deps);
  return app.request('/api/v1/chat-memory/agent-fixed', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'uk-1',
    },
    body: JSON.stringify({ agent_id: AGENT_ID }),
  });
}

describe('POST /chat-memory/agent-fixed 类型下推（#124-B1）', () => {
  it('首次调用即把 asset_types:["chat_memory"] 下推给内核，而不是拉全量后内存过滤', async () => {
    const { deps, listCalls } = makeDeps({ total: 1 });
    const res = await callAgentFixed(deps);
    expect(res.status).toBe(200);
    expect(listCalls.length).toBe(1);
    const first = listCalls[0];
    expect(first.asset_types).toEqual(['chat_memory']);
    expect(first.agent_id).toBe(AGENT_ID);
    // 展示策略：不过滤可见性、不写 usage（与改动前一致）
    expect(first.apply_visibility_filter).toBe(false);
    expect(first.touch_usage).toBe(false);
    const body = (await res.json()) as InvokeEnvelope;
    expect((body.data as { items: unknown[] }).items.length).toBe(1);
  });

  it('总数 520（>旧硬上限 500）时全部返回、按 total 翻页到收敛', async () => {
    const { deps, listCalls } = makeDeps({ total: 520 });
    const res = await callAgentFixed(deps);
    expect(res.status).toBe(200);

    const body = (await res.json()) as InvokeEnvelope;
    const items = (body.data as { items: unknown[] }).items;
    // 旧实现：第 6 次请求（offset=500）被 hard limit 截断 → 只拿到 500 条甚至 0 条
    expect(items.length).toBe(520);

    // 翻页：100/页，offset 递增到 500 后拿到 20 条即收敛（6 次）
    expect(listCalls.map((c) => c.offset)).toEqual([0, 100, 200, 300, 400, 500]);
    expect(listCalls.every((c) => c.limit === 100)).toBe(true);
    for (const c of listCalls) expect(c.asset_types).toEqual(['chat_memory']);
  });

  it('状态过滤保留：archived/deprecated/failed 仍被剔除', async () => {
    const { deps } = makeDeps({
      total: 10,
      statuses: (i) => ['ready', 'archived', 'deprecated', 'failed'][i % 4],
    });
    const res = await callAgentFixed(deps);
    const body = (await res.json()) as InvokeEnvelope;
    const items = (body.data as { items: unknown[] }).items;
    // 10 条里 index%4: 0 ready /1 archived /2 deprecated /3 failed → ready 只在 i=0,4,8
    expect(items.length).toBe(3);
    // 被剔除的 7 条不进后续 asset/get 补齐（省 7 次上游调用，也证明过滤发生在补齐之前）
    const invoke = deps.metaKernel.invoke as unknown as {
      mock: { calls: [string, unknown][] };
    };
    const assetGets = invoke.mock.calls.filter(([action]) => action === 'asset/get');
    expect(assetGets.length).toBe(3);
    const ids = assetGets.map(([, params]) => (params as { asset_id: string }).asset_id);
    expect(ids).toEqual(['chat_memory-0', 'chat_memory-4', 'chat_memory-8']);
  });
});
