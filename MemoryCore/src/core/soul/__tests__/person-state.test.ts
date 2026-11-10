/**
 * P2（关系状态写者）：从已落库事件确定性长出 soul_person_state 与 state_events。
 *
 * 判据（spec §4.4 / §9）：
 *  - 只有「这条事件只涉及一个人」时才把他的态度记到这个人头上；0 个/≥2 个人不猜归属。
 *  - 关系事实只从 history.ts 的 relationship 层来（trust/conflict/repair），不另造心理推断。
 *  - 同一事件重放不再累加：已记过的 evidence_event_ids 直接跳过（tick 幂等）。
 *  - 四轴 clamp 0..1，换轴必须留 old/new/reason 审计行。
 */
import { describe, expect, it } from "vitest";
import {
  PERSON_STATE_AXIS_DEFAULTS,
  PERSON_STATE_MAX_CONFIDENCE,
  derivePersonState,
  personStateDeltaForFact,
  runPersonStateMaintenance,
} from "../person-state.js";
import type { SoulEpisode } from "../types.js";
import type { SoulPersonStateRow } from "../../store/soul-event-types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const HE = "p_he";

function ep(over: Partial<SoulEpisode> = {}): SoulEpisode {
  return {
    episodeId: "ep-1",
    at: "2026-11-10T02:00:00.000Z",
    day: "2026-11-10",
    kind: "correction",
    title: "纠正：门禁",
    object: "门禁",
    participants: ["何晨", "assistant"],
    userStance: "这里写错了",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: -0.5,
    arousal: 0.5,
    intensity: 0.5,
    evidenceIds: ["l0-1"],
    sessionId: "s1",
    quote: null,
    affectSource: "none",
    persons: [HE],
    ...over,
  };
}

function previous(over: Partial<SoulPersonStateRow> = {}): SoulPersonStateRow {
  return {
    person_key: HE,
    team_id: TENANT.teamId,
    user_id: TENANT.userId,
    agent_id: TENANT.agentId,
    trust: 0.5,
    affinity: 0.5,
    respect: 0.5,
    obligation: 0.5,
    boundaries_json: "{}",
    model_json: "{}",
    last_interaction_at: "2026-11-09T00:00:00.000Z",
    evidence_event_ids_json: "[]",
    confidence: 0.5,
    updated_at: "2026-11-09T00:00:00.000Z",
    ...over,
  };
}

