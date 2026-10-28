/**
 * 基准 harness 的「生产同路」桥接层。
 *
 * 纪律（对齐 scripts/audit/*.mjs、scripts/lib/recall-precision-eval.mjs）：
 * - 配置只读不写：loadGatewayConfig() 读 tdai-gateway.yaml + <dataDir>/config-override.json，
 *   与网关启动时同一套解析（env > override > yaml 的优先级也在里面）。本模块只把
 *   TDAI_GATEWAY_CONFIG / TDAI_DATA_DIR 指向基准沙箱，绝不碰生产 dataDir。
 * - 存储与召回都走产品实现：createStoreBundle → store.init → store.upsertL1 写；
 *   performLayeredRecall 读（与 `/v3/recall` 端点字面同一函数）。
 * - 不引入第二套打分：检索层零重实现，只消费产出。
 *
 * 由 tsx 执行 .mjs 以便直接 import 仓库 .ts 模块（见 package.json 的 audit 脚本先例）。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { cacheFileOf, readCache, writeCache } from "./cache.mjs";
import { normHead } from "./metrics.mjs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromRepo = createRequire(import.meta.url);

// ── 配置 ────────────────────────────────────────────────────────────────────

/** 定位仓库 MemoryCore 根（本文件位于 scripts/lib/bench/）。 */
export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

/**
 * 生成基准用 yaml：以生产 yaml 为底，只改 data.baseDir / server，并关掉会污染
 * 计时与成本的旁路（capture 提取、生命周期、进化），显式开 v3Recall。
 * 返回写好的沙箱 yaml 路径。
 */
export function prepareBenchYaml({ srcYaml, storeDir, rerankOverride, mmrOverride, embThresholdOverride, ageDecayOverride, injectOverride, smallToBigOverride, conclusionLayerOverride, fusionOverride, candidateKOverride, presentTemporalOverride, validityOverride, supersessionOverride, factChannelOverride }) {
  const YAML = require_yaml();
  const raw = YAML.parse(fs.readFileSync(srcYaml, "utf8")) || {};
  const out = JSON.parse(JSON.stringify(raw));
  out.data = { ...(out.data || {}), baseDir: storeDir };
  out.server = { ...(out.server || {}), port: 0, host: "127.0.0.1" };
  out.memory = out.memory && typeof out.memory === "object" && !Array.isArray(out.memory)
    ? { ...out.memory }
    : {};
  const m = out.memory;
  // 基准期关断写侧旁路：只保留「写 L1 + 召回」这条待测路径。
  for (const k of ["capture", "extraction", "extractionExtensions", "lifecycle", "evolution"]) {
    if (m[k] && typeof m[k] === "object") m[k] = { ...m[k], enabled: false };
  }
  m.recallJournal = { ...(m.recallJournal || {}), enabled: false };
  // 基准期关断 query-expansion：bench 进程内 qe LLM 外呼恒超时（clamp 后 ~29s/题黑洞，
  // 2026-10-27 冒烟实测 p50=29.2s）；超时路径本就退化为无扩展词，关断后各档检索语义
  // 一致、延迟口径干净（偏差说明记录）。无条件写键——yaml 缺省时 config 默认 enabled。
  m.recall.queryExpansion = { ...(m.recall.queryExpansion || {}), enabled: false };
  m.recall = { ...(m.recall || {}) };
  // v3 召回是本基准的被测面，必须显式开（yaml 缺省不开）。
  m.recall.v3Recall = { ...(m.recall.v3Recall || {}), enabled: true };
  // B2-a（bench/recall-opt）：精排试验档只写沙箱 yaml（生产 yaml 定档后才动——用户决策②）。
  if (rerankOverride && typeof rerankOverride === "object" && Object.keys(rerankOverride).length) {
    m.recall.rerank = { ...(m.recall.rerank || {}), ...rerankOverride };
  }
  // B2-b（bench/recall-opt）：MMR 多样性重排试验档，同样只写沙箱 yaml。
  if (mmrOverride && typeof mmrOverride === "object" && Object.keys(mmrOverride).length) {
    m.recall.mmr = { ...(m.recall.mmr || {}), ...mmrOverride };
  }
  // B2-b：向量余弦门槛试验值（native hybrid 路疑形同虚设，A/B 用数据验证）。
  if (embThresholdOverride !== undefined && Number.isFinite(embThresholdOverride)) {
    m.recall.scoreThreshold = embThresholdOverride;
  }
  // 架构验证（bench/recall-opt）：F6b 时间衰减进排序（config 已有管道，缺省关）。
  if (ageDecayOverride && typeof ageDecayOverride === "object" && Object.keys(ageDecayOverride).length) {
    m.recall.ageDecay = { ...(m.recall.ageDecay || {}), ...ageDecayOverride };
  }
  // G1（bench/recall-opt）：注入块时间序 + 包裹语试验档。
  if (injectOverride && typeof injectOverride === "object" && Object.keys(injectOverride).length) {
    m.recall.injectTimeSort = { ...(m.recall.injectTimeSort || {}), ...(injectOverride.timeSort ?? {}) };
    if (injectOverride.wrapper) m.recall.injectWrapper = injectOverride.wrapper;
  }
  // W3（issue #134）：结论卡证据回捞（#78 R-b smallToBig）——实验档只写沙箱 yaml。
  if (smallToBigOverride && typeof smallToBigOverride === "object" && Object.keys(smallToBigOverride).length) {
    m.recall.smallToBig = { ...(m.recall.smallToBig || {}), ...smallToBigOverride };
  }
  // #138（2026-10-28）：结论层试验档（conclusionLayer.maxConclusions 等）——只写沙箱 yaml。
  if (conclusionLayerOverride && typeof conclusionLayerOverride === "object" && Object.keys(conclusionLayerOverride).length) {
    m.recall.conclusionLayer = { ...(m.recall.conclusionLayer || {}), ...conclusionLayerOverride };
  }
  // #135 R2/E1（bench/recall-opt）：加权融合试验档（recall.fusion）——只写沙箱 yaml。
  if (fusionOverride && typeof fusionOverride === "object" && Object.keys(fusionOverride).length) {
    m.recall.fusion = { ...(m.recall.fusion || {}), ...fusionOverride };
  }
  // #135 R1 全开档：候选池上游上限（recall.candidateK）。
  if (candidateKOverride !== undefined && Number.isFinite(candidateKOverride) && candidateKOverride >= 1) {
    m.recall.candidateK = Math.floor(candidateKOverride);
  }
  // #135 R3 全开档：查询时间感知（recall.presentTemporal，enabled true）。
  if (presentTemporalOverride && typeof presentTemporalOverride === "object") {
    m.recall.presentTemporal = { ...(m.recall.presentTemporal || {}), ...presentTemporalOverride };
  }
  // #136 双时态属性契约：读侧效期策略（recall.validity.mode hard|soft）与写侧
  // cardinality 门（memory.write.supersession.cardinalityGate）——只写沙箱 yaml。
  if (validityOverride && typeof validityOverride === "object" && Object.keys(validityOverride).length) {
    m.recall.validity = { ...(m.recall.validity || {}), ...validityOverride };
  }
  if (supersessionOverride && typeof supersessionOverride === "object" && Object.keys(supersessionOverride).length) {
    m.write = m.write && typeof m.write === "object" ? { ...m.write } : {};
    m.write.supersession = { ...(m.write.supersession || {}), ...supersessionOverride };
  }
  // #137 W1/C（bench）：事实键平行通道——recall.factChannel（生产 config.ts 同名字段；
  // 缺省 yaml 无此键 = 通道关，逐位现状）。只写沙箱 yaml，生产配置不动。
  if (factChannelOverride && typeof factChannelOverride === "object" && Object.keys(factChannelOverride).length) {
    m.recall.factChannel = { ...(m.recall.factChannel || {}), ...factChannelOverride };
  }
  const file = path.join(storeDir, "bench-gateway.yaml");
  fs.writeFileSync(file, YAML.stringify(out), "utf8");
  return file;
}

