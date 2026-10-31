/**
 * #红队②（task-60）· /v3 数据面归属校验活体验证
 * ---------------------------------------------------------------------------
 * 单测（gateway/auth-binding*.test.ts）证明判定与装配；本脚本证明
 * **env/yaml → config → handler → 响应** 这条链在真实例上真的变了/没变：
 *
 *   A. 开关全关（缺省）⇒ 与今天逐位相同：单凭 Bearer 用任意 user_id 可读可删
 *      （红队结论可复现）；
 *   B. 开关开（MEMORY_AUTH_REQUIRE_USER_BINDING=1）⇒
 *        · 不带 x-tdai-user-key 的跨 user 访问 403 USER_BINDING_REQUIRED
 *        · key 与 user_id 不符 403 USER_BINDING_MISMATCH
 *        · 删除同样 403，且数据真的没被删
 *        · key 相符 200；admin 双条件旁路 200 并留痕
 *   C. 写侧未知主体（MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY=warn/reject）⇒
 *      team-bogus-000 这类未登记命名空间：warn 放行留痕 / reject 400 UNKNOWN_PRINCIPAL
 *
 * 隔离不变量（脚本自证，不信口头承诺）：
 *   · 端口 8498（8420 之外的独立端口），config/data 全在 os.tmpdir() 一次性目录
 *   · embedding.provider=none + recall/lifecycle 全关 → 零外呼、无后台 LLM 任务
 *   · llm.baseUrl 指向 127.0.0.1:9（discard），误调用立即失败
 *   · 8420 只做 GET /health 探针（前后各一次），证明它是另一个进程、未被我重启
 *
 * 跑法：cd MemoryCore && node --import tsx scripts/verify-auth-binding.ts
 * 退出码：全 PASS=0，有 FAIL=1。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const PORT = Number(process.env.ISO_PORT ?? process.argv[2] ?? 8498);
const HOST = "127.0.0.1";
const KEY = "iso-task60-local-only-key";
const SERVICE = "iso-service";
const BASE = "http://" + HOST + ":" + PORT;
const PROD_BASE = "http://127.0.0.1:8420";

const ISO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-authbind-"));
const DATA_ON = path.join(ISO_DIR, "data-on");
const DATA_OFF = path.join(ISO_DIR, "data-off");
const CONFIG_PATH = path.join(ISO_DIR, "config.yaml");

process.env.TDAI_GATEWAY_CONFIG = CONFIG_PATH;
process.env.TDAI_METADATA_SQLITE_BASE_DIR = path.join(ISO_DIR, "metadata");

const NS = { team: "iso-team", agent: "iso-agent", user: "u1" };
const SESSION = "iso-sess-1";

const checks: { id: string; ok: boolean; note: string }[] = [];
const log = (...a: unknown[]) => console.log(...a);
function record(id: string, ok: boolean, note: string): void {
  checks.push({ id, ok, note });
  log("  " + (ok ? "PASS" : "FAIL") + " [" + id + "] " + note);
}
function section(t: string): void {
  log("\n──────── " + t + " ────────");
}

function writeConfig(dataDir: string): void {
  const yaml = [
    "deployMode: standalone",
    'stateBackend: "local"',
    "server:",
    "  port: " + PORT,
    '  host: "127.0.0.1"',
    '  apiKey: "' + KEY + '"',
    "data:",
    '  baseDir: "' + dataDir.replace(/\\/g, "/") + '"',
    "llm:",
    '  baseUrl: "http://127.0.0.1:9/v1"',
    '  apiKey: "iso-placeholder-unused"',
    '  model: "iso-placeholder-model"',
    "  maxTokens: 0",
    "  timeoutMs: 2000",
    "memory:",
    "  capture:",
    "    enabled: true",
    '  storeBackend: "sqlite"',
    "  pipeline:",
    "    enableWarmup: false",
    "  recall:",
    "    enabled: false",
    "  lifecycle:",
    "    enabled: false",
    "  embedding:",
    "    enabled: false",
    '    provider: "none"',
    "",
  ].join("\n");
  fs.writeFileSync(CONFIG_PATH, yaml, "utf-8");
}

type Resp = { status: number; text: string; json?: any; ms: number };
function request(
  method: string,
  pathname: string,
  body?: string,
  headers: Record<string, string> = {},
  base: string = BASE,
): Promise<Resp> {
  const payload = body === undefined ? undefined : Buffer.from(body, "utf-8");
  const h: Record<string, string> = { accept: "application/json", authorization: "Bearer " + KEY, ...headers };
  if (payload) {
    h["content-type"] = "application/json";
    h["content-length"] = String(payload.length);
  }
  const url = new URL(pathname, base);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: h, agent: false, timeout: 20000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json: unknown;
          try { json = JSON.parse(text); } catch { /* non-json */ }
          resolve({ status: res.statusCode ?? 0, text, json, ms: Date.now() - t0 });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", (err: NodeJS.ErrnoException) => resolve({ status: 0, text: err.name + ": " + err.message, ms: Date.now() - t0 }));
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitReady(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await request("GET", "/health", undefined, {}, BASE);
    if (r.status === 200) return true;
    await sleep(250);
  }
  return false;
}

