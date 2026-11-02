#!/usr/bin/env node
/**
 * #179 S5-d（2026-11-02）：嵌入相似度地板标定 —— 用真实 journal 样本算 null-probe p95。
 *
 * 口径（规格 §4.4）：
 *   - 样本 = 「真实查询 × 不相干行」的余弦相似度：查询取自某个会话，行取自**另一个会话**
 *     （跨会话配对 = 语义上无关，正是地板要挡的那一撮）；probe-* 合成会话不入样；
 *   - 统计量 = 分布 p95（最近秩法，与 src/core/recall/selection/floor-calibration.ts 同源）；
 *   - 样本 < --min-samples（缺省 50）→ 不写产物，只打印统计（诚实 no-op，不猜地板）；
 *   - 产物 data/calibration/embedding-sim-floor.json，键 `${model}@${dims}`，合并保留其它模型的条目。
 *
 * 可复现：同 --seed 同 journal → 同配对集合；--dry-run 只算不写。
 *
 * 运行（仓库根 MemoryCore/）：
 *   npx tsx scripts/calibrate-embedding-sim-floor.ts --pairs 300
 *   npx tsx scripts/calibrate-embedding-sim-floor.ts --pairs 300 --dry-run
 *
 * 只读纪律：journal 只读、embedding 只读调用、产物只写 calibration/ 下这一个文件。
 */
import fs from "node:fs";
import path from "node:path";

import { loadGatewayConfig } from "../src/gateway/config.ts";
import { createEmbeddingService } from "../src/core/store/embedding.ts";
import type { EmbeddingService } from "../src/core/store/embedding.ts";
import {
  buildFloorCalibration,
  cosineSimilarity,
  embeddingSimFloorKey,
  NULL_PROBE_MIN_SAMPLES,
  nullProbeP95,
  parseFloorCalibration,
} from "../src/core/recall/selection/floor-calibration.ts";

interface Args {
  journalDir: string;
  out: string;
  pairs: number;
  seed: number;
  minSamples: number;
  batchSize: number;
  delayMs: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataDir = process.env.TDAI_DATA_DIR ?? "D:\\TDB\\data";
  return {
    journalDir: path.resolve(get("journal-dir") ?? path.join(dataDir, "logs", "recall")),
    out: path.resolve(get("out") ?? path.join(dataDir, "calibration", "embedding-sim-floor.json")),
    pairs: Number(get("pairs") ?? 300),
    seed: Number(get("seed") ?? 179),
    minSamples: Number(get("min-samples") ?? NULL_PROBE_MIN_SAMPLES),
    // 生产 embedding 端点（doubao-embedding-vision）单请求上限 10 条输入，超限 HTTP 400
    batchSize: Math.max(1, Number(get("batch-size") ?? 10)),
    // 账号级限流间隔：300 对 = 60 个请求，500ms 间隔约 30s 跑完
    delayMs: Math.max(0, Number(get("delay-ms") ?? 4000)),
    dryRun: argv.includes("--dry-run"),
  };
}

const logger = {
  info: (m: string) => console.log(`[calibrate] ${m}`),
  warn: (m: string) => console.warn(`[calibrate] WARN ${m}`),
  debug: () => {
    /* 静默 */
  },
  error: (m: string) => console.error(`[calibrate] ERROR ${m}`),
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface JournalEntry {
  query?: unknown;
  sessionKey?: unknown;
  memoryLines?: unknown;
}

interface SessionSamples {
  sessionKey: string;
  queries: string[];
  lines: string[];
}

function readJournalEntries(dir: string): JournalEntry[] {
  if (!fs.existsSync(dir)) throw new Error(`journal 目录不存在：${dir}`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const out: JournalEntry[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as JournalEntry);
      } catch {
        // 半行/坏行跳过（journal 轮转可能留断行）
      }
    }
  }
  return out;
}

function collectSessions(entries: JournalEntry[]): SessionSamples[] {
  const map = new Map<string, { queries: Set<string>; lines: Set<string> }>();
  for (const e of entries) {
    const key = typeof e.sessionKey === "string" ? e.sessionKey : "";
    if (!key || key.startsWith("probe-")) continue; // 合成探针会话不入样
    const q = typeof e.query === "string" ? e.query.trim() : "";
    const rawLines = Array.isArray(e.memoryLines) ? e.memoryLines : [];
    const lines = rawLines.filter((l): l is string => typeof l === "string" && l.trim().length > 0);
    if (!q || lines.length === 0) continue;
    let slot = map.get(key);
    if (!slot) {
      slot = { queries: new Set(), lines: new Set() };
      map.set(key, slot);
    }
    slot.queries.add(q);
    for (const l of lines) slot.lines.add(l);
  }
  const out: SessionSamples[] = [];
  for (const [sessionKey, slot] of map) {
    out.push({ sessionKey, queries: [...slot.queries], lines: [...slot.lines] });
  }
  return out.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}

interface Pair {
  query: string;
  line: string;
  querySession: string;
  lineSession: string;
}

