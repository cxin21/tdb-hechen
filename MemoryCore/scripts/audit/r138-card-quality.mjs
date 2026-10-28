/**
 * #138 结论卡质量抽查（只读）：票面验收项「结论卡质量抽查（part_of 边完整、内容可回溯）」。
 *
 * 抽样口径（生产库 D:/TDB/data/vectors.db，只读打开）：
 *  ① part_of 边覆盖：work_fact 结论卡中有多少张至少有一条 part_of 出边（target=证据行）；
 *  ② 边完整性：边指向的行是否仍在库（l1_records / l1_archive），悬空边计数；
 *  ③ 内容可回溯：卡片正文与其证据行正文的词面重叠（≥2 个去重词 = 可回溯），抽 N 张统计。
 *
 * 用法：node scripts/audit/r138-card-quality.mjs [--db D:/TDB/data/vectors.db] [--sample 60] [--json]
 * 只读：SQLite 以 readOnly 打开，零写入零外呼。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const dbPath = String(arg("db", "D:/TDB/data/vectors.db"));
const sampleSize = Number(arg("sample", 60));
const asJson = process.argv.includes("--json");

const db = new DatabaseSync(dbPath, { readOnly: true });
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const tokens = (s) =>
  new Set(
    String(s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5]+/)
      .filter((t) => t.length >= 2),
  );

const cards = db.prepare("select record_id, content, created_time from l1_records where type='work_fact'").all();
// l1_archive 只有 data(JSON) 列：解开后取 type/content，供「归档卡」与「归档证据行」解析。
const archivedRows = db.prepare("select record_id, data from l1_archive").all().map((r) => {
  let d = {};
  try { d = JSON.parse(String(r.data ?? "{}")); } catch { /* 坏行跳过内容解析 */ }
  return { record_id: r.record_id, type: d.type ?? "", content: d.content ?? "" };
});
const archived = archivedRows.filter((r) => r.type === "work_fact");
const allIds = new Set([
  ...db.prepare("select record_id from l1_records").all().map((r) => r.record_id),
  ...archivedRows.map((r) => r.record_id),
]);
const edges = db.prepare("select source_id, target_id from l1_links where type='part_of'").all();
const byCard = new Map();
for (const e of edges) {
  if (!byCard.has(e.source_id)) byCard.set(e.source_id, []);
  byCard.get(e.source_id).push(e.target_id);
}

const withEdges = cards.filter((c) => (byCard.get(c.record_id) ?? []).length > 0);
const dangling = edges.filter((e) => !allIds.has(e.target_id)).length;
const edgeCounts = cards.map((c) => (byCard.get(c.record_id) ?? []).length);

// 内容可回溯抽样：卡正文 vs 其证据行的词面重叠
const allContent = db.prepare("select record_id, content from l1_records").all();
const contentById = new Map([
  ...allContent.map((r) => [r.record_id, r.content]),
  ...archivedRows.map((r) => [r.record_id, r.content]),
]);
const sample = withEdges.slice(0, sampleSize).map((c) => {
  const evIds = byCard.get(c.record_id) ?? [];
  const cardTokens = tokens(c.content);
  let best = 0;
  let missing = 0;
  for (const id of evIds) {
    const ev = contentById.get(id);
    if (ev === undefined) { missing++; continue; }
    const evTokens = tokens(ev);
    let hit = 0;
    for (const t of cardTokens) if (evTokens.has(t)) hit++;
    if (hit > best) best = hit;
  }
  return { recordId: c.record_id, edges: evIds.length, missing, bestOverlap: best };
});
const traceable = sample.filter((s) => s.bestOverlap >= 2).length;

const out = {
  dbPath,
  workFactCards: cards.length,
  workFactArchived: archived.length,
  cardsWithPartOf: withEdges.length,
  edgeCoverage: pct(withEdges.length, cards.length),
  partOfEdges: edges.length,
  danglingEdges: dangling,
  edgesPerCard: {
    mean: cards.length ? Math.round((edgeCounts.reduce((a, b) => a + b, 0) / cards.length) * 100) / 100 : null,
    withEdgesMean: withEdges.length
      ? Math.round((withEdges.reduce((a, c) => a + (byCard.get(c.record_id) ?? []).length, 0) / withEdges.length) * 100) / 100
      : null,
  },
  traceability: {
    sampled: sample.length,
    traceable,
    traceableRate: pct(traceable, sample.length),
    missingEvidenceRows: sample.reduce((a, s) => a + s.missing, 0),
    examples: sample.slice(0, 8),
  },
};

if (asJson) console.log(JSON.stringify(out, null, 1));
else {
  console.log("# #138 结论卡质量抽查（只读）");
  console.log("库: " + dbPath);
  console.log("");
  console.log("## ① part_of 边覆盖");
  console.log("- work_fact 结论卡: " + out.workFactCards + "（archive 另有 " + out.workFactArchived + "）");
  console.log("- 至少有一条 part_of 出边的卡: " + out.cardsWithPartOf + "（" + out.edgeCoverage + "%）");
  console.log("- part_of 边总数: " + out.partOfEdges + "；边/卡均值 " + out.edgesPerCard.mean + "，有边卡均值 " + out.edgesPerCard.withEdgesMean);
  console.log("");
  console.log("## ② 边完整性");
  console.log("- 悬空边（target 行已不在库）: " + out.danglingEdges + "（" + pct(out.danglingEdges, out.partOfEdges) + "%）");
  console.log("");
  console.log("## ③ 内容可回溯（抽 " + sample.length + " 张有边卡）");
  console.log("- 与至少一条证据行有 ≥2 个去重词重叠: " + out.traceability.traceable + "（" + out.traceability.traceableRate + "%）");
  console.log("- 证据行缺失: " + out.traceability.missingEvidenceRows + " 条");
  for (const e of out.traceability.examples) {
    console.log("  · " + e.recordId + " edges=" + e.edges + " missing=" + e.missing + " bestOverlap=" + e.bestOverlap);
  }
}
db.close();
