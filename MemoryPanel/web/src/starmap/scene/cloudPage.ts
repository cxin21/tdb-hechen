/**
 * starmap/scene/cloudPage.ts — 进入某一朵云之后的分页数据。
 *
 * 契约（与任务说明同一份，不另造）：
 *   忆云：chatMemoryApi.layer(limit, offset, timeStart, timeEnd)。四层各按 100 条标准分页，
 *         time_start / time_end（日期框）只对 L0/L1 生效；「全部」= 四层各取本页 100 条同屏（4 次请求，串行）。
 *   典籍云：wiki.graph(wikiId, { community, limit: 80, offset })。有社区按社区翻页，否则翻节点切片。边只留两端都在本页的。
 *   构筑云：code.structure(id, { kinds, edgeKinds: calls|imports|contains, limit: 80, offset })。
 *   技艺云：不分页。assigned = 已挂到当前 agent，其余 dim。
 */
import type { ChatMemoryLayerItem } from '../../lib/api/chat-memory';
import type { CodeGraphStructure, GraphData, KnowledgeFixedItem } from '../../lib/api/knowledge-api';
import type { SkillSummary } from '../../lib/api/skill-api';
import {
  fetchCodeStructure,
  fetchMemoryItem,
  fetchMemoryLayer,
  fetchSkillList,
  fetchWikiGraph,
} from '../cache/apiCache';
import { ApiError } from '../../lib/api/base';

export type MemoryLayer = 'L0' | 'L1' | 'L2' | 'L3';
/** 忆云的视图口径：all = 四层同屏（不分页）；单层 = 该层标准分页。 */
export type MemoryScope = 'all' | MemoryLayer;
export const MEMORY_LAYERS: MemoryLayer[] = ['L3', 'L2', 'L1', 'L0'];
/** 四层正式名称（产品口径，不要改写成「结论/日目录/原文」这类简写）。 */
export const LAYER_NAME: Record<MemoryLayer, string> = {
  L0: '对话原文',
  L1: '原子记忆',
  L2: '场景记忆',
  L3: '核心记忆',
};
/** 「L0 对话原文」这种层号+层名的写法，全站统一用这个拼。 */
export function layerTitle(l: MemoryLayer): string {
  return l + ' ' + LAYER_NAME[l];
}
/* 四朵云一个口径：每页 100 条，每次只向后端要这一页，前端不再整批取回再切片。 */
export const PAGE_SIZE = 100;

export function isRangeTooLarge(e: unknown): boolean {
  if (e instanceof ApiError) return e.rawMessage === 'RANGE_TOO_LARGE' || e.message === 'RANGE_TOO_LARGE';
  return e instanceof Error && (e.message === 'RANGE_TOO_LARGE' || e.message.includes('RANGE_TOO_LARGE'));
}

export interface StarPoint {
  id: string;
  label: string;
  kind: string;
  lit: boolean;
  weight: number;
  detail: string;
  at?: string;
}

export interface StarEdge {
  source: string;
  target: string;
  kind: string;
}

export interface PageModel {
  points: StarPoint[];
  edges: StarEdge[];
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
  hint?: string;
  /** 一律 paged：offset = (页号-1) × PAGE_SIZE，只取这一页 */
  mode?: 'paged';
  /** 忆云「全部」视图：每层各自取回多少、库里共多少 */
  layerCounts?: { layer: MemoryLayer; loaded: number; total: number }[];
  /** 忆云「全部」视图：某层取数失败时的原始信息（不要让失败静默变成 0） */
  layerErrors?: { layer: MemoryLayer; message: string }[];
  communities?: { id: string; label: string; count: number }[];
}

function clip(text: string | undefined, n: number): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function keepInternal(nodes: { id: string }[], edges: StarEdge[]): StarEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  return edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
}

/** 记忆条目 → 星点。kind 就是层号，画布按层上色（与总览同一套层色）。 */
function memoryPoint(layer: MemoryLayer, it: ChatMemoryLayerItem): StarPoint {
  const sig = typeof it.significance === 'number' ? it.significance : undefined;
  return {
    id: it.id,
    label: clip(it.title || it.body || it.id, 28),
    kind: layer,
    lit: true,
    weight: typeof sig === 'number' ? Math.min(1, Math.max(0.2, sig > 1 ? sig / 10 : sig)) : 0.6,
    detail: clip(it.body || it.title, 240),
    at: it.occurred_at ?? it.created_at,
  };
}

