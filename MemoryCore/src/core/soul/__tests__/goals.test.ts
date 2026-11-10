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
  collectGoalDepEdges,
  commitmentAnswer,
  deriveGoals,
  goalIdForPromise,
  goalTitleKey,
  parseGoalDueAt,
  resolveGoalIdentity,
  runGoalMaintenance,
  unwrapPromiseFact,
  type GoalStorePort,
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


/**
 * 目标重复账的口径（t28）：同租户 +（同文本键 或 同 promise_id）+ status∈active/blocked 才复用同一个 goal_id。
 * 判据是确定性归一后的「同文本」，没有相似度阈值。
 */
function fakeGoalStore(seed: {
  goals?: SoulGoalRow[];
  promises?: Array<{ promiseId: string; content: string; status: string; refKey: string; goal_id?: string | null }>;
} = {}) {
  const goals = new Map<string, SoulGoalRow>((seed.goals ?? []).map((row) => [row.goal_id, row]));
  type FakePromise = { promiseId: string; content: string; status: string; refKey: string; goal_id?: string | null };
  const promises = new Map<string, FakePromise>(
    (seed.promises ?? []).map((row) => [row.promiseId, { ...row }] as [string, FakePromise]),
  );
  const deps: Array<{ goal_id: string; depends_on_goal_id: string; kind: string }> = [];
  const upserted: string[] = [];
  const store: GoalStorePort = {
    listSoulGoals: () => Array.from(goals.values()),
    listSoulPromises: () => Array.from(promises.values()),
    upsertSoulGoal: (_tenant, insert) => {
      upserted.push(insert.goal_id);
      const existing = goals.get(insert.goal_id);
      if (existing) {
        const row: SoulGoalRow = {
          ...existing,
          title: insert.title,
          why: insert.why ?? existing.why,
          updated_at: insert.updated_at ?? existing.updated_at,
        };
        goals.set(row.goal_id, row);
        return { row, created: false };
      }
      const row: SoulGoalRow = {
        goal_id: insert.goal_id,
        team_id: insert.team_id ?? "t1",
        user_id: insert.user_id ?? "u1",
        agent_id: insert.agent_id ?? "a1",
        owner: insert.owner,
        kind: insert.kind,
        title: insert.title,
        why: insert.why ?? "",
        status: insert.status ?? "active",
        priority: insert.priority ?? 0.5,
        progress: insert.progress ?? 0,
        due_at: insert.due_at ?? null,
        parent_goal_id: insert.parent_goal_id ?? null,
        source_event_id: insert.source_event_id ?? null,
        success_criteria: insert.success_criteria ?? "",
        blocked_reason: insert.blocked_reason ?? "",
        abandon_reason: insert.abandon_reason ?? "",
        valid_from: insert.valid_from,
        valid_to: insert.valid_to ?? null,
        confidence: insert.confidence ?? 0.5,
        created_at: insert.created_at ?? insert.valid_from,
        updated_at: insert.updated_at ?? insert.valid_from,
      };
      goals.set(row.goal_id, row);
      return { row, created: true };
    },
    insertSoulGoalEvents: () => ({ inserted: 0 }),
    setSoulPromiseGoal: (_tenant, promiseId, goalId) => {
      const row = promises.get(promiseId);
      if (!row) return { updated: false };
      if (row.goal_id === goalId) return { updated: false };
      row.goal_id = goalId;
      return { updated: true };
    },
    insertSoulGoalDep: (_tenant, row) => {
      if (deps.some((d) => d.goal_id === row.goal_id && d.depends_on_goal_id === row.depends_on_goal_id)) {
        return { inserted: 0 };
      }
      deps.push({ goal_id: row.goal_id, depends_on_goal_id: row.depends_on_goal_id, kind: row.kind ?? "blocks" });
      return { inserted: 1 };
    },
    listSoulGoalDeps: () => deps,
    upsertSoulWorkingState: () => undefined,
    clearSoulWorkingState: () => ({ deleted: 0 }),
  };
  return { store, goals, promises, deps, upserted };
}

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

