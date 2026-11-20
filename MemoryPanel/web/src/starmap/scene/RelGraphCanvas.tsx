/**
 * starmap/scene/RelGraphCanvas.tsx — 关系星图（记忆图谱 / 任意「节点+边」关系图）
 *
 * 与 PersonaCanvas 的分工：那个画的是「人格恒星 + 属性」，固定四环；这个画的是
 * 任意关系图——按 hop 分环、边按 strength 淡出，点星换焦点。
 *
 * 为什么不用力导向：记忆邻接是「以某条为中心」的局部图，物理布局每次都要重新抖，
 * 同一条数据两次打开长得不一样，读图的人记不住。这里全部是确定性摆位：
 * 焦点在圆心，hop=1 一圈，hop=2 外一圈，角度按黄金角错开。
 */
import { useEffect, useRef } from 'react';

export interface RelNode {
  id: string;
  label: string;
  /** 分组（记忆里是 L0/L1/L2/L3，代码里是 file/class/function） */
  group?: string;
  /** 1 = 直接邻居，2 = 二跳；0/undefined = 焦点本身 */
  hop?: number;
  weight?: number;
  /** 0..1，边上用；节点用它调亮度 */
  strength?: number;
  lit?: boolean;
}

export interface RelEdge {
  source: string;
  target: string;
  kind?: string;
  strength?: number;
}

export interface RelGraphCanvasProps {
  nodes: RelNode[];
  edges: RelEdge[];
  focusId?: string | null;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** 画布高度由外部容器给，这里只吃 clientWidth/clientHeight */
  className?: string;
  emptyText?: string;
}

const GROUP_COLOR: Record<string, string> = {
  L0: '#7f93bd',
  L1: '#7fc8ff',
  L2: '#ffb86b',
  L3: '#9fe6c8',
  file: '#7fc8ff',
  class: '#9fe6c8',
  function: '#ffb86b',
  method: '#ffbe5c',
};

const FALLBACK_COLOR = '#9aa9c4';
const EDGE_RGB = '180,200,230';
const GOLDEN = 2.399963229728653;
const HIT_RADIUS = 12;

