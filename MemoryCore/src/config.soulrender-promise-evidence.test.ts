/**
 * #41（ADR0003-P3 实施票 C）· coreMemory.soulRender.promiseEvidence 解析（config-first 缺省关）。
 *
 * 合同（#41 票面 + ADR0003 D8）：promise 证据门总开关——缺省 false=逐位现状
 * （抽取管线零 promise 读零 promise 写）；显式 true 才开启；非法形状/值回退 false
 * （宁缺毋滥，沿 capabilities/anchorSelect 解析先例）。
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("#41 · coreMemory.soulRender.promiseEvidence 解析", () => {
  it("缺省（无 coreMemory 段）→ enabled=false（逐位现状）", () => {
    const c = parseConfig({});
    expect(c.coreMemory.soulRender.promiseEvidence.enabled).toBe(false);
  });

  it("缺省（有 soulRender 段但无 promiseEvidence 键）→ enabled=false", () => {
    const c = parseConfig({ coreMemory: { soulRender: { budgetSelfChars: 600 } } });
    expect(c.coreMemory.soulRender.promiseEvidence.enabled).toBe(false);
  });

  it("显式 true → enabled=true（开关生效）", () => {
    const c = parseConfig({ coreMemory: { soulRender: { promiseEvidence: { enabled: true } } } });
    expect(c.coreMemory.soulRender.promiseEvidence.enabled).toBe(true);
  });

  it("非法值（非 boolean）→ 回退 false（宁缺毋滥）", () => {
    const c = parseConfig({ coreMemory: { soulRender: { promiseEvidence: { enabled: "on" } } } });
    expect(c.coreMemory.soulRender.promiseEvidence.enabled).toBe(false);
  });

  it("promiseEvidence 形状错误（非对象）→ 回退 false", () => {
    const c = parseConfig({ coreMemory: { soulRender: { promiseEvidence: "x" } } });
    expect(c.coreMemory.soulRender.promiseEvidence.enabled).toBe(false);
  });
});
