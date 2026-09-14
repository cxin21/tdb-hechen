/**
 * U-A2（DS-PANEL-UI-VISUAL-001 §2 S1 / 计划批 1）：记忆卡片增强——数据层核对产出。
 *
 * S1 卡片要显示 soul 字段（valence 双色条 / coreRef chips / 🔥recall / significance），
 * 前提是 BFF 列表接口把 soul 8 字段 + metadata 透传出来：
 *   - POST /chat-memory/layer L1：已透传（896ee5d，见 chat-memory-archive.test.ts）✅ 核对通过
 *   - POST /chat-memory/search L1：本测试落点 —— 核对发现映射丢弃 soul 字段与 metadata，
 *     搜索召回的卡片因此无法与浏览卡片一致显示灵魂区 → 照 layer L1 同形补透传。
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

function makeDeps(): { deps: PanelDeps } {
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
          return okEnvelope({ valid: true, user: { user_id: 'u1', user_type: 'member' } });
        }
        if (action === 'asset/get') {
          return okEnvelope({
            asset_id: BLOCK_ID,
            team_id: 't1',
            asset_type: 'chat_memory',
            name: 'mem',
            owner_user_id: 'u1',
            visibility: 'private',
            status: 'ready',
          });
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
  return app.request('/api/v1/chat-memory/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'uk-1',
    },
    body: JSON.stringify(body),
  });
}

// ── POST /chat-memory/search L1：soul 8 字段 + metadata 透传（S1 卡片数据前提）──

describe('POST /chat-memory/search L1 soul 透传', () => {
  it('L1 命中项带顶层 soul 字段 + metadata（与 /chat-memory/layer L1 同形）', async () => {
    const { deps } = makeDeps();
    const metadata = { coreRefs: ['correctness'], recall_count: 2, last_recalled_at: '2026-09-09T00:00:00Z' };
    mockKernelFetch({
      body: {
        code: 0,
        message: 'ok',
        data: {
          items: [
            {
              record_id: 'r1',
              type: 'fact',
              content: '内容',
              score: 0.87,
              created_at: '2026-09-10T00:00:00Z',
              occurred_at: '2026-09-10T06:30:00Z',
              valid_start: '2026-09-01T00:00:00Z',
              valid_end: '2026-10-01T00:00:00Z',
              certainty: 'inferred',
              source: 'distill',
              valence: 0.8,
              arousal: 0.5,
              significance: 0.9,
              metadata,
            },
          ],
        },
      },
    });
    const res = await call(deps, { block_id: BLOCK_ID, layer: 'L1', query: '内容' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeEnvelope;
    const items = (body.data as { items: Array<Record<string, unknown>> }).items;
    expect(items[0].occurred_at).toBe('2026-09-10T06:30:00Z');
    expect(items[0].valid_start).toBe('2026-09-01T00:00:00Z');
    expect(items[0].valid_end).toBe('2026-10-01T00:00:00Z');
    expect(items[0].certainty).toBe('inferred');
    expect(items[0].source).toBe('distill');
    expect(items[0].valence).toBe(0.8);
    expect(items[0].arousal).toBe(0.5);
    expect(items[0].significance).toBe(0.9);
    expect(items[0].metadata).toEqual(metadata);
    expect(items[0].score).toBe(0.87);
  });
});
