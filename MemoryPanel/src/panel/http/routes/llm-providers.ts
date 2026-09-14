/**
 * /api/v1/llm-providers — 成员自定义 LLM Provider 自服务页的透传端点（→ MemoryProxy）。
 *
 * 设计 spec §5/§6 + plan Task5。
 *   MemoryHub UI「LLM Provider」页 读到/写入的「成员自定义 Provider」存在 MemoryProxy
 *   （/v3/admin/llm-providers），不在本 Panel。本路由只做三件事：
 *     1. 用 `validatePanelMetaHeaders` 从面板会话解析登录身份（X-Tdai-Service-Id =
 *        登录实例 spaceId + X-Tdai-User-Key = 登录用户自己的 user_key）；
 *     2. 把请求透传到 `${llmProvider.proxyBaseUrl}/v3/admin/llm-providers`，注入
 *        `space_id`（= 登录实例）+ `Authorization: Bearer <user_key>`；
 *     3. 原样回传 proxy 的状态码与 JSON body（归属校验 / 字段校验 / 401 全部由
 *        MemoryProxy 侧完成，见 MemoryProxy/src/routes/llm-providers.ts）。
 *
 * 安全要点：**不**使用共享 admin secret —— 身份完全来自登录用户自己的 user_key，
 * 归属判定（subject 必须是认证用户的 user 或 agent）由 proxy 执行。
 *
 * 请求形态（与 MemoryProxy 对齐）：
 *   GET    /api/v1/llm-providers?scope=me
 *   GET    /api/v1/llm-providers?subject_type=<type>&subject_id=<id>
 *   PUT    /api/v1/llm-providers   body { subject_type, subject_id, url, apiKey, model }
 *   DELETE /api/v1/llm-providers?subject_type=<type>&subject_id=<id>
 */
import type { Context } from 'hono';
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import {
  validatePanelMetaHeaders,
  type PanelMetaContext,
} from '../middleware/validate-panel-headers.js';

/** 从客户端查询参数复制与 llm-providers 相关的字段，并恒定注入 space_id（登录实例）。 */
function buildUpstreamUrl(deps: PanelDeps, c: Context, instanceId: string): string {
  const base = deps.config.llmProvider.proxyBaseUrl.replace(/\/+$/, '');
  const q = new URLSearchParams();
  const scope = c.req.query('scope');
  if (scope) q.set('scope', scope);
  const subjectType = c.req.query('subject_type');
  if (subjectType) q.set('subject_type', subjectType);
  const subjectId = c.req.query('subject_id');
  if (subjectId) q.set('subject_id', subjectId);
  q.set('space_id', instanceId);
  return `${base}/v3/admin/llm-providers?${q.toString()}`;
}

/** 把请求原样转发给 MemoryProxy，并原样回传其状态码与 JSON body。 */
async function forwardToProxy(
  deps: PanelDeps,
  c: Context,
  method: 'GET' | 'PUT' | 'DELETE',
  upstreamUrl: string,
  body?: unknown,
): Promise<Response> {
  const panelMeta = c.get('panelMeta') as PanelMetaContext;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.config.metadataRemoteTimeoutMs);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (panelMeta.userKey) headers.Authorization = `Bearer ${panelMeta.userKey}`;
    const resp = await fetch(upstreamUrl, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    const isTimeout = (err as { name?: string })?.name === 'AbortError';
    const code = isTimeout ? 504 : 502;
    const reason =
      isTimeout ? 'llm-providers upstream timeout' : (err as Error)?.message ?? String(err);
    deps.logger.warn('llm-providers upstream failed', {
      method,
      upstreamUrl,
      code,
      error: reason,
    });
    return c.json({ code, message: reason }, code);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 注册 /api/v1/llm-providers 的 GET/PUT/DELETE 透传路由。
 * 复用 validatePanelMetaHeaders（非 auth/verify → 强制要求 X-Tdai-User-Key）。
 */
export function registerLlmProviderRoutes(api: Hono, deps: PanelDeps): void {
  api.get('/llm-providers', validatePanelMetaHeaders(deps), async (c) => {
    const panelMeta = c.get('panelMeta') as PanelMetaContext;
    return forwardToProxy(deps, c, 'GET', buildUpstreamUrl(deps, c, panelMeta.instanceId));
  });

  api.put('/llm-providers', validatePanelMetaHeaders(deps), async (c) => {
    const panelMeta = c.get('panelMeta') as PanelMetaContext;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return forwardToProxy(deps, c, 'PUT', buildUpstreamUrl(deps, c, panelMeta.instanceId), body);
  });

  api.delete('/llm-providers', validatePanelMetaHeaders(deps), async (c) => {
    const panelMeta = c.get('panelMeta') as PanelMetaContext;
    return forwardToProxy(deps, c, 'DELETE', buildUpstreamUrl(deps, c, panelMeta.instanceId));
  });
}