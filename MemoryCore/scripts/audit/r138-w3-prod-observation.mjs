/**
 * #138 W3 生产语料灰度观测（只读）：用真实 recall journal 回答票面三问——
 *  ① 结论卡命中率（layered / conclusion 行）；
 *  ② 注入行数分布（是否触 maxResults 硬帽、经验层被结论行挤到几行）；
 *  ③ 上下文行（smallToBig 回捞）占比与触发率。
 * 另附：精排剪枝强度（gates.rerank.kept）与延迟，用于判断「剪枝噪声」是否仍在污染观测。
 *
 * 用法：node scripts/audit/r138-w3-prod-observation.mjs [--logs <dir>] [--max-results 5] [--json]
 * 只读：只读 journal jsonl，不写库、不外呼、不改生产数据。
 */
import fs from "node:fs";
import path from "node:path";

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const logsDir = String(arg("logs", "D:/TDB/data/logs/recall"));
const maxResults = Number(arg("max-results", 5));
const asJson = process.argv.includes("--json");

const files = fs.existsSync(logsDir)
  ? fs.readdirSync(logsDir).filter((f) => f.endsWith(".jsonl")).sort()
  : [];
const rows = [];
for (const f of files) {
  for (const line of fs.readFileSync(path.join(logsDir, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== "object") continue;
    const ml = Array.isArray(r.memoryLines) ? r.memoryLines.map(String) : [];
    const ctxLines = ml.filter((s) => s.includes("[上下文"));
    const concLines = ml.filter((s) => s.startsWith("- [结论") || s.startsWith("- [work_fact"));
    const wfLines = ml.filter((s) => s.startsWith("- [work_fact"));
    const expLines = ml.length - ctxLines.length - concLines.length;
    rows.push({
      file: f,
      ts: String(r.ts ?? ""),
      day: String(r.ts ?? "").slice(0, 10),
      strategy: r.strategy ?? "",
      sessionReused: r.sessionReused === true,
      layered: r.layered === true,
      conclusionCount: Number(r.conclusionCount ?? 0),
      experienceCount: Number(r.experienceCount ?? 0),
      totalLines: ml.length,
      // 行形态口径（与 conclusionCount/experienceCount 交叉校验）
      shapeConclusion: concLines.length,
      shapeWorkFact: wfLines.length,
      shapeContext: ctxLines.length,
      shapeConclusionLayer: concLines.length + ctxLines.length,
      shapeExperience: Math.max(0, expLines),
      kept: r.gates?.rerank?.kept,
      dropped: r.gates?.rerank?.dropped,
      rerankProvider: r.gates?.rerank?.provider,
      degradeded: r.gates?.rerank?.degraded ?? null,
      gates: r.gates ?? null,
      perfMs: r.perfMs?.total ?? null,
      rerankMs: r.gates?.rerank?.ms ?? null,
    });
  }
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const dist = (vals) => {
  const m = new Map();
  for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => ({ value: k, n, pct: pct(n, vals.length) }));
};
const quantile = (vals, q) => {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[i];
};

const n = rows.length;
const layered = rows.filter((r) => r.layered);
const withCtx = rows.filter((r) => r.shapeContext > 0);
const withConclusion = rows.filter((r) => r.shapeConclusion > 0);
const hardCap = rows.filter((r) => r.totalLines >= maxResults);
const starved = rows.filter((r) => r.layered && r.shapeExperience <= 1);
const keptVals = rows.map((r) => r.kept).filter((v) => typeof v === "number");
const perfVals = rows.map((r) => r.perfMs).filter((v) => typeof v === "number");

const out = {
  logsDir,
  files: files.length,
  n,
  days: [...new Set(rows.map((r) => r.day))].sort(),
  conclusionLayer: {
    hitRate: pct(layered.length, n),
    conclusionLineRate: pct(withConclusion.length, n),
    perQuery: dist(rows.map((r) => r.shapeConclusion)),
  },
  injectedLines: {
    totalLinesDist: dist(rows.map((r) => r.totalLines)),
    hardCapRate: pct(hardCap.length, n),
    experienceLinesDist: dist(rows.map((r) => r.shapeExperience)),
    experienceLinesDistWhenLayered: dist(layered.map((r) => r.shapeExperience)),
    // 结论层开启时，经验层被压到 ≤1 行的比例（零和槽位竞争的直接观测量）
    starvedRateWhenLayered: pct(starved.length, layered.length),
  },
  contextLines: {
    triggerRate: pct(withCtx.length, n),
    perTriggered: dist(withCtx.map((r) => r.shapeContext)),
    perQueryMean: n > 0 ? Math.round((withCtx.reduce((a, r) => a + r.shapeContext, 0) / n) * 1000) / 1000 : null,
    // 触发时经验层被挤掉多少：结论+上下文行占 budget 的比例
    slotShareWhenTriggered: withCtx.length
      ? Math.round((withCtx.reduce((a, r) => a + r.shapeConclusion + r.shapeContext, 0) / withCtx.reduce((a, r) => a + Math.max(1, r.totalLines), 0)) * 1000) / 10
      : null,
  },
  rerankPruning: {
    provider: [...new Set(rows.map((r) => r.rerankProvider).filter(Boolean))],
    keptDist: dist(keptVals),
    kept1Rate: pct(keptVals.filter((v) => v <= 1).length, keptVals.length),
  },
  latencyMs: {
    totalP50: quantile(perfVals, 0.5),
    totalP95: quantile(perfVals, 0.95),
    rerankP50: quantile(rows.map((r) => r.rerankMs).filter((v) => typeof v === "number"), 0.5),
  },
  // 表示占比：注入块里「结论层（结论/work_fact/上下文）」vs「经验层（原文行）」的行数比——
  // 生产实测结论层几乎吃满窗口，这是票面「上下文行占比」之外的第二个关键观测量。
  representation: (() => {
    const total = rows.reduce((a, r) => a + r.totalLines, 0);
    const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
    return {
      totalLines: total,
      conclusionShare: pct(sum("shapeConclusionLayer"), total),
      experienceShare: pct(total - sum("shapeConclusionLayer"), total),
      ofWhichContext: pct(sum("shapeContext"), total),
      ofWhichWorkFact: pct(sum("shapeWorkFact"), total),
    };
  })(),
  perDay: [...new Set(rows.map((r) => r.day))].sort().map((day) => {
    const d = rows.filter((r) => r.day === day);
    const dl = d.filter((r) => r.layered);
    return {
      day,
      n: d.length,
      layeredRate: pct(dl.length, d.length),
      ctxRate: pct(d.filter((r) => r.shapeContext > 0).length, d.length),
      meanTotalLines: Math.round((d.reduce((a, r) => a + r.totalLines, 0) / d.length) * 100) / 100,
      starvedRate: pct(dl.filter((r) => r.shapeExperience <= 1).length, dl.length),
      kept1Rate: pct(d.filter((r) => typeof r.kept === "number" && r.kept <= 1).length, d.filter((r) => typeof r.kept === "number").length),
    };
  }),
};

if (asJson) {
  console.log(JSON.stringify(out, null, 1));
} else {
  console.log("# #138 W3 生产语料灰度观测（只读）");
  console.log("journal 目录: " + logsDir + "（" + files.length + " 个文件，" + n + " 条召回记录）");
  console.log("日期: " + out.days.join(", "));
  console.log("");
  console.log("## ① 结论卡命中");
  console.log("- layered 命中率: " + out.conclusionLayer.hitRate + "%（" + layered.length + "/" + n + "）");
  console.log("- 有结论行注入的比例: " + out.conclusionLayer.conclusionLineRate + "%（" + withConclusion.length + "/" + n + "）");
  console.log("- 每题结论行数分布: " + JSON.stringify(out.conclusionLayer.perQuery));
  console.log("");
  console.log("## ② 注入行数（预算 " + maxResults + " 行）");
  console.log("- 总行数分布: " + JSON.stringify(out.injectedLines.totalLinesDist));
  console.log("- 触硬帽（= " + maxResults + " 行）比例: " + out.injectedLines.hardCapRate + "%");
  console.log("- 经验行数分布: " + JSON.stringify(out.injectedLines.experienceLinesDist));
  console.log("- 结论层命中时经验行数分布: " + JSON.stringify(out.injectedLines.experienceLinesDistWhenLayered));
  console.log("- 结论层命中时经验层 ≤1 行占比: " + out.injectedLines.starvedRateWhenLayered + "%（" + starved.length + "/" + layered.length + "）");
  console.log("");
  console.log("## ③ 上下文行（smallToBig 回捞）");
  console.log("- 触发率: " + out.contextLines.triggerRate + "%（" + withCtx.length + "/" + n + "）");
  console.log("- 每触发题上下文行数: " + JSON.stringify(out.contextLines.perTriggered));
  console.log("- 全局每题均值: " + out.contextLines.perQueryMean + " 行/题");
  console.log("- 触发时「结论+上下文」占总行数比: " + out.contextLines.slotShareWhenTriggered + "%");
  console.log("");
  console.log("## ③b 表示占比（注入行里谁是主体）");
  console.log("- 结论层（结论+work_fact+上下文）: " + out.representation.conclusionShare + "%（其中 work_fact " + out.representation.ofWhichWorkFact + "%、上下文 " + out.representation.ofWhichContext + "%）");
  console.log("- 经验层（原文行）: " + out.representation.experienceShare + "%");
  console.log("");
  console.log("## ④ 精排剪枝（观测噪声源）");
  console.log("- provider: " + JSON.stringify(out.rerankPruning.provider));
  console.log("- kept 分布: " + JSON.stringify(out.rerankPruning.keptDist));
  console.log("- kept≤1 占比: " + out.rerankPruning.kept1Rate + "%");
  console.log("");
  console.log("## ⑤ 延迟");
  console.log("- 召回总耗时 P50/P95: " + out.latencyMs.totalP50 + " / " + out.latencyMs.totalP95 + " ms；精排 P50: " + out.latencyMs.rerankP50 + " ms");
  console.log("");
  console.log("## ⑥ 按天");
  for (const d of out.perDay) {
    console.log("- " + d.day + " n=" + d.n + " layered=" + d.layeredRate + "% ctx=" + d.ctxRate + "% 均行数=" + d.meanTotalLines + " 经验≤1=" + d.starvedRate + "% kept≤1=" + d.kept1Rate + "%");
  }
}
