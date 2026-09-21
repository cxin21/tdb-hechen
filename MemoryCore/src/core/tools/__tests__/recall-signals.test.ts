/**
 * R-A1（结构感知召回 spec §2 R1/R2/R3/R8/R9）：排序层结构信号纯函数单测。
 * 每个通道一个行为断言 + 全 0 关断恒等（spec §3 不变式④：0=通道完全退出）。
 */
import { describe, expect, it } from "vitest";
import {
  buildRankContext,
  certaintyMultiplierOf,
  DEFAULT_RANK_SIGNALS,
  moodSignalOf,
  moodSignOf,
  recencySignalOf,
  reinforcementSignalOf,
  significanceSignalOf,
  structuralSignalOf,
  timeSignalOf,
  ZERO_RANK_SIGNALS,
  type RankSignalItem,
} from "../recall-signals.js";
import { parseTimeWindow, type TimeWindow } from "../content-time-window.js";

const WIN: TimeWindow = { start: "2026-09-01T00:00:00Z", end: "2026-09-08T00:00:00Z", label: "上周" };
const NOW = new Date("2026-09-10T12:00:00Z");
const DAY_MS = 86_400_000;

const item = (over: Partial<RankSignalItem>): RankSignalItem => ({ ...over });

describe("R1 timeSignalOf（时间窗命中）", () => {
  it("occurred_at 落窗内 → +boost", () => {
    expect(timeSignalOf(item({ occurred_at: "2026-09-03T10:00:00Z" }), WIN, 0.05)).toBe(0.05);
  });
  it("occurred_at 窗外 → 0", () => {
    expect(timeSignalOf(item({ occurred_at: "2026-08-20T10:00:00Z" }), WIN, 0.05)).toBe(0);
  });
  it("occurred_at 缺失但 valid 区间与窗相交（开放端）→ +boost", () => {
    // 持续态事实：2026-09-05 起至今成立（valid_end 缺 = 开放端）→ 与上周窗相交
    expect(timeSignalOf(item({ valid_start: "2026-09-05T00:00:00Z" }), WIN, 0.05)).toBe(0.05);
    // 完整区间相交
    expect(
      timeSignalOf(item({ valid_start: "2026-08-30T00:00:00Z", valid_end: "2026-09-02T00:00:00Z" }), WIN, 0.05),
    ).toBe(0.05);
  });
  it("valid 区间与窗不相交 → 0", () => {
    expect(timeSignalOf(item({ valid_start: "2026-01-01T00:00:00Z", valid_end: "2026-02-01T00:00:00Z" }), WIN, 0.05)).toBe(0);
  });
  it("无窗 / boost=0 → 恒 0（宁缺毋滥，关断退出）", () => {
    expect(timeSignalOf(item({ occurred_at: "2026-09-03T10:00:00Z" }), null, 0.05)).toBe(0);
    expect(timeSignalOf(item({ occurred_at: "2026-09-03T10:00:00Z" }), WIN, 0)).toBe(0);
    expect(timeSignalOf(item({ occurred_at: "2026-09-03T10:00:00Z" }), undefined, 0.05)).toBe(0);
  });
  // ── S7 第 5 项（R-A1 审查 M-4）：窗口边界统一半开 [ws, we) ──
  it("边界统一：occurred=ws → boost；occurred=we → 0（[ws, we)）", () => {
    expect(timeSignalOf(item({ occurred_at: "2026-09-01T00:00:00Z" }), WIN, 0.05)).toBe(0.05);
    expect(timeSignalOf(item({ occurred_at: "2026-09-08T00:00:00Z" }), WIN, 0.05)).toBe(0);
  });
  it("边界统一：valid_end 恰触窗起点（『至 ws 仍成立』）→ boost（窗起点属窗）", () => {
    // 修复前 valid 分支 e > ws 严格开区间：valid_end === ws 不加成（与 occurred >= ws 不一致）
    expect(
      timeSignalOf(item({ valid_start: "2026-08-25T00:00:00Z", valid_end: "2026-09-01T00:00:00Z" }), WIN, 0.05),
    ).toBe(0.05);
  });
  it("边界统一：valid_start 恰在窗终点 → 0（we 不属窗）", () => {
    expect(
      timeSignalOf(item({ valid_start: "2026-09-08T00:00:00Z", valid_end: "2026-09-20T00:00:00Z" }), WIN, 0.05),
    ).toBe(0);
  });
});

