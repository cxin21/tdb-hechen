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
export function prepareBenchYaml({ srcYaml, storeDir, rerankOverride }) {
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
  m.recall = { ...(m.recall || {}) };
  // v3 召回是本基准的被测面，必须显式开（yaml 缺省不开）。
  m.recall.v3Recall = { ...(m.recall.v3Recall || {}), enabled: true };
  // B2-a（bench/recall-opt）：精排试验档只写沙箱 yaml（生产 yaml 定档后才动——用户决策②）。
  if (rerankOverride && typeof rerankOverride === "object" && Object.keys(rerankOverride).length) {
    m.recall.rerank = { ...(m.recall.rerank || {}), ...rerankOverride };
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
 */
export async function ingestCase({ caseObj, store, embedding, contentIndex, chunkSize = 8, concurrency = 1, onRetry }) {
  const records = [];
  for (const g of caseObj.groups) for (const t of g.turns) records.push({ turn: t, sessionId: g.sessionId });

  const stats = { turns: records.length, embedded: 0, embedFailed: 0, written: 0, embedRetries: 0 };

  const texts = records.map(({ turn }) => turnContent(caseObj, turn));

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
          onRetry: (n) => { stats.embedRetries++; onRetry?.(n); },
        });
        for (let k = 0; k < vs.length; k++) vectors[b.start + k] = vs[k];
      } catch {
        // 批上限因模型而异：整批失败再逐条退避重试
        for (let k = 0; k < b.texts.length; k++) {
          try {
            const one = await embedWithRetry(embedding, [b.texts[k]], { tries: 4, onRetry: () => { stats.embedRetries++; onRetry?.(); } });
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
  return stats;
}

// ── 召回 ────────────────────────────────────────────────────────────────────

/**
 * 构造召回函数：per case 传三元组隔离（team/user/agent），与 /v3/recall 端点同形。
 * 返回 async (query, caseObj) => { hits:[{id,content,score}], block, latencyMs, debug }
 */
export function makeRecall({ cfg, store, embedding, dataDir, logger = silentLogger }) {
  let fn;
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
      validityNow: new Date(),
      // 精排走配置（生产同款），显式不走工厂覆盖
      rerankDeps: undefined,
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
