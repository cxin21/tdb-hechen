/**
 * S19（#57）：锚 shadow 定标行分析器——纯函数，供 D9 ε 定标与 #59 auto 档证据。
 *
 * 输入=soul-anchor-shadow-sink.ts:17-19 的 jsonl 行（对象）：
 *   { ts, agentId, threshold, rowsScored: [{ valueId, score }], wouldSelect, actuallySelected, agree }
 *
 * 哲学（ADR D9 / D7 同源）：先看分布再定标——agree 率、锚频率、分数分位数、
 * threshold 曲线全部是描述性统计，不做任何行为改变；坏行跳过并计数，绝不炸批。
 */

export interface AnchorShadowRowLike {
  rowsScored?: unknown;
  wouldSelect?: unknown;
  actuallySelected?: unknown;
  agree?: unknown;
  [key: string]: unknown;
}

export interface AnchorFrequencyEntry {
  valueId: string;
  wouldSelectCount: number;
  actuallySelectedCount: number;
  scoredCount: number;
}

export interface ThresholdCurvePoint {
  threshold: number;
  avgSelected: number;
  passRate: number;
}

export interface AnchorShadowStats {
  totalLines: number;
  badLines: number;
  agreeCount: number;
  agreeRate: number;
  anchorFrequency: AnchorFrequencyEntry[];
  scoreQuantiles: { p5: number; p10: number; p25: number; p50: number; p75: number; p95: number };
  thresholdCurve: ThresholdCurvePoint[];
}

export interface AnalyzeAnchorShadowOptions {
  /** 曲线档位；缺省 0..0.9 步长 0.1。 */
  thresholds?: readonly number[];
}

const DEFAULT_THRESHOLDS: readonly number[] = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const QUANTILES: readonly (keyof AnchorShadowStats["scoreQuantiles"])[] = ["p5", "p10", "p25", "p50", "p75", "p95"];
const QUANTILE_Q: Record<string, number> = { p5: 0.05, p10: 0.1, p25: 0.25, p50: 0.5, p75: 0.75, p95: 0.95 };

function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function countIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * 分析 shadow 定标行集合。
 * 坏行判定：rowsScored 非数组 / 含非有限 score / valueId 非串 —— 跳过并计入 badLines。
 */
export function analyzeAnchorShadowRows(
  rows: readonly AnchorShadowRowLike[],
  opts?: AnalyzeAnchorShadowOptions,
): AnchorShadowStats {
  const thresholds = opts?.thresholds ?? DEFAULT_THRESHOLDS;

  let badLines = 0;
  const goodRows: { scores: { valueId: string; score: number }[]; wouldSelect: string[]; actuallySelected: string[]; agree?: boolean }[] = [];

  for (const row of rows) {
    const raw = row?.rowsScored;
    if (!Array.isArray(raw)) { badLines += 1; continue; }
    const parsed: { valueId: string; score: number }[] = [];
    let bad = false;
    for (const item of raw) {
      const rec = item as { valueId?: unknown; score?: unknown } | null;
      if (!rec || typeof rec.valueId !== "string" || typeof rec.score !== "number" || !Number.isFinite(rec.score)) {
        bad = true;
        break;
      }
      parsed.push({ valueId: rec.valueId, score: rec.score });
    }
    if (bad) { badLines += 1; continue; }
    goodRows.push({
      scores: parsed,
      wouldSelect: countIds(row?.wouldSelect),
      actuallySelected: countIds(row?.actuallySelected),
      agree: typeof row?.agree === "boolean" ? row.agree : undefined,
    });
  }

  const totalLines = goodRows.length;

  let agreeCount = 0;
  let agreeObserved = 0;
  const freq = new Map<string, AnchorFrequencyEntry>();
  const allScores: number[] = [];
  const curveAgg = thresholds.map((threshold) => ({ threshold, selectedSum: 0, passCount: 0 }));

  for (const row of goodRows) {
    if (row.agree !== undefined) {
      agreeObserved += 1;
      if (row.agree) agreeCount += 1;
    }
    const wouldSet = new Set(row.wouldSelect);
    for (const s of row.scores) {
      allScores.push(s.score);
      const entry = freq.get(s.valueId) ?? { valueId: s.valueId, wouldSelectCount: 0, actuallySelectedCount: 0, scoredCount: 0 };
      entry.scoredCount += 1;
      if (wouldSet.has(s.valueId)) entry.wouldSelectCount += 1;
      freq.set(s.valueId, entry);
    }
    for (const id of row.actuallySelected) {
      const entry = freq.get(id);
      if (entry) entry.actuallySelectedCount += 1;
    }
    const selectedAt = (t: number): number => row.scores.filter((s) => s.score >= t).length;
    for (let i = 0; i < curveAgg.length; i++) {
      const n = selectedAt(curveAgg[i].threshold);
      curveAgg[i].selectedSum += n;
      if (n > 0) curveAgg[i].passCount += 1;
    }
  }

  allScores.sort((a, b) => a - b);
  const quantiles = {} as AnchorShadowStats["scoreQuantiles"];
  for (const key of QUANTILES) quantiles[key] = quantileSorted(allScores, QUANTILE_Q[key as string]);

  const anchorFrequency = [...freq.values()].sort((a, b) =>
    b.wouldSelectCount - a.wouldSelectCount || a.valueId.localeCompare(b.valueId),
  );

  const thresholdCurve = curveAgg.map((c) => ({
    threshold: c.threshold,
    avgSelected: totalLines > 0 ? c.selectedSum / totalLines : 0,
    passRate: totalLines > 0 ? c.passCount / totalLines : 0,
  }));

  return {
    totalLines,
    badLines,
    agreeCount,
    agreeRate: agreeObserved > 0 ? agreeCount / agreeObserved : 0,
    anchorFrequency,
    scoreQuantiles: quantiles,
    thresholdCurve,
  };
}