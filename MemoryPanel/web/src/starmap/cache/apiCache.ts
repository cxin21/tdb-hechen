/**
 * starmap/cache/apiCache.ts — 星图读写缓存层（S2 第 2 块，P5）
 *
 * 为什么要有这一层：`scene/cloudPage.ts` 的五个 `load*Page` 原来直连 API，
 * 翻页 1→2→1 会把第 1 页再打三遍；换 agent 回来也是全量重打。
 *
 * 这里只做三件事：
 *  1. 把每个远端调用包成「带 key 的资源」，交给 `ResourceStore` 管 TTL / 单飞 / 失效；
 *  2. 统一 key 规范 `sc:<user>:<resource>:<qualifiers…>`，qualifier 只放筛选，不放对象本体；
 *  3. 给出写操作后要失效的 tag 名（`memory:block:<id>` 这类），正确性靠失效、TTL 只管「多久重问」。
 *
 * 不缓存写操作，不缓存正文到磁盘（隐私边界见设计文档 B 节）。
 */
import { chatMemoryApi } from '@/lib/api/chat-memory';
import { knowledgeApi } from '@/lib/api/knowledge-api';
import { listSkills } from '@/lib/api/skill-api';
import { onMutation, type MutationScope } from '@/lib/api/mutation-bus';
import { ResourceStore, type Lane } from './resources';

/** TTL 矩阵：只决定「多久之后重问」，正确性由 invalidate 保证。 */
export const TTL = {
  memoryLayerPage: 5 * 60_000,
  memoryItem: 10 * 60_000,
  wikiGraph: 5 * 60_000,
  codeStructure: 5 * 60_000,
  skillList: 60_000,
  /** 回放日志是 append-only 的调试日志：短 TTL 只防连点，正确性靠「刷新」按钮与换 agent 换 key。 */
  memoryJournal: 30_000,
  /** 记忆图谱邻接 / 关联链：点开看的是「现在这条数据的邻居」，2 分钟足够挡连点，写操作另有 tag 失效。 */
  memoryNeighbors: 2 * 60_000,
} as const;

export const starmapStore = new ResourceStore({ maxEntries: 400, laneLimit: { soul: 1, read: 4 } });

/** 当前登录用户；换用户必须整表清空，否则会看到上一个人的缓存。 */
let userScope = '';

export function setCacheUser(userId: string | undefined): void {
  const next = userId ?? '';
  if (next === userScope) return;
  userScope = next;
  starmapStore.clear();
}

export function cacheKey(...parts: Array<string | number | undefined | null>): string {
  return ['sc', userScope || '-', ...parts.map((p) => (p === undefined || p === null || p === '' ? '-' : String(p)))].join(':');
}

export interface CacheCallOptions {
  force?: boolean;
}

interface ReadSpec<T> {
  key: string;
  ttl: number;
  lane: Lane;
  tags: string[];
  run: () => Promise<T>;
  force?: boolean;
}

function read<T>(spec: ReadSpec<T>) {
  return starmapStore.load(spec.key, spec.run, {
    ttl: spec.ttl,
    lane: spec.lane,
    tags: spec.tags,
    force: spec.force,
  });
}

export interface MemoryLayerQuery {
  blockId: string;
  layer: 'L0' | 'L1' | 'L2' | 'L3';
  limit: number;
  offset: number;
  path?: string;
  beforeTs?: string;
  from?: string;
  to?: string;
}

export function fetchMemoryLayer(q: MemoryLayerQuery, opts: CacheCallOptions = {}) {
  const key = cacheKey('memory.layer', q.blockId, q.layer, q.limit, q.offset, q.from, q.to, q.path, q.beforeTs);
  return read({
    key,
    ttl: TTL.memoryLayerPage,
    // 分层读是内核重活：实测并发 6 会顶到 15s 超时，必须串行。
    lane: 'soul',
    tags: [`memory:block:${q.blockId}`],
    force: opts.force,
    run: () => chatMemoryApi.layer(q.blockId, q.layer, q.limit, q.offset, q.path, q.beforeTs, q.from, q.to),
  });
}

export function fetchMemoryItem(
  q: { blockId: string; layer: 'L2' | 'L3'; path?: string },
  opts: CacheCallOptions = {},
) {
  const key = cacheKey('memory.item', q.blockId, q.layer, q.path);
  return read({
    key,
    ttl: TTL.memoryItem,
    lane: 'soul',
    tags: [`memory:block:${q.blockId}`],
    force: opts.force,
    run: () => chatMemoryApi.layer(q.blockId, q.layer, 1, 0, q.path),
  });
}

export function fetchWikiGraph(
  q: { wikiId: string; community?: string; limit?: number; offset?: number },
  opts: CacheCallOptions = {},
) {
  const key = cacheKey('wiki.graph', q.wikiId, q.community, q.limit, q.offset);
  return read({
    key,
    ttl: TTL.wikiGraph,
    lane: 'read',
    tags: [`wiki:${q.wikiId}`],
    force: opts.force,
    run: () =>
      knowledgeApi.wiki.graph(q.wikiId, {
        community: q.community,
        limit: q.limit,
        offset: q.offset,
      }),
  });
}

