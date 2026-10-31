/**
 * task-68：team 归属闸的**装配链**回归（走真 handleV2Route）。
 *
 * 纯函数单测证明判定正确，本套证明接线正确：
 *   1) 缺省 off ⇒ 一处不查、响应逐位不变（含非 gated 路径）；
 *   2) warn ⇒ 非成员照常 200，但留审计日志（authz.team_ownership.warn）；
 *   3) enforce ⇒ 非成员 403 TEAM_NOT_OWNED（带 team_id/user_id/hint），handler 不被调用；
 *   4) 无 x-tdai-user-key ⇒ 不拒（no_identity）；
 *   5) metadata 抛错 ⇒ fail-open 放行 + WARN；
 *   6) 白名单 ⇒ 不查询直接放行。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleV2Route } from "../v2-router.js";
import { DEFAULT_AUTH_BINDING } from "../auth-binding.js";
import type { V2RouterDeps } from "../v2-router.js";
import type { TeamOwnershipLookup } from "../team-ownership.js";
import type { IMemoryStore } from "../../core/store/types.js";

interface Capture {
  status: number;
  body: { code: number; message: string; data?: Record<string, unknown> };
}

// /v3/core/read 会走 scopedProfileStorage(base, isolation) ⇒ 需要 getBackend()
// （StorageAdapter.ts:81 `new ScopedStorageBackend(base.getBackend(), prefix)`）。
// 后端所有 key 一律读空 ⇒ handler 走「文件不存在」分支，稳定 200。
const storageBackendStub = {
  type: "local",
  getObject: async () => null,
  putObject: async () => undefined,
  exists: async () => false,
  listObjects: async () => ({ entries: [], nextMarker: undefined }),
  deleteObject: async () => undefined,
  deleteByPrefix: async () => 0,
};

const storageStub = {
  type: "local",
  getBackend: () => storageBackendStub,
  readFile: async () => null,
  stat: async () => null,
};

function makeDeps(extra: Partial<V2RouterDeps> = {}): V2RouterDeps {
  const store = {
    countProfiles: async () => 0,
    upsertL0: async () => undefined,
    hasRecentL0Duplicate: async () => false,
  } as unknown as IMemoryStore;
  return {
    getStore: () => store,
    getEmbedding: () => undefined,
    getStorage: () => storageStub as never,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    deployMode: "service" as const,
    ...extra,
  } as unknown as V2RouterDeps;
}

async function callV3(
  deps: V2RouterDeps,
  opts: {
    path?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
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
    opts.path ?? "/v3/core/read",
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

const asMember: () => TeamOwnershipLookup = () => ({
  callerUserId: "u1",
  teamKnown: true,
  isMember: false,
});

type LookupInput = { instanceId: string; teamId: string; userKey: string };

/** 显式标注形参类型 ⇒ vi.fn 的 calls 元组非空，可安全取 calls[0][0]（TS2493）。 */
const makeCheck = () =>
  vi.fn(async (_input: LookupInput): Promise<TeamOwnershipLookup> => asMember());

describe("task-68 ①：缺省 off 逐位不变", () => {
  it("无 authBinding.checkTeamOwnership ⇒ core/read 200，且根本没注入查询器", async () => {
    const res = await callV3(makeDeps());
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });

  it("off 档即使注入了查询器也不调用（零 metadata 查询）", async () => {
    const check = makeCheck();
    const res = await callV3(makeDeps({
      authBinding: { ...DEFAULT_AUTH_BINDING },
      checkTeamOwnership: check,
    }), { headers: { "x-tdai-user-key": "key-u1" } });
    expect(res.body.code).toBe(0);
    expect(check).not.toHaveBeenCalled();
  });
});

describe("task-68 ②：warn 只记不拒", () => {
  it("非成员照常 200，但留 authz.team_ownership.warn 审计行", async () => {
    const warn = vi.fn();
    const res = await callV3(makeDeps({
      authBinding: { ...DEFAULT_AUTH_BINDING, requireTeamOwnership: "warn" },
      checkTeamOwnership: async () => asMember(),
      logger: { info: () => {}, warn, error: () => {}, debug: () => {} },
    }), { headers: { "x-tdai-user-key": "key-u1" } });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("authz.team_ownership.warn"))).toBe(true);
  });
});

