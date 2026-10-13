/**
 * P1 召回质量 spec §4.2（task-1）：siliconflow rerank adapter 合同测试。
 * 合同：rerank(query, docs) → [{index, score}]（按 score 降序）| null；
 * HTTP 429/5xx/超时/网络错误/畸形响应 → null（绝不向调用方抛异常，
 * 调用方 Task 2 降级原序）。单次尝试不重试（重试策略归 Task 2 熔断层）。
 * fetch 依赖注入（默认 globalThis.fetch）——不 mock 模块。
 */
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SILICONFLOW_RERANK_BASE_URL, DEFAULT_SILICONFLOW_RERANK_MODEL, SiliconflowReranker } from "../siliconflow.js";

const okResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const makeReranker = (fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof SiliconflowReranker>[0]> = {}) =>
  new SiliconflowReranker({ apiKey: "sk-test", fetchImpl, ...overrides });

describe("P1 task-1 siliconflow adapter：成功路（请求形状 + 结果映射）", () => {
  it("默认端点/默认模型：POST {baseUrl}/v1/rerank，body {model,query,documents,top_n=docs.length}，Bearer 鉴权", async () => {
    const fetchMock = vi.fn(async () => okResponse({ id: "r1", results: [{ index: 2, relevance_score: 0.9 }] }));
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    const out = await rr.rerank("什么是排序", ["a", "b", "c"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_SILICONFLOW_RERANK_BASE_URL}/v1/rerank`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      model: DEFAULT_SILICONFLOW_RERANK_MODEL,
      query: "什么是排序",
      documents: ["a", "b", "c"],
      top_n: 3,
    });
    expect(out).toEqual([{ index: 2, score: 0.9 }]);
  });

  it("自定义 baseUrl/model 透传；results 按 score 降序归一（index 随行）", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.8 }] }),
    );
    const rr = makeReranker(fetchMock as unknown as typeof fetch, {
      baseUrl: "https://rerank.example.cn",
      model: "Qwen/Qwen3-Reranker-8B",
    });
    const out = await rr.rerank("q", ["d0", "d1"]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rerank.example.cn/v1/rerank");
    expect((JSON.parse(init.body as string) as { model: string }).model).toBe("Qwen/Qwen3-Reranker-8B");
    expect(out).toEqual([
      { index: 1, score: 0.8 },
      { index: 0, score: 0.2 },
    ]);
  });

  it("空 docs：短路返回 []，不发 HTTP", async () => {
    const fetchMock = vi.fn(async () => okResponse({ results: [] }));
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("畸形条目防御：index 越界/非整数、score 非有限数 → 丢弃该条，合法条保留", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        results: [
          { index: 9, relevance_score: 0.5 }, // 越界（docs=2）
          { index: 0.5, relevance_score: 0.5 }, // 非整数
          { index: 1, relevance_score: "x" }, // score 非数
          { index: 0, relevance_score: 0.7 },
        ],
      }),
    );
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d0", "d1"])).toEqual([{ index: 0, score: 0.7 }]);
  });
});

describe("P1 task-1 siliconflow adapter：失败路一律 null（绝不抛异常）", () => {
  it("HTTP 429 → null，且仅单次尝试（无重试）", async () => {
    const fetchMock = vi.fn(async () => okResponse({ message: "rate limited" }, 429));
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d"])).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("HTTP 500 → null", async () => {
    const fetchMock = vi.fn(async () => okResponse({ error: "boom" }, 500));
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d"])).toBeNull();
  });

  it("HTTP 401 → null（4xx 同样降级，不抛）", async () => {
    const fetchMock = vi.fn(async () => okResponse({ message: "bad key" }, 401));
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d"])).toBeNull();
  });

  it("超时：timeoutMs 到点 abort → null（不悬挂）", async () => {
    const hangingFetch = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
        }),
    );
    const rr = makeReranker(hangingFetch as unknown as typeof fetch, { timeoutMs: 20 });
    const result = await Promise.race([
      rr.rerank("q", ["d"]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("adapter 未在 2s 内超时返回")), 2000)),
    ]);
    expect(result).toBeNull();
  });

  it("fetch 直接抛网络错误 → null", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d"])).toBeNull();
  });

  it("畸形响应：results 缺失/非数组 → null", async () => {
    const fetchMockA = vi.fn(async () => okResponse({ id: "r1" }));
    const fetchMockB = vi.fn(async () => okResponse({ results: "not-an-array" }));
    expect(await makeReranker(fetchMockA as unknown as typeof fetch).rerank("q", ["d"])).toBeNull();
    expect(await makeReranker(fetchMockB as unknown as typeof fetch).rerank("q", ["d"])).toBeNull();
  });

  it("畸形响应：空 results 数组 + 非空 docs（可疑响应）→ null（宁降级勿误判全不相关）", async () => {
    const fetchMock = vi.fn(async () => okResponse({ results: [] }));
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d"])).toBeNull();
  });

  it("全畸形条目（results 非空但每条非法）→ null 降级原序，而非「精排成功：全不相关」（review T1 Minor#1）", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        results: [
          { index: 9, relevance_score: 0.9 }, // 越界（docs=2）
          { index: -1, relevance_score: 0.8 }, // 负越界
          { index: 0.5, relevance_score: 0.7 }, // 非整数
          { index: 1, relevance_score: "x" }, // score 非数
        ],
      }),
    );
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d0", "d1"])).toBeNull();
  });

  it("body 非 JSON → null（resp.json() 抛错被吞）", async () => {
    const bad = new Response("<html>502</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    const fetchMock = vi.fn(async () => bad);
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d"])).toBeNull();
  });
});
