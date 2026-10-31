#!/usr/bin/env node
/**
 * #168 长会话退化基准：场景生成器 + 三臂跑法（默认 dry-run，不触网）。
 *
 * 为什么需要这个脚本（issue #168 / docs/optimization-results.md §26.4 差距①）：
 *   现有 bench 的读数（r141 等）几乎都在 --no-write-steps 档跑——整段跳过写侧，
 *   所以「写侧固化开关」（write.supersession / consolidation）从来没法被量化。本脚本：
 *     ① 生成 30-50 条同实体多值更新序列（20-60 轮/条、5-10 次同属性更新）；
 *     ② 用**确定性 ground truth 三元组**喂给 src/core/record/supersession.ts 的同一实现
 *        （零 LLM 抽取），因此三臂可以离线跑通，不产生任何 LLM 调用；
 *     ③ 给出与 judge 无关的硬指标：旧值注入率、重复行率、问历史仍可召回率、退化曲线。
 *
 * 三臂（写侧开关显式开，缺省全关 = 与 MemoryCore/src/core/record/write-policy.ts:77 逐位一致）：
 *   A baseline          写侧全关（逐位现状）：每轮一行，旧值不失效
 *   B supersede         仅 supersession：同 (subject,predicate) 单值新值 → 旧行 valid_end
 *   C supersede+fold    B + 确定性折叠：每 (实体,属性) 生成一条「当前值」持续态行（work_fact/
 *                       consolidated，保留历史行可追溯）——这是 §27 目标形态的**离线确定性
 *                       替身**；生产 consolidation-worker 是 LLM 驱动的，差异见
 *                       docs/long-session-bench.md「与生产 consolidate 的差异」。
 *
 * 用法：
 *   node --import tsx scripts/gen-long-session-bench.mjs                 # dry-run：只生成语料
 *   node --import tsx scripts/gen-long-session-bench.mjs --cases 4 --out .eval-data/long-session
 *   node --import tsx scripts/gen-long-session-bench.mjs --run --offline-embedding --cases 4 --arm A,B,C
 *   node --import tsx scripts/gen-long-session-bench.mjs --run --allow-embedding --cases 40 --arm A,B,C
 *
 * --run 需要显式二选一：--allow-embedding（真实 embedding 外呼）或 --offline-embedding（hash 向量，
 * 只验证写侧机制与度量管道，**不是检索质量读数**）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LONG_SESSION_SCHEMA_VERSION,
  generateLongSessionCorpus,
  summarizeCorpus,
  toLongMemEvalOracle,
} from "./lib/bench/long-session-corpus.mjs";
import { evaluateQuestion, summarizeArm, normText } from "./lib/bench/long-session-metrics.mjs";
import { makeOfflineEmbedding, OFFLINE_EMBEDDING_CALIBER } from "./lib/bench/offline-embedding.mjs";
import {
  effectiveRecallSnapshot,
  embedWithRetry,
  loadBenchConfig,
  makeRecall,
  makeStoreDir,
  openBenchStore,
  prepareBenchYaml,
  repoRoot,
  turnToRecord,
  applyWriteSteps,
} from "./lib/bench/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MC_ROOT = path.resolve(HERE, "..");

const ARMS = {
  A: { key: "A", label: "baseline", supersede: false, fold: false, desc: "现状（写侧全关）" },
  B: { key: "B", label: "supersede", supersede: true, fold: false, desc: "仅 supersession" },
  C: { key: "C", label: "supersede+fold", supersede: true, fold: true, desc: "supersession + 确定性折叠（模拟 consolidation 目标形态）" },
};

function parseArgs(argv) {
  const out = { flags: new Set(), vals: new Map() };
  const takesValue = new Set([
    "cases", "seed", "out", "turns-min", "turns-max", "updates-min", "updates-max",
    "arm", "src-yaml", "store-root", "embed-interval-ms", "report-name", "copy-override",
    "limit-cases", "turns-per-session-min", "turns-per-session-max",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (takesValue.has(key)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${key} 需要一个值`);
      out.vals.set(key, v);
      i++;
    } else {
      out.flags.add(key);
    }
  }
  return out;
}

function numArg(args, key, dflt) {
  const raw = args.vals.get(key);
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${key} 需要数字，收到 ${raw}`);
  return n;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// makeOfflineEmbedding 已抽到 lib/bench/offline-embedding.mjs（eval-memory-bench 共用同一实现）

function writeCorpusArtifacts(corpus, outDir, opts) {
  ensureDir(outDir);
  const corpusFile = path.join(outDir, "long-session-corpus.json");
  const factsFile = path.join(outDir, "long-session-facts.json");
  const oracleFile = path.join(outDir, "long-session-oracle.json");
  const goldensFile = path.join(outDir, "long-session-goldens.json");
  fs.writeFileSync(corpusFile, JSON.stringify(corpus, null, 2), "utf8");
  fs.writeFileSync(factsFile, JSON.stringify({ schemaVersion: LONG_SESSION_SCHEMA_VERSION, seed: corpus.seed, factsByCase: corpus.factsByCase }, null, 2), "utf8");
  const oracle = toLongMemEvalOracle(corpus);
  fs.writeFileSync(oracleFile, JSON.stringify(oracle, null, 2), "utf8");
  const goldens = {
    schemaVersion: LONG_SESSION_SCHEMA_VERSION,
    seed: corpus.seed,
    caliber: "deterministic-ground-truth（gold 为生成时字面值，不经过 LLM judge）",
    cases: corpus.cases.map((c) => ({
      caseId: c.caseId,
      turnCount: c.turnCount,
      entity: c.entity,
      attribute: c.attribute,
      updates: c.updates,
      questions: c.questions,
    })),
  };
  fs.writeFileSync(goldensFile, JSON.stringify(goldens, null, 2), "utf8");
  return { corpusFile, factsFile, oracleFile, goldensFile, oracleItems: oracle.length };
}

/** 单臂单 case 的写侧：逐轮 embed+upsert（计时），随后 applyWriteSteps（真 supersession 实现）。 */
async function ingestCaseWithTiming({ caseObj, store, embedding, facts, supersede, embedIntervalMs, writeLats }) {
  let written = 0;
  let failed = 0;
  for (const g of caseObj.groups) {
    for (const turn of g.turns) {
      const record = turnToRecord(caseObj, turn, g.sessionId);
      const t0 = performance.now();
      let vec;
      try {
        const r = await embedWithRetry(embedding, [record.content], { minIntervalMs: embedIntervalMs, tries: 4 });
        vec = r?.[0];
      } catch {
        failed++;
      }
      const ok = store.upsertL1(record, vec);
      if (ok !== false) written++;
      writeLats.push(performance.now() - t0);
    }
  }
  const records = [];
  for (const g of caseObj.groups) for (const t of g.turns) records.push({ turn: t, sessionId: g.sessionId });
  const t1 = performance.now();
  const writeStats = await applyWriteSteps({
    caseObj,
    store,
    records,
    facts: facts ? { byTurn: facts } : undefined,
    supersede,
    cardinalityGate: true,
  });
  const supersedeMs = performance.now() - t1;
  return { written, failed, writeStats, supersedeMs };
}

