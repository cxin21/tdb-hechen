/**
 * #84 —— L0 存量分类回填（UPDATE-only，零删除，零内容改写）。
 *
 * 契约（cxin21/tdb-hechen#84；前置 #83 已合入，影子期经用户豁免走真实数据验收）：
 * - 目标 = l0_conversations 中 role='user' 且 classification='unclassified' 的存量行；
 * - 判定 = 单一事实源 MemoryProxy/src/common/intent-classifier.ts 逐行独立分类；
 *   历史 session-probe 测试行（整条精确等于
 *   「探针消息：验证 L0 写入链路，本条可安全忽略。」，票面指名的软失效对象）显式覆写为 scaffold（分类器对其判 real，需按票面覆写；不物理删除）；
 * - 写 = UPDATE 仅 classification 列，WHERE 带 AND classification='unclassified' 双保险
 *   防覆盖；单个 IMMEDIATE 事务；缺省 dry-run 零写，--write 才落库；
 * - 断言 = 总行数前后一致 + 非 classification 列逐行 FNV-1a 指纹前后一致 +
 *   实际更新行数==计划数；断言失败退出码 1。
 *
 * 用法：
 *   node --import tsx scripts/backfill-l0-classification.ts --db <vectors.db>            # dry-run（零写）
 *   node --import tsx scripts/backfill-l0-classification.ts --db <vectors.db> --write    # 执行
 *   可选 --limit N（只处理前 N 行）、--report <json 路径>（计划与统计落盘）
 */
import { classifyInbound } from "../../MemoryProxy/src/common/intent-classifier.js";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** 票面指名的历史测试行（session-probe 探针消息）全文：仅整条等于该文本才覆写；压缩摘要里引用探针句的行走分类器（同为 scaffold），避免 reason 误归因 */
export const PROBE_TEXT_EXACT = "探针消息：验证 L0 写入链路，本条可安全忽略。";

export interface L0BackfillDb {
  prepare(sql: string): {
    all(...params: never[]): unknown[];
    run(...params: never[]): { changes: number | bigint | null };
  };
  exec(sql: string): void;
}

