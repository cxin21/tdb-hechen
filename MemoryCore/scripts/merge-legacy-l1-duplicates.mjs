#!/usr/bin/env node
/**
 * 合并存量重复 L1（Round9 阶段1；内容幂等键上线后新写入不再重复，但历史 23 组还在）。
 *
 *   node scripts/merge-legacy-l1-duplicates.mjs --db <vectors.db>            # 只读演练
 *   node scripts/merge-legacy-l1-duplicates.mjs --db <vectors.db> --apply    # 真写
 *
 * 口径：
 *   - 分组键 = (team_id,user_id,agent_id, content 完全相同的字节)。
 *   - 组内保留 created_time 最早的一行（时间相同按 record_id 字典序），其余行：
 *     整行 JSON 写进 l1_archive（reason='dedup-merge'）后从 l1_records 删除。
 *   - 只处理 COALESCE(valid_end,'')='' 的活跃行；已被取代/软删的行不动。
 *   - 不做「近似重复」合并：归一化去标点后相同但原文不同的两组各自都是合法表述，
 *     合并会丢掉措辞差异，不属于本次清理范围。
 * 输出：组数/将归档行数/前 5 组样例。退出码 0=完成，1=参数/IO 错。
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const dbPath = argValue("--db");
const apply = process.argv.includes("--apply");
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error("usage: node scripts/merge-legacy-l1-duplicates.mjs --db <vectors.db> [--apply]");
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
const cols = db.prepare("PRAGMA table_info(l1_records)").all().map((c) => String(c.name));
if (!cols.includes("content") || !cols.includes("record_id")) {
  console.error("l1_records 结构不符合预期");
  process.exit(1);
}
const hasValidEnd = cols.includes("valid_end");
const rows = db
  .prepare(
    `SELECT * FROM l1_records WHERE ${hasValidEnd ? "COALESCE(valid_end,'')=''" : "1=1"} ORDER BY COALESCE(NULLIF(created_time,''),NULLIF(updated_time,''),'') ASC, record_id ASC`,
  )
  .all();
const groups = new Map();
for (const row of rows) {
  const key = [row.team_id, row.user_id, row.agent_id, String(row.content ?? "")].join("\u0000");
  const list = groups.get(key) ?? [];
  list.push(row);
  groups.set(key, list);
}
const dupGroups = [...groups.values()].filter((g) => g.length > 1);
const archiveCols = db.prepare("PRAGMA table_info(l1_archive)").all().map((c) => String(c.name));
const tenantOk = ["team_id", "user_id", "agent_id"].every((c) => archiveCols.includes(c));
let extra = 0;
const samples = [];
for (const g of dupGroups) {
  const keep = g[0];
  const drop = g.slice(1);
  extra += drop.length;
  if (samples.length < 5) {
    samples.push({ keep: keep.record_id, drop: drop.map((r) => r.record_id), chars: String(keep.content ?? "").length });
  }
  if (!apply) continue;
  const now = new Date().toISOString();
  for (const r of drop) {
    const insertCols = ["record_id", "data", "archived_at", "reason", ...(tenantOk ? ["team_id", "user_id", "agent_id"] : [])];
    const values = [r.record_id, JSON.stringify(r), now, "dedup-merge", ...(tenantOk ? [r.team_id, r.user_id, r.agent_id] : [])];
    db.prepare(`INSERT OR REPLACE INTO l1_archive (${insertCols.join(",")}) VALUES (${insertCols.map(() => "?").join(",")})`).run(...values);
    db.prepare("DELETE FROM l1_records WHERE record_id = ?").run(r.record_id);
  }
}
console.log(
  JSON.stringify(
    { db: dbPath, apply, scanned: rows.length, dupGroups: dupGroups.length, archivableRows: extra, samples },
    null,
    2,
  ),
);
db.close();
