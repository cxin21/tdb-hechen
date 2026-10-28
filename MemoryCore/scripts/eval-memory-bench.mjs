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
  makeRecall,
  makeStoreDir,
  openBenchStore,
  prepareBenchYaml,
  reembedFactKeys,
  parseExpectConfig,
  repoRoot,
  withEmbedCache,
} from "./lib/bench/store.mjs";
import { readLlmCredential } from "./lib/read-llm-credential.ts";
import { aggregate, evalRetrieval, makeIdResolver, normHead, tokenF1 } from "./lib/bench/metrics.mjs";
import { FACTS_PROMPT_VERSION, factsCoverage, factsForCase } from "./lib/bench/facts.mjs";
import { CONCLUSIONS_PROMPT_VERSION } from "./lib/bench/conclusions.mjs";
import { createStageStats, fetchFactsAndConclusions, mergeStageStats, tokenEvidence } from "./lib/bench/stages.mjs";
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
/** 取值参数：裸 flag（后面紧跟 -- 或到底）必须显式失败，不能静默退化成默认路径。 */
function strArg(name, dflt) {
  const v = arg(name, dflt);
  if (v === true) {
    console.error(`[bench] --${name} 需要一个值（只给了裸 flag）；已中止，避免静默走默认路径白跑。`);
    process.exit(2);
  }
  return v;
}

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
  --conclusion-budget-mode M     #138 上下文行预算归属 shared|additive（缺省 shared=逐位现状）
  --conclusion-legacy-rank       #138 回滚证据排序（旧序=store 返回序）
  --k N                          检索口径 top-k（默认取生产配置 maxResults）
  --recall-ks 1,3,5,10           B0 多 k 切片（行内平铺 turnCov@k 等键；缺省 1,3,5,10）
  --manifest <path>              B0 抽样清单（caseId 顺序即运行序；配对比较必须同清单）
  --rerank-minscore X            B2-a 精排试验：改沙箱 yaml rerank.minScore（生产不动）
  --rerank-candidates N          B2-a 精排试验：改沙箱 yaml rerank.candidates（生产不动）
  --rerank-mode filter|rerank   #135 R4 精排试验：filter=floor 只滤不清排（保原序）；缺省 rerank
  --rerank-blend X              #137-F 精排试验：精排分与检索融合分的混合比例 α∈[0,1]（0=纯精排=旧行为）
  --rerank-timeout MS           精排超时（毫秒；本机 onnx 冷加载可能 >5s，冷启动档放宽到 30000）
  --rerank-filter-only [floor]  精排降级为过滤器（**必须同时加 --rerank-child-proc**，否则直接退出码 2）
  --rerank-off                   B2-a 精排对照：沙箱 yaml rerank.enabled=false
  --rerank-child-proc            精排子进程隔离（onnx 原生崩溃防护；--rerank-filter-only 依赖此路径）
  --b1                           B1 读侧四件套：时间戳打包证据 + CoN/JSON v3 提示 + NOT_ENOUGH_INFO 拒答出口（英文指令）
  --b2b-validity                 B2-b：召回 validityNow=题目日期（缺省=当前时刻，现状）
  --validity-mode soft|hard      #136 效期策略：soft=失效行降权保留（仅当下意图+有更新行才硬丢）
  --supersede-cardinality off    #136 对照档：关闭 cardinality 门（多值属性也失效=现状 W2）
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
  --report-name <name>           报告文件名（不含扩展名）；arms 脚本按 tag 定位报告时必传
  --quiet                        只打最终摘要
