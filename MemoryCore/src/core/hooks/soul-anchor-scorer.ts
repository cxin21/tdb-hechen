/**
 * #42（ADR0003-P3 实施票 D / D9）：情境锚相似度打分器——确定性 cosine，不上 LLM 打分。
 * D9 边界：embedder/queryEmbedding 缺席 → []（不造分，宁缺毋滥）；缓存键=desc 原文精确键
 * （弃 hash 键——键错=静默错分，宁用原文；cap 100 FIFO 镜像 soul-assembler SOUL_CACHE_MAX）。
 * shadow-first：本模块零行为面——选择/报告语义由调用方（soul-assembler）决定。
 */
/** vec：锚 desc 向量（scoreAnchorRows 产出时随行携带，MMR 选择复用——零额外 embed 成本）。 */
export type AnchorScoredRow = { row: string; score: number; vec?: Float32Array };
export type AnchorEmbedder = (text: string) => Promise<Float32Array>;

/** 锚向量缓存：键=锚 desc 原文（精确匹配，不哈希），值=嵌入向量。FIFO cap 100。 */
const anchorVectorCache = new Map<string, Float32Array>();
const ANCHOR_VECTOR_CACHE_MAX = 100;

/** #42：单测重置缓存（同 resetCoreTenantCachesForTest 先例）。 */
export function resetAnchorVectorCacheForTest(): void {
  anchorVectorCache.clear();
  anchorVectorInflight.clear();
}

/** 同文本并发 embed 去重：生产里一次 recall 内 scoreAnchorRows 与跨段抑制
 *  （soul-dedupe suppressAnchorOverlapRows）会请求同一批 desc 向量——不合并则
 *  同一文本重复付费（E2E 实证：冷进程 soul 段 12s，正是串行+重复 embed 风暴
 *  还挤占了 L1 的 embedding 队列）。in-flight Map 合并并发请求；失败不缓存。 */
const anchorVectorInflight = new Map<string, Promise<Float32Array | null>>();

/** 带缓存/并发合并的锚文本嵌入。返回 null=本次嵌入失败（不缓存失败结果，下次重试）。
 *  缓存合同沿 #42：键=desc 原文精确匹配；cap 100 FIFO；**假定进程内单 embedder**
 *  （与 #42 缓存既有合同一致；多 embedder 场景由调用方自行隔离）。 */
export async function embedAnchorCached(
  embedder: AnchorEmbedder,
  text: string,
): Promise<Float32Array | null> {
  const cached = anchorVectorCache.get(text);
  if (cached) return cached;
  const inflight = anchorVectorInflight.get(text);
  if (inflight) return inflight;
  const p = (async (): Promise<Float32Array | null> => {
    try {
      const vec = await embedder(text);
      if (!(vec instanceof Float32Array) || vec.length === 0) return null;
      anchorVectorCache.set(text, vec);
      while (anchorVectorCache.size > ANCHOR_VECTOR_CACHE_MAX) {
        const oldest = anchorVectorCache.keys().next();
        if (oldest.done) break;
        anchorVectorCache.delete(oldest.value);
      }
      return vec;
    } catch {
      return null;
    }
  })();
  anchorVectorInflight.set(text, p);
  try {
    return await p;
  } finally {
    anchorVectorInflight.delete(text);
  }
}

/** cosine 相似度纯函数：维数不匹配或零范数 → 0（宁缺毋滥，不抛错不猜）。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** #42 审查加固（I-4）：查询向量可用门——长度 0 或零范数的退化向量过 truthy 门会导致
 *  threshold>0 时全锚滤除（价值锚行整行消失=身份段数据损失面）。调用方把不可用向量视同
 *  「向量缺席」处理（回退现状+告警），不进入打分。 */
export function isUsableQueryVec(qv: Float32Array | null | undefined): qv is Float32Array {
  if (!qv || qv.length === 0) return false;
  let sq = 0;
  for (let i = 0; i < qv.length; i++) sq += qv[i] * qv[i];
  return sq > 0;
}

