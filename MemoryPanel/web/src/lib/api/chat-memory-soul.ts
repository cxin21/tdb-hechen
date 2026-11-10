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

const SOUL_CARD_PATH = '/api/v1/chat-memory/soul-card';

/**
 * 卡的底色标签（中文特质词，非六轴）。
 *
 * gloss 只有前 2 个标签有（内核 CARD_GLOSS_TOP_N），是给"为什么会有这一条"的一句话解释。
 */
export interface SoulCardLabel {
  label: string;
  /** 该特质的当前强度（0..1，展示时保留一位小数） */
  act: number;
  gloss?: string;
}

/**
 * 卡的一块（v13 九块元数据）。source/confidence 是"这块内容哪儿来的、有多确定"，
 * evidenceIds 是支撑它的事实条数（前端只显示条数，不显示 id）。
 */
export interface SoulCardBlock {
  id: string;
  title: string;
  chars: number;
  source: string;
  confidence: string;
  evidenceIds: string[];
  warnings: string[];
}

/**
 * 人格卡只读视图（task-6）。字段与内核 SoulCardAssembly 一一对应，
 * 由 BFF 收窄后原样转发；text 是渲染好的卡全文，前端**不得改写/截断**。
 */
export interface SoulCardPayload {
  /** tenant+slot 维度版本号；库未迁移时为 0 */
  version: number;
  /** 卡内容哈希（前端只展示前 8 位） */
  hash: string;
  /** 卡全文（含 [读法] 段与 ### 区块标题） */
  text: string;
  /** 内核统计的字符数；缺失时 BFF 用 text.length 兜底 */
  chars: number;
  labels: SoulCardLabel[];
  /** 内核提示（如未落版、字段来源缺失）；原样展示，不吞 */
  warnings: string[];
  /** 区块键 → 来源（declared / derived / observed） */
  sources: Record<string, string>;
  /** 有未落版改动（写入侧尚未 append 新版本） */
  dirty: boolean;
  /** 该 tenant 是否已有种子卡 */
  seeded: boolean;
  /** 卡的结构版本；v13 为 "13"（旧上游缺省不带） */
  schema?: '13';
  /** 九块元数据；旧上游/异常时为缺失，前端按 legacy 来源行降级 */
  blocks?: SoulCardBlock[];
}

export interface SoulCardQuery {
  teamId: string;
  /** tenant 的 user 轴；缺省由内核取 "default" */
  userId?: string;
  /** agent 轴；缺省由内核取 "default" */
  agentId?: string;
}

/**
 * 拉人格卡（只读，零写入）。
 *
 * GET 而非 POST：这是幂等读面，与 POST /soul-versions（审计渲染）区分开，
 * 便于浏览器/中间层缓存语义。三个轴都走 query，BFF 以 tenantAxis 做缺省。
 */
