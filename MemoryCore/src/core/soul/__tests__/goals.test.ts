/**
 * P3 目标层纯函数：从事件里只长「显式承诺」与「计划」，愿望不立目标；
 * working 锚只放 top1 目标 + top2 到期承诺 + top1 阻塞，且 ≤300 字；
 * 跨三天问承诺仍答得出（时钟由调用侧注入，不靠真实时间）。
 */
import { describe, expect, it } from "vitest";
import {
  GOAL_OVERDUE_REASON_PREFIX,
  GOAL_WORKING_MAX_CHARS,
  buildWorkingState,
  commitmentAnswer,
  deriveGoals,
  parseGoalDueAt,
  unwrapPromiseFact,
} from "../goals.js";
import type { HistoryFact } from "../history.js";
import type { SoulEpisode } from "../types.js";
import type { SoulGoalRow } from "../../store/soul-event-types.js";

const AT = "2026-11-07T02:00:00.000Z";
const NOW = "2026-11-08T02:00:00.000Z";

function ep(partial: Partial<SoulEpisode> & { episodeId: string; at: string }): SoulEpisode {
  return {
    day: partial.at.slice(0, 10),
    kind: "decision",
    title: "推进了一点",
    object: "",
    participants: ["何晨", "assistant"],
    userStance: "",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: 0,
    arousal: 0,
    intensity: 0.2,
    evidenceIds: ["m1"],
    sessionId: "s1",
    quote: null,
    affectSource: "none",
    ...partial,
  };
}

function promiseFact(text: string, object: string, at = AT): HistoryFact {
  return { kind: "promise", layer: "self", text, object, episodeIds: ["ep-p1"], at };
}

function goalRow(partial: Partial<SoulGoalRow> & { goal_id: string }): SoulGoalRow {
  return {
    team_id: "t1",
    user_id: "u1",
    agent_id: "a1",
    owner: "self",
    kind: "commitment",
    title: "把目标写者接上",
    why: "这是我对自己立的约束",
    status: "active",
    priority: 0.6,
    progress: 0,
    due_at: null,
    parent_goal_id: null,
    source_event_id: null,
    success_criteria: "",
    blocked_reason: "",
    abandon_reason: "",
    valid_from: AT,
    valid_to: null,
    confidence: 0.7,
    created_at: AT,
    updated_at: AT,
    ...partial,
  };
}

describe("承诺包装与到期解析", () => {
  it("剥掉「我答应过自己」的包装，非包装原样返回", () => {
    expect(unwrapPromiseFact("我答应过自己：「三天内把目标写者接上」")).toBe("三天内把目标写者接上");
    expect(unwrapPromiseFact("三天内把目标写者接上")).toBe("三天内把目标写者接上");
  });

  it("只认句子里明说的三天内/明天/十天后/月底，认不出就不编", () => {
    expect(parseGoalDueAt("三天内把目标写者接上", AT)).toBe("2026-11-10T23:59:59.999Z");
    expect(parseGoalDueAt("明天把账对完", AT)).toBe("2026-11-08T23:59:59.999Z");
    expect(parseGoalDueAt("十天后再说", AT)).toBe("2026-11-17T23:59:59.999Z");
    expect(parseGoalDueAt("月底把它收口", AT)).toBe("2026-11-30T23:59:59.999Z");
    expect(parseGoalDueAt("把这件事做好", AT)).toBeNull();
  });
});

describe("deriveGoals：只从显式承诺与计划长", () => {
  it("自我承诺长成 commitment/self，带到期与回指承诺的钥匙", () => {
    const fact = promiseFact("我答应过自己：「三天内把目标写者接上」", "先取证再改");
    const got = deriveGoals({ episodes: [], facts: [fact] });
    expect(got.length).toBe(1);
    const g = got[0]!.goal;
    expect(g.kind).toBe("commitment");
    expect(g.owner).toBe("self");
    expect(g.title).toBe("三天内把目标写者接上");
    expect(g.due_at).toBe("2026-11-10T23:59:59.999Z");
    expect(g.why).toBe("这是我对自己立的约束");
    expect(got[0]!.promiseRef).toEqual({ refKey: "先取证再改", content: fact.text });
    expect(g.goal_id.startsWith("g-")).toBe(true);
  });

  it("愿望句不立目标（把每句想要都变目标就是记账）", () => {
    const got = deriveGoals({
      episodes: [ep({ episodeId: "ep-w1", at: AT, outcome: "我希望以后都能早点睡" })],
      facts: [],
    });
    expect(got).toEqual([]);
  });

  it("计划句长成 plan/self，why 说清在推什么", () => {
    const got = deriveGoals({
      episodes: [ep({ episodeId: "ep-p1", at: AT, object: "目标写者", agentStance: "我计划把目标写者的接线补上" })],
      facts: [],
    });
    expect(got.length).toBe(1);
    const g = got[0]!.goal;
    expect(g.kind).toBe("plan");
    expect(g.owner).toBe("self");
    // 「我计划把…」的引导语连同「把」一起剥掉，标题只留事情本身
    expect(g.title).toBe("目标写者的接线补上");
    expect(g.why).toContain("这件事在推");
  });

  it("对别人说出的承诺长成 commitment/joint，why 记下他当时问的是什么", () => {
    const got = deriveGoals({
      episodes: [
        ep({
          episodeId: "ep-j1",
          at: AT,
          userStance: "你什么时候把账对完？",
          outcome: "我答应你明天把账对完",
        }),
      ],
      facts: [],
    });
    expect(got.length).toBe(1);
    const g = got[0]!.goal;
    expect(g.kind).toBe("commitment");
    expect(g.owner).toBe("joint");
    expect(g.title).toBe("明天把账对完");
    expect(g.due_at).toBe("2026-11-08T23:59:59.999Z");
    expect(g.why).toContain("他那边问过");
  });

  it("问句不当成承诺或计划", () => {
    const got = deriveGoals({
      episodes: [ep({ episodeId: "ep-q1", at: AT, agentStance: "我计划这样吗？" })],
      facts: [],
    });
    expect(got).toEqual([]);
  });
});

