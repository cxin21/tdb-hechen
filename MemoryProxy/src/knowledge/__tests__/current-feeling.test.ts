import { describe, expect, it } from "vitest";
import { renderCurrentFeeling } from "../current-feeling.js";

const CFG = { enabled: true, values: [{ id: "perf", label: "性能", weight: 0.8 }], firedThreshold: 0.4 };

describe("K/L renderCurrentFeeling（MemoryProxy 注入）", () => {
  it("命中 → 输出短块", () => {
    const block = renderCurrentFeeling("这块性能太差", CFG);
    expect(block).toContain("<current_feeling>");
    expect(block).toContain("性能");
  });

  it("不命中 → 空串（宁缺毋滥）", () => {
    expect(renderCurrentFeeling("写个 hello", CFG)).toBe("");
  });

  it("disabled/无值 → 空串", () => {
    expect(renderCurrentFeeling("性能", { ...CFG, enabled: false })).toBe("");
    expect(renderCurrentFeeling("性能", { ...CFG, values: [] })).toBe("");
  });

  it("label 命中但权重低于门槛 → 空串", () => {
    expect(renderCurrentFeeling("性能", { enabled: true, values: [{ id: "a", label: "性能", weight: 0.2 }], firedThreshold: 0.4 })).toBe("");
  });
});

describe("C2 动机方向：三态方向行（spec §3.3）", () => {
  const cfg = (values: Array<{ id: string; label: string; weight: number; valence?: number | null }>) => ({
    enabled: true,
    firedThreshold: 0.4,
    values,
  });

  it("valence>0 → 本轮方向：围绕【…】推进", () => {
    const block = renderCurrentFeeling("怎么保证正确", cfg([{ id: "c", label: "正确", weight: 0.9, valence: 1 }]));
    expect(block).toContain("本轮方向：围绕【正确】推进");
  });

  it("valence<0 → 本轮方向：对【…】保持审慎", () => {
    const block = renderCurrentFeeling("这个风险大吗", cfg([{ id: "r", label: "风险", weight: 0.9, valence: -1 }]));
    expect(block).toContain("本轮方向：对【风险】保持审慎");
  });

  it("混合（同轮命中正负）→ 两行并列（不合成）", () => {
    const block = renderCurrentFeeling("正确和风险都要考虑", cfg([
      { id: "c", label: "正确", weight: 0.9, valence: 1 },
      { id: "r", label: "风险", weight: 0.9, valence: -1 },
    ]));
    expect(block).toContain("本轮方向：围绕【正确】推进");
    expect(block).toContain("本轮方向：对【风险】保持审慎");
  });

  it("valence=0 / NULL / 缺省 → 不输出方向行（宁缺毋滥 + D1 兜底）", () => {
    const zero = renderCurrentFeeling("聊聊中性", cfg([{ id: "n", label: "中性", weight: 0.9, valence: 0 }]));
    expect(zero).not.toContain("本轮方向");
    expect(zero).toContain("中性(n)");
    const nullV = renderCurrentFeeling("聊聊正确", cfg([{ id: "c", label: "正确", weight: 0.9, valence: null }]));
    expect(nullV).not.toContain("本轮方向");
    // 存量兼容：config.yaml fallback 值没有 valence 字段
    const noField = renderCurrentFeeling("聊聊性能", cfg([{ id: "p", label: "性能", weight: 0.9 }]));
    expect(noField).not.toContain("本轮方向");
    expect(noField).toContain("性能(p)");
  });

  it("方向行只含 fired 的值（未命中价值不进方向行）", () => {
    const block = renderCurrentFeeling("聊聊正确", cfg([
      { id: "c", label: "正确", weight: 0.9, valence: 1 },
      { id: "r", label: "风险", weight: 0.9, valence: -1 },
    ]));
    expect(block).toContain("围绕【正确】推进");
    expect(block).not.toContain("对【风险】保持审慎");
  });
});