/**
 * importance 进遗忘（2026-11-04）：retention 乘子。
 *
 * 设计：importance 是**价值维度**（1–10 分），与 significance（情绪显著性 0–1）正交。
 * 低重要度 → 更快归档；高重要度 → 更难归档；NULL（未评分，生产 997 行）→ 中性不罚。
 *
 * factor = clamp(1 + k*((imp-5.5)/4.5), 1-k, 1+k)，k = clamp(cfg.importanceRetention ?? 0.2, 0, 0.5)
 * scoreFor = significance × priority × factor × decay(age) + recallCountBoost（仍 Math.min(1,·)）
 *
 * 逐位兼容：importance 缺失 或 k=0 → factor≡1 → 分数与改动前完全一致（本文件显式对比 k=0）。
 */
import { describe, expect, it } from "vitest";
import { classify, decay, scoreFor, DEFAULT_FORGETTING_CONFIG } from "../scorer.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

/** 真实落库形状：soul 字段在顶层（l1_records 列），metadata 只带时间锚。 */
function mk(
  priority: number,
  daysOld: number,
  soul: { significance?: number; importance?: number | null; metaImportance?: number | null } = {},
  // 用固定 NOW 造时间锚：否则 Date.now() 微秒漂移会让 ageDays 略小于 30，逐位断言不可复现。
  now: number = NOW,
): MemoryRecord {
  const t = new Date(now - daysOld * 86_400_000).toISOString();
  const rec: Record<string, unknown> = {
    id: "m",
    content: "c",
    type: "episodic",
    priority,
    scene_name: "s",
    source_message_ids: [],
    metadata: { activity_start_time: t, occurred_at: t },
    timestamps: [t],
    occurred_at: t,
    createdAt: "",
    updatedAt: "",
    version: 1,
    sessionKey: "k",
    sessionId: "sid",
  };
  if (soul.significance != null) rec.significance = soul.significance;
  if (soul.importance !== undefined) rec.importance = soul.importance;
  if (soul.metaImportance !== undefined) (rec.metadata as Record<string, unknown>).importance = soul.metaImportance;
  return rec as unknown as MemoryRecord;
}

const NOW = Date.now();