describe("person_state：从关系事实派生四轴", () => {
  it("他说「你自己决定」→ trust/respect 上行，并写审计行", () => {
    const out = derivePersonState({
      personKey: HE,
      previous: null,
      episodes: [ep({ userStance: "这个你自己决定" })],
      now: "2026-11-10T03:00:00.000Z",
    });
    expect(out).not.toBeNull();
    expect(out!.state.trust).toBeCloseTo(0.58, 4);
    expect(out!.state.respect).toBeCloseTo(0.53, 4);
    expect(out!.state.affinity).toBeCloseTo(0.5, 4);
    expect(out!.state.last_interaction_at).toBe("2026-11-10T02:00:00.000Z");
    expect(out!.state.evidence_event_ids_json).toBe(JSON.stringify(["ep-1"]));
    expect(out!.events.map((e) => e.field).sort()).toEqual(["respect", "trust"]);
    const trust = out!.events.find((e) => e.field === "trust")!;
    expect(trust.old_value).toBeCloseTo(0.5, 4);
    expect(trust.new_value).toBeCloseTo(0.58, 4);
    expect(trust.event_id).toBe("ep-1");
    expect(trust.reason).toContain("判断权");
    expect(trust.id).toContain("ep-1");
    expect(trust.id).toContain("trust");
  });

  it("0 个或 ≥2 个 person_key 的事件不归属，返回 null（不猜）", () => {
    expect(
      derivePersonState({ personKey: HE, previous: null, episodes: [ep({ persons: [] })], now: "2026-11-10T03:00:00.000Z" }),
    ).toBeNull();
    expect(
      derivePersonState({
        personKey: HE,
        previous: null,
        episodes: [ep({ persons: [HE, "p_other"] })],
        now: "2026-11-10T03:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("同一事件重放不重复累加：evidence 已含 ep-1 时只更新 updated_at", () => {
    const out = derivePersonState({
      personKey: HE,
      previous: previous({ trust: 0.58, respect: 0.53, evidence_event_ids_json: JSON.stringify(["ep-1"]), confidence: 0.55 }),
      episodes: [ep({ userStance: "这个你自己决定" })],
      now: "2026-11-10T04:00:00.000Z",
    });
    expect(out).not.toBeNull();
    expect(out!.events).toEqual([]);
    expect(out!.state.trust).toBeCloseTo(0.58, 4);
    expect(out!.state.confidence).toBeCloseTo(0.55, 4);
    expect(out!.state.updated_at).toBe("2026-11-10T04:00:00.000Z");
  });

  it("下行的 trust 走 clamp 0 下限，亲和也下调", () => {
    const out = derivePersonState({
      personKey: HE,
      previous: previous({ trust: 0.05, affinity: 0.51, evidence_event_ids_json: "[]" }),
      episodes: [
        ep({
          kind: "complaint",
          userStance: "我现在不放心你",
          agentStance: "",
          valence: -0.6,
        }),
      ],
      now: "2026-11-10T03:00:00.000Z",
    });
    expect(out!.state.trust).toBe(0);
    expect(out!.state.affinity).toBeCloseTo(0.48, 4);
    const trust = out!.events.find((e) => e.field === "trust")!;
    expect(trust.new_value).toBe(0);
  });

  it("修复事件把 trust/affinity/respect 往回抬，reason 带原话", () => {
    const out = derivePersonState({
      personKey: HE,
      previous: previous({ trust: 0.4, affinity: 0.4, respect: 0.45 }),
      episodes: [
        ep({
          userStance: "这里漏了验收",
          outcome: "补上了：按原话跑了门禁",
        }),
      ],
      now: "2026-11-10T03:00:00.000Z",
    });
    expect(out!.state.trust).toBeCloseTo(0.46, 4);
    expect(out!.state.affinity).toBeCloseTo(0.45, 4);
    expect(out!.state.respect).toBeCloseTo(0.47, 4);
    const fields = out!.events.map((e) => e.field).sort();
    expect(fields).toEqual(["affinity", "respect", "trust"]);
    expect(out!.events[0]!.reason).toContain("对我的要求");
  });

  it("冲突事件降 trust/affinity/respect；delta 表是常量而不是配置", () => {
    expect(personStateDeltaForFact({ kind: "trust", layer: "relationship", text: "t", object: "x", episodeIds: ["e"], at: "", direction: "down" })).toEqual({ trust: -0.1, affinity: -0.03 });
    expect(personStateDeltaForFact({ kind: "conflict", layer: "relationship", text: "t", object: "x", episodeIds: ["e"], at: "" })).toEqual({ trust: -0.05, affinity: -0.04, respect: -0.02 });
    expect(personStateDeltaForFact({ kind: "failure", layer: "self", text: "t", object: "x", episodeIds: ["e"], at: "" })).toEqual({});
  });

  it("confidence 随新证据上升但封顶 0.9", () => {
    const out = derivePersonState({
      personKey: HE,
      previous: previous({ confidence: 0.88 }),
      episodes: [ep({ userStance: "这个你自己决定" })],
      now: "2026-11-10T03:00:00.000Z",
    });
    expect(out!.state.confidence).toBe(PERSON_STATE_MAX_CONFIDENCE);
    expect(PERSON_STATE_AXIS_DEFAULTS.trust).toBe(0.5);
  });
});

describe("runPersonStateMaintenance：写者按人聚合后落库", () => {
  it("同一人两条事件 → 一次 upsert + 合并后的审计行；无事件的人不建行", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const store = {
      listSoulEpisodes: async () => [
        ep({ episodeId: "ep-1", at: "2026-11-10T01:00:00.000Z", userStance: "这个你自己决定" }),
        ep({ episodeId: "ep-2", at: "2026-11-10T02:00:00.000Z", userStance: "我有点不放心你", kind: "complaint", agentStance: "" }),
        ep({ episodeId: "ep-3", persons: [], userStance: "这个你自己决定" }),
      ],
      listSoulPersonStates: async () => [],
      upsertSoulPersonState: async (_t: unknown, row: Record<string, unknown>) => {
        upserts.push(row);
        return { created: upserts.length === 1, updated: true };
      },
      insertSoulPersonStateEvents: async (_t: unknown, rows: Array<Record<string, unknown>>) => {
        events.push(...rows);
        return { inserted: rows.length };
      },
    };
    const res = await runPersonStateMaintenance({ store, tenant: TENANT, now: "2026-11-10T05:00:00.000Z" });
    expect(res.persons).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.last_interaction_at).toBe("2026-11-10T02:00:00.000Z");
    expect(events.filter((e) => e.person_key === HE).length).toBeGreaterThanOrEqual(4);
    expect(events.every((e) => e.event_id === "ep-1" || e.event_id === "ep-2")).toBe(true);
  });
});
