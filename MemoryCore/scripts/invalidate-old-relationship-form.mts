// 作废旧行文的关系层行（2026-11-08 行文改造）：这些行的 itemId 由文本哈希决定，
// 行文一改就是新 id，旧行不会自己消失——不主动写 validTo，卡上会同时出现新旧两种写法。
//
// 判据（确定性，只看文本形状）：旧写法是「他（指出）：「…」；<我这轮的回复>」，
// 分隔符是「」；」；新写法是「…」——<我做到没有>」。因此 `」；` 就是旧行文的指纹。
// 缺省 dry-run，--apply 才写；写前整库备份；走 commitSoulPersona 同事务记账本 action=invalidate。
// 用法：node --import tsx scripts/invalidate-old-relationship-form.mts [--apply]
import { copyFileSync } from "node:fs";

const DB = "D:/TDB/data/vectors.db";
const TENANT = { teamId: "team-2k12lgb650", userId: "usr-2m7b1144d9", agentId: "agt-bbr29z58s2" };
const REASON = "gate:relationship_form_v2";
const OLD_FORM = /」；/u;
const apply = process.argv.includes("--apply");

const { VectorStore } = await import("../src/core/store/sqlite.ts");

const store = new VectorStore(DB, 0);
const items = store.listSoulPersona(TENANT);
const alive = items.filter((it) => it.layer === "relationship" && it.validTo === undefined);
const bad = alive.filter((it) => OLD_FORM.test(it.text));

console.log(`[alive] 现行 relationship 行 ${alive.length} 行`);
console.log(`[targets] 旧行文 ${bad.length} 行`);
for (const it of bad) console.log(" -", it.itemId, "|", it.text.slice(0, 60));
console.log(`[keep] 新行文 ${alive.length - bad.length} 行（不动）`);

if (bad.length === 0) {
  console.log("[done] 没有需要作废的行。");
  process.exit(0);
}
if (!apply) {
  console.log("[dry-run] 不写库。加 --apply 执行。");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
const backup = `${DB}.bak-relationship-form-${stamp}`;
copyFileSync(DB, backup);
console.log("[backup]", backup);

const now = new Date().toISOString();
const upsert = bad.map((it) => ({ ...it, validTo: now, supersededReason: REASON, updatedAt: now }));
const ledger = bad.map((it) => ({
  entryId: `inv-${it.itemId}-${now}`,
  at: now,
  trigger: "manual:relationship-form-v2",
  layer: "relationship" as const,
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
