import { describe, it, expect, vi } from "vitest";
import type { WikiService } from "../src/store/index.js";
import { createWikiRoutes } from "../src/routes/wiki.js";
import type { WikiRow } from "../src/store/index.js";

function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    wiki_id: "w1",
    service_id: "svc",
    team_id: "team",
    name: "x",
    source_type: "upload",
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
  } as unknown as WikiRow;
}

function makeService(rowForGet: WikiRow) {
  const createCalls: Array<Record<string, unknown>> = [];
  const api = {
    create: vi.fn((params: Record<string, unknown>) => {
      createCalls.push(params);
      return { row: makeRow(params), existed: true };
    }),
    getById: vi.fn(() => rowForGet),
    sync: vi.fn(() => ({ kind: "ok", row: makeRow({ status: "processing" }) })),
    updateServiceUrl: vi.fn(),
  };
  return { api, createCalls };
}

async function post(
  app: ReturnType<typeof createWikiRoutes>,
  path: string,
  body: Record<string, unknown>,
) {
  return app.request(path, {
    method: "POST",
    headers: { "x-tdai-service-id": "svc", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /wiki/create (git params)", () => {
  it("passes git-source fields through to WikiService.create", async () => {
    const { api, createCalls } = makeService(makeRow());
    const app = createWikiRoutes({
      wikiService: api as unknown as WikiService,
      wikiMgr: {} as never,
      publicBaseUrl: "",
    });

    const res = await post(app, "/create", {
      team_id: "team",
      name: "gitwiki",
      source_type: "git",
      source_url: "https://github.com/acme/docs.git",
      branch: "dev",
      path_include: "^docs/.*$",
      path_exclude: "secret",
    });
    expect(res.status).toBe(200);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      source_type: "git",
      source_url: "https://github.com/acme/docs.git",
      branch: "dev",
      path_include: "^docs/.*$",
      path_exclude: "secret",
    });
  });

  it("rejects git source missing source_url with 400", async () => {
    const { api } = makeService(makeRow());
    const app = createWikiRoutes({
      wikiService: api as unknown as WikiService,
      wikiMgr: {} as never,
      publicBaseUrl: "",
    });
    const res = await post(app, "/create", {
      team_id: "team",
      name: "gitwiki",
      source_type: "git",
    });
    expect(res.status).toBe(400);
  });

  it("validates git source_url (rejects non-https) with 400", async () => {
    const { api } = makeService(makeRow());
    const app = createWikiRoutes({
      wikiService: api as unknown as WikiService,
      wikiMgr: {} as never,
      publicBaseUrl: "",
    });
    const res = await post(app, "/create", {
      team_id: "team",
      name: "gitwiki",
      source_type: "git",
      source_url: "http://private.local/repo.git",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /wiki/sync", () => {
  it("returns 202 for a git-source wiki and calls WikiService.sync", async () => {
    const { api } = makeService(
      makeRow({ source_type: "git", source_url: "https://github.com/acme/docs.git", status: "ready" }),
    );
    const app = createWikiRoutes({
      wikiService: api as unknown as WikiService,
      wikiMgr: {} as never,
      publicBaseUrl: "",
    });
    const res = await post(app, "/sync", { wiki_id: "w1" });
    expect(res.status).toBe(202);
    expect(api.sync).toHaveBeenCalledTimes(1);
    expect(api.sync.mock.calls[0]).toEqual(["svc", "team", "w1", undefined]);
  });

  it("returns 400 for non git-source wiki and does NOT call sync", async () => {
    const { api } = makeService(makeRow({ source_type: "upload", status: "ready" }));
    const app = createWikiRoutes({
      wikiService: api as unknown as WikiService,
      wikiMgr: {} as never,
      publicBaseUrl: "",
    });
    const res = await post(app, "/sync", { wiki_id: "w1" });
    expect(res.status).toBe(400);
    expect(api.sync).not.toHaveBeenCalled();
  });

  it("is gated by the x-tdai-service-id header", async () => {
    const { api } = makeService(
      makeRow({ source_type: "git", source_url: "https://github.com/acme/docs.git", status: "ready" }),
    );
    const app = createWikiRoutes({
      wikiService: api as unknown as WikiService,
      wikiMgr: {} as never,
      publicBaseUrl: "",
    });
    const res = await app.request("/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki_id: "w1" }),
    });
    expect(res.status).toBe(400);
  });
});