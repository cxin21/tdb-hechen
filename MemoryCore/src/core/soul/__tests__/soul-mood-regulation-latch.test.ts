import { describe, expect, it } from "vitest";
import {
  MOOD_REGULATION_HYSTERESIS,
  MOOD_REGULATION_TRIGGER,
  integrateMood,
  isMoodRegulationEntry,
  regulateMood,
  type EmotionEvent,
  type MoodState,
} from "../emotion.js";

function devOf(m: MoodState): number {
  return Math.max(
    Math.abs(m.valence - m.baselineValence),
    Math.abs(m.arousal - m.baselineArousal),
  );
}

function emptyMood(now: string): MoodState {
  return {
    valence: 0,
    arousal: 0.3,
    baselineValence: 0,
    baselineArousal: 0.3,
    updatedAt: now,
    sampleCount: 1,
  };
}

function stimulus(now: string): EmotionEvent {
  return {
    valence: 0.6,
    arousal: 0.4,
    dominance: 0.5,
    intensity: 1,
    halfLifeHours: 48,
    at: now,
  } as unknown as EmotionEvent;
}

const FLOOR = MOOD_REGULATION_TRIGGER - MOOD_REGULATION_HYSTERESIS;

describe("心境「进入调节」的回滞判定（a2 Round21 CP2，r73-a2b 复投后改为带宽语义）", () => {
  it("从带宽下方越线 → 记一笔（含 r73-a2b 实测的 0.293 → 0.435 穿越点）", () => {
    expect(isMoodRegulationEntry(0.1, MOOD_REGULATION_TRIGGER)).toBe(true);
    expect(isMoodRegulationEntry(0.0, 0.9)).toBe(true);
    expect(isMoodRegulationEntry(FLOOR - 0.001, 0.5)).toBe(true);
    // 真实 integrateMood 的先验权重约 0.998，渐进升温就是这么跨过去的：旧实现（下限 0.25）在这里一次都不记。
    expect(isMoodRegulationEntry(0.293, 0.435)).toBe(true);
  });

  it("还在带宽内 / 已经在调节中 → 不重复记", () => {
    expect(isMoodRegulationEntry(FLOOR, 0.5)).toBe(false);
    expect(isMoodRegulationEntry(0.34, 0.36)).toBe(false);
    expect(isMoodRegulationEntry(0.58, 0.534)).toBe(false);
  });

  it("没越线就不算进入（哪怕上一轮很低）", () => {
    expect(isMoodRegulationEntry(0.0, MOOD_REGULATION_TRIGGER - 0.001)).toBe(false);
  });

  it("坏输入按 0 处理，阈值/带宽可覆盖且带宽夹在 [0,1]", () => {
    expect(isMoodRegulationEntry(Number.NaN, 0.5)).toBe(true);
    expect(isMoodRegulationEntry(0.05, 0.6, { trigger: 0.5, hysteresis: 0.1 })).toBe(true);
    // 带宽大于 trigger：下限被夹到 0，只有「上一轮正好是 0」才算重新进入。
    expect(isMoodRegulationEntry(0.2, 0.6, { trigger: 0.5, hysteresis: 2 })).toBe(false);
  });

  it("真实 integrateMood + regulateMood：渐进升温（每 2 tick 一次强刺激）也要记到进入，且不逐 tick 刷行", () => {
    let nowMs = Date.parse("2026-11-19T00:00:00.000Z");
    let mood = emptyMood(new Date(nowMs).toISOString());
    let entries = 0;
    let appliedTicks = 0;
    let crossingTicks = 0;
    for (let i = 0; i < 36; i += 1) {
      nowMs += 600_000;
      const now = new Date(nowMs).toISOString();
      const prevDev = devOf(mood);
      const events = i % 2 === 0 ? [stimulus(now)] : [];
      const integrated = integrateMood(mood, events, now, { moodHalfLifeHours: 48 });
      const curDev = devOf(integrated);
      const reg = regulateMood(integrated);
      mood = { ...reg.mood, updatedAt: now };
      if (reg.applied) appliedTicks += 1;
      if (curDev >= MOOD_REGULATION_TRIGGER && prevDev < FLOOR) crossingTicks += 1;
      if (reg.applied && isMoodRegulationEntry(prevDev, curDev)) entries += 1;
    }
    expect(appliedTicks).toBeGreaterThan(0);
    // 关键：渐进升温确实发生了跨线（否则这个用例什么也没证明）。
    expect(crossingTicks).toBeGreaterThanOrEqual(1);
    expect(entries).toBeGreaterThanOrEqual(1);
    expect(entries).toBeLessThanOrEqual(3);
    expect(appliedTicks).toBeGreaterThan(entries);
  });

  it("贴着阈值来回抖（每 2 tick 0.2 刺激）：只记进入，不逐 tick 刷行", () => {
    let nowMs = Date.parse("2026-11-19T00:00:00.000Z");
    let mood = emptyMood(new Date(nowMs).toISOString());
    let entries = 0;
    let appliedTicks = 0;
    for (let i = 0; i < 36; i += 1) {
      nowMs += 600_000;
      const now = new Date(nowMs).toISOString();
      const prevDev = devOf(mood);
      const bumped: MoodState = { ...mood, valence: Math.min(1, mood.valence + (i % 2 === 0 ? 0.2 : 0)) };
      const reg = regulateMood(bumped);
      const curDev = devOf(bumped);
      mood = { ...reg.mood, updatedAt: now };
      if (reg.applied) appliedTicks += 1;
      if (reg.applied && isMoodRegulationEntry(prevDev, curDev)) entries += 1;
    }
    expect(appliedTicks).toBeGreaterThan(entries);
    expect(entries).toBeGreaterThanOrEqual(1);
    expect(entries).toBeLessThanOrEqual(3);
  });
});
