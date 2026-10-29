import fs from "node:fs";
import path from "node:path";

const dir = "D:/TDB/td-agemem/MemoryCore/.eval-data/bench";
const files = process.argv.slice(2);
if (!files.length) {
  console.log("usage: node diag-bench2.mjs <report.json> ...");
  process.exit(1);
}

const KIND = (s) => {
  const t = String(s ?? "");
  if (/^\[(conclusion|conclusion_block|work_fact)/i.test(t)) return "conclusion";
  if (/^(conclusion|work_fact)\b/i.test(t)) return "conclusion";
  if (/episodic/i.test(t)) return "episodic";
  if (/semantic/i.test(t)) return "semantic";
  if (/preference/i.test(t)) return "preference";
  return "other";
};

for (const f of files) {
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  const rows = r.rows || [];
  const n = rows.length;
  const hitsHist = {};
  let conc = 0, epis = 0, other = 0, lines = 0;
  let poolShort = 0, allCorrect = 0, missTurn = 0, rankMiss = 0;
  const byType = {};

  for (const row of rows) {
    const h = Number(row.hits ?? 0);
    hitsHist[h] = (hitsHist[h] || 0) + 1;
    if (h < Number(row.k ?? 5)) poolShort++;
    for (const t of row.topContents || []) {
      lines++;
      const k = KIND(t);
      if (k === "conclusion") conc++;
      else if (k === "episodic") epis++;
      else other++;
    }
    const tc = Number(row.turnCov ?? 0);
    const t = row.questionType || "?";
    byType[t] ??= { n: 0, any: 0, turn: 0, mrr: 0, hits: 0, conc: 0 };
    byType[t].n++;
    byType[t].any += Number(row.sessionAny ?? 0);
    byType[t].turn += tc;
    byType[t].mrr += Number(row.mrr ?? 0);
    byType[t].hits += h;
    byType[t].conc += (row.topContents || []).filter((x) => KIND(x) === "conclusion").length;
    if (tc >= 1) allCorrect++;
    if (tc < 1) {
      // 证据轮完全没进注入行
      missTurn++;
      if (h >= Number(row.k ?? 5)) rankMiss++;
    }
  }

  console.log("=====", path.basename(f));
  console.log("rows", n, "| strategy", Object.entries(rows.reduce((a, x) => ((a[x.strategy] = (a[x.strategy] || 0) + 1), a), {})));
  console.log("hits 分布", hitsHist, "| 未填满 k 的行", poolShort, `(${(poolShort / n * 100).toFixed(0)}%)`);
  console.log("注入行类型: conclusion", conc, "/ episodic", epis, "/ other", other, `| 结论层占 ${(conc / Math.max(1, lines) * 100).toFixed(0)}%`);
  console.log("turnCov>=1 行", allCorrect, `| 证据轮完全未注入 ${missTurn} 行（其中 hits 已满 ${rankMiss}）`);
  console.log("分层均值:");
  for (const [t, v] of Object.entries(byType)) {
    console.log(
      ` ${t.padEnd(28)} n=${String(v.n).padStart(3)} any=${(v.any / v.n).toFixed(2)} ` +
      `turn=${(v.turn / v.n).toFixed(2)} mrr=${(v.mrr / v.n).toFixed(2)} avgHits=${(v.hits / v.n).toFixed(1)} ` +
      `结论行=${(v.conc / v.n).toFixed(1)}`
    );
  }
}
