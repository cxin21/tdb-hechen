/**
 * 服务间鉴权（KNOWLEDGE_SERVICE_KEY）回归测试 —— issue #115
 *
 * 契约（对齐上游 TencentDB-Agent-Memory feat/server_team 的 middleware/auth.ts）：
 *   - KNOWLEDGE_SERVICE_KEY 为空   → 不启用鉴权，全部端点放行（向后兼容本地/开发部署）；
 *   - KNOWLEDGE_SERVICE_KEY 非空   → /v3 下除只读白名单外的端点必须带
 *     `Authorization: Bearer <key>`，缺失/错误一律 401（fail-closed）；
 *   - 只读白名单（Agent 查询面 + 工具面）保持开放；/health 挂在 /v3 之外，不受影响。
 *
 * 回归用例覆盖票面三条验收：
 *   (1) 写/管理端点无 Bearer → 401；只读端点不受影响；key 未设行为不变；
 *   (2) 只读白名单必须与 code-graph 动态查询工具名（8 个）保持一致；
 *   (3) Bearer 解析（大小写 / 空格 / 错 key / 缺 header）。
 *
 * 本文件不引入 store/engines（避免 better-sqlite3 等本地依赖），只挂最小 Hono 路由。
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  createServiceAuthMiddleware,
  isReadonlyPath,
  safeEqual,
  verifyBearer,
} from "../src/middleware/auth.js";
import { CODEGRAPH_QUERY_TOOL_NAMES } from "../src/codegraph-tool-names.js";

const API_PREFIX = "/v3";
const SERVICE_KEY = "ks-svc-test-0123456789abcdef";

/** 只读端点（Agent 查询面）：应当始终放行 */
const READONLY_POST_PATHS = [
  "/tools/list",
  "/tools/call",
  "/wiki/get",
  "/wiki/list",
  "/wiki/search",
  "/wiki/graph",
  "/wiki/raw/ls",
  "/wiki/raw/read",
  "/wiki/page/ls",
  "/wiki/page/read",
  "/code-graph/list",
  "/code-graph/get",
];

/** 写/管理端点：key 非空且无 Bearer 时必须 401 */
const WRITE_POST_PATHS = [
  "/wiki/ingest",
  "/wiki/sync",
  "/wiki/create",
  "/wiki/delete",
  "/wiki/raw/write",
  "/wiki/raw/rm",
  "/wiki/page/write",
  "/wiki/page/rm",
  "/code-graph/create",
  "/code-graph/update-meta",
  "/code-graph/sync",
  "/code-graph/delete",
  "/internal/llm-binding/set",
  "/internal/llm-binding/status",
  "/internal/llm-binding/list",
  "/admin/settings/get",
  "/admin/settings/set",
  "/admin/settings/revectorize",
  "/auto-sync/trigger",
];

function buildApp(serviceKey: string): Hono {
  const app = new Hono();
  const api = new Hono();

  api.use("*", createServiceAuthMiddleware({ serviceKey }, API_PREFIX));

  for (const p of READONLY_POST_PATHS) api.post(p, (c) => c.json({ ok: true }));
  for (const action of CODEGRAPH_QUERY_TOOL_NAMES) {
    api.post(`/code-graph/${action}`, (c) => c.json({ ok: true }));
  }
  for (const p of WRITE_POST_PATHS) api.post(p, (c) => c.json({ ok: true }));

  api.get("/auto-sync/status", (c) => c.json({ ok: true }));

  app.route(API_PREFIX, api);
  // /health 挂在 /v3 之外（与 server.ts 一致），不受入站鉴权影响
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}

