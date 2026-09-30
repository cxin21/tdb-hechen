/**
 * /v3/atomic/by-ids —— 按 record_id 批量回读 L1 记录（含归档回退，B3 语义）。
 *
 * 设计落点：fcluster-design §5「Panel 簇视图」的数据端——详情页证据（evidence_ids）
 * 目前只 join 出 id 文本，源内容不可回读（用户看不到源=没做）。本端点暴露
 * vectorStore.getL1ByIdsWithArchive（既有内部方法，auto-recall 同款消费），供 Panel
 * BFF /v3/atomic/by-ids 转发。
 *
 * 安全边界（跨租户零泄漏红线，d73e8f9a）：
 *   - 缺租户头由 dispatch 层 enforce 拒绝（v2-router:772），handler 内 requestIsolationMissing
 *     显式拒绝为纵深双保险，写明缺失头名；
 *   - 行级租户过滤 filterByIsolation：行必须匹配 iso 的 team/user/agent（sessionId 不过滤
 *     ——L1 跨 session，与 handleAtomicSearch 的 filter 语义一致）。
 */
import { z } from "zod";
import { successEnvelope, errorEnvelope, type V2RouterDeps } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { L1SearchResult } from "../core/store/types.js";

export const atomicByIdsRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});

export type IsolationCtx = { teamId?: string; userId: string; agentId: string; sessionId: string; taskId?: string };

/** 行级租户过滤：行字段（snake_case）必须匹配 iso；iso 缺 user/agent 视为无效上下文→空。 */
export function filterByIsolation(rows: L1SearchResult[], iso?: IsolationCtx): L1SearchResult[] {
  if (!iso || !iso.userId || !iso.agentId) return [];
  return rows.filter((r) => {
    if (iso.teamId && r.team_id !== iso.teamId) return false;
    if (r.user_id !== iso.userId) return false;
    if (r.agent_id !== iso.agentId) return false;
    return true; // sessionId 不过滤：L1 跨 session（agent 维度，与 handleAtomicSearch 一致）
  });
}

export async function handleAtomicByIds(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const missing = deps.requestIsolationMissing;
  if (missing && missing.length > 0) {
    return errorEnvelope(400, `Tenancy isolation required: missing ${missing.join(", ")}.`, requestId);
  }
  const parsed = atomicByIdsRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, "invalid request: ids must be 1..100 non-empty strings", requestId);
  const iso = deps.requestIsolation;
  if (!iso) return errorEnvelope(400, "Tenancy isolation required: missing tenant headers.", requestId);
  const store = deps.getStore();
  if (!store) return errorEnvelope(500, "store unavailable", requestId);
  const ids = parsed.data.ids;
  const s = store as {
    getL1ByIdsWithArchive?: (ids: string[]) => Promise<L1SearchResult[]> | L1SearchResult[];
    getL1ByIds?: (ids: string[]) => Promise<L1SearchResult[]> | L1SearchResult[];
  };
  const rows = s.getL1ByIdsWithArchive ? await s.getL1ByIdsWithArchive(ids) : [];
  const liveIds = new Set<string>(
    s.getL1ByIds ? (await s.getL1ByIds(ids)).map((r) => r.record_id) : [],
  );
  const items = filterByIsolation(rows, iso).map((r) => ({ ...r, archived: !liveIds.has(r.record_id) }));
  return successEnvelope({ items }, requestId);
}