/** 臂 C 的确定性折叠：每 (实体,属性) 一条「当前值」持续态行；历史行保留可追溯。 */
async function insertFoldRows({ caseObj, store, embedding, embedIntervalMs }) {
  const latest = caseObj.updates[caseObj.updates.length - 1];
  if (!latest) return { folded: 0, ms: 0 };
  const id = `${caseObj.caseId}-fold-${caseObj.attribute.key}`;
  const content = `${caseObj.entity}的${caseObj.attribute.label}当前是${latest.value}（由 ${caseObj.updates.length} 次更新折叠而成）。`;
  const record = {
    id,
    content,
    type: "work_fact",
    priority: 70,
    scene_name: "consolidated",
    source_message_ids: caseObj.updates.map((u) => u.turnId),
    metadata: {
      fold_of: caseObj.attribute.key,
      entity: caseObj.entity,
      source_turn_ids: caseObj.updates.map((u) => u.turnId),
      updates: caseObj.updates.length,
      origin: "long-session-bench/offline-fold",
    },
    timestamps: [latest.tsISO],
    createdAt: latest.tsISO,
    updatedAt: latest.tsISO,
    version: 1,
    sessionKey: `${caseObj.tenant.user_id}::fold`,
    sessionId: `${caseObj.caseId}-fold`,
    teamId: caseObj.tenant.team_id,
    userId: caseObj.tenant.user_id,
    agentId: caseObj.tenant.agent_id,
    occurred_at: latest.tsISO,
    valid_start: latest.tsISO,
    certainty: "observed",
    source: "long-session-fold",
  };
  const t0 = performance.now();
  let vec;
  try {
    const r = await embedWithRetry(embedding, [content], { minIntervalMs: embedIntervalMs, tries: 4 });
    vec = r?.[0];
  } catch {
    vec = undefined;
  }
  const ok = store.upsertL1(record, vec);
  if (ok !== false && typeof store.addLink === "function") {
    for (const u of caseObj.updates) {
      try {
        store.addLink(id, u.turnId, "part_of", 1);
      } catch {
        /* 软失败：链路可追溯性尽力而为 */
      }
    }
  }
  return { folded: ok === false ? 0 : 1, ms: performance.now() - t0 };
}

