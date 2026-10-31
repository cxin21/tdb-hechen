import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TEAM_OWNERSHIP,
  TEAM_NOT_OWNED,
  __resetTeamOwnershipMetricsForTests,
  decideTeamOwnership,
  normalizeTeamOwnershipWhitelist,
  parseTeamOwnershipMode,
  recordTeamOwnershipMetric,
  resolveTeamOwnershipConfig,
  snapshotTeamOwnershipMetrics,
  teamOwnershipNeedsLookup,
  type TeamOwnershipConfig,
} from "../team-ownership.js";
import { createTeamOwnershipResolver } from "../team-ownership-resolver.js";

const warnCfg: TeamOwnershipConfig = { mode: "warn", whitelist: [] };
const enforceCfg: TeamOwnershipConfig = { mode: "enforce", whitelist: [] };

describe("task-68 parseTeamOwnershipMode", () => {
  it("缺省 off；空串沿用 fallback", () => {
    expect(parseTeamOwnershipMode(undefined)).toBe("off");
    expect(parseTeamOwnershipMode("")).toBe("off");
    expect(parseTeamOwnershipMode("   ", "warn")).toBe("warn");
  });

  it("三档原样（大小写/空白归一）", () => {
    expect(parseTeamOwnershipMode("off")).toBe("off");
    expect(parseTeamOwnershipMode(" WARN ")).toBe("warn");
    expect(parseTeamOwnershipMode("enforce")).toBe("enforce");
  });

  it("未知非空取值 → enforce（宁严不松，与 parseSwitch 同口径）", () => {
    expect(parseTeamOwnershipMode("true")).toBe("enforce");
    expect(parseTeamOwnershipMode("reject")).toBe("enforce");
  });
});

describe("task-68 白名单归一化", () => {
  it("数组/逗号串都接受，trim + 去空 + 去重保序", () => {
    expect(normalizeTeamOwnershipWhitelist([" t1 ", "", "t1", "t2"])).toEqual(["t1", "t2"]);
    expect(normalizeTeamOwnershipWhitelist("t1, t2 ,, t1")).toEqual(["t1", "t2"]);
    expect(normalizeTeamOwnershipWhitelist(undefined)).toEqual([]);
    expect(normalizeTeamOwnershipWhitelist(42)).toEqual([]);
  });
});

describe("task-68 resolveTeamOwnershipConfig", () => {
  it("缺省 off + 空白名单（一次查询都不发的前提）", () => {
    expect(resolveTeamOwnershipConfig(undefined)).toEqual(DEFAULT_TEAM_OWNERSHIP);
  });

  it("yaml memory.auth 生效；env 显式设置优先", () => {
    const cfg = { memory: { auth: { requireTeamOwnership: "warn", teamOwnershipWhitelist: ["t-legacy"] } } };
    expect(resolveTeamOwnershipConfig(cfg)).toEqual({ mode: "warn", whitelist: ["t-legacy"] });
    expect(resolveTeamOwnershipConfig(cfg, { requireTeamOwnership: "enforce" }).mode).toBe("enforce");
    expect(resolveTeamOwnershipConfig(cfg, { teamOwnershipWhitelist: "t-env" }).whitelist).toEqual(["t-env"]);
  });

  it("env 空串不覆盖 yaml", () => {
    const cfg = { memory: { auth: { requireTeamOwnership: "enforce" as const } } };
    expect(resolveTeamOwnershipConfig(cfg, { requireTeamOwnership: "" }).mode).toBe("enforce");
  });
});

describe("task-68 decideTeamOwnership：off 逐位现状", () => {
  it("off 恒放行，且不需要 lookup", () => {
    const d = decideTeamOwnership({ config: DEFAULT_TEAM_OWNERSHIP, teamId: "t1", userKey: "u1" });
    expect(d).toMatchObject({ allow: true, why: "mode_off", warn: false, metric: "off" });
    expect(teamOwnershipNeedsLookup({ config: DEFAULT_TEAM_OWNERSHIP, teamId: "t1", userKey: "u1" })).toBe(false);
  });
});

