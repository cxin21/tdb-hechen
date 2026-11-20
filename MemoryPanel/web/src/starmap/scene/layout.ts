/**
 * starmap/scene/layout.ts — 五体星图的纯几何（无 DOM、无随机数）。
 *
 * 单位圆：半径 0..1，渲染时乘 viewport 的 min(w,h)/2。
 * 扇区：忆云占上半 (-180°..0°)，典籍 0..60、构筑 60..120、技艺 120..180（下半）。
 * 忆云四带：L3 最内、L0 最外（与内核分层一致）。
 */
import type { CloudKey, MemoryLayer } from '../data/overview';

export interface Pt {
  x: number;
  y: number;
}

export interface SectorDef {
  key: CloudKey;
  /** 起始角（度，SVG 坐标：0 = 正右，顺时针为正） */
  from: number;
  to: number;
  label: string;
}

export const SECTORS: SectorDef[] = [
  { key: 'memory', from: -180, to: 0, label: '记忆星云' },
  { key: 'wiki', from: 0, to: 60, label: '典籍星云' },
  { key: 'code', from: 60, to: 120, label: '构筑星云' },
  { key: 'skills', from: 120, to: 180, label: '技艺星云' },
];

export const CORE_R = 0.14;
export const CLOUD_INNER = 0.3;
export const CLOUD_OUTER = 0.72;
export const OUTER_RING = 0.78;

export const LAYER_ORDER: MemoryLayer[] = ['L3', 'L2', 'L1', 'L0'];

const GOLDEN = 137.508;

export function polar(r: number, deg: number): Pt {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad) * r, y: Math.sin(rad) * r };
}

export function sectorOf(key: CloudKey): SectorDef {
  const hit = SECTORS.find((s) => s.key === key);
  if (!hit) throw new Error(`unknown cloud: ${key}`);
  return hit;
}

/** 在扇区内均匀取 t∈[0,1)，再按黄金角加一点确定性抖动，避免排成一条直线。 */
export function pointInSector(key: CloudKey, t: number, radius: number, spread = 0): Pt {
  const s = sectorOf(key);
  const span = s.to - s.from;
  const deg = s.from + span * (t % 1) + spread;
  return polar(radius, deg);
}

/** 忆云四带的半径带：返回每层的 [inner, outer]。 */
export function bandRanges(count = LAYER_ORDER.length): Array<[number, number]> {
  const step = (CLOUD_OUTER - CLOUD_INNER) / Math.max(count, 1);
  return LAYER_ORDER.map((_, i) => [CLOUD_INNER + step * i, CLOUD_INNER + step * (i + 1)]);
}

export interface BandPoint extends Pt {
  layer: MemoryLayer;
  index: number;
  /** 该点代表的总条数（星点面积用） */
  total: number;
}

/**
 * 把某一层的 points 个星点铺在对应带上：先按环均匀，再按黄金角错位。
 * 点数 0 返回空数组；调用方自己决定空带的占位画法。
 */
export function layoutBand(layer: MemoryLayer, points: number, total: number): BandPoint[] {
  const idx = LAYER_ORDER.indexOf(layer);
  if (idx < 0) return [];
  const [inner, outer] = bandRanges()[idx];
  const radius = inner + (outer - inner) * 0.5;
  const out: BandPoint[] = [];
  for (let i = 0; i < points; i += 1) {
    // 上半圆：角度 -180..0；points 少时也要铺开，不堆在一点
    const t = points === 1 ? 0.5 : i / points;
    const deg = -180 + 180 * t;
    const jitter = ((i * GOLDEN) % 17) - 8;
    out.push({ ...polar(radius, deg + jitter * 0.35), layer, index: i, total });
  }
  return out;
}

/** 人格恒星的九块：绕核心一圈，absent 块也占位（画暗斑，不画实点）。 */
export function layoutPersonaBlocks(count: number, radius = CORE_R + 0.06): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < count; i += 1) {
    const deg = -90 + (360 / Math.max(count, 1)) * i;
    out.push(polar(radius, deg));
  }
  return out;
}

/** 外环刻度：按给定标签数均分，用于时间弧或团队可见暗星。 */
export function layoutOuter(count: number, radius = OUTER_RING): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < count; i += 1) {
    const deg = -180 + (360 / Math.max(count, 1)) * i;
    out.push(polar(radius, deg));
  }
  return out;
}
