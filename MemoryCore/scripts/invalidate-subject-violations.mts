// 作废两条「主语不是他」的档案行（2026-11-08 生产首次提炼写出）：
//   - 称呼：也叫 hechen，账号名即 hechen   → 账号标识不是称呼
//   - 近况：生产档案链路有缺陷，human 行仍为0 → 主语是系统，不是他
// 口径：不删行，写 validTo + supersededReason，并记账本 action=invalidate；缺省 dry-run，--apply 才写，写前备份。
// 用法：node --import tsx scripts/invalidate-subject-violations.mts [--apply]
import { copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DB = "D:/TDB/data/vectors.db";
const TENANT = { teamId: "team-2k12lgb650", userId: "usr-2m7b1144d9", agentId: "agt-bbr29z58s2" };
const REASON = "gate:subject_not_person";
const apply = process.argv.includes("--apply");

const { VectorStore } = await import("../src/core/store/sqlite.ts");
const { profileSubjectViolation } = await import("../src/core/person/profile.ts");

const store = new VectorStore(DB, 0);
const items = store.listSoulPersona(TENANT);
const bad = items.filter((it) => {
  if (it.layer !== "human") return false;
  const meta = it.meta as { profileField?: unknown } | undefined;
  const field = typeof meta?.profileField === "string" ? meta.profileField : null;
  if (field === null) return false;
  return profileSubjectViolation(field as never, it.text) !== null;
});

console.log(`[targets] ${bad.length} 行`);
for (const it of bad) {
  const meta = it.meta as { profileField?: string; person?: { key?: string } };
  console.log(" -", it.itemId, "|", meta.profileField, "|", it.text.slice(0, 40), "| person", meta.person?.key ?? "-");
}

// 反向核对：现行 human 档案行里有多少条能过这道门（避免一刀切把好的也作废）。
const alive = items.filter((it) => it.layer === "human" && it.validTo === undefined && (it.meta as { profileField?: unknown } | undefined)?.profileField !== undefined);
console.log(`[keep] 现行 human 档案行 ${alive.length - bad.length} 行（通过主语判据，不动）`);

if (bad.length === 0) {
  console.log("[done] 没有需要作废的行。");
  process.exit(0);
}
if (!apply) {
  console.log("[dry-run] 不写库。加 --apply 执行。");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
const backup = `${DB}.bak-profile-invalidate-${stamp}`;
copyFileSync(DB, backup);
console.log("[backup]", backup);

const now = new Date().toISOString();
const upsert = bad.map((it) => ({ ...it, validTo: now, supersededReason: REASON, updatedAt: now }));
const ledger = bad.map((it) => ({
  entryId: `inv-${it.itemId}-${now}`,
  at: now,
  trigger: "manual:subject-gate",
  layer: "human" as const,
  itemId: it.itemId,
  action: "invalidate" as const,
  reason: REASON,
  evidenceIds: [],
}));
const res = await store.commitSoulPersona(TENANT, { upsert, ledger });
console.log("[written]", JSON.stringify(res));

const back = store.listSoulPersona(TENANT, { includeSuperseded: true }).filter((it) => bad.some((b) => b.itemId === it.itemId));
for (const it of back) console.log("[verify]", it.itemId, "validTo=", it.validTo, "reason=", it.supersededReason);
store.close?.();