describe("task-68 decideTeamOwnership：warn 只记不拒", () => {
  it("非成员 ⇒ 放行 + warn", () => {
    const d = decideTeamOwnership({
      config: warnCfg,
      teamId: "t1",
      userKey: "key-u1",
      lookup: { callerUserId: "u1", teamKnown: true, isMember: false },
    });
    expect(d).toMatchObject({ allow: true, why: "not_member", warn: true, metric: "warn" });
  });

  it("team 查无 ⇒ 放行 + warn（team_unknown）", () => {
    const d = decideTeamOwnership({
      config: warnCfg,
      teamId: "t-bogus",
      userKey: "key-u1",
      lookup: { callerUserId: "u1", teamKnown: false, isMember: false },
    });
    expect(d).toMatchObject({ allow: true, why: "team_unknown", warn: true });
  });

  it("成员 ⇒ 静默放行（不打 warn 日志）", () => {
    const d = decideTeamOwnership({
      config: warnCfg,
      teamId: "t1",
      userKey: "key-u1",
      lookup: { callerUserId: "u1", teamKnown: true, isMember: true },
    });
    expect(d).toMatchObject({ allow: true, why: "member", warn: false, metric: "allowed" });
  });
});

describe("task-68 decideTeamOwnership：enforce 403", () => {
  it("非成员 ⇒ 403 TEAM_NOT_OWNED，reason 带 team 与 user", () => {
    const d = decideTeamOwnership({
      config: enforceCfg,
      teamId: "t-victim",
      userKey: "key-u1",
      lookup: { callerUserId: "u-attacker", teamKnown: true, isMember: false },
    });
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error("unreachable");
    expect(d.code).toBe(TEAM_NOT_OWNED);
    expect(d.metric).toBe("denied");
    expect(d.reason).toContain("u-attacker");
    expect(d.reason).toContain("t-victim");
  });

  it("team 查无 ⇒ 同样 403（team_unknown）", () => {
    const d = decideTeamOwnership({
      config: enforceCfg,
      teamId: "t-bogus",
      userKey: "key-u1",
      lookup: { callerUserId: "u1", teamKnown: false, isMember: false },
    });
    expect(d).toMatchObject({ allow: false, why: "team_unknown", code: TEAM_NOT_OWNED });
  });
});

describe("task-68 降级口径（不得打死正常调用方）", () => {
  it("无 x-tdai-user-key ⇒ 不判不通过，计 no_identity", () => {
    const d = decideTeamOwnership({ config: enforceCfg, teamId: "t1", userKey: "" });
    expect(d).toMatchObject({ allow: true, why: "no_identity", warn: true, metric: "no_identity" });
    expect(teamOwnershipNeedsLookup({ config: enforceCfg, teamId: "t1", userKey: "" })).toBe(false);
  });

  it("key 解不出用户（吊销/伪造）⇒ 同 no_identity 档", () => {
    const d = decideTeamOwnership({
      config: enforceCfg,
      teamId: "t1",
      userKey: "bad-key",
      lookup: { callerUserId: null, teamKnown: null, isMember: null },
    });
    expect(d).toMatchObject({ allow: true, why: "no_identity", metric: "no_identity" });
  });

  it("metadata 查询失败/事实缺失 ⇒ fail-open + metadata_error", () => {
    expect(decideTeamOwnership({ config: enforceCfg, teamId: "t1", userKey: "key-u1", lookup: null }))
      .toMatchObject({ allow: true, why: "lookup_unavailable", metric: "metadata_error" });
    expect(decideTeamOwnership({
      config: enforceCfg,
      teamId: "t1",
      userKey: "key-u1",
      lookup: { callerUserId: "u1", teamKnown: null, isMember: null },
    })).toMatchObject({ allow: true, why: "lookup_unavailable", metric: "metadata_error" });
  });
});

describe("task-68 白名单（历史脏 team 逃生口）", () => {
  it("命中 ⇒ 放行 + 不查询", () => {
    const cfg: TeamOwnershipConfig = { mode: "enforce", whitelist: ["t-legacy"] };
    const d = decideTeamOwnership({ config: cfg, teamId: "t-legacy", userKey: "key-u1" });
    expect(d).toMatchObject({ allow: true, why: "whitelisted", warn: false });
    expect(teamOwnershipNeedsLookup({ config: cfg, teamId: "t-legacy", userKey: "key-u1" })).toBe(false);
    expect(teamOwnershipNeedsLookup({ config: cfg, teamId: "t-other", userKey: "key-u1" })).toBe(true);
  });
});

