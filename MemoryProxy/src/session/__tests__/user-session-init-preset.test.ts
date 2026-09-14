import { describe, expect, it } from "vitest";
import { resolveUserSessionInitPreset } from "../user-session-init-preset.js";

describe("resolveUserSessionInitPreset", () => {
  it("null config → ask (zero-change)", () => {
    expect(resolveUserSessionInitPreset(null)).toEqual({ kind: "ask" });
  });

  it("manual_select default/absent-but-no-key effectively '1' → ask", () => {
    expect(resolveUserSessionInitPreset({})).toEqual({ kind: "ask" });
    expect(resolveUserSessionInitPreset({ manual_select: "1", default_associate: "1", default_team_id: "t" })).toEqual({ kind: "ask" });
  });

  it("manual_select=0 & default_associate=0 → bypass", () => {
    expect(resolveUserSessionInitPreset({ manual_select: "0", default_associate: "0" })).toEqual({ kind: "bypass" });
  });

  it("manual_select=0 & associate!=0 but no team → ask", () => {
    expect(resolveUserSessionInitPreset({ manual_select: "0", default_associate: "1" })).toEqual({ kind: "ask" });
  });

  it("manual_select=0 & team set & no agent → preset team only", () => {
    expect(resolveUserSessionInitPreset({ manual_select: "0", default_associate: "1", default_team_id: "t-1" })).toEqual({ kind: "preset", teamId: "t-1" });
  });

  it("manual_select=0 & team+agent set → preset with both", () => {
    expect(resolveUserSessionInitPreset({ manual_select: "0", default_associate: "1", default_team_id: "t-1", default_agent_id: "a-1" })).toEqual({ kind: "preset", teamId: "t-1", agentId: "a-1" });
  });
});