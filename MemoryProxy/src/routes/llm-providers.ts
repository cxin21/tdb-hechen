/**
 * /v3/admin/llm-providers — 成员自定义 LLM Provider 的自服务路由。
 *
 * Spec §5 / §6 + plan Task2。鉴权用**用户自己的 user_key**(verifyUserKey),
 * 非共享 admin secret;归属判定与 UI / session-init 同款:
 *   - subject_type=user → 仅允许 subject_id == 认证 user_id
 *   - subject_type=agent → 该 agent_id 必须在 listAgents(认证 user_id) 中
 * 审计列(created_* / updated_*)由写接口用认证用户填充(spec §4)。
 *
 * 请求形态:
 *   GET    /v3/admin/llm-providers?scope=me&space_id=<sid>
 *   GET    /v3/admin/llm-providers?subject_type=user&subject_id=<uid>&space_id=<sid>
 *   PUT    /v3/admin/llm-providers   body { subject_type, subject_id, url, apiKey, model, space_id }
 *   DELETE /v3/admin/llm-providers?subject_type=...&subject_id=...&space_id=<sid>
 * 鉴权头: `Authorization: Bearer <user_key>`。space_id 经查询参数传入(该管理路径无
 * spaceId 段,控件面板透传其登录实例 spaceId)。
 */
import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import type {
  LlmProvider,
  LlmProviderStoreWithCache,
  LlmProviderSubjectType,
} from "../member-llm/index.js";
import type { AgentEntity, MetadataClient } from "../meta/client.js";

/** 一次成功鉴权得到的成员身份(供归属判定 / 更建 MetadataClient 用)。 */
export interface LlmProviderAuth {
  userId: string;
  /** tenant / spaceId,原样作为 verifyUserKey 的 serviceId 与 kernel x-tdai-service-id。 */
  serviceId: string;
  userKey: string;
}

/** 路由依赖注入面(root 通过 createLlmProviderHandlers 装配真实实现,测试 mock)。 */
export interface LlmProviderHandlerDeps {
  store: LlmProviderStoreWithCache;
  /**
   * 从请求解析已认证身份(user_key + space_id → verifyUserKey)。
   * 未通过 / 未认证 → 返回 null,上层统一回 401。
   */
  authenticate: (c: Context) => Promise<LlmProviderAuth | null>;
  /** 依据认证上下文构造 MetadataClient(listTeams / listAgents)。 */
  getClient: (auth: LlmProviderAuth) => MetadataClient;
  /** 测试钩子:锁定审计时间戳。默认 new Date()。 */
  now?: () => Date;
}

interface LlmProviderBody {
  subject_type?: unknown;
  subject_id?: unknown;
  url?: unknown;
  apiKey?: unknown;
  model?: unknown;
  space_id?: unknown;
}

/**
 * 创建 llm-providers 路由处理器。返回 `{ scoped, put, delete }`,每个都是
 * `(c) => Promise<Response>` 的 hono handler。
 */
export function createLlmProviderHandlers(config: ProxyConfig, deps: LlmProviderHandlerDeps) {
  return {
    scoped: (c: Context): Promise<Response> => handleScoped(c, deps),
    put: (c: Context): Promise<Response> => handlePut(c, deps),
    delete: (c: Context): Promise<Response> => handleDelete(c, deps),
  };
}

// ── GET ──────────────────────────────────────────────────────────────────────

async function handleScoped(c: Context, deps: LlmProviderHandlerDeps): Promise<Response> {
  const auth = await deps.authenticate(c);
  if (!auth) return unauthorized(c);
  try {
    if (c.req.query("scope") === "me") {
      return await handleScopeMe(c, deps, auth);
    }
    const type = parseSubjectType(c.req.query("subject_type"));
    const id = c.req.query("subject_id") ?? "";
    if (!type || !id) {
      return error(c, 400, "specify scope=me, or subject_type + subject_id query params");
    }
    const denied = await assertOwned(c, deps, auth, type, id);
    if (denied) return denied;
    const entry = await deps.store.get(type, id);
    return ok(c, { provider: entry ?? null });
  } catch (err) {
    return error(c, 503, err instanceof Error ? err.message : String(err));
  }
}

async function handleScopeMe(
  c: Context,
  deps: LlmProviderHandlerDeps,
  auth: LlmProviderAuth,
): Promise<Response> {
  const client = deps.getClient(auth);
  const owned = await listOwnedAgents(client, auth.userId);
  const user = await deps.store.get("user", auth.userId);
  const agents = await Promise.all(
    owned.map(async (a) => ({
      agent_id: a.agent_id,
      name: a.name,
      provider: await deps.store.get("agent", a.agent_id),
    })),
  );
  return ok(c, { user: user ?? null, agents });
}

// ── PUT ──────────────────────────────────────────────────────────────────────

