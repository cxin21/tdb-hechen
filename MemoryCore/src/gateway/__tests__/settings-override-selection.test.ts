/**
 * #179 S5 — settings override 链新增 layerRuler / injection 两段单测。
 * 镜像 settings-override.importance.test.ts 的模式：
 * - 形状校验在 override 层，clamp / 缺省语义在 parseConfig（与 rerank 同口径）；
 * - apply*OverrideToRaw 必须在 parseConfig 之前并入 raw。
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";
import { applyInjectionOverrideToRaw, applyLayerRulerOverrideToRaw, validateOverride } from "../settings-override.js";

describe("validateOverride layerRuler / injection 段（#179 S5）", () => {
  it("合法字段原样透传", () => {
    const v = validateOverride({
      layerRuler: {
        mode: "enforce",
        keepRatio: 0.5,
        minPerLayer: 2,
        floor: { model: "doubao-embedding-vision", dims: 2048, value: 0.31 },
      },
      injection: { foldIdentical: true, budgetByIntent: { empty: 0, continuation: 1, self: 1, info: null } },
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.layerRuler).toEqual({
        mode: "enforce",
        keepRatio: 0.5,
        minPerLayer: 2,
        floor: { model: "doubao-embedding-vision", dims: 2048, value: 0.31 },
      });
      expect(v.value.injection).toEqual({
        foldIdentical: true,
        budgetByIntent: { empty: 0, continuation: 1, self: 1, info: null },
      });
    }
  });

  it("floor:null 透传（= 显式取消地板）", () => {
    const v = validateOverride({ layerRuler: { floor: null } });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.layerRuler).toEqual({ floor: null });
  });

  it("mode 白名单 / keepRatio 区间 / minPerLayer 整数 / floor 字段 / budget 非负 —— 非法即报错", () => {
    const badMode = validateOverride({ layerRuler: { mode: "on" } });
    expect(badMode.ok).toBe(false);
    if (!badMode.ok) expect(badMode.errors.some((e) => e.includes("layerRuler.mode"))).toBe(true);

    const badRatio = validateOverride({ layerRuler: { keepRatio: 0 } });
    expect(badRatio.ok).toBe(false);
    if (!badRatio.ok) expect(badRatio.errors.some((e) => e.includes("keepRatio"))).toBe(true);

    const badMin = validateOverride({ layerRuler: { minPerLayer: 0 } });
    expect(badMin.ok).toBe(false);
    if (!badMin.ok) expect(badMin.errors.some((e) => e.includes("minPerLayer"))).toBe(true);

    const badFloor = validateOverride({ layerRuler: { floor: { model: "", dims: 0, value: 2 } } });
    expect(badFloor.ok).toBe(false);

    const badBudget = validateOverride({ injection: { budgetByIntent: { info: -1 } } });
    expect(badBudget.ok).toBe(false);
    if (!badBudget.ok) expect(badBudget.errors.some((e) => e.includes("budgetByIntent.info"))).toBe(true);

    const badFold = validateOverride({ injection: { foldIdentical: "yes" } });
    expect(badFold.ok).toBe(false);
    if (!badFold.ok) expect(badFold.errors.some((e) => e.includes("foldIdentical"))).toBe(true);
  });
});

const baseRaw = {
  recall: {
    layerRuler: { mode: "off", keepRatio: 0.67, minPerLayer: 1, floor: null },
    injection: { foldIdentical: false, budgetByIntent: { empty: null, continuation: null, self: null, info: null } },
  },
};

describe("apply*OverrideToRaw（#179 S5）", () => {
  it("layerRuler 并入 raw 后 parseConfig 得到 enforce + 自定义比例", () => {
    const raw = applyLayerRulerOverrideToRaw(structuredClone(baseRaw), {
      mode: "enforce",
      keepRatio: 0.5,
      minPerLayer: 2,
    });
    const cfg = parseConfig(raw);
    expect(cfg.recall.layerRuler).toEqual({
      mode: "enforce",
      keepRatio: 0.5,
      minPerLayer: 2,
      floor: null,
      lengthLambda: 0,
      margin: null,
      dedupeSim: null,
      budgetMs: 300,
    });
  });

  it("layerRuler.budgetMs 并入 raw 后透传（缺省 300，显式 800 生效）", () => {
    const dflt = parseConfig(structuredClone(baseRaw));
    expect(dflt.recall.layerRuler?.budgetMs).toBe(300);
    const raw = applyLayerRulerOverrideToRaw(structuredClone(baseRaw), { budgetMs: 800 });
    expect(parseConfig(raw).recall.layerRuler?.budgetMs).toBe(800);
  });

  it("layerRuler.budgetMs 越界即报错（<50 或 >5000 或非整数）", () => {
    for (const bad of [10, 6000, 300.5]) {
      const out = validateOverride({ layerRuler: { budgetMs: bad } });
      if (out.ok) throw new Error(`应当报错: ${bad}`);
      expect(out.errors.some((e) => e.includes("layerRuler.budgetMs"))).toBe(true);
    }
  });

  it("floor 同 model@dims 时透传数值，失配由 wiring 侧判（这里仅存形状）", () => {
    const raw = applyLayerRulerOverrideToRaw(structuredClone(baseRaw), {
      floor: { model: "doubao-embedding-vision", dims: 2048, value: 0.31 },
    });
    const cfg = parseConfig(raw);
    expect(cfg.recall.layerRuler?.floor).toEqual({ model: "doubao-embedding-vision", dims: 2048, value: 0.31 });
  });

  it("injection 并入 raw 后 parseConfig 透传 foldIdentical 与预算档位", () => {
    const raw = applyInjectionOverrideToRaw(structuredClone(baseRaw), {
      foldIdentical: true,
      budgetByIntent: { empty: 0, continuation: 1, self: 1, info: null },
    });
    const cfg = parseConfig(raw);
    expect(cfg.recall.injection).toEqual({
      foldIdentical: true,
      maxLineChars: null,
      maxChars: null,
      budgetByIntent: { empty: 0, continuation: 1, self: 1, info: null },
    });
  });

  it("injection.maxChars 并入 raw 后透传给 parseConfig，且 null 表示不限", () => {
    const raw = applyInjectionOverrideToRaw(structuredClone(baseRaw), { maxChars: 600 });
    expect(parseConfig(raw).recall.injection?.maxChars).toBe(600);
    const off = applyInjectionOverrideToRaw(structuredClone(baseRaw), { maxChars: null });
    expect(parseConfig(off).recall.injection?.maxChars).toBeNull();
  });

  it("injection.maxChars 非正整数即报错（0 不允许——0 要写 null 或省略）", () => {
    const out = validateOverride({ injection: { maxChars: 0 } });
    if (out.ok) throw new Error("应当报错");
    expect(out.errors.some((e) => e.includes("injection.maxChars"))).toBe(true);
  });

  it("空 override 返回同一对象（零副作用）", () => {
    const raw = structuredClone(baseRaw);
    expect(applyLayerRulerOverrideToRaw(raw, undefined)).toBe(raw);
    expect(applyInjectionOverrideToRaw(raw, {})).toBe(raw);
  });

  it("partial injection override 保留未给出的档位", () => {
    const raw = applyInjectionOverrideToRaw(structuredClone(baseRaw), { budgetByIntent: { info: 3 } });
    const cfg = parseConfig(raw);
    expect(cfg.recall.injection?.budgetByIntent).toEqual({ empty: null, continuation: null, self: null, info: 3 });
  });
});
