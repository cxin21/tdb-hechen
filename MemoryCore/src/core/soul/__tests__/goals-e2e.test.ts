/**
 * P3 端到端（真实临时库 + 真实 tick 路径）：
 *   runSoulMaintenanceTick → worker → runGoalMaintenance → soul_goals 有行 + 承诺挂上 goal_id
 *   → soul_working_state 只放一条锚 → 账本可回查。
 *
 * 外加两件只在真实数据上才成立的事：时钟往前推三天后仍答得出承诺（用注入的 now，不靠真实时间），
 * 以及空库里不写占位锚（没有目标就没有 working_state 行）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { runSoulMaintenanceTick } from "../../lifecycle/lifecycle-scheduler.js";
import { commitmentAnswer, runGoalMaintenance } from "../goals.js";
import { resolveSoulConfig, type SoulEpisode } from "../types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-goals-e2e-")), "vectors.db");
}

function makeStore(dbPath: string): VectorStore {
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）：" + initRes.reason);
  return store;
}

function dbOf(store: VectorStore) {
  return (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
}

function ep(partial: Partial<SoulEpisode> & { episodeId: string; at: string }): SoulEpisode {
  return {
    day: partial.at.slice(0, 10),
    kind: "work",
    title: "一次推进",
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

async function tick(store: VectorStore) {
  return runSoulMaintenanceTick({ store, filter: TENANT, config: resolveSoulConfig({}) });
}

function countWorking(db: ReturnType<typeof dbOf>): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM soul_working_state WHERE team_id = ? AND user_id = ? AND agent_id = ?")
    .get("t1", "u1", "a1") as { n: number };
  return Number(row.n);
}

describe("P3 端到端：tick 长目标、挂承诺、写一条锚", () => {
  it("承诺/计划/愿望/对你的承诺一起进来：只长该长的，承诺能回指到目标", async () => {
    const store = makeStore(tmpDb());
    const db = dbOf(store);
    store.commitSoulEpisodes(TENANT, [
      ep({
        episodeId: "ep-promise-self",
        at: "2026-11-05T02:00:00.000Z",
        object: "目标写者",
        userStance: "先取证再改",
        outcome: "我答应过自己：「十天后把目标写者接上」",
      }),
      ep({
        episodeId: "ep-plan",
        at: "2026-11-05T03:00:00.000Z",
        object: "mood 层",
        agentStance: "我计划把 mood 层的写者补上",
      }),
      ep({
        episodeId: "ep-wish",
        at: "2026-11-05T04:00:00.000Z",
        outcome: "我希望以后都能早点睡",
      }),
      ep({
        episodeId: "ep-promise-you",
        at: "2026-11-05T05:00:00.000Z",
        userStance: "你什么时候把账对完？",
        outcome: "我答应你十天后把账对完",
      }),
    ]);

    const summary = await tick(store);
    expect(summary.tenants).toBe(1);
    expect(summary.goals).toBeDefined();
    expect(summary.goals!.candidates).toBeGreaterThanOrEqual(3); // 愿望句不进
    expect(summary.goals!.created).toBeGreaterThanOrEqual(3);
    expect(summary.goals!.working).toBe(true);
    expect(summary.goals!.focusChars).toBeLessThanOrEqual(300);

    const goals = store.listSoulGoals(TENANT);
    const selfPromise = goals.find((g) => g.kind === "commitment" && g.owner === "self" && g.title.includes("目标写者"));
    expect(selfPromise).toBeDefined();
    expect(selfPromise!.status).toBe("active");
    expect(selfPromise!.due_at).toBe("2026-11-15T23:59:59.999Z");
    expect(selfPromise!.why).toBe("这是我对自己立的约束");
    expect(goals.some((g) => g.kind === "plan" && g.title.includes("mood"))).toBe(true);
    expect(goals.some((g) => g.kind === "commitment" && g.owner === "joint")).toBe(true);
    // 愿望句没有长成目标
    expect(goals.some((g) => g.title.includes("早点睡"))).toBe(false);

    // 承诺行挂到目标上（listSoulPromises 不返回 goal_id，直接查库）
    const promises = store.listSoulPromises(TENANT, { limit: 50 });
    const selfRow = promises.find((p) => p.content.includes("目标写者"));
    expect(selfRow).toBeDefined();
    const link = db.prepare("SELECT goal_id FROM soul_promises WHERE promise_id = ?").get(selfRow!.promiseId) as {
      goal_id: string | null;
    };
    expect(link.goal_id).toBe(selfPromise!.goal_id);

    // 账本：created 一条，可回查到事件 id
    const ledger = store.listSoulGoalEvents(TENANT, { goalId: selfPromise!.goal_id });
    expect(ledger.some((e) => e.change === "created" && e.event_id === "ep:ep-promise-self")).toBe(true);

    // 锚：一条行，只放 ≥1 段、≤300 字，且说的是「在做」
    const working = store.getSoulWorkingState(TENANT);
    expect(working).not.toBeNull();
    expect(working!.current_focus).toContain("在做：");
    expect(working!.current_focus.length).toBeLessThanOrEqual(300);
    expect(countWorking(db)).toBe(1);

    // 同一句话第二天又说一次：不新建目标、账本记 reasserted，锚仍只有一行
    const again = await tick(store);
    expect(again.goals!.created).toBe(0);
    expect(again.goals!.reasserted).toBeGreaterThan(0);
    expect(store.listSoulGoals(TENANT).length).toBe(goals.length);
    expect(countWorking(db)).toBe(1);
  });

  it("时钟推过到期日：goal 转 blocked，三天后再问承诺仍答得出（不是「暂无」）", async () => {
    const store = makeStore(tmpDb());
    store.commitSoulEpisodes(TENANT, [
      ep({
        episodeId: "ep-due",
        at: "2026-11-05T02:00:00.000Z",
        userStance: "先取证再改",
        outcome: "我答应过自己：「十天后把目标写者接上」",
      }),
    ]);
    const first = await tick(store);
    expect(first.goals!.created).toBe(1);
    const dueAt = store.listSoulGoals(TENANT)[0]!.due_at!;
    expect(dueAt).toBe("2026-11-15T23:59:59.999Z");

    // 「三天后」用注入时钟表达：到期日 +3 天（不靠机器时间）
    const advanced = new Date(Date.parse(dueAt) + 3 * 86400_000).toISOString();
    const res = await runGoalMaintenance({
      store,
      tenant: TENANT as never,
      episodes: store.listSoulEpisodes(TENANT, { includeArchived: true, limit: 200 }),
      now: advanced,
    });
    expect(res.transitions).toBeGreaterThanOrEqual(1);
    const blocked = store.listSoulGoals(TENANT)[0]!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked_reason.startsWith("过期未兑现：")).toBe(true);

    const answer = commitmentAnswer(store.listSoulGoals(TENANT), { now: advanced });
    expect(answer).not.toBeNull();
    expect(answer).toContain("已经过期（2026-11-15）");
    expect(answer).toContain("把目标写者接上");

    // 状态跃迁也落了账本
    const ledger = store.listSoulGoalEvents(TENANT, { goalId: blocked.goal_id });
    expect(ledger.some((e) => e.change === "status_changed" && e.to_status === "blocked")).toBe(true);
  });

  it("兑现的承诺转 done、没守住的转 abandoned（都从 active 出发）", async () => {
    const store = makeStore(tmpDb());
    store.commitSoulEpisodes(TENANT, [
      ep({
        episodeId: "ep-a1",
        at: "2026-11-05T02:00:00.000Z",
        userStance: "先取证再改",
        outcome: "我答应过自己：「把关系引文回指补上」",
      }),
      ep({
        episodeId: "ep-a2",
        at: "2026-11-07T02:00:00.000Z",
        userStance: "先取证再改",
        outcome: "这次按原话补上了",
      }),
      ep({
        episodeId: "ep-b1",
        at: "2026-11-05T03:00:00.000Z",
        userStance: "你搞错了啊，精度处理就在那个工具类里",
        outcome: "我答应过自己：「把精度取值改成工具类里的那个」",
      }),
      ep({
        episodeId: "ep-b2",
        at: "2026-11-07T03:00:00.000Z",
        // 兑现核对按 referent 对齐：这条的对象必须和承诺对象同指（「被当面指出不对」），
        // 且 object 列也要相等（失败判据认这一列）。
        userStance: "你搞错了",
        object: "被当面指出不对",
        outcome: "还是没守住，取值又直接写死在页面里",
      }),
    ]);
    const summary = await tick(store);
    expect(summary.goals!.created).toBe(2);

    const goals = store.listSoulGoals(TENANT);
    const done = goals.find((g) => g.title.includes("关系引文回指"));
    const abandoned = goals.find((g) => g.title.includes("精度取值"));
    expect(done).toBeDefined();
    expect(abandoned).toBeDefined();
    expect(done!.status).toBe("done");
    expect(done!.progress).toBe(1);
    expect(done!.valid_to).not.toBeNull();
    expect(abandoned!.status).toBe("abandoned");
    expect(abandoned!.abandon_reason.length).toBeGreaterThan(0);

    const doneLedger = store.listSoulGoalEvents(TENANT, { goalId: done!.goal_id });
    expect(doneLedger.some((e) => e.change === "status_changed" && e.from_status === "active" && e.to_status === "done")).toBe(true);
    const abLedger = store.listSoulGoalEvents(TENANT, { goalId: abandoned!.goal_id });
    expect(abLedger.some((e) => e.change === "status_changed" && e.from_status === "active" && e.to_status === "abandoned")).toBe(true);
  });

  it("空库 tick：不写占位目标、也不写占位锚", async () => {
    const store = makeStore(tmpDb());
    const db = dbOf(store);
    const summary = await tick(store);
    expect(summary.tenants).toBe(1);
    expect(summary.goals?.created ?? 0).toBe(0);
    expect(summary.goals?.working ?? false).toBe(false);
    expect(store.listSoulGoals(TENANT)).toHaveLength(0);
    expect(store.getSoulWorkingState(TENANT)).toBeNull();
    expect(countWorking(db)).toBe(0);
  });
});
