/**
 * B1 验收：事件 cap 是「每会话每 tick 新增」，不是扫描期截断。
 *
 * 旧行为（饿死）：`episode.ts` 在扫描时就 `sessionEpisodes >= 5 → break`，最早 5 条入库后，
 * 每 tick 重算仍只产出这 5 条，`fresh` 恒空 → 生产 `soul_episodes` 停在 5 行不再增长。
 * 新行为：扫描只保留防爆上限（200/会话），配额移到 worker 的 commit 前，按「非 work 优先、
 * 其次 at 新→旧」挑 5 条；落选的留到下一 tick，总量最终覆盖全部合格事件且不重复。
 */
import { describe, expect, it, vi } from "vitest";

import { runSoulMaintenance, capFreshEpisodesPerSession } from "../worker.js";
import { mineEpisodes, EPISODE_PER_SESSION_PER_TICK } from "../episode.js";
import { resolveSoulConfig, type SoulEpisode, type SoulEpisodeKind } from "../types.js";
import type { IMemoryStore } from "../../store/types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

/** 12 条同一会话的合格消息（都过 isUtteranceLike + 分类），逐条对应一个真实态度句。 */
const TEXTS = [
  "不对，这不是我要的：先给我一手证据，不要听转述。",
  "你没跑测试就说全绿，这是假绿，我不接受。",
  "这个结论没有实测数字，重做一遍再来。",
  "说了要删干净，你怎么还留着半成品。",
  "收尾报告里没写风险，这算漏项。",
  "这个改动超出了写域，谁批准你去动面板的？",
  "日志和实际上注对不上，你自己去看。",
  "只改核心不碰插件，这句话你听懂了吗。",
  "你又漏了一处，上次也是你。",
  "我不接受这种半成品，回去重做。",
  "这个方案我不认可，退回去重来。",
  "你写的东西根本不能跑，别交给我。",
];

function l0Rows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < TEXTS.length; i += 1) {
    const hh = String(i).padStart(2, "0");
    rows.push({
      record_id: `u${i}`,
      session_id: "s1",
      role: "user",
      message_text: TEXTS[i],
      recorded_at: `2026-11-07T${hh}:00:00.000Z`,
    });
    rows.push({
      record_id: `a${i}`,
      session_id: "s1",
      role: "assistant",
      message_text: "我认领，直接重跑补齐证据。",
      recorded_at: `2026-11-07T${hh}:01:00.000Z`,
    });
  }
  return rows;
}

/** 最小 store：只实现 worker 事件链路真正读写的面，其余 absent 即跳过。 */
function makeStore() {
  const committed: SoulEpisode[] = [];
  const store = {
    listSoulPersona: vi.fn(async () => []),
    commitSoulPersona: vi.fn(async () => ({ upserted: 0, ledgered: 0 })),
    readSoulState: vi.fn(async () => null),
    writeSoulState: vi.fn(async () => undefined),
    recentAffectSignals: vi.fn(async () => []),
    listSoulLedger: vi.fn(async () => []),
    recentL0Messages: vi.fn(async () => l0Rows()),
    commitSoulEpisodes: vi.fn(async (_t: unknown, eps: SoulEpisode[]) => {
      const known = new Set(committed.map((e) => e.episodeId));
      const fresh = eps.filter((e) => !known.has(e.episodeId));
      committed.push(...fresh);
      return { inserted: fresh.length };
    }),
    listSoulEpisodes: vi.fn(async () => committed.map((e) => ({ ...e }))),
    deleteSoulEpisodes: vi.fn(async () => ({ archived: 0 })),
  } as unknown as IMemoryStore;
  return { store, committed };
}

const CFG = resolveSoulConfig({});

function tick(store: IMemoryStore) {
  return runSoulMaintenance({
    store,
    tenant: TENANT,
    trigger: "lifecycle",
    config: { ...CFG },
  });
}

const ep = (id: string, kind: SoulEpisodeKind, at: string, sessionId = "s1"): SoulEpisode => ({
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
  valence: 0,
  arousal: 0,
  intensity: 0,
  evidenceIds: [],
  sessionId,
  quote: null,
  affectSource: "lexicon",
});

describe("B1 事件 cap：扫描不再按会话截断", () => {
  it("mineEpisodes 返回同一会话的全部合格候选（旧实现只给 5 条）", () => {
    const mined = mineEpisodes(l0Rows() as never, CFG, { windowDays: 3650 });
    expect(mined.episodes).toHaveLength(TEXTS.length);
    expect(new Set(mined.episodes.map((e) => e.episodeId)).size).toBe(TEXTS.length);
  });
});

describe("B1 事件 cap：每 tick 新增配额", () => {
  it("同会话 12 条 → tick1 5 / tick2 5 / tick3 2，总数 12 且无重复（下一 tick 能继续吃）", async () => {
    const { store, committed } = makeStore();

    const r1 = await tick(store);
    expect(r1.episodes?.inserted).toBe(EPISODE_PER_SESSION_PER_TICK);
    expect(r1.episodeCapSkipped).toBe(7);

    const r2 = await tick(store);
    expect(r2.episodes?.inserted).toBe(EPISODE_PER_SESSION_PER_TICK);
    expect(r2.episodeCapSkipped).toBe(2);

    const r3 = await tick(store);
    expect(r3.episodes?.inserted).toBe(2);
    expect(r3.episodeCapSkipped).toBe(0);

    // 第四 tick 无事可做：幂等，不重复入库。
    const r4 = await tick(store);
    expect(r4.episodes?.inserted).toBe(0);
    expect(r4.episodeCapSkipped).toBe(0);

    const ids = committed.map((e) => e.episodeId);
    expect(ids).toHaveLength(TEXTS.length);
    expect(new Set(ids).size).toBe(TEXTS.length);
  });
});

describe("B1 事件 cap：每会话挑批顺序", () => {
  it("非 work 优先，其次 at 新→旧；每会话独立计配额", () => {
    const picked = capFreshEpisodesPerSession(
      [
        ep("w1", "work", "2026-11-07T10:00:00.000Z"),
        ep("w2", "work", "2026-11-07T09:00:00.000Z"),
        ep("w3", "work", "2026-11-07T08:00:00.000Z"),
        ep("w4", "work", "2026-11-07T07:00:00.000Z"),
        ep("c1", "complaint", "2026-11-07T06:00:00.000Z"),
        ep("c2", "correction", "2026-11-07T05:00:00.000Z"),
        ep("x1", "work", "2026-11-07T11:00:00.000Z", "s2"),
      ],
      5,
    );
    const s1 = picked.filter((e) => e.sessionId === "s1").map((e) => e.episodeId);
    // 追责/纠正先入账；work 里只有最新的三条补位（最老的 w4 留到下一 tick）。
    expect(s1).toEqual(["c1", "c2", "w1", "w2", "w3"]);
    // 另一个会话有独立配额，不受 s1 挤占。
    expect(picked.filter((e) => e.sessionId === "s2").map((e) => e.episodeId)).toEqual(["x1"]);
  });
});
