/**
 * S6 单产线验收：identity 取数只产候选（同一准入/同一事务），红线投影与 persona 同一次 commit。
 * 断言的是「接线」不是措辞：候选进了同一次 commit、strictRule 作为第三参传下去。
 */
import { describe, expect, it, vi } from "vitest";

import { episodeIdsByRecordId, resolveEpisodeIds, runSoulMaintenance } from "../worker.js";
import { countEpisodeEvidence } from "../gates.js";
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
    // Round23（R23-1）：出处是 L1 record_id、本轮事件池里解析不到任何 ep-* → 结构预过滤挡在闸门外。
    // 挡在闸门外而不是送进去被拒，才不会让「没有事件出处」冒充「模型提案被拒」。
    expect(rep.identity).toEqual({ proposed: 1, candidates: 0, prefiltered: 1 });
    expect(rep.rejections.some((x) => x.layer === "identity")).toBe(false);
    expect(rep.prefiltered).toEqual([{ layer: "identity", code: "prefilter_no_episode", count: 1 }]);
    // 落库只有一次 commitSoulPersona：identity 不单独写 core_memory 槽。
    expect(commits).toHaveLength(1);
    expect(commits[0].plan.upsert.some((i) => i.layer === "identity")).toBe(false);
  });

  // R31-1（Round31）：用户身份事实（subject=user）不是 agent 人格候选。
  // 生产证据：2026-11-19 layer=identity 的 dilemma/stance/episode 三码 763/761/522 近乎相等，
  // 因为同一批「他是谁/他的职责」描述句被三个门连续拒。挡在闸门外并单独计数，不冒充模型提案被拒。
  it("R31-1：subject=user 的身份事实不进人格候选，单独记 prefilter_user_identity", async () => {
    const { store } = makeStore();
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      identityFacts: async () => [
        { layer: "identity" as const, subject: "user" as const, text: "用户负责 TDB 记忆系统的版本发布与回归验证", evidenceIds: ["r1", "r2"] },
        { layer: "identity" as const, subject: "agent" as const, text: "我宁可少接活，也不交付没验证过的结论", evidenceIds: ["r1", "r2"] },
      ],
    });
    expect(rep.identity?.proposed).toBe(2);
    const codes = (rep.prefiltered ?? []).map((p) => p.code);
    expect(codes).toContain("prefilter_user_identity");
    // user 事实绝不进 rejections（它根本没被送进闸门）。
    expect(rep.rejections.some((x) => x.layer === "identity")).toBe(false);
    const userPrefilter = (rep.prefiltered ?? []).find((p) => p.code === "prefilter_user_identity");
    expect(userPrefilter?.count).toBe(1);
  });

  it("L1 出处能解析成 ep-* 时事件门就不再是缺口（R23-1：id 对接是唯一断点）", () => {
    // 事件池里的 quote.recordId 就是 L1 record_id（episode.ts:799）；解析后 2 条事件满足 identity 的 ≥2 门。
    const eps = [
      { episodeId: "ep-aaa111", quote: { text: "旧句", role: "user", recordId: "msg-1" } },
      { episodeId: "ep-bbb222", quote: { text: "旧句二", role: "user", recordId: "msg-2" } },
      { episodeId: "ep-ccc333", quote: { text: "没有出处", role: "assistant", recordId: "" } },
    ] as unknown as Parameters<typeof episodeIdsByRecordId>[0];
    const map = episodeIdsByRecordId(eps);
    expect(map.get("msg-1")).toEqual(["ep-aaa111"]);
    expect(map.get("msg-2")).toEqual(["ep-bbb222"]);
    expect(map.size).toBe(2);
    const resolved = resolveEpisodeIds(["msg-1", "msg-2", "msg-3"], map);
    expect(resolved).toEqual(["ep-aaa111", "ep-bbb222"]);
    // 闸门只认 ep-*（gates.ts:405-408）：消息 id 本身不算事件出处，解析成 ep-* 才过门。
    expect(countEpisodeEvidence(["msg-1", "msg-2", "msg-3"])).toBe(0);
    expect(countEpisodeEvidence(resolved)).toBeGreaterThanOrEqual(2);
    // 两跳：L1 id → source_message_ids → 事件池键（生产实测 quote.recordId 全是 msg-*）。
    const msgByL1 = new Map([["m_a", ["msg-1"]], ["m_b", ["msg-2"]]]);
    expect(resolveEpisodeIds(["m_a", "m_b"], map, msgByL1)).toEqual(["ep-aaa111", "ep-bbb222"]);
    expect(resolveEpisodeIds(["m_a", "m_a"], map, msgByL1)).toEqual(["ep-aaa111"]);
    expect(resolveEpisodeIds(["m_unknown"], map, msgByL1)).toEqual([]);
  });

  it("命中两跳后身份事实不再吃 episode 门（R23-1 端到端：出处能接到事件上）", async () => {
    const { store, commits } = makeStore();
    // 事件池的 key 是消息 id；L1 行交代自己的消息出处 → m_* 才接得上 ep-*。
    (store as unknown as { listSoulEpisodes: unknown }).listSoulEpisodes = vi.fn(async () => [
      { episodeId: "ep-aaa111", quote: { text: "旧句", role: "user", recordId: "msg-1" } },
      { episodeId: "ep-bbb222", quote: { text: "旧句二", role: "user", recordId: "msg-2" } },
    ]);
    (store as unknown as { getL1ByIdsWithArchive: unknown }).getL1ByIdsWithArchive = vi.fn(async () => [
      { record_id: "m_r1", source_message_ids: ["msg-1"] },
      { record_id: "m_r2", source_message_ids: ["msg-2"] },
    ]);
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      identityFacts: async () => [
        { layer: "identity" as const, text: "我宁可少接活，也不交付没验证过的结论", evidenceIds: ["m_r1", "m_r2"] },
      ],
    });
    expect(rep.identity).toEqual({ proposed: 1, candidates: 1 });
    // 事件门不再是缺口：解析到了 2 条 ep-*，闸门里不会出现 episode_missing。
    const codes = rep.rejections.find((x) => x.layer === "identity")?.codes ?? [];
    expect(codes).not.toContain("episode_missing");
    expect(commits.length).toBeGreaterThanOrEqual(1);
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