export async function fetchSoulCard(query: SoulCardQuery): Promise<SoulCardPayload> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const params = new URLSearchParams();
  params.set('team', query.teamId);
  if (query.userId) params.set('user', query.userId);
  if (query.agentId) params.set('agent', query.agentId);
  const envelope = await request<MetaEnvelope<SoulCardPayload>>(
    'GET',
    `${SOUL_CARD_PATH}?${params.toString()}`,
    undefined,
    {
      'X-Tdai-Service-Id': session.instanceId,
      'X-Tdai-User-Key': session.userKey,
    },
  );
  if (envelope.code !== 0) {
    // 保留后端 message（如 503 soul_card_unavailable），UI 直接展示，不伪装成空卡。
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as SoulCardPayload;
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
const SOUL_TRAIT_STATE_PATH = '/api/v1/chat-memory/soul-trait-state';

/**
 * 特质两栏的一行：label 是中文种子词（不是轴名），
 * seedWeight = 表单里设定的值，nowWeight = 它现在的激活度，drifted = 两者差超过单次漂移上限。
 * 三个数值都由内核给，前端只展示两位小数，不参与计算。
 */
export interface SoulTraitStateRow {
  label: string;
  seedWeight: number;
  nowWeight: number;
  drifted: boolean;
}

/** 「你设定的 / 它现在」两栏数据（spec §5）。 */
export interface SoulTraitStatePayload {
  agentId: string;
  /** 最近一次状态落库时间；null = 还没有任何状态行（前端显示「还没长出来」）。 */
  updatedAt: string | null;
  traits: SoulTraitStateRow[];
}

export interface SoulTraitStateQuery {
  teamId: string;
  /** tenant 的 user 轴；缺省由内核取 "default" */
  userId?: string;
  agentId?: string;
}

/** 拉特质两栏（只读）。失败保留后端 message（如 503 soul_trait_state_unavailable）。 */
export async function fetchSoulTraitState(
  query: SoulTraitStateQuery,
): Promise<SoulTraitStatePayload> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const params = new URLSearchParams();
  params.set('team', query.teamId);
  if (query.userId) params.set('user', query.userId);
  if (query.agentId) params.set('agent', query.agentId);
  const envelope = await request<MetaEnvelope<SoulTraitStatePayload>>(
    'GET',
    `${SOUL_TRAIT_STATE_PATH}?${params.toString()}`,
    undefined,
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
  return envelope.data as SoulTraitStatePayload;
}

const SOUL_INJECTION_STATS_PATH = '/api/v1/soul/injection-stats';

/** 注入窗口（服务端按 hours 从 now 反推）。 */
export interface SoulInjectionStatsWindow {
  hours: number;
  from: string;
  to: string;
}

export interface SoulInjectionLastCard {
  version: number;
  hash: string;
  chars: number;
}

export interface SoulInjectionLastVolatile {
  chars: number;
  hash: string;
  skipped: boolean;
}

/** 宿主上报的失败原因计数；**null = 窗口内没有任何失败上报**（≠ 0 次失败）。 */
export interface SoulInjectionFailReasons {
  http_status: number;
  timeout: number;
  empty: number;
  parse: number;
}

export interface SoulInjectionStatsPayload {
  window: SoulInjectionStatsWindow;
  /** 窗口内真正注入的轮数；0 = 还没注入过 */
  rows: number;
  /** 最近一次注入时间（ISO）；null = 算不出 */
  lastAt: string | null;
  /** 最近一次注入的卡体积；null = 算不出（此时「卡 v…」整段不出现） */
  lastCard: SoulInjectionLastCard | null;
  /** 最近一次 volatile（每轮对话段）体积；null = 算不出 */
  lastVolatile: SoulInjectionLastVolatile | null;
  failReasons: SoulInjectionFailReasons | null;
  /** 有 soul 观测但没有任何注入行回传的召回会话数（插件没回报） */
  serverRenderOnly: number;
  /** 召回行 ↔ 注入行按会话对账结果（matched 为可比会话数） */
  pairs: { matched: number; charMismatch: number };
  /** journal 关掉/目录不存在：服务端给 200 全零 + 这个标记 */
  note?: 'journal_disabled';
  /**
   * 窗口内每轮块（volatile）计数：injected = 真追加进提示词，skipped = 因「近 3 轮同文本」
   * 被去重跳过。可选字段：旧 Core 不返回它，此时前端按「该字段无数据」处理（不冒充 0）。
   */
  volatileCounts?: { injected: number; skipped: number };
}

export interface SoulInjectionStatsQuery {
  /** 必填：没有团队轴就不查（拿错团队的统计比没有更糟） */
  teamId: string;
  /** tenant 的 user 轴；缺省由内核取 "default" */
  userId?: string;
  /** agent 轴；缺省由内核取 "default" */
  agentId?: string;
  /** 1..8760，缺省 24（BFF 会原样校验，非法给 400 BAD_HOURS） */
  hours?: number;
}

/**
 * 拉「注入健康」统计（只读，零写入）。
 *
 * 与 fetchSoulCard 同款：GET + 三轴 query，BFF 保留 401/403/503 原码不折 500；
 * 这里把非 0 信封转成 ApiError，并把后端 message 原样带出（UI 直接展示，不吞）。
 */
export async function fetchSoulInjectionStats(
  query: SoulInjectionStatsQuery,
): Promise<SoulInjectionStatsPayload> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const params = new URLSearchParams();
  params.set('team', query.teamId);
  if (query.userId) params.set('user', query.userId);
  if (query.agentId) params.set('agent', query.agentId);
  if (query.hours !== undefined) params.set('hours', String(query.hours));
  const envelope = await request<MetaEnvelope<SoulInjectionStatsPayload>>(
    'GET',
    SOUL_INJECTION_STATS_PATH + '?' + params.toString(),
    undefined,
    {
      'X-Tdai-Service-Id': session.instanceId,
      'X-Tdai-User-Key': session.userKey,
    },
  );
  if (envelope.code !== 0) {
    // 保留后端 message（如 400 MISSING_TEAM_ID / 503 soul_injection_stats_failed）。
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as SoulInjectionStatsPayload;
}

const SOUL_EMOTIONS_PATH = '/api/v1/soul/emotions';

/**
 * 情绪单行。除 at 外都可缺：agency / confidence / objectPerson 是阶段 3 新列，
 * 旧行与旧 Core 都没有——缺就是 null，UI 跳过那段，不当 0 用。
 */
export interface SoulEmotionRow {
  at: string | null;
  object: string | null;
  objectPerson: string | null;
  label: string | null;
  valence: number | null;
  arousal: number | null;
  dominance: number | null;
  intensity: number | null;
  /** 服务端按当前时间现场衰减后的强度（只衰一次） */
  decayedIntensity: number | null;
  /** 'self' | 'other' | 'environment'；未知值一律当不明 */
  agency: string | null;
  confidence: number | null;
  templateVersion: string | null;
}

/** 漏斗六档（Core 埋点 code）；顺序即漏斗顺序。 */
export type SoulEmotionFunnelCode =
  | 'emotion:candidate'
  | 'emotion:object_ok'
  | 'emotion:appraised'
  | 'emotion:anchor_hit'
  | 'emotion:intensity_ok'
  | 'emotion:committed';

export interface SoulEmotionsPayload {
  rows: SoulEmotionRow[];
  /** 六档全有才算数；上游没给时为 null（整段不渲染） */
  funnel: Record<SoulEmotionFunnelCode, number> | null;
}

export interface SoulEmotionsQuery {
  /** 必填：没有团队轴就不查 */
  teamId: string;
  /** tenant 的 user 轴；缺省由内核取 "default" */
  userId?: string;
  /** agent 轴；缺省由内核取 "default" */
  agentId?: string;
  /** 1..200，缺省 50（BFF 原样校验，非法给 400 BAD_LIMIT） */
  limit?: number;
  /** ISO 时间，只取该时间之后落库的行；解析交给 Core */
  since?: string;
}

/**
 * 拉情绪明细（只读，零写入）。
 *
 * 与 fetchSoulInjectionStats 同款：GET + 三轴 query，401/403/503 原码透出，
 * 非 0 信封转 ApiError 并把后端 message 带出（UI 直接展示，不吞）。
 */
export async function fetchSoulEmotions(
  query: SoulEmotionsQuery,
): Promise<SoulEmotionsPayload> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const params = new URLSearchParams();
  params.set('team', query.teamId);
  if (query.userId) params.set('user', query.userId);
  if (query.agentId) params.set('agent', query.agentId);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.since) params.set('since', query.since);
  const envelope = await request<MetaEnvelope<SoulEmotionsPayload>>(
    'GET',
    SOUL_EMOTIONS_PATH + '?' + params.toString(),
    undefined,
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
  return envelope.data as SoulEmotionsPayload;
}