describe("importance retention 乘子", () => {
  it("缺省 k=0.2（配置项 defaults）", () => {
    expect(DEFAULT_FORGETTING_CONFIG.importanceRetention).toBe(0.2);
  });

  it("高 importance 分数更高（同 significance/priority/年龄）", () => {
    const hi = mk(40, 30, { significance: 0.2, importance: 10 });
    const lo = mk(40, 30, { significance: 0.2, importance: 1 });
    expect(scoreFor(hi, DEFAULT_FORGETTING_CONFIG, NOW)).toBeGreaterThan(scoreFor(lo, DEFAULT_FORGETTING_CONFIG, NOW));
  });

  it("高 importance 倾向 keep、低 importance 更易 archive（同一阈值两侧）", () => {
    const cfg = { ...DEFAULT_FORGETTING_CONFIG, minAgeDays: 1, lowThreshold: 0.06 };
    // sig0.2 × prio0.4 × decay(30)≈0.7408 ≈ 0.0593
    // imp=10 → ×1.2 ≈ 0.0711 > 0.06 keep；imp=1 → ×0.8 ≈ 0.0474 < 0.06 archive
    expect(classify(mk(40, 30, { significance: 0.2, importance: 10 }), cfg, NOW)).toBe("keep");
    expect(classify(mk(40, 30, { significance: 0.2, importance: 1 }), cfg, NOW)).toBe("archive");
  });

  it("importance 缺失（NULL/未评分）→ 中性：分数与显式 k=0 逐位一致", () => {
    const rec = mk(40, 30, { significance: 0.2 });
    const kZero = { ...DEFAULT_FORGETTING_CONFIG, importanceRetention: 0 };
    expect(scoreFor(rec, DEFAULT_FORGETTING_CONFIG, NOW)).toBe(scoreFor(rec, kZero, NOW));
  });

  it("k=0 → 有 importance 也完全不影响分数（恒等基线）", () => {
    const withImp = mk(40, 30, { significance: 0.2, importance: 10 });
    const without = mk(40, 30, { significance: 0.2 });
    const kZero = { ...DEFAULT_FORGETTING_CONFIG, importanceRetention: 0 };
    expect(scoreFor(withImp, kZero, NOW)).toBe(scoreFor(without, kZero, NOW));
  });

  it("k=0.2 时 factor 上界 1.2 / 下界 0.8（与 decay 项相乘）", () => {
    const decayPart = 0.2 * 0.4 * decay(30, DEFAULT_FORGETTING_CONFIG.lambda);
    const hi = mk(40, 30, { significance: 0.2, importance: 10 });
    const lo = mk(40, 30, { significance: 0.2, importance: 1 });
    expect(scoreFor(hi, DEFAULT_FORGETTING_CONFIG, NOW)).toBeCloseTo(decayPart * 1.2, 10);
    expect(scoreFor(lo, DEFAULT_FORGETTING_CONFIG, NOW)).toBeCloseTo(decayPart * 0.8, 10);
  });

  it("imp 越界 clamp 到 [1,10]：>10 等价 10、<1 等价 1", () => {
    const d = DEFAULT_FORGETTING_CONFIG;
    expect(scoreFor(mk(40, 30, { significance: 0.2, importance: 100 }), d, NOW)).toBe(
      scoreFor(mk(40, 30, { significance: 0.2, importance: 10 }), d, NOW),
    );
    expect(scoreFor(mk(40, 30, { significance: 0.2, importance: -5 }), d, NOW)).toBe(
      scoreFor(mk(40, 30, { significance: 0.2, importance: 1 }), d, NOW),
    );
  });

  it("k 越界 clamp 到 [0,0.5]：5 等价 0.5、-1 等价 0", () => {
    const big = { ...DEFAULT_FORGETTING_CONFIG, importanceRetention: 5 };
    const half = { ...DEFAULT_FORGETTING_CONFIG, importanceRetention: 0.5 };
    const neg = { ...DEFAULT_FORGETTING_CONFIG, importanceRetention: -1 };
    const zero = { ...DEFAULT_FORGETTING_CONFIG, importanceRetention: 0 };
    const rec = mk(40, 30, { significance: 0.2, importance: 10 });
    expect(scoreFor(rec, big, NOW)).toBe(scoreFor(rec, half, NOW));
    expect(scoreFor(rec, neg, NOW)).toBe(scoreFor(rec, zero, NOW));
  });

  it("metadata.importance 兜底（顶层缺省时）", () => {
    const top = mk(40, 30, { significance: 0.2, importance: 8 });
    const meta = mk(40, 30, { significance: 0.2, metaImportance: 8 });
    expect(scoreFor(meta, DEFAULT_FORGETTING_CONFIG, NOW)).toBe(scoreFor(top, DEFAULT_FORGETTING_CONFIG, NOW));
  });

  it("imp=5.5 为中性点：factor=1（与缺失等价）", () => {
    const mid = mk(40, 30, { significance: 0.2, importance: 5.5 });
    const none = mk(40, 30, { significance: 0.2 });
    expect(scoreFor(mid, DEFAULT_FORGETTING_CONFIG, NOW)).toBeCloseTo(scoreFor(none, DEFAULT_FORGETTING_CONFIG, NOW), 10);
  });

  it("单调性：importance 递增分数不降", () => {
    const d = DEFAULT_FORGETTING_CONFIG;
    let prev = -Infinity;
    for (const imp of [1, 2, 3, 5.5, 7, 9, 10]) {
      const s = scoreFor(mk(40, 30, { significance: 0.2, importance: imp }), d, NOW);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});
