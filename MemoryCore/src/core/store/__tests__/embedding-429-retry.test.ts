/**
 * A-lite（2026-10-26）· 429 有界重试 + 全局冷却 RED 套件。
 *
 * 生产实测（m02034–m02162）：Ark coding 端点的 429 是 43ms 内秒拒的突发限制，
 * 4rps 匀速 20/20 成功，而 150ms 内 3 发即全灭。单纯批量+缓存（B）挡不住突发，
 * 所以撞限后必须退避重试，并让后续调用一起排队等冷却。
 *
 * 2026-11-03 更新（用户授权）：实测惩罚窗 ≥30–60s，旧 400/800/1200ms 退避全落在窗内，
 * 重试只是继续撞墙。契约改为：上限 2→4 次、指数退避 1s/2s/4s/8s + 0–250ms 抖动、
 * 响应带 Retry-After 时以其为下界。
 *
 * 语义边界（不变）：只对 429 重试；4xx（非 429）/5xx/超时仍一次即抛，不拖长 recall 预算。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingService } from "../embedding.js";

interface FetchLog {
  /** 每次 provider 调用的时间戳（ms）+ 该次输入 */
  calls: Array<{ at: number; input: string[] }>;
}

function installFetch(log: FetchLog, statuses: number[], retryAfter?: string): void {
  let i = 0;
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[]; model: string };
    log.calls.push({ at: Date.now(), input: [...body.input] });
    const status = statuses[i++] ?? 200;
    if (status !== 200) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      // Ark coding 端点实测不带 Retry-After；这里只验证「若带则必须尊重」。
      if (status === 429 && retryAfter) headers["Retry-After"] = retryAfter;
      return new Response(JSON.stringify({ error: { code: "AccountRateLimitExceeded" } }), {
        status,
        statusText: status === 429 ? "Too Many Requests" : "Error",
        headers,
      });
    }
    return new Response(
      JSON.stringify({
        data: body.input.map((_t, idx) => ({ index: idx, embedding: [idx + 1, 2, 3] })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

function makeService(): OpenAIEmbeddingService {
  return new OpenAIEmbeddingService({
    provider: "openai_compatible",
    baseUrl: "https://embedding.test/v1",
    apiKey: "test-key",
    model: "test-embedding",
    dimensions: 3,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenAIEmbeddingService 429 重试与冷却（A-lite）", () => {
  it("一次 429 后自动重试成功：provider 被调 2 次，且确实等过退避", async () => {
    const log: FetchLog = { calls: [] };
    installFetch(log, [429, 200]);
    const svc = makeService();

    const started = Date.now();
    const vec = await svc.embed("bursty");
    const elapsed = Date.now() - started;

    expect(log.calls).toHaveLength(2);
    expect(vec).toHaveLength(3);
    // 指数退避首档 1s（+0–250ms 抖动）
    expect(elapsed).toBeGreaterThanOrEqual(950);
  }, 20000);

  it("连续 429 的重试有上限：共调 5 次后抛出，错误里保留 429", async () => {
    // 契约变更（2026-11-03 用户授权）：MAX_429_RETRIES 2→4（3 次→5 次）。
    // 依据：Ark 惩罚窗 ≥30–60s，3 次 400/800/1200ms 全落在窗内必全灭，重试形同虚设。
    vi.useFakeTimers();
    const log: FetchLog = { calls: [] };
    installFetch(log, [429, 429, 429, 429, 429]);
    const svc = makeService();

    const pending = expect(svc.embed("always-limited")).rejects.toThrow(/HTTP 429/);
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;
    expect(log.calls).toHaveLength(5);
    // 冷却在最后一次撞限后同样顺延，保护后续调用
    expect(svc.getCacheStats().size).toBe(0);
  }, 20000);

  it("退避指数增长（1s/2s/4s/8s，各含 0–250ms 抖动）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const log: FetchLog = { calls: [] };
    installFetch(log, [429, 429, 429, 429, 429]);
    const svc = makeService();

    const pending = expect(svc.embed("exponential")).rejects.toThrow(/HTTP 429/);
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;

    expect(log.calls).toHaveLength(5);
    const gaps = log.calls.slice(1).map((c, i) => c.at - log.calls[i].at);
    expect(gaps[0]).toBeGreaterThanOrEqual(1000);
    expect(gaps[1]).toBeGreaterThanOrEqual(2000);
    expect(gaps[2]).toBeGreaterThanOrEqual(4000);
    expect(gaps[3]).toBeGreaterThanOrEqual(8000);
  }, 20000);

  it("响应带 Retry-After 时以其为下界（不再只看指数退避）", async () => {
    const log: FetchLog = { calls: [] };
    installFetch(log, [429, 200], "2");
    const svc = makeService();

    const started = Date.now();
    await svc.embed("retry-after");
    expect(log.calls).toHaveLength(2);
    // Retry-After: 2 秒 > 指数退避 1s → 实际等待取 2s
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  }, 20000);

  it("撞限后的全局冷却会让并发进来的另一个调用一起排队", async () => {
    const log: FetchLog = { calls: [] };
    installFetch(log, [429, 200, 200]);
    const svc = makeService();

    // a 先吃 429 进入冷却；冷却期内发起 b —— b 必须排队，不能抢在窗口里打 provider
    const a = svc.embed("text-a");
    await new Promise((r) => setTimeout(r, 50));
    const b = svc.embed("text-b");
    const [va, vb] = await Promise.all([a, b]);
    expect(va).toHaveLength(3);
    expect(vb).toHaveLength(3);
    expect(log.calls).toHaveLength(3);

    // 后两次 provider 调用（a 的重试 + b 的首发）都不得早于冷却窗口
    const tails = log.calls.slice(1).map((c) => c.at - log.calls[0].at);
    expect(Math.min(...tails)).toBeGreaterThanOrEqual(950);
  }, 20000);

  it("非 429 的 4xx 一次即抛，不耗重试预算", async () => {
    const log: FetchLog = { calls: [] };
    installFetch(log, [400]);
    const svc = makeService();

    await expect(svc.embed("bad-request")).rejects.toThrow(/HTTP 400/);
    expect(log.calls).toHaveLength(1);
  });

  it("5xx 也一次即抛（保持旧语义，避免拖长 recall 预算）", async () => {
    const log: FetchLog = { calls: [] };
    installFetch(log, [500]);
    const svc = makeService();

    await expect(svc.embed("server-error")).rejects.toThrow(/HTTP 500/);
    expect(log.calls).toHaveLength(1);
  });
});