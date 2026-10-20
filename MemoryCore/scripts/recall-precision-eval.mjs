#!/usr/bin/env node
/**
 * #73 召回精度评测 runner — dataset.jsonl 四指标复放（Step 0 基线门，2026-10-20 定案）
 *
 * 纪律（红线遵守）：
 *   - 生产 tdai-gateway.yaml 全程只读；
 *   - 生产 vectors.db 只 COPY 到临时目录，临时网关仅触碰副本（零写生产库）；
 *   - 零注入零删除（不向任何记忆库写入测试数据）；
 *   - 临时网关 :8422 自起自停；结伴生（lifecycle/capture/extraction/skill.extraction）全关；
 *   - 归档 runs/<ts>.json；红牌不阻塞（exit 0，供 Step 0 对账）。
 *
 * 运行：cd MemoryCore && node scripts/recall-precision-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(__dirname, "..");
const DS_DIR = path.resolve(CORE_DIR, "..", "docs", "superpowers", "evals", "memory-recall-golden", "recall-precision-2026-10-20");
const DATASET_FILE = path.join(DS_DIR, "dataset.jsonl");
const RUNS_DIR = path.join(DS_DIR, "runs");
const PROD_YAML = path.join(CORE_DIR, "tdai-gateway.yaml"); // 只读
const PORT = 8422;
const API_BASE = "http://127.0.0.1:" + PORT;
const PROD_TEAM = "team-2k12lgb650";
const PROD_AGENT = "agt-2m7buribzz";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// fs.writeSync 直写 fd：process.exit 前管道 stdout 异步缓冲会被截断（2026-10-20 实证）
const log = (...a) => { try { fs.writeSync(1, "[recall-precision-eval] " + a.map(String).join(" ") + "\n"); } catch {} };
const loud = (...a) => { try { fs.writeSync(2, "[recall-precision-eval][RED-CARD] " + a.map(String).join(" ") + "\n"); } catch {} };
const norm = (s) => String(s).replace(/\s+/g, "").replace(/[[\]()【】、：:，,。；;·'"|-]/g, "");
const frag32 = (rowText) => { const m = rowText.match(/^- \[[^\]]+\] ([\s\S]*)$/); return norm((m ? m[1] : rowText).slice(0, 32)); };
// 审查 M2（2026-10-20 对抗审查）：旧实现只认带场景名管道前缀，漏判裸 tag（"- [结论] …"=formatConclusionLine
// 无场景名产物，recall-layered.ts:255）与全部 episodic 行（tag=m.type，auto-recall.ts:2731，可无场景名）
// → 误入 other 剔出指标口径。改白名单分类：l1 type 词表 ∪ 结论别名；soul 段（- [strict_rule] 等）维持 other。
const MEM_TAGS = new Set(["conclusion", "work_fact", "work_method", "work_task", "episodic", "persona", "instruction"]);
const levelOf = (t) => {
  const m = t.match(/^- \[([^\]|]+)(?:\|[^\]]*)?\]/);
  if (!m) return "other";
  const tag = m[1].trim();
  const lv = tag === "结论" ? "conclusion" : tag;
  return MEM_TAGS.has(lv) ? lv : "other";
};
const quantile = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

let gw = null;
let TMP_REF = null; // 失败路径 tmpDir 清理锚
async function startGw(yamlFile) {
  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway/server.ts"], {
    cwd: CORE_DIR, env: { ...process.env, TDAI_GATEWAY_CONFIG: yamlFile }, stdio: ["ignore", "ignore", "ignore"], detached: true,
  });
  gw.unref();
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    try { const h = await (await fetch(API_BASE + "/health")).json(); if (h.status === "ok") return; } catch { /* not up yet */ }
  }
  throw new Error("temp gateway :" + PORT + " not healthy in 45s");
}
function stopGw() { if (!gw) return; try { process.kill(-gw.pid); } catch {} try { gw.kill(); } catch {} gw = null; }

function parseDataset() {
  const rounds = []; let meta = null;
  for (const line of fs.readFileSync(DATASET_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o && o._meta) meta = o; else rounds.push(o);
  }
  if (!meta || !rounds.length) throw new Error("dataset.jsonl 缺 _meta 或空");
  return { meta, rounds };
}

