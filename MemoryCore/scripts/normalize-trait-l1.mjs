#!/usr/bin/env node
/**
 * 一次性迁移（B2）：把 soul_trait_state 的 axis_json / seed_state_json 缩进 L1 预算。
 *
 * 背景：修复前 seedStateFromSeeds 只 clamp 单轴、不做 L1 归一，存量行可能 Σ|x| 远超
 * TRAIT_L1_MAX=0.5（实测 agt-3i8k22f496 Σ=2.1），第一次漂移从超限状态出发，步长约束失效。
 * 修复后种子与漂移入口都已归一；本脚本负责把「已经写进库」的存量行拉回预算内。
 *
 * 用法：
 *   node scripts/normalize-trait-l1.mjs            # 默认 dry-run：只读，打印将改行
 *   node scripts/normalize-trait-l1.mjs --apply    # 备份数据库后真正缩放 + 写账本
 *
 * 库路径默认 D:/TDB/data/vectors.db，可用 SOUL_DB 覆盖（只测临时库时用）。
 * --apply 备份到 <db>.bak-trait-l1-<yyyymmdd-hhmmss>；不覆盖已有备份。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const AXES = ["warmth", "agency", "rigor", "openness", "stability", "boundary"];
const L1_MAX = 0.5;
const EPS = 1e-9;
const DB = process.env.SOUL_DB || "D:/TDB/data/vectors.db";
const apply = process.argv.includes("--apply");

const l1 = (arr) => arr.reduce((s, v) => s + Math.abs(v), 0);

/** 数组/对象/JSON 字符串 → 6 轴数组；缺失补 0，非有限数补 0。 */
function parseAxis(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (parsed == null) return null;
  if (Array.isArray(parsed)) {
    return AXES.map((_, i) => {
      const v = Number(parsed[i]);
      return Number.isFinite(v) ? v : 0;
    });
  }
  if (typeof parsed === "object") {
    return AXES.map((axis) => {
      const v = Number(parsed[axis]);
      return Number.isFinite(v) ? v : 0;
    });
  }
  return null;
}

/** 超限则等比缩放（向零截断到 4 位，保证缩放后 Σ 不回弹）；合规返回 null。 */
function normalizeAxis(arr) {
  const before = l1(arr);
  if (!Number.isFinite(before) || before <= L1_MAX + EPS) return null;
  const factor = L1_MAX / before;
  const out = arr.map((v) => Math.trunc(v * factor * 1e4) / 1e4);
  let total = l1(out);
  if (total > L1_MAX + EPS) {
    const f2 = L1_MAX / total;
    for (let i = 0; i < out.length; i += 1) out[i] = Math.trunc(out[i] * f2 * 1e4) / 1e4;
    total = l1(out);
  }
  return { arr: out, before, after: total, factor };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

if (!fs.existsSync(DB)) {
  console.error(`[trait-l1] 数据库不存在：${DB}`);
  process.exit(1);
}

const db = new DatabaseSync(DB, apply ? {} : { readOnly: true });

let rows;
try {
  rows = db
    .prepare(
      "SELECT team_id, user_id, agent_id, axis_json, seed_state_json, updated_at FROM soul_trait_state ORDER BY team_id, user_id, agent_id",
    )
    .all();
} catch (err) {
  console.error(`[trait-l1] 读 soul_trait_state 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const plan = [];
for (const row of rows) {
  const axis = parseAxis(row.axis_json);
  const seed = parseAxis(row.seed_state_json);
  const nextAxis = axis ? normalizeAxis(axis) : null;
  const nextSeed = seed ? normalizeAxis(seed) : null;
  if (!nextAxis && !nextSeed) continue;
  plan.push({
    key: `${row.team_id}/${row.user_id}/${row.agent_id}`,
    axis,
    seed,
    nextAxis,
    nextSeed,
  });
}

console.log(`[trait-l1] 库：${DB}`);
console.log(`[trait-l1] 模式：${apply ? "APPLY" : "dry-run（只读）"}`);
console.log(`[trait-l1] soul_trait_state 共 ${rows.length} 行，需要归一 ${plan.length} 行`);
for (const item of plan) {
  const parts = [];
  if (item.nextAxis) {
    parts.push(`axis Σ${item.nextAxis.before.toFixed(4)}→${item.nextAxis.after.toFixed(4)}`);
  }
  if (item.nextSeed) {
    parts.push(`seed Σ${item.nextSeed.before.toFixed(4)}→${item.nextSeed.after.toFixed(4)}`);
  }
  console.log(`  - ${item.key}  ${parts.join("；")}`);
}

if (!apply || plan.length === 0) {
  if (!apply && plan.length > 0) console.log("[trait-l1] dry-run 未写任何字节；确认后加 --apply 执行。");
  db.close();
  process.exit(0);
}

// ---- apply ----
const backup = `${DB}.bak-trait-l1-${stamp()}`;
if (fs.existsSync(backup)) {
  console.error(`[trait-l1] 备份已存在，拒绝覆盖：${backup}`);
  process.exit(1);
}
db.close();
fs.copyFileSync(DB, backup);
console.log(`[trait-l1] 已备份：${backup}`);

const wdb = new DatabaseSync(DB);
const now = new Date().toISOString();
let ledgered = 0;
try {
  wdb.exec("BEGIN");
  const upd = wdb.prepare(
    "UPDATE soul_trait_state SET axis_json = ?, seed_state_json = ? WHERE team_id = ? AND user_id = ? AND agent_id = ?",
  );
  const ins = wdb.prepare(
    `INSERT OR IGNORE INTO soul_ledger
      (entry_id, team_id, user_id, agent_id, at, trigger, layer, item_id, action, gates_json, reason, before_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of plan) {
    const nextAxisArr = item.nextAxis ? item.nextAxis.arr : item.axis;
    const nextSeedArr = item.nextSeed ? item.nextSeed.arr : item.seed;
    upd.run(JSON.stringify(nextAxisArr), JSON.stringify(nextSeedArr), item.key.split("/")[0], item.key.split("/")[1], item.key.split("/")[2]);
    const reasons = [];
    if (item.nextAxis) {
      reasons.push(`axis Σ|x| ${item.nextAxis.before.toFixed(4)}→${item.nextAxis.after.toFixed(4)}（×${item.nextAxis.factor.toFixed(4)}）`);
    }
    if (item.nextSeed) {
      reasons.push(`seed Σ|x| ${item.nextSeed.before.toFixed(4)}→${item.nextSeed.after.toFixed(4)}（×${item.nextSeed.factor.toFixed(4)}）`);
    }
    const beforeJson = JSON.stringify({
      axis: item.axis,
      seed: item.seed,
    });
    const res = ins.run(
      `mig-trait-l1-${now}-${ledgered}`,
      item.key.split("/")[0],
      item.key.split("/")[1],
      item.key.split("/")[2],
      now,
      "migration",
      "trait",
      null,
      "trait_normalized",
      JSON.stringify(["trait_l1"]),
      `L1 归一（B2：种子绕过 L1）：${reasons.join("；")}`,
      beforeJson,
    );
    ledgered += Number(res.changes);
  }
  wdb.exec("COMMIT");
} catch (err) {
  try {
    wdb.exec("ROLLBACK");
  } catch {
    /* ignore */
  }
  wdb.close();
  console.error(`[trait-l1] 迁移失败，已回滚（备份仍在 ${backup}）：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
wdb.close();
console.log(`[trait-l1] 完成：归一 ${plan.length} 行，写账本 ${ledgered} 行（action=trait_normalized, gates=[trait_l1]）`);
