#!/usr/bin/env node
/**
 * #179 S5-c（2026-11-02）：离线对照重放 —— 同批真实查询下 mode:off 与 mode:shadow 的注入口径差。
 *
 * 为什么离线：门槛 c 要在上线前知道「换成新选线后注入行数会降多少、会不会整轮归零」，
 * 但 shadow 在生产里只记录不改注入（规格 §4.3），所以只能在重放里看 would-inject：
 *   - off  ：注入 = journal 里那一轮实际注入的行（= memoryLines），零额外计算；
 *   - shadow：把同一批行喂 runInjectionSelection（生产预算值 + 折叠 + 名次尺/地板），
 *             取 selection.kept 作为「若 enforce 会保留几行」。shadow 本身不改注入，故无副作用。
 * 指标：注入行数降幅 = 1 - Σkept/Σoff（规格门槛 ≥15%）、0 行轮占比（≤20%）、丢因分布。
 *
 * 纪律：journal 只读；嵌入只读调用；产物只写 <dataDir>/calibration/ 下这一个文件。
 *
 * 运行（仓库根 MemoryCore/）：
 *   npx tsx scripts/selection-offline-replay.ts --limit 150
 *   npx tsx scripts/selection-offline-replay.ts --limit 150 --dry-run
 */
import fs from "node:fs";
import path from "node:path";

import { loadGatewayConfig } from "../src/gateway/config.ts";
import { createEmbeddingService } from "../src/core/store/embedding.ts";
import type { EmbeddingService } from "../src/core/store/embedding.ts";
import { parseConfig } from "../src/config.ts";
import {
  classifyInjectionIntent,
  PRODUCTION_INJECTION_BUDGET,
  type InjectionIntent,
} from "../src/core/recall/selection/injection-stage.ts";
import { runInjectionSelection } from "../src/core/recall/selection/injection-wiring.ts";

interface Args {
  journalDir: string;
  out: string;
  dataDir: string;
  limit: number;
  keepRatio: number;
  /** 覆盖标定产物里的地板（用于同一批样本上对比不同分位数的口径）；null = 用标定值。 */
  floor: number | null;
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
    out: path.resolve(get("out") ?? path.join(dataDir, "calibration", "selection-offline-replay.json")),
    dataDir: path.resolve(dataDir),
    limit: Math.max(1, Number(get("limit") ?? 150)),
    keepRatio: Number(get("keep-ratio") ?? 0.67),
    floor: get("floor") === undefined ? null : Number(get("floor")),
    delayMs: Math.max(0, Number(get("delay-ms") ?? 500)),
    dryRun: argv.includes("--dry-run"),
  };
}