export function fetchCodeStructure(
  q: { codeGraphId: string; kinds: string[]; limit?: number; offset?: number },
  opts: CacheCallOptions = {},
) {
  const key = cacheKey('code.structure', q.codeGraphId, [...q.kinds].sort().join('+'), q.limit, q.offset);
  return read({
    key,
    ttl: TTL.codeStructure,
    lane: 'read',
    tags: [`code:${q.codeGraphId}`],
    force: opts.force,
    run: () =>
      knowledgeApi.code.structure(q.codeGraphId, {
        kinds: q.kinds,
        edgeKinds: ['calls', 'imports', 'contains'],
        limit: q.limit,
        offset: q.offset,
      }),
  });
}

export function fetchSkillList(
  q: { teamId: string; agentId?: string; limit: number; offset: number },
  opts: CacheCallOptions = {},
) {
  const key = cacheKey('skills.list', q.teamId, q.agentId, q.limit, q.offset);
  return read({
    key,
    ttl: TTL.skillList,
    lane: 'read',
    tags: [`skills:team:${q.teamId}`, q.agentId ? `skills:agent:${q.agentId}` : 'skills:pool'],
    force: opts.force,
    run: () =>
      listSkills({
        team_id: q.teamId,
        ...(q.agentId ? { agent_id: q.agentId } : {}),
        pagination: { limit: q.limit, offset: q.offset },
      }),
  });
}

export interface RecallJournalQuery {
  teamId: string;
  agentId: string;
  page: number;
  pageSize: number;
  filter: 'all' | 'recall' | 'skipped';
}

export function fetchRecallJournal(q: RecallJournalQuery, opts: CacheCallOptions = {}) {
  const key = cacheKey('memory.journal', q.teamId, q.agentId, q.filter, q.pageSize, q.page);
  return read({
    key,
    ttl: TTL.memoryJournal,
    // 日志读是磁盘直读，走 read 泳道；与分层读（soul 泳道）互不抢占。
    lane: 'read',
    tags: [`memory:journal:${q.teamId}:${q.agentId}`],
    force: opts.force,
    run: () => chatMemoryApi.recallJournal(q.teamId, q.agentId, q.page, q.pageSize, q.filter),
  });
}

/** 记忆图谱：某条 L1 的邻接边（内核 l1_links）。按 seed 缓存，点击展开时才取。 */
export function fetchMemoryNeighbors(
  q: { blockId: string; id: string; types?: string[]; maxHop?: number; maxN?: number },
  opts: CacheCallOptions = {},
) {
  const key = cacheKey('memory.neighbors', q.blockId, q.id, [...(q.types ?? [])].sort().join('+'), q.maxHop, q.maxN);
  return read({
    key,
    // 邻接读是 BFS，比分层读轻但要连库；跟着「多久重问」走，正确性靠 memory:block 失效。
    ttl: TTL.memoryNeighbors,
    lane: 'soul',
    tags: [`memory:block:${q.blockId}`],
    force: opts.force,
    run: () =>
      chatMemoryApi.neighbors(q.blockId, q.id, {
        ...(q.types?.length ? { types: q.types } : {}),
        ...(q.maxHop != null ? { maxHop: q.maxHop } : {}),
        ...(q.maxN != null ? { maxN: q.maxN } : {}),
      }),
  });
}

/** 记忆图谱：两点最短关联链（内核 BFS path）。path=null 表示不可达，不是错误。 */
export function fetchAtomicPath(
  q: { blockId: string; startId: string; endId: string; maxHop?: number },
  opts: CacheCallOptions = {},
) {
  const key = cacheKey('memory.path', q.blockId, q.startId, q.endId, q.maxHop);
  return read({
    key,
    ttl: TTL.memoryNeighbors,
    lane: 'soul',
    tags: [`memory:block:${q.blockId}`],
    force: opts.force,
    run: () => chatMemoryApi.atomicPath(q.blockId, q.startId, q.endId, q.maxHop != null ? { maxHop: q.maxHop } : {}),
  });
}

/**
 * 写操作之后调用。tag 约定：
 *  - 分配/取消记忆、导入记忆块 → `memory:block:<blockId>`
 *  - 重建 wiki / code 资产       → `wiki:<wikiId>` / `code:<codeGraphId>`
 *  - fork / 导入 / 删技能        → `skills:agent:<agentId>` + `skills:team:<teamId>`
 */
export function invalidateStarmap(tags: string | string[]): number {
  return starmapStore.invalidate(tags);
}

export function clearStarmapCache(): void {
  starmapStore.clear();
}

/**
 * 按语义作用域整片失效（S4）。key 的第 3 段就是资源族名（`memory.layer`/`wiki.graph`/…），
 * 所以前缀失效天然对齐；团队与 agent 结构变化直接把整表清掉，因为 key 里的
 * team/agent 段本身就变了，留着只会被 LRU 慢慢淘汰，白占预算。
 */
export function invalidateScope(scope: MutationScope): number {
  if (scope === 'all' || scope === 'team' || scope === 'agents') {
    const n = starmapStore.snapshot().size;
    starmapStore.clear();
    return n;
  }
  return starmapStore.invalidatePrefix(`sc:${userScope || '-'}:${scope}`);
}

/** 写操作总线 → 缓存失效。api 层不认识缓存，反向依赖只在这里出现一次。 */
onMutation((scopes) => {
  for (const scope of scopes) invalidateScope(scope);
});