/** 行级统计：仍有效的证据行数 / 同属性有效值个数（重复行率的口径）。 */
function collectRowStats(store, corpus) {
  const attrs = [];
  let foldRows = 0;
  for (const c of corpus.cases) {
    const updateByTurn = new Map(c.updates.map((u) => [u.turnId, u]));
    let activeEvidence = 0;
    const values = new Set();
    const sessions = [...c.groups.map((g) => g.sessionId), `${c.caseId}-fold`];
    for (const sessionId of sessions) {
      let rows = [];
      try {
        rows = store.queryL1Records({ sessionId }) || [];
      } catch {
        rows = [];
      }
      for (const row of rows) {
        const rid = row.record_id ?? row.id ?? "";
        if (String(rid).startsWith(`${c.caseId}-fold-`)) {
          if (!row.valid_end) foldRows++;
          continue;
        }
        const upd = updateByTurn.get(rid);
        if (!upd) continue;
        if (row.valid_end) continue;
        activeEvidence++;
        values.add(normText(upd.value));
      }
    }
    attrs.push({
      attrKey: `${c.caseId}:${c.attribute.key}`,
      activeEvidenceRows: activeEvidence,
      activeDistinctValues: values.size,
      canonicalRows: activeEvidence + (foldRows > 0 ? 1 : 0),
    });
  }
  return { attrs, foldRows };
}