let _yaml;
function require_yaml() {
  if (!_yaml) _yaml = requireFromRepo("yaml");
  return _yaml;
}

/**
 * 载入基准配置（MemoryTdaiConfig）。yaml 与 override 都从沙箱 storeDir 读，
 * 因此调用前需把生产 config-override.json（含 llm/embedding 凭据）复制进 storeDir。
 */
export async function loadBenchConfig(storeDir) {
  const prevCfg = process.env.TDAI_GATEWAY_CONFIG;
  const prevData = process.env.TDAI_DATA_DIR;
  const yamlPath = path.join(storeDir, "bench-gateway.yaml");
  if (!fs.existsSync(yamlPath)) throw new Error("缺少 bench yaml: " + yamlPath);
  process.env.TDAI_GATEWAY_CONFIG = yamlPath;
  process.env.TDAI_DATA_DIR = storeDir;
  try {
    const { loadGatewayConfig } = await import("../../../src/gateway/config.ts");
    const gw = loadGatewayConfig();
    return { cfg: gw.memory, gw, dataDir: storeDir };
  } finally {
    if (prevCfg === undefined) delete process.env.TDAI_GATEWAY_CONFIG;
    else process.env.TDAI_GATEWAY_CONFIG = prevCfg;
    if (prevData === undefined) delete process.env.TDAI_DATA_DIR;
    else process.env.TDAI_DATA_DIR = prevData;
  }
}

/** 把生产 dataDir 的 config-override.json 复制进沙箱（缺失则跳过）。 */
export function copyOverrideFrom(prodDataDir, storeDir) {
  const src = path.join(prodDataDir, "config-override.json");
  const dst = path.join(storeDir, "config-override.json");
  if (!fs.existsSync(src)) return null;
  fs.copyFileSync(src, dst);
  return dst;
}

// ── 存储 ────────────────────────────────────────────────────────────────────

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: (m) => console.warn("[bench:warn]", m),
  error: (m) => console.error("[bench:error]", m),
};

/**
 * 带退避的 embedding 外呼。
 * 实测坑（2026-10-26）：豆包 embedding 账号级限流会直接 429（AccountRateLimitExceeded），
 * 原来的"批失败 → 逐条再试 → 再失败就放弃"会静默丢掉大量向量（419 条只写进 97 条），
 * 召回退化成纯 BM25/FTS 而不自知。改为指数退避重试，并让调用方统计重试次数。
 */
// 全局限速闸：豆包 embedding 是账号级 RPM 限制（实测 input 上限 8 条/请求，>8 直接 400），
// 并发 + 重试风暴会把配额打穿到 429 长时间不恢复。统一在模块级串行 + 最小间隔。
let _lastEmbedAt = 0;
async function paceGate(minIntervalMs) {
  const wait = _lastEmbedAt + minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastEmbedAt = Date.now();
}

export async function embedWithRetry(embedding, texts, opts = {}) {
  const tries = opts.tries ?? 5;
  const baseMs = opts.baseMs ?? 1200;
  const minIntervalMs = opts.minIntervalMs ?? 400;
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      await paceGate(minIntervalMs);
      return await embedding.embedBatch(texts);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      const retriable = /429|rate.?limit|too many|timeout|ETIMEDOUT|ECONNRESET|socket hang up|5dd/i.test(msg);
      if (!retriable || attempt === tries - 1) throw e;
      opts.onRetry?.(attempt + 1, msg);
      await new Promise((r) => setTimeout(r, Math.round(baseMs * 2 ** attempt * (1 + Math.random() * 0.3))));
    }
  }
  throw lastErr;
}

