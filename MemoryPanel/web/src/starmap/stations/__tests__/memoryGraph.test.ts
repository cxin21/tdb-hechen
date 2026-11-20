import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 记忆图谱（G1）的验收口径：
 *  1. 边只能来自内核 l1_links / BFS path —— 不许面板自己编「同会话/疑似相关」的边；
 *  2. 换种子整图重置 —— 两颗种子的邻居混成一张就是假图；
 *  3. 关联链是两段式（先起点再终点），不是「点了就算」；
 *  4. 画布摆位是确定性的（没有 Math.random），同一条数据两次打开长得一样。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const stationDir = path.resolve(here, '..');
const sceneDir = path.resolve(stationDir, '../scene');

function read(rel: string): string {
  return fs.readFileSync(rel, 'utf8');
}

/** 注释里点名的反例不算违规（和 kit 的禁令测试同一口径）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const CACHE_DIR = path.resolve(stationDir, '../cache');
const PANEL = read(path.join(stationDir, 'MemoryGraphPanel.tsx'));
const USE_API_RESOURCE = read(path.join(CACHE_DIR, 'useApiResource.ts'));
const STATION = read(path.join(stationDir, 'MemoryStation.tsx'));
const CANVAS = read(path.join(sceneDir, 'RelGraphCanvas.tsx'));

describe('记忆图谱面板', () => {
  it('关系只走真实端点：neighbors + path，且经缓存层', () => {
    expect(PANEL).toContain('fetchMemoryNeighbors');
    expect(PANEL).toContain('fetchAtomicPath');
    // 直连 API 会绕过失效与泳道，这里必须走 cache
    expect(PANEL).not.toContain('chatMemoryApi.');
  });

  it('不编边：没有「同会话 / 疑似 / 推断」这类自造关系', () => {
    expect(stripComments(PANEL)).not.toMatch(/同会话|疑似|推断关联/);
    // 边的 kind 只允许从后端返回的 row.type 透传
    expect(PANEL).toMatch(/kind:\s*row\.type/);
  });

  it('换种子或换层整图重置', () => {
    expect(PANEL).toMatch(/\[blockId,\s*seed\?\.id,\s*seed\?\.layer\]/);
    expect(PANEL).toContain('setMerged({ nodes: new Map(), edges: new Map(), detail: new Map() })');
  });

  it('关联链是两段式：先起点再终点', () => {
    expect(PANEL).toContain('setPathStart');
    expect(PANEL).toContain('setPathEnd');
    // 起点已定、终点未定时点第二颗星才设终点
    expect(PANEL).toMatch(/else if \(id !== pathStart\) \{\s*setPathEnd\(id\);/);
  });

  // 回归：apiCache 的 fetch 自己已经走了一次 soul 泳道（并发上限 1）。
  // 再用 useResource 包一层 → 外层占槽、内层排队，loading 永远不结束（真实踩过）。
  it('soul 泳道上的取数不许再套 useResource（会自我死锁）', () => {
    expect(PANEL).toContain('useApiResource');
    expect(PANEL).not.toMatch(/useResource[<(]/);
    // 钩子只读缓存，不自己排队：出现 starmapStore.load( 就是又把泳道套了一层
    expect(USE_API_RESOURCE).toContain('starmapStore.peekAny');
    expect(stripComments(USE_API_RESOURCE)).not.toContain('starmapStore.load');
  });

  it('一进图谱就选中种子，右栏不是空的', () => {
    expect(PANEL).toContain('setSelectedId(seed?.id ?? null)');
  });

  it('节点数有上限，超了就说不展开而不是画成毛线团', () => {
    expect(PANEL).toContain('MAX_NODES');
    expect(PANEL).toMatch(/merged\.nodes\.size \+ rows\.length > MAX_NODES/);
  });
});

describe('记忆站接线', () => {
  it('第三档「记忆图谱」在分区条里，且渲染的是新面板', () => {
    expect(STATION).toContain("{ value: 'graph', label: '记忆图谱' }");
    expect(STATION).toContain('<MemoryGraphPanel');
    expect(STATION).toContain("from './MemoryGraphPanel'");
  });

  it('L0 没有可当种子的关系图：种子传 null，不拿原文画假图', () => {
    expect(STATION).toMatch(/layer === 'L0' \|\| !items\[0\]\s*\n?\s*\?\s*null/);
  });
});

describe('关系星图摆位', () => {
  it('确定性布局：没有随机数', () => {
    expect(CANVAS).not.toContain('Math.random');
    expect(CANVAS).toContain('2.399963229728653');
  });

  it('命中区不小于 12px（和 DESIGN.md 的星场命中口径一致）', () => {
    expect(CANVAS).toContain('const HIT_RADIUS = 12');
  });
});