/**
 * 融合/精排档位矩阵的拟合件（#142）。
 *
 * 背景：#135 的 fit-fusion-weights.mjs 只做配对判定，没有任何「拟合」；而且 CI 用
 * 合并比例方差近似（1.96*sqrt(p(1-p)/n)），不是按 case 配对的 bootstrap。
 * 本模块把「拟合」拆成三个可解释的纯函数步骤，全部只读已落盘报告：
 *
 *  1. pairArm：按 caseId 配对，算 mean Δ 与 paired bootstrap CI（2.5/97.5 分位），
 *     同时保留旧近似 CI 作为 legacy 对照；
 *  2. singleKnobEffects：**matched design**——只挑「除一个逻辑旋钮外其余全同」的档位对，
 *     把收益归因到单个旋钮，而不是把所有档位的均值混在一起比；
 *  3. coordinateSearch + samplingPlan：在已跑矩阵内做坐标搜索（找「换一个旋钮就能更好」
 *     的坐标），并把没跑过的邻域写成**采样计划**。报告里没有候选级通道分，离线无法评估
 *     没跑过的组合，所以这里绝不假装预测数值。
 *
 * 设计口径（与 #135/#137-F 结论一致）：**不把「关开关」当结论**。rerank 的伤害来自
 * 「过度剪枝 + 主序被整体替换」，修法是深池 + blend 混合 + 锚点/补位；weighted 融合在
 * RRF 主序下是零效应，修法是让时间/有效性信号进通道内打分（normalized），再拟合通道权重。
 * 因此 rerank.enabled 只作为**诊断对象**，永远不进坐标移动；融合权重在 matched 设计里
 * 收成一个逻辑旋钮（模式+权重一起变），避免把「模式和权重」拆成五个伪独立因子。
 */
import { mcnemarExact, pairedBootstrap } from "./stats.mjs";

/**
 * 本模块补缺用的 rerank 基线旋钮（candidates=12 / minScore=-2 / mode=rerank / blend=0）。
 *
 * ⚠️ 这是**历史 bench 基线（b0base 档）**，不是当前代码缺省。#145 已把生产缺省翻成
 * 32/−10.5，但这里必须留在 12/−2：报告只记录「相对沙箱缺省的 override」，而已经落盘的
 * 报告（#135/#137-F/#144 全矩阵）都是在该基线下跑出来的——跟着代码缺省改会把「显式写
 * candidates:12」的历史档误标成非缺省，并让 diag 的「深池/blend 修复档」判定
 * （candidates > 12 || blend > 0）静默失效。新基线要比，请在报告里显式写出 override。
 */
/**
 * b0base 精排基线（#135/#144 对照臂的**锚点**，不是生产缺省）。
 * 用途仅限臂标签/诊断判据的「相对基线是否改过」比较：生产缺省自 #145 起是
 * candidates=32 / minScore=−10.5 / blend=0.9（单一源 src/core/recall/rerank/defaults.ts），
 * 这里保持 12/−2 是为了让历史修复档继续可算、可复现，别跟着生产缺省改。
 */
export const B0BASE_RERANK = Object.freeze({ candidates: 12, minScore: -2, mode: "rerank", blend: 0 });
/** candidateK 缺省 = maxResults * 3（bench 的 maxResults=5 → 15）。 */
export const DEFAULT_CANDIDATE_K = 15;

/** 逻辑旋钮（matched design 的比较粒度）。融合的模式+权重合成一个 "fusion"。 */
export const KNOB_ORDER = Object.freeze([
  "rerank.enabled",
  "rerank.blend",
  "rerank.candidates",
  "rerank.minScore",
  "rerank.mode",
  "fusion",
  "recall.candidateK",
]);

const numOr = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** 融合配置的紧凑标签（rrf / weighted(d0.4/b0.3/r0.2/v0.1)）。 */
export function fusionLabel(fusion = {}) {
  const mode = fusion.mode === "weighted" || fusion.mode === "normalized" ? fusion.mode : "rrf";
  if (mode === "rrf") return "rrf";
  const w = ["dense", "bm25", "recency", "validity", "fact"]
    .filter((k) => typeof fusion[k] === "number")
    .map((k) => k[0] + fusion[k]);
  return mode + (w.length ? "(" + w.join("/") + ")" : "");
}

