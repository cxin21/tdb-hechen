#!/usr/bin/env node
/**
 * e2e-preflight.mjs — 装桌面前的一次性 profile 预飞（一条命令跑完，只读真 8420，零 commit）
 *
 * 为什么要它：桌面安装 + 用户重启是发布链的最后一步，不能拿它当调试环境。
 * 这个脚本用**当前工作树**的 dist 起一个一次性 profile（名字带时间戳），跑一轮真实
 * headless 会话，再交给 scan-session-evidence.mjs --strict 出段证据。全绿才允许进
 * 发布门禁（G7）。全程不碰 ~/.dsh/profiles/desktop，不重启任何 GUI。
 *
 * 七步：前置检查 → 建一次性 profile → deploy（只写 apiKeyRef，不落明文）→ 预飞会话
 *      → 扫描器 --strict → 清理 profile → 汇总。
 *
 * 用法：
 *   node dsh-plugin/scripts/e2e-preflight.mjs                     # 完整预飞，跑完删 profile
 *   node dsh-plugin/scripts/e2e-preflight.mjs --keep              # 保留 profile 供复查（打完路径）
 *   node dsh-plugin/scripts/e2e-preflight.mjs --identity t,a,u    # 不给就用 TDB_TEAM_ID/TDB_AGENT_ID/TDB_USER_ID
 *   node dsh-plugin/scripts/e2e-preflight.mjs --prompt "..."      # 覆盖默认的强制工具面 prompt
 *   node dsh-plugin/scripts/e2e-preflight.mjs --writeback         # 打开写回（默认关：不往生产 L0 写测试数据）
 *   node dsh-plugin/scripts/e2e-preflight.mjs --no-logs           # 不挂 logger-console（默认挂，便于看 MISSING 的原因）
 *   node dsh-plugin/scripts/e2e-preflight.mjs --extra-patch x.yml # 追加一层 patch（例如打开某个注入段）
 *   node dsh-plugin/scripts/e2e-preflight.mjs --core-url http://127.0.0.1:8490 --core-key iso-key  # 对隔离实例跑
 *
 * 退出码：0 全绿；1 会话跑起来了但段证据不全（扫描器 --strict 失败）；2 前置检查/会话没起来。
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getRef, hasRef, maskValue } from "./credentials-util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");                 // dsh-plugin
const REPO_ROOT = resolve(PKG_ROOT, "..");            // repo root
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const DSH_BIN = process.env.DSH_BIN || "D:/DSH/resources/runtime/cli/bin/dsh.cmd";
const CRED_FILE = join(DSH_HOME, ".credentials.yaml");
const SCANNER = join(HERE, "scan-session-evidence.mjs");
const DEPLOY = join(HERE, "deploy.sh");
const CORE_URL = process.env.TDB_CORE_BASE_URL || "http://127.0.0.1:8420";
const FORBIDDEN_PROFILES = new Set(["desktop", "web", "tui"]);
const FENCE = String.fromCharCode(96, 96, 96);        // 反引号围栏用码点拼，避免本文件自身被围栏截断

// 默认 prompt：逐个点名「插件应当注册过的工具」，并要求模型在工具缺失时写 MISSING:<名>。
// 这样一次会话既是段证据，也是工具注册证据；不依赖模型自由发挥。
const DEFAULT_PROMPT = [
  "这是一次插件预飞自检，请严格按顺序执行，不要解释、不要读写任何文件：",
  "1) 调 memory_recall，query 用「dsh 插件注入段」，limit 3；",
  "2) 调 skill_search，query 用「wiki」；",
  "3) 调 knowledge_search，不带参数；",
  "4) 如果上面某个工具不存在或调用失败，在回答里写 MISSING:<工具名>。",
  "最后只输出一行：DONE 后紧跟实际调用成功的工具名（逗号分隔）。",
].join(" ");

function parseArgs(argv) {
  const opts = {
    identity: [process.env.TDB_TEAM_ID || "", process.env.TDB_AGENT_ID || "", process.env.TDB_USER_ID || ""],
    keep: false, writeback: false, logs: true, prompt: DEFAULT_PROMPT,
    extraPatch: "", timeoutMs: 300000, coreUrl: CORE_URL, coreKey: process.env.TDB_CORE_API_KEY || "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
      i += 1;
      if (i >= argv.length) fail("missing value for " + a);
      return argv[i];
    };
    if (a === "--keep") opts.keep = true;
    else if (a === "--writeback") opts.writeback = true;
    else if (a === "--no-logs") opts.logs = false;
    else if (a === "--prompt" || a.startsWith("--prompt=")) opts.prompt = val();
    else if (a === "--identity" || a.startsWith("--identity=")) opts.identity = val().split(",").map((s) => s.trim());
    else if (a === "--extra-patch" || a.startsWith("--extra-patch=")) opts.extraPatch = val();
    else if (a === "--timeout" || a.startsWith("--timeout=")) opts.timeoutMs = Number(val()) * 1000;
    else if (a === "--core-url" || a.startsWith("--core-url=")) opts.coreUrl = val();
    else if (a === "--core-key" || a.startsWith("--core-key=")) opts.coreKey = val();
    else if (a === "-h" || a === "--help") { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]); process.exit(0); }
    else fail("unknown argument: " + a);
  }
  return opts;
}

function fail(msg) { console.error("preflight: " + msg); process.exit(2); }
// 每一行都进 buffer，最后落成 report.md（证据要能带走，不能只活在终端里）。
const logLines = [];
const emit = (line) => { console.log(line); logLines.push(line); };
const say = (s) => emit("== " + s);
const step = (s) => emit("   " + s);
const ok = (s) => emit("   [PASS] " + s);
const bad = (s) => emit("   [FAIL] " + s);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push({ path: p, mtime: st.mtimeMs });
  }
  return out;
}

function newestSource() {
  const src = join(PKG_ROOT, "src");
  if (!existsSync(src)) return null;
  const files = walk(src).filter((f) => f.path.endsWith(".ts"));
  if (files.length === 0) return null;
  return files.sort((a, b) => b.mtime - a.mtime)[0];
}

function bashPath() {
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return "bash";
  for (const p of ["D:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/bin/bash.exe"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function run(cmd, args, opts = {}) {
  // Windows 上 .cmd/.bat 不能直接 spawn（EINVAL → status 为 null），必须经 cmd.exe /c。
  const isBatch = /\.(cmd|bat)$/i.test(cmd);
  const finalCmd = isBatch && process.platform === "win32" ? "cmd.exe" : cmd;
  const finalArgs = isBatch && process.platform === "win32" ? ["/d", "/s", "/c", cmd, ...args] : args;
  const res = spawnSync(finalCmd, finalArgs, { encoding: "utf8", timeout: opts.timeoutMs, env: opts.env || process.env, cwd: opts.cwd, input: opts.input });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", error: res.error, signal: res.signal };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14); // YYYYMMDDHHmmss，profile 名里不能有 "."
  const profile = "agemem-preflight-" + stamp;
  const profileDir = join(DSH_HOME, "profiles", profile);
  const tmp = mkdtempSync(join(tmpdir(), "agemem-preflight-"));
  const extraPatch = join(tmp, "config-extra.yml");
  // 证据目录放在仓内 scratch/（untracked），跟一次性 profile 解耦：profile 删了，报告还在。
  const artifacts = join(REPO_ROOT, "scratch", "preflight-" + stamp);
  mkdirSync(artifacts, { recursive: true });
  const reportPath = join(artifacts, "report.md");

  if (FORBIDDEN_PROFILES.has(profile)) fail("refusing a shipped profile name: " + profile);

  // ---------------------------------------------------------------- 1. 前置检查
  say("1/7 前置检查");
  let fatal = 0;

  const distEntry = join(PKG_ROOT, "dist", "index.js");
  const newest = newestSource();
  if (!existsSync(distEntry)) {
    bad("dist/index.js 不存在 — 先构建：cd dsh-plugin && pnpm run build");
    fatal += 1;
  } else if (newest && statSync(distEntry).mtimeMs < newest.mtime) {
    bad(
      "dist 比源码旧（" + new Date(statSync(distEntry).mtimeMs).toISOString().slice(0, 19) +
      " < " + newest.path.replace(PKG_ROOT + "\\", "").replace(PKG_ROOT + "/", "") + " " +
      new Date(newest.mtime).toISOString().slice(0, 19) + "）— 先构建：cd dsh-plugin && pnpm run build",
    );
    fatal += 1;
  } else {
    ok("dist 不旧于源码（" + new Date(statSync(distEntry).mtimeMs).toISOString().slice(0, 19) + "）");
  }

  if (!existsSync(DSH_BIN)) { bad("找不到 dsh CLI: " + DSH_BIN); fatal += 1; }
  else ok("dsh CLI: " + DSH_BIN);

  if (!existsSync(SCANNER)) { bad("找不到扫描器: " + SCANNER); fatal += 1; }
  const bash = bashPath();
  if (!bash) { bad("找不到 bash（deploy.sh 需要 git bash）"); fatal += 1; }
  if (!existsSync(DEPLOY)) { bad("找不到 deploy.sh: " + DEPLOY); fatal += 1; }

  const [teamId, agentId, userId] = opts.identity;
  if (!teamId || !agentId || !userId) {
    bad("身份不全（team=" + (teamId || "-") + " agent=" + (agentId || "-") + " user=" + (userId || "-") +
      "）— 传 --identity t,a,u 或 TDB_TEAM_ID/TDB_AGENT_ID/TDB_USER_ID");
    fatal += 1;
  } else ok("身份: team=" + teamId + " agent=" + agentId + " user=" + userId);

  if (!existsSync(CRED_FILE)) { bad("找不到凭据库: " + CRED_FILE); fatal += 1; }
  const credText = existsSync(CRED_FILE) ? readFileSync(CRED_FILE, "utf8") : "";
  const llmKey = getRef(credText, "SCM_API_KEY");
  const gatewayKey = getRef(credText, "TDAI_GATEWAY_APIKEY");
  if (!llmKey) { bad("凭据库没有 SCM_API_KEY（LLM 走 SCM 路由，没有它会话起不来）"); fatal += 1; }
  else ok("SCM_API_KEY " + maskValue(llmKey) + "（只经 env 传入子进程）");
  if (opts.coreKey) ok("core key 由 --core-key 提供（隔离实例，不读凭据库）");
  else if (!gatewayKey) { bad("凭据库没有 TDAI_GATEWAY_APIKEY（core 的 server key）"); fatal += 1; }
  else ok("TDAI_GATEWAY_APIKEY " + maskValue(gatewayKey) + "（patch 里只写 ref 名）");

  if (fatal > 0) {
    rmSync(tmp, { recursive: true, force: true });
    console.log("\n== RESULT: 前置检查未通过（" + fatal + " 项），未创建 profile、未打任何请求。");
    process.exit(2);
  }

  const health = probeHealth(opts.coreUrl);
  if (health.status !== 200) {
    // 非致命：核心可能正在重启。但要说清后果——段注入全靠核心，核心不通时第 5 步的 head/volatile 缺失属预期。
    bad("core " + opts.coreUrl + " /health → " + health.status + " " + health.body);
    step("提示：核心不通 ⇒ 第 5 步 head/volatile 段缺失属预期，本次读数只验证脚本自身可用，不能当发布读数");
  } else ok("core " + opts.coreUrl + " /health 200 " + health.body.replace(/\s+/g, " ").slice(0, 80));

  // deploy 用的 config-extra：默认关写回（预飞不往生产 L0 写测试数据），debug 便于看日志。
  const cfgLines = ["writeback:", "  enabled: " + (opts.writeback ? "true" : "false"), "debug: true"];
  writeFileSync(extraPatch, cfgLines.join("\n") + "\n");

  try {
    // ------------------------------------------------------------ 2. 一次性 profile
    say("2/7 建一次性 profile: " + profile + "（from-default-profile headless，绝不碰 desktop）");
    const create = run(DSH_BIN, ["--profile", profile, "--from-default-profile", "headless", "--dump-config"], { timeoutMs: 180000 });
    if (create.status !== 0 || !existsSync(join(profileDir, "package.json"))) {
      bad("profile 创建失败（exit " + create.status + (create.error ? " error=" + create.error.code + " " + create.error.message : "") + "）：" + (create.stderr || create.stdout).slice(-400));
      return 2;
    }
    ok("profile 已建：" + profileDir);

    // ------------------------------------------------------------ 3. deploy
    say("3/7 deploy（tarball + patch 一条 entry，apiKeyRef 而非明文）");
    const deployArgs = [DEPLOY, "--skip-tests", "--no-store-key", "--identity", [teamId, agentId, userId].join(","), "--config-extra", extraPatch];
    const dep = run(bash, deployArgs, { timeoutMs: 600000, env: { ...process.env, DSH_PROFILE: profile, DSH_BIN, TDB_CORE_BASE_URL: opts.coreUrl } });
    const depTail = (dep.stdout + dep.stderr).trim().split("\n");
    for (const line of depTail.slice(-8)) step("| " + line);
    if (dep.status !== 0) { bad("deploy 失败（exit " + dep.status + "）"); return 2; }
    const patchFile = join(profileDir, "cordis.patch.yml");
    const patchText = existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
    if (!/apiKeyRef:/.test(patchText)) { bad("patch 里没有 apiKeyRef — 拒绝继续（明文 key 或没写进去）"); return 2; }
    if (/^\s+apiKey:\s*"[^"]+"/m.test(patchText)) { bad("patch 里出现明文 apiKey — 拒绝继续"); return 2; }
    ok("patch 只含 apiKeyRef（无明文 key）");

    // ------------------------------------------------------------ 4. 预飞会话
    say("4/7 预飞会话（headless --json，身份=真，core=真）");
    const patches = ["--patch", join(HERE, "preflight", "llm-scm.yml")];
    if (opts.logs) patches.push("--patch", join(HERE, "preflight", "logger.yml"));
    if (opts.extraPatch) patches.push("--patch", resolve(opts.extraPatch));
    const prompt = opts.prompt.replace(/"/g, "'");
    const runArgs = ["--profile", profile, ...patches, "headless", "--json", prompt];
    const started = Date.now();
    const r = run(DSH_BIN, runArgs, {
      timeoutMs: opts.timeoutMs,
      env: { ...process.env, SCM_API_KEY: llmKey, TDAI_GATEWAY_APIKEY: opts.coreKey || gatewayKey, AGEMEM_DEBUG: "1" },
      cwd: REPO_ROOT,
    });
    const elapsed = Date.now() - started;
    writeFileSync(join(artifacts, "run.jsonl"), r.stdout || "");
    writeFileSync(join(artifacts, "run.err"), r.stderr || "");
    const sidMatch = /"type":"session","sessionId":"([^"]+)"/.exec(r.stdout);
    if (!sidMatch) {
      bad("会话没有起来（exit " + r.status + (r.signal ? " signal=" + r.signal : "") + (r.error ? " error=" + r.error.code + " " + r.error.message : "") + "，" + Math.round(elapsed / 1000) + "s）— 下面是 stderr 尾部：");
      for (const line of (r.stderr || "").trim().split("\n").slice(-12)) step("| " + line);
      return 2;
    }
    const sessionId = sidMatch[1];
    ok("sessionId=" + sessionId + "（" + Math.round(elapsed / 1000) + "s，exit " + r.status + "）");
    const answer = /"type":"final","text":"([^"]*)"/.exec(r.stdout);
    if (answer) step("answer: " + answer[1].slice(0, 300));
    const pluginReady = (r.stderr || "").split("\n").filter((l) => /agemem: ready|agemem: mount|identity/.test(l)).slice(-3);
    for (const line of pluginReady) step("| " + line.trim().slice(0, 300));

    // ------------------------------------------------------------ 5. 扫描器
    say("5/7 扫描器 --strict（原始输出如下）");
    const plain = run(process.execPath, [SCANNER, "--session", sessionId, "--strict"], { timeoutMs: 120000 });
    console.log(plain.stdout.trimEnd());
    writeFileSync(join(artifacts, "scan.txt"), (plain.stdout || "") + (plain.stderr || ""));
    let missing = { head: [], vol: [], tools: [] };
    const miss = /MISSING: head=\[([^\]]*)\] volatile=\[([^\]]*)\] tools=\[([^\]]*)\]/.exec(plain.stdout);
    if (miss) {
      const split = (s) => s.split(",").map((x) => x.trim()).filter((x) => x && x !== "无");
      missing = { head: split(miss[1]), vol: split(miss[2]), tools: split(miss[3]) };
    }
    const scanOk = plain.status === 0;
    console.log("");
    // 口径警告（Lead 2026-11-01 要求）：工具行的 [PASS] 只证明「注册成功」——schema 被宿主接受、名字进了模型可见的工具表。
    // 不证明「能被服务」：核心宕机 / 身份失效 / 端点 404 时这些工具照旧 [PASS]，但调用必然失败。
    step("口径：工具行 [PASS] = registered（注册成功），不是 served；served 要另跑一轮带真调用的读数为证");
    step("口径：head 段缺失时「系统提示全长 N chars」是降级读数（persona/core 取不到），不是 head pack 的真实长度");
    if (scanOk) ok("扫描器 exit 0：三段齐全");
    else bad("扫描器 exit " + plain.status + "：段证据不全（缺失见上面的 MISSING 行）");

    // ------------------------------------------------------------ 6. 汇总
    say("6/7 RESULT");
    step("session     : " + sessionId);
    step("profile     : " + profileDir + (opts.keep ? "（--keep 保留）" : "（即将删除）"));
    step("core        : " + opts.coreUrl + "（真实例，writeback=" + (opts.writeback ? "on" : "off") + "）");
    step("missing head: " + (missing.head.join(",") || "无"));
    step("missing vol : " + (missing.vol.join(",") || "无"));
    step("missing tool: " + (missing.tools.join(",") || "无"));
    return scanOk ? 0 : 1;
  } finally {
    // ------------------------------------------------------------ 7. 清理
    say("7/7 清理");
    if (opts.keep) step("保留 profile（--keep）：" + profileDir);
    else {
      rmSync(profileDir, { recursive: true, force: true });
      step("已删除一次性 profile：" + profileDir);
    }
    rmSync(tmp, { recursive: true, force: true });
    step("已删除临时 patch 目录（会话归档保留在 " + join(DSH_HOME, "sessions") + "，这是证据）");
    writeFileSync(reportPath, [
      "# 预飞报告 " + stamp,
      "",
      "- profile: " + profile + (opts.keep ? "（--keep 保留）" : "（已删除）"),
      "- 证据目录: " + artifacts,
      "- 会话归档: " + join(DSH_HOME, "sessions") + "（run.jsonl / run.err / scan.txt 在本目录）",
      "",
      FENCE + "text",
      logLines.join("\n"),
      FENCE,
      "",
    ].join("\n"));
    console.log("   报告已落盘: " + reportPath);
  }
}

// 整个脚本保持同步流程（便于 finally 清理），健康探测因此走一个子进程而不是顶层 await。
function probeHealth(url) {
  const script = [
    "const u = process.argv[1];",
    "fetch(u.replace(/\\/+$/, '') + '/health', { signal: AbortSignal.timeout(5000) })",
    "  .then(async (r) => { process.stdout.write(r.status + '\\n' + (await r.text()).slice(0, 200)); })",
    "  .catch((e) => { process.stdout.write('0\\n' + String(e && e.message ? e.message : e)); });",
  ].join("\n");
  const res = spawnSync(process.execPath, ["-e", script, url], { encoding: "utf8", timeout: 15000 });
  const [status, body] = String(res.stdout || "").split("\n");
  return { status: Number(status || 0), body: body || "" };
}

process.exit(main());
