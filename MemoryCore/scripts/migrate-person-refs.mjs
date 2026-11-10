#!/usr/bin/env node
/**
 * 一次性迁移（人格系统 v3 阶段 1 / §5.1）：`metadata_json.personRefs` → `metadata_json.persons`
 * ，同时把已知的 5 个人建进 `soul_person`。
 *
 * 为什么要保留 personRefs：读侧「persons 缺失 → 回退 personRefs」的兼容层本阶段**没有**实现
 * （阶段 1 只做写侧）。删掉旧键等于让这批记忆在新读法上线前短暂失去归属，所以迁移只加不删；
 * 旧键留着同时充当回滚证据：`persons` 写错了，把 `$.persons` 去掉即可回到迁移前。
 *
 * 用法：
 *   node scripts/migrate-person-refs.mjs                  # dry-run（只读）：待迁移行数 / 映射人数
 *   node scripts/migrate-person-refs.mjs --apply          # 备份 → 建表建人 → 逐行写 persons → 校验
 *   SOUL_DB=D:/tmp/x.db node scripts/migrate-person-refs.mjs --apply    # 对临时库演练
 *
 * 安全边界：
 *   - 缺省只读打开，未加 --apply 时一个字节都不写；
 *   - --apply 先用 `VACUUM INTO` 做一致性备份（含 WAL 内容），打印备份绝对路径，备份已存在则拒绝覆盖；
 *   - 全部写在一个事务里，任一步失败 ROLLBACK 并保留备份；
 *   - 写后强制校验 §5.1 的断言（persons 为空的 personRefs 行 = 0），不为 0 就以非 0 退出。
 *
 * 实现细节：本脚本要复用 `personKeyOf`（`p_name_<sha1…12>` 的唯一实现）与 `SOUL_PERSON_DDL`
 * （建表语句唯一一份），因此以 tsx loader 重新执行自身；这样 `node scripts/migrate-person-refs.mjs`
 * 这条命令本身仍然成立，且不产生第二份哈希/DDL 手抄。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TSX_ENV = "__MIGRATE_PERSON_REFS_TSX__";
if (!process.env[TSX_ENV]) {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, [TSX_ENV]: "1" } },
  );
  process.exit(typeof child.status === "number" ? child.status : 1);
}

const { DatabaseSync } = await import("node:sqlite");
const { personKeyOf, normalizePersonName } = await import("../src/core/person/resolve.ts");
const { SOUL_PERSON_DDL } = await import("../src/core/store/soul-person-ddl.ts");

const TAG = "[migrate-person-refs]";
const DB = process.env.SOUL_DB || "D:/TDB/data/vectors.db";
const apply = process.argv.includes("--apply");

/**
 * 规范展示名（归一化名 → 展示名）。**不再用固定 person_key**：
 * person_key 由 personKeyOf 按「租户 + 归一化名」生成，同一个人在不同 team/user/agent 下是不同 key，
 * 与 soul_person(person_key PK) + resolvePerson 的租户口径一致（v4 §3 P1-B）。
 */
const CANONICAL_DISPLAY = {
  lead: "Lead",
  何晨: "何晨",
  用户: "用户",
  wlp: "wlp",
};

/** 多值拆条：数组外层 + 字符串内 `,，、;；/` 分隔（不拆空白——"John Smith" 是一个名字）。 */
const SPLIT_RE = /[,，、;；/]+/u;

function splitNames(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    for (const part of item.split(SPLIT_RE)) {
      const name = part.trim();
      if (name !== "") out.push(name);
    }
  }
  return out;
}

/** 按归一化名去重，保留第一次出现的原始写法（展示名用）。 */
function dedupeNames(names) {
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const norm = normalizePersonName(name);
    if (norm === "" || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ raw: name, norm });
  }
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

if (!fs.existsSync(DB)) {
  console.error(`${TAG} 数据库不存在：${DB}`);
  process.exit(1);
}

// ============================
// 1. 读 + 计划（只读，dry-run 与 apply 共用同一份计划）
// ============================
let db = new DatabaseSync(DB, { readOnly: true });
db.exec("PRAGMA busy_timeout=5000");

