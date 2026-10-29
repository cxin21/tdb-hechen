/**
 * #141 因子设计跑批（≥8 格）与「1+1>2」判定 —— 叶模块，纯函数、零网络。
 *
 * 背景：W1（事实通道）/ W2（效期）/ W3（结论层）三个因子各自都被单独测过有收益，
 * 但「两两组合是否优于单档最好」从没被真正判定过——历史做法是拿组合档去比**基座**，
 * 于是「组合 > 基座」被当成「组合 > 单档」，等于把两次独立的 +3pp 相加当成协同。
 * 本模块把口径钉死：
 *  - 全部臂对同一基线做**同题配对**（caseId 交集，缺一侧的题不参与）；
 *  - 判对率（genAccuracy）为主指标，turnCovInjected / turnCov@5 为副指标；
 *  - 组合臂只跟**单机制臂里判对率最高的那一档**（singleBest）比，Δ 判对率的
 *    paired bootstrap 95%CI **下界 > 0** 才算 1+1>2（pass=true），否则 keep-single；
 *  - 判分器不同（judgeIdentity 不一致）时判对/拒答 Δ 不可归因 → verdict=insufficient；
 *  - 分题型门禁：#141 要求 temporal 不得低于基线同口径值，任一臂掉线即 perTypeGate.ok=false。
 *
 * 设计取舍：
 *  - 不新造统计量：CI 用 stats.mjs 的 pairedBootstrap（percentile 法，10k 次），
 *    判对/拒答这类二分指标用 McNemar 精确检验，连续指标的 p 用配对差方向的符号检验
 *    （保守、可复现；「差 0」不计入方向，与 exact 检验的 discordant 对同构）。
 *  - 退化不抛错：n<2、caseId 交集为空、缺某指标 → 跳过该配对并把原因写进 reasons，
 *    让跑批脚本永远能产出报告（抛错等于把「数据不足」伪装成「跑挂了」）。
 *  - 不做 IO 猜测：臂可以是 {tag, report}（已解析对象）或 {tag, file}（就地读 JSON）。
 *    判分器身份绝不猜——缺 judgeModel 就是「不可证」，不是「大概是同一把」。
 *
 * 单位约定（Lead 集成/验收按此读）：
 *  - dEval = 指标原单位差值（0.12 表示 +12 个百分点）；
 *  - pp     = dEval * 100（百分点数值，正负同向）；
 *  - ci     = [ciLow, ciHigh]（原单位）；
 *  - p      = 双侧检验 p 值（见上）。
 */
import fs from "node:fs";
import { mcnemarExact, pairedBootstrap, pct } from "./stats.mjs";
import { hasJudgedRows, judgeIdentity, pairJudges } from "./judge.mjs";

/** 主/副指标定义。judged=true 的指标受判分器一致性约束。 */
const METRIC_DEFS = [
  { key: "genAccuracy", label: "判对率", kind: "judged", invert: false },
  { key: "turnCov@5", label: "turnCov@5", kind: "cov" },
  { key: "turnCovInjected", label: "注入集 turnCov", kind: "cov" },
  { key: "refusalRate", label: "拒答率", kind: "judged", invert: true },
  { key: "injectedLines", label: "注入行数", kind: "num" },
];

/** 分题型桶里额外保留的检索口径（门禁默认比 turnCov）。 */
const PER_TYPE_KEYS = ["genAccuracy", "turnCov", "turnCov@5", "turnCovInjected", "refusalRate", "injectedLines"];

const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** invert 指标（拒答率）越小越好：渲染时箭头方向要翻。 */
const invertOf = (key) => METRIC_DEFS.find((d) => d.key === key)?.invert === true;
/** 历史产物里 genCorrect/refused 可能是布尔或 0/1 —— 两种形状都认，其余记 null（未测量）。 */
const binOrNull = (v) => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : null);
const mean = (vals) => (vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null);

