/**
 * starmap/stations/MemoryGraphPanel.tsx — 记忆图谱（旧 ChatMemoryPage 的「图谱」档，补 G1）
 *
 * 数据只走真实关系：内核 /v3/atomic/neighbors（l1_links 边）与 /v3/atomic/path（BFS 关联链）。
 * 不做假边：拿不到邻居就是一颗孤星，宁可空也不画「疑似关联」。
 *
 * 交互：
 *  - 点星 = 换焦点并展开它的邻居（合并进同一张图，边会跟着长出来）
 *  - 「关联链」两段式：先点起点再点终点 → 走 path，不可达直接说不可达
 *  - 右栏是当前星点的正文与属性；正文只读，改记忆请回「记忆块」档
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, KvList, Note, Skeleton, Surface, Tag } from '../kit';
import RelGraphCanvas, { type RelEdge, type RelNode } from '../scene/RelGraphCanvas';
import { cacheKey, fetchAtomicPath, fetchMemoryNeighbors, useApiResource } from '../cache';
import { errorText } from '../theme/ui';

interface NeighborRow {
  id: string;
  type?: string;
  strength?: number;
  hop?: number;
  content?: string;
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
}

export interface MemoryGraphSeed {
  id: string;
  label: string;
  layer?: string;
}

export interface MemoryGraphPanelProps {
  blockId: string;
  seed: MemoryGraphSeed | null;
}

const MAX_NODES = 80;

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

function labelOf(row: NeighborRow, fallback: string): string {
  const text = (row.content ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 28 ? text.slice(0, 27) + '…' : text;
  return fallback + ' · ' + shortId(row.id);
}

export default function MemoryGraphPanel({ blockId, seed }: MemoryGraphPanelProps) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [merged, setMerged] = useState<{ nodes: Map<string, RelNode>; edges: Map<string, RelEdge>; detail: Map<string, NeighborRow> }>(
    () => ({ nodes: new Map(), edges: new Map(), detail: new Map() }),
  );
  const [err, setErr] = useState<string | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [pathMode, setPathMode] = useState(false);
  const [pathStart, setPathStart] = useState<string | null>(null);
  const [pathEnd, setPathEnd] = useState<string | null>(null);

  // 种子换人（换块 / 换层 / 换选中条目）就整图重置，避免两颗种子的邻居混成一张假图
  useEffect(() => {
    setMerged({ nodes: new Map(), edges: new Map(), detail: new Map() });
    setFocusId(seed?.id ?? null);
    // 一进来就把种子选中：右栏立刻有内容，不用先点一下才知道这是什么。
    setSelectedId(seed?.id ?? null);
    setErr(null);
    setPathStart(null);
    setPathEnd(null);
    setPathMode(false);
  }, [blockId, seed?.id, seed?.layer]);

  // 必须用 useApiResource，不能套 useResource：fetchMemoryNeighbors 自己已经走了一次
  // soul 泳道（并发上限 1），再包一层会「外层占槽、内层排队」，loading 永远不结束。
  const seedReq = useApiResource<{ id: string; neighbors: NeighborRow[] }>({
    key: seed ? cacheKey('memory.neighbors', blockId, seed.id, '', 2, 40) : null,
    run: (o) => fetchMemoryNeighbors({ blockId, id: seed!.id, maxHop: 2, maxN: 40 }, { force: o.force }),
    enabled: Boolean(blockId && seed),
  });

  // 把一次邻居响应并进图里（首次是种子，之后是点击展开）
  const absorb = useCallback(
    (center: MemoryGraphSeed, rows: NeighborRow[]) => {
      setMerged((prev) => {
        const nodes = new Map(prev.nodes);
        const edges = new Map(prev.edges);
        const detail = new Map(prev.detail);
        if (!nodes.has(center.id)) {
          nodes.set(center.id, { id: center.id, label: center.label, group: center.layer, hop: 0, lit: true, weight: 1 });
        }
        for (const row of rows) {
          if (!nodes.has(row.id)) {
            nodes.set(row.id, {
              id: row.id,
              label: labelOf(row, row.type ?? '记忆'),
              group: row.type,
              hop: Math.max(1, Math.min(3, row.hop ?? 1)),
              weight: Math.max(0.2, Math.min(1, row.strength ?? 0.5)),
              strength: row.strength,
              lit: true,
            });
          }
          detail.set(row.id, row);
          const key = center.id < row.id ? center.id + '>' + row.id : row.id + '>' + center.id;
          if (!edges.has(key)) {
            edges.set(key, {
              source: center.id,
              target: row.id,
              kind: row.type,
              strength: row.strength ?? 0.4,
            });
          }
        }
        return { nodes, edges, detail };
      });
    },
    [],
  );

  useEffect(() => {
    if (!seed || !seedReq.data) return;
    absorb(seed, seedReq.data.neighbors ?? []);
  }, [seed, seedReq.data, absorb]);

  const expand = useCallback(
    async (id: string) => {
      if (expanding) return;
      const node = merged.nodes.get(id);
      if (!node) return;
      setFocusId(id);
      setExpanding(true);
      setErr(null);
      try {
        const res = await fetchMemoryNeighbors({ blockId, id, maxHop: 1, maxN: 24 });
        if (res.error && !res.data) throw res.error;
        const rows = (res.data?.neighbors ?? []) as NeighborRow[];
        // 上限：再加就成毛线团，宁可让用户点着走
        if (merged.nodes.size + rows.length > MAX_NODES) {
          setErr('这颗星的邻居会把图撑到 ' + (merged.nodes.size + rows.length) + ' 个节点（上限 ' + MAX_NODES + '），先重置再看别的方向。');
          return;
        }
        absorb({ id, label: node.label, layer: node.group }, rows);
      } catch (e) {
        setErr(errorText(e));
      } finally {
        setExpanding(false);
      }
    },
    [absorb, blockId, expanding, merged.nodes],
  );

  const pathReq = useApiResource<{ startId: string; endId: string; path: Array<{ id: string; type: string; strength: number; hop: number }> | null }>({
    key: pathStart && pathEnd ? cacheKey('memory.path', blockId, pathStart, pathEnd, 4) : null,
    run: (o) => fetchAtomicPath({ blockId, startId: pathStart!, endId: pathEnd!, maxHop: 4 }, { force: o.force }),
    enabled: Boolean(blockId && pathStart && pathEnd && pathStart !== pathEnd),
  });

  const pathIds = useMemo(() => {
    const ids = new Set<string>();
    for (const step of pathReq.data?.path ?? []) ids.add(step.id);
    return ids;
  }, [pathReq.data]);

  const nodes = useMemo(() => [...merged.nodes.values()], [merged.nodes]);
  const edges = useMemo(() => [...merged.edges.values()], [merged.edges]);
  const selected = selectedId ? merged.nodes.get(selectedId) ?? null : null;
  const selectedRow = selectedId ? merged.detail.get(selectedId) ?? null : null;

  const onSelect = (id: string) => {
    if (pathMode) {
      setSelectedId(id);
      if (!pathStart || (pathStart && pathEnd)) {
        setPathStart(id);
        setPathEnd(null);
      } else if (id !== pathStart) {
        setPathEnd(id);
      }
      return;
    }
    setSelectedId(id);
    if (id !== seed?.id) {
      setFocusId(id);
      void expand(id);
    }
  };

  if (!blockId) {
    return <Empty title="还没有选中记忆块" hint="左侧选一个记忆块，图谱才有种子。" />;
  }
  if (!seed) {
    return <Empty title="这一层还没有可当种子的条目" hint="先切到 L1 / L2 / L3，图谱以具体一条记忆为中心。" />;
  }

  return (
    <div className="stk-graph-wrap" data-testid="memory-graph">
      <div className="stk-graph-bar">
        <span className="stk-graph-seed">
          种子：{seed.label}
          <span className="stk-meta"> · {merged.nodes.size} 个节点 / {merged.edges.size} 条边</span>
        </span>
        <div className="stk-row-actions">
          <button
            type="button"
            className={'stk-btn is-sm' + (pathMode ? '' : ' is-ghost')}
            aria-pressed={pathMode}
            onClick={() => {
              setPathMode((v) => !v);
              setPathStart(null);
              setPathEnd(null);
            }}
          >
            关联链
          </button>
          <button
            type="button"
            className="stk-btn is-sm is-ghost"
            onClick={() => {
              setMerged({ nodes: new Map(), edges: new Map(), detail: new Map() });
              setFocusId(seed.id);
              setSelectedId(seed.id);
              setPathStart(null);
              setPathEnd(null);
              setErr(null);
              void seedReq.reload();
            }}
          >
            重置
          </button>
        </div>
      </div>

      {pathMode ? (
        <Note>
          {!pathStart
            ? '点第一颗星作为起点（再点一次退出关联链）。'
            : !pathEnd
              ? '起点已定，点终点星。'
              : pathReq.data?.path === null
                ? '两点之间在 4 跳内不可达（内核返回 path=null）。'
                : null}
          {pathIds.size > 0 ? <span className="stk-meta"> · 链路 {pathIds.size} 个节点</span> : null}
        </Note>
      ) : null}

      {seedReq.loading && merged.nodes.size === 0 ? <Skeleton rows={6} /> : null}
      {err ? <Note tone="warn">{err}</Note> : null}

      <div className="stk-graph-body">
        <div className="stk-graph-canvas">
          <RelGraphCanvas
            nodes={nodes}
            edges={edges}
            focusId={focusId}
            selectedId={selectedId}
            onSelect={onSelect}
            className="rel-graph-host stk-graph-host"
            emptyText={seedReq.loading ? '正在取邻居…' : '这条记忆没有邻居（内核返回空）'}
          />
        </div>
        <Surface dense as="aside" title="星点详情" className="stk-graph-side">
          {!selected ? (
            <Empty title="点一颗星" hint="点星会以它为新焦点展开邻居；右栏给正文与属性。" />
          ) : (
            <>
              <div className="stk-graph-title">{selected.label}</div>
              <KvList
                items={[
                  { k: '层级', v: selected.group ?? '—' },
                  { k: '跳数', v: selected.hop === 0 ? '种子' : String(selected.hop ?? '—') },
                  { k: '强度', v: selectedRow?.strength != null ? selectedRow.strength.toFixed(2) : '—' },
                  { k: '类型', v: selectedRow?.type ?? '—' },
                  { k: '确定性', v: selectedRow?.certainty ?? '—' },
                  { k: '发生', v: selectedRow?.occurred_at ?? selectedRow?.valid_start ?? '—' },
                  { k: '节点', v: shortId(selected.id), mono: true },
                ]}
              />
              <div className="stk-row-actions">
                <button type="button" className="stk-btn is-sm is-ghost" onClick={() => void expand(selected.id)} disabled={expanding}>
                  {expanding ? '展开中…' : '展开它的邻居'}
                </button>
                <Tag>{pathIds.has(selected.id) ? '在关联链上' : pathMode ? '选终点' : '可当起点'}</Tag>
              </div>
              {selectedRow?.content ? <pre className="stk-pre">{selectedRow.content}</pre> : null}
              {selected.lit === false ? <Note tone="warn">这颗星是暗的（已失效或未点亮）。</Note> : null}
            </>
          )}
        </Surface>
      </div>
    </div>
  );
}