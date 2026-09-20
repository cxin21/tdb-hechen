/**
 * P0-F1（REG-REMAINING v7 审计轮）：core_value/strict_rule pending 证据展示单一源化。
 * 旧本地 recountEvidence（identity-discovery.ts:352）= 20 字前缀逐字包含、无 lowercase——
 * 与 F9 token 口径同名不同义（违铁律 2 单一源），且提炼措辞 vs 语料必然微差 → 结构性假 0
 * （F-EV13-1 同族断链）。修复后与 identityFactMatchesCorpus 同源（≥12 字滑窗）。
 */
import { describe, it, expect, vi } from "vitest";
import { runIdentityDiscovery } from "./identity-discovery.js";

function makeStore(existing: Array<{ slot: string; content: string }> = []) {
  const pendingCaptured: Array<{ slot: string; content: string; evidence: number }> = [];
  return {
    pendingCaptured,
    queryL1Records: () => [
      { record_id: "r1", content: "周末全家聚餐，用户是家里的首席厨师兼采购，菜品丰富", significance: 0.9, updated_time: "2026-09-17T09:00:00Z" },
      { record_id: "r2", content: "用户在项目里负责技术评审与交付把关", significance: 0.8, updated_time: "2026-09-17T09:10:00Z" },
    ],
    countL1: () => 2,
    readCore: () => existing,
    upsertCore: () => true,
    upsertPendingCore: (slot: string, content: string, evidence: number) => {
      pendingCaptured.push({ slot, content, evidence });
      return true;
    },
    getIdentityDiscoveryState: async () => ({ lastAttemptAt: null, lastCorpusCount: null }),
    setIdentityDiscoveryState: async () => {},
  } as never;
}

const NOW = () => new Date("2026-09-17T10:00:00Z");

describe("P0-F1 pending 证据单一源（identityFactMatchesCorpus 同源）", () => {
  it("core_value 提案与语料共享 ≥12 字窗口 → evidence ≥1（旧前缀逐字口径为 0 = RED）", async () => {
    const store = makeStore();
    const run = vi.fn().mockResolvedValue(JSON.stringify([
      { slot: "core_value", content: "用户是家里的首席厨师兼采购，家庭聚餐由他主导", rationale: "多源一致" },
    ]));
    const res = await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: false, maxPerPass: 2 },
      now: NOW,
    });
    expect(res.pending).toBe(1);
    const caps = (store as never as { pendingCaptured: Array<{ evidence: number }> }).pendingCaptured;
    expect(caps).toHaveLength(1);
    expect(caps[0]!.evidence).toBeGreaterThanOrEqual(1);
  });

  it("与语料零窗口重叠的提案 → evidence=0（宁缺毋滥不误报）", async () => {
    const store = makeStore();
    const run = vi.fn().mockResolvedValue(JSON.stringify([
      { slot: "strict_rule", content: "绝不泄露数据库连接串与密钥明文", rationale: "红线" },
    ]));
    await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: false, maxPerPass: 2 },
      now: NOW,
    });
    const caps = (store as never as { pendingCaptured: Array<{ evidence: number }> }).pendingCaptured;
    expect(caps).toHaveLength(1);
    expect(caps[0]!.evidence).toBe(0);
  });
});
