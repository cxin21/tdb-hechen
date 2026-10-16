/**
 * #40（ADR0003-P3 接线票 B）· coreMemory.soulRender.capabilities 解析（config-first 缺省关）。
 *
 * 合同（#40 票面验收 1/3 + ADR0003 §6）：soul 前缀 capabilities 段开关——
 * 缺省 false=逐位现状（不渲染「## 我能做什么」）；显式 true 才开启；
 * 非法形状/非法值一律回退 false（宁缺毋滥，沿 anchorSelect/introspect 解析先例）。
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("#40 · coreMemory.soulRender.capabilities 解析", () => {
  it("缺省（无 coreMemory 段）→ enabled=false（逐位现状）", () => {
    const c = parseConfig({});
    expect(c.coreMemory.soulRender.capabilities.enabled).toBe(false);
  });

  it("缺省（有 soulRender 段但无 capabilities 键）→ enabled=false", () => {
    const c = parseConfig({ coreMemory: { soulRender: { budgetSelfChars: 600 } } });
    expect(c.coreMemory.soulRender.capabilities.enabled).toBe(false);
  });

  it("显式 true → enabled=true（开关生效）", () => {
    const c = parseConfig({ coreMemory: { soulRender: { capabilities: { enabled: true } } } });
    expect(c.coreMemory.soulRender.capabilities.enabled).toBe(true);
  });

  it("非法值（非 boolean）→ 回退 false（宁缺毋滥）", () => {
    const c = parseConfig({ coreMemory: { soulRender: { capabilities: { enabled: "yes" } } } });
    expect(c.coreMemory.soulRender.capabilities.enabled).toBe(false);
  });

  it("capabilities 形状错误（非对象）→ 回退 false", () => {
    const c = parseConfig({ coreMemory: { soulRender: { capabilities: "x" } } });
    expect(c.coreMemory.soulRender.capabilities.enabled).toBe(false);
  });
});
