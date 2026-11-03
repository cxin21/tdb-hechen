/**
 * F3（2026-11-02）：embedding 分批上限改为实例参数 + "input limit exceeded" 400 折半重试。
 *
 * 病灶：MAX_BATCH_SIZE 硬编码 256，而生产 ark doubao-embedding-vision 端点 input 上限 10
 * （15 条即 HTTP 400 "Embeddings API input limit exceeded: max 10, got 15"）→ L1 dedup 整批
 * embedding 失败 → 调用方降级 FTS → 前置门槛 prefilter 恒空转（生产 prefiltered 恒 0）。
 *
 * 合同：
 *  - config.embedding.maxBatchSize（缺省 256，clamp 1..2048）决定单批条数；
 *  - 400 且报文含 "input limit exceeded" → chunk>1 折半各发一次（递归可再拆），chunk=1 仍失败原样抛；
 *  - 其余 4xx / 5xx / 超时：一次即抛，不折半（保持旧语义）；
 *  - L0 单条 embed 与 dedup 批量 embedBatch 共用同一条分批路径（同一累加/顺序保证）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingService } from "../embedding.js";
import { batchDedup } from "../../record/l1-dedup.js";
import type { IMemoryStore } from "../types.js";
import type { LLMRunner } from "../../types.js";

interface Call {
  input: string[];
  ok: boolean;
}

/** 装 fetch：limit 之内成功（向量首分量 = 文本编号），超 limit 返回 400 input-limit。 */
function installFetch(calls: Call[], opts: { limit?: number; failStatus?: number; failBody?: string } = {}): void {
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] };
    const input = [...body.input];
    const overLimit = opts.limit !== undefined && input.length > opts.limit;
    if (opts.failStatus !== undefined) {
      calls.push({ input, ok: false });
      return new Response(opts.failBody ?? "upstream error", {
        status: opts.failStatus,
        statusText: "Error",
      });
    }
    if (overLimit) {
      calls.push({ input, ok: false });
      return new Response(
        `{"error":{"message":"Embeddings API input limit exceeded: max ${opts.limit}, got ${input.length}"}}`,
        { status: 400, statusText: "Bad Request" },
      );
    }
    calls.push({ input, ok: true });
    return new Response(
      JSON.stringify({
        data: input.map((t, idx) => ({ index: idx, embedding: [Number(t.replace(/^t/, "")), 0, 1] })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

function makeService(maxBatchSize?: number): OpenAIEmbeddingService {
  return new OpenAIEmbeddingService({
    provider: "openai_compatible",
    baseUrl: "https://embedding.test/v1",
    apiKey: "test-key",
    model: "doubao-embedding-vision",
    dimensions: 3,
    ...(maxBatchSize === undefined ? {} : { maxBatchSize }),
  });
}

const texts = (n: number): string[] => Array.from({ length: n }, (_v, i) => `t${i}`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("F3 maxBatchSize 实例参数", () => {
  it("maxBatchSize=10 且 15 条输入 → 恰好两次请求（10 + 5），结果顺序不错位", async () => {
    const calls: Call[] = [];
    installFetch(calls);
    const svc = makeService(10);

    const out = await svc.embedBatch(texts(15));

    expect(calls.map((c) => c.input.length)).toEqual([10, 5]);
    expect(out).toHaveLength(15);
    expect(out.map((v) => Math.round(v[0] / v[2]))).toEqual([...Array(15).keys()]);
  });

  it("maxBatchSize 缺省 = 256（逐位现状）：15 条仍单批一次", async () => {
    const calls: Call[] = [];
    installFetch(calls);
    const svc = makeService();

    const out = await svc.embedBatch(texts(15));

    expect(calls.map((c) => c.input.length)).toEqual([15]);
    expect(out).toHaveLength(15);
  });

  it("maxBatchSize 下界 clamp 到 1：0 视为逐条", async () => {
    const calls: Call[] = [];
    installFetch(calls);
    const svc = makeService(0);

    const out = await svc.embedBatch(texts(3));

    expect(calls.map((c) => c.input.length)).toEqual([1, 1, 1]);
    expect(out.map((v) => Math.round(v[0] / v[2]))).toEqual([0, 1, 2]);
  });
});

describe("F3 input limit exceeded 折半重试", () => {
  it("上限 10 而单批 15 → 15 失败后折半成 8+7，共 3 次请求且全部成功", async () => {
    const calls: Call[] = [];
    installFetch(calls, { limit: 10 });
    const svc = makeService(); // 缺省 256：先按 15 发，撞 400 再折半

    const out = await svc.embedBatch(texts(15));

    expect(calls.map((c) => c.input.length)).toEqual([15, 8, 7]);
    expect(calls.map((c) => c.ok)).toEqual([false, true, true]);
    expect(out).toHaveLength(15);
    expect(out.map((v) => Math.round(v[0] / v[2]))).toEqual([...Array(15).keys()]);
  });

  it("上限 5 → 递归折半直到每条都 ≤5（不重排、不丢条）", async () => {
    const calls: Call[] = [];
    installFetch(calls, { limit: 5 });
    const svc = makeService();

    const out = await svc.embedBatch(texts(15));

    expect(out).toHaveLength(15);
    expect(out.map((v) => Math.round(v[0] / v[2]))).toEqual([...Array(15).keys()]);
    // 成功批一律 ≤5；失败批只在超限时出现
    for (const c of calls) {
      if (c.ok) expect(c.input.length).toBeLessThanOrEqual(5);
      else expect(c.input.length).toBeGreaterThan(5);
    }
    expect(calls.filter((c) => c.ok).length).toBeGreaterThanOrEqual(4);
  });

  it("chunk=1 仍报 input limit exceeded → 原样抛出（不无限递归）", async () => {
    const calls: Call[] = [];
    installFetch(calls, { limit: 0 });
    const svc = makeService(1);

    await expect(svc.embedBatch(["t0"])).rejects.toThrow(/input limit exceeded/);
    expect(calls).toHaveLength(1);
  });

  it("非 400（500）不折半：一次即抛", async () => {
    const calls: Call[] = [];
    installFetch(calls, { failStatus: 500, failBody: "boom" });
    const svc = makeService();

    await expect(svc.embedBatch(texts(15))).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(1);
  });

  it("400 但报文不含 input limit exceeded（如模型名错）不折半：一次即抛", async () => {
    const calls: Call[] = [];
    installFetch(calls, { failStatus: 400, failBody: '{"error":{"message":"model not found"}}' });
    const svc = makeService();

    await expect(svc.embedBatch(texts(15))).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
  });
});

describe("F3 L0 与 dedup 共用同一分批路径", () => {
  const row = (record_id: string) => ({
    record_id,
    content: "旧记忆",
    type: "episodic",
    priority: 60,
    scene_name: "情境",
    timestamp_str: "2026-01-01T00:00:00.000Z",
    session_key: "",
    session_id: "",
    score: 0.2,
  });

  it("dedup 15 条新记忆经同一 service → 两次请求（10 + 5）", async () => {
    const calls: Call[] = [];
    installFetch(calls);
    const svc = makeService(10);
    const memories = texts(15).map((t, i) => ({
      record_id: `n${i}`,
      content: t,
      type: "episodic" as const,
      priority: 70,
      source_message_ids: [] as string[],
      metadata: {},
      scene_name: "情境",
    }));
    const vectorStore = {
      countL1VectorRows: async () => 3,
      countL1: async () => 3,
      isFtsAvailable: () => false,
      searchL1Vector: async () => [row("old1")],
    } as unknown as IMemoryStore;
    const llmRunner = { run: async () => "[]" } as unknown as LLMRunner;

    await batchDedup({ memories, vectorStore, embeddingService: svc, llmRunner });

    expect(calls.map((c) => c.input.length)).toEqual([10, 5]);
  });

  it("L0 单条 embed（逐条路径）同样走该 service：1 条 = 1 次请求", async () => {
    const calls: Call[] = [];
    installFetch(calls);
    const svc = makeService(10);

    const vec = await svc.embed("t7");

    expect(calls.map((c) => c.input.length)).toEqual([1]);
    expect(vec).toHaveLength(3);
  });
});
