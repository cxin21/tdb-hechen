/**
 * starmap/scene/CloudCanvas.tsx — 进入一朵云之后只画这一朵。
 *
 * 用户 m05333：「星云详情的展示也按照 https://enrichr.dev/elements/galaxy-spiral.html 的样式展示吧，
 * 这个应该能一模一样吧」。所以这里不再自创雾核/轨道/层壳，整块画布交给
 * `./spiralGalaxy`（参考实现的逐行移植：螺旋粒子数学 + 8 深度桶 + fillRect 方点 + 缓慢自转）。
 *
 * 三处必要差异（都在 spiralGalaxy.ts 的文件头写明）：
 *   1. 粒子位置由「实体 id 的 hash」当种子 —— 换页、重渲染都不跳位（参考实现每次重建是纯随机）；
 *   2. 颜色走调色板：忆云按层色、其余按云色；熄灭的星点统一用暗星色；
 *   3. 记录每颗星的投影坐标，点击才能命中实体（星尘不可点）。
 */
import { useEffect, useRef } from 'react';
import type { CloudKey } from '../data/overview';
import type { StarEdge, StarPoint } from './cloudPage';
import { buildGalaxy, drawGalaxy, pickGalaxy, type Galaxy } from './spiralGalaxy';

const CLOUD_COLOR: Record<CloudKey, string> = {
  memory: '#7fc8ff',
  wiki: '#9fe6c8',
  code: '#ffd479',
  skills: '#ff8fc7',
};

/* 忆云内按层上色：和全景同一套层色（L3 核心青、L2 场景橙、L1 原子蓝、L0 原文灰蓝）。 */
const LAYER_COLOR: Record<string, string> = {
  L3: '#9fe6c8',
  L2: '#ffb86b',
  L1: '#7fc8ff',
  L0: '#7f93bd',
};

/** 熄灭/未挂载的星点：与 --star-dim 同一档（对比度 4.38，不是不可见的黑）。 */
const DIM = '#66799b';

const CLOUD_ARMS: Record<CloudKey, number> = { memory: 3, wiki: 3, code: 2, skills: 3 };

export interface CloudPick {
  id: string;
  label: string;
  kind: string;
  detail: string;
  lit: boolean;
  related: { id: string; label: string; kind: string }[];
}

interface Props {
  cloud: CloudKey;
  points: StarPoint[];
  edges: StarEdge[];
  selectedId: string | null;
  onPick: (pick: CloudPick | null) => void;
  /** 该云真实总条数（只用来定星尘密度，不当作实体）。 */
  total?: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 星尘密度：按真实总条数开方。
 * 参考实现的默认盘是 688×320 / 5000 颗；我们进云后的画布约 1440×900，
 * 面积约 3 倍，同样的视觉密度就要约 3 倍粒子（这是「看着比参考稀疏」的唯一原因）。
 * 1.4 万条的忆云 ≈ 1.1 万颗，50 条的技艺云 ≈ 640 颗。
 */
export function dustFor(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(16000, Math.round(Math.sqrt(total) * 90));
}

function colorOf(cloud: CloudKey, p: StarPoint): string {
  if (cloud === 'memory') return LAYER_COLOR[p.kind] ?? CLOUD_COLOR.memory;
  return CLOUD_COLOR[cloud];
}

export default function CloudCanvas({ cloud, points, edges, selectedId, onPick, total }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const dataRef = useRef({ points, edges, selectedId });
  dataRef.current = { points, edges, selectedId };

  const galaxyRef = useRef<{ key: string; g: Galaxy } | null>(null);
  const viewRef = useRef({ rot: 0, tx: 0, ty: 0, ttx: 0, tty: 0 });
  const bgRef = useRef('#04060d');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const cs = getComputedStyle(parent);
    const bg = cs.getPropertyValue('--bg').trim();
    bgRef.current = bg || '#04060d';
    let raf = 0;
    let last = 0;
    const sizes = { w: 0, h: 0, dpr: 1 };
    const view = viewRef.current;
    view.rot = 0;
    view.tx = 0;
    view.ty = 0;
    view.ttx = 0;
    view.tty = 0;

    /* resize 必须幂等：给 canvas.width 赋任何值（哪怕同值）都会清空位图，
       而本函数还被 ResizeObserver 观测 —— 无条件赋值会每秒抹掉十几帧（P18 的真 bug）。 */
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, parent.clientWidth);
      const h = Math.max(1, parent.clientHeight);
      if (sizes.w === w && sizes.h === h && sizes.dpr === dpr) return;
      sizes.w = w;
      sizes.h = h;
      sizes.dpr = dpr;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);

    const draw = (now: number) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const { points: pts, selectedId: sel } = dataRef.current;
      const dust = dustFor(total ?? pts.length);
      const key = cloud + ':' + pts.length + ':' + pts.map((p) => (p.lit ? '1' : '0')).join('') + ':' + dust;
      /* 换页/换云才重建盘面；点星只换 selectedId，盘子原地不动。 */
      if (!galaxyRef.current || galaxyRef.current.key !== key) {
        galaxyRef.current = {
          key,
          g: buildGalaxy(
            pts.map((p) => ({ id: p.id, lit: p.lit, color: colorOf(cloud, p) })),
            { arms: CLOUD_ARMS[cloud], dust, accent: CLOUD_COLOR[cloud], dim: DIM, seed: hash(cloud) },
          ),
        };
      }
      const g = galaxyRef.current.g;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      view.rot += dt * 0.12 * 0.5;
      const k = Math.min(1, dt * 4);
      view.tx += (view.ttx - view.tx) * k;
      view.ty += (view.tty - view.ty) * k;

      const { w, h, dpr } = sizes;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawGalaxy(ctx, w, h, g, { rot: view.rot, tx: view.tx, ty: view.ty, tilt: 0.6 }, bgRef.current);
      /* 选中：只把这一颗画大一点，不额外加圆环/十字（参考实现里没有任何人造图形）。 */
      if (sel) {
        const i = g.items.findIndex((it) => it.id === sel);
        if (i >= 0) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#fbf8f1';
          const s = 5;
          ctx.fillRect(g.X[i] - s / 2, g.Y[i] - s / 2, s, s);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const r = canvas.getBoundingClientRect();
      view.ttx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2));
      view.tty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2));
    };
    const onLeave = () => {
      view.ttx = 0;
      view.tty = 0;
    };
    const onUp = (e: PointerEvent) => {
      const g = galaxyRef.current?.g;
      if (!g) return;
      const rect = canvas.getBoundingClientRect();
      const i = pickGalaxy(g, e.clientX - rect.left, e.clientY - rect.top, 12);
      if (i < 0) {
        onPickRef.current(null);
        return;
      }
      const star = g.items[g.entity[i]];
      if (!star) return;
      const src = dataRef.current.points.find((p) => p.id === star.id);
      const related: CloudPick['related'] = [];
      for (const edge of dataRef.current.edges) {
        const other = edge.source === star.id ? edge.target : edge.target === star.id ? edge.source : null;
        if (!other) continue;
        const n = dataRef.current.points.find((p) => p.id === other);
        if (!n) continue;
        related.push({ id: n.id, label: n.label, kind: edge.kind });
        if (related.length >= 12) break;
      }
      onPickRef.current({
        id: star.id,
        label: src?.label ?? star.id,
        kind: src?.kind ?? 'node',
        detail: src?.detail ?? '',
        lit: star.lit,
        related,
      });
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerup', onUp);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerup', onUp);
    };
  }, [cloud, total]);

  return <canvas ref={canvasRef} className="fb-canvas" data-testid="cloud-canvas" />;
}
