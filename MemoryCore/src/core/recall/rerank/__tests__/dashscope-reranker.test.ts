/**
 * P1 召回质量 spec §4.2（task-1）：dashscope rerank adapter 合同测试。
 * schema 已对官网核实（help.aliyun.com/zh/model-studio/text-rerank-api，2026-10-13 抓取）：
 * POST {baseUrl}/api/v1/services/rerank/text-rerank/text-rerank
 * body {model, input:{query, documents}, parameters:{top_n, return_documents}}
 * → {output:{results:[{index, relevance_score}]}}（按 relevance_score 降序）。
 * gte-rerank v1 2026-05-30 下线——默认模型取官方推荐替代档 qwen3-rerank。
 * 失败合同与 siliconflow 一致：429/5xx/超时/畸形 → null，单次尝试。
 */
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DASHSCOPE_RERANK_BASE_URL, DEFAULT_DASHSCOPE_RERANK_MODEL, DashscopeReranker } from "../dashscope.js";

const okResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const makeReranker = (fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof DashscopeReranker>[0]> = {}) =>
  new DashscopeReranker({ apiKey: "sk-dash-test", fetchImpl, ...overrides });

describe("P1 task-1 dashscope adapter：成功路（请求形状 + 结果映射）", () => {
  it("默认端点/默认模型：自有 schema {model, input:{query,documents}, parameters:{top_n,return_documents:false}}，Bearer 鉴权", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ request_id: "req-1", output: { results: [{ index: 1, relevance_score: 0.9334 }] }, usage: {} }),
    );
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    const out = await rr.rerank("什么是文本排序", ["d0", "d1", "d2"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_DASHSCOPE_RERANK_BASE_URL}/api/v1/services/rerank/text-rerank/text-rerank`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-dash-test");
    expect(JSON.parse(init.body as string)).toEqual({
      model: DEFAULT_DASHSCOPE_RERANK_MODEL,
      input: { query: "什么是文本排序", documents: ["d0", "d1", "d2"] },
      parameters: { top_n: 3, return_documents: false },
    });
    expect(out).toEqual([{ index: 1, score: 0.9334 }]);
  });

  it("自定义 baseUrl（业务空间专属域）/model 透传；results 按 score 降序归一", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ output: { results: [{ index: 0, relevance_score: 0.1 }, { index: 2, relevance_score: 0.6 }] } }),
    );
    const rr = makeReranker(fetchMock as unknown as typeof fetch, {
      baseUrl: "https://ws-abc.cn-beijing.maas.aliyuncs.com",
      model: "gte-rerank-v2",
    });
    const out = await rr.rerank("q", ["d0", "d1", "d2"]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ws-abc.cn-beijing.maas.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank");
    expect((JSON.parse(init.body as string) as { model: string }).model).toBe("gte-rerank-v2");
    expect(out).toEqual([
      { index: 2, score: 0.6 },
      { index: 0, score: 0.1 },
    ]);
  });

  it("空 docs：短路返回 []，不发 HTTP", async () => {
    const fetchMock = vi.fn(async () => okResponse({ output: { results: [] } }));
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("畸形条目防御：index 越界/非整数、score 非有限数 → 丢弃该条，合法条保留", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        output: {
          results: [
            { index: 7, relevance_score: 0.5 }, // 越界（docs=2）
            { index: 1.5, relevance_score: 0.5 }, // 非整数
            { index: 0, relevance_score: null }, // score 非数
            { index: 1, relevance_score: 0.42 },
          ],
        },
      }),
    );
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d0", "d1"])).toEqual([{ index: 1, score: 0.42 }]);
  });
});

describe("P1 task-1 dashscope adapter：失败路一律 null（绝不抛异常）", () => {
  it("HTTP 429 → null，且仅单次尝试（无重试）", async () => {
    const fetchMock = vi.fn(async () => okResponse({ code: "Throttling", message: "too many" }, 429));
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d"])).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("HTTP 500 → null", async () => {
    const fetchMock = vi.fn(async () => okResponse({ code: "InternalError" }, 500));
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d"])).toBeNull();
  });

  it("HTTP 200 但错误信封（code/message，无 output——官网失败响应示例）→ null", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ code: "InvalidApiKey", message: "Invalid API-key provided.", request_id: "fb53c4ec" }),
    );
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
      throw new Error("socket hang up");
    });
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d"])).toBeNull();
  });

  it("畸形响应：output 缺失 / output.results 非数组 → null", async () => {
    const fetchMockA = vi.fn(async () => okResponse({ request_id: "r" }));
    const fetchMockB = vi.fn(async () => okResponse({ output: { results: 42 } }));
    expect(await makeReranker(fetchMockA as unknown as typeof fetch).rerank("q", ["d"])).toBeNull();
    expect(await makeReranker(fetchMockB as unknown as typeof fetch).rerank("q", ["d"])).toBeNull();
  });

  it("畸形响应：空 results 数组 + 非空 docs → null", async () => {
    const fetchMock = vi.fn(async () => okResponse({ output: { results: [] } }));
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d"])).toBeNull();
  });

  it("body 非 JSON → null", async () => {
    const bad = new Response("gateway timeout", { status: 200, headers: { "Content-Type": "text/plain" } });
    const fetchMock = vi.fn(async () => bad);
    const rr = makeReranker(fetchMock as unknown as typeof fetch);
    expect(await rr.rerank("q", ["d"])).toBeNull();
  });
});
