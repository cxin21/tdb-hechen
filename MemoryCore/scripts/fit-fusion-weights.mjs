#!/usr/bin/env node
/**
 * #135 E1/E2 的配对汇总，以及 #142 的「真拟合」入口。
 *
 * 两个子命令语义不同，别混用：
 *
 *   compare  判定。给一个基线 + N 个档位，逐个按 caseId 配对，算 ΔturnCov@5、
 *            配对 bootstrap CI（1000 次，2.5/97.5 分位）、win/loss/tie、符号检验，
 *            并按 E2 门禁（Δ≥+3pp 且 CI 下界>0）给 PASS/FAIL。判分器不同 → 不配对、
 *            不出结论，非零退出。compare 不做拟合，也不给「怎么调」的建议。
 *
 *   fit      拟合。给一个已跑档位矩阵，先按 matched design（只差一个旋钮的档位对）
 *            把收益归因到单个旋钮，再做坐标搜索（矩阵内换一个旋钮能否更好），
 *            最后把没跑过的邻域写成采样计划。报告里没有候选级通道分，离线无法
 *            评估没跑过的组合，所以 fit 绝不预测未观测组合的数值；采样计划必须重跑。
 *
 * 共用：配对前校验 config.judgeModel / judgePromptVersion（#140）。不一致 → 该档不参与
 * 配对/拟合，只并列展示；默认 exit 3，--allow-cross-judge 显式放行并标注参考值。
 *
 * 用法：
 *   node scripts/fit-fusion-weights.mjs compare --base <result.json> --arm tag=<result.json> [--arm ...]
 *   node scripts/fit-fusion-weights.mjs fit     --base <result.json> --arm tag=<result.json> [--arm ...] [--arm-dir <dir>]
 *   node scripts/fit-fusion-weights.mjs --base <result.json> --arm tag=<result.json>   # 旧调用 = compare
 *
 * 指标口径：主指标 turnCov@5（逐 case 配对）；CI 单位是 pp。旧版近似 CI 只作 legacy 对照。
 */
import fs from "node:fs";
import path from "node:path";
import { configDiff, configDiffLine, decidePairing, judgeIdentity, judgeRepairHint } from "./lib/bench/judge.mjs";
import {
  armKnobs,
  coordinateSearch,
  diagnoseStructure,
  knobsSummary,
  metricOf,
  pairArm,
  rankedTag,
  rankArms,
  samplingPlan,
  singleKnobEffects,
} from "./lib/bench/fusion-fit.mjs";

const METRIC = "turnCov@5";
const ITERS = 1000;
const SEED = 20261027;

// ── 参数解析（支持重复 --arm，旧写法保持兼容） ──────────────────────────────
function parseArgs(argv) {
  const opts = { arm: [], allowCrossJudge: false, out: null, help: false, sub: null };
  const rest = argv.slice(2);
  if (rest[0] && !rest[0].startsWith("-")) opts.sub = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const take = () => (rest[i + 1] === undefined || rest[i + 1].startsWith("--") ? true : rest[++i]);
    if (a === "--base") opts.base = take();
    else if (a === "--arm") opts.arm.push(take());
    else if (a === "--arm-dir") opts.armDir = take();
    else if (a === "--out") opts.out = take();
    else if (a === "--allow-cross-judge") opts.allowCrossJudge = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--metric") opts.metric = take();
    else if (a === "--iters") opts.iters = numericArg("--iters", take());
    else if (a === "--seed") opts.seed = numericArg("--seed", take());
  }
  return opts;
}

/**
 * 数值参数必须显式给值：`--iters` 不带值时 take() 返回 true，Number(true)===1，
 * 会静默把 1000 次 bootstrap 变成 1 次。宁可直接报用法错误。
 */
function numericArg(flag, raw) {
  if (raw === true) {
    console.error(flag + " 缺少数值，例如 " + flag + " 1000");
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(flag + " 需要正整数，收到: " + String(raw));
    process.exit(2);
  }
  return n;
}

