/**
 * A1 Round12：降级是「状态迁移」，不是每 tick 再打一次折。
 *
 * 复核（r23-a1）发现 planLifecycle 对已 degraded 的行也乘 degradeWeightFactor：
 * 10 分钟一次的维护会把权重按 0.7^n 塌向 0，分数永远回不到稳态，而 90 天的冻结
 * 判定又依赖权重（不是只看天数）。这里钉两件事：
 *   ① 第二个 tick 不再折权重；
 *   ② 权重保住之后，90 天仍然能冻结（老化路径可达）。
 */
import { describe, it, expect } from "vitest";
import { resolveSoulConfig, type PersonaItem } from "../types.js";
import { planLifecycle } from "../persona.js";

const CFG = resolveSoulConfig({});
const NOW = "2026-11-05T12:00:00.000Z";

function item(lastEvidenceAt: string, weight = 0.8): PersonaItem {
  return {
    itemId: "self:w",
    layer: "self",
    text: "没亲手跑过的不写成已验证",
    state: "active",
    weight,
    evidenceIds: ["r1"],
    evidenceDays: [lastEvidenceAt.slice(0, 10)],
    evidenceOrigins: ["l1"],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    lastEvidenceAt,
    contradictions: 0,
  };
}

describe("人格条目老化（A1 Round12）", () => {
  it("越过 30 天后降级只折一次权重，重复 tick 不再塌陷", () => {
    const stale = item("2026-09-20T12:00:00.000Z"); // 46 天
    const d1 = planLifecycle([stale], NOW, CFG).items[0];
    expect(d1.state).toBe("degraded");
    expect(d1.weight).toBeCloseTo(stale.weight * CFG.degradeWeightFactor, 3);

    const d2 = planLifecycle([d1], NOW, CFG).items[0];
    expect(d2.state).toBe("degraded");
    // 关键断言：再跑一次不改权重（旧实现会变成 wt × 0.7²）
    expect(d2.weight).toBeCloseTo(d1.weight, 6);
  });

  it("权重不再塌陷之后，90 天仍然冻结（老化路径可达）", () => {
    const stale = item("2026-09-20T12:00:00.000Z");
    const d = planLifecycle([stale], NOW, CFG).items[0];
    const later = "2027-01-05T00:00:00.000Z"; // 107 天
    const f = planLifecycle([d], later, CFG).items[0];
    expect(f.state).toBe("frozen");
    expect(f.validTo).toBe(later);
    // 冻结也要折一次权重（frozen 不再维护，只作历史）
    expect(f.weight).toBeCloseTo(d.weight * 0.5, 3);
  });
});
