/**
 * T3（方案 Task 3，2026-10-17 未来性渲染面）· coreMemory.soulRender.promises 解析
 * （config-first 缺省关，T6-F1 生产接线）。
 *
 * 合同：promises.enabled——缺省 false=逐位现状（零渲染零查询：listSoulPromises
 * 不被调用）；显式 true 才开启承诺块渲染（「我的承诺：」最新 3 条 open 承诺原文
 * 逐字注入 soul-identity）；非法形状/值回退 false（宁缺毋滥，沿 promiseEvidence
 * 解析先例）。
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("T3/T6-F1 · coreMemory.soulRender.promises 解析", () => {
  it("缺省（无 coreMemory 段）→ enabled=false（逐位现状）", () => {
    const c = parseConfig({});
    expect(c.coreMemory.soulRender.promises.enabled).toBe(false);
  });

  it("缺省（有 soulRender 段但无 promises 键）→ enabled=false", () => {
    const c = parseConfig({ coreMemory: { soulRender: { budgetSelfChars: 600 } } });
    expect(c.coreMemory.soulRender.promises.enabled).toBe(false);
  });

  it("显式 true → enabled=true（开关生效）", () => {
    const c = parseConfig({ coreMemory: { soulRender: { promises: { enabled: true } } } });
    expect(c.coreMemory.soulRender.promises.enabled).toBe(true);
  });

  it("非法值（非 boolean）→ 回退 false（宁缺毋滥）", () => {
    const c = parseConfig({ coreMemory: { soulRender: { promises: { enabled: "on" } } } });
    expect(c.coreMemory.soulRender.promises.enabled).toBe(false);
  });

  it("promises 形状错误（非对象）→ 回退 false", () => {
    const c = parseConfig({ coreMemory: { soulRender: { promises: "x" } } });
    expect(c.coreMemory.soulRender.promises.enabled).toBe(false);
  });
});
