/**
 * 身份采纳门第二轮（REG-REMAINING-002 #2）：状态残留剥离——枚举式 + 结构式双道。
 * 契约：枚举表述剥离；日期引用（\d{4}[-年]）与阶段编号（P\d）命中 → 剥离所在句；
 * 干净身份内容逐位保留；整条提案全是状态陈述 → 空串（整体拒收）。
 */
import { describe, expect, it } from "vitest";
import { stripIdentityStateResidue } from "../identity-discovery.js";

describe("身份采纳门 stripIdentityStateResidue", () => {
  it("第一轮枚举：已知状态表述字面剥离", () => {
    expect(stripIdentityStateResidue("TDB 核心开发者（当前进行中：A6 修复）。")).toBe(
      "TDB 核心开发者。",
    );
    expect(stripIdentityStateResidue("记忆系统维护者（截至 2026-09-15）。")).toBe(
      "记忆系统维护者。",
    );
  });

  it("第二轮结构：日期引用句剥离（枚举之外的新表述也拦得住）", () => {
    const input = "他是记忆系统的核心开发者与维护者。项目于 2026-09-16 进入新阶段。坚守源码掌控。";
    expect(stripIdentityStateResidue(input)).toBe(
      "他是记忆系统的核心开发者与维护者。坚守源码掌控。",
    );
  });

  it("第二轮结构：阶段编号句剥离（P1/P4a 等）", () => {
    const input = "负责记忆系统的实现与部署。当前推进到 P4a 阶段。注重回归验证。";
    expect(stripIdentityStateResidue(input)).toBe("负责记忆系统的实现与部署。注重回归验证。");
  });

  it("年月形式（2026年9月）同样命中日期判据", () => {
    const input = "自托管工程师。自 2026年9月起深入记忆系统。";
    expect(stripIdentityStateResidue(input)).toBe("自托管工程师。");
  });

  it("干净身份内容逐位保留（角色/职责/纪律不受影响）", () => {
    const text = "AI 是该 TDB fork 记忆进化项目的实现工程师：亲自承担编码、测试、回归验证与部署重启。";
    expect(stripIdentityStateResidue(text)).toBe(text);
  });

  it("整条提案全是状态陈述 → 空串（整体拒收信号）", () => {
    expect(stripIdentityStateResidue("P1-P3 已完成，P4 进行中，2026-09-16 开始观察期。")).toBe("");
  });

  it("枚举与结构叠加：混合内容只留干净句", () => {
    const input = "记忆系统实现工程师。P2 失效设施已上线（进入观察期）。绝不派子代理执行开发任务。";
    expect(stripIdentityStateResidue(input)).toBe("记忆系统实现工程师。绝不派子代理执行开发任务。");
  });
});
