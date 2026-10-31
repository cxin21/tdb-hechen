/**
 * 路由清单 × 鉴权白名单的回归护栏 —— issue #115 / #132。
 *
 * service-auth.test.ts 用 mock 路由验证中间件行为；本文件补上「真实路由表」这一侧：
 * 从 src/routes/*.ts（目录即清单）+ src/server.ts 的挂载表静态还原 /v3 端点清单，再断言
 *
 *   1. 每个真实端点都被分类（只读白名单 ∪ 显式写端点清单）——新增端点漏登记即红，
 *      逼迫后来者显式决定「只读放行」还是「写端点默认受保护」，杜绝顺手把写端点加进白名单；
 *   2. 只读白名单每条都对应真实路由（无死条目），且与写端点清单互斥；
 *   3. 每个写端点：无 Bearer → 401，带正确 Bearer → 200（对真实路径做端到端断言）；
 *   4. /tools/call 是路径级放行，其前提是工具表全为只读工具——检出疑似写工具即红；
 *   5. 路由清单与 src/routes 目录、server.ts 挂载表三方对齐：新增路由文件漏挂、
 *      新增挂载指向不存在的文件、把路由挂到根 app（绕过 /v3 门禁）都变红。
 *
 * 静态抽取而非 import 真实路由，是为了绕开 store/engines 的 better-sqlite3 依赖
 * 与 telemetry 启动副作用；路由清单以源码为真相源。抽取不到的路由注册（路径是变量/
 * 模板）也会变红，见「动态注册必须显式登记」——否则新增端点可能静默逃过分类。
 */
import { Hono } from "hono";
import { describe, it, expect } from "vitest";

import {
  createServiceAuthMiddleware,
  isReadonlyPath,
  READONLY_POST_PATHS,
  READONLY_GET_PATHS,
} from "../src/middleware/auth.js";
import {
  readMountTable,
  readRouteFiles,
  readSrc,
  readV3Inventory,
  type RouteEntry,
} from "./helpers/server-assembly.js";

const API_PREFIX = "/v3";
const SERVICE_KEY = "ks-svc-route-guard";

/** 写端点清单（人工审阅记录）：非只读的 /v3 端点全在此列，受 Bearer 保护。 */
const WRITE_ROUTES: ReadonlySet<string> = new Set([
  "POST /wiki/ingest",
  "POST /wiki/sync",
  "POST /wiki/delete",
  "POST /wiki/update-meta",
  "POST /wiki/create",
  "PATCH /wiki/:id/source",
  "POST /wiki/:id/test",
  "POST /wiki/:id/refetch",
  "DELETE /wiki/:id",
  "POST /wiki/raw/write",
  "POST /wiki/raw/rm",
  "POST /wiki/page/write",
  "POST /wiki/page/rm",
  "POST /code-graph/create",
  "POST /code-graph/update-meta",
  "POST /code-graph/sync",
  "POST /code-graph/delete",
  "POST /internal/llm-binding/set",
  "POST /internal/llm-binding/status",
  "POST /internal/llm-binding/list",
  "POST /admin/settings/get",
  "POST /admin/settings/set",
  "POST /admin/settings/revectorize",
  "POST /auto-sync/trigger",
]);

/** 允许挂在根 app（/v3 门禁之外）的公开路由工厂。新增条目必须先证明「本就该公开」。 */
const PUBLIC_ROOT_FACTORIES: ReadonlySet<string> = new Set(["createHealthRoutes"]);

const routeFiles = readRouteFiles();
const mounts = readMountTable();
const { routes: inventory, unresolved } = readV3Inventory();

/** 把 :id 之类参数段换成合法 id，便于对真实路径发请求。 */
function concretePath(path: string): string {
  return path.replace(/:[^/]+/g, "wiki-1234abcd");
}

