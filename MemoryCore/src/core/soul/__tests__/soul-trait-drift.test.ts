/**
 * S4 单测：漂移纯函数 + 判侧协议解析 + 标签去重（判据 5/6/7 的确定性部分）。
 */
import { describe, expect, it } from "vitest";

import {
  driftTraits,
  parseTraitProtocolOutput,
  resolveLabelProposals,
  seedLabelRows,
  type TraitLabelProposal,
  type TraitVote,
} from "../trait-drift.js";
import {
  SEED_LABELS,
  TRAIT_L1_MAX,
  TRAIT_MAX_STEP,
  cosine,
  emptyAxisVector,
  l1Norm,
  normalizeTraitL1,
  type AxisVector,
} from "../traits.js";

const vote = (axis: TraitVote["axis"], delta: number, episodeId = "ep-new"): TraitVote => ({
  episodeId,
  axis,
  delta,
});

const state = (over: Partial<AxisVector> = {}): AxisVector => ({ ...emptyAxisVector(), ...over });

describe("driftTraits：净票 / 步长 / L1", () => {
  it("|net| < 2 不动（两条同向净票=2 才动）", () => {
    const one = driftTraits(state(), [vote("rigor", 1)]);
    expect(one.state.rigor).toBe(0);
    expect(one.axes.find((a) => a.axis === "rigor")?.reason).toBe("net_below_min");
    const two = driftTraits(state(), [vote("rigor", 1), vote("rigor", 1, "ep-b")]);
    expect(two.state.rigor).toBeCloseTo(0.02 * Math.tanh(2 / 3), 4);
    expect(two.changed).toBe(true);
  });

  it("s = tanh(net/3)，α=0.02：net=3 → +0.0152；反向净票为负", () => {
    const up = driftTraits(state(), [vote("rigor", 1), vote("rigor", 1, "ep-b"), vote("rigor", 1, "ep-c")]);
    expect(up.state.rigor).toBeCloseTo(0.0152, 4);
    const down = driftTraits(state(), [vote("rigor", -1), vote("rigor", -1, "ep-b"), vote("rigor", -1, "ep-c")]);
    expect(down.state.rigor).toBeCloseTo(-0.0152, 4);
  });

  it("单 tick 每轴 |Δ| ≤ 0.05：超限整轴拒绝并记账", () => {
    const res = driftTraits(state(), [vote("rigor", 1), vote("rigor", 1, "ep-b")], { alpha: 0.5, maxStep: 0.05 });
    expect(res.state.rigor).toBe(0);
    expect(res.axes.find((a) => a.axis === "rigor")?.reason).toBe("step_exceeded");
    expect(res.rejected).toBe(1);
  });

  it("Σ|state| ≤ 0.5：超限等比缩放保方向，并标 l1Clamped", () => {
    const start = state({ warmth: 0.4, rigor: 0.2 });
    const res = driftTraits(start, [vote("agency", 1), vote("agency", 1, "ep-b")], { alpha: 0.5, maxStep: 0.05, l1Max: 0.5 });
    const l1 = Object.values(res.state).reduce((s, v) => s + Math.abs(v), 0);
    expect(l1).toBeLessThanOrEqual(0.5001);
    expect(res.l1Clamped).toBe(true);
    // 方向未被清零：原有两轴仍为正
    expect(res.state.warmth).toBeGreaterThan(0);
    expect(res.state.rigor).toBeGreaterThan(0);
  });

  it("G3：只对本轮新增 episode 计票，旧事件票计 rejected", () => {
    const res = driftTraits(state(), [vote("rigor", 1, "ep-old"), vote("rigor", 1, "ep-new")], {
      newEpisodeIds: ["ep-new"],
    });
    expect(res.rejected).toBe(1);
    expect(res.votes).toBe(1);
    expect(res.state.rigor).toBe(0); // 单票净 1 < 2
  });

  it("一票最多两轴：同 episode 第三票被拒", () => {
    const res = driftTraits(state(), [
      vote("warmth", 1, "ep-a"),
      vote("rigor", 1, "ep-a"),
      vote("agency", 1, "ep-a"),
    ]);
    expect(res.rejected).toBe(1);
    expect(res.votes).toBe(2);
  });

  it("非法轴 / 非 ±1 票被丢弃", () => {
    const res = driftTraits(state(), [
      { episodeId: "ep-a", axis: "charisma" as TraitVote["axis"], delta: 1 },
      { episodeId: "ep-b", axis: "rigor", delta: 2 },
    ]);
    expect(res.rejected).toBe(2);
    expect(res.changed).toBe(false);
  });
});

