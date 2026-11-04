/**
 * 灵魂快照版本链 API（task-3）：/api/v1/chat-memory/soul-versions。
 *
 * 单独成文件而不是并入 lib/api/chat-memory.ts：后者是 chat_memory 资产族的 12 个动作，
 * 这份是**运维审计**读面（只读），关注点不同；且那个文件当前有并行会话的未提交改动，
 * 不进去抢写域。
 *
 * 后端 BFF：MemoryPanel/src/panel/http/routes/chat-memory-soul.ts
 * 上游内核：POST /v3/soul/introspect（零写入；不产生快照）
 */
import { ApiError, request } from './base';
import type { MetaEnvelope } from './types';
import { getPanelSession } from '../panelSession';

const SOUL_VERSIONS_PATH = '/api/v1/chat-memory/soul-versions';

/** 行级 diff（META 块整体增删的行数）。 */
export interface SoulVersionLineDiff {
  added: number;
  removed: number;
}

/** slot 级 diff：人设渲染单元的增删改计数 + 摘要（'+1 slot:user / ~2'）。 */
export interface SoulVersionSlotDiff {
  added: number;
  removed: number;
  changed: number;
  summary: string;
}

/**
 * 版本链一行。
 *
 * version / parentHash / reasonCode / reasonDetail / lineDiff / slotDiff **都是可选**：
 * 生产库（2026-11-04）soul_snapshots 尚未执行幂等 ALTER，内核只回 { at, hash, trigger }。
 * 缺字段即「旧快照」，前端不得补造版本号（见 soul-version-view.ts 的 legacy 降级）。
 */
export interface SoulVersionEntry {
  /** 快照时间（ISO 字符串，内核 ts 原样） */
  at: string;
  /** 人设内容哈希（旧库 8 字符，新库为更长的稳定哈希） */
  hash: string;
  /** 触发来源原样（受控枚举外的历史值如 'render' 也原样，前端不翻译） */
  trigger: string;
  /** tenant+slot 维度单调递增版本号；仅新快照有 */
  version?: number;
  /** 上一版 content_hash（版本链指针）；首版为 null */
  parentHash?: string | null;
  /** 结构化变更原因（受控枚举，见 soul-versioning.ts:13）；仅新快照有 */
  reasonCode?: string;
  /** 原因细节（自由文本，如具体提案 id） */
  reasonDetail?: string;
  lineDiff?: SoulVersionLineDiff;
  slotDiff?: SoulVersionSlotDiff;
}

export interface SoulVersionsPayload {
  teamId: string;
  agentId: string | null;
  userId: string;
  /** 当前渲染版本标识（内核 soulVersion，可选） */
  soulVersion?: string;
  /** 当前人设渲染全文（BFF 已按 4000 字截断） */
  rendered?: string;
  /** rendered 是否被截断（截断原因写在 notes） */
  renderedTruncated: boolean;
  versions: SoulVersionEntry[];
  /** 内核提示（如 snapshot-surface-unavailable）；原样展示，不吞 */
  notes: string[];
}

export interface SoulVersionsQuery {
  teamId: string;
  agentId?: string;
  /** 1..200，缺省由内核给 20 */
  snapshotLimit?: number;
}

/** 拉版本链。tenant 的 userId 轴由 BFF 从 Header 反查，前端不传。 */
export async function fetchSoulVersions(query: SoulVersionsQuery): Promise<SoulVersionsPayload> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const body: Record<string, unknown> = { team_id: query.teamId };
  if (query.agentId) body.agent_id = query.agentId;
  if (typeof query.snapshotLimit === 'number' && Number.isFinite(query.snapshotLimit)) {
    body.snapshotLimit = query.snapshotLimit;
  }
  const envelope = await request<MetaEnvelope<SoulVersionsPayload>>('POST', SOUL_VERSIONS_PATH, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
  if (envelope.code !== 0) {
    // 保留后端 message（如 503 soul_introspect_failed），UI 直接展示，不伪装成空链。
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as SoulVersionsPayload;
}
