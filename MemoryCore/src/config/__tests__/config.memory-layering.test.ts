/**
 * 记忆分层与提取优化（2026-11-02，A1/A3/B1/B2/B3/B4）配置解析：
 * 全部新键缺省 = 逐位今天行为（config-first），生产由 config-override.json 开启。
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";

describe("A1 persona.l2Gate（L2 触发门）", () => {
  it("缺省关：enabled=false, minPendingL1=30, minIntervalHours=6", () => {
    const cfg = parseConfig({});
    expect(cfg.persona.l2Gate).toEqual({
      enabled: false,
      minPendingL1: 30,
      minIntervalHours: 6,
      // F2（2026-11-02）：全局节流三键，缺省 0/0 = 不限（逐位今天行为）
      maxRunsPerHour: 0,
      maxSessionsPerRound: 0,
      bootRecoveryWarnSessions: 50,
    });
  });

  it("显式开启与覆盖", () => {
    const cfg = parseConfig({
      persona: {
        l2Gate: {
          enabled: true,
          minPendingL1: 12,
          minIntervalHours: 2.5,
          maxRunsPerHour: 3,
          maxSessionsPerRound: 5,
          bootRecoveryWarnSessions: 200,
        },
      },
    });
    expect(cfg.persona.l2Gate).toEqual({
      enabled: true,
      minPendingL1: 12,
      minIntervalHours: 2.5,
      maxRunsPerHour: 3,
      maxSessionsPerRound: 5,
      bootRecoveryWarnSessions: 200,
    });
  });

  it("非法值兜底：minPendingL1 clamp 1..1000、minIntervalHours clamp 0.1..168", () => {
    const lo = parseConfig({ persona: { l2Gate: { minPendingL1: 0, minIntervalHours: 0 } } }).persona.l2Gate;
    expect(lo.minPendingL1).toBe(1);
    expect(lo.minIntervalHours).toBe(0.1);
    const hi = parseConfig({ persona: { l2Gate: { minPendingL1: 99999, minIntervalHours: 9999 } } }).persona.l2Gate;
    expect(hi.minPendingL1).toBe(1000);
    expect(hi.minIntervalHours).toBe(168);
  });
});

describe("A3 extraction.atomicMaxChars / atomicityRewrite / actorTagging", () => {
  // 2026-11-03：缺省 300 → 600，对齐 ADR 0023 校准值（300↔600 使 atomicityRate 81.5%→33.0%）。
  // 生产 config-override 本就显式 600 → 线上逐位不变；回滚 = 显式配 300。
  it("缺省：600 / false / false（atomicityRewrite 与 actorTagging 仍逐位现状关）", () => {
    const cfg = parseConfig({});
    expect(cfg.extraction.atomicMaxChars).toBe(600);
    expect(cfg.extraction.atomicityRewrite).toBe(false);
    expect(cfg.extraction.actorTagging).toBe(false);
  });

  it("显式覆盖与 clamp 120..2000", () => {
    expect(parseConfig({ extraction: { atomicMaxChars: 600 } }).extraction.atomicMaxChars).toBe(600);
    expect(parseConfig({ extraction: { atomicMaxChars: 1 } }).extraction.atomicMaxChars).toBe(120);
    expect(parseConfig({ extraction: { atomicMaxChars: 99999 } }).extraction.atomicMaxChars).toBe(2000);
    expect(parseConfig({ extraction: { atomicityRewrite: true } }).extraction.atomicityRewrite).toBe(true);
    expect(parseConfig({ extraction: { actorTagging: true } }).extraction.actorTagging).toBe(true);
  });
});

describe("B4 extraction.dedupPrefilter", () => {
  // 2026-11-03：minCos 缺省 0.90 → 0.82。0.90 落在"应合并对 0.8587~0.9918"的偏内区，
  // 只开 enabled 不配 minCos 会把真重复放过（门恒空转）——0.82 才是 ADR 0023 的校准值。
  it("缺省关：enabled=false, minCos=0.82", () => {
    expect(parseConfig({}).extraction.dedupPrefilter).toEqual({ enabled: false, minCos: 0.82 });
  });

  it("单一事实源：config 缺省值与 l1-dedup 的 DEFAULT_PREFILTER_MIN_COS 相等", async () => {
    // config.ts 刻意不 import 该模块（避免把 store/sqlite 链拖进轻量配置解析），
    // 用本用例钉住两处常数不漂移。
    const { DEFAULT_PREFILTER_MIN_COS } = await import("../../core/record/l1-dedup.js");
    expect(parseConfig({}).extraction.dedupPrefilter.minCos).toBe(DEFAULT_PREFILTER_MIN_COS);
  });

  it("显式开启 + minCos clamp 0..1", () => {
    expect(
      parseConfig({ extraction: { dedupPrefilter: { enabled: true, minCos: 0.88 } } }).extraction.dedupPrefilter,
    ).toEqual({ enabled: true, minCos: 0.88 });
    expect(parseConfig({ extraction: { dedupPrefilter: { dot: 1 } } }).extraction.dedupPrefilter.minCos).toBe(0.82);
  });
});

describe("B1 lifecycle.consolidation.attributeGrouping", () => {
  it("缺省关：enabled=false, minCos=0.82, maxPoolEmbeds=64", () => {
    expect(parseConfig({}).lifecycle.consolidation.attributeGrouping).toEqual({
      enabled: false,
      minCos: 0.82,
      maxPoolEmbeds: 64,
    });
  });

  it("显式开启 + minCos clamp 0.5..1", () => {
    const cfg = parseConfig({ lifecycle: { consolidation: { attributeGrouping: { enabled: true, minCos: 0.9 } } } });
    expect(cfg.lifecycle.consolidation.attributeGrouping).toEqual({ enabled: true, minCos: 0.9, maxPoolEmbeds: 64 });
    const lo = parseConfig({ lifecycle: { consolidation: { attributeGrouping: { minCos: 0.1 } } } });
    expect(lo.lifecycle.consolidation.attributeGrouping.minCos).toBe(0.5);
  });

  // B1 修正（2026-11-02）：池内补齐上限必须可配且夹紧——生产事故是无上限重嵌全表。
  it("maxPoolEmbeds clamp 0..10000（负数归零，超大截顶，小数取整）", () => {
    const ag = (v: unknown) =>
      parseConfig({ lifecycle: { consolidation: { attributeGrouping: { maxPoolEmbeds: v as number } } } }).lifecycle
        .consolidation.attributeGrouping.maxPoolEmbeds;
    expect(ag(0)).toBe(0);
    expect(ag(-5)).toBe(0);
    expect(ag(3.7)).toBe(3);
    expect(ag(999999)).toBe(10000);
  });
});

describe("B3 persona.l2Form", () => {
  it("缺省 = 逐位现状：structured=false, maxBlockBytes=4096", () => {
    expect(parseConfig({}).persona.l2Form).toEqual({ structured: false, maxBlockBytes: 4096 });
  });

  it("显式开启 + maxBlockBytes clamp 1024..65536", () => {
    const cfg = parseConfig({ persona: { l2Form: { structured: true, maxBlockBytes: 8192 } } });
    expect(cfg.persona.l2Form).toEqual({ structured: true, maxBlockBytes: 8192 });
    expect(parseConfig({ persona: { l2Form: { maxBlockBytes: 1 } } }).persona.l2Form.maxBlockBytes).toBe(1024);
    expect(parseConfig({ persona: { l2Form: { maxBlockBytes: 999999 } } }).persona.l2Form.maxBlockBytes).toBe(65536);
  });
});