describe("服务间鉴权：key 为空（不启用）", () => {
  it("写端点无 Authorization 也放行（向后兼容）", async () => {
    const app = buildApp("");
    const res = await app.request("/v3/wiki/ingest", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("管理端点无 Authorization 也放行", async () => {
    const app = buildApp("");
    const res = await app.request("/v3/admin/settings/get", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("服务间鉴权：key 非空（fail-closed）", () => {
  it("写端点无 Authorization → 401", async () => {
    const app = buildApp(SERVICE_KEY);
    for (const p of WRITE_POST_PATHS) {
      const res = await app.request(`${API_PREFIX}${p}`, { method: "POST" });
      expect(res.status, `${p} 应 401`).toBe(401);
      const body = await res.json();
      expect(body.code).toBe(401);
      expect(body.message).toContain("unauthorized");
    }
  });

  it("写端点带错误 key → 401", async () => {
    const app = buildApp(SERVICE_KEY);
    const res = await app.request("/v3/wiki/ingest", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("写端点带正确 key → 放行", async () => {
    const app = buildApp(SERVICE_KEY);
    const res = await app.request("/v3/wiki/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  it("bearer 前缀大小写不敏感", async () => {
    const app = buildApp(SERVICE_KEY);
    const res = await app.request("/v3/wiki/ingest", {
      method: "POST",
      headers: { Authorization: `bearer ${SERVICE_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  it("只读端点无 Authorization → 放行（Agent 查询面不受影响）", async () => {
    const app = buildApp(SERVICE_KEY);
    for (const p of READONLY_POST_PATHS) {
      const res = await app.request(`${API_PREFIX}${p}`, { method: "POST" });
      expect(res.status, `${p} 应放行`).toBe(200);
    }
  });

  it("code-graph 动态查询端点（8 个）无 Authorization → 放行", async () => {
    const app = buildApp(SERVICE_KEY);
    expect(CODEGRAPH_QUERY_TOOL_NAMES.length).toBe(8);
    for (const action of CODEGRAPH_QUERY_TOOL_NAMES) {
      const res = await app.request(`${API_PREFIX}/code-graph/${action}`, { method: "POST" });
      expect(res.status, `/code-graph/${action} 应放行`).toBe(200);
    }
  });

  it("GET /auto-sync/status 无 Authorization → 放行", async () => {
    const app = buildApp(SERVICE_KEY);
    const res = await app.request("/v3/auto-sync/status", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("GET /health 无 Authorization → 放行（不在 /v3 内）", async () => {
    const app = buildApp(SERVICE_KEY);
    const res = await app.request("/health", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("PATCH / DELETE 写端点 → 401（非 POST 也受保护）", async () => {
    const app = buildApp(SERVICE_KEY);
    const patch = await app.request("/v3/wiki/abc/source", { method: "PATCH" });
    expect(patch.status).toBe(401);
    const del = await app.request("/v3/wiki/abc", { method: "DELETE" });
    expect(del.status).toBe(401);
  });
});

describe("safeEqual / verifyBearer", () => {
  it("safeEqual：相同为 true，长度不同或内容不同为 false", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "a")).toBe(false);
  });

  it("verifyBearer：解析大小写不敏感的 Bearer，错误格式一律 false", () => {
    expect(verifyBearer(`Bearer ${SERVICE_KEY}`, SERVICE_KEY)).toBe(true);
    expect(verifyBearer(`bearer ${SERVICE_KEY}`, SERVICE_KEY)).toBe(true);
    expect(verifyBearer(`BEARER ${SERVICE_KEY}`, SERVICE_KEY)).toBe(true);
    expect(verifyBearer(`Bearer  ${SERVICE_KEY}`, SERVICE_KEY)).toBe(true);
    expect(verifyBearer(undefined, SERVICE_KEY)).toBe(false);
    expect(verifyBearer("", SERVICE_KEY)).toBe(false);
    expect(verifyBearer("Bearer", SERVICE_KEY)).toBe(false);
    expect(verifyBearer("Bearer ", SERVICE_KEY)).toBe(false);
    expect(verifyBearer(`Bearer ${SERVICE_KEY} extra`, SERVICE_KEY)).toBe(false);
    expect(verifyBearer(`Basic ${SERVICE_KEY}`, SERVICE_KEY)).toBe(false);
    expect(verifyBearer(`Bearer wrong`, SERVICE_KEY)).toBe(false);
  });
});

describe("isReadonlyPath", () => {
  it("只读白名单命中", () => {
    expect(isReadonlyPath("POST", "/tools/list")).toBe(true);
    expect(isReadonlyPath("POST", "/tools/call")).toBe(true);
    expect(isReadonlyPath("POST", "/wiki/list")).toBe(true);
    expect(isReadonlyPath("GET", "/auto-sync/status")).toBe(true);
  });

  it("写/管理面不在白名单", () => {
    expect(isReadonlyPath("POST", "/wiki/ingest")).toBe(false);
    expect(isReadonlyPath("POST", "/internal/llm-binding/status")).toBe(false);
    expect(isReadonlyPath("POST", "/internal/llm-binding/list")).toBe(false);
    expect(isReadonlyPath("POST", "/admin/settings/get")).toBe(false);
    expect(isReadonlyPath("POST", "/auto-sync/trigger")).toBe(false);
    expect(isReadonlyPath("PATCH", "/wiki/abc/source")).toBe(false);
    expect(isReadonlyPath("DELETE", "/wiki/abc")).toBe(false);
  });

  it("code-graph 8 个动态查询端点全部在白名单", () => {
    for (const action of CODEGRAPH_QUERY_TOOL_NAMES) {
      expect(isReadonlyPath("POST", `/code-graph/${action}`)).toBe(true);
    }
  });
});