/** 打开基准库：createStoreBundle + init。返回 {store, embedding, dims}。 */
export async function openBenchStore(cfg, dataDir, logger = silentLogger) {
  const { createStoreBundle } = await import("../../../src/core/store/factory.ts");
  const bundle = createStoreBundle(cfg, { dataDir, logger });
  const embedding = bundle.embedding;
  const dims = typeof embedding?.getDimensions === "function" ? embedding.getDimensions() : 0;
  const providerInfo = dims > 0 ? embedding.getProviderInfo() : undefined;
  const init = bundle.store.init(providerInfo);
  return { store: bundle.store, embedding, dims, init, bm25: bundle.bm25Encoder };
}

/** 一条 turn → L1 MemoryRecord（type=episodic，带活动时间与来源 session）。 */
export function turnToRecord(caseObj, turn, sessionId = "s") {
  const t = turn.tsISO || caseObj.questionDateISO || "";
  const content = turnContent(caseObj, turn);
  return {
    id: turn.id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "bench",
    source_message_ids: [],
    metadata: t ? { activity_start_time: t, activity_end_time: t } : {},
    timestamps: t ? [t] : [],
    createdAt: t || "1970-01-01T00:00:00Z",
    updatedAt: t || "1970-01-01T00:00:00Z",
    version: 1,
    sessionKey: `${caseObj.tenant.user_id}::${sessionId}`,
    sessionId,
    teamId: caseObj.tenant.team_id,
    userId: caseObj.tenant.user_id,
    agentId: caseObj.tenant.agent_id,
    occurred_at: t || undefined,
    // 双时态起点（W2）：valid_start = 该轮发生时刻；valid_end 由写时 supersession 补。
    valid_start: t || "",
    certainty: "observed",
    source: "bench-ingest",
  };
}

/** turn 的落库文本：时间前缀 + 说话人 + 原文（时间前缀同时承担活动时间语义）。 */
export function turnContent(caseObj, turn) {
  const t = turn.tsISO || caseObj.questionDateISO || "";
  return t
    ? `[${t.replace("T", " ")}] ${turn.speaker}: ${turn.text}`
    : `${turn.speaker}: ${turn.text}`;
}

/**
 * 批量取向量：分块 + 限并发 + 退避重试（批上限因模型而异：整批失败再逐条重试）。
 * 返回 { vectors, failed, retries }；vectors 与 texts 逐位对齐（失败位 undefined）。
 * 主通道与事实通道共用这一实现——批次/并发/pacing 语义必须一致，否则两档不可比。
 */
async function embedTexts({ embedding, texts, chunkSize = 8, concurrency = 1, embedMinIntervalMs = 400, onRetry }) {
  const batches = [];
  for (let i = 0; i < texts.length; i += chunkSize) batches.push({ start: i, texts: texts.slice(i, i + chunkSize) });
  const vectors = new Array(texts.length).fill(undefined);
  let failed = 0;
  let retries = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, async () => {
    for (;;) {
      const bi = cursor++;
      if (bi >= batches.length) return;
      const b = batches[bi];
      if (!embedding || typeof embedding.embedBatch !== "function") continue;
      try {
        const vs = await embedWithRetry(embedding, b.texts, {
          minIntervalMs: embedMinIntervalMs,
          onRetry: (n) => { retries++; onRetry?.(n); },
        });
        for (let k = 0; k < vs.length; k++) vectors[b.start + k] = vs[k];
      } catch {
        // 批上限因模型而异：整批失败再逐条退避重试
        for (let k = 0; k < b.texts.length; k++) {
          try {
            const one = await embedWithRetry(embedding, [b.texts[k]], { tries: 4, minIntervalMs: embedMinIntervalMs, onRetry: () => { retries++; onRetry?.(); } });
            vectors[b.start + k] = one[0];
          } catch {
            failed++;
          }
        }
      }
    }
  });
  await Promise.all(workers);
  return { vectors, failed, retries };
}

// ── #137 W1/C 事实键平行通道 ─────────────────────────────────────────────────
/**
 * 载入 buildFactChannelKey（契约见 src/core/record/fact-key.ts，#137）。
 * 契约未合并时给出可诊断的错误，而不是把 TypeError 埋在灌库中途。
 */
async function loadFactChannelKeyBuilder() {
  const mod = await import("../../../src/core/record/fact-key.ts");
  if (typeof mod.buildFactChannelKey !== "function") {
    throw new Error("src/core/record/fact-key.ts 缺少 buildFactChannelKey（#137 契约未合并？）——无法启用 --fact-channel");
  }
  return mod.buildFactChannelKey;
}

/** factChannel 选项 → buildFactChannelKey opts（只传显式给出的键，其余用 src 缺省）。 */
function factChannelKeyOptions(factChannel) {
  const opts = {};
  if (typeof factChannel?.separator === "string" && factChannel.separator) opts.separator = factChannel.separator;
  if (typeof factChannel?.maxFactChars === "number") opts.maxFactChars = factChannel.maxFactChars;
  if (typeof factChannel?.maxFacts === "number") opts.maxFacts = factChannel.maxFacts;
  return opts;
}

/**
 * 通道向量逐条落库（store 缺该方法 = 静默跳过并计数，绝不抛）。
 * 返回 true 表示已写入。
 */
async function writeFactChannelVector(writeFn, stats, record, vec) {
  try {
    const wrote = await writeFn(record.id, vec, record.updatedAt);
    if (wrote === false) {
      stats.factChannelWriteFailed++;
      return false;
    }
    stats.factChannelEmbedded++;
    return true;
  } catch {
    stats.factChannelWriteFailed++;
    return false;
  }
}

