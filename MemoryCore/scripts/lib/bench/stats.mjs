/**
 * bench 统计共享件（bench-compare / summarize-bench 单一源）。
 * mulberry32 与 bench-manifest 同源；bootstrap=percentile 法；McNemar=精确双侧二项。
 */
export function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** 配对 bootstrap 95% CI（percentile 法）。 */
export function pairedBootstrap(deltas, { iters = 10000, seed = 20261027 } = {}) {
  const rnd = mulberry32(seed);
  const n = deltas.length;
  const means = new Array(iters);
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[(rnd() * n) | 0];
    means[it] = s / n;
  }
  means.sort((x, y) => x - y);
  const q = (p) => means[Math.min(iters - 1, Math.max(0, Math.round(p * (iters - 1))))];
  return { lo: q(0.025), hi: q(0.975) };
}

/** McNemar 精确检验：discordant 对 (b,c)，双侧二项 p。 */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, p: 1 };
  const k = Math.min(b, c);
  let cum = 0;
  let comb = 1;
  const pk = Math.pow(0.5, n);
  for (let i = 0; i <= k; i++) {
    if (i > 0) comb = (comb * (n - i + 1)) / i;
    cum += comb * pk;
  }
  return { b, c, p: Math.min(1, 2 * cum) };
}

export const pct = (x) => (x == null ? "n/a" : (x * 100).toFixed(1) + "%");
export const pp = (x) => (x == null ? "n/a" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "pp");
