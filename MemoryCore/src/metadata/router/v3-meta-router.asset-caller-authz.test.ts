/**
 * issue #116 回归：asset/get 与 asset/list 的调用者过滤（水平越权）。
 *
 * bug（修复前）：路由把 caller 丢弃成 `_c`，直连 `getAssetById` / `listAssetsByTeam`，
 * 于是任意持 asset_id 的调用者都能读他人资产元数据、并能分页枚举整个 team 的全量资产。
 *
 * 期望语义（与上游 TencentDB-Agent-Memory 对齐）：
 *   - asset/get：system_admin 豁免 / owner 恒可读 / 其余走 checkAssetPermission；
 *     无权返回 null → 路由 404（与「不存在」同文案，不泄露资产存在性，不是 403）。
 *   - asset/list：system_admin 全量 / 非团队成员空页 / 成员逐条过滤（权限在分页前完成，total 准确）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as http from "node:http";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import { handleV3MetaRoute, V3_PREFIX, type V3MetaRouterDeps } from "./v3-meta-router.js";
import type { ApiResponseEnvelope } from "../../gateway/v2-schemas.js";
import type {
  AssetEntity,
  AssetFilter,
  ListPage,
  PaginatedResult,
  PaginationParams,
} from "../types.js";

const INSTANCE = "authz-test-instance";

interface RouteResult {
  status: number;
  body: ApiResponseEnvelope<unknown>;
}

function createDeps(svc: MetadataService): V3MetaRouterDeps {
  return {
    getMetadataService: (instanceId: string) => (instanceId === INSTANCE ? svc : undefined),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

async function callRoute(
  deps: V3MetaRouterDeps,
  path: string,
  body: unknown,
  userKey: string,
): Promise<RouteResult> {
  const result: RouteResult = { status: 0, body: { code: -1, message: "", request_id: "" } };
  const req = {
    headers: {
      "x-tdai-service-id": INSTANCE,
      "x-tdai-user-key": userKey,
    },
  } as unknown as http.IncomingMessage;
  const res = {} as unknown as http.ServerResponse;
  const handled = await handleV3MetaRoute(
    req,
    res,
    path,
    "POST",
    async <T,>(_req: http.IncomingMessage): Promise<T> => body as T,
    (_res: http.ServerResponse, status: number, payload: unknown) => {
      result.status = status;
      result.body = payload as ApiResponseEnvelope<unknown>;
    },
    deps,
  );
  expect(handled, `route ${path} should be handled`).toBe(true);
  return result;
}

interface Fixture {
  store: SqliteMetadataStore;
  svc: MetadataService;
  deps: V3MetaRouterDeps;
  adminKey: string;
  aliceKey: string;   // team owner
  carolKey: string;   // 同 team 的普通成员
  bobKey: string;     // 另一个 team 的人，对本 team 完全无关系
  aliceUserId: string;
  carolUserId: string;
  teamId: string;
  alicePrivateId: string;
  aliceTeamSharedId: string;
  aliceArchivedId: string;
}

async function seed(): Promise<Fixture> {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  const svc = new MetadataService(store, INSTANCE);
  const deps = createDeps(svc);

  // init-admin 要求空库，必须最先建
  const admin = await svc.initAdminUser({ username: "root" });
  const alice = await svc.createNormalUser({ username: "alice" });
  const carol = await svc.createNormalUser({ username: "carol" });
  const bob = await svc.createNormalUser({ username: "bob" });

  const team = await svc.createTeam({ name: "team-a", owner_user_id: alice.user_id });
  await svc.addTeamMember({ team_id: team.team_id, user_id: carol.user_id, role: "member" });

  // bob 有自己独立的 team，确保他是「合法的别的用户」，而不是不存在的人
  const bobTeam = await svc.createTeam({ name: "team-b", owner_user_id: bob.user_id });
  expect(bobTeam.team_id).not.toBe(team.team_id);

  const alicePrivate = await svc.createAsset({
    asset_id: "asset_alice_private",
    team_id: team.team_id,
    asset_type: "skill",
    name: "alice-private",
    owner_user_id: alice.user_id,
    source_type: "manual",
    visibility: "private",
  });
  const aliceTeamShared = await svc.createAsset({
    asset_id: "asset_alice_team_shared",
    team_id: team.team_id,
    asset_type: "skill",
    name: "alice-team-shared",
    owner_user_id: alice.user_id,
    source_type: "manual",
    visibility: "team",
  });

  const aliceArchived = await svc.createAsset({
    asset_id: "asset_alice_archived",
    team_id: team.team_id,
    asset_type: "skill",
    name: "alice-archived",
    owner_user_id: alice.user_id,
    source_type: "manual",
    visibility: "team",
    status: "archived",
  });

  return {
    store,
    svc,
    deps,
    adminKey: admin.user_key,
    aliceKey: alice.default_user_key,
    carolKey: carol.default_user_key,
    bobKey: bob.default_user_key,
    aliceUserId: alice.user_id,
    carolUserId: carol.user_id,
    teamId: team.team_id,
    alicePrivateId: alicePrivate.asset_id,
    aliceTeamSharedId: aliceTeamShared.asset_id,
    aliceArchivedId: aliceArchived.asset_id,
  };
}

describe("issue #116 — asset/get 调用者过滤", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await seed();
  });

  afterEach(() => {
    fx.store.close();
  });

  it("非 owner 非成员读他人 private 资产：404，且与「资产不存在」同文案（不是 403）", async () => {
    const forbidden = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: fx.alicePrivateId },
      fx.bobKey,
    );
    const missing = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: "asset_does_not_exist" },
      fx.bobKey,
    );

    expect(forbidden.status).toBe(404);
    expect(forbidden.body.code).toBe(404);
    expect(forbidden.status).not.toBe(403);
    // 不泄露存在性：两种情况除回显的 id 外完全一致
    expect(forbidden.body.message).toBe(`asset_not_found: not found: ${fx.alicePrivateId}`);
    expect(missing.body.message).toBe("asset_not_found: not found: asset_does_not_exist");
  });

  it("同 team 成员读他人的 private 资产：仍然 404（visibility 门）", async () => {
    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: fx.alicePrivateId },
      fx.carolKey,
    );
    expect(res.status).toBe(404);
  });

  it("owner 读自己的 private 资产：200", async () => {
    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: fx.alicePrivateId },
      fx.aliceKey,
    );
    expect(res.status).toBe(200);
    expect((res.body.data as AssetEntity).asset_id).toBe(fx.alicePrivateId);
  });

  it("同 team 成员读 visibility=team 资产：200", async () => {
    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: fx.aliceTeamSharedId },
      fx.carolKey,
    );
    expect(res.status).toBe(200);
    expect((res.body.data as AssetEntity).asset_id).toBe(fx.aliceTeamSharedId);
  });

  it("system_admin 行为不变：跨 team 也能读", async () => {
    const priv = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: fx.alicePrivateId },
      fx.adminKey,
    );
    const shared = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: fx.aliceTeamSharedId },
      fx.adminKey,
    );
    expect(priv.status).toBe(200);
    expect(shared.status).toBe(200);
  });
});

describe("issue #116 — asset/list 调用者过滤", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await seed();
  });

  afterEach(() => {
    fx.store.close();
  });

  function ids(res: RouteResult): string[] {
    return (res.body.data as PaginatedResult<AssetEntity>).items.map((a) => a.asset_id);
  }

  function total(res: RouteResult): number {
    return (res.body.data as PaginatedResult<AssetEntity>).total;
  }

  it("非团队成员列本 team 资产：空页、total=0（不泄露 team 信息）", async () => {
    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId },
      fx.bobKey,
    );
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(ids(res)).toEqual([]);
    expect(total(res)).toBe(0);
  });

  it("普通成员只看到有权限的资产：看不到他人 private，total 准确", async () => {
    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId },
      fx.carolKey,
    );
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([fx.aliceTeamSharedId]);
    expect(total(res)).toBe(1);
  });

  it("owner 看到自己 team 的全部资产", async () => {
    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId },
      fx.aliceKey,
    );
    expect(res.status).toBe(200);
    expect(ids(res).sort()).toEqual([fx.alicePrivateId, fx.aliceTeamSharedId].sort());
    expect(total(res)).toBe(2);
  });

  it("权限过滤在分页前完成：limit=1 时 total 仍是过滤后的总数", async () => {
    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId, limit: 1, offset: 0 },
      fx.aliceKey,
    );
    expect(res.status).toBe(200);
    expect(ids(res)).toHaveLength(1);
    expect(total(res)).toBe(2);
  });

  it("restricted 资产：ACL 授予后可读（get 200、list 包含），owner 不受影响", async () => {
    const restrictedId = "asset_alice_restricted";
    await fx.svc.createAsset({
      asset_id: restrictedId,
      team_id: fx.teamId,
      asset_type: "skill",
      name: "alice-restricted",
      owner_user_id: fx.aliceUserId,
      source_type: "manual",
      visibility: "restricted",
    });

    const getBefore = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: restrictedId },
      fx.carolKey,
    );
    const listBefore = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId },
      fx.carolKey,
    );
    const ownerGet = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: restrictedId },
      fx.aliceKey,
    );

    expect(getBefore.status).toBe(404);
    expect(ids(listBefore)).not.toContain(restrictedId);
    expect(ownerGet.status).toBe(200);
    expect((ownerGet.body.data as AssetEntity).asset_id).toBe(restrictedId);

    // restricted = 严格 ACL 白名单：显式授予 read 后，非 admin 成员才可读
    await fx.svc.grantAcl({
      asset_id: restrictedId,
      subject_type: "user",
      subject_id: fx.carolUserId,
      permission: "read",
      granted_by: fx.aliceUserId,
    });

    const getAfter = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: restrictedId },
      fx.carolKey,
    );
    const listAfter = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId },
      fx.carolKey,
    );
    expect(getAfter.status).toBe(200);
    expect((getAfter.body.data as AssetEntity).asset_id).toBe(restrictedId);
    expect(ids(listAfter)).toContain(restrictedId);
    expect(total(listAfter)).toBe(2);
  });

  it("private 资产：即使 ACL 授予 read 也读不到（private 严格只有 owner）", async () => {
    await fx.svc.grantAcl({
      asset_id: fx.alicePrivateId,
      subject_type: "user",
      subject_id: fx.carolUserId,
      permission: "read",
      granted_by: fx.aliceUserId,
    });

    const get = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: fx.alicePrivateId },
      fx.carolKey,
    );
    const list = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId },
      fx.carolKey,
    );
    expect(get.status).toBe(404);
    expect(ids(list)).not.toContain(fx.alicePrivateId);
  });

  it("system_admin 行为不变：全量（含他人 private）", async () => {
    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId },
      fx.adminKey,
    );
    expect(res.status).toBe(200);
    expect(ids(res).sort()).toEqual([fx.alicePrivateId, fx.aliceTeamSharedId].sort());
    expect(total(res)).toBe(2);
  });
});

describe("issue #116 收尾 — 归档口径统一（asset/list 与 asset/list-accessible 同一谓词）", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await seed();
  });

  afterEach(() => {
    fx.store.close();
  });

  function ids(res: RouteResult): string[] {
    return (res.body.data as PaginatedResult<AssetEntity>).items.map((a) => a.asset_id);
  }

  function total(res: RouteResult): number {
    return (res.body.data as PaginatedResult<AssetEntity>).total;
  }

  it("owner：默认列表不含自己的归档资产，但按 id 仍可读（显式寻址通道不变）", async () => {
    const list = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId },
      fx.aliceKey,
    );
    expect(ids(list)).not.toContain(fx.aliceArchivedId);
    expect(total(list)).toBe(2);

    // get 不受列表口径影响：owner 管理/恢复归档资产仍要能读到
    const get = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/get`,
      { asset_id: fx.aliceArchivedId },
      fx.aliceKey,
    );
    expect(get.status).toBe(200);
    expect((get.body.data as AssetEntity).status).toBe("archived");
  });

  it("owner：显式 status=archived 才返回归档资产", async () => {
    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId, status: "archived" },
      fx.aliceKey,
    );
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([fx.aliceArchivedId]);
    expect(total(res)).toBe(1);
  });

  it("普通成员：显式 status=archived 也拿不到他人归档资产（可见性判定先于 status）", async () => {
    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId, status: "archived" },
      fx.carolKey,
    );
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([]);
    expect(total(res)).toBe(0);
  });

  it("system_admin：默认列表同样隐藏归档（口径不随权限放宽）", async () => {
    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId },
      fx.adminKey,
    );
    expect(res.status).toBe(200);
    expect(ids(res)).not.toContain(fx.aliceArchivedId);
    expect(total(res)).toBe(2);
  });

  it("asset/list-accessible 与 asset/list 口径一致：owner 视角都不含归档", async () => {
    const accessible = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list-accessible`,
      { user_id: fx.aliceUserId, team_id: fx.teamId },
      fx.aliceKey,
    );
    expect(accessible.status).toBe(200);
    expect(ids(accessible)).not.toContain(fx.aliceArchivedId);
    expect(total(accessible)).toBe(2);
  });

  it("deprecated 同样不进默认列表（谓词覆盖三态，不只看 archived）", async () => {
    const deprecatedId = "asset_alice_deprecated";
    await fx.svc.createAsset({
      asset_id: deprecatedId,
      team_id: fx.teamId,
      asset_type: "skill",
      name: "alice-deprecated",
      owner_user_id: fx.aliceUserId,
      source_type: "manual",
      visibility: "team",
      status: "deprecated",
    });

    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list`,
      { team_id: fx.teamId },
      fx.aliceKey,
    );
    expect(ids(res)).not.toContain(deprecatedId);
    expect(total(res)).toBe(2);
  });
});

describe("issue #116 收尾 — agent 主体的 ACL", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await seed();
  });

  afterEach(() => {
    fx.store.close();
  });

  function ids(res: RouteResult): string[] {
    return (res.body.data as PaginatedResult<AssetEntity>).items.map((a) => a.asset_id);
  }

  async function seedAgent(): Promise<string> {
    // 用 store 直建：svc.createAgent 会顺带 ensureChatMemoryAsset，多造资产污染 list 断言
    const agent = await fx.store.createAgent({
      team_id: fx.teamId,
      owner_user_id: fx.aliceUserId,
      name: "authz-agent",
    });
    return agent.agent_id;
  }

  it("restricted 资产授予 agent：acl/check 只有带 agent_id 才 allowed", async () => {
    const agentId = await seedAgent();
    const assetId = "asset_alice_restricted_agent";
    await fx.svc.createAsset({
      asset_id: assetId,
      team_id: fx.teamId,
      asset_type: "skill",
      name: "alice-restricted-agent",
      owner_user_id: fx.aliceUserId,
      source_type: "manual",
      visibility: "restricted",
    });
    await fx.svc.grantAcl({
      asset_id: assetId,
      subject_type: "agent",
      subject_id: agentId,
      permission: "read",
      granted_by: fx.aliceUserId,
    });

    const withAgent = await callRoute(
      fx.deps,
      `${V3_PREFIX}/acl/check`,
      { user_id: fx.carolUserId, asset_id: assetId, action: "read", agent_id: agentId },
      fx.carolKey,
    );
    const withoutAgent = await callRoute(
      fx.deps,
      `${V3_PREFIX}/acl/check`,
      { user_id: fx.carolUserId, asset_id: assetId, action: "read" },
      fx.carolKey,
    );

    expect(withAgent.status).toBe(200);
    expect((withAgent.body.data as { allowed: boolean }).allowed).toBe(true);
    expect(withoutAgent.status).toBe(200);
    expect((withoutAgent.body.data as { allowed: boolean }).allowed).toBe(false);
  });

  it("asset/list-accessible：带 agent_id 才包含该 restricted 资产", async () => {
    const agentId = await seedAgent();
    const assetId = "asset_alice_restricted_agent_list";
    await fx.svc.createAsset({
      asset_id: assetId,
      team_id: fx.teamId,
      asset_type: "skill",
      name: "alice-restricted-agent-list",
      owner_user_id: fx.aliceUserId,
      source_type: "manual",
      visibility: "restricted",
    });
    await fx.svc.grantAcl({
      asset_id: assetId,
      subject_type: "agent",
      subject_id: agentId,
      permission: "read",
      granted_by: fx.aliceUserId,
    });

    const withAgent = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list-accessible`,
      { user_id: fx.carolUserId, team_id: fx.teamId, agent_id: agentId },
      fx.carolKey,
    );
    const withoutAgent = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list-accessible`,
      { user_id: fx.carolUserId, team_id: fx.teamId },
      fx.carolKey,
    );

    expect(ids(withAgent)).toContain(assetId);
    expect(ids(withoutAgent)).not.toContain(assetId);
  });

  it("agent ACL 不放宽 private：授予 agent read 后仍然读不到", async () => {
    const agentId = await seedAgent();
    await fx.svc.grantAcl({
      asset_id: fx.alicePrivateId,
      subject_type: "agent",
      subject_id: agentId,
      permission: "read",
      granted_by: fx.aliceUserId,
    });

    const check = await callRoute(
      fx.deps,
      `${V3_PREFIX}/acl/check`,
      { user_id: fx.carolUserId, asset_id: fx.alicePrivateId, action: "read", agent_id: agentId },
      fx.carolKey,
    );
    const list = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list-accessible`,
      { user_id: fx.carolUserId, team_id: fx.teamId, agent_id: agentId },
      fx.carolKey,
    );

    expect((check.body.data as { allowed: boolean }).allowed).toBe(false);
    expect(ids(list)).not.toContain(fx.alicePrivateId);
  });
});


describe("issue #116 收尾 2 — 两个 list 端点同一采集口径", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await seed();
  });

  afterEach(() => {
    fx.store.close();
  });

  function idsOf(res: RouteResult): string[] {
    return (res.body.data as PaginatedResult<AssetEntity>).items.map((a) => a.asset_id);
  }

  function totalOf(res: RouteResult): number {
    return (res.body.data as PaginatedResult<AssetEntity>).total;
  }

  /**
   * 模拟「store 返回序不是 created_at 倒序」的实现（Mongo / 未来的新后端）：
   * 读取方（service）必须自己负责排序，不能把 store 的返回序当契约。
   */
  class AscOrderStore extends SqliteMetadataStore {
    override listAssetsByTeam(
      teamId: string,
      pagination?: PaginationParams | null,
      filter?: AssetFilter,
    ): ListPage<AssetEntity> {
      const page = super.listAssetsByTeam(teamId, pagination, filter);
      return { ...page, items: [...page.items].sort((a, b) => a.created_at.localeCompare(b.created_at)) };
    }
  }

  interface OrderScenario {
    store: SqliteMetadataStore;
    deps: V3MetaRouterDeps;
    aliceKey: string;
    aliceUserId: string;
    teamId: string;
    /** 创建顺序为 older → middle → newer，因此倒序期望是它的反序。 */
    idsDesc: string[];
  }

  async function seedOrderScenario(store: SqliteMetadataStore): Promise<OrderScenario> {
    store.init();
    const svc = new MetadataService(store, INSTANCE);
    const deps = createDeps(svc);
    await svc.initAdminUser({ username: "root" });
    const alice = await svc.createNormalUser({ username: "alice" });
    const team = await svc.createTeam({ name: "team-order", owner_user_id: alice.user_id });

    const created: string[] = [];
    for (const name of ["older", "middle", "newer"]) {
      // created_at 由 store 取当前毫秒；拉开 5ms 让三条时间戳严格递增
      await new Promise((resolve) => setTimeout(resolve, 5));
      const asset = await svc.createAsset({
        asset_id: `asset_order_${name}`,
        team_id: team.team_id,
        asset_type: "skill",
        name,
        owner_user_id: alice.user_id,
        source_type: "manual",
        visibility: "team",
      });
      created.push(asset.asset_id);
    }

    return {
      store,
      deps,
      aliceKey: alice.default_user_key,
      aliceUserId: alice.user_id,
      teamId: team.team_id,
      idsDesc: [...created].reverse(),
    };
  }

  it("asset/list 自己负责排序：store 返回 asc 序时仍按 created_at 倒序", async () => {
    const sc = await seedOrderScenario(new AscOrderStore(":memory:"));
    try {
      const res = await callRoute(sc.deps, `${V3_PREFIX}/asset/list`, { team_id: sc.teamId }, sc.aliceKey);
      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual(sc.idsDesc);
    } finally {
      sc.store.close();
    }
  });

  it("asset/list 与 asset/list-accessible 对同一可见集合返回完全相同的 id 序列", async () => {
    const sc = await seedOrderScenario(new AscOrderStore(":memory:"));
    try {
      const byTeam = await callRoute(sc.deps, `${V3_PREFIX}/asset/list`, { team_id: sc.teamId }, sc.aliceKey);
      const accessible = await callRoute(
        sc.deps,
        `${V3_PREFIX}/asset/list-accessible`,
        { user_id: sc.aliceUserId, team_id: sc.teamId },
        sc.aliceKey,
      );

      expect(idsOf(byTeam)).toEqual(sc.idsDesc);
      expect(idsOf(accessible)).toEqual(idsOf(byTeam));
      expect(totalOf(byTeam)).toBe(sc.idsDesc.length);
      expect(totalOf(accessible)).toBe(sc.idsDesc.length);
    } finally {
      sc.store.close();
    }
  });

  it("list-accessible 跨 team 合并后仍按 created_at 倒序（不按 team 遍历顺序拼接）", async () => {
    // carol 已是 team-a 成员；再让她拥有一个 team-c，并在那里放一条更晚创建的资产
    const teamC = await fx.svc.createTeam({ name: "team-c", owner_user_id: fx.carolUserId });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newest = await fx.svc.createAsset({
      asset_id: "asset_carol_team_c",
      team_id: teamC.team_id,
      asset_type: "skill",
      name: "carol-team-c",
      owner_user_id: fx.carolUserId,
      source_type: "manual",
      visibility: "team",
    });

    const res = await callRoute(
      fx.deps,
      `${V3_PREFIX}/asset/list-accessible`,
      { user_id: fx.carolUserId },
      fx.carolKey,
    );
    const ids = idsOf(res);

    expect(ids[0]).toBe(newest.asset_id);
    // 可见集合：team-c 的新资产 + team-a 里 visibility=team 的共享资产（private 不可读、archived 默认隐藏）
    expect(ids).toContain(fx.aliceTeamSharedId);
    expect(ids).not.toContain(fx.alicePrivateId);
    expect(ids).not.toContain(fx.aliceArchivedId);
    expect(ids).toHaveLength(2);

    // 顺序等价于「合并后再按 created_at 倒序」
    const expected: AssetEntity[] = [];
    for (const id of ids) expected.push((await fx.svc.getAssetById(id))!);
    expect(ids).toEqual(
      [...expected].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((a) => a.asset_id),
    );
  });

  it("system_admin 的 asset/list 仍含他人 private，且与 created_at 倒序一致", async () => {
    const res = await callRoute(fx.deps, `${V3_PREFIX}/asset/list`, { team_id: fx.teamId }, fx.adminKey);
    const ids = idsOf(res);

    expect(ids).toContain(fx.alicePrivateId);
    expect(ids).not.toContain(fx.aliceArchivedId);
    const assets = await Promise.all(ids.map((id) => fx.svc.getAssetById(id)));
    const expected = [...(assets as AssetEntity[])]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((a) => a.asset_id);
    expect(ids).toEqual(expected);
  });
});
