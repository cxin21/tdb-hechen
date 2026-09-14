/**
 * api/settings.ts — 管理员设置（Wiki 设置 / Memory 设置，spec §4）。
 *
 * 后端链路：本 client → Panel /api/v1/settings/{target}/:action → KS / Core 的 /v3/admin/settings/*。
 * 鉴权：与 llm-providers.ts 同范式 —— 前端把登录实例 instance_id 与登录用户 user_key
 *   注入请求头（X-Tdai-Service-Id / X-Tdai-User-Key），走 request() 第 4 参 extraHeaders；
 *   body 只放业务载荷（服务端只读 JSON body 的业务字段，auth 一律走 header）。
 */
import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';

export type SettingsTarget = 'knowledge' | 'memory';
export type SettingsAction = 'get' | 'set' | 'revectorize';

export interface SettingsLlm {
  baseUrl: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  hasApiKey: boolean;
  apiKeyMasked: string;
  source: 'env' | 'override' | 'yaml';
  [k: string]: unknown;
}

export interface SettingsEmbedding {
  provider?: string;
  baseUrl?: string;
  model: string;
  dimensions?: number;
  sendDimensions?: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string;
  source: 'env' | 'override' | 'yaml';
  [k: string]: unknown;
}

export interface SettingsView {
  llm: SettingsLlm;
  embedding: SettingsEmbedding;
  rebuildStatus?: {
    status: 'idle' | 'running' | 'done' | 'failed';
    reason?: string;
    startedAt?: string;
    finishedAt?: string;
  };
  needsRestart?: boolean;
  embeddingChanged?: boolean;
}

/** Panel 透传信封（{code,message,data}；成功 HTTP 200 + code 0，失败为非 200）。 */
interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

function authHeaders(): Record<string, string> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  };
}

/** 发起 settings 调用：非 200 已由 request() 抛 ApiError；信封 code != 0 亦视为失败。 */
async function call<T>(
  target: SettingsTarget,
  action: SettingsAction,
  body?: Record<string, unknown>,
): Promise<T> {
  const env = await request<Envelope<T>>(
    'POST',
    `/api/v1/settings/${target}/${action}`,
    body,
    authHeaders(),
  );
  if (env.code !== 0) {
    throw new ApiError(200, env.message || 'settings request failed', '', {
      code: env.code,
      rawMessage: env.message,
    });
  }
  return env.data;
}

export const settingsApi = {
  /** 读取某服务（knowledge=MemoryKnowledge / memory=MemoryCore）的当前设置视图。 */
  get: (target: SettingsTarget) => call<SettingsView>(target, 'get'),

  /** 保存设置。body 中不传 apiKey 字段 = 保留原值（服务端语义：留空保留）。 */
  set: (target: SettingsTarget, body: Record<string, unknown>) =>
    call<SettingsView & { needsRestart: boolean; embeddingChanged: boolean }>(target, 'set', body),

  /** 手动触发向量重建（knowledge 侧，失败/完成后可用）。 */
  revectorize: (target: SettingsTarget) => call<{ started: boolean }>(target, 'revectorize'),
};

// ========================= Proxy 计费价目表（spec §9.3） =========================

/** 单条计费价目（与 MemoryProxy PricingEntry 对齐；价格为每百万 token 积分）。 */
export interface PricingEntry {
  name: string;
  modelName: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** 价目表视图：source=yaml 底表 / override（storage 覆盖生效中）。 */
export interface PricingView {
  source: 'yaml' | 'override';
  models: PricingEntry[];
}

/**
 * Proxy 计费价目表（Panel /api/v1/settings/proxy-pricing/:action → MemoryProxy
 * /v3/admin/credit-pricing）。Panel 侧将 POST 翻译为上游 GET/PUT，此处统一 POST。
 * 保存为整表替换，热生效（下一请求读取新价目，无需重启）。
 */
export const proxyPricingApi = {
  get: async (): Promise<PricingView> => {
    const env = await request<Envelope<PricingView>>(
      'POST',
      '/api/v1/settings/proxy-pricing/get',
      undefined,
      authHeaders(),
    );
    if (env.code !== 0) {
      throw new ApiError(200, env.message || 'settings request failed', '', {
        code: env.code,
        rawMessage: env.message,
      });
    }
    return env.data;
  },

  set: async (models: PricingEntry[]): Promise<PricingView> => {
    const env = await request<Envelope<PricingView>>(
      'POST',
      '/api/v1/settings/proxy-pricing/set',
      { models },
      authHeaders(),
    );
    if (env.code !== 0) {
      throw new ApiError(200, env.message || 'settings request failed', '', {
        code: env.code,
        rawMessage: env.message,
      });
    }
    return env.data;
  },
};