/** 搭一个挂着真实中间件、按真实清单注册路由的最小服务。 */
function buildApp(routes: RouteEntry[]) {
  const app = new Hono();
  const api = new Hono();
  api.use("*", createServiceAuthMiddleware({ serviceKey: SERVICE_KEY }, API_PREFIX));
  for (const r of routes) {
    const handler = (c: never) => (c as { json: (b: unknown) => unknown }).json({ ok: true });
    const path = r.path;
    if (r.method === "GET") api.get(path, handler as never);
    else if (r.method === "POST") api.post(path, handler as never);
    else if (r.method === "PATCH") api.patch(path, handler as never);
    else if (r.method === "PUT") api.put(path, handler as never);
    else if (r.method === "DELETE") api.delete(path, handler as never);
  }
  app.route(API_PREFIX, api);
  // /health 挂在根 app（不在 /v3 内）——保持开放
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}

describe("路由清单 × 鉴权白名单（真实路由表护栏）", () => {
  it("真实端点清单非空，且每个 api 挂载都抽到了端点", () => {
    expect(inventory.length).toBeGreaterThanOrEqual(40);
    const origins = new Set(inventory.map((r) => r.origin));
    const apiMountedFiles = mounts.filter((m) => m.host === "api").map((m) => m.file as string);
    expect(apiMountedFiles.length).toBeGreaterThanOrEqual(6);
    for (const file of apiMountedFiles) {
      expect(origins.has(file), `已挂载的路由文件没抽到任何端点：${file}`).toBe(true);
    }
  });

  it("src/routes 下每个文件都导出 createXxxRoutes 工厂（目录即路由模块）", () => {
    const broken = routeFiles.filter((f) => !f.factory).map((f) => f.file);
    expect(broken, `这些文件在 src/routes 下却没有导出 createXxxRoutes：${broken.join(", ")}`).toEqual([]);
  });

  it("src/routes 下每个路由文件都已在 server.ts 挂载（漏挂 = 死代码 / 逃过门禁分类）", () => {
    const mounted = new Set(mounts.map((m) => m.file));
    const unmounted = routeFiles.map((f) => f.file).filter((f) => !mounted.has(f));
    expect(
      unmounted,
      `未在 server.ts 挂载的路由文件：${unmounted.join(", ")}——挂上（或删掉），否则端点会静默逃过鉴权分类`,
    ).toEqual([]);
  });

  it("server.ts 的每个挂载都指向真实路由文件（无死挂载）", () => {
    const dead = mounts
      .filter((m) => m.file === undefined)
      .map((m) => `${m.host}.route("${m.prefix}", ${m.factory}(...))`);
    expect(dead, `挂载指向不存在的路由工厂：${dead.join(", ")}`).toEqual([]);
  });

  it("每个路由文件只挂载一次（重复挂载会重复执行门禁判定）", () => {
    const counts = new Map<string, number>();
    for (const m of mounts) {
      if (m.file === undefined) continue;
      counts.set(m.file, (counts.get(m.file) ?? 0) + 1);
    }
    const duplicated = [...counts].filter(([, n]) => n > 1).map(([file]) => file);
    expect(duplicated, `重复挂载的路由文件：${duplicated.join(", ")}`).toEqual([]);
  });

  it("根 app 只挂公开路由（health）：/v3 路由必须走 api 子 app，否则绕过门禁", () => {
    const rootMounts = mounts.filter((m) => m.host === "app");
    for (const m of rootMounts) {
      expect(
        PUBLIC_ROOT_FACTORIES.has(m.factory),
        `根 app 挂载了非公开路由：app.route("${m.prefix}", ${m.factory}(...))——根 app 在 /v3 门禁之外`,
      ).toBe(true);
      expect(m.prefix, "根 app 的公开路由应挂在前缀 /（/health）").toBe("/");
    }
  });

  it("动态注册（非字面量路径）必须显式登记：路由抽取无遗漏", () => {
    expect(
      unresolved,
      `这些文件有抽取不到的路由注册（路径是变量/模板），需在 tests/helpers/server-assembly.ts 里显式处理：${JSON.stringify(unresolved)}`,
    ).toEqual([]);
  });

  it("每个真实端点都被分类：只读白名单 ∪ 写端点清单（新增端点必须显式登记）", () => {
    const unclassified = inventory
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => {
        const [method, path] = key.split(" ");
        if (isReadonlyPath(method, path)) return false;
        return !WRITE_ROUTES.has(key);
      });
    expect(unclassified, `未登记的端点（默认受保护；若确为只读请加入白名单并在此登记）: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("写端点清单与只读白名单互斥（写端点不得出现在白名单里）", () => {
    const leaked = [...WRITE_ROUTES].filter((key) => {
      const [method, path] = key.split(" ");
      return isReadonlyPath(method, path);
    });
    expect(leaked, `写端点被放进只读白名单：${leaked.join(", ")}`).toEqual([]);
  });

  it("只读白名单每条都对应真实路由（无死条目）", () => {
    for (const path of READONLY_POST_PATHS) {
      expect(
        inventory.some((r) => r.method === "POST" && r.path === path),
        `白名单条目无对应 POST 路由：POST ${path}`,
      ).toBe(true);
    }
    for (const path of READONLY_GET_PATHS) {
      expect(
        inventory.some((r) => r.method === "GET" && r.path === path),
        `白名单条目无对应 GET 路由：GET ${path}`,
      ).toBe(true);
    }
  });

  it("写端点：无 Bearer → 401；带正确 Bearer → 200（逐条真实路径）", async () => {
    const app = buildApp(inventory);
    const writes = inventory.filter((r) => WRITE_ROUTES.has(`${r.method} ${r.path}`));
    expect(writes.length).toBeGreaterThanOrEqual(20);
    for (const r of writes) {
      const url = `${API_PREFIX}${concretePath(r.path)}`;
      const anon = await app.request(url, { method: r.method });
      expect(anon.status, `${r.method} ${r.path} 未带 Bearer 应 401`).toBe(401);
      const body = await anon.json();
      expect(body.code).toBe(401);
      expect(String(body.message)).toContain("unauthorized");

      const authed = await app.request(url, {
        method: r.method,
        headers: { authorization: `Bearer ${SERVICE_KEY}` },
      });
      expect(authed.status, `${r.method} ${r.path} 带正确 Bearer 应放行`).toBe(200);
    }
  });

  it("只读端点：不带 Bearer 也放行（Agent 查询面保持开放）", async () => {
    const app = buildApp(inventory);
    const reads = inventory.filter((r) => {
      const [method, path] = [r.method, r.path];
      return isReadonlyPath(method, path);
    });
    expect(reads.length).toBeGreaterThanOrEqual(20);
    for (const r of reads) {
      const res = await app.request(`${API_PREFIX}${concretePath(r.path)}`, { method: r.method });
      expect(res.status, `${r.method} ${r.path} 只读端点应免鉴权`).toBe(200);
    }
  });

  it("未知新端点默认受保护（fail-closed：白名单之外的路径一律 401）", async () => {
    const app = buildApp(inventory);
    const res = await app.request(`${API_PREFIX}/wiki/brand-new-endpoint`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("/health 在 /v3 之外，不受鉴权中间件影响", async () => {
    const app = buildApp(inventory);
    const res = await app.request("/health", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("/tools/call 放行的前提：工具表里不得出现写工具（否则路径级放行即 fail-open 入口）", () => {
    const toolsSrc = readSrc("routes", "tools.ts");
    const start = toolsSrc.indexOf("const WIKI_TOOLS");
    const end = toolsSrc.indexOf("const WIKI_TOOL_NAMES");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const registry = toolsSrc.slice(start, end);
    const names = [...registry.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(8);
    const writeLike = /(ingest|write|delete|update|create|sync|remove|trigger|upsert|drop|patch|put|rm$|set)/i;
    const suspicious = names.filter((n) => writeLike.test(n));
    expect(
      suspicious,
      `工具表出现疑似写工具：${suspicious.join(", ")}——/tools/call 是路径级放行，写工具需改为按 tool_name 判只读`,
    ).toEqual([]);
  });
});