describe("目标去重：同一句承诺只长一个 goal", () => {
  it("文本键把承诺包装与裸句归一成同一句，句末标点不算差异", () => {
    expect(goalTitleKey("我答应过自己：「周五前把说明改成短句」")).toBe(
      goalTitleKey("周五前把说明改成短句。"),
    );
    expect(goalTitleKey("周五前把说明改成短句")).not.toBe(goalTitleKey("周五前把文档改成短句"));
  });

  it("promise_id 派生的 id 与 P0-D 迁移逐字一致（可反查、重跑不变）", () => {
    expect(goalIdForPromise("pm_1")).toBe("goal-pm_1");
    expect(goalIdForPromise("")).toBe("");
  });

  it("promise 派生与 worker 派生撞同一句话：只建一条，另一条复用它的 goal_id", async () => {
    const facts = [promiseFact("我答应过自己：「周五前把说明改成短句，一句一件事」", "你说这周要把对外说明改成短句")];
    const episodes = [
      ep({
        episodeId: "ep-p1",
        at: AT,
        object: "把说明改成短句",
        outcome: "我答应你周五前把说明改成短句，一句一件事",
      }),
    ];
    const fake = fakeGoalStore({
      promises: [
        {
          promiseId: "pm_1",
          content: "我答应过自己：「周五前把说明改成短句，一句一件事」",
          status: "open",
          refKey: "你说这周要把对外说明改成短句",
        },
      ],
    });
    const first = await runGoalMaintenance({
      store: fake.store,
      tenant: TENANT,
      episodes,
      facts,
      now: NOW,
    });
    expect(first.candidates).toBe(2);
    expect(first.created).toBe(1);
    expect(first.reused).toBe(1);
    expect(fake.goals.size).toBe(1);
    expect(Array.from(fake.goals.keys())).toEqual(["goal-pm_1"]);
    expect(fake.promises.get("pm_1")?.goal_id).toBe("goal-pm_1");

    const second = await runGoalMaintenance({
      store: fake.store,
      tenant: TENANT,
      episodes,
      facts,
      now: NOW,
    });
    expect(second.created).toBe(0);
    expect(fake.goals.size).toBe(1);
  });

  it("库里已有等价活目标时复用它，不因 id 不同再建一条", async () => {
    const legacy = goalRow({
      goal_id: "g-legacy",
      title: "周五前把说明改成短句，一句一件事",
      status: "active",
    });
    const fake = fakeGoalStore({
      goals: [legacy],
      promises: [
        {
          promiseId: "pm_1",
          content: "我答应过自己：「周五前把说明改成短句，一句一件事」",
          status: "open",
          refKey: "",
        },
      ],
    });
    const got = await runGoalMaintenance({
      store: fake.store,
      tenant: TENANT,
      episodes: [],
      facts: [promiseFact("我答应过自己：「周五前把说明改成短句，一句一件事」", "这件事")],
      now: NOW,
    });
    expect(got.created).toBe(0);
    expect(fake.goals.size).toBe(1);
    expect(fake.upserted).toEqual(["g-legacy"]);
    expect(fake.promises.get("pm_1")?.goal_id).toBe("g-legacy");
  });

  it("库里的历史重复行不新建第三条：复用 promise 派生那条，另一条留给人工清理", async () => {
    const migrated = goalRow({
      goal_id: "goal-pm_1",
      title: "我答应过自己：「周五前把说明改成短句，一句一件事」",
      status: "active",
    });
    const legacy = goalRow({
      goal_id: "g-dup",
      title: "周五前把说明改成短句，一句一件事",
      status: "active",
    });
    const fake = fakeGoalStore({
      goals: [migrated, legacy],
      promises: [
        {
          promiseId: "pm_1",
          content: "我答应过自己：「周五前把说明改成短句，一句一件事」",
          status: "open",
          refKey: "",
          goal_id: "g-dup",
        },
      ],
    });
    const got = await runGoalMaintenance({
      store: fake.store,
      tenant: TENANT,
      episodes: [],
      facts: [promiseFact("我答应过自己：「周五前把说明改成短句，一句一件事」", "这件事")],
      now: NOW,
    });
    expect(got.created).toBe(0);
    expect(fake.goals.size).toBe(2);
    expect(fake.upserted).toEqual(["goal-pm_1"]);
    expect(fake.promises.get("pm_1")?.goal_id).toBe("goal-pm_1");
  });

  it("终态目标不复活：同文本只跳过一次，不因复用又改回 active", async () => {
    const done = goalRow({ goal_id: "goal-pm_1", title: "周五前把说明改成短句", status: "done" });
    const fake = fakeGoalStore({
      goals: [done],
      promises: [
        {
          promiseId: "pm_1",
          content: "我答应过自己：「周五前把说明改成短句」",
          status: "open",
          refKey: "",
        },
      ],
    });
    const got = await runGoalMaintenance({
      store: fake.store,
      tenant: TENANT,
      episodes: [],
      facts: [promiseFact("我答应过自己：「周五前把说明改成短句」", "这件事")],
      now: NOW,
    });
    expect(got.created).toBe(0);
    expect(got.skipped).toBe(1);
    expect(fake.goals.get("goal-pm_1")?.status).toBe("done");
  });
});