const opts = parseArgs(process.argv);
if (opts.help) {
  console.log([
    "用法:",
    "  compare  判定：基线 vs 各档位的配对 Δ / 配对 bootstrap CI / E2 门禁；不做拟合。",
    "  fit      拟合：档位排名 + matched 单因子效应 + 坐标搜索 + 结构诊断 + 采样计划。",
    "",
    "  node scripts/fit-fusion-weights.mjs compare --base <result.json> --arm tag=<result.json> [--arm ...]",
    "  node scripts/fit-fusion-weights.mjs fit     --base <result.json> --arm tag=<result.json> [--arm ...] [--arm-dir <dir>]",
    "",
    "公共参数:",
    "  --allow-cross-judge   判分器不一致时显式放行（输出标注参考值 / 拟合排除）",
    "  --out <file.md>       同时把报告写文件",
    "  --metric <key>        主指标（默认 " + METRIC + "；取 row 上同名/去 @N 的列）",
    "  --iters <n>           bootstrap 次数（默认 " + ITERS + "）",
    "  --seed <n>            随机种子（默认 " + SEED + "）",
    "",
    "语义差异:",
    "  compare 只回答「这一对/这一档是否达到合入门禁」，不回答「下一步调什么」。",
    "  fit    只回答「在已跑矩阵里哪个旋钮值得动、哪些邻域还没跑」，不预测未观测组合。",
    "  报告没有候选级通道分，所以任何「离线重排未跑组合」的做法都是伪装拟合。",
  ].join("\n"));
  process.exit(0);
}

if (opts.sub && opts.sub !== "compare" && opts.sub !== "fit") {
  console.error("未知子命令: " + opts.sub + "（只支持 compare / fit；--help 看语义）");
  process.exit(2);
}
const sub = opts.sub ?? "compare";
const METRIC_KEY = opts.metric && opts.metric !== true ? opts.metric : METRIC;
const ITER = opts.iters ?? ITERS;
const BOOTSTRAP_SEED = opts.seed ?? SEED;

if (!opts.base || opts.base === true) {
  console.error("缺 --base <result.json>");
  process.exit(2);
}
if (!opts.arm.length && (!opts.armDir || opts.armDir === true)) {
  console.error("缺 --arm tag=<result.json> 或 --arm-dir <dir>");
  process.exit(2);
}

/**
 * 读报告：用法/读文件错误一律 exit 2（与「不可比 exit 3」分开），不抛栈。
 * 报告是外部产物，路径打错/JSON 半截都很常见，调用脚本要能据此区分「跑错了」和「数据不可比」。
 */
const readReport = (p) => {
  if (p === true || p == null) {
    console.error("路径参数缺值（--base/--arm 需要跟一个 .json 文件）");
    process.exit(2);
  }
  const abs = path.resolve(String(p));
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (err) {
    console.error("读不到报告: " + abs + "（" + err.message + "）");
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    console.error("报告 JSON 解析失败: " + abs + "（" + err.message + "）");
    process.exit(2);
  }
  if (!Array.isArray(report.rows)) {
    console.error("报告没有 rows 数组: " + abs);
    process.exit(2);
  }
  return { path: abs, report };
};

const baseFile = readReport(String(opts.base));
const base = baseFile.report;
const baseJudge = judgeIdentity(base);
const pctOf = (v) => (typeof v === "number" ? (v * 100).toFixed(1) + "%" : "-");
const pp = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "pp";
const ciText = (ci) => "[" + (ci.lo * 100).toFixed(2) + ", " + (ci.hi * 100).toFixed(2) + "]";

/** 报告里可能没有 overall.turnCov；退回 rows 的均值（逐题取值规则与 pairArm 共用 metricOf）。 */
function overallMetric(report, key = METRIC_KEY) {
  if (typeof report.overall?.[key] === "number") return report.overall[key];
  const vals = (report.rows ?? []).map((r) => metricOf(r, key)).filter((v) => typeof v === "number");
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

/** 汇总一条档位记录（含判分器配对结论）。 */
function loadArm(spec) {
  let tag;
  let file;
  if (typeof spec === "string") {
    const eq = spec.indexOf("=");
    tag = eq > 0 ? spec.slice(0, eq) : spec;
    file = eq > 0 ? spec.slice(eq + 1) : spec;
  } else {
    tag = spec.tag;
    file = spec.file;
  }
  const { path: abs, report } = readReport(file);
  // 判定只走 judge.mjs 的单一入口（放行/拒绝 + 退出码 + 措辞都在那里），脚本不另写一套。
  const verdict = decidePairing({ baseReport: base, trialReport: report, allowCrossJudge: !!opts.allowCrossJudge });
  const pairing = verdict.pairing;
  const retrievalOnly = !pairing.judgedMetricsPresent;
  return { tag, path: abs, report, pairing, verdict, retrievalOnly, pairedOk: verdict.allowed, knobs: armKnobs(report.config) };
}

const armSpecs = [...opts.arm];
if (opts.armDir && opts.armDir !== true) {
  const dir = path.resolve(String(opts.armDir));
  const byTag = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let report;
    try {
      report = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(report.rows) || report.rows.length < 2) continue;
    // 只收同基线（同 manifest）且行数一致的档位，避免把别的数据集混进矩阵
    if (base.config?.manifest && report.config?.manifest && report.config.manifest !== base.config.manifest) continue;
    if (report.rows.length !== base.rows.length) continue;
    // 目录扫描会把 --base 自己扫进来：自配对 Δ 恒为 0，只会污染排名，跳过（显式 --arm 不拦，留着做同 judge 冒烟）。
    if (path.resolve(path.join(dir, f)) === baseFile.path) continue;
    const tag = report.config?.tag ?? f.replace(/\.json$/, "");
    const prev = byTag.get(tag);
    if (!prev || String(report.generatedAt) > String(prev.report.generatedAt)) {
      byTag.set(tag, { tag, file: path.join(dir, f), report });
    }
  }
  armSpecs.push(...byTag.values());
}
const arms = armSpecs.map(loadArm);

