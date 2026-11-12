import { describe, expect, it } from "vitest";
import { renderSoulTurnState, assembleTurnState } from "../turn-state.js";
import { PERSONA_TURN_MAX_CHARS } from "../traits.js";
import type { SoulCalibrationOutcome, SoulCalibrationRow } from "../../store/soul-event-types.js";

/**
 * t26 / P4：每轮尾巴用 soul_calibration 写一句按域把握。
 * 预算 400 是硬的：校准句整条放不下就整条丢，不留半句。
 */

function cal(
  domain: string,
  predicted: number,
  outcome: SoulCalibrationOutcome,
  index: number,
): SoulCalibrationRow {
  return {
    id: `cal-${index}`,
    team_id: "team-1",
    user_id: "user-1",
    agent_id: "agent-1",
    domain,
    predicted_confidence: predicted,
    actual_outcome: outcome,
    event_id: `ev-${index}`,
    at: "2026-11-10T00:00:00.000Z",
    error: null,
    note: "",
  };
}

function rows(predicted: number, outcome: SoulCalibrationOutcome, count: number): SoulCalibrationRow[] {
  return Array.from({ length: count }, (_, i) => cal("测试", predicted, outcome, i + 1));
}

describe("turn 尾巴：心境 + 未完的事 + 可选校准句", () => {
  it("没有校准：输出与旧口径逐字节一致，不多写「把握」", () => {
    const result = renderSoulTurnState({
      moodLine: "心里有点沉",
      openLoops: ["把票关了", "把说明改短"],
    });
    expect(result.text).toBe("心里有点沉\n未完的事：把票关了；把说明改短");
    expect(result.text).not.toContain("把握");
    expect(result.openLoops).toEqual(["把票关了", "把说明改短"]);
  });

  it("有校准：心境在前，校准句以「记得：」接在未完的事后面", () => {
    const result = renderSoulTurnState({
      moodLine: "心里有点沉",
      openLoops: ["把票关了"],
      calibration: rows(0.5, "success", 3),
    });
    const lines = result.text.split("\n");
    expect(lines[0]).toBe("心里有点沉");
    expect(lines[1]).toBe("未完的事：把票关了");
    expect(lines[2]).toContain("记得：在测试上，我给自己半成把握，3 次里成了 3 次。");
    expect(result.text.length).toBeLessThanOrEqual(PERSONA_TURN_MAX_CHARS);
  });

  it("校准全错：写「没成」，把握度不升", () => {
    const result = renderSoulTurnState({
      moodLine: "心里有点沉",
      openLoops: [],
      calibration: rows(0.8, "fail", 3),
    });
    expect(result.text).toContain("记得：在测试上，我给自己八成把握，3 次里没成 3 次。");
    expect(result.text).toContain("没成 3 次");
    expect(result.text).toContain("报得比实际高约 0.80");
    expect(result.text).not.toContain("八成把握，3 次里成了");
  });

  it("预算 400：校准句整条放不下就整条丢，绝不截半句", () => {
    const mood = "沉".repeat(PERSONA_TURN_MAX_CHARS - 10);
    const result = renderSoulTurnState({
      moodLine: mood,
      openLoops: ["把票关了"],
      calibration: rows(0.5, "success", 3),
    });
    expect(result.text.length).toBeLessThanOrEqual(PERSONA_TURN_MAX_CHARS);
    expect(result.text).not.toContain("记得：");
    expect(result.text.startsWith(mood)).toBe(true);
  });

  it("超长正文才截断，截断留省略号；未完的事最多 3 条并单行化", () => {
    const result = renderSoulTurnState({
      moodLine: "沉".repeat(PERSONA_TURN_MAX_CHARS + 50),
      openLoops: ["  a \n b ", "", "c", "d", "e"],
    });
    expect(result.text.length).toBe(PERSONA_TURN_MAX_CHARS);
    expect(result.text.endsWith("…")).toBe(true);
    expect(result.openLoops).toEqual(["a b", "c", "d"]);
  });
});

const NL = String.fromCharCode(10);

const RT_TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const RT_NOW = "2026-11-12T00:00:00.000Z";

