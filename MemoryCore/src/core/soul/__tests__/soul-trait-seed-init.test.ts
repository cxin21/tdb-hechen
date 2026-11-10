/**
 * D3 验收：新 agent 的「它现在」从「你设定的」出发。
 *
 * 旧行为：`soul_trait_state` 首次写入时 axis 用 `emptyAxisVector()`（全 0）而 seedState 是
 * 表单归一后的非零向量 → 一出生就和设定不一致，`/v3/soul/trait-state` 在还没有任何漂移时
 * 就报 `drifted:true`（审墨 agt-fa0u5mi7x4，2026-11-07 实测）。
 * 新行为：无历史 state 时 `traitState = seedState`，只有真的攒到票才偏离设定。
 */
import { describe, expect, it, vi } from "vitest";

import { runSoulMaintenance } from "../worker.js";
import { resolveSoulConfig } from "../types.js";
import { l1Norm, seedStateFromSeeds, type AxisVector } from "../traits.js";
import type { IMemoryStore } from "../../store/types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const NOW = "2026-11-07T10:00:00.000Z";

const TRAITS = [
  { label: "严谨" as const, weight: 0.6 },
  { label: "直接" as const, weight: 0.4 },
];

/** 最小 store：没有历史 trait 行、没有事件；只关心首次写 trait state 的入参。 */
function makeStore() {
  const writes: Array<{ state: AxisVector; seedState?: AxisVector }> = [];
  const store = {
    listSoulPersona: vi.fn(async () => []),
    commitSoulPersona: vi.fn(async () => ({ upserted: 0, ledgered: 0 })),
    readSoulState: vi.fn(async () => null),
    writeSoulState: vi.fn(async () => undefined),
    recentAffectSignals: vi.fn(async () => []),
    listSoulLedger: vi.fn(async () => []),
    recentL0Messages: vi.fn(async () => []),
    commitSoulEpisodes: vi.fn(async () => ({ inserted: 0 })),
    listSoulEpisodes: vi.fn(async () => []),
    soulMetaGet: vi.fn(() => undefined),
    soulMetaSet: vi.fn(() => undefined),
    readSoulTraitState: vi.fn(() => null),
    writeSoulTraitState: vi.fn((_t: unknown, input: { state: AxisVector; seedState?: AxisVector }) => {
      writes.push({ state: { ...input.state }, ...(input.seedState ? { seedState: { ...input.seedState } } : {}) });
    }),
    listSoulTraitLabels: vi.fn(() => []),
    commitSoulTraitLabels: vi.fn(async () => undefined),
  } as unknown as IMemoryStore;
  return { store, writes };
}

describe("D3 新 agent 的当前状态从种子出发", () => {
  it("无历史 state 行时，首次写入的 state 等于 seedState（非全零、Σ≤0.5）", async () => {
    const { store, writes } = makeStore();
    const expected = seedStateFromSeeds(TRAITS);

    const report = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      now: NOW,
      readAgentProfile: async () => ({ traits: TRAITS }) as never,
    });

    expect(report.traitSkipped).toBe("no_trait_judge");
    expect(writes.length).toBeGreaterThan(0);
    const first = writes[0];
    expect(first.state).toEqual(expected);
    expect(Object.values(first.state).some((v) => v !== 0)).toBe(true);
    expect(l1Norm(first.state)).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(first.seedState).toEqual(expected);
  });
});