function groupColor(group: string | undefined): string {
  if (!group) return FALLBACK_COLOR;
  return GROUP_COLOR[group] ?? FALLBACK_COLOR;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

interface Placed {
  node: RelNode;
  x: number;
  y: number;
  r: number;
}

export default function RelGraphCanvas({
  nodes,
  edges,
  focusId,
  selectedId,
  onSelect,
  className,
  emptyText = '没有可画的关系',
}: RelGraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoomRef = useRef(1);
  const hoverRef = useRef<string | null>(null);
  const placedRef = useRef<Placed[]>([]);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const paintRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const paint = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (w === 0 || h === 0) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      if (nodes.length === 0) {
        ctx.fillStyle = '#66799b';
        ctx.font = '12px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(emptyText, w / 2, h / 2);
        placedRef.current = [];
        return;
      }

      const cx = w / 2;
      const cy = h / 2;
      const base = Math.min(w, h) * 0.34;
      const zoom = zoomRef.current;
      const focus = focusId ?? nodes[0]?.id ?? null;

      // 按 hop 分桶：焦点 0，其余 1/2/3…
      const buckets = new Map<number, RelNode[]>();
      for (const n of nodes) {
        const hop = n.id === focus ? 0 : Math.max(1, Math.min(3, n.hop ?? 1));
        const arr = buckets.get(hop) ?? [];
        arr.push(n);
        buckets.set(hop, arr);
      }

      const placed: Placed[] = [];
      for (const [hop, arr] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
        // 同一 hop 内先亮的、权重大的排前面，读图时先看到它们
        arr.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.id.localeCompare(b.id));
        if (hop === 0) {
          for (const n of arr) {
            placed.push({ node: n, x: cx, y: cy, r: 7 + Math.min(3, (n.weight ?? 0.4) * 4) });
          }
          continue;
        }
        const ring = base * hop * zoom * 0.62;
        arr.forEach((n, i) => {
          const angle = i * GOLDEN + hop * 0.7;
          placed.push({
            node: n,
            x: cx + Math.cos(angle) * ring,
            y: cy + Math.sin(angle) * ring,
            r: 3.2 + Math.min(2.6, (n.weight ?? 0.35) * 3.2) + (n.id === selectedId ? 1.6 : 0),
          });
        });
      }
      placedRef.current = placed;

      const pos = new Map(placed.map((p) => [p.node.id, p]));
      const hot = selectedId ?? hoverRef.current ?? focus;

      // 边：二次贝塞尔外弓 + 到中心线性淡出，避免全部穿心糊成一团
      for (const e of edges) {
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        if (!a || !b) continue;
        const related = e.source === hot || e.target === hot;
        const strength = Math.max(0.12, Math.min(1, e.strength ?? 0.5));
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const bow = Math.min(46, len * 0.16);
        const mx = (a.x + b.x) / 2 - (dy / len) * bow;
        const my = (a.y + b.y) / 2 + (dx / len) * bow;
        const alpha = related ? 0.16 + strength * 0.4 : 0.05 + strength * 0.09;
        ctx.strokeStyle = 'rgba(' + EDGE_RGB + ',' + alpha.toFixed(3) + ')';
        ctx.lineWidth = related ? 1.2 : 0.8;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx, my, b.x, b.y);
        ctx.stroke();
      }

      // 星点
      for (const p of placed) {
        const related = hot == null || p.node.id === hot;
        const color = groupColor(p.node.group);
        const dim = p.node.lit === false;
        ctx.globalAlpha = dim ? 0.42 : related ? 1 : 0.34;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        if (p.node.id === selectedId || p.node.id === focus) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // 文字：焦点、选中、悬停 + 每个环里最亮的一条，其余不写
      const labelled = new Set<string>();
      if (focus) labelled.add(focus);
      if (selectedId) labelled.add(selectedId);
      if (hoverRef.current) labelled.add(hoverRef.current);
      for (const [, arr] of buckets) {
        const top = arr[0];
        if (top) labelled.add(top.id);
      }
      ctx.font = '11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const p of placed) {
        if (!labelled.has(p.node.id)) continue;
        const strong = p.node.id === focus || p.node.id === selectedId || p.node.id === hoverRef.current;
        ctx.fillStyle = strong ? '#e8f1ff' : '#7b8db0';
        ctx.fillText(clip(p.node.label, 18), p.x, p.y + p.r + 5);
      }
    };
    paintRef.current = paint;

    const raf = requestAnimationFrame(paint);
    const ro = new ResizeObserver(() => paint());
    ro.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [nodes, edges, focusId, selectedId, emptyText]);

  /** 方向键在星点之间走：优先角度最接近按下的方向，其次距离最近。 */
  const step = (dx: number, dy: number): void => {
    const placed = placedRef.current;
    if (placed.length === 0 || !onSelect) return;
    const curId = selectedId ?? focusId ?? null;
    const from = placed.find((p) => p.node.id === curId) ?? null;
    if (!from) {
      const first = placed.find((p) => p.node.lit !== false) ?? placed[0];
      onSelect(first.node.id);
      return;
    }
    const len = Math.hypot(dx, dy) || 1;
    let best: Placed | null = null;
    let bestScore = Infinity;
    for (const p of placed) {
      if (p.node.id === from.node.id) continue;
      const vx = p.x - from.x;
      const vy = p.y - from.y;
      const d = Math.hypot(vx, vy);
      if (d < 1) continue;
      // 投影 < 0 表示在反方向；其余按角度偏离 + 距离加权
      const proj = (vx * dx + vy * dy) / (d * len);
      if (proj <= 0.2) continue;
      const off = 1 - proj;
      const score = off * 3 + d / 400;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) onSelect(best.node.id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>): void => {
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1, 0); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1, 0); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); step(0, 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); step(0, -1); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      const cur = selectedId ?? focusId ?? placedRef.current[0]?.node.id;
      if (cur && onSelect) { e.preventDefault(); onSelect(cur); }
    }
  };

  const hit = (clientX: number, clientY: number): Placed | null => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: Placed | null = null;
    let bestD = Infinity;
    for (const p of placedRef.current) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < Math.max(HIT_RADIUS, p.r + 6) && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  };

  return (
    <div ref={hostRef} className={className ?? 'rel-graph-host'}>
      <canvas
        ref={canvasRef}
        data-testid="rel-graph-canvas"
        role="application"
        tabIndex={0}
        aria-label={'关系星图，' + nodes.length + ' 个节点。方向键在星点之间移动，回车打开详情。'}
        onKeyDown={onKeyDown}
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onMouseMove={(e) => {
          const drag = dragRef.current;
          if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) drag.moved = true;
          const p = hit(e.clientX, e.clientY);
          const next = p?.node.id ?? null;
          if (next !== hoverRef.current) {
            hoverRef.current = next;
            paintRef.current();
          }
          e.currentTarget.style.cursor = p ? 'pointer' : 'crosshair';
        }}
        onMouseLeave={() => {
          dragRef.current = null;
          if (hoverRef.current) {
            hoverRef.current = null;
            paintRef.current();
          }
        }}
        onClick={(e) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (drag?.moved) return;
          const p = hit(e.clientX, e.clientY);
          if (p && onSelect) onSelect(p.node.id);
        }}
        onWheel={(e) => {
          // 画布是「看关系」的地方，滚轮缩放不滚动页面；缩放范围收窄，避免缩到看不见
          const next = Math.max(0.6, Math.min(2.2, zoomRef.current * (e.deltaY > 0 ? 0.94 : 1.06)));
          if (next === zoomRef.current) return;
          zoomRef.current = next;
          paintRef.current();
        }}
      />
    </div>
  );
}