async function handlePut(c: Context, deps: LlmProviderHandlerDeps): Promise<Response> {
  const auth = await deps.authenticate(c);
  if (!auth) return unauthorized(c);

  let body: LlmProviderBody;
  try {
    body = await c.req.json<LlmProviderBody>();
  } catch {
    return error(c, 400, "invalid JSON body");
  }
  const v = validateProviderInput(body);
  if ("error" in v) return error(c, 400, v.error);

  try {
    const denied = await assertOwned(c, deps, auth, v.type, v.subjectId);
    if (denied) return denied;

    const nowStr = (deps.now ? deps.now() : new Date()).toISOString();
    const existing = await deps.store.get(v.type, v.subjectId);
    const entry: LlmProvider = {
      subject_type: v.type,
      subject_id: v.subjectId,
      url: v.url,
      apiKey: v.apiKey,
      model: v.model,
      // created_* 首次写入用认证用户填充;覆盖时保留首次值。
      created_by: existing?.created_by ?? auth.userId,
      created_at: existing?.created_at ?? nowStr,
      updated_by: auth.userId,
      updated_at: nowStr,
    };

    await deps.store.set(entry);
    // 显式失效缓存 → 下一次请求立即生效(不依赖 TTL 过期)。
    deps.store.cache.invalidate(v.type, v.subjectId);
    return ok(c, { subject_type: v.type, subject_id: v.subjectId });
  } catch (err) {
    return error(c, 503, err instanceof Error ? err.message : String(err));
  }
}

// ── DELETE ───────────────────────────────────────────────────────────────────

async function handleDelete(c: Context, deps: LlmProviderHandlerDeps): Promise<Response> {
  const auth = await deps.authenticate(c);
  if (!auth) return unauthorized(c);

  const type = parseSubjectType(c.req.query("subject_type"));
  const id = c.req.query("subject_id") ?? "";
  if (!type || !id) return error(c, 400, "subject_type and subject_id query params are required");

  try {
    const denied = await assertOwned(c, deps, auth, type, id);
    if (denied) return denied;
    await deps.store.del(type, id);
    deps.store.cache.invalidate(type, id);
    return ok(c, { subject_type: type, subject_id: id, deleted: true });
  } catch (err) {
    return error(c, 503, err instanceof Error ? err.message : String(err));
  }
}

// ── 归属判定 / 字段校验 ──────────────────────────────────────────────────────

/**
 * 校验请求主体的归属(subject 必须属于认证用户),返回 403 Response 或 null(通过)。
 */
async function assertOwned(
  c: Context,
  deps: LlmProviderHandlerDeps,
  auth: LlmProviderAuth,
  type: LlmProviderSubjectType,
  id: string,
): Promise<Response | null> {
  if (type === "user") {
    if (id !== auth.userId) {
      return error(c, 403, "forbidden: cannot manage another user's provider");
    }
    return null;
  }
  const client = deps.getClient(auth);
  const owned = await isAgentOwnedByUser(client, auth.userId, id);
  if (!owned) {
    return error(c, 403, "forbidden: agent is not owned by this user");
  }
  return null;
}

interface ValidatedInput {
  type: LlmProviderSubjectType;
  subjectId: string;
  url: string;
  apiKey: string;
  model: string;
}

function validateProviderInput(body: LlmProviderBody): ValidatedInput | { error: string } {
  const type = parseSubjectType(body.subject_type);
  if (!type) return { error: "subject_type must be 'user' or 'agent'" };
  const subjectId = typeof body.subject_id === "string" ? body.subject_id.trim() : "";
  if (!subjectId) return { error: "subject_id is required" };
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!isValidHttpUrl(url)) return { error: "url must be a valid http(s) URL" };
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return { error: "apiKey must not be empty" };
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) return { error: "model must not be empty" };
  return { type, subjectId, url, apiKey, model };
}

function isValidHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function parseSubjectType(raw: unknown): LlmProviderSubjectType | null {
  return raw === "user" || raw === "agent" ? raw : null;
}

// ── 导出的归属判定 helpers(spec §5,复用给 Task 3/4) ───────────────────────

/**
 * 返回用户在其团队内「按 user 维度过滤后」拥有的 agent 集合。
 * 与 session-init 同款调用(listTeams(userId) → 每队 listAgents(team, userId))。
 */
export async function listOwnedAgents(
  client: MetadataClient,
  userId: string,
): Promise<AgentEntity[]> {
  const teams = await client.listTeams(userId);
  const perTeam = await Promise.all(
    teams.map((t) => client.listAgents(t.team_id, userId).catch((): AgentEntity[] => [])),
  );
  return perTeam.flat();
}

/** 判定 agentId 是否属于该用户(spec §5)。
 * 与 UI 用同一判定:listAgents(认证 user_id) 返回的 agent 集合。 */
export async function isAgentOwnedByUser(
  client: MetadataClient,
  userId: string,
  agentId: string,
): Promise<boolean> {
  const owned = await listOwnedAgents(client, userId);
  return owned.some((a) => a.agent_id === agentId);
}

// ── 响应外壳(与 rate-limits 的 admin 样式一致) ─────────────────────────────

function ok(c: Context, data: Record<string, unknown>): Response {
  return c.json({ code: 0, message: "ok", data });
}

function unauthorized(c: Context): Response {
  return error(c, 401, "unauthorized: missing or invalid user_key");
}

function error(c: Context, status: 400 | 401 | 403 | 503, message: string): Response {
  return c.json({ code: status, message }, status);
}