import { describe, it, expect } from "vitest";
import { runIdentityDiscovery } from "./identity-discovery.js";

const TENANT = { teamId: "flowtest", userId: "ev5", agentId: "agent-l5ug" };

function makeStore(existing: Array<{ slot: string; content: string }>) {
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
    getIdentityDiscoveryState: async () => ({ lastAttemptAt: null, lastCorpusCount: null }),
    setIdentityDiscoveryState: async () => {},
  } as never;
}

const LLM = JSON.stringify([
  { slot: "identity", content: "用户是家里的首席厨师，周末为全家掌勺", rationale: "修订" },
  { slot: "self_identity", content: "我在这个团队负责技术评审与交付把关", rationale: "新增" },
]);

describe("O14 身份修订旧文留痕（P1）", () => {
  it("merge 成功且旧槽非空：logger.info 留痕旧文（replacing <slot> (old content): …）", async () => {
    const logs: string[] = [];
    const store = makeStore([
      { slot: "identity", content: "用户是家里的首席厨师" },
      { slot: "self_identity", content: "我在这个团队负责技术评审" },
    ]);
    await runIdentityDiscovery({
      store, llmRunner: { run: async () => LLM },
      logger: { info: (m: string) => logs.push(m), warn: () => {}, error: () => {} },
      config: { intervalHours: 24 }, selfIdentity: { enabled: true, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(logs.some((m) => m.includes("replacing identity (old content):") && m.includes("用户是家里的首席厨师"))).toBe(true);
    expect(logs.some((m) => m.includes("replacing self_identity (old content):") && m.includes("我在这个团队负责技术评审"))).toBe(true);
  });

  it("旧槽为空（首次写入）：不产生 replacing 日志", async () => {
    const logs: string[] = [];
    await runIdentityDiscovery({
      store: makeStore([]), llmRunner: { run: async () => LLM },
      logger: { info: (m: string) => logs.push(m), warn: () => {}, error: () => {} },
      config: { intervalHours: 24 }, selfIdentity: { enabled: true, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(logs.some((m) => m.includes("replacing"))).toBe(false);
  });
});
