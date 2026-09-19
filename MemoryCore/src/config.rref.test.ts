/**
 * F-EV12-4（REG-REMAINING-006 A-4）：reflection.rRef clamp 下限 10→1。
 * 实锤：config.ts:1034 Math.max(10,…) 使 yaml rRef: 2（注释意图"2.0≈3 条高显著记录"）
 * 被静默钳到 10——配置值与生效值背离（2026-09-19 审计 G-31 发现）。
 */
import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

describe("lifecycle.reflection.rRef clamp（F-EV12-4）", () => {
  it("yaml rRef=2 原样生效（不被下限 10 吞掉）", () => {
    const c = parseConfig({ lifecycle: { reflection: { enabled: true, rRef: 2 } } });
    expect((c.lifecycle as unknown as { reflection: { rRef: number } }).reflection.rRef).toBe(2);
  });
  it("缺省仍回落 150；上界 100000 钳制保持；下界 1", () => {
    const d = parseConfig({});
    expect((d.lifecycle as unknown as { reflection: { rRef: number } }).reflection.rRef).toBe(150);
    const hi = parseConfig({ lifecycle: { reflection: { rRef: 999999 } } });
    expect((hi.lifecycle as unknown as { reflection: { rRef: number } }).reflection.rRef).toBe(100000);
    const lo = parseConfig({ lifecycle: { reflection: { rRef: 0 } } });
    expect((lo.lifecycle as unknown as { reflection: { rRef: number } }).reflection.rRef).toBe(1);
  });
});