async function runArm({ corpus, armKey, opts }) {
  const arm = ARMS[armKey];
  const storeDir = opts.storeRoot
    ? path.join(opts.storeRoot, `arm-${arm.key}`)
    : makeStoreDir(`long-session-${corpus.seed}-${arm.key}`, false);
  ensureDir(storeDir);
  prepareBenchYaml({
    srcYaml: opts.srcYaml,
    storeDir,
    // 写侧开关只影响我们自己的 applyWriteSteps；读侧精排关掉（省本地模型加载，且与写侧无关）。
    rerankOverride: { enabled: false },
  });
  const { cfg } = await loadBenchConfig(storeDir);
  const { store, embedding, dims } = await openBenchStore(cfg, storeDir);
  // 向量维度以配置里的 embedding.dimensions 为准：openBenchStore 的 getDimensions() 在未真正
  // 初始化远端 provider 时会返回 0，而 sqlite vec0 表按配置维度建表，维度不一致会静默丢行。
  const embedDims = dims > 0 ? dims : Number(cfg.embedding?.dimensions ?? 0);
  if (opts.offlineEmbedding && !(embedDims > 0)) {
    throw new Error("离线 embedding 需要已知向量维度：cfg.embedding.dimensions 为空且 getDimensions()=0");
  }
  const emb = opts.offlineEmbedding ? makeOfflineEmbedding(embedDims) : embedding;
  const recall = makeRecall({ cfg, store, embedding: emb, dataDir: storeDir, validityFromCase: true });

  const writeLats = [];
  const recallLats = [];
  const evaluations = [];
  let written = 0;
  let failed = 0;
  let supersedeMs = 0;
  let foldMs = 0;
  const supersedeOps = [];
  const ingestStats = { turns: 0, written: 0, embedFailed: 0 };

  for (const c of corpus.cases) {
    const facts = corpus.factsByCase[c.caseId];
    const st = await ingestCaseWithTiming({
      caseObj: c,
      store,
      embedding: emb,
      facts,
      supersede: arm.supersede,
      embedIntervalMs: opts.embedIntervalMs,
      writeLats,
    });
    written += st.written;
    failed += st.failed;
    supersedeMs += st.supersedeMs;
    ingestStats.turns += c.turnCount;
    ingestStats.written += st.written;
    if (arm.supersede) {
      const { computeSupersessions } = await import("../src/core/record/supersession.ts");
      const turnFacts = [];
      for (const g of c.groups) {
        for (const t of g.turns) {
          turnFacts.push({
            turnId: t.id,
            timestamp: t.tsISO || "",
            facts: facts?.[t.id]?.triples ?? [],
          });
        }
      }
      for (const op of computeSupersessions(turnFacts, { cardinalityGate: true })) supersedeOps.push(op);
    }
    if (arm.fold) {
      const f = await insertFoldRows({ caseObj: c, store, embedding: emb, embedIntervalMs: opts.embedIntervalMs });
      foldMs += f.ms;
    }
    for (const q of c.questions) {
      const r = await recall(q.question, c);
      const ev = evaluateQuestion(q, r);
      ev.caseTurns = c.turnCount;
      ev.arm = arm.key;
      ev.caseId = c.caseId;
      evaluations.push(ev);
      if (typeof r?.latencyMs === "number") recallLats.push(r.latencyMs);
    }
  }

  const rowStats = collectRowStats(store, corpus);
  const metrics = summarizeArm({
    evaluations,
    rowStats,
    writeLats,
    supersedeMs,
    supersedeOps,
    ingestStats: { ...ingestStats, embedFailed: failed, written },
    recallLatencies: recallLats,
  });
  if (foldMs > 0) metrics.cost.foldMs = Math.round(foldMs * 1000) / 1000;

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    arm: { key: arm.key, label: arm.label, desc: arm.desc, supersede: arm.supersede, fold: arm.fold },
    dataset: { name: "long-session-synthetic", seed: corpus.seed, cases: corpus.cases.length, summary: summarizeCorpus(corpus) },
    caliber: {
      judge: "none（deterministic ground truth；本报告不可与 judge 门禁报告配对）",
      write: "store.upsertL1 + src/core/record/supersession.ts（与生产 l1-writer 的 W2 同实现；未经 LLM 抽取/去重）",
      embedding: opts.offlineEmbedding ? OFFLINE_EMBEDDING_CALIBER : (cfg.embedding?.model ?? "unknown"),
      latency: "writeMs=embed+upsert/轮（不含 LLM 抽取）；recallMs=召回端到端",
    },
    config: { effective: effectiveRecallSnapshot(cfg), storeDir },
    metrics,
    questions: evaluations,
  };
  return { report, storeDir };
}

function printSummary(corpus, artifacts) {
  const s = summarizeCorpus(corpus);
  console.log("[long-session] 语料：" + s.cases + " 条 case / " + s.turns + " 轮 / " + s.updates + " 次更新 / " + s.questions + " 道题");
  console.log(
    "[long-session] 轮数 min=" + s.turnsPerCase.min + " mean=" + s.turnsPerCase.mean + " max=" + s.turnsPerCase.max +
      "；每 case 更新次数 min=" + s.updatesPerCase.min + " max=" + s.updatesPerCase.max,
  );
  console.log("[long-session] 属性族分布：" + Object.entries(s.byFamily).map(([k, v]) => k + "=" + v).join(", "));
  console.log("[long-session] 产出：" + artifacts.corpusFile);
  console.log("[long-session]      " + artifacts.factsFile + "（写侧三元组 sidecar，零 LLM）");
  console.log("[long-session]      " + artifacts.oracleFile + "（LongMemEval-oracle 形状，" + artifacts.oracleItems + " 条，可喂 eval-memory-bench）");
  console.log("[long-session]      " + artifacts.goldensFile);
}