/**
 * 从报告 config 抽出可比较的旋钮向量。
 *
 * 报告只记录「相对沙箱缺省的 override」，所以缺省要在这里补齐，否则「没写 minScore」
 * 与「显式写 -2」会被当成两个不同档位。bench 的 rerank 基线是 enabled=true + local，
 * 因此 rerankOverride.enabled === false 才表示关闭。
 */
export function armKnobs(config = {}) {
  const rr = config.rerankOverride ?? {};
  const rerankOn = rr.enabled !== false;
  return {
    "rerank.enabled": rerankOn,
    "rerank.blend": numOr(rr.blend, B0BASE_RERANK.blend),
    "rerank.candidates": numOr(rr.candidates, B0BASE_RERANK.candidates),
    "rerank.minScore": numOr(rr.minScore, B0BASE_RERANK.minScore),
    "rerank.mode": rr.mode === "filter" ? "filter" : B0BASE_RERANK.mode,
    fusion: fusionLabel(config.fusion ?? {}),
    "recall.candidateK": numOr(config.candidateK, DEFAULT_CANDIDATE_K),
  };
}

/** 旋钮的紧凑渲染（只显示非缺省项，档位表不被长串默认值撑爆）。 */
export function knobsSummary(knobs) {
  const parts = [];
  if (!knobs["rerank.enabled"]) parts.push("rerank=off");
  else {
    if (knobs["rerank.candidates"] !== B0BASE_RERANK.candidates) parts.push("cand=" + knobs["rerank.candidates"]);
    if (knobs["rerank.minScore"] !== B0BASE_RERANK.minScore) parts.push("floor=" + knobs["rerank.minScore"]);
    if (knobs["rerank.blend"] !== B0BASE_RERANK.blend) parts.push("blend=" + knobs["rerank.blend"]);
    if (knobs["rerank.mode"] === "filter") parts.push("rerank=filter");
  }
  if (knobs.fusion && knobs.fusion !== "rrf") parts.push("fusion=" + knobs.fusion);
  if (knobs["recall.candidateK"] !== DEFAULT_CANDIDATE_K) parts.push("cK=" + knobs["recall.candidateK"]);
  return parts.join(" ") || "缺省";
}

/** 两个旋钮向量的差异键。 */
export function knobDiff(a, b) {
  return KNOB_ORDER.filter((k) => a[k] !== b[k]);
}

/** 取报告里某指标的逐题值（优先平铺 \@5 列，否则退回 primary）。 */
export function metricOf(row, metricKey = "turnCov@5") {
  if (typeof row?.[metricKey] === "number") return row[metricKey];
  const fallback = metricKey.replace(/@\d+$/, "");
  return typeof row?.[fallback] === "number" ? row[fallback] : null;
}

/** 旧版近似 CI 半宽（只作 legacy 对照，门禁不再使用）。 */
export function legacyCiHalfWidth(p, n) {
  if (!n) return 0;
  return 1.96 * Math.sqrt((p * (1 - p)) / n);
}

/** 精确二项（对称尾）；n≤90 可承受。符号检验用。 */
export function binomTwoSided(k, n) {
  const c = (nn, kk) => {
    let r = 1;
    for (let i = 0; i < kk; i++) r = (r * (nn - i)) / (i + 1);
    return r;
  };
  let tail = 0;
  for (let i = 0; i <= n; i++) if (Math.min(i, n - i) <= Math.min(k, n - k)) tail += c(n, i);
  return Math.min(1, tail / 2 ** n);
}

/**
 * 按 caseId 配对两份报告，给出主指标 Δ、paired bootstrap CI、legacy 近似 CI、
 * win/loss/tie 与符号检验 p；若两侧都有判分行，再给判对率 Δ 与 McNemar。
 *
 * 缺行/指标为 null（如应拒答的 _abs 题）不静默补 0：配对集合 = 两侧都有**数值**指标的
 * caseId，missing/null 的数量单独报出。
 */
