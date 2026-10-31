/**
 * 红队 2026-11-01 §MEDIUM-无任何限速（task-59 ②）。
 *
 * 缺陷复盘（scratch/probe-red/results-02.json P3.1）：
 *   /v3/meta/auth/verify 20 连发假 key 全 200、均 1ms、零延迟零锁定。
 *   历史账号 user-key 只有 4–7 个字符（= 用户名），可离线穷举 —— 限速是这一层的
 *   唯一防线，所以必须证明两件事：① 突发真的被拦；② 正常流量不被误伤。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimit, takeToken, type RateLimitOptions } from '../src/panel/http/middleware/rate-limit.js';
import { buildPanelApp } from '../src/panel/http/app.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';

interface Bucket {
  count: number;
  resetAt: number;
}

function buildApp(options: RateLimitOptions) {
  const app = new Hono();
  app.use('/api/*', rateLimit(options));
  app.post('/api/echo', (c) => c.json({ code: 0, message: 'ok', request_id: 't', data: null }));
  app.get('/api/echo', (c) => c.json({ code: 0, message: 'ok', request_id: 't', data: null }));
  return app;
}

function call(
  app: Hono,
  opts: { userKey?: string; path?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.userKey) headers['x-tdai-user-key'] = opts.userKey;
  return Promise.resolve(
    app.request(opts.path ?? '/api/echo', { method: 'POST', headers }),
  );
}

// ── 纯函数层：takeToken ───────────────────────────────────────────────

describe('takeToken（固定窗口计数）', () => {
  it('窗口内放行到上限，第 max+1 次拒绝', () => {
    const buckets = new Map<string, Bucket>();
    const rule = { max: 3, windowMs: 1000 };
    expect(takeToken(buckets, 'k', rule, 0).allowed).toBe(true);
    expect(takeToken(buckets, 'k', rule, 1).allowed).toBe(true);
    expect(takeToken(buckets, 'k', rule, 2).allowed).toBe(true);
    const denied = takeToken(buckets, 'k', rule, 3);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(1);
  });

  it('被拒的请求不计数（不会把自己的窗口越推越远）', () => {
    const buckets = new Map<string, Bucket>();
    const rule = { max: 1, windowMs: 1000 };
    takeToken(buckets, 'k', rule, 0);
    for (let i = 1; i < 10; i += 1) {
      expect(takeToken(buckets, 'k', rule, i).allowed).toBe(false);
    }
    // 原窗口到期后立刻恢复，没有因为 9 次被拒而延长
    const after = takeToken(buckets, 'k', rule, 1000);
    expect(after.allowed).toBe(true);
  });

  it('retryAfterSec 按剩余窗口向上取整、至少 1 秒', () => {
    const buckets = new Map<string, Bucket>();
    const rule = { max: 1, windowMs: 10_000 };
    takeToken(buckets, 'k', rule, 0);
    expect(takeToken(buckets, 'k', rule, 1).retryAfterSec).toBe(10);
    expect(takeToken(buckets, 'k', rule, 9_500).retryAfterSec).toBe(1);
    expect(takeToken(buckets, 'k', rule, 9_999).retryAfterSec).toBe(1);
  });
});

// ── 中间件层 ──────────────────────────────────────────────────────────

describe('rateLimit 中间件', () => {
  it('正常流量不被误伤：限额内全部 200', async () => {
    let now = 0;
    const app = buildApp({
      key: { max: 5, windowMs: 60_000 },
      ip: false,
      now: () => now,
    });
    for (let i = 0; i < 5; i += 1) {
      const res = await call(app, { userKey: 'uk-1' });
      expect(res.status).toBe(200);
      now += 100;
    }
  });

  it('突发被拦：超限返 429 + Retry-After，且不再进入业务路由', async () => {
    let now = 0;
    const app = buildApp({
      key: { max: 2, windowMs: 60_000 },
      ip: false,
      now: () => now,
    });
    expect((await call(app, { userKey: 'uk-1' })).status).toBe(200);
    expect((await call(app, { userKey: 'uk-1' })).status).toBe(200);
    const blocked = await call(app, { userKey: 'uk-1' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    const body = (await blocked.json()) as Record<string, unknown>;
    expect(body.code).toBe(429);
    expect(body.message).toBe('RATE_LIMITED');
  });

  it('窗口滚动后恢复配额', async () => {
    let now = 0;
    const app = buildApp({
      key: { max: 1, windowMs: 60_000 },
      ip: false,
      now: () => now,
    });
    expect((await call(app, { userKey: 'uk-1' })).status).toBe(200);
    expect((await call(app, { userKey: 'uk-1' })).status).toBe(429);
    now = 60_000;
    expect((await call(app, { userKey: 'uk-1' })).status).toBe(200);
  });

  it('不同 key 各自独立计量（不互相牵连）', async () => {
    let now = 0;
    const app = buildApp({
      key: { max: 1, windowMs: 60_000 },
      ip: false,
      now: () => now,
    });
    expect((await call(app, { userKey: 'uk-a' })).status).toBe(200);
    expect((await call(app, { userKey: 'uk-b' })).status).toBe(200);
    expect((await call(app, { userKey: 'uk-a' })).status).toBe(429);
  });

  it('IP 维度挡住「换 key 爆破」：同一个 IP 换着 key 打也会被拦', async () => {
    let now = 0;
    const app = buildApp({
      key: { max: 1000, windowMs: 60_000 },
      ip: { max: 3, windowMs: 60_000 },
      now: () => now,
      // 模拟 LAN 客户端地址（默认实现见不到真实 socket 时返回 undefined）
      clientIp: () => '10.4.100.50',
    });
    for (let i = 0; i < 3; i += 1) {
      expect((await call(app, { userKey: `fake-${i}` })).status).toBe(200);
    }
    const blocked = await call(app, { userKey: 'fake-3' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
  });

  it('回环地址不参与 IP 限速（避免本机操作替攻击者背锅）', async () => {
    let now = 0;
    const app = buildApp({
      key: false,
      ip: { max: 1, windowMs: 60_000 },
      now: () => now,
      // 默认实现：127.0.0.1 / ::1 / 取不到地址 → undefined
      clientIp: () => undefined,
    });
    for (let i = 0; i < 10; i += 1) {
      expect((await call(app, { userKey: `k${i}` })).status).toBe(200);
    }
  });

  it('无 user-key 的请求不参与 key 维度（缺 key 由鉴权层返 400/401）', async () => {
    let now = 0;
    const app = buildApp({
      key: { max: 1, windowMs: 60_000 },
      ip: false,
      now: () => now,
    });
    for (let i = 0; i < 5; i += 1) {
      expect((await call(app)).status).toBe(200);
    }
  });

  it('接线确认：buildPanelApp 缺省挂上限速，rateLimit:false 可关', async () => {
    const deps = {
      config: {
        ui: { distDir: 'tests' },
        knowledge: { baseUrl: 'http://ks-test:1', authToken: 'k', timeoutMs: 1000 },
        llmProvider: { proxyBaseUrl: 'http://proxy-test:3' },
        metadataRemoteTimeoutMs: 1000,
      },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      },
      instanceRegistry: {
        resolve: () => ({ instance_id: 'inst-1', gateway_endpoint: 'http://core:2', api_key: 'k' }),
        listPublic: () => [{ instance_id: 'inst-1' }],
      },
      metaKernel: { invoke: async () => ({ code: 0, message: 'ok', request_id: 't', data: null }) },
      kernelHttp: { postEnvelope: async () => ({ code: 0, message: 'ok', request_id: 't', data: null }) },
      ingestProgressStore: { get: () => null },
    } as unknown as PanelDeps;

    const app = buildPanelApp(deps, {
      rateLimit: { key: { max: 2, windowMs: 60_000 }, ip: false },
    });
    const hit = () => app.request('/api/v1/meta/instances', { headers: { 'x-tdai-user-key': 'uk-1' } });
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    const blocked = await hit();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    // 换 key 不受牵连（各 key 独立桶）
    const otherKey = await app.request('/api/v1/meta/instances', {
      headers: { 'x-tdai-user-key': 'uk-2' },
    });
    expect(otherKey.status).toBe(200);

    const off = buildPanelApp(deps, { rateLimit: false });
    for (let i = 0; i < 3; i += 1) {
      const res = await off.request('/api/v1/meta/instances', { headers: { 'x-tdai-user-key': 'uk-1' } });
      expect(res.status).toBe(200);
    }
  });

  it('非 /api/* 路径不受影响（健康检查与静态资源不烧配额）', async () => {
    let now = 0;
    const app = buildApp({
      key: { max: 1, windowMs: 60_000 },
      ip: false,
      now: () => now,
    });
    (app as unknown as { get: (p: string, h: (c: unknown) => unknown) => void }).get('/health', (c) =>
      (c as { json: (b: unknown) => unknown }).json({ ok: true }),
    );
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
    }
  });
});
