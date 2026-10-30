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
import type { AssetEntity, PaginatedResult } from "../types.js";

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
  teamId: string;
  alicePrivateId: string;
  aliceTeamSharedId: string;
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

  return {
    store,
    svc,
    deps,
    adminKey: admin.user_key,
    aliceKey: alice.default_user_key,
    carolKey: carol.default_user_key,
    bobKey: bob.default_user_key,
    aliceUserId: alice.user_id,
    teamId: team.team_id,
    alicePrivateId: alicePrivate.asset_id,
    aliceTeamSharedId: aliceTeamShared.asset_id,
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

  it("restricted 资产：非 owner 成员读不到（get 404、list 不含），owner 不受影响", async () => {
    // 注意：restricted + acl/grant 目前对非 admin 仍一律被拒，因为 checkAssetPermission
    // 的懒加载 ACL 只在 reason === "no_permission" 时才查表（metadata-service.ts:1592，
    // pre-existing，与 #116 无关）。这里只钉住「调用者过滤」这一层的行为。
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
