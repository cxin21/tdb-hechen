#!/usr/bin/env node
/**
 * 记忆系统基准评测入口（td-agemem / MemoryCore）。
 *
 * 被测面 = 产品自己的「写 L1 + 召回」链路（生产同路）：
 *   - 写：createStoreBundle → store.upsertL1（与网关写路径同一 store 实现）
 *   - 读：performLayeredRecall（与 `/v3/recall` 端点字面同一函数，含 query 扩展/FTS/向量/hybrid/精排/分层组装）
 *
 * 数据集：LongMemEval(oracle) / LoCoMo —— 均为第三方公开基准，不自造题。
 *
 * 用法：
 *   node --import tsx scripts/eval-memory-bench.mjs --dataset longmemeval --limit 10
 *   node --import tsx scripts/eval-memory-bench.mjs --dataset locomo --samples 2
 * 全部参数见 --help。
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire as _createRequire } from "node:module";

import {
  loadDataset,
  summarizeDataset,
} from "./lib/bench/datasets.mjs";
import {
  copyOverrideFrom,
  ingestCase,
  loadBenchConfig,
  makeRecall,
  makeStoreDir,
  openBenchStore,
  prepareBenchYaml,
  repoRoot,
} from "./lib/bench/store.mjs";
import { readLlmCredential } from "./lib/read-llm-credential.ts";
import { aggregate, evalRetrieval, makeIdResolver, normHead, tokenF1 } from "./lib/bench/metrics.mjs";
import {
  buildAnswerPrompt,
  buildJudgePrompt,
  makeLlm,
  PROMPT_VERSION,
  ANSWER_PROMPT_VERSION,
  buildEvidenceBlock,
  buildAnswerPromptV3,
  extractFinalAnswer,
} from "./lib/bench/llm.mjs";

// ── 参数 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
function num(name, dflt) {
  const v = arg(name, undefined);
  return v === undefined ? dflt : Number(v);
}
function flag(name) {
  return argv.includes("--" + name);
}

if (flag("help") || argv.length === 0) {
  console.log(`记忆系统基准评测
  --dataset longmemeval|locomo   数据集（必填）
  --data <path>                  数据文件（缺省用仓库 docs/eval/baselines 下的标准路径）
  --samples N                    LoCoMo 样本数（每样本含 18–26 题）
  --limit N                      题目数上限（默认全部）
  --gen-limit N                  生成+判分题数上限（默认 = limit；0 = 只测检索）
  --k N                          检索口径 top-k（默认取生产配置 maxResults）
  --recall-ks 1,3,5,10           B0 多 k 切片（行内平铺 turnCov@k 等键；缺省 1,3,5,10）
  --manifest <path>              B0 抽样清单（caseId 顺序即运行序；配对比较必须同清单）
  --rerank-minscore X            B2-a 精排试验：改沙箱 yaml rerank.minScore（生产不动）
  --rerank-candidates N          B2-a 精排试验：改沙箱 yaml rerank.candidates（生产不动）
  --rerank-off                   B2-a 精排对照：沙箱 yaml rerank.enabled=false
  --b1                           B1 读侧四件套：时间戳打包证据 + CoN/JSON v3 提示 + NOT_ENOUGH_INFO 拒答出口（英文指令）
  --b2b-validity                 B2-b：召回 validityNow=题目日期（缺省=当前时刻，现状）
  --mmr                          B2-b：沙箱 yaml 开 MMR 多样性重排（recall.mmr.enabled）
  --mmr-lambda X                 B2-b：MMR λ（缺省 0.7；1=纯相关序）
  --tag NAME                     运行标签（进 config.tag，A/B 对比命名用）
  --store <dir>                  复用已有库（跳过灌库）
  --keep                         保留沙箱目录
  --out <dir>                    报告输出目录（默认 MemoryCore/.eval-data/bench）
  --concurrency N                embedding 并发（默认 1；账号限流下调高只会加重 429）
  --pace N                       每题之间停顿毫秒（默认 0；限流账号建议 300）
  --prod-config <path>           生产 yaml（默认 MemoryCore/tdai-gateway.yaml）
  --prod-data <dir>              生产 dataDir（默认 TDAI_DATA_DIR 或 yaml data.baseDir）
  --quiet                        只打最终摘要
`);
  process.exit(0);
}

const datasetName = String(arg("dataset", "")).toLowerCase();
if (!datasetName) {
  console.error("缺少 --dataset longmemeval|locomo");
  process.exit(2);
}
const repo = repoRoot();
const prodConfig = String(arg("prod-config", path.join(repo, "tdai-gateway.yaml")));
const outDir = String(arg("out", path.join(repo, ".eval-data", "bench")));
const quiet = flag("quiet");
const log = (...a) => {
  if (!quiet) console.log(...a);
};

/** 生产 dataDir：env → yaml data.baseDir。 */
function resolveProdDataDir(yamlPath) {
  const explicit = arg("prod-data", undefined);
  if (typeof explicit === "string") return explicit;
  if (process.env.TDAI_DATA_DIR) return process.env.TDAI_DATA_DIR;
  const YAML = requireYaml(yamlPath);
  const doc = YAML.parse(fs.readFileSync(yamlPath, "utf8")) || {};
  const bd = doc?.data?.baseDir;
  if (typeof bd === "string" && bd.trim()) return bd.replace(/^~/, process.env.USERPROFILE || process.env.HOME || "~");
  throw new Error("无法确定生产 dataDir：请用 --prod-data 指定");
}

