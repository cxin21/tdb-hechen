/**
 * #46 收口（override 透传缺口）— settings override 链新增 extraction 段单测。
 * 镜像 settings-override.importance.test.ts 的 P1-T7 范式：
 * - SettingsOverride 新增 extraction（memory.extraction.scenePoisonSplit /
 *   sceneBatchMaxChars）段；
 * - 形状校验在 override 层，clamp/缺省语义在 parseConfig（与 rerank 同口径）；
 * - applyExtractionOverrideToRaw 在 parseConfig 之前并入 raw（不变量在 parse 内，
 *   parse 后合并会绕过）。
 * 背景：#46 修复批（92a2fe5）把 scenePoisonSplit/sceneBatchMaxChars 写进
 * config-override.json 顶层，但 SettingsOverride 合同不含 extraction 段 →
 * readSettingsOverride 读入后被 apply 链静默丢弃 → 拆分运行时未生效（活体
 * EV 行 promptChars=33178 未预拆）。本合同钉住透传链闭合。
 */
import { describe, expect, it } from "vitest";
import {
  applyExtractionOverrideToRaw,
  validateOverride,
} from "../settings-override.js";
import { parseConfig } from "../../config.js";

describe("validateOverride extraction 段（#46 收口）", () => {
  it("全字段合法 → 原样透传", () => {
    const v = validateOverride({ extraction: { scenePoisonSplit: true, sceneBatchMaxChars: 20000 } });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.extraction).toEqual({ scenePoisonSplit: true, sceneBatchMaxChars: 20000 });
    }
  });

  it("scenePoisonSplit 非 boolean → 报错", () => {
    const v = validateOverride({ extraction: { scenePoisonSplit: "yes" } });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.some((e) => e.includes("extraction.scenePoisonSplit"))).toBe(true);
    }
  });

  it("sceneBatchMaxChars：数字串宽收（rerank 先例），非数字串/负数报错，clamp 在 parseConfig 落地", () => {
    const coerced = validateOverride({ extraction: { sceneBatchMaxChars: "20000" } });
    expect(coerced.ok).toBe(true);
    if (coerced.ok) expect(coerced.value.extraction?.sceneBatchMaxChars).toBe(20000);
    const badStr = validateOverride({ extraction: { sceneBatchMaxChars: "abc" } });
    expect(badStr.ok).toBe(false);
    if (!badStr.ok) expect(badStr.errors.some((e) => e.includes("extraction.sceneBatchMaxChars"))).toBe(true);
    const negative = validateOverride({ extraction: { sceneBatchMaxChars: -5 } });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.errors.some((e) => e.includes("extraction.sceneBatchMaxChars"))).toBe(true);
  });

  it("无 extraction 键 → 不产生空段", () => {
    const v = validateOverride({});
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.extraction).toBeUndefined();
  });
});

describe("applyExtractionOverrideToRaw（#46 收口）", () => {
  it("并入 raw.extraction（子对象浅合并，保留既有键）", () => {
    const raw = { extraction: { extractionTimeoutMs: 300000 } };
    const next = applyExtractionOverrideToRaw(raw, { scenePoisonSplit: true });
    expect(next).toEqual({ extraction: { extractionTimeoutMs: 300000, scenePoisonSplit: true } });
  });

  it("raw 无 extraction 段时创建", () => {
    const next = applyExtractionOverrideToRaw({}, { scenePoisonSplit: true, sceneBatchMaxChars: 20000 });
    expect(next.extraction).toEqual({ scenePoisonSplit: true, sceneBatchMaxChars: 20000 });
  });

  it("override 的 undefined 字段不覆盖 raw 既有值（pickDefined 语义）", () => {
    const raw = { extraction: { sceneBatchMaxChars: 1000 } };
    const next = applyExtractionOverrideToRaw(raw, { scenePoisonSplit: true });
    expect(next).toEqual({ extraction: { sceneBatchMaxChars: 1000, scenePoisonSplit: true } });
  });

  it("不改入参（非变异）；override 空 → 原样返回", () => {
    const raw = { extraction: { scenePoisonSplit: false } } as Record<string, unknown>;
    applyExtractionOverrideToRaw(raw, { scenePoisonSplit: true });
    expect(raw.extraction).toEqual({ scenePoisonSplit: false });
    expect(applyExtractionOverrideToRaw(raw, undefined)).toBe(raw);
    expect(applyExtractionOverrideToRaw(raw, {})).toBe(raw);
  });
});

describe("端到端：override 注入链 → parseConfig 消化（#46 收口断层面）", () => {
  // 镜像 gateway/config.ts:501-507 的真实嵌套顺序（rerank→extraction→worthiness→importancePenalty），
  // 钉住「apply 产物能被 parseConfig 正确消化成运行时配置」——活体失效面正是
  // override 合同不含 extraction 段导致 raw 注入前被丢弃。
  it("override extraction 段经注入链进入 parseConfig 产物", () => {
    const raw: Record<string, unknown> = {};
    const merged = applyExtractionOverrideToRaw(raw, { scenePoisonSplit: true, sceneBatchMaxChars: 20000 });
    const cfg = parseConfig(merged);
    expect(cfg.extraction?.scenePoisonSplit).toBe(true);
    expect(cfg.extraction?.sceneBatchMaxChars).toBe(20000);
  });

  it("无 override → parseConfig 产物保持缺省关（config-first 逐位现状）", () => {
    const cfg = parseConfig({});
    expect(cfg.extraction?.scenePoisonSplit).toBe(false);
    expect(cfg.extraction?.sceneBatchMaxChars).toBe(0);
  });
});
