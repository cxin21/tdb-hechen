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
  appraisalFromEpisode,
  moodBiasLine,
  objectRecurrence,
  extractAffectReferent,
  counterfactualStance,
  moodAttention,
  isReusableAffectObject,
  decayedIntensity,
  decayedStoredIntensity,
  isEmotionExpired,
  isStoredEmotionExpired,
  pickCurrentEmotion,
  moodFocusOf,
  templateHalfLifeHours,
  rankLabelsByPad,
  EMOTION_HALF_LIFE_SCALE,
  EMOTION_PAD_NEAR_MAX,
  EMOTION_LABELS,
  EMOTION_TEMPLATE_VERSION,
  EMOTION_EXPIRY_INTENSITY,
} from "../emotion.js";

const NOW = "2026-11-05T02:00:00.000Z";
const CFG = { emotionHalfLifeHours: 3 };

/** 时间推进只靠算 ISO 字符串，不改系统时钟、不 sleep。 */
const addHours = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * 3600_000).toISOString();

describe("可复用情境对象（2026-11-06 补全：六情绪都要说得出原因）", () => {
  it.each([
    ["builder 微提交任务：t10 adversary 裁决 PASS-WITH-CONCERNS（1 MEDIUM+3 INFO）", "公开裁决"],
    ["裁决 PASS-WITH-CONCERNS（2 LOW+3 INFO），Lead 定夺：C1+C2 必修", "公开裁决"],
    ["除了rerank云端凭据外其他都做，按生产级标准落地并测试", "生产级标准"],
    ["这处不对不是我弄的，你别错怪我", "被错怪"],
    ["他开始不太放心，信不过我这条链路", "他对我的信任"],
  ])("%s → %s", (text, want) => {
    expect(extractAffectReferent(text)).toBe(want);
    expect(isReusableAffectObject(want)).toBe(true);
  });

  it("甩锅类必须先于通用「不对」判，否则委屈永远拿不到原因", () => {
    expect(extractAffectReferent("这里还是不对，但不是我弄的")).toBe("被错怪");
  });
});


describe("整句关系陈述不能当情绪原因（t21/F4）", () => {
  it.each([
    ["他是林夏的师父"],
    ["她就是隔壁组的负责人"],
    ["我和他吵了一架"],
    ["你跟他只是同事"],
    ["用户（姓名未提供）在评审中坚持门禁必须亲手执行"],
    ["我在评审中坚持门禁必须亲手执行"],
  ])("%s → 不是可复用对象", (object) => {
    expect(isReusableAffectObject(object)).toBe(false);
  });

  it.each([["导出报错"], ["这个报错堆栈"], ["公开裁决"], ["生产级标准"], ["他对我的信任"]])(
    "%s → 仍可复用（不许误伤正常短语）",
    (object) => {
      expect(isReusableAffectObject(object)).toBe(true);
    },
  );

  it("命中时 readMood 不写原因，只报读数——整句陈述不再被永久写进心境", () => {
    const mood = { valence: -0.15, arousal: 0.2, baselineValence: 0, baselineArousal: 0.3, updatedAt: NOW, sampleCount: 10 };
    const hit = readMood(mood, { emotion: { object: "他是林夏的师父", label: "失望", effectiveIntensity: 0.2 } });
    expect(hit.reason).toBeUndefined();
    const keep = readMood(mood, { emotion: { object: "导出报错", label: "失望", effectiveIntensity: 0.2 } });
    expect(keep.reason).toContain("导出报错");
  });
});

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

  it("超长原句不截断充数：超过 24 字直接不算对象（不把整段记录搬进 prompt）", () => {
    // 去掉句内标点，确保测的是「长度上界」而不是「在首个分句被切开」。
    expect(deriveEmotionObject("我在云文库窄栏重设计中确立了取舍先留白再压缩层级最后再谈动效与配色的细节")).toBe("");
  });

  it("按首个中文标点截断：逗号/顿号/冒号也算分句边界", () => {
    expect(deriveEmotionObject("召回链路漏投影，下一轮再修")).toBe("召回链路漏投影");
    expect(deriveEmotionObject("何晨要求先取证：不许改代码")).toBe("何晨要求先取证");
    expect(deriveEmotionObject("注入预算、裁剪顺序都重排了")).toBe("注入预算");
  });

  it("指令式开头剥掉：必须/需要/应该/请… 不是情绪原因", () => {
    expect(deriveEmotionObject("必须把召回链路修好")).toBe("把召回链路修好");
    expect(deriveEmotionObject("请你先取证，再改代码")).toBe("你先取证");
    expect(deriveEmotionObject("应该先看实测数字")).toBe("先看实测数字");
  });

  it("泛化指代拒绝当锚：这件事/这个问题不是对象", () => {
    expect(deriveEmotionObject("这件事")).toBe("");
    expect(deriveEmotionObject("这个问题")).toBe("");
    expect(isReusableAffectObject("这件事")).toBe(false);
    expect(isReusableAffectObject("上述问题")).toBe(false);
  });

  it("21–24 字的原句不再落进「截断后仍超上界」的死区", () => {
    // 21–24 字：旧实现原样返回（≤24），却被可复用判据的 20 字上界整句拒掉。
    const raw22 = "他把注入预算和裁剪顺序连同人格层次序一起重排";
    expect(raw22.length).toBeGreaterThanOrEqual(21);
    expect(isReusableAffectObject(deriveEmotionObject(raw22))).toBe(true);
    const raw24 = "这处改动把注入预算与裁剪顺序连同层次序一起重排了";
    expect(raw24.length).toBeLessThanOrEqual(24);
    expect(isReusableAffectObject(deriveEmotionObject(raw24))).toBe(true);
  });
});

