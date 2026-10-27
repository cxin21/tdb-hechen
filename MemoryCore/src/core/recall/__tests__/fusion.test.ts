import { describe, expect, it } from "vitest";
import {
  fusionWeightsOf,
  recencyNormOf,
  validityNormOf,
  RRF_IDENTITY_WEIGHTS,
  WEIGHTED_DEFAULT_WEIGHTS,
  type RecallFusionConfig,
} from "../fusion.js";

describe("#135 R2 加权融合（fusion 纯函数）", () => {
  describe("fusionWeightsOf", () => {
    it("缺省/rrf 模式 = RRF 恒等权重（dense/bm25=1，recency/validity=0 → 逐位现状）", () => {
      expect(fusionWeightsOf(undefined)).toEqual(RRF_IDENTITY_WEIGHTS);
      expect(fusionWeightsOf({ mode: "rrf" })).toEqual(RRF_IDENTITY_WEIGHTS);
    });

    it("weighted 模式缺省权重 = 拟合前占位（0.4/0.3/0.2/0.1）", () => {
      expect(fusionWeightsOf({ mode: "weighted" })).toEqual(WEIGHTED_DEFAULT_WEIGHTS);
    });

    it("weighted + 显式覆盖：逐项采用（离线拟合产物入口）", () => {
      const cfg: RecallFusionConfig = { mode: "weighted", dense: 0.5, bm25: 0.2, recency: 0.25, validity: 0.05 };
      expect(fusionWeightsOf(cfg)).toEqual({ dense: 0.5, bm25: 0.2, recency: 0.25, validity: 0.05 });
    });

    it("非法/非有限权重逐项回落缺省", () => {
      const w = fusionWeightsOf({ mode: "weighted", dense: -1, bm25: NaN });
      expect(w.dense).toBe(WEIGHTED_DEFAULT_WEIGHTS.dense);
      expect(w.bm25).toBe(WEIGHTED_DEFAULT_WEIGHTS.bm25);
      expect(w.recency).toBe(WEIGHTED_DEFAULT_WEIGHTS.recency);
      expect(w.validity).toBe(WEIGHTED_DEFAULT_WEIGHTS.validity);
    });
  });

  describe("recencyNormOf", () => {
    const NOW = new Date("2026-10-27T00:00:00Z");

    it("30 天前 + 半衰期 30 天 → 0.5", () => {
      const t = new Date(NOW.getTime() - 30 * 86400000).toISOString();
      expect(recencyNormOf(t, NOW, 30)).toBeCloseTo(0.5, 6);
    });

    it("刚发生 → 约 1；未来时间 clamp 1", () => {
      const t = new Date(NOW.getTime() - 60000).toISOString();
      expect(recencyNormOf(t, NOW, 30)).toBeCloseTo(1, 3);
      const future = new Date(NOW.getTime() + 86400000).toISOString();
      expect(recencyNormOf(future, NOW, 30)).toBe(1);
    });

    it("缺失 occurred_at → 0（无实证不加成）", () => {
      expect(recencyNormOf(undefined, NOW, 30)).toBe(0);
      expect(recencyNormOf("not-a-date", NOW, 30)).toBe(0);
    });

    it("floor 0.05 never-a-filter：极旧条目不低于 floor", () => {
      const t = new Date(NOW.getTime() - 3650 * 86400000).toISOString();
      expect(recencyNormOf(t, NOW, 30)).toBe(0.05);
    });
  });

  describe("validityNormOf", () => {
    const NOW = new Date("2026-10-27T00:00:00Z");

    it("生效中（start<=now<=end）→ 1", () => {
      expect(validityNormOf("2026-01-01", "2026-12-31", NOW)).toBe(1);
    });

    it("缺失双时态字段 → 1（无实证不惩罚）", () => {
      expect(validityNormOf(undefined, undefined, NOW)).toBe(1);
    });

    it("已失效（end<=now）→ 0", () => {
      expect(validityNormOf(undefined, "2026-01-01", NOW)).toBe(0);
    });

    it("未生效（start>now）→ 0", () => {
      expect(validityNormOf("2026-12-31", undefined, NOW)).toBe(0);
    });
  });
});