function rtMood(overrides: Record<string, unknown> = {}) {
  return {
    team_id: "t1", user_id: "u1", agent_id: "a1",
    label: "平稳", valence: 0.8, arousal: 0.4, intensity: 0.6,
    half_life_hours: 36,
    cause_event_ids_json: JSON.stringify(["ev-m1"]),
    updated_at: "2026-11-11T00:00:00.000Z",
    ...overrides,
  };
}
function rtGoal(overrides: Record<string, unknown> = {}) {
  return {
    goal_id: "g1", team_id: "t1", user_id: "u1", agent_id: "a1",
    owner: "joint", kind: "commitment", title: "把说明改短", why: "一句一件事",
    status: "active", priority: 1, progress: 0, due_at: "2026-11-12T12:00:00.000Z",
    parent_goal_id: null, source_event_id: "ev-g1", success_criteria: "验收通过",
    blocked_reason: "", abandon_reason: "", valid_from: RT_NOW, valid_to: null,
    confidence: 0.9, created_at: RT_NOW, updated_at: RT_NOW,
    ...overrides,
  };
}
function rtRel(overrides: Record<string, unknown> = {}) {
  return {
    relId: "r1", subjKey: "p_A", pred: "信任", objKey: "p_B", objName: "",
    validTo: null, direction: "mutual", eventId: "ev-r1", status: "active",
    ...overrides,
  };
}
function rtPerson(key: string, name: string) {
  return { personKey: key, displayName: name, mergedInto: undefined };
}
function rtStore(overrides: Record<string, unknown> = {}) {
  return {
    readSoulState: async () => ({ valence: 0, arousal: 0.3, baselineValence: 0, baselineArousal: 0.3, sampleCount: 5, updatedAt: RT_NOW }),
    readSoulMoodState: async () => rtMood(),
    listSoulGoals: async () => [],
    getSoulWorkingState: async () => null,
    listSoulPersonRelations: async () => [],
    listSoulPersons: async () => [],
    listSoulPersonStates: async () => [],
    ...overrides,
  };
}

