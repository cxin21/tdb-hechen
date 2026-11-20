#!/usr/bin/env node
/**
 * 合并 l1_records 里「同一租户 + 正文逐字节相同」的历史重复行（Round29）。
 *
 * 背景：内容键（contentMemoryId）2026-11-19 之前只覆盖部分写面，历史行用随机 id，
 * 同一句话被抽取两次就留两行。生产 14071 行里 23 组 / 46 行是逐字节重复
 * （scripts/merge-legacy-l1-duplicates.mjs 走 normalizeForId 口径只认 4 组）。
 * 本脚本按「租户三元组 + 正文完全相同」成组，保留最早一行，其余整行归档到 l1_archive
 * （reason='legacy_exact_duplicate'），并清向量/FTS 索引与指向被删行的 l1_links 边。
 * 注：FTS5 直接 `DELETE FROM l1_fts WHERE record_id = ?` 即可；本脚本不做 rebuild
 *    （上一版头注释写「最后 rebuild FTS」，实际没有该语句也不需要有，已删）。
 *
 * 安全：默认 dry-run；--apply 前自动 VACUUM INTO 备份到「库文件同目录的 backups/」
 *       （可用 --backup-dir 覆盖；不再硬编码 D:/TDB/data/backups，换库时备份不会跑到另一块盘）。
 * 用法：
 *   node scripts/merge-legacy-l1-exact-duplicates.mjs --db D:/TDB/data/vectors.db
 *   node scripts/merge-legacy-l1-exact-duplicates.mjs --db D:/TDB/data/vectors.db --apply
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const argOf = (name, fallback = "") => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return fallback;
};
const has = (name) => argv.includes(`--${name}`);
const dbPath = argOf("db", "D:/TDB/data/vectors.db");
const apply = argv.includes("--apply");
const limit = Number(argOf("limit", "0")) || 0;

const tables = (db) =>
  new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));

const db = new DatabaseSync(dbPath);
const present = tables(db);

const groups = db
  .prepare(
    `SELECT content, team_id, user_id, agent_id, COUNT(*) AS c
       FROM l1_records
      GROUP BY content, team_id, user_id, agent_id
     HAVING c > 1
      ORDER BY c DESC, content`,
  )
  .all();

const sampleCap = limit > 0 ? limit : groups.length;
const plan = [];
for (const g of groups.slice(0, sampleCap)) {
  const rows = db
    .prepare(
      `SELECT record_id, created_time FROM l1_records
        WHERE content = ? AND team_id IS ? AND user_id IS ? AND agent_id IS ?
        ORDER BY created_time ASC, record_id ASC`,
    )
    .all(g.content, g.team_id, g.user_id, g.agent_id);
  const keep = rows[0]?.record_id;
  const drop = rows.slice(1).map((r) => r.record_id);
  plan.push({ keep, drop, chars: String(g.content).length, team: g.team_id, agent: g.agent_id });
}

const out = {
  db: dbPath,
  apply,
  scanned: db.prepare("SELECT COUNT(*) c FROM l1_records").get().c,
  dupGroups: groups.length,
  archivableRows: plan.reduce((n, p) => n + p.drop.length, 0),
  samples: plan.slice(0, 5),
};

if (!apply) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// 备份：VACUUM INTO（事务安全，不复制 WAL 中间态）
const backupDir = argOf("backup-dir", join(dirname(dbPath), "backups"));
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDir, `pre-r29-l1-merge-${stamp}.db`);
db.exec(`VACUUM INTO '${backupPath}'`);

const archiveInsert = db.prepare(
  "INSERT OR REPLACE INTO l1_archive (record_id, data, archived_at, reason, team_id, user_id, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
const fullRow = db.prepare("SELECT * FROM l1_records WHERE record_id = ?");
const delRecord = db.prepare("DELETE FROM l1_records WHERE record_id = ?");
// vec0 虚拟表需要 sqlite-vec 扩展；CLI 里通常加载不到。加载不到就跳过并在结果里标注，
// 残留向量行不会让已删记录「复活」——召回侧拿到 id 后仍会去 l1_records 取正文，取不到即丢。
const tryVec = (table) => {
  if (!present.has(table)) return null;
  try {
    return db.prepare(`DELETE FROM ${table} WHERE record_id = ?`);
  } catch {
    return null;
  }
};
const delVec = tryVec("l1_vec");
const delFact = tryVec("l1_fact_vec");
const delFts = present.has("l1_fts") ? db.prepare("DELETE FROM l1_fts WHERE record_id = ?") : null;
// 边上不留悬挂：被删行的出边与入边一起删（归档里仍有整行数据，边没有 target 就没有意义）。
// 只删本次被删的 id，不做全库悬挂边清扫（全库现存 37048 条指向不存在 id 的边是历史债，单列报告）。
const delLinks = present.has("l1_links")
  ? [db.prepare("DELETE FROM l1_links WHERE source_id = ?"), db.prepare("DELETE FROM l1_links WHERE target_id = ?")]
  : [];

// R32-11（r32h-a3）：l1_archive 的主键是 record_id 且这里是 INSERT OR REPLACE，
// 同一 id 再次归档会静默覆盖旧归档（旧 reason / archived_at / 整行 data 全丢）。
// 先查冲突：有冲突就 fail-closed，除非显式 --force-overwrite。
const archiveExisting = db.prepare("SELECT record_id FROM l1_archive WHERE record_id = ?");
const archiveConflicts = plan.flatMap((p) => p.drop).filter((id) => Boolean(archiveExisting.get(id)));
const forceOverwrite = has("force-overwrite");
if (archiveConflicts.length > 0 && !forceOverwrite) {
  console.error(JSON.stringify({ ok: false, error: "archive_conflict", archiveConflicts: archiveConflicts.slice(0, 10), count: archiveConflicts.length, hint: "加 --force-overwrite 才会覆盖既有归档" }));
  process.exit(1);
}

let archived = 0;
let linksDeleted = 0;
db.exec("BEGIN");
try {
  for (const p of plan) {
    for (const id of p.drop) {
      const row = fullRow.get(id);
      if (!row) continue;
      archiveInsert.run(
        id,
        JSON.stringify(row),
        new Date().toISOString(),
        "legacy_exact_duplicate",
        row.team_id && String(row.team_id).trim() !== "" ? row.team_id : "default",
        row.user_id && String(row.user_id).trim() !== "" ? row.user_id : "default",
        row.agent_id && String(row.agent_id).trim() !== "" ? row.agent_id : "default",
      );
      delRecord.run(id);
      delVec?.run(id);
      delFact?.run(id);
      delFts?.run(id);
      for (const q of delLinks) linksDeleted += Number(q.run(id).changes);
      archived += 1;
    }
  }
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}

const after = db
  .prepare(
    `SELECT COUNT(*) AS groups FROM (
        SELECT content, team_id, user_id, agent_id, COUNT(*) c
          FROM l1_records GROUP BY content, team_id, user_id, agent_id HAVING c > 1)`,
  )
  .get();
console.log(
  JSON.stringify(
    { ok: true, backup: backupPath, archived, linksDeleted, remainingDupGroups: after.groups, rows: out.scanned - archived, vectorDeleteSkipped: delVec === null, factVectorDeleteSkipped: delFact === null, archiveConflicts: archiveConflicts.length },
    null,
    2,
  ),
);
