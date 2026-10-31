/**
 * task-73（core wiki 薄转发）· /v3/wiki/{list,search} 行为契约。
 *
 * 覆盖 Lead 票面验收点：
 *   1. 发现面直连 8421（不依赖 core 注册表），8421 挂时回落注册表且请求仍 200；
 *   2. 检索面跨 wiki 按 **absScore** 合并（score 同值不同 absScore 时不得按 score 并列）；
 *   3. 单 wiki 故障隔离进 meta.failed[]，不可读 wiki 进 meta.skipped[]；
 *   4. team 归属由 metadata 判：enforce 不通过 403；warn/unknown/unavailable fail-open；
 *   5. /v3/wiki/* 已登记 isV3Extra，handleV2Route 能真正派发（否则 404）；
 *   6. enabled=false → 403 WIKI_FORWARDING_DISABLED（不是静默空结果）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import { handleV2Route } from "../v2-router.js";
import { makeWikiRouteTable, __resetWikiWarnOnceForTests } from "../wiki-handlers.js";
import type { WikiRouteHandler, WikiRouterDeps } from "../wiki-handlers.js";
import type { WikiFetchLike, WikiFetchResponseLike } from "../wiki-client.js";

const SERVICE_ID = "default";
const TEAM = "team-2k12lgb650";
const AUTH = { apiKey: "test-key", serviceId: SERVICE_ID };

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function jsonResponse(data: unknown, opts: { code?: number; message?: string; status?: number } = {}): WikiFetchResponseLike {
  const payload = JSON.stringify({ code: opts.code ?? 0, message: opts.message ?? "ok", data });
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => payload,
    json: async () => JSON.parse(payload) as unknown,
  };
}

function wikiRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    wiki_id: "wiki-a",
    team_id: TEAM,
    name: "scm-standards",
    service_url: "http://127.0.0.1:8421/v3",
    status: "ready",
    internal_status: "ready",
    sync_error: null,
    last_sync_at: "2026-10-31T00:00:00.000Z",
    page_count: 50,
    source_type: "git",
    summary: null,
    ...over,
  };
}

function hitRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "wiki/concepts/数据格式档案.md",
    title: "数据格式档案",
    score: 0.6,
    absScore: 1.3140508108247821,
    type: "concept",
    hop: 0,
    snippet: "暂估与冲销",
    ...over,
  };
}

/** 假 8421：按服务端行为（list + 每 wiki search）回放，可注入单 wiki 失败。 */
function makeFetch(handlers: {
  list?: (body: Record<string, unknown>) => WikiFetchResponseLike | Promise<WikiFetchResponseLike>;
  search?: (body: Record<string, unknown>, url: string) => WikiFetchResponseLike | Promise<WikiFetchResponseLike>;
  calls?: Call[];
}): WikiFetchLike {
  return async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    handlers.calls?.push({ url, body });
    if (url.endsWith("/v3/wiki/list")) {
      if (!handlers.list) return jsonResponse({ items: [], total: 0 });
      return handlers.list(body);
    }
    if (url.endsWith("/wiki/search")) {
      if (!handlers.search) return jsonResponse({ results: [], links: [], count: 0 });
      return handlers.search(body, url);
    }
    return jsonResponse({}, { code: 404, message: `unexpected url ${url}`, status: 404 });
  };
}

function listHandler(rows: Array<Record<string, unknown>>): (body: Record<string, unknown>) => WikiFetchResponseLike {
  return () => jsonResponse({ items: rows, total: rows.length });
}

/** 每个 wiki 返回同 score、不同 absScore —— 断言合并只看 absScore。 */
function searchByWiki(map: Record<string, Array<Record<string, unknown>>>): (body: Record<string, unknown>) => WikiFetchResponseLike {
  return (body) => {
    const id = String(body.wiki_id);
    if (!(id in map)) return jsonResponse({ results: [], links: [], count: 0 });
    const results = map[id] ?? [];
    return jsonResponse({ results, links: [], count: results.length });
  };
}

function makeLogger(): { lines: string[]; warn: (m: string) => void; info: (m: string) => void; debug: (m: string) => void; error: (m: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    warn: (m: string) => { lines.push(`WARN ${m}`); },
    info: (m: string) => { lines.push(`INFO ${m}`); },
    debug: () => {},
    error: (m: string) => { lines.push(`ERROR ${m}`); },
  };
}

interface DepsOpts {
  fetchImpl?: WikiFetchLike;
  metadata?: Record<string, unknown> | null;
  store?: Record<string, unknown> | null;
  headers?: Record<string, string>;
  config?: Record<string, unknown>;
  logger?: ReturnType<typeof makeLogger>;
}

