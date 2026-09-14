/**
 * Task 1 (DS-PANEL-UI-WIKI-SOURCE-001) — enabled/stale 数据结构 + WikiService.updateSource
 * + 重建成功清 stale + auto-sync enabled 过滤（存储/服务层）。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { WikiService } from "../src/store/wiki-service.js";
import { AutoSyncScheduler } from "../src/store/auto-sync-scheduler.js";
import type { AutoSyncCandidate, IKnowledgeStore, WikiRow, WikiWorker } from "../src/store/index.js";
import { toWikiDetail } from "../src/api-helpers.js";

const dbs: Array<{ close: () => void }> = [];
const tmpDirs: string[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function freshDb() {
  const inst = createDb({ path: ":memory:" });
  dbs.push(inst.raw);
  return inst;
}

function tmpRoot() {
  const dir = mkdtempSync(join(tmpdir(), "wiki-src-test-"));
  tmpDirs.push(dir);
  return dir;
}

function createStore(db = freshDb().db) {
  return new SqliteKnowledgeStore(db);
}

function makeWiki(store: SqliteKnowledgeStore, over: Partial<Record<string, unknown>> = {}): WikiRow {
  const { row } = store.createWiki({
    service_id: "svc",
    team_id: "team",
    name: over.name as string ?? "wiki-" + Math.random().toString(36).slice(2, 8),
    source_type: (over.source_type as string) ?? "git",
    source_url: (over.source_url as string) ?? "https://github.com/acme/docs.git",
    branch: (over.branch as string) ?? "main",
  });
  return row;
}

// ─────────────── migration / defaults ───────────────

describe("knowledge_wiki enabled/stale columns", () => {
  it("table has enabled and stale columns", () => {
    const { raw } = freshDb();
    const cols = (raw.pragma("table_info(knowledge_wiki)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("enabled");
    expect(cols).toContain("stale");
  });

  it("a fresh wiki row defaults to enabled=true / stale=false", () => {
    const store = createStore();
    const row = makeWiki(store);
    expect(row.enabled).toBe(true);
    expect(row.stale).toBe(false);
    const detail = toWikiDetail(row);
    expect(detail.enabled).toBe(true);
    expect(detail.stale).toBe(false);
  });
});

// ─────────────── store round-trip ───────────────

describe("SqliteKnowledgeStore enabled/stale round-trip", () => {
  it("updateWikiStatus persists enabled and stale patches", () => {
    const store = createStore();
    const row = makeWiki(store);

    store.updateWikiStatus("svc", row.wiki_id, { enabled: false, stale: true });
    const after = store.getWikiById("svc", row.wiki_id);
    expect(after?.enabled).toBe(false);
    expect(after?.stale).toBe(true);

    store.updateWikiStatus("svc", row.wiki_id, { enabled: true, stale: false });
    const back = store.getWikiById("svc", row.wiki_id);
    expect(back?.enabled).toBe(true);
    expect(back?.stale).toBe(false);
  });
});

// ─────────────── WikiService.updateSource ───────────────

describe("WikiService.updateSource", () => {
  it("persists source_url/branch/enabled/stale and returns the updated row", () => {
    const store = createStore();
    const svc = new WikiService({ store, dataRoot: tmpRoot(), worker: async () => undefined });
    const row = makeWiki(store);

    const updated = svc.updateSource("svc", row.wiki_id, {
      source_url: "https://github.com/acme/docs-v2.git",
      branch: "dev",
      stale: true,
    });
    expect(updated).not.toBeNull();
    expect(updated?.source_url).toBe("https://github.com/acme/docs-v2.git");
    expect(updated?.branch).toBe("dev");
    expect(updated?.stale).toBe(true);

    const toggled = svc.updateSource("svc", row.wiki_id, { enabled: false });
    expect(toggled?.enabled).toBe(false);
  });

  it("returns null for unknown / foreign-tenant wiki", () => {
    const store = createStore();
    const svc = new WikiService({ store, dataRoot: tmpRoot(), worker: async () => undefined });
    const row = makeWiki(store);
    expect(svc.updateSource("svc", "nope", { enabled: false })).toBeNull();
    expect(svc.updateSource("other", row.wiki_id, { enabled: false })).toBeNull();
  });
});

// ─────────────── stale cleared on successful build ───────────────

describe("stale lifecycle through the build pipeline", () => {
  function makeSvc(store: SqliteKnowledgeStore, worker: WikiWorker) {
    return new WikiService({ store, dataRoot: tmpRoot(), worker });
  }

  it("clears stale when a rebuild reaches ready", async () => {
    const store = createStore();
    const svc = makeSvc(store, async () => ({ pageCount: 7 }));
    const row = makeWiki(store);
    svc.updateSource("svc", row.wiki_id, { stale: true });

    const result = svc.ingest("svc", "team", row.wiki_id);
    expect(result.kind).toBe("ok");

    await vi.waitFor(() => {
      expect(store.getWikiById("svc", row.wiki_id)?.status).toBe("ready");
    });
    const done = store.getWikiById("svc", row.wiki_id);
    expect(done?.stale).toBe(false);
    expect(done?.page_count).toBe(7);
  });

  it("keeps stale=true when the rebuild fails (badge must not silently vanish)", async () => {
    const store = createStore();
    const svc = makeSvc(store, async () => { throw new Error("git fetch failed"); });
    const row = makeWiki(store);
    svc.updateSource("svc", row.wiki_id, { stale: true });

    svc.ingest("svc", "team", row.wiki_id);
    await vi.waitFor(() => {
      expect(store.getWikiById("svc", row.wiki_id)?.status).toBe("failed");
    });
    const done = store.getWikiById("svc", row.wiki_id);
    expect(done?.stale).toBe(true);
    expect(done?.sync_error).toContain("git fetch failed");
  });
});

// ─────────────── auto-sync enabled filter ───────────────

function wikiRowFor(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    wiki_id: id,
    service_id: "s",
    team_id: "t",
    name: id,
    source_type: "git",
    source_url: "https://github.com/acme/docs.git",
    branch: "main",
    path_include: null,
    path_exclude: null,
    owner_user_id: null,
    user_id: null,
    agent_id: null,
    task_id: null,
    visibility: "team",
    status: "ready",
    internal_status: null,
    sync_error: null,
    page_count: 5,
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

describe("AutoSyncScheduler enabled filter", () => {
  function makeStoreWith(rows: WikiRow[]): IKnowledgeStore {
    const byId = new Map(rows.map((r) => [r.wiki_id, r]));
    return {
      listSyncedWikis: () => rows.map((r) => ({ service_id: r.service_id, team_id: r.team_id, wiki_id: r.wiki_id })),
      getWiki: (_s: string, _t: string, id: string) => byId.get(id) ?? null,
      listSyncedCodeGraphs: () => [],
    } as unknown as IKnowledgeStore;
  }

  function candidates(rows: WikiRow[]): AutoSyncCandidate[] {
    const sched = new AutoSyncScheduler({
      store: makeStoreWith(rows),
      cgService: { sync: vi.fn() } as never,
      wikiService: { sync: vi.fn() } as never,
      config: { enabled: false, scanIntervalMs: 0, maxConcurrentSyncs: 1 },
    });
    return (sched as unknown as { listSyncCandidates(): AutoSyncCandidate[] }).listSyncCandidates();
  }

  it("paused (enabled=false) git wikis are skipped by auto-sync", () => {
    const cands = candidates([
      wikiRowFor("w-on"),
      wikiRowFor("w-off", { enabled: false }),
    ]);
    const wikiIds = cands.filter((c) => c.kind === "wiki").map((c) => (c.row as WikiRow).wiki_id);
    expect(wikiIds).toContain("w-on");
    expect(wikiIds).not.toContain("w-off");
  });
});
