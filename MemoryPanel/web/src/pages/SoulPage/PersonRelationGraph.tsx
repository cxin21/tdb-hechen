/**
 * PersonRelationGraph —— 人物关系图（纯 SVG，不引第三方图库）。
 *
 * 输入是 /api/v1/soul/persons 的 persons + edges：
 *   - 节点 = 已登记的人（实线圆），加上关系边里只有名字的对方（objKey 缺失 → 浅色虚线圆，
 *     不可点击，因为它还没有 person_key）。
 *   - 边方向按 direction：out 单箭头；mutual 两端箭头。
 *   - 生产首屏就是「有人、0 条边」：照样画节点，并在图下方写「还没有关系边」，
 *     不留一片空白 SVG。
 *
 * 只读：点节点只是切换右侧详情，不改任何数据。
 */
import { useMemo } from 'react';
import type { SoulPersonEdge, SoulPersonRow } from '@/lib/api/chat-memory-soul';

interface PersonRelationGraphProps {
  persons: SoulPersonRow[];
  edges: SoulPersonEdge[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

interface GraphNode {
  /** person_key，或 `name:<显示名>`（未登记的人）。 */
  id: string;
  label: string;
  registered: boolean;
}

const WIDTH = 680;
const HEIGHT = 400;
const NODE_R = 26;

function truncate(s: string, max = 7): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 未登记节点用名字做 id（同名的两侧合并成一个点，正是想要的效果）。 */
function unnamedId(name: string | null): string {
  return `name:${name ?? '（未登记）'}`;
}

export function PersonRelationGraph({
  persons,
  edges,
  selectedKey,
  onSelect,
}: PersonRelationGraphProps) {
  const { nodes, edgeViews } = useMemo(() => {
    const list: GraphNode[] = persons.map((p) => ({
      id: p.key,
      label: p.displayName,
      registered: true,
    }));
    const byId = new Map(list.map((n) => [n.id, n]));

    const views: Array<{
      edge: SoulPersonEdge;
      fromId: string;
      toId: string;
      dashed: boolean;
    }> = [];

    for (const edge of edges) {
      const toId = edge.objKey ?? unnamedId(edge.objName);
      const fromId = edge.subjKey;
      if (!byId.has(fromId) || !byId.has(toId)) {
        // 边指向了不在 persons 列表里的人：只可能是对方只有名字 —— 补一个浅色节点。
        if (!byId.has(toId)) {
          const node: GraphNode = {
            id: toId,
            label: edge.objName ?? '（未登记）',
            registered: false,
          };
          byId.set(toId, node);
          list.push(node);
        }
        if (!byId.has(fromId)) continue; // 起点缺失说明上游数据不完整，不硬画。
      }
      views.push({ edge, fromId, toId, dashed: edge.objKey === null });
    }

    return { nodes: list, edgeViews: views };
  }, [persons, edges]);

  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const radius = nodes.length <= 1 ? 0 : Math.min(140, 70 + nodes.length * 8);
  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    nodes.forEach((node, i) => {
      if (nodes.length === 1) {
        map.set(node.id, { x: cx, y: cy });
        return;
      }
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / nodes.length;
      map.set(node.id, {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      });
    });
    return map;
  }, [nodes, cx, cy, radius]);

  if (persons.length === 0) {
    return (
      <div className="_soul-empty">
        还没有登记的人。等有过对话、能从记忆里认出是谁之后，这里才会出现人物。
      </div>
    );
  }