describe("goal_deps：有父才落边，没父 0 行", () => {
  it("parent_goal_id 指向本批目标时落一条 blocks 边（重跑幂等不翻倍）", async () => {
    const parent = goalRow({ goal_id: "g-parent", title: "先把说明定稿", status: "active" });
    const child = goalRow({
      goal_id: "g-child",
      title: "再把说明改成短句",
      status: "active",
      parent_goal_id: "g-parent",
    });
    const fake = fakeGoalStore({ goals: [parent, child] });
    const first = await runGoalMaintenance({ store: fake.store, tenant: TENANT, episodes: [], facts: [], now: NOW });
    expect(first.deps).toBe(1);
    expect(fake.deps).toEqual([{ goal_id: "g-child", depends_on_goal_id: "g-parent", kind: "blocks" }]);

    const second = await runGoalMaintenance({ store: fake.store, tenant: TENANT, episodes: [], facts: [], now: NOW });
    expect(second.deps).toBe(0);
    expect(fake.deps).toHaveLength(1);
  });

  it("没有父目标就是 0 行；父不在库里也不猜边", async () => {
    const orphan = goalRow({ goal_id: "g-orphan", title: "等着不存在的东西", parent_goal_id: "g-missing" });
    const plain = goalRow({ goal_id: "g-plain", title: "独立的目标" });
    const fake = fakeGoalStore({ goals: [orphan, plain] });
    const got = await runGoalMaintenance({ store: fake.store, tenant: TENANT, episodes: [], facts: [], now: NOW });
    expect(got.deps).toBe(0);
    expect(fake.deps).toEqual([]);
  });

  it("collectGoalDepEdges 是纯函数：丢自依赖、丢跨批缺失父、带去重", () => {
    const rows = [
      goalRow({ goal_id: "g-a", parent_goal_id: "g-b" }),
      goalRow({ goal_id: "g-b", parent_goal_id: "g-a" }),
      goalRow({ goal_id: "g-c", parent_goal_id: "g-c" }),
      goalRow({ goal_id: "g-d", parent_goal_id: "g-missing" }),
      goalRow({ goal_id: "g-a", parent_goal_id: "g-b" }),
    ];
    expect(collectGoalDepEdges(rows)).toEqual([
      { goal_id: "g-a", depends_on_goal_id: "g-b", kind: "blocks" },
      { goal_id: "g-b", depends_on_goal_id: "g-a", kind: "blocks" },
    ]);
  });

  it("resolveGoalIdentity 的口径：只复用 active/blocked，终态不复用", () => {
    const active = goalRow({ goal_id: "g-live", title: "周五前把说明改成短句", status: "active" });
    const done = goalRow({ goal_id: "g-done", title: "周五前把说明改成短句", status: "done" });
    const candidate = deriveGoals({
      episodes: [],
      facts: [promiseFact("我答应过自己：「周五前把说明改成短句」", "这件事")],
    })[0]!;
    expect(resolveGoalIdentity({ candidate, existing: [done], promiseId: "pm_1" })).toEqual({
      goalId: "goal-pm_1",
      reason: "promise",
    });
    expect(resolveGoalIdentity({ candidate, existing: [active, done] })).toEqual({
      goalId: "g-live",
      reason: "title",
    });
  });
});

