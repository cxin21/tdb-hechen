/**
 * task-3（P0-b）：灵魂快照版本链 BFF 路由测试。
 *
 * 覆盖 POST /api/v1/chat-memory/soul-versions → 内核 /v3/soul/introspect：
 *   ① 正常透传 + 出参收窄（payload_json 永不出圈；旧快照字段不补造）
 *   ② 内核 503 信封 → HTTP 503 且保留后端 message
 *   ③ tenant 轴来自 Header（caller），body 里的 userId/user_id 不得覆盖
 *   ④ 门控：缺 team_id → 400；非团队成员 → 403
 *   ⑤ snapshotLimit 夹取 1..200，缺省不发送（交给内核默认 20）
 *
 * 构造方式照抄 tests/chat-memory-values.test.ts（真实 FetchKernelHttpAdapter +
 * mock globalThis.fetch）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemorySoulRoutes } from '../src/panel/http/routes/chat-memory-soul.js';
import { FetchKernelHttpAdapter } from '../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';

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

function makeDeps(opts?: { callerUserId?: string; teamMember?: boolean }): PanelDeps {
  const callerUserId = opts?.callerUserId ?? 'u1';
  const teamMember = opts?.teamMember ?? true;
  const invoke = vi.fn(async (action: string): Promise<InvokeEnvelope> => {
    if (action === 'auth/verify') {
      return okEnvelope({ valid: true, user: { user_id: callerUserId, user_type: 'member' } });
    }
    if (action === 'team-member/get') {
      return teamMember ? okEnvelope({ team_id: 't1', user_id: callerUserId }) : okEnvelope(null);
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
  } as unknown as PanelDeps;
}

function buildApp(deps: PanelDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  registerChatMemorySoulRoutes(api, deps);
  app.route('/api/v1', api);
  return app;
}

let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.restoreAllMocks();
});

function mockKernelFetch(payload: { status?: number; body: unknown }) {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload.body), {
        status: payload.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
}

async function call(deps: PanelDeps, body: unknown): Promise<Response> {
  return buildApp(deps).request('/api/v1/chat-memory/soul-versions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'uk-1',
    },
    body: JSON.stringify(body),
  });
}

async function lastKernelBody(): Promise<Record<string, unknown>> {
  const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  expect(url).toBe(`${CORE_BASE}/v3/soul/introspect`);
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('POST /chat-memory/soul-versions', () => {
  it('透传 tenant 轴并收窄出参：payload_json 不出圈、旧快照不补造版本字段', async () => {
    const deps = makeDeps();
    mockKernelFetch({
      body: {
        code: 0,
        message: 'ok',
        data: {
          rendered: '灵魂全文\n- 我是谁：稳',
          soulVersion: 'soul-v-9',
          snapshots: [
            // 旧快照：库里还没有 version/parent_hash/reason_detail/slots_json 列
            { ts: '2026-11-01T00:00:00.000Z', content_hash: 'deadbeef', trigger: 'render' },
            // 新快照：四列已就位
            {
              ts: '2026-11-02T00:00:00.000Z',
              content_hash: 'cafe1234',
              trigger: 'core-values',
              version: 2,
              parentHash: 'deadbeef',
              reasonCode: 'core-values',
              reasonDetail: '采纳 core_value 提案',
              diff: { addedLines: 3, removedLines: 1 },
              slotDiff: { added: 1, removed: 0, changed: 2, summary: '+1 slot:user / ~2' },
            },
          ],
          probes: null,
          orphanAnchors: [],
          evidenceWindowHours: 168,
          notes: ['probes-skipped: 未传探针'],
        },
      },
    });

    const res = await call(deps, { team_id: 't1', agent_id: 'agt-1' });
    expect(res.status).toBe(200);
    const sent = await lastKernelBody();
    expect(sent.teamId).toBe('t1');
    expect(sent.agentId).toBe('agt-1');
    expect(sent.userId).toBe('u1');
    expect('snapshotLimit' in sent).toBe(false);

    const env = (await res.json()) as InvokeEnvelope;
    expect(env.code).toBe(0);
    const data = env.data as Record<string, unknown>;
    expect(data.soulVersion).toBe('soul-v-9');
    expect(data.rendered).toBe('灵魂全文\n- 我是谁：稳');
    expect(data.renderedTruncated).toBe(false);
    expect(data.notes).toEqual(['probes-skipped: 未传探针']);

    const versions = data.versions as Array<Record<string, unknown>>;
    expect(versions).toHaveLength(2);
    // 旧行：只有三件套，不编造版本号
    expect(versions[0]).toEqual({
      at: '2026-11-01T00:00:00.000Z',
      hash: 'deadbeef',
      trigger: 'render',
    });
    // 新行：版本链字段逐项映射（content_hash→hash、diff→lineDiff）
    expect(versions[1]).toEqual({
      at: '2026-11-02T00:00:00.000Z',
      hash: 'cafe1234',
      trigger: 'core-values',
      version: 2,
      parentHash: 'deadbeef',
      reasonCode: 'core-values',
      reasonDetail: '采纳 core_value 提案',
      lineDiff: { added: 3, removed: 1 },
      slotDiff: { added: 1, removed: 0, changed: 2, summary: '+1 slot:user / ~2' },
    });
    // 不透传 payload_json（即便内核某天把它塞进来）
    expect(JSON.stringify(env)).not.toContain('payload_json');
  });

  it('rendered 超长时截断并注明（不静默丢内容）', async () => {
    const deps = makeDeps();
    const long = 'x'.repeat(5000);
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { rendered: long, snapshots: [], notes: [] } } });
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-1' });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as InvokeEnvelope).data as Record<string, unknown>;
    expect((data.rendered as string).length).toBe(4000);
    expect(data.renderedTruncated).toBe(true);
    expect((data.notes as string[]).some((n) => n.startsWith('rendered-truncated:'))).toBe(true);
  });

  it('内核 503 信封 → HTTP 503 并保留后端 message', async () => {
    const deps = makeDeps();
    mockKernelFetch({ status: 503, body: { code: 503, message: 'soul_introspect_failed' } });
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-1' });
    expect(res.status).toBe(503);
    const env = (await res.json()) as InvokeEnvelope;
    expect(env.code).toBe(503);
    expect(env.message).toBe('soul_introspect_failed');
    expect(env.data).toBeNull();
  });

  it('上联不可达（无效信封）→ 502 语义，不伪装成空版本链', async () => {
    const deps = makeDeps();
    fetchMock = vi.fn(async () => new Response('oops', { status: 500 }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-1' });
    expect(res.status).toBe(502);
    const env = (await res.json()) as InvokeEnvelope;
    expect(env.code).toBe(502);
    expect(env.data).toBeNull();
  });

  it('tenant 轴只认 Header：body 里的 userId/user_id 不得覆盖 caller', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { rendered: '', snapshots: [], notes: [] } } });
    await call(deps, { team_id: 't1', agent_id: 'agt-1', userId: 'u-evil', user_id: 'u-evil' });
    const sent = await lastKernelBody();
    expect(sent.userId).toBe('u1');
    expect(sent.user_id).toBeUndefined();
  });

  it('缺 team_id → 400 且不触达内核', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: {} } });
    const res = await call(deps, { agent_id: 'agt-1' });
    expect(res.status).toBe(400);
    const env = (await res.json()) as InvokeEnvelope;
    expect(env.message).toBe('MISSING_TEAM_ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非团队成员 → 403 且不触达内核', async () => {
    const deps = makeDeps({ teamMember: false });
    mockKernelFetch({ body: { code: 0, message: 'ok', data: {} } });
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-1' });
    expect(res.status).toBe(403);
    const env = (await res.json()) as InvokeEnvelope;
    expect(env.message).toBe('NOT_TEAM_MEMBER');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('snapshotLimit 夹取到 1..200（0→1，500→200）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { rendered: '', snapshots: [], notes: [] } } });
    await call(deps, { team_id: 't1', agent_id: 'agt-1', snapshotLimit: 500 });
    expect((await lastKernelBody()).snapshotLimit).toBe(200);
    await call(deps, { team_id: 't1', agent_id: 'agt-1', snapshotLimit: 0 });
    expect((await lastKernelBody()).snapshotLimit).toBe(1);
  });
});
