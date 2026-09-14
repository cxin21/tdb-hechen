/**
 * 对抗审查生产数据探针（只读）：验证 soul 字段/归档/图边/价值锚在真实库中的落位。
 * 依赖 Node 22 内置 node:sqlite（与 sqlite.ts 同驱动）。
 * 用法: node scripts/audit-prod-probe.mjs
 */
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("D:/tdai-data/vectors.db", { readOnly: true });
function q(label, sql) {
  try {
    const rows = db.prepare(sql).all();
    console.log("==", label, JSON.stringify(rows));
  } catch (e) {
    console.log("==", label, "ERR:", e.message);
  }
}

q("tables", "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%archive%' OR name LIKE '%links%' OR name LIKE '%core%' OR name='l1_records') ORDER BY name");
q("l1_records", "SELECT COUNT(*) c FROM l1_records");
q("l1_archive", "SELECT COUNT(*) c FROM l1_archive");
q("l1_links", "SELECT COUNT(*) c FROM l1_links");
q("core_memory", "SELECT COUNT(*) c FROM core_memory");
q("core_values", "SELECT COUNT(*) c FROM core_values");
q("soul_fields", "SELECT COUNT(*) total, SUM(CASE WHEN occurred_at IS NOT NULL AND occurred_at != '' THEN 1 ELSE 0 END) has_occurred, SUM(CASE WHEN certainty IS NOT NULL AND certainty != '' THEN 1 ELSE 0 END) has_certainty, SUM(CASE WHEN valence IS NOT NULL THEN 1 ELSE 0 END) has_valence, SUM(CASE WHEN significance IS NOT NULL THEN 1 ELSE 0 END) has_sig FROM l1_records");
q("archive_by_reason", "SELECT COALESCE(reason,'') reason, COUNT(*) c FROM l1_archive GROUP BY reason");
q("links_by_type", "SELECT COALESCE(type,'') type, COUNT(*) c FROM l1_links GROUP BY type");
q("sample_records", "SELECT record_id, type, certainty, occurred_at, valence, significance, substr(content,1,40) content FROM l1_records ORDER BY created_time DESC LIMIT 5");
try {
  console.log("== ddl_l1_archive", JSON.stringify(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='l1_archive'").all()));
} catch (e) { console.log("== ddl_l1_archive ERR", e.message); }
db.close();