let rows;
let totalL1;
try {
  totalL1 = Number(db.prepare("SELECT count(*) AS c FROM l1_records").get().c);
  rows = db
    .prepare("SELECT record_id, team_id, user_id, agent_id, metadata_json FROM l1_records WHERE metadata_json LIKE '%personRefs%'")
    .all();
} catch (err) {
  console.error(`${TAG} 读 l1_records 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const plan = [];
const skipped = { invalidJson: 0, alreadyHasPersons: 0, noUsableName: 0 };
/** `${tenantKey}\u0000${person_key}` → { tenant, tenantKey, key, displayName, aliases:Set, rows:number } */
const keyStats = new Map();
/** 租户 → 行数 */
const tenantStats = new Map();

for (const row of rows) {
  let meta;
  try {
    meta = JSON.parse(row.metadata_json);
  } catch {
    skipped.invalidJson += 1;
    continue;
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    skipped.invalidJson += 1;
    continue;
  }
  if (Array.isArray(meta.persons) && meta.persons.length > 0) {
    // 幂等：已经挂过人的行不动（重跑 / 写侧先写过）。
    skipped.alreadyHasPersons += 1;
    continue;
  }
  const names = dedupeNames(splitNames(meta.personRefs));
  if (names.length === 0) {
    skipped.noUsableName += 1;
    continue;
  }
  const tenant = { teamId: row.team_id, userId: row.user_id, agentId: row.agent_id };
  const tenantKey = `${tenant.teamId}\u0000${tenant.userId}\u0000${tenant.agentId}`;
  const persons = [];
  const seenKeys = new Set();
  for (const { raw, norm } of names) {
    // 租户内唯一：同一个人在不同 team/user/agent 下是不同 person_key（v4 §3 P1-B）。
    const key = personKeyOf({ ...tenant, displayName: raw });
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    persons.push({ key, role: "subject" });
    const statKey = `${tenantKey}\u0000${key}`;
    const stat = keyStats.get(statKey) ?? {
      tenant,
      tenantKey,
      key,
      displayName: CANONICAL_DISPLAY[norm] ?? raw,
      aliases: new Set(),
      rows: 0,
    };
    stat.aliases.add(raw);
    stat.rows += 1;
    keyStats.set(statKey, stat);
  }
  if (persons.length === 0) {
    skipped.noUsableName += 1;
    continue;
  }
  plan.push({ recordId: String(row.record_id), persons });
  tenantStats.set(tenantKey, (tenantStats.get(tenantKey) ?? 0) + 1);
}

const personList = [...keyStats.values()];
const perTenantPersonCount = new Map();
for (const stat of personList) {
  perTenantPersonCount.set(stat.tenantKey, (perTenantPersonCount.get(stat.tenantKey) ?? 0) + 1);
}
const totalPersonLinks = plan.reduce((s, p) => s + p.persons.length, 0);

console.log(`${TAG} 库：${DB}`);
console.log(`${TAG} 模式：${apply ? "APPLY（会写库）" : "dry-run（只读，不写任何字节）"}`);
console.log(`${TAG} l1_records 共 ${totalL1} 行；metadata 含 personRefs 的 ${rows.length} 行`);
console.log(`${TAG} 待迁移行数：${plan.length}（拟写 persons 条目 ${totalPersonLinks} 条）`);
console.log(`${TAG} 拟建人数：${personList.length}（按租户 × 归一化名，去重后）`);
if (skipped.alreadyHasPersons > 0) console.log(`${TAG} 已有 persons 跳过：${skipped.alreadyHasPersons} 行`);
if (skipped.invalidJson > 0) console.log(`${TAG} metadata 非法 JSON 跳过：${skipped.invalidJson} 行`);
if (skipped.noUsableName > 0) console.log(`${TAG} personRefs 拆不出名字跳过：${skipped.noUsableName} 行`);
console.log(`${TAG} 人 → 行数（按租户）：`);
for (const stat of [...personList].sort((a, b) => b.rows - a.rows)) {
  const t = `${stat.tenant.teamId}/${stat.tenant.userId}/${stat.tenant.agentId}`;
  console.log(
    `  ${stat.key.padEnd(24)} ${String(stat.rows).padStart(4)} 行  ${stat.displayName}  [${t}]  别名=[${[...stat.aliases].join(", ")}]`,
  );
}
const tenantList = [...tenantStats.entries()].sort((a, b) => b[1] - a[1]);
console.log(`${TAG} 受影响租户：${tenantList.length} 组`);
for (const [tk, n] of tenantList) {
  console.log(`  ${tk.split("\u0000").join(" / ")}  ${n} 行`);
}

// ============================
// 2. dry-run 到此为止
// ============================
if (!apply) {
  // 顺手跑一遍 §5.1 的校验断言，让 dry-run 就暴露"迁移后会不会仍不满足"。
  let preMissing = null;
  try {
    preMissing = Number(
      db
        .prepare(
          "SELECT count(*) AS c FROM l1_records WHERE metadata_json LIKE '%personRefs%' AND json_extract(metadata_json, '$.persons') IS NULL",
        )
        .get().c,
    );
  } catch (err) {
    console.log(`${TAG} 校验查询当前不可执行（${err instanceof Error ? err.message : String(err)}）——迁移后会重试`);
  }
  if (preMissing !== null) {
    console.log(`${TAG} 当前「有 personRefs 但无 persons」的行：${preMissing}（迁移后必须为 0）`);
  }
  console.log(`${TAG} dry-run 未写任何字节；确认后加 --apply 执行。`);
  db.close();
  process.exit(0);
}

if (plan.length === 0) {
  console.log(`${TAG} 没有需要迁移的行；不建人也不备份（无写入）。`);
  db.close();
  process.exit(0);
}

// ============================
// 3. 备份（VACUUM INTO：单文件、含 WAL 内容、一致性快照）
// ============================
const backup = `${DB}.bak-person-refs-${stamp()}`;
if (fs.existsSync(backup)) {
  console.error(`${TAG} 备份已存在，拒绝覆盖：${backup}`);
  process.exit(1);
}
let backupMode = "vacuum-into";
try {
  db.prepare("VACUUM INTO ?").run(backup);
} catch (err) {
  // 兜底：三件套文件拷贝（含 -wal/-shm）。注意这种备份必须整组还原。
  console.warn(
    `${TAG} VACUUM INTO 失败（${err instanceof Error ? err.message : String(err)}），退回文件拷贝（含 -wal/-shm）`,
  );
  backupMode = "file-copy";
  fs.copyFileSync(DB, backup);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${DB}${suffix}`)) fs.copyFileSync(`${DB}${suffix}`, `${backup}${suffix}`);
  }
}
const backupSize = fs.existsSync(backup) ? fs.statSync(backup).size : 0;
if (backupSize <= 0) {
  console.error(`${TAG} 备份失败（文件为空）：${backup}`);
  process.exit(1);
}
console.log(`${TAG} 已备份（${backupMode}）：${backup}（${backupSize} 字节）`);
// 备份自检：能只读打开且行数与源库一致，才算"可回滚"。
try {
  const bdb = new DatabaseSync(backup, { readOnly: true });
  const n = Number(bdb.prepare("SELECT count(*) AS c FROM l1_records").get().c);
  bdb.close();
  if (n !== totalL1) throw new Error(`备份行数 ${n} ≠ 源库 ${totalL1}`);
  console.log(`${TAG} 备份自检通过：l1_records ${n} 行`);
} catch (err) {
  console.error(`${TAG} 备份自检失败，中止（未写库）：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
db.close();

// ============================
// 4. 写：建表 → 建人 → 逐行 persons，全在一个事务里
// ============================
if (tenantList.length > 1) {
  console.log(`${TAG} 租户口径：${tenantList.length} 组各自建人（同一个人在不同租户下是不同 person_key）`);
}

const wdb = new DatabaseSync(DB);
wdb.exec("PRAGMA busy_timeout=5000");
const now = new Date().toISOString();
let linkedRows = 0;
let failedUpdates = 0;
try {
  wdb.exec("BEGIN IMMEDIATE");
  for (const ddl of SOUL_PERSON_DDL) wdb.exec(ddl);

  const insPerson = wdb.prepare(
    `INSERT INTO soul_person
       (person_key, team_id, user_id, agent_id, platform, platform_id, display_name, aliases_json, merged_into, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', NULL, ?, ?, NULL, ?, ?)
     ON CONFLICT(person_key) DO UPDATE SET
       display_name = CASE WHEN soul_person.display_name = '' THEN excluded.display_name ELSE soul_person.display_name END,
       aliases_json = excluded.aliases_json,
       updated_at = excluded.updated_at`,
  );
  for (const stat of personList) {
    insPerson.run(
      stat.key,
      stat.tenant.teamId,
      stat.tenant.userId,
      stat.tenant.agentId,
      stat.displayName,
      JSON.stringify([...stat.aliases]),
      now,
      now,
    );
  }

  // json(?) 让绑定值按 JSON 文本写入而不是再被转义一层；record_id 精确定位，不碰别的列。
  const upd = wdb.prepare(
    "UPDATE l1_records SET metadata_json = json_set(metadata_json, '$.persons', json(?)) WHERE record_id = ?",
  );
  for (const item of plan) {
    try {
      linkedRows += Number(upd.run(JSON.stringify(item.persons), item.recordId).changes);
    } catch (err) {
      failedUpdates += 1;
      console.warn(`${TAG} 行 ${item.recordId} 写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failedUpdates > 0) {
    throw new Error(`${failedUpdates} 行写入失败（已回滚，宁可不迁移也不留半成品）`);
  }
  wdb.exec("COMMIT");
} catch (err) {
  try {
    wdb.exec("ROLLBACK");
  } catch {
    /* ignore */
  }
  wdb.close();
  console.error(`${TAG} 迁移失败，已回滚（备份仍在 ${backup}）：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ============================
// 5. 写后校验（§5.1 断言）
// ============================
const check = new DatabaseSync(DB, { readOnly: true });
let missingWithRefs = null;
let checkError = null;
try {
  missingWithRefs = Number(
    check
      .prepare(
        "SELECT count(*) AS c FROM l1_records WHERE metadata_json LIKE '%personRefs%' AND json_extract(metadata_json, '$.persons') IS NULL",
      )
      .get().c,
  );
} catch (err) {
  checkError = err instanceof Error ? err.message : String(err);
  if (checkError && checkError.includes("malformed")) {
    // 有非法 JSON 行时 json_extract 会抛错：改用 json_valid 守卫，语义等价（非法 JSON 无法承载 persons）。
    missingWithRefs = Number(
      check
        .prepare(
          "SELECT count(*) AS c FROM l1_records WHERE metadata_json LIKE '%personRefs%' AND json_valid(metadata_json) AND json_extract(metadata_json, '$.persons') IS NULL",
        )
        .get().c,
    );
  }
}
const withPersons = Number(
  check.prepare("SELECT count(*) AS c FROM l1_records WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.persons') IS NOT NULL").get().c,
);
const personRows = Number(check.prepare("SELECT count(*) AS c FROM soul_person WHERE merged_into IS NULL").get().c);
// 逐租户可解析：每个被引用的 person_key 必须在同一租户下存在一行（v4 §9 判据 1 的加强版）。
const personIndex = new Set(
  check
    .prepare("SELECT team_id, user_id, agent_id, person_key FROM soul_person WHERE merged_into IS NULL")
    .all()
    .map((r) => `${r.team_id}\u0000${r.user_id}\u0000${r.agent_id}\u0000${r.person_key}`),
);
let unresolvedRefs = 0;
for (const r of check.prepare("SELECT team_id, user_id, agent_id, metadata_json FROM l1_records WHERE json_valid(metadata_json) AND json_extract(metadata_json,'$.persons') IS NOT NULL").all()) {
  let list;
  try { list = JSON.parse(r.metadata_json).persons; } catch { continue; }
  if (!Array.isArray(list)) continue;
  for (const item of list) {
    const k = item && typeof item === "object" ? item.key : undefined;
    if (typeof k !== "string" || k === "") continue;
    if (!personIndex.has(`${r.team_id}\u0000${r.user_id}\u0000${r.agent_id}\u0000${k}`)) unresolvedRefs += 1;
  }
}
const totalL1After = Number(check.prepare("SELECT count(*) AS c FROM l1_records").get().c);
const refsStillThere = Number(
  check.prepare("SELECT count(*) AS c FROM l1_records WHERE metadata_json LIKE '%personRefs%'").get().c,
);
check.close();
wdb.close();

console.log(`${TAG} 写入完成：更新 ${linkedRows} 行，建/更新 ${keyStats.size} 个人，l1_records ${totalL1} → ${totalL1After} 行`);
console.log(`${TAG} 校验：有 personRefs 且无 persons 的行 = ${missingWithRefs}（断言 0）`);
console.log(`${TAG} 校验：含 persons 的行 = ${withPersons}（期望 ${plan.length}）`);
console.log(`${TAG} 校验：personRefs 仍保留 ${refsStillThere} 行（只加不删）`);
console.log(`${TAG} 校验：soul_person 未合并行 = ${personRows}（期望 = ${personList.length}）`);
console.log(`${TAG} 校验：租户内查不到人的引用 = ${unresolvedRefs}（断言 0）`);

const ok =
  missingWithRefs === 0 &&
  withPersons === plan.length &&
  totalL1After === totalL1 &&
  personRows >= personList.length &&
  unresolvedRefs === 0;
if (!ok) {
  console.error(`${TAG} 校验未通过；如需回滚：把备份 ${backup} 覆盖回 ${DB}（先停服务）`);
  process.exit(1);
}
console.log(`${TAG} PASS：迁移完成。回滚方式：停服务后用 ${backup} 覆盖 ${DB}${backupMode === "file-copy" ? "（并一并还原 -wal/-shm）" : ""}`);
