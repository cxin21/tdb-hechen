import { describe, it, expect } from "vitest";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/index.js";

function makeStore() {
  const { db, raw } = createDb({ path: ":memory:" });
  return { store: new SqliteKnowledgeStore(db), raw };
}

describe("markInterruptedAsFailed / restart recovery", () => {
  it("recovers non-terminal wiki that previously synced (has last_sync_at) to ready instead of failed", () => {
    const { store } = makeStore();

    // A wiki that had once synced successfully (index on disk) — must not be lost on restart.
    const { row } = store.createWiki({
      service_id: "svc-1",
      team_id: "team-1",
      name: "had-index",
      source_type: "git",
    });
    store.updateWikiStatus("svc-1", row.wiki_id, {
      status: "processing",
      internal_status: "fetching",
      last_sync_at: "2026-09-07T11:57:33.110Z",
    });

    // A brand-new wiki still mid-ingest on restart — no index ever built.
    const { row: fresh } = store.createWiki({
      service_id: "svc-1",
      team_id: "team-1",
      name: "never-synced",
      source_type: "git",
    });
    store.updateWikiStatus("svc-1", fresh.wiki_id, {
      status: "processing",
      internal_status: "scanning",
    });

    const affected = store.markInterruptedAsFailed();

    const recovered = store.getWiki("svc-1", "team-1", row.wiki_id);
    const stranded = store.getWiki("svc-1", "team-1", fresh.wiki_id);

    // Previously-synced wiki keeps serving (ready); only truly-new one becomes failed.
    expect(affected).toBe(1);
    expect(recovered?.status).toBe("ready");
    expect(recovered?.internal_status).toBeNull();
    expect(recovered?.sync_error).toBeNull();
    expect(stranded?.status).toBe("failed");
    expect(stranded?.sync_error).toBe("interrupted by restart");
  });

  it("recovers non-terminal code-graph that previously synced (has last_sync_at) to ready instead of failed", () => {
    const { store } = makeStore();

    const { row } = store.createCodeGraph({
      service_id: "svc-1",
      team_id: "team-1",
      repo_url: "https://example.com/repo.git",
      branch: "main",
    });
    store.updateCodeGraphStatus("svc-1", row.code_graph_id, {
      status: "processing",
      internal_status: "indexing",
      last_sync_at: "2026-09-07T11:57:33.110Z",
    });

    const { row: fresh } = store.createCodeGraph({
      service_id: "svc-1",
      team_id: "team-1",
      repo_url: "https://example.com/fresh.git",
      branch: "main",
    });
    store.updateCodeGraphStatus("svc-1", fresh.code_graph_id, {
      status: "processing",
      internal_status: "cloning",
    });

    const affected = store.markInterruptedAsFailed();

    const recovered = store.getCodeGraph("svc-1", "team-1", row.code_graph_id);
    const stranded = store.getCodeGraph("svc-1", "team-1", fresh.code_graph_id);

    expect(affected).toBe(1);
    expect(recovered?.status).toBe("ready");
    expect(recovered?.internal_status).toBeNull();
    expect(recovered?.sync_error).toBeNull();
    expect(stranded?.status).toBe("failed");
  });
});