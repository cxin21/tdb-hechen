/**
 * task-73 · core wiki 薄转发（/v3/wiki/{list,search}）隔离实例活体验证（core-ops-b）
 * ---------------------------------------------------------------------------
 * 单测证明 handler 契约，不证明「yaml/env -> config -> client -> upstream -> 响应」这条装配链。
 * 本脚本起一台完全隔离的 gateway 第二实例（scratch/core-iso-wiki/data + 8498 端口），
 * 并在 8497 起一个 8421 形状的**桩上游**（无生产凭据也能确定性验证），断言：
 *
 *   A. 发现面：yaml memory.wiki.baseUrl 生效 -> /v3/wiki/list 直连桩上游，返回三条 wiki
 *   B. 检索面：跨 wiki 按 absScore 合并排序；不可读 wiki 进 meta.skipped 且不发检索
 *   C. 契约面：body.team_id 与 x-tdai-team-id 不一致 -> 400 WIKI_TEAM_MISMATCH（不静默）
 *   D. 隔离面：生效 config 打印 port=8498 / baseDir=scratch/core-iso-wiki/data /
 *      memory.wiki 六项取值来自 yaml；8420 前后各探一次 /health 均 200（未被重启）
 *
 * 跑法：cd MemoryCore && node --import tsx scripts/verify-core-wiki.ts [port]
 * 退出码：全部 PASS=0，有 FAIL=1。
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ISO_DIR = path.join(REPO, "scratch", "core-iso-wiki");
const DATA_DIR = path.join(ISO_DIR, "data");
const CONFIG_PATH = path.join(ISO_DIR, "config.yaml");
const PORT = Number(process.env.ISO_PORT ?? process.argv[2] ?? 8498);
const STUB_PORT = PORT + 1;
const HOST = "127.0.0.1";
const KEY = "iso-task73-local-only-key";
const BASE = "http://" + HOST + ":" + PORT;
const PROD_BASE = "http://127.0.0.1:8420";
const SERVICE = "iso-service";

process.env.TDAI_GATEWAY_CONFIG = CONFIG_PATH;
process.env.TDAI_METADATA_SQLITE_BASE_DIR = path.join(DATA_DIR, "metadata");

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(
  CONFIG_PATH,
  [
    "server:",
    "  port: " + PORT,
    "  host: " + HOST,
    "memory:",
    "  embedding:",
    "    provider: none",
    "    enabled: false",
    "  wiki:",
    "    enabled: true",
    "    baseUrl: http://" + HOST + ":" + STUB_PORT,
    "    teamVerify: off",
    "    topK: 5",
    "    perWikiLimit: 3",
    "    minScore: 0.02",
    "",
  ].join("\n"),
  "utf-8",
);

type Check = { id: string; ok: boolean; note: string };
const checks: Check[] = [];
const log = (...a: unknown[]) => console.log(...a);
function record(id: string, ok: boolean, note: string): void {
  checks.push({ id, ok, note });
  log("  " + (ok ? "PASS" : "FAIL") + " [" + id + "] " + note);
}
const section = (t: string) => log("\n──────── " + t + " ────────");

// ── 桩上游：8421 形状（/v3/wiki/list + /v3/wiki/search）──────────────────────
const WIKIS = [
  { wiki_id: "wiki-a", name: "scm-standards", page_count: 50, status: "ready", last_sync_at: "2026-10-30T02:00:00Z" },
  { wiki_id: "wiki-b", name: "scm-recipes", page_count: 686, status: "ready", last_sync_at: "2026-10-31T01:00:00Z" },
  { wiki_id: "wiki-c", name: "scm-business-analysis", page_count: 12, status: "failed", last_sync_at: null },
];
const SEARCH: Record<string, Record<string, unknown>[]> = {
  "wiki-a": [
    { path: "standards/a.md", title: "A 标准", snippet: "...", score: 0.9, absScore: 0.31 },
    { path: "standards/shared.md", title: "共享", snippet: "...", score: 0.8, absScore: 0.44 },
  ],
  "wiki-b": [
    { path: "recipes/b.md", title: "B 配方", snippet: "...", score: 0.95, absScore: 0.52 },
    { path: "recipes/shared.md", title: "共享", snippet: "...", score: 0.7, absScore: 0.6 },
  ],
};
const seenSearches: string[] = [];
const stub = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf-8");
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* ignore */ }
    const send = (payload: unknown) => {
      const text = JSON.stringify(payload);
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
      res.end(text);
    };
    if (req.url?.includes("/v3/wiki/list")) {
      send({ code: 0, message: "ok", data: { items: WIKIS, total: WIKIS.length } });
      return;
    }
    if (req.url?.includes("/v3/wiki/search")) {
      const id = String(body.wiki_id ?? "");
      seenSearches.push(id);
      const results = SEARCH[id] ?? [];
      send({ code: 0, message: "ok", data: { results, links: [], count: results.length } });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 404, message: "not found" }));
  });
});
await new Promise<void>((r) => stub.listen(STUB_PORT, HOST, r));
log("  桩上游 8421 形状：http://" + HOST + ":" + STUB_PORT);

