/**
 * 审计 F3：存量 L1 soul 字段回填（一次性，可重入）。
 * 对 l1_records 中 occurred_at/valence/significance 为空的行：
 *   1. 先用确定性 content-soul 规则（零 LLM，复用 patchSoulFromContent）
 *   2. 仍无 occurred_at → fallback created_time（写入时刻，P0 语义"缺省=提取时刻"）
 *   3. valence 仍无 → 0；significance 仍无 → 0.5（P0 兜底）
 * 不触碰 FTS/向量（soul 列不参与检索索引；只影响遗忘打分/UI 徽章）。
 * 默认 dry-run；加 --apply 真写。
 * 用法: node --import tsx scripts/backfill-soul-fields.ts [--apply] [--db=路径]
 */
import { VectorStore } from "../src/core/store/sqlite.js";
import { patchSoulFromContent } from "../src/core/lifecycle/consolidation/content-soul.js";

const apply = process.argv.includes("--apply");
const dbArg = process.argv.find((a) => a.startsWith("--db="))?.slice(5);
const dbPath = dbArg ?? "D:/tdai-data/vectors.db";

const vs = new VectorStore(dbPath, 0, console as never);
await vs.init();

interface Row {
  record_id: string;
  content: string;
  occurred_at: string | null;
  valence: number | null;
  significance: number | null;
  created_time: string;
  certainty: string | null;
  source: string | null;
}

const rows = (vs as unknown as { db: { prepare(sql: string): { all(): Row[] } } }).db
  .prepare(
    `SELECT record_id, content, occurred_at, valence, significance, created_time, certainty, source
     FROM l1_records
     WHERE occurred_at IS NULL OR occurred_at='' OR valence IS NULL OR significance IS NULL`,
  )
  .all();

const prep = (vs as unknown as { db: { prepare(sql: string): { run(...args: (string | number)[]): void } } }).db.prepare(
  `UPDATE l1_records SET occurred_at=?, valence=?, arousal=?, significance=?, certainty=?, source=? WHERE record_id=?`,
);

let dry = 0, updated = 0, perField = { occurred_at: 0, valence: 0, significance: 0 };
for (const r of rows) {
  const patch = patchSoulFromContent(r.content ?? "", { occurred_at: r.occurred_at ?? undefined });
  let occurredAt = patch.occurred_at ?? r.created_time ?? undefined;
  let valence = typeof r.valence === "number" ? r.valence : (typeof patch.valence === "number" ? patch.valence : 0);
  let significance = typeof r.significance === "number" ? r.significance : (typeof patch.significance === "number" ? patch.significance : 0.5);
  const certainty = (r.certainty ?? "observed") || "observed";
  const source = (r.source ?? "extraction") || "extraction";

  const changedO = !r.occurred_at && !!occurredAt;
  const changedV = r.valence == null || typeof r.valence !== "number";
  const changedS = r.significance == null || typeof r.significance !== "number";
  if (changedO) perField.occurred_at++;
  if (changedV) perField.valence++;
  if (changedS) perField.significance++;

  if (!changedO && !changedV && !changedS) continue;
  dry++;
  if (apply) {
    prep.run(String(occurredAt ?? ""), valence, 0, significance, String(certainty), String(source), r.record_id);
    updated++;
  }
}

console.log(`F3 backfill (${apply ? "APPLY" : "DRY-RUN"}): scanned=${rows.length}, rows-to-fill=${dry}, applied=${updated}`);
console.log(`  per-field: occurred_at=${perField.occurred_at}, valence=${perField.valence}, significance=${perField.significance}`);
if (!apply) console.log("  加 --apply 真写");
await vs.destroy?.();