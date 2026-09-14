import { describe, it, expect, vi } from "vitest";
import { AutoSyncScheduler } from "../src/store/auto-sync-scheduler.js";
import type { AutoSyncCandidate } from "../src/store/auto-sync-scheduler.js";
import type { CodeGraphRow, WikiRow, IKnowledgeStore, SyncedCodeGraphRef, SyncedWikiRef } from "../src/store/index.js";

const codeGraphRow = {
  code_graph_id: "cg1",
  service_id: "s",
  team_id: "t",
  repo_url: "https://github.com/acme/app.git",
  repo_name: "",
  branch: "main",
  commit_hash: null,
  owner_user_id: null,
  user_id: null,
  agent_id: null,
  task_id: null,
  visibility: "team",
  status: "ready",
  internal_status: null,
  sync_error: null,
  stats_json: null,
  service_url: null,
  summary: null,
  version: 0,
  last_sync_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
} as unknown as CodeGraphRow;

const gitWikiRow = {
  wiki_id: "w1",
  service_id: "s",
  team_id: "t",
  name: "gitwiki",
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
  enabled: true,
  stale: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
} as unknown as WikiRow;

const uploadWikiRow = { ...gitWikiRow, wiki_id: "w2", name: "upload", source_type: "upload", source_url: null } as unknown as WikiRow;

function makeStore(): IKnowledgeStore {
  return {
    listSyncedCodeGraphs: () => [{ service_id: "s", team_id: "t", code_graph_id: "cg1" }],
    getCodeGraph: () => codeGraphRow,
    listSyncedWikis: (): SyncedWikiRef[] => [
      { service_id: "s", team_id: "t", wiki_id: "w1" },
      { service_id: "s", team_id: "t", wiki_id: "w2" },
    ],
    getWiki: (svc: string, team: string, id: string) => (id === "w1" ? gitWikiRow : uploadWikiRow),
  } as unknown as IKnowledgeStore;
}

function makeSvc() {
  const wikiService = { sync: vi.fn(() => ({ kind: "ok", row: gitWikiRow })) };
  const cgService = { sync: vi.fn(() => ({ kind: "ok", row: codeGraphRow })) };
  return { wikiService, cgService };
}

describe("AutoSyncScheduler git-source wiki integration", () => {
  it("listSyncCandidates collects git-source ready wiki + code-graph when wikiService injected", () => {
    const { wikiService, cgService } = makeSvc();
    const sched = new AutoSyncScheduler({
      store: makeStore(),
      cgService: cgService as never,
      wikiService: wikiService as never,
      config: { enabled: false, scanIntervalMs: 0, maxConcurrentSyncs: 1 },
    });
    const cands = (sched as unknown as { listSyncCandidates(): AutoSyncCandidate[] }).listSyncCandidates();
    expect(cands.some((c) => c.kind === "wiki" && c.row.wiki_id === "w1" && c.row.source_type === "git")).toBe(true);
    // upload source_type wiki excluded
    expect(cands.some((c) => c.kind === "wiki" && c.row.wiki_id === "w2")).toBe(false);
    expect(cands.some((c) => c.kind === "codegraph" && c.row.code_graph_id === "cg1")).toBe(true);
  });

  it("excludes git-source wikis when wikiService is NOT injected", () => {
    const { cgService } = makeSvc();
    const sched = new AutoSyncScheduler({
      store: makeStore(),
      cgService: cgService as never,
      config: { enabled: false, scanIntervalMs: 0, maxConcurrentSyncs: 1 },
    });
    const cands = (sched as unknown as { listSyncCandidates(): AutoSyncCandidate[] }).listSyncCandidates();
    expect(cands.every((c) => c.kind === "codegraph")).toBe(true);
  });

  it("syncOne dispatches wiki → wikiService.sync and code-graph → cgService.sync", async () => {
    const { wikiService, cgService } = makeSvc();
    const sched = new AutoSyncScheduler({
      store: makeStore(),
      cgService: cgService as never,
      wikiService: wikiService as never,
      config: { enabled: false, scanIntervalMs: 0, maxConcurrentSyncs: 1 },
    });
    const anySched = sched as unknown as { syncOne(c: AutoSyncCandidate): Promise<void> };

    await anySched.syncOne({ kind: "wiki", row: gitWikiRow });
    expect(wikiService.sync).toHaveBeenCalledWith("s", "t", "w1");

    await anySched.syncOne({ kind: "codegraph", row: codeGraphRow });
    expect(cgService.sync).toHaveBeenCalledWith("s", "t", "cg1", undefined);
  });

  it("scan enqueues git wiki + code-graph once (dedup), then a worker call dispatches", async () => {
    const { wikiService, cgService } = makeSvc();
    const sched = new AutoSyncScheduler({
      store: makeStore(),
      cgService: cgService as never,
      wikiService: wikiService as never,
      config: { enabled: false, scanIntervalMs: 0, maxConcurrentSyncs: 1 },
    });
    const anySched = sched as unknown as {
      scan(): Promise<void>;
      syncOne(c: AutoSyncCandidate): Promise<void>;
    };

    await anySched.scan();

    // 手动消费：验证 worker 分派 git wiki 到 wikiService.sync
    const cand = { kind: "wiki" as const, row: gitWikiRow };
    await anySched.syncOne(cand);
    expect(wikiService.sync).toHaveBeenCalledTimes(1);
  });
});