/**
 * 验收门禁汇总（issue #134）：把 LME90 配对报告按票面三条门禁判定。
 *
 * 门禁（票面「验收」）：
 *  1. 召回缺口桶回收 ≥5 题：base turnCov@5 ∈ {0, 0.5} 的题 → trial turnCov@5 ≥ 0.5
 *  2. 判对 ≥ +3pt 且 95%CI 下界 > 0（paired bootstrap on genCorrect）
 *  3. 写入预算：抽取 token/turn 与结论卡数量在预算内（--budget-tokens-per-turn，缺省 800）
 *
 * 用法：
 *   node --import tsx scripts/bench-gates.mjs <base.json> <trial.json> [--min-recovered 5] [--min-delta-pp 3]
 * 退出码：0 = 全过；1 = 有门禁未过；2 = 参数/读文件错误。
 */
import fs from "node:fs";
import { mcnemarExact, pairedBootstrap, pct, pp } from "./lib/bench/stats.mjs";

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const files = argv.filter((a) => !a.startsWith("--") && !/^[\d.]+$/.test(a));
const [baseFile, trialFile] = files;
if (!baseFile || !trialFile) {
  console.error("用法: node --import tsx scripts/bench-gates.mjs <base.json> <trial.json> [--min-recovered 5] [--min-delta-pp 3] [--budget-tokens-per-turn 800]");
  process.exit(2);
}
const minRecovered = Number(arg("min-recovered", 5));
const minDeltaPp = Number(arg("min-delta-pp", 3));
const budgetTokensPerTurn = Number(arg("budget-tokens-per-turn", 800));

const A = JSON.parse(fs.readFileSync(baseFile, "utf8"));
const B = JSON.parse(fs.readFileSync(trialFile, "utf8"));
const mapById = (r) => new Map(r.rows.map((x) => [x.caseId, x]));
const am = mapById(A);
const bm = mapById(B);
const pairs = [...am.keys()].filter((id) => bm.has(id)).map((id) => ({ id, a: am.get(id), b: bm.get(id) }));

const L = [];
L.push("# 验收门禁（issue #134）");
L.push(`base : ${baseFile} (tag=${A.config?.tag ?? "-"})`);
L.push(`trial: ${trialFile} (tag=${B.config?.tag ?? "-"})`);
L.push(`配对题数: ${pairs.length}`);
L.push("");
let failed = 0;
let skipped = 0;

// ── 门禁 1：召回缺口桶回收 ──
{
  const gapRows = pairs.filter((p) => typeof p.a["turnCov@5"] === "number" && p.a["turnCov@5"] < 0.5);
  // 回收 = 严格上升且达到 ≥0.5（base cov=0.5 已在桶内，未改善不能算回收）
  const recovered = gapRows.filter(
    (p) => typeof p.b["turnCov@5"] === "number" && p.b["turnCov@5"] >= 0.5 && p.b["turnCov@5"] > p.a["turnCov@5"] + 1e-9,
  );
  const pass1 = recovered.length >= minRecovered;
  if (!pass1) failed++;
  L.push(`## 门禁1 召回缺口桶回收（≥${minRecovered} 题）`);
  L.push(`缺口桶（base cov@5<0.5）: ${gapRows.length} 题；回收（trial cov@5≥0.5）: ${recovered.length} 题 → ${pass1 ? "PASS" : "FAIL"}`);
  if (recovered.length) {
    L.push("回收清单:");
    for (const p of recovered) L.push(`  - ${p.id} [${p.a.questionType}] cov ${p.a["turnCov@5"]} → ${p.b["turnCov@5"]}（判对 ${p.a.genCorrect ?? "-"} → ${p.b.genCorrect ?? "-"}）`);
  }
  L.push("");
}

// ── 门禁 2：判对 Δ ≥ +3pt 且 CI 下界 > 0 ──
{
  const rows = pairs.filter((p) => p.a.genCorrect != null && p.b.genCorrect != null);
  const deltas = rows.map((p) => p.b.genCorrect - p.a.genCorrect);
  const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length;
  const ci = pairedBootstrap(deltas, { iters: 10000 });
  const b = rows.filter((p) => p.a.genCorrect === 1 && p.b.genCorrect === 0).length;
  const c = rows.filter((p) => p.a.genCorrect === 0 && p.b.genCorrect === 1).length;
  const m = mcnemarExact(b, c);
  const accA = rows.filter((p) => p.a.genCorrect === 1).length / rows.length;
  const accB = rows.filter((p) => p.b.genCorrect === 1).length / rows.length;
  const pass2 = mean * 100 >= minDeltaPp && ci.lo > 0;
  if (!pass2) failed++;
  L.push(`## 门禁2 判对（≥+${minDeltaPp}pt 且 CI 下界>0）`);
  L.push(`correct: base=${pct(accA)} trial=${pct(accB)} Δ=${pp(mean)}  95%CI=[${pp(ci.lo)}, ${pp(ci.hi)}]  McNemar b=${b} c=${c} p=${m.p.toFixed(4)}`);
  L.push(`判分: ${pass2 ? "PASS" : "FAIL"}`);
  const refA = rows.filter((p) => p.a.refused === 1).length / rows.length;
  const refB = rows.filter((p) => p.b.refused === 1).length / rows.length;
  L.push(`refused: base=${pct(refA)} trial=${pct(refB)}`);
  L.push("");
}

