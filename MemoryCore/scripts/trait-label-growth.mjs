#!/usr/bin/env node
/**
 * 「标签有没有净增长」的只读读数（B9）：
 *   - soul_trait_label 按 status 计数（seed / admitted / 其它）
 *   - soul_ledger 里标签相关动作（admit / reject / merge）按 reason 聚合
 *   - soul_trait_state 行数与最近更新时间（轴有没有在动）
 *   - soul_episodes 的 agent_stance 覆盖（判「有没有票源」）
 *
 *   node scripts/trait-label-growth.mjs --db <vectors.db> [--team <team>]
 *
 * 只读：以 readOnly 打开，不建表、不迁移。
 */
import { DatabaseSync } from "node:sqlite";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dbPath = arg("--db");
if (!dbPath) {
  console.error("usage: node scripts/trait-label-growth.mjs --db <vectors.db> [--team <team>]");
  process.exit(1);
}
const team = arg("--team", "");
const db = new DatabaseSync(dbPath, { readOnly: true });
const one = (sql, ...args) => {
  try { return db.prepare(sql).get(...args) ?? null; } catch (e) { return { error: e.message }; }
};
const all = (sql, ...args) => {
  try { return db.prepare(sql).all(...args); } catch (e) { return [{ error: e.message }]; }
};
const cols = (t) => all(`PRAGMA table_info(${t})`).map((r) => r.name).filter(Boolean);
const has = (t, c) => cols(t).includes(c);

console.log("db=" + dbPath + (team ? " team=" + team : ""));
console.log("columns.soul_trait_label=" + cols("soul_trait_label").join(","));

const where = team && has("soul_trait_label", "tenant_id") ? " WHERE tenant_id LIKE ?" : "";
const wargs = where ? [team + "%"] : [];
const status = all(`SELECT status, COUNT(*) AS n FROM soul_trait_label${where} GROUP BY status ORDER BY n DESC`, ...wargs);
console.log("label.byStatus=" + JSON.stringify(status));
const total = one(`SELECT COUNT(*) AS n FROM soul_trait_label${where}`, ...wargs);
console.log("label.total=" + JSON.stringify(total));
const nonSeedWhere = where ? `${where} AND status <> 'seed'` : " WHERE status <> 'seed'";
const admitted = all(`SELECT label, status, first_seen, last_seen FROM soul_trait_label${nonSeedWhere} ORDER BY last_seen DESC LIMIT 20`, ...wargs);
console.log("label.nonSeed=" + JSON.stringify(admitted));

const ledger = all("SELECT action, COUNT(*) AS n FROM soul_ledger WHERE entry_id LIKE '%trait%' GROUP BY action ORDER BY n DESC");
console.log("ledger.traitActions=" + JSON.stringify(ledger));
const labelLedger = all("SELECT action, reason, COUNT(*) AS n FROM soul_ledger WHERE entry_id LIKE '%label%' GROUP BY action, reason ORDER BY n DESC LIMIT 20");
console.log("ledger.labelActions=" + JSON.stringify(labelLedger));
// 标签提案被拒走 soul_gate_stats（code = label_<reason>），不写账本。
const labelGates = all("SELECT code, SUM(count) AS n, MAX(last_at) AS last FROM soul_gate_stats WHERE code LIKE 'label\\_%' ESCAPE '\\' GROUP BY code");
console.log("gate.labelCodes=" + JSON.stringify(labelGates));

const state = one("SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM soul_trait_state");
console.log("traitState=" + JSON.stringify(state));

const eps = one("SELECT COUNT(*) AS n, SUM(CASE WHEN COALESCE(agent_stance,'') <> '' THEN 1 ELSE 0 END) AS withAgentStance FROM soul_episodes");
console.log("episodes=" + JSON.stringify(eps));

// 判读：有 nonSeed 标签 → 真生长；status 全 seed 且 ledger 无 reject → 代码没产票；
// status 全 seed 但有 reject → 产了票但被门挡（证据不够/判据太严）。
const nonSeed = admitted.filter((r) => r && !r.error && r.status !== "seed").length;
const rejects = labelGates.filter((r) => r && !r.error).reduce((a, r) => a + Number(r.n || 0), 0);
console.log("verdict=" + JSON.stringify({ nonSeed, rejects, kind: nonSeed > 0 ? "grown" : rejects > 0 ? "produced-but-rejected" : "no-proposal" }));
db.close();