describe("working 锚：只放 top1 目标 + top2 到期承诺 + top1 阻塞", () => {
  const focus = goalRow({
    goal_id: "g-focus",
    title: "把账对完",
    due_at: "2026-11-09T23:59:59.999Z",
  });
  const second = goalRow({
    goal_id: "g-second",
    title: "把目标写者接上",
    due_at: "2026-11-10T23:59:59.999Z",
  });
  const third = goalRow({ goal_id: "g-third", title: "接情绪层", due_at: "2026-11-11T23:59:59.999Z" });
  const fourth = goalRow({ goal_id: "g-fourth", title: "写验收数字", due_at: "2026-11-12T23:59:59.999Z" });
  const blocked = goalRow({
    goal_id: "g-blocked",
    kind: "plan",
    status: "blocked",
    blocked_reason: "等着：目标写者",
    title: "接 mood 层",
  });

  it("按到期排，只留一个在做、两条欠着、一条卡住，且不超 300 字", () => {
    const w = buildWorkingState({ goals: [third, focus, blocked, second, fourth], now: NOW });
    expect(w).not.toBeNull();
    expect(w!.current_goal_id).toBe("g-focus");
    expect(w!.current_focus).toContain("在做：把账对完");
    expect(w!.current_focus).toContain("欠着：");
    expect(w!.current_focus).toContain("卡住：接 mood 层");
    expect(w!.current_focus.length).toBeLessThanOrEqual(GOAL_WORKING_MAX_CHARS);
    // 三条到期承诺：一条在做，另外两条正好填满「欠着」（top2）
    expect(w!.current_focus).toContain("欠着：把目标写者接上");
    const owed = w!.current_focus.split("欠着：")[1]!.split("；")[0]!;
    expect(owed.split("、").length).toBe(2);
    // 第 4 条到期承诺被预算挡在外面，不挤进锚
    expect(w!.current_focus).not.toContain("写验收数字");
    expect(w!.session_id).toBe("");
  });

  it("长标题也不许把锚撑破 300 字", () => {
    const long = goalRow({ goal_id: "g-long", title: "把".repeat(200) + "这件事接上" });
    const w = buildWorkingState({ goals: [long, second, third], now: NOW });
    expect(w!.current_focus.length).toBeLessThanOrEqual(GOAL_WORKING_MAX_CHARS);
  });

  it("没有目标就返回 null（不写占位）", () => {
    expect(buildWorkingState({ goals: [], now: NOW })).toBeNull();
    expect(
      buildWorkingState({
        goals: [goalRow({ goal_id: "g-done", status: "done" }), goalRow({ goal_id: "g-ab", status: "abandoned" })],
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("承诺问答：跨三天仍答得出", () => {
  const dueSoon = goalRow({ goal_id: "g-c1", title: "把目标写者接上", due_at: "2026-11-10T23:59:59.999Z" });
  const overdue = goalRow({
    goal_id: "g-c2",
    title: "把账对完",
    status: "blocked",
    blocked_reason: GOAL_OVERDUE_REASON_PREFIX + "2026-11-05T23:59:59.999Z",
    due_at: "2026-11-05T23:59:59.999Z",
  });

  it("到期前说清哪天前，过期说清什么时候过期", () => {
    const before = commitmentAnswer([dueSoon], { now: AT });
    expect(before).toContain("我答应过「把目标写者接上」");
    expect(before).toContain("2026-11-10 前");
    const after = commitmentAnswer([dueSoon], { now: "2026-11-11T02:00:00.000Z" });
    expect(after).toContain("已经过期（2026-11-10）");
  });

  it("卡住的承诺带一句卡在哪", () => {
    const got = commitmentAnswer([overdue], { now: NOW });
    expect(got).toContain("已经过期（2026-11-05）");
    expect(got).toContain("（卡着：");
  });

  it("三天后的同一句追问仍答得出（不是「暂无」）", () => {
    const got = commitmentAnswer([dueSoon, overdue], { now: "2026-11-13T02:00:00.000Z" });
    expect(got).not.toBeNull();
    expect(got).toContain("我答应过「");
    expect(got).toContain("已经过期（");
  });

  it("没有承诺就不回答（不编一句「暂无承诺」）", () => {
    expect(commitmentAnswer([], { now: NOW })).toBeNull();
    expect(commitmentAnswer([goalRow({ goal_id: "g-x", kind: "plan" })], { now: NOW })).toBeNull();
  });
});
