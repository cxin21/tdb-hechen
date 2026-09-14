import { test, expect } from "vitest";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWikiSourceManager } from "../src/engines/wiki/manager.js";
import { loadVecExtension } from "../src/engines/wiki/index-db.js";

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

/** 阻塞轮询 index.db 的 wiki_vec 行数（等 register 的 fire-and-forget writeVectors 落库）。 */
async function waitForVecRows(indexDb: string, expected: number, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let n = 0;
    try {
      const db = new Database(indexDb);
      loadVecExtension(db);
      const r = db.prepare("SELECT count(*) c FROM wiki_vec").get() as { c: number };
      n = r.c;
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

test("hop>0 hybrid search returns non-empty when embedding enabled (F-1 regression)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wikivec-hop-"));
  const wikiId = "wk-" + Math.random().toString(36).slice(2); // 唯一 id，避免多测试共享 read 池
  mkdirSync(join(dir, "wiki"), { recursive: true });
  writeFileSync(join(dir, "wiki", "alpha.md"), "alpha meaning definition here", "utf-8");
  writeFileSync(join(dir, "wiki", "beta.md"), "beta unrelated notes", "utf-8");

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

    // register 触发 writeIndex（DELETE wiki_vec）+ fire-and-forget writeVectors（经 mock embed 落库）。
    await waitForVecRows(join(dir, "index.db"), 2);

    // hop>0 + embedding 启用：图行走必须用 BM25 尺度 seed，而非 RRF 小尺度（~1/60)，
    // 否则被 graphMultiHopSearch 的 minScore(=0.05) 门槛过滤成空（修复前 F-1 复现为空）。
    const resp = await mgr.search(wikiId, "alpha", 10, { hop: 1, decay: 1, minScore: 0.05 });
    expect(resp.results.length).toBeGreaterThan(0);
  } finally {
    try { mgr?.remove(wikiId); } catch { /* best-effort：释放 read 连接以便删除 index.db（Windows 锁） */ }
    await mock.close();
    await rmSyncRetry(dir);
  }
});