import { describe, it, expect } from "vitest";
import { computeSupersessions } from "./supersession.js";

/**
 * W2（issue #134）：写时双时态 supersession——同实体同属性新值标记旧值失效。
 * 契约（逐片 TDD 累积）：
 *  - 同（subject, predicate）后值 ≠ 前值 → 旧 turn 出 op，validEnd = 新 turn 时间戳
 *  - 只标记不删除：函数只产出「标记 op」，由调用方写 valid_end
 */
describe("computeSupersessions", () => {
  const fact = (subject: string, predicate: string, value: string) => ({ subject, predicate, value });

  it("同实体同属性后值不同 → 标记旧行失效（validEnd=后值时间戳）", () => {
    const ops = computeSupersessions([
      { turnId: "t1", timestamp: "2023-05-01T10:00:00", facts: [fact("User", "Instagram followers", "1250")] },
      { turnId: "t2", timestamp: "2023-06-01T10:00:00", facts: [fact("User", "Instagram followers", "1300")] },
    ]);
    expect(ops).toEqual([
      {
        turnId: "t1",
        validEnd: "2023-06-01T10:00:00",
        supersededByTurnId: "t2",
        subject: "User",
        predicate: "Instagram followers",
        oldValue: "1250",
        newValue: "1300",
        // #136：op 携带基数（只有 single 会产出 op）
        cardinality: "single",
      },
    ]);
  });

  it("同值重复陈述不产生失效标记", () => {
    const ops = computeSupersessions([
      { turnId: "t1", timestamp: "2023-05-01T10:00:00", facts: [fact("User", "Instagram followers", "1250")] },
      { turnId: "t2", timestamp: "2023-06-01T10:00:00", facts: [fact("User", "Instagram followers", "1250")] },
    ]);
    expect(ops).toEqual([]);
  });

  it("输入乱序 → 按时间戳推演（后值仍是后值）", () => {
    const ops = computeSupersessions([
      { turnId: "t2", timestamp: "2023-06-01T10:00:00", facts: [fact("User", "Instagram followers", "1300")] },
      { turnId: "t1", timestamp: "2023-05-01T10:00:00", facts: [fact("User", "Instagram followers", "1250")] },
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ turnId: "t1", validEnd: "2023-06-01T10:00:00", supersededByTurnId: "t2" });
  });

  it("同一行的两个键被先后取代 → 合并为一条，valid_end 取最早", () => {
    const ops = computeSupersessions([
      { turnId: "t1", timestamp: "2023-05-01T10:00:00", facts: [fact("User", "Instagram followers", "1250"), fact("User", "city", "Paris")] },
      { turnId: "t2", timestamp: "2023-06-01T10:00:00", facts: [fact("User", "Instagram followers", "1300")] },
      { turnId: "t3", timestamp: "2023-07-01T10:00:00", facts: [fact("User", "city", "Berlin")] },
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ turnId: "t1", validEnd: "2023-06-01T10:00:00", predicate: "Instagram followers" });
  });

  it("实体/属性大小写与空白差异视为同键；值同值不失效", () => {
    const ops = computeSupersessions([
      { turnId: "t1", timestamp: "2023-05-01T10:00:00", facts: [fact("user", "instagram   followers", "1250")] },
      { turnId: "t2", timestamp: "2023-06-01T10:00:00", facts: [fact("User", "Instagram Followers", "1250")] },
    ]);
    expect(ops).toEqual([]);
  });

  it("缺时间戳的 turn 不参与推演；空 value / 缺实体属性的事实忽略", () => {
    const ops = computeSupersessions([
      { turnId: "t1", timestamp: "", facts: [fact("User", "followers", "1250")] },
      { turnId: "t2", timestamp: "2023-05-01T10:00:00", facts: [fact("User", "followers", "1300")] },
      { turnId: "t3", timestamp: "2023-06-01T10:00:00", facts: [fact("User", "followers", ""), fact("", "x", "1"), fact("User", "", "2")] },
    ]);
    expect(ops).toEqual([]);
  });
});