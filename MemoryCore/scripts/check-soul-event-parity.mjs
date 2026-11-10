#!/usr/bin/env node
/**
 * P0-D 对账（spec §5.2/§5.3）：旧灵魂表 vs 新事件底座，只读比较，不修数据。
 *
 * 比什么（口径与 migrate-soul-events.mjs 的映射是同一份 mapEpisodeRow()）：
 *   1. 旧 soul_episodes 条数 = 新 soul_events 条数（逐租户）；
 *   2. soul_event_chat 行数 = 事件数（每条事件都有 chat 行）；
 *   3. 每条事件至少一条 soul_event_evidence；
 *   4. 每条旧 episode 现场重算期望值，与落库行逐字段比对，并给每租户一个字段 hash
 *      （同一份旧数据永远算出同一个 hash，跨机器/跨次可比）；
 *   5. 0 孤儿 event_id（emotions / relations / evidence / chat 都指向真实存在的事件）；
 *   6. promise 都有 goal、goal_id 都回填。
 *
 * 用法：
 *   node scripts/check-soul-event-parity.mjs --db <path>            # 读-only，全部租户
 *   node scripts/check-soul-event-parity.mjs --db <path> --tenant t/u/a [--tenant ...] [--json]
 *
 * 退出码：0 = 全部一致；1 = 有 diff（或目标表还没建）；2 = 参数错；3 = 执行错误。
 *
 * 本脚本永远以 readOnly 打开数据库（node:sqlite 会在驱动层拒绝写），所以对生产库也是安全的：
 * 它只读，不需要 --allow-production。
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TSX_ENV = "__CHECK_SOUL_EVENT_PARITY_TSX__";
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

const TAG = "[check-soul-event-parity]";
const USAGE =
  "用法：node scripts/check-soul-event-parity.mjs --db <path> [--tenant team/user/agent] [--json]";

function die(code, message) {
  console.error(TAG + " " + message);
  process.exit(code);
}

const opts = { db: null, tenants: [], json: false, help: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--db") opts.db = argv[++i] ?? null;
  else if (a.startsWith("--db=")) opts.db = a.slice(5);
  else if (a === "--tenant") opts.tenants.push(argv[++i] ?? "");
  else if (a.startsWith("--tenant=")) opts.tenants.push(a.slice(9));
  else if (a === "--json") opts.json = true;
  else if (a === "--help" || a === "-h") opts.help = true;
  else die(2, "未知参数：" + a + "\n" + USAGE);
}

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!opts.db) die(2, "缺 --db <path>\n" + USAGE);

const DB_PATH = lib.normalizeDbPath(opts.db);
if (!fs.existsSync(DB_PATH)) die(3, "数据库不存在：" + DB_PATH);

const tenants = opts.tenants.map((s) => lib.parseTenantSpec(s));
const db = new DatabaseSync(DB_PATH, { readOnly: true });
let exitCode = 0;
let result = null;

try {
  result = lib.collectParity(db, { tenants });
  const t = result.totals;
  console.log(
    TAG + " 库：" + DB_PATH + "（" + lib.fileBytes(DB_PATH) + " 字节，只读" +
      (tenants.length ? "，租户限定 " + tenants.map(lib.formatTenant).join(", ") : "") + "）",
  );
  console.log(TAG + " 目标 schema：" + (result.hasTarget ? "齐全" : "缺失"));
  for (const issue of result.issues) console.log(TAG + " 全局：" + issue);
  console.log("");

  const header = ["租户", "旧episode", "事件", "chat", "证据", "goal", "缺事件", "缺chat", "缺证据", "孤儿", "字段不一致", "字段hash"];
  const rows = result.tenants.map((b) => [
    b.label,
    String(b.legacy.episodes),
    String(b.target.events),
    String(b.target.chat),
    String(b.target.evidence),
    String(b.target.goals),
    String(b.target.missingEvents),
    String(b.target.missingChat),
    String(b.target.missingEvidence),
    String(b.target.orphanEventIds),
    String(b.field.mismatchEvents),
    (b.field.hash ?? "-").slice(0, 12),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c + " ".repeat(Math.max(0, widths[i] - c.length))).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
  console.log("");

  let anyDiff = false;
  for (const b of result.tenants) {
    if (b.diffs.length === 0) continue;
    anyDiff = true;
    console.log(TAG + " ✗ " + b.label + "：" + b.diffs.join("；"));
    for (const m of b.mismatches) console.log(TAG + "   不一致事件 " + m.eventId + "：" + m.fields.join(", "));
    for (const issue of b.issues.slice(0, 10)) console.log(TAG + "   其它：" + issue);
  }

  console.log(
    TAG + " 合计：旧 episode " + t.legacyEpisodes + " → 事件 " + t.events + " · chat " + t.chat +
      " · 证据 " + t.evidence + " · goal " + t.goals +
      " · 字段不一致 " + t.fieldMismatchEvents + " · 孤儿 event_id " + t.orphanEventIds,
  );
  console.log(TAG + " 结论：" + (result.ok ? "全部一致（exit 0）" : "有 diff（exit 1）"));
  exitCode = result.ok ? 0 : 1;
  if (!result.ok && !anyDiff && result.issues.length === 0) {
    console.log(TAG + " 说明：diff 来自目标表缺失或空库，详见上面的「目标 schema」与列表。");
  }
  console.log(TAG + " 退出码 " + exitCode);
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

if (opts.json) console.log(JSON.stringify({ tag: "soul-event-parity", db: DB_PATH, exitCode, parity: result }));
process.exit(exitCode);
