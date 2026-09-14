/**
 * Task 1 (DS-PANEL-UI-WIKI-SOURCE-001) — wiki 源管理四路由测试：
 *   PATCH /wiki/:id/source · POST /wiki/:id/test · POST /wiki/:id/refetch · DELETE /wiki/:id
 *
 * 校验复用 SourceFetcherRegistry（https-only + SSRF 零放宽）——PATCH 与 test 的
 * 非法 URL 拒绝用例使用**真实默认 registry**，确保防线不被测试 mock 掩盖。
 */

import { describe, it, expect, vi } from "vitest";
import type { WikiService } from "../src/store/index.js";
import type { WikiRow } from "../src/store/index.js";
import type { ISourceFetcher, FetchResult, SourceProbeResult } from "../src/source-fetcher/types.js";
import { SourceFetcherRegistry } from "../src/source-fetcher/index.js";
import { createWikiRoutes } from "../src/routes/wiki.js";

function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    wiki_id: "w1",
    service_id: "svc",
    team_id: "team",
    name: "x",
    source_type: "git",
    source_url: "https://github.com/acme/docs.git",
    branch: "main",
    path_include: null,
    path_exclude: null,
    owner_user_id: null,
    user_id: "u1",
    agent_id: null,
    task_id: null,
    visibility: "team",
    status: "ready",
    internal_status: null,
    sync_error: null,
    page_count: 3,
    service_url: null,
    summary: null,
    version: 0,
    last_sync_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    enabled: true,
    stale: false,
    ...over,
  } as unknown as WikiRow;
}

function makeService(rowForGet: WikiRow | null) {
  const api = {
    getById: vi.fn(() => rowForGet),
    updateSource: vi.fn((..._args: unknown[]) => rowForGet),
    sync: vi.fn(() => ({ kind: "ok", row: rowForGet })),
    delete: vi.fn(() => true),
  };
  return api;
}

function makeWikiMgr() {
  return { remove: vi.fn() };
}

/** 可注入 probe 行为的 fake git fetcher（仅覆盖 test 路由探测，不掩盖真实校验）。 */
class FakeGitFetcher implements ISourceFetcher {
  readonly supportedType = "git" as const;
  probeCalls: string[] = [];
  constructor(private readonly impl: (url: string) => SourceProbeResult) {}
  validate(sourceUrl: string): void {
    if (!sourceUrl.startsWith("https://")) {
      throw new Error("first version only supports public HTTPS repos");
    }
  }
  async fetch(): Promise<FetchResult> { throw new Error("not used in tests"); }
  async sync(): Promise<FetchResult> { throw new Error("not used in tests"); }
  probe(sourceUrl: string): Promise<SourceProbeResult> {
    this.probeCalls.push(sourceUrl);
    return Promise.resolve(this.impl(sourceUrl));
  }
}

function registryWithProbe(impl: (url: string) => SourceProbeResult): SourceFetcherRegistry {
  const registry = new SourceFetcherRegistry();
  const fake = new FakeGitFetcher(impl);
  registry.register(fake);
  return registry;
}

function defaultDeps(api: ReturnType<typeof makeService>, extra: Partial<Record<string, unknown>> = {}) {
  return {
    wikiService: api as unknown as WikiService,
    wikiMgr: makeWikiMgr() as never,
    publicBaseUrl: "",
    ...extra,
  };
}