`);
  process.exit(0);
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
  const factExtract = flag("fact-extract") || factDualWrite || writeSupersede || factChannel;
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
  const validityOverride = validityModeArg === "soft" || validityModeArg === "hard" ? { mode: validityModeArg } : undefined;
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
  const conclusionBudgetMode = String(arg("conclusion-budget-mode", "shared")) === "additive" ? "additive" : "shared";
  const conclusionLegacyRank = flag("conclusion-legacy-rank");
  // #138：结论层查询路由（assistantRecall = 回忆 assistant 输出的查询跳过结论层）
  const conclusionRouting = String(arg("conclusion-routing", "off")) === "assistant-recall" ? "assistantRecall" : "off";
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
  // 精排超时（毫秒；0=不限）——本机 onnx 冷加载可能 >5s，冷启动档需要放宽
  const rtimeout = arg("rerank-timeout", undefined);
  if (rtimeout !== undefined && rtimeout !== true && Number.isFinite(Number(rtimeout))) {
    rerankOverride.timeoutMs = Math.max(0, Number(rtimeout));
  }
  // #137-F：精排 × 融合相关度混合比例 α（0=纯精排=旧行为；1=纯融合序）
  const rblend = arg("rerank-blend", undefined);
  if (rblend !== undefined && rblend !== true && Number.isFinite(Number(rblend))) {
    rerankOverride.blend = Math.min(1, Math.max(0, Number(rblend)));
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
  const injectWrapperRaw = String(arg("inject-wrapper", "legacy"));
  const injectWrapper = injectWrapperRaw === "neutral" ? "neutral" : "legacy";
  const injectOverride = {};
  if (injectTimeSort) injectOverride.timeSort = { enabled: true };
  if (injectWrapper !== "legacy") injectOverride.wrapper = injectWrapper;
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

  prepareBenchYaml({
    srcYaml: prodConfig,
    storeDir,
    ...(Object.keys(rerankOverride).length ? { rerankOverride } : {}),
    ...(Object.keys(mmrOverride).length ? { mmrOverride } : {}),
  ...(fusionOverride ? { fusionOverride } : {}),
  ...(candidateKOverride !== undefined ? { candidateKOverride } : {}),
  ...(presentTemporalOverride ? { presentTemporalOverride } : {}),
    ...(validityOverride ? { validityOverride } : {}),
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
    ...(conclusionLayerOff || conclusionCap !== undefined || conclusionRouting !== "off"
      ? {
          conclusionLayerOverride: {
            ...(conclusionLayerOff ? { enabled: false } : {}),
            ...(!conclusionLayerOff && conclusionCap !== undefined ? { maxConclusions: conclusionCap } : {}),
            ...(!conclusionLayerOff && conclusionRouting !== "off" ? { routing: conclusionRouting } : {}),
          },
        }
      : {}),
    ...(factChannelOverride ? { factChannelOverride } : {}),
  });
  if (Object.keys(injectOverride).length) log("[bench] G1 注入试验档(仅沙箱 yaml): " + JSON.stringify(injectOverride));
  if (conclusionCards) log("[bench] W3 写入面试验档(仅沙箱 yaml): 蒸馏 + part_of 证据链落库");
  if (conclusionLayerOff) log("[bench] 结论层整体关闭（--conclusion-layer-off）：无卡基线档");
  if (conclusionCap !== undefined || conclusionRouting !== "off") log("[bench] 结论层读侧试验档(仅沙箱 yaml): " + JSON.stringify({ ...(conclusionCap !== undefined ? { maxConclusions: conclusionCap } : {}), routing: conclusionRouting }));
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
  const { store, embedding, dims, init } = await openBenchStore(cfg, storeDir);
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
    if (factExtract) log(`[bench] 事实抽取: model=${factModel} cache=${factCacheDir} dualWrite=${factDualWrite} supersede=${writeSupersede}`);
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
  const embedForRecall = withEmbedCache(embedding, flag("no-embed-cache") ? null : embedCacheDir, `${cfg.embedding?.model ?? "emb"}-${dims}`);
  const recall = makeRecall({ cfg, store, embedding: embedForRecall, dataDir: storeDir, validityFromCase: b2bValidity, rerankChildProc, rerankFilterOnly, rerankFilterFloor });
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
    // #139 评论 8：block 与 evidence 是两条渲染路，报告里分别落长度，避免分析时混读。
    const evidenceBlock = b1Mode ? buildEvidenceBlock(r.hits) : null;
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
      ...(b1Mode ? { evidence: evidenceBlock, evidenceChars: evidenceBlock.length } : {}),
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
      // #135 第1项：报告必须记 enabled（只记 provider 会掩盖"沙箱写 false、生产 override 覆盖成 true"）
      rerankEnabled: cfg.recall?.rerank?.enabled === true,
      // #139 第5项：读侧 smallToBig 与写侧 conclusionCards 分开归因
      smallToBig: {
        enabled: cfg.recall?.smallToBig?.enabled === true,
        maxExtraLines: cfg.recall?.smallToBig?.maxExtraLines ?? null,
        budget: cfg.recall?.smallToBig?.budget ?? null,
        relevanceRanked: cfg.recall?.smallToBig?.relevanceRanked ?? null,
        // 'on' / 'off' / null：null = 没指定，继承生产 yaml 的生效值（旧布尔分不清这两者）。
        requested: smallToBigEnabled ? "on" : smallToBigOff ? "off" : null,
      },
      // #135 第1项：最终生效召回配置原始快照（--expect-config 断言对象，也是归因表的事实来源）
      effectiveConfig,
      v3Recall: cfg.recall?.v3Recall?.enabled ?? false,
      k,
      recallKs: kList,
      answerModel: llmInfo?.model ?? null,
      judgeTemperature: 0,
      judgePromptVersion: PROMPT_VERSION,
      tag: String(strArg("tag", "")) || null,
      manifest: manifestUsed,
      rerankOverride: Object.keys(rerankOverride).length ? rerankOverride : null,
      answerPrompt: b1Mode ? ANSWER_PROMPT_VERSION : "prod-block-v2",
  rerankChildProc,
      rerankDocCap,
      rerankThreads,
      rerankFilterOnly,
      rerankFilterFloor: rerankFilterOnly ? rerankFilterFloor : null,
      ageDecayDays: ageDecayDays > 0 ? ageDecayDays : null,
      injectTimeSort,
      injectWrapper,
      validityFromCase: b2bValidity,
      mmrOverride: Object.keys(mmrOverride).length ? mmrOverride : null,
  fusion: fusionOverride ?? null,
      candidateK: candidateKOverride ?? null,
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
    rows,
  };

  fs.mkdirSync(outDir, { recursive: true });
  // #139：报告名可钉死（--report-name）——arms 脚本按 tag 定位报告，用「全局最新」在并行跑时会串味。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportNameArg = strArg("report-name", undefined);
  const reportName = typeof reportNameArg === "string" && reportNameArg ? reportNameArg : `${ds.name}-${stamp}`;
  if (/[\\/]/.test(reportName)) throw new Error("--report-name 只能是文件名，不能带路径分隔符");
  const base = path.join(outDir, reportName);
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
  // 判分器必须出现在报告头部（#140）：判对率的可比性取决于「谁在判」。
  L.push(
    `- 判分器：\`${r.config.judgeModel ?? "（未记录）"}\`（提示版本 \`${r.config.judgePromptVersion ?? "-"}\`，端点 \`${r.config.judgeHost ?? "-"}\`）`,
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