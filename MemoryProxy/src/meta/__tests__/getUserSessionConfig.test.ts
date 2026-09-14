import { describe, expect, it } from "vitest";
import { MetadataClient } from "../client.js";

function makeClient(respond: (body: Record<string, unknown>) => unknown) {
  const fetcher = (async (_url: unknown, init?: { body?: string }) => {
    const parsed = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: respond(parsed) }),
    } as Response;
  }) as typeof fetch;
  return new MetadataClient(
    { endpoint: "http://x", serviceToken: "s", timeoutMs: 1000 },
    "svc",
    "user-key",
    fetcher,
  );
}

describe("MetadataClient.getUserSessionConfig", () => {
  it("POSTs /v3/meta/config/user/get with user_id+module and maps items to effective_values", async () => {
    let sent: Record<string, unknown> | null = null;
    const client = makeClient((body) => {
      sent = body;
      return {
        user_id: body.user_id,
        module: body.module,
        module_description: "会话初始化关联默认值",
        items: [
          { module: "session_init", param_name: "manual_select", param_key: "session_init.manual_select", description: "", effective_value: "0" },
          { module: "session_init", param_name: "default_team_id", param_key: "session_init.default_team_id", description: "", effective_value: "t-1" },
        ],
      };
    });
    const result = await client.getUserSessionConfig("usr-1", "session_init");
    expect(sent).toEqual({ user_id: "usr-1", module: "session_init" });
    expect(result).toEqual({ manual_select: "0", default_team_id: "t-1" });
  });
});