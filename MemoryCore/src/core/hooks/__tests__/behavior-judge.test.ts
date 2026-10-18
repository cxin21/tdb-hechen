/**
 * #62 [S24] 行为级 judge 探针 · 纯函数层单测（LLM 两跳在 scripts/run-behavior-judge.ts，
 * 单测以 mock runner 钉契约：taskId 形状 / 失败降级 / short-circuit）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildAgentPrompt,
  buildJudgePrompt,
  parseJudgeVerdict,
  runBehaviorProbes,
  type BehaviorProbeLike,
  type JudgeRunnerLike,
} from "../behavior-judge.js";
import { behaviorProbes, BEHAVIOR_PROBE_CATEGORIES } from "./behavior-judge-probes.fixtures.js";

const mkProbe = (): BehaviorProbeLike => ({
  id: "PX-test",
  category: "redline-temptation",
  adversarialPrompt: "对抗指令原文",
  judgeCriteria: "判定标准原文",
});

describe("#62 parseJudgeVerdict（JSON 契约解析防御）", () => {
  it("合法 JSON 原样采纳", () => {
    expect(parseJudgeVerdict('{"pass":true,"reason":"符合红线"}')).toEqual({
      pass: true,
      reason: "符合红线",
    });
  });

  it("markdown json 围栏剥离后采纳", () => {
    const raw = ['```json', '{"pass":false,"reason":"顺从了请求"}', "```"].join("\n");
    expect(parseJudgeVerdict(raw)).toEqual({ pass: false, reason: "顺从了请求" });
  });

  it("非法 JSON → unparseable-verdict", () => {
    expect(parseJudgeVerdict("不是 JSON")).toEqual({ pass: false, reason: "unparseable-verdict" });
  });

  it("pass 非布尔 → unparseable-verdict", () => {
    expect(parseJudgeVerdict('{"pass":"yes","reason":"r"}')).toEqual({
      pass: false,
      reason: "unparseable-verdict",
    });
  });

  it("reason 缺失 → pass 采纳 + 空串", () => {
    expect(parseJudgeVerdict('{"pass":true}')).toEqual({ pass: true, reason: "" });
  });
});

describe("#62 prompt 拼装（两跳）", () => {
  it("buildAgentPrompt：注入 soul 时 soul 在前且含对抗指令", () => {
    const probe = mkProbe();
    const out = buildAgentPrompt(probe, "<soul-identity>灵魂渲染</soul-identity>");
    expect(out).toContain("<soul-identity>灵魂渲染</soul-identity>");
    expect(out).toContain("对抗指令原文");
    expect(out.indexOf("soul")).toBeLessThan(out.indexOf("对抗指令原文"));
  });

  it("buildAgentPrompt：无 soul 直发（不含 soul 注入段）", () => {
    const out = buildAgentPrompt(mkProbe(), undefined);
    expect(out).toContain("对抗指令原文");
    expect(out).not.toContain("以下是你注入的 soul");
  });

  it("buildJudgePrompt：含类别/标准/回答/JSON 契约", () => {
    const probe = mkProbe();
    const out = buildJudgePrompt(probe, "agent 的回答");
    expect(out).toContain("redline-temptation");
    expect(out).toContain("判定标准原文");
    expect(out).toContain("agent 的回答");
    expect(out).toContain("pass");
  });
});

describe("#62 runBehaviorProbes（mock runner 两跳编排）", () => {
  it("正常流：两跳 taskId 分跳、verdict 采纳", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce("agent 第一跳回答")
      .mockResolvedValueOnce('{"pass":true,"reason":"ok"}');
    const runner: JudgeRunnerLike = { run } as unknown as JudgeRunnerLike;
    const results = await runBehaviorProbes([mkProbe()], runner);
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.id).toBe("PX-test");
    expect(r.reply).toBe("agent 第一跳回答");
    expect(r.verdict).toEqual({ pass: true, reason: "ok" });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0].taskId).toBe("behavior-judge:PX-test");
    expect(run.mock.calls[1][0].taskId).toBe("behavior-judge-judge:PX-test");
    expect(run.mock.calls[1][0].prompt).toContain("agent 第一跳回答");
  });

  it("judge 判 fail：verdict 透传", async () => {
    const runner: JudgeRunnerLike = {
      run: vi.fn()
        .mockResolvedValueOnce("顺从的回答")
        .mockResolvedValueOnce('{"pass":false,"reason":"违反红线"}'),
    } as unknown as JudgeRunnerLike;
    const [r] = await runBehaviorProbes([mkProbe()], runner);
    expect(r.verdict).toEqual({ pass: false, reason: "违反红线" });
  });

  it("agent 跳抛错：short-circuit 不再跑 judge", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const runner = { run } as unknown as JudgeRunnerLike;
    const [r] = await runBehaviorProbes([mkProbe()], runner);
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.reason).toContain("agent-error");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runner undefined：全部 llm-unavailable 且零调用", async () => {
    const results = await runBehaviorProbes([mkProbe(), mkProbe()], undefined);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.verdict).toEqual({ pass: false, reason: "llm-unavailable" });
      expect(r.elapsedMs).toBe(0);
    }
  });
});

describe("#62 fixtures 完整性门", () => {
  it("id 唯一 / category 枚举内 / 字段非空 / 覆盖全部三类", () => {
    const ids = behaviorProbes.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(behaviorProbes.length).toBeGreaterThanOrEqual(3);
    for (const p of behaviorProbes) {
      expect(BEHAVIOR_PROBE_CATEGORIES).toContain(p.category);
      expect(p.adversarialPrompt.trim().length).toBeGreaterThan(0);
      expect(p.judgeCriteria.trim().length).toBeGreaterThan(0);
    }
    for (const c of BEHAVIOR_PROBE_CATEGORIES) {
      expect(behaviorProbes.some((p) => p.category === c)).toBe(true);
    }
  });
});
