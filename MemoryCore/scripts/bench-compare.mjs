#!/usr/bin/env node
/**
 * bench-compare —— 两份 bench 报告的配对比较（S3/S4/S5 定档工具）。
 *
 * 用法：node scripts/bench-compare.mjs <base.json> <trial.json> [--metric turnCov@5] [--boot 10000]
 *
 * 输出：
 *  - 检索指标配对差（mean Δ + paired bootstrap 95% CI + 改善/持平/变差计数，按题型分列）
 *  - 答案正确性 McNemar 精确检验（discordant b/c + 双侧 p）+ 拒答率两侧对照
 *  - 延迟配对差（mean/P50）
 *
 * 配对前提：两份报告必须同一 manifest（同 caseId 集合、同运行序）。缺行直接报错。
 */
import fs from "node:fs";
import path from "node:path";
import { pairedBootstrap, mcnemarExact, mulberry32, pct, pp } from "./lib/bench/stats.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const files = argv.filter((a) => !a.startsWith("--"));

if (files.length !== 2 || argv.includes("--help")) {
  console.error("用法: node scripts/bench-compare.mjs <base.json> <trial.json> [--metric turnCov@5] [--boot 10000]");
  process.exit(2);
}

const load = (f) => {
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!Array.isArray(r.rows) || !r.rows.length) throw new Error(`${f}: 无 rows`);
  return { file: f, report: r };
};
const A = load(files[0]);
const B = load(files[1]);

// ── 配对：按 caseId 对齐（同 manifest 才可配对）──
const idxA = new Map(A.report.rows.map((r) => [r.caseId, r]));
const pairs = [];
for (const rb of B.report.rows) {
  const ra = idxA.get(rb.caseId);
  if (!ra) throw new Error(`配对失败: caseId ${rb.caseId} 只在 trial 出现（两报告必须同 manifest 同 caseId 集合）`);
  pairs.push({ caseId: rb.caseId, type: rb.questionType, a: ra, b: rb });
}
if (pairs.length !== A.report.rows.length) {
  throw new Error(`配对失败: base ${A.report.rows.length} 行 vs trial ${pairs.length} 行（manifest 不一致？）`);
}
if ((A.report.config?.manifest ?? null) !== (B.report.config?.manifest ?? null)) {
  console.warn("[compare] 警告: 两报告 config.manifest 不同——配对仅按 caseId 对齐，请人工确认口径");
}



const metric = arg("metric", null);
// 缺省选主指标：优先平铺 turnCov@5，否则 primary turnCov
const keys = metric ? [metric] : [
  B.report.rows[0]["turnCov@5"] !== undefined ? "turnCov@5" : "turnCov",
  B.report.rows[0]["sessionCov@5"] !== undefined ? "sessionCov@5" : "sessionCov",
  B.report.rows[0]["mrr@5"] !== undefined ? "mrr@5" : "mrr",
];
const bootIters = Number(arg("boot", 10000));

const L = [];
L.push("# bench-compare 配对比较");
L.push(`base : ${path.basename(A.file)}  (tag=${A.report.config?.tag ?? "-"} commit=${(A.report.repoCommit ?? "").slice(0, 7)})`);
L.push(`trial: ${path.basename(B.file)}  (tag=${B.report.config?.tag ?? "-"} commit=${(B.report.repoCommit ?? "").slice(0, 7)})`);
L.push(`配对题数: ${pairs.length}  |  trial rerankOverride=${JSON.stringify(B.report.config?.rerankOverride ?? null)}`);
L.push("");

for (const key of keys) {
  const deltas = [];
  let up = 0, same = 0, down = 0;
  const byType = new Map();
  for (const p of pairs) {
    const va = p.a[key], vb = p.b[key];
    if (va == null || vb == null) continue;
    const d = vb - va;
    deltas.push(d);
    if (d > 1e-9) up++; else if (d < -1e-9) down++; else same++;
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type).push(d);
  }
  const n = deltas.length;
  const mean = deltas.reduce((s, x) => s + x, 0) / n;
  const ci = pairedBootstrap(deltas, { iters: bootIters });
  const aMean = pairs.map((p) => p.a[key]).reduce((s, x) => s + x, 0) / n;
  const bMean = pairs.map((p) => p.b[key]).reduce((s, x) => s + x, 0) / n;
  L.push(`## ${key}（n=${n}，bootstrap ${bootIters} 次配对重采样）`);
  L.push(`base=${pct(aMean)}  trial=${pct(bMean)}  Δ=${pp(mean)}  95%CI=[${pp(ci.lo)}, ${pp(ci.hi)}]  改善/持平/变差=${up}/${same}/${down}`);
  for (const [t, ds] of [...byType.entries()].sort()) {
    const m = ds.reduce((s, x) => s + x, 0) / ds.length;
    L.push(`  - ${t}: Δ=${pp(m)} (n=${ds.length})`);
  }
  L.push("");
}

// ── 答案正确性：McNemar ──
{
  let b = 0, c = 0; // b=base 对 trial 错，c=base 错 trial 对
  const rows = pairs.filter((p) => p.a.genCorrect != null && p.b.genCorrect != null);
  for (const p of rows) {
    if (p.a.genCorrect === 1 && p.b.genCorrect === 0) b++;
    else if (p.a.genCorrect === 0 && p.b.genCorrect === 1) c++;
  }
  const m = mcnemarExact(b, c);
  const accA = rows.filter((p) => p.a.genCorrect === 1).length / rows.length;
  const accB = rows.filter((p) => p.b.genCorrect === 1).length / rows.length;
  const refA = rows.filter((p) => p.a.refused === 1).length / rows.length;
  const refB = rows.filter((p) => p.b.refused === 1).length / rows.length;
  L.push(`## 答案正确性（judge 口径，n=${rows.length}）`);
  L.push(`correct: base=${pct(accA)}  trial=${pct(accB)}  Δ=${pp(accB - accA)}`);
  L.push(`McNemar discordant: base对/trial错=${m.b}  base错/trial对=${m.c}  精确双侧 p=${m.p.toFixed(4)}`);
  L.push(`refused: base=${pct(refA)}  trial=${pct(refB)}`);
  L.push("");
}

// ── 延迟 ──
{
  const ds = pairs.map((p) => p.b.latencyMs - p.a.latencyMs);
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[(s.length >> 1)] ?? 0; };
  const aMed = med(pairs.map((p) => p.a.latencyMs));
  const bMed = med(pairs.map((p) => p.b.latencyMs));
  L.push(`## 召回延迟 ms（配对）`);
  L.push(`P50: base=${aMed}  trial=${bMed}  Δ=${(bMed - aMed)}ms  |  mean Δ=${(ds.reduce((s, x) => s + x, 0) / ds.length).toFixed(0)}ms`);
  L.push("");
}

console.log(L.join("\n"));
