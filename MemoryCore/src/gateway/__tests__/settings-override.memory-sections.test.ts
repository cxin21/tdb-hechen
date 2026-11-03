/**
 * config-override.json → memory 段（recall / persona / lifecycle）注入（2026-11-02）。
 *
 * 背景：网关只把 llm/embedding/rerank/importancePenalty/worthiness/extraction/
 * layerRuler/injection 八段并入 parse 之前的 raw；记忆分层优化新增的
 * recall.selfNarration / persona.l2Gate / persona.l2Form /
 * lifecycle.consolidation.attributeGrouping 写进 override 会被静默忽略（落盘 ≠ 生效）。
 * 本套件钉住「深合并 + 不改入参 + parse 后真生效」。
 */
import { describe, expect, it } from "vitest";
import { applyExtractionOverrideToRaw, applyMemorySectionsOverrideToRaw } from "../settings-override.js";
import { parseConfig } from "../../config.js";

function baseRaw(): Record<string, unknown> {
  return {
    recall: { layerRuler: { mode: "enforce", keepRatio: 0.67 }, injection: { maxChars: 600 } },
    persona: { triggerEveryN: 50, maxScenes: 15 },
    lifecycle: { consolidation: { enabled: true, scheduleCron: "0 3 * * *" } },
    extraction: {
      facts: { enabled: true, maxFacts: 5, includeTriples: true },
      dedupTimeoutMs: 90000,
      atomicityRewrite: false,
    },
  };
}

describe("applyMemorySectionsOverrideToRaw（recall / persona / lifecycle）", () => {
  it("recall.selfNarration 深合并：新键生效，同段其它 recall 键逐位保留", () => {
    const raw = applyMemorySectionsOverrideToRaw(baseRaw(), { recall: { selfNarration: { enabled: true } } });
    const recall = raw.recall as Record<string, any>;
    expect(recall.selfNarration).toEqual({ enabled: true });
    expect(recall.layerRuler).toEqual({ mode: "enforce", keepRatio: 0.67 });
    expect(recall.injection).toEqual({ maxChars: 600 });
  });

  it("persona.l2Gate / l2Form 深合并：triggerEveryN 与 maxScenes 不动", () => {
    const raw = applyMemorySectionsOverrideToRaw(baseRaw(), {
      persona: { l2Gate: { enabled: true, minPendingL1: 30, minIntervalHours: 6 }, l2Form: { structured: true } },
    });
    const persona = raw.persona as Record<string, any>;
    expect(persona.l2Gate).toEqual({ enabled: true, minPendingL1: 30, minIntervalHours: 6 });
    expect(persona.l2Form).toEqual({ structured: true });
    expect(persona.triggerEveryN).toBe(50);
    expect(persona.maxScenes).toBe(15);
  });

  it("lifecycle.consolidation.attributeGrouping 深合并：同段其它 consolidation 键保留", () => {
    const raw = applyMemorySectionsOverrideToRaw(baseRaw(), {
      lifecycle: { consolidation: { attributeGrouping: { enabled: true, minCos: 0.82 } } },
    });
    const cons = (raw.lifecycle as Record<string, any>).consolidation as Record<string, any>;
    expect(cons.attributeGrouping).toEqual({ enabled: true, minCos: 0.82 });
    expect(cons.enabled).toBe(true);
    expect(cons.scheduleCron).toBe("0 3 * * *");
  });

  it("空 / undefined override：原样返回同一引用（逐位现状）", () => {
    const b = baseRaw();
    expect(applyMemorySectionsOverrideToRaw(b, undefined)).toBe(b);
    expect(applyMemorySectionsOverrideToRaw(b, {})).toBe(b);
    expect(applyMemorySectionsOverrideToRaw(b, { recall: {}, persona: {} })).toBe(b);
  });

  it("数组值整体替换（不做元素级合并）", () => {
    const b = { recall: { someList: [1, 2, 3] } } as Record<string, unknown>;
    const raw = applyMemorySectionsOverrideToRaw(b, { recall: { someList: [9] } });
    expect((raw.recall as Record<string, any>).someList).toEqual([9]);
  });

  it("不改入参：base 对象深比较后逐位不变", () => {
    const b = baseRaw();
    const snapshot = JSON.parse(JSON.stringify(b));
    applyMemorySectionsOverrideToRaw(b, { persona: { l2Gate: { enabled: true } } });
    expect(b).toEqual(snapshot);
  });
});

describe("applyExtractionOverrideToRaw 新增键（A3/B4/A2）", () => {
  it("atomicityRewrite / actorTagging 直接生效", () => {
    const raw = applyExtractionOverrideToRaw(baseRaw(), { atomicityRewrite: true, actorTagging: true });
    const ex = raw.extraction as Record<string, any>;
    expect(ex.atomicityRewrite).toBe(true);
    expect(ex.actorTagging).toBe(true);
    expect(ex.dedupTimeoutMs).toBe(90000);
  });

  it("facts 深合并：enabled=false 生效且 maxFacts/includeTriples 逐位保留（不被整块替换）", () => {
    const raw = applyExtractionOverrideToRaw(baseRaw(), { facts: { enabled: false } });
    expect((raw.extraction as Record<string, any>).facts).toEqual({
      enabled: false,
      maxFacts: 5,
      includeTriples: true,
    });
  });

  it("dedupPrefilter 新块并入，minCos 覆盖", () => {
    const raw = applyExtractionOverrideToRaw(baseRaw(), { dedupPrefilter: { enabled: true, minCos: 0.9 } });
    expect((raw.extraction as Record<string, any>).dedupPrefilter).toEqual({ enabled: true, minCos: 0.9 });
  });
});

describe("端到端：override → raw 合并 → parseConfig 真生效", () => {
  it("七项生产档全部落到解析结果", () => {
    const merged = applyExtractionOverrideToRaw(
      applyMemorySectionsOverrideToRaw(baseRaw(), {
        recall: { selfNarration: { enabled: true } },
        persona: {
          l2Gate: { enabled: true, minPendingL1: 30, minIntervalHours: 6 },
          l2Form: { structured: true, maxBlockBytes: 4096 },
        },
        lifecycle: { consolidation: { attributeGrouping: { enabled: true, minCos: 0.82 } } },
      }),
      {
        atomicMaxChars: 600,
        atomicityRewrite: true,
        actorTagging: true,
        dedupPrefilter: { enabled: true, minCos: 0.9 },
        facts: { enabled: false },
      },
    );
    const cfg = parseConfig(merged);
    expect(cfg.recall.selfNarration).toEqual({ enabled: true });
    // F2（2026-11-02）全局节流三键随 override 一起落到解析结果；本档未配 ⇒ 缺省 0/0/50
    expect(cfg.persona.l2Gate).toEqual({
      enabled: true,
      minPendingL1: 30,
      minIntervalHours: 6,
      maxRunsPerHour: 0,
      maxSessionsPerRound: 0,
      bootRecoveryWarnSessions: 50,
    });
    expect(cfg.persona.l2Form).toEqual({ structured: true, maxBlockBytes: 4096 });
    expect(cfg.lifecycle.consolidation.attributeGrouping).toEqual({ enabled: true, minCos: 0.82, maxPoolEmbeds: 64 });
    expect(cfg.extraction.atomicMaxChars).toBe(600);
    expect(cfg.extraction.atomicityRewrite).toBe(true);
    expect(cfg.extraction.actorTagging).toBe(true);
    expect(cfg.extraction.dedupPrefilter).toEqual({ enabled: true, minCos: 0.9 });
    expect(cfg.extraction.facts).toEqual({ enabled: false, maxFacts: 5, includeTriples: true });
  });
});
