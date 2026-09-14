import { describe, expect, it } from "vitest";
import { evolveCandidate, evolvePersona, DEFAULT_PERSONA_CONFIG } from "../persona-evolution.js";

describe("M persona 演进（反漂移/observed 红线）", () => {
  it("significant+observed+minObserved → 提议并入", () => {
    const { proposed, deferred } = evolveCandidate(
      [{ content: "用户偏好本地化方案", significance: 0.9, certainty: "observed", observedCount: 3 }],
      "",
      DEFAULT_PERSONA_CONFIG,
    );
    expect(proposed).toHaveLength(1);
    expect(deferred).toHaveLength(0);
  });

  it("significance 不足 → defer（防漂移）", () => {
    const { proposed, deferred } = evolveCandidate(
      [{ content: "一次反常", significance: 0.1, certainty: "observed", observedCount: 1 }],
      "",
      DEFAULT_PERSONA_CONFIG,
    );
    expect(proposed).toHaveLength(0);
    expect(deferred).toHaveLength(1);
  });

  it("inferred 不得冒充 observed → defer", () => {
    const { proposed } = evolveCandidate(
      [{ content: "推断的", significance: 0.9, certainty: "inferred", observedCount: 5 }],
      "",
      DEFAULT_PERSONA_CONFIG,
    );
    expect(proposed).toHaveLength(0);
  });

  it("观察次数不足(minObserved) → defer", () => {
    const { proposed } = evolveCandidate(
      [{ content: "只见过一次", significance: 0.9, certainty: "observed", observedCount: 1 }],
      "",
      { ...DEFAULT_PERSONA_CONFIG, minObserved: 2 },
    );
    expect(proposed).toHaveLength(0);
  });

  it("增量子器不重复并入旧 persona", () => {
    const next = evolvePersona("旧画像：喜欢本地", { proposed: ["喜欢本地", "新增一条"], deferred: [] });
    expect(next).toContain("喜欢本地");
    expect(next).not.toContain("旧画像：喜欢本地\n- 喜欢本地");
  });
});