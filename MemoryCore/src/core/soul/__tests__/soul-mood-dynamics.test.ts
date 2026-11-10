/**
 * P5 心境动力学（纯函数）：半衰期 36–168h（默认 48h，恢复 ADR 口径）的衰减、
 * 调节只回收超出部分、归因一致性门、「承诺到期被指出」不许落正向，
 * 以及重评保留原事件的身份（id/at/object）。
 *
 * 这些数字是验收口径的一部分，不靠「手感」：48h 半衰期就是 factor=0.5，
 * 三天（1.5 个半衰期）后偏离量必须落在 2^-1.5 ≈ 0.354 倍附近。
 */
import { describe, expect, it } from "vitest";
import {
  MOOD_HALF_LIFE_DEFAULT_HOURS,
  MOOD_HALF_LIFE_MAX_HOURS,
  MOOD_HALF_LIFE_MIN_HOURS,
  applyAppraisalConsistency,
  appraiseEmotion,
  decayMoodTowardBaseline,
  moodDecayFactor,
  moodSignAt,
  normalizeMoodHalfLife,
  reappraiseEmotion,
  regulateMood,
  type AppraisalVector,
  type EmotionEvent,
  type MoodState,
} from "../emotion.js";
import {
  emotionReappraisalFromEpisode,
  episodeAppraisal,
  promiseOverduePointedOut,
  reappraisalDiffers,
} from "../episode.js";
import { resolveSoulConfig, type SoulEpisode } from "../types.js";

function mood(partial: Partial<MoodState> = {}): MoodState {
  return {
    valence: 0.8,
    arousal: 0.6,
    baselineValence: 0.3,
    baselineArousal: 0.4,
    updatedAt: "2026-11-01T00:00:00.000Z",
    sampleCount: 3,
    ...partial,
  };
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
    intensity: 0.4,
    evidenceIds: ["m1"],
    sessionId: "s1",
    quote: null,
    affectSource: "none",
    ...partial,
  };
}

const APPRAISAL: AppraisalVector = {
  goalRelevance: 0.6,
  expectationViolation: 0.5,
  control: 0.6,
  normCompatibility: 0.8,
  agency: "self",
};

describe("半衰期口径：36–168h，默认 48h", () => {
  it("任何来源的半衰期都夹进 36–168（24→36，48→48，500→168，缺省 48）", () => {
    expect(normalizeMoodHalfLife(24)).toBe(MOOD_HALF_LIFE_MIN_HOURS);
    expect(normalizeMoodHalfLife(48)).toBe(48);
    expect(normalizeMoodHalfLife(500)).toBe(MOOD_HALF_LIFE_MAX_HOURS);
    expect(normalizeMoodHalfLife(undefined)).toBe(MOOD_HALF_LIFE_DEFAULT_HOURS);
    expect(MOOD_HALF_LIFE_MIN_HOURS).toBe(36);
    expect(MOOD_HALF_LIFE_MAX_HOURS).toBe(168);
    expect(MOOD_HALF_LIFE_DEFAULT_HOURS).toBe(48);
  });

  it("48h 正好衰减一半，24h 是 2^-0.5", () => {
    const base = "2026-11-01T00:00:00.000Z";
    expect(moodDecayFactor(48, base, "2026-11-03T00:00:00.000Z")).toBeCloseTo(0.5, 6);
    expect(moodDecayFactor(48, base, "2026-11-02T00:00:00.000Z")).toBeCloseTo(Math.SQRT1_2, 4);
    // 时间不可解析 / 没前进：不虚构衰减。
    expect(moodDecayFactor(48, base, "not-a-date")).toBe(1);
    expect(moodDecayFactor(48, base, base)).toBe(1);
  });

  it("三天后心境按 48h 半衰期回落到基线，偏离量落在 2^-1.5 附近", () => {
    const d0 = mood({ valence: 0.8, baselineValence: 0.3 });
    const dev0 = d0.valence - d0.baselineValence;
    const d3 = decayMoodTowardBaseline(d0, "2026-11-04T00:00:00.000Z", 48);
    const expected = Math.pow(2, -1.5);
    expect(d3.factor).toBeCloseTo(expected, 6);
    const ratio = (d3.valence - 0.3) / dev0;
    expect(ratio).toBeGreaterThanOrEqual(0.33);
    expect(ratio).toBeLessThanOrEqual(0.37);
    // 基线本身不动：衰减是「偏离回落」，不是把基线也拉低。
    expect(d3.valence).toBeCloseTo(0.3 + 0.5 * expected, 6);
  });

  it("召回用的心境符号先衰减再判向：三天后仍偏负，一周后归 0", () => {
    const d0 = mood({ valence: -0.5, baselineValence: 0.0, updatedAt: "2026-11-01T00:00:00.000Z" });
    expect(moodSignAt(d0, "2026-11-01T01:00:00.000Z", 48)).toBe(-1);
    // 三天（1.5 个半衰期）：-0.5 → -0.177，仍过 0.05 阈值。
    expect(moodSignAt(d0, "2026-11-04T00:00:00.000Z", 48)).toBe(-1);
    // 一周（168h = 3.5 个半衰期）：-0.5 → -0.044，低于阈值归 0（宁缺毋滥）。
    expect(moodSignAt(d0, "2026-11-08T00:00:00.000Z", 48)).toBe(0);
    // 两周（336h = 7 个半衰期）：更弱，仍归 0。
    expect(moodSignAt(d0, "2026-11-15T00:00:00.000Z", 48)).toBe(0);
  });
});

