/**
 * #141（2026-10-28）：查询意图分类 + 分阶段策略（纯规则）。
 *
 * 背景（票面第一性原理①）：三机制同阶段竞争——结论卡与 turn 行承载同一知识，
 * 只能零和替换。分阶段的前提是「先知道问题要什么表示」：
 *   精确事实/时间推理 → turn 优先（答案在原文，时间戳也在原文）
 *   聚合/更新/偏好 → 结论优先（结论卡就是跨轮聚合/最新值）
 *   回忆 assistant 输出 → 整层跳过（#138 已落地）
 * 规则宁缺毋滥：无明确线索 → "default"（沿用现状上限，不做任何路由动作）。
 */
import { describe, expect, it } from "vitest";

import { classifyRecallIntent, recallIntentPolicy } from "../query-intent.js";

describe("#141 query-intent：classifyRecallIntent", () => {
  it("assistant-recall：复用 #138 判定（整层跳过）", () => {
    expect(classifyRecallIntent("Can you remind me what the recommended ratio was?")).toBe("assistant-recall");
    expect(classifyRecallIntent("你上次推荐的那家店叫什么？")).toBe("assistant-recall");
    expect(recallIntentPolicy("assistant-recall").conclusionBudget).toBe(0);
  });

  it("temporal：何时/多久/先后类 → turn 优先、结论上限 1", () => {
    const hits = [
      "How long did I wait for the decision on my asylum application?",
      "When did I start learning to play the guitar?",
      "What day did I book the flight?",
      "我上个月的计划是什么时候提交的？",
      "多久之后才收到回复？",
    ];
    for (const q of hits) expect(classifyRecallIntent(q), q).toBe("temporal");
    const p = recallIntentPolicy("temporal");
    expect(p.order).toBe("turn-first");
    expect(p.conclusionBudget).toBe(1);
    expect(p.pairing).toBe(true);
  });

  it("update：现在/最新/不再 → 结论优先、结论上限 2", () => {
    const hits = [
      "What is my current internet plan?",
      "Which editor am I using now?",
      "我现在用的编辑器是哪个？",
      "最新的部署方案还支持旧接口吗？",
    ];
    for (const q of hits) expect(classifyRecallIntent(q), q).toBe("update");
    const p = recallIntentPolicy("update");
    expect(p.order).toBe("conclusion-first");
    expect(p.conclusionBudget).toBe(2);
  });

  it("aggregate：多少/列举/汇总 → 结论优先、结论上限 2", () => {
    const hits = [
      "How many books did I read last year?",
      "List all the places I visited in Japan.",
      "我一共参加了多少次面试？",
      "都有哪些工具推荐过？",
    ];
    for (const q of hits) expect(classifyRecallIntent(q), q).toBe("aggregate");
    expect(recallIntentPolicy("aggregate").conclusionBudget).toBe(2);
  });

  it("preference：推荐/偏好/适合 → 结论优先、结论上限 1", () => {
    const hits = [
      "Can you recommend some activities I can do during my commute?",
      "What is my favorite type of cuisine?",
      "有什么适合我的运动建议？",
    ];
    for (const q of hits) expect(classifyRecallIntent(q), q).toBe("preference");
    expect(recallIntentPolicy("preference").conclusionBudget).toBe(1);
  });

  it("exact-fact：单实体单属性问句 → turn 优先、结论预算 0（票面口径）", () => {
    const hits = [
      "What speed is my new internet plan?",
      "Who is my manager at work?",
      "我的车是什么颜色的？",
    ];
    for (const q of hits) expect(classifyRecallIntent(q), q).toBe("exact-fact");
    const p = recallIntentPolicy("exact-fact");
    expect(p.order).toBe("turn-first");
    // 票面 W3：exact-fact=0——答案在原文行上，摘要只会丢细节。
    expect(p.conclusionBudget).toBe(0);
    expect(p.pairing).toBe(false);
  });

  it("default：无线索 → 不设结论上限（沿用现状）、不成对、不仲裁", () => {
    expect(classifyRecallIntent("I've been feeling a bit stuck with my paintings lately.")).toBe("default");
    expect(classifyRecallIntent("")).toBe("default");
    expect(classifyRecallIntent(undefined as unknown as string)).toBe("default");
    const p = recallIntentPolicy("default");
    expect(p.conclusionBudget).toBeUndefined();
    expect(p.order).toBe("conclusion-first");
    // intent 模式下 default 是绝大多数题的落点：必须逐位退化，不能偷偷开成对/仲裁。
    expect(p.pairing).toBe(false);
    expect(p.arbitrate).toBe(false);
  });

  it("优先级：assistant-recall > temporal > update > aggregate > preference", () => {
    // 含 "how many"（aggregate）+ "you said"（assistant-recall）→ assistant-recall 胜
    expect(classifyRecallIntent("How many eggs did you say we needed?")).toBe("assistant-recall");
    // 含 "how long"（temporal）+ "now"（update）→ temporal 胜（问的是时长跨度）
    expect(classifyRecallIntent("How long has it been since I moved?")).toBe("temporal");
  });
});
