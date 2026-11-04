/**
 * 429 治理（2026-11-03）· 发车节流 + 字符预算 RED 套件。
 *
 * 生产实证（本轮 90 题基准灌库）：Ark coding 端点返 AccountRateLimitExceeded，
 * 同步 429、无 Retry-After；旧实现 400/800/1200ms 退避全部落在 ≥30–60s 惩罚窗内，
 * 于是「重试＝继续撞墙」，灌库 20/90 题即被限流拖死。
 *
 * 两条发车侧修法（缺省 0＝关，生产逐位现状不动）：
 * 1) embedding.paceMinIntervalMs：两发之间最小间隔；
 * 2) embedding.charsPerMinute：分钟级字符预算（实测 1.2M/min 稳、4.4M/min 必撞）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingPacer, OpenAIEmbeddingService } from "../embedding.js";

interface FetchLog {
  calls: Array<{ at: number; input: string[] }>;
}

function installFetch(log: FetchLog): void {
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[]; model: string };
    log.calls.push({ at: Date.now(), input: [...body.input] });
    return new Response(
      JSON.stringify({
        data: body.input.map((_t, idx) => ({ index: idx, embedding: [idx + 1, 2, 3] })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

function makeService(extra: { paceMinIntervalMs?: number; charsPerMinute?: number }): OpenAIEmbeddingService {
  return new OpenAIEmbeddingService({
    provider: "openai_compatible",
    baseUrl: "https://embedding.test/v1",
    apiKey: "test-key",
    model: "test-embedding",
    dimensions: 3,
    ...extra,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("EmbeddingPacer（纯记账）", () => {
  it("缺省全关：任何时刻、任何字符数都不等待（逐位现状）", () => {
    const pacer = new EmbeddingPacer({});
    pacer.charge(1_000, 5_000);
    expect(pacer.delayMs(1_000, 5_000)).toBe(0);
    expect(pacer.delayMs(1_000, 999_999)).toBe(0);
  });

  it("最小间隔：首发不等，第二发补足差额，过了间隔不等", () => {
    const pacer = new EmbeddingPacer({ paceMinIntervalMs: 500 });
    expect(pacer.delayMs(1_000, 10)).toBe(0);
    pacer.charge(1_000, 10);
    expect(pacer.delayMs(1_200, 10)).toBe(300);
    expect(pacer.delayMs(1_600, 10)).toBe(0);
  });

  it("字符预算：窗口内超额要等到下一分钟，窗口过期立即放行", () => {
    const pacer = new EmbeddingPacer({ charsPerMinute: 100 });
    pacer.charge(1_000, 60);
    // 窗口内还剩 40，30 字符放行
    expect(pacer.delayMs(2_000, 30)).toBe(0);
    // 50 字符超额 → 等到 1000+60000
    expect(pacer.delayMs(2_000, 50)).toBe(59_000);
    // 窗口已过期 → 立即放行
    expect(pacer.delayMs(61_000, 90)).toBe(0);
  });

  it("两种约束取较大者（间隔与预算同时生效）", () => {
    const pacer = new EmbeddingPacer({ paceMinIntervalMs: 500, charsPerMinute: 100 });
    pacer.charge(1_000, 80);
    // now=1000：间隔等 500，预算要等 60_000（扣除已等待的 500）→ 取大
    expect(pacer.delayMs(1_000, 50)).toBeGreaterThanOrEqual(59_000);
  });
});

describe("OpenAIEmbeddingService 发车节流（接入面）", () => {
  it("paceMinIntervalMs=120：两次外呼之间至少隔 110ms", async () => {
    const log: FetchLog = { calls: [] };
    installFetch(log);
    const svc = makeService({ paceMinIntervalMs: 120 });

    await svc.embed("text-a");
    await svc.embed("text-b");

    expect(log.calls).toHaveLength(2);
    expect(log.calls[1].at - log.calls[0].at).toBeGreaterThanOrEqual(110);
  });

  it("charsPerMinute=20：第二发 20 字符要等到下一分钟（假时钟）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const log: FetchLog = { calls: [] };
    installFetch(log);
    const svc = makeService({ charsPerMinute: 20 });

    const first = svc.embed("a".repeat(20));
    await vi.advanceTimersByTimeAsync(0);
    expect(log.calls).toHaveLength(1);
    await first;

    const second = svc.embed("b".repeat(20));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(log.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(log.calls).toHaveLength(2);
    await second;
  });
});
