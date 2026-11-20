#!/usr/bin/env node
// 清理「孤儿向量」：l1_vec_rowids / l1_fact_vec_rowids 里指向的记录已不在 l1_records 的映射行，
// 连同它们在 vec0 虚表（l1_vec / l1_fact_vec）里的向量行一起删掉（先删向量行，再删映射行）。
//
// 两个必须知道的事实：
// 1) vec0 是虚拟表，DELETE 必须走真正加载了 sqlite-vec 扩展的连接，否则报 "no such module: vec0"。
//    注意 node:sqlite 的扩展开关只能在建连接时给（new DatabaseSync(p, { allowExtension: true })），
//    事后再调 enableLoadExtension(true) 会报「Cannot enable extension loading because it was disabled at database creation」。
// 2) 本库的 vec0 DDL 是 record_id TEXT PRIMARY KEY（自定义 TEXT 主键），这种表在 SQLite 侧不暴露 rowid 列
//    （SELECT/DELETE ... WHERE rowid=? 都会报 "no such column: rowid"）。所以脚本启动时探测一次能力：
//    能用 rowid 就按 rowid 删（并校验该 rowid 上的 record_id 与映射行 id 一致，不一致就跳过、只报告）；
//    不能用就退化成 record_id 等值删除 —— 同样是精确命中，而且天然免疫映射表与向量表错位。
// 3) l1_vec_rowids / l1_fact_vec_rowids 并不是业务自建表，它们本身就是 vec0 的影子表 <vec>_rowids
//    （id 列存的就是 aux 主键 record_id；实测两边 id 集合完全一致，各 14085 / 9520 条，无一多余）。
//    所以 vec0 的 DELETE 一般会把它一并删掉；脚本仍按任务要求显式再删一次映射行收尾，
//    审计里分开记 shadowRowsRemovedByVec0（vec0 顺手删掉）与 shadowRowsDeletedExplicitly（脚本补删到的残留）。
//// 判据：映射行的 id 不在 l1_records 即孤儿（记录已归档到 l1_archive 或已彻底删除，两种情况都要清）。
// 默认 dry-run；--apply 前先 VACUUM INTO 备份，并把删除明细与前后计数写进审计 JSON。
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const TABLES = [
  { vec: "l1_vec", map: "l1_vec_rowids" },
  { vec: "l1_fact_vec", map: "l1_fact_vec_rowids" },
];

const USAGE = [
  "用法: node scripts/prune-orphan-vectors.mjs [选项]",
  "",
  "默认 dry-run（只读连接，只打印将要删除的 id 与条数）；--apply 才会真的删。",
  "",
  "选项:",
  "  --db <path>         SQLite 库路径（默认 D:/TDB/data/vectors.db）",
  "  --apply             真正执行删除；会先 VACUUM INTO 备份到 --backup-dir",
  "  --backup-dir <dir>  备份与审计 JSON 目录（默认 <db 所在目录>/backups）",
  "  --vec-ext <path>    覆盖 sqlite-vec 可加载扩展路径（默认从 node_modules/sqlite-vec 解析）",
  "  --ids-limit <n>     输出里列出的 id 条数上限（默认 20；0 = 不限）",
  "  --include-vec-only  连「向量表里有、映射表里没有、记录也已不存在」的残留一起删（默认只报不删）",
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
const includeVecOnly = has("include-vec-only");
const idsLimit = Math.max(0, Number(argOf("ids-limit", "20")) || 0);
const backupDir = argOf("backup-dir", join(dirname(dbPath), "backups"));

function vecExtensionPath() {
  const override = argOf("vec-ext", "");
  if (override) return resolvePath(override);
  const require = createRequire(import.meta.url);
  const mod = require("sqlite-vec");
  if (typeof mod.getLoadablePath !== "function") {
    throw new Error("sqlite-vec 模块没有导出 getLoadablePath()，无法定位可加载扩展");
  }
  return mod.getLoadablePath();
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name));
}

function detectVecKeyMode(db, vecTable) {
  try {
    db.prepare("SELECT rowid FROM \"" + vecTable + "\" LIMIT 1").all();
    return "rowid";
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/no such column:\s*rowid/i.test(msg)) return "record_id";
    throw err;
  }
}

