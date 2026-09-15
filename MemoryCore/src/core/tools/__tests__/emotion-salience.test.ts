/** GROW-EVO P3 R10：emotionSalienceOf 纯函数 + 缺省恒等契约（§3.2）。 */
import { describe, expect, it } from "vitest";
import { emotionSalienceOf, DEFAULT_RANK_SIGNALS, ZERO_RANK_SIGNALS } from "../recall-signals.js";

describe("GROW-EVO P3 R10 emotionSalienceOf", () => {
  it("|valence| × arousal：负 valence 取绝对值", () => {
    expect(emotionSalienceOf({ valence: -0.8, arousal: 0.5 })).toBeCloseTo(0.4, 10);
    expect(emotionSalienceOf({ valence: 0.8, arousal: 0.5 })).toBeCloseTo(0.4, 10);
  });
  it("缺字段 / undefined → 0", () => {
    expect(emotionSalienceOf(undefined)).toBe(0);
    expect(emotionSalienceOf({})).toBe(0);
    expect(emotionSalienceOf({ valence: 0.8 })).toBe(0);
  });
  it("越界 clamp：valence 2 → 1、arousal 3 → 1", () => {
    expect(emotionSalienceOf({ valence: 2, arousal: 3 })).toBe(1);
  });
  it("双 0 恒 0（中性记忆无情感显著度）", () => {
    expect(emotionSalienceOf({ valence: 0, arousal: 0.9 })).toBe(0);
  });
  it("缺省恒等契约：DEFAULT/ZERO 的 emotionSalienceWeight = 0", () => {
    expect(DEFAULT_RANK_SIGNALS.emotionSalienceWeight).toBe(0);
    expect(ZERO_RANK_SIGNALS.emotionSalienceWeight).toBe(0);
  });
});