describe("情绪 → 心境", () => {
  it("信号带摘要时情绪有对象，readMood 才写原因", () => {
    const ev = emotionFromSignal(
      { valence: -0.8, arousal: 0.6, occurred_at: "2026-11-05T01:00:00.000Z", excerpt: "假绿被当场指出" },
      NOW,
      CFG,
    );
    expect(ev.object).toBe("假绿");
    const mood = integrateMood(null, [ev], "2026-11-05T01:10:00.000Z", { moodHalfLifeHours: 48, emotionHalfLifeHours: 3 } as never);
    const line = renderMoodLine(mood, { emotion: { ...ev, effectiveIntensity: 0.9 }, threshold: 0.15 });
    expect(line).toContain("因为「假绿」");
  });

  it("任务标题整段不能当对象，但被指出的错、被要求守住的事必须抽出来", () => {
    expect(extractAffectReferent("列表按钮状态处理不对，选中了为什么派发不可点")).toBe("被当面指出不对");
    // task-27/P2-2：姓名硬编码已删。识别人称主语（「X 说/指出/要求…」）后返回代词「他」：
    // 名字属于数据，代码里不写死；没有可信姓名源时也不凭一句话编一个名字出来。
    expect(extractAffectReferent("何晨说先取证，否则不许改代码")).toBe("他");
    expect(extractAffectReferent("假绿被当场指出")).toBe("假绿");
    const pointed = emotionFromSignal(
      { valence: -0.8, arousal: 0.6, occurred_at: "2026-11-05T01:00:00.000Z", excerpt: "列表按钮状态处理不对，选中了为什么派发不可点" },
      NOW,
      CFG,
    );
    expect(pointed.object).toBe("被当面指出不对");
    const garbage = [
      "AI于2026-11-05完成工作区切换相关修复与回归验证",
      "[Compressed conversation section] — 任务与文档定位",
      "<system-reminder> The following workspace instructions",
      "继续 D:/TDB/td-agemem 的自维护人格系统",
    ];
    for (const excerpt of garbage) {
      const ev = emotionFromSignal(
        { valence: -0.8, arousal: 0.6, occurred_at: "2026-11-05T01:00:00.000Z", excerpt },
        NOW,
        CFG,
      );
      expect(ev.object, excerpt).toBe("");
      expect(ev.object).not.toMatch(/最近一次/);
    }
    const mood = integrateMood(null, [], "2026-11-05T01:10:00.000Z", { moodHalfLifeHours: 48, emotionHalfLifeHours: 3 } as never);
    const line = renderMoodLine(mood, {
      emotion: { object: "最近一次否定", label: "失望", effectiveIntensity: 0.9 },
      threshold: 0.15,
    });
    expect(line).not.toContain("最近一次");
    expect(line).not.toContain("因为");
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

  it("拟人情绪：同一件被指出的错，当众是害羞，私下归因自己是愧疚，归因对方是委屈", () => {
    const base = { goalRelevance: 0.7, expectationViolation: 0.8, control: 0.4, normCompatibility: 0.8 };
    const shy = appraiseEmotion({
      at: NOW,
      object: "被当面指出不对",
      appraisal: { ...base, agency: "self", socialExposure: "public", selfCause: false, otherCause: false },
    });
    const guilt = appraiseEmotion({
      at: NOW,
      object: "被当面指出不对",
      appraisal: { ...base, agency: "self", socialExposure: "private", selfCause: true, otherCause: false },
    });
    const wronged = appraiseEmotion({
      at: NOW,
      object: "被当面指出不对",
      appraisal: { ...base, agency: "other", socialExposure: "private", selfCause: false, otherCause: true },
    });
    expect(shy.label).toBe("害羞");
    expect(guilt.label).toBe("愧疚");
    expect(wronged.label).toBe("委屈");
    expect(new Set([shy.label, guilt.label, wronged.label]).size).toBe(3);
  });

  it("拟人情绪：被夸奖是开心，收口之后是安心，不是同一个正向读数", () => {
    const praised = appraiseEmotion({
      at: NOW,
      object: "何晨",
      appraisal: { goalRelevance: 0.8, expectationViolation: 0.1, control: 0.7, normCompatibility: 1, agency: "other", socialExposure: "public", selfCause: false, otherCause: true },
    });
    const settled = appraiseEmotion({
      at: NOW,
      object: "假绿",
      appraisal: { goalRelevance: 0.6, expectationViolation: 0.1, control: 0.8, normCompatibility: 1, agency: "self", socialExposure: "private", selfCause: true, otherCause: false },
    });
    expect(praised.label).toBe("开心");
    expect(settled.label).toBe("安心");
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

  it("同一对象复发过，即使心境已回到基线，也照样给判断（判断跟对象史走，不只看偏移）", () => {
    const ep = { episodeId: "ep-1", object: "被当面指出不对", at: NOW } as never;
    const flat = { ...emptyMood(NOW), valence: 0.01, baselineValence: 0 };
    const hits = [
      { object: "被当面指出不对", intensity: 0.6, valence: -0.5, repaired: false },
      { object: "被当面指出不对", intensity: 0.7, valence: -0.6, repaired: true },
    ];
    expect(moodBiasLine(flat, { episode: ep, threshold: 0.15 })).toBeNull();
    expect(moodBiasLine(flat, { episode: ep, threshold: 0.15, hits })).toContain("被当面指出不对");
  });

  it("同一对象再次出现：次数、强度、修复会让判断可观测地不同", () => {
    const first = objectRecurrence([
      { object: "假绿", intensity: 0.4, valence: -0.4, repaired: false },
    ]);
    const again = objectRecurrence([
      { object: "假绿", intensity: 0.4, valence: -0.4, repaired: false },
      { object: "假绿", intensity: 0.8, valence: -0.7, repaired: false },
    ]);
    const repaired = objectRecurrence([
      { object: "假绿", intensity: 0.8, valence: -0.7, repaired: false },
      { object: "假绿", intensity: 0.5, valence: 0.4, repaired: true },
    ]);
    expect(first.count).toBe(1);
    expect(again.count).toBe(2);
    expect(again.peak).toBeGreaterThan(first.peak);
    expect(again.stance).not.toBe(first.stance);
    expect(repaired.repaired).toBe(true);
    expect(repaired.stance).not.toBe(again.stance);
    const latestOpen = objectRecurrence([
      { object: "假绿", intensity: 0.8, valence: -0.7, repaired: true, at: "2026-08-01T00:00:00.000Z" },
      { object: "假绿", intensity: 0.5, valence: -0.4, repaired: false, at: "2026-11-06T00:00:00.000Z" },
    ]);
    expect(latestOpen.repaired).toBe(false);
    expect(latestOpen.stance).not.toContain("先核对修复");
    const line = renderMoodLine(
      { valence: 0, arousal: 0.3, baselineValence: 0, baselineArousal: 0.3, updatedAt: NOW, sampleCount: 2, objectStance: again.stance },
      { threshold: 0.15 },
    );
    expect(line).toContain("先挡一下");
    expect(line).not.toContain("先核对修复");
    expect(repaired.stance).toContain("先核对修复");
    expect(again.stance).toContain("先挡");
  });

  it("反事实：同一句「先做还是先核」，有假绿史和没有，判断不同", () => {
    const cf = counterfactualStance("这次先做还是先核？上次假绿被当面指出。", [
      { object: "假绿", intensity: 0.8, valence: -0.7 },
      { object: "假绿", intensity: 0.5, valence: -0.4 },
    ]);
    expect(cf.withoutHistory).toContain("没有这段史");
    expect(cf.withHistory).not.toBe(cf.withoutHistory);
    expect(cf.differs).toBe(true);
    const empty = counterfactualStance("这次先做还是先核？", []);
    expect(empty.differs).toBe(false);
  });

  it("生产原话也要算出不同情绪：指出不对且我补上是愧疚，只回进度是委屈，被夸是开心，我自己收口是安心", () => {
    const guilt = appraisalFromEpisode({
      userStance: "这两栏设置卡片内部布局有点问题，和边界的间距不对",
      agentStance: "设置页的间距与缩进已按同一条 16px 轨道对齐，六页都逐项量过",
      valence: -0.55,
      arousal: 0.5,
    });
    const wronged = appraisalFromEpisode({
      userStance: "列表按钮状态处理不对，选中了为什么派发不可点",
      agentStance: "改名已经全部落地",
      valence: -0.55,
      arousal: 0.5,
    });
    const joy = appraisalFromEpisode({
      userStance: "这次改得好，就按这个来",
      agentStance: "收到",
      valence: 0.4,
      arousal: 0.4,
    });
    const relief = appraisalFromEpisode({
      userStance: "继续",
      agentStance: "六页都逐项量过，收口了",
      valence: 0.3,
      arousal: 0.3,
    });
    expect(appraiseEmotion({ at: NOW, object: "被当面指出不对", appraisal: guilt }).label).toBe("愧疚");
    expect(appraiseEmotion({ at: NOW, object: "被当面指出不对", appraisal: wronged }).label).toBe("委屈");
    expect(appraiseEmotion({ at: NOW, object: "何晨", appraisal: joy }).label).toBe("开心");
    expect(appraiseEmotion({ at: NOW, object: "收口", appraisal: relief }).label).toBe("安心");
  });

  it("事件原话能算出评价：当众被指出是害羞，我认错是愧疚，对方造成是委屈", () => {
    const shy = appraisalFromEpisode({
      userStance: "当着大家的面指出：这里不对",
      agentStance: "我改",
      valence: -0.6,
      arousal: 0.6,
    });
    const guilt = appraisalFromEpisode({
      userStance: "这是你没做到",
      agentStance: "我错了，我重做",
      valence: -0.6,
      arousal: 0.4,
    });
    const wronged = appraisalFromEpisode({
      userStance: "都是你的问题",
      agentStance: "这不是我造成的",
      valence: -0.5,
      arousal: 0.4,
    });
    expect(appraiseEmotion({ at: NOW, object: "被当面指出不对", appraisal: shy }).label).toBe("害羞");
    expect(appraiseEmotion({ at: NOW, object: "被当面指出不对", appraisal: guilt }).label).toBe("愧疚");
    expect(appraiseEmotion({ at: NOW, object: "被当面指出不对", appraisal: wronged }).label).toBe("委屈");
  });

  it("情绪不止四个：道谢是感激，当众做成是自豪，被催是着急，说算了是无奈", () => {
    const good = { goalRelevance: 0.8, expectationViolation: 0.1, control: 0.7, normCompatibility: 1 };
    const bad = { goalRelevance: 0.6, expectationViolation: 0.7, control: 0.6, normCompatibility: 0.6 };
    const grateful = appraiseEmotion({
      at: NOW,
      object: "何晨",
      appraisal: { ...good, agency: "other", otherCause: true, otherCost: true },
    });
    const proud = appraiseEmotion({
      at: NOW,
      object: "六页对齐",
      appraisal: { ...good, agency: "self", selfCause: true, socialExposure: "public" },
    });
    const hurried = appraiseEmotion({
      at: NOW,
      object: "今晚要",
      appraisal: { ...bad, agency: "other", otherCause: true, urgency: true },
    });
    const resigned = appraiseEmotion({
      at: NOW,
      object: "这个方案",
      appraisal: { ...bad, agency: "other", otherCause: true, resignation: true },
    });
    expect(grateful.label).toBe("感激");
    expect(proud.label).toBe("自豪");
    // 同一件做成的事：私下没人看见是开心，当众收口才是自豪。不能只有一个正向读数。
    const glad = appraiseEmotion({
      at: NOW,
      object: "四道门禁",
      appraisal: {
        ...good,
        goalRelevance: 0.9,
        agency: "self",
        selfCause: true,
        achievement: true,
        socialExposure: "private",
      },
    });
    const gladPublic = appraiseEmotion({
      at: NOW,
      object: "四道门禁",
      appraisal: {
        ...good,
        goalRelevance: 0.9,
        agency: "self",
        selfCause: true,
        achievement: true,
        socialExposure: "public",
      },
    });
    expect(glad.label).toBe("开心");
    expect(gladPublic.label).toBe("自豪");
    expect(hurried.label).toBe("着急");
    expect(resigned.label).toBe("无奈");
    expect(new Set([grateful.label, proud.label, hurried.label, resigned.label]).size).toBe(4);
    // 回归（2026-11-06 P0）：当众说「算了」必须仍是无奈，不能因为 public+self+violated
    // 先命中害羞而把「我不争了」写成「我不好意思」。两个标签对应完全不同的行为倾向。
    const resignedPublic = appraiseEmotion({
      at: NOW,
      object: "这个方案",
      appraisal: {
        ...bad,
        agency: "self",
        selfCause: true,
        resignation: true,
        socialExposure: "public",
      },
    });
    expect(resignedPublic.label).toBe("无奈");
  });

  it("情绪决定注意力方向：愧疚向内看自己、恼火向外看冲突、安心看修复；无有效对象不偏", () => {
    const base = { ...emptyMood(NOW), sampleCount: 3, updatedAt: NOW };
    const at = (object: string, label: string) => ({ ...base, emotion: { object, label, intensity: 0.8, at: NOW } });
    expect(moodAttention(at("按钮组样式", "愧疚"))).toEqual({ object: "按钮组样式", focus: "self" });
    expect(moodAttention(at("按钮组样式", "害羞"))).toEqual({ object: "按钮组样式", focus: "self" });
    expect(moodAttention(at("按钮组样式", "恼火"))).toEqual({ object: "按钮组样式", focus: "conflict" });
    expect(moodAttention(at("按钮组样式", "委屈"))).toEqual({ object: "按钮组样式", focus: "conflict" });
    expect(moodAttention(at("按钮组样式", "安心"))).toEqual({ object: "按钮组样式", focus: "repair" });
    // 「最近一次肯定/否定」是可复用对象判据里的假对象——注意力也不许被它带偏
    expect(moodAttention(at("最近一次否定", "愧疚")).focus).toBe("none");
    expect(moodAttention(base).focus).toBe("none");
  });

  it("情绪过期后，同一对象近一周的历史标签仍决定先看哪一层（但不写原因）", () => {
    const base = { ...emptyMood(NOW), sampleCount: 3, updatedAt: NOW };
    const past = { ...base, historyEmotion: { object: "被当面指出不对", label: "愧疚", at: NOW } };
    expect(moodAttention(past)).toEqual({ object: "被当面指出不对", focus: "self" });
    // 在场情绪优先：现在恼火着，就先看冲突，而不是上周那条愧疚
    const both = {
      ...base,
      emotion: { object: "按钮组样式", label: "恼火", intensity: 0.8, at: NOW },
      historyEmotion: { object: "被当面指出不对", label: "愧疚", at: NOW },
    };
    expect(moodAttention(both)).toEqual({ object: "按钮组样式", focus: "conflict" });
    // 历史里的假对象同样不成立
    expect(
      moodAttention({ ...base, historyEmotion: { object: "最近一次肯定", label: "开心", at: NOW } }).focus,
    ).toBe("none");
  });

  it("问句不能当情绪对象：把整句「这个是不是没必要了」当原因，心境行就成了对一次性任务的偏见", () => {
    const ask = "这个是不是没必要了，和待人工卡片重复了";
    expect(isReusableAffectObject(ask)).toBe(false);
    expect(extractAffectReferent(ask)).toBe("");
    expect(isReusableAffectObject("这个是否重复")).toBe(false);
  });

  it("只有说话框的对象不算原因：「你说」指的是对话本身，换一句就失效", () => {
    for (const s of ["你说", "我说过", "他刚才讲", "你回答道"]) expect(isReusableAffectObject(s)).toBe(false);
    // 真对象照旧放行，别为了这一条把正常短语也挡了
    expect(isReusableAffectObject("导出报错")).toBe(true);
    expect(isReusableAffectObject("他")).toBe(true);
  });

  it("空心境基线：zero valence、arousal 0.3，不与「当前值」混同", () => {
    const m = emptyMood(NOW);
    expect(m.baselineValence).toBe(0);
    expect(m.baselineArousal).toBe(0.3);
    expect(m.sampleCount).toBe(0);
  });
});

describe("情绪扩充（2026-11-06）：释然/尴尬/失落/烦躁/欣慰/同情各有独立触发条件", () => {
  const base = { goalRelevance: 0.5, expectationViolation: 0.1, control: 0.5, normCompatibility: 0.9 };
  const label = (appraisal: Parameters<typeof appraiseEmotion>[0]["appraisal"]) =>
    appraiseEmotion({ at: NOW, object: "这次的事", appraisal }).label;

  it("违背后解除是释然，不是开心；当众出岔子但不是我的锅是尴尬，不是委屈", () => {
    expect(label({ ...base, expectationViolation: 0.45, control: 0.7, agency: "other" })).toBe("释然");
    expect(
      label({
        ...base,
        expectationViolation: 0.8,
        control: 0.4,
        agency: "other",
        socialExposure: "public",
        selfCause: false,
        otherCause: true,
      }),
    ).toBe("尴尬");
  });

  it("环境不配合、我推不动是失落；他造成的但我还拿得住是烦躁；他付了代价但事没成是同情", () => {
    expect(label({ ...base, goalRelevance: 0.3, expectationViolation: 0.8, control: 0.2, agency: "environment" })).toBe(
      "失落",
    );
    expect(
      label({ ...base, expectationViolation: 0.7, control: 0.8, normCompatibility: 0.6, agency: "other", otherCause: true }),
    ).toBe("烦躁");
    expect(label({ ...base, expectationViolation: 0.7, control: 0.4, agency: "other", otherCost: true })).toBe("同情");
  });

  it("我自己把很在意的事做成是欣慰，普通收口仍是安心——两者不是同一个正向读数", () => {
    expect(
      label({ ...base, goalRelevance: 0.85, expectationViolation: 0.1, control: 0.8, agency: "self", selfCause: true }),
    ).toBe("欣慰");
    expect(
      label({ ...base, goalRelevance: 0.6, expectationViolation: 0.1, control: 0.8, agency: "self", selfCause: true }),
    ).toBe("安心");
  });

  it("半衰期按情绪类别走：自我意识类退得慢，高唤醒类退得快（不再所有情绪共用 3h）", () => {
    const guilt = appraiseEmotion({ at: NOW, object: "假绿", appraisal: { ...base, expectationViolation: 0.8, agency: "self", selfCause: true } });
    const angry = appraiseEmotion({ at: NOW, object: "假绿", appraisal: { ...base, expectationViolation: 0.8, control: 0.9, normCompatibility: 0.1, agency: "other", otherCause: true } });
    expect(guilt.label).toBe("愧疚");
    expect(angry.label).toBe("恼火");
    expect(guilt.halfLifeHours).toBeGreaterThan(angry.halfLifeHours);
    const twoHoursLater = new Date(Date.parse(NOW) + 2 * 3600_000).toISOString();
    expect(decayedIntensity(guilt, twoHoursLater)).toBeGreaterThan(decayedIntensity(angry, twoHoursLater));
  });

  it("支配感是第三维：愧疚把「撑得住」压下去，读法里出现「有点被动」", () => {
    const ev = appraiseEmotion({
      at: NOW,
      object: "假绿",
      appraisal: { ...base, goalRelevance: 0.9, expectationViolation: 0.9, control: 0.1, normCompatibility: 0.2, agency: "self", selfCause: true },
    });
    expect(ev.label).toBe("愧疚");
    expect(ev.dominance).toBeLessThan(0.5);
    const mood = integrateMood(emptyMood(NOW), [ev], NOW, { moodHalfLifeHours: 48, emotionHalfLifeHours: 3 } as never);
    const reading = readMood(mood, { threshold: 0.05 });
    expect(reading.deltaDominance).toBeLessThan(0);
    expect(reading.phrase).toContain("有点被动");
  });

  it("混合情绪：主标签之外还剩一条时写成复合名，而不是只报一个标签", () => {
    const mood = {
      ...emptyMood(NOW),
      sampleCount: 3,
      updatedAt: NOW,
      emotion: { object: "假绿", label: "愧疚", intensity: 0.7, at: NOW },
      blend: { label: "着急", intensity: 0.5 },
    };
    const line = renderMoodLine(mood, { threshold: 0.15 });
    expect(line).toContain("愧疚里带着着急（懊恼）");
    const noBlend = renderMoodLine({ ...mood, blend: { label: "着急", intensity: 0.2 } }, { threshold: 0.15 });
    expect(noBlend).not.toContain("里带着");
  });

  it("情绪给一个当场做得到的动作，且只在对象可复用时给（不写无来由的行为指令）", () => {
    const shy = {
      ...emptyMood(NOW),
      sampleCount: 1,
      updatedAt: NOW,
      emotion: { object: "假绿", label: "害羞", intensity: 0.8, at: NOW },
    };
    expect(renderMoodLine(shy, { threshold: 0.15 })).toContain("先摆证据");
    const noObject = { ...shy, emotion: { object: "", label: "害羞", intensity: 0.8, at: NOW } };
    expect(renderMoodLine(noObject, { threshold: 0.15 })).not.toContain("先摆证据");
  });

  it("焦点覆盖全部标签：24 个标签只有「平静」不偏（旧版 12 个标签一律 none）", () => {
    expect(EMOTION_LABELS.length).toBe(24);
    for (const label of EMOTION_LABELS) {
      const focus = moodFocusOf(label);
      if (label === "平静") expect(focus).toBe("none");
      else expect(["self", "conflict", "repair"]).toContain(focus);
    }
    // 旧版漏掉的 12 个逐个钉住方向，避免以后再新增标签又落进 none。
    expect(moodFocusOf("尴尬")).toBe("self");
    expect(moodFocusOf("着急")).toBe("self");
    expect(moodFocusOf("失落")).toBe("self");
    expect(moodFocusOf("烦躁")).toBe("conflict");
    expect(moodFocusOf("无奈")).toBe("conflict");
    expect(moodFocusOf("同情")).toBe("conflict");
    expect(moodFocusOf("释然")).toBe("repair");
    expect(moodFocusOf("欣慰")).toBe("repair");
  });

  it("心境、复发立场、行为提示三句之间不粘在一起", () => {
    const mood = {
      ...emptyMood(NOW),
      sampleCount: 3,
      updatedAt: NOW,
      emotion: { object: "假绿", label: "害羞", intensity: 0.8, at: NOW },
      objectStance: "先核对修复是否还在，再决定要不要挡",
    };
    const line = renderMoodLine(mood, { threshold: 0.15 });
    expect(line).toContain("要不要挡。此刻先摆证据");
    expect(line).not.toContain("要不要挡此刻先摆证据");
    expect(line.endsWith("。")).toBe(true);
  });
});
describe("情绪生命周期（2026-11-06）：原因会到期、落库强度要二次衰减、模板有版本", () => {
  const ev = (over: Partial<ReturnType<typeof appraiseEmotion>> = {}) => ({
    ...appraiseEmotion({
      at: NOW,
      object: "假绿",
      appraisal: { goalRelevance: 0.9, expectationViolation: 0.9, control: 0.2, normCompatibility: 0.2, agency: "self", selfCause: true },
    }),
    ...over,
  });

  it("半衰期按标签查得到；不认识的旧标签回落到缺省而不是崩", () => {
    expect(templateHalfLifeHours("愧疚")).toBeGreaterThan(templateHalfLifeHours("恼火"));
    expect(templateHalfLifeHours("不存在的旧标签", 7)).toBe(7);
  });

  it("模板版本只由标签集合决定（换判据要换版本，旧行才不会被静默改写）", () => {
    expect(EMOTION_TEMPLATE_VERSION).toMatch(/^et-[0-9a-f]{8}$/u);
    // 同一进程内重复导出必须稳定：落库主键含它，抖一次就会翻倍写情绪史。
    expect(EMOTION_TEMPLATE_VERSION).toBe(EMOTION_TEMPLATE_VERSION);
  });

  it("事件到期：衰减到阈值以下、或年龄超过 6 个半衰期，都不再是「此刻的原因」", () => {
    const e = ev();
    expect(isEmotionExpired(e, NOW)).toBe(false);
    const weak = new Date(Date.parse(NOW) - 3 * 3600_000).toISOString();
    expect(isEmotionExpired({ ...e, at: weak, intensity: 0.2 }, NOW)).toBe(false);
    // 年龄超过 6×半衰期（愧疚 8h → 48h）即使原强度再高也过期
    expect(isEmotionExpired({ ...e, at: "2026-10-01T00:00:00.000Z" }, NOW)).toBe(true);
    // 时间解析失败按过期处理，不拿一条读不懂的时间当原因
    expect(isEmotionExpired({ ...e, at: "not-a-date" }, NOW)).toBe(true);
  });

  it("落库强度不重复衰减：asOf 之后到 now 这一段才衰减（写侧已衰过一次）", () => {
    const stored = { label: "愧疚", intensity: 0.4, asOf: NOW };
    expect(decayedStoredIntensity(stored, NOW)).toBeCloseTo(0.4, 6);
    const threeHoursLater = new Date(Date.parse(NOW) + 3 * 3600_000).toISOString();
    const decayed = decayedStoredIntensity(stored, threeHoursLater);
    expect(decayed).toBeLessThan(0.4);
    expect(decayed).toBeGreaterThan(0.4 * 0.5); // 愧疚 4h 半衰期（§5 P3-B 减半后）：3h 后 0.594 > 一半
    // 行到期判据：年龄看 at，强度看 asOf 起的二次衰减
    expect(isStoredEmotionExpired({ label: "愧疚", intensity: 0.4, at: NOW, asOf: NOW }, NOW)).toBe(false);
    expect(
      isStoredEmotionExpired({ label: "愧疚", intensity: 0.4, at: "2026-10-01T00:00:00.000Z", asOf: NOW }, NOW),
    ).toBe(true);
    expect(EMOTION_EXPIRY_INTENSITY).toBeLessThan(0.1);
  });

  it("挑「此刻在场」的那条：活着的优先，过期的不当原因、退回 undefined（只写心境不写原因）", () => {
    const fresh = ev();
    expect(pickCurrentEmotion([fresh], undefined, NOW)?.label).toBe("愧疚");
    const stale = ev({ at: "2026-10-01T00:00:00.000Z" });
    expect(pickCurrentEmotion([stale], undefined, NOW)).toBeUndefined();
    // 假对象（最近一次否定）不能因为「最近」就当原因
    expect(pickCurrentEmotion([{ ...fresh, object: "最近一次否定" }], undefined, NOW)).toBeUndefined();
    // 活跃里没有、但最近一条还活着 → 用最近一条
    expect(pickCurrentEmotion([], fresh, NOW)?.label).toBe("愧疚");
  });
});

describe("§5 P3-B：模板半衰期减半，且读侧 scale 只乘一次", () => {
  it("模板值就是减半后的字面值（不是「旧值 × 0.5」的表达式，也不在读侧再乘一次）", () => {
    // 旧值 → 新值：2→1、4→2、6→3、8→4、12→6。
    expect(templateHalfLifeHours("振奋")).toBe(1);
    expect(templateHalfLifeHours("开心")).toBe(2);
    expect(templateHalfLifeHours("失望")).toBe(3);
    expect(templateHalfLifeHours("愧疚")).toBe(4);
    expect(templateHalfLifeHours("踏实")).toBe(6);
    expect(EMOTION_HALF_LIFE_SCALE).toBe(1);
    // 落库行按标签重算衰减时用的就是这张表：0.4 的「开心」过 3 个半衰期（6h）= 0.05。
    expect(decayedStoredIntensity({ label: "开心", intensity: 0.4, asOf: NOW }, addHours(NOW, 6))).toBeCloseTo(0.05, 3);
    // 反证：若半衰期没减半（4h），6h 后应是 0.4·2^-1.5 = 0.1414，不该出现。
    expect(decayedStoredIntensity({ label: "开心", intensity: 0.4, asOf: NOW }, addHours(NOW, 6))).toBeLessThan(0.1);
  });

  it("高唤醒模板 1h 半衰期：6.5 个半衰期后落到过期线以下（减半前 2h 只衰到 0.105）", () => {
    const at = NOW;
    const later = addHours(NOW, 6.5);
    const e = { label: "振奋", object: "x", intensity: 1, at };
    expect(decayedIntensity({ intensity: 1, at, halfLifeHours: templateHalfLifeHours("振奋") }, later)).toBeCloseTo(
      0.011, 3,
    );
    expect(decayedIntensity({ intensity: 1, at, halfLifeHours: templateHalfLifeHours("振奋") }, later)).toBeLessThan(
      EMOTION_EXPIRY_INTENSITY,
    );
    expect(isEmotionExpired(e, later)).toBe(true);
    // 不减半（2h）时同一点是 0.105，仍高于过期线——这条判据能区分「有没有真的减半」。
    expect(Math.pow(2, -6.5 / 2)).toBeGreaterThan(EMOTION_EXPIRY_INTENSITY);
  });

  it("scale 是观测旋钮：0.5 = 半衰点提前一半，且只衰一次（不叠乘）", () => {
    const ev = { intensity: 1, at: NOW, halfLifeHours: 4 };
    const fourHours = addHours(NOW, 4);
    expect(decayedIntensity(ev, fourHours)).toBeCloseTo(0.5, 6); // 不缩放：4h = 一个半衰期
    expect(decayedIntensity(ev, fourHours, 0.5)).toBeCloseTo(0.25, 6); // 缩放后 4h = 两个半衰期
    expect(decayedIntensity(ev, fourHours, 2)).toBeCloseTo(Math.SQRT1_2, 6); // 反方向同理，不叠加
    // 落库行同口径：scale 只进 effectiveHalfLife 一次（愧疚 4h → 2h，4h 后 = 两个半衰期）。
    expect(decayedStoredIntensity({ label: "愧疚", intensity: 1, asOf: NOW }, fourHours, 0.5)).toBeCloseTo(0.25, 6);
    expect(decayedStoredIntensity({ label: "愧疚", intensity: 1, asOf: NOW }, fourHours)).toBeCloseTo(0.5, 6);
  });
});

describe("§5 P3-C：近邻排序（加权欧氏）——只服务读面与漏斗，不给写入的 label", () => {
  it("同一份 PAD 在余弦下会选错（记录在案的实测）：(0.3,0.4,0.6) 的余弦最近是「自豪」，但它其实是生产里的「平静」", () => {
    // 这条不让 rankLabelsByPad 承担标签职责，只把它当「离哪个锚点更近」的度量；
    // 余弦版本的错误结论（自豪 cos 0.974）保留在这里作为「为什么不用余弦」的活证据。
    const near = rankLabelsByPad({ valence: 0.3, arousal: 0.4, dominance: 0.6 }, 1)[0];
    expect(near.distance).toBeLessThan(EMOTION_PAD_NEAR_MAX);
  });

  it("近邻排序：正中距离 0、全零不命中、k=2 升序（并列按字典序）", () => {
    const joy = rankLabelsByPad({ valence: 0.7, arousal: 0.55, dominance: 0.7 }, 3);
    expect(joy[0].label).toBe("开心");
    expect(joy[0].distance).toBe(0);

    const zero = rankLabelsByPad({ valence: 0, arousal: 0, dominance: 0 }, 2);
    expect(zero).toHaveLength(2);
    for (const r of zero) {
      expect(r.distance).toBeGreaterThan(EMOTION_PAD_NEAR_MAX);
      expect(Number.isFinite(r.distance)).toBe(false); // 没有读数：不是「像谁」，是没有距离
    }

    const two = rankLabelsByPad({ valence: 0.3, arousal: 0.4, dominance: 0.6 }, 2);
    expect(two.map((r) => r.label)).toEqual(["欣慰", "笃定"]);
    expect(two[0].distance).toBeLessThan(two[1].distance);
    expect(two[0].distance).toBeCloseTo(0.1275, 3);
  });
});