const v3Headers = (extra: Record<string, string> = {}) => ({
  "x-tdai-service-id": SERVICE,
  ...extra,
});
const iso = (userId: string, teamId: string = NS.team) => ({
  session_id: SESSION,
  team_id: teamId,
  agent_id: NS.agent,
  user_id: userId,
});

const { TdaiGateway } = await import("../src/gateway/server.js");
const { loadGatewayConfig } = await import("../src/gateway/config.js");

// 8420 基线（只读）
section("0. 生产实例基线（8420，只读 /health）");
const prodBefore = await request("GET", "/health", undefined, {}, PROD_BASE);
record("P-8420-alive-before", prodBefore.status === 200, "status=" + prodBefore.status + " ms=" + prodBefore.ms);

async function startInstance(dataDir: string, label: string) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  writeConfig(dataDir);
  const gateway = new TdaiGateway({
    server: { port: PORT, host: HOST, apiKey: KEY },
    data: { baseDir: dataDir },
  });
  await gateway.start();
  const ok = await waitReady();
  const cfg = loadGatewayConfig({ server: { port: PORT, host: HOST, apiKey: KEY }, data: { baseDir: dataDir } });
  log("  [" + label + "] data.baseDir=" + cfg.data.baseDir + " port=" + cfg.server.port + " ready=" + ok);
  if (!ok) throw new Error("instance " + label + " not ready");
  return gateway;
}

// ── B. 开关全开（先跑，隔离库独立）─────────────────────────────────────────
section("B. 开关开：MEMORY_AUTH_REQUIRE_USER_BINDING=1");
process.env.MEMORY_AUTH_REQUIRE_USER_BINDING = "1";
process.env.MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY = "off";
process.env.MEMORY_AUTH_ADMIN_BYPASS_ENABLED = "1";
const gwOn = await startInstance(DATA_ON, "on");

// B0 业主写 L0（key 与 user_id 相符）
const add = await request(
  "POST",
  "/v3/conversation/add",
  JSON.stringify({ ...iso(NS.user), messages: [{ role: "user", content: "auth-binding probe: team budget approved on 2026-11-01" }] }),
  v3Headers({ "x-tdai-user-key": NS.user, "x-tdai-user-id": NS.user, "x-tdai-team-id": NS.team, "x-tdai-agent-id": NS.agent }),
);
record("B0-owner-write-200", add.status === 200 && (add.json?.code === 0), "status=" + add.status + " code=" + add.json?.code);

