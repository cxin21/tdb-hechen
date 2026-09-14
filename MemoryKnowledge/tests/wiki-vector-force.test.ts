/**
 * writeVectors force 全量重建（spec §6.2）：
 * - forceRevectorizeAll() 绕过 content_sha 复用，内容未变的页面也重新 embed；
 * - 重建状态透出：vectorStatus() 在完成后为 done。
 *
 * 引擎搭建方式复用 tests/wiki-vector-write.test.ts（临时目录 + mock embedding HTTP 服务 +
 * register 触发异步 writeVectors + 轮询 wiki_vec 行数）；两文件不互相 import 私有函数。
 */
import { test, expect } from "vitest";
import Database from "better-sqlite3";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWikiSourceManager } from "../src/engines/wiki/manager.js";
import { loadVecExtension } from "../src/engines/wiki/index-db.js";

/** 本地 mock embedding 服务：任意输入返回固定 3 维向量，并统计请求次数（embed 调用计数）。 */
function startCountingMockEmbed(): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      n++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [0.5, 0.5, 0.5] }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        count: () => n,
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

test("forceRevectorizeAll 绕过 content_sha 复用，内容未变的页面也重新 embed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wikivec-force-"));
  const wikiId = "wkf-" + Math.random().toString(36).slice(2); // 唯一 id，避免多测试共享 read 池
  mkdirSync(join(dir, "wiki"), { recursive: true });
  // 内容页：type=entity（非结构页，应被嵌入）
  writeFileSync(join(dir, "wiki", "alpha.md"), "---\ntype: entity\ntitle: Alpha\n---\n\nalpha meaning", "utf-8");

  const mock = await startCountingMockEmbed();
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

    await waitForVecRows(join(dir, "index.db"), 1);
    await new Promise((r) => setTimeout(r, 200)); // 让异步 writeVectors 跑完，计数稳定
    const callsAfterFirst = mock.count();
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1); // 首次写入确实发生了 embed

    // force 全量重建：内容零变化，但必须绕过 content_sha 复用重新 embed
    // （F3：返回 boolean —— true=本次调用真正启动了新一轮）
    expect(await mgr.forceRevectorizeAll()).toBe(true);

    expect(mock.count()).toBeGreaterThan(callsAfterFirst); // force 绕过 sha 复用
    expect(mgr.vectorStatus().status).toBe("done"); // 状态透出：完成后 done
    // 向量仍在库（重建不丢数据）
    const db = new Database(join(dir, "index.db"));
    try {
      loadVecExtension(db);
      const rows = db.prepare("SELECT page_id FROM wiki_vec").all() as Array<{ page_id: string }>;
      expect(rows).toEqual([{ page_id: "alpha" }]);
    } finally {
      db.close();
    }
  } finally {
    try { mgr?.remove(wikiId); } catch { /* best-effort：释放 read 连接以便删除 index.db（Windows 锁） */ }
    await mock.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 竞态，容忍 */ }
  }
});

// ── fix round（review findings #1/#2）─────────────────────────────────────────

/** 每次请求都失败（500）的 mock embedding 服务，统计请求次数。 */
function startFailingMockEmbed(): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      n++;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "embedding down" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        count: () => n,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** 奇数次请求失败、偶数次成功的 mock（用于构造 partial：部分页 embed 失败、部分成功）。 */
function startFlakyMockEmbed(): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      n++;
      if (n % 2 === 1) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "embedding flaky" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ embedding: [0.5, 0.5, 0.5] }] }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        count: () => n,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * 请求被闸门扣住（release 前永不响应）的 mock：用于模拟"第一次重建运行中"。
 */
function startGatedMockEmbed(): Promise<{ url: string; count: () => number; release: () => void; close: () => Promise<void> }> {
  let n = 0;
  let released = false;
  let gateResolve: () => void = () => {};
  const gate = new Promise<void>((r) => { gateResolve = r; });
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      n++;
      (released ? Promise.resolve() : gate).then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ embedding: [0.5, 0.5, 0.5] }] }));
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        count: () => n,
        release: () => { released = true; gateResolve(); },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** 轮询直到 cond 为真（timeout 抛错）。 */
