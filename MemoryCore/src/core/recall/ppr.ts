/**
 * 引擎二 · PPR 全图扩散（DS-RECALL-V2-THREE-ENGINES-001 §E2.1 逐字采用）。
 *
 * 纯函数，零 IO：图数据由调用方从 l1_links 收集（种子可达子图 BFS，
 * 见 memory-search.ts / auto-recall.ts 集成处的等价性论证），本模块只做数学。
 *
 * 算法（E2.1 迭代公式）：
 *   r⁰ = p（种子分布起步，p_i = score_i / Σscores——相关性越高的命中扩散影响力越大）
 *   r^(t+1) = d · M · r^(t) + (1-d) · p
 *     M：列归一化转移矩阵（无向边权/度）；d = pprDamping（默认 0.85）
 *   收敛：max|r^(t+1) - r^(t)| < 1e-6 或 pprIterations 轮
 *
 * 正确性（报告前节 §0.1 论证摘要）：
 *   - M 列和为 1 → Σr ≡ 1（质量守恒，PPR 分跨图可比）；
 *   - 游走展开：r^(T)_v = Σ_种子 p_s · Σ_{s→v 长度≤T 游走} d^{|W|}·Π(边权/度)
 *     ——多跳按几何衰减自动发生，一步计算覆盖 A→B→C 链；
 *   - 压缩映射（d<1）→ 几何收敛；迭代顺序固定、无随机项 → 同图同种子逐位同结果。
 *
 * 输出评分（E2.1）：非种子节点按 PPR 分降序取前 pprTopK；
 *   pprNorm_i = ppr_i / maxPprNonSeed ∈ (0,1]——调用方乘 maxHitScore × graphDiscount
 *   得候选分，非种子天花板恰为 maxHitScore × graphDiscount（折扣语义保持：图候选恒低于命中）。
 *
 * 复杂度（E2.2）：稀疏 Map 邻接表 + pprIterations × 边数 ≈ 万级运算，微秒级；零 LLM 调用。
 */

/** 一条无向语义边（调用方已做租户过滤与 graphMinStrength 门槛）。 */
export interface PPREdge {
  src: string;
  tgt: string;
  /** 边权 strength ∈ (0,1]（l1_links.strength）。 */
  strength: number;
  /** 边型（causal/evolve/similar/…），供主导边类型标注。 */
  kind: string;
}

export interface PPROpts {
  /** 阻尼系数 d（默认 0.85；0 = r 恒等于 p，无非种子质量 = 通道退化关断）。 */
  damping?: number;
  /** 非种子候选上限（默认 10；≤0 = 零输出）。 */
  topK?: number;
  /** 最大迭代轮数（默认 30；游走展开式下长度 > 迭代数的游走贡献恒零）。 */
  maxIterations?: number;
}

export interface PPRDetail {
  /** 非种子节点 → pprNorm（= ppr / 非种子最大值；按 PPR 降序，已截 topK）。 */
  pprNorm: Map<string, number>;
  /** 非种子节点 → 主导边类型（该节点入池贡献最大的边类型，取自累积扩散量）。 */
  kinds: Map<string, string>;
}

/** 边型优先序（R-A2 同款：causal/evolve 优先）——主导边类型并列时的确定性 tiebreak。 */
export const pprKindRank = (kind: string): number => (kind === "causal" ? 0 : kind === "evolve" ? 1 : 2);

/** PPR 默认参数（E2.1：damping 0.85 / topK 10 / 迭代 30）。 */
export const PPR_DEFAULTS = { damping: 0.85, topK: 10, maxIterations: 30 } as const;
/** E2.1 收敛阈值（固定，不可配置——确定性纪律）。 */
const PPR_EPSILON = 1e-6;

/**
 * 无向化邻接表（E2.1：遍历按无向——记忆关联在召回语义上对称，双向各记一条同权边）。
 * - 自环丢弃（对 PPR 质量无贡献：质量流回自身不改变分布形状）；
 * - 并行边（同节点对同型）由调用方去重后传入，此处按 (对端, kind) 再去重一次（防御）；
 * - 邻接表按 (对端 id, kind) 排序——消除边收集顺序对迭代求和顺序的影响（确定性纪律）；
 * - 度 = 无向关联边权和（列归一化分母）。
 */
export function buildAdjacency(edges: PPREdge[]): {
  adj: Map<string, Array<{ node: string; weight: number; kind: string }>>;
  deg: Map<string, number>;
} {
  const adj = new Map<string, Array<{ node: string; weight: number; kind: string }>>();
  const deg = new Map<string, number>();
  const addOne = (u: string, v: string, w: number, kind: string): void => {
    let list = adj.get(u);
    if (!list) { list = []; adj.set(u, list); }
    if (list.some((e) => e.node === v && e.kind === kind)) return; // 防御性去重
    list.push({ node: v, weight: w, kind });
    deg.set(u, (deg.get(u) ?? 0) + w);
  };
  for (const e of edges) {
    if (!(e.strength > 0) || !e.src || !e.tgt || e.src === e.tgt) continue;
    addOne(e.src, e.tgt, e.strength, e.kind);
    addOne(e.tgt, e.src, e.strength, e.kind);
  }
  for (const list of adj.values()) {
    list.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : pprKindRank(a.kind) - pprKindRank(b.kind) || (a.kind < b.kind ? -1 : 1)));
  }
  return { adj, deg };
}

/**
 * PPR 核心迭代（单次实现，runPPR/runPPRDetail 共用——两排序点单一源消费）。
 * 返回最终分布 r 与"逐节点逐边型累积扩散量"（主导边类型依据，E2.1 输出评分段）。
 */