/** #52 D3 选项C（仅裁剪时重排）的裁剪触发门：调用方传 maxRows，rows.length > maxRows 即发生裁剪。 */
export interface ScoreAnchorRowsOpts {
  /** 裁剪触发门（候选行数上限）：仅 rows.length > maxRows 时按 score desc 重排；不传=无裁剪门=不重排。 */
  maxRows?: number;
  /** 锚 desc 并行预嵌的**软预算**（ms；0/缺省=不限=逐位现状）：超时抛错回退调用方声明序。
   *  E2E 实证（2026-10-19）：冷进程首召回 20 锚并行 embed 仍可能 ~3s（ark 并发受限），叠加
   *  expand 帽后顶穿 /v3/recall 5000ms 预算→504；本预算保 cold 请求能落地（降级=声明序锚行），
   *  in-flight embed **继续落缓存**，下一请求即享完整 MMR 质量。函数级缺省 0（单测零行为变化），
   *  生产默认由 config anchorSelect.scorer.embedBudgetMs（1200）注入。 */
  embedBudgetMs?: number;
}

/** 批量打分：rows 取 desc 向量（embedAnchorCached：缓存命中/并发合并零重复 embed；
 *  缺失的唯一 desc **并行**预嵌——E2E 实证串行 20 锚 × ark RTT 是冷进程 soul 段 12s 主因），
 *  score=cosine(query, vec)。任一 desc 嵌入失败 → 整体抛错（调用方回退全锚行，
 *  与旧「embedder 抛错即回退」合同一致——不造分不猜，宁缺毋滥）。
 *  #52 D3 选项C（仅裁剪时重排）：rows.length > opts.maxRows（发生裁剪）才按 score desc
 *  （并列保声明序）决定保留集与顺序；rows.length ≤ maxRows 或未传 maxRows（无裁剪门）→
 *  不重排，保持入参声明序（调用方以 value_id 稳定序喂入），分数照常计算可报告。
 *  embedder/queryEmbedding 缺席或 rows 空 → []。 */
export async function scoreAnchorRows(
  rows: ReadonlyArray<{ row: string; desc: string }>,
  queryEmbedding: Float32Array | null | undefined,
  embedder?: AnchorEmbedder | null,
  opts?: ScoreAnchorRowsOpts,
): Promise<AnchorScoredRow[]> {
  if (!embedder || !queryEmbedding || rows.length === 0) return [];
  const uniqueTexts = [...new Set(rows.map((r) => r.desc))];
  const budgetMs = opts?.embedBudgetMs ?? 0;
  let embedded: (Float32Array | null)[];
  if (budgetMs > 0) {
    // 软预算：整体 race 一个 deadline timer（unref 不拦进程退出）；超时抛错回退调用方——
    // in-flight embedAnchorCached 不取消（Promise 无取消语义），完成后自动落缓存供下一请求复用。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs);
      (timer as { unref?: () => void } | undefined)?.unref?.();
    });
    const raced: (Float32Array | null)[] | null = await Promise.race([
      Promise.all(uniqueTexts.map((t) => embedAnchorCached(embedder, t))),
      deadline,
    ]);
    clearTimeout(timer);
    if (raced === null) {
      throw new Error(
        `[soul-anchor-scorer] anchor embed budget exceeded (${budgetMs}ms, ${uniqueTexts.length} descs) — fallback to declaration order`,
      );
    }
    embedded = raced;
  } else {
    embedded = await Promise.all(uniqueTexts.map((t) => embedAnchorCached(embedder, t)));
  }
  const vecByText = new Map<string, Float32Array>();
  uniqueTexts.forEach((t, i) => {
    const v = embedded[i];
    if (v === null) {
      throw new Error(`[soul-anchor-scorer] anchor embed failed for desc: ${t.slice(0, 24)}`);
    }
    vecByText.set(t, v);
  });
  const withIdx = rows.map((r, idx) => ({ r, idx }));
  const scored: Array<AnchorScoredRow & { idx: number }> = withIdx.map(({ r, idx }) => ({
    row: r.row,
    score: cosineSimilarity(queryEmbedding, vecByText.get(r.desc)!),
    idx,
    vec: vecByText.get(r.desc)!,
  }));
  // 选项C：仅发生裁剪（rows > maxRows）时重排；未裁剪时输出序=声明序（不抖动 value_id 稳定序）。
  const trimTriggered = opts?.maxRows !== undefined && rows.length > opts.maxRows;
  const keepVec = (s: (typeof scored)[number]): AnchorScoredRow => ({ row: s.row, score: s.score, vec: s.vec });
  if (!trimTriggered) return scored.map(keepVec);
  return scored.sort((a, b) => b.score - a.score || a.idx - b.idx).map(keepVec);
}