function main() {
  const extPath = vecExtensionPath();
  const db = new DatabaseSync(dbPath, { readOnly: !apply, allowExtension: true });
  db.loadExtension(extPath);
  const vecVersion = db.prepare("SELECT vec_version() AS v").get().v;

  const aliveStmt = db.prepare("SELECT 1 AS x FROM l1_records WHERE record_id = ? LIMIT 1");
  const archivedStmt = db.prepare("SELECT 1 AS x FROM l1_archive WHERE record_id = ? LIMIT 1");
  const isAlive = (id) => Boolean(aliveStmt.get(id));
  const isArchived = (id) => Boolean(archivedStmt.get(id));

  for (const cfg of TABLES) {
    if (!tableExists(db, cfg.vec)) throw new Error("库里没有向量表 " + cfg.vec);
    if (!tableExists(db, cfg.map)) throw new Error("库里没有映射表 " + cfg.map);
  }

  const plans = TABLES.map((cfg) => {
    const keyMode = detectVecKeyMode(db, cfg.vec);
    const countVec = () => db.prepare("SELECT COUNT(*) AS c FROM \"" + cfg.vec + "\"").get().c;
    const countMap = () => db.prepare("SELECT COUNT(*) AS c FROM \"" + cfg.map + "\"").get().c;

    const orphanRows = db
      .prepare(
        "SELECT m.rowid AS rid, m.id AS id, " +
          "EXISTS(SELECT 1 FROM l1_archive a WHERE a.record_id = m.id) AS in_archive " +
          "FROM \"" + cfg.map + "\" AS m " +
          "WHERE NOT EXISTS (SELECT 1 FROM l1_records r WHERE r.record_id = m.id) " +
          "ORDER BY m.rowid"
      )
      .all();

    const vecLookup =
      keyMode === "rowid"
        ? db.prepare("SELECT record_id FROM \"" + cfg.vec + "\" WHERE rowid = ?")
        : db.prepare("SELECT record_id FROM \"" + cfg.vec + "\" WHERE record_id = ?");

    const targets = [];
    const skipped = [];
    for (const row of orphanRows) {
      const key = keyMode === "rowid" ? row.rid : String(row.id);
      const hit = vecLookup.get(key);
      const inArchive = Boolean(row.in_archive);
      if (hit && keyMode === "rowid" && String(hit.record_id ?? "") !== String(row.id)) {
        // 映射表 rowid 与向量表 rowid 指向了不同记录：绝不动手，交给人看
        skipped.push({ rowid: Number(row.rid), id: String(row.id), reason: "rowid_mismatch", vecRecordId: hit.record_id ?? null });
        continue;
      }
      targets.push({ rowid: Number(row.rid), id: String(row.id), inArchive, vecRowPresent: Boolean(hit) });
    }

    const mapIds = new Set(db.prepare("SELECT id FROM \"" + cfg.map + "\"").all().map((r) => String(r.id)));
    const vecOnly = [];
    for (const r of db.prepare("SELECT record_id FROM \"" + cfg.vec + "\"").all()) {
      const id = String(r.record_id ?? "");
      if (!mapIds.has(id) && !isAlive(id)) vecOnly.push(id);
    }

    return {
      cfg,
      keyMode,
      countVec,
      countMap,
      targets,
      skipped,
      vecOnly,
      archiveCount: targets.filter((t) => t.inArchive).length,
      deleteVec:
        keyMode === "rowid"
          ? db.prepare("DELETE FROM \"" + cfg.vec + "\" WHERE rowid = ?")
          : db.prepare("DELETE FROM \"" + cfg.vec + "\" WHERE record_id = ?"),
      deleteMap: db.prepare("DELETE FROM \"" + cfg.map + "\" WHERE rowid = ?"),
      mapLookup: db.prepare("SELECT 1 AS x FROM \"" + cfg.map + "\" WHERE rowid = ?"),
      deleteVecOnly: db.prepare("DELETE FROM \"" + cfg.vec + "\" WHERE record_id = ?"),
    };
  });

  const caps = (list) => (idsLimit === 0 ? list : list.slice(0, idsLimit));
  const report = {
    db: dbPath,
    mode: apply ? "dry-run (before apply)" : "dry-run",
    vecExtension: extPath,
    vecVersion,
    keyMode: Object.fromEntries(plans.map((p) => [p.cfg.vec, p.keyMode])),
    includeVecOnly,
    tables: plans.map((p) => ({
      vec: p.cfg.vec,
      map: p.cfg.map,
      countsBefore: { vecRows: p.countVec(), mapRows: p.countMap() },
      orphans: { mappings: p.targets.length, inArchive: p.archiveCount, notInAnyTable: p.targets.length - p.archiveCount },
      vecRowsToDelete: p.targets.filter((t) => t.vecRowPresent).length,
      skipped: p.skipped,
      targets: caps(p.targets),
      targetsTruncated: p.targets.length > caps(p.targets).length,
      vecOnlyResidue: { count: p.vecOnly.length, ids: caps(p.vecOnly), deleteByFlag: includeVecOnly },
    })),
    totals: {
      orphanMappings: plans.reduce((n, p) => n + p.targets.length, 0),
      vecRows: plans.reduce((n, p) => n + p.targets.filter((t) => t.vecRowPresent).length, 0),
      vecOnlyResidue: plans.reduce((n, p) => n + p.vecOnly.length, 0),
      skipped: plans.reduce((n, p) => n + p.skipped.length, 0),
    },
    backupDir,
  };

  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    db.close();
    return;
  }

  const nothingToDo = report.totals.orphanMappings === 0 && (!includeVecOnly || report.totals.vecOnlyResidue === 0);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(backupDir, { recursive: true });
  let backupPath = null;
  if (!nothingToDo) {
    backupPath = join(backupDir, "pre-orphan-vector-prune-" + stamp + ".db");
    db.exec("VACUUM INTO '" + backupPath.replace(/'/g, "''") + "'");
  }

  const deletions = plans.map((p) => ({ vec: p.cfg.vec, map: p.cfg.map, deletedVecRows: 0, shadowRowsRemovedByVec0: 0, shadowRowsDeletedExplicitly: 0, ids: [] }));
  const vecOnlyDeleted = [];
  if (!nothingToDo) {
    db.exec("BEGIN IMMEDIATE");
    try {
      plans.forEach((p, i) => {
        const acc = deletions[i];
        for (const t of p.targets) {
          const key = p.keyMode === "rowid" ? t.rowid : t.id;
          const vecChanges = Number(p.deleteVec.run(key).changes ?? 0);
          acc.deletedVecRows += vecChanges;
          if (p.mapLookup.get(t.rowid)) {
            // 影子行还在：vec0 没清（或本来就没有对应向量行），脚本显式补删
            acc.shadowRowsDeletedExplicitly += Number(p.deleteMap.run(t.rowid).changes ?? 0);
          } else if (vecChanges > 0) {
            acc.shadowRowsRemovedByVec0 += 1;
          }
          acc.ids.push({ rowid: t.rowid, id: t.id, inArchive: t.inArchive });
        }
        if (includeVecOnly) {
          for (const id of p.vecOnly) {
            const n = Number(p.deleteVecOnly.run(id).changes ?? 0);
            if (n > 0) vecOnlyDeleted.push({ vec: p.cfg.vec, id, deleted: n });
          }
        }
      });
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  const countsAfter = plans.map((p) => ({ vec: p.cfg.vec, map: p.cfg.map, vecRows: p.countVec(), mapRows: p.countMap() }));
  const orphansAfter = plans.map((p) => {
    const n = db
      .prepare(
        "SELECT COUNT(*) AS c FROM \"" + p.cfg.map + "\" m " +
          "WHERE NOT EXISTS (SELECT 1 FROM l1_records r WHERE r.record_id = m.id)"
      )
      .get().c;
    return { map: p.cfg.map, orphanMappings: n };
  });

  const audit = {
    at: new Date().toISOString(),
    tool: "prune-orphan-vectors",
    db: dbPath,
    backupPath,
    vecExtension: extPath,
    vecVersion,
    keyMode: report.keyMode,
    includeVecOnly,
    countsBefore: Object.fromEntries(report.tables.map((t) => [t.map, t.countsBefore])),
    countsAfter: Object.fromEntries(countsAfter.map((c) => [c.map, { vecRows: c.vecRows, mapRows: c.mapRows }])),
    deletions,
    skipped: report.tables.flatMap((t) => t.skipped.map((s) => ({ vec: t.vec, ...s }))),
    vecOnlyDeleted,
    verify: { orphansAfter },
  };
  const auditPath = join(backupDir, "orphan-vector-prune-" + stamp + ".json");
  writeFileSync(auditPath, JSON.stringify(audit, null, 2), "utf8");
  db.close();

  console.log(
    JSON.stringify(
      {
        ...report,
        mode: "apply",
        backupPath,
        auditPath,
        deleted: deletions.map((d) => ({ map: d.map, vecRows: d.deletedVecRows, shadowRowsRemovedByVec0: d.shadowRowsRemovedByVec0, shadowRowsDeletedExplicitly: d.shadowRowsDeletedExplicitly })),
        vecOnlyDeleted: vecOnlyDeleted.length,
        orphansAfter,
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