describe("R1 recencySignalOf（时近性 last_recalled_at < 24h）", () => {
  it("23h 前回忆过 → +boost", () => {
    const it1 = item({ metadata: { last_recalled_at: new Date(NOW.getTime() - 23 * 3_600_000).toISOString() } });
    expect(recencySignalOf(it1, NOW, 0.03)).toBe(0.03);
  });
  it("25h 前 / 未来时间戳 / 缺失 → 0", () => {
    expect(recencySignalOf(item({ metadata: { last_recalled_at: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() } }), NOW, 0.03)).toBe(0);
    expect(recencySignalOf(item({ metadata: { last_recalled_at: new Date(NOW.getTime() + 3_600_000).toISOString() } }), NOW, 0.03)).toBe(0);
    expect(recencySignalOf(item({ metadata: {} }), NOW, 0.03)).toBe(0);
    expect(recencySignalOf(item({}), NOW, 0.03)).toBe(0);
  });
  it("boost=0 → 恒 0", () => {
    const it1 = item({ metadata: { last_recalled_at: NOW.toISOString() } });
    expect(recencySignalOf(it1, NOW, 0)).toBe(0);
  });
});

describe("R2 significanceSignalOf", () => {
  it("significance * weight", () => {
    expect(significanceSignalOf(item({ significance: 0.8 }), 0.03)).toBeCloseTo(0.024, 12);
  });
  it("缺失 / weight=0 → 0", () => {
    expect(significanceSignalOf(item({}), 0.03)).toBe(0);
    expect(significanceSignalOf(item({ significance: 0.8 }), 0)).toBe(0);
  });
});

describe("R3 certaintyMultiplierOf（inferred 乘法降权）", () => {
  it("inferred × (1-penalty)，observed × 1", () => {
    expect(certaintyMultiplierOf(item({ certainty: "inferred" }), 0.1)).toBeCloseTo(0.9, 12);
    expect(certaintyMultiplierOf(item({ certainty: "observed" }), 0.1)).toBe(1);
    expect(certaintyMultiplierOf(item({}), 0.1)).toBe(1);
  });
  it("penalty=0 → 恒 1（关断恒等）", () => {
    expect(certaintyMultiplierOf(item({ certainty: "inferred" }), 0)).toBe(1);
  });
});

describe("R8 reinforcementSignalOf（对数缩放）", () => {
  it("recall_count=9 → log10(10)*weight = weight", () => {
    expect(reinforcementSignalOf(item({ metadata: { recall_count: 9 } }), 0.03)).toBeCloseTo(0.03, 12);
  });
  it("count=0 / 缺失 / weight=0 → 0", () => {
    expect(reinforcementSignalOf(item({ metadata: { recall_count: 0 } }), 0.03)).toBe(0);
    expect(reinforcementSignalOf(item({}), 0.03)).toBe(0);
    expect(reinforcementSignalOf(item({ metadata: { recall_count: 9 } }), 0)).toBe(0);
  });
});

describe("R9 moodSignalOf（对称弱偏置）", () => {
  it("moodSign>0 偏置正 valence，moodSign<0 偏置负 valence（对称）", () => {
    expect(moodSignalOf(item({ valence: 0.6 }), 1, 0.03)).toBe(0.03);
    expect(moodSignalOf(item({ valence: -0.6 }), 1, 0.03)).toBe(0);
    expect(moodSignalOf(item({ valence: -0.6 }), -1, 0.03)).toBe(0.03);
    expect(moodSignalOf(item({ valence: 0.6 }), -1, 0.03)).toBe(0);
  });
  it("valence 0/缺失 / moodSign=0 / boost=0 → 0", () => {
    expect(moodSignalOf(item({ valence: 0 }), 1, 0.03)).toBe(0);
    expect(moodSignalOf(item({}), 1, 0.03)).toBe(0);
    expect(moodSignalOf(item({ valence: 0.6 }), 0, 0.03)).toBe(0);
    expect(moodSignalOf(item({ valence: 0.6 }), 1, 0)).toBe(0);
  });
});