export function pairArm(baseReport, armReport, { metricKey = "turnCov@5", iters = 1000, seed = 20261027 } = {}) {
  const bm = new Map((baseReport.rows ?? []).map((r) => [r.caseId, r]));
  const pairs = [];
  let missing = 0;
  for (const rb of armReport.rows ?? []) {
    const ra = bm.get(rb.caseId);
    if (!ra) {
      missing++;
      continue;
    }
    pairs.push({ a: ra, b: rb });
  }
  const deltas = [];
  const validPairs = [];
  for (const p of pairs) {
    const va = metricOf(p.a, metricKey);
    const vb = metricOf(p.b, metricKey);
    if (va == null || vb == null) continue;
    deltas.push(vb - va);
    validPairs.push({ a: va, b: vb });
  }
  const n = deltas.length;
  const mean = n ? deltas.reduce((s, x) => s + x, 0) / n : 0;
  const ci = n ? pairedBootstrap(deltas, { iters, seed }) : { lo: 0, hi: 0 };
  const baseMean = validPairs.length ? validPairs.reduce((s, p) => s + p.a, 0) / validPairs.length : 0;
  const armMean = validPairs.length ? validPairs.reduce((s, p) => s + p.b, 0) / validPairs.length : 0;
  const legacy = legacyCiHalfWidth(Math.max(0, Math.min(1, baseMean + mean)), n);

  // 辅助指标（同配对集合）：sessionCov / mrr 的逐 case 均值差，用于报告口径
  const auxDelta = (key) => {
    const ds = [];
    for (const p of pairs) {
      const va = metricOf(p.a, key);
      const vb = metricOf(p.b, key);
      if (va != null && vb != null) ds.push(vb - va);
    }
    return ds.length ? ds.reduce((s, x) => s + x, 0) / ds.length : null;
  };

  let win = 0, loss = 0, tie = 0;
  for (const d of deltas) {
    if (d > 1e-9) win++;
    else if (d < -1e-9) loss++;
    else tie++;
  }

  // 判对/拒答（同 judge 才有意义；配不配对由 judge.mjs 判定，这里只算数值）
  const judgedPairs = pairs.filter((p) => typeof p.a.genCorrect === "number" && typeof p.b.genCorrect === "number");
  let judged = null;
  if (judgedPairs.length) {
    const dAcc = judgedPairs.map((p) => (p.b.genCorrect === 1 ? 1 : 0) - (p.a.genCorrect === 1 ? 1 : 0));
    let b = 0, c = 0;
    for (const p of judgedPairs) {
      if (p.a.genCorrect === 1 && p.b.genCorrect !== 1) b++;
      else if (p.a.genCorrect !== 1 && p.b.genCorrect === 1) c++;
    }
    const mc = mcnemarExact(b, c);
    judged = {
      n: judgedPairs.length,
      base: judgedPairs.filter((p) => p.a.genCorrect === 1).length / judgedPairs.length,
      arm: judgedPairs.filter((p) => p.b.genCorrect === 1).length / judgedPairs.length,
      mean: dAcc.reduce((s, x) => s + x, 0) / dAcc.length,
      b,
      c,
      p: mc.p,
    };
  }
  const refusedPairs = pairs.filter((p) => typeof p.a.refused === "number" && typeof p.b.refused === "number");
  const refused = refusedPairs.length
    ? {
        n: refusedPairs.length,
        base: refusedPairs.filter((p) => p.a.refused === 1).length / refusedPairs.length,
        arm: refusedPairs.filter((p) => p.b.refused === 1).length / refusedPairs.length,
      }
    : null;

  return {
    n,
    missing,
    baseMean,
    armMean,
    mean,
    ci,
    legacy,
    dSession: auxDelta("sessionCov@5"),
    dMrr: auxDelta("mrr@5"),
    win,
    loss,
    tie,
    signP: binomTwoSided(win, win + loss),
    judged,
    refused,
  };
}

/**
 * 把所有档位相对于基线排名（主指标降序；同分看判对）。
 * @returns {{rows: Array, best: object|null}}
 */
