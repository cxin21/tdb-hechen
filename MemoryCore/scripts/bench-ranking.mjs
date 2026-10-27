/**
 * 档位排名（issue #134）：把基线报告与任意多个 trial 报告按同题配对，
 * 输出按「判对率」排序的排名表（Δ vs 基线 + paired bootstrap 95%CI），
 * 以及 turnCov@5 / 拒答 / 判分模型对照。
 *
 * 用法：
 *   node --import tsx scripts/bench-ranking.mjs --base <base.json> <trial.json...>
 */
import fs from "node:fs";
import { pairedBootstrap, pct, pp } from "./lib/bench/stats.mjs";

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return undefined;
  return argv[i + 1];
}
const baseFile = arg("base");
const trials = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base");
if (!baseFile || trials.length === 0) {
  console.error("用法: node --import tsx scripts/bench-ranking.mjs --base <base.json> <trial.json...>");
  process.exit(2);
}

const load = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const base = load(baseFile);
const bm = new Map(base.rows.map((r) => [r.caseId, r]));
const baseTag = base.config?.tag ?? baseFile;

/** 从 row 取判对/覆盖；缺字段按 0/缺失处理。 */
const correctOf = (r) => (r.genCorrect === 1 ? 1 : 0);
const covOf = (r) => (typeof r["turnCov@5"] === "number" ? r["turnCov@5"] : null);
const refusedOf = (r) => (r.refused === 1 ? 1 : 0);

const rows = [];
for (const f of [baseFile, ...trials]) {
  const rep = load(f);
  const tm = new Map(rep.rows.map((r) => [r.caseId, r]));
  const ids = [...bm.keys()].filter((id) => tm.has(id));
  const pairs = ids.map((id) => ({ a: bm.get(id), b: tm.get(id) }));
  const n = pairs.length;
  const m = (sel) => {
    const vals = pairs.map((p) => sel(p.b)).filter((v) => v !== null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  };
  const dCorrect = pairs.map((p) => correctOf(p.b) - correctOf(p.a));
  const covPairs = pairs.filter((p) => covOf(p.a) !== null && covOf(p.b) !== null);
  const dCov = covPairs.map((p) => covOf(p.b) - covOf(p.a));
  const accCi = pairedBootstrap(dCorrect, { iters: 10000 });
  const covCi = pairedBootstrap(dCov, { iters: 10000 });
  rows.push({
    tag: rep.config?.tag ?? f.split("/").pop(),
    isBase: f === baseFile,
    n,
    correct: m(correctOf),
    dCorrect: dCorrect.reduce((s, x) => s + x, 0) / n,
    ciLo: accCi.lo,
    ciHi: accCi.hi,
    refused: m(refusedOf),
    cov5: m(covOf),
    dCov: dCov.reduce((s, x) => s + x, 0) / n,
    covLo: covCi.lo,
    covHi: covCi.hi,
    model: rep.config?.answerModel ?? rep.config?.judgeModel ?? "-",
  });
}
const baseRow = rows.find((r) => r.isBase);
const ranked = rows.filter((r) => !r.isBase).sort((x, y) => y.correct - x.correct);

const L = [];
L.push("# LME90 档位排名（同题配对 n=" + baseRow.n + "，基线 " + baseTag + "）");
L.push("");
L.push("| # | 档 | 判对 | Δ vs 基线 [95%CI] | 拒答 | turnCov@5 | Δ cov [95%CI] | 判分模型 |");
L.push("|---|---|---|---|---|---|---|---|");
L.push(`| - | ${baseRow.tag}（基线） | ${pct(baseRow.correct)} | — | ${pct(baseRow.refused)} | ${pct(baseRow.cov5)} | — | ${baseRow.model} |`);
ranked.forEach((r, i) => {
  const sgn = (v) => (v >= 0 ? "+" : "");
  L.push(
    `| ${i + 1} | ${r.tag} | ${pct(r.correct)} | ${sgn(r.dCorrect)}${pp(r.dCorrect)} [${pp(r.ciLo)}, ${pp(r.ciHi)}] | ${pct(r.refused)} | ${pct(r.cov5)} | ${sgn(r.dCov)}${pp(r.dCov)} [${pp(r.covLo)}, ${pp(r.covHi)}] | ${r.model} |`,
  );
});
L.push("");
console.log(L.join("\n"));