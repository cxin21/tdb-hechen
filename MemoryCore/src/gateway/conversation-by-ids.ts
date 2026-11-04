/**
 * POST /v3/conversation/by-ids —— 按 L0 record_id 批量回读原始消息。
 *
 * 设计落点：ADR-0025 行级溯源（L1.source_message_ids 存的是 L0 record_id）。
 * 既有 /v3/conversation/query 只能按 session 分页查，面板拿到一串证据 id 也无处
 * 换回原话；本端点补「按 id 批量读」的缺口，供 MemoryPanel BFF
 * /chat-memory/source-messages 转发（同 /atomic/by-ids 的证据抽屉先例）。
 *
 * 安全边界（跨租户零泄漏）：
 *   - 缺租户头由 dispatch 层 enforce（collectV3Missing 422），handler 不再重复拒绝；
 *   - 行级过滤下推到 SQL（team/user/agent/task 四轴，与 handleConversationQuery 同口径），
 *     跨租户 id 静默查不到 —— 与「不存在」同形，不泄露存在性；
 *   - ids 上限 100（批量读不是全表导出）；空数组是合法读（零条），不报错。
 */
import { z } from "zod";
import { successEnvelope, errorEnvelope, type V2RouterDeps } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { L0ByIdsFilter, L0QueryRow } from "../core/store/types.js";

/** 上限 = 单次批量读 100 条（与 /atomic/by-ids 同刻度）。 */
export const CONVERSATION_BY_IDS_MAX = 100;

export const conversationByIdsRequestSchema = z.object({
  ids: z.array(z.string()).max(CONVERSATION_BY_IDS_MAX),
});

/**
 * ids 归一（纯函数，可单测）：trim → 丢空/非字符串 → 去重保序。
 * 保序是用户可感知语义（证据列表按 L1 里的原序读），去重避免 SQL IN 重复占位。
 */
export function normalizeConversationIds(raw: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface ConversationByIdsItem {
  id: string;
  role: string;
  content: string;
  /** 原消息 recorded_at（ISO 8601；与 /conversation/query 的 timestamp 同义）。 */
  timestamp: string;
  session_key: string;
  session_id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  task_id: string;
}

export interface ConversationByIdsData {
  items: ConversationByIdsItem[];
}

type ByIdsCapableStore = {
  queryL0ByIds?: (ids: string[], filter?: L0ByIdsFilter) => L0QueryRow[] | Promise<L0QueryRow[]>;
};

export async function handleConversationByIds(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = conversationByIdsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorEnvelope(
      400,
      `invalid request: ids must be an array of strings (max ${CONVERSATION_BY_IDS_MAX})`,
      requestId,
    );
  }
  const ids = normalizeConversationIds(parsed.data.ids);
  // 零条是合法读（调用方可能过滤后为空）；不触库，也不要求 store 支持该能力。
  if (ids.length === 0) {
    return successEnvelope<ConversationByIdsData>({ items: [] }, requestId);
  }

  const iso = deps.requestIsolation;
  if (!iso) return errorEnvelope(400, "Tenancy isolation required: missing tenant headers.", requestId);

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  const queryL0ByIds = (store as ByIdsCapableStore).queryL0ByIds;
  if (typeof queryL0ByIds !== "function") {
    // fail-loud：老 store 没有该能力时报错，不静默返回空数组伪装成「没有原话」。
    return errorEnvelope(503, "Store does not support queryL0ByIds", requestId);
  }

  const rows = await queryL0ByIds.call(store, ids, {
    teamId: iso.teamId,
    userId: iso.userId,
    agentId: iso.agentId,
    taskId: iso.taskId,
  });

  const items: ConversationByIdsItem[] = rows.map((r) => ({
    id: r.record_id,
    role: r.role,
    content: r.message_text,
    timestamp: r.recorded_at,
    session_key: r.session_key,
    session_id: r.session_id,
    team_id: r.team_id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    task_id: r.task_id,
  }));
  return successEnvelope<ConversationByIdsData>({ items }, requestId);
}