/**
 * 写入策略参数簇（#139 第6项）。
 *
 * 历史：ingestCase 12 个位置参数、四个开关互相依赖（dualWrite/factChannel 需要 facts、
 * supersede 需要 facts.triples、conclusions 需要 cards），漏传一个就静默退化成控制档——
 * 一档白跑的代价是 90 题 × 数十分钟。这里把依赖集中校验：该报错就报错。
 *
 * @param {object} [input] {dualWrite, factChannel, supersede, cardinalityGate, conclusions}
 * @param {{facts?:object, conclusions?:object}} [ctx] 供依赖校验的实际数据
 * @returns {{dualWrite:object|null, factChannel:object|null, supersede:boolean, cardinalityGate:boolean, conclusions:object|null}}
 */
export function normalizeWritePolicy(input = {}, ctx = {}) {
  const src = input && typeof input === "object" ? input : {};
  const { facts, conclusions } = ctx;

  // dualWrite: true | {separator?, maxFactChars?, enabled?} | null
  let dualWrite = null;
  if (src.dualWrite === true) dualWrite = { enabled: true };
  else if (src.dualWrite && typeof src.dualWrite === "object" && src.dualWrite.enabled !== false) dualWrite = { enabled: true, ...src.dualWrite };

  // factChannel: true | {separator?, maxFacts?, enabled?} | null
  let factChannel = null;
  if (src.factChannel === true) factChannel = { enabled: true };
  else if (src.factChannel && typeof src.factChannel === "object" && src.factChannel.enabled !== false) {
    factChannel = { enabled: true, ...src.factChannel };
  }

  const supersede = src.supersede === true;
  // cardinalityGate 缺省开（#136 契约）；显式 false 才关。
  const cardinalityGate = src.cardinalityGate !== false;
  const concl = src.conclusions && Array.isArray(src.conclusions.cards) ? src.conclusions : conclusions && Array.isArray(conclusions.cards) ? conclusions : null;

  if ((dualWrite || factChannel || supersede) && !facts?.byTurn) {
    throw new Error("writePolicy: dualWrite/factChannel/supersede 都需要 facts（先跑 --fact-extract；缓存命中也可）");
  }
  if (concl && concl.cards.length === 0) {
    // 0 卡不是错误（软失败可达），但需要调用方知道本档没有写入面。
    return { dualWrite, factChannel, supersede, cardinalityGate, conclusions: concl, emptyConclusions: true };
  }
  return { dualWrite, factChannel, supersede, cardinalityGate, conclusions: concl, emptyConclusions: false };
}

/**
 * 批量写入一个 case 的全部 turn（含 embedding）+ 回填 content→turnId 映射。
 * 并发受限（embedding 服务多为单批小上限），失败对半降级重试。
 *
 * W1（issue #134）：facts/dualWrite 传入时，embedding 键文本 = turn 原文 + 事实短语拼接；
 * 落库 content 不变（原文仍是命中载荷）。缺省（未传）→ 逐位现状。
 *
 * W1/C（#137）：facts/factChannel 传入时，另算「事实短语键」文本（不含原文）→ 单独 embed
 * → store.upsertL1FactVector 写平行向量表（l1_vec 主索引完全不动）。与 dualWrite 可同时开：
 * 两者键文本不同、目标表不同，互不干扰。store 无该方法（tcvdb 等）→ 静默跳过并计数。
 */
