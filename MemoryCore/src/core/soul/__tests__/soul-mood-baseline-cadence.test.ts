/**
 * 基线 EMA 必须按墙钟时间推进，而不是按调用次数（Round13 A2 复核 CP2）。
 *
 * 旧实现每 tick 都 ×0.02：60s 节拍跑 10 次与 10min 节拍跑 1 次应是同一段 10 分钟，
 * 却推进了 10 倍的量——同一条输入换个节拍就是另一条曲线。
 */
import { describe, expect, it } from "vitest";
import {
  BASELINE_EMA_REF_HOURS,
  baselineEmaAlpha,
  emptyMood,
  integrateMood,
} from "../emotion.js";
import { BASELINE_EMA_ALPHA } from "../traits.js";

const T0 = "2026-11-19T00:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const CFG = { moodHalfLifeHours: 48, emotionHalfLifeHours: 3 } as never;
const EVENT = [{
  id: "e1",
  at: T0,
  valence: -0.9,
  arousal: 0.7,
  dominance: 0.5,
  intensity: 1,
  halfLifeHours: 3,
  label: "worry",
  object: "他",
  source: "lexicon",
}] as never;

describe("基线 EMA 的节拍不变性（Round13 A2）", () => {
  it("参考节拍仍是 α=0.02；更密的 tick 拿到更小的等效 α", () => {
    expect(BASELINE_EMA_REF_HOURS).toBeCloseTo(1 / 6, 12);
    expect(baselineEmaAlpha(BASELINE_EMA_REF_HOURS)).toBeCloseTo(BASELINE_EMA_ALPHA, 12);
    expect(baselineEmaAlpha(1 / 60)).toBeLessThan(BASELINE_EMA_ALPHA);
    expect(baselineEmaAlpha(0)).toBe(0);
  });

  it("同一段 10 分钟：60s×10 与 10min×1 的基线和心境一致", () => {
    const seed = integrateMood(null, EVENT, T0, CFG);
    let dense = seed;
    // 1 分钟一步 ×10 = 10 分钟，与 10min×1 比较（参考节拍内的小步与整步）。
    for (let i = 1; i <= 10; i += 1) dense = integrateMood(dense, [], at(i), CFG);
    const sparse = integrateMood(seed, [], at(10), CFG);
    // 目标值本身随时间衰减，两种切法的路径差异是二阶小量（1e-5 量级），不是 10 倍差。
    expect(dense.baselineValence).toBeCloseTo(sparse.baselineValence, 4);
    expect(dense.valence).toBeCloseTo(sparse.valence, 4);
    // Round28：静默期基线必须**不动**。旧断言要求它动，正是「没有新证据也在漂」的那条 bug；
    // 现在基线只被证据推动（emotion.ts 的 emaAlpha 在 events.length===0 时为 0）。
    expect(sparse.baselineValence).toBeCloseTo(seed.baselineValence, 12);
    expect(dense.baselineValence).toBeCloseTo(seed.baselineValence, 12);
  });

  it("有证据时基线才动，且与事件分成几批无关（Round28）", () => {
    const seed = integrateMood(null, [], T0, CFG);
    const template = EVENT[0] as unknown as Record<string, unknown>;
    const many = Array.from({ length: 10 }, (_, i) => ({ ...template, id: "m" + i })) as never;
    const oneShot = integrateMood(seed, many, at(10), CFG);
    let perTick = seed;
    for (let i = 1; i <= 10; i += 1) {
      perTick = integrateMood(perTick, [{ ...template, id: "m" + i }] as never, at(i), CFG);
    }
    // 证据推动基线（方向与事件一致），且「10 条一次到账」与「10 个 tick 各 1 条」推进量同级。
    expect(oneShot.baselineValence).toBeLessThan(seed.baselineValence - 1e-6);
    expect(perTick.baselineValence).toBeLessThan(seed.baselineValence - 1e-6);
    expect(Math.abs(perTick.baselineValence - oneShot.baselineValence)).toBeLessThan(0.005);
  });

  it("同一段 6 小时：60s×360 与 10min×36 的基线一致（旧实现在这里差 10 倍推进量）", () => {
    const seed = integrateMood(null, EVENT, T0, CFG);
    let dense = seed;
    // 1 分钟一步 ×360 = 6 小时；与 10min×36 比较。
    for (let i = 1; i <= 360; i += 1) dense = integrateMood(dense, [], at(i), CFG);
    let sparse = seed;
    for (let i = 1; i <= 36; i += 1) sparse = integrateMood(sparse, [], at(i * 10), CFG);
    // 6 小时里目标值一直在衰减，路径差 2.4e-4（相对 0.1%）；旧实现按调用次数推进会差 0.17。
    expect(dense.baselineValence).toBeCloseTo(sparse.baselineValence, 3);
    expect(dense.valence).toBeCloseTo(sparse.valence, 3);
  });
});
