import { describe, it, expect } from "vitest";
import { runIdentityDiscovery } from "./identity-discovery.js";

const TENANT = { teamId: "flowtest", userId: "ev5", agentId: "agent-l5ug" };

function makeStore(existing: Array<{ slot: string; content: string }> = [], state: { lastAttemptAt: string | null } = { lastAttemptAt: null }) {
  const coreUpserts: Array<{ slot: string; content: string; createdBy: string }> = [];
  return {
    coreUpserts,
    queryL1Records: () => [
      { record_id: "r1", content: "用户把体检安排在周五，全家一起吃晚饭", significance: 0.9, updated_time: "2026-09-17T09:00:00Z" },
    ],
    countL1: () => 1,
    readCore: () => existing,
    upsertCore: (slot: string, content: string, createdBy: string) => {
      coreUpserts.push({ slot, content, createdBy });
      return true;
    },
    getIdentityDiscoveryState: () => ({ lastAttemptAt: state.lastAttemptAt, lastCorpusCount: null }), // 同步——readState 不 await（生产 sqlite 同步方法）
    setIdentityDiscoveryState: async () => {},
  } as never;
}

const LLM_DUAL = JSON.stringify([
  { slot: "self_identity", content: "我在这个团队负责技术评审与交付把关", rationale: "agent 侧行为可证" },
]);

describe("selfIdentity.intervalHours 冷却覆盖（F15 分池，gated）", () => {
  it("enabled=true + intervalHours=1：2h 前跑过 → 冷却已过，正常执行", async () => {
    const store = makeStore([], { lastAttemptAt: "2026-09-17T08:00:00Z" });
    const res = await runIdentityDiscovery({
      store, llmRunner: { run: async () => LLM_DUAL },
      config: { intervalHours: 24 },
      selfIdentity: { enabled: true, maxPerPass: 2, intervalHours: 1 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(res.ran).toBe(true);
  });

  it("enabled=false（缺省路径）：冷却仍走 anchorDiscovery 的 24h → 2h 前跑过 → skip（逐位现状）", async () => {
    const store = makeStore([], { lastAttemptAt: "2026-09-17T08:00:00Z" });
    const res = await runIdentityDiscovery({
      store, llmRunner: { run: async () => LLM_DUAL },
      config: { intervalHours: 24 },
      selfIdentity: { enabled: false, maxPerPass: 2, intervalHours: 1 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(res.ran).toBe(false);
  });
});