export async function ingestCase({ caseObj, store, embedding, contentIndex, opts = {} }) {
  const { chunkSize = 8, concurrency = 1, onRetry, embedMinIntervalMs = 400, facts, conclusions } = opts;
  // #139 第6项：12 个散参收敛为 opts.writePolicy，依赖关系在这一处集中校验（漏配即报错，
  // 不再静默降级成"控制档"——历史上有过 --fact-channel 没开 dualWrite 却以为开着的档）。
  const policy = normalizeWritePolicy(opts.writePolicy, { facts, conclusions });
  const dualWrite = policy.dualWrite;
  const factChannel = policy.factChannel;
  const records = [];
  for (const g of caseObj.groups) for (const t of g.turns) records.push({ turn: t, sessionId: g.sessionId });

  const stats = { turns: records.length, embedded: 0, embedFailed: 0, written: 0, embedRetries: 0 };

  const payloadTexts = records.map(({ turn }) => turnContent(caseObj, turn));
  // W1：键文本（缺省 = 载荷文本，逐位现状）。事实按 turn id 对齐；无事实的 turn 键=原文。
  let texts = payloadTexts;
  if (dualWrite?.enabled) {
    const { buildEmbeddingKey } = await import("../../../src/core/record/fact-key.ts");
    let factTurns = 0;
    let factChars = 0;
    texts = records.map(({ turn }, i) => {
      const phrases = facts?.byTurn?.[turn.id]?.phrases ?? [];
      if (phrases.length) factTurns++;
      const key = buildEmbeddingKey(payloadTexts[i], phrases, {
        ...(dualWrite.separator ? { separator: dualWrite.separator } : {}),
        ...(typeof dualWrite.maxFactChars === "number" ? { maxFactChars: dualWrite.maxFactChars } : {}),
      });
      factChars += key.length - payloadTexts[i].length;
      return key;
    });
    stats.factKeys = records.length;
    stats.factTurns = factTurns;
    stats.factKeyCharsAdded = factChars;
  }

  // #137 W1/C：事实键平行通道——先算键文本（无事实 → ""，不外呼），再按「有键文本」的下标批量 embed。
  // 键文本 = 事实短语（不含原文），与 dualWrite 的「原文 + 事实」是两条独立通道。
  let channel = null;
  let writeFactVector = null;
  if (factChannel?.enabled) {
    const buildFactChannelKey = await loadFactChannelKeyBuilder();
    const keyOpts = factChannelKeyOptions(factChannel);
    const keys = records.map(({ turn }) => buildFactChannelKey(facts?.byTurn?.[turn.id]?.phrases, keyOpts));
    stats.factChannelTurns = 0;
    stats.factChannelEmbedded = 0;
    stats.factChannelEmbedFailed = 0;
    stats.factChannelWriteFailed = 0;
    stats.factChannelRetries = 0;
    stats.factChannelKeyChars = keys.reduce((n, k) => n + k.length, 0);
    channel = new Array(keys.length).fill(undefined);
    const idx = [];
    for (let i = 0; i < keys.length; i++) if (keys[i]) idx.push(i);
    stats.factChannelTurns = idx.length;
    writeFactVector = typeof store.upsertL1FactVector === "function" ? store.upsertL1FactVector.bind(store) : null;
    if (!writeFactVector) {
      // 契约：缺失时静默跳过（tcvdb 等后端没有该表）。计数可见，避免试验档静默等同控制档。
      stats.factChannelUnsupported = true;
      console.warn("[bench:warn] store 无 upsertL1FactVector（#137 契约未落地/后端不支持）：事实通道静默关闭");
    } else if (idx.length && embedding) {
      const sub = await embedTexts({ embedding, texts: idx.map((i) => keys[i]), chunkSize, concurrency, embedMinIntervalMs, onRetry });
      stats.factChannelEmbedFailed += sub.failed;
      stats.factChannelRetries += sub.retries;
      idx.forEach((ri, k) => { channel[ri] = sub.vectors[k]; });
    }
  }

  // 分批 + 限并发取向量（与事实通道同一实现）
  const main = await embedTexts({ embedding, texts, chunkSize, concurrency, embedMinIntervalMs, onRetry });
  const vectors = main.vectors;
  stats.embedFailed += main.failed;
  stats.embedRetries += main.retries;
  stats.embedded = vectors.filter(Boolean).length;

  for (let i = 0; i < records.length; i++) {
    const { turn, sessionId } = records[i];
    const record = turnToRecord(caseObj, turn, sessionId);
    contentIndex.set(normHead(record.content), turn.id);
    const ok = store.upsertL1(record, vectors[i]);
    if (ok !== false) stats.written++;
    // #137：通道向量逐条写入（有键文本且成向量才写；写失败只计数，不拖垮主写入）
    const vec = channel ? channel[i] : undefined;
    if (writeFactVector && vec && vec.length) await writeFactChannelVector(writeFactVector, stats, record, vec);
  }

  // W2/W3 写入面（issue #134）：失效标记 + 结论卡——与 --store 分阶段写入共用同一实现（零重复）。
  Object.assign(
    stats,
    await applyWriteSteps({
      caseObj,
      store,
      records,
      facts,
      supersede: policy.supersede,
      cardinalityGate: policy.cardinalityGate,
      conclusions: policy.conclusions,
    }),
  );
  return stats;
}

// ── 召回 ────────────────────────────────────────────────────────────────────

/**
 * 构造召回函数：per case 传三元组隔离（team/user/agent），与 /v3/recall 端点同形。
 * 返回 async (query, caseObj) => { hits:[{id,content,score}], block, latencyMs, debug }
 */
export function makeRecall({ cfg, store, embedding, dataDir, logger = silentLogger, validityFromCase, rerankChildProc, rerankFilterOnly, rerankFilterFloor }) {
  let fn;
  let childReranker;
  return async function recall(query, caseObj) {
    if (!fn) fn = (await import("../../../src/core/hooks/auto-recall.ts")).performLayeredRecall;
    const t0 = performance.now();
    const outcome = await fn({
      userText: query,
      sessionKey: `${caseObj.tenant.user_id}::${caseObj.tenant.team_id}::${caseObj.tenant.agent_id}`,
      cfg,
      pluginDataDir: dataDir,
      logger,
      vectorStore: store,
      embeddingService: embedding,
      storage: undefined,
      profileIsolation: { teamId: caseObj.tenant.team_id, agentId: caseObj.tenant.agent_id },
      isolationFilter: {
        teamId: caseObj.tenant.team_id,
        userId: caseObj.tenant.user_id,
        agentId: caseObj.tenant.agent_id,
      },
      // B2-b：validityNow=题目日期（D6——拿 2026 视角看 2023 会触发不该触发的双时态失效排除）
      validityNow:
        validityFromCase && caseObj?.questionDateISO ? new Date(caseObj.questionDateISO) : new Date(),
      // 精排走配置（生产同款）。--rerank-child-proc：子进程隔离注入（onnx 原生崩溃防护，
      // 见 rerank-child-host.mjs 头注）；模型与打分同款，仅传输层不同。
      rerankDeps:
        rerankChildProc && cfg?.recall?.rerank?.enabled && cfg?.recall?.rerank?.provider === "local"
          ? {
              reranker: (childReranker ??= await (async () => {
                const { resolveLocalModelDir } = await import("../../../src/core/recall/rerank/factory.ts");
                const { ChildProcessReranker } = await import("./rerank-child-host.mjs");
                return new ChildProcessReranker({
                  modelDir: resolveLocalModelDir(cfg.recall.rerank),
                  idleUnloadMs: cfg.recall?.rerank?.local?.idleUnloadMs ?? 0,
                  timeoutMs: 180_000,
                  recycleAfter: 4,
                  logger: console,
                  filterOnly: rerankFilterOnly === true,
                  filterFloor: Number.isFinite(rerankFilterFloor) ? rerankFilterFloor : -1e9,
                });
              })()),
            }
          : undefined,
    });
    const latencyMs = performance.now() - t0;
    // 召回行是「渲染后文本」：带 [type|scene] 前言与 ·soul[...] / ·(活动时间:…) 尾注。
    // 用生产同一个 stripMemoryLineMeta 剥掉系统标注，才能与落库原文精确对齐证据 turn。
    const { stripMemoryLineMeta } = await import("../../../src/core/hooks/memory-line-meta.ts");
    const clean = (t) => stripMemoryLineMeta(String(t ?? "")).replace(/^-\s+/, "").trim();
    return {
      hits: (outcome.recalledL1Memories || []).map((m) => ({
        content: m.content,
        clean: clean(m.content),
        score: m.score,
        type: m.type,
      })),
      block: outcome.block || "",
      latencyMs,
      strategy: outcome.effectiveStrategy,
      // B0 校尺（bench/recall-opt）：检索计时与门观测透传进行数据
      searchTiming: outcome.searchTiming,
      ...(outcome.gates ? { gates: outcome.gates } : {}),
      perfMs: outcome.perfMs,
      layered: outcome.layered,
      conclusionCount: outcome.conclusionCount,
      experienceCount: outcome.experienceCount,
    };
  };
}