function printArmMetrics(report) {
  const m = report.metrics;
  const pct = (r) => (r?.rate === null || r?.rate === undefined ? "-" : (r.rate * 100).toFixed(1) + "%");
  console.log(
    "[long-session] arm " + report.arm.key + " (" + report.arm.label + "): " +
      "问当下命中 " + pct(m.questions.current) + "（top1 " + pct(m.questions.current.top1) + "）" +
      "；旧值注入 " + pct(m.questions.currentStaleInjection) +
      "；问历史命中 " + pct(m.questions.history) +
      "；重复行/属性 " + (m.duplicates.activeDistinctValues.mean ?? "-") +
      "；块字符 p50 " + (m.cost.blockChars.p50 ?? "-"),
  );
  console.log(
    "[long-session]        写侧 p50 " + m.cost.writeMs.p50 + "ms p95 " + m.cost.writeMs.p95 +
      "ms；失效 op " + m.cost.supersedeOps + "（single " + m.cost.supersedeOpsSingle + "）；折叠行 " + m.duplicates.foldRows,
  );
  const sz = m.curve.byCaseSize;
  console.log(
    "[long-session]        退化曲线：" +
      Object.entries(sz).map(([k, v]) => k + " 当前" + pct(v.current) + "/历史" + pct(v.history)).join("；"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("help")) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return 0;
  }
  const seed = numArg(args, "seed", 20261031);
  const cases = numArg(args, "cases", 40);
  if (cases < 1) throw new Error("--cases 必须 >= 1");
  const corpus = generateLongSessionCorpus({
    cases,
    seed,
    turnsMin: numArg(args, "turns-min", 20),
    turnsMax: numArg(args, "turns-max", 60),
    updatesMin: numArg(args, "updates-min", 5),
    updatesMax: numArg(args, "updates-max", 10),
    fillerTurnsMin: numArg(args, "turns-per-session-min", 3),
    fillerTurnsMax: numArg(args, "turns-per-session-max", 6),
  });
  const outDir = path.resolve(args.vals.get("out") ?? path.join(MC_ROOT, ".eval-data", "long-session"));
  const artifacts = writeCorpusArtifacts(corpus, outDir, { seed });
  printSummary(corpus, artifacts);

  const run = args.flags.has("run");
  if (!run) {
    console.log("[long-session] dry-run 完成（未建库/未外呼）。加 --run --offline-embedding 可做离线机制冒烟。");
    return 0;
  }
  const offlineEmbedding = args.flags.has("offline-embedding");
  const allowEmbedding = args.flags.has("allow-embedding");
  if (!offlineEmbedding && !allowEmbedding) {
    console.error("[long-session] --run 需要显式 --offline-embedding（hash 向量，机制冒烟）或 --allow-embedding（真实 embedding 外呼）。");
    return 2;
  }
  const srcYaml = path.resolve(args.vals.get("src-yaml") ?? path.join(MC_ROOT, "tdai-gateway.yaml"));
  if (!fs.existsSync(srcYaml)) {
    console.error("[long-session] 缺少沙箱源配置：" + srcYaml + "（本脚本需要一份可解析的 tdai-gateway.yaml 才能建库）");
    return 2;
  }
  const armArg = (args.vals.get("arm") ?? "A,B,C").toUpperCase();
  const armKeys = armArg.split(",").map((s) => s.trim()).filter(Boolean);
  for (const k of armKeys) if (!ARMS[k]) throw new Error("未知 arm：" + k + "（A/B/C）");
  const limitCases = numArg(args, "limit-cases", 0);
  const runCorpus = limitCases > 0 ? { ...corpus, cases: corpus.cases.slice(0, limitCases) } : corpus;

  const reports = [];
  for (const key of armKeys) {
    const t0 = Date.now();
    const { report, storeDir } = await runArm({
      corpus: runCorpus,
      armKey: key,
      opts: {
        srcYaml,
        storeRoot: args.vals.get("store-root") ? path.resolve(args.vals.get("store-root")) : null,
        offlineEmbedding,
        embedIntervalMs: numArg(args, "embed-interval-ms", offlineEmbedding ? 0 : 400),
      },
    });
    report.wallMs = Date.now() - t0;
    report.storeDir = storeDir;
    const reportFile = path.join(outDir, `long-session-${report.arm.key}-${stamp()}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");
    printArmMetrics(report);
    console.log("[long-session] 报告：" + reportFile + "（" + report.wallMs + "ms）");
    reports.push({ arm: report.arm.key, file: reportFile, metrics: report.metrics });
  }
  const suiteFile = path.join(outDir, `long-session-suite-${stamp()}.json`);
  fs.writeFileSync(
    suiteFile,
    JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), seed: corpus.seed, cases: runCorpus.cases.length, arms: reports, caliber: "deterministic-ground-truth" }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), suite: path.basename(suiteFile), arms: armKeys }, null, 2), "utf8");
  console.log("[long-session] 套件汇总：" + suiteFile);
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    console.error("[long-session] 失败：" + (e?.stack ?? e));
    process.exit(1);
  });