function pprCore(
  seeds: Map<string, number>,
  edges: PPREdge[],
  opts: Required<Pick<PPROpts, "damping" | "maxIterations">>,
): { r: Map<string, number>; kindInflow: Map<string, Map<string, number>> } {
  const { adj, deg } = buildAdjacency(edges);
  // 种子归一化（E2.1）：p_i = score_i / Σscores；负/非法权重按 0 计（防御，宁缺毋滥）。
  let sum = 0;
  for (const w of seeds.values()) sum += w > 0 && Number.isFinite(w) ? w : 0;
  const p = new Map<string, number>();
  if (sum > 0) {
    for (const [id, w] of seeds) {
      const wi = w > 0 && Number.isFinite(w) ? w : 0;
      if (wi > 0) p.set(id, wi / sum);
    }
  }
  const r = new Map<string, number>(p); // r⁰ = p
  const kindInflow = new Map<string, Map<string, number>>();
  if (p.size === 0 || adj.size === 0) return { r, kindInflow };

  const d = opts.damping;
  for (let t = 0; t < opts.maxIterations; t++) {
    const next = new Map<string, number>();
    // 扩散分量：d · M · r（稀疏实现——只沿有质量的节点外推）
    for (const [u, ru] of r) {
      if (!(ru > 0)) continue;
      const du = deg.get(u);
      const outs = adj.get(u);
      if (!du || !outs) continue;
      for (const e of outs) {
        const mass = d * ru * (e.weight / du);
        next.set(e.node, (next.get(e.node) ?? 0) + mass);
        // 累积扩散量（按边型）：主导边类型 = 该节点累计 received 质量最大的边型
        let byKind = kindInflow.get(e.node);
        if (!byKind) { byKind = new Map<string, number>(); kindInflow.set(e.node, byKind); }
        byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + mass);
      }
    }
    // 传送分量：(1-d) · p（只回种子——个性化项）
    for (const [s, ps] of p) next.set(s, (next.get(s) ?? 0) + (1 - d) * ps);
    // 收敛判定：max|r^(t+1) - r^(t)| < 1e-6
    let delta = 0;
    for (const [id, v] of next) {
      const diff = Math.abs(v - (r.get(id) ?? 0));
      if (diff > delta) delta = diff;
    }
    for (const [id, v] of r) {
      if (!next.has(id)) {
        const diff = Math.abs(v);
        if (diff > delta) delta = diff;
      }
    }
    r.clear();
    for (const [id, v] of next) r.set(id, v);
    if (delta < PPR_EPSILON) break;
  }
  return { r, kindInflow };
}

/**
 * runPPR（plan Interfaces 契约）：seeds（id→score，内部归一化）+ 无向边集 →
 * 非种子节点 pprNorm Map（按 PPR 降序、topK 截断）。
 * 空图 / 无种子 / Σscore≤0 / damping=0 → 空 Map（E2.4 失败安全：零图候选）。
 */
export function runPPR(seeds: Map<string, number>, edges: PPREdge[], opts: PPROpts = {}): Map<string, number> {
  return runPPRDetail(seeds, edges, opts).pprNorm;
}

/**
 * runPPRDetail：runPPR + 主导边类型标注（一次迭代同时产出，保证两者来自同一分布）。
 * 主导边类型 = 该节点累积 received 质量最大的边型；并列时 causal < evolve < 其余，
 * 再按字典序（全序确定性，关断矩阵的确定性前提）。
 */
export function runPPRDetail(seeds: Map<string, number>, edges: PPREdge[], opts: PPROpts = {}): PPRDetail {
  const damping = typeof opts.damping === "number" && Number.isFinite(opts.damping)
    ? Math.min(Math.max(opts.damping, 0), 1)
    : PPR_DEFAULTS.damping;
  const topK = Number.isFinite(opts.topK) ? Math.max(0, Math.floor(opts.topK as number)) : PPR_DEFAULTS.topK;
  const maxIterations = Number.isFinite(opts.maxIterations)
    ? Math.max(1, Math.floor(opts.maxIterations as number))
    : PPR_DEFAULTS.maxIterations;

  const { r, kindInflow } = pprCore(seeds, edges, { damping, maxIterations });

  // 非种子集合（种子已是命中集，不重复入候选池）
  const nonSeeds: Array<{ id: string; ppr: number }> = [];
  let maxNonSeed = 0;
  for (const [id, v] of r) {
    if (seeds.has(id) || !(v > 0)) continue;
    nonSeeds.push({ id, ppr: v });
    if (v > maxNonSeed) maxNonSeed = v;
  }
  if (maxNonSeed <= 0 || topK <= 0) return { pprNorm: new Map(), kinds: new Map() };

  nonSeeds.sort((a, b) => b.ppr - a.ppr || (a.id < b.id ? -1 : 1)); // PPR 降序 + id 确定性 tiebreak
  const pprNorm = new Map<string, number>();
  const kinds = new Map<string, string>();
  for (const { id, ppr } of nonSeeds.slice(0, topK)) {
    pprNorm.set(id, ppr / maxNonSeed);
    let bestKind = "related";
    let bestMass = -1;
    const byKind = kindInflow.get(id);
    if (byKind) {
      for (const [kind, mass] of byKind) {
        if (mass > bestMass || (mass === bestMass && (pprKindRank(kind) < pprKindRank(bestKind) ||
            (pprKindRank(kind) === pprKindRank(bestKind) && kind < bestKind)))) {
          bestKind = kind;
          bestMass = mass;
        }
      }
    }
    kinds.set(id, bestKind);
  }
  return { pprNorm, kinds };
}
