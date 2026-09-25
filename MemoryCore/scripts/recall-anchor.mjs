/**
 * 记忆召回轻量锚点归档（Task GOLD，E' 零人工设计）— 正式化自 recall-compare.mjs v2。
 *
 * 用途：对 MemoryCore L1 混合检索做 OFF（十开关全 0）/ON（生产值）排序对比 + 通道归因
 *       + Precision@5 粗门 + FTS 交叉自检，归档到 docs/superpowers/evals/memory-recall-golden/runs/。
 *
 * 隔离纪律（brief 裁决）：
 *   - 生产 tdai-gateway.yaml 全程只读——本脚本只 readFileSync 读取，绝不写入；
 *     临时 yaml（TDAI_GATEWAY_CONFIG 指向，os.tmpdir 内）承载十开关改写与结伴生关闭。
 *   - 临时网关端口 8422（避开生产 8420 / MemoryKnowledge 8421 / Panel 8123），自起自停。
 *   - 生产 DB 路径 = 生产 yaml data.baseDir 派生（GOLD-FIX 2026-09-15：原硬编码 D:/tdai-data 随本地迁移已失效），TDAI_ANCHOR_DB 可覆盖；只用 DatabaseSync readOnly（语料快照 / FTS 交叉自检 /
 *     bump 清单前后照），与排序路径零交集。
 *   - 结伴生关闭：临时 yaml 中 lifecycle/capture/extraction/skill.extraction 全部置 false，
 *     最小化临时网关对生产库的写入面（召回本身的 reconsolidation bump 如实记录）。
 *
 * 键名勘误（相对 recall-compare.mjs v2 的修复）：config.ts 只读 memory.recall.coreRefBoost
 * （src/config.ts:831），生产 yaml 的 valueBoost 键不被消费。v2 的 setPhase 写 valueBoost
 * 导致其 OFF 阶段 coreRef 通道实际未关（默认 0.05 仍生效）。本脚本统一改写 coreRefBoost。
 *
 * 运行：cd MemoryCore && node --import tsx scripts/recall-anchor.mjs
 * 门失败处理：红牌写归档 JSON + stderr loud，不阻塞（exit 0，零人工）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";

// 生产同构模块（tsx 直跑）：排序信号纯函数 + FTS 查询构造（单一源，不重写）
const { timeSignalOf, recencySignalOf, significanceSignalOf,
        certaintyMultiplierOf, reinforcementSignalOf, moodSignalOf, moodSignOf,
        sceneSignalOf, detectSceneHit } = await import("../src/core/tools/recall-signals.ts");
const { parseTimeWindow } = await import("../src/core/tools/content-time-window.ts");
const { buildFtsQuery } = await import("../src/core/store/sqlite.ts");
const { appraise, DEFAULT_APPRAISAL_CONFIG } = await import("../src/core/lifecycle/feeling/appraisal.ts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(__dirname, "..");
const GOLD_DIR = path.resolve(CORE_DIR, "..", "docs", "superpowers", "evals", "memory-recall-golden");
const RUNS_DIR = path.join(GOLD_DIR, "runs");
const PROD_YAML = path.join(CORE_DIR, "tdai-gateway.yaml"); // 只读
// GOLD-FIX（2026-09-15）：DB 路径不再硬编码盘符——本地迁移后 D:/tdai-data 已不存在，
// 硬编码使锚点静默指向不存在的库。解析顺序：TDAI_ANCHOR_DB 环境变量（评估快照副本
// 时显式覆盖）> 生产 yaml data.baseDir。库文件缺失 → loud 报错退出，绝不静默跑空。
const PROD_YAML_CFG = YAML.parse(fs.readFileSync(PROD_YAML, "utf8"));
const ANCHOR_BASE_DIR = PROD_YAML_CFG?.data?.baseDir ?? "";
const DB_PATH = process.env.TDAI_ANCHOR_DB ?? path.resolve(ANCHOR_BASE_DIR, "vectors.db");
if (!fs.existsSync(DB_PATH)) {
  console.error(`[anchor] FATAL: 生产 DB 不存在: ${DB_PATH}`);
  console.error(`[anchor] 来源: tdai-gateway.yaml data.baseDir="${ANCHOR_BASE_DIR}"${process.env.TDAI_ANCHOR_DB ? "（TDAI_ANCHOR_DB 覆盖）" : ""}`);
  console.error("[anchor] 修复: 检查 tdai-gateway.yaml 的 data.baseDir，或设 TDAI_ANCHOR_DB=<vectors.db 路径>");
  process.exit(1);
}
const PORT = 8422;
const API_BASE = `http://127.0.0.1:${PORT}`;
// 与生产同源（生产 yaml server.apiKey 已随仓入库；归档 JSON 不落 key）
const ISO = { team_id: "team-2j92u63hre", user_id: "usr-2t8126nehp", agent_id: "agt-2t81sh9zdz" };
const QUERIES = [
  "网关重启和安全操作纪律",
  "密钥与敏感信息管理要求",
  "记忆是怎么从对话里提取出来的",
  "召回排序的信号和规则",
  "灵魂注入的格式与预算",
  "面板 UI 展示要求",
  "数据库操作规范",
  "提案与待裁决机制",
  "测试与验收纪律",
  "多租户隔离保障",
];
/** Precision@5 粗门阈值：mean P@5 < 0.6 → 红牌（不阻塞）。阈值与 wiki golden 诚实基线 0.66 同量级。 */
const P5_GATE_THRESHOLD = 0.6;
const SWITCH_KEYS = ["timeBoost","recencyBoost","sigWeight","inferredPenalty","reinforcementWeight","moodBoost","coreRefBoost","graphMinStrength","graphDiscount","sceneBoost"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[recall-anchor]", ...a);
const loud = (...a) => console.error("[recall-anchor][RED-CARD]", ...a);

// ── 生产 yaml 只读读取 + 临时 yaml 构造 ─────────────────────────────
function buildTempYaml(phase, ts) {
  const prod = fs.readFileSync(PROD_YAML, "utf8"); // 只读
  const cfg = YAML.parse(prod);
  if (phase === "off") {
    // 十开关全 0（graphMinStrength 为阈值旋钮，graphDiscount=0 时通道整体退出，
    // 此处一并置 0 以逐字满足"十开关全 0"）
    for (const k of SWITCH_KEYS) cfg.memory.recall[k] = 0;
  } else {
    // ON = 生产值（valueBoost 键勘误：config 只读 coreRefBoost）
    const r = cfg.memory.recall;
    if (r.coreRefBoost === undefined) r.coreRefBoost = r.valueBoost ?? 0.05;
    delete r.valueBoost;
    // V12-任务2（2026-09-25 何晨拍板）：TDAI_ANCHOR_ON_OVERRIDES（JSON）注入 ON 相位开关
    // 覆盖（R8/R10 A/B 用）；未设=生产值逐位现状。覆盖值随归档 onOverrides 留痕。
    if (process.env.TDAI_ANCHOR_ON_OVERRIDES) {
      const ov = JSON.parse(process.env.TDAI_ANCHOR_ON_OVERRIDES);
      for (const [k, v] of Object.entries(ov)) cfg.memory.recall[k] = v;
    }
  }
  // 结伴生关闭（最小化临时网关写入面；召回 bump 属排序链路本身，另行照单）
  cfg.server.port = PORT;
  if (cfg.memory) {
    if (cfg.memory.lifecycle) cfg.memory.lifecycle.enabled = false;
    if (cfg.memory.capture) cfg.memory.capture.enabled = false;
    if (cfg.memory.extraction) cfg.memory.extraction.enabled = false;
  }
  if (cfg.skill && cfg.skill.extraction) cfg.skill.extraction.enabled = false;
  const out = path.join(os.tmpdir(), `recall-anchor-${phase}-${ts}.yaml`);
  fs.writeFileSync(out, YAML.stringify(cfg), "utf8");
  return { file: out, recall: cfg.memory.recall };
}

// ── 临时网关自起自停 ────────────────────────────────────────────────
let gw = null;
async function startGw() {
  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway/server.ts"], {
    cwd: CORE_DIR,
    env: { ...process.env, TDAI_GATEWAY_CONFIG: gw.yamlFile },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  gw.unref();
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    try {
      const h = await (await fetch(`${API_BASE}/health`)).json();
      if (h.status === "ok") return;
    } catch { /* not up yet */ }
  }
  throw new Error(`temp gateway on :${PORT} not healthy in 45s`);
}
function stopGw() {
  if (!gw) return;
  try { process.kill(-gw.pid); } catch { /* already gone */ }
  try { gw.kill(); } catch { /* already gone */ }
  gw = null;
}

