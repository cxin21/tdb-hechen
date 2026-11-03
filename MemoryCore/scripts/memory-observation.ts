#!/usr/bin/env tsx
/**
 * P1–P7 观察窗读数（**只读**）。2026-11-02 上线后用于取"生产是不是真的这么跑"的证据。
 *
 * 用法（在 MemoryCore/ 下）：
 *   npm run memory:observe                       # 最近 24h 读数（人读 Markdown）
 *   npm run memory:observe -- --hours 6 --json    # 机读 JSON
 *   npm run memory:observe -- --data-dir D:/TDB/data --db D:/TDB/data/vectors.db
 *
 * 口径与证据边界见 docs/ops/2026-11-02-layering-observation.md。红线：数据库 readOnly，
 * 日志/journal 只读；不写任何文件、不改任何一行。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { computeRecallMetrics, type RecallJournalEntry } from "../src/core/metrics/memory-metrics.js";
import {
  aggregateDedupBatches,
  parseLogTimestamp,
  scanLogLines,
  summarizeJournalGates,
  summarizeSceneSizes,
} from "../src/core/metrics/observation-scan.js";

interface Args {
  dataDir: string;
  db: string;
  hours: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dataDir: "D:/TDB/data", db: "D:/TDB/data/vectors.db", hours: 24, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    switch (a) {
      case "--data-dir":
        args.dataDir = next();
        break;
      case "--db":
        args.db = next();
        break;
      case "--hours":
        args.hours = Number(next());
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
        console.log("usage: memory-observation [--data-dir <dir>] [--db <path>] [--hours N] [--json]");
        process.exit(0);
        break;
      default:
        if (a.startsWith("-")) {
          console.error(`unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  if (!Number.isFinite(args.hours) || args.hours <= 0) {
    console.error("--hours must be a positive number");
    process.exit(2);
  }
  return args;
}

interface LogSlice {
  lines: string[];
  files: number;
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * 读窗口内 core 日志。
 * - 每个进程日志有两份（.out.log 与 .out.log.tee.log，后者编码稳定）：按"同一 stem 只取一份"去重，
 *   不能"有 tee 就只用 tee"——老进程可能只有 .out.log，那样会把整段窗口漏掉。
 * - 时间戳统一走 parseLogTimestamp（不截断偏移串）。
 */
function readLogLines(dir: string, since: number): LogSlice {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith("tdai-core-") && f.endsWith(".log"));
  } catch {
    return { lines: [], files: 0, firstTs: null, lastTs: null };
  }
  const byStem = new Map<string, string>();
  for (const f of files) {
    const stem = f.replace(/\.tee\.log$/, "").replace(/\.out\.log$/, "");
    const isTee = f.endsWith(".tee.log");
    const prev = byStem.get(stem);
    if (!prev || isTee) byStem.set(stem, f);
  }
  const lines: string[] = [];
  let used = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const f of byStem.values()) {
    const full = path.join(dir, f);
    let mtime = 0;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < since) continue;
    let text = "";
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    let fileUsed = false;
    for (const line of text.split(/\r?\n/)) {
      const ts = parseLogTimestamp(line);
      if (!Number.isFinite(ts) || ts < since) continue;
      lines.push(line);
      fileUsed = true;
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    if (fileUsed) used += 1;
  }
  return { lines, files: used, firstTs, lastTs };
}

function readJournalEntries(dir: string, since: number): RecallJournalEntry[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const entries: RecallJournalEntry[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let mtime = 0;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < since) continue;
    let text = "";
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        const o = JSON.parse(line) as RecallJournalEntry & { ts?: string };
        const ts = o.ts ? Date.parse(o.ts) : Number.NaN;
        if (Number.isFinite(ts) && ts < since) continue;
        entries.push(o);
      } catch {
        /* 半行/坏行：跳过，不猜 */
      }
    }
  }
  return entries;
}