/** 单行 → 指标值；缺字段返回 null（=未测量，绝不按 0 计）。 */
export function metricOf(row, key) {
  if (!row) return null;
  switch (key) {
    case "genAccuracy":
      return binOrNull(row.genCorrect);
    case "refusalRate":
      return binOrNull(row.refused);
    case "turnCov@5":
      return numOrNull(row["turnCov@5"]);
    case "turnCov":
      return numOrNull(row.turnCov);
    case "turnCovInjected":
      return numOrNull(row.turnCovInjected);
    case "injectedLines":
      return numOrNull(row.injectedLines);
    default:
      return null;
  }
}

/** 报告行按指标求均值（只对「测到了」的行取均值——与 metrics.mjs 的 aggregate 同口径）。 */
function meanOfRows(rows, key) {
  return mean(rows.map((r) => metricOf(r, key)).filter((v) => v !== null));
}

/** 一份报告 → 一格（cells 的一行）。 */
function cellOf(tag, report) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const cell = {
    tag,
    n: rows.length,
    genJudged: rows.filter((r) => binOrNull(r?.genCorrect) !== null).length,
    perType: {},
  };
  for (const def of METRIC_DEFS) cell[def.key] = meanOfRows(rows, def.key);
  const byType = new Map();
  for (const row of rows) {
    const t = row?.questionType || "unknown";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(row);
  }
  for (const [t, list] of byType) {
    const bucket = { n: list.length };
    for (const key of PER_TYPE_KEYS) bucket[key] = meanOfRows(list, key);
    cell.perType[t] = bucket;
  }
  return cell;
}

/** 臂 → {tag, report}；file 就地读（缺文件抛错由调用方转成退出码 2）。 */
function resolveArm(arm, index) {
  if (arm && arm.report && typeof arm.report === "object") {
    return { tag: arm.tag ?? arm.report.config?.tag ?? `arm#${index}`, report: arm.report };
  }
  if (arm && typeof arm.file === "string") {
    const report = JSON.parse(fs.readFileSync(arm.file, "utf8"));
    return { tag: arm.tag ?? report.config?.tag ?? arm.file.split(/[\\/]/).pop(), report };
  }
  throw new Error(`arm[${index}] 需要 {tag, report} 或 {tag, file}（收到 ${JSON.stringify(arm)}）`);
}

/** 配对样本：两侧 caseId 交集、且该指标两侧都有值。 */
function pairedValues(rowsA, rowsB, key) {
  const mapA = new Map((rowsA ?? []).map((r) => [r?.caseId, r]));
  const out = [];
  for (const b of rowsB ?? []) {
    const a = mapA.get(b?.caseId);
    if (!a) continue;
    const va = metricOf(a, key);
    const vb = metricOf(b, key);
    if (va === null || vb === null) continue;
    out.push([va, vb]);
  }
  return out;
}

/** 二分指标用 McNemar 精确检验；连续指标退化为配对差方向的符号检验（保守）。 */
function pValueOf(def, pairs, deltas) {
  if (def.kind === "judged") {
    let b = 0;
    let c = 0;
    for (const [va, vb] of pairs) {
      if (va === 1 && vb === 0) b++;
      else if (va === 0 && vb === 1) c++;
    }
    return mcnemarExact(b, c).p;
  }
  const pos = deltas.filter((d) => d > 1e-12).length;
  const neg = deltas.filter((d) => d < -1e-12).length;
  return mcnemarExact(pos, neg).p;
}

/**
 * 判分器是否「同一把尺子」：以基线为锚，逐臂 pairJudges。
 * retrieval-only（两侧都无判分行）不算冲突——那份比较本来不涉及判分器。
 */