// ── 公共：判分器结论 ────────────────────────────────────────────────────────
function judgeNote(arm) {
  if (arm.pairing.judgedComparable) return "同 judge（" + arm.pairing.base.label + "）";
  if (arm.retrievalOnly) return "检索档（无判分行，判分器不参与）";
  return "跨 judge 参考——门禁不认";
}

// ── compare ────────────────────────────────────────────────────────────────
function runCompare() {
  const lines = [
    "# 配对汇总（compare：只判定，不拟合）",
    "",
    "基线: " + (base.config?.tag ?? baseFile.path) + " n=" + (base.overall?.n ?? base.rows.length) + "  判分器=" + baseJudge.label,
    "口径: 主指标 " + METRIC_KEY + "；Δ 为逐 case 配对均值；CI 单位 pp；配对 bootstrap " + ITER + " 次（按 case 重采样，2.5/97.5 分位，seed=" + BOOTSTRAP_SEED + "）。",
    "配对集合 = 两侧都有数值指标的 caseId；指标为 null（应拒答的 _abs 题）剔除，不按 0 计入（旧脚本按 0 计入，故 Δ 可能差 ~0.5pp）。",
    "",
  ];
  let refused = 0;
  const refusedTags = [];
  for (const arm of arms) {
    if (!arm.pairedOk) {
      refused++;
      refusedTags.push(arm.tag);
      const p = arm.report;
      lines.push(
        "## " + arm.tag + "（未配对：" + (arm.pairing.status === "cross" ? "判分器与基线不一致" : "判分器身份不可证") + "）",
        "- 判分器: " + arm.pairing.base.label + " → " + arm.pairing.trial.label + "（" + arm.pairing.reasons.join("；") + "）",
        "- 并列展示（不做 Δ、不给门禁结论）: arm turnCov@5=" + pctOf(p.overall?.turnCov ?? overallMetric(p)) + "  sessionCov=" + pctOf(p.overall?.sessionCov) + "  mrr=" + pctOf(p.overall?.mrr),
        "- 基线同口径: turnCov@5=" + pctOf(base.overall?.turnCov ?? overallMetric(base)) + "  sessionCov=" + pctOf(base.overall?.sessionCov) + "  mrr=" + pctOf(base.overall?.mrr),
        "- " + configDiffLine(configDiff(base, p)),
        ...judgeRepairHint({ trialJudge: arm.pairing?.trial?.model ?? null }),
        "",
      );
      continue;
    }
    const stats = pairArm(base, arm.report, { metricKey: METRIC_KEY, iters: ITER, seed: BOOTSTRAP_SEED });
    const gate = stats.mean >= 0.03 && stats.ci.lo > 0;
    const gateText = gate
      ? arm.pairing.judgedComparable || arm.retrievalOnly
        ? "PASS"
        : "PASS（跨 judge 参考，不计入合入）"
      : "FAIL";
    const bAcc = stats.judged ? (stats.judged.base * 100).toFixed(1) + "%" : "-";
    const aAcc = stats.judged ? (stats.judged.arm * 100).toFixed(1) + "%" : "-";
    lines.push(
      "## " + arm.tag + (arm.pairing.judgedComparable ? "" : arm.retrievalOnly ? "（检索档：无判分行，判分器不参与）" : "（跨判分器参考值）"),
      "- arm turnCov@5=" + pctOf(overallMetric(arm.report)) + "  base=" + pctOf(overallMetric(base)) + "  Δ=" + (stats.mean * 100).toFixed(2) + "pp",
      "- 配对 bootstrap CI95=" + ciText(stats.ci) + "pp（" + stats.n + " 个 case，按 case 重采样，" + ITER + " 次，2.5/97.5 分位）",
      "- 旧近似 CI95≈±" + (stats.legacy * 100).toFixed(2) + "pp（legacy：合并比例方差 1.96*sqrt(p(1-p)/n)，不按 case 配对；与上行之差即配对相关性的修正）",
      "- ΔsessionCov=" + (stats.dSession == null ? "-" : pp(stats.dSession)) + "  Δmrr=" + (stats.dMrr == null ? "-" : pp(stats.dMrr)) +
        "  判对 " + bAcc + " → " + aAcc + (stats.judged ? "（Δ=" + pp(stats.judged.mean) + "，McNemar p=" + stats.judged.p.toFixed(4) + "）" : ""),
      "- 配对 win/loss/tie=" + stats.win + "/" + stats.loss + "/" + stats.tie + "  符号检验 p=" + stats.signP.toFixed(4),
      "- 判分: " + judgeNote(arm),
      ...(stats.missing ? ["- 缺行: " + stats.missing + " 个 caseId 只在 arm 里、基线没有 → 已跳过（检查两侧是否同一 manifest）"] : []),
      "- " + configDiffLine(configDiff(base, arm.report)),
      "- E2 门禁（Δ≥+3pp 且配对 CI 下界>0）: " + gateText,
      "",
    );
  }
  if (refused) {
    lines.push("## 结论：未配对的档位（" + refusedTags.join("、") + "）已在上文各自给出修复路径。", "");
  }
  return { text: lines.join("\n"), refused };
}

