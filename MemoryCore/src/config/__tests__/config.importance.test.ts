/**
 * P1 Task 7（worthiness importance，spec §6）：importance 写入/降权配置解析。
 * memory.worthiness.extractionEnabled（写入面 gate，mirror D-3 memory.sensitivity.extractionEnabled：
 * 缺省 false = prompt 字节不变 = 逐位现状）+ memory.recall.importancePenalty.*（召回面，
 * 缺省 enabled:false = 零行为变化；开启即真实降权——shadowMode 已按用户 2026-10-14 拍板移除；
 * penalty clamp [0,0.9]——1 会把 ≤4 的记忆乘成 0 分沉底，spec 拍板不许）。
 */
import { describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";

const impOf = (raw: Record<string, unknown>) => parseConfig(raw).recall.importancePenalty;
const worthinessOf = (raw: Record<string, unknown>) => parseConfig(raw).worthiness;

describe("P1 task-7 config：memory.recall.importancePenalty（缺省关 = 零行为变化）", () => {
  it("零配置：enabled false + penalty 0.3", () => {
    const c = impOf({});
    expect(c.enabled).toBe(false);
    expect(c.penalty).toBe(0.3);
  });

  it("显式开启：enabled/penalty 透传", () => {
    const c = impOf({ recall: { importancePenalty: { enabled: true, penalty: 0.5 } } });
    expect(c.enabled).toBe(true);
    expect(c.penalty).toBe(0.5);
  });

  it("penalty clamp [0,0.9]：-0.5→0；2→0.9；非数值回落 0.3；0 合法（enabled 下不罚=观测-only）", () => {
    expect(impOf({ recall: { importancePenalty: { penalty: -0.5 } } }).penalty).toBe(0);
    expect(impOf({ recall: { importancePenalty: { penalty: 2 } } }).penalty).toBe(0.9);
    expect(impOf({ recall: { importancePenalty: { penalty: "x" as unknown as number } } }).penalty).toBe(0.3);
    expect(impOf({ recall: { importancePenalty: { enabled: true, penalty: 0 } } }).penalty).toBe(0);
  });

  it("shadowMode 键已移除（用户 2026-10-14 拍板）：携带该键不再生效，解析不报错", () => {
    const c = impOf({ recall: { importancePenalty: { shadowMode: false, enabled: true } } });
    expect((c as unknown as Record<string, unknown>).shadowMode).toBeUndefined();
    expect(c.enabled).toBe(true);
  });

  it("enabled 缺省 false：即使 penalty 配了也拿不到乘子（config-first，零行为变化）", () => {
    expect(impOf({ recall: { importancePenalty: { penalty: 0.9 } } }).enabled).toBe(false);
  });
});

describe("P1 task-7 config：memory.worthiness.extractionEnabled（写入面 gate，D-3 镜像）", () => {
  it("零配置：false（prompt 字节不变，LLM 不产出 importance 字段）", () => {
    expect(worthinessOf({}).extractionEnabled).toBe(false);
  });

  it("显式 true 透传；非布尔回落 false", () => {
    expect(worthinessOf({ worthiness: { extractionEnabled: true } }).extractionEnabled).toBe(true);
    expect(worthinessOf({ worthiness: { extractionEnabled: "yes" as unknown as boolean } }).extractionEnabled).toBe(
      false,
    );
  });
});
