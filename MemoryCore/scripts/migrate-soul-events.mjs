#!/usr/bin/env node
/**
 * P0-D 迁移：旧灵魂表 → 事件底座（spec docs/specs/2026-11-10-soul-event-model-full-optimization.md §5.1）
 *
 *   soul_episodes        → soul_events + soul_event_chat + soul_event_evidence
 *   soul_emotions        → 回填 event_id（= episode_id）
 *   soul_person_relation → 回填 event_id（record_id 经 evidence 反查，查不到留 NULL）
 *   soul_promises        → soul_goals(kind=commitment) + 回填 goal_id
 *
 * 用法：
 *   node scripts/migrate-soul-events.mjs --db <path>                     # dry-run（只读，一个字节都不写）
 *   node scripts/migrate-soul-events.mjs --db <path> --apply             # 建表 → 逐租户事务写入 → 对账
 *   node scripts/migrate-soul-events.mjs --db <path> --apply --tenant t/u/a   # 只迁一个租户（可重复）
 *   node scripts/migrate-soul-events.mjs --db <path> --apply --allow-production
 *
 * 安全边界：
 *   - --db 必填，没有「默认库」这种东西（误连生产是本任务的第一号风险）；
 *   - 缺省 dry-run，以 readOnly 打开，未加 --apply 时一个字节都不写；
 *   - D:/TDB/data/vectors.db 是生产库：不给 --allow-production 就直接拒绝（dry-run 也拒），
 *     给了也必须先看到「备份 / 字节 / sha256」的阻断提示；
 *   - 每租户一个 BEGIN IMMEDIATE/COMMIT，单租户失败只回滚该租户（已提交的不回退，可续跑）；
 *   - 全量 INSERT OR IGNORE + 只回填 NULL，重跑幂等（第二次写入行数应为 0）。
 *
 * 退出码：0 = 成功且对账通过；1 = 对账有 diff；2 = 参数/安全拒绝；3 = 执行错误。
 *
 * 为什么要重新执行自身：DDL 与映射的唯一一份都在 src 下的 .ts（soul-event-ddl.ts /
 * scripts/lib/soul-event-migration.mjs→前者），本脚本用 tsx loader 自举，避免手抄建表语句。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TSX_ENV = "__MIGRATE_SOUL_EVENTS_TSX__";
if (!process.env[TSX_ENV]) {
  const child = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, [TSX_ENV]: "1" } },
  );
  process.exit(typeof child.status === "number" ? child.status : 1);
}

const { DatabaseSync } = await import("node:sqlite");
const lib = await import("./lib/soul-event-migration.mjs");

const TAG = lib.TAG;
const USAGE = [
  "用法：node scripts/migrate-soul-events.mjs --db <path> [--apply] [--tenant team/user/agent] [--allow-production] [--json]",
  "  --db <path>          必填：要迁移的 sqlite 库（D:/TDB/data/vectors.db 需额外 --allow-production）",
  "  --apply              真正写入；缺省是只读 dry-run",
  "  --tenant t/u/a       只迁该租户（team_id/user_id/agent_id），可重复",
  "  --allow-production   允许碰生产库 D:/TDB/data/vectors.db（会先打印备份/字节/sha256 提示）",
  "  --json               末尾额外打印一行机器可读 JSON",
].join("\n");

function die(code, message) {
  console.error(TAG + " " + message);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { db: null, apply: false, tenants: [], allowProduction: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--db") opts.db = argv[++i] ?? null;
    else if (a.startsWith("--db=")) opts.db = a.slice(5);
    else if (a === "--apply") opts.apply = true;
    else if (a === "--tenant") opts.tenants.push(argv[++i] ?? "");
    else if (a.startsWith("--tenant=")) opts.tenants.push(a.slice(9));
    else if (a === "--allow-production") opts.allowProduction = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else die(2, "未知参数：" + a + "\n" + USAGE);
  }
  return opts;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "未知";
  return n + " 字节";
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!opts.db) die(2, "缺 --db <path>（本脚本故意没有默认库）\n" + USAGE);

const DB_PATH = lib.normalizeDbPath(opts.db);
if (!fs.existsSync(DB_PATH)) die(3, "数据库不存在：" + DB_PATH);
if (!fs.statSync(DB_PATH).isFile()) die(3, "不是文件：" + DB_PATH);

const tenants = opts.tenants.map((s) => lib.parseTenantSpec(s));
const production = lib.isProductionDb(DB_PATH);

if (production && !opts.allowProduction) {
  die(
    2,
    [
      "拒绝操作生产库：" + DB_PATH,
      "  这是 soul 记忆的生产库，迁移会建表/写行/加列，误操作无法靠重跑恢复。",
      "  确实要动它，请：1) 先做一致性备份并核对字节+sha256；2) 再显式加 --allow-production。",
      "  备份命令（只读连接 + VACUUM INTO，含 WAL 内容）：",
      "    node -e \"const {DatabaseSync}=require('node:sqlite');new DatabaseSync('" + DB_PATH + "').prepare('VACUUM INTO ?').run('" + DB_PATH + ".bak-' + Date.now() + '.db')\"",
    ].join("\n"),
  );
}

if (production) {
  const bytes = lib.fileBytes(DB_PATH);
  const sha = await lib.sha256File(DB_PATH);
  console.log(TAG + " ⚠ 生产库路径：" + DB_PATH);
  console.log(TAG + " ⚠ 当前字节：" + fmtBytes(bytes) + "   sha256：" + sha);
  console.log(TAG + " ⚠ 阻断提示：写库前必须有 VACUUM INTO 备份，备份后逐项核对「字节数一致 + sha256 一致」。");
  console.log(TAG + " ⚠ 备份示例：node -e \"const {DatabaseSync}=require('node:sqlite');new DatabaseSync('" + DB_PATH +
    "').prepare('VACUUM INTO ?').run('" + DB_PATH + ".bak-' + Date.now() + '.db')\"");
  if (opts.apply) {
    console.log(TAG + " ⚠ 这次是 --apply：上面的备份没有由本脚本创建，确认备份可回滚后再继续。");
  }
}

const mode = opts.apply ? "apply" : "dry-run";
const db = new DatabaseSync(DB_PATH, { readOnly: !opts.apply });
let exitCode = 0;
let report = null;

try {
  const before = { bytes: lib.fileBytes(DB_PATH) };
  const hasEvents = lib.tableExists(db, "soul_events");
  console.log(
    TAG + " 库：" + DB_PATH + "（" + fmtBytes(before.bytes) + "，模式 " + mode +
      (tenants.length ? "，租户限定 " + tenants.map(lib.formatTenant).join(", ") : "") + "）",
  );
  console.log(TAG + " 目标表 soul_events 现状：" + (hasEvents ? "已存在" : "不存在（--apply 时先建表）"));

  if (opts.apply) {
    const schema = await lib.ensureTargetSchema(db);
    console.log(TAG + " DDL 就位：建表/索引 " + schema.ddlCount + " 条；ALTER 跳过缺失表 " + schema.skippedTables.length + " 个");
  }

  const plan = lib.planMigration(db, { tenants });
  const t = plan.totals;

  console.log(TAG + " 旧数据：episodes " + t.episodes + " · emotions " + t.legacyEmotions +
    " · relations " + t.legacyRelations + " · promises " + t.legacyPromises +
    "（本次待回填 events " + t.events + " · emotions " + t.emotionUpdates +
    " · relations " + t.relationUpdates + " · promises " + t.promiseUpdates + "）");
  console.log(
    TAG + " 计划（" + mode + "）：events " + t.events + " · chat " + t.chat + " · evidence " + t.evidence +
      " · goals " + t.goals + " · emotions 回填 " + t.emotionUpdates + " · relations 回填 " + t.relationUpdates +
      " · promises 回填 " + t.promiseUpdates +
      (t.eventsAlreadyPresent > 0 ? " · 事件已存在（幂等跳过） " + t.eventsAlreadyPresent : ""),
  );
  console.log(
    TAG + " 不进迁移：emotion 孤儿 " + plan.skipped.emotionOrphan + " · relation 未映射 " + plan.skipped.relationUnmapped +
      " · relation 多义 " + plan.skipped.relationAmbiguous + " · promise 孤儿 " + plan.skipped.promiseOrphan,
  );
  for (const g of plan.groups) {
    const c = g.counts;
    console.log(
      TAG + "   租户 " + g.label + "：episodes " + c.episodes + " events " + c.events + " chat " + c.chat +
        " evidence " + c.evidence + " goals " + c.goals + " emotions~" + c.emotionUpdates +
        " relations~" + c.relationUpdates + " promises~" + c.promiseUpdates,
    );
  }

  let applied = null;
  if (opts.apply) {
    applied = lib.applyPlan(db, plan);
    console.log(
      TAG + " 写入合计：events +" + applied.totals.events + " chat +" + applied.totals.chat +
        " evidence +" + applied.totals.evidence + " goals +" + applied.totals.goals +
        " emotions~" + applied.totals.emotionUpdates + " relations~" + applied.totals.relationUpdates +
        " promises~" + applied.totals.promiseUpdates +
        " （已存在跳过 " + applied.totals.skippedByConflict + "）",
    );
    if (applied.failed.length > 0) {
      for (const f of applied.failed) console.error(TAG + " 失败租户 " + f.tenant + "：" + f.error);
      exitCode = 3;
    }
  }

  const parity = lib.collectParity(db, { tenants });
  console.log(TAG + " 对账：" + (parity.ok ? "一致" : "有 diff") +
    "   旧 episode " + parity.totals.legacyEpisodes + " → 迁移派生事件 " + parity.totals.events +
    " · chat " + parity.totals.chat + " · evidence " + parity.totals.evidence + " · goals " + parity.totals.goals);
  // 迁移范围外的行要单独报出来，否则操作者会以为「事件比 episode 多」是迁移多写了。
  if (parity.outOfScope.total > 0) {
    const kinds = Object.entries(parity.outOfScope.bySourceKind)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([kind, n]) => kind + " " + n)
      .join("/");
    console.log(TAG + " 迁移范围外事件 " + parity.outOfScope.total + " 条（" + kinds + "），不计入对账");
  }
  for (const b of parity.tenants) {
    console.log(
      TAG + "   租户 " + b.label + "：字段 hash " + (b.field.hash ?? "-") + "（比对 " + b.field.compared +
        " 条，不一致 " + b.field.mismatchEvents + " 条" +
        (b.field.backfillGapEvents > 0 ? "，存量缺口 " + b.field.backfillGapEvents + " 条事件" : "") + "）" +
        (b.diffs.length ? " DIFF: " + b.diffs.join("；") : " OK"),
    );
    for (const m of b.mismatches) {
      console.log(TAG + "     不一致事件 " + m.eventId + "：" + m.fields.join(", "));
    }
    for (const issue of b.issues) console.log(TAG + "     其它：" + issue);
  }
  for (const issue of parity.issues) console.log(TAG + "   全局：" + issue);

  // 存量回填缺口单独一段：它是「库里是空、期望有值」，INSERT OR IGNORE 不会覆盖已有行，
  // 属于要单独决定的缺口，不是写错值。和真 mismatch 分开列，避免操作者看混。
  const gapColumns = Object.entries(parity.totals.backfillGaps).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const gapTotal = gapColumns.reduce((sum, [, n]) => sum + n, 0);
  if (gapTotal > 0) {
    console.log(TAG + " 存量回填缺口（库里有空、期望有值；INSERT OR IGNORE 不覆盖已有行，需另行决定是否回填）：");
    for (const [col, n] of gapColumns) console.log(TAG + "   " + col + "：" + n + " 条");
    console.log(TAG + "   涉及事件 " + parity.totals.backfillGapEvents + " 条；这些字段当前不影响退出码。");
  }

  exitCode = lib.migrationExitCode({ apply: opts.apply, applied, parity });

  const summary = lib.summarizeMigrationRun({
    applied,
    parity,
    placeholderStats: lib.countPlaceholderEvidence(db),
  });
  console.log(TAG + " ── 结论 ──");
  for (const line of summary.lines) console.log(TAG + " " + line);

  report = {
    db: DB_PATH,
    mode,
    production,
    tenants: tenants.map((x) => lib.formatTenant(x)),
    plan: { totals: plan.totals, skipped: plan.skipped, groups: plan.groups.map((g) => ({ tenant: g.label, counts: g.counts })) },
    applied: applied ? { totals: applied.totals, ok: applied.ok, failed: applied.failed } : null,
    parity: {
      ok: parity.ok,
      hasTarget: parity.hasTarget,
      totals: parity.totals,
      issues: parity.issues,
      backfillGaps: parity.totals.backfillGaps,
      outOfScope: parity.outOfScope,
      tenants: parity.tenants.map((b) => ({
        tenant: b.label,
        legacy: b.legacy,
        target: b.target,
        field: b.field,
        backfillGaps: b.backfillGaps,
        diffs: b.diffs,
      })),
    },
    summary: summary.lines,
    exitCode,
  };
  console.log(TAG + " 退出码 " + exitCode + (opts.apply ? "（--apply 已执行）" : "（dry-run，未写任何字节）"));
} catch (err) {
  console.error(TAG + " 执行失败：" + (err instanceof Error ? err.stack || err.message : String(err)));
  exitCode = 3;
} finally {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
}

if (opts.json && report) console.log(JSON.stringify({ tag: "soul-event-migration", ...report }));
process.exit(exitCode);
