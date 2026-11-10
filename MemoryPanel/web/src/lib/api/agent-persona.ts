/**
 * agent-persona API —— 人格设定六项的读写（spec §1，动作已在 BFF 白名单：
 * MemoryPanel/src/panel/api/meta-actions.ts:52-53 'agent-persona/get' | 'agent-persona/save'）。
 *
 * 为什么不复用 metaPost：get 在「还没有设定」时内核回 data:null，而 metaCall 会把
 * data==null 当成错误抛（base.ts:166-172）。这里自己解信封——null 就是 null，
 * 前端据此以空表单起步，而不是弹一个「empty meta response」。
 *
 * 返回字段是库里的 snake_case（traits_json/redlines_json 为 JSON 字符串），
 * 统一交给 lib/agent-persona-form.ts 的 parseAgentPersona 归一，调用方不用关心。
 */
import { ApiError, META_PREFIX, request } from './base';
import type { MetaEnvelope } from './types';
import { getPanelSession } from '../panelSession';
import {
  buildPersonaSaveBody,
  parseAgentPersona,
  type AgentPersonaDraft,
  type AgentPersonaRecord,
} from '../agent-persona-form';

async function postMetaAllowEmpty(
  action: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<unknown>>(
    'POST',
    `${META_PREFIX}/${action}`,
    body,
    {
      'X-Tdai-Service-Id': session.instanceId,
      'X-Tdai-User-Key': session.userKey,
    },
  );
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data ?? null;
}

/** 读人格式；未设定返回 null（不是错误）。 */
export async function fetchAgentPersona(agentId: string): Promise<AgentPersonaRecord | null> {
  const data = await postMetaAllowEmpty('agent-persona/get', { agent_id: agentId });
  return parseAgentPersona(data);
}

/**
 * 保存人格式。名称用 Agent 显示名同一个值（内核会同时写回 meta_agents.name，F7），
 * 校验不过时内核回 agent_persona_invalid + 具体原因，这里原样抛给调用方展示。
 */
export async function saveAgentPersona(
  agentId: string,
  name: string,
  draft: AgentPersonaDraft,
): Promise<AgentPersonaRecord | null> {
  const data = await postMetaAllowEmpty(
    'agent-persona/save',
    buildPersonaSaveBody(agentId, name, draft),
  );
  return parseAgentPersona(data);
}
