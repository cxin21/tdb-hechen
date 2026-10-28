#!/usr/bin/env node
/**
 * #135 E1/E2：R2 加权融合离线拟合汇总 + 配对门禁判定。
 *
 * 输入 = eval-memory-bench.mjs 跑出的档位结果 JSON（rows 按 caseId 配对）。
 * 输出 = 每档 vs 基线的配对 turnCov@5 / sessionCov / mrr@5 差值、win/loss/tie、
 *        符号检验 p 值（双尾二项），并按 E2 门禁（ΔturnCov@5 ≥ +3pt 且 CI 下界>0）
 *        给出合入判定。纯离线计算，不外呼。
 *
 * 判分器一致性（#140）：本脚本的 Δ 用于 E2 合入门禁，所以配对前先比 judgeModel /
 * judgePromptVersion。两档判分器不一致（或身份缺失）→ 不做配对、不出 Δ、不给门禁结论，
 * 只并列展示各自的检索指标，并列出「判分器之外的实验旋钮差异」，避免把配置差异读成
 * 方法收益。--allow-cross-judge 可显式放行（输出标注为跨判分器参考值）。
 *
 * 用法：
 *   node scripts/fit-fusion-weights.mjs --base <result.json> --arm tag=<result.json> [--arm ...] [--allow-cross-judge]
 */
import fs from "node:fs";
import { configDiff, configDiffLine, judgeIdentity, judgeRepairHint, pairJudges } from "./lib/bench/judge.mjs";

function argOf(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const basePath = argOf("base");
if (!basePath || basePath === true) { console.error("缺 --base <result.json>"); process.exit(2); }
const armSpecs = [].concat(argOf("arm", [])).flat();
if (!armSpecs.length) { console.error("缺 --arm tag=<result.json>"); process.exit(2); }
const allowCrossJudge = process.argv.includes("--allow-cross-judge");

const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
const baseRows = new Map(base.rows.map((r) => [r.caseId, r]));

function ci95HalfWidth(p, n) {
  if (!n) return 0;
  const z = 1.96;
  return z * Math.sqrt((p * (1 - p)) / n);
}

function binomTwoSided(k, n) {
  // 精确二项（对称尾）；n≤90 可承受
  const c = (nn, kk) => { let r = 1; for (let i = 0; i < kk; i++) r = (r * (nn - i)) / (i + 1); return r; };
  let tail = 0;
  for (let i = 0; i <= n; i++) if (Math.min(i, n - i) <= Math.min(k, n - k)) tail += c(n, i);
  return Math.min(1, tail / 2 ** n);
}

const pctOf = (v) => (typeof v === "number" ? (v * 100).toFixed(1) + "%" : "-");
const baseJudge = judgeIdentity(base);
const lines = [
  "# R2 加权融合配对汇总",
  "",
  "基线: " + (base.config?.tag ?? basePath) + " n=" + base.overall.n + "  判分器=" + baseJudge.label,
  "",
];

let refused = 0;
const refusedTags = [];

for (const spec of armSpecs) {
  const eq = spec.indexOf("=");
  const tag = eq > 0 ? spec.slice(0, eq) : spec;
  const p = eq > 0 ? spec.slice(eq + 1) : spec;
  const arm = JSON.parse(fs.readFileSync(p, "utf8"));
  const pairing = pairJudges(base, arm);
  // retrieval-only 档（两侧都没有判分行）判分器根本不参与比较 → 放行，
  // 与 decidePairing 的 carve-out 保持一致（否则 E2 的检索门禁在这类档上永远算不出来）。
  const retrievalOnly = !pairing.judgedMetricsPresent;
  const pairedOk = pairing.judgedComparable || retrievalOnly || allowCrossJudge;
  if (!pairedOk) {
    // 不配对：只并列展示（票面要求），并说明为什么、怎么修
    refused++;
    refusedTags.push(tag);
    lines.push(
      "## " + tag + "（未配对：判分器与基线不一致）",
      "- 判分器: " + pairing.base.label + " → " + pairing.trial.label + "（" + pairing.reasons.join("；") + "）",
      "- 并列展示（不做 Δ、不给门禁结论）: arm turnCov@5=" + pctOf(arm.overall?.turnCov) + "  sessionCov=" + pctOf(arm.overall?.sessionCov) + "  mrr=" + pctOf(arm.overall?.mrr),
      "- 基线同口径: turnCov@5=" + pctOf(base.overall?.turnCov) + "  sessionCov=" + pctOf(base.overall?.sessionCov) + "  mrr=" + pctOf(base.overall?.mrr),
      "- " + configDiffLine(configDiff(base, arm)),
      "- 修复: 用 --allow-cross-judge 显式看参考值，或先把两档对齐到同一 judge（scripts/bench-rejudge.mjs / scripts/bench-baseline.mjs resolve）",
      "",
    );
    continue;
  }
  const armRows = new Map(arm.rows.map((r) => [r.caseId, r]));
  let win = 0, loss = 0, tie = 0;
  let dTurnSum = 0, dSessSum = 0, dMrrSum = 0, n = 0;
  for (const [id, b] of baseRows) {
    const a = armRows.get(id);
    if (!a) continue;
    n++;
    const dT = (a.turnCov ?? 0) - (b.turnCov ?? 0);
    dTurnSum += dT; dSessSum += (a.sessionCov ?? 0) - (b.sessionCov ?? 0); dMrrSum += (a.mrr ?? 0) - (b.mrr ?? 0);
    if (dT > 1e-9) win++; else if (dT < -1e-9) loss++; else tie++;
  }
  const mean = n ? dTurnSum / n : 0;
  const hw = ci95HalfWidth(Math.max(0, Math.min(1, (base.overall.turnCov + mean))), n); // 近似以合并 p 估方差
  const pVal = binomTwoSided(win, win + loss);
  const gate = mean >= 0.03 && mean - hw > 0;
  const gateText = gate
    ? (pairing.judgedComparable || retrievalOnly ? "PASS" : "PASS（跨 judge 参考，不计入合入）")
    : "FAIL";
  lines.push(
    "## " + tag + (pairing.judgedComparable ? "" : retrievalOnly ? "（检索档：无判分行，判分器不参与）" : "（跨判分器参考值）"),
    "- arm turnCov@5=" + (arm.overall.turnCov * 100).toFixed(1) + "%  base=" + (base.overall.turnCov * 100).toFixed(1) + "%  Δ=" + (mean * 100).toFixed(2) + "pp  CI95≈±" + (hw * 100).toFixed(2) + "pp",
    "- ΔsessionCov=" + ((n ? dSessSum / n : 0) * 100).toFixed(2) + "pp  Δmrr=" + ((n ? dMrrSum / n : 0) * 100).toFixed(2) + "pp",
    "- 配对 win/loss/tie=" + win + "/" + loss + "/" + tie + "  符号检验 p=" + pVal.toFixed(4),
    "- 判分: " + (pairing.judgedComparable ? "同 judge（" + pairing.base.label + "）" : "跨 judge 参考——门禁不认"),
    "- " + configDiffLine(configDiff(base, arm)),
    "- E2 门禁（Δ≥+3pp 且 CI 下界>0）: " + gateText,
    "",
  );
}

if (refused) {
  lines.push("## 结论：未配对的档位（" + refusedTags.join("、") + "）");
  lines.push(...judgeRepairHint({ trialJudge: baseJudge.model }));
  lines.push("");
}

const out = lines.join("\n");
console.log(out);
const outPath = argOf("out", undefined);
if (outPath && outPath !== true) fs.writeFileSync(outPath, out + "\n", "utf8");
if (refused && !allowCrossJudge) process.exit(3);
