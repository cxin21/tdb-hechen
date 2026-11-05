/**
 * 自维护人格层（m00527）单测 E：情绪/心境确定性模型。
 *
 * 关注三件事（都是「人格谎言」的高发点）：
 *  1) 情绪必须有对象——L1 只有正文摘要时从首句抽话题短语；抽不到就不写原因，绝不编造对象；
 *  2) 对象抽取的确定性清洗（弹头/引用符/句读/代词/超长截断）；
 *  3) 心境只报相对基线的偏离，不报绝对档位。
 */
import { describe, expect, it } from "vitest";
import {
  deriveEmotionObject,
  emotionFromSignal,
  emptyMood,
  integrateMood,
  readMood,
  renderMoodLine,
  appraiseEmotion,
  moodBiasLine,
} from "../emotion.js";

const NOW = "2026-11-05T02:00:00.000Z";
const CFG = { emotionHalfLifeHours: 3 };

describe("deriveEmotionObject（情绪对象抽取）", () => {
  it("取首句、去弹头与引用符、去尾标点", () => {
    const out = deriveEmotionObject("- [strict_rule] 「何晨要求先取证」，否则不许改代码。第二句忽略");
    expect(out.startsWith("何晨要求先取证")).toBe(true);
    expect(out).not.toContain("第二句");
    expect(out).not.toContain("。");
    expect(deriveEmotionObject("* 召回链路漏投影")).toBe("召回链路漏投影");
  });

  it("空/纯代词/超短 → 空串（没有对象就不算情绪）", () => {
    expect(deriveEmotionObject(null)).toBe("");
    expect(deriveEmotionObject("   ")).toBe("");
    expect(deriveEmotionObject("用户")).toBe("");
    expect(deriveEmotionObject("我")).toBe("");
    expect(deriveEmotionObject("。")).toBe("");
  });

  it("超长话题截断到 24 字并加省略号（不把整段记录搬进 prompt）", () => {
    const out = deriveEmotionObject("我在云文库窄栏重设计中确立了取舍：先留白再压缩层级，最后再谈动效与配色的细节");
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(25);
  });
});

describe("情绪 → 心境", () => {
  it("信号带摘要时情绪有对象，readMood 才写原因", () => {
    const ev = emotionFromSignal(
      { valence: -0.8, arousal: 0.6, occurred_at: "2026-11-05T01:00:00.000Z", excerpt: "假绿被当场指出" },
      NOW,
      CFG,
    );
    expect(ev.object).toBe("假绿被当场指出");
    const mood = integrateMood(null, [ev], "2026-11-05T01:10:00.000Z", { moodHalfLifeHours: 48, emotionHalfLifeHours: 3 } as never);
    const line = renderMoodLine(mood, { emotion: { ...ev, effectiveIntensity: 0.9 }, threshold: 0.15 });
    expect(line).toContain("因为「假绿被当场指出」");
  });

  it("任务标题式的长摘要 → 退回稳定反馈类别，不把一次性任务写成长期偏见", () => {
    const ev = emotionFromSignal(
      { valence: -0.8, arousal: 0.6, occurred_at: "2026-11-05T01:00:00.000Z", excerpt: "AI于2026-11-05完成工作区切换相关修复与回归验证" },
      NOW,
      CFG,
    );
    expect(ev.object).toBe("最近一次否定");
    const mood = integrateMood(null, [ev], "2026-11-05T01:10:00.000Z", { moodHalfLifeHours: 48, emotionHalfLifeHours: 3 } as never);
    expect(renderMoodLine(mood, { emotion: { ...ev, effectiveIntensity: 0.9 }, threshold: 0.15 })).toContain("因为「最近一次否定」");
  });

  it("无摘要 → object 空，行内不出现「因为」（不编造）", () => {
    const ev = emotionFromSignal({ valence: -0.8, arousal: 0.6, occurred_at: "2026-11-05T01:00:00.000Z" }, NOW, CFG);
    expect(ev.object).toBe("");
    const mood = integrateMood(null, [ev], "2026-11-05T01:10:00.000Z", { moodHalfLifeHours: 48, emotionHalfLifeHours: 3 } as never);
    expect(renderMoodLine(mood, { emotion: { ...ev, effectiveIntensity: 0.9 }, threshold: 0.15 })).not.toContain("因为");
  });

  it("心境无对象也成立：无事件时回归基线、短语为「比基线平稳」", () => {
    const mood = integrateMood(null, [], NOW, { moodHalfLifeHours: 48, emotionHalfLifeHours: 3 } as never);
    const reading = readMood(mood, { threshold: 0.15 });
    expect(reading.phrase).toBe("比基线平稳");
    expect(reading.reason).toBeUndefined();
  });

  it("结构化评估：同样的负向事件，可控=恼火/不可控=不安（不是关键词猜情绪）", () => {
    const controllable = appraiseEmotion({
      at: NOW,
      object: "门禁",
      appraisal: { goalRelevance: 0.2, expectationViolation: 0.8, control: 0.9, normCompatibility: 1, agency: "other" },
    });
    const uncontrollable = appraiseEmotion({
      at: NOW,
      object: "门禁",
      appraisal: { goalRelevance: 0.2, expectationViolation: 0.8, control: 0.1, normCompatibility: 1, agency: "other" },
    });
    expect(controllable.label).not.toBe(uncontrollable.label);
    expect(controllable.valence).toBeLessThan(0);
    expect(uncontrollable.valence).toBeLessThan(0);
  });

  it("心境影响判断：偏移够大且有对象才给一次倾向，且正负方向不混", () => {
    const ep = { episodeId: "ep-1", object: "门禁", at: NOW } as never;
    const down = { ...emptyMood(NOW), valence: -0.6, baselineValence: 0 };
    const up = { ...emptyMood(NOW), valence: 0.6, baselineValence: 0 };
    expect(moodBiasLine(down, { episode: ep, threshold: 0.15 })).toContain("防着「门禁」");
    expect(moodBiasLine(up, { episode: ep, threshold: 0.15 })).toContain("多走一步");
    // 没有对象 / 偏移不够 → 不伪造倾向
    expect(moodBiasLine(down, { episode: { episodeId: "ep-1", object: "", at: NOW } as never, threshold: 0.15 })).toBeNull();
    expect(moodBiasLine({ ...down, valence: -0.05 }, { episode: ep, threshold: 0.15 })).toBeNull();
  });

  it("空心境基线：zero valence、arousal 0.3，不与「当前值」混同", () => {
    const m = emptyMood(NOW);
    expect(m.baselineValence).toBe(0);
    expect(m.baselineArousal).toBe(0.3);
    expect(m.sampleCount).toBe(0);
  });
});