/** 层内关系边：L1 同会话相邻 + refs 引用 + 原文溯源（L0 已取回时直接连到那颗 L0 星）。 */
function memoryEdges(layer: MemoryLayer, items: ChatMemoryLayerItem[], l0Ids?: Set<string>): StarEdge[] {
  if (layer !== 'L1') return [];
  const edges: StarEdge[] = [];
  const bySession = new Map<string, string[]>();
  for (const it of items) {
    const sk = it.session_key ?? it.session_id;
    if (!sk) continue;
    const arr = bySession.get(sk) ?? [];
    arr.push(it.id);
    bySession.set(sk, arr);
  }
  for (const ids of bySession.values()) {
    for (let i = 1; i < ids.length; i += 1) edges.push({ source: ids[i - 1], target: ids[i], kind: '同会话' });
  }
  const idset = new Set(items.map((it) => it.id));
  for (const it of items) {
    for (const ref of it.refs ?? []) {
      if (idset.has(ref)) edges.push({ source: it.id, target: ref, kind: '引用' });
    }
    for (const src of (it.source_message_ids ?? []).slice(0, 4)) {
      if (l0Ids?.has(src)) edges.push({ source: it.id, target: src, kind: '出自原文' });
    }
  }
  return edges;
}

export async function loadMemoryPage(input: {
  blockId: string;
  layer: MemoryLayer;
  offset: number;
  /** 时间筛选（ISO8601，仅 L0/L1 生效）；不传 = 不限时间 */
  from?: string;
  to?: string;
  limit?: number;
}): Promise<PageModel> {
  const timed = input.layer === 'L0' || input.layer === 'L1';
  const limit = input.limit ?? PAGE_SIZE;
  try {
    const r = await fetchMemoryLayer({
      blockId: input.blockId,
      layer: input.layer,
      limit,
      offset: input.offset,
      from: timed ? input.from : undefined,
      to: timed ? input.to : undefined,
    });
    if (r.error && !r.data) throw r.error;
    const res = r.data!;
    const items = (res.items ?? []) as ChatMemoryLayerItem[];
    const points: StarPoint[] = items.map((it) => memoryPoint(input.layer, it));
    const edges = memoryEdges(input.layer, items);
    return {
      points,
      edges: keepInternal(points, edges),
      total: res.total ?? points.length,
      offset: input.offset,
      limit,
      mode: 'paged',
      truncated: (res.total ?? 0) > input.offset + points.length,
    };
  } catch (e) {
    if (isRangeTooLarge(e)) {
      return {
        points: [],
        edges: [],
        total: 0,
        offset: 0,
        limit,
        truncated: false,
        hint: '时间范围太大，请收窄后再看。',
      };
    }
    throw e;
  }
}

/** 聚合层的全量正文：L2 带 path 读那篇场景记忆 md，L3 直接读整份核心记忆。 */
export async function readMemoryItem(input: {
  blockId: string;
  layer: 'L2' | 'L3';
  path?: string;
}): Promise<{ id: string; title: string; body: string; at?: string }> {
  const r = await fetchMemoryItem({ blockId: input.blockId, layer: input.layer, path: input.path });
  if (r.error && !r.data) throw r.error;
  const res = r.data!;
  const it = (res.items ?? [])[0];
  return {
    id: it?.id ?? input.path ?? input.layer.toLowerCase(),
    title: it?.title ?? input.path ?? '',
    body: it?.body ?? '',
    at: it?.occurred_at ?? it?.created_at,
  };
}

/**
 * 忆云「全部」视图：四层同屏、但**按页取**——每层都要 (页号-1)×100 之后的 100 条，
 * 翻页时四层一起往前 100，和单层翻页同一个动作。
 * 星点按 L3→L2→L1→L0 排，画布自然成同心四圈，和总览一个形状。
 * 4 个请求串行发（实测并发会顶到内核 15s 超时）。
 * total 取四层里最大的那个，作为分页总条数。
 */