function judgeOf(baseReport, baseTag, armList) {
  const baseId = judgeIdentity(baseReport);
  const perArm = [];
  const comparable = {};
  const mismatched = [];
  let ok = true;
  if (hasJudgedRows(baseReport) && !baseId.known) {
    ok = false;
    mismatched.push({ tag: baseTag, status: "unknown", reasons: ["基线报告含判分行但未记录 config.judgeModel（判分器身份不可证）"] });
  }
  for (const { tag, report } of armList) {
    if (tag === baseTag) {
      perArm.push({ tag, label: judgeIdentity(report).label, status: "base" });
      comparable[tag] = !(hasJudgedRows(report) && !baseId.known);
      continue;
    }
    const p = pairJudges(baseReport, report);
    const harmless = p.status === "unknown" && !p.judgedMetricsPresent;
    perArm.push({ tag, label: p.trial.label, status: p.status });
    comparable[tag] = p.status === "same" || harmless;
    if (!harmless && p.status !== "same") {
      ok = false;
      mismatched.push({ tag, status: p.status, reasons: p.reasons });
    }
  }
  const note = ok
    ? `判分器一致：${baseId.label}${baseId.promptVersion ? `（judgePromptVersion=${baseId.promptVersion}）` : ""} → 判对/拒答 Δ 可归因`
    : `判分器不一致，判对/拒答 Δ 不可归因：${mismatched
        .map((m) => `${m.tag}(${m.status}: ${m.reasons.join("；")})`)
        .join("；")}`;
  return { ok, identity: ok ? baseId : null, base: baseId, perArm, comparable, mismatched, note };
}

/** meta.floor 归一：{type: {metric, pp}}；也接受 [{type, metric, pp}]。 */
function normalizeFloor(floor) {
  const out = {};
  if (!floor) return out;
  const entries = Array.isArray(floor) ? floor.map((f) => [f.type, f]) : Object.entries(floor);
  for (const [type, spec] of entries) {
    if (!type) continue;
    const metric = typeof spec === "string" ? spec : spec?.metric ?? "turnCov";
    const ppVal = typeof spec === "number" ? spec : numOrNull(spec?.pp) ?? 0;
    out[type] = { metric, pp: ppVal };
  }
  return out;
}

/**
 * 把门禁里的题型名解析到真实桶名：#141 正文写的是「temporal」，而 LongMemEval 的
 * questionType 是「temporal-reasoning」这类全名。先精确匹配，再唯一前缀匹配；
 * 多个候选时宁可跳过也不猜（猜错等于门禁静默失效）。
 */
function resolveTypeKey(knownTypes, want) {
  if (knownTypes.includes(want)) return want;
  const lower = String(want).toLowerCase();
  const hits = knownTypes.filter((t) => String(t).toLowerCase().startsWith(lower));
  return hits.length === 1 ? hits[0] : null;
}

