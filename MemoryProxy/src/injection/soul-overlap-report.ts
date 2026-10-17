/**
 * #51（H26）：soul/core 重叠报告的口径感知纯函数层。
 *
 * 第一性原理（issue #51）：判定规则只应消费同口径数据——journal 只存 hash 无原文，
 * 旧口径行（norm 缺省=0，同文异装格式噪声恒 0% 伪影）不可离线重算归一 hash，
 * 混窗永久存在；预注册三档规则（>80 归一 / 60-80 分工 / <60 关票）按「两周窗」
 * 判定，窗口跨口径切换日时旧 0% 数据会稀释均值导致误判 → 三档判定：
 *   - 只消费 norm === JOURNAL_NORM_VERSION 的同口径数据；
 *   - 口径切换日（首个 norm>=1 行日期）在 days 窗口内（同口径数据不足 days 天）
 *     或窗口内无同口径有效行 → `insufficient-window` 诚实降级，不套用三档规则。
 *
 * 本文件为纯函数（无 I/O），由 scripts/report-soul-overlap.ts 消费；独立单测于
 * __tests__/soul-overlap-report.test.ts。
 */

import {
  JOURNAL_NORM_VERSION,
  jaccard,
  journalNormVersion,
} from "./soul-overlap-journal.js";

const DAY_MS = 86_400_000;

/** 三档档位（预注册规则，r5-26.md）。 */
export type OverlapTier = "normalize" | "boundary" | "keep-dual";

export interface OverlapWindowDecision {
  /** verdict = 套用三档规则；insufficient-window = 窗口内同口径数据不足，诚实降级。 */
  status: "insufficient-window" | "verdict";
  /** insufficient-window 时的降级原因。 */
  reason?: string;
  /** verdict：窗口内同口径数据 Jaccard 全期均值（0..1，行级均值）。 */
  mean?: number;
  /** verdict：三档档位。 */
  tier?: OverlapTier;
  /** verdict：进入判定的同口径有效行数（透明性，供报告展示）。 */
  rows?: number;
}

/**
 * 报告消费的最小行形状：解析自不可信 JSONL（旧行/坏行字段可缺失），
 * 全部字段可选；运行时逐字段容错（hasValidTs / journalNormVersion / ?? []）。
 * SoulOverlapJournalEntry（必填字段）天然可赋值给本类型。
 */
export type OverlapReportRow = {
  ts?: string;
  norm?: number;
  soul_line_hashes?: string[];
  core_line_hashes?: string[];
};

/** ts 是否为可解析的有效 ISO 日期（≥"YYYY-MM-DD"），与报告脚本 unknown 桶判型一致。 */
function hasValidTs(e: OverlapReportRow): e is OverlapReportRow & { ts: string } {
  return typeof e.ts === "string" && e.ts.length >= 10 && Number.isFinite(Date.parse(e.ts));
}

/**
 * 口径切换日：首个 norm>=1 行的日期（输入顺序 = journal 追加顺序；ts 无效行跳过）。
 * 无归一口径行 → null。
 */
export function inferNormSwitchDay(entries: OverlapReportRow[]): string | null {
  for (const e of entries) {
    if (journalNormVersion(e) >= 1 && typeof e.ts === "string" && e.ts.length >= 10) {
      return e.ts.slice(0, 10);
    }
  }
  return null;
}

/**
 * 有界 days 窗口的三档判定（#51 口径感知）：
 * 1. 无归一口径行（norm>=1）→ insufficient-window（无可判定的同口径 era）。
 * 2. 口径切换日 UTC 零点晚于窗口起点（now-days 天）→ insufficient-window
 *    （同口径数据不足 days 天，窗口跨切换日）。
 * 3. 窗口内 norm === JOURNAL_NORM_VERSION 的有效行（ts 合法且 ts>=窗口起点）
 *    为空 → insufficient-window。
 * 4. 否则按行级 Jaccard 均值套用三档：>80% 归一 / 60–80% 分工 / <60% 关票
 *    （>80 严格大于；60–80 档含两端点 0.6 与 0.8）。
 */
export function decideOverlapWindow(
  entries: OverlapReportRow[],
  days: number,
  nowMs: number,
): OverlapWindowDecision {
  const switchDay = inferNormSwitchDay(entries);
  if (switchDay === null) {
    return {
      status: "insufficient-window",
      reason: "journal 无归一口径（norm>=1）数据，三档规则不适用",
    };
  }
  const cutoffMs = nowMs - days * DAY_MS;
  const switchStartMs = Date.parse(`${switchDay}T00:00:00.000Z`);
  if (switchStartMs > cutoffMs) {
    return {
      status: "insufficient-window",
      reason: `口径切换日 ${switchDay} 在窗口内：同口径数据不足 ${days} 天，三档规则不适用`,
    };
  }
  const decisionRows = entries.filter(
    (e) =>
      journalNormVersion(e) === JOURNAL_NORM_VERSION &&
      hasValidTs(e) &&
      Date.parse(e.ts) >= cutoffMs,
  );
  if (decisionRows.length === 0) {
    return {
      status: "insufficient-window",
      reason: `窗口内无 norm=${JOURNAL_NORM_VERSION} 同口径有效数据，三档规则不适用`,
    };
  }
  const allJ: number[] = [];
  for (const e of decisionRows) {
    allJ.push(jaccard(e.soul_line_hashes ?? [], e.core_line_hashes ?? []));
  }
  const mean = allJ.reduce((x, y) => x + y, 0) / allJ.length;
  const tier: OverlapTier = mean > 0.8 ? "normalize" : mean >= 0.6 ? "boundary" : "keep-dual";
  return { status: "verdict", mean, tier, rows: decisionRows.length };
}