/** 排名表里的档位名：跨判分器但被 --allow-cross-judge 放行的档标「（参考）」，避免被当成合入依据。 */
export function rankedTag({ tag, pairing, retrievalOnly }) {
  const reference = !pairing?.judgedComparable && !retrievalOnly;
  return tag + (reference ? "（参考）" : "");
}

export function rankArms({ baseReport, arms, metricKey = "turnCov@5", iters = 1000, seed = 20261027 }) {
  const rows = arms.map((a) => ({
    ...a,
    stats: pairArm(baseReport, a.report, { metricKey, iters, seed }),
  }));
  rows.sort((x, y) => {
    const dx = x.stats.mean;
    const dy = y.stats.mean;
    if (Math.abs(dy - dx) > 1e-12) return dy - dx;
    const jx = x.stats.judged?.arm ?? -1;
    const jy = y.stats.judged?.arm ?? -1;
    return jy - jx;
  });
  return { rows, best: rows[0] ?? null };
}

const armMetric = (arm, metricKey) => {
  if (typeof arm.metric === "number") return arm.metric;
  if (typeof arm.overall?.[metricKey] === "number") return arm.overall[metricKey];
  if (arm.stats && typeof arm.stats.armMean === "number") return arm.stats.armMean;
  return null;
};

/**
 * Matched design 单因子效应：只统计「除一个逻辑旋钮外其余旋钮全同」的档位对。
 * 每个 level 的 meanDelta = 该 level 相对「配对里另一侧」的平均主指标差（正 = 更好），
 * 因此是「在其它结构相同的前提下，换到这一档的估计收益」。
 *
 * 注意：这是**观测矩阵内的边际效应**，不是因果拟合；配对数量 pairs 一并返回，
 * n 很小的时候调用方必须降级表述（CLI 会标 n<2 仅供参考）。
 */
export function singleKnobEffects(arms, { metricKey = "turnCov@5" } = {}) {
  const out = new Map(KNOB_ORDER.map((k) => [k, { knob: k, pairs: 0, levels: new Map() }]));
  const matched = [];
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const a = arms[i], b = arms[j];
      const diff = knobDiff(a.knobs, b.knobs);
      if (diff.length !== 1) continue;
      const knob = diff[0];
      const va = armMetric(a, metricKey), vb = armMetric(b, metricKey);
      if (va == null || vb == null) continue;
      const delta = vb - va; // b - a
      const rec = out.get(knob);
      rec.pairs++;
      matched.push({ knob, from: a.tag, to: b.tag, fromLevel: a.knobs[knob], toLevel: b.knobs[knob], delta });
      for (const [arm, sign] of [[a, -1], [b, 1]]) {
        const key = String(arm.knobs[knob]);
        if (!rec.levels.has(key)) rec.levels.set(key, { value: arm.knobs[knob], n: 0, sum: 0, tags: [] });
        const L = rec.levels.get(key);
        L.n++;
        L.sum += sign * delta;
        L.tags.push(arm.tag);
      }
    }
  }
  const effects = [];
  for (const { knob, pairs, levels } of out.values()) {
    if (!pairs) continue;
    effects.push({
      knob,
      pairs,
      levels: [...levels.values()]
        .map((L) => ({ value: L.value, n: L.n, meanDelta: L.sum / L.n, tags: L.tags }))
        .sort((x, y) => y.meanDelta - x.meanDelta),
    });
  }
  return { effects };
}

/**
 * 在已跑矩阵内做坐标搜索：从当前最优档出发，逐旋钮看「matched 效应」是否指向另一个
 * 已观测 level。只返回**已观测**的 level（可直接重跑验证），不预测没跑过的组合。
 *
 * rerank.enabled 是结构性开关，永远不作为坐标移动：它的 matched 效应会被剪枝档位分布
 * 混杂（见 diagnoseStructure），放进 ignored 里显式说明。
 */
