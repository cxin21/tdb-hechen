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
  applyWriteSteps,
  assertExpectedConfig,
  copyOverrideFrom,
  effectiveRecallSnapshot,
  ingestCase,
  loadBenchConfig,
  buildFactRowRecords,
  makeRecall,
  makeStoreDir,
  turnContent,
  openBenchStore,
  prepareBenchYaml,
  reembedFactKeys,
  parseExpectConfig,
  repoRoot,
  withEmbedCache,
} from "./lib/bench/store.mjs";
import { readLlmCredential } from "./lib/read-llm-credential.ts";
import { aggregate, evalRetrieval, makeIdResolver, normHead, tokenF1 } from "./lib/bench/metrics.mjs";
import { attributeInjectedLines, evidenceSufficiency, INJECT_LINE_TYPES } from "./lib/bench/inject-attribution.mjs";
import { FACTS_PROMPT_VERSION, factsCoverage, factsForCase } from "./lib/bench/facts.mjs";
import { CONCLUSIONS_PROMPT_VERSION } from "./lib/bench/conclusions.mjs";
import { createStageStats, fetchFactsAndConclusions, mergeStageStats, tokenEvidence } from "./lib/bench/stages.mjs";
// 审计 M6/M8：生效配置三层快照 + 判分存在性门禁（报告自证）。
import { readEffectiveBenchConfig, formatEffectiveConfig } from "./lib/bench/effective-config.ts";
import { attachJudgingStatus } from "./lib/bench/report.mjs";
import { buildCostSection } from "./lib/bench/cost.mjs";
import { makeOfflineEmbedding, OFFLINE_EMBEDDING_CALIBER } from "./lib/bench/offline-embedding.mjs";
import { createArgReader } from "./lib/bench/argv.mjs";
import {
  buildAnswerPrompt,
  buildAnswerPromptTuned,
  buildAnswerPromptMarshalled,
  ANSWER_PROMPT_MARSHAL_VERSION,
  ANSWER_PROMPT_CURRENCY_VERSION,
  ANSWER_PROMPT_PREF_VERSION,
  buildJudgePrompt,
  makeLlm,
  PROMPT_VERSION,
  ANSWER_PROMPT_VERSION,
  buildEvidenceBlock,
  buildAnswerPromptV3,
  extractFinalAnswer,
} from "./lib/bench/llm.mjs";

// ── 参数 ────────────────────────────────────────────────────────────────────

// #160：取参规则单一源（裸 flag / 非数值一律 exit 2，不再静默走默认值或 NaN）。
const argv = process.argv.slice(2);
const { arg, flag, num, strArg } = createArgReader(argv);

if (flag("help") || argv.length === 0) {
  console.log(`记忆系统基准评测
  --dataset longmemeval|locomo   数据集（必填）
  --data <path>                  数据文件（缺省用仓库 docs/eval/baselines 下的标准路径）
  --samples N                    LoCoMo 样本数（每样本含 18–26 题）
  --limit N                      题目数上限（默认全部）
  --gen-limit N                  生成+判分题数上限（默认 = limit；0 = 只测检索）
  --conclusion-cards             W3 **写入面**：蒸馏结论卡 + work_fact 落库 + part_of 证据链
  --small-to-big                 W3 **读侧**：开 recall.smallToBig 证据回捞（#139 拆分；不再隐含于 --conclusion-cards）
  --small-to-big-off             显式关读侧（复用库会继承 yaml；归因「读侧关」档必须用它）
  --conclusion-layer-off         连结论层注入一起关（归因表「无卡基线」档）
  --small-to-big-max-extra N     读侧上下文行帽（缺省取 --conclusion-max-extra）
  --conclusion-max-extra N       读侧上下文行帽别名（缺省 2）
  --conclusion-cap N             #138 结论行条数上限（conclusionLayer.maxConclusions；缺省 floor(maxResults/2)）
  --conclusion-budget-mode M     #138/#141 上下文行预算归属 shared|additive|slot（缺省 shared=逐位现状；slot=复合单元槽位预算）
  --conclusion-routing R         #138/#141 结论层查询路由 off|assistant-recall|intent（intent=按题意分预算/排序/成对）
  --conclusion-slot-cost X       #141 复合单元槽位成本（clamp [1,3]；缺省 1.5；仅 --conclusion-budget-mode slot 生效）
  --conclusion-pairing off|require  #141 结论必带源证据（require=没回捞到证据的结论行丢弃）
  --conclusion-legacy-rank       #138 回滚证据排序（旧序=store 返回序）
  --k N                          检索口径 top-k（默认取生产配置 maxResults）
  --recall-ks 1,3,5,10           B0 多 k 切片（行内平铺 turnCov@k 等键；缺省 1,3,5,10）
  --recall-max-results N         #146 诊断档：沙箱 yaml recall.maxResults（放大行预算；生产不动）
  --dedupe-hits-by-turn          #146 诊断档：召回行按父 turn 去重后再进指标/注入（需配 --recall-max-results）
  --manifest <path>              B0 抽样清单（caseId 顺序即运行序；配对比较必须同清单）
  --rerank-minscore X            B2-a 精排试验：改沙箱 yaml rerank.minScore（生产不动）
  --rerank-candidates N          B2-a 精排试验：改沙箱 yaml rerank.candidates（生产不动）
  --rerank-mode filter|rerank   #135 R4 精排试验：filter=floor 只滤不清排（保原序）；缺省 rerank
  --rerank-timeout MS           精排超时（毫秒；本机 onnx 冷加载可能 >5s，冷启动档放宽到 30000）
  --rerank-filter-only [floor]  精排降级为过滤器（**必须同时加 --rerank-child-proc**，否则直接退出码 2）
  --rerank-off                   B2-a 精排对照：沙箱 yaml rerank.enabled=false
  --rerank-child-proc            精排子进程隔离（onnx 原生崩溃防护；--rerank-filter-only 依赖此路径）
  --dump-rerank-scores           #144 floor 校准：把每次精排调用的**全量候选分数**落 <out>/<report>-rerank-scores.jsonl
                                 （含未达线行 + recordId/来源会话 + 最终保留序；只加 IO，不改召回行为）
  --b1                           B1 读侧四件套：时间戳打包证据 + CoN/JSON v3 提示 + NOT_ENOUGH_INFO 拒答出口（英文指令）
  --b2b-validity                 B2-b：召回 validityNow=题目日期（缺省=当前时刻，现状）
  --validity-mode soft|hard      #136 效期策略：soft=失效行降权保留（仅当下意图+有更新行才硬丢）
  --validity-off                 #136/#141 对照档：关失效排除（recall.excludeInvalidated=false，不排也不降权）
  --supersede-cardinality off    #136 对照档：关闭 cardinality 门（多值属性也失效=现状 W2）
  --fact-rows                    #146 事实级双时态**写入面**：一条事实一行（隐含 --fact-extract）；
                                 单值行写前按 fact_key 失效同键旧行、多值行不失效（事实级失效，
                                 替代整行 supersede）；与 --fact-dual-write/--fact-channel/
                                 --write-supersede 互斥；--store 复用库不可用（须重灌）
  --prune-fact-sibling-index     #166 验收④ 诊断档（只配 --fact-rows）：灌库后把 fact_index>0 的兄弟事实行
                                 移出 **FTS 索引面**（只删 l1_fts，l1_records 与 l1_vec 全量保留——连向量一起删会让
                                 候选变稀、读数无法归因到 IDF），效期/失效判定不变。
                                 用于隔离「同一 turn 文本在语料里重复多次 → BM25 IDF 稀释」——索引文档数
                                 从事实行数回到 turn 数，其余（写入形状、读侧折叠、精排）逐位不变。
  --fact-channel                 #137 事实键平行通道试验档（隐含 --fact-extract；事实短语键另写 l1_fact_vec + 沙箱 yaml recall.factChannel）
  --fact-channel-read-only       只开读侧（沙箱 recall.factChannel），不写通道向量——在已灌库上迭代融合参数的零外呼档
  --fact-channel-weight N        #137 事实通道融合权重（缺省 0.6；只进沙箱 yaml，不改写侧）
  --fact-channel-off             #137 对照档：显式关读侧事实通道（生产 yaml 已开，复跑旧基线必须用它）
  --fact-max-facts N             #137 事实通道键的事实条数上限（缺省 5；即 buildFactChannelKey 的 maxFacts）
  --mmr                          B2-b：沙箱 yaml 开 MMR 多样性重排（recall.mmr.enabled）
  --mmr-lambda X                 B2-b：MMR λ（缺省 0.7；1=纯相关序）
  --emb-threshold X              B2-b：向量余弦门槛（生产 0.3；试验 0.15 放宽）
  --tag NAME                     运行标签（进 config.tag，A/B 对比命名用）
  --store <dir>                  复用已有库（跳过灌库）
  --keep                         保留沙箱目录
  --out <dir>                    报告输出目录（默认 MemoryCore/.eval-data/bench）
  --concurrency N                embedding 并发（默认 1；账号限流下调高只会加重 429）
  --pace N                       每题之间停顿毫秒（默认 0；限流账号建议 300）
  --prod-config <path>           生产 yaml（默认 MemoryCore/tdai-gateway.yaml）
  --prod-data <dir>              生产 dataDir（默认 TDAI_DATA_DIR 或 yaml data.baseDir）
  --expect-config k=v[,k=v]      生效配置自检（如 recall.rerank.enabled=false）；不符即退出码 2，防白跑整档
  --no-write-steps               --store 复用库时跳过分阶段写入（纯读侧档：库里状态保持不变）
  --offline-embedding            用离线 hash 向量代替生产 embedding（零外呼；只验证度量管线，
                                 读数**不是**检索质量结论；自动禁用 embed-cache，避免污染真实模型缓存）
  --report-name <name>           报告文件名（不含扩展名）；arms 脚本按 tag 定位报告时必传
  --quiet                        只打最终摘要
`);
  process.exit(0);
}