function makeDeps(opts: DepsOpts = {}) {
  const logger = opts.logger ?? makeLogger();
  const deps = {
    logger,
    getStore: () => opts.store ?? undefined,
    getMetadataService: async () => (opts.metadata === null ? undefined : opts.metadata ?? undefined),
    wikiHeaders: opts.headers ?? {},
  };
  const table = makeWikiRouteTable({
    getConfig: () => ({ timeoutMs: 2000, perWikiTimeoutMs: 1000, ...(opts.config ?? {}) }),
    fetchImpl: opts.fetchImpl ?? makeFetch({}),
    now: () => Date.now(),
  });
  return { deps, table, logger };
}

async function call(
  table: Record<string, WikiRouteHandler>,
  path: string,
  body: unknown,
  deps: unknown,
): Promise<{ code: number; message?: string; data?: any }> {
  const handler = table[path];
  if (!handler) throw new Error(`route not found: ${path}`);
  return (await handler(body, AUTH, "req-test", deps as WikiRouterDeps)) as {
    code: number;
    message?: string;
    data?: any;
  };
}

beforeEach(() => {
  __resetWikiWarnOnceForTests();
});

describe("/v3/wiki/list", () => {
  it("发现面直连 8421：三条 wiki 原样返回，readiness 镜像 wikiCanServeReads", async () => {
    const fetchImpl = makeFetch({
      list: listHandler([
        wikiRow({ wiki_id: "wiki-a", name: "scm-standards", page_count: 50, status: "ready" }),
        wikiRow({ wiki_id: "wiki-b", name: "scm-recipes", page_count: 686, status: "ready" }),
        // failed + 无 last_sync_at ⇒ 不可读（8421 侧同样返回空结果）
        wikiRow({ wiki_id: "wiki-c", name: "scm-business-analysis", status: "failed", last_sync_at: null }),
      ]),
    });
    const { deps, table } = makeDeps({ fetchImpl });
    const res = await call(table, "/v3/wiki/list", { team_id: TEAM }, deps);

    expect(res.code).toBe(0);
    expect(res.data.meta.source).toBe("knowledge");
    expect(res.data.total).toBe(3);
    expect(res.data.wikis.map((w: any) => [w.wikiId, w.ready])).toEqual([
      ["wiki-a", true],
      ["wiki-b", true],
      ["wiki-c", false],
    ]);
    expect(res.data.meta.failed).toEqual([]);
  });

  it("8421 挂掉时回落 core 注册表，请求仍 200 且 meta.failed 留证", async () => {
    const fetchImpl = makeFetch({
      list: () => jsonResponse({}, { code: 500, message: "knowledge service down", status: 500 }),
    });
    const store = {
      listKnowledge: async () => ({
        items: [
          { knowledge_id: "wiki-legacy", name: "legacy-wiki", service_url: "http://127.0.0.1:8421/v3", summary: null },
        ],
        total: 1,
      }),
    };
    const { deps, table } = makeDeps({ fetchImpl, store });
    const res = await call(table, "/v3/wiki/list", { team_id: TEAM }, deps);

    expect(res.code).toBe(0);
    expect(res.data.meta.source).toBe("core_registry");
    expect(res.data.wikis.map((w: any) => w.wikiId)).toEqual(["wiki-legacy"]);
    expect(res.data.meta.failed).toHaveLength(1);
    expect(res.data.meta.failed[0].stage).toBe("discovery");
  });
});