describe("assembleTurnState（issue #180 §6：只读运行时状态装配）", () => {
  it("衰减公式：effective = baseline + (stored - baseline) * exp(-dt / half_life)", async () => {
    const store = rtStore({
      readSoulMoodState: async () => rtMood({ valence: 0.8, half_life_hours: 36, updated_at: "2026-11-10T12:00:00.000Z" }),
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW });
    expect(s.mood.valence).toBeCloseTo(0 + (0.8 - 0) * Math.exp(-36 / 36), 6);
    expect(s.mood.derived).toBe(false);
    expect(s.mood.stale).toBe(false);
    expect(s.asOf).toBe(RT_NOW);
    expect(typeof s.stateHash).toBe("string");
    expect(s.evidenceIds).toContain("ev-m1");
  });

  it("soul_mood_state 缺失：回退 soul_state，标 derived:true，不伪造 mood 行", async () => {
    const store = rtStore({
      readSoulMoodState: async () => null,
      readSoulState: async () => ({ valence: -0.2, arousal: 0.5, baselineValence: 0, baselineArousal: 0.3, sampleCount: 3, updatedAt: RT_NOW }),
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW });
    expect(s.mood.derived).toBe(true);
    expect(s.mood.valence).toBe(-0.2);
  });

  it("超过 72 小时标 stale，只给中性底色", async () => {
    const store = rtStore({
      readSoulMoodState: async () => rtMood({ valence: 0.9, updated_at: "2026-11-08T00:00:00.000Z" }),
      readSoulState: async () => ({ valence: 0, arousal: 0.3, baselineValence: 0.1, baselineArousal: 0.3, sampleCount: 5, updatedAt: RT_NOW }),
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW });
    expect(s.mood.stale).toBe(true);
    expect(s.mood.valence).toBe(0.1);
  });

  it("A 的关系不泄漏给 B：只取 personKey 的入边和出边", async () => {
    const store = rtStore({
      listSoulPersons: async () => [rtPerson("p_A", "何晨"), rtPerson("p_B", "林夏"), rtPerson("p_C", "王五")],
      listSoulPersonRelations: async () => [
        rtRel({ relId: "r1", subjKey: "p_A", objKey: "p_B", pred: "信任" }),
        rtRel({ relId: "r2", subjKey: "p_B", objKey: "p_C", pred: "亏欠" }),
        rtRel({ relId: "r3", subjKey: "p_C", objKey: "p_A", pred: "合作" }),
      ],
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, personKey: "p_A", now: RT_NOW });
    const joined = s.relation.facts.join(NL);
    expect(joined).toContain("信任");
    expect(joined).toContain("合作");
    expect(joined).not.toContain("亏欠");
  });

  it("person 解析失败：person_unresolved warning，关系整段省略（fail-closed）", async () => {
    const store = rtStore({
      listSoulPersons: async () => [rtPerson("p_A", "何晨")],
      listSoulPersonRelations: async () => [rtRel({ subjKey: "p_A", objKey: "p_B", pred: "信任" })],
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, personKey: "p_B", now: RT_NOW });
    expect(s.warnings.some((w) => w.startsWith("person_unresolved"))).toBe(true);
    expect(s.relation.facts).toHaveLength(0);
  });

  it("due 24h 提醒：只提醒 24h 内到期的 active 目标；blocked 只写阻塞原因", async () => {
    const store = rtStore({
      listSoulGoals: async () => [
        rtGoal({ goal_id: "g1", title: "今天到期", due_at: "2026-11-12T12:00:00.000Z", status: "active" }),
        rtGoal({ goal_id: "g2", title: "两天后", due_at: "2026-11-14T12:00:00.000Z", status: "active" }),
        rtGoal({ goal_id: "g3", title: "被挡住", due_at: "2026-11-12T06:00:00.000Z", status: "blocked", blocked_reason: "等对方回话" }),
      ],
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW });
    expect(s.flags.goalReminder).toBe(true);
    const joined = s.goals.lines.join(NL);
    expect(joined).toContain("今天到期");
    expect(joined).not.toContain("两天后");
    expect(joined).toContain("等对方回话");
    expect(joined).not.toContain("被挡住");
  });

  it("flags 仲裁：事实与证据 > 关系修复，先问而不是先做；每个 flag 进 trace", async () => {
    const store = rtStore({
      readSoulMoodState: async () => rtMood({ valence: 0.9, updated_at: "2026-11-01T00:00:00.000Z" }),
      listSoulGoals: async () => [rtGoal({ status: "blocked", blocked_reason: "等确认" })],
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW });
    expect(s.flags.repairFirst).toBe(true);
    expect(s.flags.evidenceStrict).toBe(true);
    expect(s.flags.initiative).toBe("ask");
    expect(s.flagTrace.length).toBeGreaterThanOrEqual(7);
    const iFacts = s.flagTrace.findIndex((t) => t.includes("事实与证据"));
    const iRepair = s.flagTrace.findIndex((t) => t.includes("关系修复"));
    expect(iFacts).toBeGreaterThanOrEqual(0);
    expect(iRepair).toBeGreaterThan(iFacts);
  });

  it("目标 500 字预算，红线不丢", async () => {
    const store = rtStore({
      listSoulGoals: async () => [rtGoal({ title: "改".repeat(600), due_at: "2026-11-12T12:00:00.000Z" })],
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW, redlines: ["不可逆动作先确认", "隐私不跨人披露"] });
    expect(s.goals.chars).toBeLessThanOrEqual(500);
    expect(s.dynamicText.length).toBeLessThanOrEqual(400);
    expect(s.dynamicText).toContain("不可逆动作先确认");
    expect(s.dynamicText).toContain("隐私不跨人披露");
  });

  it("状态读失败用基线并标 absent，不阻塞会话", async () => {
    const store = rtStore({
      readSoulMoodState: async () => { throw new Error("db locked"); },
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW });
    expect(s.warnings).toContain("absent");
    expect(s.mood.valence).toBe(0);
  });

  it("derived 回退也受 72h 约束：soul_state 过期就不装成现在", async () => {
    const store = rtStore({
      readSoulMoodState: async () => null,
      readSoulState: async () => ({ valence: -0.6, arousal: 0.8, baselineValence: 0, baselineArousal: 0.3, sampleCount: 9, updatedAt: "2026-11-01T00:00:00.000Z" }),
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW });
    expect(s.mood.derived).toBe(true);
    expect(s.mood.stale).toBe(true);
    expect(s.mood.valence).toBe(0);
    expect(s.mood.arousal).toBe(0.3);
  });

  it("stateHash 能区分「现在」：只换 working 焦点也要换 hash", async () => {
    const at = (focus: string) => rtStore({
      readSoulMoodState: async () => null,
      getSoulWorkingState: async () => ({ current_focus: focus, updated_at: RT_NOW }),
    });
    const a = await assembleTurnState({ store: at("接线"), tenant: RT_TENANT, now: RT_NOW });
    const b = await assembleTurnState({ store: at("写票"), tenant: RT_TENANT, now: RT_NOW });
    expect(a.dynamicText).not.toBe(b.dynamicText);
    expect(a.stateHash).not.toBe(b.stateHash);
  });

  it("预算超限：整块丢关系，目标不被切半，goalReminder 与注入一致", async () => {
    const relations = Array.from({ length: 30 }, (_, i) =>
      rtRel({ relId: "r" + i, subjKey: "p_A", objKey: "p_" + i, pred: "长期协作并互相信任", direction: "out" }));
    const persons = [rtPerson("p_A", "何晨")].concat(
      Array.from({ length: 30 }, (_, i) => rtPerson("p_" + i, "对象" + i + "号")));
    const store = rtStore({
      listSoulPersons: async () => persons,
      listSoulPersonRelations: async () => relations,
      listSoulGoals: async () => [rtGoal({ goal_id: "g9", title: "交付评审", due_at: "2026-11-12T12:00:00.000Z" })],
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, personKey: "p_A", now: RT_NOW });
    expect(s.dynamicText.length).toBeLessThanOrEqual(400);
    const lines = s.dynamicText.split(NL);
    for (const line of lines) expect(/^(红线：|红线省略：|现在：|你与|目标：|已逾期：|阻塞：|优先级：)/.test(line)).toBe(true);
    for (const line of lines) expect(line.endsWith("…")).toBe(false);
    expect(lines).toContain("目标：交付评审");
    expect(s.flags.goalReminder).toBe(true);
    expect(s.relation.facts.length).toBeGreaterThan(0);
  });

  it("仲裁可执行：有红线时 tone 不 warm、disclosure 收敛为 guarded", async () => {
    const store = rtStore({ readSoulMoodState: async () => rtMood({ valence: 0.9, updated_at: "2026-11-11T23:00:00.000Z" }) });
    const calm = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW });
    expect(calm.flags.tone).toBe("warm");
    const guarded = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW, redlines: ["不动生产数据"] });
    expect(guarded.flags.tone).toBe("neutral");
    expect(guarded.flags.disclosure).toBe("guarded");
  });

  it("已逾期目标同样提醒，行文写「已逾期：」", async () => {
    const store = rtStore({ listSoulGoals: async () => [rtGoal({ title: "上周就该交", due_at: "2026-11-01T00:00:00.000Z" })] });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW });
    expect(s.flags.goalReminder).toBe(true);
    expect(s.dynamicText).toContain("已逾期：上周就该交");
  });

  it("长期阻塞不永久注入：valid_to 过期的 blocked 行丢掉，带 blocked_event_id 才可追", async () => {
    const store = rtStore({
      listSoulGoals: async () => [
        rtGoal({ goal_id: "g-old", status: "blocked", blocked_reason: "等半年了", valid_to: "2026-11-01T00:00:00.000Z" }),
        rtGoal({ goal_id: "g-new", status: "blocked", blocked_reason: "等确认", blocked_event_id: "ev-blocked" }),
      ],
    });
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW });
    expect(s.dynamicText).not.toContain("等半年了");
    expect(s.dynamicText).toContain("阻塞：等确认");
    expect(s.evidenceIds).toContain("ev-blocked");
  });

  it("红线装不下时留可见占位，不让边界段悄悄消失（第三轮评审 MAJOR-2）", async () => {
    const store = rtStore({});
    const longRedline = "红".repeat(600);
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW, redlines: [longRedline] });
    expect(s.dynamicText.length).toBeLessThanOrEqual(400);
    expect(s.dynamicText).toContain("红线：见人格卡（1 条）");
    expect(s.dynamicText).not.toContain(longRedline);
    expect(s.warnings).toContain("budget_dropped:redline:1/1");
    expect(s.flags.tone).toBe("neutral");
    expect(s.flags.disclosure).toBe("guarded");
  });

  it("预算可由调用方收窄（插件把标头占位交给 Core，避免二次裁尾）", async () => {
    const store = rtStore({
      listSoulGoals: async () => [rtGoal({ title: "交付评审" })],
    });
    const wide = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW, personKey: "p_A" });
    const narrow = await assembleTurnState({
      store,
      tenant: RT_TENANT,
      now: RT_NOW,
      personKey: "p_A",
      dynamicMaxChars: 10,
    });
    expect(wide.dynamicText.length).toBeLessThanOrEqual(400);
    expect(narrow.dynamicText.length).toBeLessThanOrEqual(10);
    // 优先级行永远在末尾：预算再紧也不能把「先做/先问」挤掉。
    for (const text of [wide.dynamicText, narrow.dynamicText]) {
      const lines = text.split(NL);
      expect(lines[lines.length - 1]!.startsWith("优先级：")).toBe(true);
    }
    expect(narrow.warnings.some((w) => w.startsWith("budget_dropped:") && w.includes("/"))).toBe(true);
  });

  it("占位行不重复计数，优先级行也放不下时留一条警告（第四轮评审 MINOR-1/2）", async () => {
    const store = rtStore({});
    const s = await assembleTurnState({ store, tenant: RT_TENANT, now: RT_NOW, redlines: ["红".repeat(600)], dynamicMaxChars: 5 });
    // 连「优先级：先做」都放不下：正文为空，但必须能看出原因。
    expect(s.dynamicText).toBe("");
    expect(s.warnings).toContain("budget_dropped:priority:1/1");
    for (const w of s.warnings) {
      const m = /^budget_dropped:([a-z]+):(\d+)\/(\d+)$/.exec(w);
      if (m) expect(Number(m[2])).toBeLessThanOrEqual(Number(m[3]));
    }
  });
});

