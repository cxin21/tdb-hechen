#!/usr/bin/env node
/**
 * 回填 soul_person_relation.valid_from（issue #180 §S9 / Round3 阶段0 遗留项）。
 *
 * 背景：2026-11-18 之前 profile-distiller 把 valid_from 固定写成本轮 tick 的 now，
 * 于是「关系从哪条证据开始成立」被记成了「哪一轮提炼看到它」。新写入已改为取证据时间
 * （profile-distiller.ts 的 edgeAt），但**存量行不回填就永远是脏的**，而回填属于改历史，
 * 必须单独一步、可预期、可审计：
 *
 *   node scripts/migrate-soul-relation-validfrom.mjs --db <vectors.db>            # 只读演练
 *   node scripts/migrate-soul-relation-validfrom.mjs --db <vectors.db> --apply    # 真写
 *
 * 口径（R24-a3 修正）：
 *   - 证据集合 = 该边的 record_id + evidence_json[].recordId。
 *   - 证据时间优先取 evidence_json[].at（写关系时内存里就有这条记忆的时间）；
 *     缺失时才去同租户的 l1_records **与 l1_archive** 里查
 *     （2026-11-19 复核：5 条边里 3 条的共同证据已被 dedup-update 归档，
 *      只查 l1_records 会得到「可回填 0、找不到 3」的假阴性）。
 *   - 新 valid_from = 证据时间里最早的一个（created_time，没有时回落 updated_time）。
 *   - 只有当新值严格早于现值才改；valid_to 若早于新 valid_from 则夹到 valid_from
 *     （不倒挂，与新写入侧 CASE WHEN 一致）。
 *   - 不改 rel_id、不改 created_at/updated_at：rel_id 里含旧 validFrom，改它会破坏幂等键。
 *
 * 输出：计划/apply 的计数 + 前 5 条样例（rel_id / old / new）。退出码 0=完成，1=参数/IO 错。
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
  console.error("usage: node scripts/migrate-soul-relation-validfrom.mjs --db <vectors.db> [--apply]");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const table = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='soul_person_relation'")
  .get();
if (!table) {
  console.log("soul_person_relation 不存在：这个库还没启用人物关系边，无需回填。");
  process.exit(0);
}

const rows = db
  .prepare(
    "SELECT rel_id, team_id, user_id, agent_id, record_id, evidence_json, valid_from, valid_to FROM soul_person_relation",
  )
  .all();

function evidenceRefsOf(row) {
  /** @type {Array<{ id: string, at: string }>} */
  const refs = [];
  const seen = new Set();
  const push = (id, at) => {
    const key = `${id}\u0000${at}`;
    if (id === "" || seen.has(key)) return;
    seen.add(key);
    refs.push({ id, at });
  };
  if (typeof row.record_id === "string" && row.record_id.trim() !== "") push(row.record_id.trim(), "");
  try {
    const parsed = JSON.parse(typeof row.evidence_json === "string" ? row.evidence_json : "[]");
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const id = item.recordId ?? item.record_id;
        if (typeof id === "string" && id.trim() !== "") {
          push(id.trim(), typeof item.at === "string" ? item.at : "");
        }
      }
    }
  } catch {
    // evidence_json 坏了不影响 record_id 这一条证据。
  }
  return refs;
}

const liveAtStmt = db.prepare(
  `SELECT COALESCE(NULLIF(created_time, ''), NULLIF(updated_time, ''), '') AS at
     FROM l1_records
    WHERE team_id = ? AND user_id = ? AND agent_id = ? AND record_id = ?`,
);
const hasArchive = Boolean(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='l1_archive'").get(),
);
// l1_archive.data 是整行 JSON；活表已被 dedup-update/dedup-merge 挪走的记录只能从这里拿时间。
const archiveAtStmt = hasArchive
  ? db.prepare(
      `SELECT COALESCE(
                NULLIF(json_extract(data, '$.created_time'), ''),
                NULLIF(json_extract(data, '$.updated_time'), ''),
                ''
              ) AS at
         FROM l1_archive
        WHERE team_id = ? AND user_id = ? AND agent_id = ? AND record_id = ?`,
    )
  : null;

const candidates = [];
let unresolved = 0;
let atFromEvidence = 0;
let atFromLive = 0;
let atFromArchive = 0;
for (const row of rows) {
  const refs = evidenceRefsOf(row);
  let earliest = "";
  for (const ref of refs) {
    let at = ref.at;
    let source = at !== "" ? "evidence" : "";
    if (at === "") {
      const live = liveAtStmt.get(row.team_id, row.user_id, row.agent_id, ref.id);
      at = live && typeof live.at === "string" ? live.at : "";
      if (at !== "") source = "live";
    }
    if (at === "" && archiveAtStmt) {
      const archived = archiveAtStmt.get(row.team_id, row.user_id, row.agent_id, ref.id);
      at = archived && typeof archived.at === "string" ? archived.at : "";
      if (at !== "") source = "archive";
    }
    if (at === "") continue;
    if (earliest === "" || at < earliest) {
      earliest = at;
      if (source === "evidence") atFromEvidence += 1;
      else if (source === "live") atFromLive += 1;
      else atFromArchive += 1;
    }
  }
  if (earliest === "") {
    unresolved += 1;
    continue;
  }
  if (earliest < String(row.valid_from ?? "")) {
    candidates.push({ ...row, evidenceAt: earliest });
  }
}

console.log(
  `扫描关系边 ${rows.length} 条；可回填 ${candidates.length} 条；证据在 l1_records/l1_archive 里找不到 ${unresolved} 条。`,
);
console.log(
  `最早证据时间的来源：evidence_json ${atFromEvidence} 次 / l1_records ${atFromLive} 次 / l1_archive ${atFromArchive} 次（archive ${hasArchive ? "可查" : "无表"}）。`,
);
for (const row of candidates.slice(0, 5)) {
  console.log(`  - ${row.rel_id}: ${row.valid_from} → ${row.evidenceAt}`);
}

if (!apply) {
  console.log("这是只读演练。确认后加 --apply 才写库。");
  process.exit(0);
}

const update = db.prepare(
  `UPDATE soul_person_relation
      SET valid_from = ?,
          valid_to = CASE WHEN valid_to IS NOT NULL AND valid_to < ? THEN ? ELSE valid_to END
    WHERE rel_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?`,
);
let changed = 0;
db.exec("BEGIN");
try {
  for (const row of candidates) {
    update.run(row.evidenceAt, row.evidenceAt, row.evidenceAt, row.rel_id, row.team_id, row.user_id, row.agent_id);
    changed += 1;
  }
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}
console.log(`已回填 ${changed} 条 valid_from（valid_to 早于新 valid_from 的已夹取）。`);