function requireYaml() {
  return _createRequire(import.meta.url)("yaml");
}

/** 数据集缺省路径：先查仓库根 .eval-data/，再查 MemoryCore/.eval-data/。 */
function defaultDataPath(name) {
  const names = {
    longmemeval: ["longmemeval_oracle.json", "longmemeval_s.json"],
    locomo: ["locomo10.json"],
  }[name] || [];
  const roots = [path.resolve(repo, ".."), repo];
  const cands = [];
  for (const r of roots) for (const n of names) cands.push(path.join(r, ".eval-data", n));
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error(`找不到 ${name} 数据文件，请用 --data 指定（已查：${cands.join(" | ")}）`);
}

function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const dataPath = String(arg("data", defaultDataPath(datasetName)));
  const ds = loadDataset(datasetName, dataPath, { samples: num("samples", 0) });
  // B0（bench/recall-opt）：--manifest 抽样——caseId 清单顺序即运行序。配对比较（McNemar /
  // paired bootstrap）要求两轮跑完全相同的题集，固定 seed 生成一次 manifest 后永久复用。
  const manifestArg = arg("manifest", undefined);
  let cases = ds.cases;
  let manifestUsed = null;
  if (manifestArg && manifestArg !== true) {
    manifestUsed = String(manifestArg);
    const manifest = JSON.parse(fs.readFileSync(manifestUsed, "utf8"));
    const ids = manifest.caseIds ?? manifest;
    if (!Array.isArray(ids) || ids.length === 0) throw new Error("manifest 无 caseIds");
    const byId = new Map(ds.cases.map((c) => [c.caseId, c]));
    cases = ids.map((id) => {
      const c = byId.get(id);
      if (!c) throw new Error(`manifest caseId 不在数据集中: ${id}`);
      return c;
    });
    log(`[bench] manifest 抽样: ${cases.length}/${ds.cases.length} 题（${manifestUsed}）`);
  }
  const limit = num("limit", cases.length);
  const casesAll = cases.slice(0, limit);
  const dsSummary = summarizeDataset({ ...ds, cases: casesAll });
  log(`[bench] 数据集=${ds.name} 题数=${dsSummary.cases} 轮数=${dsSummary.turns}`);

  // ── 沙箱库 ──
  const reuse = arg("store", undefined);
  const storeDir = makeStoreDir(ds.name, typeof reuse === "string" ? reuse : undefined);
  const reuseMode = typeof reuse === "string";
  log(`[bench] 库目录: ${storeDir}${reuseMode ? "（复用）" : ""}`);

  const prodData = resolveProdDataDir(prodConfig);
  const overrideCopied = copyOverrideFrom(prodData, storeDir);
  if (!overrideCopied && !reuseMode) {
    log(`[bench] 警告：生产 dataDir 无 config-override.json（${prodData}），embedding/llm 可能不可用`);
  }
  // B2-a：精排试验档（只改沙箱 bench-gateway.yaml；生产 tdai-gateway.yaml 不动）
  const rerankOverride = {};
  if (flag("rerank-off")) rerankOverride.enabled = false;
  const rms = arg("rerank-minscore", undefined);
  if (rms !== undefined && rms !== true) rerankOverride.minScore = Number(rms);
  const rcand = arg("rerank-candidates", undefined);
  if (rcand !== undefined && rcand !== true) rerankOverride.candidates = Number(rcand);
  // B2-b：MMR 试验档（只写沙箱 yaml；生产 yaml 不动——同用户决策②）。声明须在 prepareBenchYaml 之前。
  const mmrOverride = {};
  if (flag("mmr")) mmrOverride.enabled = true;
  const mlam = arg("mmr-lambda", undefined);
  if (mlam !== undefined && mlam !== true) mmrOverride.lambda = Number(mlam);
  prepareBenchYaml({
    srcYaml: prodConfig,
    storeDir,
    ...(Object.keys(rerankOverride).length ? { rerankOverride } : {}),
    ...(Object.keys(mmrOverride).length ? { mmrOverride } : {}),
  });
  if (Object.keys(rerankOverride).length) log("[bench] 精排试验档(仅沙箱 yaml): " + JSON.stringify(rerankOverride));
  if (Object.keys(mmrOverride).length) log("[bench] MMR 试验档(仅沙箱 yaml): " + JSON.stringify(mmrOverride));

  const { cfg } = await loadBenchConfig(storeDir);
  const { store, embedding, dims, init } = await openBenchStore(cfg, storeDir);
  log(`[bench] 存储=${cfg.storeBackend} 向量维=${dims} bm25=${cfg.bm25?.enabled ? "on" : "off"} 精排=${cfg.recall?.rerank?.provider ?? "none"}`);
  if (init && init.needsReindex) log("[bench] 警告: store.init 要求重建索引（embedding 维度变化）");

  // ── 按 groupKey 分组灌库 ──
  const groups = new Map();
  for (const c of casesAll) {
    if (!groups.has(c.groupKey)) groups.set(c.groupKey, { corpus: c, cases: [] });
    groups.get(c.groupKey).cases.push(c);
  }
  log(`[bench] 记忆语料组=${groups.size}（每组一次灌库 + 组内题目检索）`);

  const ingestStats = { groups: 0, turns: 0, embedded: 0, embedFailed: 0, written: 0, embedRetries: 0 };
  const resolvers = new Map();
  const corpusSummary = [];

  if (!reuseMode) {
    const t0 = Date.now();
    let gi = 0;
    for (const [key, g] of groups) {
      gi++;
      const contentIndex = new Map();
      const st = await ingestCase({
        caseObj: g.corpus,
        store,
        embedding,
        contentIndex,
        concurrency: num("concurrency", 1),
      });
      ingestStats.groups++;
      ingestStats.turns += st.turns;
      ingestStats.embedded += st.embedded;
      ingestStats.embedFailed += st.embedFailed;
      ingestStats.embedRetries += st.embedRetries ?? 0;
      ingestStats.written += st.written;
      resolvers.set(key, makeIdResolver(contentIndex));
      corpusSummary.push({ groupKey: key, turns: st.turns, written: st.written, embedded: st.embedded });
      if (!quiet && (gi % 5 === 0 || gi === groups.size)) {
        log(`[bench] 灌库 ${gi}/${groups.size} 轮数=${ingestStats.turns} 已写=${ingestStats.written} 向量=${ingestStats.embedded}（失败 ${ingestStats.embedFailed}，重试 ${ingestStats.embedRetries}）耗时=${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }
  } else {
    // 复用模式：仍需 content→id 映射（stub，按召回内容反查不可行 → 直接按规则重建索引）
    for (const [key, g] of groups) {
      const contentIndex = new Map();
      for (const gg of g.corpus.groups) for (const t of gg.turns) {
        const { turnContent } = await import("./lib/bench/store.mjs");
        contentIndex.set(normHead(turnContent(g.corpus, t)), t.id);
      }
      resolvers.set(key, makeIdResolver(contentIndex));
      corpusSummary.push({ groupKey: key, turns: contentIndex.size, reused: true });
    }
  }

  // ── 检索评估 ──
  // B2-b：validityNow 用题目日期（--b2b-validity；缺省保持 new Date() 现状）
  const b2bValidity = flag("b2b-validity");
  const recall = makeRecall({ cfg, store, embedding, dataDir: storeDir, validityFromCase: b2bValidity });
  const k = num("k", cfg.recall?.maxResults ?? 5);
  // B0 校尺（bench/recall-opt）：多 k 切片——同一次召回结果上重切，零额外召回成本
  const kList = String(arg("recall-ks", "1,3,5,10"))
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  // 单题硬超时：生产 /v3/recall 有 5000ms 端到端超时，基准侧放宽到 60s，
  // 避免个别题（query 扩展外呼抖动）把整轮跑挂死。
  const recallTimeoutMs = num("recall-timeout", 60000);
  const paceMs = num("pace", 0);
  // B1（bench/recall-opt）：读侧四件套，显式开关——S3 各档不受影响
  const b1Mode = flag("b1");
  const rows = [];
  let i = 0;
  for (const c of casesAll) {
    i++;
    const t0 = performance.now();
    let r;
    try {
      r = await Promise.race([
        recall(c.question, c),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`recall timeout ${recallTimeoutMs}ms`)), recallTimeoutMs)),
      ]);
    } catch (e) {
      r = { hits: [], block: "", latencyMs: performance.now() - t0, strategy: "error", error: String(e?.message ?? e) };
    }
    if (paceMs > 0) await new Promise((res) => setTimeout(res, paceMs));
    const ret = evalRetrieval({ caseObj: c, hits: r.hits, resolve: resolvers.get(c.groupKey), k, kList });
    rows.push({
      caseId: c.caseId,
      questionType: c.questionType,
      question: c.question,
      gold: c.goldAnswer,
      latencyMs: Math.round(r.latencyMs),
      strategy: r.strategy,
      layered: r.layered,
      conclusionCount: r.conclusionCount,
      experienceCount: r.experienceCount,
      // B0 校尺：检索计时/门观测/相关度分数序列透传进行数据
      searchTiming: r.searchTiming ?? null,
      ...(r.gates ? { gates: r.gates } : {}),
      scores: r.hits.map((h) => Math.round((h.score ?? 0) * 1e4) / 1e4),
      ...(b1Mode ? { evidence: buildEvidenceBlock(r.hits) } : {}),
      blockChars: (r.block || "").length,
      hits: r.hits.length,
      topContents: r.hits.slice(0, k).map((h) => h.content.slice(0, 160)),
      ...ret,
      block: r.block,
    });
    if (!quiet && (i % 10 === 0 || i === casesAll.length)) log(`[bench] 检索 ${i}/${casesAll.length}`);
  }

  // ── 生成 + 判分 ──
  const genLimit = num("gen-limit", casesAll.length);
  let llmInfo = null;
  if (genLimit > 0) {
    const cred = readLlmCredential({ yamlPath: path.join(storeDir, "bench-gateway.yaml"), baseDir: storeDir });
    const llm = makeLlm(cred);
    llmInfo = llm.info;
    let gi = 0;
    for (const row of rows) {
      if (gi >= genLimit) break;
      gi++;
      const c = casesAll.find((x) => x.caseId === row.caseId);
      try {
        const answer = await llm.text([
          b1Mode
            ? { role: "user", content: buildAnswerPromptV3({ question: row.question, evidence: row.evidence, questionDate: c?.questionDateISO, datasetName: ds.name }) }
            : { role: "user", content: buildAnswerPrompt({ question: row.question, block: row.block, questionDate: c?.questionDateISO, datasetName: ds.name }) },
        ], { maxTokens: cred?.maxTokens && cred.maxTokens > 0 ? cred.maxTokens : 1024 });
        row.answer = answer;
        // B1：v3 提示产出「笔记 + Answer: 行」，判分/F1 只看抽取后的最终答案
        const answerFinal = b1Mode ? extractFinalAnswer(answer) : answer;
        if (b1Mode) row.answerFinal = answerFinal;
        row.f1 = tokenF1(answerFinal, row.gold);
        const verdict = await llm.json([
          { role: "user", content: buildJudgePrompt({ question: row.question, gold: row.gold, answer: answerFinal, questionType: row.questionType, datasetName: ds.name }) },
        ], { maxTokens: 512 });
        row.genCorrect = verdict?.correct === true ? 1 : 0;
        // judge 规则3：拒答（声称无法确定而标准答案有答案）
        row.refused = verdict?.refused === true ? 1 : 0;
        row.judgeReason = verdict?.reason ?? (verdict ? "" : "judge-parse-failed");
      } catch (e) {
        row.genError = String(e?.message ?? e);
      }
      if (!quiet && (gi % 5 === 0 || gi === Math.min(genLimit, rows.length))) log(`[bench] 生成+判分 ${gi}/${Math.min(genLimit, rows.length)}`);
    }
  }

  // ── 汇总 ──
  const agg = aggregate(rows);
  const report = {
    generatedAt: new Date().toISOString(),
    repoCommit: gitSha(),
    dataset: { ...dsSummary, file: dataPath },
    config: {
      storeBackend: cfg.storeBackend,
      embeddingModel: cfg.embedding?.model,
      embeddingDims: dims,
      bm25: cfg.bm25?.enabled ?? false,
      recallStrategy: cfg.recall?.strategy,
      maxResults: cfg.recall?.maxResults,
      scoreThreshold: cfg.recall?.scoreThreshold,
      queryExpansion: cfg.recall?.queryExpansion?.enabled ?? false,
      rerank: cfg.recall?.rerank?.provider ?? "none",
      v3Recall: cfg.recall?.v3Recall?.enabled ?? false,
      k,
      recallKs: kList,
      answerModel: llmInfo?.model ?? null,
      judgeTemperature: 0,
      judgePromptVersion: PROMPT_VERSION,
      tag: String(arg("tag", "")) || null,
      manifest: manifestUsed,
      rerankOverride: Object.keys(rerankOverride).length ? rerankOverride : null,
      answerPrompt: b1Mode ? ANSWER_PROMPT_VERSION : "prod-block-v2",
      validityFromCase: b2bValidity,
      mmrOverride: Object.keys(mmrOverride).length ? mmrOverride : null,
      judgeModel: llmInfo?.model ?? null,
      judgeHost: llmInfo?.baseUrlHost ?? null,
      apiKeySource: llmInfo?.apiKeySource ?? null,
      ingest: ingestStats,
      storeDir: reuseMode ? storeDir : "(已清理/保留见运行日志)",
    },
    overall: agg.overall,
    perType: agg.perType,
    rows,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = path.join(outDir, `${ds.name}-${stamp}`);
  fs.writeFileSync(base + ".json", JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(base + ".md", renderMarkdown(report), "utf8");

  console.log(renderConsole(report));
  console.log(`\n[bench] 报告: ${base}.json / .md`);

  if (!flag("keep") && !reuseMode) {
    try {
      fs.rmSync(storeDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  }
}

// ── 报告渲染 ────────────────────────────────────────────────────────────────

const pct = (v) => (typeof v === "number" ? (v * 100).toFixed(1) + "%" : "-");
const fix = (v, d = 3) => (typeof v === "number" ? v.toFixed(d) : "-");

function renderConsole(r) {
  const o = r.overall;
  return [
    "",
    "──────────────── 记忆基准结果 ────────────────",
    `数据集      ${r.dataset.name}（${r.dataset.cases} 题 / ${r.dataset.turns} 轮）`,
    `嵌入模型    ${r.config.embeddingModel}（${r.config.embeddingDims}d）  bm25=${r.config.bm25}`,
    `召回配置    strategy=${r.config.recallStrategy} maxResults=${r.config.maxResults} threshold=${r.config.scoreThreshold} rerank=${r.config.rerank}`,
    `检索 top-k  ${r.config.k}`,
    `检索指标    session_any@k=${pct(o.sessionAny)}  session_cov@k=${pct(o.sessionCov)}  turn_cov@k=${pct(o.turnCov)}`,
    `            MRR=${fix(o.mrr)}  nDCG@k=${fix(o.ndcg)}`,
    `生成指标    LLM判对率=${pct(o.genAccuracy)}（判分 ${o.genJudged} 题）  tokenF1=${fix(o.f1)}`,
    `召回延迟    mean=${o.latencyMsMean?.toFixed(0)}ms p50=${o.latencyMsP50 ?? "-"}ms p95=${o.latencyMsP95 ?? "-"}ms max=${o.latencyMsMax ?? "-"}ms`,
    "─────────────────────────────────────────────",
  ].join("\n");
}

function renderMarkdown(r) {
  const o = r.overall;
  const L = [];
  L.push(`# 记忆基准评测 · ${r.dataset.name}`, "");
  L.push(`- 生成时间：${r.generatedAt}`);
  L.push(`- 仓库提交：\`${r.repoCommit}\``);
  L.push(`- 数据文件：\`${r.dataset.file}\``);
  L.push(`- 题数 / 轮数：${r.dataset.cases} / ${r.dataset.turns}`, "");

  L.push("## 被测配置（生产同路）", "");
  L.push("| 项 | 值 |", "| --- | --- |");
  for (const [k2, v] of Object.entries(r.config)) {
    if (k2 === "ingest") continue;
    L.push(`| ${k2} | \`${String(v)}\` |`);
  }
  L.push("");
  L.push(`灌库统计：语料组 ${r.config.ingest.groups}、轮数 ${r.config.ingest.turns}、已写 ${r.config.ingest.written}、embedding ${r.config.ingest.embedded}（失败 ${r.config.ingest.embedFailed ?? 0}，429 重试 ${r.config.ingest.embedRetries ?? 0}）`, "");

  L.push("## 总体", "");
  L.push("| 指标 | 值 | 定义 |", "| --- | --- | --- |");
  L.push(`| session_any@k | ${pct(o.sessionAny)} | top-k 内任一行来自证据会话即算命中 |`);
  L.push(`| session_cov@k | ${pct(o.sessionCov)} | 命中的证据会话数 / 证据会话总数 |`);
  L.push(`| turn_cov@k | ${pct(o.turnCov)} | 命中的证据轮数 / 证据轮总数（LoCoMo 精确到轮） |`);
  L.push(`| MRR | ${fix(o.mrr)} | 首个证据命中位次倒数 |`);
  L.push(`| nDCG@k | ${fix(o.ndcg)} | 二值相关性 |`);
  L.push(`| LLM 判对率 | ${pct(o.genAccuracy)} | 判分 ${o.genJudged} 题，模型=${r.config.judgeModel} |`);
  L.push(`| token-F1 | ${fix(o.f1)} | LoCoMo 官方风格 token 重叠 F1 |`);
  L.push(`| 召回延迟 p50/p95/max | ${o.latencyMsP50 ?? "-"} / ${o.latencyMsP95 ?? "-"} / ${o.latencyMsMax ?? "-"} ms | 单题端到端 |`, "");

  L.push("## 分题型", "");
  L.push("| 题型 | 题数 | session_any | turn_cov | MRR | 判对率 |", "| --- | --- | --- | --- | --- | --- |");
  for (const [t, s] of Object.entries(r.perType)) {
    L.push(`| ${t} | ${s.n} | ${pct(s.sessionAny)} | ${pct(s.turnCov)} | ${fix(s.mrr)} | ${pct(s.genAccuracy)} |`);
  }
  L.push("");

  L.push("## 逐题明细", "");
  L.push("| # | 题型 | 问题 | 命中证据 | MRR | 判分 | 延迟 |", "| --- | --- | --- | --- | --- | --- | --- |");
  r.rows.forEach((row, i) => {
    const q = String(row.question).replace(/\|/g, "\\|").slice(0, 70);
    const ev = row.hasEvidence ? (row.sessionAny ? "✓" : "✗") : "n/a";
    const verdict = typeof row.genCorrect === "number" ? (row.genCorrect ? "✓" : "✗") : "-";
    L.push(`| ${i + 1} | ${row.questionType} | ${q} | ${ev} | ${fix(row.mrr, 2)} | ${verdict} | ${row.latencyMs}ms |`);
  });
  L.push("");
  return L.join("\n");
}

main()
  .then(() => {
    // B0（bench/recall-opt）：报告已同步落盘，主动退出——本地精排模型/连接池挂着事件循环，
    // 不显式退出进程会在成功后挂住（观察到的现象：报告打印后进程不结束）。
    process.exit(0);
  })
  .catch((e) => {
    console.error("[bench] 失败:", e?.stack || e);
    process.exit(1);
  });