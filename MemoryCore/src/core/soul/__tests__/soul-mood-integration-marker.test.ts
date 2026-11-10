/**
 * 心境积分：按「事件是否已积过」增量，不按时间水位。
 *
 * 背景（2026-11-08 生产实测）：旧实现把 `soulMeta.moodIntegratedAt` 写成「处理时刻」，
 * 而事件的 `at` 是消息时间。凡是「上一 tick 之后才被挖出来的旧消息」，其 `at` 恒小于水位，
 * 于是被永久跳过——生产库里 48 条事件、11 条非 work，`soul_emotions` 却是 0 行。
 *
 * 现在每条事件落 `mood_integrated_at` 打标：只回答「这条积过没有」，与两个时钟无关，
 * 也天然幂等（同一事件不会被每 tick 重复计权）。
 *
 * 两条不变式：
 *   1 同一事件只积一次（打标后才算积过，写失败则下一轮重试）；
 *   2 迟到事件（`at` 早于上一次 tick 的处理时刻）必须照样积进去。
 */
import { describe, expect, it, vi } from "vitest";

import { runSoulMaintenance } from "../worker.js";
import { resolveSoulConfig, type SoulEpisode, type SoulEpisodeKind } from "../types.js";
import type { IMemoryStore } from "../../store/types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

const T1 = "2026-11-07T10:00:00.000Z";
const T2 = "2026-11-07T11:00:00.000Z";
const T3 = "2026-11-07T12:00:00.000Z";

const ep = (id: string, kind: SoulEpisodeKind, at: string, valence: number): SoulEpisode => ({
  episodeId: id,
  at,
  day: at.slice(0, 10),
  kind,
  title: "",
  object: "",
  participants: [],
  userStance: "",
  agentStance: "",
  cost: "",
  outcome: "",
  valence,
  arousal: 0.6,
  intensity: 1,
  evidenceIds: [],
  sessionId: "s1",
  quote: null,
  affectSource: "lexicon",
});

/** 最小 store：事件池与打标都落内存，其余 absent 即跳过。 */
function makeStore(initial: SoulEpisode[]) {
  const episodes = [...initial];
  let state: Record<string, unknown> | null = null;
  const store = {
    listSoulPersona: vi.fn(async () => []),
    commitSoulPersona: vi.fn(async () => ({ upserted: 0, ledgered: 0 })),
    readSoulState: vi.fn(async () => state),
    writeSoulState: vi.fn(async (_t: unknown, next: Record<string, unknown>) => {
      state = { ...next };
    }),
    recentAffectSignals: vi.fn(async () => []),
    listSoulLedger: vi.fn(async () => []),
    recentL0Messages: vi.fn(async () => []),
    commitSoulEpisodes: vi.fn(async () => ({ inserted: 0 })),
    listSoulEpisodes: vi.fn(async () => episodes.map((e) => ({ ...e }))),
    markSoulEpisodesMoodIntegrated: vi.fn(async (_t: unknown, ids: string[], at: string) => {
      let updated = 0;
      for (const id of ids) {
        const target = episodes.find((e) => e.episodeId === id);
        if (!target || target.moodIntegratedAt) continue;
        target.moodIntegratedAt = at;
        updated += 1;
      }
      return { updated };
    }),
  } as unknown as IMemoryStore;
  return { store, episodes, readState: () => state };
}

const CFG = resolveSoulConfig({});

function tick(store: IMemoryStore, now: string) {
  return runSoulMaintenance({
    store,
    tenant: TENANT,
    trigger: "lifecycle",
    config: { ...CFG },
    now,
  });
}

