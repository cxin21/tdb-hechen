/**
 * S5 验收（判据 10 / §6）：基线 EMA、无情绪时的底子行三档、情绪对象锚过期保留、门只观测不否决。
 */
import { describe, expect, it } from "vitest";

import { baselineToneOf, emptyMood, integrateMood, renderMoodLine } from "../emotion.js";
import { BASELINE_EMA_ALPHA } from "../traits.js";

const NOW = "2026-11-07T12:00:00.000Z";
const CFG = { moodHalfLifeHours: 48 };

describe("基线 EMA（α=0.02）", () => {
  it("单次事件只把基线挪 α·Δ：0 → 0.5 得 0.01", () => {
    const mood = integrateMood(
      { ...emptyMood("2026-11-07T11:00:00.000Z"), sampleCount: 1 },
      [{ id: "e1", at: NOW, object: "假绿", label: "恼火", valence: -1, arousal: 0.5, intensity: 1 } as never],
      NOW,
      CFG,
    );
    expect(BASELINE_EMA_ALPHA).toBe(0.02);
    // 先验 1h 衰减后仍带旧值 0；事件权重 1 → valence≈-0.5（先验也占权重 1），
    // 基线挪 α·Δ = 0.02 × (-0.5) ≈ -0.0101（不是 -0.02：Δ 是心境变化量，不是事件值）
    expect(mood.baselineValence).toBeCloseTo(-0.01, 3);
    expect(Math.abs(mood.baselineValence)).toBeLessThan(0.05);
  });

  it("连续同向事件：基线单调向该方向走，但远慢于心境本身", () => {
    let mood = { ...emptyMood("2026-11-07T10:00:00.000Z"), sampleCount: 1 };
    const event = [{ id: "e1", at: NOW, object: "假绿", label: "恼火", valence: 1, arousal: 0.5, intensity: 1 } as never];
    for (let i = 0; i < 10; i += 1) mood = integrateMood(mood, event, NOW, CFG);
    expect(mood.baselineValence).toBeGreaterThan(0.15);
    expect(mood.baselineValence).toBeLessThan(mood.valence);
  });
});

describe("底子行三档（0.15 / 0.4）", () => {
  const moodAt = (dv: number) => ({ ...emptyMood(NOW), valence: dv, baselineValence: 0 });

  it("|Δ| ≤ 0.15 → 平静；0.15–0.4 → 偏；> 0.4 → 很强", () => {
    expect(baselineToneOf(moodAt(0.1))).toEqual({ tier: "calm", text: "底子平静" });
    expect(baselineToneOf(moodAt(-0.15))).toEqual({ tier: "calm", text: "底子平静" });
    expect(baselineToneOf(moodAt(0.25))).toEqual({ tier: "lean", text: "底子偏积极" });
    expect(baselineToneOf(moodAt(-0.4))).toEqual({ tier: "lean", text: "底子偏沉" });
    expect(baselineToneOf(moodAt(0.5))).toEqual({ tier: "strong", text: "底子很积极" });
    expect(baselineToneOf(moodAt(-0.7))).toEqual({ tier: "strong", text: "底子很沉" });
  });

  it("无存活情绪时 renderMoodLine 输出底子行，不留空白", () => {
    const line = renderMoodLine(moodAt(0.1));
    expect(line).toContain("近期心境：底子平静。");
    expect(renderMoodLine(moodAt(-0.5))).toContain("底子很沉");
  });

  it("对象不可复用（如「这件事」）也不写原因，退回底子行", () => {
    const line = renderMoodLine(moodAt(0.2), { emotion: { object: "这件事", label: "恼火", effectiveIntensity: 0.8 } });
    expect(line).toContain("底子偏积极");
    expect(line).not.toContain("因为");
  });
});