// #141 评审 #5：未识别旗标必须显式失败。`arg()` 走 argv.indexOf 精确匹配，
// 于是 `--conclusion-pairing=require`（等号写法）和拼错的 `--conclusion-routin` 都会被静默忽略：
// 负控臂在「以为已关」的情况下跑成默认档，报告里看不出任何差别 —— 这正是 #141 要消灭的静默降级。
const KNOWN_FLAGS = new Set([
  "age-decay", "b1", "b2b-validity", "candidate-k", "conclusion-budget-mode", "conclusion-cap",
  "conclusion-cards", "conclusion-layer-off", "conclusion-legacy-rank", "conclusion-max", "conclusion-max-extra", "conclusion-pairing",
  "conclusion-routing", "conclusion-slot-cost", "concurrency", "currency-prompt", "pref-prompt", "marshal-prompt", "data", "dataset", "emb-threshold",
  "embed-cache", "embed-interval-ms", "evidence-pack", "expect-config", "fact-batch-size", "fact-cache", "fact-case-concurrency",
  "fact-channel", "fact-channel-off", "fact-channel-read-only", "fact-channel-weight", "fact-concurrency", "fact-dual-write",
  "fact-extract", "fact-max-chars", "fact-max-facts", "fact-model", "fact-rows", "fact-separator", "facts-only",
  "fusion", "gen-limit", "help", "inject-time-sort", "inject-wrapper", "keep",
  "limit", "manifest", "mmr", "mmr-lambda", "no-embed-cache", "no-write-steps", "offline-embedding",
  "out", "pace", "present-temporal", "prod-config", "prod-data", "prune-fact-sibling-index", "quiet",
  "recall-ks", "recall-max-results", "dedupe-hits-by-turn", "expand-parent-turn", "recall-timeout", "report-name", "rerank-candidates", "rerank-child-proc",
  "dump-rerank-scores", "rerank-doc-cap", "rerank-filter-only", "rerank-minscore", "rerank-mode", "rerank-off", "rerank-threads",
  // #144：filter 的题内相对尺子（floor 在题间量纲漂移下不可校准，见 docs/optimization-results.md §19）
  "rerank-filter-rule", "rerank-margin-top", "rerank-keep-ratio",
  "rerank-timeout", "samples", "small-to-big", "small-to-big-max-extra", "small-to-big-off", "store",
  "supersede-cardinality", "tag", "validity-mode", "validity-off", "write-supersede",
]);
{
  const bad = [];
  for (const tok of argv) {
    if (typeof tok !== "string" || !tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    const name = (eq >= 0 ? tok.slice(2, eq) : tok.slice(2)).toLowerCase();
    if (!KNOWN_FLAGS.has(name)) bad.push(tok);
    else if (eq >= 0) bad.push(tok + "（等号写法；请改成 --" + name + " <值>）");
  }
  if (bad.length) {
    console.error("[bench:error] 未识别的旗标：" + bad.join("、"));
    console.error("[bench:error] 已支持：" + [...KNOWN_FLAGS].sort().join(" "));
    process.exit(2);
  }
}

const datasetName = String(strArg("dataset", "")).toLowerCase();
if (!datasetName) {
  console.error("缺少 --dataset longmemeval|locomo");
  process.exit(2);
}
const repo = repoRoot();
const prodConfig = String(arg("prod-config", path.join(repo, "tdai-gateway.yaml")));
const outDir = String(arg("out", path.join(repo, ".eval-data", "bench")));
const quiet = flag("quiet");
// 端到端验收用：离线 hash 向量（零外呼）。报告里必须显式标注，否则又是一代不可自证的读数。
const offlineEmbedding = flag("offline-embedding");
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
  const manifestArg = strArg("manifest", undefined);
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

  // W1/W2（issue #134）：写入治本试验档——事实抽取离线批处理 + K=V+fact 双写 + 写时 supersession。
  // 缺省全关（逐位现状）；--write-supersede 需要抽取结果（隐含 --fact-extract）。
  const factDualWrite = flag("fact-dual-write");
  const writeSupersede = flag("write-supersede");
  // #137 W1/C（bench）：事实键平行通道试验档——原文键仍是主索引（l1_vec 不动），事实短语键
  // embedding 另写一张 vec0 表（store.upsertL1FactVector），召回侧按 recall.factChannel 融合。
  // --fact-channel 隐含 --fact-extract（通道复用同一份事实缓存，键文本来自 phrases）。
  // --fact-channel-read-only：只开读侧（沙箱 yaml recall.factChannel），不写通道向量——
  // 用于在已灌好 fact 向量的库上迭代融合参数（权重/模式），零重复 embedding 外呼。
  const factChannel = flag("fact-channel");
  const factChannelReadOnly = flag("fact-channel-read-only");
  // 复跑历史档要用：生产 yaml 自 #137 起 recall.factChannel.enabled=true，复用的沙箱库
  // 会继承它 —— 没有 off 开关就无法复现「无事实通道」的旧基线（#135-1 同源漂移）。
  const factChannelOff = flag("fact-channel-off");
  if (factChannelOff && (factChannel || factChannelReadOnly)) {
    console.error("[bench] --fact-channel-off 与 --fact-channel/--fact-channel-read-only 互斥；已中止。");
    process.exit(2);
  }
  const fcWeightArg = num("fact-channel-weight", 0.6);
  const factChannelWeight = Number.isFinite(fcWeightArg) ? fcWeightArg : 0.6;
  const fcMaxFactsArg = num("fact-max-facts", 5);
  const factMaxFacts = Number.isFinite(fcMaxFactsArg) && fcMaxFactsArg > 0 ? Math.floor(fcMaxFactsArg) : 5;
  // #146（事实级双时态）：--fact-rows 一条事实一行。隐含 --fact-extract；写侧失效降级到事实级
  // （single 行写前按 fact_key 失效同键旧行，multi 行永不失效），因此与整行档的 --write-supersede、
  // --fact-dual-write（整行键拼法）、--fact-channel（通道向量按 turn id 落表）互斥。
  // 混开会让「差异来自哪种写面」无法归因——这类静默降级必须显式失败（#141 纪律）。
  const factRows = flag("fact-rows");
  if (factRows && (writeSupersede || factDualWrite || factChannel || factChannelReadOnly)) {
    console.error("[bench:error] --fact-rows 与 --write-supersede/--fact-dual-write/--fact-channel/--fact-channel-read-only 互斥（事实行档自带事实级失效与事实载荷，混开无法归因）");
    process.exit(2);
  }
  // #166 验收④：IDF 稀释隔离档（诊断）——只对事实行有意义（整行档没有兄弟行可去重）。
  const pruneFactSiblingIndex = flag("prune-fact-sibling-index");
  if (pruneFactSiblingIndex && !factRows) {
    console.error("[bench:error] --prune-fact-sibling-index 只能配 --fact-rows（整行档没有同 turn 兄弟行，去重无意义）");
    process.exit(2);
  }
  const factExtract = flag("fact-extract") || factDualWrite || writeSupersede || factChannel || factRows;
  const factMaxChars = num("fact-max-chars", 240);
  const factSeparatorArg = arg("fact-separator", undefined);
  const factSeparator = typeof factSeparatorArg === "string" ? factSeparatorArg : undefined;
  // #137：通道键的构造选项（写侧；与 dualWrite 的「键替换」档互不干扰，可同时开）
  const factChannelWrite = factChannel && !factChannelReadOnly;
  const factChannelOpts = factChannelWrite
    ? {
        enabled: true,
        ...(typeof factSeparator === "string" ? { separator: factSeparator } : {}),
        maxFacts: factMaxFacts,
      }
    : null;
  // #137：沙箱 yaml memory.recall.factChannel（生产 config.ts 同名字段；缺省无此键 = 通道关）。
  // weight 只影响读侧融合，写侧灌库与权重无关。
  const factChannelOverride = factChannel ? { enabled: true, weight: factChannelWeight } : factChannelOff ? { enabled: false } : undefined;
  const factCacheDir = String(arg("fact-cache", path.join(repo, ".eval-data", "bench", "facts-cache")));
  const factBatchSize = num("fact-batch-size", 20);
  const factConcurrency = num("fact-concurrency", 8);
  const factModelArg = arg("fact-model", undefined);
  // #136 双时态属性契约试验档：
  //  --validity-mode soft|hard  读侧效期策略（soft = 失效行降权而非硬过滤；缺省读 yaml）
  //  --supersede-cardinality off  写侧关闭 cardinality 门（对照档：现状"谓词一变就失效"）
  const validityModeArg = String(arg("validity-mode", "") ?? "").toLowerCase();
  const validityModeOverride = validityModeArg === "soft" || validityModeArg === "hard" ? { mode: validityModeArg } : undefined;
  // --validity-off：#141 的 W2「关」格。失效排除总开关是 recall 根级键（不是 recall.validity.mode），
  // 两者分开写：混在 validityOverride 里会被 prepareBenchYaml 塞进 recall.validity，静默失效。
  const validityOffOverride = flag("validity-off") ? { excludeInvalidated: false } : undefined;
  // #146 诊断档（事实行预算饥饿）：--recall-max-results N 把沙箱 yaml 的 recall.maxResults 放大，
  // 配合 --dedupe-hits-by-turn 交付「k 个不同 turn」——用来验证掉分是槽位被同 turn 多条事实行吃掉，
  // 而不是事实级失效本身有害。两条都只写沙箱 yaml / 只改读侧聚合，生产配置与写面零影响。
  const recallMaxResultsArg = arg("recall-max-results", undefined);
  const recallMaxResultsOverride = recallMaxResultsArg !== undefined && recallMaxResultsArg !== true && Number.isFinite(Number(recallMaxResultsArg)) && Number(recallMaxResultsArg) >= 1
    ? { maxResults: Math.floor(Number(recallMaxResultsArg)) }
    : undefined;
  if (flag("dedupe-hits-by-turn") && recallMaxResultsOverride === undefined) {
    console.error("[bench] --dedupe-hits-by-turn 需要 --recall-max-results N（池子仍是 k 行时去重只会更少，测不出预算饥饿）；已中止。");
    process.exit(2);
  }
  const validityOverride = validityModeOverride;
  const supersedeCardinalityArg = String(arg("supersede-cardinality", "") ?? "").toLowerCase();
  const cardinalityGate = supersedeCardinalityArg === "off" ? false : undefined;
  const supersessionOverride = cardinalityGate === false ? { cardinalityGate: false } : undefined;
  // embedding 节流（豆包账号级 RPM 限制）：请求间隔下限，避免突发触发 429 重试风暴
  const embedIntervalMs = num("embed-interval-ms", 400);
  // W3（issue #134）：结论卡（work_fact）接入召回——蒸馏 + part_of 证据链 + smallToBig 回捞。
  const conclusionCards = flag("conclusion-cards");
  const conclusionMax = num("conclusion-max", 4);
  const conclusionMaxExtra = num("conclusion-max-extra", 2);
  // #138（2026-10-28）：结论层预算三旋钮——结论条数上限 / 上下文行预算归属 / 证据排序档。
  const conclusionCapArg = num("conclusion-cap", undefined);
  const conclusionCap = typeof conclusionCapArg === "number" && Number.isFinite(conclusionCapArg) && conclusionCapArg >= 0
    ? Math.floor(conclusionCapArg)
    : undefined;
  // #141：slot = 复合单元槽位预算（结论按 slotCost 占槽，经验层取剩余）。
  // 显式校验（裸 flag / 拼错一律退出码 2）：静默回落 shared 会让「新分阶段档」跑成旧档，
  // 报告里也看不出差别——这类静默降级正是 #141 要消灭的。
  const budgetModeArg = strArg("conclusion-budget-mode", "shared");
  if (!["shared", "additive", "slot"].includes(String(budgetModeArg))) {
    console.error(`[bench:error] --conclusion-budget-mode 只能是 shared|additive|slot（收到 ${budgetModeArg}）`);
    process.exit(2);
  }
  const conclusionBudgetMode = String(budgetModeArg);
  const conclusionLegacyRank = flag("conclusion-legacy-rank");
  // #138：结论层查询路由（assistantRecall = 回忆 assistant 输出的查询跳过结论层）
  // #141：intent = 按查询意图分预算/排序/成对（分阶段选择）。同样显式校验，不静默回落 off。
  const routingArg = strArg("conclusion-routing", "off");
  if (!["off", "assistant-recall", "intent"].includes(String(routingArg))) {
    console.error(`[bench:error] --conclusion-routing 只能是 off|assistant-recall|intent（收到 ${routingArg}）`);
    process.exit(2);
  }
  const conclusionRouting = String(routingArg) === "assistant-recall" ? "assistantRecall" : String(routingArg) === "intent" ? "intent" : "off";
  // #141：复合单元槽位成本（[1,3]；缺省留给运行期 layered-budget 的 1.5）与成对执行开关。
  const slotCostArg = strArg("conclusion-slot-cost", undefined);
  const slotCostNum = slotCostArg === undefined ? undefined : Number(slotCostArg);
  if (slotCostArg !== undefined && (!Number.isFinite(slotCostNum) || slotCostNum < 1 || slotCostNum > 3)) {
    console.error(`[bench:error] --conclusion-slot-cost 需 1~3 的数值（收到 ${slotCostArg}）`);
    process.exit(2);
  }
  const conclusionSlotCost = slotCostNum;
  const pairingArg = strArg("conclusion-pairing", "off");
  if (!["off", "require"].includes(String(pairingArg))) {
    console.error(`[bench:error] --conclusion-pairing 只能是 off|require（收到 ${pairingArg}）`);
    process.exit(2);
  }
  const conclusionPairing = String(pairingArg);
  // #139 第5项归因补充：无卡基线档（连结论层注入都关），用于把「卡本身」与「回捞」分离。
  const conclusionLayerOff = flag("conclusion-layer-off");
  // #139 第5项：W3 写/读开关拆分。--conclusion-cards 只开**写入面**（蒸馏 + work_fact 落库 + part_of 链）；
  // **读侧回捞**（recall.smallToBig 证据回捞）改由 --small-to-big 独立开关控制。
  // 历史语义（--conclusion-cards 同时开两面）导致 +10pp 无法归因：无法区分是"结论卡进了候选池"
  // 还是"smallToBig 把证据行捞回来"。拆分后两档各跑一次即可归因。
  const smallToBigEnabled = flag("small-to-big");
  // --small-to-big-off：显式关读侧。归因必需——复用库（--store）常继承上一档 yaml 里的
  // smallToBig.enabled=true，只「不加 --small-to-big」并不能真的关掉（--expect-config 会把它抓出来）。
  const smallToBigOff = flag("small-to-big-off");
  if (smallToBigEnabled && smallToBigOff) {
    console.error("[bench:error] --small-to-big 与 --small-to-big-off 互斥");
    process.exit(2);
  }
  const smallToBigMaxExtraArg = num("small-to-big-max-extra", conclusionMaxExtra);
  const smallToBigMaxExtra = Number.isFinite(smallToBigMaxExtraArg) && smallToBigMaxExtraArg >= 0 ? Math.floor(smallToBigMaxExtraArg) : conclusionMaxExtra;
  if (flag("conclusion-cards") && !smallToBigEnabled) {
    log("[bench] W3 只开写入面（--conclusion-cards 不再隐含读侧回捞）：需要 smallToBig 回捞请加 --small-to-big");
  }
  // #135 第1项：--expect-config key=value[,key=value] 生效配置自检（灌库前失败，避免白跑整档）。
  const expectConfigRaw = arg("expect-config", undefined);
  if (expectConfigRaw === true) {
    console.error("[bench:error] --expect-config 需要 key=value（例如 recall.rerank.enabled=false）");
    process.exit(2);
  }
  let expectConfig = null;
  if (expectConfigRaw !== undefined) {
    try {
      expectConfig = parseExpectConfig(String(expectConfigRaw));
    } catch (e) {
      // 参数错误统一 exit 2（与 run 内断言失败区分：断言失败也是 2，二者都是"没跑起来"）。
      console.error(`[bench:error] --expect-config 解析失败: ${e?.message ?? e}`);
      process.exit(2);
    }
  }

  // ── 按 groupKey 分组灌库 ──
  const groups = new Map();
  for (const c of casesAll) {
    if (!groups.has(c.groupKey)) groups.set(c.groupKey, { corpus: c, cases: [] });
    groups.get(c.groupKey).cases.push(c);
  }

  // W1/W2（issue #134）：--facts-only 离线批处理——只跑抽取落 facts-cache，不建库、不检索、不判分。
  // 门禁（scripts/fact-extract-gate.mjs）的前置步：抽取质量不达标就不启用双写。
  if (flag("facts-only")) {
    const fcred0 = readLlmCredential({ yamlPath: prodConfig, baseDir: resolveProdDataDir(prodConfig) });
    const fcred = typeof factModelArg === "string" && factModelArg ? { ...fcred0, model: factModelArg } : fcred0;
    const fllm = makeLlm(fcred);
    const fmodel = fllm.info?.model ?? fcred?.model ?? "unknown";
    log(`[bench] facts-only 离线抽取: model=${fmodel} cache=${factCacheDir} 组=${groups.size}`);
    const t0 = Date.now();
    let done = 0;
    let nextIdx = 0;
    // #139 第2项：统计累加只有 mergeStageStats 一份实现（与灌库主循环/分阶段写入同口径）。
    const stage = createStageStats();
    const groupList = [...groups.values()];
    // case 级并行：单 case 内部再按 factBatchSize 并发；两侧并行度相乘 =
    // in-flight 外呼数（抽取是本轮唯一的长尾，串行 case 会拖到小时级）。
    const caseWorkers = Math.max(1, Math.min(Number(arg("fact-case-concurrency", 6)), groupList.length));
    const batchWorkers = Math.max(1, Math.min(6, factConcurrency));
    await Promise.all(Array.from({ length: caseWorkers }, async () => {
      for (;;) {
        const i = nextIdx++;
        if (i >= groupList.length) return;
        const fx = await factsForCase({
          caseObj: groupList[i].corpus,
          cacheDir: factCacheDir,
          llm: fllm,
          model: fmodel,
          batchSize: factBatchSize,
          concurrency: batchWorkers,
          logger: { warn: (m) => log("[bench:warn] " + m) },
        });
        // #139 第4项：缓存命中也带 usage（真值或 estimated-cache 回落），一律入账并标注来源。
        mergeStageStats(stage, { facts: fx });
        done++;
        if (done % 5 === 0 || done === groupList.length) {
          const fs1 = stage.facts;
          log(`[bench] facts-only ${done}/${groupList.length}（缓存命中 ${fs1.cacheHits}；覆盖 turn ${fs1.turnsWithFacts}/${fs1.turns}，短语 ${fs1.phrases}）耗时=${((Date.now() - t0) / 1000).toFixed(0)}s`);
        }
      }
    }));
    const fs1 = stage.facts;
    const tok = tokenEvidence(fs1);
    log(
      `[bench] facts-only 完成：组 ${fs1.groups}（缓存命中 ${fs1.cacheHits}；来源 ${JSON.stringify(fs1.usageBySource)}），短语 ${fs1.phrases}，` +
        `LLM usage prompt=${fs1.usage.prompt} completion=${fs1.usage.completion}${tok.hasEstimated ? "（含估算，" + tok.estimatedCalls + " 组）" : ""}`,
    );
    // 抽取失败批非 0 退出（门禁链可判：抽取全失败不能静默当成功）
    if (fs1.failedBatches > 0) {
      console.error(`[bench] facts-only 失败批 ${fs1.failedBatches} 个——抽取不完整，退出码 1`);
      process.exit(1);
    }
    process.exit(0);
  }

  // ── 沙箱库 ──
  const reuse = strArg("store", undefined);
  const storeDir = makeStoreDir(ds.name, typeof reuse === "string" ? reuse : undefined);
  const reuseMode = typeof reuse === "string";
  // #146：复用库里的行是上一次写入形状（整行）。再跑 --fact-rows 会在同一 turn 上叠一套事实行，
  // 库内容变成两种形状混杂 —— 度量既不是事实行档也不是整行档，必须重灌。
  // 但 --no-write-steps 的只读档例外：此时 --fact-rows 只用于「按同一 planner 重建事实行→父 turn 索引」，
  // 一个字节都不写库（#146 诊断档要拿冻结库反复比读侧，不重灌才跑得动 90 题档）。
  if (reuseMode && factRows && !flag("no-write-steps")) {
    console.error("[bench:error] --fact-rows 不能与 --store 复用库同用（库里是上次写入形状，重复写会叠出多套行）——请去掉 --store 重灌，或加 --no-write-steps 做只读档");
    process.exit(2);
  }
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
  // #135 R4：精排模式（rerank=重排；filter=只丢低于 floor 的行、保原序）。写进 yaml 与 override json，两边一致。
  const rmode = arg("rerank-mode", undefined);
  if (rmode === "filter" || rmode === "rerank") rerankOverride.mode = rmode;
  // #144：filter 的判定尺子。floor=旧口径（只看 minScore，题间量纲不一致→整题误杀）；
  // margin/quantile 只比同题分数序，minScore 不参与（两把尺子不互相盖）。
  const frule = arg("rerank-filter-rule", undefined);
  if (frule === "floor" || frule === "margin" || frule === "quantile") {
    rerankOverride.filterRule = frule;
    if (frule !== "floor") {
      // 相对尺子要配 --rerank-minscore 极低（让候选全量进入打分），否则 floor 会先把候选剪掉
      log("[bench] filter 相对尺子生效：minScore 不参与判定；请确认 --rerank-minscore 足够低以放开候选");
    }
  }
  const fmargin = arg("rerank-margin-top", undefined);
  if (fmargin !== undefined && fmargin !== true && Number.isFinite(Number(fmargin)) && Number(fmargin) > 0) {
    rerankOverride.filterMarginTop = Number(fmargin);
  }
  const fkeep = arg("rerank-keep-ratio", undefined);
  if (fkeep !== undefined && fkeep !== true && Number.isFinite(Number(fkeep)) && Number(fkeep) > 0 && Number(fkeep) <= 1) {
    rerankOverride.filterKeepRatio = Number(fkeep);
  }
  // 精排超时（毫秒；0=不限）——本机 onnx 冷加载可能 >5s，冷启动档需要放宽
  const rtimeout = arg("rerank-timeout", undefined);
  if (rtimeout !== undefined && rtimeout !== true && Number.isFinite(Number(rtimeout))) {
    rerankOverride.timeoutMs = Math.max(0, Number(rtimeout));
  }
  // B2-b：MMR 试验档（只写沙箱 yaml；生产 yaml 不动——同用户决策②）。声明须在 prepareBenchYaml 之前。
  const mmrOverride = {};
  if (flag("mmr")) mmrOverride.enabled = true;
  const mlam = arg("mmr-lambda", undefined);
  if (mlam !== undefined && mlam !== true) mmrOverride.lambda = Number(mlam);
  // B2-b：向量余弦门槛试验值（0.3→0.15 等；声明须在 prepareBenchYaml 之前）
  let embThresholdOverride;
  const eth = arg("emb-threshold", undefined);
  if (eth !== undefined && eth !== true) embThresholdOverride = Number(eth);
  // B2a 结论验证：--rerank-filter-only [floor] 精排降级为过滤器（只丢噪声不清排）
  let rerankFilterOnly = false;
  let rerankFilterFloor = -1e9;
  const rfo = arg("rerank-filter-only", undefined);
  if (rfo !== undefined) {
    rerankFilterOnly = true;
    const fl = rfo === true ? -7 : Number(rfo);
    if (Number.isFinite(fl)) rerankFilterFloor = fl;
  }
  // #135 第2项：--rerank-filter-only 只在 rerankChildProc 路径（ChildProcessReranker）生效，
  // 不加 --rerank-child-proc 等于静默无效（一档白跑）。这里显式失败，别让它悄悄变成控制档。
  if (rerankFilterOnly && !flag("rerank-child-proc")) {
    console.error("[bench] --rerank-filter-only 需要 --rerank-child-proc（filter 模式只在该路径生效）；已中止，避免白跑一档。");
    process.exit(2);
  }
  // #135 R2/E1（bench/recall-opt）：--fusion '<json>' 加权融合试验档（recall.fusion，沙箱 yaml）。
  // 例：--fusion '{"mode":"weighted","dense":0.4,"bm25":0.3,"recency":0.2,"validity":0.1,"recencyHalfLifeDays":30}'
  // #135 全开档：--candidate-k N（recall.candidateK）+ --present-temporal（recall.presentTemporal enabled）
  const candidateKArg = arg("candidate-k", undefined);
  const candidateKOverride = candidateKArg !== undefined && candidateKArg !== true && Number.isFinite(Number(candidateKArg)) && Number(candidateKArg) >= 1
    ? Math.floor(Number(candidateKArg)) : undefined;
  const presentTemporalOverride = flag("present-temporal")
    ? { enabled: true, boost: 0.08, recentDays: 30 } : undefined;
  const fusionRaw = arg("fusion", undefined);
  let fusionOverride;
  if (fusionRaw !== undefined && fusionRaw !== true) {
    try {
      fusionOverride = JSON.parse(String(fusionRaw));
      if (!fusionOverride || typeof fusionOverride !== "object" || Array.isArray(fusionOverride)) throw new Error("not an object");
    } catch (e) {
      throw new Error("--fusion 需为合法 JSON 对象: " + String(e?.message ?? e));
    }
  }
  // 架构验证：--age-decay [days] F6b 时间衰减进排序（config 已有管道）
  let ageDecayDays = 0;
  const adArg = arg("age-decay", undefined);
  if (adArg !== undefined) {
    ageDecayDays = adArg === true ? 30 : Number(adArg);
    if (!Number.isFinite(ageDecayDays) || ageDecayDays <= 0) ageDecayDays = 30;
  }
  // G1（bench/recall-opt B1 生产化）：--inject-time-sort / --inject-wrapper neutral|legacy
  const injectTimeSort = flag("inject-time-sort");
  const injectWrapperRaw = arg("inject-wrapper", undefined);
  // #172-②/WP1b：三档（legacy | neutral | calibrated）。未指定 = **不覆盖**（继承沙箱 yaml /
  // 代码缺省 = calibrated）；显式给档则恒写沙箱 yaml，含 legacy——缺省已不是 legacy，
  // 不再写就等于 `--inject-wrapper legacy` 静默失效（缺省翻转后必须显式钉）。
  const injectWrapper =
    injectWrapperRaw === undefined
      ? undefined
      : injectWrapperRaw === "neutral" || injectWrapperRaw === "calibrated"
        ? injectWrapperRaw
        : "legacy";
  const injectOverride = {};
  if (injectTimeSort) injectOverride.timeSort = { enabled: true };
  if (injectWrapper !== undefined) injectOverride.wrapper = injectWrapper;
  // #169（2026-10-31）：证据包四档 --evidence-pack N（每侧邻接行数 0..3；N=0 = 不扩 = 对照档）。
  // 只写沙箱 yaml（recall.evidencePack）；时间窗/总帽/会话上限用生产缺省（30min / 6 行 / 400 行）。
  const evidencePackArg = arg("evidence-pack", undefined);
  const evidencePackOverride = (() => {
    if (evidencePackArg === undefined) return undefined;
    const n = evidencePackArg === true ? 1 : Number(evidencePackArg);
    const adjacent = Number.isFinite(n) ? Math.min(3, Math.max(0, Math.floor(n))) : 1;
    return { enabled: adjacent > 0, adjacent, windowMinutes: 30, maxExtraLines: 6, maxSessionRows: 400 };
  })();
  // B0 修复（bench/recall-opt）：rerank 试验键必须同时打进 override json——
  // loadGatewayConfig 合并优先级 override > yaml，生产 config-override.json 带
  // rerank.enabled=true，会吞掉沙箱 yaml 里的 enabled:false（2026-10-27 T4 实锤）。
  if (Object.keys(rerankOverride).length && overrideCopied) {
    try {
      const ojPath = overrideCopied;
      const oj = JSON.parse(fs.readFileSync(ojPath, "utf8"));
      oj.rerank = { ...(oj.rerank ?? {}), ...rerankOverride };
      fs.writeFileSync(ojPath, JSON.stringify(oj, null, 2) + "\n", "utf8");
      log("[bench] rerank 试验键同步进 override json: " + JSON.stringify(rerankOverride));
    } catch (e) {
      log("[bench] 警告: override json 补丁失败，试验键可能被生产 override 吞掉: " + String(e?.message ?? e));
    }
  }

  // #141 评审 #6：slot 预算 / 槽位成本 / 成对执行都依赖读侧回捞（smallToBig.enabled）。
  // 没有 --small-to-big 时这些键会被 yaml gate 掉，臂名写着 slot/require、实际跑的是旧档。
  if (!smallToBigEnabled) {
    const inert = [
      conclusionBudgetMode !== "shared" ? "--conclusion-budget-mode " + conclusionBudgetMode : null,
      conclusionSlotCost !== undefined ? "--conclusion-slot-cost" : null,
      conclusionPairing === "require" ? "--conclusion-pairing require" : null,
    ].filter(Boolean);
    if (inert.length) {
      console.error("[bench:error] " + inert.join("、") + " 需要 --small-to-big（读侧回捞没开时这些键会被 yaml gate 掉，等于白跑）");
      process.exit(2);
    }
  }
  if (conclusionSlotCost !== undefined && conclusionBudgetMode !== "slot") {
    console.error("[bench:error] --conclusion-slot-cost 只在 --conclusion-budget-mode slot 下生效；请补 --conclusion-budget-mode slot 或去掉槽位成本");
    process.exit(2);
  }

  const sandboxYaml = prepareBenchYaml({
    srcYaml: prodConfig,
    storeDir,
    ...(Object.keys(rerankOverride).length ? { rerankOverride } : {}),
    ...(Object.keys(mmrOverride).length ? { mmrOverride } : {}),
  ...(fusionOverride ? { fusionOverride } : {}),
  ...(candidateKOverride !== undefined ? { candidateKOverride } : {}),
  ...(presentTemporalOverride ? { presentTemporalOverride } : {}),
    ...(validityOverride ? { validityOverride } : {}),
    ...(validityOffOverride || recallMaxResultsOverride
      ? { recallFlatOverride: { ...(validityOffOverride || {}), ...(recallMaxResultsOverride || {}) } }
      : {}),
    ...(supersessionOverride ? { supersessionOverride } : {}),
    ...(embThresholdOverride !== undefined ? { embThresholdOverride } : {}),
    ...(ageDecayDays > 0 ? { ageDecayOverride: { enabled: true, halfLifeDays: ageDecayDays } } : {}),
    ...(Object.keys(injectOverride).length ? { injectOverride } : {}),
    // #139 第5项：读侧 smallToBig 独立于写侧 conclusionCards（拆分后两档可分别归因）。
    ...(smallToBigEnabled || smallToBigOff
      ? {
          smallToBigOverride: {
            enabled: smallToBigEnabled,
            ...(smallToBigEnabled ? { maxExtraLines: smallToBigMaxExtra, budget: conclusionBudgetMode, relevanceRanked: !conclusionLegacyRank } : {}),
          },
        }
      : {}),
    // conclusionLayer 是**读侧**（注入层）参数：maxConclusions/routing 不该被写侧开关 gate 掉，
    // 否则「不加 --conclusion-cards 就用不上 --conclusion-cap/--conclusion-routing」= 静默退化。
    // --conclusion-layer-off：连卡本身都不注入——归因表要的「无卡基线」档。
    ...(conclusionLayerOff || conclusionCap !== undefined || conclusionRouting !== "off" || conclusionSlotCost !== undefined || conclusionPairing !== "off"
      ? {
          conclusionLayerOverride: {
            ...(conclusionLayerOff ? { enabled: false } : {}),
            ...(!conclusionLayerOff && conclusionCap !== undefined ? { maxConclusions: conclusionCap } : {}),
            ...(!conclusionLayerOff && conclusionRouting !== "off" ? { routing: conclusionRouting } : {}),
            // #141 分阶段读侧旋钮：槽位成本 + 成对执行（只影响 slot/pairing 生效时的注入组装）。
            ...(!conclusionLayerOff && conclusionSlotCost !== undefined ? { slotCost: conclusionSlotCost } : {}),
            ...(!conclusionLayerOff && conclusionPairing !== "off" ? { pairing: conclusionPairing } : {}),
          },
        }
      : {}),
    ...(factChannelOverride ? { factChannelOverride } : {}),
    ...(evidencePackOverride ? { evidencePackOverride } : {}),
  });
  if (Object.keys(injectOverride).length) log("[bench] G1 注入试验档(仅沙箱 yaml): " + JSON.stringify(injectOverride));
  if (evidencePackOverride) log("[bench] #169 证据包档(仅沙箱 yaml): " + JSON.stringify(evidencePackOverride));
  if (conclusionCards) log("[bench] W3 写入面试验档(仅沙箱 yaml): 蒸馏 + part_of 证据链落库");
  if (conclusionLayerOff) log("[bench] 结论层整体关闭（--conclusion-layer-off）：无卡基线档");
  if (conclusionCap !== undefined || conclusionRouting !== "off" || conclusionSlotCost !== undefined || conclusionPairing !== "off") log("[bench] 结论层读侧试验档(仅沙箱 yaml): " + JSON.stringify({ ...(conclusionCap !== undefined ? { maxConclusions: conclusionCap } : {}), routing: conclusionRouting, ...(conclusionSlotCost !== undefined ? { slotCost: conclusionSlotCost } : {}), ...(conclusionPairing !== "off" ? { pairing: conclusionPairing } : {}) }));
  if (validityOffOverride) log("[bench] #141 效期对照档(仅沙箱 yaml): recall.excludeInvalidated=false（不排也不降权）");
  if (smallToBigEnabled) log("[bench] W3 读侧 smallToBig 试验档(仅沙箱 yaml): " + JSON.stringify({ enabled: true, maxExtraLines: smallToBigMaxExtra, budget: conclusionBudgetMode, relevanceRanked: !conclusionLegacyRank }));
  if (smallToBigOff) log("[bench] W3 读侧 smallToBig 显式关闭（--small-to-big-off）");
  if (ageDecayDays > 0) log("[bench] ageDecay 试验档(仅沙箱 yaml): " + JSON.stringify({ enabled: true, halfLifeDays: ageDecayDays }));
  if (Object.keys(rerankOverride).length) log("[bench] 精排试验档(仅沙箱 yaml): " + JSON.stringify(rerankOverride));
  if (Object.keys(mmrOverride).length) log("[bench] MMR 试验档(仅沙箱 yaml): " + JSON.stringify(mmrOverride));
  if (fusionOverride) log("[bench] R2 融合试验档(仅沙箱 yaml): " + JSON.stringify(fusionOverride));
  if (candidateKOverride !== undefined) log("[bench] R1 候选池上限试验档(仅沙箱 yaml): candidateK=" + candidateKOverride);
  if (presentTemporalOverride) log("[bench] R3 时间感知试验档(仅沙箱 yaml): " + JSON.stringify(presentTemporalOverride));
  if (factChannelOff) log("[bench] #137 事实键平行通道显式关闭（--fact-channel-off）：复跑无通道基线用");
  if (factChannelOverride) {
    log(
      "[bench] #137 事实键平行通道试验档(仅沙箱 yaml): recall.factChannel=" +
        JSON.stringify(factChannelOverride) +
        " 写侧=" + JSON.stringify({ ...factChannelOpts, dualWrite: factDualWrite }),
    );
  }

  const { cfg } = await loadBenchConfig(storeDir);
  // #135 第1项：回读**最终生效**配置并落报告/断言。生产 config-override.json 会覆盖沙箱 yaml
  // （rerank.enabled=true 吞掉 enabled:false 的教训），只信解析后的 cfg，不信自己写过什么。
  const effectiveConfig = effectiveRecallSnapshot(cfg);
  for (const [k, v] of Object.entries(effectiveConfig)) log(`[bench] cfg ${k}=${JSON.stringify(v)}`);
  // #135 第2项残留：--rerank-filter-only 的 filter 模式只在 ChildProcessReranker 里生效，
  // 而 store 只在 rerankChildProc && rerank.enabled && provider==='local' 时建子进程。
  // 所以 rerank.enabled 被关掉时，--rerank-child-proc 是空转、--rerank-filter-only 静默失效
  // （一档白跑）。这里对解析后的生效配置断言，别只校验 flag 有没有传。
  if (rerankFilterOnly && cfg.recall?.rerank?.enabled !== true) {
    console.error(
      "[bench] --rerank-filter-only 需要 rerank.enabled=true（当前生效值 enabled=" +
        JSON.stringify(cfg.recall?.rerank?.enabled) +
        "，provider=" + JSON.stringify(cfg.recall?.rerank?.provider) +
        "）：filter 模式只在 local 子进程精排路径生效；已中止，避免白跑一档。",
    );
    process.exit(2);
  }
  if (expectConfig) {
    try {
      assertExpectedConfig(effectiveConfig, expectConfig);
      log("[bench] --expect-config 通过: " + JSON.stringify(expectConfig));
    } catch (e) {
      console.error("[bench] " + String(e?.message ?? e));
      process.exit(2);
    }
  }
  const opened = await openBenchStore(cfg, storeDir);
  const { store, init } = opened;
  let embedding = opened.embedding;
  let dims = opened.dims;
  if (offlineEmbedding) {
    // 维度必须与 vec0 表一致：openBenchStore 的 getDimensions() 在远端 provider 未初始化时返回 0，
    // 落到默认 256 会与 2048 维表不匹配 —— sqlite 只打 non-fatal warn 并静默丢行（召回全空的假象）。
    const dim = dims > 0 ? dims : Number(cfg.embedding?.dimensions ?? 0);
    if (!(dim > 0)) {
      console.error("[bench] --offline-embedding 无法确定向量维数（dims=0 且 cfg.embedding.dimensions 缺失）：已中止，避免静默丢行");
      process.exit(2);
    }
    embedding = makeOfflineEmbedding(dim);
    dims = dim;
    log("[bench] ⚠ 离线 hash 向量模式：" + OFFLINE_EMBEDDING_CALIBER + "，维=" + dim + "；已禁用 embed-cache");
  }
  log(`[bench] 存储=${cfg.storeBackend} 向量维=${dims} bm25=${cfg.bm25?.enabled ? "on" : "off"} 精排=${cfg.recall?.rerank?.provider ?? "none"}(enabled=${cfg.recall?.rerank?.enabled === true})`);
  if (init && init.needsReindex) log("[bench] 警告: store.init 要求重建索引（embedding 维度变化）");

  log(`[bench] 记忆语料组=${groups.size}（每组一次灌库 + 组内题目检索）`);

  const ingestStats = { groups: 0, turns: 0, embedded: 0, embedFailed: 0, written: 0, embedRetries: 0 };
  const resolvers = new Map();
  const corpusSummary = [];

  // W1/W2（issue #134）：抽取器 LLM——凭据同一读取器（ADR-0006），yaml 已由 prepareBenchYaml 落盘。
  let factLlm = null;
  let factModel = null;
  if (factExtract || conclusionCards) {
    const fcred0 = readLlmCredential({ yamlPath: path.join(storeDir, "bench-gateway.yaml"), baseDir: storeDir });
    // 「小模型离线批处理」：--fact-model 覆盖抽取/蒸馏用模型（端点 highspeed 档；缺省=生产同款）
    const fcred = typeof factModelArg === "string" && factModelArg ? { ...fcred0, model: factModelArg } : fcred0;
    factLlm = makeLlm(fcred);
    factModel = factLlm.info?.model ?? fcred?.model ?? "unknown";
    if (factExtract) log(`[bench] 事实抽取: model=${factModel} cache=${factCacheDir} dualWrite=${factDualWrite} supersede=${writeSupersede} factRows=${factRows}`);
    if (conclusionCards) log(`[bench] 结论卡蒸馏: model=${factModel} max=${conclusionMax} cache=${factCacheDir}`);
  }
  // #139 第2项：抽取/蒸馏计数走 stages.mjs 单一实现（缓存命中与实抽同口径，含 token 来源分桶）。
  const stageStats = createStageStats();
  const factStats = stageStats.facts;
  const conclusionStats = stageStats.conclusions;

  if (!reuseMode) {
    const t0 = Date.now();
    let gi = 0;
    for (const [key, g] of groups) {
      gi++;
      const contentIndex = new Map();
      // 缓存优先；命中零外呼。未启用段返回 null（与历史「不抽就不计」等价）。
      const fetched = await fetchFactsAndConclusions({
        caseObj: g.corpus,
        factCacheDir,
        llm: factLlm,
        model: factModel,
        wantFacts: factExtract,
        wantConclusions: conclusionCards,
        factBatchSize,
        factConcurrency,
        conclusionMax,
        logger: { warn: (m) => log("[bench:warn] " + m) },
      });
      mergeStageStats(stageStats, fetched);
      const st = await ingestCase({
        caseObj: g.corpus,
        store,
        embedding,
        contentIndex,
        opts: {
          concurrency: num("concurrency", 1),
          embedMinIntervalMs: embedIntervalMs,
          facts: fetched.facts?.facts,
          conclusions: fetched.conclusions,
          writePolicy: {
            dualWrite: factDualWrite ? { enabled: true, separator: factSeparator, maxFactChars } : null,
            factChannel: factChannelOpts,
            supersede: writeSupersede,
            cardinalityGate,
            // #146：一条事实一行（写面）。cardinalityDefault 留给启发式缺省（default-single）。
            factRows: factRows ? { enabled: true } : null,
          },
        },
      });
      ingestStats.groups++;
      ingestStats.turns += st.turns;
      ingestStats.embedded += st.embedded;
      ingestStats.embedFailed += st.embedFailed;
      ingestStats.embedRetries += st.embedRetries ?? 0;
      ingestStats.written += st.written;
      // W1/W2/W3 写入面计数（门禁预算与证据用）
      if (st.factTurns !== undefined) ingestStats.factTurns = (ingestStats.factTurns ?? 0) + st.factTurns;
      if (st.factKeyCharsAdded !== undefined) ingestStats.factKeyCharsAdded = (ingestStats.factKeyCharsAdded ?? 0) + st.factKeyCharsAdded;
      if (st.supersedeOps !== undefined) ingestStats.supersedeOps = (ingestStats.supersedeOps ?? 0) + st.supersedeOps;
      if (st.superseded !== undefined) ingestStats.superseded = (ingestStats.superseded ?? 0) + st.superseded;
      if (st.supersedeOpsSingle !== undefined) ingestStats.supersedeOpsSingle = (ingestStats.supersedeOpsSingle ?? 0) + st.supersedeOpsSingle;
      if (st.supersedeOpsMulti !== undefined) ingestStats.supersedeOpsMulti = (ingestStats.supersedeOpsMulti ?? 0) + st.supersedeOpsMulti;
      if (st.conclusionsWritten !== undefined) ingestStats.conclusionsWritten = (ingestStats.conclusionsWritten ?? 0) + st.conclusionsWritten;
      if (st.conclusionLinks !== undefined) ingestStats.conclusionLinks = (ingestStats.conclusionLinks ?? 0) + st.conclusionLinks;
      // #146 事实行写入面计数（0 事实行 = 本档等同整行档，报告里必须看得见）
      for (const key of ["factRows", "factRowTurns", "factRowDropped", "factRowInvalidateOps", "factRowsInvalidated", "factRowInvalidateFailed"]) {
        if (st[key] !== undefined) ingestStats[key] = (ingestStats[key] ?? 0) + st[key];
      }
      if (st.factRowInvalidateUnsupported) ingestStats.factRowInvalidateUnsupported = true;
      // #137 事实键平行通道计数（写侧有效性证据：0 写入 = 本档等同控制档，不能当成功）
      for (const key of ["factChannelTurns", "factChannelEmbedded", "factChannelEmbedFailed", "factChannelWriteFailed", "factChannelKeyChars"]) {
        if (st[key] !== undefined) ingestStats[key] = (ingestStats[key] ?? 0) + st[key];
      }
      if (st.factChannelUnsupported) ingestStats.factChannelUnsupported = true;
      resolvers.set(key, makeIdResolver(contentIndex));
      corpusSummary.push({ groupKey: key, turns: st.turns, written: st.written, embedded: st.embedded });
      if (!quiet && (gi % 5 === 0 || gi === groups.size)) {
        log(`[bench] 灌库 ${gi}/${groups.size} 轮数=${ingestStats.turns} 已写=${ingestStats.written} 向量=${ingestStats.embedded}（失败 ${ingestStats.embedFailed}，重试 ${ingestStats.embedRetries}）耗时=${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }
    // #141 纪律：0 事实行 = 本档与整行档行为等同，报告里不能当「事实行档」结论用。
    if (factRows && (ingestStats.factRowTurns ?? 0) === 0) {
      console.warn("[bench:warn] --fact-rows 打开但 0 个 turn 产出事实行（facts 缓存无可用三元组？）——本档等同整行档，不能作为事实行结论");
    }
    if (factRows) {
      log(
        `[bench] 事实行写面: 行=${ingestStats.factRows ?? 0}（来自 ${ingestStats.factRowTurns ?? 0} 轮，去重丢弃 ${ingestStats.factRowDropped ?? 0}）` +
          ` 失效调用=${ingestStats.factRowInvalidateOps ?? 0} 失效旧行=${ingestStats.factRowsInvalidated ?? 0}` +
          `${ingestStats.factRowInvalidateFailed ? ` 失效失败=${ingestStats.factRowInvalidateFailed}` : ""}` +
          `${ingestStats.factRowInvalidateUnsupported ? "（store 不支持事实级失效）" : ""}`,
      );
    }
    // ── #166 验收④：IDF 稀释隔离档（诊断，不参与生产口径）──
    // 只删每个 turn 的 fact_index>0 行的 **fts5 索引**，vec0 与主表 l1_records 全量保留：
    //  - 效期/失效判定、读侧折叠、精排输入、向量候选集全部不变；
    //  - 变的只有「同一 turn 文本在 FTS 语料里出现几次」= BM25 df / IDF 的唯一变量
    //    （spec 要隔离的就是这条；连 vec0 一起删会让向量候选变稀，读数无法归因到 IDF）。
    // 判读：v2 残留掉分若主要来自 IDF 稀释，本档应把 turnCov 拉回整行档附近；若仍低，说明还有槽位/排序因素。
    if (pruneFactSiblingIndex) {
      const db = store?.db;
      if (!db || typeof db.prepare !== "function") {
        console.error("[bench:error] --prune-fact-sibling-index 需要 sqlite store（store.db 不可用）——本档只对 sqlite 后端起效");
        process.exit(2);
      }
      const all = db.prepare("SELECT record_id, metadata_json FROM l1_records").all();
      const delFts = db.prepare("DELETE FROM l1_fts WHERE record_id = ?");
      let pruned = 0;
      let kept = 0;
      db.exec("BEGIN");
      try {
        for (const row of all) {
          let md;
          try { md = JSON.parse(row.metadata_json ?? "{}"); } catch { md = {}; }
          const fi = typeof md?.fact_index === "number" ? md.fact_index : undefined;
          if (fi !== undefined && fi > 0) {
            delFts.run(row.record_id);
            pruned++;
          } else {
            kept++;
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
      ingestStats.prunedFactSiblingIndex = pruned;
      ingestStats.indexedRowsAfterPrune = kept;
      log(`[bench] #166 IDF 隔离档：FTS 面删兄弟行 ${pruned}（仅 fact_index>0），保留 ${kept}；主表 l1_records 与 l1_vec 全量保留（效期/向量候选不变）`);
    }
  } else {
    // 复用模式：仍需 content→id 映射（stub，按召回内容反查不可行 → 直接按规则重建索引）
    for (const [key, g] of groups) {
      const contentIndex = new Map();
      // #146 诊断档踩坑：--fact-rows 库里命中的是「事实行」，内容=事实短语（带 [ts] 说话人 前缀），
      // 只索引父 turn 原文会让事实行命中全部 unresolved（实测 turnCov 78.4% → 15.5%，纯度量假摔）。
      // 复用模式没有写入期的回填，只能按同一 planner 重算事实行内容（facts 缓存命中，零外呼）。
      const reuseFacts = factRows
        ? await fetchFactsAndConclusions({
            caseObj: g.corpus,
            factCacheDir,
            llm: factLlm,
            model: factModel,
            wantFacts: true,
            wantConclusions: false,
            factBatchSize,
            factConcurrency,
            conclusionMax,
            logger: { warn: (m) => log("[bench:warn] " + m) },
          })
        : null;
      for (const gg of g.corpus.groups) for (const t of gg.turns) {
        const { turnContent } = await import("./lib/bench/store.mjs");
        contentIndex.set(normHead(turnContent(g.corpus, t)), t.id);
        // 注意嵌套口径：fetchFactsAndConclusions 返回 {facts:<factsForCase 返回>}，byTurn 在 facts.facts.byTurn
        // （灌库分支同样用 fetched.facts?.facts，见 ingestCase 调用处）。
        const byTurn = reuseFacts?.facts?.facts?.byTurn;
        if (byTurn) {
          const plan = await buildFactRowRecords({ caseObj: g.corpus, turn: t, sessionId: gg.sessionId, turnFacts: byTurn[t.id] });
          for (const row of plan.rows) contentIndex.set(normHead(row.record.content), t.id);
        }
      }
      resolvers.set(key, makeIdResolver(contentIndex));
      corpusSummary.push({ groupKey: key, turns: contentIndex.size, reused: true });
    }
  }

  // ── 检索评估 ──
  // B2-b：validityNow 用题目日期（--b2b-validity；缺省保持 new Date() 现状）
  const b2bValidity = flag("b2b-validity");
  // ── #144：filter floor 校准的候选分数转储 ──
  // 为什么在 bench 侧开：results JSON 只留 kept/dropped 计数，事后无法重建**任何其它 floor** 的
  // turnCov；一档一跑 = 每档 90 题白烧一次精排。转储全量分数后，任意 floor 都能离线重算。
  const dumpRerankScores = flag("dump-rerank-scores");
  let rerankScoreDumpPath;
  if (dumpRerankScores) {
    if (rerankOverride.enabled === false) {
      console.error("[bench] --dump-rerank-scores 需要精排开启（当前 --rerank-off）；已中止，避免落空文件后误判分布。");
      process.exit(2);
    }
    fs.mkdirSync(outDir, { recursive: true });
    const dumpStamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dumpReportName = String(strArg("report-name", "") ?? "").trim();
    const dumpName = dumpReportName || `${datasetName}-${dumpStamp}`;
    rerankScoreDumpPath = path.join(outDir, `${dumpName}-rerank-scores.jsonl`);
    fs.rmSync(rerankScoreDumpPath, { force: true });
    process.env.RERANK_SCORE_DUMP = rerankScoreDumpPath;
    log("[bench] #144 候选分数转储: " + rerankScoreDumpPath + "（全量候选分数；诊断用，勿把该档延迟当正式口径）");
  }
    // B0 修复（bench/recall-opt）：--rerank-child-proc 精排子进程隔离（onnx 原生崩溃防护）
  const rerankChildProc = flag("rerank-child-proc");
  // B2a 提速（bench/recall-opt）：rerank 推理耗时治理——文档截断 + onnx 线程数。
  // 只影响 --rerank-child-proc 子进程链路（env 透传 worker）；A/B 全档一致即对比公平。
  let rerankDocCap = 0;
  let rerankThreads = 0;
  if (rerankChildProc) {
    rerankDocCap = num("rerank-doc-cap", 192);
    rerankThreads = num("rerank-threads", 8);
    process.env.RERANK_DOC_CAP = String(rerankDocCap);
    process.env.RERANK_THREADS = String(rerankThreads);
  }
  // ── W1/W2/W3 分阶段写入（--store 复用库：只补写本档差异，不重灌 turn）──
  // 语义等价于重灌：W1 只对「有事实」的 turn 重 embed 键（无事实 turn 键===原文，复用原向量）；
  // W2 只落 valid_end 标记；W3 只写结论卡 + part_of 链。embedding 外呼因此降到 1/N。
  // #139 第5项补充：读侧迭代档（--store 复用库）不该顺带触发写侧外呼——尤其
  // 「库里已有结论卡、只想比 smallToBig 开/关」的归因场景。--no-write-steps 显式关掉本段。
  const noWriteSteps = flag("no-write-steps");
  if (noWriteSteps && reuseMode) {
    log("[bench] --no-write-steps：跳过分阶段写入（只做读侧评估；写侧保持库内现状）");
  }
  if (reuseMode && !noWriteSteps && (factDualWrite || writeSupersede || conclusionCards || factChannelWrite)) {
    const t0 = Date.now();
    log(`[bench] 分阶段写入：dualWrite=${factDualWrite} supersede=${writeSupersede} conclusions=${conclusionCards} factChannel=${factChannelWrite}${factChannelReadOnly ? "（read-only 档：不写通道向量）" : ""}`);
    let gi2 = 0;
    for (const [, g] of groups) {
      gi2++;
      const records = [];
      for (const gg of g.corpus.groups) for (const t of gg.turns) records.push({ turn: t, sessionId: gg.sessionId });
      const fetched = await fetchFactsAndConclusions({
        caseObj: g.corpus,
        factCacheDir,
        llm: factLlm,
        model: factModel,
        wantFacts: factDualWrite || writeSupersede || factChannelWrite,
        wantConclusions: conclusionCards,
        factBatchSize,
        factConcurrency,
        conclusionMax,
        logger: { warn: (m) => log("[bench:warn] " + m) },
      });
      // #139 第2项：旧分阶段分支**完全不累加 conclusionStats.ms**，且缓存命中不计 usage；
      // 统一走 mergeStageStats 后与灌库主循环同口径（缓存档 token 也可测）。
      mergeStageStats(stageStats, fetched);
      const fx = fetched.facts;
      const cc = fetched.conclusions;
      if (factDualWrite || factChannelWrite) {
        const st = await reembedFactKeys({
          caseObj: g.corpus,
          store,
          embedding,
          facts: fx?.facts,
          ...(factDualWrite ? { dualWrite: { enabled: true, separator: factSeparator, maxFactChars: factMaxChars } } : {}),
          ...(factChannelOpts ? { factChannel: factChannelOpts } : {}),
          embedMinIntervalMs: embedIntervalMs,
        });
        if (factDualWrite) {
          ingestStats.factTurns = (ingestStats.factTurns ?? 0) + (st.factTurns ?? 0);
          ingestStats.factKeyCharsAdded = (ingestStats.factKeyCharsAdded ?? 0) + (st.factKeyCharsAdded ?? 0);
          ingestStats.embedded = (ingestStats.embedded ?? 0) + (st.embedded ?? 0);
          ingestStats.embedFailed = (ingestStats.embedFailed ?? 0) + (st.embedFailed ?? 0);
          ingestStats.embedRetries = (ingestStats.embedRetries ?? 0) + (st.embedRetries ?? 0);
        }
        // #137 通道计数（st 侧只有通道字段；dualWrite 关闭时主通道零变化）
        for (const key of ["factChannelTurns", "factChannelEmbedded", "factChannelEmbedFailed", "factChannelWriteFailed", "factChannelKeyChars"]) {
          if (st[key] !== undefined) ingestStats[key] = (ingestStats[key] ?? 0) + st[key];
        }
        if (st.factChannelUnsupported) ingestStats.factChannelUnsupported = true;
      }
      const st2 = await applyWriteSteps({
        caseObj: g.corpus,
        store,
        records,
        facts: fx?.facts,
        supersede: writeSupersede,
        ...(cardinalityGate === false ? { cardinalityGate: false } : {}),
        conclusions: cc,
      });
      ingestStats.supersedeOps = (ingestStats.supersedeOps ?? 0) + (st2.supersedeOps ?? 0);
      ingestStats.superseded = (ingestStats.superseded ?? 0) + (st2.superseded ?? 0);
      ingestStats.supersedeOpsSingle = (ingestStats.supersedeOpsSingle ?? 0) + (st2.supersedeOpsSingle ?? 0);
      ingestStats.supersedeOpsMulti = (ingestStats.supersedeOpsMulti ?? 0) + (st2.supersedeOpsMulti ?? 0);
      ingestStats.conclusionsWritten = (ingestStats.conclusionsWritten ?? 0) + (st2.conclusionsWritten ?? 0);
      ingestStats.conclusionLinks = (ingestStats.conclusionLinks ?? 0) + (st2.conclusionLinks ?? 0);
      if (!quiet && (gi2 % 10 === 0 || gi2 === groups.size)) {
        log(`[bench] 分阶段写入 ${gi2}/${groups.size}（重嵌 turn ${ingestStats.factTurns ?? 0}，失效 ${ingestStats.superseded ?? 0}，结论卡 ${ingestStats.conclusionsWritten ?? 0}）耗时=${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }
    log(`[bench] 分阶段写入完成：耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  // #137 事实通道写侧证据：0 条 = 本档实际等同控制档（store 不支持 / 事实缓存空 / 键全空），
  // 必须显式可见——否则容易把「通道没生效」误读成「通道无效」。
  if (factChannelWrite) {
    log(
      `[bench] 事实通道写侧: turns=${ingestStats.factChannelTurns ?? 0} 已写=${ingestStats.factChannelEmbedded ?? 0} ` +
        `embed失败=${ingestStats.factChannelEmbedFailed ?? 0} 写失败=${ingestStats.factChannelWriteFailed ?? 0}`,
    );
    if ((ingestStats.factChannelEmbedded ?? 0) === 0) {
      console.warn("[bench:warn] 事实通道向量写入 0 条——本档等同控制档（检查 store.upsertL1FactVector / 事实缓存）");
    }
  } else if (factChannel) {
    log("[bench] 事实通道 read-only 档：不写通道向量（假定 --store 库已灌好）");
  }

  // 查询向量磁盘缓存：同一批题目跨档复用（embedding 确定性，语义零变化），避开账号级 RPM 限流。
  const embedCacheDir = String(arg("embed-cache", path.join(repo, ".eval-data", "bench", "embed-cache")));
  // 缓存键按 model+dims 计：hash 向量绝不能进真实模型缓存（否则后续真实档命中脏向量）。
  const embedForRecall = withEmbedCache(embedding, flag("no-embed-cache") || offlineEmbedding ? null : embedCacheDir, `${cfg.embedding?.model ?? "emb"}-${dims}`);
  const recall = makeRecall({ cfg, store, embedding: embedForRecall, dataDir: storeDir, validityFromCase: b2bValidity, rerankChildProc, rerankFilterOnly, rerankFilterFloor });
  const k = num("k", cfg.recall?.maxResults ?? 5);
  // #146 诊断档：事实行模式下一个 turn 会占多行（1.5–2 行/turn 实测），k 个槽位装不到 k 个 turn。
  // --dedupe-hits-by-turn 在**召回之后、指标与注入之前**按父 turn 折叠（保留最高分的首现行），
  // 配合 --recall-max-results 放大的池子，衡量「同预算下能装几个不同 turn」。
  // #146 诊断档 2：读侧「父 turn 展开」——命中事实行（拆碎的短句）时，把注入内容换回父 turn 原文。
  // 模拟生产「读侧把事实行展开回 L0/journal 原文」的可行性：度量仍是父 turn（contentIndex 已回填），
  // 所以本档只变注入载荷，不变命中集。需要 store 里的 row id → turn 映射，故只能用 turn 文本表反查。
  const expandParentTurn = flag("expand-parent-turn");
  const dedupeByTurn = flag("dedupe-hits-by-turn");
  const dedupeHits = (hits, resolve) => {
    if (!dedupeByTurn || !Array.isArray(hits)) return { hits, dup: 0 };
    const seen = new Set();
    const out = [];
    let dup = 0;
    for (const h of hits) {
      const id = resolve(h?.clean ?? h?.content);
      if (id) {
        if (seen.has(id)) { dup++; continue; }
        seen.add(id);
      }
      out.push(h);
    }
    return { hits: out, dup };
  };
  // #146 诊断档 2：turn id → 原文表（父 turn 展开只换注入载荷；命中集与度量口径不动）
  const turnTextById = new Map();
  if (expandParentTurn) {
    for (const [, g] of groups) for (const gg of g.corpus.groups) for (const t of gg.turns) turnTextById.set(t.id, turnContent(g.corpus, t));
    log("[bench] #146 诊断档：读侧父 turn 展开开启（命中事实行 → 注入父 turn 原文，命中集不变）");
  }
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
  // #146 算法重判：币值口径答案提示（读侧只改措辞，不动检索/存储）。
  const currencyPrompt = flag("currency-prompt");
  const prefPrompt = flag("pref-prompt");
  // #146 后续 Y 臂：证据编排（按日期分组 + 证据清点 + 先整理再答），只重排注入块，不删行。
  const marshalPrompt = flag("marshal-prompt");
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
      // 召回整段失败不中止评测，但必须留痕：报告 rows[].error 与日志双落（否则只剩 strategy=error，事后无从归因）。
      log("[bench:warn] 召回失败 " + c.caseId + ": " + r.error);
    }
    if (paceMs > 0) await new Promise((res) => setTimeout(res, paceMs));
    let dupHits = 0;
    let expandedHits = 0;
    if (expandParentTurn && !r.error) {
      const resolveHit = resolvers.get(c.groupKey);
      r = {
        ...r,
        hits: r.hits.map((h) => {
          const id = resolveHit(h.clean ?? h.content);
          const txt = id ? turnTextById.get(id) : null;
          // clean 保持原样：resolve(clean) → 父 turn id 是度量口径的锚，换掉会让 turnCov 崩。
          if (!txt || txt === h.clean) return h;
          expandedHits++;
          return { ...h, content: txt, expanded: true };
        }),
      };
    }
    if (dedupeByTurn && !r.error) {
      const d = dedupeHits(r.hits, resolvers.get(c.groupKey));
      r = { ...r, hits: d.hits };
      dupHits = d.dup;
    }
    const ret = evalRetrieval({ caseObj: c, hits: r.hits, resolve: resolvers.get(c.groupKey), k, kList });
    // #141 / #158：注入行类型归因 + 证据充分性。逐题就地算（hits 是对象数组，
    // 报告里只落 hits 计数，事后无法再归因），跨题汇总交 aggregate 之外的 byTypeTotal 单独落盘。
    // sessionOf 与 metrics.evalRetrieval 同口径：turn id 尾部 -s<N>-t<M> → session_<N>。
    const sessionOfTurn = (id) => {
      const m = String(id).match(/-s(\d+)-t\d+$/);
      return m ? `session_${Number(m[1])}` : null;
    };
    const lineTypeStats = attributeInjectedLines({
      hits: r.hits,
      resolve: resolvers.get(c.groupKey),
      goldTurnIds: c.evidenceTurnIds,
      sessionOf: sessionOfTurn,
      goldSessionIds: c.evidenceSessionIds,
    });
    // #139 评论 8：block 与 evidence 是两条渲染路，报告里分别落长度，避免分析时混读。
    const evidenceBlock = b1Mode ? buildEvidenceBlock(r.hits) : null;
    // 证据充分性：量的是「作答模型眼前那段证据」的字面 gold 覆盖率（b1 用编号证据块，否则用记忆块）。
    const suff = evidenceSufficiency({
      evidence: b1Mode ? evidenceBlock : r.block,
      goldAnswer: c.goldAnswer,
    });
    rows.push({
      caseId: c.caseId,
      questionType: c.questionType,
      question: c.question,
      gold: c.goldAnswer,
      latencyMs: Math.round(r.latencyMs),
      strategy: r.strategy,
      ...(r.error ? { error: r.error } : {}),
      layered: r.layered,
      conclusionCount: r.conclusionCount,
      experienceCount: r.experienceCount,
      // B0 校尺：检索计时/门观测/相关度分数序列透传进行数据
      searchTiming: r.searchTiming ?? null,
      // #170：召回层分段计时（total/scene/expand/l2/l1/soul），cost 段据此给分段成本
      perfMs: r.perfMs ?? null,
      ...(r.gates ? { gates: r.gates } : {}),
      // #169：证据包观测（enabled=true 时恒有；adjacencyLines 等计数只表示「补进来的上下文」，
      // 与 turnCov/sessionCov 无关——覆盖率口径只认 seed 行）
      ...(r.gates?.evidencePack ? { evidencePack: r.gates.evidencePack } : {}),
      scores: r.hits.map((h) => Math.round((h.score ?? 0) * 1e4) / 1e4),
      ...(b1Mode ? { evidence: evidenceBlock, evidenceChars: evidenceBlock.length } : {}),
      blockChars: (r.block || "").length,
      hits: r.hits.length,
      // #146 诊断档：被折叠掉的「同 turn 重复行」条数（0 = 未开 --dedupe-hits-by-turn 或池子无重复）
      dupTurnHits: dupHits,
      // #146 诊断档 2：本问有几条命中被换回父 turn 原文（0 = 未开 --expand-parent-turn 或没命中事实行）
      expandedHits,
      topContents: r.hits.slice(0, k).map((h) => h.content.slice(0, 160)),
      ...ret,
      // #141 / #158：注入行类型归因（含去掉某类后的一阶覆盖率损失）与证据充分性。
      // missing 只留前 20 token，报告体积可控；全量口径见单测。
      lineTypeStats,
      evidenceSufficiency: { score: suff.score, goldTokens: suff.goldTokens, coveredTokens: suff.coveredTokens },
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
            : marshalPrompt
              ? { role: "user", content: buildAnswerPromptMarshalled({ question: row.question, block: row.block, questionDate: c?.questionDateISO, datasetName: ds.name, currency: !!currencyPrompt, preference: !!prefPrompt }) }
            : currencyPrompt || prefPrompt
              ? { role: "user", content: buildAnswerPromptTuned({ question: row.question, block: row.block, questionDate: c?.questionDateISO, datasetName: ds.name, currency: !!currencyPrompt, preference: !!prefPrompt }) }
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
  // #141 / #158：跨题注入行类型汇总（与 rows[].lineTypeStats.byType 同口径累加，sessions 按题求和）
  // 与证据充分性均值（null = 证据块里没有 gold token，不参与均值，避免把「无信号」摊成 0 分）。
  const lineTypeTotals = Object.fromEntries(INJECT_LINE_TYPES.map((t) => [t, { lines: 0, goldLines: 0, sessions: 0 }]));
  for (const row of rows) {
    const bt = row.lineTypeStats?.byType ?? {};
    for (const t of INJECT_LINE_TYPES) {
      if (!bt[t]) continue;
      lineTypeTotals[t].lines += bt[t].lines;
      lineTypeTotals[t].goldLines += bt[t].goldLines;
      lineTypeTotals[t].sessions += bt[t].sessions;
    }
  }
  // #169：证据包汇总（独立计数 = Lead 要求的防自我污染口径）。
  // 「+N 档变好」必须能与「指标被扩行推高」区分开：这里只累计 pack 行与跳过原因，
  // turnCov/sessionCov 只在 seed 行上算（见 lib/bench/inject-attribution.mjs 口径注释）。
  const epTotals = {
    enabledCases: 0,
    seedLines: 0,
    seedWithSession: 0,
    adjacencyLines: 0,
    skippedNoSession: 0,
    skippedNoSeedRow: 0,
    skippedWindow: 0,
    skippedCap: 0,
    skippedSessionTooLarge: 0,
    sessionsQueried: 0,
  };
  for (const row of rows) {
    const ep = row.evidencePack;
    if (!ep || ep.enabled !== true) continue;
    epTotals.enabledCases++;
    epTotals.seedLines += ep.seedLines ?? 0;
    epTotals.seedWithSession += ep.seedWithSession ?? 0;
    epTotals.adjacencyLines += ep.adjacencyLines ?? 0;
    epTotals.skippedNoSession += ep.skippedNoSession ?? 0;
    epTotals.skippedNoSeedRow += ep.skippedNoSeedRow ?? 0;
    epTotals.skippedWindow += ep.skippedWindow ?? 0;
    epTotals.skippedCap += ep.skippedCap ?? 0;
    epTotals.skippedSessionTooLarge += ep.skippedSessionTooLarge ?? 0;
    epTotals.sessionsQueried += ep.sessionsQueried ?? 0;
  }
  const esScores = rows.map((row) => row.evidenceSufficiency?.score).filter((v) => typeof v === "number");
  const evidenceSufficiencySummary = {
    mean: esScores.length ? esScores.reduce((a, b) => a + b, 0) / esScores.length : null,
    cases: esScores.length,
  };
  // 审计 M6：三层（代码缺省 → 配置文件 → CLI/沙箱）合并后的最终生效值 + 逐键来源。
  // 底配来自 gitignored 的 tdai-gateway.yaml，只记 CLI 覆盖值等于「读数不可自证」。
  const effective = await readEffectiveBenchConfig({ sandboxYaml, srcYaml: prodConfig, dataDir: storeDir });
  if (effective.meta.error) log("[bench] 警告: 生效配置快照失败: " + effective.meta.error);
  else log("[bench] 生效配置 " + formatEffectiveConfig(effective));

  // 「实验值，非缺省」标注（lead 2026-10-31）：被臂钉死的调参旋钮必须与代码缺省显式区分。
  // 只列已知会被实验臂改写的旋钮——不是所有非缺省键都算实验（生产 yaml 里的值也是非缺省，但它才是线上口径）。
  const EXPERIMENTAL_KNOBS = ["recall.validity.softPenalty"];
  const experimentalKnobs = {};
  for (const key of EXPERIMENTAL_KNOBS) {
    const val = effective.values[key];
    const def = effective.defaults?.[key];
    if (JSON.stringify(val) === JSON.stringify(def)) continue;
    experimentalKnobs[key] = { value: val ?? null, defaultValue: def ?? null, source: effective.sources?.[key] ?? "?", note: "实验值，非缺省" };
  }
  if (Object.keys(experimentalKnobs).length) log("[bench] ⚠ 实验值（非缺省）: " + JSON.stringify(experimentalKnobs));

  // 库形态（lead 2026-10-31）：失效行数必须是一等字段。
  // r141 五臂全部读在 inval=0 的库上 ⇒ validity 分档是空实验，而旧报告只记 rows、看不出来。
  const storeShape = (() => {
    try {
      const db = store.getRawDb?.();
      if (!db) return { error: "store 未暴露 getRawDb（非 sqlite 后端）" };
      const c = (sql) => Number(db.prepare(sql).get()?.c ?? 0);
      const l1Rows = c("SELECT COUNT(*) AS c FROM l1_records");
      const invalidatedRows = c("SELECT COUNT(*) AS c FROM l1_records WHERE valid_end IS NOT NULL AND valid_end <> ''");
      const sessions = c("SELECT COUNT(DISTINCT session_id) AS c FROM l1_records");
      return {
        l1Rows,
        invalidatedRows,
        invalidatedPct: l1Rows ? +((invalidatedRows / l1Rows) * 100).toFixed(2) : null,
        sessions,
        caliber: "valid_end 非空行即失效行（store 侧原样计数，不按题型/来源过滤）",
      };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  })();
  log(`[bench] 库形态 l1=${storeShape.l1Rows ?? "?"} inval=${storeShape.invalidatedRows ?? "?"} (${storeShape.invalidatedPct ?? "?"}%) sessions=${storeShape.sessions ?? "?"}`);

  const report = {
    generatedAt: new Date().toISOString(),
    repoCommit: gitSha(),
    dataset: { ...dsSummary, file: dataPath },
    // 库形态：inval=0 的库上跑 validity 分档等于空实验（r141 五臂教训），故必须随报告落盘。
    storeShape,
    config: {
      storeBackend: cfg.storeBackend,
      embeddingModel: cfg.embedding?.model,
      embeddingDims: dims,
      // 审计：本次到底用哪套向量。hash 向量档必须显式标注，否则读数会被当成生产 embedding 结论。
      embeddingVector: offlineEmbedding
        ? { mode: "offline-hash", caliber: OFFLINE_EMBEDDING_CALIBER }
        : { mode: "provider" },
      bm25: cfg.bm25?.enabled ?? false,
      recallStrategy: cfg.recall?.strategy,
      maxResults: cfg.recall?.maxResults,
      scoreThreshold: cfg.recall?.scoreThreshold,
      queryExpansion: cfg.recall?.queryExpansion?.enabled ?? false,
      rerank: cfg.recall?.rerank?.provider ?? "none",
      // #135 第1项：报告必须记 enabled（只记 provider 会掩盖"沙箱写 false、生产 override 覆盖成 true"）
      rerankEnabled: cfg.recall?.rerank?.enabled === true,
      // #144：filter floor 校准的**生效**参数快照——floor 的可比性取决于标度(mode/logitScale)，只记分数会张冠李戴。
      rerankMode: cfg.recall?.rerank?.mode ?? "rerank",
      rerankMinScore: cfg.recall?.rerank?.minScore ?? null,
      rerankCandidates: cfg.recall?.rerank?.candidates ?? null,
      rerankScoreDump: rerankScoreDumpPath ? path.basename(rerankScoreDumpPath) : null,
      // #144：filter 判定尺子（floor/margin/quantile）与相对尺子参数——只记 minScore 无法区分「按绝对分剪」与「按题内序剪」。
      rerankFilterRule: cfg.recall?.rerank?.filterRule ?? null,
      rerankMarginTop: cfg.recall?.rerank?.filterMarginTop ?? null,
      rerankKeepRatio: cfg.recall?.rerank?.filterKeepRatio ?? null,
      // #139 第5项：读侧 smallToBig 与写侧 conclusionCards 分开归因
      smallToBig: {
        enabled: cfg.recall?.smallToBig?.enabled === true,
        maxExtraLines: cfg.recall?.smallToBig?.maxExtraLines ?? null,
        budget: cfg.recall?.smallToBig?.budget ?? null,
        relevanceRanked: cfg.recall?.smallToBig?.relevanceRanked ?? null,
        // 'on' / 'off' / null：null = 没指定，继承生产 yaml 的生效值（旧布尔分不清这两者）。
        requested: smallToBigEnabled ? "on" : smallToBigOff ? "off" : null,
      },
      // #141（三机制分阶段）：读侧结论层的**生效**快照。判定表必须能区分「这一臂真跑在新分阶段」
      // 与「旗标静默回落到旧档」——只看命令行看不出来，只看 effectiveConfig 又要人肉挖。
      conclusionLayer: {
        enabled: cfg.recall?.conclusionLayer?.enabled !== false,
        maxConclusions: cfg.recall?.conclusionLayer?.maxConclusions ?? null,
        routing: cfg.recall?.conclusionLayer?.routing ?? null,
        pairing: cfg.recall?.conclusionLayer?.pairing ?? null,
        slotCost: cfg.recall?.conclusionLayer?.slotCost ?? null,
        arbitrate: cfg.recall?.conclusionLayer?.arbitrate ?? null,
        arbitrateThreshold: cfg.recall?.conclusionLayer?.arbitrateThreshold ?? null,
        requested: { budget: conclusionBudgetMode, routing: conclusionRouting, pairing: conclusionPairing, slotCost: conclusionSlotCost ?? null },
      },
      // #141 W2「关/软/硬」三格：失效排除总开关与效期模式是两处不同的键，必须分开记。
      validity: {
        excludeInvalidated: cfg.recall?.excludeInvalidated ?? null,
        mode: cfg.recall?.validity?.mode ?? null,
        requested: validityOffOverride ? "off" : validityModeOverride ? String(validityModeOverride.mode) : null,
      },
      // #135 第1项：最终生效召回配置原始快照（--expect-config 断言对象，也是归因表的事实来源）
      effectiveConfig,
      // 审计 M6：全量生效值（loadGatewayConfig 解析）+ 逐键来源 default|file|cli + 配置指纹。
      effective: effective.values,
      effectiveSources: effective.sources,
      effectiveFingerprint: effective.fingerprint,
      effectiveMeta: effective.meta,
      // 实验臂钉死的非缺省旋钮（值 + 代码缺省 + 来源），避免后人把实验值当生产值。
      experimentalKnobs,
      v3Recall: cfg.recall?.v3Recall?.enabled ?? false,
      k,
      recallKs: kList,
      answerModel: llmInfo?.model ?? null,
      judgeTemperature: 0,
      judgePromptVersion: PROMPT_VERSION,
      tag: String(strArg("tag", "")) || null,
      manifest: manifestUsed,
      rerankOverride: Object.keys(rerankOverride).length ? rerankOverride : null,
      answerPrompt: b1Mode
        ? ANSWER_PROMPT_VERSION
        : marshalPrompt
          ? ANSWER_PROMPT_MARSHAL_VERSION + (currencyPrompt ? "+currency" : "") + (prefPrompt ? "+pref" : "")
          : currencyPrompt && prefPrompt
            ? ANSWER_PROMPT_CURRENCY_VERSION + "+pref"
            : currencyPrompt
              ? ANSWER_PROMPT_CURRENCY_VERSION
              : prefPrompt
                ? ANSWER_PROMPT_PREF_VERSION
                : "prod-block-v2",
  rerankChildProc,
      rerankDocCap,
      rerankThreads,
      rerankFilterOnly,
      rerankFilterFloor: rerankFilterOnly ? rerankFilterFloor : null,
      ageDecayDays: ageDecayDays > 0 ? ageDecayDays : null,
      injectTimeSort,
      injectWrapper: injectWrapper ?? null,
      // #169：证据包档（null = 未指定，继承生产 yaml 的生效值）
      evidencePack: evidencePackOverride ?? null,
      validityFromCase: b2bValidity,
      mmrOverride: Object.keys(mmrOverride).length ? mmrOverride : null,
  fusion: fusionOverride ?? null,
      candidateK: candidateKOverride ?? null,
      // #146 诊断档：行预算放大与同 turn 折叠（只影响读侧聚合，写面不变）
      recallMaxResults: recallMaxResultsOverride?.maxResults ?? null,
      dedupeHitsByTurn: dedupeByTurn,
      // #146 诊断档 2：读侧父 turn 展开（注入载荷换回原文，命中集不变）
      expandParentTurn,
      // #137 事实键平行通道试验档（写侧选项 + 沙箱 yaml 读侧覆盖，与 fusion/candidateK 同位）
      factChannel: factChannel
        ? {
            ...factChannelOverride,
            readOnly: factChannelReadOnly,
            maxFacts: factChannelOpts?.maxFacts ?? factMaxFacts,
            separator: factChannelOpts?.separator ?? null,
            sandboxKey: "memory.recall.factChannel",
          }
        : null,
      presentTemporal: presentTemporalOverride ?? null,
      embThresholdOverride: embThresholdOverride !== undefined ? embThresholdOverride : null,
      judgeModel: llmInfo?.model ?? null,
      judgeHost: llmInfo?.baseUrlHost ?? null,
      apiKeySource: llmInfo?.apiKeySource ?? null,
      factExtraction: factExtract
        ? {
            promptVersion: FACTS_PROMPT_VERSION,
            model: factModel,
            dualWrite: factDualWrite,
            maxFactChars: factDualWrite ? factMaxChars : null,
            separator: factDualWrite ? (factSeparator ?? " | ") : null,
            supersede: writeSupersede,
            cardinalityGate: cardinalityGate !== false,
            cacheDir: factCacheDir,
            stats: factStats,
            tokens: tokenEvidence(factStats),
          }
        : null,
      conclusionCards: conclusionCards
        ? {
            promptVersion: CONCLUSIONS_PROMPT_VERSION,
            model: factModel,
            maxCards: conclusionMax,
            maxExtraLines: smallToBigMaxExtra,
            stats: conclusionStats,
            tokens: tokenEvidence(conclusionStats),
          }
        : null,
      ingest: ingestStats,
      storeDir: reuseMode ? storeDir : "(已清理/保留见运行日志)",
      // #139 评论 8：两套渲染路不可混读——blockChars 是生产 injector 输出（短、常只 1-2 行），
      // evidenceChars 是 b1 模式下喂给作答的证据块（hits 拼装、长）；分析注入预算请认准后者。
      fieldSemantics: {
        blockChars: "生产 injector 注入块长度（非 b1 作答口径）",
        evidenceChars: b1Mode ? "b1 证据块长度（作答与预算分析用这个）" : null,
        injectedLines: "b1 证据块行数",
      },
    },
    overall: agg.overall,
    perType: agg.perType,
    lineTypeTotals,
    // #169：证据包口径（adjacencyLines 与 turnCov/sessionCov 严格分离，勿混读）
    injectionAdjacency: epTotals,
    evidenceSufficiency: evidenceSufficiencySummary,
    rows,
  };

  fs.mkdirSync(outDir, { recursive: true });
  // 审计 M7：报告只追加、永不就地覆盖。
  // 病根：r141 五臂 2026-10-31 被同名重跑覆盖 ⇒ 判分行消失、cov 还在，20 张票的判定被卡住。
  // 命名 = <base>-<yyyymmdd-HHMMSS>-<配置指纹 sha8>.json；冲突再追加 -2/-3。
  // ---- 兼容：--report-name=<tag> 时额外写 <tag>.json 副本（arms 脚本按它定位），
  //      副本只指向本次结果，原件在带时间戳文件里，历史读数永远可追。
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const compact = stamp.replace(/-/g, "").replace("T", "-");
  const reportNameArg = strArg("report-name", undefined);
  if (typeof reportNameArg === "string" && /[\\/]/.test(reportNameArg)) {
    throw new Error("--report-name 只能是文件名，不能带路径分隔符");
  }
  const nameBase = typeof reportNameArg === "string" && reportNameArg ? reportNameArg : `bench-${ds.name}`;
  const fp = effective.fingerprint ?? "nofp";
  let stem = `${nameBase}-${compact}-${fp}`;
  for (let n = 2; fs.existsSync(path.join(outDir, stem + ".json")); n++) {
    stem = `${nameBase}-${compact}-${fp}-${n}`;
  }
  // M8：判分实况入报告（judged/total、覆盖率、判分器），下游无需重算即可拒绝 judged=0 的档。
  attachJudgingStatus(report);
  // #170：成本与延迟口径段（token / 检索 p50-p95 / 子阶段分段），与 overall 不重复覆盖。
  report.cost = buildCostSection(report.rows);
  const base = path.join(outDir, stem);
  fs.writeFileSync(base + ".json", JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(base + ".md", renderMarkdown(report), "utf8");
  if (typeof reportNameArg === "string" && reportNameArg) {
    fs.copyFileSync(base + ".json", path.join(outDir, reportNameArg + ".json"));
    fs.copyFileSync(base + ".md", path.join(outDir, reportNameArg + ".md"));
  }
  // latest 指针（目录级）：并行/重跑后按它找最近一次，而不是猜文件名。
  const latestPath = path.join(outDir, "latest.json");
  let prevLatest = null;
  try { prevLatest = JSON.parse(fs.readFileSync(latestPath, "utf8")); } catch { /* 首次运行无指针 */ }
  fs.writeFileSync(latestPath, JSON.stringify({
    generatedAt: report.generatedAt,
    report: path.basename(base) + ".json",
    tag: typeof reportNameArg === "string" && reportNameArg ? reportNameArg : null,
    fingerprint: fp,
    nameBase,
    previous: prevLatest?.report ?? null,
  }, null, 2) + "\n", "utf8");

  console.log(renderConsole(report));
  console.log(`\n[bench] 报告: ${base}.json / .md（latest.json 指向它）`);

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
  // 判分器必须出现在报告头部（#140）：判对率的可比性取决于「谁在判」。
  L.push(
    `- 判分器：\`${r.config.judgeModel ?? "（未记录）"}\`（提示版本 \`${r.config.judgePromptVersion ?? "-"}\`，端点 \`${r.config.judgeHost ?? "-"}\`）——与其他档配对前先核这两项：跨 judge 会被 bench-compare/gates/ranking 拒判（#140）`,
  );
  if (r.config.rejudgedFrom) {
    L.push(
      `- 判分器已重判：\`${r.config.rejudgedFrom.judgeModel ?? "（未记录）"}\` → 当前判分器（复用原答案，判对已重算；跨 judge 时先比对这一行）`,
    );
  }
  L.push(`- 数据文件：\`${r.dataset.file}\``);
  L.push(`- 题数 / 轮数：${r.dataset.cases} / ${r.dataset.turns}`, "");

  L.push("## 被测配置（生产同路）", "");
  L.push("| 项 | 值 |", "| --- | --- |");
  for (const [k2, v] of Object.entries(r.config)) {
    if (k2 === "ingest" || k2 === "rejudgedFrom") continue;
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