import { describe, expect, it } from "vitest";
import { decay, classify, classifyWithValues, scoreFor, DEFAULT_FORGETTING_CONFIG } from "../scorer.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

/**
 * 审计修复 A2：测试 fixture 必须反映真实落库形状——
 * P2a/P0 把 occurred_at/certainty/valence/significance 存 MemoryRecord 顶层
 * （sqlite l1_records 顶层列），不在 metadata 里。原 fixture 只放 metadata
 * → 掩盖了 scorer 恒读 0.5 的缺陷（本审计 A2）。
 */
function mk(
  priority: number,
  daysOld: number,
  soul?: { significance?: number; valence?: number },
  globalRule = false,
  /** 模拟 lifecycle-scheduler 传回的行形状（顶层 + metadata 只带时间锚） */
  legacyMetaOnly = false,
): MemoryRecord {
  const t = new Date(Date.now() - daysOld * 86_400_000).toISOString();
  const rec: Record<string, unknown> = {
    id: "m", content: "c", type: "episodic", priority: globalRule ? -1 : priority, scene_name: "s",
    source_message_ids: [],
    // 真实形状：metadata 只有时间锚（scheduler 只搬 activity_start_time/occurred_at）
    metadata: { activity_start_time: t, occurred_at: t },
    timestamps: [t],
    occurred_at: t,
    createdAt: "", updatedAt: "", version: 1, sessionKey: "k", sessionId: "sid",
  };
  if (legacyMetaOnly) {
    // 旧缺陷路径的兼容样本：significance 只在 metadata（应仍能被 metadata 兜底读到）
    if (soul?.significance != null) (rec.metadata as Record<string, unknown>).significance = soul.significance;
    if (soul?.valence != null) (rec.metadata as Record<string, unknown>).valence = soul.valence;
  } else {
    // P2a 真实形状：soul 字段在顶层
    if (soul?.significance != null) rec.significance = soul.significance;
    if (soul?.valence != null) rec.valence = soul.valence;
  }
  return rec as unknown as MemoryRecord;
}

describe("forgetting scorer (I 遗忘)", () => {
  it("衰减：越旧分越低", () => {
    expect(decay(0, 0.01)).toBe(1);
    expect(decay(100, 0.01)).toBeLessThan(decay(10, 0.01));
  });

  it("新记忆(<minAgeDays)不归档", () => {
    expect(classify(mk(50, 5), DEFAULT_FORGETTING_CONFIG)).toBe("keep");
  });

  it("低分且超期 → archive；高价值保留", () => {
    const cfg = { ...DEFAULT_FORGETTING_CONFIG, minAgeDays: 1, lowThreshold: 0.3 };
    const now = Date.now();
    // 对抗性自审修正 i：原 age=365 → decay=e^-3.65=0.026，任何 sig×prio 都被压到 <0.3，
    // 导致"高价值保留"断言必挂。改 age=30：decay(30)=e^-0.3≈0.7408，salience 差异真实显现。
    // 低 priority 40 + significance 0.2 → 0.2*0.4*0.7408≈0.059 <0.3 → archive
    expect(classify(mk(40, 30, { significance: 0.2 }), cfg, now)).toBe("archive");
    // 高 priority 80 + significance 0.9 → 0.9*0.8*0.7408≈0.533 >0.3 → keep
    expect(classify(mk(80, 30, { significance: 0.9 }), cfg, now)).toBe("keep");
  });

  it("A2 回归：significance 在顶层（真实落库形状）参与打分，不再恒 0.5", () => {
    const cfg = { ...DEFAULT_FORGETTING_CONFIG, minAgeDays: 1, lowThreshold: 0.3 };
    const now = Date.now();
    // 对抗性自审修正 ii：significance=1.0 + priority 80 + age=30 → 0.8*0.7408≈0.59 >0.3 → keep；
    //   若 bug 仍恒 0.5（旧行为）→ 0.5*0.8*0.7408≈0.296 <0.3 → archive，故本断言区分修复前后。
    expect(classify(mk(80, 30, { significance: 1.0 }), cfg, now)).toBe("keep");
    // significance=0.1 + priority 80 → 0.1*0.8*0.7408≈0.059 <0.3 → archive
    expect(classify(mk(80, 30, { significance: 0.1 }), cfg, now)).toBe("archive");
    // metadata 兜底路径（旧行/兼容形状）仍生效：0.2*0.8*0.7408≈0.119 <0.3 → archive
    expect(classify(mk(80, 30, { significance: 0.2 }, false, true), cfg, now)).toBe("archive");
  });

  it("全局死规则(-1)永不归档", () => {
    expect(classify(mk(0, 3650, { significance: 0 }, true), DEFAULT_FORGETTING_CONFIG)).toBe("keep");
  });

  it("scoreFor 单调性", () => {
    expect(scoreFor(mk(80, 10, { significance: 0.9 }), DEFAULT_FORGETTING_CONFIG)).toBeGreaterThan(
      scoreFor(mk(20, 400, { significance: 0.1 }), DEFAULT_FORGETTING_CONFIG),
    );
  });

  it("B1 回归：价值命中 → boost → 本会被归档的记忆保留（更难被遗忘）", () => {
    // 对抗性自审修正 iii：基线 sig0.2*prio0.4*decay(30)=0.059。选 lowThreshold=0.08：
    //   无 boost 0.059<0.08 → archive；salienceBoost(命中"性能")≈0.1 → 0.159>0.08 → keep。
    const cfg = { ...DEFAULT_FORGETTING_CONFIG, minAgeDays: 1, lowThreshold: 0.08 };
    const now = Date.now();
    const values = [{ id: "perf", label: "性能", weight: 0.9 }];
    // 无 boost 时会 archive 的边界样本
    const rec = mk(40, 30, { significance: 0.2 });
    expect(classify(rec, cfg, now)).toBe("archive");
    // 命中价值（内容含"性能"）→ boost → keep
    const rec2 = mk(40, 30, { significance: 0.2 });
    (rec2 as unknown as { content: string }).content = "性能优化关键决策记录";
    expect(classifyWithValues(rec2, values, cfg, now)).toBe("keep");
  });

  it("B1 回归：values 为空 → 行为与 classify 完全一致（零影响）", () => {
    const cfg = { ...DEFAULT_FORGETTING_CONFIG, minAgeDays: 1, lowThreshold: 0.08 };
    const now = Date.now();
    const rec = mk(40, 30, { significance: 0.2 });
    expect(classifyWithValues(rec, [], cfg, now)).toBe(classify(rec, cfg, now));
  });
});
