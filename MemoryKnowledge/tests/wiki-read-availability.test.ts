import { describe, it, expect, vi } from "vitest";
import type { WikiService } from "../src/store/index.js";
import { createWikiRoutes } from "../src/routes/wiki.js";
import type { WikiRow } from "../src/store/index.js";

/**
 * 回归测试：wiki 处于重同步（pending/processing）期间，只要它"曾 ready"过
 * （last_sync_at 已有落库值），读路径（/search、/graph）应继续返回旧索引数据，
 * 而不是被状态门短路成空。只有从未 ready 的全新建库（draft / last_sync_at 空）才挡。
 *
 * 对应根因：此前读路由用 `status !== "ready"` 直接短路，导致定时同步重建索引时
 * 查询全部返回空，与 WAL"重建时不中断读"的设计意图相违背。
 */
function makeRow(over: Partial<Record<string, unknown>> = {}): WikiRow {
  return {
    wiki_id: "w1",
    service_id: "svc",
    team_id: "team",
    name: "x",
    source_type: "git",
    source_url: null,
    branch: null,
    path_include: null,
    path_exclude: null,
    owner_user_id: null,
    user_id: "u1",
    agent_id: null,
    task_id: null,
    visibility: "team",
    status: "draft",
    internal_status: null,
    sync_error: null,
    page_count: null,
    service_url: null,
    summary: null,
    version: 0,
    last_sync_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    ...over,
  } as WikiRow;
}

function makeApp(rowForGet: WikiRow) {
  const api = {
    create: vi.fn(() => ({ row: makeRow(), existed: true })),
    getById: vi.fn(() => rowForGet),
    sync: vi.fn(() => ({ kind: "ok", row: makeRow({ status: "processing" }) })),
    updateServiceUrl: vi.fn(),
  };
  const search = vi.fn(async () => ({ results: [{ id: "a" }], links: [], count: 1 }));
  const graph = vi.fn(() => ({ nodes: [{ id: "a" }], edges: [], communities: [] }));
  const wikiMgr = { search, graph } as never;
  const app = createWikiRoutes({
    wikiService: api as unknown as WikiService,
    wikiMgr,
    publicBaseUrl: "",
  });
  return { api, search, graph, app };
}

async function post(app: ReturnType<typeof createWikiRoutes>, path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method: "POST",
    headers: { "x-tdai-service-id": "svc", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("读路径重建期间可用性（曾 ready 的 wiki 重同步时仍返回数据）", () => {
  it("/search: processing + last_sync_at 有值 → 放行，返回旧索引结果", async () => {
    const { search, app } = makeApp(
      makeRow({ status: "processing", internal_status: "rebuilding-index", last_sync_at: "2026-01-01T00:00:00Z" }),
    );
    const res = await post(app, "/search", { wiki_id: "w1", query: "alpha" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.results.length).toBe(1);
    expect(search).toHaveBeenCalled();
  });

  it("/graph: processing + last_sync_at 有值 → 放行，返回旧图", async () => {
    const { graph, app } = makeApp(
      makeRow({ status: "processing", internal_status: "scanning", last_sync_at: "2026-01-01T00:00:00Z" }),
    );
    const res = await post(app, "/graph", { wiki_id: "w1" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.nodes.length).toBe(1);
    expect(graph).toHaveBeenCalled();
  });

  it("/search: draft（从未 ready）→ 仍被拦，返回空", async () => {
    const { search, app } = makeApp(makeRow({ status: "draft", last_sync_at: null }));
    const res = await post(app, "/search", { wiki_id: "w1", query: "alpha" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.results).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("/search: processing 但从未 ready（last_sync_at 空，首次建库进行中）→ 仍被拦，返回空", async () => {
    const { search, app } = makeApp(makeRow({ status: "processing", last_sync_at: null }));
    const res = await post(app, "/search", { wiki_id: "w1", query: "alpha" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.results).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("/search: ready 正常放行", async () => {
    const { search, app } = makeApp(makeRow({ status: "ready", last_sync_at: "2026-01-01T00:00:00Z" }));
    const res = await post(app, "/search", { wiki_id: "w1", query: "alpha" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.results.length).toBe(1);
    expect(search).toHaveBeenCalled();
  });
});