describe("入口 L1 归一（B2：存量超限行不能绕过步长）", () => {
  const over = (): AxisVector => ({ warmth: 0.5, agency: 0.3, rigor: 0.6, openness: 0.2, stability: 0.1, boundary: 0.4 });

  it("超限状态先缩到预算内再走步长：每轴 |Δ| ≤ 0.05，Σ ≤ 0.5，标 l1Clamped", () => {
    const start = over();
    expect(l1Norm(start)).toBeCloseTo(2.1, 6);
    const res = driftTraits(start, [
      vote("rigor", 1, "ep-a"),
      vote("rigor", 1, "ep-b"),
      vote("rigor", 1, "ep-c"),
      vote("warmth", 1, "ep-d"),
      vote("warmth", 1, "ep-e"),
    ]);
    const base = normalizeTraitL1(start);
    expect(cosine(base, start)).toBeCloseTo(1, 6);
    expect(l1Norm(res.state)).toBeLessThanOrEqual(TRAIT_L1_MAX + 1e-9);
    expect(res.l1Clamped).toBe(true);
    expect(res.changed).toBe(true);
    // 位移只来自漂移步长：相对归一起点每轴 ≤ TRAIT_MAX_STEP
    for (const axis of Object.keys(res.state) as Array<keyof AxisVector>) {
      expect(Math.abs(res.state[axis] - base[axis])).toBeLessThanOrEqual(TRAIT_MAX_STEP + 1e-9);
    }
    for (const ax of res.axes) {
      if (ax.delta !== 0) expect(Math.abs(ax.delta)).toBeLessThanOrEqual(TRAIT_MAX_STEP + 1e-9);
    }
  });

  it("合规状态无票：原样返回，changed/l1Clamped 都是 false（归一幂等）", () => {
    const start = state({ warmth: 0.1, rigor: 0.2 });
    const res = driftTraits(start, []);
    expect(res.state).toEqual(start);
    expect(res.changed).toBe(false);
    expect(res.l1Clamped).toBe(false);
    expect(res.votes).toBe(0);
  });
});

describe("parseTraitProtocolOutput：[TRAIT-PROTOCOL v1]", () => {
  it("解析围栏 JSON；坏投票/坏标签计数丢弃，quote≤40、why≤20", () => {
    const raw = [
      "说明文字",
      "\u0060\u0060\u0060json",
      JSON.stringify({
        votes: [
          { episode_id: "ep-1", axis: "rigor", delta: 1, quote: "x".repeat(60), why: "y".repeat(30) },
          { episode_id: "ep-2", axis: "vibes", delta: 1 },
          { episode_id: "bad", axis: "rigor", delta: -1 },
        ],
        label_proposals: [
          { label: "较真", definition: "对细节反复核对", direction: { rigor: 1 }, evidence_ids: ["ep-1", "ep-2"] },
          { label: "", definition: "缺名", direction: { rigor: 1 }, evidence_ids: ["ep-1"] },
        ],
      }),
      "\u0060\u0060\u0060",
    ].join("\n");
    const out = parseTraitProtocolOutput(raw);
    expect(out.votes).toHaveLength(1);
    expect(out.votes[0].quote).toHaveLength(40);
    expect(out.votes[0].why).toHaveLength(20);
    expect(out.labelProposals).toHaveLength(1);
    expect(out.labelProposals[0].direction.rigor).toBeCloseTo(1, 6);
    expect(out.invalid).toBe(3);
  });

  it("非 JSON 输入返回空且 invalid=1", () => {
    expect(parseTraitProtocolOutput("模型跑飞了")).toEqual({ votes: [], labelProposals: [], invalid: 1 });
  });
});