async function recall(query, session, apiKey, tenant) {
  const r = await fetch(API_BASE + "/v3/recall", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
      "x-tdai-service-id": "default",
      "x-tdai-team-id": tenant.team_id,
      "x-tdai-user-id": tenant.user_id,
      "x-tdai-agent-id": tenant.agent_id,
      "x-tdai-session-id": session,
    },
    // maxResults=5 镜像生产 proxy（globalTopK 缺省 5，tdai-l1-recall-injector.ts:38/:45；config.ts:127/:608）
    body: JSON.stringify({ query, maxResults: 5 }),
  });
  if (!r.ok) throw new Error("/v3/recall HTTP " + r.status + ": " + (await r.text()).slice(0, 300));
  const j = await r.json();
  if (j && j.code !== 0) throw new Error("/v3/recall code!=0: " + JSON.stringify(j).slice(0, 300));
  const d = (j && j.data) || {};
  const block = d.block || "";
  const meta = d.meta || {};
  const out = block.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("- ["));
  return { block, meta, lines: out, skipReason: meta.skipReason ?? null };
}

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const { meta, rounds } = parseDataset();
  const prod = YAML.parse(fs.readFileSync(PROD_YAML, "utf8"));
  const baseDir = prod && prod.data && prod.data.baseDir;
  // API key 解析（env-first，与网关 config.ts:445 同序）：env 主名 → env 兼容名 → yaml 字面值。
  // yaml 占位符（${...}）不能当 Bearer——env 缺失时网关按 P2-T13 生成随机临时密钥 → 401（2026-10-20 实证）。
  const PH = /^\${([A-Za-z0-9_]+)\}$/;
  const yamlKey = prod && prod.server && prod.server.apiKey;
  const envKey = process.env.TDAI_GATEWAY_APIKEY ?? process.env.TDAI_GATEWAY_API_KEY;
  const apiKey = envKey ?? (typeof yamlKey === "string" && yamlKey && !PH.test(yamlKey) ? yamlKey : undefined);
  if (typeof apiKey !== "string" || !apiKey) {
    throw new Error("API key 未解析到：env TDAI_GATEWAY_APIKEY/TDAI_GATEWAY_API_KEY 缺省且 yaml server.apiKey 非字面值（占位符需经 env 注入，勿明文入库）");
  }
  if (!baseDir) throw new Error("data.baseDir 缺失");

  // 1) 生产 DB 副本（零写生产）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-precision-eval-"));
  TMP_REF = tmpDir;
  const dbCopy = path.join(tmpDir, "vectors.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = path.join(String(baseDir), "vectors.db" + suffix);
    if (fs.existsSync(src)) fs.copyFileSync(src, dbCopy + suffix);
  }
  log("DB copied: " + dbCopy);

  // 1b) 配置层副本（生产保真）：config-override.json 是生产实际配置层（优先级 override>env>yaml，
  // settings-override.ts:65/config.ts:495）。缺它临时网关退回 yaml 层（无内网 LLM/本地 rerank/
  // importancePenalty）→ 指标失真（2026-10-20 实证 perf 6-37ms vs 生产 expand p50 1.51s）。
  // 只读复制进临时 baseDir，零改原件。
  const overrideSrc = path.join(String(baseDir), "config-override.json");
  if (fs.existsSync(overrideSrc)) {
    fs.copyFileSync(overrideSrc, path.join(tmpDir, "config-override.json"));
    log("config-override.json copied (config layer fidelity)");
  } else {
    log("WARN: config-override.json absent in prod baseDir — temp gateway runs yaml layer only");
  }

  // 2) 租户三元组（副本直查）
  const db = new DatabaseSync(dbCopy, { readOnly: true });
  const triples = db.prepare("select team_id, user_id, agent_id, count(*) n from l1_records group by team_id, user_id, agent_id order by n desc").all();
  db.close();
  const hit = triples.find((t) => t.team_id === PROD_TEAM && t.agent_id === PROD_AGENT);
  if (!hit) throw new Error("副本未找到生产主租户: " + JSON.stringify(triples.slice(0, 5)));
  const tenant = { team_id: hit.team_id, user_id: hit.user_id, agent_id: hit.agent_id };
  log("tenant=" + JSON.stringify(tenant) + " l1rows=" + hit.n);

  // 3) 临时 yaml（baseDir=副本；结伴生全关；recall=生产值原样）
  const cfg = JSON.parse(JSON.stringify(prod));
  cfg.server = Object.assign({}, prod.server, { port: PORT });
  cfg.data = Object.assign({}, prod.data, { baseDir: tmpDir });
  if (cfg.memory) {
    if (cfg.memory.lifecycle) cfg.memory.lifecycle.enabled = false;
    if (cfg.memory.capture) cfg.memory.capture.enabled = false;
    if (cfg.memory.extraction) cfg.memory.extraction.enabled = false;
  }
  if (cfg.skill && cfg.skill.extraction) cfg.skill.extraction.enabled = false;
  // v3Recall 超时放宽到 60s：临时网关首呼为冷启动（embedding API TLS 握手/LLM 连接/本地 rerank
  // 惰性加载），生产网关长驻等效温态不受此限；超时只作中止界，不改变召回计算路径与 perfMs 计量。
  for (const holder of [cfg.recall, cfg.memory && cfg.memory.recall]) {
    if (holder && holder.v3Recall) holder.v3Recall.timeoutMs = 60000;
  }
  const yamlFile = path.join(tmpDir, "gateway.yaml");
  fs.writeFileSync(yamlFile, YAML.stringify(cfg), "utf8");

  await startGw(yamlFile);
  const redCards = [];

  // 预热呼（不计指标）：温化 embedding API/LLM 连接/本地 rerank——冷启动首呼可超 5s 级（2026-10-20
  // 504 实证）。只读召回打在副本上，零生产写入；journal 落 tmpDir。
  try {
    await recall("TDD 工程纪律 预热", "rp-warmup-" + ts, apiKey, tenant);
    log("warmup recall ok");
  } catch (e) {
    log("WARN warmup failed (continuing): " + String((e && e.message) || e).slice(0, 200));
  }

  // 4) Pass A：干净查询复放
  const cleanRuns = [];
  for (const round of rounds) {
    // 审查 M1 旁证修复：dataset.queryClean 是构建期冻结产物（半角形态残留主题尾巴）→ 复放前按当前
    // sanitizer 口径（sanitize.ts pattern8 两形态并容）再剥一次区段头行，杜绝冻结伪影进查询。
    const cleanQuery = round.queryClean.replace(/^\s*[【\[]Compressed conversation section[】\]][^\n]*$/gim, "");
    const res = await recall(cleanQuery, "rp-clean-" + round.id + "-" + ts, apiKey, tenant);
    // block = soul 注入段（- [strict_rule] 等，恒 8 行/轮，DS-RECALL-MERGE-001 服务端合流）+ 记忆行；
    // 生产 journal memoryLines 口径只含记忆行 → 指标一律按记忆行计，soul 行单列（2026-10-20 实证 other=72=8×9 全为 soul 段）。
    const memLines = res.lines.filter((l) => levelOf(l) !== "other");
    const soulLines = res.lines.length - memLines.length;
    const exps = (round.expected || []).filter((x) => x.tier === "high" || x.tier === "mid")
      .map((x) => ({ rowIndex: x.rowIndex, tier: x.tier, frag: frag32(x.rowText) }));
    const expsHigh = (round.expected || []).filter((x) => x.tier === "high")
      .map((x) => ({ rowIndex: x.rowIndex, tier: x.tier, frag: frag32(x.rowText) }));
    const hits = exps.filter((f) => memLines.some((l) => norm(l).includes(f.frag)));
    const hitsHigh = expsHigh.filter((f) => memLines.some((l) => norm(l).includes(f.frag)));
    const layerCount = { conclusion: 0, work_fact: 0, persona: 0, other: 0 };
    for (const l of memLines) layerCount[levelOf(l)]++;
    cleanRuns.push({
      id: round.id, systemPov: !!round.systemPov,
      expectedRows: (round.journal.memoryLines || []).length, returnedRows: memLines.length, soulLines,
      empty: memLines.length === 0, perfMs: (res.meta.perfMs && res.meta.perfMs.total) ?? null, perfBreakdown: res.meta.perfMs ?? null, sessionReused: res.meta.sessionReused ?? null,
      highExpected: exps.length, highHits: hits.length, strictHighExpected: expsHigh.length, strictHighHits: hitsHigh.length,
      hitDetail: exps.map((f) => ({ rowIndex: f.rowIndex, tier: f.tier, hit: hits.includes(f) })),
      layerCount, returnedHead: memLines.map((l) => l.slice(0, 140)),
    });
    // 审查 M2 红牌兜底：分类后零行时同时报原始带 tag 行数（排除 soul strict_rule 段），
    // 区分「真零召回」与「分类器/渲染形态漂移导致的伪零」。
    const nonSoulTagged = res.lines.filter((l) => /^- \[(?!strict_rule\b)/.test(l)).length;
    if (!round.systemPov && memLines.length === 0) redCards.push(round.id + " 生产轮复放零记忆行（生产 journal 有行 → 复放/生产行为分歧，需归因；raw 带 tag 行=" + nonSoulTagged + "，>0 疑分类器/渲染漂移）");
    log("clean " + round.id + " memRows=" + memLines.length + " soulLines=" + soulLines + " high=" + hits.length + "/" + exps.length + " strictHigh=" + hitsHigh.length + "/" + expsHigh.length + " perf=" + ((res.meta.perfMs && res.meta.perfMs.total) ?? "?") + "ms");
  }

  // 5) Pass B：原始查询复放（混脚手架）+ 纯脚手架探针（#74 活体验证）
  const rawRuns = [];
  for (const round of rounds) {
    // queryRaw 在 journal 嵌套内（dataset 结构：round.journal.queryRaw；round.queryRaw 恒 undefined——2026-10-20 实证修正）
    const rawQuery = (round.journal && round.journal.queryRaw) ?? round.queryRaw;
    if (rawQuery === round.queryClean) continue;
    if (!String(rawQuery || "").trim()) {
      rawRuns.push({ id: round.id, skipped: true, skipReason: "empty-queryRaw-not-replayable", rows: 0, cleanOverlap: 0, cleanRows: 0 });
      log("raw " + round.id + " skipped (queryRaw 空串，无法复放)");
      continue;
    }
    const res = await recall(rawQuery, "rp-raw-" + round.id + "-" + ts, apiKey, tenant);
    const clean = cleanRuns.find((c) => c.id === round.id);
    const headSet = new Set(clean.returnedHead.map((l) => norm(l).slice(0, 32)));
    const rawMem = res.lines.filter((l) => levelOf(l) !== "other");
    const overlap = rawMem.filter((l) => headSet.has(norm(l).slice(0, 32))).length;
    rawRuns.push({ id: round.id, skipped: res.skipReason !== null, skipReason: res.skipReason, rows: rawMem.length, soulLines: res.lines.length - rawMem.length, cleanOverlap: overlap, cleanRows: clean.returnedRows });
    log("raw " + round.id + " skipped=" + (res.skipReason !== null) + " memRows=" + rawMem.length + " overlap=" + overlap + "/" + clean.returnedRows);
  }
  const probeRuns = [];
  for (const p of meta.probes || []) {
    const res = await recall(p.queryRaw, "rp-probe-" + p.id + "-" + ts, apiKey, tenant);
    probeRuns.push({ id: p.id, skipped: res.skipReason !== null, skipReason: res.skipReason, rows: res.lines.length, perfMs: (res.meta.perfMs && res.meta.perfMs.total) ?? null });
    if (res.skipReason === null) redCards.push("纯脚手架探针 " + p.id + " 未跳过（#74 两级策略未生效或被绕过）");
    log("probe " + p.id + " skipped=" + (res.skipReason !== null) + " rows=" + res.lines.length);
  }

  // 6) 四指标汇总（生产子集口径，P6 单列）
  const prodRounds = cleanRuns.filter((c) => !c.systemPov);
  const highExp = prodRounds.reduce((s, c) => s + c.highExpected, 0);
  const highHit = prodRounds.reduce((s, c) => s + c.highHits, 0);
  const perfs = prodRounds.map((c) => c.perfMs).filter((v) => typeof v === "number");
  const totalMemRows = prodRounds.reduce((s, c) => s + c.returnedRows, 0);
  const strictExp = prodRounds.reduce((s, c) => s + c.strictHighExpected, 0);
  const strictHit = prodRounds.reduce((s, c) => s + c.strictHighHits, 0);
  const summary = {
    highValueHitRate: highExp ? +(highHit / highExp).toFixed(3) : null,
    highValueHitDetail: highHit + "/" + highExp + "（expected=high+mid 行的召回率）",
    strictHighHitRate: strictExp ? +(strictHit / strictExp).toFixed(3) : null,
    strictHighHitDetail: strictHit + "/" + strictExp + "（仅 tier=high）",
    memoryRowsReturned: totalMemRows,
    highValuePrecisionProxy: totalMemRows ? +(highHit / totalMemRows).toFixed(3) : null,
    emptyRecallRate: +(prodRounds.filter((c) => c.empty).length / prodRounds.length).toFixed(3),
    scaffoldProbeSkipped: probeRuns.filter((p) => p.skipped).length + "/" + probeRuns.length,
    mixedRawNoSkipAndOverlap: rawRuns.map((r) => ({ id: r.id, skipped: r.skipped, overlap: r.cleanOverlap + "/" + r.cleanRows })),
    perfMs: { p50: quantile(perfs, 0.5), p90: quantile(perfs, 0.9), n: perfs.length },
    layerComposition: prodRounds.reduce((acc, c) => { for (const k of Object.keys(c.layerCount)) acc[k] = (acc[k] || 0) + c.layerCount[k]; return acc; }, {}),
  };
  if (summary.highValueHitRate !== null && summary.highValueHitRate < 0.2) redCards.push("高价值命中率 " + summary.highValueHitRate + " 远低于 T4 基线带宽（复放环境失真？先查 embedding/配置）");

  // 审查 m6：HEAD 原文是 ref（"ref: refs/heads/main"）非 SHA——解析到 40 位提交哈希
  //（loose ref → packed-refs 兜底），归档溯源可信（对齐既有评测 corpus/gitSha 双一致纪律）。
  const resolveGitSha = () => {
    try {
      const gitDir = path.join(CORE_DIR, "..", ".git");
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      const m = head.match(/^ref: (.+)$/);
      if (!m) return head;
      const loose = path.join(gitDir, m[1]);
      if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim();
      const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
      const line = packed.split("\n").find((l) => l.trim().endsWith(" " + m[1]));
      return line ? line.split(" ")[0] : head;
    } catch { return null; }
  };
  const gitSha = resolveGitSha();
  const archive = {
    archivedAt: new Date().toISOString(), gitSha,
    dataset: DATASET_FILE, tenant, dbCopyUsed: dbCopy,
    configSnapshot: { recall: cfg.memory ? cfg.memory.recall : null, companionDisabled: ["memory.lifecycle", "memory.capture", "memory.extraction", "skill.extraction"], tempGatewayPort: PORT },
    summary, cleanRuns, rawRuns, probeRuns,
    redCards, metaNotes: meta.discrepancy,
  };
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const runFile = path.join(RUNS_DIR, ts + ".json");
  fs.writeFileSync(runFile, JSON.stringify(archive, null, 2), "utf8");
  log("archive: " + runFile);
  log("SUMMARY " + JSON.stringify(summary));
  for (const rc of redCards) loud(rc);
  if (!redCards.length) log("no red cards");

  stopGw();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  log("tmp cleaned: " + tmpDir);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { loud("run failed:", e && e.stack || String(e)); stopGw(); if (TMP_REF) { try { fs.rmSync(TMP_REF, { recursive: true, force: true }); } catch {} } process.exit(1); })
  .finally(() => stopGw());