describe("心境积分：按事件打标增量", () => {
  it("2 条事件两轮 → 第一轮积 2、第二轮积 0；补 1 条 → 第三轮积 1", async () => {
    const { store, episodes, readState } = makeStore([
      ep("e1", "complaint", "2026-11-07T08:00:00.000Z", -0.6),
      ep("e2", "correction", "2026-11-07T09:00:00.000Z", -0.5),
    ]);

    const r1 = await tick(store, T1);
    expect(r1.moodEpisodesIntegrated).toBe(2);
    expect(r1.mood?.written).toBe(true);
    const v1 = r1.mood?.mood.valence ?? 0;
    expect(v1).toBeLessThan(-0.1);
    expect(readState()?.sampleCount).toBe(2);
    // 打标落在事件上，而不是落在某个时间水位上。
    expect(episodes.map((e) => e.moodIntegratedAt)).toEqual([T1, T1]);

    // 第二轮：两条都已打标 → 一条不积，心境只能向基线回落。
    const r2 = await tick(store, T2);
    expect(r2.moodEpisodesIntegrated).toBe(0);
    expect(r2.mood?.mood.valence ?? 0).toBeGreaterThanOrEqual(v1);
    expect(readState()?.sampleCount).toBe(0);

    // 补一条新事件：只有它被积进第三轮。
    episodes.push(ep("e3", "complaint", "2026-11-07T11:30:00.000Z", -0.9));
    const r3 = await tick(store, T3);
    expect(r3.moodEpisodesIntegrated).toBe(1);
    expect(readState()?.sampleCount).toBe(1);
    expect(episodes.find((e) => e.episodeId === "e3")?.moodIntegratedAt).toBe(T3);
  });

  it("迟到事件照样积：at 早于上一次 tick 的处理时刻，也不再被永久跳过", async () => {
    const { store, episodes } = makeStore([ep("new", "complaint", "2026-11-07T09:50:00.000Z", -0.4)]);
    const r1 = await tick(store, T1);
    expect(r1.moodEpisodesIntegrated).toBe(1);

    // 模拟「上一 tick 之后才被挖出来的旧消息」：消息时间 09:55，早于 T1(=10:00) 的处理时刻。
    episodes.push(ep("late", "complaint", "2026-11-07T09:55:00.000Z", -0.8));
    const r2 = await tick(store, T2);
    expect(r2.moodEpisodesIntegrated).toBe(1);
    expect(episodes.find((e) => e.episodeId === "late")?.moodIntegratedAt).toBe(T2);

    // 再跑一轮：没有新事件，一条都不积。
    const r3 = await tick(store, T3);
    expect(r3.moodEpisodesIntegrated).toBe(0);
  });

  it("work 事件不计入心境，也不打标", async () => {
    const { store, episodes } = makeStore([
      ep("w1", "work", "2026-11-07T08:00:00.000Z", 0.2),
      ep("c1", "complaint", "2026-11-07T09:00:00.000Z", -0.4),
    ]);
    const r = await tick(store, T1);
    expect(r.moodEpisodesIntegrated).toBe(1);
    expect(episodes.find((e) => e.episodeId === "w1")?.moodIntegratedAt).toBeUndefined();
    expect(episodes.find((e) => e.episodeId === "c1")?.moodIntegratedAt).toBe(T1);
  });

  it("写心境失败时不打标：下一轮还会重试这条事件", async () => {
    const { store, episodes } = makeStore([ep("e1", "complaint", "2026-11-07T08:00:00.000Z", -0.6)]);
    const write = (store as unknown as { writeSoulState: ReturnType<typeof vi.fn> }).writeSoulState;
    write.mockRejectedValueOnce(new Error("disk full"));

    // 心境没写进去 → 记 0，且不打标（下一轮才会重试这条事件）。
    const r1 = await tick(store, T1);
    expect(r1.moodEpisodesIntegrated).toBe(0);
    expect(episodes[0]?.moodIntegratedAt).toBeUndefined();

    const r2 = await tick(store, T2);
    expect(r2.moodEpisodesIntegrated).toBe(1);
    expect(episodes[0]?.moodIntegratedAt).toBe(T2);
  });
});