describe("task-68 obs 计数", () => {
  it("判定计数按 metric 累加，快照只回非零", () => {
    __resetTeamOwnershipMetricsForTests();
    recordTeamOwnershipMetric("warn");
    recordTeamOwnershipMetric("warn");
    recordTeamOwnershipMetric("denied", 0);
    expect(snapshotTeamOwnershipMetrics()).toEqual({ warn: 2 });
    __resetTeamOwnershipMetricsForTests();
    expect(snapshotTeamOwnershipMetrics()).toEqual({});
  });
});

describe("task-68 resolver：LRU + fail-open 留痕", () => {
  const makeSvc = (over: Partial<Record<string, unknown>> = {}) => ({
    verifyAuth: vi.fn(async () => ({ user_id: "u1" })),
    getTeamById: vi.fn(async () => ({ team_id: "t1" })),
    getTeamMember: vi.fn(async () => ({ team_id: "t1", user_id: "u1" })),
    ...over,
  });

  it("同 (team,user) 第二次命中缓存，不再打 metadata", async () => {
    const svc = makeSvc();
    const resolver = createTeamOwnershipResolver({
      getMetadataService: async () => svc as never,
      logger: { warn: () => {} },
    });
    const first = await resolver.lookup({ instanceId: "i1", teamId: "t1", userKey: "key-u1" });
    const second = await resolver.lookup({ instanceId: "i1", teamId: "t1", userKey: "key-u1" });
    expect(first).toEqual({ callerUserId: "u1", teamKnown: true, isMember: true });
    expect(second).toEqual(first);
    expect(svc.verifyAuth).toHaveBeenCalledTimes(1);
    expect(svc.getTeamMember).toHaveBeenCalledTimes(1);
    expect(resolver.stats()).toMatchObject({ users: 1, members: 1 });
  });

  it("TTL 过期后重新查询", async () => {
    let clock = 1000;
    const svc = makeSvc();
    const resolver = createTeamOwnershipResolver({
      getMetadataService: async () => svc as never,
      logger: { warn: () => {} },
      cacheTtlMs: 100,
      now: () => clock,
    });
    await resolver.lookup({ instanceId: "i1", teamId: "t1", userKey: "key-u1" });
    clock += 50;
    await resolver.lookup({ instanceId: "i1", teamId: "t1", userKey: "key-u1" });
    expect(svc.verifyAuth).toHaveBeenCalledTimes(1);
    clock += 100;
    await resolver.lookup({ instanceId: "i1", teamId: "t1", userKey: "key-u1" });
    expect(svc.verifyAuth).toHaveBeenCalledTimes(2);
  });

  it("metadata 抛错 ⇒ 抛给调用方（fail-open 由 dispatch 决定）且 WARN 只打一次", async () => {
    const warn = vi.fn();
    const svc = makeSvc({
      verifyAuth: vi.fn(async () => { throw new Error("db down"); }),
    });
    const resolver = createTeamOwnershipResolver({
      getMetadataService: async () => svc as never,
      logger: { warn },
    });
    await expect(resolver.lookup({ instanceId: "i1", teamId: "t1", userKey: "key-u1" })).rejects.toThrow("db down");
    await expect(resolver.lookup({ instanceId: "i1", teamId: "t1", userKey: "key-u1" })).rejects.toThrow("db down");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("fail-open");
  });

  it("team 查无 ⇒ teamKnown=false / isMember=false", async () => {
    const svc = makeSvc({ getTeamById: vi.fn(async () => null) });
    const resolver = createTeamOwnershipResolver({
      getMetadataService: async () => svc as never,
      logger: { warn: () => {} },
    });
    expect(await resolver.lookup({ instanceId: "i1", teamId: "t-bogus", userKey: "key-u1" }))
      .toEqual({ callerUserId: "u1", teamKnown: false, isMember: false });
  });
});
