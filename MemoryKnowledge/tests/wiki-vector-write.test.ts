import { test, expect } from "vitest";
import Database from "better-sqlite3";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWikiSourceManager } from "../src/engines/wiki/manager.js";
import { loadVecExtension } from "../src/engines/wiki/index-db.js";

/** 建临时 wiki：含 wiki/ 目录 + 一个 .md 页。 */
function tempWiki(): string {
  const dir = mkdtempSync(join(tmpdir(), "wikivec-write-"));
  mkdirSync(join(dir, "wiki"), { recursive: true });
  writeFileSync(join(dir, "wiki", "hello.md"), "# Hello\n\ncontent here", "utf-8");
  return dir;
}

test("writeIndex without embedding leaves wiki_vec absent", () => {
  const dir = tempWiki();
  try {
    const mgr = createWikiSourceManager(join(dir, "_engine"), null); // embedding 未启用 → null
    const state = mgr.register({ name: "wk", path: dir });
    expect(state.status).toBe("ready");

    const db = new Database(join(dir, "index.db"));
    try {
      const vec = db.prepare("SELECT count(*) c FROM sqlite_master WHERE name='wiki_vec'").get() as { c: number };
      expect(vec.c).toBe(0); // writeIndex 不建 wiki_vec（embedding 关闭）；DELETE wiki_vec 在表缺失时静默跳过
      const fts = db.prepare("SELECT count(*) c FROM sqlite_master WHERE name='wiki_fts'").get() as { c: number };
      expect(fts.c).toBe(1); // FTS 照常
      const meta = db.prepare("SELECT count(*) c FROM page_meta").get() as { c: number };
      expect(meta.c).toBe(1); // 页元数据落库
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 本地 mock embedding 服务：任意输入返回固定 3 维向量（dimensions=3 合法）。 */
function startMockEmbed(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [0.5, 0.5, 0.5] }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** 阻塞轮询 index.db 的 wiki_vec 行数达到 expected（register 的 fire-and-forget writeVectors 后）。 */
async function waitForVecRows(indexDb: string, expected: number, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let n = 0;
    try {
      const db = new Database(indexDb);
      loadVecExtension(db);
      n = (db.prepare("SELECT count(*) c FROM wiki_vec").get() as { c: number }).c;
      db.close();
    } catch { /* 表尚未就绪/未加载 vec0 -> 重试 */ }
    if (n >= expected) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`wiki_vec 未在 ${timeoutMs}ms 内收集到 ${expected} 行`);
}

/** 删除临时目录；Windows 上索引连接释放可能有竞态 → 遇 EBUSY 短暂重试。 */
async function rmSyncRetry(dir: string, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EBUSY" || i === tries - 1) throw e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("structural pages (root-level / structural types) are skipped by writeVectors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wikivec-struct-"));
  const wikiId = "wks-" + Math.random().toString(36).slice(2); // 唯一 id，避免多测试共享 read 池
  mkdirSync(join(dir, "wiki"), { recursive: true });
  mkdirSync(join(dir, "wiki", "entities"), { recursive: true });
  // 结构页：根级 index.md（无 type，超大，模拟会被 MAX_INPUT_BYTES 截断） + schema.md（type=schema）
  writeFileSync(join(dir, "wiki", "index.md"), "# Index\n\n" + "x".repeat(300_000), "utf-8");
  writeFileSync(join(dir, "wiki", "schema.md"), "---\ntype: schema\ntitle: Schema\n---\n\nschema body", "utf-8");
  // 内容页：entities/alpha.md（type=entity，应被嵌入）
  writeFileSync(join(dir, "wiki", "entities", "alpha.md"), "---\ntype: entity\ntitle: Alpha\n---\n\nalpha meaning", "utf-8");

  const mock = await startMockEmbed();
  let mgr: ReturnType<typeof createWikiSourceManager> | undefined;
  try {
    mgr = createWikiSourceManager(join(dir, "_engine"), {
      provider: "openai_compatible",
      baseUrl: mock.url,
      apiKey: "k",
      model: "m",
      dimensions: 3,
    });
    const state = mgr.register({ name: wikiId, path: dir });
    expect(state.status).toBe("ready");

    await waitForVecRows(join(dir, "index.db"), 1); // 只有内容页被嵌入
    await new Promise((r) => setTimeout(r, 200)); // 让异步 writeVectors 跑完，避免计数恰好==1 时误判
    const db = new Database(join(dir, "index.db"));
    try {
      loadVecExtension(db);
      const rows = db.prepare("SELECT page_id FROM wiki_vec ORDER BY page_id").all() as Array<{ page_id: string }>;
      expect(rows).toEqual([{ page_id: "entities/alpha" }]); // 结构页零向量残留
    } finally {
      db.close();
    }
  } finally {
    try { mgr?.remove(wikiId); } catch { /* best-effort：释放 read 连接以便删除 index.db（Windows 锁） */ }
    await mock.close();
    await rmSyncRetry(dir);
  }
});