describe("task-68 ③：enforce 403", () => {
  it("非成员 ⇒ 403 TEAM_NOT_OWNED + data.team_id/user_id/hint（读面）", async () => {
    const check = makeCheck();
    const res = await callV3(makeDeps({
      authBinding: { ...DEFAULT_AUTH_BINDING, requireTeamOwnership: "enforce" },
      checkTeamOwnership: check,
    }), { headers: { "x-tdai-user-key": "key-u1" } });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain("TEAM_NOT_OWNED");
    expect(res.body.data?.code).toBe("TEAM_NOT_OWNED");
    expect(res.body.data?.team_id).toBe("t1");
    expect(res.body.data?.user_id).toBe("u1");
    expect(String(res.body.data?.hint)).toContain("teamOwnershipWhitelist");
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0][0]).toMatchObject({ instanceId: "test", teamId: "t1", userKey: "key-u1" });
  });

  it("写面 /conversation/add 同样 403（handler 不被调用）", async () => {
    const upsertL0 = vi.fn(async () => undefined);
    const store = { upsertL0, hasRecentL0Duplicate: async () => false } as unknown as IMemoryStore;
    const res = await callV3(makeDeps({
      authBinding: { ...DEFAULT_AUTH_BINDING, requireTeamOwnership: "enforce" },
      checkTeamOwnership: async () => asMember(),
      getStore: () => store,
    }), {
      path: "/v3/conversation/add",
      body: { session_id: "s1", messages: [{ role: "user", content: "hi" }] },
      headers: { "x-tdai-user-key": "key-u1" },
    });
    expect(res.status).toBe(403);
    expect(res.body.data?.code).toBe("TEAM_NOT_OWNED");
    expect(upsertL0).not.toHaveBeenCalled();
  });

  it("非 gated 路径（/v3/scenario/count）不查也不拦", async () => {
    const check = makeCheck();
    const res = await callV3(makeDeps({
      authBinding: { ...DEFAULT_AUTH_BINDING, requireTeamOwnership: "enforce" },
      checkTeamOwnership: check,
    }), { path: "/v3/scenario/count", headers: { "x-tdai-user-key": "key-u1" } });
    expect(res.body.code).not.toBe(403);
    expect(check).not.toHaveBeenCalled();
  });
});

describe("task-68 降级：不得打死正常调用方", () => {
  it("enforce + 无 x-tdai-user-key ⇒ 200（no_identity），不查询", async () => {
    const check = makeCheck();
    const res = await callV3(makeDeps({
      authBinding: { ...DEFAULT_AUTH_BINDING, requireTeamOwnership: "enforce" },
      checkTeamOwnership: check,
    }));
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(check).not.toHaveBeenCalled();
  });

  it("enforce + metadata 抛错 ⇒ fail-open 200 + WARN fail-open", async () => {
    const warn = vi.fn();
    const res = await callV3(makeDeps({
      authBinding: { ...DEFAULT_AUTH_BINDING, requireTeamOwnership: "enforce" },
      checkTeamOwnership: async () => { throw new Error("metadata db down"); },
      logger: { info: () => {}, warn, error: () => {}, debug: () => {} },
    }), { headers: { "x-tdai-user-key": "key-u1" } });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("fail-open"))).toBe(true);
  });

  it("enforce + 白名单命中 ⇒ 200 且一次查询都不发", async () => {
    const check = makeCheck();
    const res = await callV3(makeDeps({
      authBinding: {
        ...DEFAULT_AUTH_BINDING,
        requireTeamOwnership: "enforce",
        teamOwnershipWhitelist: ["t1"],
      },
      checkTeamOwnership: check,
    }), { headers: { "x-tdai-user-key": "key-u1" } });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(check).not.toHaveBeenCalled();
  });
});
