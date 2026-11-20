#!/usr/bin/env node
// 清理「两端都已不存在的边」：l1_links 里 source_id / target_id 既不在 l1_records 也不在 l1_archive 的行。
//
// 判据（与库里既有口径一致）：
//   - target 侧悬挂：target_id 不在 l1_records 且不在 l1_archive。
//   - source 侧悬挂：source_id 不在 l1_records 且不在 l1_archive，
//     但要排除 profile:v1: 前缀的跨命名空间 id —— 这类 id 本来就不指向 l1 记录，不是损坏。
// 一条边只要任意一端真悬挂，就是坏边（两端都坏也算一条，只删一次）。
//
// 删除按 rowid 精确命中（l1_links 是普通 rowid 表，主键是 (source_id,target_id,type) 复合唯一索引，
// 按三元组删在有重复/大小写差异时不如 rowid 稳）。
// 默认 dry-run；--apply 前先 VACUUM INTO 备份，并把删除明细与前后计数写进审计 JSON。
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const PROFILE_NS_PREFIX = "profile:v1:";

const USAGE = [
  "用法: node scripts/prune-dangling-links.mjs [选项]",
  "",
  "默认 dry-run（只读连接，只打印将要删除的边与条数）；--apply 才会真的删。",
  "",
  "选项:",
  "  --db <path>         SQLite 库路径（默认 D:/TDB/data/vectors.db）",
  "  --apply             真正执行删除；会先 VACUUM INTO 备份到 --backup-dir",
  "  --backup-dir <dir>  备份与审计 JSON 目录（默认 <db 所在目录>/backups）",
  "  --ids-limit <n>     输出里列出的边条数上限（默认 20；0 = 不限）",
  "  --include-profile-source",
  "                      连 source 侧 profile:v1: 前缀的「悬挂」也一起删（默认视为跨命名空间、不动）",
  "  --help              显示本帮助",
].join("\n");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a === "--" + name || a.startsWith("--" + name + "="));
  if (!hit) return dflt;
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  const i = argv.indexOf(hit);
  return argv[i + 1] ?? dflt;
};
const has = (name) => argv.some((a) => a === "--" + name);

