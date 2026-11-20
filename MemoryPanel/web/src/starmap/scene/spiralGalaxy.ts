/**
 * starmap/scene/spiralGalaxy.ts — 单朵星云的银河盘渲染器。
 *
 * 逐行移植 https://enrichr.dev/js/lib/galaxy-spiral.js（用户 m05333 要求「一模一样」），
 * 只做三处必要改造：
 *   1. 粒子不再由 `rnd(7)` 顺序生成，而是「每个实体用自己的 hash 当种子」——同一颗星点
 *      在两次渲染、换一页数据之后都落在同一位置（参考实现每次 `build()` 是纯随机）；
 *   2. 色带从固定 4 档（COLS + accent）推广成「调色板索引」——忆云的四层色、
 *      典籍/构筑的每库一色才能各自上色，几何与 alpha 规则一字未改；
 *   3. 记录每颗星上一帧的投影坐标 X/Y 与对应的实体下标，供点击命中（参考实现不可交互）。
 *
 * 其余全部照抄：粒子公式、8 个深度桶、alpha = 0.18 + depth * 0.82、
 * 尺寸 = (0.7 + depth * 1.1) * P.s、R = min(W,H) * 0.46、f = 1 / (1.6 - z3 * 0.9)、
 * tiltX = 1.0 + ty * 0.7 * tilt、核心径向渐变（stop 0 / 0.4 / 1）。
 */

export interface GalaxyItem {
  id: string;
  /** 点亮时的颜色（层色 / 库色 / 云色）。 */
  color: string;
  lit: boolean;
}

export interface GalaxyOptions {
  /** 旋臂数，参考实现 2–5。 */
  arms: number;
  /** 星尘颗数（不含实体）。按真实条数算出来的密度，不可点。 */
  dust?: number;
  /** 主色：色带 index 1 之外，还用于核球渐变。 */
  accent: string;
  /** 熄灭星点的颜色。 */
  dim: string;
  seed: number;
}

export interface Galaxy {
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  size: Float32Array;
  /** 调色板下标。 */
  color: Uint8Array;
  /** 粒子 → 实体下标，-1 表示星尘。 */
  entity: Int32Array;
  /** 上一帧投影坐标（CSS px），命中检测用。 */
  X: Float32Array;
  Y: Float32Array;
  palette: string[];
  accent: string;
  dim: string;
  /** 核球渐变中间档。参考实现是 accent 压暗后的绿，这里按云色推导，可显式覆盖。 */
  coreMid?: string;
  /** 核球渐变外档（alpha 为 0，但渐变按非预乘插值时颜色仍会影响边缘）。 */
  coreEnd?: string;
  items: GalaxyItem[];
}

export const NB = 8;

