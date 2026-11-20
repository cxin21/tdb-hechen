import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * apiCache 的验收口径：请求次数。
 * 这里 mock 掉三个 API 模块，只数调用；store 是真的（TTL/单飞/失效/清表都在真实现上跑）。
 */
const counts = {
  layer: 0,
  wiki: 0,
  code: 0,
  skills: 0,
  journal: 0,
  neighbors: 0,
  path: 0,
};

vi.mock('@/lib/api/chat-memory', () => ({
  chatMemoryApi: {
    layer: async (blockId: string, layer: string, limit: number, offset: number) => {
      counts.layer += 1;
      return { block_id: blockId, layer, limit, offset, items: [], total: 0 };
    },
    neighbors: async (_blockId: string, id: string) => {
      counts.neighbors += 1;
      return { id, neighbors: [{ id: id + '-n1', type: 'L1', strength: 0.5, hop: 1 }] };
    },
    atomicPath: async (_blockId: string, startId: string, endId: string) => {
      counts.path += 1;
      return { startId, endId, path: null };
    },
    recallJournal: async (
      teamId: string,
      agentId: string,
      page: number,
      pageSize: number,
      filter: string,
    ) => {
      counts.journal += 1;
      return {
        items: [],
        total: 0,
        page,
        page_size: pageSize,
        has_more: false,
        filter,
        counts: { all: 0, recall: 0, skipped: 0 },
        teamId,
        agentId,
      };
    },
  },
}));

vi.mock('@/lib/api/knowledge-api', () => ({
  knowledgeApi: {
    wiki: {
      graph: async (wikiId: string, query: { offset?: number }) => {
        counts.wiki += 1;
        return { wiki_id: wikiId, nodes: [], edges: [], total: 0, ...query };
      },
    },
    code: {
      structure: async (codeGraphId: string, query: { offset?: number }) => {
        counts.code += 1;
        return { code_graph_id: codeGraphId, nodes: [], edges: [], total: 0, ...query };
      },
    },
  },
}));

vi.mock('@/lib/api/skill-api', () => ({
  listSkills: async (req: { team_id: string; agent_id?: string; pagination: { limit: number; offset: number } }) => {
    counts.skills += 1;
    return { items: [], total: 0, ...req };
  },
}));

import { emitMutation } from '@/lib/api/mutation-bus';
import {
  fetchMemoryNeighbors,
  fetchAtomicPath,
  cacheKey,
  clearStarmapCache,
  fetchCodeStructure,
  fetchMemoryLayer,
  fetchRecallJournal,
  fetchSkillList,
  fetchWikiGraph,
  invalidateStarmap,
  setCacheUser,
  starmapStore,
} from '../apiCache';

const layer = (offset: number) =>
  fetchMemoryLayer({ blockId: 'blk-1', layer: 'L1', limit: 100, offset });