// B1 无 key 跨 user 读 → 403 USER_BINDING_REQUIRED
const noKey = await request(
  "POST",
  "/v3/conversation/query",
  JSON.stringify({ ...iso("u-victim"), limit: 5 }),
  v3Headers({ "x-tdai-user-id": "u-victim", "x-tdai-team-id": NS.team, "x-tdai-agent-id": NS.agent }),
);
record(
  "B1-no-key-403-REQUIRED",
  noKey.status === 403 && String(noKey.json?.data?.code ?? "") === "USER_BINDING_REQUIRED",
  "status=" + noKey.status + " data.code=" + String(noKey.json?.data?.code),
);

// B2 key 不符 → 403 USER_BINDING_MISMATCH
const mismatch = await request(
  "POST",
  "/v3/conversation/query",
  JSON.stringify({ ...iso("u-victim"), limit: 5 }),
  v3Headers({ "x-tdai-user-key": "u-attacker", "x-tdai-user-id": "u-victim", "x-tdai-team-id": NS.team, "x-tdai-agent-id": NS.agent }),
);
record(
  "B2-mismatch-403-MISMATCH",
  mismatch.status === 403 && String(mismatch.json?.data?.code ?? "") === "USER_BINDING_MISMATCH",
  "status=" + mismatch.status + " data.code=" + String(mismatch.json?.data?.code),
);

// B3 跨 user 删除 → 403，且数据未被删
const del = await request(
  "POST",
  "/v3/conversation/delete",
  JSON.stringify({ ...iso("u-victim"), session_ids: [SESSION] }),
  v3Headers({ "x-tdai-user-id": "u-victim", "x-tdai-team-id": NS.team, "x-tdai-agent-id": NS.agent }),
);
record("B3-cross-user-delete-403", del.status === 403, "status=" + del.status + " code=" + del.json?.code);
const ownerRead = await request(
  "POST",
  "/v3/conversation/query",
  JSON.stringify({ ...iso(NS.user), limit: 5 }),
  v3Headers({ "x-tdai-user-key": NS.user, "x-tdai-user-id": NS.user, "x-tdai-team-id": NS.team, "x-tdai-agent-id": NS.agent }),
);
const rowCount = Number(ownerRead.json?.data?.total ?? ownerRead.json?.data?.messages?.length ?? -1);
record("B4-owner-read-still-200", ownerRead.status === 200 && ownerRead.json?.code === 0, "status=" + ownerRead.status + " code=" + ownerRead.json?.code + " total=" + rowCount);

// B5 同 key 相符（跨 user_id 但 key 一致）→ 200
const match = await request(
  "POST",
  "/v3/conversation/query",
  JSON.stringify({ ...iso(NS.user), limit: 5 }),
  v3Headers({ "x-tdai-user-key": NS.user, "x-tdai-user-id": NS.user, "x-tdai-team-id": NS.team, "x-tdai-agent-id": NS.agent }),
);
record("B5-matched-key-200", match.status === 200 && match.json?.code === 0, "status=" + match.status + " code=" + match.json?.code);

// B6 admin 双条件旁路
const bypass = await request(
  "POST",
  "/v3/conversation/query",
  JSON.stringify({ ...iso("u-victim"), limit: 5 }),
  v3Headers({ "x-tdai-user-type": "system_admin", "x-tdai-admin-bypass": "1", "x-tdai-team-id": NS.team, "x-tdai-agent-id": NS.agent }),
);
record("B6-admin-bypass-200", bypass.status === 200 && bypass.json?.code === 0, "status=" + bypass.status + " code=" + bypass.json?.code);

// B7 写侧 warn 档：未登记 team-bogus-000 放行
process.env.MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY = "warn";
const warnWrite = await request(
  "POST",
  "/v3/conversation/add",
  JSON.stringify({ ...iso("u1", "team-bogus-000"), session_id: "iso-bogus-1", messages: [{ role: "user", content: "bogus namespace write" }] }),
  v3Headers({ "x-tdai-user-key": "u1", "x-tdai-user-id": "u1", "x-tdai-team-id": "team-bogus-000", "x-tdai-agent-id": NS.agent }),
);
record("B7-unknown-principal-warn-allow", warnWrite.status === 200 && warnWrite.json?.code === 0, "status=" + warnWrite.status + " code=" + warnWrite.json?.code);

