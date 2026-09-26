/**
 * V12-CV：core_value 提案生成端 label/description 透传——parseProposals 普通分支此前丢弃
 * label 字段（仅 character 分支透传）、upsertPendingCore 无 extra 落点。
 * 用例：LLM 输出 core_value 提案带 label/description → fake store.upsertPendingCore 收到 extra。
 */
import { describe, it, expect, vi } from "vitest";
import { runIdentityDiscovery } from "./identity-discovery.js";

function makeStore() {
  const pendingCaptured: Array<{ slot: string; content: string; evidence: number; extra?: { label?: string; description?: string } }> = [];
  return {
    pendingCaptured,
    queryL1Records: () => [
      { record_id: "r1", content: "用户在项目里负责技术评审与交付把关，坚持取证先行", significance: 0.9, updated_time: "2026-09-17T09:00:00Z" },
    ],
    countL1: () => 1,
    readCore: () => [],
    upsertCore: () => true,
    upsertPendingCore: (slot: string, content: string, evidence: number, _t?: unknown, extra?: { label?: string; description?: string }) => {
      pendingCaptured.push({ slot, content, evidence, extra });
      return true;
    },
    getIdentityDiscoveryState: async () => ({ lastAttemptAt: null, lastCorpusCount: null }),
    setIdentityDiscoveryState: async () => {},
  } as never;
}

const NOW = () => new Date("2026-09-17T10:00:00Z");

describe("V12-CV core_value 提案 label/description 生成端透传", () => {
  it("LLM 输出 core_value 带 label/description → upsertPendingCore 收到 extra（RED：现链丢弃）", async () => {
    const store = makeStore();
    const run = vi.fn().mockResolvedValue(JSON.stringify([
      { slot: "core_value", content: "取证先行：任何结论都必须有 file:line 证据支撑后才能下", rationale: "多源一致", label: "取证先行", description: "任何结论必须有证据支撑后才能下" },
    ]));
    await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: false, maxPerPass: 2 },
      now: NOW,
    });
    const caps = (store as never as { pendingCaptured: Array<{ extra?: { label?: string; description?: string } }> }).pendingCaptured;
    expect(caps).toHaveLength(1);
    expect(caps[0]!.extra?.label).toBe("取证先行");
    expect(caps[0]!.extra?.description).toBe("任何结论必须有证据支撑后才能下");
  });
});
