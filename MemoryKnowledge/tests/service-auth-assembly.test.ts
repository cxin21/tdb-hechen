/**
 * 生产装配行回归 —— issue #132（#115 复审遗留第 3 项）。
 *
 * service-auth-route-guard.test.ts 证明的是「中间件判定逻辑对」：它拿真实路由清单自己搭一个
 * app。那证明不了 server.ts 真的把门禁挂上了 —— 删掉
 * `api.use("*", createServiceAuthMiddleware(config.auth, config.apiPrefix))` 那一行，
 * 那份护栏仍然全绿（白名单/401 判定一条没变）。本文件专盯装配行本身：
 *
 *   1. api 子 app 上确实挂了 createServiceAuthMiddleware，且是路径级 `"*"`；
 *   2. 挂载位置早于首个 api.route(...)（Hono 按注册顺序匹配，晚挂的中间件盖不住先注册的路由）；
 *   3. 根 app 不挂该门禁（/health、/docs、/openapi.json 留在 /v3 之外保持开放）；
 *   4. 门禁实参是 config.auth + config.apiPrefix（不是硬编码空 key / 写死前缀）；
 *   5. /v3 子 app 确实以 config.apiPrefix 挂到根 app（否则门禁与真实路径错位）。
 */
import { describe, it, expect } from "vitest";

import { readServerAssembly, type UseMount } from "./helpers/server-assembly.js";

const assembly = readServerAssembly();
const apiAuthMounts = assembly.authMounts.filter((m) => m.host === "api");
const rootAuthMounts = assembly.authMounts.filter((m) => m.host === "app");

/** 压实空白后的源码原文：断言装配实参时不受换行/缩进影响。 */
const collapse = (s: string): string => s.replace(/\s+/g, " ");

/** 唯一一条 api 侧门禁挂载；缺失或多出时干净失败，而不是在 [0] 上抛 TypeError。 */
function soleApiAuthMount(): UseMount {
  expect(
    apiAuthMounts.length,
    "src/server.ts 未在 api 子 app 上挂载 createServiceAuthMiddleware —— /v3 写/管理面失去入站门禁",
  ).toBe(1);
  return apiAuthMounts[0];
}

describe("生产装配行：server.ts 的门禁挂载", () => {
  it('api 子 app 挂载了服务鉴权中间件：api.use("*", createServiceAuthMiddleware(...))', () => {
    const mount = soleApiAuthMount();
    expect(collapse(mount.text)).toContain('"*"');
    expect(collapse(mount.text)).toContain("createServiceAuthMiddleware(");
  });

  it("门禁挂载早于首个 api.route(...)（Hono 按注册顺序匹配，晚挂等于不挂）", () => {
    expect(assembly.firstApiRouteIndex, "server.ts 里没有任何 api.route(...)？装配结构变了").toBeGreaterThan(-1);
    expect(
      soleApiAuthMount().index,
      "createServiceAuthMiddleware 注册在首个 api.route(...) 之后 —— 先注册的路由不会被该中间件覆盖",
    ).toBeLessThan(assembly.firstApiRouteIndex);
  });

  it("门禁实参用配置（config.auth / config.apiPrefix），不是硬编码", () => {
    expect(collapse(soleApiAuthMount().text)).toContain(
      "createServiceAuthMiddleware(config.auth, config.apiPrefix)",
    );
  });

  it("根 app 未挂该门禁：/health、/docs、/openapi.json 保持开放", () => {
    expect(
      rootAuthMounts.map((m) => m.text),
      "根 app 上挂了服务鉴权中间件 —— 会误伤 /health、/docs、/openapi.json（这三者本应挂在 /v3 之外）",
    ).toEqual([]);
    expect(assembly.apiMountedAtPrefix, "未找到 app.route(config.apiPrefix, api)：/v3 子 app 没挂到根 app").toBe(true);
  });
});
