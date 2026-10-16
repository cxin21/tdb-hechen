/**
 * #37（S16/R5 首交付物，2026-10-16）：灵魂分层块接口——类型与缺省值的运行时合同。
 * 语义文档见 docs/soul-block-interface.md；类型单一源在 ../types.ts。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOUL_TIMING,
  INJECTION_POINTS,
  SOUL_BLOCK_KINDS,
  type InjectionPoint,
  type SoulBlockKind,
  type SoulTimingConfig,
} from "../types.js";

describe("#37 soul 分层块接口", () => {
  it("三块类型冻结：soul.head / soul.tail / soul.event", () => {
    expect(SOUL_BLOCK_KINDS).toEqual(["soul.head", "soul.tail", "soul.event"]);
    // 类型级合同（编译期保证，运行时断言防意外放宽）
    const kinds: readonly SoulBlockKind[] = SOUL_BLOCK_KINDS;
    expect(kinds.length).toBe(3);
  });

  it("tools.before_call 已进挂点清单（红线事件块挂点；分发层接线前 no-op）", () => {
    expect(INJECTION_POINTS.filter((p) => p === "tools.before_call")).toHaveLength(1);
    const point: InjectionPoint = "tools.before_call";
    expect(point).toBe("tools.before_call");
  });

  it("DEFAULT_SOUL_TIMING=现状逐位（identity/redline=session_head, feeling=every_turn, driftTrigger=off）", () => {
    expect(DEFAULT_SOUL_TIMING).toEqual({
      identity: "session_head",
      redline: "session_head",
      feeling: "every_turn",
      driftTrigger: "off",
    } satisfies SoulTimingConfig);
  });
});
