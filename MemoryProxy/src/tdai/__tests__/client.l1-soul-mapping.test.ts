/**
 * P4-T21（D1）：searchL1ForCtx soul 8 字段透传单测。
 *
 * 背景：第五轮审计 D1 —— `/v3/atomic/search` 网关已透传 soul 8 字段
 * （occurred_at/valid_start/valid_end/certainty/source/valence/arousal/significance），
 * 但 proxy client 的 item 映射只取 id/type/content/score/updated_at 五字段，
 * soul 字段在 proxy 侧被静默丢弃。本单测锁定映射补齐语义：
 *   1. item 上已有的 soul 值 → 逐字段透传（类型不变形）
 *   2. item 上缺 soul 字段 → 结果里保持 undefined（可选，不造默认值）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TdaiClient } from "../client.js";
import type { TdaiAgentCtx, TdaiMemoryConfig } from "../types.js";

const CTX: TdaiAgentCtx = {
  teamId: "team-verify",
  userId: "user-verify",
  agentId: "agent-verify",
};

function makeConfig(overrides: Partial<TdaiMemoryConfig> = {}): TdaiMemoryConfig {
  return {
    enabled: true,
    endpoint: "http://127.0.0.1:8420",
    apiKey: "k",
    serviceId: "default",
    writeL0: false,
    recallL1: true,
    injectL2L3: false,
    l1Limit: 5,
    l2Limit: 5,
    timeoutMs: 1000,
    ...overrides,
  };
}

describe("TdaiClient.searchL1ForCtx soul 8 字段透传（P4-T21 D1）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("item 上的 soul 8 字段逐项透传（类型保持）", async () => {
    const item = {
      id: "rec-1",
      type: "episodic",
      content: "soul memory",
      score: 0.87,
      updated_at: "2026-09-09T10:00:00.000Z",
      occurred_at: "2026-09-01T08:00:00.000Z",
      valid_start: "2026-09-01T00:00:00.000Z",
      valid_end: null,
      certainty: "confirmed",
      source: "user",
      valence: 0.6,
      arousal: 0.2,
      significance: 0.9,
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 0, data: { items: [item] } }),
    }) as unknown as Response));

    const client = new TdaiClient(makeConfig());
    const hits = await client.searchL1ForCtx(CTX, "soul", "session-verify");
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    // 原有五字段不回归
    expect(hit.id).toBe("rec-1");
    expect(hit.type).toBe("episodic");
    expect(hit.content).toBe("soul memory");
    expect(hit.score).toBe(0.87);
    expect(hit.updatedAt).toBe("2026-09-09T10:00:00.000Z");
    // soul 8 字段
    expect(hit.occurredAt).toBe("2026-09-01T08:00:00.000Z");
    expect(hit.validStart).toBe("2026-09-01T00:00:00.000Z");
    expect(hit.validEnd).toBeUndefined();
    expect(hit.certainty).toBe("confirmed");
    expect(hit.source).toBe("user");
    expect(hit.valence).toBe(0.6);
    expect(hit.arousal).toBe(0.2);
    expect(hit.significance).toBe(0.9);
  });

  it("item 缺 soul 字段 → 结果保持 undefined（不造默认值）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: { items: [{ id: "rec-2", type: "instruction", content: "legacy row" }] },
      }),
    }) as unknown as Response));

    const client = new TdaiClient(makeConfig());
    const hits = await client.searchL1ForCtx(CTX, "legacy", "session-verify");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.occurredAt).toBeUndefined();
    expect(hits[0]!.validStart).toBeUndefined();
    expect(hits[0]!.validEnd).toBeUndefined();
    expect(hits[0]!.certainty).toBeUndefined();
    expect(hits[0]!.source).toBeUndefined();
    expect(hits[0]!.valence).toBeUndefined();
    expect(hits[0]!.arousal).toBeUndefined();
    expect(hits[0]!.significance).toBeUndefined();
  });
});
