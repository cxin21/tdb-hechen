import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore, WikiService, BuildQueue } from "../src/store/index.js";
import type { WikiBuildContext, WikiWorker } from "../src/store/index.js";
import { syncGitWikisource } from "../src/module.js";
import type { ISourceFetcher } from "../src/source-fetcher/index.js";

const GIT_URL = "https://github.com/acme/docs.git";

function makeStore() {
  const { db, raw } = createDb({ path: ":memory:" });
  return { store: new SqliteKnowledgeStore(db), raw };
}

function writeTree(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

describe("git-source wiki worker pre-stage", () => {
  it("carries git-source fields into the worker ctx and reaches ready", async () => {
    const { store, raw } = makeStore();
    const dataRoot = mkdtempSync(join(tmpdir(), "wkg-flow-"));
    const captured: WikiBuildContext[] = [];
    const queue = new BuildQueue();
    const worker: WikiWorker = async (ctx) => {
      captured.push(ctx);
      return { pageCount: 3 };
    };
    const service = new WikiService({ store, dataRoot, worker, queue });

    const { row } = service.create({
      service_id: "svc-1",
      team_id: "team-1",
      name: "gitwiki",
      source_type: "git",
      source_url: GIT_URL,
      branch: "dev",
      path_include: "^docs/.*$",
      path_exclude: "secret",
    });
    expect(row.source_type).toBe("git");
    expect(row.branch).toBe("dev");

    const res = service.ingest("svc-1", "team-1", row.wiki_id);
    expect(res.kind).toBe("ok");
    await queue.onIdle();

    expect(captured).toHaveLength(1);
    const ctx = captured[0]!;
    expect(ctx.source_type).toBe("git");
    expect(ctx.source_url).toBe(GIT_URL);
    expect(ctx.branch).toBe("dev");
    expect(ctx.path_include).toBe("^docs/.*$");
    expect(ctx.path_exclude).toBe("secret");

    const finalRow = service.getById("svc-1", row.wiki_id);
    expect(finalRow?.status).toBe("ready");
    expect(finalRow?.page_count).toBe(3);

    raw.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("upload (non-git) wiki passes no git fields (manual upload path unaffected)", async () => {
    const { store, raw } = makeStore();
    const dataRoot = mkdtempSync(join(tmpdir(), "wkg-flow-"));
    const captured: WikiBuildContext[] = [];
    const queue = new BuildQueue();
    const worker: WikiWorker = async (ctx) => {
      captured.push(ctx);
      return { pageCount: 2 };
    };
    const service = new WikiService({ store, dataRoot, worker, queue });

    const { row } = service.create({ service_id: "svc-2", team_id: "team-1", name: "uploadwiki" });
    expect(row.source_type).toBeNull();

    const res = service.ingest("svc-2", "team-1", row.wiki_id);
    expect(res.kind).toBe("ok");
    await queue.onIdle();

    const ctx = captured[0]!;
    expect(ctx.source_type).toBeUndefined();
    expect(ctx.source_url).toBeUndefined();
    expect(ctx.branch).toBeUndefined();
    const finalRow = service.getById("svc-2", row.wiki_id);
    expect(finalRow?.status).toBe("ready");

    raw.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("git pre-stage fetches then filters matching files into raw/sources", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wkg-sync-"));
    mkdirSync(join(dir, "raw", "sources"), { recursive: true });
    const fixture = { "docs/a.md": "#a", "docs/secret.md": "#s", "src/x.ts": "x" };
    const fetchMock = vi.fn(async (_url: string, _branch: string, localPath: string) => {
      writeTree(localPath, fixture);
      return { localPath, version: "abc1234", sourceType: "git" as const };
    });
    const fetcher: ISourceFetcher = {
      supportedType: "git",
      validate: () => {},
      fetch: fetchMock,
      sync: async () => {
        throw new Error("sync should not be called on first clone");
      },
    };
    const statuses: string[] = [];
    await syncGitWikisource({
      fetcher,
      sourceUrl: GIT_URL,
      branch: "main",
      dir,
      pathInclude: "^docs/.*$",
      pathExclude: "secret",
      setInternalStatus: (s) => statuses.push(s),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statuses).toContain("cloning");
    expect(statuses).toContain("filtering");
    expect(existsSync(join(dir, "raw", "sources", "docs", "a.md"))).toBe(true);
    expect(existsSync(join(dir, "raw", "sources", "docs", "secret.md"))).toBe(false);
    expect(existsSync(join(dir, "raw", "sources", "src", "x.ts"))).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it("git pre-stage uses incremental sync when repo_src already cloned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wkg-sync-"));
    mkdirSync(join(dir, "raw", "sources"), { recursive: true });
    const cloneDir = join(dir, "raw", "repo_src");
    mkdirSync(join(cloneDir, ".git"), { recursive: true });

    const syncMock = vi.fn(async (_url: string, _branch: string, localPath: string) => {
      writeTree(localPath, { "a.md": "#updated" });
      return { localPath, version: "def5678", sourceType: "git" as const };
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not be called when repo already cloned");
    });
    const fetcher: ISourceFetcher = {
      supportedType: "git",
      validate: () => {},
      fetch: fetchMock,
      sync: syncMock,
    };
    const statuses: string[] = [];
    await syncGitWikisource({
      fetcher,
      sourceUrl: GIT_URL,
      branch: "main",
      dir,
      pathInclude: "^a\\.md$",
      setInternalStatus: (s) => statuses.push(s),
    });

    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statuses).toContain("fetching");
    expect(existsSync(join(dir, "raw", "sources", "a.md"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});