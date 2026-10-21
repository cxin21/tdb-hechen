import { describe, it, expect, vi, beforeEach } from "vitest";
import { warnTurnContextMissing, __resetTurnContextWarnForTests } from "../sentinel.js";
import { log } from "../../report/log.js";

// Me1（审查 4544dc9d）：injector 注释宣称 turnContext 缺失有哨兵+loud 日志兜底，
// 实现无 else 静默回落 legacy。修复=限频 warn（每会话 60s 一次），让
// 「档位已开但 handler 未接线」可观测、防静默。
describe("warnTurnContextMissing - 限频告警（Me1）", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetTurnContextWarnForTests();
    warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
  });

  it("同会话 60s 内只告警一次", () => {
    warnTurnContextMissing("sess-warn-1", "intent");
    warnTurnContextMissing("sess-warn-1", "intent");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toBe("dsh-recall-turn-context-missing");
  });

  it("不同会话各自告警", () => {
    warnTurnContextMissing("sess-warn-2", "intent");
    warnTurnContextMissing("sess-warn-3", "shadow");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
