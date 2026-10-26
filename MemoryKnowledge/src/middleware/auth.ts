/**
 * 服务间鉴权中间件（KNOWLEDGE_SERVICE_KEY）—— issue #115。
 *
 * 模型（对齐 MemoryCore gateway 的 Layer 1 Bearer 语义，与上游
 * TencentDB-Agent-Memory feat/server_team 的 MemoryKnowledge/src/middleware/auth.ts 同源）：
 *   - KNOWLEDGE_SERVICE_KEY 为空  → 不启用鉴权，全部放行（向后兼容本地/开发部署）；
 *   - KNOWLEDGE_SERVICE_KEY 非空  → /v3 下除只读白名单外的端点均要求
 *     `Authorization: Bearer <serviceKey>`，缺失/错误一律 401（fail-closed）。
 *
 * 只读白名单（Agent 直连面）保持开放：
 *   tools/list、tools/call（Agent 自发现与只读工具执行）、wiki 查询类、
 *   code-graph 查询类、auto-sync/status。
 * 注意：llm-binding 的 status/list 虽不回显 api_key 明文，但会暴露 binding
 * 存在性与 base_url（侦察价值），故不放行——唯一调用方 Panel 均携带 key。
 * 写/管理面（wiki ingest、raw/page write、llm-binding/set、admin/settings/*、
 * auto-sync/trigger 等）一律需要 key —— 新增端点默认受保护。
 *
 * /health、/docs、/openapi.json 挂在 api 子 app 之外（server.ts），不受本中间件影响。
 *
 * 与上游的差异（本仓补齐）：上游白名单只列了 /code-graph/list 与 /code-graph/get，
 * 漏掉了 code-graph 动态注册的 8 个只读查询端点（/code-graph/search|explore|callers|
 * callees|impact|node|status|files）。上游启用 key 后这批端点会 401，而它们正是
 * Agent 查询面（src/mcp/tools.ts 的 8 个 MCP 工具转发到它们）。票面验收要求
 * 「查询不受影响」，故本仓用同一份真相源（src/codegraph-tool-names.ts）把它们纳入白名单。
 */

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { wrapError } from "../api-helpers.js";
import { createLogger } from "../logger.js";
import { CODEGRAPH_QUERY_TOOL_NAMES } from "../codegraph-tool-names.js";
import type { KnowledgeAuthConfig } from "../config.js";

const log = createLogger("auth");

/** 常量时间比较；长度不等时也对自身比一次，避免长度侧信道。 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** 只读白名单：POST（Agent 查询面）。 */
export const READONLY_POST_PATHS: ReadonlySet<string> = new Set([
  "/tools/list", "/tools/call",
  "/wiki/get", "/wiki/list", "/wiki/raw/ls", "/wiki/raw/read",
  "/wiki/page/ls", "/wiki/page/read", "/wiki/graph", "/wiki/search",
  "/code-graph/list", "/code-graph/get",
  // code-graph 动态注册的只读查询端点（与路由注册同源，避免两边漂移）
  ...CODEGRAPH_QUERY_TOOL_NAMES.map((name) => `/code-graph/${name}`),
]);

/** 只读白名单：GET。 */
export const READONLY_GET_PATHS: ReadonlySet<string> = new Set([
  "/auto-sync/status",
]);

// 上游白名单还含 /source-credential/status 与 /source-provider/* 前缀，
// 本仓未引入这两组路由，故不列；若日后引入需同步补白名单（缺省受保护 = fail-closed）。

/** 该 method + path（已剥掉 API 前缀）是否属于只读白名单。 */
export function isReadonlyPath(method: string, path: string): boolean {
  if (method === "POST") return READONLY_POST_PATHS.has(path);
  if (method === "GET") return READONLY_GET_PATHS.has(path);
  return false;
}

/** 校验 Authorization: Bearer <token>；缺失或格式不符一律 false。 */
export function verifyBearer(authHeader: string | undefined, serviceKey: string): boolean {
  if (!authHeader) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
  if (!m) return false;
  return safeEqual(m[1], serviceKey);
}

export function createServiceAuthMiddleware(
  cfg: KnowledgeAuthConfig,
  apiPrefix: string,
): MiddlewareHandler {
  return async (c, next) => {
    if (!cfg.serviceKey) return next();
    const full = c.req.path;
    const path = full.startsWith(apiPrefix) ? full.slice(apiPrefix.length) : full;
    if (isReadonlyPath(c.req.method, path)) return next();
    if (verifyBearer(c.req.header("authorization"), cfg.serviceKey)) return next();
    log.warn(`rejected unauthenticated request: ${c.req.method} ${full}`);
    return c.json(wrapError(401, "unauthorized: valid service key required"), 401);
  };
}
