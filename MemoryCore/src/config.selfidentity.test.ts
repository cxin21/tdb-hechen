import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

describe("coreMemory.selfIdentity / soulRender（P1 双槽）", () => {
  it("缺省：selfIdentity.enabled=false（config-first 逐位现状）", () => {
    const c = parseConfig({});
    expect(c.coreMemory.selfIdentity.enabled).toBe(false);
    expect(c.coreMemory.selfIdentity.maxPerPass).toBe(2);
    expect(c.coreMemory.selfIdentity.intervalHours).toBe(24);
  });

  it("缺省：soulRender 预算 600/900；#10 三行预算 0=关", () => {
    const c = parseConfig({});
    expect(c.coreMemory.soulRender.budgetSelfChars).toBe(600);
    expect(c.coreMemory.soulRender.budgetIdentityChars).toBe(900);
    expect(c.coreMemory.soulRender.budgetAnchorChars).toBe(0);
    expect(c.coreMemory.soulRender.budgetPersonChars).toBe(0);
    expect(c.coreMemory.soulRender.budgetCharacterChars).toBe(0);
  });

  it("缺省白名单含 self_identity（信任边界扩展，写入仍由 enabled 门控）", () => {
    const c = parseConfig({});
    expect(c.coreMemory.allowedSlots).toContain("self_identity");
  });

  it("yaml 值真实生效 + clamp", () => {
    const c = parseConfig({
      coreMemory: {
        selfIdentity: { enabled: true, maxPerPass: 99, intervalHours: 0 },
        soulRender: { budgetSelfChars: 100, budgetIdentityChars: 50, budgetAnchorChars: 480, budgetPersonChars: -5, budgetCharacterChars: 99999 },
      },
    });
    expect(c.coreMemory.selfIdentity.enabled).toBe(true);
    expect(c.coreMemory.selfIdentity.maxPerPass).toBe(10); // clamp 上界 10（宁缺毋滥）
    expect(c.coreMemory.selfIdentity.intervalHours).toBe(1); // clamp 下界 1
    expect(c.coreMemory.soulRender.budgetSelfChars).toBe(100);
    expect(c.coreMemory.soulRender.budgetIdentityChars).toBe(100); // clamp 下界 100（防手滑归零段）
    expect(c.coreMemory.soulRender.budgetAnchorChars).toBe(480); // #10：0..4000，可开
    expect(c.coreMemory.soulRender.budgetPersonChars).toBe(0); // #10：负值→0（0=关）
    expect(c.coreMemory.soulRender.budgetCharacterChars).toBe(4000); // #10：clamp 上界
  });

  it("显式 allowedSlots 覆盖缺省（不含 self_identity 时写入将被信任边界拒绝——合法配置）", () => {
    const c = parseConfig({ coreMemory: { allowedSlots: ["identity"] } });
    expect(c.coreMemory.allowedSlots).toEqual(["identity"]);
  });
});

describe("coreMemory.anchorDiscovery.descRefresh（#11 T5）", () => {
  it("缺省：enabled=false（config-first 逐位现状），倍数/轮次取缺省", () => {
    const c = parseConfig({});
    expect(c.coreMemory.anchorDiscovery.descRefresh.enabled).toBe(false);
    expect(c.coreMemory.anchorDiscovery.descRefresh.evidenceMultiple).toBe(2);
    expect(c.coreMemory.anchorDiscovery.descRefresh.maxPerPass).toBe(2);
  });

  it("yaml 值真实生效 + clamp（1..10 / 1..5）", () => {
    const c = parseConfig({ coreMemory: { anchorDiscovery: { descRefresh: { enabled: true, evidenceMultiple: 99, maxPerPass: 0 } } } });
    expect(c.coreMemory.anchorDiscovery.descRefresh.enabled).toBe(true);
    expect(c.coreMemory.anchorDiscovery.descRefresh.evidenceMultiple).toBe(10);
    expect(c.coreMemory.anchorDiscovery.descRefresh.maxPerPass).toBe(1);
  });
});