// ── 门禁 3：写入预算（token/turn + 热路径延迟）──
{
  const fx = B.config?.factExtraction ?? null;
  const cc = B.config?.conclusionCards ?? null;
  const stats = fx?.stats ?? null;
  const turns = stats?.turns ?? 0;
  // usage 累加只在「非缓存 case」发生；若整档全缓存命中则 token 证据缺失——此时不能判 PASS（假绿），
  // 显式记 SKIP 并在总账里标注"未能测量"。缓存文件里的 usage 作为回落证据。
  const tokens = (stats?.usage?.prompt ?? 0) + (stats?.usage?.completion ?? 0);
  const cacheHits = stats?.cacheHits ?? 0;
  const groups = stats?.groups ?? 0;
  let status3;
  if (!fx) status3 = "SKIP（本档未启用事实抽取）";
  else if (tokens === 0) status3 = "SKIP（无可测 token 证据：抽取全走缓存；预算需在首次抽取档核验）";
  else status3 = tokens / Math.max(1, turns) <= budgetTokensPerTurn ? "PASS" : "FAIL";
  if (status3 === "FAIL") failed++;
  if (status3.startsWith("SKIP")) skipped++;
  L.push("## 门禁3 写入预算（离线抽取 token/turn ≤ " + budgetTokensPerTurn + "）");
  if (fx) {
    L.push("抽取: groups=" + groups + "（缓存命中 " + cacheHits + "） turns=" + turns + " phrases=" + (stats?.phrases ?? 0) + " 失败批=" + (stats?.failedBatches ?? 0));
    L.push("token: prompt=" + (stats?.usage?.prompt ?? 0) + " completion=" + (stats?.usage?.completion ?? 0) + " → " + (turns ? (tokens / turns).toFixed(1) : "0.0") + " token/turn");
    L.push("离线抽取耗时: " + ((stats?.extractMs ?? 0) / 1000).toFixed(0) + "s（缓存命中档为 0——不计入写入热路径）");
  }
  if (cc) {
    const cs = cc.stats ?? {};
    L.push("结论卡: groups=" + (cs.groups ?? 0) + "（缓存命中 " + (cs.cacheHits ?? 0) + "） cards=" + (cs.cards ?? 0) + " 平均 " + (cs.groups ? ((cs.cards ?? 0) / cs.groups).toFixed(2) : "0.00") + " 卡/组");
  }
  const ing = B.config?.ingest ?? {};
  L.push("灌库: turns=" + (ing.turns ?? 0) + " written=" + (ing.written ?? 0) + " embedded=" + (ing.embedded ?? 0) + "（失败 " + (ing.embedFailed ?? 0) + "）superseded=" + (ing.superseded ?? 0) + "/" + (ing.supersedeOps ?? 0) + " conclusions=" + (ing.conclusionsWritten ?? 0) + " links=" + (ing.conclusionLinks ?? 0));
  L.push("判分: " + status3);
  L.push("");
}

// ── 门禁 4：抽取噪声抽样验收（读取 fact-extract-gate 报告）──
{
  const gatePath = arg("fact-gate", undefined);
  let status4 = "SKIP（未提供 --fact-gate 报告）";
  if (typeof gatePath === "string" && gatePath) {
    try {
      const g = JSON.parse(fs.readFileSync(gatePath, "utf8"));
      const ok = g?.pass === true && (g?.scored?.total ?? 0) >= 30;
      status4 = ok
        ? "PASS（accuracy " + (g.scored?.accuracy * 100).toFixed(1) + "% ≥ 阈值，样本 " + (g.scored?.total ?? 0) + " 条 ≥ 30）"
        : "FAIL（accuracy " + (g.scored?.accuracy * 100).toFixed(1) + "%，样本 " + (g.scored?.total ?? 0) + " 条；要求 ≥90% 且 ≥30 条）";
      if (!ok) failed++;
      L.push("## 门禁4 抽取噪声抽样验收");
      L.push("报告: " + gatePath + "（样本 " + (g.sampleVerified ?? 0) + " turn / " + (g.scored?.total ?? 0) + " 条事实，阈值 " + ((g.threshold ?? 0) * 100).toFixed(0) + "%）→ " + status4);
      L.push("");
    } catch (e) {
      status4 = "SKIP（报告读取失败: " + String(e?.message ?? e) + "）";
    }
  }
  if (status4.startsWith("SKIP")) skipped++;
  if (typeof gatePath !== "string" || !gatePath) {
    L.push("## 门禁4 抽取噪声抽样验收");
    L.push("未提供 --fact-gate 报告 → 未能核验（SKIP）");
    L.push("");
  }
}

L.push(`## 结论：${failed === 0 ? (skipped > 0 ? "门禁通过，但 " + skipped + " 项 SKIP（未能测量）" : "全部门禁 PASS") : failed + " 项门禁 FAIL"}`);
console.log(L.join("\n"));
process.exit(failed === 0 ? 0 : 1);