/**
 * A1 · L2 运行后状态决策（Lead 补口，2026-11-02）。
 *
 * 病灶（builder-scene 交付时自曝的越界项）：pipeline-manager.runL2 在**非首轮 skip** 时
 * 仍把 l2_last_extraction_time 重打成 now（pipeline-manager.ts:964-966）。门一拦下就把
 * 「距上次成功抽取」清零 ⇒ 时间门永远不会到期，生产的调度路径上只剩条数门。
 *
 * 契约（decideL2PostRun）：
 *  T1 门拦下（reason="l2-gate"）→ recordSuccess=false（不刷新时间戳/不推 minInterval 基准），
 *     resetPending=false（records 未被消费，未处理计数必须继续累积）。
 *  T2 legacy 冷启动 skip（首轮无增量）→ recordSuccess=false、resetPending=true（逐位今天）。
 *  T3 legacy 非首轮 skip → 逐位今天：recordSuccess=true、resetPending=true。
 *  T4 正常跑完 / 无返回值 → recordSuccess=true、resetPending=true。
 */
import { describe, expect, it } from "vitest";

import { decideL2PostRun, isL2GateSkip, isL2ThrottleSkip } from "../l2-gate.js";

describe("isL2GateSkip", () => {
  it("F2：reason=l2-throttle 也算「门拦下」", () => {
    expect(isL2GateSkip({ skipped: true, reason: "l2-throttle" })).toBe(true);
  });

  it("reason=l2-gate 才认；其余形态一律 false", () => {
    expect(isL2GateSkip({ skipped: true, reason: "l2-gate" })).toBe(true);
    expect(isL2GateSkip({ skipped: true })).toBe(false);
    expect(isL2GateSkip({ skipped: false, reason: "l2-gate" })).toBe(false);
    expect(isL2GateSkip({ skipped: true, reason: "no-records" })).toBe(false);
    expect(isL2GateSkip(undefined)).toBe(false);
    expect(isL2GateSkip(null)).toBe(false);
  });
});

describe("decideL2PostRun · 门拦下不得刷新“上次成功 L2”", () => {
  it("T1 gate skip → 不记成功、不清 pending", () => {
    expect(decideL2PostRun({ skipped: true, reason: "l2-gate" })).toEqual({
      recordSuccess: false,
      resetPending: false,
    });
  });

  it("T1 边界：isFirstRun 不影响门拦下的语义（门是门，与冷启动无关）", () => {
    expect(decideL2PostRun({ skipped: true, reason: "l2-gate" }, { isFirstRun: true })).toEqual({
      recordSuccess: false,
      resetPending: false,
    });
    expect(decideL2PostRun({ skipped: true, reason: "l2-gate" }, { isFirstRun: false })).toEqual({
      recordSuccess: false,
      resetPending: false,
    });
  });

  it("T2 legacy 冷启动 skip → 不记成功但清 pending（逐位今天）", () => {
    expect(decideL2PostRun({ skipped: true }, { isFirstRun: true })).toEqual({
      recordSuccess: false,
      resetPending: true,
    });
  });

  it("T3 legacy 非首轮 skip → 记成功并清 pending（逐位今天）", () => {
    expect(decideL2PostRun({ skipped: true }, { isFirstRun: false })).toEqual({
      recordSuccess: true,
      resetPending: true,
    });
  });

  it("T5 F2 全局速率门拦下（reason=l2-throttle）→ 与 A1 门同语义：不记成功、不清 pending", () => {
    expect(decideL2PostRun({ skipped: true, reason: "l2-throttle" })).toEqual({
      recordSuccess: false,
      resetPending: false,
    });
    expect(decideL2PostRun({ skipped: true, reason: "l2-throttle" }, { isFirstRun: true })).toEqual({
      recordSuccess: false,
      resetPending: false,
    });
    expect(isL2ThrottleSkip({ skipped: true, reason: "l2-throttle" })).toBe(true);
    expect(isL2ThrottleSkip({ skipped: true, reason: "l2-gate" })).toBe(false);
    expect(isL2ThrottleSkip({ skipped: true })).toBe(false);
  });

  it("T4 正常跑完 / 无返回 → 记成功并清 pending", () => {
    expect(decideL2PostRun({ latestCursor: "2026-11-02T00:00:00Z" })).toEqual({
      recordSuccess: true,
      resetPending: true,
    });
    expect(decideL2PostRun(undefined)).toEqual({ recordSuccess: true, resetPending: true });
  });
});
