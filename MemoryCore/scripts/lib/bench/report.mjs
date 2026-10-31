/**
 * 报告可信度门禁（审计 M8 / #154 前序）。
 *
 * 背景：r141 五臂在 2026-10-31 被同名重跑覆盖成 judged=0，判分行消失、cov 还在；
 * 而 bench-report / bench-bucket-paired 只渲染或只比 Δ，从不检查「判分到底有没有跑」，
 * 于是「90 题里只判了 30 题」「judgeModel 缺失」这类报告被当成正常档参与比较。
 *
 * 口径（与 scripts/lib/bench/judge.mjs 互补）：
 * - judge.mjs 管**配对**（同判分器才可比，cross ⇒ exit 3）；
 * - 本模块管**存在性/覆盖率**（judged/total < 阈值 或 judge 字段缺失 ⇒ invalid，exit 非 0）。
 * 二者都不通过时，任何 Δ 都不许写进文档。
 */

/** 判分覆盖率下限：低于它就不算「这一档被判过」。 */
export const JUDGE_COVERAGE_MIN = 0.95;

/** 从报告里读出判分实况（不信任 overall.genJudged——老报告可能缺这一项）。 */
export function judgeCoverage(report) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const total = rows.length;
  const judged = rows.filter((r) => typeof r?.genCorrect === "number").length;
  const cfg = report?.config ?? {};
  const judgeModel = typeof cfg.judgeModel === "string" && cfg.judgeModel ? cfg.judgeModel : null;
  const judgePromptVersion = typeof cfg.judgePromptVersion === "string" ? cfg.judgePromptVersion : null;
  const coverage = total ? judged / total : 0;
  return { total, judged, coverage, judgeModel, judgePromptVersion, retrievalOnly: judged === 0 };
}

/**
 * 判分门禁。
 * @param {object} report 报告对象（eval-memory-bench 产出）
 * @param {object} [opts]
 * @param {string} [opts.label] 打印用的报告名
 * @param {number} [opts.minCoverage] 覆盖率下限，缺省 0.95
 * @param {boolean} [opts.allowUnjudged] 显式承认「检索-only 档」：跳过覆盖率门禁（仍打印警示）
 * @returns {{ok:boolean, invalid:boolean, issues:string[], hint:string|null, total:number, judged:number, coverage:number, judgeModel:string|null, judgePromptVersion:string|null, retrievalOnly:boolean}}
 */
export function judgeGate(report, opts = {}) {
  const { label = "report", minCoverage = JUDGE_COVERAGE_MIN, allowUnjudged = false } = opts;
  const s = judgeCoverage(report);
  const issues = [];
  if (!s.total) {
    issues.push("rows 为空（没有题行，配对/统计无意义）");
  } else if (s.coverage < minCoverage) {
    issues.push(
      `判分覆盖 ${s.judged}/${s.total}=${(s.coverage * 100).toFixed(1)}% < ${(minCoverage * 100).toFixed(0)}%`,
    );
  }
  if (s.judged > 0 && !s.judgeModel) issues.push("有判分行但 config.judgeModel 缺失（判分器不可考，跨判分器无法配对）");
  if (s.judged === 0) issues.push("judged=0（判分行全部缺失——重跑覆盖或判分失败，不是检索-only 请勿当正常档）");

  const bypass = allowUnjudged && s.retrievalOnly;
  const invalid = issues.length > 0 && !bypass;
  const hint = invalid
    ? "重跑或补 judge：node --import tsx scripts/bench-rejudge.mjs --help；确为检索-only 档请显式加 --allow-unjudged"
    : null;
  return { ok: !invalid, invalid, issues, hint, label, ...s };
}

/** 打印一段人能直接照做的错误（返回 exit code，调用方决定是否 process.exit）。 */
export function enforceJudgeGate(report, opts = {}) {
  const g = judgeGate(report, opts);
  if (g.invalid) {
    console.error(`[bench:invalid] ${g.label}: 报告不可用作结论（judged ${g.judged}/${g.total}）`);
    for (const it of g.issues) console.error("  - " + it);
    if (g.hint) console.error("  → " + g.hint);
    return 3;
  }
  if (g.issues.length) {
    console.error(`[bench:warn] ${g.label}: ${g.issues.join("；")}（--allow-unjudged 已显式放行）`);
  }
  return 0;
}

/**
 * 把判分实况写进报告（producer 侧用：让下游不必重算，也让覆盖不足一眼可见）。
 * 注意：这里用**严格**口径（invalid 照实记为 true）。检索-only 档也会被标 invalid，
 * 这正是 M8 要的——下游必须显式 --allow-unjudged 才能拿它做配对，不许静默通过。
 */
export function attachJudgingStatus(report, opts = {}) {
  const g = judgeGate(report, { ...opts });
  report.judging = {
    total: g.total,
    judged: g.judged,
    coverage: Number(g.coverage.toFixed(4)),
    judgeModel: g.judgeModel,
    judgePromptVersion: g.judgePromptVersion,
    invalid: g.invalid,
    issues: g.issues,
  };
  return report.judging;
}
