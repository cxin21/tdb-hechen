/**
 * #红队②（task-60）：数据面归属校验的**装配链**回归（走真 handleV2Route）。
 *
 * 纯函数单测证明判定正确，本套证明接线正确：
 *   1) deps 无 authBinding ⇒ 行为与今天逐位相同：任意 user_id 照常进入 handler；
 *   2) 开 requireUserBinding ⇒ 缺 key / key 不符 403 且 handler 不被调用；
 *   3) key 相符 / admin 双条件旁路 ⇒ 放行；
 *   4) unknownPrincipalPolicy reject ⇒ 写侧 400 UNKNOWN_PRINCIPAL；warn/off 不拦。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleV2Route } from "./v2-router.js";
import { DEFAULT_AUTH_BINDING } from "./auth-binding.js";
import type { V2RouterDeps } from "./v2-router.js";
import type { IMemoryStore } from "../core/store/types.js";

interface Capture {
  status: number;
  body: { code: number; message: string; data?: Record<string, unknown> };
}

function makeDeps(extra: Partial<V2RouterDeps> = {}): V2RouterDeps {
  const store = { countProfiles: async () => 0 } as unknown as IMemoryStore;
  return {
    getStore: () => store,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    deployMode: "service" as const,
    // v3 严格隔离保持开（缺省值）⇒ 每个请求都带齐 team/agent/user
    ...extra,
  } as unknown as V2RouterDeps;
}

async function callV3(
  deps: V2RouterDeps,
  opts: { body?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Promise<Capture> {
  const req = {
    headers: {
      authorization: "Bearer test-key",
      "x-tdai-service-id": "test",
      ...(opts.headers ?? {}),
    },
  } as unknown as IncomingMessage;
  const captured: Capture = { status: -1, body: { code: -1, message: "" } };
  const body = { team_id: "t1", agent_id: "a1", user_id: "u1", ...(opts.body ?? {}) };
  const handled = await handleV2Route(
    req,
    {} as unknown as ServerResponse,
    "/v3/scenario/count",
    "POST",
    async <T,>() => body as T,
    (_res, status, payload) => {
      captured.status = status;
      captured.body = payload as Capture["body"];
    },
    deps,
  );
  expect(handled).toBe(true);
  return captured;
}

describe("#红队② ①：缺省（无 authBinding）逐位不变", () => {
  it("任意 user_id 照常进入 handler（不 403/400）", async () => {
    const res = await callV3(makeDeps(), { body: { user_id: "u-victim" } });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });

  it("authBinding 存在但 requireUserBinding=false 同样放行", async () => {
    const res = await callV3(makeDeps({ authBinding: { ...DEFAULT_AUTH_BINDING } }), {
      body: { user_id: "u-victim" },
      headers: { "x-tdai-user-key": "u-attacker" },
    });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });
});

describe("#红队② ②：开启后 403 且 handler 不被调用", () => {
  const on = { ...DEFAULT_AUTH_BINDING, requireUserBinding: true };

  it("缺 x-tdai-user-key ⇒ 403 USER_BINDING_REQUIRED", async () => {
    const store = { countProfiles: vi.fn(async () => 0) };
    const res = await callV3(
      makeDeps({ authBinding: on, getStore: () => store as unknown as IMemoryStore }),
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(403);
    expect(res.body.message).toContain("USER_BINDING_REQUIRED");
    expect((res.body.data ?? {}).code).toBe("USER_BINDING_REQUIRED");
    expect(store.countProfiles).not.toHaveBeenCalled();
  });

  it("key 与 user_id 不符 ⇒ 403 USER_BINDING_MISMATCH", async () => {
    const res = await callV3(makeDeps({ authBinding: on }), {
      body: { user_id: "u-victim" },
      headers: { "x-tdai-user-key": "u-attacker" },
    });
    expect(res.status).toBe(403);
    expect((res.body.data ?? {}).code).toBe("USER_BINDING_MISMATCH");
  });

  it("key 与 user_id 相符 ⇒ 放行", async () => {
    const res = await callV3(makeDeps({ authBinding: on }), { headers: { "x-tdai-user-key": "u1" } });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });

  it("④ admin 双条件旁路放行（并留日志）", async () => {
    const warn = vi.fn();
    const res = await callV3(
      makeDeps({
        authBinding: { ...on, adminBypassEnabled: true },
        logger: { info: () => {}, warn, error: () => {}, debug: () => {} },
      }),
      { headers: { "x-tdai-user-type": "system_admin", "x-tdai-admin-bypass": "1" } },
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("USER_BINDING_ADMIN_BYPASS"))).toBe(true);
  });

  it("取 body.user_id 为空串时按 header 兜底比较（header 匹配即放行）", async () => {
    const res = await callV3(makeDeps({ authBinding: on }), {
      body: { user_id: undefined },
      headers: { "x-tdai-user-id": "u1", "x-tdai-user-key": "u1" },
    });
    expect(res.body.code).toBe(0);
  });
});

describe("#红队② ③：写侧未知主体策略", () => {
  it("reject + 查无 user ⇒ 400 UNKNOWN_PRINCIPAL，handler 不被调用", async () => {
    const store = { countProfiles: vi.fn(async () => 0) };
    const lookupPrincipal = vi.fn(async () => ({ teamKnown: true, agentKnown: true, userKnown: false }));
    const res = await callV3(
      makeDeps({
        authBinding: { ...DEFAULT_AUTH_BINDING, unknownPrincipalPolicy: "reject" },
        lookupPrincipal,
        getStore: () => store as unknown as IMemoryStore,
      }),
    );
    expect(res.status).toBe(400);
    expect((res.body.data ?? {}).code).toBe("UNKNOWN_PRINCIPAL");
    expect(res.body.data?.unknown).toEqual(["user"]);
    expect(store.countProfiles).not.toHaveBeenCalled();
  });

  it("warn ⇒ 放行但记日志", async () => {
    const warn = vi.fn();
    const res = await callV3(
      makeDeps({
        authBinding: { ...DEFAULT_AUTH_BINDING, unknownPrincipalPolicy: "warn" },
        lookupPrincipal: async () => ({ teamKnown: true, agentKnown: true, userKnown: false }),
        logger: { info: () => {}, warn, error: () => {}, debug: () => {} },
      }),
    );
    expect(res.body.code).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("UNKNOWN_PRINCIPAL"))).toBe(true);
  });

  it("off ⇒ lookupPrincipal 根本不被调用（不查不记）", async () => {
    const lookupPrincipal = vi.fn(async () => ({ teamKnown: false, agentKnown: false, userKnown: false }));
    const res = await callV3(makeDeps({ authBinding: { ...DEFAULT_AUTH_BINDING }, lookupPrincipal }));
    expect(res.body.code).toBe(0);
    expect(lookupPrincipal).not.toHaveBeenCalled();
  });

  it("查询抛错 ⇒ 软失败放行并留痕（不静默）", async () => {
    const warn = vi.fn();
    const res = await callV3(
      makeDeps({
        authBinding: { ...DEFAULT_AUTH_BINDING, unknownPrincipalPolicy: "reject" },
        lookupPrincipal: async () => {
          throw new Error("entity table unavailable");
        },
        logger: { info: () => {}, warn, error: () => {}, debug: () => {} },
      }),
    );
    expect(res.body.code).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("principal lookup failed"))).toBe(true);
  });
});
