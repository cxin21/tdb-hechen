/**
 * 自然衰减的留痕判据（Round12 起，Round13 A2 复核后定稿）。
 *
 * 判据换过三次，每次都是「把阈值调到能落地」而没有换判据，于是每次都换一种坏法：
 * ① 固定 0.005：10 分钟 tick 下单步最大 0.0048，decay 行数学上落不了账；
 * ② 按 dt 缩放的 0.0003：能落地，但 |dev| ≥ 0.125 时**每个 tick 都过门**——
 *    临时库实测 1 小时 6 个 tick 写出 6 条 decay + 6 条 regulation；
 * ③ 按 dt 线性放大：72h 空档要求退 0.13，真实只有 0.07，最该记的那次被挡。
 *
 * 现在锁住三条与节拍无关的腿：越线（偏着→不偏）、大幅单步（≥0.02）、跨档（0.01 一档）。
 */
import { describe, expect, it } from "vitest";
import {
  decayMoodTowardBaseline,
  shouldRecordMoodDecay,
  MOOD_DECAY_BUCKET,
  MOOD_DECAY_EVENT_DELTA,
} from "../emotion.js";

const NOW = "2026-11-19T00:00:00.000Z";
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

/** 走一次真实衰减：返回 {prevDev, nextDev}（基线按 0 计）。 */
function decayStep(dev: number, elapsedHours: number, halfLife = 48) {
  const out = decayMoodTowardBaseline(
    { valence: dev, arousal: 0, baselineValence: 0, baselineArousal: 0, updatedAt: hoursAgo(elapsedHours) },
    NOW,
    halfLife,
  );
  return { prevDev: dev, nextDev: out.valence };
}

describe("shouldRecordMoodDecay：与节拍无关的留痕判据", () => {
  it("越线（偏着 → 不偏）在任何节拍下都落一条：60s 与 10min 结果一致", () => {
    const gate = 0.05;
    const dense = decayStep(0.05, 1 / 60);
    const sparse = decayStep(0.05, 1 / 6);
    expect(Math.abs(dense.nextDev)).toBeLessThan(gate);
    expect(Math.abs(sparse.nextDev)).toBeLessThan(gate);
    expect(shouldRecordMoodDecay(dense.prevDev, dense.nextDev, gate)).toBe(true);
    expect(shouldRecordMoodDecay(sparse.prevDev, sparse.nextDev, gate)).toBe(true);
  });

  it("跨档才记：大偏离的可见值变了就记，只退一丁点没跨档就不记", () => {
    const dense = decayStep(0.16, 1 / 60);
    const sparse = decayStep(0.16, 1 / 6);
    // 0.16 → 0.1599 / 0.1586：floor(dev/0.01) 从 16 掉到 15，跨档。
    expect(shouldRecordMoodDecay(dense.prevDev, dense.nextDev, 0.05)).toBe(true);
    expect(shouldRecordMoodDecay(sparse.prevDev, sparse.nextDev, 0.05)).toBe(true);
    // 偏离 0.015：10 分钟单步 3.6e-5，档位不动（1 → 1），不落账。
    const tiny = decayStep(0.015, 1 / 6);
    expect(shouldRecordMoodDecay(tiny.prevDev, tiny.nextDev, 0.05)).toBe(false);
  });

  it("连续 6 个 10 分钟 tick 的同一段大偏离：decay 行不该每 tick 一条", () => {
    // Round13 A2 复核的反例：旧 0.0003 阈值下这里会得到 6 条 decay。
    let dev = 0.6;
    let at = Date.parse(NOW);
    let rows = 0;
    for (let i = 0; i < 6; i += 1) {
      const prev = dev;
      const out = decayMoodTowardBaseline(
        { valence: dev, arousal: 0, baselineValence: 0, baselineArousal: 0, updatedAt: new Date(at).toISOString() },
        new Date(at + 10 * 60_000).toISOString(),
        48,
      );
      dev = out.valence;
      at += 10 * 60_000;
      if (shouldRecordMoodDecay(prev, dev, 0.05)) rows += 1;
    }
    expect(rows).toBeGreaterThanOrEqual(1);
    expect(rows).toBeLessThanOrEqual(2);
    // 而且这一段并没有越线（仍偏着），记下来的行只能来自「跨档/大幅单步」。
    expect(Math.abs(dev)).toBeGreaterThan(0.05);
  });

  it("72 小时空档：真实衰减 0.07 不算大，但越线了，必须留痕", () => {
    const step = decayStep(0.11, 72);
    expect(Math.abs(step.nextDev)).toBeLessThan(0.05);
    expect(shouldRecordMoodDecay(step.prevDev, step.nextDev, 0.05)).toBe(true);
  });

  it("大幅单步：长空档里没越线也记（一次退掉 ≥ MOOD_DECAY_EVENT_DELTA）", () => {
    expect(shouldRecordMoodDecay(0.195, 0.195 - MOOD_DECAY_EVENT_DELTA, 0.05)).toBe(true);
    // 同一档内的小步退（0.195 → 0.190，档位都是 19，差值 0.005 < 0.02）不记：
    // 靠的是「跨档 / 越线 / 大幅」三条腿，而不是「退了一点就写」。
    expect(shouldRecordMoodDecay(0.195, 0.19, 0.05)).toBe(false);
    expect(MOOD_DECAY_BUCKET).toBeGreaterThan(0);
  });

  it("偏离反而变大（远离基线，不是衰减）→ 不写", () => {
    expect(shouldRecordMoodDecay(0.01, 0.02, 0.05)).toBe(false);
    expect(shouldRecordMoodDecay(-0.02, -0.03, 0.05)).toBe(false);
  });

  it("负偏离越线同样成立，且阈值缺省按 0.05 兜底", () => {
    expect(shouldRecordMoodDecay(-0.06, -0.01, 0.05)).toBe(true);
    expect(shouldRecordMoodDecay(-0.06, -0.01, Number.NaN)).toBe(true);
  });
});