export async function loadMemoryAll(input: {
  blockId: string;
  offset: number;
  from?: string;
  to?: string;
}): Promise<PageModel> {
  const points: StarPoint[] = [];
  const itemsByLayer: Partial<Record<MemoryLayer, ChatMemoryLayerItem[]>> = {};
  const layerCounts: { layer: MemoryLayer; loaded: number; total: number }[] = [];
  const layerErrors: { layer: MemoryLayer; message: string }[] = [];
  let maxTotal = 0;
  let hint: string | undefined;
  for (const layer of MEMORY_LAYERS) {
    const timed = layer === 'L0' || layer === 'L1';
    try {
      const r = await fetchMemoryLayer({
        blockId: input.blockId,
        layer,
        limit: PAGE_SIZE,
        offset: input.offset,
        from: timed ? input.from : undefined,
        to: timed ? input.to : undefined,
      });
      if (r.error && !r.data) throw r.error;
      const res = r.data!;
      const items = (res.items ?? []) as ChatMemoryLayerItem[];
      itemsByLayer[layer] = items;
      const t = res.total ?? items.length;
      maxTotal = Math.max(maxTotal, t);
      layerCounts.push({ layer, loaded: items.length, total: t });
      points.push(...items.map((it) => memoryPoint(layer, it)));
    } catch (e) {
      if (isRangeTooLarge(e)) {
        hint = 'L0/L1 时间范围太大，后端拒绝了这个窗口，请收窄日期或清空时间。';
        layerCounts.push({ layer, loaded: 0, total: 0 });
        layerErrors.push({ layer, message: 'RANGE_TOO_LARGE（时间范围过大）' });
        continue;
      }
      /* 单层失败不拖垮整屏，但绝不静默成 0：原文留进 layerErrors 由侧卡显示 */
      layerCounts.push({ layer, loaded: 0, total: 0 });
      layerErrors.push({ layer, message: e instanceof Error ? e.message : String(e) });
    }
  }
  /* 跨层提取边：L1 → 它来自的 L0 原话（source_message_ids 命中屏上的 L0 星才连）。
     四层都取回来之后再建边，否则 L1 建边时 L0 还没到。 */
  const l0Ids = new Set((itemsByLayer.L0 ?? []).map((it) => it.id));
  const edges: StarEdge[] = memoryEdges('L1', itemsByLayer.L1 ?? [], l0Ids);
  const kept = keepInternal(points, edges);
  return {
    points,
    edges: kept,
    total: maxTotal,
    offset: input.offset,
    limit: PAGE_SIZE,
    truncated: input.offset + PAGE_SIZE < maxTotal,
    mode: 'paged',
    layerCounts,
    layerErrors,
    ...(hint ? { hint } : {}),
  };
}

export async function loadWikiPage(input: {
  wikiId: string;
  community?: string;
  offset: number;
}): Promise<PageModel> {
  const wr = await fetchWikiGraph({
    wikiId: input.wikiId,
    community: input.community,
    limit: PAGE_SIZE,
    offset: input.offset,
  });
  if (wr.error && !wr.data) throw wr.error;
  const data: GraphData = wr.data!;
  const nodes = data.nodes ?? [];
  const points: StarPoint[] = nodes.map((n) => ({
    id: n.id,
    label: clip(n.label || n.path || n.id, 28),
    kind: n.type || 'page',
    lit: true,
    weight: Math.min(1, 0.35 + (n.linkCount ?? 0) / 12),
    detail: n.label || n.id,
  }));
  const edges = keepInternal(
    points,
    (data.edges ?? []).map((e) => ({ source: e.source, target: e.target, kind: '引用' })),
  );
  const communities = (data.communities ?? []).map((c) => ({
    id: String(c.id),
    label: '社区 ' + c.id,
    count: c.nodeCount,
  }));
  return {
    points,
    edges,
    total: data.total ?? (input.community ? points.length : nodes.length),
    offset: input.offset,
    limit: PAGE_SIZE,
    mode: 'paged',
    truncated: data.truncated === true || (data.total != null && data.total > input.offset + points.length),
    communities,
  };
}