function buildPairs(sessions: SessionSamples[], count: number, seed: number): Pair[] {
  const rand = mulberry32(seed);
  const usable = sessions.filter((s) => s.queries.length > 0);
  if (usable.length < 2) return [];
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  const maxTries = count * 40;
  for (let tries = 0; tries < maxTries && pairs.length < count; tries++) {
    const qs = usable[Math.floor(rand() * usable.length)]!;
    const ls = usable[Math.floor(rand() * usable.length)]!;
    if (qs.sessionKey === ls.sessionKey) continue; // 必须跨会话
    if (ls.lines.length === 0) continue;
    const query = qs.queries[Math.floor(rand() * qs.queries.length)]!;
    const line = ls.lines[Math.floor(rand() * ls.lines.length)]!;
    const key = `${qs.sessionKey}\u0000${query}\u0000${ls.sessionKey}\u0000${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ query, line, querySession: qs.sessionKey, lineSession: ls.sessionKey });
  }
  return pairs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const gw = loadGatewayConfig();
  const embeddingCfg = gw.memory.embedding;
  const svc = createEmbeddingService(embeddingCfg, logger);
  const provider = svc.getProviderInfo();
  const dims = svc.getDimensions();
  if (!provider || provider.provider === "noop" || !Number.isFinite(dims) || dims <= 0) {
    throw new Error(`embedding 不可用（provider=${provider?.provider ?? "?"}, dims=${dims}）——拒绝写假标定`);
  }
  logger.info(`embedding = ${provider.provider}/${provider.model}@${dims}；journal = ${args.journalDir}`);

  const entries = readJournalEntries(args.journalDir);
  const sessions = collectSessions(entries);
  const pairs = buildPairs(sessions, args.pairs, args.seed);
  logger.info(
    `journal ${entries.length} 条 / 可用会话 ${sessions.length} 个 / 配对 ${pairs.length} 对（目标 ${args.pairs}）`,
  );
  if (pairs.length === 0) throw new Error("配对为空：跨会话样本不足，无法标定（不写产物）");

  // 一次批量嵌入 query 与 line（批内分片，避免单请求过大）
  const texts: string[] = [];
  for (const p of pairs) texts.push(p.query, p.line);
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += args.batchSize) {
    const chunk = texts.slice(i, i + args.batchSize);
    const got = await embedWithRetry(svc, chunk, logger, args.delayMs);
    if (!Array.isArray(got) || got.length !== chunk.length) {
      throw new Error(`embedBatch 长度不符：期望 ${chunk.length}，实得 ${Array.isArray(got) ? got.length : "非数组"}`);
    }
    vectors.push(...got);
    logger.info(`嵌入进度 ${Math.min(i + args.batchSize, texts.length)}/${texts.length} 条（${chunk.length} 条/请求）`);
    // 账号级限流（实测 429 AccountRateLimitExceeded）：请求之间主动留间隔
    if (args.delayMs > 0 && i + args.batchSize < texts.length) await sleep(args.delayMs);
  }

  const sims: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const sim = cosineSimilarity(vectors[2 * i]!, vectors[2 * i + 1]!);
    if (sim !== null) sims.push(sim);
  }
  const p95 = nullProbeP95(sims, args.minSamples);
  logger.info(`有效样本 ${sims.length} / 配对 ${pairs.length}；p50=${fmt(quantile(sims, 0.5))} p95=${fmt(p95)}`);
  if (sims.length < args.minSamples || p95 === null) {
    logger.warn(`样本不足或 p95 越界：${sims.length} < ${args.minSamples} 或 p95 不在 0..1 —— 不写产物（诚实 no-op）`);
    return;
  }

  const measuredAt = new Date().toISOString();
  const nextRecord = {
    model: provider.model,
    dims,
    value: p95,
    measuredAt,
    samples: sims.length,
    method: "null-probe-cross-session-p95",
    source: `journal:${args.journalDir}`,
  };

  // 合并保留其它模型/维度的既有条目
  const existingText = fs.existsSync(args.out) ? fs.readFileSync(args.out, "utf8") : "";
  const existing = parseFloorCalibration(existingText);
  const records = [...existing.entries()].map(([key, value]) => {
    const at = key.lastIndexOf("@");
    return { model: key.slice(0, at), dims: Number(key.slice(at + 1)), value };
  });
  const merged = records.filter((r) => !(r.model === provider.model && r.dims === dims));
  merged.push(nextRecord);
  const doc = buildFloorCalibration(merged, { generatedAt: measuredAt });

  if (args.dryRun) {
    logger.info(`--dry-run：不写盘。目标文件 ${args.out}，键 ${embeddingSimFloorKey(provider.model, dims)}`);
    console.log(doc);
    return;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, doc, "utf8");
  logger.info(
    `已写 ${args.out}（键 ${embeddingSimFloorKey(provider.model, dims)}，value=${p95.toFixed(4)}，samples=${sims.length}）`,
  );
}

/**
 * 账号级限流重试：生产 embedding 端点对突发请求回 429（AccountRateLimitExceeded），
 * 服务自身只短冷却 3 次；标定是离线批任务，这里用更长的退避再兜一层，避免整批报废。
 */
async function embedWithRetry(
  svc: EmbeddingService,
  chunk: string[],
  logger: { warn: (m: string) => void; info: (m: string) => void },
  delayMs: number,
): Promise<Float32Array[]> {
  // 实测 429 是账号级配额，短退避（5s/15s）撑不过配额窗口；标定是离线批任务，
  // 允许等一整分钟以上，宁可慢也不要整批报废。
  const backoffs = [15000, 30000, 60000, 120000, 180000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await svc.embedBatch(chunk);
    } catch (err) {
      lastErr = err;
      const wait = backoffs[attempt];
      if (wait === undefined) break;
      logger.warn(
        `嵌入批失败（${chunk.length} 条），${wait}ms 后重试：${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
      await sleep(wait + delayMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function quantile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const k = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length - 1, k - 1)] ?? null;
}
const fmt = (v: number | null): string => (v === null ? "null" : v.toFixed(4));

main().catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
