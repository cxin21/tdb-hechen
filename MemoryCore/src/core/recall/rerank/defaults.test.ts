/**
 * #145（2026-10-29）：rerank 生产默认值的**单一口径源**。
 *
 * 背景：#135 实测 b0base（candidates=12 / minScore=−2）在 LME90 上 67.1%，把池扩到 32 并把
 * 门槛放到 −10.5（≈ 不筛）后 84.3%（+16.67pp，CI95[+9.05,+24.29]）——伤害源是**剪枝**，
 * 不是重排本身。缺省值因此从「浅池 + 硬 floor」翻转为「深池 + 近不筛」，并由本模块统一
 * 声明，config.ts / auto-recall.ts 不再各写一套（单一源原则见 ADR-0012；题内相对尺子与
 * 门槛刻度见 ADR-0013）。离线校准脚本在外——它们复算历史实验的显式阶梯，刻意不跟随生产缺省。
 *
 * 刻度语义（#99 F3 起）：配置里的 minScore **恒按 provider 原生刻度声明**——
 * local cross-encoder 输出原始 logit（−10.5），云 provider 输出 0..1 相关度。因此
 * 「等价缺省」对概率刻度 provider 必须做 sigmoid 换算，照搬 −10.5 等于阈值为负、等价永不剪枝。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RERANK_CANDIDATES,
  DEFAULT_RERANK_MIN_SCORE_LOGIT,
  DEFAULT_RERANK_MIN_SCORE_PROB,
  defaultRerankMinScore,
  isLogitScaleProvider,
  sigmoid01,
} from "./defaults.js";

describe("#145 rerank 缺省：候选池", () => {
  it("candidates 缺省 = 32（#135 deep105 档；浅池 12 只扩池不加 floor 无收益，T1 Δ=0）", () => {
    expect(DEFAULT_RERANK_CANDIDATES).toBe(32);
  });
});

describe("#145 rerank 缺省：provider 标度感知的 minScore", () => {
  it("local（logit 刻度）缺省 = −10.5：落在本批日志分布左侧 ≈ 不筛，只有 candidates cap 真剪枝", () => {
    expect(DEFAULT_RERANK_MIN_SCORE_LOGIT).toBe(-10.5);
    expect(defaultRerankMinScore("local")).toBe(-10.5);
  });

  it("off/none/未知 provider 回落 logit 缺省（off 态只用于展示与 journal，不参与判定）", () => {
    expect(defaultRerankMinScore("none")).toBe(-10.5);
    expect(defaultRerankMinScore(undefined)).toBe(-10.5);
    expect(defaultRerankMinScore(null)).toBe(-10.5);
    expect(defaultRerankMinScore("openai")).toBe(-10.5);
  });

  it("0..1 概率刻度 provider（siliconflow/dashscope）换算为 sigmoid(−10.5) ≈ 2.75e-5，绝不照搬 −10.5", () => {
    const p = defaultRerankMinScore("siliconflow");
    expect(p).toBeCloseTo(1 / (1 + Math.exp(10.5)), 12);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-4);
    expect(DEFAULT_RERANK_MIN_SCORE_PROB).toBe(p);
    expect(defaultRerankMinScore("dashscope")).toBe(p);
  });

  it("换算与 auto-recall 的判定同构：两个缺省门槛落在同一 sigmoid 分位（单调等价）", () => {
    const logitThreshold01 = sigmoid01(defaultRerankMinScore("local"));
    const probThreshold01 = defaultRerankMinScore("siliconflow");
    expect(probThreshold01).toBeCloseTo(logitThreshold01, 12);
  });

  it("isLogitScaleProvider：只有 local 需 sigmoid 归一；与 defaultRerankMinScore 的差异是有意的", () => {
    expect(isLogitScaleProvider("local")).toBe(true);
    for (const p of ["siliconflow", "dashscope", "none", "openai", undefined, null]) {
      expect(isLogitScaleProvider(p)).toBe(false);
    }
    // 判定路径与取值路径的分工：none/未知不走判定（false），但缺省展示值仍回落 logit −10.5。
    expect(isLogitScaleProvider("none")).toBe(false);
    expect(defaultRerankMinScore("none")).toBe(-10.5);
  });

  it("sigmoid01：0 → 0.5、大负数 → 0 附近、单调递增", () => {
    expect(sigmoid01(0)).toBe(0.5);
    expect(sigmoid01(-10.5)).toBeLessThan(sigmoid01(-2));
    expect(sigmoid01(40)).toBe(1);
  });
});