// ── 检索调用 ────────────────────────────────────────────────────────
async function search(query, sessionId, apiKey) {
  const r = await fetch(`${API_BASE}/v3/atomic/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "x-tdai-service-id": "default" },
    body: JSON.stringify({ query, limit: 5, ...ISO, session_id: sessionId }),
  });
  if (!r.ok) throw new Error(`atomic/search HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  return (j?.data?.items ?? []).map((x) => ({
    id: x.id, score: x.score, type: x.type, content: x.content,
    scene_name: x.background ?? null,
    occurred_at: x.occurred_at, valid_start: x.valid_start, valid_end: x.valid_end,
    certainty: x.certainty, valence: x.valence, significance: x.significance,
    metadata: x.metadata ?? {},
  }));
}

// ── 只读 DB：语料统计 / core_values / FTS 交叉自检 / bump 照片 ──────
function openRo() { return new DatabaseSync(DB_PATH, { readOnly: true }); }

function corpusStats(db) {
  const scope = `team_id='${ISO.team_id}' AND user_id='${ISO.user_id}' AND agent_id='${ISO.agent_id}'`;
  const total = db.prepare(`select count(*) n from l1_records where ${scope}`).get().n;
  const byType = {};
  for (const r of db.prepare(`select type, count(*) n from l1_records where ${scope} group by type`).all()) byType[r.type] = r.n;
  return { scopeCount: total, byType, scope: ISO };
}

function listValues(db) {
  return db.prepare("select value_id, label, weight, valence from core_values").all()
    .filter((v) => typeof v.label === "string" && v.label.trim());
}

function ftsCrossCheck(db, query, onIds) {
  const fq = buildFtsQuery(query);
  if (!fq) return { query, ftsQuery: null, warn: false, ftsTop5: [] };
  const rows = db.prepare(
    `select record_id, bm25(l1_fts) AS rank from l1_fts
     where l1_fts match ? and team_id = ? and user_id = ? and agent_id = ?
     order by rank limit 5`
  ).all(fq, ISO.team_id, ISO.user_id, ISO.agent_id);
  const ftsTop5 = rows.map((x) => x.record_id);
  const hits = ftsTop5.filter((id) => onIds.includes(id));
  // warn 级：FTS 词面强命中被 hybrid top-5 丢弃 → 警告不失败
  return { query, ftsQuery: fq, warn: ftsTop5.length > 0 && hits.length === 0, ftsTop5, hitsInHybrid: hits };
}

/** bump 前后照：{record_id: {recall_count, last_recalled_at}}（metadata_json 只读解析） */
function bumpPhoto(db) {
  const rows = db.prepare(
    "select record_id, metadata_json from l1_records where team_id = ? and user_id = ? and agent_id = ?"
  ).all(ISO.team_id, ISO.user_id, ISO.agent_id);
  const out = {};
  for (const r of rows) {
    let m = {};
    try { m = r.metadata_json ? JSON.parse(r.metadata_json) : {}; } catch { m = {}; }
    out[r.record_id] = { recall_count: typeof m.recall_count === "number" ? m.recall_count : undefined,
                         last_recalled_at: typeof m.last_recalled_at === "string" ? m.last_recalled_at : undefined };
  }
  return out;
}
function bumpDiff(before, after) {
  const bumps = [];
  for (const [id, a] of Object.entries(after)) {
    const b = before[id] ?? {};
    const cnt = (a.recall_count ?? 0) - (b.recall_count ?? 0);
    const rec = a.last_recalled_at !== b.last_recalled_at;
    if (cnt > 0 || rec) bumps.push({ id, recallCountDelta: cnt, lastRecalledAtChanged: rec, lastRecalledAt: a.last_recalled_at ?? null });
  }
  return bumps;
}

// ── 通道归因（依据 recall-signals 各信号分量的实际取值） ────────────
// coreRef 分量与 memory-search.ts:206-225 resolveCoreRefBoost 同构（4 行交集判定，
// 避免为取纯函数引入 memory-search 模块的整链依赖；语义以源码注释为准）。
function coreRefsOf(item) {
  const refs = item?.metadata?.coreRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((s) => typeof s === "string" && s.trim().length > 0);
}

function attributeItem(item, ctx) {
  const ch = {};
  const tw = timeSignalOf(item, ctx.timeWindow, ctx.signals.timeBoost);
  if (tw > 0) ch["R1时窗"] = tw;
  const rec = recencySignalOf(item, ctx.now, ctx.signals.recencyBoost);
  if (rec > 0) ch["R1时近"] = rec;
  const sig = significanceSignalOf(item, ctx.signals.sigWeight);
  if (sig > 0) ch["R2重要性"] = sig;
  const r8 = reinforcementSignalOf(item, ctx.signals.reinforcementWeight);
  if (r8 > 0) ch["R8强化"] = r8;
  const r5 = coreRefsOf(item).some((s) => ctx.firedLabels.includes(s)) ? ctx.signals.coreRefBoost : 0;
  if (r5 > 0) ch["R5价值"] = r5;
  const r6 = sceneSignalOf(item, ctx.sceneHit, ctx.signals.sceneBoost);
  if (r6 > 0) ch["R6场景"] = r6;
  const r9 = moodSignalOf(item, ctx.moodSign, ctx.signals.moodBoost);
  if (r9 > 0) ch["R9情绪"] = r9;
  const mult = certaintyMultiplierOf(item, ctx.signals.inferredPenalty);
  if (mult < 1) ch["R3降权"] = 1 - mult;
  return ch;
}

function buildCtx(query, items, values, onSignals) {
  const now = new Date();
  const fired = appraise(query, values, DEFAULT_APPRAISAL_CONFIG).filter((a) => a.fired);
  const valenceByLabel = new Map(values.map((v) => [v.label.trim(), typeof v.valence === "number" ? v.valence : null]));
  const firedValues = fired.map((a) => ({ label: a.value.label, weight: a.weight, valence: valenceByLabel.get(a.value.label) ?? null }));
  return {
    now,
    timeWindow: parseTimeWindow(query, now),
    firedLabels: firedValues.map((v) => v.label),
    moodSign: moodSignOf(firedValues.map((v) => v.valence)),
    sceneHit: detectSceneHit(query, items.map((i) => i?.scene_name ?? "")),
    signals: onSignals,
  };
}

// ── Precision@5 粗门 ────────────────────────────────────────────────
function loadLabels() {
  const file = path.join(GOLD_DIR, "labels.jsonl");
  return fs.readFileSync(file, "utf8").split("\n")
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o) => o && o.query && Array.isArray(o.relevant));
}

