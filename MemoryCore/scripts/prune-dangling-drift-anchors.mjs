#!/usr/bin/env node
// 清理「悬空漂移锚」：soul_persona.meta_json.lastDrift.anchorIds 里按命名空间解析不到的 id。
// 命名空间：ep-* → soul_episodes.episode_id；msg-* → l1_records.record_id / l1_archive.record_id /
// l1_records.source_message_ids（JSON 数组里逐字匹配）。
// 默认 dry-run；--apply 前先 VACUUM INTO 备份，并把被删的 id 写进审计文件（可复查、可回溯）。
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a === "--" + name || a.startsWith("--" + name + "="));
  if (!hit) return dflt;
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  const i = argv.indexOf(hit);
  return argv[i + 1] ?? dflt;
};
const has = (name) => argv.some((a) => a === "--" + name);
const dbPath = argOf("db", "D:/TDB/data/vectors.db");
const apply = has("apply");
const backupDir = argOf("backup-dir", join(dirname(dbPath), "backups"));
const db = new DatabaseSync(dbPath, { readOnly: !apply });
const epTable = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='soul_episodes'").get());

const stmt = {
  ep: db.prepare("SELECT 1 AS x FROM soul_episodes WHERE episode_id = ? LIMIT 1"),
  record: db.prepare("SELECT 1 AS x FROM l1_records WHERE record_id = ? LIMIT 1"),
  archive: db.prepare("SELECT 1 AS x FROM l1_archive WHERE record_id = ? LIMIT 1"),
  source: db.prepare("SELECT 1 AS x FROM l1_records WHERE source_message_ids LIKE ? LIMIT 1"),
};
function resolve(id) {
  if (id.startsWith("ep-")) return epTable && stmt.ep.get(id) ? "ep" : "";
  if (stmt.record.get(id)) return "record";
  if (stmt.archive.get(id)) return "archive";
  if (stmt.source.get("%\"" + id + "\"%")) return "source";
  return "";
}

const team = argOf("team", "");
const user = argOf("user", "");
const agent = argOf("agent", "");
const where = [];
const whereArgs = [];
if (team) { where.push("team_id = ?"); whereArgs.push(team); }
if (user) { where.push("user_id = ?"); whereArgs.push(user); }
if (agent) { where.push("agent_id = ?"); whereArgs.push(agent); }
const rows = db.prepare("SELECT item_id, team_id, user_id, agent_id, meta_json FROM soul_persona" + (where.length ? " WHERE " + where.join(" AND ") : "")).all(...whereArgs);
const plan = [];
for (const r of rows) {
  let meta;
  try { meta = JSON.parse(String(r.meta_json ?? "{}")); } catch { continue; }
  const anchors = Array.isArray(meta?.lastDrift?.anchorIds) ? meta.lastDrift.anchorIds.map(String) : [];
  if (anchors.length === 0) continue;
  const keep = [];
  const drop = [];
  for (const id of anchors) (resolve(id) ? keep : drop).push(id);
  if (drop.length === 0) continue;
  plan.push({ item_id: String(r.item_id), tenant: [r.team_id, r.user_id, r.agent_id].join("/"), anchorKey: meta.lastDrift?.anchorKey ?? null, keep, drop, meta });
}

const summary = { db: dbPath, scope: [team || "*", user || "*", agent || "*"].join("/"), mode: apply ? "apply" : "dry-run", scannedRows: rows.length, itemsWithDangling: plan.length, danglingIds: plan.reduce((n, p) => n + p.drop.length, 0), sample: plan.slice(0, 5).map((p) => ({ item: p.item_id, drop: p.drop })) };
if (!apply) { console.log(JSON.stringify(summary, null, 0)); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDir, "pre-r32-drift-anchor-prune-" + stamp + ".db");
mkdirSync(backupDir, { recursive: true });
db.exec("VACUUM INTO '" + backupPath.replace(/'/g, "''") + "'");
const auditPath = join(backupDir, "drift-anchor-prune-" + stamp + ".json");
writeFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), db: dbPath, backupPath, items: plan.map((p) => ({ item_id: p.item_id, tenant: p.tenant, anchorKey: p.anchorKey, removed: p.drop, remaining: p.keep })) }, null, 2), "utf8");
let updated = 0;
const upd = db.prepare("UPDATE soul_persona SET meta_json = ? WHERE item_id = ?");
for (const p of plan) {
  p.meta.lastDrift.anchorIds = p.keep;
  upd.run(JSON.stringify(p.meta), p.item_id);
  updated += 1;
}
db.close();
console.log(JSON.stringify({ ...summary, mode: "apply", updated, backupPath, auditPath }));