// ── HTTP 客户端 ─────────────────────────────────────────────────────────────
type Resp = { status: number; text: string; json: any };
function request(method: string, pathname: string, body?: unknown, base = BASE, headers: Record<string, string> = {}): Promise<Resp> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf-8");
  const h: Record<string, string> = { accept: "application/json", authorization: "Bearer " + KEY, ...headers };
  if (payload) {
    h["content-type"] = "application/json";
    h["content-length"] = String(payload.length);
  }
  const url = new URL(pathname, base);
  return new Promise((resolve) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: h, agent: false, timeout: 60000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        let json: any;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ status: 0, text: e.name + ": " + e.message, json: undefined }));
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 生产基线 ────────────────────────────────────────────────────────────────
section("0. 生产实例基线（8420，只读 /health）");
const prodBefore = await request("GET", "/health", undefined, PROD_BASE, { authorization: "" });
log("  GET 8420/health -> " + prodBefore.status);
record("P-8420-alive-before", prodBefore.status === 200, "status=" + prodBefore.status);

const { TdaiGateway } = await import("../src/gateway/server.js");
const { loadGatewayConfig } = await import("../src/gateway/config.js");

const effective = loadGatewayConfig({ server: { port: PORT, host: HOST, apiKey: KEY }, data: { baseDir: DATA_DIR } });
const wikiCfg = (effective as any).memory?.wiki;
section("1. 生效配置（yaml -> config 装配链）");
log("  config file :", CONFIG_PATH);
log("  memory.wiki :", JSON.stringify(wikiCfg));
record(
  "C-wiki-from-yaml",
  !!wikiCfg && wikiCfg.baseUrl === "http://" + HOST + ":" + STUB_PORT && wikiCfg.topK === 5 && wikiCfg.perWikiLimit === 3,
  "baseUrl=" + String(wikiCfg?.baseUrl) + " topK=" + String(wikiCfg?.topK) + " perWikiLimit=" + String(wikiCfg?.perWikiLimit),
);

section("2. 起隔离实例 8498");
const gateway = new TdaiGateway({ server: { port: PORT, host: HOST, apiKey: KEY }, data: { baseDir: DATA_DIR } });
await gateway.start();
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  const r = await request("GET", "/health", undefined, BASE, { authorization: "" });
  ready = r.status === 200;
  if (!ready) await sleep(250);
}
record("S-start", ready, "listen=" + BASE + " ready=" + ready);
if (!ready) {
  await gateway.stop().catch(() => undefined);
  stub.close();
  process.exit(1);
}

