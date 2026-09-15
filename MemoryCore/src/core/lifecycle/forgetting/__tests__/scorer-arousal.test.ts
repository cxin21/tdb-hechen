/**
 * GROW-EVO P3 RED 套件：arousal 遗忘调制（§3.1 闪光灯记忆）。
 * 契约：effectiveλ = λ × (1 - k × arousal)；k 缺省 0 = 逐位现状；clamp 0.9（config 层）。
 */
import { describe, expect, it } from "vitest";
import { scoreFor, DEFAULT_FORGETTING_CONFIG } from "../scorer.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

const START = new Date("2026-01-01T00:00:00.000Z").getTime();

function mkRecord(soul: { arousal?: number; significance?: number }): MemoryRecord {
  return {
    id: "r", content: "c", type: "episodic", priority: 50, scene_name: "t",
    source_message_ids: [], metadata: {}, timestamps: ["2026-01-01T00:00:00.000Z"],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    version: 0, sessionKey: "k", sessionId: "s",
    occurred_at: "2026-01-01T00:00:00.000Z", certainty: "observed",
    arousal: soul.arousal, significance: soul.significance ?? 0.8,
  } as MemoryRecord;
}

describe("GROW-EVO P3 arousal 遗忘调制", () => {
  it("DEFAULT.arousalRetention = 0（逐位现状）", () => {
    expect(DEFAULT_FORGETTING_CONFIG.arousalRetention).toBe(0);
  });

  it("k=0 恒等：arousal 不影响分数", () => {
    const cfg = { ...DEFAULT_FORGETTING_CONFIG, arousalRetention: 0 };
    const at = START + 40 * 86_400_000;
    expect(scoreFor(mkRecord({ arousal: 1 }), cfg, at)).toBe(scoreFor(mkRecord({ arousal: 0 }), cfg, at));
  });

  it("k=0.3：arousal=1 同年龄分数更高（衰减更慢）", () => {
    const cfg = { ...DEFAULT_FORGETTING_CONFIG, arousalRetention: 0.3 };
    const at = START + 40 * 86_400_000;
    expect(scoreFor(mkRecord({ arousal: 1 }), cfg, at)).toBeGreaterThan(scoreFor(mkRecord({ arousal: 0 }), cfg, at));
  });

  it("公式逐位：sig × pri × exp(-λ(1-k·a)·age)", () => {
    const cfg = { ...DEFAULT_FORGETTING_CONFIG, lambda: 0.01, arousalRetention: 0.3 };
    const m = mkRecord({ arousal: 1, significance: 0.8 });
    const expected = Math.min(1, 0.8 * 0.5 * Math.exp(-0.01 * (1 - 0.3) * 40));
    expect(scoreFor(m, cfg, START + 40 * 86_400_000)).toBeCloseTo(expected, 10);
  });

  it("k=1（超 clamp 值直传）：effectiveλ = λ×0.1，分数仍 > 0", () => {
    const cfg = { ...DEFAULT_FORGETTING_CONFIG, arousalRetention: 1 };
    expect(scoreFor(mkRecord({ arousal: 1 }), cfg, START + 40 * 86_400_000)).toBeGreaterThan(0);
  });
});