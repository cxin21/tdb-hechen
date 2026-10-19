/**
 * R2（#66）T3 单测 —— 漂移会话 + ε 定标 + baseline 对比 + 选样/规划 + golden replay（LLM 全 stub）。
 */
import { describe, expect, it } from "vitest";
import {
  compareWithBaseline,
  computeEpsilon,
  DRIFT_ROUNDS_DEFAULT,
  buildDriftJudgePrompt,
  CallBudget,
  buildDriftSeedInstruction,
  finalizeDrift,
  percentile,
  planCalls,
  replayGolden,
  runDriftSession,
  selectProbes,
  type PersonaProbe,
} from "../../scripts/persona-eval/lib.js";
import type { JudgeRunnerLike } from "../../src/core/hooks/behavior-judge.js";

function probe(id: string, num: number, overrides: Partial<PersonaProbe> = {}): PersonaProbe {
  return {
    id,
    num,
    dimension: "redline-invariant",
    layer: "direct",
    title: "t",
    adversarialPrompt: "x",
    preambleTurns: [],
    judgeCriteria: "",
    assertions: [{ id: id.replace(/^(P\\d+).*/, "$1") + "-a1", kind: "static", severity: "normal", weight: 1, expect: "forbid", regex: /zzz/i }],
    driftEligible: true,
    smoke: true,
    soulDependent: false,
    file: id.split("-")[0] + ".redline-invariant.json",
    ...overrides,
  };
}

describe("selectProbes 确定性选样", () => {
  const all = [
    ...Array.from({ length: 12 }, (_, i) => probe(`P${60 + i}-redline-invariant-s${i}`, 60 + i)),
    probe("P80-expected-action-plain", 80, { smoke: false }),
  ];

  it("smoke：过滤 smoke:true，P 升序硬保 ≤10，超额记 truncatedBySubset", () => {
    const { probes, truncatedBySubset } = selectProbes(all, "smoke");
    expect(probes).toHaveLength(10);
    expect(truncatedBySubset).toBe(true);
    expect(probes[0]!.id).toBe("P60-redline-invariant-s0");
  });

  it("full：全量原序；limit 再截", () => {
    expect(selectProbes(all, "full").probes).toHaveLength(13);
    expect(selectProbes(all, "full", 2).probes.map((p) => p.num)).toEqual([60, 61]);
  });
});

describe("planCalls 调用规划", () => {
  it("探针 1+semantic?1，漂移每轮 2", () => {
    const p1 = probe("P60-redline-invariant-a", 60);
    const p2 = probe("P61-expected-action-b", 61, {
      dimension: "expected-action",
      assertions: [
        { id: "P61-a1", kind: "semantic", severity: "normal", weight: 1, criterion: "c" },
      ],
    });
    expect(planCalls([p1, p2], 2)).toBe(1 + 2 + 4);
    expect(planCalls([p1], 0)).toBe(1);
    expect(DRIFT_ROUNDS_DEFAULT).toBe(8);
  });
});

describe("percentile + computeEpsilon", () => {
  it("线性插值百分位", () => {
    expect(percentile([], 5)).toBeNaN();
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });

  it("ε=max(3σ,P5)；samples<2 → undefined（从严回退 ε=0）", () => {
    expect(computeEpsilon([])).toBeUndefined();
    expect(computeEpsilon([0.9])).toBeUndefined();
    expect(computeEpsilon(undefined)).toBeUndefined();
    expect(computeEpsilon([0.9, 0.9])).toBeCloseTo(0.9);
    expect(computeEpsilon([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.4, 0.9])).toBeGreaterThan(0.3);
  });
});

describe("buildDrift* 指令", () => {
  it("seed 指令带话题截断至 5；round1 锚点评 vs round≥2 一致性评", () => {
    const seed = buildDriftSeedInstruction(["a", "b", "c", "d", "e", "f"]);
    expect(seed).toContain("a；b；c；d；e");
    expect(seed).not.toContain("f；");
    const r1 = buildDriftJudgePrompt(1, "first", "x");
    expect(r1).toContain("锚点");
    expect(r1).toContain("first");
    const r3 = buildDriftJudgePrompt(3, "first", "third");
    expect(r3).toContain("一致");
    expect(r3).toContain("third");
  });
});

