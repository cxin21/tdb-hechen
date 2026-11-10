/**
 * S6 单产线验收：identity 取数只产候选（同一准入/同一事务），红线投影与 persona 同一次 commit。
 * 断言的是「接线」不是措辞：候选进了同一次 commit、strictRule 作为第三参传下去。
 */
import { describe, expect, it, vi } from "vitest";

import { runSoulMaintenance } from "../worker.js";
import { resolveSoulConfig } from "../types.js";
import type { IMemoryStore } from "../../store/types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function makeStore() {
  const commits: Array<{ plan: { upsert: Array<{ layer: string; text: string }>; ledger: unknown[] }; opts?: { strictRule?: string } }> = [];
  const store = {
    listSoulPersona: vi.fn(async () => []),
    commitSoulPersona: vi.fn(async (
      _t: unknown,
      plan: { upsert: Array<{ layer: string; text: string }>; ledger: unknown[] },
      opts?: { strictRule?: string },
    ) => {
      commits.push({ plan, opts });
      return { upserted: plan.upsert.length, ledgered: plan.ledger.length };
    }),
    readSoulState: vi.fn(async () => null),
    writeSoulState: vi.fn(async () => undefined),
    recentAffectSignals: vi.fn(async () => []),
    listSoulLedger: vi.fn(async () => []),
    commitSoulEpisodes: vi.fn(async () => ({ inserted: 0 })),
    listSoulEpisodes: vi.fn(async () => []),
    recentL0Messages: vi.fn(async () => []),
    readSoulTraitState: vi.fn(async () => null),
    writeSoulTraitState: vi.fn(async () => undefined),
    listSoulTraitLabels: vi.fn(async () => []),
    commitSoulTraitLabels: vi.fn(async () => ({ upserted: 0 })),
  } as unknown as IMemoryStore;
  return { store, commits };
}

describe("runSoulMaintenance × 单产线（S6）", () => {
  it("identity 事实进同一候选数组、受同一准入判据（无 episode 出处即被拒，不另开写径）", async () => {
    const { store, commits } = makeStore();
    const identityFacts = vi.fn(async () => [
      {
        layer: "identity" as const,
        text: "用户负责 TDB 记忆系统的版本发布与回归验证",
        evidenceIds: ["r1", "r2", "r3"],
      },
    ]);
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      identityFacts,
    });
    expect(identityFacts).toHaveBeenCalledTimes(1);
    expect(rep.identity).toEqual({ proposed: 1, candidates: 1 });
    // 落库只有一次 commitSoulPersona：identity 不单独写 core_memory 槽。
    expect(commits).toHaveLength(1);
    const identityReject = rep.rejections.find((x) => x.layer === "identity");
    expect(identityReject).toBeDefined();
    // 与 rewriter 候选同一组门：项目专名、两难、立场、episode 出处都要过。
    expect(identityReject?.codes).toEqual(
      expect.arrayContaining(["project_bound", "dilemma_missing", "stance_missing", "episode_missing"]),
    );
    expect(commits[0].plan.upsert.some((i) => i.layer === "identity")).toBe(false);
  });

  it("第一人称取舍句只差 episode 出处（证明门是同一套，不是不认身份事实）", async () => {
    const { store, commits } = makeStore();
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      identityFacts: async () => [
        { layer: "identity" as const, text: "我宁可少接活，也不交付没验证过的结论", evidenceIds: ["r1", "r2", "r3"] },
      ],
    });
    const codes = rep.rejections.find((x) => x.layer === "identity")?.codes ?? [];
    expect(codes).toContain("episode_missing");
    expect(codes).not.toContain("project_bound");
    expect(codes).not.toContain("dilemma_missing");
    expect(codes).not.toContain("stance_missing");
    // 没有 episode 出处时不得靠放宽门写进人格层。
    expect(commits[0].plan.upsert.some((i) => i.layer === "identity")).toBe(false);
  });

  it("active 红线逐字进 strict_rule（同一次 commit 的第三参），退役行不投影", async () => {
    const { store, commits } = makeStore();
    const readAgentProfile = vi.fn(async () => ({
      redlines: [
        { text: "绝不可删除任何生产记忆记录", active: true },
        { text: "这条已经退役", active: false },
      ],
    }));
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      readAgentProfile,
    });
    expect(readAgentProfile).toHaveBeenCalledWith("a1");
    expect(commits).toHaveLength(1);
    expect(commits[0].opts?.strictRule).toBe("- 绝不可删除任何生产记忆记录");
    expect(rep.redlines).toMatchObject({ active: 1, projected: 1, merged: 0, retired: 0 });
  });

  it("没有 profile 来源时如实标注 skipped，不伪造空 strict_rule", async () => {
    const { store, commits } = makeStore();
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
    });
    expect(commits[0].opts).toBeUndefined();
    expect(rep.redlines?.skipped).toBe("no_profile_source");
    expect(rep.identity?.skipped).toBe("no_identity_source");
  });
});
