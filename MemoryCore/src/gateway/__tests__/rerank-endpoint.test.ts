/**
 * POST /v1/rerank 核心逻辑合同测试（HTTP 无关，纯函数层）。
 *
 * 背景（2026-10-16 wiki 召回重排 R1）：core 以 HTTP 暴露 rerank 资源给 KS；
 * 线协议与云端 rerank adapter 同形（query/documents/top_n → results 降序）。
 * 合同要点：
 *   - 200 { results: [{index, score}] }——index=入参原始下标、score 降序、防御性整形
 *   - 400 请求体校验（query/documents/top_n 与限额）
 *   - 503 不可用（未配置 / provider 降级 null / 调用抛错 / 外层超时）
 *   - 永不 500（provider 异常坍缩 503，调用方降级原序）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleRerankCore,
  normalizeRerankResults,
  RERANK_LIMITS,
  type RerankCoreDeps,
} from "../rerank-endpoint.js";
import type { MemoryReranker } from "../../core/recall/rerank/types.js";

function fakeReranker(
  impl: (query: string, docs: string[]) => Promise<{ index: number; score: number }[] | null>,
): MemoryReranker & { rerank: ReturnType<typeof vi.fn> } {
  return { rerank: vi.fn(impl) } as unknown as MemoryReranker & { rerank: ReturnType<typeof vi.fn> };
}

function depsWith(r: MemoryReranker | null | undefined, timeoutMs?: number): RerankCoreDeps {
  return { getReranker: () => r, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

describe("normalizeRerankResults", () => {
  it("丢弃非法下标（越界/负数/非整数/非有限分），按 score 降序", () => {
    const out = normalizeRerankResults(
      [
        { index: 5, score: 9 }, // 越界
        { index: -1, score: 8 }, // 负数
        { index: 0.5, score: 7 }, // 非整数
        { index: 2, score: Number.NaN }, // 非有限分
        { index: 1, score: 0.3 },
        { index: 0, score: 0.9 },
      ],
      3,
    );
    expect(out).toEqual([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.3 },
    ]);
  });

  it("重复 index 首见保留；null/非数组 → 空数组", () => {
    expect(normalizeRerankResults([{ index: 1, score: 1 }, { index: 1, score: 2 }], 3)).toEqual([
      { index: 1, score: 1 },
    ]);
    expect(normalizeRerankResults(null, 3)).toEqual([]);
    expect(normalizeRerankResults(undefined, 3)).toEqual([]);
  });
});

describe("handleRerankCore", () => {
  const goodBody = { query: "采购订单 保存校验", documents: ["a", "b", "c"] };

  it("happy path：adapter 已排序 → 原样返回 200", async () => {
    const r = fakeReranker(async () => [
      { index: 2, score: 0.9 },
      { index: 0, score: 0.1 },
    ]);
    const res = await handleRerankCore(goodBody, depsWith(r));
    expect(res.status).toBe(200);
    expect(res).toEqual({
      status: 200,
      payload: { results: [{ index: 2, score: 0.9 }, { index: 0, score: 0.1 }] },
    });
    expect(r.rerank).toHaveBeenCalledWith("采购订单 保存校验", ["a", "b", "c"]);
  });

  it("防御性整形：adapter 乱序/脏数据 → 降序且剔非法", async () => {
    const r = fakeReranker(async () => [
      { index: 0, score: 0.1 },
      { index: 9, score: 0.9 }, // 越界剔除
      { index: 2, score: 0.5 },
    ]);
    const res = await handleRerankCore(goodBody, depsWith(r));
    expect(res.status).toBe(200);
    expect(res.status === 200 && res.payload.results).toEqual([
      { index: 2, score: 0.5 },
      { index: 0, score: 0.1 },
    ]);
  });

  it("top_n 截断；超长 top_n clamp 到 documents.length；非法 top_n → 400", async () => {
    const r = fakeReranker(async () => [
      { index: 1, score: 0.8 },
      { index: 0, score: 0.2 },
      { index: 2, score: 0.5 },
    ]);
    const cut = await handleRerankCore({ ...goodBody, top_n: 2 }, depsWith(r));
    expect(cut.status).toBe(200);
    expect(cut.status === 200 && cut.payload.results).toEqual([
      { index: 1, score: 0.8 },
      { index: 2, score: 0.5 },
    ]);

    const clamp = await handleRerankCore({ ...goodBody, top_n: 99 }, depsWith(r));
    expect(clamp.status).toBe(200);
    expect(clamp.status === 200 && cut.status === 200 && clamp.payload.results.length).toBe(3);

    const bad = await handleRerankCore({ ...goodBody, top_n: 0 }, depsWith(r));
    expect(bad).toEqual({ status: 400, payload: { code: 400, message: "field 'top_n' must be a positive integer" } });
  });

  it.each([
    ["body 非 JSON 对象", "not-an-object"],
    ["body 为 null", null],
    ["body 为数组", [1, 2]],
    ["query 缺失", { documents: ["a"] }],
    ["query 非字符串", { query: 1, documents: ["a"] }],
    ["query 超长", { query: "q".repeat(RERANK_LIMITS.maxQueryChars + 1), documents: ["a"] }],
    ["documents 缺失", { query: "q" }],
    ["documents 空数组", { query: "q", documents: [] }],
    ["documents 非字符串成员", { query: "q", documents: ["a", 5] }],
    ["单文档超长", { query: "q", documents: ["d".repeat(RERANK_LIMITS.maxDocChars + 1)] }],
    ["文档数超限", { query: "q", documents: Array.from({ length: RERANK_LIMITS.maxDocs + 1 }, () => "x") }],
  ])("400：%s", async (_name, body) => {
    const res = await handleRerankCore(body, depsWith(fakeReranker(async () => [])));
    expect(res.status).toBe(400);
  });

  it("getReranker 返回 null/undefined → 503 rerank_unavailable", async () => {
    const res = await handleRerankCore(goodBody, depsWith(null));
    expect(res).toEqual({ status: 503, payload: { code: 503, message: "rerank_unavailable" } });
    const res2 = await handleRerankCore(goodBody, depsWith(undefined));
    expect(res2.status).toBe(503);
  });

  it("provider 降级 null → 503（永不 500）", async () => {
    const r = fakeReranker(async () => null);
    const res = await handleRerankCore(goodBody, depsWith(r));
    expect(res).toEqual({ status: 503, payload: { code: 503, message: "rerank_unavailable" } });
  });

  it("provider 抛错 → 503 rerank_failed（异常不外泄）", async () => {
    const r = fakeReranker(async () => {
      throw new Error("boom internal");
    });
    const res = await handleRerankCore(goodBody, depsWith(r));
    expect(res).toEqual({ status: 503, payload: { code: 503, message: "rerank_failed" } });
  });

  it("provider 悬挂 → 外层超时 503（timer 清理不悬挂句柄）", async () => {
    const r = fakeReranker(() => new Promise(() => undefined)); // never resolves
    const t0 = Date.now();
    const res = await handleRerankCore(goodBody, depsWith(r, 30));
    expect(res).toEqual({ status: 503, payload: { code: 503, message: "rerank_unavailable" } });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("非函数 reranker 形状 → 503（防御注入错误）", async () => {
    const res = await handleRerankCore(goodBody, {
      getReranker: () => ({}) as unknown as MemoryReranker,
    });
    expect(res.status).toBe(503);
  });
});
