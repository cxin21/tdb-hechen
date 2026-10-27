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
export function prepareBenchYaml({ srcYaml, storeDir, rerankOverride, mmrOverride, embThresholdOverride, ageDecayOverride, injectOverride, smallToBigOverride, fusionOverride, candidateKOverride, presentTemporalOverride }) {
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
 * 批量写入一个 case 的全部 turn（含 embedding）+ 回填 content→turnId 映射。
 * 并发受限（embedding 服务多为单批小上限），失败对半降级重试。
 *
 * W1（issue #134）：facts/dualWrite 传入时，embedding 键文本 = turn 原文 + 事实短语拼接；
 * 落库 content 不变（原文仍是命中载荷）。缺省（未传）→ 逐位现状。
 */
export async function ingestCase({ caseObj, store, embedding, contentIndex, chunkSize = 8, concurrency = 1, onRetry, facts, dualWrite, supersede, conclusions, embedMinIntervalMs = 400 }) {
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

  // 分批 + 限并发取向量
  const batches = [];
  for (let i = 0; i < texts.length; i += chunkSize) batches.push({ start: i, texts: texts.slice(i, i + chunkSize) });
  const vectors = new Array(texts.length).fill(undefined);
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
          onRetry: (n) => { stats.embedRetries++; onRetry?.(n); },
        });
        for (let k = 0; k < vs.length; k++) vectors[b.start + k] = vs[k];
      } catch {
        // 批上限因模型而异：整批失败再逐条退避重试
        for (let k = 0; k < b.texts.length; k++) {
          try {
            const one = await embedWithRetry(embedding, [b.texts[k]], { tries: 4, minIntervalMs: embedMinIntervalMs, onRetry: () => { stats.embedRetries++; onRetry?.(); } });
            vectors[b.start + k] = one[0];
          } catch {
            stats.embedFailed++;
          }
        }
      }
    }
  });
  await Promise.all(workers);
  stats.embedded = vectors.filter(Boolean).length;

  for (let i = 0; i < records.length; i++) {
    const { turn, sessionId } = records[i];
    const record = turnToRecord(caseObj, turn, sessionId);
    contentIndex.set(normHead(record.content), turn.id);
    const ok = store.upsertL1(record, vectors[i]);
    if (ok !== false) stats.written++;
  }

  // W2/W3 写入面（issue #134）：失效标记 + 结论卡——与 --store 分阶段写入共用同一实现（零重复）。
  Object.assign(stats, await applyWriteSteps({ caseObj, store, records, facts, supersede, conclusions }));
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
export async function applyWriteSteps({ caseObj, store, records, facts, supersede, conclusions }) {
  const stats = { supersedeOps: 0, superseded: 0, conclusionsWritten: 0, conclusionLinks: 0 };
  if (supersede && facts?.byTurn) {
    const { computeSupersessions } = await import("../../../src/core/record/supersession.ts");
    const turnFacts = records.map(({ turn }) => ({
      turnId: turn.id,
      timestamp: turn.tsISO || caseObj.questionDateISO || "",
      facts: facts.byTurn?.[turn.id]?.triples ?? [],
    }));
    const ops = computeSupersessions(turnFacts);
    for (const op of ops) {
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
 */
export async function reembedFactKeys({ caseObj, store, embedding, facts, dualWrite, embedMinIntervalMs = 400 }) {
  const { buildEmbeddingKey } = await import("../../../src/core/record/fact-key.ts");
  const records = [];
  for (const g of caseObj.groups) for (const t of g.turns) {
    if (facts?.byTurn?.[t.id]?.phrases?.length) records.push({ turn: t, sessionId: g.sessionId });
  }
  const stats = { factTurns: records.length, embedded: 0, embedFailed: 0, embedRetries: 0, factKeyCharsAdded: 0 };
  if (records.length === 0 || !embedding) return stats;
  const keyOpts = dualWrite?.enabled
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
    const keyTexts = batch.map(({ turn }, j) =>
      buildEmbeddingKey(payloadTexts[j], facts.byTurn[turn.id].phrases, keyOpts),
    );
    let vectors = null;
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
    const existing = await readExisting(batch.map(({ turn }) => turn.id));
    for (let k = 0; k < batch.length; k++) {
      const { turn, sessionId } = batch[k];
      const record = turnToRecord(caseObj, turn, sessionId);
      const prev = existing.get(turn.id);
      if (prev) {
        record.valid_start = prev.valid_start ?? record.valid_start;
        record.valid_end = prev.valid_end ?? record.valid_end;
      }
      stats.factKeyCharsAdded += keyTexts[k].length - payloadTexts[k].length;
      const ok = await store.upsertL1(record, vectors ? vectors[k] : undefined);
      if (ok !== false && vectors && vectors[k]) stats.embedded++;
    }
  }
  return stats;
}

/** 查询向量磁盘缓存（同题同模型零重复外呼；arms 间复用，语义不变——embedding 确定性）。 */
export function withEmbedCache(embedding, cacheDir, tag) {
  if (!embedding || !cacheDir) return embedding;
  const dir = path.join(cacheDir, "emb");
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = (text) => {
    const h = createHash("sha256").update(tag + "\u0000" + String(text)).digest("hex").slice(0, 32);
    return path.join(dir, h + ".json");
  };
  const wrapper = Object.create(embedding);
  const innerEmbed = typeof embedding.embed === "function" ? embedding.embed.bind(embedding) : null;
  // 只缓存默认选项下的查询向量（带 opts 的调用直接回源，避免把 timeoutMs 等语义吞掉）。
  wrapper.embed = async (text, opts) => {
    if (!innerEmbed) throw new Error("embedding.embed 不可用");
    if (opts !== undefined) return innerEmbed(text, opts);
    const f = fileOf(text);
    if (fs.existsSync(f)) {
      try {
        return new Float32Array(JSON.parse(fs.readFileSync(f, "utf8")));
      } catch {
        /* 缓存损坏 → 回源 */
      }
    }
    const v = await innerEmbed(text);
    try {
      const tmp = f + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(Array.from(v)), "utf8");
      fs.renameSync(tmp, f);
    } catch {
      /* 写缓存失败不影响结果 */
    }
    return v;
  };
  return wrapper;
}
