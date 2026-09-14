/**
 * api/llm-providers.ts — 成员自定义 LLM Provider 自服务（Memory Hub UI「LLM Provider」页）。
 *
 * 后端链路：前端 → Panel 透传端点 /api/v1/llm-providers → MemoryProxy /v3/admin/llm-providers。
 * 身份：前端把登录实例 spaceId 与**登录用户自己的 user_key** 注入请求头
 *   （X-Tdai-Service-Id / X-Tdai-User-Key），Panel 透传并用该 user_key 作
 *   `Authorization: Bearer`。全链路无共享 admin secret；归属判定由 proxy 完成。
 */
import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';

export type LlmProviderSubjectType = 'user' | 'agent';

/** MemoryProxy 存的一条成员自定义 Provider（审计列由写接口填充，UI 不回显）。 */
export interface LlmProviderConfig {
  subject_type: LlmProviderSubjectType;
  subject_id: string;
  url: string;
  /** 成员私有 LLM Key，明文仅在 GET 响应里随所属 provider 返回（UI 以 password 掩码展示）。 */
  apiKey: string;
  model: string;
}

/** GET scope=me：当前用户 user 级 Provider + 其拥有的 agents（每项带各自 Provider）。 */
export interface OwnedAgentProvider {
  agent_id: string;
  name: string;
  provider: LlmProviderConfig | null;
}

export interface ScopeMeResult {
  user: LlmProviderConfig | null;
  agents: OwnedAgentProvider[];
}

/** proxy admin 信封（{code,message,data}；成功恒为 HTTP 200 + code 0，失败为非 200）。 */
interface AdminEnvelope<T> {
  code: number;
  message: string;
  data: T | null;
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

/** 解包 admin 信封并放下 data；非 200 已由 request() 抛 ApiError。 */
function dataOf<T>(envelope: AdminEnvelope<T>): T {
  return envelope.data as T;
}

export const llmProviderApi = {
  /** 读当前登录用户的 user Provider + 其拥有的 agents Provider（一次拉全）。 */
  getScopeMe: () =>
    request<AdminEnvelope<ScopeMeResult>>(
      'GET',
      '/api/v1/llm-providers?scope=me',
      undefined,
      authHeaders(),
    ).then(dataOf),

  /** 保存某个 subject（user 或自有 agent）的 Provider。 */
  save: (cfg: Omit<LlmProviderConfig, 'subject_type' | 'subject_id'> & { subjectType: LlmProviderSubjectType; subjectId: string }) =>
    request<AdminEnvelope<{ subject_type: LlmProviderSubjectType; subject_id: string }>>(
      'PUT',
      '/api/v1/llm-providers',
      {
        subject_type: cfg.subjectType,
        subject_id: cfg.subjectId,
        url: cfg.url,
        apiKey: cfg.apiKey,
        model: cfg.model,
      },
      authHeaders(),
    ),

  /** 清除某个 subject 的 Provider（回落到团队/全局默认）。 */
  clear: (subjectType: LlmProviderSubjectType, subjectId: string) =>
    request<AdminEnvelope<{ subject_type: LlmProviderSubjectType; subject_id: string; deleted: boolean }>>(
      'DELETE',
      `/api/v1/llm-providers?subject_type=${subjectType}&subject_id=${encodeURIComponent(subjectId)}`,
      undefined,
      authHeaders(),
    ),
};