describe("R9 moodSignOf（fired valence 均值符号）", () => {
  it("均值符号判定", () => {
    expect(moodSignOf([1, 1])).toBe(1);
    expect(moodSignOf([-1])).toBe(-1);
    expect(moodSignOf([1, -1])).toBe(0);
    expect(moodSignOf([0.5, 1])).toBe(1);
  });
  it("fired 为空 / 全 null → 0（不加成）", () => {
    expect(moodSignOf([])).toBe(0);
    expect(moodSignOf([null, null])).toBe(0);
  });
});

describe("structuralSignalOf 关断矩阵（全 0 → 恒 0）", () => {
  it("全信号命中的条目在 ZERO_RANK_SIGNALS 下加成恒 0（IEEE754 +0 恒等）", () => {
    const hot: RankSignalItem = {
      occurred_at: "2026-09-03T10:00:00Z",
      metadata: { last_recalled_at: new Date(NOW.getTime() - 3_600_000).toISOString(), recall_count: 9 },
      significance: 0.8,
      valence: 0.6,
    };
    const ctx = { timeWindow: WIN, moodSign: 1, signals: ZERO_RANK_SIGNALS, now: NOW };
    expect(structuralSignalOf(hot, ctx)).toBe(0);
  });
  it("DEFAULT_RANK_SIGNALS 默认值与 spec §2 一致（R9 默认关 + R10 情感显著度默认关断）", () => {
    expect(DEFAULT_RANK_SIGNALS).toEqual({
      timeBoost: 0.05,
      recencyBoost: 0.03,
      sigWeight: 0.03,
      inferredPenalty: 0.1,
      reinforcementWeight: 0.03,
      moodBoost: 0,
      // R10（REG-R10-AB-001）：情感显著度信号默认关断（A/B 未过不得置正，实验轨红线）。
      emotionSalienceWeight: 0,
      // D-3（R11）：敏感降权默认关断（gated，缺省 0=逐位现状）。
      sensitivityPenalty: 0,
    });
  });
});

describe("buildRankContext（plan Interfaces：R-A2 复用）", () => {
  it("fired 价值 + valence → firedLabels/moodSign；时间线索 → timeWindow", async () => {
    const ctx = await buildRankContext("上周 正确性 的事情", [], {
      readValues: () => [{ value_id: "v1", label: "正确性", weight: 0.8, valence: 1 }],
      now: NOW,
    });
    expect(ctx.firedLabels).toEqual(["正确性"]);
    expect(ctx.firedValues).toHaveLength(1);
    expect(ctx.firedValues[0]).toMatchObject({ label: "正确性", weight: 0.8, valence: 1 });
    expect(ctx.moodSign).toBe(1);
    expect(ctx.timeWindow?.label).toBe("上周");
    expect(ctx.now).toBe(NOW);
  });
  it("无 fired（query 不含 label）→ firedLabels 空、moodSign 0", async () => {
    const ctx = await buildRankContext("无关查询", [], {
      readValues: () => [{ value_id: "v1", label: "正确性", weight: 0.8, valence: 1 }],
      now: NOW,
    });
    expect(ctx.firedLabels).toEqual([]);
    expect(ctx.moodSign).toBe(0);
  });
  it("无时间线索 → timeWindow null（宁缺毋滥）", async () => {
    const ctx = await buildRankContext("正确性", [], { now: NOW });
    expect(ctx.timeWindow).toBeNull();
    expect(ctx.moodSign).toBe(0);
    expect(ctx.firedLabels).toEqual([]);
  });
  it("readValues 抛错 → best-effort 空信号（不 throw）", async () => {
    const ctx = await buildRankContext("正确性", [], {
      readValues: () => {
        throw new Error("db down");
      },
      now: NOW,
    });
    expect(ctx.firedLabels).toEqual([]);
    expect(ctx.moodSign).toBe(0);
  });
  it("时间窗解析与 parseTimeWindow 同源（now 快照一致）", async () => {
    const ctx = await buildRankContext("N 天前的记录", [], { now: NOW });
    expect(ctx.timeWindow).toEqual(parseTimeWindow("N 天前的记录", NOW));
  });
});
