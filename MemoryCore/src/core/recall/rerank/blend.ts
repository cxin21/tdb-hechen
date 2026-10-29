/**
 * #137-F（2026-10-28）：精排与检索融合相关度的混合排序。
 *
 * 问题（实测）：W3 结论层开启后经验层预算常只剩 1 行（`experienceLimit = maxResults − 结论行`），
 * 而精排又把候选池按**原始 logit** 全量重排——单条注入行完全由 cross-encoder 决定，
 * 将已验证的融合主序（含 normalized 通道融合 / 事实通道 / 时间与实体证据）整条丢弃。
 * LME90 实测：同配置下 rerank 生产值判对 77.8%、深池 80.0%，关掉 86.7%——问题不是"精排没用"，
 * 而是**它把主序全吃了**。
 *
 * 本模块把两者混合：score = α × 检索相关度（池内 max 归一） + (1−α) × 精排分（0..1）。
 * - α=0 → 逐位旧行为（纯精排顺序）；
 * - α=1 → 纯检索顺序（精排只保留 floor 语义）；
 * - 0<α<1 → 精排只能在"检索也很看好"的候选之间翻盘，丢不掉融合 top-1。
 *
 * 纯函数、无副作用（便于用契约测试钉住 α=0/1 的逐位等价）。
 */

/** 精排候选（与 provider 返回同形；index 为注入行下标）。 */
export interface RerankScored {
  index: number;
  /** 0..1 归一后的精排分（local logit 已 sigmoid；云 provider 原生 0..1）。 */
  score01: number;
}

/**
 * 融合序位次先验（0..1）：`lines` 已按**最终融合顺序**（work_fact 分层 + 组合精排 + 探索位）排列，
 * 因此「第 i 行」本身就是最忠实的相关度信号——不要再用原始 scores 的数值归一化：
 * 组合精排/分层会让 scores 顺序 ≠ 行顺序（实测 rel0 只有池内 max 的 5%），按数值混合等于
 * 换了一个排序基准，α 越大反而越偏离融合序（LME90 实测 α=0.9 cov 76.1% < α=0.3 82.2%）。
 */
export function rankPriorScores(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [1];
  return Array.from({ length: count }, (_, i) => 1 - i / (count - 1));
}

/**
 * 混合排序：对已过 floor 的候选下标按 blended score 降序，平局回落到原始下标升序（确定性）。
 *
 * score = α × 融合位次先验(1 − i/(n−1)) + (1−α) × 精排分(0..1)
 * - α=1 → 逐位等于融合顺序（精排只保留 floor 语义）；
 * - α=0 → 纯精排顺序（旧行为）；
 * - 中间值 → 精排只能在相邻名次间做有界修正。
 *
 * @param passIdxs 已通过门槛的候选下标
 * @param scored   精排结果（index → 0..1 分）
 * @param totalLines 行总数（位次先验上下文）
 * @param blend    α∈[0,1]
 */
export function blendRerankOrder(
  passIdxs: readonly number[],
  scored: readonly RerankScored[],
  totalLines: number,
  blend: number,
): number[] {
  const base = [...passIdxs];
  if (!(blend > 0) || base.length <= 1) return base;
  const prior = rankPriorScores(totalLines);
  const rr = new Map<number, number>();
  for (const s of scored) rr.set(s.index, s.score01);
  const blended = new Map<number, number>();
  for (const i of base) {
    const pos = Math.min(Math.max(i, 0), Math.max(totalLines - 1, 0));
    blended.set(i, blend * (prior[pos] ?? 0) + (1 - blend) * (rr.get(i) ?? 0));
  }
  return base.sort((a, b) => {
    const sa = blended.get(a) ?? 0;
    const sb = blended.get(b) ?? 0;
    if (sb !== sa) return sb - sa;
    return a - b;
  });
}

/**
 * #137-F：融合锚点——截断窗口（cap）内必须保留融合主序 top-1。
 *
 * 动机（实测）：W3 结论层开启后经验层预算常只剩 1 行，精排把这一行换成自己的 top-1，
 * 单条证据完全由 cross-encoder 决定；LME90 全开档判对 77.8% vs 关掉精排 86.7%。
 * 锚点保证「已验证的融合最高置信证据」不被精排单方面换掉，同时 cap≥2 时精排仍可改
 * 第 2..cap 名次（价值保留），且 cap=1 时等于「精排只滤不清排」。
 *
 * @param order     精排（或混合）排序后的下标序列
 * @param cap       截断窗口（注入行数上限）
 * @param anchorIdx 融合主序 top-1 下标（searchResult.lines 已按融合序排列，恒 0）
 */
export function anchorRerankOrder(order: readonly number[], cap: number, anchorIdx = 0): number[] {
  const out = [...order];
  if (!(cap > 0) || out.length === 0) return out;
  if (out.slice(0, cap).includes(anchorIdx)) return out;
  return [anchorIdx, ...out.filter((i) => i !== anchorIdx)];
}