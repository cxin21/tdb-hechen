/**
 * P5 端到端（真实临时库 + 真实 worker 路径）：
 *   episode → soul_emotions.event_id/goal_id 落位
 *   → soul_mood_state 一行 + soul_mood_events 账本（appraisal / decay）
 *   → 追到期承诺不再落「踏实」→ 重评保留原事件、另起一条读数
 *   → 三天后（注入 now）心境按 48h 半衰期衰减，召回符号跟着走。
 *
 * 时钟只从注入的 now 来：这里不读真实时间、不 sleep，
 * 否则「三天后衰减一半」就成了一条靠等待的断言。快情绪的半衰期只有几小时，
 * 事件必须落在 now 之前 1–2 小时内，否则还没积进心境就已经衰减到 0（等于没测）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { runSoulMaintenanceTick } from "../../lifecycle/lifecycle-scheduler.js";
import { runSoulMaintenance } from "../worker.js";
import { moodSignAt } from "../emotion.js";
import { moodSignalOf } from "../../tools/recall-signals.js";
import { resolveSoulConfig, type SoulEpisode } from "../types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-mood-e2e-")), "vectors.db");
}

function makeStore(): VectorStore {
  const store = new VectorStore(tmpDb(), 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）：" + res.reason);
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

type Row = Record<string, unknown>;

function moodStateRow(db: ReturnType<typeof dbOf>): Row | undefined {
  return db
    .prepare("SELECT * FROM soul_mood_state WHERE team_id = ? AND user_id = ? AND agent_id = ?")
    .get("t1", "u1", "a1") as Row | undefined;
}

function moodEvents(db: ReturnType<typeof dbOf>): Row[] {
  return db
    .prepare("SELECT * FROM soul_mood_events ORDER BY at ASC, id ASC")
    .all() as unknown as Row[];
}

function emotionRows(db: ReturnType<typeof dbOf>): Row[] {
  return db
    .prepare(
      "SELECT episode_id, label, valence, event_id, goal_id, template_version, dimensions_json FROM soul_emotions ORDER BY episode_id, template_version",
    )
    .all() as unknown as Row[];
}

describe("P5 端到端：情绪落位 → 心境账本 → 衰减 → 重评", () => {
  it("一次 tick 把三条事件写成情绪与心境，三天后按半衰期衰减一半", async () => {
    const store = makeStore();
    const db = dbOf(store);
    // 目标行直写（这条测的是情绪挂目标，不是目标派生；t3 已单测派生）。
    store.upsertSoulGoal(TENANT, {
      goal_id: "goal-recall",
      owner: "self",
      kind: "plan",
      title: "把召回链路守住",
      valid_from: "2026-11-01T00:00:00.000Z",
    } as never);
    store.commitSoulEpisodes(TENANT, [
      // ① 可挂目标的普通负面事件（对象 = 召回链路）
      ep({
        episodeId: "ep-recall",
        at: "2026-11-09T22:00:00.000Z",
        kind: "correction",
        object: "召回链路",
        valence: -0.15,
        arousal: 0.5,
        intensity: 0.5,
      }),
      // ② 他当面追「说好的、到期还没交」的承诺：不许落踏实
      ep({
        episodeId: "ep-overdue",
        at: "2026-11-09T22:30:00.000Z",
        kind: "correction",
        userStance: "说好的那笔账到期了还没交呢",
        valence: -0.3,
        arousal: 0.6,
        intensity: 0.6,
      }),
      // ③ 已经补上的事：重评要留原行，另起一条读数
      ep({
        episodeId: "ep-repaired",
        at: "2026-11-09T23:00:00.000Z",
        kind: "correction",
        object: "插件工具事件采集",
        agentStance: "已经补上，改完了",
        valence: -0.2,
        arousal: 0.5,
        intensity: 0.5,
      }),
    ]);

    const NOW1 = "2026-11-10T00:00:00.000Z";
    const first = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: NOW1,
      config: resolveSoulConfig({}),
      trigger: "manual",
      llmCallBudget: 0,
    });
    expect(first.mood?.written).toBe(true);

    // —— 心境：一行当前态，带 48h 半衰期与原因事件 id ——
    const state1 = moodStateRow(db);
    expect(state1).toBeDefined();
    expect(Number(state1!.half_life_hours)).toBe(48);
    expect(typeof state1!.label).toBe("string");
    expect(String(state1!.label).length).toBeGreaterThan(0);
    const cause1 = JSON.parse(String(state1!.cause_event_ids_json ?? "[]")) as string[];
    expect(cause1).toEqual(expect.arrayContaining(["ep-recall", "ep-overdue", "ep-repaired"]));

    // —— 账本：一条 appraisal，原因指回事件 ——
    const events1 = moodEvents(db);
    const appraisals = events1.filter((e) => e.kind === "appraisal");
    expect(appraisals).toHaveLength(1);
    const appraisalCause = JSON.parse(String(appraisals[0].cause_event_ids_json ?? "[]")) as string[];
    expect(appraisalCause).toHaveLength(3);
    expect(String(appraisals[0].note)).toContain("评价→心境");

    // —— 情绪：event_id 落位（= episode id），object 不是空 ——
    const rows1 = emotionRows(db);
    const recallRow = rows1.find((r) => r.episode_id === "ep-recall" && !String(r.template_version).includes("+reappraise"));
    expect(recallRow).toBeDefined();
    expect(recallRow!.event_id).toBe("ep-recall");
    expect(String(recallRow!.event_id)).not.toBe("");
    // 目标挂靠：唯一命中才挂，且真的挂上了
    expect(recallRow!.goal_id).toBe("goal-recall");
    const dims = JSON.parse(String(recallRow!.dimensions_json ?? "{}")) as Record<string, unknown>;
    expect(dims).toBeTypeOf("object");

    // —— 验收①：承诺到期被指出，不落「踏实」，落成我的愧疚（agency 已被门改成 self）——
    const overdueRow = rows1.find((r) => r.episode_id === "ep-overdue" && !String(r.template_version).includes("+reappraise"));
    expect(overdueRow).toBeDefined();
    expect(String(overdueRow!.label)).not.toBe("踏实");
    expect(Number(overdueRow!.valence)).toBeLessThan(0);
    const overdueDims = JSON.parse(String(overdueRow!.dimensions_json ?? "{}")) as Record<string, unknown>;
    expect(overdueDims.positiveForbidden).toBe(true);
    expect(overdueDims.selfCause).toBe(true);
    expect(overdueDims.otherCause).toBe(false);

    // —— 验收③：重评保留原事件（同 episode 两行，模板版本不同）——
    const repairedRows = rows1.filter((r) => r.episode_id === "ep-repaired");
    expect(repairedRows).toHaveLength(2);
    const baseRow = repairedRows.find((r) => !String(r.template_version).includes("+reappraise"));
    const reRow = repairedRows.find((r) => String(r.template_version).includes("+reappraise"));
    expect(baseRow).toBeDefined();
    expect(reRow).toBeDefined();
    expect(String(baseRow!.label)).not.toBe(String(reRow!.label));
    // 原事件行仍在、未被覆盖（event_id/at 都指同一条事件）
    expect(baseRow!.event_id).toBe("ep-repaired");

    // —— 同一时刻再跑一遍：账本不翻倍、情绪不重复 ——
    const beforeRepeat = { events: moodEvents(db).length, emotions: emotionRows(db).length };
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: NOW1,
      config: resolveSoulConfig({}),
      trigger: "manual",
      llmCallBudget: 0,
    });
    expect(moodEvents(db).length).toBe(beforeRepeat.events);
    expect(emotionRows(db).length).toBe(beforeRepeat.emotions);

    // —— 验收②：三天后（注入 now = updated_at + 72h）按 48h 半衰期衰减（1.5 个半衰期）——
    const updatedAt = String(state1!.updated_at);
    const threeDaysLater = new Date(Date.parse(updatedAt) + 72 * 3_600_000).toISOString();
    const wk = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: threeDaysLater,
      config: resolveSoulConfig({}),
      trigger: "manual",
      llmCallBudget: 0,
    });
    expect(wk.mood?.written).toBe(true);

    const state3 = moodStateRow(db);
    // soul_mood_state 不存基线（基线在 soul_state），这里按「相对 0」读偏离。
    const dev1 = Number(state1!.valence);
    const dev3 = Number(state3!.valence);
    expect(Math.abs(dev1)).toBeGreaterThan(0.05);
    const ratio = Math.abs(dev3) / Math.abs(dev1);
    // 三天 = 1.5 个 48h 半衰期：偏离量剩 2^-1.5 ≈ 0.354。基线 EMA 会把比例略抬，
    // 区间放到 [0.33, 0.40]；纯函数那一档在 soul-mood-dynamics 里钉到 2^-1.5。
    expect(ratio).toBeGreaterThanOrEqual(0.33);
    expect(ratio).toBeLessThanOrEqual(0.4);

    // 账本里能看见这次衰减：一条 decay 行，note 写明半衰期
    const decayRow = moodEvents(db).find((e) => e.kind === "decay");
    expect(decayRow).toBeDefined();
    expect(String(decayRow!.note)).toContain("48h");
    expect(Math.abs(Number(decayRow!.delta_valence))).toBeGreaterThan(0.005);

    // —— 心境对召回的影响：符号先按衰减算，再喂给排序 ——
    // 当初（NOW1）偏离 0.11 → 符号 -1，负面记忆拿 boost；三天后剩 0.043，
    // 已低于 0.05 阈值 → 符号 0：衰减完就不再永久偏置召回（宁缺毋滥）。
    const sign1 = moodSignAt(
      { valence: Number(state1!.valence), baselineValence: 0, updatedAt: NOW1 },
      NOW1,
      Number(state1!.half_life_hours),
    );
    const sign3 = moodSignAt(
      { valence: Number(state3!.valence), baselineValence: 0, updatedAt: threeDaysLater },
      threeDaysLater,
      Number(state3!.half_life_hours),
    );
    const veryLate = new Date(Date.parse(threeDaysLater) + 7 * 86_400_000).toISOString();
    const signLate = moodSignAt(
      { valence: Number(state3!.valence), baselineValence: 0, updatedAt: threeDaysLater },
      veryLate,
      Number(state3!.half_life_hours),
    );
    expect(sign1).toBe(-1);
    expect(Math.abs(dev3)).toBeLessThan(0.05);
    expect(sign3).toBe(0);
    expect(signLate).toBe(0);
    expect(moodSignalOf({ valence: -0.2 } as never, sign1, 0.03)).toBeCloseTo(0.03, 6);
    expect(moodSignalOf({ valence: 0.2 } as never, sign1, 0.03)).toBe(0);
    expect(moodSignalOf({ valence: -0.2 } as never, sign3, 0.03)).toBe(0);

    // 心境行的半衰期落在 36–168 之间且默认取 48（不是随手写的数字）
    expect(Number(state3!.half_life_hours)).toBeGreaterThanOrEqual(36);
    expect(Number(state3!.half_life_hours)).toBeLessThanOrEqual(168);
    expect(Number(state3!.half_life_hours)).toBe(48);
  });
});

describe("P5 端到端：调度器真实 tick 也落心境行（不是只有手动 worker 路径）", () => {
  it("runSoulMaintenanceTick 一轮之后 mood_state / mood_events / emotions.event_id 都在", async () => {
    const store = makeStore();
    const db = dbOf(store);
    // 用真实时钟造一条「刚刚发生」的事件：快情绪半衰期只有几小时，
    // 这里要验的是 tick 接线，不是衰减数学（衰减数学上一条用例用注入 now 钉死了）。
    const at = new Date(Date.now() - 30 * 60_000).toISOString();
    store.commitSoulEpisodes(TENANT, [
      ep({
        episodeId: "ep-tick",
        at,
        kind: "correction",
        object: "召回链路",
        valence: -0.3,
        arousal: 0.6,
        intensity: 0.6,
      }),
    ]);

    const summary = await runSoulMaintenanceTick({ store, filter: TENANT, config: resolveSoulConfig({}) });
    expect(summary.tenants).toBe(1);

    const state = moodStateRow(db);
    expect(state).toBeDefined();
    expect(Number(state!.half_life_hours)).toBe(48);
    const cause = JSON.parse(String(state!.cause_event_ids_json ?? "[]")) as string[];
    expect(cause).toContain("ep-tick");

    const events = moodEvents(db);
    expect(events.some((e) => e.kind === "appraisal")).toBe(true);

    const row = emotionRows(db).find((r) => r.episode_id === "ep-tick");
    expect(row).toBeDefined();
    expect(row!.event_id).toBe("ep-tick");
    expect(String(row!.label).length).toBeGreaterThan(0);
  });

  it("账本写不进去就不打标：这批事件留给下一 tick，缺口不被「已积过」掩掉", async () => {
    const store = makeStore();
    const db = dbOf(store);
    store.commitSoulEpisodes(TENANT, [
      ep({
        episodeId: "ep-ledger-gap",
        at: "2026-11-09T22:00:00.000Z",
        kind: "correction",
        object: "账本缺口",
        valence: -0.2,
        arousal: 0.5,
        intensity: 0.5,
      }),
    ]);
    const marks: string[][] = [];
    const realMark = store.markSoulEpisodesMoodIntegrated.bind(store);
    store.markSoulEpisodesMoodIntegrated = (t, ids, at) => {
      marks.push(ids);
      return realMark(t, ids, at);
    };
    // 账本被拒：一行没写、也没有一行本来就在
    store.commitSoulMoodEvents = () => ({ inserted: 0, present: 0 });

    const report = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-10T00:00:00.000Z",
      config: resolveSoulConfig({}),
      trigger: "manual",
      llmCallBudget: 0,
    });
    // 心境本身写进去了，但账本没着落 → 不打标，事件留待重试
    expect(report.mood?.written).toBe(true);
    expect(report.moodEpisodesIntegrated).toBe(0);
    expect(marks).toEqual([]);
    const row = db
      .prepare("SELECT mood_integrated_at FROM soul_episodes WHERE episode_id = ?")
      .get("ep-ledger-gap") as { mood_integrated_at: string | null };
    expect(row.mood_integrated_at).toBeNull();
  });

  it("心境原因写入前过滤历史脏对象：「你说」不会被当成原因一直挂在心境上", async () => {
    const store = makeStore();
    const db = dbOf(store);
    store.commitSoulEpisodes(TENANT, [
      ep({
        episodeId: "ep-dirty-object",
        at: "2026-11-09T22:00:00.000Z",
        kind: "correction",
        object: "账本缺口",
        valence: -0.2,
        arousal: 0.5,
        intensity: 0.5,
      }),
    ]);
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-10T00:00:00.000Z",
      config: resolveSoulConfig({}),
      trigger: "manual",
      llmCallBudget: 0,
    });
    // 修复前的情绪表里可能存着空对象；模拟成上一轮写进 soul_state 的历史值
    db.prepare("DELETE FROM soul_emotions").run();
    db.prepare("UPDATE soul_state SET emotion_object = ?, emotion_label = ?").run("你说", "意外");

    await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-10T01:00:00.000Z",
      config: resolveSoulConfig({}),
      trigger: "manual",
      llmCallBudget: 0,
    });
    const row = db.prepare("SELECT emotion_object, emotion_label FROM soul_state").get() as {
      emotion_object: string | null;
      emotion_label: string | null;
    };
    // 原因被门掉；标签是读数，允许留着
    expect(row.emotion_object).toBeNull();
    expect(row.emotion_label).toBe("意外");
  });
});
