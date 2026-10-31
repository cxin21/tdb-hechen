/**
 * #172-②：注入块包裹语三档（legacy / neutral / calibrated）单一源。
 *
 * 硬口径：
 *  - 缺省 = calibrated（WP1b 翻转；legacy/neutral 都被判「诱导拒答」）——undefined / 未知值
 *    一律回落 INJECT_WRAPPER_DEFAULT 文案；
 *  - calibrated 不得含「仅作为参考」这类贬抑措辞，也不得写「可能相关」式免责；
 *  - 三档文案逐字钉死（线上注入文案变更必须走测试）。
 */
import { describe, expect, it } from "vitest";
import { INJECT_WRAPPER_DEFAULT, INJECT_WRAPPER_HEADS, injectWrapperHeadOf, injectWrapperModeOf } from "../inject-wrapper.js";

describe("#172-② 注入包裹语三档", () => {
  it("缺省 = calibrated（WP1b 翻转，回滚改单一常量）", () => {
    expect(INJECT_WRAPPER_DEFAULT).toBe("calibrated");
    expect(injectWrapperModeOf(undefined)).toBe("calibrated");
    expect(injectWrapperHeadOf(undefined)).toBe(INJECT_WRAPPER_HEADS.calibrated);
    expect(INJECT_WRAPPER_HEADS.calibrated).not.toContain("仅作为参考");
  });

  it("三档文案互不相同且逐字钉死", () => {
    expect(INJECT_WRAPPER_HEADS.legacy).toBe("以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：");
    expect(INJECT_WRAPPER_HEADS.neutral).toBe(
      "以下是与当前对话可能相关的历史对话记忆（按时间先后排列）。请结合当前对话使用这些记忆；若记忆不足以回答，请如实说明。",
    );
    expect(INJECT_WRAPPER_HEADS.calibrated).toBe("以下是与问题相关的历史记忆，请据此回答；若信息不足再说明。");
  });

  it("calibrated：不诱导拒答（无「仅作为参考」/「可能相关」免责），且给出正向指令", () => {
    const head = injectWrapperHeadOf("calibrated");
    expect(head).not.toContain("仅作为参考");
    expect(head).not.toContain("可能相关的历史对话记忆");
    expect(head).toContain("请据此回答");
    expect(head).toContain("若信息不足再说明");
  });

  it("legacy 仍可按显式档回滚；未知值回落当前缺省", () => {
    expect(injectWrapperModeOf("legacy")).toBe("legacy");
    expect(injectWrapperHeadOf("legacy")).toContain("仅作为参考");
    expect(injectWrapperModeOf("neutral")).toBe("neutral");
    expect(injectWrapperHeadOf("neutral")).toContain("若记忆不足以回答，请如实说明");
    expect(injectWrapperModeOf("calibrated")).toBe("calibrated");
    expect(injectWrapperModeOf("bogus")).toBe("calibrated");
    expect(injectWrapperModeOf(null)).toBe("calibrated");
    expect(injectWrapperHeadOf(42)).toBe(INJECT_WRAPPER_HEADS.calibrated);
  });
});