/** 分题型门禁：默认 temporal 的 turnCov 不得低于基线（pp=0 容差）。 */
function perTypeGateOf(cells, baseCell, floorSpec, reasons) {
  const spec = { temporal: { metric: "turnCov", pp: 0 }, ...normalizeFloor(floorSpec) };
  const failures = [];
  const knownTypes = [...new Set(cells.flatMap((c) => Object.keys(c.perType ?? {})))];
  // 显式写全名的门禁优先：--floor temporal-reasoning=turnCov=100 不应该被默认的
  // temporal（前缀解析到同一个桶）再按 pp=0 判一次。
  const entries = Object.entries(spec)
    .map(([type, v]) => ({ type, ...v }))
    .sort((x, y) => Number(knownTypes.includes(y.type)) - Number(knownTypes.includes(x.type)));
  const seenBuckets = new Set();
  for (const { type, metric, pp: ppVal } of entries) {
    const bucket = resolveTypeKey(knownTypes, type);
    if (!bucket) {
      reasons.push(`分题型门禁跳过：题型 ${type} 不在报告里（实际桶: ${knownTypes.join(", ") || "无"}）`);
      continue;
    }
    if (seenBuckets.has(bucket)) continue;
    seenBuckets.add(bucket);
    const baseVal = baseCell?.perType?.[bucket]?.[metric];
    if (baseVal === null || baseVal === undefined) {
      reasons.push(`分题型门禁跳过：基线 ${baseCell?.tag} 无 ${bucket}.${metric}（题集里没有该题型？）`);
      continue;
    }
    const floorValue = baseVal - ppVal / 100;
    for (const cell of cells) {
      if (cell.tag === baseCell.tag) continue;
      const value = cell.perType?.[bucket]?.[metric];
      if (value === null || value === undefined) continue;
      if (value < floorValue - 1e-9) {
        failures.push({ tag: cell.tag, type: bucket, metric, value, floor: floorValue, floorPp: ppVal, baseValue: baseVal, gateType: type });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * 因子设计主入口。
 * @param {Array<{tag?: string, report?: object, file?: string}>} arms
 * @param {{baseTag?: string, singleTags?: string[], comboTags?: string[], comboTag?: string,
 *          floor?: object|array, judgeGate?: boolean}} meta
 */
export function buildFactorial(arms = [], meta = {}) {
  const reasons = [];
  const armList = (Array.isArray(arms) ? arms : []).map(resolveArm);
  if (!armList.length) {
    return {
      judge: { ok: false, identity: null, note: "没有可分析的臂（arms 为空）", perArm: [], mismatched: [] },
      cells: [],
      effects: { baseTag: null, win: [] },
      singleBest: null,
      combo: null,
      verdict: "insufficient",
      reasons: ["arms 为空：无法判定"],
      perTypeGate: { ok: true, failures: [] },
    };
  }
  const baseTag = meta.baseTag ?? armList[0].tag;
  const baseArm = armList.find((a) => a.tag === baseTag);
  if (!baseArm) {
    throw new Error(`meta.baseTag=${baseTag} 不在 arms 里（可选：${armList.map((a) => a.tag).join(", ")}）`);
  }
  const baseReport = baseArm.report;
  const baseRows = Array.isArray(baseReport?.rows) ? baseReport.rows : [];
  const judge = judgeOf(baseReport, baseTag, armList);
  if (!judge.ok) reasons.push("判分器不一致：判对/拒答 Δ 只作参考，判定线不认这类数据");

  const cells = armList.map(({ tag, report }) => cellOf(tag, report));
  const baseCell = cells.find((c) => c.tag === baseTag);

  // ── 每臂 vs 基线：同题配对 Δ + 95%CI + p ──
  const win = [];
  for (const { tag, report } of armList) {
    if (tag === baseTag) continue;
    const armRows = Array.isArray(report?.rows) ? report.rows : [];
    const shared = new Set(armRows.map((r) => r?.caseId));
    const inter = baseRows.filter((r) => shared.has(r?.caseId)).length;
    if (inter < 2) {
      reasons.push(`配对跳过：${tag} vs 基线 ${baseTag} 的 caseId 交集 ${inter} 条（<2，无法配对）`);
      continue;
    }
    for (const def of METRIC_DEFS) {
      const pairs = pairedValues(baseRows, armRows, def.key);
      if (!pairs.length) {
        reasons.push(`指标跳过：${tag} 的 ${def.key} 与基线无共同测量行`);
        continue;
      }
      const deltas = pairs.map(([a, b]) => b - a);
      const { lo, hi } = pairedBootstrap(deltas, { iters: 10000 });
      const dEval = mean(deltas);
      const pass = lo > 0;
      const lose = hi < 0;
      win.push({
        a: baseTag,
        b: tag,
        metric: def.key,
        label: def.label,
        n: pairs.length,
        dEval,
        pp: dEval * 100,
        ci: [lo, hi],
        ciLow: lo,
        ciHigh: hi,
        p: pValueOf(def, pairs, deltas),
        // 可归因性按臂判定：只有跨了尺子（或尺子不可证）的那个臂的同判对指标不可比，
        // 同尺子的臂仍然可读；整体 judge.ok 仍决定 verdict 是否认这套数据。
        judgedComparable: def.kind !== "judged" || judge.comparable[tag] !== false,
        verdict: pairs.length < 2 ? "insufficient" : pass ? "win" : lose ? "loss" : "inconclusive",
      });
    }
  }
  const effects = { baseTag, win };

  // ── 单档最好（meta.singleTags 里判对率最高者） ──
  const singleTags = Array.isArray(meta.singleTags) ? meta.singleTags : [];
  const singleCells = cells.filter((c) => singleTags.includes(c.tag) && c.tag !== baseTag && c.genAccuracy !== null);
  if (!singleTags.length) reasons.push("未提供 meta.singleTags：无法确定「单档最好」，判定线不可用");
  else if (!singleCells.length) reasons.push(`单机制臂里没有可用的判对率（${singleTags.join(", ")}）`);
  // #141 评审 #11：singleBest 必须在**与组合臂相同的题集**上选，否则「少判且都对」的臂
  // 会因为分母小被选中，判定线就成了「拿单臂的小样本比组合臂的全样本」。
  const comboTagsForDenom = meta.comboTag ? [meta.comboTag] : Array.isArray(meta.comboTags) ? meta.comboTags : [];
  const denomArmRows = armList
    .filter((a) => singleTags.includes(a.tag) || comboTagsForDenom.includes(a.tag) || a.tag === baseTag)
    .map((a) => (Array.isArray(a.report?.rows) ? a.report.rows : []).filter((r) => binOrNull(r?.genCorrect) !== null).map((r) => r?.caseId));
  const commonJudged = denomArmRows.length
    ? denomArmRows.reduce((acc, ids) => new Set(ids.filter((id) => acc.has(id))), new Set(denomArmRows[0]))
    : new Set();
  if (commonJudged.size >= 2) {
    for (const c of singleCells) {
      const rows = (armList.find((a) => a.tag === c.tag)?.report?.rows ?? []).filter(
        (r) => commonJudged.has(r?.caseId) && binOrNull(r?.genCorrect) !== null,
      );
      c.genAccuracyCommon = meanOfRows(rows, "genAccuracy");
      c.commonN = rows.length;
    }
    reasons.push("singleBest 在共同判分题集（n=" + commonJudged.size + "）上选，避免各臂分母不一致");
  }
  const rankedSingles = [...singleCells].sort(
    (x, y) =>
      (y.genAccuracyCommon ?? y.genAccuracy ?? -1) - (x.genAccuracyCommon ?? x.genAccuracy ?? -1) ||
      (y.turnCovInjected ?? -1) - (x.turnCovInjected ?? -1) ||
      (y["turnCov@5"] ?? -1) - (x["turnCov@5"] ?? -1),
  );
  const singleBest = rankedSingles[0] ?? null;

  // ── 组合臂 vs 单档最好：判定线 ──
  const comboTags = meta.comboTag ? [meta.comboTag] : Array.isArray(meta.comboTags) ? meta.comboTags : [];
  const comboCells = cells.filter((c) => comboTags.includes(c.tag) && c.tag !== baseTag && c.genAccuracy !== null);
  const rankedCombos = [...comboCells].sort((x, y) => (y.genAccuracy ?? -1) - (x.genAccuracy ?? -1));
  const comboCell = rankedCombos[0] ?? null;
  let combo = null;
  if (!comboCell) {
    reasons.push(comboTags.length ? `组合臂里没有可用的判对率（${comboTags.join(", ")}）` : "未提供 comboTag/comboTags：判定线不可用");
  } else if (!singleBest) {
    reasons.push(`组合臂 ${comboCell.tag} 缺少对照的单档最好（singleBest 为空）`);
  } else {
    const bestReport = armList.find((a) => a.tag === singleBest.tag)?.report;
    const comboReport = armList.find((a) => a.tag === comboCell.tag)?.report;
    const pairs = pairedValues(
      Array.isArray(bestReport?.rows) ? bestReport.rows : [],
      Array.isArray(comboReport?.rows) ? comboReport.rows : [],
      "genAccuracy",
    );
    if (pairs.length < 2) {
      reasons.push(`判定线跳过：${comboCell.tag} vs 单档最好 ${singleBest.tag} 的判对配对仅 ${pairs.length} 条（<2）`);
      combo = { tag: comboCell.tag, bestTag: singleBest.tag, n: pairs.length, dVsBest: null, pp: null, ci: null, ciLow: null, ciHigh: null, p: null, pass: false };
    } else {
      const deltas = pairs.map(([a, b]) => b - a);
      const { lo, hi } = pairedBootstrap(deltas, { iters: 10000 });
      const dVsBest = mean(deltas);
      combo = {
        tag: comboCell.tag,
        bestTag: singleBest.tag,
        n: pairs.length,
        dVsBest,
        pp: dVsBest * 100,
        ci: [lo, hi],
        ciLow: lo,
        ciHigh: hi,
        p: pValueOf(METRIC_DEFS[0], pairs, deltas),
        // 判定线（#141 验收）：95%CI 下界 > 0 才算 1+1>2。
        pass: judge.ok && lo > 0,
      };
      if (!judge.ok) reasons.push(`判定线不认跨 judge 数据：${comboCell.tag} vs ${singleBest.tag} 的 Δ 不可归因`);
    }
  }

  let verdict;
  if (!judge.ok) verdict = "insufficient";
  else if (!singleBest || !combo) verdict = "insufficient";
  else if (combo.pass) verdict = "combination-wins";
  else verdict = "keep-single";

  const perTypeGate = perTypeGateOf(cells, baseCell, meta.floor, reasons);
  if (!perTypeGate.ok) {
    reasons.push(
      `分题型门禁未过：${perTypeGate.failures.map((f) => `${f.tag}.${f.type}.${f.metric}=${f.value.toFixed(3)} < ${f.floor.toFixed(3)}`).join("；")}`,
    );
  }

  return { judge, cells, effects, singleBest, combo, verdict, reasons, perTypeGate };
}

const VERDICT_TEXT = {
  "combination-wins": "**combination-wins**：组合臂显著优于单档最好（Δ 判对率 95%CI 下界 > 0）→ 因子间存在协同，按组合上线",
  "keep-single": "**keep-single**：组合臂未显著优于单档最好（95%CI 下界 ≤ 0）→ 不做组合，保留单档最好",
  insufficient: "**insufficient**：判分器不一致 / 缺单档或组合臂 / 配对数 <2 → 本批数据不足以判定，需补跑或对齐判分器",
};

const fmtP = (p) => (p === null || p === undefined ? "n/a" : p < 1e-4 ? "<0.0001" : p.toFixed(4));
/** 原单位 → 带符号百分点文案（0.12 → "+12.0pp"）。 */
const ppt = (raw) => (raw === null || raw === undefined ? "n/a" : `${raw >= 0 ? "+" : ""}${(raw * 100).toFixed(1)}pp`);

/**
 * 渲染中文 markdown：cells 表 + effects 表 + 判定结论 + 分题型门禁明细。
 * @param {object} result buildFactorial 的返回值
 * @param {{allowCrossJudge?: boolean}} [opts] 跨 judge 时是否已显式豁免（决定脚注措辞）
 */
export function formatFactorialMarkdown(result, opts = {}) {
  const { judge, cells, effects, singleBest, combo, verdict, reasons, perTypeGate } = result;
  const allowCrossJudge = opts.allowCrossJudge === true;
  const star = judge.ok ? "" : "*";
  const L = [];
  L.push(`# 因子设计对比（${cells.length} 格，${effects.baseTag ? `基线 ${effects.baseTag}` : "无基线"}）`);
  L.push("");
  L.push(`判分器: ${judge.base?.label ?? "（未记录）"}${judge.base?.promptVersion ? `（judgePromptVersion=${judge.base.promptVersion}）` : ""} → ${judge.ok ? "一致，判对/拒答可配对" : allowCrossJudge ? "**不一致（已 --allow-cross-judge 豁免）**：判对/拒答 Δ 只作参考" : "**不一致**：判对/拒答 Δ 不可归因"};`);
  if (!judge.ok) L.push(`  - ${judge.note}`);
  L.push("");

  L.push("## 各格结果");
  L.push("");
  L.push(`| 臂 | n | 判对${star} | turnCov@5 | 注入集 turnCov | 拒答${star} | 注入行 | 角色 |`);
  L.push("|---|---|---|---|---|---|---|---|");
  const roleOf = (tag) => {
    if (tag === effects.baseTag) return "基线";
    if (singleBest?.tag === tag) return "单档最好";
    if (combo?.tag === tag) return "组合臂";
    return "";
  };
  for (const c of cells) {
    L.push(
      `| ${c.tag} | ${c.n} | ${pct(c.genAccuracy)}${star} | ${pct(c["turnCov@5"])} | ${pct(c.turnCovInjected)} | ${pct(c.refusalRate)}${star} | ${c.injectedLines === null ? "n/a" : c.injectedLines.toFixed(2)} | ${roleOf(c.tag)} |`,
    );
  }
  L.push("");

  L.push("## 每臂 vs 基线（同题配对）");
  L.push("");
  L.push(`| 臂 | Δ 判对${star} [95%CI] | p | 判定 | Δ 注入 turnCov | Δ turnCov@5 | Δ 拒答${star}（↓好） | Δ 注入行 |`);
  L.push("|---|---|---|---|---|---|---|---|");
  const pickEffect = (tag, metric) => effects.win.find((w) => w.b === tag && w.metric === metric);
  const cellDelta = (tag, metric, withJudge = false) => {
    const w = pickEffect(tag, metric);
    if (!w) return "—";
    const s = withJudge ? star : "";
    // invert 指标（拒答率）方向相反：下降是改善。箭头按「对结果有利」翻向，
    // 否则每个变好的臂都被读成 loss/↓（评审 #12：METRIC_DEFS.invert 声明了却没人读）。
    const inv = invertOf(metric);
    const verdictMark = w.verdict === "win" ? (inv ? "↓" : "↑") : w.verdict === "loss" ? (inv ? "↑" : "↓") : "·";
    return `${ppt(w.dEval)}${s} [${ppt(w.ciLow)}, ${ppt(w.ciHigh)}] ${verdictMark} n=${w.n}`;
  };
  for (const c of cells) {
    if (c.tag === effects.baseTag) continue;
    const main = pickEffect(c.tag, "genAccuracy");
    L.push(
      `| ${c.tag} | ${cellDelta(c.tag, "genAccuracy", true)} | ${main ? fmtP(main.p) : "—"} | ${main ? main.verdict : "—"} | ${cellDelta(c.tag, "turnCovInjected")} | ${cellDelta(c.tag, "turnCov@5")} | ${cellDelta(c.tag, "refusalRate", true)} | ${cellDelta(c.tag, "injectedLines")} |`,
    );
  }
  L.push("");

  L.push("## 1+1>2 判定");
  L.push("");
  if (singleBest) {
    L.push(`- 单档最好：${singleBest.tag}（判对 ${pct(singleBest.genAccuracy)}，n=${singleBest.n}）`);
  } else {
    L.push("- 单档最好：不可用（未提供 singleTags 或这些臂没有判对率）");
  }
  if (combo) {
    const ci = combo.ci ? `[${ppt(combo.ciLow)}, ${ppt(combo.ciHigh)}]` : "n/a";
    L.push(
      `- 组合臂 ${combo.tag} vs ${combo.bestTag ?? "单档最好"}：Δ 判对 ${star}${ppt(combo.dVsBest)}，95%CI ${ci}，p=${fmtP(combo.p)}，n=${combo.n} → ${combo.pass ? "**pass**" : "not pass"}`,
    );
  } else {
    L.push("- 组合臂：不可用");
  }
  L.push(`- 结论：${VERDICT_TEXT[verdict] ?? verdict}`);
  L.push("");

  L.push("## 分题型门禁");
  L.push("");
  if (perTypeGate.ok) {
    L.push(`- 全部通过（temporal 未低于基线同口径值）`);
  } else {
    L.push("| 臂 | 题型 | 指标 | 值 | 门禁下限 | 基线值 |");
    L.push("|---|---|---|---|---|---|");
    for (const f of perTypeGate.failures) {
      L.push(`| ${f.tag} | ${f.type} | ${f.metric} | ${f.value.toFixed(3)} | ${f.floor.toFixed(3)}（容差 ${f.floorPp}pp） | ${f.baseValue.toFixed(3)} |`);
    }
  }
  L.push("");

  if (reasons?.length) {
    L.push("## 跳过/告警");
    L.push("");
    for (const r of reasons) L.push(`- ${r}`);
    L.push("");
  }
  if (!judge.ok) {
    L.push(
      allowCrossJudge
        ? "* 跨 judge 参考值：判分尺不同，Δ 含判分器差异，不得作为方法结论（--allow-cross-judge 已豁免）。"
        : "* 跨 judge 参考值：判分尺不同，Δ 不可归因到方法差异；对齐判分器后重跑才算数。",
    );
  }
  return L.join("\n");
}
