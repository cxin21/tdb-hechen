/**
 * P3 存储面：soul_goals / soul_goal_events / soul_goal_deps / soul_working_state。
 * 锁三件事：状态机（active↔blocked，之后只能 done|abandoned，终态不复活）、
 * 账本幂等（同一 (goal_id,event_id,change) 重放不刷行）、
 * working 锚的过期语义（过期读不到旧锚，不能把三天前的注意力当现在的）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import {
  GOAL_TRANSITIONS,
  canTransitionGoal,
  clearSoulWorkingState,
  getSoulGoal,
  getSoulWorkingState,
  insertSoulGoalDep,
  insertSoulGoalEvents,
  listSoulGoalDeps,
  listSoulGoalEvents,
  listSoulGoals,
  transitionSoulGoal,
  upsertSoulGoal,
  upsertSoulWorkingState,
} from "../soul-goal-store.js";
import type { SoulGoalEventInsert, SoulGoalInsert } from "../soul-event-types.js";
import type { CoreTenant } from "../types.js";

const T1: CoreTenant = { teamId: "t1", userId: "u1", agentId: "a1" };
const T2: CoreTenant = { teamId: "t1", userId: "u2", agentId: "a2" };
const AT = "2026-11-07T02:00:00.000Z";
const LATER = "2026-11-08T02:00:00.000Z";
const DUE = "2026-11-17T23:59:59.999Z";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-goal-"));
  return path.join(dir, "vectors.db");
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

function goal(id: string, extra: Partial<SoulGoalInsert> = {}): SoulGoalInsert {
  return { goal_id: id, owner: "self", kind: "commitment", title: "把目标写者接上", valid_from: AT, ...extra };
}

describe("soul_goals 写者", () => {
  it("新目标默认 active：租户三列落全，进度与优先级取默认值", () => {
    const db = dbOf(makeStore(tmpDb()));
    const { row, created } = upsertSoulGoal(db, T1, goal("g-new", { due_at: DUE }));
    expect(created).toBe(true);
    expect(row.status).toBe("active");
    expect(row.progress).toBe(0);
    expect(row.priority).toBe(0.5);
    expect(row.team_id).toBe("t1");
    expect(row.user_id).toBe("u1");
    expect(row.agent_id).toBe("a1");
    expect(row.due_at).toBe(DUE);
    expect(row.valid_to).toBeNull();
    expect(getSoulGoal(db, T1, "g-new")!.title).toBe("把目标写者接上");
    // 租户边界：同一 goal_id 在别的租户里读不到
    expect(getSoulGoal(db, T2, "g-new")).toBeNull();
    expect(getSoulGoal(db, T1, "g-missing")).toBeNull();
    expect(listSoulGoals(db, T2).length).toBe(0);
    expect(listSoulGoals(db, T1).length).toBe(1);
  });

  it("状态机：blocked 必须给原因，done 之后不会被重说复活", () => {
    const db = dbOf(makeStore(tmpDb()));
    upsertSoulGoal(db, T1, goal("g-1"));

    // 缺原因的 blocked 拒绝，且一行都不改
    const noReason = transitionSoulGoal(db, T1, "g-1", "blocked", { at: LATER });
    expect(noReason.ok).toBe(false);
    expect(noReason.ok ? "" : noReason.reason).toBe("missing-blocked-reason");
    expect(getSoulGoal(db, T1, "g-1")!.status).toBe("active");

    const blocked = transitionSoulGoal(db, T1, "g-1", "blocked", { at: LATER, reason: "等着：目标写者" });
    expect(blocked.ok).toBe(true);
    expect(blocked.ok ? blocked.changed : false).toBe(true);
    expect(getSoulGoal(db, T1, "g-1")!.blocked_reason).toBe("等着：目标写者");

    // blocked 回到 active 不需要原因，且把阻塞理由清空
    expect(transitionSoulGoal(db, T1, "g-1", "active", { at: LATER }).ok).toBe(true);
    expect(getSoulGoal(db, T1, "g-1")!.status).toBe("active");
    expect(getSoulGoal(db, T1, "g-1")!.blocked_reason).toBe("");

    const done = transitionSoulGoal(db, T1, "g-1", "done", { at: LATER });
    expect(done.ok).toBe(true);
    const doneRow = getSoulGoal(db, T1, "g-1")!;
    expect(doneRow.status).toBe("done");
    expect(doneRow.progress).toBe(1);
    expect(doneRow.valid_to).toBe(LATER);

    // 同一句话第二次被说出来：只更新可刷字段，终态不回退
    const reagain = upsertSoulGoal(db, T1, goal("g-1", { title: "把目标写者接上（第二遍）" }));
    expect(reagain.created).toBe(false);
    expect(reagain.row.status).toBe("done");
    expect(getSoulGoal(db, T1, "g-1")!.status).toBe("done");

    const illegal = transitionSoulGoal(db, T1, "g-1", "active", { at: LATER });
    expect(illegal.ok).toBe(false);
    expect(illegal.ok ? "" : illegal.reason).toBe("invalid-transition:done->active");
    expect(canTransitionGoal("active", "done")).toBe(true);
    expect(canTransitionGoal("done", "active")).toBe(false);
    expect(GOAL_TRANSITIONS.done.length).toBe(0);

    // 同状态重放不算一次跃迁
    const same = transitionSoulGoal(db, T1, "g-1", "done", { at: LATER });
    expect(same.ok).toBe(true);
    expect(same.ok ? same.changed : true).toBe(false);

    expect(transitionSoulGoal(db, T1, "g-404", "done", { at: LATER }).ok).toBe(false);

    // abandoned：必须带原因，落 valid_to 与 abandon_reason
    upsertSoulGoal(db, T1, goal("g-2"));
    expect(transitionSoulGoal(db, T1, "g-2", "abandoned", { at: LATER }).ok).toBe(false);
    expect(transitionSoulGoal(db, T1, "g-2", "abandoned", { at: LATER, reason: "同一对象后来又失败" }).ok).toBe(true);
    const ab = getSoulGoal(db, T1, "g-2")!;
    expect(ab.status).toBe("abandoned");
    expect(ab.abandon_reason).toBe("同一对象后来又失败");
    expect(ab.valid_to).toBe(LATER);
  });

  it("账本：同一 (goal_id,event_id,change) 重放只算一次，跨租户写不进来", () => {
    const db = dbOf(makeStore(tmpDb()));
    upsertSoulGoal(db, T1, goal("g-a"));
    const rows: SoulGoalEventInsert[] = [
      { goal_id: "g-a", event_id: "ep:e1", change: "created", to_status: "active", at: AT },
    ];
    expect(insertSoulGoalEvents(db, T1, rows).inserted).toBe(1);
    // 同一批重放（tick 重跑）不刷行
    expect(insertSoulGoalEvents(db, T1, rows).inserted).toBe(0);
    // 别人的租户写本租户的目标：整行丢弃
    expect(insertSoulGoalEvents(db, T2, rows).inserted).toBe(0);
    expect(listSoulGoalEvents(db, T2).length).toBe(0);
    expect(listSoulGoalEvents(db, T1, { goalId: "g-a" }).length).toBe(1);

    // 状态跃迁自己也要落一条 change=status_changed
    expect(transitionSoulGoal(db, T1, "g-a", "blocked", { at: LATER, reason: "等着：依赖" }).ok).toBe(true);
    const all = listSoulGoalEvents(db, T1, { goalId: "g-a" });
    expect(all.length).toBe(2);
    expect(all.some((e) => e.change === "status_changed" && e.from_status === "active" && e.to_status === "blocked")).toBe(true);
  });

  it("依赖：自依赖和跨租户的边都不写", () => {
    const db = dbOf(makeStore(tmpDb()));
    upsertSoulGoal(db, T1, goal("g-a"));
    upsertSoulGoal(db, T1, goal("g-b", { kind: "plan" }));
    upsertSoulGoal(db, T2, goal("g-c"));
    expect(insertSoulGoalDep(db, T1, { goal_id: "g-a", depends_on_goal_id: "g-b" }).inserted).toBe(1);
    expect(insertSoulGoalDep(db, T1, { goal_id: "g-a", depends_on_goal_id: "g-a" }).inserted).toBe(0);
    expect(insertSoulGoalDep(db, T1, { goal_id: "g-a", depends_on_goal_id: "g-c" }).inserted).toBe(0);
    expect(listSoulGoalDeps(db, T1, { goalId: "g-a" }).length).toBe(1);
    expect(listSoulGoalDeps(db, T2).length).toBe(0);
  });
});

describe("soul_working_state 锚", () => {
  it("过期读不到、覆盖写只有一行、clear 之后为空、租户之间互不可见", () => {
    const db = dbOf(makeStore(tmpDb()));
    upsertSoulWorkingState(db, T1, {
      current_goal_id: "g-1",
      current_focus: "在做：把目标写者接上（11-07 到期）",
      updated_at: AT,
      expires_at: "2026-11-08T00:00:00.000Z",
    });
    const live = getSoulWorkingState(db, T1, { now: "2026-11-07T12:00:00.000Z" });
    expect(live?.current_focus).toContain("在做：");
    expect(live?.current_goal_id).toBe("g-1");
    // 过期锚：读不到，而不是读到一个三天前的注意力
    expect(getSoulWorkingState(db, T1, { now: "2026-11-09T00:00:00.000Z" })).toBeNull();
    // 不给 now 时行在就返回（调用侧负责传当前时刻）
    expect(getSoulWorkingState(db, T1)?.current_goal_id).toBe("g-1");
    expect(getSoulWorkingState(db, T2)).toBeNull();

    // 覆盖写：同一 (team,user,agent,session_id) 只有一行
    upsertSoulWorkingState(db, T1, {
      current_focus: "在做：换了一件",
      updated_at: LATER,
      expires_at: null,
    });
    const updated = getSoulWorkingState(db, T1)!;
    expect(updated.current_focus).toBe("在做：换了一件");
    expect(updated.current_goal_id).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS n FROM soul_working_state WHERE team_id = ? AND user_id = ? AND agent_id = ?").get("t1", "u1", "a1") as { n: number };
    expect(Number(count.n)).toBe(1);

    expect(clearSoulWorkingState(db, T1).deleted).toBe(1);
    expect(getSoulWorkingState(db, T1)).toBeNull();
  });
});