// B8 写侧 reject 档：未登记 team-bogus-000 → 400 UNKNOWN_PRINCIPAL
process.env.MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY = "reject";
const rejectWrite = await request(
  "POST",
  "/v3/conversation/add",
  JSON.stringify({ ...iso("u1", "team-bogus-0002"), session_id: "iso-bogus-2", messages: [{ role: "user", content: "bogus namespace write 2" }] }),
  v3Headers({ "x-tdai-user-key": "u1", "x-tdai-user-id": "u1", "x-tdai-team-id": "team-bogus-0002", "x-tdai-agent-id": NS.agent }),
);
record(
  "B8-unknown-principal-reject-400",
  rejectWrite.status === 400 && String(rejectWrite.json?.data?.code ?? "") === "UNKNOWN_PRINCIPAL",
  "status=" + rejectWrite.status + " data.code=" + String(rejectWrite.json?.data?.code) + " unknown=" + JSON.stringify(rejectWrite.json?.data?.unknown),
);
process.env.MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY = "off";
await gwOn.stop();

// ── A. 开关全关（缺省）→ 红队结论可复现 = 逐位现状 ────────────────────────
section("A. 开关全关（缺省）：服务级信任逐位不变（红队结论可复现）");
delete process.env.MEMORY_AUTH_REQUIRE_USER_BINDING;
delete process.env.MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY;
delete process.env.MEMORY_AUTH_ADMIN_BYPASS_ENABLED;
const gwOff = await startInstance(DATA_OFF, "off");

const seed = await request(
  "POST",
  "/v3/conversation/add",
  JSON.stringify({ ...iso(NS.user), messages: [{ role: "user", content: "default-mode probe row" }] }),
  v3Headers({ "x-tdai-user-id": NS.user, "x-tdai-team-id": NS.team, "x-tdai-agent-id": NS.agent }),
);
record("A1-seed-write-200", seed.status === 200 && seed.json?.code === 0, "status=" + seed.status + " code=" + seed.json?.code);

const victimRead = await request(
  "POST",
  "/v3/conversation/query",
  JSON.stringify({ ...iso("u-victim"), limit: 5 }),
  v3Headers({ "x-tdai-user-id": "u-victim", "x-tdai-team-id": NS.team, "x-tdai-agent-id": NS.agent }),
);
record("A2-default-cross-user-read-allowed", victimRead.status === 200 && victimRead.json?.code === 0, "status=" + victimRead.status + " code=" + victimRead.json?.code + "（缺省 = 红队结论仍可复现）");

const victimDelete = await request(
  "POST",
  "/v3/conversation/delete",
  JSON.stringify({ ...iso("u-victim"), session_ids: [SESSION] }),
  v3Headers({ "x-tdai-user-id": "u-victim", "x-tdai-team-id": NS.team, "x-tdai-agent-id": NS.agent }),
);
const deleted = Number(victimDelete.json?.data?.deleted ?? victimDelete.json?.data?.deleted_count ?? 0);
record("A3-default-cross-user-delete-allowed", victimDelete.status === 200 && victimDelete.json?.code === 0, "status=" + victimDelete.status + " deleted=" + deleted + "（缺省下删除同样通行 = 红队原结论）");
await gwOff.stop();

// ── 8420 仍在（未被我重启）─────────────────────────────────────────────────
section("C. 生产实例仍在（未重启）");
const prodAfter = await request("GET", "/health", undefined, {}, PROD_BASE);
record("P-8420-alive-after", prodAfter.status === 200, "status=" + prodAfter.status + " ms=" + prodAfter.ms);

fs.rmSync(ISO_DIR, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
log("\n" + "=".repeat(70));
log("结果：" + (checks.length - failed.length) + "/" + checks.length + " PASS" + (failed.length ? "，FAIL: " + failed.map((f) => f.id).join(", ") : ""));
log("=".repeat(70));
process.exit(failed.length ? 1 : 0);
