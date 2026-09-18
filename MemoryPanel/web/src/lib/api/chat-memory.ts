/**
 * api/chat-memory.ts — Chat Memory 面板专用业务路由（/api/v1/chat-memory/*）。
 */
import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';
import type { MetaEnvelope } from './types';

/** 网关 /health 的 memory 子对象（与 MemoryCore MemoryHealthInfo 对齐，T15） */
export interface MemoryHealthInfo {
  /** vecRows / max(metaRows, 1) —— <0.9 即部分向量死亡 */
  vectorCoverage: number;
  vecRows: number;
  metaRows: number;
  embedding: 'ok' | 'degraded';
  degradedSince: string | null;
  lastVecWriteAt: string | null;
}

/** 价值锚行（/v3/core-memory/read 的 values；store/types.ts listValues 同形） */
export interface ValueAnchor {
  value_id: string;
  label: string;
  weight: number;
  created_by: string;
  /** 动机方向：-1|0|1；null = 未判定（LLM 未判或新建） */
  valence: number | null;
  /** GROW 来源徽标：seed 种子 / manual 手工 / auto 自生长；旧网关缺省 → undefined（前向兼容） */
  origin?: 'seed' | 'manual' | 'auto';
  /** GROW 钉住：1 = 永不被自生长挤出 */
  pinned?: 0 | 1;
  /** GROW 状态机：active 活跃 / retired 退休（退休区）/ vetoed 永久否决（任何读面不可见） */
  state?: 'active' | 'retired' | 'vetoed';
  /** P2（U2）：锚类型（theme 主题 / person 人物双节点）；旧网关缺省 → undefined（前向兼容） */
  node_type?: 'theme' | 'person';
  /** P2（U2）：人物锚属性 JSON（{role, aliases}）；主题锚为 '{}' */
  attrs_json?: string;
}

/** P2 待办项（O13）：/v3/core-memory/pending/list 的行（core_value/strict_rule 分级提案） */
export interface PendingItem {
  pending_id: string;
  slot: string;
  content: string;
  version?: number;
  state?: string;
  evidence_count?: number;
}

/** 价值锚提案（Task DISC，提议制）：/v3/core-memory/values/discover 返回，只提议不落库 */
export interface ValueProposal {
  label: string;
  rationale: string;
  /** 后端按 label 关键词在样本语料实际命中数重算（LLM 报数不采信） */
  evidenceCount: number;
  /** 证据密度公式 clamp [0.3, 0.8]；采纳时作为 upsert 的 weight */
  suggestedWeight: number;
}

/** 记忆块列表项（team-assets / agent-fixed / my-agents 共用） */
export interface ChatMemoryBlock {  id: string;
  title: string;
  summary?: string;
  uploaded_by_user_id: string;
  updated_at_ms: number;
  layer_counts: { L0_messages: number; L1: number; L2: number; L3: number };
  /** 仅 team-assets */
  bound_agent_count?: number;
  /** 仅 agent-fixed */
  agent_id?: string;
  /** 资产可见范围：agent-fixed / my-agents 由 visibility 映射返回；team-assets 不返回（恒为 team） */
  scope?: 'team' | 'private';
}

/** L1 metadata 宽松形状（C1 落库：coreRefs / recall_count；网关今日不返回 → 前向兼容） */
export interface ChatMemoryLayerMetadata {
  coreRefs?: unknown;
  recall_count?: unknown;
  last_recalled_at?: unknown;
  [k: string]: unknown;
}

/** 分层懒加载条目 */
export interface ChatMemoryLayerItem {
  id: string;
  role?: string;
  title: string;
  body: string;
  tags?: string[];
  refs?: string[];
  /** 条目创建/记录时间（ISO8601），backend 从 recorded_at_ms / created_time_ms / updated_at 转换 */
  created_at?: string;
  // 灵魂记忆字段（时空网格 / 记忆图 UI）
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
  /** L1 行 metadata（价值锚 coreRefs / 回忆统计 recall_count）；缺省 = 上游未返回 */
  metadata?: ChatMemoryLayerMetadata;
}

