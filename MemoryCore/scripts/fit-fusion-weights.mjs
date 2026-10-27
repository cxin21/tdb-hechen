#!/usr/bin/env node
/**
 * #135 E1/E2：R2 加权融合离线拟合汇总 + 配对门禁判定。
 *
 * 输入 = eval-memory-bench.mjs 跑出的档位结果 JSON（rows 按 caseId 配对）。
 * 输出 = 每档 vs 基线的配对 turnCov@5 / sessionCov / mrr@5 差值、win/loss/tie、
 *        符号检验 p 值（双尾二项），并按 E2 门禁（ΔturnCov@5 ≥ +3pt 且 CI 下界>0）
 *        给出合入判定。纯离线计算，不外呼。
 *
 * 用法：
 *   node scripts/fit-fusion-weights.mjs --base <result.json> --arm tag=<result.json> [--arm ...]
 */
import fs from "node:fs";

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

const lines = ["# R2 加权融合配对汇总", "", "基线: " + (base.config?.tag ?? basePath) + " n=" + base.overall.n, ""];
for (const spec of armSpecs) {
  const eq = spec.indexOf("=");
  const tag = eq > 0 ? spec.slice(0, eq) : spec;
  const p = eq > 0 ? spec.slice(eq + 1) : spec;
  const arm = JSON.parse(fs.readFileSync(p, "utf8"));
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
  const hw = ci95HalfWidth(Math.max(0, Math.min(1, (base.overall.turnCov + mean))), n) ; // 近似以合并 p 估方差
  const pVal = binomTwoSided(win, win + loss);
  const gate = mean >= 0.03 && mean - hw > 0;
  lines.push(
    "## " + tag,
    "- arm turnCov@5=" + (arm.overall.turnCov * 100).toFixed(1) + "%  base=" + (base.overall.turnCov * 100).toFixed(1) + "%  Δ=" + (mean * 100).toFixed(2) + "pp  CI95≈±" + (hw * 100).toFixed(2) + "pp",
    "- ΔsessionCov=" + ((n ? dSessSum / n : 0) * 100).toFixed(2) + "pp  Δmrr=" + ((n ? dMrrSum / n : 0) * 100).toFixed(2) + "pp",
    "- 配对 win/loss/tie=" + win + "/" + loss + "/" + tie + "  符号检验 p=" + pVal.toFixed(4),
    "- E2 门禁（Δ≥+3pp 且 CI 下界>0）: " + (gate ? "PASS" : "FAIL"),
    ""
  );
}
const out = lines.join("\n");
console.log(out);
const outPath = argOf("out", undefined);
if (outPath && outPath !== true) fs.writeFileSync(outPath, out + "\n", "utf8");