export function coordinateSearch(arms, { effects, metricKey = "turnCov@5" } = {}) {
  const eff = effects ?? singleKnobEffects(arms, { metricKey }).effects;
  let best = null;
  for (const a of arms) {
    const m = armMetric(a, metricKey);
    if (m == null) continue;
    if (!best || m > best.metric) best = { arm: a, metric: m };
  }
  if (!best) return { best: null, bestMetric: 0, moves: [], ignored: [], converged: true };
  const moves = [];
  const ignored = [];
  for (const e of eff) {
    if (e.pairs < 2) continue; // 单对证据不足，交给采样计划
    if (e.knob === "rerank.enabled") {
      ignored.push({
        knob: e.knob,
        reason: "结构性开关不做坐标移动；off 的 matched 优势来自剪枝档位分布，先调 blend/candidates/minScore",
      });
      continue;
    }
    const current = e.levels.find((L) => L.value === best.arm.knobs[e.knob]);
    const better = e.levels.find(
      (L) => L.value !== best.arm.knobs[e.knob] && L.meanDelta > (current?.meanDelta ?? 0) + 0.001,
    );
    if (!better) continue;
    // level 被观测过，不代表「这个 level × 当前结构」这个组合被观测过
    const proposed = { ...best.arm.knobs, [e.knob]: better.value };
    const observed = arms.some((a) => KNOB_ORDER.every((k) => a.knobs[k] === proposed[k]));
    moves.push({
      knob: e.knob,
      from: best.arm.knobs[e.knob],
      to: better.value,
      estimate: better.meanDelta - (current?.meanDelta ?? 0),
      evidence: [...new Set(better.tags)],
      pairs: e.pairs,
      observed,
    });
  }
  moves.sort((x, y) => y.estimate - x.estimate);
  return { best: best.arm, bestMetric: best.metric, moves, ignored };
}

/**
 * 结构诊断：按 matched 证据把「零效应 / 剪枝 / 主序」三类根因说清楚。
 * 文本只描述数据支持的事；样本不足时显式说「证据不足」。
 */