// ── fit ────────────────────────────────────────────────────────────────────
function runFit() {
  const usable = arms.filter((a) => a.pairedOk);
  const skipped = arms.filter((a) => !a.pairedOk);
  const trialJudge = skipped.find((a) => a.pairing?.trial?.model)?.pairing.trial.model ?? null;
  const lines = [
    "# 档位拟合（fit：矩阵内坐标搜索 + 采样计划）",
    "",
    "基线: " + (base.config?.tag ?? baseFile.path) + " n=" + (base.overall?.n ?? base.rows.length) + "  判分器=" + baseJudge.label,
    "口径: 主指标 " + METRIC_KEY + "；Δ=逐 case 配对均值；CI=配对 bootstrap " + ITER + " 次（2.5/97.5 分位，seed=" + BOOTSTRAP_SEED + "）pp；",
    "      单因子效应=matched design（只统计「除一个旋钮外其余旋钮全同」的档位对）；",
    "      报告不含候选级通道分，未跑过的组合不预测数值，只进采样计划。",
    "",
  ];
  if (usable.some((a) => !a.pairing.judgedComparable && !a.retrievalOnly)) {
    lines.push("⚠️ 含 --allow-cross-judge 放行的跨判分器档（表内标「参考」）：判对/拒答列含判分器差异，只作参考，不得作为合入结论。", "");
  }
  if (!usable.length) {
    lines.push("没有可拟合的档位（全部判分器不一致或缺行）。先修 judge 或 --allow-cross-judge。", "");
    return { text: lines.join("\n"), refused: skipped.length };
  }

  const ranked = rankArms({ baseReport: base, arms: usable, metricKey: METRIC_KEY, iters: ITER, seed: BOOTSTRAP_SEED });
  lines.push(
    "## 档位排名（相对基线 " + (base.config?.tag ?? "base") + "）",
    "",
    "| 档位 | 旋钮 | " + METRIC_KEY + " | Δpp | 配对bootstrap CI95 | legacy CI95 | W/L/T | 判对 | 拒答 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of ranked.rows) {
    const s = row.stats;
    const acc = s.judged ? (s.judged.arm * 100).toFixed(1) + "%" : "-";
    const ref = s.refused ? (s.refused.arm * 100).toFixed(1) + "%" : "-";
    const tagCell = rankedTag(row);
    lines.push(
      "| " + tagCell + " | " + knobsSummary(row.knobs).replace(/\|/g, "/") + " | " + pctOf(overallMetric(row.report)) +
        " | " + (s.mean * 100).toFixed(2) + " | " + ciText(s.ci) + " | ±" + (s.legacy * 100).toFixed(2) +
        " | " + s.win + "/" + s.loss + "/" + s.tie + " | " + acc + " | " + ref + " |",
    );
  }
  lines.push("");

  const fitArms = ranked.rows.map((r) => ({ ...r, metric: overallMetric(r.report) }));
  const { effects } = singleKnobEffects(fitArms, { metricKey: METRIC_KEY });

  lines.push("## 单因子效应（matched design）", "");
  if (!effects.length) {
    lines.push("- 没有「只差一个旋钮」的档位对 → 无法归因。先按下面的采样计划补成对档位。", "");
  } else {
    lines.push("只列有 matched 对的旋钮；meanΔ = 该 level 相对配对另一侧的平均主指标差（正=更好），n=配对数。", "");
    for (const e of effects) {
      const parts = e.levels.map((L) => String(L.value) + "→" + (L.meanDelta * 100).toFixed(2) + "pp(n=" + L.n + ")");
      lines.push("- " + e.knob + "（" + e.pairs + " 对）: " + parts.join("  ") + (e.pairs < 2 ? "  ⚠️ n<2 仅供参考" : ""));
    }
    lines.push("");
  }

  const coord = coordinateSearch(fitArms, { effects, metricKey: METRIC_KEY });
  lines.push("## 坐标搜索（只在已观测档位间移动）", "");
  lines.push(
    "当前最优: " + (coord.best?.tag ?? "-") + "  " + knobsSummary(coord.best?.knobs ?? {}) +
      "  绝对主指标 " + ((coord.bestMetric ?? 0) * 100).toFixed(1) + "%",
    "",
  );
  if (!coord.moves.length) {
    lines.push("- 没有「换一个旋钮就有更好已观测档」的坐标 → 矩阵内已收敛；下一步靠采样计划扩矩阵。", "");
  } else {
    for (const m of coord.moves) {
      lines.push(
        "- " + m.knob + ": " + String(m.from) + " → " + String(m.to) + "，预计 " + pp(m.estimate) +
          "（matched " + m.pairs + " 对；" + (m.observed ? "该组合已观测" : "该组合未观测，需重跑") +
          "；证据档: " + m.evidence.join("、") + "）",
      );
    }
    lines.push("");
  }
  for (const ig of coord.ignored) lines.push("- 不作为坐标移动：" + ig.knob + "——" + ig.reason);
  if (coord.ignored.length) lines.push("");

  const diag = diagnoseStructure(fitArms, { effects, best: coord.best, metricKey: METRIC_KEY });
  lines.push("## 结构诊断（按 matched 证据说话）", "");
  for (const d of diag) lines.push("- [" + d.severity + "] " + d.text);
  lines.push("");

  const plan = samplingPlan(fitArms, coord.best, { diagnosis: diag, moves: coord.moves });
  lines.push("## 下一步采样计划（未观测组合必须重跑）", "");
  if (!plan.length) lines.push("- 邻域已覆盖；若要继续，扩数据集或换判分维度。", "");
  else {
    lines.push("| 建议 tag | 基于 | 旋钮 | 现值 | 建议 | 理由 |", "| --- | --- | --- | --- | --- | --- |");
    for (const p of plan) {
      lines.push("| " + p.tag + " | " + p.baseTag + " | " + p.knob + " | " + String(p.from) + " | " + String(p.to) + " | " + p.rationale + " |");
    }
    lines.push("");
  }

  if (skipped.length) {
    lines.push("## 拟合排除（判分器/行数不匹配）", "");
    for (const a of skipped) lines.push("- " + a.tag + "：" + (a.pairing?.reasons?.join("；") || "不可比"));
    if (!opts.allowCrossJudge) {
      lines.push("", "退出码 3：有 " + skipped.length + " 档判分器不可比、已排除；确认要看参考值再加 --allow-cross-judge（输出会标注「参考」）。");
      lines.push("", ...judgeRepairHint({ trialJudge }));
    }
    lines.push("");
  }
  return { text: lines.join("\n"), refused: skipped.length };
}

const result = sub === "fit" ? runFit() : runCompare();
console.log(result.text);
if (opts.out && opts.out !== true) fs.writeFileSync(path.resolve(String(opts.out)), result.text + "\n", "utf8");
if (result.refused && !opts.allowCrossJudge) process.exit(3);
