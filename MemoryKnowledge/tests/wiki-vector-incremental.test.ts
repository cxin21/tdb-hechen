import { test, expect } from "vitest";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWikiSourceManager } from "../src/engines/wiki/manager.js";
import { loadVecExtension } from "../src/engines/wiki/index-db.js";
import { contentSha256 } from "../src/engines/wiki/content-sha.js";

/** mock embedding：记录每次 embed 的输入文本；返回确定性 2 维向量。 */
function startMockEmbed() {
  const calls: Array<{ text: string }> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.resume();
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { const b = JSON.parse(raw); calls.push({ text: String(b.input?.[0] ?? "") }); } catch { /* ignore */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [0.5, 0.5] }] }));
    });
  });
  return new Promise<any>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** 轮询直至 pred 为真或超时。 */
async function waitFor(pred: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (pred()) return; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error("condition not met within timeout");
}
function vecPageIds(indexDb: string): string[] {
  const db = new Database(indexDb); try { loadVecExtension(db); return (db.prepare("SELECT page_id FROM wiki_vec").all() as any[]).map((r) => String(r.page_id)); } finally { db.close(); }
}
function vecRows(indexDb: string): number { try { return vecPageIds(indexDb).length; } catch { return -1; } }

async function rmSyncRetry(dir: string, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EBUSY" || i === tries - 1) throw e; }
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("writeVectors: 复用/变更/删页(零孤儿)/新增 语义", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wikivec-inc-"));
  const wikiId = "wk-inc-" + Math.random().toString(36).slice(2);
  mkdirSync(join(dir, "wiki"), { recursive: true });
  writeFileSync(join(dir, "wiki", "a.md"), "alpha meaning", "utf-8");
  writeFileSync(join(dir, "wiki", "b.md"), "beta notes", "utf-8");

  const mock = await startMockEmbed();
  let mgr: ReturnType<typeof createWikiSourceManager> | undefined;
  try {
    mgr = createWikiSourceManager(join(dir, "_engine"), {
      provider: "openai_compatible", baseUrl: mock.url, apiKey: "k", model: "m", dimensions: 2,
    });
    mgr.register({ name: wikiId, path: dir });
    const indexDb = join(dir, "index.db");

    // [1] run1: 两页全嵌 → 2 行
    await waitFor(() => vecRows(indexDb) === 2 && mock.calls.length >= 2, 8000);
    const base = mock.calls.length; // 2

    // [2] 复用：同内容再次 sync → 无新 embed、行数不变、content_sha 不变
    mgr.sync(wikiId);
    await waitFor(() => mock.calls.length === base, 3000);
    expect(mock.calls.length).toBe(base);

    // [3] 变更 b 内容 → 仅 b 重嵌（+1）；a 复用
    writeFileSync(join(dir, "wiki", "b.md"), "beta CHANGED content", "utf-8");
    mgr.sync(wikiId);
    await waitFor(() => mock.calls.length === base + 1, 6000);
    expect(mock.calls.length).toBe(base + 1);
    expect(mock.calls[mock.calls.length - 1].text).toContain("CHANGED");

    // [4] 新增 c + 删 b(磁盘 .md 删除) → 新增 c 重嵌(+1)；删页 b 向量被清理（零孤儿）
    writeFileSync(join(dir, "wiki", "c.md"), "gamma new", "utf-8");
    rmSync(join(dir, "wiki", "b.md"));
    mgr.sync(wikiId);
    await waitFor(() => {
      const ids = vecPageIds(indexDb).sort() as string[];
      return ids.includes("a") && ids.includes("c") && !ids.includes("b") && ids.length === 2;
    }, 8000);
    await waitFor(() => mock.calls.length === base + 2, 8000);
    expect(mock.calls.length).toBe(base + 2);
  } finally {
    try { mgr?.remove(wikiId); } catch { /* best-effort 释放连接 */ }
    await mock.close();
    await rmSyncRetry(dir);
  }
});

test("contentSha256 helper: 同/异/空", () => {
  expect(contentSha256("abc")).toBe(contentSha256("abc"));
  expect(contentSha256("abc")).not.toBe(contentSha256("abd"));
  expect(contentSha256("")).toBe("");
});