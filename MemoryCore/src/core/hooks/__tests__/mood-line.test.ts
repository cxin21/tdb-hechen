/**
 * M1-S2（S-FEEL-1）：mood-line 纯函数 RED 套件（≥8 用例，M1 计划 S2）。
 *
 * 设计依据：DS-SOUL-EVOLUTION-001 §1.2（公式逐字）/§1.6 验收：
 *   w_i=2^(-age_hours_i/halfLifeHours)；mood_valence=clamp(Σ(v·w)/Σw, -1, 1)；三档映射 ±0.15（cfg 阈值）。
 *   确定性：同输入逐字节同输出；nowMs 必须注入（禁 Date.now() 内联）。
 *   单一源：computeMoodValence 导出供任务 2（R10）复用——禁第二份加权实现。
 *   红线 R-A：mood 不参与召回排序——本模块只有聚合与映射，无任何排序/加权召回接口。
 */
import { describe, expect, it } from "vitest";
import { computeMoodTier, computeMoodValence, type MoodSample } from "../mood-line.js";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const iso = (hoursBefore: number): string => new Date(NOW - hoursBefore * 3600e3).toISOString();
const s = (valence: number, hoursBefore: number, occurredAt?: string): MoodSample => ({
  valence,
  arousal: null,
  occurred_at: occurredAt ?? iso(hoursBefore),
});
const cfg = (over: Partial<Parameters<typeof computeMoodTier>[1]> = {}) => ({
  minSamples: 1, maxSamples: 20, posThreshold: 0.15, negThreshold: -0.15, halfLifeHours: 48, nowMs: NOW, ...over,
});

describe("M1-S2 mood-line：computeMoodValence 加权聚合（单一源）", () => {
  it("④ 半衰期加权正确性：2 样本手算期望 0.1333（±0.001 容差）", () => {
    // s1: age=48h → w=2^(-1)=0.5, valence 0.8；s2: age=0 → w=1, valence -0.2
    // mood = (0.8*0.5 + (-0.2)*1) / (0.5+1) = 0.2/1.5 = 0.133333…
    const mood = computeMoodValence([s(0.8, 48), s(-0.2, 0)], { halfLifeHours: 48, nowMs: NOW });
    expect(mood).not.toBeNull();
    expect(mood as number).toBeGreaterThan(0.13333 - 0.001);
    expect(mood as number).toBeLessThan(0.13333 + 0.001);
  });

  it("④b 半衰期翻倍减权：age=halfLife 样本权重恰为一半（同 valence 双样本对照）", () => {
    const m = computeMoodValence([s(0.6, 0), s(0.6, 48)], { halfLifeHours: 48, nowMs: NOW });
    // (0.6*1 + 0.6*0.5)/1.5 = 0.6
    expect(m as number).toBeCloseTo(0.6, 6);
  });

  it("⑦ clamp：全 ±1 样本聚合值不越界（恒等于边界）", () => {
    expect(computeMoodValence([s(1, 0), s(1, 10), s(1, 30)], { halfLifeHours: 48, nowMs: NOW })).toBe(1);
    expect(computeMoodValence([s(-1, 0), s(-1, 10)], { halfLifeHours: 48, nowMs: NOW })).toBe(-1);
  });

  it("非法样本防御：NaN valence / 非法 occurred_at / 未来时间戳按 0 龄", () => {
    // NaN valence + 非法时间样本被过滤；唯一合法样本 valence 0.3 age 0 → 0.3
    expect(computeMoodValence([s(NaN, 0), { valence: 0.5, arousal: null, occurred_at: "not-a-date" }, s(0.3, 0)], { halfLifeHours: 48, nowMs: NOW })).toBeCloseTo(0.3, 9);
    // 未来时间戳（occurred_at > now）age 取 0，不放大权重
    expect(computeMoodValence([s(0.5, -2)], { halfLifeHours: 48, nowMs: NOW })).toBeCloseTo(0.5, 9);
    // 全非法 → null
    expect(computeMoodValence([s(NaN, 0), { valence: 0.5, arousal: null, occurred_at: "bad" }], { halfLifeHours: 48, nowMs: NOW })).toBeNull();
  });
});

describe("M1-S2 mood-line：computeMoodTier 三档映射（降级+边界+确定性）", () => {
  it("① 空数组 → tier=null、sampleCount=0（基调行省略）", () => {
    expect(computeMoodTier([], cfg())).toEqual({ tier: null, sampleCount: 0 });
  });

  it("② 样本数 < minSamples → null（宁缺毋滥）", () => {
    const r = computeMoodTier([s(0.5, 1), s(0.6, 2)], cfg({ minSamples: 5 }));
    expect(r.tier).toBeNull();
    expect(r.sampleCount).toBe(2);
  });

  it("③ 全非法 valence 过滤后不足 minSamples → null", () => {
    const r = computeMoodTier([s(NaN, 1), { valence: 0.4, arousal: null, occurred_at: "bad" }], cfg({ minSamples: 5 }));
    expect(r.tier).toBeNull();
    expect(r.sampleCount).toBe(0);
  });

  it("⑤ 恰 +0.15 → positive（边界含）；⑥ 恰 −0.15 → strained（边界含）", () => {
    expect(computeMoodTier([s(0.15, 0)], cfg()).tier).toBe("positive");
    expect(computeMoodTier([s(-0.15, 0)], cfg()).tier).toBe("strained");
    expect(computeMoodTier([s(0.14, 0)], cfg()).tier).toBe("neutral");
    expect(computeMoodTier([s(-0.14, 0)], cfg()).tier).toBe("neutral");
  });

  it("⑧ 确定性：同输入两次调用逐字节同输出（nowMs 注入，禁内联时钟）", () => {
    const samples = [s(0.7, 1), s(-0.3, 5), s(0.1, 30), s(0.9, 60), s(-0.8, 70)];
    const a = computeMoodTier(samples, cfg({ minSamples: 5 }));
    const b = computeMoodTier(samples, cfg({ minSamples: 5 }));
    expect(b).toEqual(a);
    expect(["positive", "neutral", "strained", null]).toContain(a.tier);
  });

  it("maxSamples 截断：输入按 occurred_at DESC（store 契约），取前 maxSamples 条", () => {
    const samples = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3].map((v, i) => s(v, i + 1));
    const r = computeMoodTier(samples, cfg({ maxSamples: 5, minSamples: 3 }));
    expect(r.sampleCount).toBe(5);
  });

  it("加权主档：近期正向样本占优 → positive（半衰期生效的语义校验）", () => {
    // 近期（1h/2h）正向 0.8/0.7，远期（200h）负向 -0.9：加权后应为正 → positive
    const r = computeMoodTier([s(0.8, 1), s(0.7, 2), s(-0.9, 200), s(-0.9, 220), s(-0.9, 240)], cfg({ minSamples: 5 }));
    expect(r.tier).toBe("positive");
  });
});
