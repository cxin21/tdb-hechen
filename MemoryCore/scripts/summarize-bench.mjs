#!/usr/bin/env node
/**
 * summarize-bench —— S6 决策汇总：基线 vs 多档试验的一页对比表。
 *
 * 用法：node scripts/summarize-bench.mjs <base.json> <trial1.json> [<trial2.json> ...] [--boot 10000]
 * 每档一行：tag | turnCov@5 Δ[CI] | avgHits | correct Δ(McNemar p) | refused | latP50 Δ | 显著性。
 * 显著性：95%CI 不含 0 记 *，含 0 记 ns（±9pp 内且 ns = 无变化）。
 */
import fs from "node:fs";
import path from "node:path";
import { pairedBootstrap, mcnemarExact, pct, pp } from "./lib/bench/stats.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const files = argv.filter((a) => !a.startsWith("--"));
if (files.length < 2 || argv.includes("--help")) {
  console.error("用法: node scripts/summarize-bench.mjs <base.json> <trial1.json> [...] [--boot 10000]");
  process.exit(2);
}
const bootIters = Number(arg("boot", 10000));

const load = (f) => {
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!Array.isArray(r.rows) || !r.rows.length) throw new Error(`${f}: 无 rows`);
  return { file: f, report: r };
};
const base = load(files[0]);
const trials = files.slice(1).map(load);

const K = base.report.rows[0]["turnCov@5"] !== undefined ? "turnCov@5" : "turnCov";

/** avgHits：overall 里 /avghits/i 数值键优先，否则行级 hits 数组均长，否则 n/a。 */
function avgHitsOf(rep) {
  for (const [k, v] of Object.entries(rep.overall ?? {})) {
    if (/avghits/i.test(k) && typeof v === "number") return v;
  }
  const hs = rep.rows.map((r) => (Array.isArray(r.hits) ? r.hits.length : null)).filter((x) => x != null);
  if (hs.length === rep.rows.length) return hs.reduce((s, x) => s + x, 0) / hs.length;
  return null;
}
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const p50 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] ?? null; };
const genRows = (rep) => rep.rows.filter((r) => r.genCorrect != null);

const baseCov = mean(base.report.rows.map((r) => r[K]).filter((x) => x != null));
const baseHits = avgHitsOf(base.report);
const baseGen = genRows(base.report);
const baseAcc = baseGen.length ? baseGen.filter((r) => r.genCorrect === 1).length / baseGen.length : null;
const baseRef = baseGen.length ? baseGen.filter((r) => r.refused === 1).length / baseGen.length : null;
const baseLat = p50(base.report.rows.map((r) => r.latencyMs).filter((x) => x != null));

const L = [];
L.push(`# bench 汇总：${path.basename(base.file)} (tag=${base.report.config?.tag ?? "-"}) 基线 vs ${trials.length} 档`);
L.push(`主指标 ${K}：基线 ${pct(baseCov)} | avgHits ${baseHits?.toFixed(2) ?? "n/a"} | correct ${pct(baseAcc)} | refused ${pct(baseRef)} | latP50 ${baseLat}ms`);
L.push(`基线 commit=${(base.report.repoCommit ?? "").slice(0, 7)}  n=${base.report.rows.length}`);
L.push("");
L.push("| 档 | " + [K, "avgHits", "correct(Δ/p)", "refused", "latP50 Δ", "显著"].join(" | ") + " |");
L.push("|---|" + ["---", "---", "---", "---", "---", "---"].join("|") + "|");

for (const t of trials) {
  const idxA = new Map(base.report.rows.map((r) => [r.caseId, r]));
  const pairs = [];
  for (const rb of t.report.rows) {
    const ra = idxA.get(rb.caseId);
    if (ra) pairs.push({ a: ra, b: rb });
  }
  const tag = t.report.config?.tag ?? path.basename(t.file);
  if (pairs.length !== base.report.rows.length || pairs.length !== t.report.rows.length) {
    L.push(`| ${tag} | 配对失败: base ${base.report.rows.length} vs trial ${t.report.rows.length} 行 | | | | | |`);
    continue;
  }
  const deltas = pairs.map((p) => p.b[K] - p.a[K]).filter((x) => x != null);
  const m = mean(deltas);
  const ci = pairedBootstrap(deltas, { iters: bootIters });
  const covB = mean(pairs.map((p) => p.b[K]).filter((x) => x != null));
  const sig = ci.lo > 0 || ci.hi < 0 ? "*" : "ns";
  const hits = avgHitsOf(t.report);
  const gen = genRows(t.report);
  const acc = gen.length ? gen.filter((r) => r.genCorrect === 1).length / gen.length : null;
  const ref = gen.length ? gen.filter((r) => r.refused === 1).length / gen.length : null;
  let b = 0, c = 0;
  for (const p of pairs) {
    if (p.a.genCorrect == null || p.b.genCorrect == null) continue;
    if (p.a.genCorrect === 1 && p.b.genCorrect === 0) b++;
    else if (p.a.genCorrect === 0 && p.b.genCorrect === 1) c++;
  }
  const mc = mcnemarExact(b, c);
  const lat = p50(pairs.map((p) => p.b.latencyMs).filter((x) => x != null));
  const latD = lat - baseLat;
  const hitsD = hits - baseHits;
  const accD = acc - baseAcc;
  L.push(`| ${tag} | ${pct(covB)} (Δ${pp(m)} [${pp(ci.lo)},${pp(ci.hi)}]) | ${hits?.toFixed(2) ?? "n/a"} (Δ${hitsD.toFixed(2)}) | ${pct(acc)} (Δ${pp(accD)}/p=${mc.p.toFixed(3)}) | ${pct(ref)} | ${latD >= 0 ? "+" : ""}${latD}ms | ${sig} |`);
}
L.push("");
L.push(`显著性: * = 95%CI 不含 0；ns = 含 0。±9pp 内且 ns 视为无变化。`);
console.log(L.join("\n"));