const logger = {
  info: (m: string) => console.log(`[replay] ${m}`),
  warn: (m: string) => console.warn(`[replay] WARN ${m}`),
  debug: () => {
    /* 静默 */
  },
  error: (m: string) => console.error(`[replay] ERROR ${m}`),
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Round {
  sessionKey: string;
  query: string;
  lines: string[];
  ts: string;
}

function readRounds(journalDir: string, limit: number): Round[] {
  const files = fs.existsSync(journalDir)
    ? fs
        .readdirSync(journalDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
    : [];
  const all: Round[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(journalDir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const sessionKey = typeof e.sessionKey === "string" ? e.sessionKey : "";
      const query = typeof e.query === "string" ? e.query : "";
      const lines = Array.isArray(e.memoryLines)
        ? (e.memoryLines as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      if (!sessionKey || !query.trim() || lines.length === 0) continue;
      // 合成探针会话不入样（与标定脚本同口径）
      if (sessionKey.startsWith("probe-")) continue;
      all.push({ sessionKey, query, lines, ts: typeof e.ts === "string" ? e.ts : "" });
    }
  }
  all.sort((a, b) => a.ts.localeCompare(b.ts));
  // 去重同轮重复：同 sessionKey + 同 query + 相邻 <3s（journal 实测同一轮会写两条）
  const rounds: Round[] = [];
  for (const r of all) {
    const prev = rounds[rounds.length - 1];
    if (prev && prev.sessionKey === r.sessionKey && prev.query === r.query) {
      const dt = Math.abs(new Date(r.ts).getTime() - new Date(prev.ts).getTime());
      if (dt < 3000) continue;
    }
    rounds.push(r);
  }
  // 均匀抽 limit 轮（保留时间序，覆盖各窗口）
  if (rounds.length <= limit) return rounds;
  const step = rounds.length / limit;
  const picked: Round[] = [];
  for (let i = 0; i < limit; i++) picked.push(rounds[Math.floor(i * step)]!);
  return picked;
}

const OFF_CFG = parseConfig({
  recall: {
    layerRuler: { mode: "off", keepRatio: 1, minPerLayer: 1, floor: null },
    injection: { foldIdentical: false, budgetByIntent: { empty: null, continuation: null, self: null, info: null } },
  },
}).recall;
const SHADOW_CFG = (keepRatio: number, floor: { model: string; dims: number; value: number } | null) =>
  parseConfig({
    recall: {
      layerRuler: { mode: "shadow", keepRatio, minPerLayer: 1, floor },
      injection: { foldIdentical: true, budgetByIntent: PRODUCTION_INJECTION_BUDGET },
    },
  }).recall;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const gw = loadGatewayConfig({}) as Record<string, unknown>;
  const memory = (gw.memory ?? {}) as Record<string, unknown>;
  const embeddingCfg = memory.embedding as Record<string, unknown> | undefined;
  const svc = await createEmbeddingService(embeddingCfg as never, logger as never);
  if (!svc) throw new Error("embedding 服务不可用（离线重放需要真实相似度）");
  const info = svc.getProviderInfo();
  const dims = svc.getDimensions();
  logger.info(`embedding = ${info.provider}/${info.model}@${dims}；journal = ${args.journalDir}`);

  const rounds = readRounds(args.journalDir, args.limit);
  logger.info(`重放轮次 ${rounds.length}（已去同轮重复、跳过 probe-* 与 0 行轮）`);
  if (rounds.length === 0) throw new Error("没有可重放的轮次");

  // 地板来源：--floor 显式覆盖（同一批样本对比不同分位数），否则读标定产物（wiring 内解析）。
  const floorOverride =
    args.floor !== null && Number.isFinite(args.floor) ? { model: info.model, dims, value: args.floor } : null;
  const shadowCfg = SHADOW_CFG(args.keepRatio, floorOverride);
  const perSession = new Map<string, string>();
  let offLines = 0;
  let keptLines = 0;
  let injectedLines = 0;
  let zeroRounds = 0;
  let bypassRounds = 0;
  const intents: Record<InjectionIntent, number> = { empty: 0, continuation: 0, self: 0, info: 0 };
  const dropped = { rank: 0, floor: 0, budget: 0, fold: 0 };
  const perRound: Record<string, unknown>[] = [];
  /** 门槛 e：单轮选线增量（嵌入批次 + 纯选择）——只统计成功轮，bypass 轮单列。 */
  const msSamples: number[] = [];
  const msSamplesBypass: number[] = [];

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i]!;
    const shadow = await runInjectionSelection({
      lines: r.lines,
      query: r.query,
      cfg: shadowCfg,
      pluginDataDir: args.dataDir,
      embeddingService: svc as EmbeddingService,
      previousHash: perSession.get(r.sessionKey),
    });
    offLines += r.lines.length;
    keptLines += shadow.selection.kept;
    injectedLines += shadow.lines.length;
    if (shadow.selection.kept === 0) zeroRounds += 1;
    if (shadow.ruler.bypass) bypassRounds += 1;
    intents[classifyInjectionIntent(r.query)] += 1;
    dropped.rank += shadow.selection.droppedBy.rank;
    dropped.floor += shadow.selection.droppedBy.floor;
    dropped.budget += shadow.selection.droppedBy.budget;
    dropped.fold += shadow.selection.droppedBy.fold;
    if (shadow.foldHash) perSession.set(r.sessionKey, shadow.foldHash);
    if (typeof shadow.ruler.ms === "number") {
      (shadow.ruler.bypass ? msSamplesBypass : msSamples).push(shadow.ruler.ms);
    }
    perRound.push({
      sessionKey: r.sessionKey,
      query: r.query.slice(0, 40),
      off: r.lines.length,
      wouldInject: shadow.selection.kept,
      droppedBy: shadow.selection.droppedBy,
      floorSource: shadow.ruler.floorSource,
      bypass: shadow.ruler.bypass ?? null,
      ms: shadow.ruler.ms ?? null,
    });
    if (args.delayMs > 0 && i + 1 < rounds.length) await sleep(args.delayMs);
  }

  const reduction = offLines === 0 ? 0 : 1 - keptLines / offLines;
  const zeroRate = zeroRounds / rounds.length;
  // 最近秩分位（与标定脚本同口径）：p95 = 第 ceil(0.95n) 小的值。
  const quantile = (values: number[], p: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const k = Math.max(1, Math.ceil(p * sorted.length));
    return sorted[Math.min(sorted.length, k) - 1]!;
  };
  const perfMs = {
    n: msSamples.length,
    p50: quantile(msSamples, 0.5),
    p95: quantile(msSamples, 0.95),
    max: msSamples.length > 0 ? Math.max(...msSamples) : null,
    bypassN: msSamplesBypass.length,
    bypassMax: msSamplesBypass.length > 0 ? Math.max(...msSamplesBypass) : null,
  };
  const report = {
    measuredAt: new Date().toISOString(),
    embedding: { provider: info.provider, model: info.model, dims },
    journalDir: args.journalDir,
    rounds: rounds.length,
    keepRatio: args.keepRatio,
    floorOverride: floorOverride?.value ?? null,
    budget: PRODUCTION_INJECTION_BUDGET,
    offLines,
    wouldInjectLines: keptLines,
    injectedLinesUnderShadow: injectedLines,
    reduction: Number(reduction.toFixed(4)),
    zeroRounds,
    zeroRate: Number(zeroRate.toFixed(4)),
    bypassRounds,
    perfMs,
    intents,
    droppedBy: dropped,
    gate: {
      reductionTarget: 0.15,
      zeroRateTarget: 0.2,
      reductionPass: reduction >= 0.15,
      zeroRatePass: zeroRate <= 0.2,
    },
    samples: perRound,
  };

  logger.info(
    `off 行数 ${offLines} / would-inject ${keptLines}（降 ${(reduction * 100).toFixed(1)}%，门槛 ≥15%）/ 0 行轮 ${zeroRounds}/${rounds.length}（${(zeroRate * 100).toFixed(1)}%，门槛 ≤20%）/ bypass ${bypassRounds}`,
  );
  logger.info(
    `丢因 rank=${dropped.rank} floor=${dropped.floor} budget=${dropped.budget} fold=${dropped.fold}；intent ${JSON.stringify(intents)}`,
  );
  logger.info(
    `选线增量 ms（门槛 e ≤300ms）：n=${perfMs.n} p50=${perfMs.p50} p95=${perfMs.p95} max=${perfMs.max}；bypass 轮 n=${perfMs.bypassN} max=${perfMs.bypassMax}`,
  );

  if (args.dryRun) {
    logger.info("--dry-run：不写盘");
    return;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n", "utf8");
  logger.info(`已写 ${args.out}`);
}

main().catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