function sceneBlocks(dataDir: string): { sizes: number[]; modifiedSizes: number[] } {
  const profiles = path.join(dataDir, "profiles");
  const sizes: number[] = [];
  const modified: number[] = [];
  let scopes: string[] = [];
  try {
    scopes = readdirSync(profiles);
  } catch {
    return { sizes, modifiedSizes: modified };
  }
  const since = Date.now() - 24 * 3600 * 1000;
  for (const scope of scopes) {
    const dir = path.join(profiles, scope, "scene_blocks");
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const st = statSync(full);
        sizes.push(st.size);
        if (st.mtimeMs >= since) modified.push(st.size);
      } catch {
        /* 竞态：跳过 */
      }
    }
  }
  return { sizes, modifiedSizes: modified };
}

function dbCounts(dbPath: string): Record<string, number> {
  const out: Record<string, number> = {};
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const one = (sql: string): number => {
      const row = db!.prepare(sql).get() as { n?: number } | undefined;
      return Number(row?.n ?? 0);
    };
    out.l1Records = one("select count(*) as n from l1_records");
    out.l1Archived = one("select count(*) as n from l1_archive");
    out.l1ValidEndSet = one("select count(*) as n from l1_records where valid_end is not null and valid_end != ''");
    out.l1ActorAgent = one(
      "select count(*) as n from l1_records where json_extract(metadata_json, '$.actor') = 'agent'",
    );
  } catch (err) {
    out.error = 0;
    console.error(`[memory-observation] db read failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const since = Date.now() - args.hours * 3600 * 1000;
  const logSlice = readLogLines(path.join(args.dataDir, "logs"), since);
  const logs = scanLogLines(logSlice.lines);
  const dedup = aggregateDedupBatches(logs.dedupBatches);
  const consolidation = {
    runs: logs.consolidationRuns.length,
    meanGroups:
      logs.consolidationRuns.length > 0
        ? Math.round((logs.consolidationRuns.reduce((a, r) => a + r.groups, 0) / logs.consolidationRuns.length) * 100) /
          100
        : null,
    meanSources:
      logs.consolidationRuns.length > 0
        ? Math.round(
            (logs.consolidationRuns.reduce((a, r) => a + r.sources, 0) / logs.consolidationRuns.length) * 100,
          ) / 100
        : null,
    // 2026-11-02 新增：源集合指纹未变而跳过的组（0 LLM 调用）合计。
    // 旧日志无该字段 ⇒ 只数有字段的行，且样本为 0 时报 null 而不是 0（不拿 0 冒充"跑过但没跳过"）。
    skippedUnchanged: logs.consolidationRuns.some((r) => r.skippedUnchanged !== undefined)
      ? logs.consolidationRuns.reduce((a, r) => a + (r.skippedUnchanged ?? 0), 0)
      : null,
  };
  const entries = readJournalEntries(path.join(args.dataDir, "logs", "recall"), since);
  const recall = computeRecallMetrics(entries);
  const gates = summarizeJournalGates(entries);
  const sceneAll = sceneBlocks(args.dataDir);
  const scene = summarizeSceneSizes(sceneAll.sizes);
  const sceneInWindow = summarizeSceneSizes(sceneAll.modifiedSizes);
  const db = dbCounts(args.db);

  const report = {
    window: {
      hours: args.hours,
      since: new Date(since).toISOString(),
      until: new Date().toISOString(),
      // 日志覆盖率：轮转会切掉窗口头部，读数只在覆盖段内成立（诚实边界，不是脚注）。
      logCoverage: {
        files: logSlice.files,
        firstTs: logSlice.firstTs === null ? null : new Date(logSlice.firstTs).toISOString(),
        lastTs: logSlice.lastTs === null ? null : new Date(logSlice.lastTs).toISOString(),
      },
    },
    a1: {
      l2Enqueued: logs.l2Enqueued,
      l2Completed: logs.l2Completed,
      l2GateSkips: logs.l2GateSkips,
      // F2：全局节流拦截次数（与门拦截分开——两者拦的理由不同）。
      l2ThrottleSkips: logs.l2ThrottleSkips,
      l2SkippedInvalidated: logs.l2SkippedInvalidated,
      l2Extracted: logs.l2Extracted,
    },
    b1: consolidation,
    b4: dedup,
    b2: {
      roundsWithValidity: gates.roundsWithValidity,
      // F7：三层口径分开报——pool 是"池里被看见多少"，injected 才是"注入少了几行"。
      validityPoolDropped: gates.validityDropped,
      validityTopDropped: gates.validityTopDropped,
      validityInjectedDropped: gates.validityInjectedDropped,
      validityEndFiltered: gates.validityEndFiltered,
      validityExpired: gates.validityExpired,
      validityFuture: gates.validityFuture,
    },
    a3: { roundsWithSelfNarration: gates.roundsWithSelfNarration, selfNarrationDropped: gates.selfNarrationDropped },
    b3: { sceneBlocks: scene, sceneBlocksInWindow: sceneInWindow },
    recall,
    db,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const lines = [
    `# 观察窗读数（最近 ${args.hours}h：${report.window.since} → ${report.window.until}）`,
    `- 日志覆盖：${report.window.logCoverage.files} 个文件，${report.window.logCoverage.firstTs ?? "—"} → ${report.window.logCoverage.lastTs ?? "—"}（A1/B1/B4 读数仅在此段内成立）`,
    "",
    `## A1 L2 触发门`,
    `- 调度入队（跑了多少次）：${report.a1.l2Enqueued}`,
    `- 任务完成：${report.a1.l2Completed}，真写块：${report.a1.l2Extracted}，候选全失效跳过：${report.a1.l2SkippedInvalidated}`,
    `- 门拦截（gate-skip，每会话条数/时间门）：${report.a1.l2GateSkips}`,
    `- 全局节流拦截（l2-throttle，F2）：${report.a1.l2ThrottleSkips}`,
    "",
    `## B1 L3 换键归组`,
    `- 巩固运行：${consolidation.runs} 次，平均 groups=${consolidation.meanGroups ?? "—"}，平均 sources=${consolidation.meanSources ?? "—"}`,
    `- 指纹未变跳过（合计）：${consolidation.skippedUnchanged === null ? "—（旧日志无该字段）" : consolidation.skippedUnchanged}`,
    "",
    `## B4 dedup 前置门槛`,
    `- 批次：${dedup.batches}，LLM 调用合计：${dedup.llmCalls}，均值=${dedup.meanLlmCallsPerBatch ?? "—"} 次/批`,
    `- 候选合计：${dedup.candidateTotal}，前置淘汰：${dedup.prefiltered}`,
    "",
    `## B2 效期计数（journal）`,
    `- 带 validity 门的轮次：${gates.roundsWithValidity}`,
    `- 池口径 dropped=${gates.validityDropped}（截断前全池，诊断用）；top dropped=${gates.validityTopDropped}；**注入口径 injected.dropped=${gates.validityInjectedDropped}（真少注入的行数）**`,
    `- 过期=${gates.validityExpired}，未来=${gates.validityFuture}，validEndFiltered=${gates.validityEndFiltered}（=池口径，兼容旧读数）`,
    "",
    `## A3 自述过滤`,
    `- 带 selfNarration 门的轮次：${gates.roundsWithSelfNarration}，丢弃行=${gates.selfNarrationDropped}`,
    "",
    `## B3 scene 块字节`,
    `- 全部：${scene.files} 块，总 ${scene.totalBytes}B，p50=${scene.p50Bytes ?? "—"}B，max=${scene.maxBytes}B`,
    `- 窗口内改动：${sceneInWindow.files} 块，p50=${sceneInWindow.p50Bytes ?? "—"}B，max=${sceneInWindow.maxBytes}B`,
    "",
    `## 召回读数（journal）`,
    `- 轮次：${recall.rounds}，零注入率：${(recall.zeroInjectionRate * 100).toFixed(1)}%，注入字符 p50=${recall.injectedCharsP50}`,
    `- 平均注入行：${recall.avgInjectedLines.toFixed(2)}，precisionProxy=${(recall.precisionProxy * 100).toFixed(1)}%`,
    "",
    `## 库内计数`,
    `- l1_records=${db.l1Records ?? "—"}，l1_archive=${db.l1Archived ?? "—"}，valid_end 非空=${db.l1ValidEndSet ?? "—"}，actor=agent=${db.l1ActorAgent ?? "—"}`,
  ];
  console.log(lines.join("\n"));
}

main();
