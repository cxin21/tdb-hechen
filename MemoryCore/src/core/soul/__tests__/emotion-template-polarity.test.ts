import { describe, expect, it } from "vitest";
import { EMOTION_LABELS, emotionTemplateOf } from "../emotion.js";

/**
 * 模板 D 轴极性的守卫（spec v4 §P3-H）。
 *
 * 背景：调研文档曾断言「我们 24 条模板 D 全部 ≥0.2，而 ALMA 负性情绪 D 为负，所以极性写错」。
 * 复核发现是量纲误读——我们存 0..1（0.5 中性），ALMA 用 −1..1。换算后 23/24 与 ALMA 同向，
 * 唯一的「负效价 + 正支配」是「恼火」，与 ALMA 的 Anger(+0.25) 一致，属正确行为。
 *
 * 这条测试锁住的是「换算到 −1..1 之后仍然成立的极性」，不是「全部为负」：
 *  - 负效价：d_pad ≤ 0.25（给 Anger 一族留出 ALMA 的 +0.25 上限）
 *  - 正效价：d_pad ≥ −0.15（给「感激」这类受惠于人的低支配留边缘）
 * 一旦有人按错误结论把 D 全改成负，正效价那一半会先红。
 */
const toPad = (d01: number) => 2 * d01 - 1;

describe("情绪模板的 D 轴极性（§P3-H）", () => {
  it("24 条模板全部可查、标签唯一", () => {
    expect(EMOTION_LABELS.length).toBe(24);
    expect(new Set(EMOTION_LABELS).size).toBe(24);
    for (const label of EMOTION_LABELS) expect(emotionTemplateOf(label)?.label).toBe(label);
  });

  it("负效价的 D 不高于 +0.25、正效价的 D 不低于 −0.15（换算到 −1..1）", () => {
    const violations: string[] = [];
    for (const label of EMOTION_LABELS) {
      const t = emotionTemplateOf(label)!;
      const d = toPad(t.dominance);
      if (t.valence < 0 && d > 0.25) violations.push(`${label}: v=${t.valence} d_pad=${d.toFixed(2)}`);
      if (t.valence > 0 && d < -0.15) violations.push(`${label}: v=${t.valence} d_pad=${d.toFixed(2)}`);
    }
    expect(violations).toEqual([]);
  });

  it("负效价里唯一的高支配只能是「恼火」（与 ALMA Anger +0.25 对齐）", () => {
    const highDominanceNegative = EMOTION_LABELS.map((l) => emotionTemplateOf(l)!).filter(
      (t) => t.valence < 0 && toPad(t.dominance) > 0.1,
    );
    expect(highDominanceNegative.map((t) => t.label)).toEqual(["恼火"]);
  });
});
