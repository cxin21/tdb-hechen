import { describe, it, expect } from "vitest";
import { classifyCardinality, isSupersessionEligible } from "./cardinality.js";

/**
 * #136 属性契约：只有单值属性（同一时刻只有一个值）允许 supersession。
 * 判据优先级：显式 → 单值词表 → 多值动词线索 → 值结构线索 → 缺省 single。
 */
describe("#136 cardinality 契约", () => {
  it("显式标注优先于一切启发式", () => {
    expect(classifyCardinality("followers", "1250", "multi").cardinality).toBe("multi");
    expect(classifyCardinality("is considering", "a trip", "single").cardinality).toBe("single");
  });

  it("单值：计数/联系方式/个人属性（中英）", () => {
    for (const p of ["Instagram followers", "粉丝数", "city", "phone number", "年龄", "住在哪个城市"]) {
      expect(classifyCardinality(p, "1250").cardinality).toBe("single");
    }
  });

  it("多值：模态/意愿动词（#136 评论里的误失效谓词）", () => {
    for (const p of ["is considering", "wants to create", "has a book club member", "likes", "打算", "计划去"]) {
      expect(classifyCardinality(p, "something").cardinality).toBe("multi");
    }
  });

  it("多值：泛化系动词/动作谓词（不是函数依赖——#136 实测残留）", () => {
    for (const p of ["has", "feels", "is currently reading", "uses", "replaced", "has made"]) {
      expect(classifyCardinality(p, "something").cardinality).toBe("multi");
    }
  });

  it("多值：值本身并列（or/and/、/，/also）", () => {
    expect(classifyCardinality("activity", "yoga or pilates").cardinality).toBe("multi");
    expect(classifyCardinality("关注项目", "健身、读书").cardinality).toBe("multi");
    // 单值词表优先级高于值线索：粉丝数即使并列描述也不是多值
    expect(classifyCardinality("followers", "1250 and 1300").cardinality).toBe("single");
  });

  it("缺省保覆盖：未知谓词按单值处理（= #136 前的逐位行为），并给出理由", () => {
    const verdict = classifyCardinality("quantum flux", "42");
    expect(verdict.cardinality).toBe("single");
    expect(verdict.reason).toMatch(/default|缺省/);
  });

  it("英文 cue 卡词边界：language 不因 age 命中单值词表（reason 可观测）", () => {
    expect(classifyCardinality("age", "30")).toMatchObject({ cardinality: "single", reason: "single-cue:age" });
    expect(classifyCardinality("language", "English").reason).toBe("default-single");
    expect(classifyCardinality("entitled", "x").reason).toBe("default-single");
    expect(classifyCardinality("account", "abc").reason).toBe("single-cue:account");
  });

  it("优先级锁定：谓词同时含单值与泛化动词线索时，单值词表先命中（保 knowledge-update）", () => {
    expect(classifyCardinality("has 1,250 followers", "1250")).toMatchObject({ cardinality: "single" });
    expect(classifyCardinality("has 1,250 followers", "1250").reason).toMatch(/^single-cue:/);
    expect(classifyCardinality("feels proud of their 1250 fans", "1250")).toMatchObject({ cardinality: "single" });
  });

  it("只有单值可被 supersession 失效", () => {
    expect(isSupersessionEligible("single")).toBe(true);
    expect(isSupersessionEligible("multi")).toBe(false);
  });
});