export function diagnoseStructure(arms, { effects, best, metricKey = "turnCov@5" } = {}) {
  const eff = effects ?? singleKnobEffects(arms, { metricKey }).effects;
  const diag = [];
  const find = (k) => eff.find((e) => e.knob === k);

  // ── 融合：matched 对里模式/权重变化是否改变主指标 ──
  const fusionEff = find("fusion");
  if (fusionEff) {
    const maxAbs = Math.max(...fusionEff.levels.map((L) => Math.abs(L.meanDelta)), 0);
    const weightedLevels = fusionEff.levels.filter((L) => String(L.value).startsWith("weighted"));
    const weightedMax = weightedLevels.length ? Math.max(...weightedLevels.map((L) => Math.abs(L.meanDelta))) : null;
    const normalized = fusionEff.levels.find((L) => String(L.value).startsWith("normalized"));
    if (weightedMax != null && weightedMax < 0.01) {
      diag.push({
        code: "fusion-null-effect",
        severity: "warn",
        text: "matched 证据：weighted 档相对 rrf/其它融合配置最大 |Δ|=" + (weightedMax * 100).toFixed(2) + "pp（<1pp），" + fusionEff.pairs + " 对 → **在本矩阵内**，RRF 主序下加性权重观测不到效应（不是「已被证明不存在」，是当前档位分布下不可辨识）。继续在本矩阵上网格搜索权重没有信息量；应把时间/有效性/通道分放进**通道内打分**（recall.fusion.mode=\"normalized\"，见 #137），RRF 只保留名次融合+去重，然后再拟合通道权重。" +
          (normalized ? "已有 normalized 档的 matched 收益 " + (normalized.meanDelta * 100).toFixed(2) + "pp（n=" + normalized.n + "），说明结构改完后信号才可观测。" : ""),
      });
    } else {
      diag.push({
        code: "fusion-effect-observed",
        severity: "info",
        text: "matched 证据：融合配置变化最大 |Δ|=" + (maxAbs * 100).toFixed(2) + "pp，说明当前结构下权重**可观测**；可以继续坐标搜索。" +
          (normalized ? "normalized 档平均 " + (normalized.meanDelta * 100).toFixed(2) + "pp（n=" + normalized.n + "）。" : ""),
      });
    }
  } else {
    diag.push({
      code: "fusion-evidence-missing",
      severity: "info",
      text: "矩阵里没有只差 fusion 旋钮的 matched 对（或都缺 fusion override）→ 无法判断权重是否有效，先补一组同结构的 rrf vs weighted/normalized 对照。",
    });
  }

  // ── rerank：off 是否只是因为默认剪枝档太紧 ──
  const toggle = find("rerank.enabled");
  const offBest = arms
    .filter((a) => !a.knobs["rerank.enabled"])
    .reduce((acc, a) => Math.max(acc, armMetric(a, metricKey) ?? -1), -1);
  const onArms = arms.filter((a) => a.knobs["rerank.enabled"]);
  const onBest = onArms.reduce((acc, a) => Math.max(acc, armMetric(a, metricKey) ?? -1), -1);
  if (toggle && offBest >= 0 && onBest >= 0) {
    const offMatched = toggle.levels.find((L) => L.value === false)?.meanDelta ?? 0;
    const fixedArms = onArms.filter(
      (a) => a.knobs["rerank.candidates"] > B0BASE_RERANK.candidates || a.knobs["rerank.blend"] > 0,
    );
    const fixedBest = fixedArms.reduce((acc, a) => Math.max(acc, armMetric(a, metricKey) ?? -1), -1);
    const offBetterMatched = offMatched > 0.01;
    const onWinsOverall = onBest >= offBest;
    diag.push({
      code: offBetterMatched
        ? onWinsOverall
          ? "rerank-toggle-confounded"
          : fixedBest >= offBest
            ? "rerank-off-confounded"
            : "rerank-pruning-gap"
        : "rerank-net-positive",
      severity: offBetterMatched && !onWinsOverall && fixedBest < offBest ? "warn" : "info",
      text: offBetterMatched
        ? "matched 证据：rerank=off 平均 " + (offMatched * 100).toFixed(2) + "pp（" + toggle.pairs + " 对），但 on 的最好档 " + (onBest * 100).toFixed(1) + "% vs off 最好档 " + (offBest * 100).toFixed(1) + "%" +
          (fixedBest >= 0 ? "（深池/blend 修复档 " + (fixedBest * 100).toFixed(1) + "%）" : "") + "。" +
          (onWinsOverall
            ? "按**最好档**看 rerank=on 更高 → off 的 matched 优势是「剪枝档位分布」的混杂（浅池/negative floor 与 off 混在一起比），不是重排本身。不要把「关闭 rerank」当结论；下一步在 on 上继续调 blend/candidates/minScore（#137-F）。"
            : fixedBest >= offBest
              ? "深池/blend 修复档已追平/反超 off → off 的优势来自默认剪枝档（candidates=12/floor=-2），不是重排本身。不要把「关闭 rerank」当结论；下一步在 on 上继续调 blend/candidates/minScore（#137-F）。"
              : "差距仍在，但机制是剪枝饿死窗口 + 主序被整体替换，不是「rerank 无效」。下一步优先 blend / candidates / floor 校准与分数校准，**不以关闭 rerank 作为验收方案**。")
        : "rerank=on 最好档 " + (onBest * 100).toFixed(1) + "% ≥ off 最好档 " + (offBest * 100).toFixed(1) + "% → 当前结构下重排是净正/中性；不需要用关闭开关来换收益。",
    });
  }

  if (best) {
    diag.push({
      code: "best-observed",
      severity: "info",
      text: "矩阵内最优 = " + best.tag + "（" + knobsSummary(best.knobs) + "），绝对主指标 " + ((armMetric(best, metricKey) ?? 0) * 100).toFixed(1) + "%。",
    });
  }
  return diag;
}

const NEIGHBORS = {
  "rerank.blend": [0, 0.3, 0.5, 0.7, 0.9, 1],
  "rerank.candidates": [12, 16, 24, 32, 48, 64],
  "rerank.minScore": [-2, -4, -6, -7, -8, -10.5, -12, -14],
  "recall.candidateK": [15, 24, 32, 48, 64],
};

/**
 * 下一步采样计划：以当前最优档为锚，每个旋钮取「没跑过但离当前值最近」的邻域档位。
 * 明确标注**必须重跑**——报告里没有候选级分数，离线无法评估未跑组合。
 */