describe('apiCache', () => {
  beforeEach(() => {
    clearStarmapCache();
    setCacheUser('u1');
    counts.layer = 0;
    counts.wiki = 0;
    counts.code = 0;
    counts.skills = 0;
    counts.journal = 0;
    counts.neighbors = 0;
    counts.path = 0;
  });

  it('回放日志：同页同口径第二次命中，换页/换口径各打一次', async () => {
    const q = { teamId: 't1', agentId: 'a1', page: 1, pageSize: 20, filter: 'recall' as const };
    await fetchRecallJournal(q);
    await fetchRecallJournal(q);
    expect(counts.journal).toBe(1);
    await fetchRecallJournal({ ...q, page: 2 });
    await fetchRecallJournal({ ...q, filter: 'skipped' });
    expect(counts.journal).toBe(3);
    // 回到第 1 页仍然命中（分页窗口按 key 各留一份）
    await fetchRecallJournal(q);
    expect(counts.journal).toBe(3);
  });

  it('同 key 第二次命中缓存，不再打接口', async () => {
    const a = await layer(0);
    const b = await layer(0);
    expect(counts.layer).toBe(1);
    expect(a.data).toEqual(b.data);
  });

  it('offset 变化即不同 key，各自打一次', async () => {
    await layer(0);
    await layer(100);
    expect(counts.layer).toBe(2);
  });

  it('翻页 1→2→1：第三枪回到第 1 页命中缓存，总请求 2 次', async () => {
    await layer(0);
    await layer(100);
    await layer(0);
    expect(counts.layer).toBe(2);
  });

  it('失效标签命中后重打', async () => {
    await layer(0);
    expect(counts.layer).toBe(1);
    const removed = invalidateStarmap('memory:block:blk-1');
    expect(removed).toBeGreaterThan(0);
    await layer(0);
    expect(counts.layer).toBe(2);
  });

  it('失效别的块不影响本块', async () => {
    await layer(0);
    invalidateStarmap('memory:block:blk-other');
    await layer(0);
    expect(counts.layer).toBe(1);
  });

  it('换用户清空整表', async () => {
    await layer(0);
    setCacheUser('u2');
    await layer(0);
    expect(counts.layer).toBe(2);
  });

  it('同用户重复设置不清表', async () => {
    setCacheUser('u1');
    await layer(0);
    setCacheUser('u1');
    await layer(0);
    expect(counts.layer).toBe(1);
  });

  it('key 带用户前缀，空值统一为 -', () => {
    expect(cacheKey('a', 'b')).toBe('sc:u1:a:b');
    expect(cacheKey('a', undefined, '')).toBe('sc:u1:a:-:-');
  });

  it('wiki 与 code 各自独立缓存，失效只清自己的 tag', async () => {
    await fetchWikiGraph({ wikiId: 'w1', limit: 80, offset: 0 });
    await fetchWikiGraph({ wikiId: 'w1', limit: 80, offset: 0 });
    expect(counts.wiki).toBe(1);

    await fetchCodeStructure({ codeGraphId: 'c1', kinds: ['file'], limit: 80, offset: 0 });
    await fetchCodeStructure({ codeGraphId: 'c1', kinds: ['file'], limit: 80, offset: 0 });
    expect(counts.code).toBe(1);

    invalidateStarmap('wiki:w1');
    await fetchWikiGraph({ wikiId: 'w1', limit: 80, offset: 0 });
    await fetchCodeStructure({ codeGraphId: 'c1', kinds: ['file'], limit: 80, offset: 0 });
    expect(counts.wiki).toBe(2);
    expect(counts.code).toBe(1);
  });

  it('code 的 kinds 顺序不影响 key（排序后入键）', async () => {
    await fetchCodeStructure({ codeGraphId: 'c1', kinds: ['file', 'class'], limit: 80, offset: 0 });
    await fetchCodeStructure({ codeGraphId: 'c1', kinds: ['class', 'file'], limit: 80, offset: 0 });
    expect(counts.code).toBe(1);
  });

  /** S4：写操作总线 → 按作用域整片失效。断言口径仍是「请求次数」。 */
  it('总线按作用域失效：写记忆只刷记忆，不误伤知识面', async () => {
    await fetchMemoryLayer({ blockId: 'blk-1', layer: 'L1', limit: 100, offset: 0 });
    await fetchWikiGraph({ wikiId: 'w1', limit: 80, offset: 0 });
    await fetchCodeStructure({ codeGraphId: 'c1', kinds: ['file'], limit: 80, offset: 0 });
    expect([counts.layer, counts.wiki, counts.code]).toEqual([1, 1, 1]);

    emitMutation('memory');

    await fetchMemoryLayer({ blockId: 'blk-1', layer: 'L1', limit: 100, offset: 0 });
    await fetchWikiGraph({ wikiId: 'w1', limit: 80, offset: 0 });
    await fetchCodeStructure({ codeGraphId: 'c1', kinds: ['file'], limit: 80, offset: 0 });
    expect([counts.layer, counts.wiki, counts.code]).toEqual([2, 1, 1]);
  });

  it('团队/agent 结构变化（all）清整表', async () => {
    await fetchMemoryLayer({ blockId: 'blk-1', layer: 'L1', limit: 100, offset: 0 });
    await fetchWikiGraph({ wikiId: 'w1', limit: 80, offset: 0 });
    await fetchSkillList({ teamId: 't1', agentId: 'a1', limit: 100, offset: 0 });
    expect([counts.layer, counts.wiki, counts.skills]).toEqual([1, 1, 1]);

    emitMutation('all');

    await fetchMemoryLayer({ blockId: 'blk-1', layer: 'L1', limit: 100, offset: 0 });
    await fetchWikiGraph({ wikiId: 'w1', limit: 80, offset: 0 });
    await fetchSkillList({ teamId: 't1', agentId: 'a1', limit: 100, offset: 0 });
    expect([counts.layer, counts.wiki, counts.skills]).toEqual([2, 2, 2]);
  });

  it('人格写入（persona 作用域）只清人格面，不误伤记忆与知识', async () => {
    let personaCalls = 0;
    const loadPerson = () =>
      starmapStore.load(cacheKey('persona.person', 'a1', 'p1'), async () => {
        personaCalls += 1;
        return { key: 'p1' };
      }, { ttl: 60_000, lane: 'soul' });

    await loadPerson();
    await loadPerson();
    expect(personaCalls).toBe(1);

    emitMutation('persona');
    await loadPerson();
    expect(personaCalls).toBe(2);
  });

  it('技能：挂载范围与 offset 各自独立 key；团队失效清掉两种', async () => {
    await fetchSkillList({ teamId: 't1', agentId: 'a1', limit: 100, offset: 0 });
    await fetchSkillList({ teamId: 't1', limit: 100, offset: 0 });
    expect(counts.skills).toBe(2);

    invalidateStarmap(['skills:team:t1']);
    await fetchSkillList({ teamId: 't1', agentId: 'a1', limit: 100, offset: 0 });
    await fetchSkillList({ teamId: 't1', limit: 100, offset: 0 });
    expect(counts.skills).toBe(4);
  });

describe('记忆图谱资源（neighbors / path）', () => {
  it('同一颗星的邻居只取一次；换 seed 才重取', async () => {
    clearStarmapCache();
    setCacheUser('u1');
    const first = await fetchMemoryNeighbors({ blockId: 'b1', id: 'i1', maxHop: 2, maxN: 40 });
    const second = await fetchMemoryNeighbors({ blockId: 'b1', id: 'i1', maxHop: 2, maxN: 40 });
    expect(first.data?.neighbors).toHaveLength(1);
    expect(second.data?.neighbors).toHaveLength(1);
    expect(counts.neighbors).toBe(1);
    await fetchMemoryNeighbors({ blockId: 'b1', id: 'i2', maxHop: 2, maxN: 40 });
    expect(counts.neighbors).toBe(2);
  });

  it('记忆块失效会同时清掉邻居与关联链，别让图谱显示改前的边', async () => {
    clearStarmapCache();
    setCacheUser('u1');
    await fetchMemoryNeighbors({ blockId: 'b1', id: 'i1', maxHop: 2, maxN: 40 });
    await fetchAtomicPath({ blockId: 'b1', startId: 'i1', endId: 'i2', maxHop: 4 });
    expect(counts.neighbors).toBe(1);
    expect(counts.path).toBe(1);
    invalidateStarmap('memory:block:b1');
    await fetchMemoryNeighbors({ blockId: 'b1', id: 'i1', maxHop: 2, maxN: 40 });
    await fetchAtomicPath({ blockId: 'b1', startId: 'i1', endId: 'i2', maxHop: 4 });
    expect(counts.neighbors).toBe(2);
    expect(counts.path).toBe(2);
  });

  it('别的记忆块失效不误伤图谱', async () => {
    clearStarmapCache();
    setCacheUser('u1');
    await fetchMemoryNeighbors({ blockId: 'b1', id: 'i1', maxHop: 2, maxN: 40 });
    invalidateStarmap('memory:block:b9');
    await fetchMemoryNeighbors({ blockId: 'b1', id: 'i1', maxHop: 2, maxN: 40 });
    expect(counts.neighbors).toBe(1);
  });
});

});