import { test, expect } from "vitest";
import { createHttpReranker } from "../src/rerank/client.js";

type FetchCall = { url: string; init: RequestInit };

/** 构造可捕获请求的假 fetch。 */
function fakeFetch(responder: (body: any) => { status: number; payload: unknown } | "hang") {
  const calls: FetchCall[] = [];
  const impl = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), init });
    let raw = "";
    if (init.body) raw = String(init.body);
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { /* ignore */ }
    const r = responder(parsed);
    if (r === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return new Response(JSON.stringify(r.payload), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("happy path：透传 results、附带 Bearer 与 JSON 头、POST 正确 body", async () => {
  const { impl, calls } = fakeFetch(() => ({
    status: 200,
    payload: { results: [{ index: 1, score: 9.5 }, { index: 0, score: 2 }] },
  }));
  const rr = createHttpReranker({ url: "http://core:8420/v1/rerank", apiKey: "k1", fetchImpl: impl });
  const out = await rr.rerank("库存查询", ["docA", "docB"]);
  expect(out).toEqual([{ index: 1, score: 9.5 }, { index: 0, score: 2 }]);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("http://core:8420/v1/rerank");
  expect(calls[0].init.method).toBe("POST");
  const headers = calls[0].init.headers as Record<string, string>;
  expect(headers["Content-Type"]).toBe("application/json");
  expect(headers["Authorization"]).toBe("Bearer k1");
  const body = JSON.parse(String(calls[0].init.body));
  expect(body).toEqual({ query: "库存查询", documents: ["docA", "docB"] });
});

test("无 apiKey → 不带 Authorization 头", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, payload: { results: [] } }));
  const rr = createHttpReranker({ url: "http://core:8420/v1/rerank", fetchImpl: impl });
  await rr.rerank("q", ["d"]);
  expect((calls[0].init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
});

test("防御整形：越界/非整数/重复/未排序 → 过滤、去重、降序", async () => {
  const { impl } = fakeFetch(() => ({
    status: 200,
    payload: {
      results: [
        { index: 0, score: 1 },
        { index: 2, score: 9 },      // 界内，最高
        { index: 5, score: 7 },      // 越界 → 剔除（仅 3 篇）
        { index: 1.5, score: 6 },    // 非整数 → 剔除
        { index: 0, score: 4 },      // 重复 → 首见保留
        { index: 1, score: 3 },
      ],
    },
  }));
  const rr = createHttpReranker({ url: "http://x/v1/rerank", fetchImpl: impl });
  const out = await rr.rerank("q", ["d0", "d1", "d2"]);
  expect(out).toEqual([{ index: 2, score: 9 }, { index: 1, score: 3 }, { index: 0, score: 1 }]);
});

test("HTTP 500 → null", async () => {
  const { impl } = fakeFetch(() => ({ status: 500, payload: { code: 503, message: "rerank_failed" } }));
  const rr = createHttpReranker({ url: "http://x/v1/rerank", fetchImpl: impl });
  expect(await rr.rerank("q", ["d"])).toBeNull();
});

test("HTTP 400 → null", async () => {
  const { impl } = fakeFetch(() => ({ status: 400, payload: { code: 400, message: "bad" } }));
  const rr = createHttpReranker({ url: "http://x/v1/rerank", fetchImpl: impl });
  expect(await rr.rerank("q", ["d"])).toBeNull();
});

test("非法 JSON → null", async () => {
  const impl = (async () => new Response("{not-json", { status: 200 })) as unknown as typeof fetch;
  const rr = createHttpReranker({ url: "http://x/v1/rerank", fetchImpl: impl });
  expect(await rr.rerank("q", ["d"])).toBeNull();
});

test("响应形状错误（无 results / results 非数组）→ null", async () => {
  const a = fakeFetch(() => ({ status: 200, payload: { unexpected: true } }));
  const b = fakeFetch(() => ({ status: 200, payload: { results: "nope" } }));
  const ra = createHttpReranker({ url: "http://x/v1/rerank", fetchImpl: a.impl });
  const rb = createHttpReranker({ url: "http://x/v1/rerank", fetchImpl: b.impl });
  expect(await ra.rerank("q", ["d"])).toBeNull();
  expect(await rb.rerank("q", ["d"])).toBeNull();
});

test("fetch 抛错（网络层）→ null", async () => {
  const impl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const rr = createHttpReranker({ url: "http://x/v1/rerank", fetchImpl: impl });
  expect(await rr.rerank("q", ["d"])).toBeNull();
});

test("超时（signal 触发 abort）→ null 且及时返回", async () => {
  const { impl } = fakeFetch(() => "hang");
  const rr = createHttpReranker({ url: "http://x/v1/rerank", fetchImpl: impl, timeoutMs: 50 });
  const t0 = Date.now();
  const out = await rr.rerank("q", ["d"]);
  expect(out).toBeNull();
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("空 documents → 直接返回 null（不发请求）", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, payload: { results: [] } }));
  const rr = createHttpReranker({ url: "http://x/v1/rerank", fetchImpl: impl });
  expect(await rr.rerank("q", [])).toBeNull();
  expect(calls).toHaveLength(0);
});
