#!/usr/bin/env node
/**
 * 分桶配对汇总（#136 验收）：同一 manifest / 同一判分器下，逐题配对比较
 * 一个或多个试验档与基线的 turnCov@5 / genCorrect，并按 questionType 分桶给
 * Δ、95% paired bootstrap CI 与 McNemar 精确检验。
 *
 * 用法：
 *   node --import tsx scripts/bench-bucket-paired.mjs \
 *     --base .eval-data/bench/<b1off>.json \
 *     --arm card-soft=.eval-data/bench/<trial>.json [--arm ...]
 *
 * 设计：纯离线（不检索、不外呼）；rows 按 caseId 配对；桶缺题时打印样本数。
 */
import fs from "node:fs";
import { mcnemarExact, pairedBootstrap, pct, pp } from "./lib/bench/stats.mjs";

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const basePath = arg("base");
if (!basePath || basePath === true) {
  console.error("缺 --base <result.json>");
  process.exit(2);
}
const armSpecs = [].concat(arg("arm", [])).flat();
if (!armSpecs.length) {
  console.error("缺 --arm tag=<result.json>");
  process.exit(2);
}

const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
const baseRows = new Map(base.rows.map((r) => [r.caseId, r]));
const buckets = [...new Set(base.rows.map((r) => r.questionType))].sort();
const fmt = (x) => (x == null ? "n/a" : x.toFixed(4));

function pairStats(pairs, field) {
  const vals = pairs.map(([b, a]) => (a[field] ?? 0) - (b[field] ?? 0));
  const mean = vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
  const ci = pairedBootstrap(vals);
  return { n: vals.length, mean, ci };
}

function genStats(pairs) {
  let b = 0, c = 0, n = 0;
  for (const [baseRow, armRow] of pairs) {
    if (baseRow.genCorrect == null || armRow.genCorrect == null) continue;
    n++;
    const bw = !baseRow.genCorrect, aw = !armRow.genCorrect;
    if (bw && !aw) b++;
    if (!bw && aw) c++;
  }
  return { n, b, c, p: mcnemarExact(b, c).p };
}

/** #136 门禁：指定桶的 cov 与判对都不得低于基线（Δ < 0 即 FAIL）。 */
const gateArg = arg("gate", undefined);
const gateBuckets = typeof gateArg === "string" && gateArg && gateArg !== true
  ? gateArg.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const lines = [];
lines.push("# 分桶配对汇总（#136）");
lines.push("");
lines.push(`基线: ${base.config?.tag ?? basePath}（n=${base.overall?.n ?? base.rows.length}）`);
lines.push("");
for (const spec of armSpecs) {
  const eq = spec.indexOf("=");
  const tag = eq > 0 ? spec.slice(0, eq) : spec;
  const p = eq > 0 ? spec.slice(eq + 1) : spec;
  const arm = JSON.parse(fs.readFileSync(p, "utf8"));
  const armRows = new Map(arm.rows.map((r) => [r.caseId, r]));
  const pairsOf = (filter) =>
    [...baseRows.entries()]
      .filter(([id, b]) => armRows.has(id) && (!filter || filter(b)))
      .map(([id, b]) => [b, armRows.get(id)]);
  lines.push(`## ${tag}（${p}）`);
  const groups = [["全部", null], ...buckets.map((b) => [b, (r) => r.questionType === b])];
  for (const [name, filter] of groups) {
    const pairs = pairsOf(filter);
    if (!pairs.length) continue;
    const cov = pairStats(pairs, "turnCov@5");
    const gen = genStats(pairs);
    const baseCov = pairs.reduce((s, [b]) => s + (b["turnCov@5"] ?? 0), 0) / pairs.length;
    const armCov = pairs.reduce((s, [, a]) => s + (a["turnCov@5"] ?? 0), 0) / pairs.length;
    const baseGen = pairs.reduce((s, [b]) => s + (b.genCorrect ?? 0), 0) / pairs.length;
    const armGen = pairs.reduce((s, [, a]) => s + (a.genCorrect ?? 0), 0) / pairs.length;
    lines.push(
      `- ${name}（n=${pairs.length}）: cov ${pct(baseCov)} → ${pct(armCov)}（${pp(cov.mean)}，CI[${pp(cov.ci.lo)},${pp(cov.ci.hi)}]）; ` +
        `判对 ${pct(baseGen)} → ${pct(armGen)}（${pp(armGen - baseGen)}，McNemar b/c=${gen.b}/${gen.c} p=${gen.p.toFixed(4)}）`,
    );
  }
  lines.push("");
}

let gateFailed = false;
if (gateBuckets.length) {
  lines.push("## 门禁（--gate）");
  for (const spec of armSpecs) {
    const eq = spec.indexOf("=");
    const tag = eq > 0 ? spec.slice(0, eq) : spec;
    const p = eq > 0 ? spec.slice(eq + 1) : spec;
    const arm = JSON.parse(fs.readFileSync(p, "utf8"));
    const armRows = new Map(arm.rows.map((r) => [r.caseId, r]));
    for (const bucket of gateBuckets) {
      const pairs = [...baseRows.entries()]
        .filter(([id, b]) => armRows.has(id) && b.questionType === bucket)
        .map(([id, b]) => [b, armRows.get(id)]);
      if (!pairs.length) { lines.push(`- ${tag} / ${bucket}: SKIP（无配对样本）`); continue; }
      const cov = pairStats(pairs, "turnCov@5");
      const baseGen = pairs.reduce((s, [b]) => s + (b.genCorrect ?? 0), 0) / pairs.length;
      const armGen = pairs.reduce((s, [, a]) => s + (a.genCorrect ?? 0), 0) / pairs.length;
      const covOk = cov.mean >= -1e-9;
      const genOk = armGen - baseGen >= -1e-9;
      if (!covOk || !genOk) gateFailed = true;
      lines.push(
        `- ${tag} / ${bucket}: covΔ=${pp(cov.mean)} ${covOk ? "PASS" : "FAIL"}; 判对Δ=${pp(armGen - baseGen)} ${genOk ? "PASS" : "FAIL"}`,
      );
    }
  }
  lines.push("");
}

console.log(lines.join("\n"));
if (gateFailed) process.exitCode = 1;