try {
  section("3. 发现面 /v3/wiki/list（直连桩上游，不落 core 注册表）");
  const list = await request("POST", "/v3/wiki/list", { team_id: "iso-team-wiki" }, BASE, { "x-tdai-service-id": SERVICE, "x-tdai-team-id": "iso-team-wiki" });
  log("  -> " + list.status + " " + list.text.slice(0, 500));
  record("W-list-200", list.status === 200 && list.json?.code === 0, "status=" + list.status + " code=" + String(list.json?.code));
  const wikis = list.json?.data?.wikis ?? [];
  // meta.source 语义：knowledge = 8421 知识服务直连成功；core_registry = 8421 不可用回落 core 注册表。
  record("W-list-source-upstream", list.json?.data?.meta?.source === "knowledge", "meta.source=" + String(list.json?.data?.meta?.source));
  record(
    "W-list-readiness",
    wikis.length === 3 && wikis[0].ready === true && wikis[2].ready === false,
    "wikis=" + JSON.stringify(wikis.map((w: any) => [w.wikiId, w.ready])),
  );

  section("4. 检索面 /v3/wiki/search（absScore 合并 + 不可读跳过）");
  const s = await request("POST", "/v3/wiki/search", { query: "供应商准入", team_id: "iso-team-wiki", top_k: 5 }, BASE, { "x-tdai-service-id": SERVICE, "x-tdai-team-id": "iso-team-wiki" });
  log("  -> " + s.status + " " + s.text.slice(0, 700));
  const hits = s.json?.data?.results ?? [];
  record("W-search-200", s.status === 200 && s.json?.code === 0, "status=" + s.status);
  record(
    "W-search-absScore-order",
    hits.length === 4 && hits.map((h: any) => h.absScore).join(",") === "0.6,0.52,0.44,0.31",
    "absScores=" + hits.map((h: any) => h.absScore).join(","),
  );
  record(
    "W-search-same-path-kept",
    hits.filter((h: any) => String(h.path).endsWith("shared.md")).length === 2,
    "shared.md 两条分别来自 wiki-a/wiki-b（去重键含 wikiId）",
  );
  record(
    "W-search-skip-unreadable",
    (s.json?.data?.meta?.skipped ?? []).some((x: any) => x.wikiId === "wiki-c"),
    "meta.skipped=" + JSON.stringify(s.json?.data?.meta?.skipped),
  );
  record("W-search-no-request-to-unreadable", !seenSearches.includes("wiki-c"), "上游收到的 wiki_id=" + JSON.stringify(seenSearches));

  section("5. 契约面：team 头不一致 -> 400（不静默）");
  const mm = await request("POST", "/v3/wiki/list", { team_id: "team-x" }, BASE, { "x-tdai-service-id": SERVICE, "x-tdai-team-id": "team-y" });
  log("  -> " + mm.status + " " + mm.text.slice(0, 300));
  record("W-team-mismatch-400", mm.status === 400 && mm.json?.code === 400, "status=" + mm.status + " code=" + String(mm.json?.code) + " error=" + String(mm.json?.message));

  section("6. 8420 存活复查");
  const prodAfter = await request("GET", "/health", undefined, PROD_BASE, { authorization: "" });
  log("  GET 8420/health -> " + prodAfter.status);
  record("P-8420-alive-after", prodAfter.status === 200, "status=" + prodAfter.status);
} finally {
  await gateway.stop().catch(() => undefined);
  await new Promise<void>((r) => stub.close(() => r()));
}

const failed = checks.filter((c) => !c.ok);
log("\n──────── 汇总 ────────");
log("  " + checks.length + " checks, " + failed.length + " failed");
const out = { runAt: new Date().toISOString(), port: PORT, checks };
fs.mkdirSync(ISO_DIR, { recursive: true });
fs.writeFileSync(path.join(ISO_DIR, "verify-result.json"), JSON.stringify(out, null, 2), "utf-8");
process.exit(failed.length === 0 ? 0 : 1);
