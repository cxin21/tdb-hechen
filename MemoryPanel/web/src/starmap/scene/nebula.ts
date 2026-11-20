/**
 * starmap/scene/nebula.ts — 星云气团贴图（总览的「星云川」用）。
 *
 * 只用一张 128×128 的确定性贴图：径向衰减 × fbm 调制的 alpha。
 * 好处是「气」和「星」分开 —— 星点仍然是真实实体（一像素方点），
 * 气团只是低 alpha 的雾，不冒充星点（用户 m04975 只禁假星点）。
 */

/** 2D 值噪声：整数格点 hash + 平滑插值。 */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf;
}

export function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i += 1) {
    v += noise2(x * f, y * f, seed + i * 977) * amp;
    amp *= 0.5;
    f *= 2.07;
  }
  return v;
}

const cache = new Map<string, HTMLCanvasElement>();
export const NEBULA_SIZE = 128;

/**
 * 一块气团贴图：中心亮、边缘透，alpha 被 fbm 撕成丝状。
 * tint 决定色相（每朵云自己的主色）。
 */
export function nebulaSprite(tint: string, seed = 1): HTMLCanvasElement {
  const key = tint + '|' + seed;
  const hit = cache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = NEBULA_SIZE;
  cv.height = NEBULA_SIZE;
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  const rgb = [1, 3, 5].map((i) => parseInt(tint.replace('#', '').slice(i - 1, i + 1), 16));
  const img = ctx.createImageData(NEBULA_SIZE, NEBULA_SIZE);
  const half = NEBULA_SIZE / 2;
  for (let y = 0; y < NEBULA_SIZE; y += 1) {
    for (let x = 0; x < NEBULA_SIZE; x += 1) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const r = Math.hypot(dx, dy);
      if (r >= 1) continue;
      const fall = Math.pow(1 - r, 2.6);
      const n = fbm(x * 0.055, y * 0.055, seed);
      const a = Math.max(0, Math.min(1, fall * (0.15 + n * 0.72)));
      const at = (y * NEBULA_SIZE + x) * 4;
      img.data[at] = rgb[0];
      img.data[at + 1] = rgb[1];
      img.data[at + 2] = rgb[2];
      img.data[at + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  cache.set(key, cv);
  return cv;
}

/** 两个十六进制色的线性插值，用来让气带从一朵云过渡到下一朵云的颜色。 */
export function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.replace('#', '').slice(i - 1, i + 1), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.replace('#', '').slice(i - 1, i + 1), 16));
  const out = pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.max(0, Math.min(1, t))));
  return '#' + out.map((v) => v.toString(16).padStart(2, '0')).join('');
}
