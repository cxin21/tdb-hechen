/**
 * A2 Round28：衰减账本按「累计纯衰减量」记，不按单 tick 落差、也不按落库值差。
 *
 * 两个反例都真发生过：
 * ① 拿上一 tick 落库值当锚：10 分钟一 tick 单步只退约 7e-4，永远跨不过 0.01 档
 *    ——生产 70.6 小时空档、417 张快照、decay 行 0 条；
 * ② 拿落库值差当衰减：|dev|≥0.35 期间自我调节每 tick 拉回 20%，24 tick 用例记出 8 条假 decay。
 */
import { describe, expect, it } from "vitest";
import {
  MOOD_DECAY_LEDGER_MIN_DROP,
  decayMoodTowardBaseline,
  stepMoodDecayLedger,
} from "../emotion.js";

const START = "2026-11-13T03:53:00.000Z";
const at = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000).toISOString();
const EMPTY = { pendingValence: null, pendingArousal: null, since: null };

/** 本 tick 被半衰期退掉多少（纯衰减量，正数）。 */
function pureDecay(dev: number, fromMinutes: number, toMinutes: number, halfLife = 48): number {
  const before = decayMoodTowardBaseline(
    { valence: dev, arousal: 0, baselineValence: 0, baselineArousal: 0, updatedAt: at(fromMinutes) },
    at(toMinutes),
    halfLife,
  ).valence;
  return Math.abs(before - dev);
}

function runTicks(dev: number, ticks: number, stepMinutes = 10) {
  let state = stepMoodDecayLedger({
    previous: EMPTY,
    perTickValence: 0,
    perTickArousal: 0,
    directionValence: dev,
    directionArousal: 0,
    now: at(0),
  });
  const decays: Array<{ minutes: number; deltaValence: number }> = [];
  for (let i = 1; i <= ticks; i += 1) {
    const perTick = pureDecay(dev, (i - 1) * stepMinutes, i * stepMinutes);
    const next = stepMoodDecayLedger({
      previous: state,
      perTickValence: perTick,
      perTickArousal: 0,
      directionValence: dev,
      directionArousal: 0,
      now: at(i * stepMinutes),
    });
    if (next.decay) decays.push({ minutes: i * stepMinutes, deltaValence: next.decay.deltaValence });
    state = next;
  }
  return { state, decays };
}

describe("stepMoodDecayLedger：累计纯衰减量", () => {
  it("首次只起算不记账：累计量是正的小数，decay 为 null", () => {
    const step = stepMoodDecayLedger({
      previous: EMPTY,
      perTickValence: 0.0007,
      perTickArousal: 0.0002,
      directionValence: -0.4,
      directionArousal: 0,
      now: at(0),
    });
    expect(step.decay).toBeNull();
    expect(step.pendingValence).toBeCloseTo(0.0007, 9);
    expect(step.pendingArousal).toBeCloseTo(0.0002, 9);
    expect(step.since).toBe(at(0));
  });

  it("70.6 小时空档（423 个 10 分钟 tick）必须记出累计衰减，幅度是跨 tick 的累计值", () => {
    const { decays } = runTicks(-0.4, 423);
    expect(decays.length).toBeGreaterThanOrEqual(1);
    const biggest = Math.max(...decays.map((d) => Math.abs(d.deltaValence)));
    expect(biggest).toBeGreaterThan(0.02);
    expect(biggest).toBeGreaterThan(10 * 7e-4);
    const total = decays.reduce((sum, d) => sum + Math.abs(d.deltaValence), 0);
    expect(total).toBeGreaterThan(0.1);
  });

  it("攒不够阈值时继续累计、起算时刻不变（不是每 tick 重置）", () => {
    const first = stepMoodDecayLedger({
      previous: EMPTY, perTickValence: 0.001, perTickArousal: 0,
      directionValence: -0.4, directionArousal: 0, now: at(0),
    });
    const second = stepMoodDecayLedger({
      previous: first, perTickValence: 0.001, perTickArousal: 0,
      directionValence: -0.4, directionArousal: 0, now: at(10),
    });
    expect(second.decay).toBeNull();
    expect(second.pendingValence).toBeCloseTo(0.002, 9);
    expect(second.since).toBe(at(0));
  });

  it("攒够后落一行并把累计清零、起算推到此刻；方向按偏离符号（向基线退）", () => {
    const step = stepMoodDecayLedger({
      previous: { pendingValence: 0.018, pendingArousal: 0, since: at(0) },
      perTickValence: 0.003,
      perTickArousal: 0,
      directionValence: -0.4,
      directionArousal: 0,
      now: at(600),
    });
    // 偏离为负（心境比基线低）：衰减把它往基线推 = valence 变大，delta 为正。
    expect(step.decay?.deltaValence).toBeCloseTo(0.021, 6);
    expect(step.decay?.hours).toBeCloseTo(10, 6);
    expect(step.pendingValence).toBe(0);
    expect(step.since).toBe(at(600));

    // 偏离为正时方向相反：delta 必须变负，不能把两边写成同一个符号。
    const positive = stepMoodDecayLedger({
      previous: { pendingValence: 0.018, pendingArousal: 0, since: at(0) },
      perTickValence: 0.003,
      perTickArousal: 0,
      directionValence: 0.4,
      directionArousal: 0,
      now: at(600),
    });
    expect(positive.decay?.deltaValence).toBeCloseTo(-0.021, 6);
  });

  it("自我调节的拉回不算衰减：本 tick 纯衰减为 0 时一行都不记（24 tick 反例的机制）", () => {
    let state = { pendingValence: null as number | null, pendingArousal: null as number | null, since: null as string | null };
    let rows = 0;
    for (let i = 0; i < 24; i += 1) {
      const step = stepMoodDecayLedger({
        previous: state,
        perTickValence: 0,
        perTickArousal: 0,
        directionValence: -0.4,
        directionArousal: 0,
        now: at(i * 10),
      });
      if (step.decay) rows += 1;
      state = { pendingValence: step.pendingValence, pendingArousal: step.pendingArousal, since: step.since };
    }
    expect(rows).toBe(0);
  });

  it("阈值可配：minDrop 调大后同样的累计不再记账（判据不是写死的）", () => {
    const previous = { pendingValence: 0.018, pendingArousal: 0, since: at(0) };
    const strict = stepMoodDecayLedger({
      previous, perTickValence: 0.003, perTickArousal: 0,
      directionValence: -0.4, directionArousal: 0, now: at(600), minDrop: 0.5,
    });
    expect(strict.decay).toBeNull();
    const loose = stepMoodDecayLedger({
      previous, perTickValence: 0.003, perTickArousal: 0,
      directionValence: -0.4, directionArousal: 0, now: at(600), minDrop: MOOD_DECAY_LEDGER_MIN_DROP,
    });
    expect(loose.decay).not.toBeNull();
  });
});