/** 沙箱目录：默认放系统临时目录，避免污染仓库与生产 dataDir。 */
export function makeStoreDir(datasetName, reuse) {
  if (reuse) {
    if (!fs.existsSync(reuse)) throw new Error("--store 指定的目录不存在: " + reuse);
    return reuse;
  }
  const base = path.join(os.tmpdir(), "tdagemem-bench");
  const dir = path.join(base, `${datasetName}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// ── 分阶段写入（issue #134：复用同一沙箱库零重灌）─────────────────────────────
/**
 * 在既有库上补写 W2/W3 的写入面差异（不重灌 turn，无 embedding 外呼）：
 *  - supersede：按本 case 事实计算失效标记 → store.invalidateL1（只标记）
 *  - conclusions：结论卡 work_fact 落库 + part_of 证据链
 * @returns {{supersedeOps:number, superseded:number, conclusionsWritten:number, conclusionLinks:number}}
 */
export async function applyWriteSteps({ caseObj, store, records, facts, supersede, cardinalityGate = true, conclusions }) {
  const stats = { supersedeOps: 0, superseded: 0, supersedeOpsMulti: 0, supersedeOpsSingle: 0, conclusionsWritten: 0, conclusionLinks: 0 };
  if (supersede && facts?.byTurn) {
    const { computeSupersessions } = await import("../../../src/core/record/supersession.ts");
    const turnFacts = records.map(({ turn }) => ({
      turnId: turn.id,
      timestamp: turn.tsISO || caseObj.questionDateISO || "",
      facts: facts.byTurn?.[turn.id]?.triples ?? [],
    }));
    // #136 属性契约：cardinalityGate !== false 时多值属性不进失效表（同一谓词可并存多值）。
    const ops = computeSupersessions(turnFacts, { cardinalityGate: cardinalityGate !== false });
    for (const op of ops) {
      if (op.cardinality === "multi") stats.supersedeOpsMulti++;
      else stats.supersedeOpsSingle++;
      if (typeof store.invalidateL1 !== "function") break;
      try {
        const r = await store.invalidateL1(op.turnId, op.validEnd);
        if (r !== false) stats.superseded++;
      } catch {
        /* 软失败计数可见 */
      }
    }
    stats.supersedeOps = ops.length;
  }
  if (conclusions?.cards?.length) {
    const byId = new Map(records.map(({ turn, sessionId }) => [turn.id, { turn, sessionId }]));
    let idx = 0;
    for (const card of conclusions.cards) {
      idx++;
      const srcTurns = (card.sourceTurnIds || []).map((id) => byId.get(id)).filter(Boolean);
      if (srcTurns.length === 0) continue;
      const tsList = srcTurns.map(({ turn }) => turn.tsISO).filter(Boolean).sort();
      const ts = tsList.length ? tsList[tsList.length - 1] : caseObj.questionDateISO || "";
      const id = caseObj.caseId + "-wfc-" + idx;
      const record = {
        id,
        content: card.content,
        type: "work_fact",
        priority: 70,
        scene_name: "conclusion",
        source_message_ids: card.sourceTurnIds.slice(),
        metadata: ts ? { activity_start_time: ts, activity_end_time: ts } : {},
        timestamps: ts ? [ts] : [],
        createdAt: ts || "1970-01-01T00:00:00Z",
        updatedAt: ts || "1970-01-01T00:00:00Z",
        version: 1,
        sessionKey: caseObj.tenant.user_id + "::concl",
        sessionId: srcTurns[0].sessionId || "concl",
        teamId: caseObj.tenant.team_id,
        userId: caseObj.tenant.user_id,
        agentId: caseObj.tenant.agent_id,
        occurred_at: ts || undefined,
        valid_start: ts || "",
        certainty: "inferred",
        source: "bench-conclusion",
        significance: 0.8,
      };
      const ok = await store.upsertL1(record, undefined);
      if (ok === false) continue;
      stats.conclusionsWritten++;
      if (typeof store.addLink === "function") {
        for (const { turn } of srcTurns) {
          try {
            if (store.addLink(id, turn.id, "part_of", 1) !== false) stats.conclusionLinks++;
          } catch {
            /* 软失败 */
          }
        }
      }
    }
  }
  return stats;
}

/**
 * W1 分阶段键重写：只对「有事实」的 turn 重新 embed 键并 upsert 向量；
 * 无事实 turn 的键 === 原文（逐位相同向量）→ 复用既有向量，零外呼。
 *
 * W1/C（#137）：factChannel.enabled 时同批再算事实短语键并写 l1_fact_vec
 * （该表由 store.init 的 IF NOT EXISTS 在复用库里自愈建出，零迁移脚本）。
 * 只有 dualWrite 档才重写主向量（l1_vec 不动是通道档的硬要求）。
 */
export async function reembedFactKeys({ caseObj, store, embedding, facts, dualWrite, factChannel, embedMinIntervalMs = 400 }) {
  const { buildEmbeddingKey } = await import("../../../src/core/record/fact-key.ts");
  const records = [];
  for (const g of caseObj.groups) for (const t of g.turns) {
    if (facts?.byTurn?.[t.id]?.phrases?.length) records.push({ turn: t, sessionId: g.sessionId });
  }
  const stats = {
    factTurns: records.length,
    embedded: 0,
    embedFailed: 0,
    embedRetries: 0,
    factKeyCharsAdded: 0,
    factChannelTurns: 0,
    factChannelEmbedded: 0,
    factChannelEmbedFailed: 0,
    factChannelWriteFailed: 0,
    factChannelRetries: 0,
  };
  if (records.length === 0 || !embedding) return stats;
  const dualEnabled = dualWrite?.enabled === true;
  const fcEnabled = factChannel?.enabled === true;
  const buildFactChannelKey = fcEnabled ? await loadFactChannelKeyBuilder() : null;
  const fcKeyOpts = fcEnabled ? factChannelKeyOptions(factChannel) : {};
  const writeFactVector = fcEnabled && typeof store.upsertL1FactVector === "function" ? store.upsertL1FactVector.bind(store) : null;
  if (fcEnabled && !writeFactVector) {
    stats.factChannelUnsupported = true;
    console.warn("[bench:warn] store 无 upsertL1FactVector（#137 契约未落地/后端不支持）：事实通道静默关闭");
  }
  const keyOpts = dualEnabled
    ? {
        ...(dualWrite.separator ? { separator: dualWrite.separator } : {}),
        ...(typeof dualWrite.maxFactChars === "number" ? { maxFactChars: dualWrite.maxFactChars } : {}),
      }
    : {};
  const chunkSize = 8;
  // 顺序不变式：重写向量**不得抹掉**既有双时态状态（对已跑过 supersession 的库再跑 dual-write，
  // 若用无 valid_* 的重建记录 upsert，会把 valid_end 写回空 → 静默复活已失效行）。
  const readExisting = async (ids) => {
    if (typeof store.getL1ByIds !== "function") return new Map();
    try {
      const rows = (await store.getL1ByIds(ids)) ?? [];
      return new Map(rows.map((r) => [r.record_id, r]));
    } catch {
      return new Map();
    }
  };
  for (let i = 0; i < records.length; i += chunkSize) {
    const batch = records.slice(i, i + chunkSize);
    const payloadTexts = batch.map(({ turn }) => turnContent(caseObj, turn));
    const keyTexts = dualEnabled
      ? batch.map(({ turn }, j) => buildEmbeddingKey(payloadTexts[j], facts.byTurn[turn.id].phrases, keyOpts))
      : null;
    const fcTexts = fcEnabled ? batch.map(({ turn }) => buildFactChannelKey(facts.byTurn[turn.id].phrases, fcKeyOpts)) : null;

    // 主通道（l1_vec）：仅 dualWrite 档重写，逐位保持既有重试/降级语义
    let vectors = null;
    if (dualEnabled) {
      try {
        vectors = await embedWithRetry(embedding, keyTexts, {
          minIntervalMs: embedMinIntervalMs,
          onRetry: () => {
            stats.embedRetries++;
          },
        });
      } catch {
        for (let k = 0; k < batch.length; k++) {
          try {
            const one = await embedWithRetry(embedding, [keyTexts[k]], { tries: 4, minIntervalMs: embedMinIntervalMs });
            if (!vectors) vectors = new Array(batch.length).fill(undefined);
            vectors[k] = one[0];
          } catch {
            stats.embedFailed++;
          }
        }
      }
    }

    // 事实通道（l1_fact_vec）：只对有键文本的 turn 外呼（批/并发/节流用同一实现）
    let fcVectors = null;
    if (fcEnabled) {
      const idx = [];
      for (let k = 0; k < fcTexts.length; k++) if (fcTexts[k]) idx.push(k);
      stats.factChannelTurns += idx.length;
      fcVectors = new Array(fcTexts.length).fill(undefined);
      if (writeFactVector && idx.length) {
        const sub = await embedTexts({ embedding, texts: idx.map((k) => fcTexts[k]), chunkSize, concurrency: 1, embedMinIntervalMs });
        stats.factChannelEmbedFailed += sub.failed;
        stats.factChannelRetries += sub.retries;
        idx.forEach((k, j) => { fcVectors[k] = sub.vectors[j]; });
      }
    }

    const batchRecords = batch.map(({ turn, sessionId }) => turnToRecord(caseObj, turn, sessionId));
    if (dualEnabled) {
      const existing = await readExisting(batch.map(({ turn }) => turn.id));
      for (let k = 0; k < batchRecords.length; k++) {
        const prev = existing.get(batchRecords[k].id);
        if (prev) {
          batchRecords[k].valid_start = prev.valid_start ?? batchRecords[k].valid_start;
          batchRecords[k].valid_end = prev.valid_end ?? batchRecords[k].valid_end;
        }
        stats.factKeyCharsAdded += keyTexts[k].length - payloadTexts[k].length;
      }
    }
    for (let k = 0; k < batchRecords.length; k++) {
      if (dualEnabled) {
        const ok = await store.upsertL1(batchRecords[k], vectors ? vectors[k] : undefined);
        if (ok !== false && vectors && vectors[k]) stats.embedded++;
      }
      const vec = fcVectors ? fcVectors[k] : undefined;
      if (writeFactVector && vec && vec.length) await writeFactChannelVector(writeFactVector, stats, batchRecords[k], vec);
    }
  }
  return stats;
}

/** 查询向量磁盘缓存（同题同模型零重复外呼；arms 间复用，语义不变——embedding 确定性）。 */
export function withEmbedCache(embedding, cacheDir, tag) {
  if (!embedding || !cacheDir) return embedding;
  // #139 第3项：路径/读/原子写统一走 cache.mjs（与 facts/conclusions 同一实现，
  // 并发写不再互踩固定 .tmp 名）。
  const keyOf = (text) => createHash("sha256").update(tag + "\u0000" + String(text)).digest("hex").slice(0, 32);
  const wrapper = Object.create(embedding);
  const innerEmbed = typeof embedding.embed === "function" ? embedding.embed.bind(embedding) : null;
  // 只缓存默认选项下的查询向量（带 opts 的调用直接回源，避免把 timeoutMs 等语义吞掉）。
  wrapper.embed = async (text, opts) => {
    if (!innerEmbed) throw new Error("embedding.embed 不可用");
    if (opts !== undefined) return innerEmbed(text, opts);
    const key = keyOf(text);
    const hit = readCache(cacheDir, "emb", key, (payload) => Array.isArray(payload) && payload.length > 0);
    if (hit) return new Float32Array(hit.payload);
    const v = await innerEmbed(text);
    try {
      // 缓存写失败不影响检索结果（embed cache 只是省外呼的旁路）。
      writeCache(cacheDir, "emb", key, Array.from(v));
    } catch {
      /* 磁盘只读/配额满 → 继续跑 */
    }
    return v;
  };
  return wrapper;
}

// ── 生效配置自检（issue #135 白跑档的根因防线）───────────────────────────────
/**
 * 回读「最终生效」的召回配置。
 *
 * 背景（#135）：每轮 copyOverrideFrom(prodData, storeDir) 会把生产
 * config-override.json（rerank.enabled=true）复制进沙箱库，覆盖
 * prepareBenchYaml 写的 enabled:false——yaml 写得对、实验档却按生产配置跑，
 * 一档白跑且无从察觉（报告里 rerank 字段还只记 provider 不记 enabled）。
 *
 * 纪律：报告必须记这里的原始快照；--expect-config 用它做断言。
 */
export function effectiveRecallSnapshot(cfg) {
  const r = cfg?.recall ?? {};
  const rr = r.rerank ?? {};
  return {
    "recall.maxResults": r.maxResults ?? null,
    "recall.candidateK": r.candidateK ?? null,
    "recall.fusion.mode": r.fusion?.mode ?? null,
    "recall.rerank.enabled": rr.enabled === true,
    "recall.rerank.provider": rr.provider ?? "none",
    "recall.rerank.candidates": rr.candidates ?? null,
    "recall.rerank.minScore": rr.minScore ?? null,
    "recall.rerank.mode": rr.mode ?? null,
    "recall.rerank.blend": rr.blend ?? null,
    "recall.smallToBig.enabled": r.smallToBig?.enabled === true,
    "recall.smallToBig.maxExtraLines": r.smallToBig?.maxExtraLines ?? null,
    "recall.smallToBig.budget": r.smallToBig?.budget ?? null,
    "recall.conclusionLayer.enabled": r.conclusionLayer?.enabled === true,
    "recall.conclusionLayer.maxConclusions": r.conclusionLayer?.maxConclusions ?? null,
    "recall.factChannel.enabled": r.factChannel?.enabled === true,
    "recall.factChannel.weight": r.factChannel?.weight ?? null,
    "recall.validity.mode": r.validity?.mode ?? null,
    "recall.presentTemporal.enabled": r.presentTemporal?.enabled === true,
  };
}

/** 解析 --expect-config key=value[,key=value] 或多次 --expect-config。 */
export function parseExpectConfig(spec) {
  const out = {};
  const list = Array.isArray(spec) ? spec : String(spec ?? "").split(",");
  for (const raw of list) {
    const item = String(raw ?? "").trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) throw new Error("--expect-config 需要 key=value，收到: " + item);
    const key = item.slice(0, eq).trim();
    const val = item.slice(eq + 1).trim();
    out[key] = coerceConfigValue(val);
  }
  return out;
}

function coerceConfigValue(val) {
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null") return null;
  if (val !== "" && Number.isFinite(Number(val))) return Number(val);
  return val;
}

/** 比较生效快照与期望值，返回不匹配清单（空数组=全过）。 */
export function diffExpectedConfig(snapshot, expected) {
  const mismatches = [];
  for (const [key, want] of Object.entries(expected ?? {})) {
    const got = snapshot?.[key];
    const same = typeof want === "number" && typeof got === "number" ? Math.abs(got - want) < 1e-9 : got === want;
    if (!same) mismatches.push({ key, expected: want, actual: got ?? null });
  }
  return mismatches;
}

/** 断言生效配置；不匹配直接抛错（让档位在灌库前失败，而不是跑完才发现白跑）。 */
export function assertExpectedConfig(snapshot, expected) {
  const mismatches = diffExpectedConfig(snapshot, expected);
  if (mismatches.length) {
    const detail = mismatches.map((m) => `${m.key}: 期望 ${JSON.stringify(m.expected)} 实际 ${JSON.stringify(m.actual)}`).join("; ");
    throw new Error("生效配置与 --expect-config 不符（多半是生产 config-override.json 覆盖了沙箱 yaml）: " + detail);
  }
}

