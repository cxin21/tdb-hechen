import { describe, it, expect } from "vitest";
import { normalizeConclusionCards } from "./conclusion-card.js";

/**
 * W3（issue #134）：结论卡（work_fact）作为召回候选——LLM 蒸馏输出的规范化/校验。
 * 契约（逐片 TDD 累积）：
 *  - 无有效证据 turn 的卡丢弃（宁缺毋滥：结论必须可回捞到源证据，否则不注入）
 *  - sourceTurnIds 过滤到已知 turn 集、去重、保序
 */
describe("normalizeConclusionCards", () => {
  const known = new Set(["t1", "t2", "t3"]);

  it("有效卡保留，sourceTurnIds 过滤并保序", () => {
    const cards = normalizeConclusionCards(
      { cards: [{ content: "用户在 2023 年 5 月把 Instagram 粉丝数更新到 1300。", sourceTurnIds: ["t2", "unknown", "t1", "t2"] }] },
      { knownTurnIds: known },
    );
    expect(cards).toEqual([
      { content: "用户在 2023 年 5 月把 Instagram 粉丝数更新到 1300。", sourceTurnIds: ["t2", "t1"] },
    ]);
  });

  it("无源证据 / 空内容 / 纯空白卡丢弃", () => {
    const cards = normalizeConclusionCards(
      {
        cards: [
          { content: "无证据的结论", sourceTurnIds: [] },
          { content: "证据全不存在", sourceTurnIds: ["zz"] },
          { content: "   ", sourceTurnIds: ["t1"] },
          { content: "", sourceTurnIds: ["t1"] },
          { content: 42, sourceTurnIds: ["t1"] },
          null,
          "junk",
        ],
      },
      { knownTurnIds: known },
    );
    expect(cards).toEqual([]);
  });

  it("卡数上限 + 内容去重（保留首见）", () => {
    const cards = normalizeConclusionCards(
      {
        cards: [
          { content: "用户在五月把粉丝数更新到 1300。", sourceTurnIds: ["t1"] },
          { content: "用户在五月把粉丝数更新到 1300。", sourceTurnIds: ["t2"] },
          { content: "用户住在上海并养了一只猫。", sourceTurnIds: ["t2"] },
          { content: "用户计划六月去东京旅行。", sourceTurnIds: ["t3"] },
        ],
      },
      { knownTurnIds: known, maxCards: 2 },
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].content).toBe("用户在五月把粉丝数更新到 1300。");
    expect(cards[1].content).toBe("用户住在上海并养了一只猫。");
  });

  it("裸数组入口（无 cards 包装）同款校验；minContentChars 生效", () => {
    const cards = normalizeConclusionCards(
      [
        { content: "短", sourceTurnIds: ["t1"] },
        { content: "用户在五月把粉丝数更新到 1300。", sourceTurnIds: ["t1"] },
      ],
      { knownTurnIds: known, minContentChars: 12 },
    );
    expect(cards).toEqual([{ content: "用户在五月把粉丝数更新到 1300。", sourceTurnIds: ["t1"] }]);
  });

  it("maxCards=0 → 不产出（关断语义）", () => {
    const cards = normalizeConclusionCards(
      { cards: [{ content: "用户在五月把粉丝数更新到 1300。", sourceTurnIds: ["t1"] }] },
      { knownTurnIds: known, maxCards: 0 },
    );
    expect(cards).toEqual([]);
  });
});