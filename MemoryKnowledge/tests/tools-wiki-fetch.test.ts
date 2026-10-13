/**
 * Task 5 (P1-recall-quality M2 #4) — wiki_fetch knowledge tool.
 *
 * /tools/list advertises wiki_fetch; /tools/call fetches a wiki page body
 * (full page or one section, ≤4000 chars with truncation marker) by
 * doc_path (preferred, = wiki search hit path) or exact title fallback.
 * Not-found returns a structured error result (HTTP 200 + isError), never a crash.
 * Strictly read-only: never mutates page files or knowledge_wiki rows.
 *
 * Seeding goes through the service's own write path (pageWriteMany) — never raw SQL.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { WikiService } from "../src/store/wiki-service.js";
import { createToolsRoutes } from "../src/routes/tools.js";

const dbs: Array<{ close: () => void }> = [];
const tmpDirs: string[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-fetch-test-"));
  tmpDirs.push(dir);
  return dir;
}

const PAGE_A = [
  "---",
  'title: "为什么这么设计"',
  "type: thesis",
  "description: 记忆系统分层设计动机",
  "---",
  "",
  "# 为什么这么设计",
  "",
  "## 背景",
  "",
  "旧系统把所有记忆塞进一个池子，召回噪声大。",
  "",
  "## 目标",
  "",
  "分层召回，先召回候选再做精排。",
].join("\n") + "\n";

function makeLongPage(): string {
  const lines: string[] = [
    "---",
    'title: "Redis 缓存实践"',
    "type: methodology",
    "---",
    "",
    "## 用法",
    "",
  ];
  for (let i = 1; i <= 160; i++) {
    lines.push(`第 ${i} 行：Redis 缓存要把 key 的 TTL 设好，避免雪崩与穿透。`);
  }
  lines.push("", "## 陷阱", "", "热点 key 过期会造成惊群。");
  return lines.join("\n") + "\n";
}

function makeEnv(opts: { ready?: boolean } = {}) {
  const inst = createDb({ path: ":memory:" });
  dbs.push(inst.raw);
  const store = new SqliteKnowledgeStore(inst.db);
  const dataRoot = tmpRoot();
  const svc = new WikiService({ store, dataRoot, worker: async () => undefined });

  const { row } = store.createWiki({
    service_id: "svc",
    team_id: "team",
    name: "设计知识库",
    source_type: "git",
    source_url: "https://example.com/acme/docs.git",
    branch: "main",
  });
  const wikiId = row.wiki_id;

  const outcome = svc.pageWriteMany("svc", "team", wikiId, [
    { ref: "concepts/design.md", content: PAGE_A },
    { ref: "guides/redis.md", content: makeLongPage() },
  ]);
  expect(Array.isArray(outcome)).toBe(true); // guard: seeding went through the service write path

  if (opts.ready !== false) {
    store.updateWikiStatus("svc", wikiId, { status: "ready", last_sync_at: "2026-01-01T00:00:00Z" });
  }

  const app = createToolsRoutes({
    wikiService: svc,
    wikiMgr: {} as never,
    cgService: {} as never,
    instancePool: {} as never,
  });
  return { app, wikiId, store, svc, dataRoot };
}

async function call(
  app: ReturnType<typeof createToolsRoutes>,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "x-tdai-service-id": "svc", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function walkFiles(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, out);
    else out[p.slice(base.length + 1)] = readFileSync(p, "utf-8");
  }
  return out;
}

// ─────────────── tools/list ───────────────

describe("POST /tools/list — wiki_fetch advertised", () => {
  it("lists wiki_fetch with doc_path / title / section params", async () => {
    const { app, wikiId } = makeEnv();
    const res = await call(app, "/list", { knowledge_id: wikiId });
    expect(res.status).toBe(200);
    const body = await res.json();
    const wf = body.data.tools.find((t: { name: string }) => t.name === "wiki_fetch");
    expect(wf).toBeTruthy();
    expect(wf.description).toBeTruthy();
    const names = Object.keys(wf.params);
    expect(names).toEqual(expect.arrayContaining(["doc_path", "title", "section"]));
    // doc_path OR title required → neither individually mandatory; section optional
    expect(wf.params.doc_path.required).toBe(false);
    expect(wf.params.title.required).toBe(false);
    expect(wf.params.section.required).toBe(false);
  });
});

// ─────────────── tools/call: happy paths ───────────────

describe("POST /tools/call wiki_fetch — by doc_path", () => {
  it("returns the page body without frontmatter", async () => {
    const { app, wikiId } = makeEnv();
    const res = await call(app, "/call", {
      knowledge_id: wikiId,
      tool_name: "wiki_fetch",
      params: { doc_path: "wiki/concepts/design.md" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.isError).toBe(false);
    expect(body.data.text).toContain("旧系统把所有记忆塞进一个池子");
    expect(body.data.text).toContain("分层召回，先召回候选再做精排。");
    expect(body.data.text).not.toContain("locked");
    expect(body.data.title).toBe("为什么这么设计");
    expect(body.data.doc_path).toBe("wiki/concepts/design.md");
    expect(body.data.truncated).toBe(false);
  });
});

describe("POST /tools/call wiki_fetch — by exact title", () => {
  it("falls back to exact-title match when doc_path is absent", async () => {
    const { app, wikiId } = makeEnv();
    const res = await call(app, "/call", {
      knowledge_id: wikiId,
      tool_name: "wiki_fetch",
      params: { title: "Redis 缓存实践" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.isError).toBe(false);
    expect(body.data.text).toContain("Redis 缓存要把 key 的 TTL 设好");
    expect(body.data.doc_path).toBe("wiki/guides/redis.md");
  });
});

describe("POST /tools/call wiki_fetch — section", () => {
  it("returns only the matched section", async () => {
    const { app, wikiId } = makeEnv();
    const res = await call(app, "/call", {
      knowledge_id: wikiId,
      tool_name: "wiki_fetch",
      params: { doc_path: "wiki/concepts/design.md", section: "目标" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.isError).toBe(false);
    expect(body.data.text).toContain("分层召回，先召回候选再做精排。");
    expect(body.data.text).not.toContain("旧系统把所有记忆塞进一个池子");
    expect(body.data.section).toBe("目标");
  });

  it("returns structured error when the section does not exist", async () => {
    const { app, wikiId } = makeEnv();
    const res = await call(app, "/call", {
      knowledge_id: wikiId,
      tool_name: "wiki_fetch",
      params: { doc_path: "wiki/concepts/design.md", section: "不存在的节" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.isError).toBe(true);
    expect(body.data.text).toBe("");
    expect(body.data.error).toContain("不存在的节");
  });
});

// ─────────────── tools/call: truncation ───────────────

describe("POST /tools/call wiki_fetch — truncation", () => {
  it("caps output at ≤4000 chars with a truncation marker", async () => {
    const { app, wikiId } = makeEnv();
    const res = await call(app, "/call", {
      knowledge_id: wikiId,
      tool_name: "wiki_fetch",
      params: { title: "Redis 缓存实践" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.isError).toBe(false);
    expect(body.data.truncated).toBe(true);
    expect(body.data.text.length).toBeLessThanOrEqual(4000);
    expect(body.data.text).toContain("[truncated");
    expect(body.data.total_chars).toBeGreaterThan(4000);
    // 标记里的 "showing N" 必须等于实际保留的正文字符数，且 "of M" = total_chars。
    const m = /\[truncated: showing (\d+) of (\d+) chars/.exec(body.data.text);
    expect(m).toBeTruthy();
    expect(m![2]).toBe(String(body.data.total_chars));
    const bodyPart = body.data.text.slice(0, body.data.text.indexOf("\n\n[truncated"));
    expect(bodyPart.length).toBe(Number(m![1]));
    // 标记计入预算：截断时整体恰好顶到 4000 上限。
    expect(body.data.text.length).toBe(4000);
  });
});

// ─────────────── tools/call: not found / validation ───────────────

describe("POST /tools/call wiki_fetch — not found & validation", () => {
  it("unknown doc_path → structured error (HTTP 200, isError)", async () => {
    const { app, wikiId } = makeEnv();
    const res = await call(app, "/call", {
      knowledge_id: wikiId,
      tool_name: "wiki_fetch",
      params: { doc_path: "wiki/nope/missing.md" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.isError).toBe(true);
    expect(body.data.text).toBe("");
    expect(body.data.error).toBeTruthy();
  });

  it("unknown title → structured error", async () => {
    const { app, wikiId } = makeEnv();
    const res = await call(app, "/call", {
      knowledge_id: wikiId,
      tool_name: "wiki_fetch",
      params: { title: "不存在的页面" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.isError).toBe(true);
    expect(body.data.error).toContain("不存在的页面");
  });

  it("neither doc_path nor title → 400 param error", async () => {
    const { app, wikiId } = makeEnv();
    const res = await call(app, "/call", {
      knowledge_id: wikiId,
      tool_name: "wiki_fetch",
      params: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).not.toBe(0);
  });

  it("wiki not ready to serve reads → structured error, not crash", async () => {
    const { app, wikiId } = makeEnv({ ready: false });
    const res = await call(app, "/call", {
      knowledge_id: wikiId,
      tool_name: "wiki_fetch",
      params: { doc_path: "wiki/concepts/design.md" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.isError).toBe(true);
  });
});

// ─────────────── doc_path 边界：穿越拒绝 + 无前缀兜底 ───────────────

describe("POST /tools/call wiki_fetch — doc_path guard & normalization", () => {
  it("traversal-shaped doc_path → structured miss (boundary pinned at tool surface)", async () => {
    const { app, wikiId } = makeEnv();
    const res = await call(app, "/call", {
      knowledge_id: wikiId,
      tool_name: "wiki_fetch",
      params: { doc_path: "wiki/../../etc/passwd" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.isError).toBe(true);
    expect(body.data.text).toBe("");
    expect(body.data.error).toBeTruthy();
  });

  it("unprefixed doc_path works via the wiki/ prefix fallback", async () => {
    const { app, wikiId } = makeEnv();
    const res = await call(app, "/call", {
      knowledge_id: wikiId,
      tool_name: "wiki_fetch",
      params: { doc_path: "concepts/design.md" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.isError).toBe(false);
    expect(body.data.doc_path).toBe("wiki/concepts/design.md");
    expect(body.data.text).toContain("旧系统把所有记忆塞进一个池子");
  });
});

// ─────────────── read-only guarantee ───────────────

describe("POST /tools/call wiki_fetch — read-only", () => {
  it("never mutates page files or the wiki row", async () => {
    const { app, wikiId, store, dataRoot } = makeEnv();
    const snapshot = () => ({
      files: walkFiles(join(dataRoot, "svc", "team", wikiId)),
      row: JSON.stringify(store.getWiki("svc", "team", wikiId)),
    });
    const before = snapshot();

    for (const params of [
      { doc_path: "wiki/concepts/design.md" },
      { title: "Redis 缓存实践" },
      { doc_path: "wiki/concepts/design.md", section: "目标" },
      { doc_path: "wiki/nope/missing.md" },
    ]) {
      const res = await call(app, "/call", {
        knowledge_id: wikiId,
        tool_name: "wiki_fetch",
        params,
      });
      expect(res.status).toBe(200);
    }

    expect(snapshot()).toEqual(before);
  });
});
