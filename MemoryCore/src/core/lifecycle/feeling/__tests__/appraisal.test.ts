import { describe, expect, it } from "vitest";
import { appraise, hasFired, salienceBoost } from "../appraisal.js";

const VALUES = [
  { id: "perf", label: "性能", weight: 0.8 },
  { id: "safety", label: "安全", weight: 0.7 },
];

describe("K/L appraisal（价值锚 + 当前感受）", () => {
  it("命中价值 → fired", () => {
    const res = appraise("我们需要优化性能，不然太慢", VALUES, { enabled: true, firedThreshold: 0.4 });
    const perf = res.find((r) => r.value.id === "perf");
    expect(perf?.fired).toBe(true);
    expect(hasFired(res)).toBe(true);
  });

  it("无关语境 → 无命中、无输出（宁缺毋滥）", () => {
    const res = appraise("今天写一个 hello world", VALUES, { enabled: true, firedThreshold: 0.4 });
    expect(hasFired(res)).toBe(false);
  });

  it("disabled → 不判", () => {
    expect(appraise("性能问题", VALUES, { enabled: false, firedThreshold: 0.4 })).toEqual([]);
  });

  it("权重低于门槛不 fired", () => {
    const res = appraise("提到安全", [{ id: "safety", label: "安全", weight: 0.2 }], { enabled: true, firedThreshold: 0.4 });
    expect(res[0]?.fired).toBe(false);
  });
});

describe("salienceBoost（审计 B1：价值命中 → 遗忘显著性 boost）", () => {
  it("命中价值 → 有正向 boost", () => {
    const b = salienceBoost("性能问题 需要优化", VALUES, { enabled: true, firedThreshold: 0.4 });
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThanOrEqual(0.2);
  });

  it("无关内容 → 0 无影响（宁缺毋滥）", () => {
    expect(salienceBoost("今天写了一个 hello world", VALUES, { enabled: true, firedThreshold: 0.4 })).toBe(0);
  });

  it("无价值锚 / disabled → 0", () => {
    expect(salienceBoost("性能", [], { enabled: true, firedThreshold: 0.4 })).toBe(0);
    expect(salienceBoost("性能", VALUES, { enabled: false, firedThreshold: 0.4 })).toBe(0);
  });
});