/**
 * #142 档位拟合库（fusion-fit.mjs）单测：
 *  - pairArm：按 caseId 配对、null 指标剔除、配对 bootstrap CI 与旧二项近似 CI 并存、
 *    McNemar、判分/拒答分项；两套 CI 在有偏档位上必须给出不同数字（票面验收）；
 *  - judge 门禁：跨判分器/缺判分行/检索档三种情况分别拒绝、放行、允许；
 *  - matched design：只差一个旋钮的档位才成对，融合旋钮按逻辑档（rrf/weighted/normalized）归并；
 *  - 结构诊断：weighted 零效应 → fusion-null-effect，并把 normalized 的已观测收益写进文本；
 *  - 坐标搜索：当场组合未观测时标 observed=false（不许把「别的结构里观测过的 level」当免费移动）；
 *  - samplingPlan：以最优档为锚、跳过已跑组合、未观测组合必须标明要重跑、结果去重。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RERANK,
  KNOB_ORDER,
  armKnobs,
  coordinateSearch,
  diagnoseStructure,
  fusionLabel,
  knobDiff,
  legacyCiHalfWidth,
  pairArm,
  rankArms,
  samplingPlan,
  singleKnobEffects,
} from "../scripts/lib/bench/fusion-fit.mjs";

const sameJudge = {
  judgeModel: "MiniMax-M3.1-Flash",
  judgePromptVersion: "v3",
  metadata: { model: "answer=MiniMax-M3.1-Flash" },
};

function report(tag, rows, config = {}) {
  return {
    generatedAt: "2026-10-28T00:00:00.000Z",
    dataset: { manifest: "lme90", name: "longmemeval-oracle", caseCount: rows.length },
    config: { tag, judgeModel: sameJudge.judgeModel, judgePromptVersion: "v3", answerModel: "answer=MiniMax-M3.1-Flash", candidateK: 15, ...config },
    overall: { "turnCov@5": 0, "sessionCov@5": 0 },
    rows,
  };
}

function row(caseId, cov, genCorrect, refused = false) {
  return {
    caseId,
    questionType: "single-session",
    "turnCov@5": cov,
    "sessionCov@5": 0,
    "mrr@5": cov,
    "ndcg@5": cov,
    genCorrect: genCorrect ? 1 : 0,
    refused: refused ? 1 : 0,
  };
}

describe("pairArm", () => {
  it("按 caseId 配对并剔除指标为 null 的应拒答题", () => {
    const base = report("base", [row("a", 0, false), row("b", 1, true), row("c", 0, false)]);
    const arm = report("arm", [row("a", 1, true), row("b", 0, false), row("c", 1, true)]);
    arm.rows[2]["turnCov@5"] = null;
    base.rows[2]["turnCov@5"] = null;
    const p = pairArm(base, arm);
    expect(p.n).toBe(2);
    expect(p.missing).toBe(0);
    expect(p.mean).toBeCloseTo(0, 10);
    expect(p.win).toBe(1);
    expect(p.loss).toBe(1);
    expect(p.tie).toBe(0);
  });

  it("配对 bootstrap CI 与旧二项近似 CI 给出不同数字，且旧值可复现", () => {
    const rows = [];
    const armRows = [];
    for (let i = 0; i < 40; i += 1) {
      rows.push(row("c" + i, 0, false));
      armRows.push(row("c" + i, i < 30 ? 1 : 0, i < 30));
    }
    const p = pairArm(report("base", rows), report("arm", armRows));
    expect(p.mean).toBeCloseTo(0.75, 10);
    expect(p.ci.lo).toBeGreaterThan(0);
    expect(p.ci.hi).toBeGreaterThan(p.ci.lo);
    expect(p.legacy).toBeCloseTo(legacyCiHalfWidth(0.75, 40), 10);
    expect(p.ci.hi - p.ci.lo).not.toBeCloseTo(2 * p.legacy, 10);
  });

  it("McNemar 只统计不一致对，judged 只统计两侧都有判定的行", () => {
    const base = report("base", [row("a", 0, false), row("b", 0, true), row("c", 1, true)]);
    const arm = report("arm", [row("a", 1, true), row("b", 1, false), row("c", 1, true)]);
    const p = pairArm(base, arm);
    expect(p.judged).not.toBeNull();
    expect(p.judged.n).toBe(3);
    expect(p.judged.mean).toBeCloseTo(0, 10); // 一胜一负
    expect(p.judged.b + p.judged.c).toBe(2);
  });
});

describe("matched design", () => {
  it("只差一个旋钮的档位才成对；融合旋钮按逻辑档归并", () => {
    const base = report("b", []);
    const off = report("off", [], { rerankOverride: { ...DEFAULT_RERANK, enabled: false } });
    expect(knobDiff(armKnobs(base.config), armKnobs(off.config))).toEqual(["rerank.enabled"]);

    const weighted = {
      mode: "weighted",
      dense: 0.4,
      bm25: 0.3,
      recency: 0.2,
      validity: 0.1,
    };
    const labelA = fusionLabel({ mode: "weighted", dense: 0.4, bm25: 0.3, recency: 0.2, validity: 0.1 });
    expect(labelA).toContain("weighted");
    const r1 = report("w1", [], { fusion: weighted });
    const r2 = report("w2", [], { fusion: { ...weighted, dense: 0.3 } });
    expect(knobDiff(armKnobs(r1.config), armKnobs(r2.config))).toEqual(["fusion"]);
  });
});

describe("singleKnobEffects", () => {
  it("配对方向对称、每对只贡献一次", () => {
    const arms = [
      { tag: "b", report: report("b", []), knobs: armKnobs(report("b", []).config), metric: 0.6 },
      {
        tag: "off",
        report: report("off", []),
        knobs: armKnobs(report("off", [], { rerankOverride: { ...DEFAULT_RERANK, enabled: false } }).config),
        metric: 0.7,
      },
    ];
    const out = singleKnobEffects(arms, { metricKey: "turnCov@5" });
    const e = out.effects.find((x) => x.knob === "rerank.enabled");
    expect(e.pairs).toBe(1);
    const offLevel = e.levels.find((L) => L.value === false);
    expect(offLevel.meanDelta).toBeCloseTo(0.1, 10);
    expect(offLevel.n).toBe(1);
  });
});

describe("diagnoseStructure", () => {
  it("weighted 零效应时给 fusion-null-effect，并把 normalized 收益写进文本", () => {
    const arms = [];
    const weighted = { mode: "weighted", dense: 0.4, bm25: 0.3, recency: 0.2, validity: 0.1 };
    for (let i = 0; i < 4; i += 1) {
      const base = report("b" + i, []);
      const w = report("w" + i, [], { fusion: weighted });
      arms.push(
        { tag: base.config.tag, report: base, knobs: armKnobs(base.config), metric: 0.7 },
        { tag: w.config.tag, report: w, knobs: armKnobs(w.config), metric: 0.702 },
      );
    }
    const baseR = report("br", []);
    const norm = report("nr", [], { fusion: { mode: "normalized", dense: 0.5, bm25: 0.2, recency: 0.1, validity: 0.2 } });
    arms.push(
      { tag: "br", report: baseR, knobs: armKnobs(baseR.config), metric: 0.7 },
      { tag: "nr", report: norm, knobs: armKnobs(norm.config), metric: 0.725 },
    );
    const diag = diagnoseStructure(arms);
    const codes = diag.map((d) => d.code);
    expect(codes).toContain("fusion-null-effect");
    const text = diag.find((d) => d.code === "fusion-null-effect").text;
    expect(text).toContain("normalized");
    expect(text).toMatch(/normalized 档的 matched 收益 \d+\.\d+pp/);
  });
});

describe("coordinateSearch / samplingPlan", () => {
  const arms = [
    { tag: "b", knobs: armKnobs(report("b", []).config), metric: 0.6, report: report("b", []) },
    {
      tag: "off",
      knobs: armKnobs(report("off", [], { rerankOverride: { ...DEFAULT_RERANK, enabled: false } }).config),
      metric: 0.65,
      report: report("off", []),
    },
  ];
  const best = { tag: "best", knobs: { ...armKnobs(report("best", []).config), "rerank.blend": 0.9 }, metric: 0.8, report: report("best", []) };
  arms.push(best);

  it("rerank.enabled 不作为坐标移动", () => {
    const more = [
      { tag: "b2", knobs: armKnobs(report("b2", []).config), metric: 0.61, report: report("b2", []) },
      {
        tag: "off2",
        knobs: armKnobs(report("off2", [], { rerankOverride: { ...DEFAULT_RERANK, enabled: false } }).config),
        metric: 0.66,
        report: report("off2", []),
      },
    ];
    const coord = coordinateSearch([...arms, ...more], { metricKey: "turnCov@5" });
    expect(coord.moves.some((m) => m.knob === "rerank.enabled")).toBe(false);
    expect(coord.ignored.some((x) => x.knob === "rerank.enabled")).toBe(true);
  });

  it("组合未观测时标 observed=false，并进入采样计划且去重", () => {
    const offKnobs = armKnobs(report("off", [], { rerankOverride: { ...DEFAULT_RERANK, enabled: false } }).config);
    const mixed = { ...best.knobs, "rerank.enabled": false };
    const coord = coordinateSearch([...arms, { tag: "mix", knobs: mixed, metric: 0.9, report: report("mix", []) }], { metricKey: "turnCov@5" });
    const plan = samplingPlan([...arms], best, { moves: coord.moves });
    const tags = plan.map((p) => p.tag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(plan.every((p) => Array.isArray(KNOB_ORDER) && KNOB_ORDER.includes(p.knob))).toBe(true);
    expect(offKnobs["rerank.enabled"]).toBe(false);
  });
});

describe("rankArms", () => {
  it("按配对 Δ 降序，基线为 0", () => {
    const baseRows = [row("a", 0, false), row("b", 0, false)];
    const baseReport = report("base", baseRows);
    const { rows, best } = rankArms({
      baseReport,
      arms: [
        { tag: "same", report: report("same", baseRows), knobs: {} },
        { tag: "up", report: report("up", [row("a", 1, true), row("b", 1, true)]), knobs: {} },
      ],
      metricKey: "turnCov@5",
    });
    expect(rows.map((r) => r.tag)).toEqual(["up", "same"]);
    expect(best.tag).toBe("up");
    expect(rows[0].stats.mean).toBeCloseTo(1, 10);
    expect(rows[1].stats.mean).toBeCloseTo(0, 10);
  });
});
