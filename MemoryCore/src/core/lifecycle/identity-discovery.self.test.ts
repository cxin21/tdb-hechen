import { describe, it, expect, vi } from "vitest";
import { runIdentityDiscovery, DISCOVERY_SYSTEM_PROMPT } from "./identity-discovery.js";

const TENANT = { teamId: "flowtest", userId: "ev5", agentId: "agent-l5ug" };

function makeFakeStore(existing: Array<{ slot: string; content: string }> = []) {
  const coreUpserts: Array<{ slot: string; content: string; createdBy: string }> = [];
  return {
    coreUpserts,
    queryL1Records: () => [
      { record_id: "r1", content: "用户把体检安排在周五，全家一起吃晚饭", significance: 0.9, updated_time: "2026-09-17T09:00:00Z" },
      { record_id: "r2", content: "我在对话中承诺每周五出周报并坚持执行", significance: 0.9, updated_time: "2026-09-17T09:30:00Z" },
    ],
    countL1: () => 2,
    readCore: () => existing, // 同步——生产 sqlite store 的 readCore 为同步方法（v2 实证教训）
    upsertCore: (slot: string, content: string, createdBy: string) => {
      coreUpserts.push({ slot, content, createdBy });
      return true;
    },
    getIdentityDiscoveryState: async () => ({ lastAttemptAt: null, lastCorpusCount: null }),
    setIdentityDiscoveryState: async () => {},
  } as never;
}

const LLM_DUAL = JSON.stringify([
  { slot: "identity", content: "用户是家里的首席厨师，周末为全家掌勺", rationale: "多源一致" },
  { slot: "self_identity", content: "我在这个团队负责技术评审与交付把关", rationale: "agent 侧行为可证" },
]);

describe("identity-discovery 双视角（P1）", () => {
  it("selfIdentity.enabled=false：走旧单视角 prompt（字节级），self 提案不被采纳", async () => {
    const store = makeFakeStore();
    const run = vi.fn().mockResolvedValue(LLM_DUAL);
    const res = await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: false, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(run.mock.calls[0][0].systemPrompt).toBe(DISCOVERY_SYSTEM_PROMPT);
    expect(res.adopted).toBe(1); // 仅 identity
    expect((store as never as { coreUpserts: Array<{ slot: string }> }).coreUpserts.map((u) => u.slot)).toEqual(["identity"]);
  });

  it("enabled=true：双视角一次调用，双槽分别 merge 落库，strip 门复用", async () => {
    const store = makeFakeStore();
    const run = vi.fn().mockResolvedValue(LLM_DUAL);
    const res = await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: true, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(res.adopted).toBe(2);
    const ups = (store as never as { coreUpserts: Array<{ slot: string; content: string; createdBy: string }> }).coreUpserts;
    const bySlot = Object.fromEntries(ups.map((u) => [u.slot, u]));
    expect(bySlot.identity.content).toContain("首席厨师");
    expect(bySlot.self_identity.content).toMatch(/^- /m); // bulleted merge
    expect(bySlot.self_identity.createdBy).toBe("identity-discovery");
  });

  it("enabled=true：self 提案全状态陈述 → strip 拒收，不落库", async () => {
    const store = makeFakeStore();
    const run = vi.fn().mockResolvedValue(JSON.stringify([
      { slot: "self_identity", content: "P1 阶段已完成，当前正在做收尾", rationale: "状态" },
    ]));
    const res = await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: true, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(res.adopted).toBe(0);
    expect((store as never as { coreUpserts: unknown[] }).coreUpserts).toEqual([]);
  });

  it("enabled=true：self 提案超 maxPerPass → 截断", async () => {
    const store = makeFakeStore();
    const run = vi.fn().mockResolvedValue(JSON.stringify([
      { slot: "self_identity", content: "我负责技术评审", rationale: "a" },
      { slot: "self_identity", content: "我承诺每周五出周报", rationale: "b" },
      { slot: "self_identity", content: "我坚持先给结论再给细节", rationale: "c" },
    ]));
    await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: true, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    const ups = (store as never as { coreUpserts: Array<{ slot: string; content: string }> }).coreUpserts;
    const self = ups.find((u) => u.slot === "self_identity");
    expect((self!.content.match(/^- /gm) ?? []).length).toBe(2);
  });
});
