/**
 * task-39 · 隔离实例活体验证（core-ops-b）
 * ---------------------------------------------------------------------------
 * 目的：单测证明模块，不证明「env/yaml -> config -> handler -> 响应」这条装配链。
 * 本脚本起一台完全隔离的 gateway 第二实例（临时 baseDir + 8499 端口），
 * 用真 HTTP + 真磁盘断言验证三条今天改过的链路：
 *
 *   A. 413 可诊断性（MAX_BODY_BYTES 字节墙：1.2MB -> HTTP 413 + JSON，不是 ECONNRESET）
 *   B. skill /v3/skill/conversation/add 入口幂等（第二次 duplicate_skipped，buffer 不涨）
 *   C. L0 /v3/conversation/add 幂等（第二次 accepted_ids: []，库里行数不增）
 *
 * 隔离不变量（脚本自己断言，不信口头承诺）：
 *   - 生效配置来自 scratch/core-iso/config.yaml + 构造期 overrides；断言 port=8499、
 *     baseDir=scratch/core-iso/data、embedding.provider=none/enabled=false
 *   - 8420 生产实例不受影响：脚本前后各探一次 8420/health，两次都 200 即证明它是另一个进程
 *   - D:/TDB/data 不写入：生效 baseDir 与其不等 + 本进程所有落盘都在 scratch/core-iso/data 下
 *     （8420 并发写同一目录，故不以 mtime 作「未变」证据）
 *
 * 跑法：
 *   cd MemoryCore && node --import tsx scripts/verify-core-live.ts [port]
 * 退出码：全部 PASS=0，有 FAIL=1。
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // MemoryCore/scripts
const REPO = path.resolve(HERE, "..", "..");
const ISO_DIR = path.join(REPO, "scratch", "core-iso");
const DATA_DIR = path.join(ISO_DIR, "data");
const CONFIG_PATH = path.join(ISO_DIR, "config.yaml");
const PORT = Number(process.env.ISO_PORT ?? process.argv[2] ?? 8499);
const HOST = "127.0.0.1";
const KEY = "iso-task39-local-only-key";
const BASE = "http://" + HOST + ":" + PORT;
const PROD_BASE = "http://127.0.0.1:8420";
const RUN = Date.now().toString(36);
const NS = { team: "iso-team", agent: "iso-agent", user: "iso-user" };
const SERVICE = "iso-service";

// ── 隔离前置：强制本进程的配置/元数据/env 路径，删掉可能污染结论的变量 ─────────
if (!CONFIG_PATH.startsWith(ISO_DIR)) throw new Error("config path escaped scratch/core-iso");
if (!DATA_DIR.startsWith(ISO_DIR)) throw new Error("data path escaped scratch/core-iso");
process.env.TDAI_GATEWAY_CONFIG = CONFIG_PATH;
process.env.TDAI_METADATA_SQLITE_BASE_DIR = path.join(DATA_DIR, "metadata");
delete process.env.MEMORY_MAX_BODY_BYTES; // 用代码缺省 1 MiB，使 413 判据确定

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

type Check = { id: string; ok: boolean; note: string };
const checks: Check[] = [];
function log(...a: unknown[]): void { console.log(...a); }
function record(id: string, ok: boolean, note: string): void {
  checks.push({ id, ok, note });
  log("  " + (ok ? "PASS" : "FAIL") + " [" + id + "] " + note);
}
function section(title: string): void {
  log("\n──────── " + title + " ────────");
}

const { TdaiGateway } = await import("../src/gateway/server.js");
const { loadGatewayConfig } = await import("../src/gateway/config.js");
const { resolveMaxBodyBytes } = await import("../src/utils/env-config.js");

// ── 生效配置（这条就是「env/yaml -> config」链的活体证据）─────────────────────
const effective = loadGatewayConfig({
  server: { port: PORT, host: HOST, apiKey: KEY },
  data: { baseDir: DATA_DIR },
});
const limitBytes = resolveMaxBodyBytes();
const embCfg = (effective as unknown as { memory: { embedding: { enabled: boolean; provider: string } } })
  .memory.embedding;

section("0. 生效配置（隔离不变量）");
log("  config file        :", CONFIG_PATH);
log("  server.port        :", effective.server.port);
log("  server.host        :", effective.server.host);
log("  data.baseDir       :", effective.data.baseDir);
log("  memory.embedding   :", JSON.stringify({ enabled: embCfg.enabled, provider: embCfg.provider }));
log("  MAX_BODY_BYTES     :", limitBytes, "(1 MiB = 1048576)");
record("C0-port", effective.server.port === PORT, "server.port=" + effective.server.port + " 期望 " + PORT);
record(
  "C0-base-dir",
  path.resolve(effective.data.baseDir) === path.resolve(DATA_DIR),
  "data.baseDir=" + effective.data.baseDir,
);
record("C0-embedding", embCfg.provider === "none" && embCfg.enabled === false, "provider=" + embCfg.provider + " enabled=" + String(embCfg.enabled));
record("C0-body-limit", limitBytes === 1048576, "MAX_BODY_BYTES=" + limitBytes);

// ── HTTP 工具 ────────────────────────────────────────────────────────────────
type Resp = { status: number; headers: http.IncomingHttpHeaders; text: string; ms: number; json?: any };
function request(
  method: string,
  pathname: string,
  body?: string | Buffer,
  opts: { auth?: boolean; serviceId?: string; base?: string } = {},
): Promise<Resp> {
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
  const headers: Record<string, string> = { accept: "application/json" };
  if (payload) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.length);
  }
  if (opts.auth !== false) headers["authorization"] = "Bearer " + KEY;
  if (opts.serviceId) headers["x-tdai-service-id"] = opts.serviceId;
  const url = new URL(pathname, opts.base ?? BASE);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, agent: false, timeout: 60000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json: unknown;
          try { json = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, ms: Date.now() - t0, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("client timeout 60s")));
    req.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ status: 0, headers: {}, text: err.name + ": " + err.message + " code=" + String(err.code), ms: Date.now() - t0 });
    });
    if (payload) req.write(payload);
    req.end();
  });
}
const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const clip = (s: string, n = 700) => (s.length <= n ? s : s.slice(0, n) + "…[+" + (s.length - n) + " chars]");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitReady(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await request("GET", "/health", undefined, { auth: false });
    if (r.status === 200) return true;
    await sleep(250);
  }
  return false;
}

// ── 生产实例基线（证明我们没动 8420）────────────────────────────────────────
section("1. 生产实例基线（8420，只读 /health）");
const prodBefore = await request("GET", "/health", undefined, { auth: false, base: PROD_BASE });
log("  GET " + PROD_BASE + "/health -> " + prodBefore.status + " " + clip(prodBefore.text, 240));
record("P-8420-alive-before", prodBefore.status === 200, "status=" + prodBefore.status);

// ── 起隔离实例 ──────────────────────────────────────────────────────────────
section("2. 起隔离实例");
const gateway = new TdaiGateway({
  server: { port: PORT, host: HOST, apiKey: KEY },
  data: { baseDir: DATA_DIR },
});
const tStart = Date.now();
await gateway.start();
const ready = await waitReady();
record("S-start", ready, "listen=" + BASE + " ready=" + ready + " startMs=" + (Date.now() - tStart));
if (!ready) {
  log("  实例未就绪，输出磁盘清单：", fs.readdirSync(DATA_DIR));
  await gateway.stop().catch(() => undefined);
  process.exit(1);
}

const health0 = await request("GET", "/health", undefined, { auth: false });
log("  GET /health -> " + health0.status + " " + clip(health0.text, 900));
const h0 = health0.json ?? {};
record("S-health-vector-store", health0.status === 200 && !!h0?.stores?.vectorStore, "stores=" + JSON.stringify(h0?.stores));
record(
  "S-health-embedding-noop",
  h0?.memory?.embedding === "degraded" && h0?.memory?.embeddingConfigured === false,
  "memory.embedding=" + JSON.stringify({ status: h0?.memory?.embedding, configured: h0?.memory?.embeddingConfigured, provider: h0?.memory?.embeddingProvider }),
);
record(
  "S-health-noop-not-counted",
  h0?.stores?.embeddingService === false,
  "stores.embeddingService=" + String(h0?.stores?.embeddingService) + "（#123：noop 不算可用 embedding）",
);

// ── A. 413 可诊断性 ─────────────────────────────────────────────────────────
section("A. 413 可诊断性（1 MiB 字节墙）");
const l0OkSession = "iso-" + RUN + "-l0-500k";
const okBody = JSON.stringify({
  session_id: l0OkSession,
  team_id: NS.team,
  agent_id: NS.agent,
  user_id: NS.user,
  messages: Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: (i + ":").padEnd(8192, "a"),
    timestamp: new Date().toISOString(),
  })),
});
log("  A1 body=" + Buffer.byteLength(okBody) + " bytes（60 条 x 8192 字符，schema 内）");
const a1 = await request("POST", "/v3/conversation/add", okBody, { serviceId: SERVICE });
log("  A1 POST /v3/conversation/add -> " + a1.status + " in " + a1.ms + "ms " + clip(a1.text, 300));
record("A1-under-limit-200", a1.status === 200 && a1.json?.code === 0, "status=" + a1.status + " code=" + a1.json?.code);

const overSession = "iso-" + RUN + "-l0-1.2m";
const overBody = JSON.stringify({
  session_id: overSession,
  team_id: NS.team,
  agent_id: NS.agent,
  user_id: NS.user,
  messages: Array.from({ length: 100 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: (i + ":").padEnd(13000, "b"),
    timestamp: new Date().toISOString(),
  })),
});
log("  A2 body=" + Buffer.byteLength(overBody) + " bytes（100 条 x 13000 字符 -> 超 1 MiB）");
const a2 = await request("POST", "/v3/conversation/add", overBody, { serviceId: SERVICE });
log("  A2 POST /v3/conversation/add -> " + a2.status + " in " + a2.ms + "ms");
log("  A2 response headers: " + JSON.stringify({ connection: a2.headers.connection, "content-type": a2.headers["content-type"], "content-length": a2.headers["content-length"] }));
log("  A2 response body   : " + a2.text);
const a2j = a2.json ?? {};
// 实测口径（与 task-36 单测的差异，见报告 P2）：/v3 走 v2-router 自己的 catch，
// 响应是 {code:413,message,request_id,trace_id,retryable:false}；limitBytes/hint 只有
// server.ts 顶层 catch 才加（非 v2 路径）。字节墙本身已可诊断：message 里带 1048576。
record(
  "A2-413-json",
  a2.status === 413 &&
    a2j?.code === 413 &&
    a2j?.retryable === false &&
    typeof a2j?.message === "string" &&
    a2j.message.includes("1048576"),
  "status=" + a2.status + " body=" + clip(a2.text, 400),
);
record(
  "A2-detail-fields",
  a2j?.limitBytes === undefined && a2j?.hint === undefined,
  "/v3 的 413 不带 limitBytes/hint（v2-router.ts:769-779 自建 envelope）；已在报告记为 P2 后续票",
);
record("A2-not-econnreset", a2.status !== 0, "status=" + a2.status + "（0 才是 ECONNRESET/断连）");
record("A2-connection-close", String(a2.headers.connection ?? "").toLowerCase() === "close", "connection=" + String(a2.headers.connection));

const healthAfter413 = await request("GET", "/health", undefined, { auth: false });
record("A3-alive-after-413", healthAfter413.status === 200, "GET /health -> " + healthAfter413.status);

// ── B. skill 入口幂等 ───────────────────────────────────────────────────────
section("B. skill conversation/add 幂等");
const skillSession = "iso-" + RUN + "-skill";
const skillPayload = JSON.stringify({
  session_id: skillSession,
  space_id: SERVICE,
  team_id: NS.team,
  agent_id: NS.agent,
  user_id: NS.user,
  messages: [
    { role: "user", content: "iso probe user turn " + RUN, timestamp: Date.now() },
    { role: "assistant", content: "iso probe assistant turn " + RUN, timestamp: Date.now() },
    { role: "tool_call", content: "read_file(\"/iso/probe.txt\")", timestamp: Date.now(), tool_name: "read_file", tool_call_id: "call-iso-1" },
    { role: "tool_result", content: "iso file body", timestamp: Date.now(), tool_call_id: "call-iso-1" },
  ],
});
const skillDir = path.join(DATA_DIR, "skill_buffer", NS.user, NS.team, NS.agent, skillSession);
const currentFile = path.join(skillDir, "data-current.jsonl");
const metaFile = path.join(skillDir, "meta.json");
function readSnap() {
  const exists = fs.existsSync(skillDir);
  const currentRaw = fs.existsSync(currentFile) ? fs.readFileSync(currentFile) : null;
  const metaRaw = fs.existsSync(metaFile) ? fs.readFileSync(metaFile) : null;
  return {
    dir: exists,
    currentBytes: currentRaw ? currentRaw.length : -1,
    currentHash: currentRaw ? sha(currentRaw) : "-",
    metaBytes: metaRaw ? metaRaw.length : -1,
    metaHash: metaRaw ? sha(metaRaw) : "-",
    messages: currentRaw ? ((JSON.parse(currentRaw.toString("utf-8")) as { messages?: unknown[] }).messages?.length ?? -1) : -1,
    meta: metaRaw ? (JSON.parse(metaRaw.toString("utf-8")) as Record<string, unknown>) : null,
  };
}

const b1 = await request("POST", "/v3/skill/conversation/add", skillPayload, { serviceId: SERVICE });
log("  B1 first  POST -> " + b1.status + " " + clip(b1.text, 300));
const snap1 = readSnap();
log("  B1 disk: messages=" + snap1.messages + " tool_call_count=" + String(snap1.meta?.tool_call_count) + " byte_count=" + String(snap1.meta?.byte_count) + " currentBytes=" + snap1.currentBytes + " metaBytes=" + snap1.metaBytes);
record("B1-first-ok", b1.status === 200 && (b1.json?.code === 0 || b1.json?.code === undefined), "status=" + b1.status + " body=" + clip(b1.text, 200));

const b2 = await request("POST", "/v3/skill/conversation/add", skillPayload, { serviceId: SERVICE });
log("  B2 replay POST -> " + b2.status + " " + clip(b2.text, 300));
const snap2 = readSnap();
const skipped = b2.json?.data?.duplicate_skipped ?? b2.json?.duplicate_skipped;
record(
  "B2-duplicate-skipped",
  b2.status === 200 && Number(skipped) === 4,
  "duplicate_skipped=" + String(skipped) + "（期望 4）status=" + b2.status,
);
record(
  "B3-buffer-unchanged",
  snap1.messages === 4 && snap2.messages === 4 && snap1.currentHash === snap2.currentHash,
  "messages " + snap1.messages + "->" + snap2.messages + " currentHash " + snap1.currentHash + "->" + snap2.currentHash + " bytes " + snap1.currentBytes + "->" + snap2.currentBytes,
);
record(
  "B4-counters-unchanged",
  snap1.metaHash === snap2.metaHash && snap2.meta?.tool_call_count === 1 && Number(snap2.meta?.byte_count) === Number(snap1.meta?.byte_count),
  "metaHash " + snap1.metaHash + "->" + snap2.metaHash + " tool_call_count=" + String(snap2.meta?.tool_call_count) + " byte_count=" + String(snap2.meta?.byte_count),
);

// ── C. L0 幂等 ─────────────────────────────────────────────────────────────
section("C. L0 conversation/add 幂等");
const l0Session = "iso-" + RUN + "-l0-idem";
const l0Payload = JSON.stringify({
  session_id: l0Session,
  team_id: NS.team,
  agent_id: NS.agent,
  user_id: NS.user,
  messages: [
    { role: "user", content: "iso L0 idempotency probe " + RUN, timestamp: new Date().toISOString() },
    { role: "assistant", content: "iso L0 idempotency reply " + RUN, timestamp: new Date().toISOString() },
  ],
});
const c1 = await request("POST", "/v3/conversation/add", l0Payload, { serviceId: SERVICE });
const c1ids: string[] = c1.json?.data?.accepted_ids ?? c1.json?.accepted_ids ?? [];
log("  C1 first  POST -> " + c1.status + " " + clip(c1.text, 400));
record("C1-first-accepted", c1.status === 200 && c1ids.length === 2, "accepted_ids=" + c1ids.length);

const c2 = await request("POST", "/v3/conversation/add", l0Payload, { serviceId: SERVICE });
const c2ids: string[] = c2.json?.data?.accepted_ids ?? c2.json?.accepted_ids ?? [];
const c2total = c2.json?.data?.total_count ?? c2.json?.total_count;
log("  C2 replay POST -> " + c2.status + " " + clip(c2.text, 400));
record("C2-replay-empty", c2.status === 200 && c2ids.length === 0 && c2total === 0, "accepted_ids=" + c2ids.length + " total_count=" + String(c2total));

const query = await request(
  "POST",
  "/v3/conversation/query",
  JSON.stringify({ session_id: l0Session, team_id: NS.team, agent_id: NS.agent, user_id: NS.user, limit: 50 }),
  { serviceId: SERVICE },
);
const qmsgs: Array<{ id?: string; role?: string }> = query.json?.data?.messages ?? query.json?.messages ?? [];
const qtotal = query.json?.data?.total ?? query.json?.total;
log("  C3 POST /v3/conversation/query -> " + query.status + " total=" + String(qtotal) + " messages=" + qmsgs.length);
record(
  "C3-store-rows",
  query.status === 200 && Number(qtotal) === 2 && qmsgs.length === 2,
  "total=" + String(qtotal) + " messages=" + qmsgs.length + " roles=" + qmsgs.map((m) => m.role).join(","),
);
record(
  "C4-same-ids",
  qmsgs.map((m) => m.id).sort().join(",") === [...c1ids].sort().join(","),
  "query ids 与首次 accepted_ids 一致（" + c1ids.length + " 条）",
);

// ── 收尾证据 ────────────────────────────────────────────────────────────────
section("3. 隔离证据与落盘清单");
function walk(dir: string, depth: number, out: string[] = []): string[] {
  if (depth < 0 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(path.relative(DATA_DIR, p) + "/"); walk(p, depth - 1, out); }
    else out.push(path.relative(DATA_DIR, p) + " (" + fs.statSync(p).size + "B)");
  }
  return out;
}
log("  隔离 baseDir 落盘（深度 2）：");
for (const line of walk(DATA_DIR, 2).slice(0, 40)) log("   · " + line);

const prodAfter = await request("GET", "/health", undefined, { auth: false, base: PROD_BASE });
log("  GET " + PROD_BASE + "/health -> " + prodAfter.status + " " + clip(prodAfter.text, 240));
record("P-8420-alive-after", prodAfter.status === 200, "status=" + prodAfter.status);

await gateway.stop();
await sleep(500);
const afterStop = await request("GET", "/health", undefined, { auth: false });
record("S-stopped", afterStop.status === 0, "stop 后 " + BASE + " 不可达（status=" + afterStop.status + "）");

const failed = checks.filter((c) => !c.ok);
const result = {
  run: RUN,
  port: PORT,
  dataDir: DATA_DIR,
  configPath: CONFIG_PATH,
  maxBodyBytes: limitBytes,
  startedAt: new Date(tStart).toISOString(),
  checks,
  failed: failed.length,
  prod: { before: prodBefore.status, after: prodAfter.status },
};
fs.writeFileSync(path.join(ISO_DIR, "verify-result.json"), JSON.stringify(result, null, 2), "utf-8");

log("\n════ 汇总：" + (checks.length - failed.length) + "/" + checks.length + " PASS ════");
for (const f of failed) log("  FAIL " + f.id + ": " + f.note);
log("  结果 JSON: " + path.join(ISO_DIR, "verify-result.json"));
process.exit(failed.length === 0 ? 0 : 1);
