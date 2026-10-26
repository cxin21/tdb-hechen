/**
 * 路由清单 × 鉴权白名单的回归护栏 —— issue #115。
 *
 * service-auth.test.ts 用 mock 路由验证中间件行为；本文件补上「真实路由表」这一侧：
 * 从 src/routes/*.ts + src/server.ts 的挂载前缀静态还原 /v3 端点清单，再断言
 *
 *   1. 每个真实端点都被分类（只读白名单 ∪ 显式写端点清单）——新增端点漏登记即红，
 *      逼迫后来者显式决定「只读放行」还是「写端点默认受保护」，杜绝顺手把写端点加进白名单；
 *   2. 只读白名单每条都对应真实路由（无死条目），且与写端点清单互斥；
 *   3. 每个写端点：无 Bearer → 401，带正确 Bearer → 200（对真实路径做端到端断言）；
 *   4. /tools/call 是路径级放行，其前提是工具表全为只读工具——检出疑似写工具即红。
 *
 * 静态抽取而非 import 真实路由，是为了绕开 store/engines 的 better-sqlite3 依赖
 * （本机无原生绑定即整文件 import 失败）；路由清单以源码为真相源，新增端点必然被抽到。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, it, expect } from "vitest";

import {
  createServiceAuthMiddleware,
  isReadonlyPath,
  READONLY_POST_PATHS,
  READONLY_GET_PATHS,
} from "../src/middleware/auth.js";
import { CODEGRAPH_QUERY_TOOL_NAMES } from "../src/codegraph-tool-names.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const readSrc = (p: string) => readFileSync(join(SRC, p), "utf8");

const API_PREFIX = "/v3";
const SERVICE_KEY = "ks-svc-route-guard";

interface RouteEntry {
  method: string;
  path: string;
  origin: string;
}

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

/** 还原 server.ts 的挂载前缀：api.route("<prefix>", createXxxRoutes(...))。 */
function readMountPrefixes(): Map<string, string> {
  const serverSrc = readSrc("server.ts");
  const map = new Map<string, string>();
  for (const m of serverSrc.matchAll(/api\.route\(\s*"([^"]*)"\s*,\s*create(\w+)Routes\(/g)) {
    map.set(m[2], m[1]);
  }
  return map;
}

/** 从路由源码静态抽取 /v3 端点清单（路径已剥掉 API 前缀，与鉴权白名单同口径）。 */
function readRouteInventory(): RouteEntry[] {
  const prefixes = readMountPrefixes();
  const files = [
    "wiki.ts",
    "code-graph.ts",
    "tools.ts",
    "llm-binding.ts",
    "admin-settings.ts",
    "auto-sync.ts",
  ];
  const routes: RouteEntry[] = [];
  for (const file of files) {
    const src = readSrc(join("routes", file));
    const factory = /export function create(\w+)Routes/.exec(src)?.[1];
    const mount = factory ? prefixes.get(factory) : undefined;
    if (factory && mount === undefined) {
      throw new Error(`挂载前缀未解析：${file} → create${factory}Routes（server.ts 挂载方式变了？）`);
    }
    const base = !mount || mount === "/" ? "" : mount;
    for (const m of src.matchAll(/app\.(get|post|patch|put|delete)\(\s*[`"]([^`"$]*)[`"]/g)) {
      routes.push({ method: m[1].toUpperCase(), path: base + m[2], origin: file });
    }
  }
  // code-graph 动态注册的只读查询端点（模板字面量，静态抽不出，按单一真相源补齐）
  for (const action of CODEGRAPH_QUERY_TOOL_NAMES) {
    routes.push({ method: "POST", path: `/code-graph/${action}`, origin: "code-graph.ts(dynamic)" });
  }
  return routes;
}

const inventory = readRouteInventory();

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
  it("真实端点清单非空且覆盖已知模块", () => {
    expect(inventory.length).toBeGreaterThanOrEqual(40);
    const origins = new Set(inventory.map((r) => r.origin));
    expect(origins.size).toBeGreaterThanOrEqual(6);
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
    const toolsSrc = readSrc(join("routes", "tools.ts"));
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