const SOUL_PERSONS_PATH = '/api/v1/soul/persons';
const SOUL_PERSON_PATH = '/api/v1/soul/person';

/** 人物列表一行（已登记的人；fieldCount/relationCount 为 0 是常态）。 */
export interface SoulPersonRow {
  key: string;
  displayName: string;
  aliases: string[];
  platform: string;
  platformId: string | null;
  fieldCount: number;
  relationCount: number;
  updatedAt: string | null;
}

/**
 * 全员关系边。objKey 为 null 表示对方只有名字、还不是已登记的人 ——
 * 关系图用 objName 画一个浅色「未登记」节点，不补造 key。
 */
export interface SoulPersonEdge {
  relId: string;
  subjKey: string;
  subjName: string | null;
  pred: string;
  objKey: string | null;
  objName: string | null;
  direction: 'out' | 'mutual';
  quote: string;
  recordId: string;
  validFrom: string | null;
}

export interface SoulPersonsPayload {
  persons: SoulPersonRow[];
  edges: SoulPersonEdge[];
}

export interface SoulProfileEvidence {
  recordId: string;
  at: string | null;
  quote: string;
}

/** 九字段里的一条；只有已经提炼出依据的字段才会出现。 */
export interface SoulProfileField {
  field: string;
  label: string;
  text: string;
  evidence: SoulProfileEvidence[];
  updatedAt: string | null;
  stale: boolean;
}