export interface BackfillL0ClassificationDeps {
  db: L0BackfillDb;
  /** false = dry-run（零写）；true = 单个 IMMEDIATE 事务落库 */
  write: boolean;
  limit?: number;
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export interface BackfillPlanEntry {
  recordId: string;
  classification: string;
  reason: "probe-override" | "classifier";
  textPreview: string;
}

export interface BackfillL0ClassificationResult {
  mode: "dry-run" | "write";
  beforeCount: number;
  afterCount: number;
  targets: number;
  updated: number;
  plan: BackfillPlanEntry[];
  distributionUser: Record<string, number>;
  distributionAll: Record<string, number>;
  fingerprintBefore: string;
  fingerprintAfter: string;
  assertOk: boolean;
  assertionFailures: string[];
}

/** 单行判定：探针测试行覆写 scaffold；其余交给分类器（单一事实源，逐行独立调用） */
export function classifyL0Row(messageText: string): { classification: string; reason: "probe-override" | "classifier" } {
  if (messageText.trim() === PROBE_TEXT_EXACT) {
    return { classification: "scaffold", reason: "probe-override" };
  }
  const ctx = classifyInbound([{ role: "user", content: messageText }]);
  return { classification: ctx.classified[0]?.classification ?? "unknown", reason: "classifier" };
}

const TARGET_SQL =
  "SELECT record_id, message_text FROM l0_conversations WHERE role='user' AND classification='unclassified' ORDER BY rowid";
const GUARDED_UPDATE_SQL =
  "UPDATE l0_conversations SET classification=? WHERE record_id=? AND classification='unclassified'";

/** 非 classification 列指纹：FNV-1a 32bit，全表按 rowid 折叠；前后一致 ⟺ 除 classification 外零改动 */
const FINGERPRINT_SQL =
  "SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp FROM l0_conversations ORDER BY rowid";
const FP_COLUMNS = [
  "record_id", "session_key", "session_id", "team_id", "task_id",
  "user_id", "agent_id", "role", "message_text", "recorded_at", "timestamp",
] as const;

function fingerprintAll(db: L0BackfillDb): string {
  const rows = db.prepare(FINGERPRINT_SQL).all() as Array<Record<string, unknown>>;
  let h = 0x811c9dc5;
  const fold = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  for (const r of rows) {
    fold(FP_COLUMNS.map((c) => (r[c] === null || r[c] === undefined ? "\u0000N" : String(r[c]))).join("\u001f") + "\u001e");
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function countAll(db: L0BackfillDb): number {
  const rows = db.prepare("SELECT COUNT(*) AS n FROM l0_conversations").all() as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

function groupCount(db: L0BackfillDb, where: string): Record<string, number> {
  const rows = db.prepare(
    "SELECT classification AS c, COUNT(*) AS n FROM l0_conversations " + where + " GROUP BY classification ORDER BY c",
  ).all() as Array<{ c: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.c] = Number(r.n);
  return out;
}

function planStats(plan: BackfillPlanEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of plan) out[p.classification] = (out[p.classification] ?? 0) + 1;
  return out;
}

export async function runBackfillL0Classification(deps: BackfillL0ClassificationDeps): Promise<BackfillL0ClassificationResult> {
  const { db, write, logger } = deps;
  const mode: BackfillL0ClassificationResult["mode"] = write ? "write" : "dry-run";

  const beforeCount = countAll(db);
  const fingerprintBefore = fingerprintAll(db);
  const targetRows = (db.prepare(TARGET_SQL).all() as Array<{ record_id: string; message_text: string }>).slice(0, deps.limit);
  const plan: BackfillPlanEntry[] = targetRows.map((row) => {
    const d = classifyL0Row(row.message_text);
    return { recordId: row.record_id, classification: d.classification, reason: d.reason, textPreview: row.message_text.slice(0, 80) };
  });

  let updated = 0;
  if (write && targetRows.length > 0) {
    const upd = db.prepare(GUARDED_UPDATE_SQL);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < targetRows.length; i++) {
        const res = upd.run(plan[i].classification, targetRows[i].record_id);
        updated += Number(res.changes ?? 0);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  const afterCount = countAll(db);
  const fingerprintAfter = fingerprintAll(db);
  const assertionFailures: string[] = [];
  if (beforeCount !== afterCount) {
    assertionFailures.push("总行数变化 " + beforeCount + "→" + afterCount + "（违反零删除/零注入红线）");
  }
  if (fingerprintBefore !== fingerprintAfter) {
    assertionFailures.push("非 classification 列指纹不匹配 " + fingerprintBefore + "→" + fingerprintAfter + "（违反仅 classification 可变红线）");
  }
  if (write && updated !== targetRows.length) {
    assertionFailures.push("更新行数 " + updated + " != 计划行数 " + targetRows.length);
  }

  const distributionUser = groupCount(db, "WHERE role='user'");
  const distributionAll = groupCount(db, "");
  const result: BackfillL0ClassificationResult = {
    mode, beforeCount, afterCount, targets: targetRows.length, updated, plan,
    distributionUser, distributionAll, fingerprintBefore, fingerprintAfter,
    assertOk: assertionFailures.length === 0, assertionFailures,
  };
  logger.info("[backfill-l0-classification] mode=" + mode + " targets=" + result.targets + " updated=" + updated);
  logger.info("[backfill-l0-classification] planStats=" + JSON.stringify(planStats(plan)));
  logger.info("[backfill-l0-classification] assertOk=" + result.assertOk + (assertionFailures.length ? " failures=" + assertionFailures.join("；") : ""));
  logger.info("[backfill-l0-classification] distributionUser=" + JSON.stringify(distributionUser) + " distributionAll=" + JSON.stringify(distributionAll));
  return result;
}

const USAGE =
  "用法：node --import tsx scripts/backfill-l0-classification.ts --db <vectors.db> [--write] [--limit N] [--report <json>]";

function parseArgs(argv: string[]): { db?: string; write: boolean; limit?: number; report?: string } {
  const args: { db?: string; write: boolean; limit?: number; report?: string } = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") args.db = argv[++i];
    else if (a === "--write") args.write = true;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--report") args.report = argv[++i];
    else {
      console.error("未知参数：" + a);
      console.error(USAGE);
      process.exit(2);
    }
  }
  return args;
}

/** 边界样本：每类取第一个 + 计划最后一条，供人工复核 */
function pickBoundary(plan: BackfillPlanEntry[]): BackfillPlanEntry[] {
  const picked: BackfillPlanEntry[] = [];
  const seen = new Set<string>();
  for (const p of plan) {
    if (!seen.has(p.classification)) {
      seen.add(p.classification);
      picked.push(p);
    }
  }
  const last = plan[plan.length - 1];
  if (last && !picked.includes(last)) picked.push(last);
  return picked;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db) {
    console.error(USAGE);
    process.exit(2);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = path.resolve(args.db);
  const db = new DatabaseSync(dbPath, { readOnly: !args.write });
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    const result = await runBackfillL0Classification({ db, write: args.write, limit: args.limit, logger: console });
    if (args.report) {
      const report = {
        tool: "backfill-l0-classification",
        issue: "cxin21/tdb-hechen#84",
        db: dbPath,
        ranAt: new Date().toISOString(),
        ...result,
        planStats: planStats(result.plan),
        boundarySamples: pickBoundary(result.plan),
      };
      const reportPath = path.resolve(args.report);
      const fs = await import("node:fs/promises");
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
      console.log("report → " + reportPath);
    }
    if (!result.assertOk) process.exit(1);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