describe("/v3/wiki/search", () => {
  const twoWikis = listHandler([
    wikiRow({ wiki_id: "wiki-a", name: "scm-standards" }),
    wikiRow({ wiki_id: "wiki-b", name: "scm-recipes" }),
  ]);

  it("跨 wiki 合并用 absScore：score 相同（0.6）时按 absScore 排序", async () => {
    const fetchImpl = makeFetch({
      list: twoWikis,
      search: searchByWiki({
        "wiki-a": [hitRow({ path: "a.md", title: "A" })],
        "wiki-b": [hitRow({ path: "b.md", title: "B", absScore: 0.42 })],
      }),
    });
    const { deps, table } = makeDeps({ fetchImpl });
    const res = await call(table, "/v3/wiki/search", { query: "暂估 冲销", team_id: TEAM }, deps);

    expect(res.code).toBe(0);
    expect(res.data.results.map((r: any) => r.title)).toEqual(["A", "B"]);
    expect(res.data.results[0].absScore).toBeGreaterThan(res.data.results[1].absScore);
    expect(res.data.meta.wikisQueried).toBe(2);
  });

  it("同 path 存在于多个 wiki 时各自保留（去重键含 wikiId，不把一个 wiki 的文档并掉）", async () => {
    const fetchImpl = makeFetch({
      list: twoWikis,
      search: searchByWiki({
        "wiki-a": [hitRow({ path: "shared.md", absScore: 1.0 })],
        "wiki-b": [hitRow({ path: "shared.md", absScore: 2.5 })],
      }),
    });
    const { deps, table } = makeDeps({ fetchImpl });
    const res = await call(table, "/v3/wiki/search", { query: "q", team_id: TEAM }, deps);

    // 同一 path 在不同 wiki 里是两个不同知识库文档：合并只按 absScore 排序，
    // 去重只在 (wikiId, path) 内做 —— 否则会丢失来源归属，用户无从判断该信哪个。
    expect(res.data.results.map((x: any) => [x.wikiId, x.absScore])).toEqual([
      ["wiki-b", 2.5],
      ["wiki-a", 1.0],
    ]);
  });

  it("单 wiki 500 只进 meta.failed，其它 wiki 结果照常返回（200）", async () => {
    const fetchImpl = makeFetch({
      list: twoWikis,
      search: (body) => {
        if (body.wiki_id === "wiki-b") return jsonResponse({}, { code: 500, message: "index corrupted", status: 500 });
        return jsonResponse({ results: [hitRow({ path: "a.md" })], links: [], count: 1 });
      },
    });
    const { deps, table } = makeDeps({ fetchImpl });
    const res = await call(table, "/v3/wiki/search", { query: "q", team_id: TEAM }, deps);

    expect(res.code).toBe(0);
    expect(res.data.results).toHaveLength(1);
    expect(res.data.meta.wikisFailed).toBe(1);
    expect(res.data.meta.failed[0].wikiId).toBe("wiki-b");
  });

  it("不可读 wiki（draft / failed 且无 last_sync_at）进 meta.skipped 且不发起检索", async () => {
    const calls: Call[] = [];
    const fetchImpl = makeFetch({
      list: listHandler([
        wikiRow({ wiki_id: "wiki-a", status: "ready" }),
        wikiRow({ wiki_id: "wiki-draft", status: "draft", last_sync_at: null }),
        wikiRow({ wiki_id: "wiki-failed", status: "failed", last_sync_at: null }),
      ]),
      search: searchByWiki({ "wiki-a": [hitRow({ path: "a.md" })] }),
      calls,
    });
    const { deps, table } = makeDeps({ fetchImpl });
    const res = await call(table, "/v3/wiki/search", { query: "q", team_id: TEAM }, deps);

    const searched = calls.filter((c) => c.url.endsWith("/wiki/search")).map((c) => String(c.body.wiki_id));
    expect(searched).toEqual(["wiki-a"]);
    expect(res.data.meta.skipped.map((s: any) => [s.wikiId, s.reason])).toEqual([
      ["wiki-draft", "not_readable(draft)"],
      ["wiki-failed", "not_readable(failed)"],
    ]);
  });

  it("perWikiTimeoutMs 到点：该 wiki 进 meta.failed，原因是超时（不是整体 500）", async () => {
    const hanging: WikiFetchLike = async (url, init) => {
      if (url.endsWith("/v3/wiki/list")) return jsonResponse({ items: [wikiRow({ wiki_id: "wiki-slow" })], total: 1 });
      return await new Promise<WikiFetchResponseLike>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const { deps, table } = makeDeps({ fetchImpl: hanging, config: { timeoutMs: 5000, perWikiTimeoutMs: 100 } });
    const res = await call(table, "/v3/wiki/search", { query: "q", team_id: TEAM }, deps);

    expect(res.code).toBe(0);
    expect(res.data.results).toEqual([]);
    expect(res.data.meta.failed[0].error).toContain("timeout");
  });

  it("minScore 按 absScore 过滤", async () => {
    const fetchImpl = makeFetch({
      list: twoWikis,
      search: searchByWiki({
        "wiki-a": [hitRow({ path: "low.md", absScore: 0.01 }), hitRow({ path: "high.md", absScore: 1.2 })],
        "wiki-b": [],
      }),
    });
    const { deps, table } = makeDeps({ fetchImpl });
    const res = await call(table, "/v3/wiki/search", { query: "q", team_id: TEAM, min_score: 0.02 }, deps);

    expect(res.data.results.map((r: any) => r.path)).toEqual(["high.md"]);
  });
});

describe("team 归属校验（metadata 白名单）", () => {
  const listOk = listHandler([wikiRow({})]);

  it("enforce + 用户不属于该 team → 403 WIKI_TEAM_FORBIDDEN，且不打 8421", async () => {
    const calls: Call[] = [];
    const { deps, table } = makeDeps({
      fetchImpl: makeFetch({ list: listOk, calls }),
      metadata: { listTeamsByUser: async () => ({ items: [{ team_id: "team-other" }] }) },
      config: { teamVerify: "enforce" },
    });
    const res = await call(table, "/v3/wiki/list", { team_id: TEAM, user_id: "u-1" }, deps);

    expect(res.code).toBe(403);
    expect((res.data as any)?.code).toBe("WIKI_TEAM_FORBIDDEN");
    expect(calls).toHaveLength(0);
  });

  it("enforce + 用户属于该 team → 放行", async () => {
    const { deps, table } = makeDeps({
      fetchImpl: makeFetch({ list: listOk }),
      metadata: { listTeamsByUser: async () => ({ items: [{ team_id: TEAM }] }) },
      config: { teamVerify: "enforce" },
    });
    const res = await call(table, "/v3/wiki/list", { team_id: TEAM, user_id: "u-1" }, deps);
    expect(res.code).toBe(0);
  });

  it("warn 档不通过 → 放行一次并只 WARN 一次（灰度口径）", async () => {
    const logger = makeLogger();
    const { deps, table } = makeDeps({
      fetchImpl: makeFetch({ list: listOk }),
      metadata: { listTeamsByUser: async () => ({ items: [{ team_id: "team-other" }] }) },
      config: { teamVerify: "warn" },
      logger,
    });
    const first = await call(table, "/v3/wiki/list", { team_id: TEAM, user_id: "u-1" }, deps);
    const second = await call(table, "/v3/wiki/list", { team_id: TEAM, user_id: "u-1" }, deps);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(logger.lines.filter((l) => l.includes("fail-open"))).toHaveLength(1);
  });

  it("metadata 抛错 → fail-open（enforce 也不误杀）", async () => {
    const { deps, table } = makeDeps({
      fetchImpl: makeFetch({ list: listOk }),
      metadata: { listTeamsByUser: async () => { throw new Error("db locked"); } },
      config: { teamVerify: "enforce" },
    });
    const res = await call(table, "/v3/wiki/list", { team_id: TEAM, user_id: "u-1" }, deps);
    expect(res.code).toBe(0);
  });

  it("无 user_id → 只用 getTeamById 判存在性；不存在也 fail-open（不误杀服务端调用）", async () => {
    const { deps, table } = makeDeps({
      fetchImpl: makeFetch({ list: listOk }),
      metadata: { getTeamById: async () => null },
      config: { teamVerify: "enforce" },
    });
    const res = await call(table, "/v3/wiki/list", { team_id: TEAM }, deps);
    expect(res.code).toBe(0);
  });

  it("body 与 x-tdai-team-id 不一致 → 400 WIKI_TEAM_MISMATCH", async () => {
    const { deps, table } = makeDeps({
      fetchImpl: makeFetch({ list: listOk }),
      headers: { "x-tdai-team-id": "team-evil" },
      config: { teamVerify: "off" },
    });
    const res = await call(table, "/v3/wiki/list", { team_id: TEAM }, deps);
    expect(res.code).toBe(400);
    expect((res.data as any)?.code).toBe("WIKI_TEAM_MISMATCH");
  });
});

describe("开关与派发", () => {
  it("enabled=false → 403 WIKI_FORWARDING_DISABLED", async () => {
    const { deps, table } = makeDeps({ config: { enabled: false } });
    const res = await call(table, "/v3/wiki/list", { team_id: TEAM }, deps);
    expect(res.code).toBe(403);
    expect((res.data as any)?.code).toBe("WIKI_FORWARDING_DISABLED");
  });

  it("handleV2Route 能派发 /v3/wiki/list（登记在 isV3Extra，否则被封闭清单挡成 404）", async () => {
    const fetchImpl = makeFetch({ list: listHandler([wikiRow({})]) });
    const { deps } = makeDeps({ fetchImpl, config: { teamVerify: "off" } });
    // handleV2Route 的 resolveStoreForRequest 会调 deps.getEmbedding/getStorage（与业务无关的
    // 前置），缺它会 500 —— 这是既有网关契约，不是 wiki 的问题。
    Object.assign(deps as Record<string, unknown>, {
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      deployMode: "service",
      config: { memory: {} },
    });
    const req = {
      headers: { authorization: "Bearer test-key", "x-tdai-service-id": SERVICE_ID },
    } as unknown as IncomingMessage;
    const res = {} as unknown as ServerResponse;
    let captured: { code: number; data?: unknown } = { code: -1 };
    const handled = await handleV2Route(
      req,
      res,
      "/v3/wiki/list",
      "POST",
      async <T,>() => ({ team_id: TEAM }) as T,
      (_res, _status, payload) => { captured = payload as { code: number }; },
      deps as never,
      makeWikiRouteTable({ getConfig: () => ({ teamVerify: "off" }), fetchImpl }),
    );

    expect(handled).toBe(true);
    expect(captured.code).toBe(0);
  });
});
