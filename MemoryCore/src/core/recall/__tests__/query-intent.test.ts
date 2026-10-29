/**
 * #138（2026-10-28）：assistantRecall 查询意图检测（纯规则）单测。
 *
 * 契约：只在「回忆 assistant 自己先前的输出」时命中；纯「请求新建议」（Can you recommend…、
 * Any tips…）必须不命中——否则会误杀 preference / user 桶。
 */
import { describe, expect, it } from "vitest";

import { isAssistantRecallQuery } from "../query-intent.js";

describe("#138 query-intent：isAssistantRecallQuery", () => {
  it("命中：明确回忆 assistant 先前输出（LME90 assistant 桶原句）", () => {
    const hits = [
      "I remember you told me to dilute tea tree oil with a carrier oil before applying it. Can you remind me what the recommended ratio was?",
      "I'm planning another trip to New York City and I was wondering if you could remind me of that vegan eatery you recommended last time?",
      "I was going through our previous chat and I was wondering, what was Andy wearing in the script you wrote for the comedy movie scene?",
      "I was going through our previous conversation about making a classic French omelette, and I wanted to confirm - how many eggs did you say we needed?",
      "你上次推荐的那家店叫什么？",
    ];
    for (const q of hits) expect(isAssistantRecallQuery(q), q).toBe(true);
  });

  it("不命中：请求新建议（preference 桶原句）", () => {
    const miss = [
      "I've been feeling a bit stuck with my paintings lately. Do you have any ideas on how I can find new inspiration?",
      "Can you recommend some recent publications or conferences that I might find interesting?",
      "Can you suggest some activities I can do during my commute to work?",
      "Any tips for keeping my kitchen clean?",
      "帮我推荐一些学习视频剪辑的资源",
    ];
    for (const q of miss) expect(isAssistantRecallQuery(q), q).toBe(false);
  });

  it("不命中：用户侧事实回忆（user 桶，无第二人称/无 assistant 输出线索）", () => {
    const miss = [
      "What did I buy for my sister's birthday gift?",
      "How long did I wait for the decision on my asylum application?",
      "What speed is my new internet plan?",
    ];
    for (const q of miss) expect(isAssistantRecallQuery(q), q).toBe(false);
  });

  it("边界：空串/非字符串/仅建议前缀", () => {
    expect(isAssistantRecallQuery("")).toBe(false);
    expect(isAssistantRecallQuery(undefined as unknown as string)).toBe(false);
    expect(isAssistantRecallQuery("Can you recommend ")).toBe(false);
  });
});