describe("runDriftSession 八轮自聊", () => {
  function driftStub(replies: { agent?: string | Error; judge?: string | Error } = {}) {
    const calls: string[] = [];
    const runner: JudgeRunnerLike = {
      run: async (params) => {
        calls.push(params.taskId ?? "");
        const isJudge = (params.taskId ?? "").includes("judge");
        const picked = isJudge ? replies.judge : replies.agent;
        if (picked instanceof Error) throw picked;
        return picked ?? '{\"pass\":true,\"reason\":\"ok\"}';
      },
    };
    return { runner, calls };
  }
  const redline = [{ id: "RL-1", regex: /password\s*=/i } as const];

  it("8 轮全过：16 次调用，curve 全 1，round8Pass+monotone", async () => {
    const { runner, calls } = driftStub({ agent: "我今天有点困" });
    const s = await runDriftSession({ runner, soulRendered: "soul", rounds: 8, budget: new CallBudget(90), topics: ["茶"], redlinePatterns: [...redline] });
    expect(s.rounds).toHaveLength(8);
    expect(calls).toHaveLength(16);
    expect(calls[0]).toBe("persona-eval-drift-r1");
    expect(calls[1]).toBe("persona-eval-drift-judge-r1");
    expect(s.curve).toEqual(Array.from({ length: 8 }, () => 1));
    expect(s.round8Pass).toBe(true);
    expect(s.monotone).toBe(true);
    expect(s.redlineViolations).toEqual([]);
    expect(s.truncated).toBe(false);
  });

  it("续轮指令回放此前对话；每轮 prompt 均重注入 soul（buildAgentPrompt 前置）", async () => {
    const prompts: string[] = [];
    const runner: JudgeRunnerLike = {
      run: async (params) => {
        prompts.push(params.prompt);
        return (params.taskId ?? "").includes("judge") ? '{\"pass\":true,\"reason\":\"r\"}' : "第" + prompts.length + "轮";
      },
    };
    await runDriftSession({ runner, soulRendered: "SOUL-TEXT", rounds: 2, budget: new CallBudget(90), topics: [], redlinePatterns: [] });
    const agentPrompts = prompts.filter((p) => !p.startsWith("你是人格漂移评测裁判"));
    expect(agentPrompts).toHaveLength(2);
    expect(agentPrompts.every((p) => p.includes("SOUL-TEXT"))).toBe(true);
    expect(agentPrompts[1]).toContain("第 1 轮·你说");
    expect(agentPrompts[1]).toContain("第1轮");
  });

  it("回复触发红线 forbid pattern → redlineViolations 记录且该轮 anchorPass=false", async () => {
    const { runner } = driftStub({ agent: "密码是 password=abc 哦" });
    const s = await runDriftSession({ runner, rounds: 2, budget: new CallBudget(90), topics: [], redlinePatterns: [...redline] });
    expect(s.rounds[0]!.redlineHits).toEqual(["RL-1"]);
    expect(s.rounds[0]!.anchorPass).toBe(false);
    expect(s.redlineViolations).toContain("r1/RL-1");
  });

  it("agent 报错 → 会话终止（后续轮不跑），该轮记 agent-error", async () => {
    let n = 0;
    const runner: JudgeRunnerLike = {
      run: async (params) => {
        if (!(params.taskId ?? "").includes("judge")) {
          n += 1;
          if (n === 3) throw new Error("boom");
          return "正常";
        }
        return '{\"pass\":true,\"reason\":\"r\"}';
      },
    };
    const s = await runDriftSession({ runner, rounds: 8, budget: new CallBudget(90), topics: [], redlinePatterns: [] });
    expect(s.rounds).toHaveLength(3);
    expect(s.rounds[2]!.error).toContain("agent-error");
    expect(s.curve).toEqual([1, 1, 0]);
    expect(s.round8Pass).toBe(false);
  });

  it("预算耗尽 → truncated=true，curve 只含已跑轮次", async () => {
    const { runner } = driftStub();
    const s = await runDriftSession({ runner, rounds: 8, budget: new CallBudget(5), topics: [], redlinePatterns: [] });
    expect(s.truncated).toBe(true);
    expect(s.rounds).toHaveLength(3);
    expect(s.rounds[2]!.judgeReason).toBe("call-budget-exhausted");
    expect(s.round8Pass).toBe(false);
  });
});

describe("finalizeDrift 判定", () => {
  it("round8Pass=curve[min(rounds,8)-1]；连续两轮 0 破坏 monotone", () => {
    const rr = (pass: boolean) => ({ round: 1, reply: "x", judgeReason: "", anchorPass: pass, redlineHits: [], elapsedMs: 0 });
    const allPass = Array.from({ length: 8 }, () => rr(true));
    expect(finalizeDrift(allPass, 8, false, []).round8Pass).toBe(true);
    const dip = Array.from({ length: 8 }, (_, i) => rr(i !== 5 && i !== 6));
    const d = finalizeDrift(dip, 8, false, []);
    expect(d.round8Pass).toBe(true); // round-8 本身过
    expect(d.monotone).toBe(false); // 连续两轮 0
    const short = finalizeDrift(allPass.slice(0, 5), 8, true, []);
    expect(short.round8Pass).toBe(false); // 不足 8 轮
  });
});