function precision5(relevant, ids) {
  if (!relevant.length) return { hits: 0, denom: 0, p: null };
  const hits = relevant.filter((id) => ids.includes(id)).length;
  return { hits, denom: relevant.length, p: hits / relevant.length };
}

// ── 主流程 ──────────────────────────────────────────────────────────
async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const labels = loadLabels();
  const labelByQuery = new Map(labels.map((l) => [l.query, l.relevant]));

  // 生产 yaml server.apiKey（走 YAML.parse 取值——正则会误命中注释里的占位符 "your-key"）
  const prodCfg = YAML.parse(fs.readFileSync(PROD_YAML, "utf8")); // 只读
  const apiKey = prodCfg?.server?.apiKey;
  if (typeof apiKey !== "string" || !apiKey) throw new Error("server.apiKey not found in production yaml (read-only)");

  const db = openRo();
  const stats = corpusStats(db);
  const values = listValues(db);
  // 口径澄清（2026-09-11）：values 为 core_values 全表行数（含各 agent 扇出副本与
  // veto 残留）——护栏上限 15 是 per-agent active 口径，两者不可直接比较
  // （生产实证：全表 37 = 5 agent × 6 active + 1 veto 残留，per-agent 全部 ≤7，护栏无失效）。
  const activeAnchorTenant = values.filter(
    (v) => v.state === "active" && v.agent_id === "agt-2t81sh9zdz",
  ).length;
  const bumpBefore = bumpPhoto(db);
  db.close();
  log(`corpus=${stats.scopeCount} labels=${labels.length} values=${values.length}（全表，含副本/否决） anchorTenantActive=${activeAnchorTenant}`);

  // OFF 双跑（各自冷启动 + 独立 session，防 E3 session 复用缓存跨轮污染）+ ON 单跑
  const offRuns = [[], []];
  const onRun = [];
  for (const [pass, results] of [[1, offRuns[0]], [2, offRuns[1]], [3, onRun]]) {
    const phase = pass <= 2 ? "off" : "on";
    const tmp = buildTempYaml(phase, `${ts}-p${pass}`);
    gw = { yamlFile: tmp.file };
    await startGw();
    log(`phase=${phase} pass=${pass} port=${PORT}`);
    const session = `anchor-${phase}-${pass}-${ts}`;
    for (const q of QUERIES) results.push({ query: q, items: await search(q, session, apiKey) });
    stopGw();
    await sleep(1500);
    fs.rmSync(tmp.file, { force: true });
  }

  // OFF 确定性断言：两趟逐位一致（比较 top-5 id 序列）
  const offMismatch = [];
  for (const q of QUERIES) {
    const a = offRuns[0].find((x) => x.query === q).items.map((i) => i.id);
    const b = offRuns[1].find((x) => x.query === q).items.map((i) => i.id);
    if (JSON.stringify(a) !== JSON.stringify(b)) offMismatch.push({ query: q, pass1: a, pass2: b });
  }
  const offDeterminism = { method: "OFF 两趟冷启动，比较 top-5 id 序列逐位一致", mismatchCount: offMismatch.length, passed: offMismatch.length === 0, mismatches: offMismatch };
  if (!offDeterminism.passed) loud(`OFF 确定性断言失败：${offMismatch.length}/10 query 两趟 id 序列不一致（embedding 外呼近似确定 + R1·R8 时变通道，见 README 局限性）`);

  // 通道归因 + per-query 组装（ON 生产值；valueBoost→coreRefBoost 勘误）
  const prodRecall = prodCfg.memory.recall;
  const onSignals = { ...prodRecall };
  if (onSignals.coreRefBoost === undefined) onSignals.coreRefBoost = onSignals.valueBoost ?? 0.05;
  delete onSignals.valueBoost;

  const perQuery = [];
  const ftsWarnings = [];
  for (const q of QUERIES) {
    const off = offRuns[0].find((x) => x.query === q).items;
    const on = onRun.find((x) => x.query === q).items;
    const offIds = off.map((i) => i.id);
    const onIds = on.map((i) => i.id);
    const ctx = buildCtx(q, [...off, ...on], values, onSignals);
    const setO = new Set(offIds), setN = new Set(onIds);
    const entered = on.filter((i) => !setO.has(i.id)).map((i) => ({ id: i.id, score: i.score, channels: attributeItem(i, ctx) }));
    const exited = off.filter((i) => !setN.has(i.id)).map((i) => ({ id: i.id, score: i.score, channels: attributeItem(i, ctx) }));
    const relevant = labelByQuery.get(q) ?? [];
    const pOn = precision5(relevant, onIds);
    const pOff = precision5(relevant, offIds);
    const fts = ftsCrossCheck(openRo(), q, onIds);
    if (fts.warn) ftsWarnings.push(fts);
    perQuery.push({
      query: q,
      ctx: { firedLabels: ctx.firedLabels, moodSign: ctx.moodSign, timeWindow: ctx.timeWindow, sceneHit: ctx.sceneHit },
      off: offIds, off2: offRuns[1].find((x) => x.query === q).items.map((i) => i.id),
      on: on.map((i) => ({ id: i.id, score: i.score })),
      rankChanged: JSON.stringify(offIds) !== JSON.stringify(onIds),
      entered, exited,
      precision5: { relevantCount: relevant.length, onHits: pOn.hits, offHits: pOff.hits, on: pOn.p, off: pOff.p },
      ftsCrossCheck: { ftsTop5: fts.ftsTop5, warn: fts.warn, hitsInHybrid: fts.hitsInHybrid ?? [] },
    });
  }

  // 粗门：mean P@5（对照 labels）
  const ps = perQuery.map((x) => x.precision5.on).filter((p) => p !== null);
  const meanP = ps.length ? ps.reduce((s, p) => s + p, 0) / ps.length : 0;
  const gatePassed = meanP >= P5_GATE_THRESHOLD;
  const gate = { kind: "precision@5", threshold: P5_GATE_THRESHOLD, meanOn: meanP, passed: gatePassed, redCard: !gatePassed, blocking: false };
  if (!gatePassed) loud(`Precision@5 粗门未过：mean ON P@5=${meanP.toFixed(3)} < ${P5_GATE_THRESHOLD}（红牌，不阻塞）`);
  for (const w of ftsWarnings) loud(`FTS 交叉自检 warn：query="${w.query}" 的 FTS top-5 词面强命中被 hybrid top-5 全部丢弃`);

  // bump 清单（方向性污染声明：OFF 先行 → ON 基于已被 OFF 污染的时变通道状态）
  const db2 = openRo();
  const bumps = bumpDiff(bumpBefore, bumpPhoto(db2));
  db2.close();

  // 归档
  const emb = prodCfg.memory.embedding ?? {};
  const embFingerprint = crypto.createHash("sha256")
    .update([emb.baseUrl, emb.model, emb.dimensions].join("|")).digest("hex").slice(0, 16);
  const archive = {
    gitSha: (() => { try { return fs.readFileSync(path.join(CORE_DIR, "..", ".git", "HEAD"), "utf8").trim(); } catch { return null; } })(),
    gitShaResolved: null,
    archivedAt: new Date().toISOString(),
    configSnapshot: {
      tenSwitchesOn: onSignals,
      tenSwitchesOff: Object.fromEntries(SWITCH_KEYS.map((k) => [k, 0])),
      onOverrides: process.env.TDAI_ANCHOR_ON_OVERRIDES ?? null,
      embeddingFingerprint: embFingerprint,
      embedding: { baseUrl: emb.baseUrl, model: emb.model, dimensions: emb.dimensions },
      tempGatewayPort: PORT,
      companionSchedulersDisabled: ["memory.lifecycle", "memory.capture", "memory.extraction", "skill.extraction"],
      productionYaml: "READ-ONLY（本脚本未写入生产 tdai-gateway.yaml）",
      corpus: stats,
      coreValues: values.map((v) => ({ label: v.label, weight: v.weight, valence: v.valence })),
    },
    offDeterminism,
    reconsolidationBumps: {
      count: bumps.length, items: bumps,
      note: "OFF 先行的方向性污染声明：检索触发 bumpRecallCount（recall_count/last_recalled_at），OFF 双跑会污染后续 ON 跑的 R1时近/R8强化 分量取值；锚点记录归因而非永恒排序。",
    },
    gate,
    ftsWarningsCount: ftsWarnings.length,
    perQuery,
  };
  // gitSha 解析（detached HEAD 支持，读不到则如实 null）
  try {
    const { execSync } = await import("node:child_process");
    archive.gitShaResolved = execSync("git rev-parse HEAD", { cwd: CORE_DIR, encoding: "utf8" }).trim();
  } catch { archive.gitShaResolved = null; }

  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const runFile = path.join(RUNS_DIR, `${ts}.json`);
  fs.writeFileSync(runFile, JSON.stringify(archive, null, 2), "utf8");
  log(`archive written: ${runFile}`);
  log(`OFF determinism: ${offDeterminism.passed ? "PASS" : "FAIL"} | gate mean P@5=${meanP.toFixed(3)} (${gatePassed ? "pass" : "RED-CARD"}) | bumps=${bumps.length} | ftsWarn=${ftsWarnings.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { loud("anchor run failed:", e?.stack ?? String(e)); stopGw(); process.exit(1); })
  .finally(() => stopGw());