  return (
    <div className="_soul-persongraph">
      <svg
        className="_soul-persongraph-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="人物关系图"
      >
        <defs>
          <marker
            id="_soul-arrow-out"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#86909c" />
          </marker>
          <marker
            id="_soul-arrow-unnamed"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#c2c6cc" />
          </marker>
        </defs>

        {edgeViews.map((view, i) => {
          const from = positions.get(view.fromId);
          const to = positions.get(view.toId);
          if (!from || !to) return null;
          // 连边略作弧线并交替偏向，双向关系不会完全重叠成一条线。
          const mx = (from.x + to.x) / 2;
          const my = (from.y + to.y) / 2;
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const len = Math.hypot(dx, dy) || 1;
          const bend = (i % 2 === 0 ? 1 : -1) * Math.min(18, len / 6);
          const ctrlX = mx + (-dy / len) * bend;
          const ctrlY = my + (dx / len) * bend;
          // 把弧线端点收到圆边，箭头才落在节点外侧而不是圆心（切线方向 = 控制点方向）。
          const pointToward = (
            node: { x: number; y: number },
            target: { x: number; y: number },
          ) => {
            const vx = target.x - node.x;
            const vy = target.y - node.y;
            const l = Math.hypot(vx, vy) || 1;
            return {
              x: node.x + (vx / l) * (NODE_R + 2),
              y: node.y + (vy / l) * (NODE_R + 2),
            };
          };
          const ctrl = { x: ctrlX, y: ctrlY };
          const a = pointToward(from, ctrl);
          const b = pointToward(to, ctrl);
          const path = `M ${a.x} ${a.y} Q ${ctrlX} ${ctrlY} ${b.x} ${b.y}`;
          const labelX = (a.x + 2 * ctrlX + b.x) / 4;
          const labelY = (a.y + 2 * ctrlY + b.y) / 4;
          return (
            <g key={view.edge.relId} className="_soul-persongraph-edge">
              <path
                d={path}
                fill="none"
                stroke={view.dashed ? '#c2c6cc' : '#86909c'}
                strokeWidth={1.4}
                strokeDasharray={view.dashed ? '5 4' : undefined}
                markerEnd={
                  view.dashed ? 'url(#_soul-arrow-unnamed)' : 'url(#_soul-arrow-out)'
                }
                markerStart={
                  view.edge.direction === 'mutual'
                    ? view.dashed
                      ? 'url(#_soul-arrow-unnamed)'
                      : 'url(#_soul-arrow-out)'
                    : undefined
                }
              />
              <text
                className="_soul-persongraph-edge-label"
                x={labelX}
                y={labelY - 4}
                textAnchor="middle"
              >
                {view.edge.pred}
              </text>
              <title>
                {view.edge.subjName ?? '某人'} → {view.edge.objName ?? '某人'}：
                {view.edge.pred}
              </title>
            </g>
          );
        })}

        {nodes.map((node) => {
          const p = positions.get(node.id);
          if (!p) return null;
          const selected = node.registered && node.id === selectedKey;
          return (
            <g
              key={node.id}
              className={[
                '_soul-persongraph-node',
                node.registered ? '_soul-persongraph-node--person' : '_soul-persongraph-node--unnamed',
                selected ? '_soul-persongraph-node--selected' : '',
                node.registered ? '_soul-persongraph-node--clickable' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={node.registered ? () => onSelect(node.id) : undefined}
              role={node.registered ? 'button' : undefined}
              tabIndex={node.registered ? 0 : undefined}
              onKeyDown={
                node.registered
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(node.id);
                      }
                    }
                  : undefined
              }
            >
              <title>{node.label}</title>
              <circle
                cx={p.x}
                cy={p.y}
                r={NODE_R}
                className="_soul-persongraph-circle"
              />
              <text className="_soul-persongraph-label" x={p.x} y={p.y + 4} textAnchor="middle">
                {truncate(node.label)}
              </text>
            </g>
          );
        })}
      </svg>
      {edgeViews.length === 0 ? (
        <div className="_soul-persongraph-note">
          还没有关系边。图里只有人：等对话里出现「谁和谁是什么关系」的依据之后，这里才会连线。
        </div>
      ) : (
        <div className="_soul-persongraph-legend">
          <span className="_soul-persongraph-legend-item">实线圆圈 = 已登记的人</span>
          <span className="_soul-persongraph-legend-item">虚线圆圈 = 只出现过名字的人</span>
          <span className="_soul-persongraph-legend-item">箭头 = 关系指向，两端都有 = 互相</span>
        </div>
      )}
    </div>
  );
}