#!/usr/bin/env node
/**
 * 档位排名（issue #134）：把基线报告与任意多个 trial 报告按同题配对，
 * 输出按「判对率」排序的排名表（Δ vs 基线 + paired bootstrap 95%CI），
 * 以及 turnCov@5 / 拒答 / 判分模型对照。
 *
 * 判分器一致性（#140）：判对率只在「同一把尺子」下可比。基线与某档的 judgeModel
 * （或判分提示版本）不一致时，该档的判对/Δ/拒答列不出数，只保留检索指标；
 * 表头列出跨 judge 的档位并给出对齐路径，退出码 3。--allow-cross-judge 可显式
 * 展示参考值（标 *，不作方法结论）。
 *
 * 用法：
 *   node --import tsx scripts/bench-ranking.mjs --base <base.json> <trial.json...> [--allow-cross-judge]
 */
import fs from "node:fs";
import { pairedBootstrap, pct, pp } from "./lib/bench/stats.mjs";
import { configDiff, configDiffLine, hasJudgedRows, judgeIdentity, judgeRepairHint, pairJudges } from "./lib/bench/judge.mjs";

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return undefined;
  return argv[i + 1];
}
const allowCrossJudge = argv.includes("--allow-cross-judge");
const baseFile = arg("base");
const trials = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base");
if (!baseFile || trials.length === 0) {
  console.error("用法: node --import tsx scripts/bench-ranking.mjs --base <base.json> <trial.json...> [--allow-cross-judge]");
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
  const pairing = pairJudges(base, rep);
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
    judgeModel: judgeIdentity(rep).label,
    judgeStatus: pairing.status,
    judgedComparable: pairing.judgedComparable,
    judgedPresent: hasJudgedRows(rep),
    diff: configDiff(base, rep),
  });
}
const baseRow = rows.find((r) => r.isBase);
const ranked = rows.filter((r) => !r.isBase).sort((x, y) => y.correct - x.correct);

const unjudged = rows.filter((r) => !r.isBase && (!r.judgedComparable || !r.judgedPresent));
const crossArms = rows.filter((r) => !r.isBase && r.judgedPresent && !r.judgedComparable);

const L = [];
L.push("# LME90 档位排名（同题配对 n=" + baseRow.n + "，基线 " + baseTag + "）");
L.push(`判分器: 基线=${baseRow.judgeModel}`);
if (crossArms.length) {
  L.push(
    `跨 judge/身份未记录的档位: ${crossArms.map((r) => `${r.tag}(${r.judgeModel})`).join(", ")} → 判对/拒答列不出数（判分器不一致，Δ 不可归因）`,
  );
}
if (unjudged.some((r) => !r.judgedPresent)) {
  L.push(`无判分行的档位: ${unjudged.filter((r) => !r.judgedPresent).map((r) => r.tag).join(", ")}`);
}
L.push("");
L.push("| # | 档 | 判对 | Δ vs 基线 [95%CI] | 拒答 | turnCov@5 | Δ cov [95%CI] | 判分模型 |");
L.push("|---|---|---|---|---|---|---|---|");

const judgeCell = (r) => {
  if (r.judgedComparable) return `${r.judgeModel}`;
  if (!r.judgedPresent) return `${r.judgeModel}（无判分行）`;
  return `${r.judgeModel}（跨 judge）`;
};
const judgedCells = (r) => {
  if (r.isBase) return { acc: pct(r.correct), d: "—", ref: pct(r.refused) };
  if (!r.judgedPresent) return { acc: "—", d: "—", ref: "—" };
  if (r.judgedComparable) {
    return { acc: pct(r.correct), d: `${pp(r.dCorrect)} [${pp(r.ciLo)}, ${pp(r.ciHi)}]`, ref: pct(r.refused) };
  }
  if (allowCrossJudge) {
    return { acc: pct(r.correct) + "*", d: `${pp(r.dCorrect)}* [${pp(r.ciLo)}, ${pp(r.ciHi)}]`, ref: pct(r.refused) + "*" };
  }
  return { acc: "—", d: "—（跨 judge）", ref: "—" };
};

{
  const c = judgedCells(baseRow);
  L.push(`| - | ${baseRow.tag}（基线） | ${c.acc} | ${c.d} | ${c.ref} | ${pct(baseRow.cov5)} | — | ${judgeCell(baseRow)} |`);
}
ranked.forEach((r, i) => {
  const c = judgedCells(r);
  L.push(
    `| ${i + 1} | ${r.tag} | ${c.acc} | ${c.d} | ${c.ref} | ${pct(r.cov5)} | ${pp(r.dCov)} [${pp(r.covLo)}, ${pp(r.covHi)}] | ${judgeCell(r)} |`,
  );
});
L.push("");
const diffLines = rows.filter((r) => !r.isBase && r.diff.length).map((r) => `${r.tag}: ${configDiffLine(r.diff)}`);
if (diffLines.length) {
  L.push("实验旋钮差异（判分器之外，解释 Δ 时先看这里）:");
  for (const line of diffLines) L.push("  - " + line);
} else {
  L.push(configDiffLine([]));
}
if (allowCrossJudge && crossArms.length) {
  L.push("");
  L.push("* 跨 judge 参考值：判分尺不同，Δ 含判分器差异，不得作为方法结论。");
}

console.log(L.join("\n"));

if (crossArms.length && !allowCrossJudge) {
  console.error("[ranking] 跨判分器档位未出数（exit 3）。");
  for (const line of judgeRepairHint({ trialJudge: crossArms[0].judgeModel })) console.error(line);
  process.exit(3);
}