/** 转正选择纯函数：threshold 硬门（score ≥ threshold，含等号——M-2 回归锁钉死；0=仅滤负相关
 *  （cosine<0 不注入），>0=硬门——M-3 注释语义对齐）+ top-K（K=maxRows，缺省=不过滤）。
 *  maxRows≤0 → []。#52 D3 选项C：输入=scoreAnchorRows 输出（仅裁剪时 desc，未裁剪时=声明序）
 *  → 输出保输入序（过滤/截取不改序）。 */
export function selectAnchorRows(
  scored: ReadonlyArray<AnchorScoredRow>,
  cfg: { maxRows?: number; threshold?: number } = {},
): AnchorScoredRow[] {
  const maxRows = cfg.maxRows ?? scored.length;
  if (maxRows <= 0) return [];
  const threshold = cfg.threshold ?? 0;
  return scored.filter((s) => s.score >= threshold).slice(0, maxRows);
}

/**
 * MMR（Maximal Marginal Relevance）多样性选择——灵魂注入质量轮 2026-10-19（渲染端去扎堆）：
 * 生产实拍价值锚块「取证」族 6 锚同质扎堆（近义锚被纯 cosine top-K 一起选中），调研正解
 * （docs/research/2026-10-19-soul-rendering-survey-2025-2026.md §MMR）= 检索端多样性：
 *   val(c) = λ·rel(c,query) − (1−λ)·max_{s∈selected} sim(c,s)
 * 贪心逐个选取；λ=0.7（经典缺省，config anchorSelect.scorer.mmrLambda 可调，0=退化为纯 top-K）。
 * 阈值语义与 selectAnchorRows 一致（score ≥ threshold）；触发门与 #52 D3 选项C 同款：
 * 仅 pool.length > maxRows（发生裁剪）时 MMR 选择，未裁剪=声明序原样（不抖动 value_id 稳定序）。
 * 向量缺席行（vec 非 Float32Array）不进 MMR 池（宁缺毋滥不猜相似度）。
 * 并列取先声明者（严格大于才替换——与 sort 稳定序 tie-break 同语义）。
 */
export function selectAnchorRowsMmr(
  scored: ReadonlyArray<AnchorScoredRow>,
  cfg: { maxRows?: number; threshold?: number; lambda?: number } = {},
): AnchorScoredRow[] {
  const maxRows = cfg.maxRows ?? scored.length;
  if (maxRows <= 0) return [];
  const threshold = cfg.threshold ?? 0;
  const pool = scored.filter((s) => s.score >= threshold && s.vec instanceof Float32Array);
  if (pool.length <= maxRows) return pool.map(({ row, score }) => ({ row, score }));
  const lambda = cfg.lambda ?? 0.7;
  const remaining = pool.slice();
  const picked: Float32Array[] = [];
  const out: AnchorScoredRow[] = [];
  while (out.length < maxRows && remaining.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      let maxSim = -1;
      for (const pv of picked) {
        const sim = cosineSimilarity(c.vec as Float32Array, pv);
        if (sim > maxSim) maxSim = sim;
      }
      const val = lambda * c.score - (1 - lambda) * Math.max(0, maxSim);
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    const [chosen] = remaining.splice(bestIdx, 1);
    picked.push(chosen.vec as Float32Array);
    out.push({ row: chosen.row, score: chosen.score });
  }
  return out;
}
