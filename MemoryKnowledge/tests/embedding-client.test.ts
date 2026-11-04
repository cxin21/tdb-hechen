import { test, expect, vi, afterEach } from "vitest";
import { getEmbeddingConfig, WikiEmbeddingClient } from "../src/engines/wiki/embedding-client.js";

test("getEmbeddingConfig returns null when incomplete", () => {
  expect(getEmbeddingConfig({})).toBeNull();
  expect(getEmbeddingConfig({ embedding: { baseUrl: "x" } })).toBeNull();
});

test("getEmbeddingConfig parses valid cfg", () => {
  const c = getEmbeddingConfig({ embedding: { baseUrl: "http://h:1", apiKey: "k", model: "m", dimensions: 4 } });
  expect(c?.dimensions).toBe(4);
});

test("WikiEmbeddingClient normalizes baseUrl trailing slash", () => {
  const c = new WikiEmbeddingClient({ provider: "x", baseUrl: "http://h:1/", apiKey: "k", model: "m", dimensions: 2 });
  expect((c as any).cfg.baseUrl).toBe("http://h:1");
});

// ── 2026-11-03（授权）：429 防护对齐记忆侧 ────────────────────────────────
// 病灶实证：2026-10-22 10:58:27 生产 tdai-knowledge 日志 [wiki-embed] HTTP 429 ×2 →
// "FAIL after 2 attempts" → 该次 /v3/wiki/search 降级纯 FTS。旧实现 = 1 次重试 + 固定
// 300ms，必然落在 Ark 账号级限流 ≥30–60s 的惩罚窗内，等于没有重试。

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.useRealTimers();
});

/** 造一个按序回放状态的 fetch，返回调用时间戳。 */
function installFetch(states: Array<{ status: number; retryAfter?: string }>, opts?: { throwOnce?: boolean }) {
  const calls: number[] = [];
  let thrown = false;
  globalThis.fetch = (async () => {
    calls.push(Date.now());
    if (opts?.throwOnce && !thrown) {
      thrown = true;
      throw new Error("ECONNRESET");
    }
    const spec = states[Math.min(calls.length - 1, states.length - 1)];
    if (spec.status === 200) {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    }
    const headers = new Headers();
    if (spec.retryAfter) headers.set("retry-after", spec.retryAfter);
    return new Response(JSON.stringify({ error: { code: "AccountRateLimitExceeded" } }), {
      status: spec.status,
      headers,
    });
  }) as typeof fetch;
  return calls;
}

function mk(extra: Partial<{ paceMinIntervalMs: number; charsPerMinute: number }> = {}) {
  return new WikiEmbeddingClient({
    provider: "x",
    baseUrl: "http://h:1",
    apiKey: "k",
    model: "m",
    dimensions: 2,
    ...extra,
  });
}

test("429 后自动重试成功：首轮退避 ≥1s（旧实现 300ms 必失败）", async () => {
  const calls = installFetch([{ status: 429 }, { status: 200 }]);
  const t0 = Date.now();
  const v = await mk().embed("你好");
  const dt = Date.now() - t0;
  expect(v.length).toBe(2);
  expect(calls.length).toBe(2);
  expect(dt).toBeGreaterThanOrEqual(950);
});

test("连续 429 耗尽：共 5 次尝试后抛错（旧实现只有 2 次）", async () => {
  vi.useFakeTimers();
  const calls = installFetch([{ status: 429 }]);
  const p = mk().embed("x");
  const guarded = expect(p).rejects.toThrow(/429/);
  await vi.advanceTimersByTimeAsync(60_000);
  await guarded;
  expect(calls.length).toBe(5);
});

test("响应带 Retry-After 时以其为下界（2s > 首轮 1s）", async () => {
  vi.useFakeTimers();
  const calls = installFetch([{ status: 429, retryAfter: "2" }, { status: 200 }]);
  const p = mk().embed("x");
  await vi.advanceTimersByTimeAsync(10_000);
  const v = await p;
  expect(v.length).toBe(2);
  expect(calls.length).toBe(2);
  // 用两次调用的真实间隔判定（Date.now 在假时钟下被推进到 10s，不能作证据）
  expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(1_900);
});

test("非 429 的 4xx 立即失败，不做重试", async () => {
  const calls = installFetch([{ status: 400 }]);
  await expect(mk().embed("x")).rejects.toThrow(/400/);
  expect(calls.length).toBe(1);
});

test("网络错误保留轻量重试（一次，300ms 后重来）", async () => {
  vi.useFakeTimers();
  const calls = installFetch([{ status: 200 }], { throwOnce: true });
  const t0 = Date.now();
  const p = mk().embed("x");
  await vi.advanceTimersByTimeAsync(1_000);
  const v = await p;
  expect(v.length).toBe(2);
  expect(calls.length).toBe(2);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
});

test("paceMinIntervalMs 生效：连续两次 embed 至少间隔配置值", async () => {
  vi.useFakeTimers();
  const calls = installFetch([{ status: 200 }]);
  const c = mk({ paceMinIntervalMs: 300 });
  const p1 = c.embed("a");
  await vi.advanceTimersByTimeAsync(0);
  await p1;
  const p2 = c.embed("b");
  await vi.advanceTimersByTimeAsync(500);
  await p2;
  expect(calls.length).toBe(2);
  expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(290);
});

test("charsPerMinute 生效：超出字符预算要等到下一个 60s 窗口", async () => {
  vi.useFakeTimers();
  const calls = installFetch([{ status: 200 }]);
  const c = mk({ charsPerMinute: 1_000 });
  const text = "x".repeat(600); // 600 字符 ×2 > 1000 预算（clamp 下限 1000，见 config 解析）
  const p1 = c.embed(text);
  await vi.advanceTimersByTimeAsync(0);
  await p1;
  const p2 = c.embed(text);
  await vi.advanceTimersByTimeAsync(70_000);
  await p2;
  expect(calls.length).toBe(2);
  expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(59_000);
});
