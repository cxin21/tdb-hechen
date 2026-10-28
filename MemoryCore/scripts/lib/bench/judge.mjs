/**
 * 判分器一致性（issue #140）——bench 配对比较的「尺子是不是同一把」问题。
 *
 * 背景：2026-10-26 的 b0-base/b1-off 是 scm-flash 判分，10-27 起的档位是
 * MiniMax-M3.1-Flash 判分。直接配对会把「判分器差异 ≈ +7.8pp」算成方法收益
 * （w3b vs b1-off：跨 judge +14.4pp/p=0.0023 → 同 judge +6.7pp/p=0.146）。
 *
 * 本模块只做判定与渲染（纯函数，零 IO、零网络）：
 *  - judgeIdentity：报告里记录的判分器身份（model + 判分提示版本 + 端点）；
 *  - pairJudges：两侧能不能配对（same / cross / unknown）；
 *  - decidePairing：给 CLI 的放行/拒绝结论 + 退出码 + 头部行；
 *  - configDiff：判分器之外的实验旋钮差异（避免把配置差异读成方法收益）。
 *
 * 设计取舍（为什么不是「一律拒绝」）：
 *  拒绝只是止血，**治本是把尺子对齐**。所以 decidePairing 的拒绝输出必须带上
 *  两条可执行修复路径（对齐基线 / 用 bench-rejudge.mjs 拿旧答案按当前 judge 重判），
 *  而不是让人「关掉开关、别比较了」。
 */
/** 跨 judge 配对被拒时的退出码（2 已被「用法/读文件错误」占用）。 */
export const CROSS_JUDGE_EXIT_CODE = 3;

const UNKNOWN_LABEL = "（未记录）";

/**
 * config 里**不**算「实验旋钮」的键：判分器身份 / 档位标签 / 基准集坐标 / 溯源字段。
 * 其余键一律参与差异比对（黑名单而非白名单——新旋钮默认可见，不会被静默漏掉）。
 */
export const CONFIG_NON_EXPERIMENT_KEYS = new Set([
  "judgeModel",
  "judgePromptVersion",
  "judgeHost",
  "judgeApiKeySource",
  "tag",
  "manifest",
  "dataset",
  "generatedAt",
  "rejudgedFrom",
  "rejudgedAt",
  // 本机沙箱库路径（每次跑档都不同，与实验结论无关）
  "storeDir",
]);

/** 去空白字符串归一：空串/非字符串 → null（「没记录」绝不猜测成某个值）。 */
export const normalizeText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 判分器身份：模型 + 判分提示版本 + 端点。任一缺失都记为 null，绝不猜测。 */
export function judgeIdentity(report) {
  const cfg = report?.config ?? {};
  const model = normalizeText(cfg.judgeModel);
  const promptVersion = normalizeText(cfg.judgePromptVersion);
  const host = normalizeText(cfg.judgeHost);
  return {
    model,
    promptVersion,
    host,
    known: Boolean(model),
    label: model ?? UNKNOWN_LABEL,
    /** 可打印的指纹：模型@提示版本；版本缺失时只留模型（照样比得上）。 */
    fingerprint: model ? (promptVersion ? `${model}@${promptVersion}` : model) : null,
  };
}

/** 报告里是否有判分行（没有 = retrieval-only 档，判分器不参与比较）。 */
export const hasJudgedRows = (report) => (report?.rows ?? []).some((r) => typeof r?.genCorrect === "number");

/**
 * 两侧配对资格判定。
 *  - same    ：同模型 + 同判分提示版本 → 判对指标可配对；
 *  - cross   ：模型或提示版本不一致 → 判对指标不可配对（检索指标不受影响）；
 *  - unknown ：至少一侧没记录 judgeModel → 身份不可证。
 *             若两侧都没有判分行（retrieval-only 档），这份比较本来就不涉及判分器 → 无害；
 *             只要有判分行，就等于「拿一把没署名的尺子当方法论收益」→ 同样不可配对。
 */
export function pairJudges(baseReport, trialReport) {
  const base = judgeIdentity(baseReport);
  const trial = judgeIdentity(trialReport);
  const judgedMetricsPresent = hasJudgedRows(baseReport) || hasJudgedRows(trialReport);
  const reasons = [];

  let status;
  if (!base.known || !trial.known) {
    status = "unknown";
    const missing = [!base.known ? "base" : null, !trial.known ? "trial" : null].filter(Boolean);
    reasons.push(`${missing.join("/")} 报告未记录 config.judgeModel（判分器身份不可证）`);
    if (judgedMetricsPresent) reasons.push("报告含判分行 → 判对 Δ 无法归因到方法差异");
  } else if (base.model !== trial.model) {
    status = "cross";
    reasons.push(`判分模型不同：base=${base.model} / trial=${trial.model}`);
  } else if (base.promptVersion && trial.promptVersion && base.promptVersion !== trial.promptVersion) {
    status = "cross";
    reasons.push(`判分提示版本不同：base=${base.promptVersion} / trial=${trial.promptVersion}（同模型不同尺子）`);
  } else {
    status = "same";
  }

  return {
    status,
    sameJudge: status === "same",
    base,
    trial,
    reasons,
    judgedMetricsPresent,
    /** 判对/拒答这类 judge-依赖指标能否配对。检索指标（turnCov@5 / MRR）永远可配对。 */
    judgedComparable: status === "same",
  };
}

