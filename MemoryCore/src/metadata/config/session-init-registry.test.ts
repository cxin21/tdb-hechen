import { describe, expect, it } from "vitest";
import { loadDefaultRegistry } from "./param-registry.js";

describe("session_init config params registry", () => {
  const reg = loadDefaultRegistry();
  const mod = reg.get("session_init");

  it("registers the session_init module with 4 user-scope params", () => {
    expect(mod).toBeDefined();
    expect(mod!.params.map((p) => p.param_name)).toEqual([
      "manual_select",
      "default_associate",
      "default_team_id",
      "default_agent_id",
    ]);
    for (const p of mod!.params) {
      expect(p.allowed_scopes).toContain("user");
    }
  });

  it("keeps boolean params defaulting to 0/1 and id params defaulting to empty", () => {
    const manual = mod!.params.find((p) => p.param_name === "manual_select")!;
    const team = mod!.params.find((p) => p.param_name === "default_team_id")!;
    expect(["0", "1"]).toContain(manual.param_value);
    expect(team.param_value).toBe("");
  });
});