/** 详情页关系行：in 方向时 objName 是本人名字，对方名按 counterpartKey 从列表反查。 */
export interface SoulProfileRelation {
  relId: string;
  pred: string;
  objKey: string | null;
  objName: string | null;
  direction: 'out' | 'in' | 'mutual';
  counterpartKey: string | null;
  quote: string;
  recordId: string;
  validFrom: string | null;
}

export interface SoulPersonDetailPayload {
  person: { key: string; displayName: string; aliases: string[] };
  fields: SoulProfileField[];
  relations: SoulProfileRelation[];
}

export interface SoulPersonsQuery {
  /** 必填：没有团队轴就不查 */
  teamId: string;
  /** tenant 的 user 轴；缺省由内核取 "default" */
  userId?: string;
  /** agent 轴；缺省由内核取 "default" */
  agentId?: string;
}

/**
 * 拉人物列表 + 全员关系边（只读，零写入）。
 *
 * 与 fetchSoulEmotions 同款：GET + 三轴 query，BFF 保留 400/404/503 原码不折 500；
 * 非 0 信封转 ApiError，后端 message 原样带出（UI 直接展示，不吞）。
 */
export async function fetchSoulPersons(
  query: SoulPersonsQuery,
): Promise<SoulPersonsPayload> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const params = new URLSearchParams();
  params.set('team', query.teamId);
  if (query.userId) params.set('user', query.userId);
  if (query.agentId) params.set('agent', query.agentId);
  const envelope = await request<MetaEnvelope<SoulPersonsPayload>>(
    'GET',
    SOUL_PERSONS_PATH + '?' + params.toString(),
    undefined,
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
  return envelope.data as SoulPersonsPayload;
}

/** 拉单人档案（九字段里已提炼的那几条 + 关系行，只读）。 */
export async function fetchSoulPerson(
  query: SoulPersonsQuery & { key: string },
): Promise<SoulPersonDetailPayload> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const params = new URLSearchParams();
  params.set('team', query.teamId);
  if (query.userId) params.set('user', query.userId);
  if (query.agentId) params.set('agent', query.agentId);
  params.set('key', query.key);
  const envelope = await request<MetaEnvelope<SoulPersonDetailPayload>>(
    'GET',
    SOUL_PERSON_PATH + '?' + params.toString(),
    undefined,
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
  return envelope.data as SoulPersonDetailPayload;
}
