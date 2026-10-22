/**
 * #88 · short-intent 纯函数契约（短消息三分判据，2026-10-22 定案）。
 *
 * S1 延续/确认类：词表命中 → continuation（不独立召回，意图=last-known，去重闸裁决）；
 * S2 可检索短新意图：非词表且（实义残差 ≥ 2 或含 ASCII/数字实体）→ retrievable（正常召回）；
 * S3 纯指令短消息：实义残差 < 2 且无 ASCII/数字实体 → command（不召回 + 焦点切换 + 记账）。
 * 判序从严、默认放行、不全拦（宁漏勿杀）。
 * RED 形态：模块尚不存在——import 失败即 feature-missing RED。
 */
import { describe, expect, it } from "vitest";
import { classifyShortIntent, CONTINUATION_WORDS, normalizeIntentText } from "../short-intent.js";

describe("#88 · normalizeIntentText（归一化：小写+全角转半角+叠字折叠+去尾标点）", () => {
  it("去尾标点与首尾空白", () => {
    expect(normalizeIntentText("好的！")).toBe("好的");
    expect(normalizeIntentText("继续。")).toBe("继续");
    expect(normalizeIntentText("  行？  ")).toBe("行");
  });

  it("全角转半角 + 小写", () => {
    expect(normalizeIntentText("ＯＫ")).toBe("ok");
    expect(normalizeIntentText("Next！")).toBe("next");
  });

  it("叠字折叠（相邻同字折叠为一）", () => {
    expect(normalizeIntentText("嗯嗯")).toBe("嗯");
    expect(normalizeIntentText("好好")).toBe("好");
  });
});

describe("#88 · classifyShortIntent（S1/S2/S3 三分判据）", () => {
  it("S1 词表命中 → continuation（归一化后精确匹配）", () => {
    for (const w of ["继续", "好的", "嗯", "行", "可以", "对", "是", "收到", "明白", "ok", "go", "next", "没问题", "好哒"]) {
      expect(classifyShortIntent(normalizeIntentText(w)), w).toBe("continuation");
    }
    expect(CONTINUATION_WORDS.size).toBeGreaterThan(10);
  });

  it("S2 短新意图（残差≥2）→ retrievable", () => {
    expect(classifyShortIntent(normalizeIntentText("换北京"))).toBe("retrievable");
    expect(classifyShortIntent(normalizeIntentText("撤回上一步"))).toBe("retrievable");
  });

  it("S2 含 ASCII/数字实体 → retrievable（v3/R71 类短 token 不被杀）", () => {
    expect(classifyShortIntent(normalizeIntentText("v3"))).toBe("retrievable");
    expect(classifyShortIntent(normalizeIntentText("666"))).toBe("retrievable");
    expect(classifyShortIntent(normalizeIntentText("a"))).toBe("retrievable");
  });

  it("S3 纯指令（残差<2 且无 ASCII/数字实体）→ command", () => {
    for (const w of ["停", "撤", "？", "。", "哦", "？？"]) {
      expect(classifyShortIntent(normalizeIntentText(w)), w).toBe("command");
    }
  });

  it("空串/纯空白 → command", () => {
    expect(classifyShortIntent(normalizeIntentText("   "))).toBe("command");
  });
});
