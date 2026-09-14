// MemoryProxy/src/knowledge/__tests__/wiki-retrieve-client.test.ts
import { describe, expect, it, vi } from "vitest";
import { WikiRetrieveClient } from "../wiki-retrieve-client.js";

const HIT = {
  path: "wiki/concepts/a.md", title: "A", snippet: "snip",
  score: 19.3, type: "concept", hop: 0,
};

describe("WikiRetrieveClient", () => {
  it("posts to {service_url}/wiki/search with wiki_id/query and x-tdai-service-id header", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 0, data: { results: [HIT], count: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const c = new WikiRetrieveClient(
      "http://ks:8421/v3", "default",
      { timeoutMs: 3000 },
    );
    c.fetchImpl = fetchMock as unknown as typeof fetch;

    const hits = await c.search({ wikiId: "wiki-x", query: "暂估回冲", limit: 5, minScore: 0.01 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
    expect(url).toBe("http://ks:8421/v3/wiki/search");
    const headers = init!.headers as Record<string, string>;
    expect(headers["x-tdai-service-id"]).toBe("default");
    const body = JSON.parse(String(init!.body));
    expect(body.wiki_id).toBe("wiki-x");
    expect(body.query).toBe("暂估回冲");
    expect(body.limit).toBe(5);
    expect(body.minScore).toBe(0.01);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("A");
    expect(hits[0].hop).toBe(0);
  });

  it("strips related and normalizes absence of fields gracefully", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        code: 0,
        data: { results: [{ ...HIT, related: [{ title: "R", path: "p", type: "concept", direction: "both" }] }], count: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const c = new WikiRetrieveClient("http://ks:8421/v3", "default");
    c.fetchImpl = fetchMock as unknown as typeof fetch;
    const hits = await c.search({ wikiId: "w", query: "q" });
    expect(hits[0]).not.toHaveProperty("related");
  });

  it("returns [] on non-0 code", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 1, message: "err" }), { status: 200 },
    ));
    const c = new WikiRetrieveClient("http://ks:8421/v3", "default");
    c.fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(c.search({ wikiId: "w", query: "q" })).resolves.toEqual([]);
  });

  it("returns [] on network failure (graceful degradation)", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("boom"); });
    const c = new WikiRetrieveClient("http://ks:8421/v3", "default");
    c.fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(c.search({ wikiId: "w", query: "q" })).resolves.toEqual([]);
  });
});