async function waitFor(cond: () => boolean, timeoutMs = 4000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）：${what}`);
}

/** 轮询 mock embedding 请求计数达到 expected（register/force 的异步 embed 已发起）。 */
async function waitForEmbedCount(mock: { count: () => number }, expected: number, timeoutMs = 4000): Promise<void> {
  await waitFor(() => mock.count() >= expected, timeoutMs, `embed count >= ${expected}`);
}

test("force 重建全部页 embed 失败 → vectorStatus=failed 且不写指纹", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wikivec-forcefail-"));
  const wikiId = "wkff-" + Math.random().toString(36).slice(2);
  mkdirSync(join(dir, "wiki"), { recursive: true });
  writeFileSync(join(dir, "wiki", "alpha.md"), "---\ntype: entity\ntitle: Alpha\n---\n\nalpha meaning", "utf-8");

  const mock = await startFailingMockEmbed();
  let mgr: ReturnType<typeof createWikiSourceManager> | undefined;
  try {
    mgr = createWikiSourceManager(join(dir, "_engine"), {
      provider: "openai_compatible",
      baseUrl: mock.url,
      apiKey: "k",
      model: "m",
      dimensions: 3,
    });
    const fpFile = join(dir, "_engine", "embedding-fingerprint.json");
    expect(existsSync(fpFile)).toBe(true); // 启动采纳指纹已写入
    // 覆盖为陈旧旧值：让"失败路径绝不写新指纹"成为可真断言（而非写回同值）
    writeFileSync(fpFile, JSON.stringify({ fingerprint: "stale|old|1" }), "utf-8");

    const state = mgr.register({ name: wikiId, path: dir });
    expect(state.status).toBe("ready");
    await waitForEmbedCount(mock, 1); // register 的异步 writeVectors 已发起 embed（将失败）
    await new Promise((r) => setTimeout(r, 200)); // 让异步 writeVectors 跑完

    await mgr.forceRevectorizeAll();

    // 失败必须可见：状态 failed（不得走成功分支置 done）
    const status = mgr.vectorStatus();
    expect(status.status).toBe("failed");
    expect(status.reason).toBeTruthy();
    // 指纹保持旧值：失败路径不写新指纹 → 下次重启重新检测并重跑（防半新半旧混存）
    const stored = (JSON.parse(readFileSync(fpFile, "utf-8")) as { fingerprint?: string }).fingerprint;
    expect(stored).toBe("stale|old|1");
  } finally {
    try { mgr?.remove(wikiId); } catch { /* best-effort */ }
    await mock.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 竞态，容忍 */ }
  }
});

test("force 重建部分页失败（仍有成功嵌入）→ 保守裁决：failed 且不写指纹", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wikivec-forcepart-"));
  const wikiId = "wkfp-" + Math.random().toString(36).slice(2);
  mkdirSync(join(dir, "wiki"), { recursive: true });
  writeFileSync(join(dir, "wiki", "alpha.md"), "---\ntype: entity\ntitle: Alpha\n---\n\nalpha meaning", "utf-8");
  writeFileSync(join(dir, "wiki", "beta.md"), "---\ntype: entity\ntitle: Beta\n---\n\nbeta meaning", "utf-8");

  const mock = await startFlakyMockEmbed(); // 奇数请求失败、偶数成功
  let mgr: ReturnType<typeof createWikiSourceManager> | undefined;
  try {
    mgr = createWikiSourceManager(join(dir, "_engine"), {
      provider: "openai_compatible",
      baseUrl: mock.url,
      apiKey: "k",
      model: "m",
      dimensions: 3,
    });
    const fpFile = join(dir, "_engine", "embedding-fingerprint.json");
    writeFileSync(fpFile, JSON.stringify({ fingerprint: "stale|old|1" }), "utf-8");

    const state = mgr.register({ name: wikiId, path: dir });
    expect(state.status).toBe("ready");
    // register 写入：alpha(奇=失败) + beta(偶=成功) → wiki_vec 恰 1 行即异步写入已完成
    await waitForVecRows(join(dir, "index.db"), 1);

    await mgr.forceRevectorizeAll(); // force: alpha(奇=失败) + beta(偶=成功) → partial

    // 保守裁决（防混存）：只要有 failed 就不写指纹、状态置 failed（reason 注明 partial）
    const status = mgr.vectorStatus();
    expect(status.status).toBe("failed");
    expect(status.reason).toContain("partial");
    const stored = (JSON.parse(readFileSync(fpFile, "utf-8")) as { fingerprint?: string }).fingerprint;
    expect(stored).toBe("stale|old|1");
  } finally {
    try { mgr?.remove(wikiId); } catch { /* best-effort */ }
    await mock.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 竞态，容忍 */ }
  }
});

test("running 期间二次 forceRevectorizeAll 被拒（重入守卫）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wikivec-forcerentry-"));
  const wikiId = "wkfr-" + Math.random().toString(36).slice(2);
  mkdirSync(join(dir, "wiki"), { recursive: true });
  writeFileSync(join(dir, "wiki", "alpha.md"), "---\ntype: entity\ntitle: Alpha\n---\n\nalpha meaning", "utf-8");

  const mock = await startGatedMockEmbed(); // release 前所有 embed 挂起
  let mgr: ReturnType<typeof createWikiSourceManager> | undefined;
  try {
    mgr = createWikiSourceManager(join(dir, "_engine"), {
      provider: "openai_compatible",
      baseUrl: mock.url,
      apiKey: "k",
      model: "m",
      dimensions: 3,
    });
    mgr.register({ name: wikiId, path: dir });
    await waitForEmbedCount(mock, 1); // register 的异步 writeVectors 已挂起在 embed 上

    const first = mgr.forceRevectorizeAll(); // 不 await：第一次重建进入 running 并挂起
    await waitFor(() => mgr!.vectorStatus().status === "running");
    await waitForEmbedCount(mock, 2); // 第一次重建的 writeVectors 已发起 embed（挂起）
    const startedAt = mgr.vectorStatus().startedAt;
    const countBefore = mock.count();

    // 第二次调用：running 期间必须被守卫拒绝、立即返回（F3：诚实返回 false=被守卫拒绝）
    expect(await mgr.forceRevectorizeAll()).toBe(false);

    expect(mock.count()).toBe(countBefore); // 未发起新 embed（重复重建未启动）
    expect(mgr.vectorStatus().status).toBe("running"); // 状态未被第二次调用改写
    expect(mgr.vectorStatus().startedAt).toBe(startedAt);

    mock.release();
    expect(await first).toBe(true); // 第一次重建真正启动 → true
    expect(mgr.vectorStatus().status).toBe("done");
  } finally {
    try { mgr?.remove(wikiId); } catch { /* best-effort */ }
    await mock.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 竞态，容忍 */ }
  }
});

// ── F4：指纹文件损坏判别（终审修复）──────────────────────────────────────────

test("指纹文件损坏（JSON.parse 失败）→ 启动检测视为不一致并触发重建（F4）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wikivec-fpcorrupt-"));
  const wikiId = "wkpc-" + Math.random().toString(36).slice(2);
  mkdirSync(join(dir, "wiki"), { recursive: true });
  writeFileSync(join(dir, "wiki", "alpha.md"), "---\ntype: entity\ntitle: Alpha\n---\n\nalpha meaning", "utf-8");

  const mock = await startCountingMockEmbed();
  // 预置持久化状态：引擎 dataDir 内先有 ready wiki 源 + 损坏的指纹文件
  // （损坏 ≠ 缺失：旧行为把解析失败当 undefined 走"首次启用采纳"路径，静默不重建）
  const engineDir = join(dir, "_engine");
  mkdirSync(engineDir, { recursive: true });
  writeFileSync(join(engineDir, "wiki-sources.json"), JSON.stringify({ [wikiId]: { name: wikiId, path: dir, status: "ready" } }), "utf-8");
  writeFileSync(join(engineDir, "embedding-fingerprint.json"), "{corrupt-json!!!", "utf-8");

  let mgr: ReturnType<typeof createWikiSourceManager> | undefined;
  try {
    mgr = createWikiSourceManager(engineDir, {
      provider: "openai_compatible",
      baseUrl: mock.url,
      apiKey: "k",
      model: "m",
      dimensions: 3,
    });
    // 损坏指纹必须视为指纹不一致 → 触发 force 重建（vectorStatus 进入 done）
    await waitFor(() => mgr!.vectorStatus().status === "done", 6000, "vectorStatus done after corrupt fingerprint");
    expect(mock.count()).toBeGreaterThanOrEqual(2); // restore 增量 1 次 + force 重建 ≥ 1 次
    // 重建完成后指纹文件恢复为合法 JSON 且记录当前指纹（provider|model|dimensions）
    const stored = JSON.parse(readFileSync(join(engineDir, "embedding-fingerprint.json"), "utf-8")) as { fingerprint?: string };
    expect(stored.fingerprint).toBe("openai_compatible|m|3");
  } finally {
    try { mgr?.remove(wikiId); } catch { /* best-effort：释放 read 连接以便删除 index.db（Windows 锁） */ }
    await mock.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 竞态，容忍 */ }
  }
});
