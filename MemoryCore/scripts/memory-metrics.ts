#!/usr/bin/env tsx
/**
 * P7（2026-11-02）：记忆内禀指标 + 召回读数 CLI（**只读**）。
 *
 * 用法（在 MemoryCore/ 下）：
 *   npm run memory:metrics                          # 默认读 D:/TDB/data/vectors.db 最近 2000 行
 *   npm run memory:metrics -- --limit 500
 *   npm run memory:metrics -- --since 2026-10-01T00:00:00Z
 *   npm run memory:metrics -- --db D:/TDB/data/vectors.db --json
 *   npm run memory:metrics -- --journal-dir D:/TDB/data/logs/recall --journal-files 20
 *
 * 红线：数据库以 readOnly 打开，**零写入**；不 checkpoint、不 VACUUM、不改任何一行。
 * 指标口径与诚实边界见 docs/ops/memory-metrics.md（本脚本与纯函数层 src/core/metrics/memory-metrics.ts 同源）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  computeL1Metrics,
  computeRecallMetrics,
  describeSampling,
  type L1MetricRow,
  type RecallJournalEntry,
  type SamplingLimitSource,
} from "../src/core/metrics/memory-metrics.js";
import { readChurnWindow } from "../src/core/metrics/churn-window.js";
import { resolveAtomicMaxChars } from "../src/core/metrics/metrics-config.js";

interface Args {
  db: string;
  limit: number;
  /** --limit 来源：cli=显式传参，default=脚本缺省（报告里必须显式打印，防把 2000 当全库）。 */
  limitSource: SamplingLimitSource;
  since?: string;
  json: boolean;
  journalDir: string;
  journalFiles: number;
  /** CLI 显式值；缺省 undefined = 跟随 config-override（F6⑤，不再硬编码 300）。 */
  atomicMaxChars?: number;
  dupThreshold: number;
  /** config-override.json 路径（F6⑤）。 */
  config: string;
  /** 重复对采样上限（缺省 120，随机采样）。 */
  dupSampleLimit?: number;
  /** 采样种子（缺省 20261102，可复现）。 */
  sampleSeed?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: "D:/TDB/data/vectors.db",
    limit: 2000,
    limitSource: "default",
    json: false,
    journalDir: "D:/TDB/data/logs/recall",
    journalFiles: 10,
    dupThreshold: 0.85,
    config: "D:/TDB/data/config-override.json",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    switch (a) {
      case "--db":
        args.db = next();
        break;
      case "--limit":
        args.limit = Number(next());
        args.limitSource = "cli";
        break;
      case "--since":
        args.since = next();
        break;
      case "--json":
        args.json = true;
        break;
      case "--journal-dir":
        args.journalDir = next();
        break;
      case "--journal-files":
        args.journalFiles = Number(next());
        break;
      case "--atomic-max-chars":
        args.atomicMaxChars = Number(next());
        break;
      case "--dup-threshold":
        args.dupThreshold = Number(next());
        break;
      case "--config":
        args.config = next();
        break;
      case "--dup-sample-limit":
        args.dupSampleLimit = Number(next());
        break;
      case "--sample-seed":
        args.sampleSeed = Number(next());
        break;
      case "--help":
      case "-h":
        console.log(
          "usage: memory-metrics [--db <path>] [--limit N] [--since ISO] [--json] [--journal-dir <dir>] [--journal-files N] [--config <config-override.json>] [--atomic-max-chars N] [--dup-threshold 0..1] [--dup-sample-limit N] [--sample-seed N]",
        );
        process.exit(0);
        break;
      default:
        if (a.startsWith("-")) {
          console.error(`unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

/**
 * F6① 同期翻台读数（**分子分母同窗口**）：口径与实现见
 * src/core/metrics/churn-window.ts（readChurnWindow），此处只负责取数编排。
 */
function readRows(args: Args): {
  rows: L1MetricRow[];
  archivedInWindow: number;
  liveInWindow: number | null;
  windowFrom: string | null;
  scanned: number;
} {
  const db = new DatabaseSync(args.db, { readOnly: true });
  try {
    const where = args.since ? "WHERE created_time >= ?" : "";
    const sql = `SELECT record_id, type, content, created_time, metadata_json FROM l1_records ${where} ORDER BY created_time DESC LIMIT ?`;
    const stmt = db.prepare(sql);
    const raw = (args.since ? stmt.all(args.since, args.limit) : stmt.all(args.limit)) as Array<
      Record<string, unknown>
    >;
    const rows: L1MetricRow[] = raw.map((r) => {
      let metadata: Record<string, unknown> | null = null;
      const mj = r.metadata_json;
      if (typeof mj === "string" && mj.length > 0) {
        try {
          metadata = JSON.parse(mj) as Record<string, unknown>;
        } catch {
          metadata = null;
        }
      }
      return {
        recordId: String(r.record_id ?? ""),
        type: String(r.type ?? "unknown"),
        content: String(r.content ?? ""),
        createdAt: (r.created_time as string | null) ?? null,
        metadata,
      };
    });
    const { archived, live, windowFrom } = readChurnWindow(db, rows, args.since);
    const scanned = Number(
      (
        (args.since
          ? db.prepare("SELECT COUNT(*) AS c FROM l1_records WHERE created_time >= ?").get(args.since)
          : db.prepare("SELECT COUNT(*) AS c FROM l1_records").get()) as { c?: number } | undefined
      )?.c ?? 0,
    );
    return { rows, archivedInWindow: archived, liveInWindow: live, windowFrom, scanned };
  } finally {
    db.close();
  }
}

function readJournal(args: Args): { entries: RecallJournalEntry[]; files: number } {
  let files: string[] = [];
  try {
    files = readdirSync(args.journalDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(args.journalDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, args.journalFiles);
  } catch {
    return { entries: [], files: 0 };
  }
  const entries: RecallJournalEntry[] = [];
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as RecallJournalEntry & { ts?: string };
        if (args.since && e.ts && e.ts < args.since) continue;
        entries.push(e);
      } catch {
        // 坏行跳过（journal 是追加写，断电可能留半行）
      }
    }
  }
  return { entries, files: files.length };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  // F6⑤：atomicMaxChars 跟随配置（CLI 显式 > config-override > parseConfig 缺省），三者同一 clamp。
  const atomic = resolveAtomicMaxChars({ cli: args.atomicMaxChars, configPath: args.config });
  const { rows, archivedInWindow, liveInWindow, windowFrom, scanned } = readRows(args);
  const { entries, files } = readJournal(args);
  const l1 = computeL1Metrics(rows, {
    atomicMaxChars: atomic.value,
    dupThreshold: args.dupThreshold,
    archivedInWindow,
    liveInWindow: liveInWindow ?? undefined,
    dupSampleLimit: args.dupSampleLimit,
    sampleSeed: args.sampleSeed,
  });
  const recall = computeRecallMetrics(entries);
  // F6⑥：采样四件套显式化（sampledRows / totalRows / limit / limitSource）。
  const sampling = describeSampling({
    sampledRows: rows.length,
    totalRows: scanned,
    limit: args.limit,
    limitSource: args.limitSource,
  });
  const { limitSource: _limitSource, ...cliArgs } = args;
  const report = {
    generatedAt: new Date().toISOString(),
    args: { ...cliArgs, atomicMaxChars: atomic.value },
    atomicMaxChars: atomic,
    sampling,
    archiveWindow: {
      from: windowFrom,
      archived: l1.churn.archived,
      live: l1.churn.live,
      ratio: l1.churn.ratio,
      // A：分子分母口径字符串随数一起给，避免只改数不改口径
      numerator: "COUNT(l1_archive) WHERE archived_at >= windowFrom",
      denominator: "COUNT(l1_records) WHERE created_time >= windowFrom",
    },
    scanned,
    l1,
    recall,
    journalFiles: files,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const churnRatio = l1.churn.ratio === null ? "null（未取得同期分母）" : pct(l1.churn.ratio);
  const churnDenom = l1.churn.live === null ? "live=null" : `${l1.churn.archived}+${l1.churn.live}`;
  const windowSource = args.since ? "--since" : "采样最老行 created_time";
  const lines: string[] = [];
  lines.push(`# 记忆指标（${report.generatedAt}）`);
  lines.push("");
  lines.push(
    `- 库：\`${args.db}\`（readOnly；全库 ${scanned} 行，本次采样 ${rows.length} 行${args.since ? `，since=${args.since}` : ""}）`,
  );
  lines.push(
    `- 采样：sampledRows=${sampling.sampledRows} / totalRows=${sampling.totalRows}，limit=${sampling.limit}，` +
      `limitSource=${sampling.limitSource}（${sampling.limitSource === "cli" ? "--limit 显式" : "脚本缺省，非全库"}），占 ${pct(sampling.coverage)}`,
  );
  lines.push(
    `- journal：\`${args.journalDir}\`（${files} 个文件；有 selection ${recall.coverage.withSelection} 轮 / 无 selection ${recall.coverage.withoutSelection} 轮）`,
  );
  lines.push(
    `- atomicMaxChars=${atomic.value}（来源 ${atomic.source}；config=\`${args.config}\`；parseConfig 缺省 ${atomic.parsedDefault}）`,
  );
  lines.push("");
  lines.push("| 指标 | 分子/分母 | 读数 | 说明 |");
  lines.push("|---|---|---|---|");
  lines.push(`| total | — | ${l1.total} | 采样行数 |`);
  lines.push(`| avgLen | 字符和/${l1.total} | ${l1.avgLen.toFixed(1)} | 平均字符长度 |`);
  lines.push(
    `| selfNarrationRate | ${l1.selfNarration.count}/${l1.total} | ${pct(l1.selfNarration.rate)} | 启发式判定（metadata.actor=agent 或主语+动作词）；读侧只丢标签行，会漏无主语自述 |`,
  );
  lines.push(
    `| actorLabeledRate | ${l1.actorLabeled.count}/${l1.total} | ${pct(l1.actorLabeled.rate)} | 仅写侧标签 metadata.actor='agent'；与 selfNarrationRate 不合并（差值=未打标签的自述行） |`,
  );
  lines.push(
    `| atomicityRate | ${l1.atomicity.both}/${l1.total} | ${pct(l1.atomicity.rate)} | 长度≤${atomic.value}（来源 ${atomic.source}）且单断言 |`,
  );
  lines.push(
    `| semanticDupRate@${l1.semanticDup.threshold} | ${l1.semanticDup.pairs} 对/${l1.semanticDup.compared} 对 ` +
      `（随机采样 ${l1.semanticDup.sampled} 行；seed ${args.sampleSeed ?? 20261102}） | ${pct(l1.semanticDup.rate)} | 方法 ${l1.semanticDup.method} |`,
  );
  lines.push(
    `| factsCoverage | ${l1.factsCoverage.count}/${l1.total} | ${pct(l1.factsCoverage.rate)} | 带 facts/factTriples 的行 |`,
  );
  lines.push(
    `| churn | ${l1.churn.archived}/(${churnDenom}) | ${churnRatio} | 同期翻台：分子 COUNT(l1_archive WHERE archived_at ≥ ${windowFrom ?? "—"})，分母 COUNT(l1_records WHERE created_time ≥ 同一窗口起点)；窗口起点来源 ${windowSource} |`,
  );
  lines.push(
    `| recall injectedCharsP50 | — | ${recall.injectedCharsP50} | 仅 selection != null 的 ${recall.rounds} 轮，selection.injectedChars 中位 |`,
  );
  lines.push(
    `| recall zeroInjectionRate | ${recall.zeroInjectionRounds}/${recall.rounds} | ${pct(recall.zeroInjectionRate)} | selection.injected=0 的轮；分母含空池轮（emptyPool 标记），回答「用户这轮到底有没有拿到记忆」 |`,
  );
  lines.push(
    `| recall emptyPoolRounds | ${recall.emptyPoolRounds}/${recall.rounds} | ${pct(recall.rounds > 0 ? recall.emptyPoolRounds / recall.rounds : 0)} | 候选池为空的轮（L1/scene/persona 全空）：写零观测但仍计入分母，免得空池静默抬高命中率 |`,
  );
  lines.push(
    `| recall zeroInjectionRateNonEmpty | ${recall.zeroInjectionRoundsNonEmpty}/${recall.rounds - recall.emptyPoolRounds} | ${pct(recall.zeroInjectionRateNonEmpty)} | 只算非空池轮：召回到东西时选线是否把它全砍掉；与上面全额口径不可混读 |`,
  );
  lines.push(
    `| recall avgInjectedLines | 注入行和/${recall.rounds} | ${recall.avgInjectedLines.toFixed(2)} | 取 selection.injected（不用候选池长度） |`,
  );
  lines.push(
    `| recall coverage | ${recall.coverage.withSelection}/${recall.coverage.withSelection + recall.coverage.withoutSelection} | ${pct(recall.coverage.rate)} | journal 轮里带 selection 的占比（口径覆盖度，单列） |`,
  );
  lines.push(
    `| recallPoolAnchorRate | ${recall.anchorLines}/${recall.totalInjectedLines} | ${pct(recall.poolAnchorRate)} | 取样面 ${recall.precisionScope}（候选池行含日期/时刻/file:line/短哈希）；旧名 recallPrecisionProxy 同值 ${pct(recall.precisionProxy)} 保留 |`,
  );
  lines.push("");
  lines.push(
    `类型分布：${
      Object.entries(l1.typeDistribution)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "（空）"
    }`,
  );
  console.log(lines.join("\n"));
}

main();