describe("心境调节：只回收超出阈值的部分", () => {
  it("小偏离不调节（不伪造「我调节了自己」）", () => {
    const r = regulateMood(mood({ valence: 0.55, baselineValence: 0.3, arousal: 0.4, baselineArousal: 0.4 }));
    expect(r.applied).toBe(false);
    expect(r.deltaValence).toBe(0);
    expect(r.mood.valence).toBe(0.55);
  });

  it("大偏离往基线回拉约 20% 的超出量，不归零", () => {
    const r = regulateMood(mood({ valence: 1, baselineValence: 0.3, arousal: 0.4, baselineArousal: 0.4 }));
    expect(r.applied).toBe(true);
    const excess = 1 - 0.3;
    // 只回收 (excess - trigger) 的 20%。
    expect(r.mood.valence).toBeCloseTo(1 - (excess - 0.35) * 0.2, 6);
    expect(r.mood.valence).toBeGreaterThan(0.3);
    expect(r.deltaValence).toBeLessThan(0);
  });
});

describe("归因一致性门：agency 与 selfCause/otherCause 同侧互斥", () => {
  it("self ⇒ 只 selfCause；other ⇒ 只 otherCause；environment ⇒ 两侧都不是", () => {
    const self = applyAppraisalConsistency({ ...APPRAISAL, agency: "self", selfCause: false, otherCause: true });
    expect([self.selfCause, self.otherCause]).toEqual([true, false]);
    const other = applyAppraisalConsistency({ ...APPRAISAL, agency: "other", selfCause: true, otherCause: false });
    expect([other.selfCause, other.otherCause]).toEqual([false, true]);
    const env = applyAppraisalConsistency({ ...APPRAISAL, agency: "environment", selfCause: true, otherCause: true });
    expect([env.selfCause, env.otherCause]).toEqual([false, false]);
  });

  it("没有 agency 却两侧都成立：认账优先，去掉 otherCause", () => {
    // 旧数据/外部调用可能没有 agency 字段：类型上强转，模拟「缺归因」的存量向量。
    const a = applyAppraisalConsistency({
      ...APPRAISAL,
      selfCause: true,
      otherCause: true,
      agency: undefined,
    } as unknown as AppraisalVector);
    expect([a.selfCause, a.otherCause]).toEqual([true, false]);
  });

  it("appraiseEmotion 出口已过门：agency=self 的事件不会带 otherCause", () => {
    const e = appraiseEmotion({
      at: "2026-11-01T00:00:00.000Z",
      object: "召回链路",
      appraisal: { ...APPRAISAL, agency: "self", otherCause: true },
    });
    expect(e.appraisal.selfCause).toBe(true);
    expect(e.appraisal.otherCause).toBe(false);
  });
});

describe("承诺到期被指出：不许落「踏实」", () => {
  const overdue = ep({
    episodeId: "ep-overdue",
    at: "2026-11-03T00:00:00.000Z",
    kind: "correction",
    object: "对账",
    title: "被追问承诺",
    userStance: "你答应过的那笔账还没交呢",
    agentStance: "嗯",
  });

  it("识别「承诺 + 到期/没交」的话术，但不把「已经补上了」当成催账", () => {
    expect(promiseOverduePointedOut(overdue)).toBe(true);
    expect(
      promiseOverduePointedOut({
        userStance: "上次说的那个补上了吗",
        title: "",
        object: "",
      }),
    ).toBe(false);
  });

  it("评价变成「我的事」且禁正向，判出来的情绪不是踏实", () => {
    const a = episodeAppraisal(overdue);
    expect(a.positiveForbidden).toBe(true);
    expect(a.agency).toBe("self");
    expect(a.selfCause).toBe(true);
    expect(a.otherCause).toBe(false);
    const e = appraiseEmotion({ at: overdue.at, object: overdue.object, appraisal: a });
    expect(e.label).not.toBe("踏实");
    expect(e.valence).toBeLessThan(0);
  });

  it("正向模板被禁时兜底成负面（selfCause ⇒ 愧疚，否则不安）", () => {
    const positive: AppraisalVector = {
      goalRelevance: 0.9,
      expectationViolation: 0.1,
      control: 0.9,
      normCompatibility: 1,
      agency: "self",
      positiveForbidden: true,
    };
    const e = appraiseEmotion({ at: "2026-11-03T00:00:00.000Z", object: "对账", appraisal: positive });
    expect(e.label).toBe("愧疚");
    const other = appraiseEmotion({
      at: "2026-11-03T00:00:00.000Z",
      object: "对账",
      appraisal: { ...positive, agency: "other", selfCause: false, otherCause: true },
    });
    expect(other.label).toBe("不安");
  });
});

