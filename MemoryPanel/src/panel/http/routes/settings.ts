/**
 * /api/v1/settings/{knowledge,memory}/:action — 管理员设置透传（spec §4）。
 *
 * 门控顺序（照抄 llm-providers.ts / skill/proxy.ts 既有挂载方式，逐路由挂
 * validatePanelMetaHeaders —— 本仓库该中间件为 per-route，不在 app.ts 级挂载）：
 *   validatePanelMetaHeaders（解析 panelMeta：instanceId / gatewayEndpoint /
 *   gatewayApiKey / userKey）→ isCallerSystemAdmin（auth/verify → user_type）。
 * 非 admin → 403；Panel 层门控是服务侧内网信任模型的唯一权限点。
 *
 * 上游：
 *   knowledge → deps.config.knowledge.baseUrl + authToken（共享 KS 实例凭据）；
 *   memory    → panelMeta.gatewayEndpoint + gatewayApiKey（登录实例自己的 Core）。
 *   action ∈ get|set|revectorize；revectorize 仅 knowledge（Core 无此端点）。
 *   proxy-pricing → deps.config.llmProvider.proxyBaseUrl + /v3/admin/credit-pricing
 *   （MemoryProxy，内网信任模型无鉴权头；POST 翻译为上游 GET/PUT，spec §9.3）。
 *
 * 上游错误映射 Control envelope（504 超时 / 502 失败），照 routes/llm-providers.ts
 * forwardToProxy 既有模式。
 */
import type { Context } from 'hono';
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { buildCtx, isCallerSystemAdmin } from './knowledge/common.js';
import { respondControlError } from '../envelope.js';

const VALID_ACTIONS = new Set(['get', 'set', 'revectorize']);

async function forwardJson(
  deps: PanelDeps,
  c: Context,
  url: string,
  headers: Record<string, string>,
  opts?: { method?: string; body?: string },
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.config.metadataRemoteTimeoutMs);
  try {
    // opts 提供时 body 以 opts.body 为准（GET 显式无 body）；否则沿用客户端方法语义
    const body = opts
      ? opts.body
      : c.req.method === 'POST'
        ? JSON.stringify(await c.req.json().catch(() => ({})))
        : undefined;
    const resp = await fetch(url, {
      method: opts?.method ?? c.req.method,
      headers: { 'content-type': 'application/json', ...headers },
      body,
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
    const message = isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR';
    deps.logger.warn('settings upstream failed', {
      url,
      code,
      error: (err as Error)?.message ?? String(err),
    });
    return respondControlError(c, code, message);
  } finally {
    clearTimeout(timer);
  }
}

export function registerSettingsRoutes(api: Hono, deps: PanelDeps): void {
  const handler = (target: 'knowledge' | 'memory') => async (c: Context) => {
    const action = c.req.param('action') ?? '';
    if (!VALID_ACTIONS.has(action)) return respondControlError(c, 400, 'INVALID_ACTION');
    if (target === 'memory' && action === 'revectorize') {
      return respondControlError(c, 400, 'NOT_SUPPORTED');
    }
    const ctx = buildCtx(c);
    if (!(await isCallerSystemAdmin(deps, ctx))) {
      return respondControlError(c, 403, 'FORBIDDEN');
    }

    if (target === 'knowledge') {
      const base = deps.config.knowledge.baseUrl.replace(/\/+$/, '');
      const headers: Record<string, string> = {
        // KS 约定头（per-instance 路由/审计用）；admin settings 路由本身不强制，带上保持一致
        'x-tdai-service-id': ctx.instanceId,
      };
      if (deps.config.knowledge.authToken) {
        headers.Authorization = `Bearer ${deps.config.knowledge.authToken}`;
      }
      return forwardJson(deps, c, `${base}/v3/admin/settings/${action}`, headers);
    }

    const coreBase = (ctx.gatewayEndpoint ?? '').replace(/\/+$/, '');
    if (!coreBase) return respondControlError(c, 502, 'NO_INSTANCE_ENDPOINT');
    const headers: Record<string, string> = {
      // Core 网关强制要求 x-tdai-service-id（缺失 → 401，2026-09-09 Memory 页签报错根因）
      'x-tdai-service-id': ctx.instanceId,
    };
    if (ctx.gatewayApiKey) headers.Authorization = `Bearer ${ctx.gatewayApiKey}`;
    return forwardJson(deps, c, `${coreBase}/v3/admin/settings/${action}`, headers);
  };

  api.post('/settings/knowledge/:action', validatePanelMetaHeaders(deps), handler('knowledge'));
  api.post('/settings/memory/:action', validatePanelMetaHeaders(deps), handler('memory'));

  // ── Proxy 计费价目表（spec §9.3）：get|set 透传 MemoryProxy /v3/admin/credit-pricing ──
  // 上游仅有 GET/PUT/DELETE（Task 10），故 Panel 的 POST 必须翻译方法：
  //   get → GET（无 body）；set → PUT（body { models: [...] } 原样透传）。
  // 上游为内网信任模型（与 rate-limits 一致），无需注入鉴权头。
  api.post('/settings/proxy-pricing/:action', validatePanelMetaHeaders(deps), async (c: Context) => {
    const action = c.req.param('action') ?? '';
    if (action !== 'get' && action !== 'set') return respondControlError(c, 400, 'INVALID_ACTION');
    const ctx = buildCtx(c);
    if (!(await isCallerSystemAdmin(deps, ctx))) return respondControlError(c, 403, 'FORBIDDEN');
    const base = deps.config.llmProvider.proxyBaseUrl.replace(/\/+$/, '');
    const url = `${base}/v3/admin/credit-pricing`;
    if (action === 'get') return forwardJson(deps, c, url, {}, { method: 'GET' });
    const body = JSON.stringify(await c.req.json().catch(() => ({})));
    return forwardJson(deps, c, url, {}, { method: 'PUT', body });
  });
}
