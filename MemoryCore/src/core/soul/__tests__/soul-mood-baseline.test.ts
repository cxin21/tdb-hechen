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
      // Round13：基线 EMA 按墙钟 dt 折算，这里让上一轮正好早 10 分钟（参考节拍），α 仍 = 0.02。
      { ...emptyMood("2026-11-07T11:50:00.000Z"), sampleCount: 1 },
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
    // halfLifeHours 必填：dt>0 时 decayedIntensity 用它算权重，缺了会被当成 NaN→0（时间推进后就整条丢失）。
    const event = [{ id: "e1", at: NOW, object: "假绿", label: "恼火", valence: 1, arousal: 0.5, intensity: 1, halfLifeHours: 3 } as never];
    // 每次隔 10 分钟（参考节拍）：10 轮 = 100 分钟墙钟，基线推进 1-0.98^10 ≈ 18%。
    for (let i = 0; i < 10; i += 1) {
      const tick = new Date(Date.parse(NOW) + (i + 1) * 10 * 60_000).toISOString();
      mood = integrateMood(mood, event, tick, CFG);
    }
    expect(mood.baselineValence).toBeGreaterThan(0.15);
    expect(mood.baselineValence).toBeLessThan(mood.valence);
  });
});

describe("底子行四档（0.10 / 0.25 / 0.45）", () => {
  const moodAt = (dv: number) => ({ ...emptyMood(NOW), valence: dv, baselineValence: 0, sampleCount: 1 });

  it("sampleCount=0 不写「底子平静」：没样本与平静是两件事（A2 Round9）", () => {
    const blank = { ...emptyMood(NOW), valence: 0, baselineValence: 0, sampleCount: 0 };
    expect(baselineToneOf(blank)).toEqual({ tier: "calm", text: "还没有形成可说的底子" });
    expect(renderMoodLine(blank)).toContain("近期心境：还没有形成可说的底子。");
    expect(renderMoodLine(blank)).not.toContain("底子平静");
  });

  it("|Δ| ≤ 0.10 → 平静；≤ 0.25 → 略偏；≤ 0.45 → 偏；> 0.45 → 很", () => {
    expect(baselineToneOf(moodAt(0.1))).toEqual({ tier: "calm", text: "底子平静" });
    expect(baselineToneOf(moodAt(-0.15))).toEqual({ tier: "slight", text: "底子略偏沉" });
    expect(baselineToneOf(moodAt(0.25))).toEqual({ tier: "slight", text: "底子略偏积极" });
    expect(baselineToneOf(moodAt(-0.4))).toEqual({ tier: "lean", text: "底子偏沉" });
    expect(baselineToneOf(moodAt(0.5))).toEqual({ tier: "strong", text: "底子很积极" });
    expect(baselineToneOf(moodAt(-0.7))).toEqual({ tier: "strong", text: "底子很沉" });
  });

  it("R28：valence 全量程里至少读出 7 种不同底子（可判读粒度下限，r28f-a2 CP1）", () => {
    const seen = new Set<string>();
    for (let v = -0.9; v <= 0.9001; v += 0.01) {
      seen.add(baselineToneOf(moodAt(Number(v.toFixed(2)))).text);
    }
    // 三档时代这里只有 5 种（含「底子平静」），读侧看不出 0.2 与 0.4 的差别。
    expect(seen.size).toBeGreaterThanOrEqual(7);
  });

  it("无存活情绪时 renderMoodLine 输出底子行，不留空白", () => {
    const line = renderMoodLine(moodAt(0.1));
    expect(line).toContain("近期心境：底子平静。");
    expect(renderMoodLine(moodAt(-0.5))).toContain("底子很沉");
  });

  it("对象不可复用（如「这件事」）也不写原因，退回底子行", () => {
    const line = renderMoodLine(moodAt(0.2), { emotion: { object: "这件事", label: "恼火", effectiveIntensity: 0.8 } });
    expect(line).toContain("底子略偏积极");
    expect(line).not.toContain("因为");
  });

  it("样本数是累计量：空轮不把「有底子」读成「还没有底子」（A2 Round24）", () => {
    const prev = { ...emptyMood("2026-11-07T11:50:00.000Z"), valence: -0.32, baselineValence: -0.1, sampleCount: 4 };
    const noEvents = integrateMood(prev, [], NOW, CFG);
    // 旧写法按轮覆盖成 events.length=0 → 底子行翻回「还没有形成可说的底子」，与上一轮自相矛盾。
    expect(noEvents.sampleCount).toBe(4);
    expect(baselineToneOf(noEvents)).toEqual({ tier: "slight", text: "底子略偏沉" });
    const withEvent = integrateMood(
      prev,
      [{ id: "e9", at: NOW, object: "假绿", label: "恼火", valence: -1, arousal: 0.4, intensity: 1, halfLifeHours: 3 } as never],
      NOW,
      CFG,
    );
    expect(withEvent.sampleCount).toBe(5);
  });
});
