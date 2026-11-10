import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

describe("coreMemory.selfIdentity / soulRender（P1 双槽）", () => {
  it("缺省：selfIdentity.enabled=false（config-first 逐位现状）", () => {
    const c = parseConfig({});
    expect(c.coreMemory.selfIdentity.enabled).toBe(false);
    expect(c.coreMemory.selfIdentity.maxPerPass).toBe(2);
  });

  it("缺省：soulRender 身份两槽预算 600/900", () => {
    const c = parseConfig({});
    expect(c.coreMemory.soulRender.budgetSelfChars).toBe(600);
    expect(c.coreMemory.soulRender.budgetIdentityChars).toBe(900);
  });

  it("yaml 值真实生效 + clamp", () => {
    const c = parseConfig({
      coreMemory: {
        selfIdentity: { enabled: true, maxPerPass: 99 },
        soulRender: { budgetSelfChars: 100, budgetIdentityChars: 50 },
      },
    });
    expect(c.coreMemory.selfIdentity.enabled).toBe(true);
    expect(c.coreMemory.selfIdentity.maxPerPass).toBe(10); // clamp 上界 10（宁缺毋滥）
    expect(c.coreMemory.soulRender.budgetSelfChars).toBe(100);
    expect(c.coreMemory.soulRender.budgetIdentityChars).toBe(100); // clamp 下界 100（防手滑归零段）
  });
});