export async function loadCodePage(input: {
  codeGraphId: string;
  kinds: string[];
  offset: number;
}): Promise<PageModel> {
  const cr = await fetchCodeStructure({
    codeGraphId: input.codeGraphId,
    kinds: input.kinds,
    limit: PAGE_SIZE,
    offset: input.offset,
  });
  if (cr.error && !cr.data) throw cr.error;
  const data: CodeGraphStructure = cr.data!;
  const points: StarPoint[] = (data.nodes ?? []).map((n) => ({
    id: n.id,
    label: clip(n.name || n.qualifiedName || n.id, 28),
    kind: n.kind,
    lit: n.isExported !== false,
    weight: n.kind === 'file' ? 0.9 : n.kind === 'class' ? 0.75 : 0.55,
    detail: [n.qualifiedName, n.filePath, n.signature].filter(Boolean).join(' · '),
  }));
  const edges = keepInternal(
    points,
    (data.edges ?? []).map((e) => ({ source: e.source, target: e.target, kind: e.kind })),
  );
  return {
    points,
    edges,
    total: data.total ?? points.length,
    offset: input.offset,
    limit: PAGE_SIZE,
    mode: 'paged',
    truncated: data.truncated === true || data.total > input.offset + points.length,
  };
}

/** 已挂载清单只用来判「亮/暗」，不画星；给个够用的上限，别为它多翻页。 */
const ASSIGNED_CAP = 500;

/**
 * 技艺云：同样每页 100、只取这一页。
 * scope=assigned 时这一页就是「已挂到当前 agent」的技能（全亮）；
 * scope=all 时这一页是团队技能池，再串行补一次已挂载 id 集合来判亮暗。
 */
export async function loadSkillPage(input: {
  teamId: string;
  agentId: string;
  scope: 'assigned' | 'all';
  offset: number;
}): Promise<PageModel> {
  if (input.scope === 'assigned') {
    const sr = await fetchSkillList({
      teamId: input.teamId,
      agentId: input.agentId,
      limit: PAGE_SIZE,
      offset: input.offset,
    });
    if (sr.error && !sr.data) throw sr.error;
    const res = sr.data!;
    return {
      points: skillPoints(res.items, new Set(res.items.map((s) => s.skill_id)), input.agentId, true),
      edges: [],
      total: res.total,
      offset: input.offset,
      limit: PAGE_SIZE,
      truncated: res.total > input.offset + res.items.length,
      mode: 'paged',
    };
  }
  const poolR = await fetchSkillList({ teamId: input.teamId, limit: PAGE_SIZE, offset: input.offset });
  if (poolR.error && !poolR.data) throw poolR.error;
  const pool = poolR.data!;
  const ownedR = await fetchSkillList({
    teamId: input.teamId,
    agentId: input.agentId,
    limit: ASSIGNED_CAP,
    offset: 0,
  });
  if (ownedR.error && !ownedR.data) throw ownedR.error;
  const owned = ownedR.data!;
  const assignedIds = new Set(owned.items.map((s) => s.skill_id));
  return {
    points: skillPoints(pool.items, assignedIds, input.agentId, false),
    edges: [],
    total: pool.total,
    offset: input.offset,
    limit: PAGE_SIZE,
    truncated: pool.total > input.offset + pool.items.length,
    mode: 'paged',
  };
}

function skillPoints(pool: SkillSummary[], assignedIds: Set<string>, agentId: string, allLit: boolean): StarPoint[] {
  return pool.map((s) => {
    const lit = allLit || assignedIds.has(s.skill_id) || s.owner_agent_id === agentId;
    return {
      id: s.skill_id,
      label: clip(s.name, 28),
      kind: 'skill',
      lit,
      weight: lit ? 1 : 0.35,
      detail: clip(s.description, 200),
    };
  });
}

export function litIds(fixed: KnowledgeFixedItem[], type: 'llm_wiki' | 'code_graph'): Set<string> {
  return new Set(fixed.filter((f) => f.asset_type === type).map((f) => f.knowledge_id));
}
