/**
 * #42（ADR0003-P3 实施票 D / D9）：情境锚相似度打分器——确定性 cosine，不上 LLM 打分。
 * D9 边界：embedder/queryEmbedding 缺席 → []（不造分，宁缺毋滥）；缓存键=desc 原文精确键
 * （弃 hash 键——键错=静默错分，宁用原文；cap 100 FIFO 镜像 soul-assembler SOUL_CACHE_MAX）。
 * shadow-first：本模块零行为面——选择/报告语义由调用方（soul-assembler）决定。
 */
export type AnchorScoredRow = { row: string; score: number };
export type AnchorEmbedder = (text: string) => Promise<Float32Array>;

/** 锚向量缓存：键=锚 desc 原文（精确匹配，不哈希），值=嵌入向量。FIFO cap 100。 */
const anchorVectorCache = new Map<string, Float32Array>();
const ANCHOR_VECTOR_CACHE_MAX = 100;

/** #42：单测重置缓存（同 resetCoreTenantCachesForTest 先例）。 */
export function resetAnchorVectorCacheForTest(): void {
  anchorVectorCache.clear();
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
}

/** 批量打分：rows 逐条取 desc 向量（缓存命中零 embed），score=cosine(query, vec)。
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
  const withIdx = rows.map((r, idx) => ({ r, idx }));
  const scored: Array<AnchorScoredRow & { idx: number }> = [];
  for (const { r, idx } of withIdx) {
    let vec = anchorVectorCache.get(r.desc);
    if (!vec) {
      vec = await embedder(r.desc);
      anchorVectorCache.set(r.desc, vec);
      while (anchorVectorCache.size > ANCHOR_VECTOR_CACHE_MAX) {
        const oldest = anchorVectorCache.keys().next();
        if (oldest.done) break;
        anchorVectorCache.delete(oldest.value);
      }
    }
    scored.push({ row: r.row, score: cosineSimilarity(queryEmbedding, vec), idx });
  }
  // 选项C：仅发生裁剪（rows > maxRows）时重排；未裁剪时输出序=声明序（不抖动 value_id 稳定序）。
  const trimTriggered = opts?.maxRows !== undefined && rows.length > opts.maxRows;
  if (!trimTriggered) return scored.map(({ row, score }) => ({ row, score }));
  return scored
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .map(({ row, score }) => ({ row, score }));
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