/** 报告头部的判分器三行（所有配对工具共用同一措辞，避免各写一套口径）。 */
export function judgeHeaderLines(pairing, { allowCrossJudge = false } = {}) {
  const lines = [];
  const head = `判分器: base=${pairing.base.label} / trial=${pairing.trial.label}`;
  if (pairing.status === "same") {
    const v = pairing.base.promptVersion ?? pairing.trial.promptVersion;
    lines.push(`${head} → 一致${v ? `（judgePromptVersion=${v}）` : ""}，判对指标可配对`);
    return lines;
  }
  if (pairing.status === "cross") {
    const why = pairing.reasons.join("；");
    lines.push(
      allowCrossJudge
        ? `${head} → **跨 judge 配对（已用 --allow-cross-judge 豁免）**：${why}；判对/拒答 Δ 含判分器差异，只作参考，不得作为门禁结论`
        : `${head} → **跨 judge 配对**：${why}；判对/拒答 Δ 不可归因到方法差异`,
    );
    return lines;
  }
  // unknown
  lines.push(
    pairing.judgedMetricsPresent
      ? `判分器: ${pairing.base.label} / ${pairing.trial.label} → **判分器身份不可证**（${pairing.reasons.join("；")}）`
      : `判分器: 未记录（两侧均无判分行：retrieval-only 档，本比较不涉及判分器）`,
  );
  return lines;
}

/** 修复路径：拒绝之后必须给出口，否则等于让人放弃比较。 */
export function judgeRepairHint({ trialJudge = null } = {}) {
  const judge = trialJudge ?? "<judge>";
  return [
    "修复路径（任选其一，都不需要关掉门禁）：",
    `  1) 对齐基线：node scripts/bench-baseline.mjs resolve --judge ${judge}  → 取「同 judge 基线」重新配对（登记表见 lme-baselines.json）`,
    "  2) 对齐旧报告：node --import tsx scripts/bench-rejudge.mjs <旧报告.json>  → 用当前 judge 重判已有答案（只花 N 次判分调用，不重跑召回/embedding）",
    "  3) 查历史登记：node scripts/bench-baseline.mjs list",
    "若确实只需要跨 judge 的参考值，显式加 --allow-cross-judge（报告中会标注豁免，门禁不认这类数据）。",
  ];
}

/**
 * CLI 侧的唯一判定入口：放行/拒绝 + 退出码 + 头部（含警示与修复路径）。
 * 返回的 lines 由调用方按自己的输出顺序拼接（compare/gates/ranking 头部各不相同）。
 */
export function decidePairing({ baseReport, trialReport, allowCrossJudge = false, baseLabel = null, trialLabel = null } = {}) {
  const pairing = pairJudges(baseReport, trialReport);
  const lines = judgeHeaderLines(pairing, { allowCrossJudge });

  if (pairing.status === "same") return { pairing, allowed: true, exitCode: 0, lines };
  // retrieval-only：判分器不参与这份比较，放行（否则所有召回归因档都得先配一把无意义的 judge）
  if (pairing.status === "unknown" && !pairing.judgedMetricsPresent) {
    return { pairing, allowed: true, exitCode: 0, lines };
  }
  if (allowCrossJudge) {
    return {
      pairing,
      allowed: true,
      exitCode: 0,
      lines: [...lines, `[warn] 跨判分器配对已豁免——${pairing.reasons.join("；")}；门禁类结论不认这份数据。`],
    };
  }
  const who = pairing.status === "cross" ? "跨 judge 配对" : "判分器身份不可证";
  return {
    pairing,
    allowed: false,
    exitCode: CROSS_JUDGE_EXIT_CODE,
    lines: [
      ...lines,
      `REFUSED: ${who}（${baseLabel ?? "base"} vs ${trialLabel ?? "trial"}）——判对 Δ 无法归因到方法差异，拒绝判定。`,
      ...judgeRepairHint({ trialJudge: pairing.trial.model ?? pairing.base.model }),
    ],
  };
}

const stable = (v) => JSON.stringify(v ?? null);

/**
 * 判分器之外的实验旋钮差异（用于提示「这一对到底只差一个因子吗」）。
 * 两侧 config 的键取并集，黑名单之外全部比对——新增旋钮默认会被看见。
 */
export function configDiff(baseReport, trialReport) {
  const a = baseReport?.config ?? {};
  const b = trialReport?.config ?? {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => !CONFIG_NON_EXPERIMENT_KEYS.has(k))
    .sort();
  const out = [];
  for (const key of keys) {
    const va = a[key] ?? null;
    const vb = b[key] ?? null;
    if (stable(va) !== stable(vb)) out.push({ key, a: va, b: vb });
  }
  return out;
}

/** 单行渲染（头部只占一行，细节交给 --json / 人工比对）。 */
export function configDiffLine(diff, { max = 8 } = {}) {
  if (!diff.length) return "配置差异: 无差异（除判分器外的实验旋钮一致）";
  const shown = diff.slice(0, max).map((d) => `${d.key}=${JSON.stringify(d.a)}→${JSON.stringify(d.b)}`);
  const more = diff.length > max ? ` …(+${diff.length - max})` : "";
  return `配置差异（除判分器外）: ${shown.join(", ")}${more}`;
}