if (has("help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const dbPath = argOf("db", "D:/TDB/data/vectors.db");
const apply = has("apply");
const includeProfileSource = has("include-profile-source");
const idsLimit = Math.max(0, Number(argOf("ids-limit", "20")) || 0);
const backupDir = argOf("backup-dir", join(dirname(dbPath), "backups"));

function main() {
  const db = new DatabaseSync(dbPath, { readOnly: !apply });

  const aliveStmt = db.prepare("SELECT 1 AS x FROM l1_records WHERE record_id = ? LIMIT 1");
  const archivedStmt = db.prepare("SELECT 1 AS x FROM l1_archive WHERE record_id = ? LIMIT 1");
  const isAlive = (id) => Boolean(aliveStmt.get(id)) || Boolean(archivedStmt.get(id));
  const isProfileNs = (id) => id.startsWith(PROFILE_NS_PREFIX);

  const countAll = () => db.prepare("SELECT COUNT(*) AS c FROM l1_links").get().c;

  // 先用 SQL 粗筛（把 profile:v1: 前缀的 source 直接排除，除非显式 --include-profile-source），
  // 再用 JS 逐行复核两端状态并记下原因，审计里写清楚为什么删。
  const candidates = db
    .prepare(
      "SELECT l.rowid AS rid, l.source_id AS source_id, l.target_id AS target_id, l.type AS type " +
        "FROM l1_links AS l " +
        "WHERE (NOT EXISTS (SELECT 1 FROM l1_records r WHERE r.record_id = l.target_id) " +
        "       AND NOT EXISTS (SELECT 1 FROM l1_archive a WHERE a.record_id = l.target_id)) " +
        "   OR (NOT EXISTS (SELECT 1 FROM l1_records r WHERE r.record_id = l.source_id) " +
        "       AND NOT EXISTS (SELECT 1 FROM l1_archive a WHERE a.record_id = l.source_id) " +
        (includeProfileSource ? ") " : "       AND l.source_id NOT LIKE ?) ") +
        "ORDER BY l.rowid"
    )
    .all(...(includeProfileSource ? [] : [PROFILE_NS_PREFIX + "%"]));

  // 被「跨命名空间」规则挡下的边：source 侧是 profile:v1: 且记录确实不在了，但 target 侧还活着。
  // 这类不是损坏，默认不动；这里单独计数，避免「被排除」变成看不见的黑箱。
  const profileNsExcluded = db
    .prepare(
      "SELECT COUNT(*) AS c FROM l1_links AS l " +
        "WHERE l.source_id LIKE ? " +
        "  AND NOT EXISTS (SELECT 1 FROM l1_records r WHERE r.record_id = l.source_id) " +
        "  AND NOT EXISTS (SELECT 1 FROM l1_archive a WHERE a.record_id = l.source_id) " +
        "  AND (EXISTS (SELECT 1 FROM l1_records r2 WHERE r2.record_id = l.target_id) " +
        "       OR EXISTS (SELECT 1 FROM l1_archive a2 WHERE a2.record_id = l.target_id))"
    )
    .get(PROFILE_NS_PREFIX + "%").c;

  const targets = [];
  const excluded = { profileNsSourceMissingWithLiveTarget: profileNsExcluded, deletedByFlag: includeProfileSource };
  for (const row of candidates) {
    const source = String(row.source_id);
    const target = String(row.target_id);
    const sourceDangling = !isAlive(source);
    const targetDangling = !isAlive(target);
    const profileSourceOnly = sourceDangling && isProfileNs(source) && !targetDangling;
    if (profileSourceOnly && !includeProfileSource) continue;
    const reasons = [];
    if (sourceDangling) reasons.push("source_missing");
    if (targetDangling) reasons.push("target_missing");
    if (reasons.length === 0) continue;
    targets.push({ rowid: Number(row.rid), source, target, type: String(row.type ?? ""), reasons, sourceProfileNs: isProfileNs(source) });
  }

  const sideStats = {
    sourceDangling: targets.filter((t) => t.reasons.includes("source_missing")).length,
    targetDangling: targets.filter((t) => t.reasons.includes("target_missing")).length,
    bothEnds: targets.filter((t) => t.reasons.length === 2).length,
    profileNsSource: targets.filter((t) => t.sourceProfileNs).length,
  };
  const caps = (list) => (idsLimit === 0 ? list : list.slice(0, idsLimit));
  const report = {
    db: dbPath,
    mode: apply ? "dry-run (before apply)" : "dry-run",
    includeProfileSource,
    counts: { linksTotal: countAll(), danglingEdges: targets.length, ...sideStats },
    excluded,
    targets: caps(targets),
    targetsTruncated: targets.length > caps(targets).length,
    backupDir,
  };

  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    db.close();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(backupDir, { recursive: true });
  let backupPath = null;
  if (targets.length > 0) {
    backupPath = join(backupDir, "pre-dangling-link-prune-" + stamp + ".db");
    db.exec("VACUUM INTO '" + backupPath.replace(/'/g, "''") + "'");
  }

  let deleted = 0;
  if (targets.length > 0) {
    const del = db.prepare("DELETE FROM l1_links WHERE rowid = ?");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of targets) deleted += Number(del.run(t.rowid).changes ?? 0);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // 收尾复核：同一个判据再跑一次，剩下的应该只剩被排除的 profile:v1: cross-namespace 边。
  const orphanAfter = db
    .prepare(
      "SELECT COUNT(*) AS c FROM l1_links AS l " +
        "WHERE (NOT EXISTS (SELECT 1 FROM l1_records r WHERE r.record_id = l.target_id) " +
        "       AND NOT EXISTS (SELECT 1 FROM l1_archive a WHERE a.record_id = l.target_id)) " +
        "   OR (NOT EXISTS (SELECT 1 FROM l1_records r WHERE r.record_id = l.source_id) " +
        "       AND NOT EXISTS (SELECT 1 FROM l1_archive a WHERE a.record_id = l.source_id) " +
        "       AND l.source_id NOT LIKE ?)"
    )
    .get(PROFILE_NS_PREFIX + "%").c;

  const audit = {
    at: new Date().toISOString(),
    tool: "prune-dangling-links",
    db: dbPath,
    backupPath,
    includeProfileSource,
    countsBefore: { linksTotal: countAll() + deleted, danglingEdges: targets.length, ...sideStats },
    countsAfter: { linksTotal: countAll(), danglingEdgesRemaining: orphanAfter },
    excluded,
    deletions: targets.map((t) => ({ rowid: t.rowid, source_id: t.source, target_id: t.target, type: t.type, reasons: t.reasons })),
  };
  const auditPath = join(backupDir, "dangling-link-prune-" + stamp + ".json");
  writeFileSync(auditPath, JSON.stringify(audit, null, 2), "utf8");
  db.close();

  console.log(
    JSON.stringify(
      {
        ...report,
        mode: "apply",
        backupPath,
        auditPath,
        deleted,
        countsAfter: audit.countsAfter,
        excludedProfileNsSource: excluded.profileNsSourceMissingWithLiveTarget,
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  console.error("FAILED: " + (err && err.message ? err.message : String(err)));
  process.exit(1);
}