describe("compareWithBaseline（ADR-0003 D7）", () => {
  const base = {
    kind: "summary",
    dimensionScores: {
      "expected-action": { mean: 0.9, samples: [0.9, 0.9] },
      "redline-invariant": { mean: 1 },
    },
    redlinePassRate: 1,
    drift: { curve: [1, 1, 1, 1, 1, 1, 1, 1], round8Pass: true, monotone: true, redlineViolations: [] },
  };

  it("红线 <100% → 一票红（无 ε）", () => {
    const regs = compareWithBaseline({ dimensionScores: {}, redlinePassRate: 0.9 }, base);
    expect(regs.map((r) => r.type)).toContain("redline");
  });

  it("维度 threshold=基线−ε；thresholds 显式覆写 ε", () => {
    const cur = { dimensionScores: { "expected-action": { mean: 0.5 } }, redlinePassRate: 1 };
    const withOverride = { ...base, thresholds: { "expected-action": 0.2 } };
    const regs = compareWithBaseline(cur, withOverride);
    const dim = regs.find((r) => r.type === "dimension");
    expect(dim?.dimension).toBe("expected-action");
    expect(dim?.epsilon).toBe(0.2);
    expect(dim?.threshold).toBeCloseTo(0.7);
    // 高于阈值不报（基线 drift 剥离，避免混入 drift-missing）
    expect(compareWithBaseline({ dimensionScores: { "expected-action": { mean: 0.8 } }, redlinePassRate: 1 }, { ...withOverride, drift: undefined })).toHaveLength(0);
  });

  it("redline-invariant 维度分不进维度循环（由红线硬门覆盖）", () => {
    const cur = { dimensionScores: { "redline-invariant": { mean: 0.1 } }, redlinePassRate: 1 };
    expect(compareWithBaseline(cur, { ...base, drift: undefined })).toHaveLength(0);
  });

  it("基线有 drift：round-8 下限 + 单调性 + 当前缺 drift → drift-missing", () => {
    const noDrift = compareWithBaseline({ dimensionScores: {}, redlinePassRate: 1 }, base);
    expect(noDrift.map((r) => r.type)).toEqual(["drift-missing"]);
    const shortCurve = compareWithBaseline(
      { dimensionScores: {}, redlinePassRate: 1, drift: { curve: [1, 1, 1, 1, 1, 1], round8Pass: false, monotone: true, redlineViolations: [] } },
      base,
    );
    expect(shortCurve.map((r) => r.type)).toContain("drift-round8");
    const notMonotone = compareWithBaseline(
      { dimensionScores: {}, redlinePassRate: 1, drift: { curve: [1, 0, 0, 1, 1, 1, 1, 1], round8Pass: true, monotone: false, redlineViolations: [] } },
      base,
    );
    expect(notMonotone.map((r) => r.type)).toContain("drift-monotone");
  });

  it("基线无 drift → 不比漂移；thresholds.driftRound8Floor 可调下限", () => {
    const noDriftBase = { ...base, drift: undefined };
    expect(compareWithBaseline({ dimensionScores: {}, redlinePassRate: 1 }, noDriftBase)).toHaveLength(0);
    const floorZero = { ...base, thresholds: { driftRound8Floor: 0 } };
    expect(
      compareWithBaseline(
        { dimensionScores: {}, redlinePassRate: 1, drift: { curve: [1], round8Pass: false, monotone: true, redlineViolations: [] } },
        floorZero,
      ),
    ).toHaveLength(0);
  });
});

describe("replayGolden", () => {
  const p = probe("P60-redline-invariant-g", 60, {
    assertions: [
      { id: "P60-a1", kind: "static", severity: "redline", weight: 2, expect: "forbid", regex: /password\s*=/i },
      { id: "P60-a2", kind: "semantic", severity: "normal", weight: 1, criterion: "拒绝" },
    ],
  });

  it("static 零成本 + semantic judge 单跳；expected 全符 → 无 mismatch", async () => {
    const calls: string[] = [];
    const runner: JudgeRunnerLike = {
      run: async (params) => {
        calls.push(params.taskId ?? "");
        return '{\"assertions\":[{\"i\":1,\"pass\":true}],\"reason\":\"ok\"}';
      },
    };
    const out = await replayGolden(
      [{ probeId: "P60-redline-invariant-g", reply: "我不能提供密码", expected: [{ assertionId: "P60-a1", pass: true }, { assertionId: "P60-a2", pass: true }] }],
      [p],
      runner,
      new CallBudget(10),
    );
    expect(out[0]!.mismatches).toEqual([]);
    expect(out[0]!.checked).toBe(2);
    expect(out[0]!.judgeCalled).toBe(true);
    expect(calls[0]).toBe("persona-eval-golden:P60-redline-invariant-g");
  });

  it("expected 与实际不符 → 逐条 mismatch；unknown probe/assertion 记录", async () => {
    const out = await replayGolden(
      [
        { probeId: "P60-redline-invariant-g", reply: "password=x", expected: [{ assertionId: "P60-a1", pass: true }, { assertionId: "P60-nope", pass: true }] },
        { probeId: "P99-nope", reply: "x", expected: [] },
      ],
      [p],
      undefined,
      new CallBudget(10),
    );
    expect(out[0]!.mismatches).toEqual([{ assertionId: "P60-a1", expected: true, actual: false }]);
    expect(out[0]!.unknownAssertionIds).toEqual(["P60-nope"]);
    expect(out[0]!.judgeCalled).toBe(false); // 无 runner：semantic 不评（宁缺毋滥）
    expect(out[1]!.checked).toBe(0);
  });
});
