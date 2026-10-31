/**
 * #红队②（task-60）：数据面归属校验纯函数契约。
 *
 * 核心断言：**缺省全放行**（与今天逐位相同），只有显式开开关才拦。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTH_BINDING,
  UNKNOWN_PRINCIPAL,
  USER_BINDING_MISMATCH,
  USER_BINDING_REQUIRED,
  decideUnknownPrincipal,
  decideUserBinding,
  parseSwitch,
  parseUnknownPrincipalPolicy,
  resolveAuthBindingConfig,
} from "./auth-binding.js";

describe("parseSwitch / parseUnknownPrincipalPolicy", () => {
  it("空串走 fallback；on/off 词各自生效", () => {
    expect(parseSwitch(undefined, false)).toBe(false);
    expect(parseSwitch("  ", true)).toBe(true);
    expect(parseSwitch("0", true)).toBe(false);
    expect(parseSwitch("off", true)).toBe(false);
    expect(parseSwitch("1", false)).toBe(true);
    expect(parseSwitch("TRUE", false)).toBe(true);
  });

  it("显式写了但写错 → fail-secure 视为开启（与 resolveV3StrictIsolation 同口径）", () => {
    expect(parseSwitch("maybe", false)).toBe(true);
    expect(parseUnknownPrincipalPolicy("strict", "off")).toBe("reject");
  });

  it("策略三档 + 未知取值 fail-secure 到 reject", () => {
    expect(parseUnknownPrincipalPolicy(undefined, "off")).toBe("off");
    expect(parseUnknownPrincipalPolicy("warn", "off")).toBe("warn");
    expect(parseUnknownPrincipalPolicy("REJECT", "off")).toBe("reject");
    expect(parseUnknownPrincipalPolicy("nonsense", "off")).toBe("reject");
  });
});

describe("resolveAuthBindingConfig：优先级 env > config > 缺省", () => {
  it("全缺省 ⇒ 三项全关（今天的生产行为）", () => {
    expect(resolveAuthBindingConfig()).toEqual(DEFAULT_AUTH_BINDING);
    expect(resolveAuthBindingConfig({})).toEqual({
      requireUserBinding: false,
      unknownPrincipalPolicy: "off",
      adminBypassEnabled: false,
      // task-68：同一份 memory.auth 里的 team 归属开关，缺省同样全关。
      requireTeamOwnership: "off",
      teamOwnershipWhitelist: [],
    });
  });

  it("只读 yaml memory.auth（env 未设）", () => {
    expect(
      resolveAuthBindingConfig({
        memory: { auth: { requireUserBinding: true, unknownPrincipalPolicy: "warn", adminBypassEnabled: true } },
      }),
    ).toEqual({
      requireUserBinding: true,
      unknownPrincipalPolicy: "warn",
      adminBypassEnabled: true,
      requireTeamOwnership: "off",
      teamOwnershipWhitelist: [],
    });
  });

  it("env 显式设置覆盖 yaml", () => {
    const cfg = resolveAuthBindingConfig(
      { memory: { auth: { requireUserBinding: true, unknownPrincipalPolicy: "reject" } } },
      { requireUserBinding: "0", unknownPrincipalPolicy: "warn" },
    );
    expect(cfg.requireUserBinding).toBe(false);
    expect(cfg.unknownPrincipalPolicy).toBe("warn");
  });
});

describe("decideUserBinding", () => {
  const on = { ...DEFAULT_AUTH_BINDING, requireUserBinding: true };

  it("① 缺省关：任意 user_id + 任意/缺失 key 全部放行（bite-identical）", () => {
    for (const key of [undefined, "", "someone-else"]) {
      const d = decideUserBinding({ config: DEFAULT_AUTH_BINDING, requestUserId: "u-victim", userKey: key });
      expect(d).toEqual({ allow: true, bypassed: false });
    }
  });

  it("② 开：缺 key ⇒ USER_BINDING_REQUIRED（403 机器码）", () => {
    const d = decideUserBinding({ config: on, requestUserId: "u1", userKey: "" });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe(USER_BINDING_REQUIRED);
  });

  it("② 开：key 与 user_id 不一致 ⇒ USER_BINDING_MISMATCH", () => {
    const d = decideUserBinding({ config: on, requestUserId: "u-victim", userKey: "u-attacker" });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.code).toBe(USER_BINDING_MISMATCH);
      expect(d.reason).toContain("u-victim");
    }
  });

  it("② 开：相等放行（含首尾空白）", () => {
    expect(decideUserBinding({ config: on, requestUserId: " u1 ", userKey: "u1" })).toEqual({
      allow: true,
      bypassed: false,
    });
  });

  it("④ admin 旁路需 system_admin + 显式 header 双条件都满足", () => {
    const bypassOn = { ...on, adminBypassEnabled: true };
    expect(
      decideUserBinding({ config: bypassOn, requestUserId: "u1", userType: "system_admin", adminBypass: "1" }),
    ).toEqual({ allow: true, bypassed: true });
    // 只带 type 不带 header → 不放行
    const onlyType = decideUserBinding({ config: bypassOn, requestUserId: "u1", userType: "system_admin" });
    expect(onlyType.allow).toBe(false);
    // 只带 header 不带 type → 不放行
    const onlyHeader = decideUserBinding({ config: bypassOn, requestUserId: "u1", adminBypass: "1" });
    expect(onlyHeader.allow).toBe(false);
    // 旁路开关关闭时，双条件齐也不放行
    const gateOff = decideUserBinding({ config: on, requestUserId: "u1", userType: "system_admin", adminBypass: "1" });
    expect(gateOff.allow).toBe(false);
  });
});

describe("decideUnknownPrincipal", () => {
  const unknown = { teamKnown: false, agentKnown: true, userKnown: false };

  it("off ⇒ 恒放行且不列出未知（不查不记）", () => {
    expect(decideUnknownPrincipal("off", unknown)).toEqual({ action: "allow", unknown: [] });
  });

  it("warn / reject 各自生效并列出 dimension", () => {
    expect(decideUnknownPrincipal("warn", unknown)).toEqual({ action: "warn", unknown: ["team", "user"] });
    expect(decideUnknownPrincipal("reject", unknown)).toEqual({ action: "reject", unknown: ["team", "user"] });
  });

  it("全 true 或 null（查不了）⇒ 不拦", () => {
    expect(decideUnknownPrincipal("reject", { teamKnown: true, agentKnown: true, userKnown: true }).action).toBe("allow");
    expect(decideUnknownPrincipal("reject", { teamKnown: null, agentKnown: null, userKnown: null }).action).toBe("allow");
    expect(decideUnknownPrincipal("reject", null).action).toBe("allow");
  });

  it("UNKNOWN_PRINCIPAL 是稳定机器码（写侧 400 用）", () => {
    expect(UNKNOWN_PRINCIPAL).toBe("UNKNOWN_PRINCIPAL");
  });
});
