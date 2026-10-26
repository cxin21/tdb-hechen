/**
 * B（2026-10-26 降调用量）· embedding 内容寻址缓存 RED 套件。
 *
 * 动机：Ark coding 端点的突发并发上限约 4~5 在飞，超了即 429 秒拒；
 * 而 L1 链条对同一 content 会 embed 三次（dedup 批量 → l1-writer → 相似搜索），
 * L0 重复提交同样命中。缓存在 provider 调用前把重复文本摘掉。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingService } from "../embedding.js";

interface FetchLog {
  calls: string[][];
}

function installFetch(log: FetchLog, opts?: { failTimes?: number; failStatus?: number }): void {
  let remainingFailures = opts?.failTimes ?? 0;
  const failStatus = opts?.failStatus ?? 429;
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[]; model: string };
    log.calls.push([...body.input]);
    if (remainingFailures > 0) {
      remainingFailures--;
      return new Response(JSON.stringify({ error: { code: "AccountRateLimitExceeded" } }), {
        status: failStatus,
        statusText: failStatus === 429 ? "Too Many Requests" : "Bad Request",
      });
    }
    return new Response(
      JSON.stringify({
        data: body.input.map((_t, i) => ({ index: i, embedding: [i + 1, 1, 0] })),
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
});

describe("OpenAIEmbeddingService 内容缓存（B 降调用量）", () => {
  it("同一批里的重复文本只发一次，结果按原顺序回填", async () => {
    const log: FetchLog = { calls: [] };
    installFetch(log);
    const svc = makeService();

    const out = await svc.embedBatch(["a", "b", "a"]);

    expect(log.calls).toEqual([["a", "b"]]);
    expect(out).toHaveLength(3);
    expect(Array.from(out[0])).toEqual(Array.from(out[2]));
    expect(Array.from(out[1])).not.toEqual(Array.from(out[0]));
  });

  it("第二次 embed 命中缓存，不再打 provider", async () => {
    const log: FetchLog = { calls: [] };
    installFetch(log);
    const svc = makeService();

    await svc.embedBatch(["a", "b"]);
    expect(log.calls).toHaveLength(1);

    const again = await svc.embed("a");
    expect(log.calls).toHaveLength(1);
    expect(Array.from(again)).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);

    const stats = svc.getCacheStats();
    expect(stats.size).toBe(2);
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });

  it("缓存条目按文本去重，不因重复写入而膨胀", async () => {
    const log: FetchLog = { calls: [] };
    installFetch(log);
    const svc = makeService();

    await svc.embed("same");
    await svc.embed("same");
    await svc.embed("same");

    expect(log.calls).toHaveLength(1);
    expect(svc.getCacheStats().size).toBe(1);
  });

  it("调用失败不写缓存：下一次仍会真正重试 provider", async () => {
    const log: FetchLog = { calls: [] };
    // 用不可重试的 4xx（429 现在会自动重试，见 embedding-429-retry.test.ts）
    installFetch(log, { failTimes: 1, failStatus: 400 });
    const svc = makeService();

    await expect(svc.embed("flaky")).rejects.toThrow(/HTTP 400/);
    expect(svc.getCacheStats().size).toBe(0);

    const ok = await svc.embed("flaky");
    expect(log.calls).toHaveLength(2);
    expect(ok).toHaveLength(3);
    expect(svc.getCacheStats().size).toBe(1);
  });
});
