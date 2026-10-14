/**
 * P1 Task 7（worthiness importance）— settings override 链新增段单测。
 * 镜像 settings-override.test.ts 的 rerank 段模式（P1 task-4）：
 * - SettingsOverride 新增 importancePenalty（memory.recall.importancePenalty.*）
 *   与 worthiness（memory.worthiness.extractionEnabled）两段；
 * - 形状校验在 override 层，clamp 语义在 parseConfig（与 rerank 同口径）；
 * - applyImportancePenaltyOverrideToRaw / applyWorthinessOverrideToRaw 在
 *   parseConfig 之前并入 raw（不变量在 parse 内，parse 后合并会绕过）。
 */
import { describe, expect, it } from "vitest";
import {
  applyImportancePenaltyOverrideToRaw,
  applyWorthinessOverrideToRaw,
  validateOverride,
} from "../settings-override.js";

describe("validateOverride importancePenalty 段（P1-T7）", () => {
  it("全字段合法 → 原样透传", () => {
    const v = validateOverride({ importancePenalty: { enabled: true, penalty: 0.5, shadowMode: false } });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.importancePenalty).toEqual({ enabled: true, penalty: 0.5, shadowMode: false });
    }
  });

  it("部分字段合法 → 只保留给出的字段", () => {
    const v = validateOverride({ importancePenalty: { penalty: 0.3 } });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.importancePenalty).toEqual({ penalty: 0.3 });
  });

  it("enabled/shadowMode 非 boolean → 报错", () => {
    const v = validateOverride({ importancePenalty: { enabled: "yes", shadowMode: 1 } });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.some((e) => e.includes("importancePenalty.enabled"))).toBe(true);
      expect(v.errors.some((e) => e.includes("importancePenalty.shadowMode"))).toBe(true);
    }
  });

  it("penalty 非数字字符串 → 报错（数字串按 rerank 先例 Number() 宽收，clamp 在 parseConfig 落地）", () => {
    // rerank 段先例：Number() 宽收数字串，非数字串报错
    const coerced = validateOverride({ importancePenalty: { penalty: "0.5" } });
    expect(coerced.ok).toBe(true);
    if (coerced.ok) expect(coerced.value.importancePenalty?.penalty).toBe(0.5);
    const v = validateOverride({ importancePenalty: { penalty: "abc" } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.includes("importancePenalty.penalty"))).toBe(true);
  });

  it("worthiness.extractionEnabled 合法 boolean 透传 / 非 boolean 报错", () => {
    const ok = validateOverride({ worthiness: { extractionEnabled: true } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.worthiness).toEqual({ extractionEnabled: true });
    const bad = validateOverride({ worthiness: { extractionEnabled: "on" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((e) => e.includes("worthiness.extractionEnabled"))).toBe(true);
  });
});

describe("applyImportancePenaltyOverrideToRaw（P1-T7）", () => {
  it("并入 raw.recall.importancePenalty（嵌套一层）", () => {
    const raw = { recall: { importancePenalty: { enabled: false } } };
    const next = applyImportancePenaltyOverrideToRaw(raw, { enabled: true, penalty: 0.4 });
    expect(next).toEqual({ recall: { importancePenalty: { enabled: true, penalty: 0.4 } } });
  });

  it("raw 无 recall 段时创建", () => {
    const next = applyImportancePenaltyOverrideToRaw({}, { enabled: true });
    expect((next.recall as Record<string, unknown>).importancePenalty).toEqual({ enabled: true });
  });

  it("不改入参（非变异）", () => {
    const raw = { recall: { importancePenalty: { enabled: false } } } as Record<string, unknown>;
    applyImportancePenaltyOverrideToRaw(raw, { enabled: true });
    expect((raw.recall as Record<string, unknown>).importancePenalty).toEqual({ enabled: false });
  });

  it("override 为空 → 原样返回", () => {
    const raw = { recall: {} } as Record<string, unknown>;
    expect(applyImportancePenaltyOverrideToRaw(raw, undefined)).toBe(raw);
    expect(applyImportancePenaltyOverrideToRaw(raw, {})).toBe(raw);
  });
});

describe("applyWorthinessOverrideToRaw（P1-T7）", () => {
  it("并入 raw.worthiness", () => {
    const next = applyWorthinessOverrideToRaw({}, { extractionEnabled: true });
    expect(next.worthiness).toEqual({ extractionEnabled: true });
  });

  it("不改入参；空 override 原样返回", () => {
    const raw = { worthiness: { extractionEnabled: false } } as Record<string, unknown>;
    applyWorthinessOverrideToRaw(raw, { extractionEnabled: true });
    expect(raw.worthiness).toEqual({ extractionEnabled: false });
    expect(applyWorthinessOverrideToRaw(raw, undefined)).toBe(raw);
  });
});