describe("重评：保留原事件，另起一条读数", () => {
  const repaired = ep({
    episodeId: "ep-repaired",
    at: "2026-11-02T00:00:00.000Z",
    kind: "correction",
    object: "召回链路",
    userStance: "你改完没？",
    agentStance: "已经补上了，改完了",
    outcome: "已按你说的改完",
    intensity: 0.6,
  });

  it("没修复的事件不产生重评", () => {
    expect(emotionReappraisalFromEpisode(ep({ episodeId: "ep-x", at: "2026-11-02T00:00:00.000Z" }), resolveSoulConfig({}))).toBeNull();
  });

  it("修复后重评读数与原读数不同，但 id/at/object 不漂移", () => {
    const original: EmotionEvent = appraiseEmotion({
      id: repaired.episodeId,
      at: repaired.at,
      object: repaired.object,
      appraisal: { ...APPRAISAL, expectationViolation: 0.9, normCompatibility: 0.2, agency: "other" },
    });
    const next = emotionReappraisalFromEpisode(repaired, resolveSoulConfig({}));
    expect(next).not.toBeNull();
    const merged = reappraiseEmotion(original, next!);
    expect(merged.id).toBe(original.id);
    expect(merged.at).toBe(original.at);
    expect(merged.object).toBe(original.object);
    expect(reappraisalDiffers(original, next)).toBe(true);
    // 同一标签不算重评（避免把「还是那个情绪」写成两条账）。
    expect(reappraisalDiffers(original, { ...original })).toBe(false);
  });
});

describe("归因门不把「他在场」当成「他在怪我」", () => {
  it("他提不同意见（agency=other、otherCause=true）落不安，不落委屈", () => {
    const e = appraiseEmotion({
      at: "2026-11-06T00:00:00.000Z",
      object: "召回链路",
      appraisal: {
        goalRelevance: 0.47,
        expectationViolation: 0.65,
        control: 0.3,
        normCompatibility: 0.35,
        agency: "other",
      },
    });
    // 门只补「他造成的」（otherCause），不替他补「他在怪我」（otherBlame）。
    expect(e.appraisal.otherCause).toBe(true);
    expect(e.appraisal.otherBlame).not.toBe(true);
    expect(e.label).toBe("不安");
  });

  it("我按方案开工（agency=self、selfCause=true）落笃定，不因为「我造成的」就认错", () => {
    const e = appraiseEmotion({
      at: "2026-11-06T00:00:00.000Z",
      object: "召回链路",
      appraisal: {
        goalRelevance: 0.84,
        expectationViolation: 0.25,
        control: 0.75,
        normCompatibility: 0.8,
        agency: "self",
      },
    });
    expect(e.appraisal.selfCause).toBe(true);
    expect(e.appraisal.selfFault).not.toBe(true);
    expect(e.label).toBe("笃定");
  });

  it("他当面追责（otherBlame）仍然落委屈/恼火，不被这次拆分抹平", () => {
    const wronged = appraiseEmotion({
      at: "2026-11-06T00:00:00.000Z",
      object: "召回链路",
      appraisal: {
        goalRelevance: 0.4,
        expectationViolation: 0.75,
        control: 0.7,
        normCompatibility: 0.6,
        agency: "other",
        otherCause: true,
        exculpated: true,
      },
    });
    expect(wronged.label).toBe("委屈");
    const angry = appraiseEmotion({
      at: "2026-11-06T00:00:00.000Z",
      object: "召回链路",
      appraisal: {
        goalRelevance: 0.4,
        expectationViolation: 0.75,
        control: 0.7,
        normCompatibility: 0.2,
        agency: "other",
        otherCause: true,
        otherBlame: true,
      },
    });
    expect(angry.label).toBe("恼火");
  });
});