describe("resolveLabelProposals：余弦去重（判据 7）", () => {
  const now = "2026-11-07T12:00:00.000Z";
  const seeds = seedLabelRows(SEED_LABELS, now);
  const proposal = (over: Partial<TraitLabelProposal>): TraitLabelProposal => ({
    label: "较真",
    definition: "对细节反复核对，不肯放过",
    direction: { warmth: 0, agency: 0, rigor: 1, openness: 0, stability: 0, boundary: 0 },
    evidenceIds: ["ep-1", "ep-2", "ep-3"],
    ...over,
  });

  it("与「严谨」余弦 1 → 并入既有标签而不是并排新建", () => {
    const res = resolveLabelProposals([proposal({})], seeds, { now });
    expect(res.admitted).toHaveLength(0);
    expect(res.merged).toHaveLength(1);
    expect(res.merged[0].into).toBe("严谨");
    // 种子「严谨」是归一后的混合方向（rigor .98），余弦 0.982 已过 0.85 门槛
    expect(res.merged[0].similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("方向可区分 → admitted；证据不足 → rejected", () => {
    const res = resolveLabelProposals(
      [
        proposal({ label: "爱笑", direction: { warmth: 1, agency: 0, rigor: 1, openness: 0, stability: 0, boundary: 0 } }),
        proposal({ label: "凑数", evidenceIds: ["ep-1"] }),
      ],
      seeds,
      { now },
    );
    expect(res.admitted.map((r) => r.label)).toEqual(["爱笑"]);
    expect(res.admitted[0].status).toBe("admitted");
    expect(res.admitted[0].protocolVersion).toBe("v1");
    expect(res.rejected).toEqual([{ label: "凑数", reason: "insufficient_evidence" }]);
  });

  it("新标签与刚 admitted 的标签同义 → 第二条并入第一条（不并排）", () => {
    const res = resolveLabelProposals(
      [
        proposal({ label: "爱笑", direction: { warmth: 1, agency: 0, rigor: 1, openness: 0, stability: 0, boundary: 0 } }),
        proposal({ label: "爱乐", direction: { warmth: 1, agency: 0, rigor: 1, openness: 0, stability: 0, boundary: 0 } }),
      ],
      [],
      { now },
    );
    expect(res.admitted.map((r) => r.label)).toEqual(["爱笑"]);
    expect(res.merged).toEqual([{ label: "爱乐", into: "爱笑", similarity: 1 }]);
  });

  // P1-3：proposal 里的可选 gloss 必须落进标签行——库里没有这一份，卡里就永远没有注解。
  it("proposal 带 gloss → 解析后按 40 字截断，并原样落进 admitted 行", () => {
    const raw = JSON.stringify({
      votes: [],
      label_proposals: [
        {
          label: "爱笑",
          definition: "遇到小事也容易先笑出来",
          direction: { warmth: 1, agency: 0, rigor: 1, openness: 0, stability: 0, boundary: 0 },
          evidence_ids: ["ep-1", "ep-2", "ep-3"],
          gloss: "笑".repeat(60),
        },
      ],
    });
    const parsed = parseTraitProtocolOutput(raw);
    expect(parsed.labelProposals[0].gloss).toBe("笑".repeat(40));
    const res = resolveLabelProposals(parsed.labelProposals, seeds, { now });
    expect(res.admitted.map((r) => r.gloss)).toEqual(["笑".repeat(40)]);
  });
});
