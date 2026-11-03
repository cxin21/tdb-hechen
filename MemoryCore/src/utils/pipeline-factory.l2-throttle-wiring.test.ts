/**
 * F2 · createPipelineManager 必须把 persona.l2Gate 透传进 MemoryPipelineManager。
 *
 * 台账里的病灶（242 会话同一 tick 全放行）能发生，一半原因是门根本没被配置到
 * manager；这条用例钉住"配置解析 → factory 映射 → manager 生效"的最后一跳，
 * 变异（删掉 l2Gate 透传）必须让它变红。
 */
import { describe, expect, it } from "vitest";

import type { MemoryTdaiConfig } from "../config.js";
import type { Logger } from "../core/types.js";
import { createPipelineManager } from "./pipeline-factory.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

function cfgWith(gate: { maxRunsPerHour: number; maxSessionsPerRound: number; bootRecoveryWarnSessions: number }) {
  return {
    pipeline: {
      everyNConversations: 5,
      enableWarmup: true,
      l1IdleTimeoutSeconds: 60,
      l2DelayAfterL1Seconds: 90,
      l2MinIntervalSeconds: 900,
      l2MaxIntervalSeconds: 3600,
      sessionActiveWindowHours: 24,
    },
    persona: {
      l2Gate: { enabled: true, minPendingL1: 30, minIntervalHours: 6, ...gate },
    },
  } as unknown as MemoryTdaiConfig;
}

describe("createPipelineManager · F2 全局门透传", () => {
  it("persona.l2Gate 的两个上限与 boot 阈值进入 manager", () => {
    const pm = createPipelineManager(
      cfgWith({ maxRunsPerHour: 12, maxSessionsPerRound: 3, bootRecoveryWarnSessions: 7 }),
      logger as never,
    );
    const stats = pm.getL2ThrottleStats();
    expect(stats.enabled).toBe(true);
    expect(stats.maxRunsPerHour).toBe(12);
    expect(stats.maxSessionsPerRound).toBe(3);
  });

  it("两个上限都 0 ⇒ 门不启用（逐位现状）", () => {
    const pm = createPipelineManager(
      cfgWith({ maxRunsPerHour: 0, maxSessionsPerRound: 0, bootRecoveryWarnSessions: 50 }),
      logger as never,
    );
    expect(pm.getL2ThrottleStats().enabled).toBe(false);
  });
});