/** 参考实现的 LCG。 */
function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** 把实体色向「核球白」或「背景」混合，得到参考实现那四档明暗。 */
function mix(hex: string, toward: string, t: number): string {
  const a = hexRgb(hex);
  const b = hexRgb(toward);
  const c = [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
  return '#' + c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

const CORE_WHITE = '#fbf8f1';
const BAND_BG = '#04060d';
/** 四档明暗：band0 核球白、band1 实体色、band2/3 逐步压向背景。 */
export function toneOf(color: string, band: number): string {
  if (band === 0) return mix(color, CORE_WHITE, 0.68);
  if (band === 1) return color;
  if (band === 2) return mix(color, BAND_BG, 0.42);
  return mix(color, BAND_BG, 0.68);
}

function rgbCss(rgb: [number, number, number], a: number): string {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

/**
 * 参考实现的粒子公式，返回盘面坐标、尺寸、半径与色带下标。
 * 色带 `band` 就是参考实现的 `P.c`：核心偏亮白、旋臂偏实体色、外缘压暗 ——
 * 这是它看起来有「核球 → 旋臂」明暗层次的关键，缺了就是一片同色噪点。
 */
export function spiralParticle(rand: () => number, arms: number): { x: number; y: number; z: number; size: number; rad: number; band: number } {
  const rad = Math.pow(rand(), 1.5) * 0.95 + 0.02;
  const arm = Math.floor(rand() * arms);
  let ang = (arm * Math.PI * 2) / arms + rad * 5.2;
  const spread = (rand() + rand() + rand() - 1.5) * 0.45;
  ang += spread * (rad + 0.25);
  const core = rad < 0.14;
  const q = core ? rand() * Math.PI * 2 : ang;
  const rr = core ? rad * (0.5 + rand()) : rad + (rand() - 0.5) * 0.04;
  const z = (rand() + rand() - 1) * (core ? 0.15 : 0.04) * (1.2 - rad);
  const size = 0.5 + rand() * rand() * 1.6;
  const cr = rand();
  const band = rad < 0.22 ? (cr < 0.6 ? 0 : 1) : rad < 0.55 ? (cr < 0.25 ? 0 : cr < 0.6 ? 1 : 2) : cr < 0.12 ? 1 : cr < 0.45 ? 2 : 3;
  return { x: Math.cos(q) * rr, y: Math.sin(q) * rr, z, size, rad, band };
}

/** 建盘：实体 + 星尘，位置全部来自参考公式。 */
export function buildGalaxy(items: GalaxyItem[], opts: GalaxyOptions): Galaxy {
  const palette: string[] = [];
  const idxOf = (color: string): number => {
    const at = palette.indexOf(color);
    if (at >= 0) return at;
    palette.push(color);
    return palette.length - 1;
  };
  const toneIdx = (color: string, band: number): number => idxOf(toneOf(color, band));
  const accentIdx = idxOf(opts.accent);
  const real = items.length;
  const dust = Math.max(0, Math.round(opts.dust ?? 0));
  const n = real + dust;
  const g: Galaxy = {
    n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    size: new Float32Array(n),
    color: new Uint8Array(n),
    entity: new Int32Array(n),
    X: new Float32Array(n),
    Y: new Float32Array(n),
    palette,
    accent: opts.accent,
    dim: opts.dim,
    items,
  };
  const arms = Math.max(2, Math.min(5, Math.round(opts.arms)));
  for (let i = 0; i < n; i += 1) {
    const isDust = i >= real;
    const seed = isDust
      ? (opts.seed ^ Math.imul(i - real + 1, 0x9e3779b9)) >>> 0
      : (opts.seed ^ hashStr(items[i].id)) >>> 0;
    const p = spiralParticle(rnd(seed), arms);
    g.x[i] = p.x;
    g.y[i] = p.y;
    g.z[i] = p.z;
    g.size[i] = p.size;
    /* 星尘用云自己的颜色走同一套明暗（否则盘面核心是黑的，参考实现的核球亮度就丢了）；
       熄灭的真星点仍用暗星色，保证「暗 = 未挂载」这条语义没被星尘冲掉。 */
    const base = isDust ? opts.accent : items[i].lit ? items[i].color : opts.dim;
    g.color[i] = toneIdx(base, p.band);
    g.entity[i] = isDust ? -1 : i;
  }
  void accentIdx;
  return g;
}

export interface GalaxyView {
  /** 盘面自转角。 */
  rot: number;
  /** 指针 X 视差（-1..1）。 */
  tx: number;
  /** 指针 Y 视差（-1..1）。 */
  ty: number;
  /** 参考实现的 tilt 参数（0..1）。 */
  tilt: number;
}

/**
 * 画一帧。返回 false 表示这一帧没画（调用方不必再清屏）。
 * 与参考实现逐项对应：底色铺满 → 核球径向渐变 → 8 个深度桶 → fillRect 方点。
 */
export function drawGalaxy(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  g: Galaxy,
  view: GalaxyView,
  background: string,
): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.46;
  const accentRgb = hexRgb(g.accent);
  const coreMid = g.coreMid ?? mix(g.accent, background, 0.62);
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.55);
  core.addColorStop(0, rgbCss(accentRgb, 0.26));
  core.addColorStop(0.4, rgbCss(hexRgb(coreMid), 0.18));
  core.addColorStop(1, rgbCss(hexRgb(g.coreEnd ?? mix(g.accent, background, 0.86)), 0));
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, w, h);

  const tiltX = 1.0 + view.ty * 0.7 * view.tilt;
  const cs = Math.cos(view.rot);
  const sn = Math.sin(view.rot);
  const ct = Math.cos(tiltX);
  const st = Math.sin(tiltX);
  const yaw = view.tx * 0.5 * view.tilt;
  const cyaw = Math.cos(yaw);
  const syaw = Math.sin(yaw);
  const span = 0.9;
  const nc = g.palette.length;
  const buckets: number[][] = [];
  for (let b = 0; b < NB * nc; b += 1) buckets.push([]);
  for (let i = 0; i < g.n; i += 1) {
    const x = g.x[i] * cs - g.y[i] * sn;
    const y = g.x[i] * sn + g.y[i] * cs;
    const z = g.z[i];
    const y2 = y * ct - z * st;
    const z2 = y * st + z * ct;
    const x3 = x * cyaw + z2 * syaw;
    const z3 = -x * syaw + z2 * cyaw;
    const f = 1 / (1.6 - z3 * 0.9);
    g.X[i] = cx + x3 * R * f * 1.6;
    g.Y[i] = cy + y2 * R * f * 1.6;
    const d = Math.max(0, Math.min(0.999, (z3 + span) / (2 * span)));
    buckets[Math.floor(d * NB) * nc + g.color[i]].push(i);
  }
  for (let db = 0; db < NB; db += 1) {
    const depth = (db + 0.5) / NB;
    ctx.globalAlpha = 0.18 + depth * 0.82;
    const sz = 0.7 + depth * 1.1;
    for (let c = 0; c < nc; c += 1) {
      const list = buckets[db * nc + c];
      if (!list.length) continue;
      ctx.fillStyle = g.palette[c];
      for (let j = 0; j < list.length; j += 1) {
        const m = list[j];
        const s = sz * g.size[m];
        ctx.fillRect(g.X[m] - s / 2, g.Y[m] - s / 2, s, s);
      }
    }
  }
  ctx.globalAlpha = 1;
}

/** 命中：最近的实体星点（星尘不参与）。 */
export function pickGalaxy(g: Galaxy, px: number, py: number, radius = 12): number {
  let best = -1;
  let bestD = radius;
  for (let i = 0; i < g.n; i += 1) {
    if (g.entity[i] < 0) continue;
    const d = Math.hypot(g.X[i] - px, g.Y[i] - py);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}