async function patch(
  app: ReturnType<typeof createWikiRoutes>,
  path: string,
  body: Record<string, unknown>,
  header = "svc",
) {
  return app.request(path, {
    method: "PATCH",
    headers: { "x-tdai-service-id": header, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function post(
  app: ReturnType<typeof createWikiRoutes>,
  path: string,
  body: Record<string, unknown>,
  header = "svc",
) {
  return app.request(path, {
    method: "POST",
    headers: { "x-tdai-service-id": header, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ═══════════════ PATCH /wiki/:id/source ═══════════════

describe("PATCH /wiki/:id/source", () => {
  it("updates url+branch with validation, sets stale=true, returns updated detail", async () => {
    const row = makeRow();
    const api = makeService(row);
    const updated = makeRow({ source_url: "https://github.com/acme/docs-v2.git", branch: "dev", stale: true });
    api.updateSource.mockReturnValue(updated);
    const app = createWikiRoutes(defaultDeps(api));

    const res = await patch(app, "/w1/source", {
      source_url: "https://github.com/acme/docs-v2.git",
      branch: "dev",
    });
    expect(res.status).toBe(200);
    expect(api.updateSource).toHaveBeenCalledWith("svc", "w1", {
      source_url: "https://github.com/acme/docs-v2.git",
      branch: "dev",
      stale: true,
    });
    const body = (await res.json()) as { code: number; data: Record<string, unknown> };
    expect(body.code).toBe(0);
    expect(body.data.stale).toBe(true);
    expect(body.data.source_url).toBe("https://github.com/acme/docs-v2.git");
  });

  it("rejects non-https source_url with 400 and does NOT persist (real registry, zero relaxation)", async () => {
    const api = makeService(makeRow());
    const app = createWikiRoutes(defaultDeps(api));
    const res = await patch(app, "/w1/source", { source_url: "http://github.com/acme/docs.git" });
    expect(res.status).toBe(400);
    expect(api.updateSource).not.toHaveBeenCalled();
  });

  it("rejects private-address source_url with 400 (SSRF blocklist)", async () => {
    const api = makeService(makeRow());
    const app = createWikiRoutes(defaultDeps(api));
    const res = await patch(app, "/w1/source", { source_url: "https://10.0.0.1/acme/docs.git" });
    expect(res.status).toBe(400);
    expect(api.updateSource).not.toHaveBeenCalled();
  });

  it("rejects loopback-address source_url with 400 (SSRF blocklist)", async () => {
    const api = makeService(makeRow());
    const app = createWikiRoutes(defaultDeps(api));
    const res = await patch(app, "/w1/source", { source_url: "https://localhost/acme/docs.git" });
    expect(res.status).toBe(400);
    expect(api.updateSource).not.toHaveBeenCalled();
  });

  it("enabled-only update skips url validation and does NOT touch stale", async () => {
    const row = makeRow({ source_type: "upload", source_url: null, stale: true });
    const api = makeService(row);
    const app = createWikiRoutes(defaultDeps(api));
    const res = await patch(app, "/w1/source", { enabled: false });
    expect(res.status).toBe(200);
    expect(api.updateSource).toHaveBeenCalledWith("svc", "w1", { enabled: false });
  });

  it("url/branch update on a non-git wiki is rejected with 400", async () => {
    const api = makeService(makeRow({ source_type: "upload", source_url: null }));
    const app = createWikiRoutes(defaultDeps(api));
    const res = await patch(app, "/w1/source", { source_url: "https://github.com/acme/x.git" });
    expect(res.status).toBe(400);
    expect(api.updateSource).not.toHaveBeenCalled();
  });

  it("rejects an empty patch with 400", async () => {
    const api = makeService(makeRow());
    const app = createWikiRoutes(defaultDeps(api));
    const res = await patch(app, "/w1/source", {});
    expect(res.status).toBe(400);
    expect(api.updateSource).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown wiki", async () => {
    const api = makeService(null);
    const app = createWikiRoutes(defaultDeps(api));
    const res = await patch(app, "/w1/source", { enabled: false });
    expect(res.status).toBe(404);
  });

  it("is gated by the x-tdai-service-id header", async () => {
    const api = makeService(makeRow());
    const app = createWikiRoutes(defaultDeps(api));
    const res = await patch(app, "/w1/source", { enabled: false }, "");
    expect(res.status).toBe(400);
  });

  it("rejects unsafe :id path segment with 400", async () => {
    const api = makeService(makeRow());
    const app = createWikiRoutes(defaultDeps(api));
    const res = await patch(app, "/..%2Fevil/source", { enabled: false });
    expect(res.status).toBe(400);
  });

  it("same-value url update does not re-flag stale", async () => {
    const row = makeRow(); // source_url=https://github.com/acme/docs.git
    const api = makeService(row);
    const app = createWikiRoutes(defaultDeps(api));
    const res = await patch(app, "/w1/source", { source_url: "https://github.com/acme/docs.git" });
    expect(res.status).toBe(200);
    expect(api.updateSource.mock.calls[0][2]).not.toHaveProperty("stale");
  });
});

// ═══════════════ POST /wiki/:id/test ═══════════════

describe("POST /wiki/:id/test", () => {
  it("probes the stored git source and returns reachable + branches", async () => {
    const api = makeService(makeRow());
    const registry = registryWithProbe(() => ({ reachable: true, branches: ["main", "dev"] }));
    const app = createWikiRoutes(defaultDeps(api, { fetcherRegistry: registry }));
    const res = await post(app, "/w1/test", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { reachable: boolean; branches: string[] } };
    expect(body.code).toBe(0);
    expect(body.data.reachable).toBe(true);
    expect(body.data.branches).toEqual(["main", "dev"]);
  });

  it("returns reachable=false (200) when probe fails at network level", async () => {
    const api = makeService(makeRow());
    const registry = registryWithProbe(() => {
      throw new Error("Connection refused");
    });
    const app = createWikiRoutes(defaultDeps(api, { fetcherRegistry: registry }));
    const res = await post(app, "/w1/test", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { reachable: boolean; error?: string } };
    expect(body.data.reachable).toBe(false);
    expect(body.data.error).toContain("Connection refused");
  });

  it("supports an optional body.source_url override for edit-time preview (still validated)", async () => {
    const api = makeService(makeRow());
    const registry = registryWithProbe((url) => ({ reachable: true, branches: [url] }));
    const app = createWikiRoutes(defaultDeps(api, { fetcherRegistry: registry }));
    const res = await post(app, "/w1/test", { source_url: "https://github.com/acme/other.git" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { branches: string[] } };
    expect(body.data.branches).toEqual(["https://github.com/acme/other.git"]);
  });

  it("rejects an invalid override url with 400 (real registry)", async () => {
    const api = makeService(makeRow());
    const app = createWikiRoutes(defaultDeps(api));
    const res = await post(app, "/w1/test", { source_url: "http://127.0.0.1/repo.git" });
    expect(res.status).toBe(400);
  });

  it("rejects non-git wiki with 400", async () => {
    const api = makeService(makeRow({ source_type: "upload", source_url: null }));
    const app = createWikiRoutes(defaultDeps(api));
    const res = await post(app, "/w1/test", {});
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown wiki", async () => {
    const api = makeService(null);
    const app = createWikiRoutes(defaultDeps(api));
    const res = await post(app, "/w1/test", {});
    expect(res.status).toBe(404);
  });
});

// ═══════════════ POST /wiki/:id/refetch ═══════════════

describe("POST /wiki/:id/refetch", () => {
  it("re-runs the existing ingest pipeline for a git wiki (202)", async () => {
    const row = makeRow();
    const api = makeService(row);
    const app = createWikiRoutes(defaultDeps(api));
    const res = await post(app, "/w1/refetch", { user_id: "u9" });
    expect(res.status).toBe(202);
    expect(api.sync).toHaveBeenCalledWith("svc", "team", "w1", "u9");
    const body = (await res.json()) as { data: { wiki_id: string; status: string } };
    expect(body.data.wiki_id).toBe("w1");
    expect(body.data.status).toBe("ready");
  });

  it("returns 409 when a build is already in flight", async () => {
    const api = makeService(makeRow());
    api.sync.mockReturnValue({ kind: "busy", status: "processing", step: "ingesting" });
    const app = createWikiRoutes(defaultDeps(api));
    const res = await post(app, "/w1/refetch", {});
    expect(res.status).toBe(409);
  });

  it("rejects non-git wiki with 400 and does NOT enqueue", async () => {
    const api = makeService(makeRow({ source_type: "upload", source_url: null }));
    const app = createWikiRoutes(defaultDeps(api));
    const res = await post(app, "/w1/refetch", {});
    expect(res.status).toBe(400);
    expect(api.sync).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown wiki", async () => {
    const api = makeService(null);
    const app = createWikiRoutes(defaultDeps(api));
    const res = await post(app, "/w1/refetch", {});
    expect(res.status).toBe(404);
  });
});

// ═══════════════ DELETE /wiki/:id ═══════════════

describe("DELETE /wiki/:id", () => {
  it("deletes the wiki together with its ingested pages and unregisters the engine", async () => {
    const row = makeRow();
    const api = makeService(row);
    const wikiMgr = makeWikiMgr();
    const app = createWikiRoutes({
      wikiService: api as unknown as WikiService,
      wikiMgr: wikiMgr as never,
      publicBaseUrl: "",
    });
    const res = await app.request("/w1", { method: "DELETE", headers: { "x-tdai-service-id": "svc" } });
    expect(res.status).toBe(200);
    expect(api.delete).toHaveBeenCalledWith("svc", "team", "w1");
    expect(wikiMgr.remove).toHaveBeenCalledWith("w1");
    const body = (await res.json()) as { data: { wiki_id: string; deleted: boolean } };
    expect(body.data.deleted).toBe(true);
  });

  it("still succeeds when wikiMgr.remove throws (cleanup is non-fatal)", async () => {
    const row = makeRow();
    const api = makeService(row);
    const wikiMgr = { remove: vi.fn(() => { throw new Error("engine busy"); }) };
    const app = createWikiRoutes({
      wikiService: api as unknown as WikiService,
      wikiMgr: wikiMgr as never,
      publicBaseUrl: "",
    });
    const res = await app.request("/w1", { method: "DELETE", headers: { "x-tdai-service-id": "svc" } });
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown wiki and does NOT delete", async () => {
    const api = makeService(null);
    const app = createWikiRoutes(defaultDeps(api));
    const res = await app.request("/w1", { method: "DELETE", headers: { "x-tdai-service-id": "svc" } });
    expect(res.status).toBe(404);
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("is gated by the x-tdai-service-id header", async () => {
    const api = makeService(makeRow());
    const app = createWikiRoutes(defaultDeps(api));
    const res = await app.request("/w1", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});