export function samplingPlan(arms, best, { diagnosis = [], moves = [] } = {}) {
  if (!best) return [];
  const sampled = new Set(arms.map((a) => KNOB_ORDER.map((k) => k + "=" + String(a.knobs[k])).join("|")));
  const has = (knobs) => sampled.has(KNOB_ORDER.map((k) => k + "=" + String(knobs[k])).join("|"));
  const plan = [];
  const push = (knob, value, rationale) => {
    const knobs = { ...best.knobs, [knob]: value };
    if (has(knobs)) return;
    const tag = best.tag + "~" + knob.replace(/^rerank\.|^recall\./, "") + "=" + value;
    plan.push({ tag, baseTag: best.tag, knob, from: best.knobs[knob], to: value, changes: { [knob]: value }, rationale });
  };
  const nearest = (knob, value) =>
    (NEIGHBORS[knob] ?? []).filter((v) => v !== value).sort((x, y) => Math.abs(x - value) - Math.abs(y - value));

  // 坐标搜索指向的 level 可能在别的结构里观测过，但「该 level × 当前结构」这个组合
  // 往往没跑过——这种必须进采样计划重跑，不能当成免费移动。
  for (const m of moves.filter((x) => !x.observed)) {
    const knobs = { ...best.knobs, [m.knob]: m.to };
    if (has(knobs)) continue;
    plan.push({
      tag: best.tag + "~" + m.knob.replace(/^rerank\.|^recall\./, "") + "=" + m.to,
      baseTag: best.tag,
      knob: m.knob,
      from: m.from,
      to: m.to,
      changes: { [m.knob]: m.to },
      rationale: "坐标搜索指向的 level（matched " + m.pairs + " 对，预计 " + (m.estimate >= 0 ? "+" : "") + (m.estimate * 100).toFixed(2) + "pp），但该组合未跑过，必须重跑验证",
    });
  }

  if (best.knobs["rerank.enabled"]) {
    for (const [knob, why] of [
      ["rerank.blend", "混合比例：在「融合序」与「精排分」之间找拐点（#137-F α=0.9 只是起点）"],
      ["rerank.candidates", "深池：候选池越浅，剪枝越容易把证据剪光（#135 §10.3）"],
      ["rerank.minScore", "floor 校准：logit 刻度下的阈值，补位机制之外仍影响尾部"],
    ]) {
      for (const v of nearest(knob, best.knobs[knob]).slice(0, 2)) push(knob, v, why);
    }
    if (best.knobs["rerank.mode"] === "rerank" && !arms.some((a) => a.knobs["rerank.mode"] === "filter")) {
      push("rerank.mode", "filter", "安全降级档：只按 floor 过滤、保留融合序（#135 R4），用于确认「重排 vs 过滤」的净差");
    }
  } else {
    // 最优档恰好是 off：样本里没有可比的 on 档，先补 on 的缺省/深池两档
    push("rerank.enabled", true, "补 rerank=on 的对照（缺省剪枝档），避免「off 最优」缺基线");
  }
  for (const v of nearest("recall.candidateK", best.knobs["recall.candidateK"]).slice(0, 2)) {
    push("recall.candidateK", v, "上游候选池：影响两通道进融合的行数（#135 R1）");
  }

  // 融合：零效应时不再扫加性权重，直接补 normalized 结构档
  const nullFusion = diagnosis.some((d) => d.code === "fusion-null-effect");
  if (nullFusion) {
    for (const s of [
      { dense: 0.5, bm25: 0.2, fact: 0.3 },
      { dense: 0.4, bm25: 0.3, fact: 0.3 },
    ]) {
      const label = "normalized(d" + s.dense + "/b" + s.bm25 + "/f" + s.fact + ")";
      const knobs = { ...best.knobs, fusion: label };
      if (has(knobs)) continue;
      plan.push({
        tag: best.tag + "~fusion=" + label,
        baseTag: best.tag,
        knob: "fusion",
        from: best.knobs.fusion,
        to: label,
        changes: { fusion: label },
        rationale: "结构优先：通道内归一化后才谈「拟合权重」（#137 / #142 结论）",
      });
    }
  }
  const seen = new Set();
  return plan.filter((p) => (seen.has(p.tag) ? false : (seen.add(p.tag), true)));
}