/** L1 语义搜索命中项：在分层条目基础上附带相关度 score（越大越相关） */
export interface ChatMemorySearchHit extends ChatMemoryLayerItem {
  score?: number;
}

const CHAT_MEMORY_PREFIX = '/api/v1/chat-memory';

async function chatMemoryCall<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>(
    'POST',
    `${CHAT_MEMORY_PREFIX}/${endpoint}`,
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
  return envelope.data as T;
}

export const chatMemoryApi = {
  /** 记忆健康条：网关 /health 的 memory 子对象（vectorCoverage/embedding/degradedSince，T15） */
  health: () => chatMemoryCall<{ memory: MemoryHealthInfo }>('health', {}),

  /** 团队 Memory 池：当前团队所有已共享的 chat_memory */
  teamAssets: (teamId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[]; total: number }>('team-assets', { team_id: teamId }),

  /** Agent 固定资产 */
  agentFixed: (agentId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[]; total: number }>('agent-fixed', {
      agent_id: agentId,
    }),

  /** 我的资产分配（owner=me 的 agent 列表） */
  myAgents: (teamId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[] }>('my-agents', { team_id: teamId }),

  /** L0/L1/L2/L3 分层懒加载；L2 可传 path 懒读单个 Markdown 原文。
   *  L0 游标分页：第一页传 offset=0；后续页传 beforeTs（最后一条消息的 created_at），
   *  后端用 time_end 过滤，offset 归零，避免 VDB 大 offset 扫描。 */
  layer: (
    blockId: string,
    l: 'L0' | 'L1' | 'L2' | 'L3',
    limit = 50,
    offset = 0,
    path?: string,
    beforeTs?: string,
    timeStart?: string,
    timeEnd?: string,
  ) =>
    chatMemoryCall<{
      layer: string;
      items: ChatMemoryLayerItem[];
      total: number;
      limit: number;
      offset: number;
    }>('layer', {
      block_id: blockId,
      layer: l,
      limit,
      offset,
      ...(path ? { path } : {}),
      ...(beforeTs ? { before_ts: beforeTs } : {}),
      // 详情页时间筛选器（ISO8601），仅 L0 / L1 生效，后端对 L2 / L3 忽略
      ...(timeStart ? { time_start: timeStart } : {}),
      ...(timeEnd ? { time_end: timeEnd } : {}),
    }),

  /** 批量设置某个 agent 的固定 memory，后端会原子校验借入上限。 */
  setAgentFixed: (teamId: string, agentId: string, blockIds: string[]) =>
    chatMemoryCall<{ updated: boolean; agent_id: string; block_ids: string[] }>('set-agent-fixed', {
      team_id: teamId,
      agent_id: agentId,
      block_ids: blockIds,
    }),

  /** 借入资产到我的 agent */
  allocate: (teamId: string, blockId: string, agentId: string) =>
    chatMemoryCall<{ allocated: boolean; agent_id: string; block_id: string }>('allocate', {
      team_id: teamId,
      block_id: blockId,
      agent_id: agentId,
    }),

  /** 从 agent 解绑 */
  unbind: (teamId: string, blockId: string, agentId: string) =>
    chatMemoryCall<{ unbound: boolean; agent_id: string; block_id: string }>('unbind', {
      team_id: teamId,
      block_id: blockId,
      agent_id: agentId,
    }),

  /** 手工建独立 UserAsset */
  create: (teamId: string, title: string, scope: 'team' | 'private', description?: string) =>
    chatMemoryCall<ChatMemoryBlock>('create', { team_id: teamId, title, scope, description }),

  /** 切换资产可见范围 */
  patchScope: (blockId: string, scope: 'team' | 'private') =>
    chatMemoryCall<{ updated: boolean; id: string; scope: string }>('patch-scope', {
      block_id: blockId,
      scope,
    }),

  /** 导入历史对话到 agent 的 L0（走 /v3/conversation/add） */
  import: (params: {
    teamId: string;
    agentId: string;
    messages: Array<{ role: string; content: string }>;
    sessionId?: string;
  }) =>
    chatMemoryCall<{
      imported: boolean;
      block_id: string;
      session_id: string;
      accepted_count: number;
    }>('import', {
      team_id: params.teamId,
      agent_id: params.agentId,
      messages: params.messages,
      session_id: params.sessionId,
    }),

  /** 编辑单层记忆内容（Owner-only）：
   *  L1 传 id=记录主键 + content；L2 传 id=文件路径 + content（可选 summary）；
   *  L3 只传 content（整份 core persona 覆盖写）。 */
  updateLayer: (
    blockId: string,
    layer: 'L1' | 'L2' | 'L3',
    params: { id?: string; content: string; summary?: string },
  ) =>
    chatMemoryCall<{
      id?: string;
      path?: string;
      version?: string;
      updated_at?: string;
    }>('layer-update', {
      block_id: blockId,
      layer,
      ...(params.id ? { id: params.id } : {}),
      content: params.content,
      ...(params.summary !== undefined ? { summary: params.summary } : {}),
    }),

  /** 分层语义 / 关键字搜索（agent 维度跨 session 召回，命中项带 score）：
   *  L0 = 对话消息检索；L1 = 原子记忆检索。 */
  searchLayer: (
    blockId: string,
    layer: 'L0' | 'L1',
    query: string,
    limit = 30,
    type?: string,
  ) =>
    chatMemoryCall<{ items: ChatMemorySearchHit[]; total: number }>('search', {
      block_id: blockId,
      layer,
      query,
      limit,
      ...(type ? { type } : {}),
    }),

  /** 记忆图（G）：某条 L1 记录的邻接记忆（l1_links 边）。 */
  neighbors: (
    blockId: string,
    id: string,
    opts: { types?: string[]; maxHop?: number; maxN?: number } = {},
  ) =>
    chatMemoryCall<{
      id: string;
      neighbors: Array<{
        id: string;
        type: string;
        strength?: number;
        hop?: number;
        content?: string;
        occurred_at?: string;
        certainty?: string;
        valence?: number;
        significance?: number;
      }>;
    }>('neighbors', {
      block_id: blockId,
      id,
      ...(opts.types?.length ? { types: opts.types } : {}),
      ...(opts.maxHop != null ? { maxHop: opts.maxHop } : {}),
      ...(opts.maxN != null ? { maxN: opts.maxN } : {}),
    }),

  /** 关联链（U-A3）：两节点 BFS 最短路径（/v3/atomic/path 透传；path=null = 不可达或存储未支持） */
  atomicPath: (blockId: string, startId: string, endId: string, opts: { maxHop?: number } = {}) =>
    chatMemoryCall<{
      startId: string;
      endId: string;
      path: Array<{
        id: string;
        type: string;
        strength: number;
        hop: number;
        content?: string;
        occurred_at?: string;
        certainty?: string;
        valence?: number;
        significance?: number;
      }> | null;
    }>('path', {
      block_id: blockId,
      startId,
      endId,
      ...(opts.maxHop != null ? { maxHop: opts.maxHop } : {}),
    }),

  /** 归档桶列表（Task 4；网关不做租户过滤，行无 team/agent 字段——见任务报告 concern-2） */
  archiveList: (blockId: string, limit = 100, offset = 0) =>
    chatMemoryCall<{
      items: Array<{
        record_id: string;
        archived_at: string;
        reason: string;
        content: string;
        occurred_at?: string;
      }>;
      total: number;
    }>('archive/list', { block_id: blockId, limit, offset }),

  /** 归档恢复（Owner-only；恢复后回主时间轴） */
  archiveRestore: (blockId: string, id: string) =>
    chatMemoryCall<{ ok: boolean; id: string }>('archive/restore', {
      block_id: blockId,
      id,
    }),

  /** 价值锚列表（Task 5；复用 /v3/core-memory/read 的 values，丢 slots）。
   *  GROW：includeRetired=true 附带退休区行（state='retired'；vetoed 任何读面都不可见）。 */
  valuesList: (blockId: string, opts?: { includeRetired?: boolean }) =>
    chatMemoryCall<{ values: ValueAnchor[] }>('values/list', {
      block_id: blockId,
      ...(opts?.includeRetired ? { include_retired: true } : {}),
    }),

  /** agent 身份区只读（U1，DS-SOUL-MEMORY-002 P1）：复用 /v3/core-memory/read 的 slots
   *  （values/list 丢 slots 的既有注释即此缺口；BFF 透传零新端点）。 */
  identityRead: (blockId: string) =>
    chatMemoryCall<{ slots: Array<{ slot: string; content: string; version?: number }> }>('identity/read', {
      block_id: blockId,
    }),

  /** P2（O13 UI）：待办列表（core_value/strict_rule 分级提案，人工裁决后生效） */
  pendingList: (blockId: string) =>
    chatMemoryCall<{ pending: PendingItem[] }>('pending/list', { block_id: blockId }),

  /** 待办决策（Owner-only）：adopted 采纳（落槽）/ rejected 拒绝（O13 单向状态机，复决 404） */
  pendingDecide: (blockId: string, pendingId: string, decision: 'adopted' | 'rejected') =>
    chatMemoryCall<{ pending_id: string; decision: string; slot?: string }>('pending/decide', {
      block_id: blockId,
      pending_id: pendingId,
      decision,
    }),

  /** 价值锚 upsert：valence 显式传入 = 用户微调；不传 = plain 新建（落 NULL 待 LLM 判）。
   *  U2：可选 attrs（人物锚 role/aliases 行内编辑；显式传入才更新，theme 锚忽略无害）。 */
  valuesUpsert: (
    blockId: string,
    params: { value_id: string; label: string; weight: number; valence?: number; attrs?: { role?: string; aliases?: string[] } },
  ) =>
    chatMemoryCall<{ ok: boolean; value_id: string }>('values/upsert', {
      block_id: blockId,
      value_id: params.value_id,
      label: params.label,
      weight: params.weight,
      ...(params.valence !== undefined ? { valence: params.valence } : {}),
      ...(params.attrs !== undefined ? { attrs: params.attrs } : {}),
    }),

  /** 价值锚删除（Owner-only；不存在/失败 404） */
  valuesDelete: (blockId: string, valueId: string) =>
    chatMemoryCall<{ ok: boolean; value_id: string }>('values/delete', {
      block_id: blockId,
      value_id: valueId,
    }),

  /** 重新总结方向（C2 derive）：LLM 重判 NULL 行；后端保证永不覆盖用户微调 */
  valuesDerive: (blockId: string) =>
    chatMemoryCall<{ derived: number; skipped: number }>('values/derive', {
      block_id: blockId,
    }),

  /** 价值锚发现（Task DISC，提议制）：LLM 蒸馏提案，只提议不落库；采纳走 valuesUpsert */
  valuesDiscover: (blockId: string) =>
    chatMemoryCall<{ proposals: ValueProposal[]; sampleSize: number }>('values/discover', {
      block_id: blockId,
    }),

  /** GROW（钉住/取消钉住）：pinned=1 永不被自生长挤出 */
  valuesPin: (blockId: string, valueId: string, pinned: boolean) =>
    chatMemoryCall<{ ok: boolean; value_id: string; pinned: boolean }>('values/pin', {
      block_id: blockId,
      value_id: valueId,
      pinned,
    }),

  /** GROW（手动退休）：state → 'retired'（退休区可见，可恢复/可钉住；可逆） */
  valuesRetire: (blockId: string, valueId: string) =>
    chatMemoryCall<{ ok: boolean; value_id: string }>('values/retire', {
      block_id: blockId,
      value_id: valueId,
    }),

  /** GROW（恢复）：retired → active（退休区[恢复]） */
  valuesRestore: (blockId: string, valueId: string) =>
    chatMemoryCall<{ ok: boolean; value_id: string }>('values/restore', {
      block_id: blockId,
      value_id: valueId,
    }),
};
