/**
 * dsh PTC 会话身份预检（捕获中断修复批次）单测。
 * deps 形状兼容 MetadataClient.listTeams/listAgents/getUserSessionConfig。
 */
import { describe, it, expect } from "vitest";
import { resolveDshPtcPresetIdentity, type DshPtcPresetDeps } from "../dsh-ptc-preset.js";

function deps(over: {
  userCfg?: Record<string, string>;
  teams?: { team_id: string }[];
  agents?: { agent_id: string; team_id?: string }[];
  cfgError?: Error;
  teamsError?: Error;
  agentsError?: Error;
}): DshPtcPresetDeps {
  return {
    getUserSessionConfig: async () => {
      if (over.cfgError) throw over.cfgError;
      return over.userCfg ?? {};
    },
    listTeams: async () => {
      if (over.teamsError) throw over.teamsError;
      return over.teams ?? [];
    },
    listAgents: async () => {
      if (over.agentsError) throw over.agentsError;
      return over.agents ?? [];
    },
  };
}

const FULL_OK = {
  manual_select: "0",
  default_associate: "1",
  default_team_id: "t-1",
  default_agent_id: "a-1",
} as const;

const TEAMS_OK = [{ team_id: "t-1" }, { team_id: "t-2" }];
const AGENTS_OK = [{ agent_id: "a-1", team_id: "t-1" }, { agent_id: "a-2", team_id: "t-1" }];

describe("resolveDshPtcPresetIdentity", () => {
  it("四属性配齐且 kernel 校验通过 → 返回 PresetIdentity", async () => {
    const r = await resolveDshPtcPresetIdentity(deps({ userCfg: { ...FULL_OK }, teams: TEAMS_OK, agents: AGENTS_OK }), "usr-1");
    expect(r).toEqual({ teamId: "t-1", agentId: "a-1" });
  });

  it("userId 缺失 → null（维持 bypass）", async () => {
    const r = await resolveDshPtcPresetIdentity(deps({ userCfg: { ...FULL_OK }, teams: TEAMS_OK, agents: AGENTS_OK }), "");
    expect(r).toBeNull();
  });

  it("未配置（空 config）→ resolveUserSessionInitPreset=ask → null", async () => {
    const r = await resolveDshPtcPresetIdentity(deps({ userCfg: {}, teams: TEAMS_OK, agents: AGENTS_OK }), "usr-1");
    expect(r).toBeNull();
  });

  it("manual_select=1（需要手动选）→ null", async () => {
    const r = await resolveDshPtcPresetIdentity(
      deps({ userCfg: { ...FULL_OK, manual_select: "1" }, teams: TEAMS_OK, agents: AGENTS_OK }), "usr-1");
    expect(r).toBeNull();
  });

  it("default_associate=0（明确不关联）→ null", async () => {
    const r = await resolveDshPtcPresetIdentity(
      deps({ userCfg: { ...FULL_OK, default_associate: "0" }, teams: TEAMS_OK, agents: AGENTS_OK }), "usr-1");
    expect(r).toBeNull();
  });

  it("只配 team 缺 agent → canRegister=false → null", async () => {
    const r = await resolveDshPtcPresetIdentity(
      deps({ userCfg: { manual_select: "0", default_associate: "1", default_team_id: "t-1" }, teams: TEAMS_OK, agents: AGENTS_OK }), "usr-1");
    expect(r).toBeNull();
  });

  it("team 不在 kernel（mismatch）→ null", async () => {
    const r = await resolveDshPtcPresetIdentity(
      deps({ userCfg: { ...FULL_OK }, teams: [{ team_id: "t-9" }], agents: AGENTS_OK }), "usr-1");
    expect(r).toBeNull();
  });

  it("agent 不在 team（mismatch）→ null", async () => {
    const r = await resolveDshPtcPresetIdentity(
      deps({ userCfg: { ...FULL_OK }, teams: TEAMS_OK, agents: [{ agent_id: "a-9", team_id: "t-1" }] }), "usr-1");
    expect(r).toBeNull();
  });

  it("kernel 读配置失败 → null（零行为变化）", async () => {
    const r = await resolveDshPtcPresetIdentity(
      deps({ cfgError: new Error("kernel down"), teams: TEAMS_OK, agents: AGENTS_OK }), "usr-1");
    expect(r).toBeNull();
  });

  it("kernel 拉 teams 失败 → null（零行为变化）", async () => {
    const r = await resolveDshPtcPresetIdentity(
      deps({ userCfg: { ...FULL_OK }, teamsError: new Error("kernel down") }), "usr-1");
    expect(r).toBeNull();
  });

  it("kernel 拉 agents 失败 → null（零行为变化）", async () => {
    const r = await resolveDshPtcPresetIdentity(
      deps({ userCfg: { ...FULL_OK }, teams: TEAMS_OK, agentsError: new Error("kernel down") }), "usr-1");
    expect(r).toBeNull();
  });
});
