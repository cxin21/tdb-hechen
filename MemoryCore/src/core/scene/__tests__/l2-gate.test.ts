/**
 * A1 · decideL2Gate 纯函数边界（task-4）。
 *
 * 触发门的所有决策都在这里，pipeline-factory 只负责取数+调用，
 * 所以边界（零条、非法配置、从未跑过、时钟回拨、阈值相等）必须在
 * 本文件被逐条钉死。
 */
import { describe, expect, it } from "vitest";

import { L2_GATE_DEFAULT_MIN_INTERVAL_HOURS, L2_GATE_DEFAULT_MIN_PENDING_L1, decideL2Gate } from "../l2-gate.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-02T12:00:00.000Z");

describe("decideL2Gate", () => {
  it("enabled=false（缺省）→ 永不跳过", () => {
    const d = decideL2Gate({ pendingCount: 0, lastExtractionAt: "", nowMs: NOW });
    expect(d.skip).toBe(false);
  });

  it("零条增量 → 即使门关闭也不产生可跑轮次语义（skip 且 reason=l2-gate）", () => {
    const d = decideL2Gate({ enabled: true, pendingCount: 0, lastExtractionAt: "", nowMs: NOW });
    expect(d.skip).toBe(true);
    expect(d.reason).toBe("l2-gate");
  });

  it("未达条数且距上次很近 → 跳过", () => {
    const d = decideL2Gate({
      enabled: true,
      pendingCount: 29,
      lastExtractionAt: new Date(NOW - HOUR).toISOString(),
      nowMs: NOW,
    });
    expect(d.skip).toBe(true);
    expect(d.reason).toBe("l2-gate");
    expect(d.elapsedMs).toBe(HOUR);
  });

  it("条数恰好等于 minPendingL1 → 跑（阈值含等于）", () => {
    const d = decideL2Gate({
      enabled: true,
      pendingCount: L2_GATE_DEFAULT_MIN_PENDING_L1,
      lastExtractionAt: new Date(NOW - HOUR).toISOString(),
      nowMs: NOW,
    });
    expect(d.skip).toBe(false);
  });

  it("距上次恰好等于 minIntervalHours → 跑（时间阈值含等于）", () => {
    const d = decideL2Gate({
      enabled: true,
      pendingCount: 1,
      lastExtractionAt: new Date(NOW - L2_GATE_DEFAULT_MIN_INTERVAL_HOURS * HOUR).toISOString(),
      nowMs: NOW,
    });
    expect(d.skip).toBe(false);
    expect(d.elapsedMs).toBe(L2_GATE_DEFAULT_MIN_INTERVAL_HOURS * HOUR);
  });

  it("从未抽取过（空串/未设置/非法时间串）→ 视为已超时间阈值，跑", () => {
    for (const last of ["", "   ", null, undefined, "not-a-timestamp"]) {
      const d = decideL2Gate({ enabled: true, pendingCount: 1, lastExtractionAt: last, nowMs: NOW });
      expect(d.elapsedMs).toBeNull();
      expect(d.skip).toBe(false);
    }
  });

  it("时钟回拨（last 在未来）→ elapsed 收敛到 0，不出现负值", () => {
    const d = decideL2Gate({
      enabled: true,
      pendingCount: 1,
      lastExtractionAt: new Date(NOW + 5 * HOUR).toISOString(),
      nowMs: NOW,
    });
    expect(d.elapsedMs).toBe(0);
    expect(d.skip).toBe(true);
  });

  it("非法配置回落缺省（NaN/负数/非数字 → 30 条 / 6 小时）", () => {
    const d = decideL2Gate({
      enabled: true,
      pendingCount: 20,
      lastExtractionAt: new Date(NOW - HOUR).toISOString(),
      nowMs: NOW,
      minPendingL1: Number.NaN,
      minIntervalHours: -1,
    });
    expect(d.minPendingL1).toBe(L2_GATE_DEFAULT_MIN_PENDING_L1);
    expect(d.minIntervalHours).toBe(L2_GATE_DEFAULT_MIN_INTERVAL_HOURS);
    expect(d.skip).toBe(true);
  });

  it("minIntervalHours=0 → 时间门恒放开，不拦（运维可关时间维度）", () => {
    const d = decideL2Gate({
      enabled: true,
      pendingCount: 1,
      lastExtractionAt: new Date(NOW).toISOString(),
      nowMs: NOW,
      minPendingL1: 30,
      minIntervalHours: 0,
    });
    expect(d.skip).toBe(false);
  });

  it("minPendingL1=0 → 任意非零增量都跑", () => {
    const d = decideL2Gate({
      enabled: true,
      pendingCount: 1,
      lastExtractionAt: new Date(NOW).toISOString(),
      nowMs: NOW,
      minPendingL1: 0,
      minIntervalHours: 6,
    });
    expect(d.skip).toBe(false);
  });

  it("force=true 绕过门（条数与时间都不满足也跑）", () => {
    const d = decideL2Gate({
      enabled: true,
      pendingCount: 1,
      lastExtractionAt: new Date(NOW - 60_000).toISOString(),
      nowMs: NOW,
      force: true,
    });
    expect(d.skip).toBe(false);
  });
});
