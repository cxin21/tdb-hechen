#!/usr/bin/env node
// 修复 Round29 那次 legacy 去重 apply 留下的悬挂边（当时脚本还没有删边逻辑）。
// 对每个 l1_archive.reason='legacy_exact_duplicate' 的 record_id：
//   1) 在 l1_records 里找「同租户 + 正文逐字节相同」的保留行（最早一条）；
//   2) 找到 → 把两端指向它的边改指保留行（去重统计），找不到 → 删除该端的边。
// 默认 dry-run；--apply 前 VACUUM INTO 备份，并把每个 id 的处理结果写审计文件。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a === "--" + name || a.startsWith("--" + name + "="));
  if (!hit) return dflt;
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  return argv[argv.indexOf(hit) + 1] ?? dflt;
};
const has = (name) => argv.some((a) => a === "--" + name);
const dbPath = argOf("db", "D:/TDB/data/vectors.db");
const apply = has("apply");
const backupDir = argOf("backup-dir", join(dirname(dbPath), "backups"));
const db = new DatabaseSync(dbPath, { readOnly: !apply });

if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='l1_links'").get()) {
  console.log(JSON.stringify({ db: dbPath, ok: true, note: "库没有 l1_links，无需修复" }));
  process.exit(0);
}
const archived = db.prepare("SELECT record_id, data FROM l1_archive WHERE reason = 'legacy_exact_duplicate'").all();
const keptByKey = new Map();
for (const r of db.prepare("SELECT record_id, content, team_id, user_id, agent_id, created_time FROM l1_records ORDER BY created_time ASC, record_id ASC").all()) {
  const key = [r.content, r.team_id, r.user_id, r.agent_id].join("\u0000");
  if (!keptByKey.has(key)) keptByKey.set(key, String(r.record_id));
}
const plan = [];
for (const a of archived) {
  let row;
  try { row = JSON.parse(String(a.data ?? "{}")); } catch { row = {}; }
  const key = [row.content, row.team_id, row.user_id, row.agent_id].join("\u0000");
  const kept = keptByKey.get(key) ?? "";
  const out = db.prepare("SELECT COUNT(*) AS n FROM l1_links WHERE source_id = ?").get(a.record_id).n;
  const inn = db.prepare("SELECT COUNT(*) AS n FROM l1_links WHERE target_id = ?").get(a.record_id).n;
  if (Number(out) + Number(inn) === 0) continue;
  plan.push({ id: String(a.record_id), kept, out: Number(out), inn: Number(inn) });
}
const summary = { db: dbPath, mode: apply ? "apply" : "dry-run", archivedScanned: archived.length, items: plan.length, edges: plan.reduce((n, p) => n + p.out + p.inn, 0), remappable: plan.filter((p) => p.kept).length, deletable: plan.filter((p) => !p.kept).length };
if (!apply) { console.log(JSON.stringify({ ...summary, sample: plan.slice(0, 5) })); process.exit(0); }

mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDir, "pre-r32-dup-link-repair-" + stamp + ".db");
db.exec("VACUUM INTO '" + backupPath.replace(/'/g, "''") + "'");
const auditPath = join(backupDir, "dup-link-repair-" + stamp + ".json");
let remapped = 0, deleted = 0, deduped = 0;
const updSrcRow = db.prepare("UPDATE l1_links SET source_id = ? WHERE rowid = ?");
const updTgtRow = db.prepare("UPDATE l1_links SET target_id = ? WHERE rowid = ?");
const delRow = db.prepare("DELETE FROM l1_links WHERE rowid = ?");
const delSrc = db.prepare("DELETE FROM l1_links WHERE source_id = ?");
const delTgt = db.prepare("DELETE FROM l1_links WHERE target_id = ?");
// l1_links 对 (source_id,target_id,type) 有唯一约束：改指保留行后可能与既有边撞车。
// 撞车时删掉这一条重复边（保留行本来就有等价边），并单独计数，不静默吞掉约束错误。
const remapOne = (rowid, col, kept) => {
  try {
    (col === "source_id" ? updSrcRow : updTgtRow).run(kept, rowid);
    remapped += 1;
  } catch (err) {
    if (!(err instanceof Error) || !/UNIQUE constraint failed/u.test(err.message)) throw err;
    delRow.run(rowid);
    deduped += 1;
  }
};
db.exec("BEGIN");
try {
  for (const p of plan) {
    if (p.kept) {
      for (const r of db.prepare("SELECT rowid AS rid FROM l1_links WHERE source_id = ?").all(p.id)) remapOne(r.rid, "source_id", p.kept);
      for (const r of db.prepare("SELECT rowid AS rid FROM l1_links WHERE target_id = ?").all(p.id)) remapOne(r.rid, "target_id", p.kept);
    } else {
      deleted += Number(delSrc.run(p.id).changes) + Number(delTgt.run(p.id).changes);
    }
  }
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}
const orphans = db.prepare("SELECT COUNT(*) AS n FROM l1_links WHERE source_id NOT IN (SELECT record_id FROM l1_records) OR target_id NOT IN (SELECT record_id FROM l1_records)").get().n;
writeFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), db: dbPath, backupPath, summary, plan }, null, 2), "utf8");
db.close();
console.log(JSON.stringify({ ...summary, mode: "apply", remapped, deleted, deduped, orphansEitherSideAfter: Number(orphans), backupPath, auditPath }));
