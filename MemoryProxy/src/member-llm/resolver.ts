/**
 * member-llm/resolver — 转发时按身份解析成员的 LLM Provider 上游。
 *
 * spec §3.1 + plan Task3。优先级(高→低):
 *   1. agent_id 命中 LlmProvider 表 → 用该 Agent 的 {url, apiKey, model}
 *   2. user_id 命中 → 用该用户的 {url, apiKey, model}
 *   3. 未配置 → null(调用方走既有全局兜底 upstream.agents / upstream.url)
 *
 * 解析只经 {@link LlmProviderStore.get} —— 即 write-through 缓存门面:命中缓存直接
 * 返回、不回源;缓存 miss 时回源并写回缓存。由 T4 在 handler 转发缝上用共享 store 实例调用。
 */
import type { LlmProvider, LlmProviderStore } from "./index.js";

/** 命中成员覆盖后返回的扁平上游三元组(同官方 upstream.agents 一张表)。 */
export interface MemberUpstream {
  url: string;
  apiKey: string;
  model: string;
}

/** 解析所需的身份:userId / agentId 均可缺省(null/undefined/空)。 */
export interface ResolveIdentity {
  userId?: string | null;
  agentId?: string | null;
}

function toMemberUpstream(p: LlmProvider): MemberUpstream {
  return { url: p.url, apiKey: p.apiKey, model: p.model };
}

/**
 * 解析成员定义的上游。命中 agent(最高优先)→ 否则 user → 否则 null。
 * 仅当对应 id 非空才查,空 id 不触发 store.get(避免空 key 校验抛错)。
 */
export async function resolveMemberUpstream(
  store: Pick<LlmProviderStore, "get">,
  identity: ResolveIdentity,
): Promise<MemberUpstream | null> {
  if (identity.agentId) {
    const agent = await store.get("agent", identity.agentId);
    if (agent) return toMemberUpstream(agent);
  }
  if (identity.userId) {
    const user = await store.get("user", identity.userId);
    if (user) return toMemberUpstream(user);
  }
  return null;
}

/**
 * 命中成员覆盖后替换客户端请求体的 `model` 顶层字段为成员的默认模型名。
 * 只改 body.model,不动其它字段;仅应在 resolver 命中(null 之外)后调用。
 */
export function applyMemberModel(body: Record<string, unknown>, upstream: MemberUpstream): void {
  body.model = upstream.model;
}