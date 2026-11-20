/**
 * scene/dust.ts — 铺满整幅画布的淡星尘（云页与人格页共用）。
 *
 * 为什么单独一层：星云本体只占画布中间约 45%（焦距按 min(w,h) 定），窗口一宽四周就是死黑。
 * 星尘不属于任何一颗星、不参与命中与归属，只负责让「星场是背景」这件事在宽窗口下也成立。
 * 位置只取决于画布像素尺寸 —— 同一尺寸永远同一张底图，避免逐帧重随机导致整屏闪。
 */
function hashN(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 返回 [x, y, alpha] 三元组数组；点数随画布面积走，alpha 0.05–0.20。
 * density 只放大点数（人格页星云只占中间，需要更密的底图把四角填住），不改变位置分布规则。
 */
export function makeDust(w: number, h: number, density = 1): Float32Array {
  const n = Math.max(160, Math.round(((w * h) / 2600) * density));
  const out = new Float32Array(n * 3);
  let seed = hashN(Math.round(w * 7919 + h * 104729)) || 1;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < n; i += 1) {
    out[i * 3] = rnd() * w;
    out[i * 3 + 1] = rnd() * h;
    out[i * 3 + 2] = 0.05 + rnd() * 0.15;
  }
  return out;
}
