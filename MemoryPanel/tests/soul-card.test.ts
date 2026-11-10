/**
 * S2（判据 12/14）：人格卡只读视图 BFF 路由测试 —— GET /api/v1/chat-memory/soul-card。
 *
 * 覆盖：
 *   ① 正常转发：GET 方法、三轴进 query、Authorization 与面板头齐备、无 body；
 *      出参逐字段收窄（labels 缺 act 即丢、sources 只留非空字符串）且卡文本**不截断**。
 *   ② 三轴缺省：不传/传空串/纯空白 → 一律 "default"（与内核 tenantOf 同口径）。
 *   ③ 内核 503 soul_card_unavailable → HTTP 503 且 message 原样，不折成 500。
 *   ④ 内核 checkAuth 的纯文本 401 → HTTP 401 原码透传（GET 通道辨认，不折 502）。
 *   ⑤ 上游 code=0 但没有 text → 503 soul_card_failed（不伪造成空卡）。
 *   ⑥ chars 缺失时用 text.length 兜底。
 *   ⑦ v13 元数据：schema="13" 与 blocks 九块（缺 id 的半截块丢弃）原样透传；
 *      旧上游没有 blocks 时回空数组、schema 不出现（前端按 legacy 来源行降级）。
 *
 * 构造方式照抄 tests/chat-memory-soul-versions.test.ts（真实 FetchKernelHttpAdapter +
 * mock globalThis.fetch）。注意本读面**不**做 team 成员门控，故 metaKernel.invoke 不会被触达。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemorySoulRoutes } from '../src/panel/http/routes/chat-memory-soul.js';
import { FetchKernelHttpAdapter } from '../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';

const CORE_BASE = 'http://core-test:2';
const CARD_PATH = '/api/v1/chat-memory/soul-card';

interface Envelope {
  code: number;
  message: string;
  request_id: string;
  data: unknown;
}

function makeDeps(): PanelDeps {
  const invoke = vi.fn(async () => ({
    code: 0,
    message: 'ok',
    request_id: 'test-req',
    data: null,
  }));
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

function mockKernelText(status: number, text: string) {
  fetchMock = vi.fn(async () => new Response(text, { status }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
}

async function call(deps: PanelDeps, query?: Record<string, string>): Promise<Response> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  return buildApp(deps).request(`${CARD_PATH}${qs}`, {
    method: 'GET',
    headers: {
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'uk-1',
    },
  });
}

/** 最近一次内核请求的 URL 与 init（GET 断言统一走这里）。 */
function lastKernelCall(): { url: URL; init: RequestInit } {
  const [rawUrl, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  return { url: new URL(rawUrl), init };
}

describe('GET /chat-memory/soul-card', () => {
  it('透传三轴并原样返回卡文本（GET、无 body、出参收窄）', async () => {
    const deps = makeDeps();
    const cardText = '[读法] 这张卡分三层：你设定的 / 推出来的 / 经历里长出来的。\n\n### 名称\n小满\n\n### 底线\n- 不替你做决定';
    mockKernelFetch({
      body: {
        code: 0,
        message: 'ok',
        data: {
          version: 7,
          hash: 'abcdef0123456789abcdef0123456789abcdef01',
          text: cardText,
          chars: 1234,
          labels: [
            { label: '严谨', act: 0.72 },
            { label: '直接', act: 0.4, gloss: '用户说过喜欢把话说透' },
            // 缺 act 的半截行必须被丢掉
            { label: '好奇' },
            { label: '', act: 0.5 },
          ],
          warnings: ['底色为空：没有达阈值的标签'],
          sources: {
            name: 'declared',
            traits: 'derived',
            human: 'observed',
            // 非字符串/空值不收
            bogus: 3,
            empty: '',
          },
          dirty: true,
          seeded: true,
          schema: '13',
          blocks: [
            {
              id: 'firstLook',
              title: '第一眼',
              chars: 24,
              source: 'declared',
              confidence: 'high',
              evidenceIds: [],
              warnings: [],
            },
            {
              id: 'us',
              title: '我们',
              chars: 88,
              source: 'structured',
              confidence: 'medium',
              evidenceIds: ['rel-1', 'ps-1'],
              warnings: ['person_unresolved:p_x'],
            },
            // 缺 id 的半截块必须被丢掉
            { title: '现在', source: 'absent' },
          ],
        },
      },
    });

    const res = await call(deps, { team: 't1', user: 'u1', agent: 'agt-1' });
    expect(res.status).toBe(200);

    const { url, init } = lastKernelCall();
    expect(url.origin + url.pathname).toBe(`${CORE_BASE}/v3/soul/card`);
    expect(url.searchParams.get('team')).toBe('t1');
    expect(url.searchParams.get('user')).toBe('u1');
    expect(url.searchParams.get('agent')).toBe('agt-1');
    expect(init.method).toBe('GET');
    // GET 不带 body，也不该带 Content-Type
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer core-key');
    expect(headers['Content-Type']).toBeUndefined();

    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(0);
    const data = env.data as Record<string, unknown>;
    // 卡文本逐字相同：BFF 不改写、不截断（卡本体自带 [读法] 段与 ### 区块）
    expect(data.text).toBe(cardText);
    expect(data.version).toBe(7);
    expect(data.hash).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(data.chars).toBe(1234);
    expect(data.dirty).toBe(true);
    expect(data.seeded).toBe(true);
    expect(data.warnings).toEqual(['底色为空：没有达阈值的标签']);
    expect(data.labels).toEqual([
      { label: '严谨', act: 0.72 },
      { label: '直接', act: 0.4, gloss: '用户说过喜欢把话说透' },
    ]);
    expect(data.sources).toEqual({ name: 'declared', traits: 'derived', human: 'observed' });
    expect(data.schema).toBe('13');
    expect(data.blocks).toEqual([
      {
        id: 'firstLook',
        title: '第一眼',
        chars: 24,
        source: 'declared',
        confidence: 'high',
        evidenceIds: [],
        warnings: [],
      },
      {
        id: 'us',
        title: '我们',
        chars: 88,
        source: 'structured',
        confidence: 'medium',
        evidenceIds: ['rel-1', 'ps-1'],
        warnings: ['person_unresolved:p_x'],
      },
    ]);
  });

  it('旧上游没有 schema/blocks 时降级：blocks 为空数组、schema 不出现', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { text: '卡', version: 3, hash: 'h', sources: { name: 'declared' } } } });
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    const data = ((await res.json()) as Envelope).data as Record<string, unknown>;
    expect(data.blocks).toEqual([]);
    expect('schema' in data).toBe(false);
    expect(data.sources).toEqual({ name: 'declared' });
  });

  it('长卡不截断：4500 字原样返回（与 soul-versions 的 4000 字截断策略不同）', async () => {
    const deps = makeDeps();
    const long = 'x'.repeat(4500);
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { text: long, version: 1, hash: 'h', chars: 4500 } } });
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as Envelope).data as Record<string, unknown>;
    expect((data.text as string).length).toBe(4500);
  });

  it('三轴缺省 / 空串 / 纯空白 → 全部 "default"（与内核 tenantOf 同口径）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { text: '', version: 0, hash: '' } } });
    await call(deps);
    let { url } = lastKernelCall();
    expect(url.searchParams.get('team')).toBe('default');
    expect(url.searchParams.get('user')).toBe('default');
    expect(url.searchParams.get('agent')).toBe('default');

    await call(deps, { team: '', user: '   ', agent: '  ' });
    ({ url } = lastKernelCall());
    expect(url.searchParams.get('team')).toBe('default');
    expect(url.searchParams.get('user')).toBe('default');
    expect(url.searchParams.get('agent')).toBe('default');
  });

  it('内核 503 soul_card_unavailable → HTTP 503 且 message 原样（不吞成 500）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ status: 503, body: { code: 503, message: 'soul_card_unavailable' } });
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    expect(res.status).toBe(503);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(503);
    expect(env.message).toBe('soul_card_unavailable');
    expect(env.data).toBeNull();
  });

  it('内核 checkAuth 的纯文本 401 → HTTP 401 原码透传（不折成 502）', async () => {
    const deps = makeDeps();
    mockKernelText(401, 'unauthorized');
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    expect(res.status).toBe(401);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(401);
    expect(env.message).toBe('unauthorized');
  });

  it('上游 code=0 但没有 text → 503 soul_card_failed（不伪造成空卡）', async () => {
    const deps = makeDeps();
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { version: 3, hash: 'h' } } });
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    expect(res.status).toBe(503);
    const env = (await res.json()) as Envelope;
    expect(env.code).toBe(503);
    expect(env.message).toBe('soul_card_failed');
  });

  it('chars 缺失时用 text.length 兜底', async () => {
    const deps = makeDeps();
    const text = '### 名称\nA';
    mockKernelFetch({ body: { code: 0, message: 'ok', data: { text, version: 1, hash: 'h' } } });
    const res = await call(deps, { team: 't1', agent: 'agt-1' });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as Envelope).data as Record<string, unknown>;
    expect(data.chars).toBe(text.length);
  });
});
