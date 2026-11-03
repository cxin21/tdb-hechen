/**
 * F2 · L2 全局速率门（滑动 60 分钟窗口 + 单轮 session 上限）纯函数契约。
 *
 * 病灶：`pipeline-factory.ts` 的 A1 门只看**单 session** 的 records.length，于是
 * boot recovery 给 242 个 session 各挂一个 L2 timer、每个 backlog≥30 时，同一个
 * tick 会把 242 个 L2 全放出去（16:16:40–16:49:56 实测：35 个不同
 * `scene-extract-<ms>` taskId、224 次 putObject、0 条 "L2 complete"、15691 条
 * "Lock conflict"）。
 *
 * 本模块的判定是纯函数：不读写存储、不起定时器，便于把边界钉死。
 * 缺省（两个上限都 0）⇒ `admit:true` 恒真 = 逐位等于加门之前的行为。
 */
import { describe, expect, it } from "vitest";

import {
  L2_RUN_WINDOW_MS,
  L2_THROTTLE_ROUND_MS,
  L2_THROTTLE_SKIP_REASON,
  decideL2Throttle,
  isL2GateSkip,
  isL2ThrottleSkip,
  pruneL2RunTimestamps,
} from "../l2-gate.js";

const T0 = Date.parse("2026-11-02T08:00:00.000Z");

function base(over: Partial<Parameters<typeof decideL2Throttle>[0]> = {}) {
  return decideL2Throttle({
    maxRunsPerHour: 0,
    maxSessionsPerRound: 0,
    runTimestamps: [],
    inFlight: 0,
    roundAdmitted: 0,
    roundStartedAtMs: 0,
    nowMs: T0,
    ...over,
  });
}

describe("decideL2Throttle · 缺省关 = 逐位现状", () => {
  it("两个上限都 0：恒放行、无 reason、无窗口约束", () => {
    const d = base();
    expect(d.admit).toBe(true);
    expect(d.reason).toBeUndefined();
    expect(d.maxRunsPerHour).toBe(0);
    expect(d.maxSessionsPerRound).toBe(0);
    expect(d.nextSlotAtMs).toBeNull();
    expect(d.windowUsed).toBe(0);
  });

  it("缺省键（undefined）等同 0：恒放行", () => {
    const d = decideL2Throttle({ runTimestamps: [], inFlight: 0, roundAdmitted: 0, nowMs: T0 });
    expect(d.admit).toBe(true);
    expect(d.windowRemaining).toBe(Number.POSITIVE_INFINITY);
    expect(d.roundRemaining).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("decideL2Throttle · 滑动 60 分钟窗口", () => {
  it("窗口内真实运行数达到上限 ⇒ 拦下（reason=l2-throttle）", () => {
    const runs = [T0 - 10_000, T0 - 20_000, T0 - 30_000];
    const d = base({ maxRunsPerHour: 3, runTimestamps: runs });
    expect(d.admit).toBe(false);
    expect(d.reason).toBe(L2_THROTTLE_SKIP_REASON);
    expect(d.windowUsed).toBe(3);
    expect(d.windowRemaining).toBe(0);
    // 最早一次运行滑出窗口的时刻
    expect(d.nextSlotAtMs).toBe(T0 - 30_000 + L2_RUN_WINDOW_MS);
  });

  it("窗口未满 ⇒ 放行，且 nextSlotAtMs 指向最早运行滑出的时刻", () => {
    const d = base({ maxRunsPerHour: 10, runTimestamps: [T0 - 3_600_000] });
    expect(d.admit).toBe(true);
    expect(d.windowUsed).toBe(0); // 恰好 1h 前的运行已滑出窗口
    expect(d.nextSlotAtMs).toBeNull();
  });

  it("滑出窗口的旧运行不占额度（> 1h 的丢弃，== 1h 的也丢弃）", () => {
    const kept = pruneL2RunTimestamps([T0 - L2_RUN_WINDOW_MS - 1, T0 - L2_RUN_WINDOW_MS, T0 - 1], T0);
    expect(kept).toEqual([T0 - 1]);
  });

  it("inFlight（已放行未结算）保守计入窗口，避免并发放行超发", () => {
    const d = base({ maxRunsPerHour: 5, runTimestamps: [T0 - 1, T0 - 2], inFlight: 3 });
    expect(d.windowUsed).toBe(5);
    expect(d.admit).toBe(false);
  });
});

describe("decideL2Throttle · 单轮 session 上限", () => {
  it("本轮已放行数达到上限 ⇒ 拦下，且告知新轮起点", () => {
    const d = base({
      maxSessionsPerRound: 5,
      roundAdmitted: 5,
      roundStartedAtMs: T0 - 10_000,
      nowMs: T0,
    });
    expect(d.admit).toBe(false);
    expect(d.reason).toBe(L2_THROTTLE_SKIP_REASON);
    expect(d.roundRemaining).toBe(0);
    expect(d.roundAdmitted).toBe(5);
    expect(d.roundStartedAtMs).toBe(T0 - 10_000);
  });

  it("本轮时长未满 60s 时不得自行滚动；满 60s ⇒ 新轮从 now 起，额度恢复", () => {
    const stillSameRound = base({
      maxSessionsPerRound: 2,
      roundAdmitted: 2,
      roundStartedAtMs: T0 - (L2_THROTTLE_ROUND_MS - 1),
    });
    expect(stillSameRound.admit).toBe(false);
    expect(stillSameRound.roundAdmitted).toBe(2);

    const rolled = base({
      maxSessionsPerRound: 2,
      roundAdmitted: 2,
      roundStartedAtMs: T0 - L2_THROTTLE_ROUND_MS,
    });
    expect(rolled.admit).toBe(true);
    expect(rolled.roundAdmitted).toBe(0);
    expect(rolled.roundStartedAtMs).toBe(T0);
  });

  it("首次判定（roundStartedAtMs=0）开新一轮", () => {
    const d = base({ maxSessionsPerRound: 1, nowMs: T0 });
    expect(d.admit).toBe(true);
    expect(d.roundStartedAtMs).toBe(T0);
  });

  it("两道门同时生效：窗口与单轮任一满都拦", () => {
    const byWindow = base({ maxRunsPerHour: 1, maxSessionsPerRound: 10, runTimestamps: [T0 - 1] });
    expect(byWindow.admit).toBe(false);
    // 有一条已放行记录 ⇒ 本轮必然已开始（roundStartedAtMs=0 的「无轮次」态不可能带计数）
    const byRound = base({
      maxRunsPerHour: 10,
      maxSessionsPerRound: 1,
      roundAdmitted: 1,
      roundStartedAtMs: T0 - 1_000,
    });
    expect(byRound.admit).toBe(false);
  });
});

describe("skip reason 判定", () => {
  it("throttle skip 与 A1 门 skip 都算「门拦下」（不刷新时间戳/不清 pending）", () => {
    expect(isL2ThrottleSkip({ skipped: true, reason: "l2-throttle" })).toBe(true);
    expect(isL2ThrottleSkip({ skipped: true, reason: "l2-gate" })).toBe(false);
    expect(isL2GateSkip({ skipped: true, reason: "l2-throttle" })).toBe(true);
    expect(isL2GateSkip({ skipped: true, reason: "l2-gate" })).toBe(true);
    expect(isL2GateSkip({ skipped: true, reason: "no-records" })).toBe(false);
  });
});
