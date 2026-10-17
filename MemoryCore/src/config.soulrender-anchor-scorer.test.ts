/**
 * #42（ADR0003-P3 实施票 D / D9）· coreMemory.soulRender.anchorSelect.scorer 解析（config-first 缺省关）。
 *
 * 合同（#42 票面验收 3 + ADR0003 D9）：相似度打分器 config 门——
 * enabled 缺省 false=shadow（只报告不裁剪，渲染逐位现状）；显式 true 才转正（threshold 硬门+top-K）；
 * threshold clamp 0..1 缺省 0（=只 top-K 不设语义门）；
 * 非法形状/非法值一律回退缺省（宁缺毋滥，沿 capabilities/anchorSelect 解析先例）。
 * embedder/queryEmbedding 运行时注入，不入 config（不测）。
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("#42 · coreMemory.soulRender.anchorSelect.scorer 解析", () => {
  it("缺省（无 coreMemory 段）→ enabled=false、threshold=0（逐位现状）", () => {
    const c = parseConfig({});
    expect(c.coreMemory.soulRender.anchorSelect.scorer.enabled).toBe(false);
    expect(c.coreMemory.soulRender.anchorSelect.scorer.threshold).toBe(0);
  });

  it("缺省（有 soulRender 段但无 scorer 键）→ enabled=false", () => {
    const c = parseConfig({ coreMemory: { soulRender: { anchorSelect: { maxRows: 5 } } } });
    expect(c.coreMemory.soulRender.anchorSelect.scorer.enabled).toBe(false);
    expect(c.coreMemory.soulRender.anchorSelect.scorer.threshold).toBe(0);
  });

  it("显式 true + 合法 threshold → 开关与阈值生效", () => {
    const c = parseConfig({
      coreMemory: { soulRender: { anchorSelect: { maxRows: 5, scorer: { enabled: true, threshold: 0.6 } } } },
    });
    expect(c.coreMemory.soulRender.anchorSelect.scorer.enabled).toBe(true);
    expect(c.coreMemory.soulRender.anchorSelect.scorer.threshold).toBe(0.6);
  });

  it("threshold 越界 clamp 到 0..1（1.5→1；-0.2→0）", () => {
    const hi = parseConfig({ coreMemory: { soulRender: { anchorSelect: { scorer: { threshold: 1.5 } } } } });
    const lo = parseConfig({ coreMemory: { soulRender: { anchorSelect: { scorer: { threshold: -0.2 } } } } });
    expect(hi.coreMemory.soulRender.anchorSelect.scorer.threshold).toBe(1);
    expect(lo.coreMemory.soulRender.anchorSelect.scorer.threshold).toBe(0);
  });

  it("非法值（enabled 非 boolean/threshold 非数值）→ 回退缺省（宁缺毋滥）", () => {
    const c = parseConfig({
      coreMemory: { soulRender: { anchorSelect: { scorer: { enabled: "yes", threshold: "high" } } } },
    });
    expect(c.coreMemory.soulRender.anchorSelect.scorer.enabled).toBe(false);
    expect(c.coreMemory.soulRender.anchorSelect.scorer.threshold).toBe(0);
  });

  it("scorer 形状错误（非对象）→ 回退缺省", () => {
    const c = parseConfig({ coreMemory: { soulRender: { anchorSelect: { scorer: "on" } } } });
    expect(c.coreMemory.soulRender.anchorSelect.scorer.enabled).toBe(false);
    expect(c.coreMemory.soulRender.anchorSelect.scorer.threshold).toBe(0);
  });

  it("maxRows 解析不回归：缺省 999、非法回退 999（#29 先例保持）", () => {
    const def = parseConfig({});
    const bad = parseConfig({ coreMemory: { soulRender: { anchorSelect: { maxRows: "x" } } } });
    expect(def.coreMemory.soulRender.anchorSelect.maxRows).toBe(999);
    expect(bad.coreMemory.soulRender.anchorSelect.maxRows).toBe(999);
  });
});

describe("#52 D3 · coreMemory.soulRender.perTurnSlots 解析", () => {
  it("缺省（无 soulRender 键）→ true（逐位现状）", () => {
    const c = parseConfig({});
    expect(c.coreMemory.soulRender.perTurnSlots).toBe(true);
  });

  it("缺省（有 soulRender 段但无 perTurnSlots 键）→ true", () => {
    const c = parseConfig({ coreMemory: { soulRender: { anchorSelect: { maxRows: 5 } } } });
    expect(c.coreMemory.soulRender.perTurnSlots).toBe(true);
  });

  it("显式 false → false（省略身份两行）；显式 true → true", () => {
    const off = parseConfig({ coreMemory: { soulRender: { perTurnSlots: false } } });
    const on = parseConfig({ coreMemory: { soulRender: { perTurnSlots: true } } });
    expect(off.coreMemory.soulRender.perTurnSlots).toBe(false);
    expect(on.coreMemory.soulRender.perTurnSlots).toBe(true);
  });

  it("非 true 值（\"off\"/0）→ false（===true 解析语义：defined 非 true 一律关，同 snapshotsEnabled 先例）", () => {
    const str = parseConfig({ coreMemory: { soulRender: { perTurnSlots: "off" } } });
    const num = parseConfig({ coreMemory: { soulRender: { perTurnSlots: 0 } } });
    expect(str.coreMemory.soulRender.perTurnSlots).toBe(false);
    expect(num.coreMemory.soulRender.perTurnSlots).toBe(false);
  });
});
