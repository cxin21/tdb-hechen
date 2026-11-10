/**
 * starmap/engine/geometry.ts — 三维投影、布局与噪声。
 * 纯函数，无 DOM 依赖，便于单测。
 */

export type Vec3 = { x: number; y: number; z: number };

export interface MapNode {
  id: string;
  label: string;
  /** 图层：L0 原文 / L1 记忆 / L2 日目录 / L3 结论 / person 人物 / day 日期 */
  kind: 'L0' | 'L1' | 'L2' | 'L3' | 'person' | 'day';
  region: number;
  /** 显著性 0..1，决定光点大小与亮度 */
  weight: number;
  day?: string;
  full?: string;
  /** 原始记录时间（用于排序/详情） */
  at?: string;
}

export interface MapLink {
  a: number;
  b: number;
  /** 0..1 关系强度 */
  weight: number;
  kind: 'session' | 'person' | 'ref';
}

export interface StarPoint extends Vec3 {
  r: number;
  phase: number;
  alpha: number;
}

export const KIND_COLOR: Record<MapNode['kind'], string> = {
  L0: '#7f93bd',
  L1: '#7fc8ff',
  L2: '#ffb86b',
  L3: '#9fe6c8',
  person: '#ff8fc7',
  day: '#ffd479',
};

/** 六锚点方位（与旧脑区概念同构，但只决定排布不决定语义） */
export const REGION_ANCHORS: Vec3[] = [
  { x: 0, y: 0, z: 0 },
  { x: 1, y: 0.35, z: 0.2 },
  { x: -0.85, y: 0.55, z: -0.3 },
  { x: 0.35, y: -0.9, z: 0.55 },
  { x: -0.5, y: -0.45, z: 0.8 },
  { x: 0.75, y: -0.15, z: -0.9 },
];

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** 费波那契球均匀撒点，落在 region 锚点附近的一个壳层上 */
export function layoutNodes(nodes: MapNode[]): Vec3[] {
  const out: Vec3[] = [];
  const byRegion = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    const arr = byRegion.get(n.region) ?? [];
    arr.push(i);
    byRegion.set(n.region, arr);
  });
  for (const [region, idxs] of byRegion) {
    const anchor = REGION_ANCHORS[region % REGION_ANCHORS.length];
    const total = idxs.length;
    idxs.forEach((nodeIdx, k) => {
      // 球面均匀分布
      const t = total === 1 ? 0.5 : (k + 0.5) / total;
      const y = 1 - 2 * t;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = GOLDEN * k;
      const shell = 0.62 + 0.5 * ((k * 7919) % 100) / 100; // 0.62..1.12 壳层抖动
      out[nodeIdx] = {
        x: anchor.x * 0.85 + Math.cos(theta) * r * shell,
        y: anchor.y * 0.85 + y * shell * 0.92,
        z: anchor.z * 0.85 + Math.sin(theta) * r * shell,
      };
    });
  }
  return out;
}

/** 绕 Y/X 轴旋转 */
export function rotate(p: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x1 = p.x * cy - p.z * sy;
  const z1 = p.x * sy + p.z * cy;
  const y1 = p.y * cp - z1 * sp;
  const z2 = p.y * sp + z1 * cp;
  return { x: x1, y: y1, z: z2 };
}

export interface Projected {
  x: number;
  y: number;
  /** 透视缩放，越近越大 */
  scale: number;
  depth: number;
  visible: boolean;
}

/** 透视投影：focal 越大越接近正交 */
export function project(p: Vec3, w: number, h: number, focal: number): Projected {
  const camZ = 3.6;
  const denom = camZ - p.z;
  const safe = denom < 0.25 ? 0.25 : denom;
  const scale = focal / safe;
  return {
    x: w / 2 + p.x * scale,
    y: h / 2 + p.y * scale,
    scale: scale / focal,
    depth: p.z,
    visible: denom > 0.25,
  };
}

/* ---------- 值噪声（星云用） ---------- */
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

export function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

export function fbm(x: number, y: number, octaves = 4): number {
  let sum = 0, amp = 0.5, fx = x, fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(fx, fy);
    fx *= 2.03;
    fy *= 1.97;
    amp *= 0.5;
  }
  return sum;
}

/** 确定性伪随机（同一种子同一点位，避免每次重排抖动） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 撒一层固定星尘 */
export function makeDust(count: number, seed: number, spread = 1.55): StarPoint[] {
  const rnd = mulberry32(seed);
  const out: StarPoint[] = [];
  for (let i = 0; i < count; i++) {
    const theta = rnd() * Math.PI * 2;
    const phi = Math.acos(2 * rnd() - 1);
    const r = spread * (0.4 + 0.6 * rnd());
    out.push({
      x: Math.sin(phi) * Math.cos(theta) * r,
      y: Math.cos(phi) * r * 0.62,
      z: Math.sin(phi) * Math.sin(theta) * r,
      r: 0.4 + rnd() * 1.1,
      phase: rnd() * Math.PI * 2,
      alpha: 0.18 + rnd() * 0.55,
    });
  }
  return out;
}

/** 旋臂碎星：对数螺线 */
export function makeArms(arms: number, perArm: number, seed: number): StarPoint[] {
  const rnd = mulberry32(seed);
  const out: StarPoint[] = [];
  for (let a = 0; a < arms; a++) {
    const base = (a / arms) * Math.PI * 2;
    for (let i = 0; i < perArm; i++) {
      const t = i / perArm;
      const radius = 0.5 + t * 1.85;
      const angle = base + t * 2.5 + (rnd() - 0.5) * 0.34;
      const jitter = 1 + (rnd() - 0.5) * 0.14;
      out.push({
        x: Math.cos(angle) * radius * jitter,
        y: (rnd() - 0.5) * 0.16 * (1.2 - t),
        z: Math.sin(angle) * radius * jitter,
        r: 0.35 + rnd() * 0.9,
        phase: rnd() * Math.PI * 2,
        alpha: (0.1 + rnd() * 0.4) * (1 - t * 0.55),
      });
    }
  }
  return out;
}
