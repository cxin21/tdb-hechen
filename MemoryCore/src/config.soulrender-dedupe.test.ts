/**
 * soul 去重门（soul-dedupe，2026-10-19）· coreMemory.soulRender.{strictRuleDedup,anchorDedup} 解析
 * （config-first 缺省关，沿 anchorSelect.scorer / capabilities 解析先例）。
 * 非法形状/非法值一律回退缺省（宁缺毋滥）。jaccardThreshold clamp 0..1 缺省 0.45
 * （与 soul-dedupe.ts DEFAULT_RULE_JACCARD_THRESHOLD 标定一致）。
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("soulRender.strictRuleDedup 解析（soul-dedupe 门）", () => {
  it("缺省：enabled=false、jaccardThreshold=0.45（逐位现状）", () => {
    const c = parseConfig({ coreMemory: { soulRender: { budgetSelfChars: 600 } } });
    expect(c.coreMemory.soulRender.strictRuleDedup.enabled).toBe(false);
    expect(c.coreMemory.soulRender.strictRuleDedup.jaccardThreshold).toBe(0.45);
  });

  it("显式开启：透传 enabled=true 与合法阈值", () => {
    const c = parseConfig({
      coreMemory: { soulRender: { strictRuleDedup: { enabled: true, jaccardThreshold: 0.6 } } },
    });
    expect(c.coreMemory.soulRender.strictRuleDedup.enabled).toBe(true);
    expect(c.coreMemory.soulRender.strictRuleDedup.jaccardThreshold).toBe(0.6);
  });

  it("阈值 clamp 0..1（1.5→1、-0.2→0）", () => {
    const hi = parseConfig({ coreMemory: { soulRender: { strictRuleDedup: { jaccardThreshold: 1.5 } } } });
    const lo = parseConfig({ coreMemory: { soulRender: { strictRuleDedup: { jaccardThreshold: -0.2 } } } });
    expect(hi.coreMemory.soulRender.strictRuleDedup.jaccardThreshold).toBe(1);
    expect(lo.coreMemory.soulRender.strictRuleDedup.jaccardThreshold).toBe(0);
  });

  it("形状错回退缺省（整组非对象 / 阈值非数值 / enabled 非布尔）", () => {
    const bad = parseConfig({ coreMemory: { soulRender: { strictRuleDedup: "on" } } as never });
    expect(bad.coreMemory.soulRender.strictRuleDedup.enabled).toBe(false);
    expect(bad.coreMemory.soulRender.strictRuleDedup.jaccardThreshold).toBe(0.45);
    const bad2 = parseConfig({
      coreMemory: { soulRender: { strictRuleDedup: { enabled: "yes", jaccardThreshold: "high" } } },
    });
    expect(bad2.coreMemory.soulRender.strictRuleDedup.enabled).toBe(false);
    expect(bad2.coreMemory.soulRender.strictRuleDedup.jaccardThreshold).toBe(0.45);
  });
});

describe("soulRender.anchorDedup 解析（soul-dedupe 门）", () => {
  it("缺省 false=逐位现状；显式 true 才开", () => {
    const def = parseConfig({ coreMemory: { soulRender: { budgetSelfChars: 600 } } });
    expect(def.coreMemory.soulRender.anchorDedup.enabled).toBe(false);
    const on = parseConfig({ coreMemory: { soulRender: { anchorDedup: { enabled: true } } } });
    expect(on.coreMemory.soulRender.anchorDedup.enabled).toBe(true);
    const bad = parseConfig({ coreMemory: { soulRender: { anchorDedup: { enabled: "yes" } } } });
    expect(bad.coreMemory.soulRender.anchorDedup.enabled).toBe(false);
    const bad2 = parseConfig({ coreMemory: { soulRender: { anchorDedup: "on" } } as never });
    expect(bad2.coreMemory.soulRender.anchorDedup.enabled).toBe(false);
  });
});
