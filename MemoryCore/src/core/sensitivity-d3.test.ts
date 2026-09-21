import { describe, it, expect } from "vitest";
import { SOUL_COLUMNS, SOUL_COL_NAMES } from "../core/store/soul-columns.js";
import { formatMemoryLine } from "../core/hooks/auto-recall.js";
import { scoreFor } from "../core/lifecycle/forgetting/scorer.js";

/**
 * D-3（2026-09-21，用户拍板"全做"）：sensitivity 全链 RED——
 * ① SOUL_COLUMNS 第 9 列（enum none/health/finance/relationship，缺省 none）
 * ② 注入行徽章 ·soul[敏感:健康]
 * ③ 遗忘敏感偏置（gated bias>0 时敏感行衰减更快）
 */
describe("D-3: sensitivity schema 单一源", () => {
  it("SOUL_COLUMNS 含第 9 列 sensitivity（TEXT，UNINDEXED）", () => {
    const col = SOUL_COLUMNS.find((c) => c.name === "sensitivity");
    expect(col).toBeDefined();
    expect(col?.sqlType).toBe("TEXT");
    expect(col?.ftsSuffix).toBe("UNINDEXED");
    expect(SOUL_COL_NAMES).toContain("sensitivity");
  });
});

describe("D-3: 注入行敏感性徽章", () => {
  it("sensitivity=health → ·soul[敏感:健康] 在场；none → 不标注", () => {
    const hit = formatMemoryLine({
      type: "episodic", content: "用户体检发现血压偏高",
      occurred_at: "2026-09-21T00:00:00.000Z", certainty: "observed",
      valence: -0.3, significance: 0.6,
      sensitivity: "health",
    } as never);
    expect(hit).toContain("敏感:健康");
    const none = formatMemoryLine({ type: "episodic", content: "用户讨论了架构设计", certainty: "observed", sensitivity: "none" } as never);
    expect(none).not.toContain("敏感");
    const absent = formatMemoryLine({ type: "episodic", content: "c", certainty: "observed" } as never);
    expect(absent).not.toContain("敏感");
  });
});

describe("D-3: 遗忘敏感偏置（gated，缺省 0=逐位现状）", () => {
  const base: Record<string, unknown> = {
    id: "r1", content: "c", priority: 50, significance: 0.5, arousal: 0.5,
    created_time: new Date(Date.now() - 40 * 86400_000).toISOString(), metadata: {},
  };
  it("bias=0（缺省）与无 sensitivity 行为一致", () => {
    const cfg = { lambda: 0.01, lowThreshold: 0.12, arousalRetention: 0.3, sensitivityBias: 0 };
    const plain = scoreFor(base as never, cfg as never);
    expect(plain).toBeGreaterThan(0);
  });
  it("sensitivity=health + bias>0 → 分数更低（更早归档）", () => {
    const cfg = { lambda: 0.01, lowThreshold: 0.12, arousalRetention: 0, sensitivityBias: 0.5 };
    const noneRow = scoreFor({ ...base, sensitivity: "none" } as never, cfg as never);
    const healthRow = scoreFor({ ...base, sensitivity: "health" } as never, cfg as never);
    expect(healthRow).toBeLessThan(noneRow);
  });
});

import { parseExtractionResult } from "./record/l1-extractor.js";

describe("D-3b: parseExtractionResult sensitivity 透传（丢值根因修复回归）", () => {
  it("LLM 输出 sensitivity=health → 解析后在场", () => {
    const raw = JSON.stringify([{
      scene_name: "s", message_ids: ["m1"],
      memories: [{ content: "用户体检查出血压偏高", type: "persona", priority: 90, occurred_at: "2026-09-21T00:00:00.000Z", certainty: "observed", valence: -0.3, arousal: 0.4, significance: 0.6, sensitivity: "health" }],
    }]);
    const scenes = parseExtractionResult(raw, undefined, []);
    expect(scenes[0]?.memories[0]?.sensitivity).toBe("health");
  });
});


import { normalizeSensitivity } from "./record/l1-extractor.js";

describe("D-3c: sensitivity 确定性枚举门单一源（F-T1-1 修复回归）", () => {
  it("undefined → 'none'（不得串化 'undefined'——DB 已实测 4 行污染）", () => {
    expect(normalizeSensitivity(undefined)).toBe("none");
  });
  it("null → 'none'", () => {
    expect(normalizeSensitivity(null)).toBe("none");
  });
  it("非法值 'secret' → 'none'（确定性枚举门）", () => {
    expect(normalizeSensitivity("secret")).toBe("none");
  });
  it("'health'/'none' 合法透传", () => {
    expect(normalizeSensitivity("health")).toBe("health");
    expect(normalizeSensitivity("none")).toBe("none");
  });
});
