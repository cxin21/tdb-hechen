/**
 * P2-E 身份来源：事件的说话人取 L0 的真列（user_id），展示名只作最后回退。
 *
 * 这一层修的是一个根因：`participants` 里写的是 `cfg.personName`（默认「用户」），
 * 拿展示名当身份 → 角色词被剔除 → 生产 57 条事件 50 条 persons 为空。
 * 这里守五条：
 *   1) 老行没带 user_id → speaker 缺省，按展示名回退（历史数据只有名字可查）；
 *   2) 有 user_id → person_key 由 platformId 直接推出，与 personKeyOf 手算一致（p_ 前缀）；
 *   3) 同一 tick 内同一 user_id 只解析一次（缓存），否则一个人会被写多行；
 *   4) 无 user_id、名字唯一命中 → 复用既有 person_key（不新建人）；
 *   5) 角色词不算人 / 解析抛错 → 名单为空且事件照常落库（fail-open）。
 *
 * 未覆盖（见交付报告「没做到的」）：名字 0 命中或重名时「不挂人」。
 * resolvePerson 的既有判据是「0 命中新建、重名也新建、绝不猜」（person/resolve.ts:140、175-177），
 * 要满足那条断言必须改判据本身——本轮不改。
 */
import { describe, expect, it, vi } from "vitest";
import { personKeyOf } from "../../person/resolve.js";
import type { IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import { EPISODE_SPEAKER_PLATFORM } from "../episode.js";
import { resolveSoulConfig } from "../types.js";
import type { SoulEpisode } from "../types.js";
import { runSoulMaintenance, type SoulEvidenceRecord } from "../worker.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const NOW = "2026-11-08T03:00:00.000Z";
const USER_ID = "usr-2m7b1144d9";
const AGENT_ID = "agt-bbr29z58s2";

const USER_TEXT_A = "不对，你又没跑门禁就报绿，先取证再回话";
const USER_TEXT_B = "先灰度再全量，不要一次全推，这是原则";

const RECORDS: SoulEvidenceRecord[] = [
  { id: "r1", content: "我把召回链路的空结果定位到投影漏列，先取证再改代码。", valence: -0.2, arousal: 0.4 },
  { id: "r2", content: "评审被打回时我没有辩解，直接认领笔误并重跑门禁。", valence: -0.3, arousal: 0.3 },
  { id: "r3", content: "我先跑门禁再回话。", valence: 0, arousal: 0.2 },
];

const PERSON_A = { personKey: "p_name_a", displayName: "何晨", aliases: [] };

type Row = {
  record_id: string;
  session_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  user_id?: string;
  agent_id?: string;
};

/** 两个会话各一轮对话：给了 ids 就带上真列，不给就是老行（模拟缺列/缺值）。 */
function rows(ids?: { userId?: string; agentId?: string }): Row[] {
  const extra = {
    ...(ids?.userId === undefined ? {} : { user_id: ids.userId }),
    ...(ids?.agentId === undefined ? {} : { agent_id: ids.agentId }),
  };
  return [
    {
      record_id: "l0-1",
      session_id: "s1",
      role: "user",
      message_text: USER_TEXT_A,
      recorded_at: "2026-11-08T01:00:00.000Z",
      ...extra,
    },
    {
      record_id: "l0-2",
      session_id: "s1",
      role: "assistant",
      message_text: "好，先灰度再全量。",
      recorded_at: "2026-11-08T01:00:05.000Z",
      ...extra,
    },
    {
      record_id: "l0-3",
      session_id: "s2",
      role: "user",
      message_text: USER_TEXT_B,
      recorded_at: "2026-11-08T01:30:00.000Z",
      ...extra,
    },
    {
      record_id: "l0-4",
      session_id: "s2",
      role: "assistant",
      message_text: "记下了，不替你排期。",
      recorded_at: "2026-11-08T01:30:05.000Z",
      ...extra,
    },
  ];
}

function makeStore(
  opts: {
    input?: Row[];
    persons?: Array<{ personKey: string; displayName: string; aliases: string[] }>;
    personsThrow?: boolean;
  } = {},
) {
  const committedEpisodes: SoulEpisode[][] = [];
  const upsertCalls: Array<{ personKey: string; platform?: string; platformId?: string | null }> = [];
  const byPlatformCalls: Array<{ platform?: string; platformId?: string }> = [];
  const store = {
    listSoulPersona: vi.fn(async () => []),
    commitSoulPersona: vi.fn(async () => ({ upserted: 0, ledgered: 0 })),
    readSoulState: vi.fn(async () => null),
    writeSoulState: vi.fn(async () => undefined),
    commitSoulEmotions: vi.fn(async () => ({ inserted: 0 })),
    recentAffectSignals: vi.fn(async () => []),
    listSoulLedger: vi.fn(async () => []),
    bumpSoulGateStats: vi.fn(async () => ({ bumped: 0 })),
    commitSoulEpisodes: vi.fn(async (_t: unknown, eps: SoulEpisode[]) => {
      committedEpisodes.push(eps.map((e) => ({ ...e })));
      return { inserted: eps.length };
    }),
    listSoulEpisodes: vi.fn(async () => []),
    soulMetaGet: vi.fn(async () => undefined),
    recentL0Messages: vi.fn(async () => (opts.input ?? rows()).map((r) => ({ ...r }))),
    // 没有平台命中行 → resolvePerson 落 ③ 新建；upsert 回显入参，便于观察 key 与被调次数。
    getSoulPersonByPlatform: vi.fn(async (_t: unknown, hint: { platform?: string; platformId?: string }) => {
      byPlatformCalls.push(hint);
      return null;
    }),
    upsertSoulPerson: vi.fn(async (_t: unknown, row: { personKey: string; platform?: string; platformId?: string | null }) => {
      upsertCalls.push(row);
      return row;
    }),
    ...(opts.personsThrow
      ? {
          listSoulPersons: vi.fn(async () => {
            throw new Error("soul_person unavailable");
          }),
        }
      : { listSoulPersons: vi.fn(async () => opts.persons ?? [PERSON_A]) }),
  } as unknown as IMemoryStore;
  return { store, committedEpisodes, upsertCalls, byPlatformCalls };
}

function config(over: Record<string, unknown> = {}) {
  return { ...resolveSoulConfig({}), updateIntervalHours: 0, ...over };
}

function run(store: IMemoryStore, over: Record<string, unknown> = {}, logger?: Logger) {
  return runSoulMaintenance({
    store,
    tenant: TENANT,
    now: NOW,
    trigger: "manual",
    config: config(over),
    recentRecords: async () => RECORDS,
    rewriter: async () => [],
    ...(logger === undefined ? {} : { logger }),
  });
}

describe("P2-E 说话人身份：L0 真列优先", () => {
  it("① 老行没有 user_id/agent_id → speaker 缺省，按展示名回退并照常落库", async () => {
    const { store, committedEpisodes } = makeStore();
    const rep = await run(store, { personName: "何晨" });
    const eps = committedEpisodes.flat();
    expect(eps.length).toBe(2);
    for (const ep of eps) {
      // 没有真身份就绝不编一个：speaker 缺省，调用侧才知道要走名字回退。
      expect(ep.speaker).toBeUndefined();
      expect(ep.participants).toContain("assistant");
      expect(ep.persons).toEqual([PERSON_A.personKey]);
    }
    expect(rep.episodes?.inserted ?? 0).toBe(2);
  });

  it("P2-E2：名字回退只复用、不新建——租户里没这个名字就不挂人", async () => {
    // 名单里只有 A（何晨），本轮 participants 写的是「小满」这种谁也不是的名字
    const { store, committedEpisodes, upsertCalls } = makeStore({ persons: [PERSON_A] });
    const rep = await run(store, { personName: "小满" });
    const eps = committedEpisodes.flat();
    expect(rep.episodes?.inserted ?? 0).toBe(2);
    for (const ep of eps) expect(ep.persons).toEqual([]);
    // 关键：不允许为了「挂上人」而新建一行 soul_person
    expect(upsertCalls).toEqual([]);
  });

  it("② 有 user_id → persons 由 platformId 直接推出，与 personKeyOf 手算一致", async () => {
    const { store, committedEpisodes, byPlatformCalls, upsertCalls } = makeStore({
      input: rows({ userId: USER_ID, agentId: AGENT_ID }),
      persons: [],
    });
    await run(store, { personName: "何晨" });
    const expected = personKeyOf({
      teamId: TENANT.teamId,
      userId: TENANT.userId,
      agentId: TENANT.agentId,
      platform: EPISODE_SPEAKER_PLATFORM,
      platformId: USER_ID,
    });
    const eps = committedEpisodes.flat();
    expect(eps.length).toBe(2);
    for (const ep of eps) {
      expect(ep.speaker).toMatchObject({ userId: USER_ID, agentId: AGENT_ID, displayName: "何晨" });
      // participants 保持展示层原样：身份不许借道这里。
      expect(ep.participants).toEqual(["何晨", "assistant"]);
      expect(ep.persons).toEqual([expected]);
      expect(ep.persons?.[0] ?? "").toMatch(/^p_/);
    }
    expect(expected).toBe(personKeyOf({ ...TENANT, platform: "tdai", platformId: USER_ID }));
    // 平台命中查询按 (platform=tdai, platformId=user_id) 走，且没被展示名带到别的平台
    expect(byPlatformCalls.every((c) => c.platform === EPISODE_SPEAKER_PLATFORM && c.platformId === USER_ID)).toBe(true);
    // 两个人（两会话）同一个 id：缓存生效 → 只建一行
    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0].personKey).toBe(expected);
    expect(upsertCalls[0].platformId).toBe(USER_ID);
  });

  it("③ 同一 user_id 在两个会话里重复出现 → 只解析/建行一次（tick 内缓存）", async () => {
    const { store, committedEpisodes, byPlatformCalls, upsertCalls } = makeStore({
      input: rows({ userId: USER_ID }),
      persons: [],
    });
    await run(store, { personName: "何晨" });
    expect(committedEpisodes.flat().length).toBe(2);
    expect(byPlatformCalls.length).toBe(1);
    expect(upsertCalls.length).toBe(1);
    const keys = new Set(committedEpisodes.flat().map((ep) => ep.persons?.[0]));
    expect(keys.size).toBe(1);
  });

  it("④ 无 user_id、名字唯一命中 → 复用既有 person_key（不新建人）", async () => {
    const { store, committedEpisodes, upsertCalls } = makeStore({
      persons: [{ personKey: "p_name_a", displayName: "何晨", aliases: ["小何"] }],
    });
    await run(store, { personName: "小何" });
    for (const ep of committedEpisodes.flat()) {
      expect(ep.speaker).toBeUndefined();
      expect(ep.persons).toEqual(["p_name_a"]);
    }
    expect(upsertCalls.length).toBe(0);
  });

  it("⑤a 无 user_id、参与者只剩角色词 → 名单为空，不给「用户」建人", async () => {
    const { store, committedEpisodes, upsertCalls } = makeStore({ persons: [] });
    await run(store);
    for (const ep of committedEpisodes.flat()) {
      expect(ep.speaker).toBeUndefined();
      expect(ep.persons).toEqual([]);
    }
    expect(upsertCalls.length).toBe(0);
  });

  it("⑤b 无 user_id、租户名单读失败 → fail-open：事件照常落库，名单为空，tick 不中断", async () => {
    const warnings: string[] = [];
    const { store, committedEpisodes } = makeStore({ personsThrow: true });
    const rep = await run(store, { personName: "何晨" }, {
      info: () => {},
      warn: (m: string) => void warnings.push(m),
      error: () => {},
    });
    expect(rep.episodes?.inserted ?? 0).toBe(2);
    for (const ep of committedEpisodes.flat()) {
      expect(ep.persons).toEqual([]);
      expect(ep.quote?.recordId ?? "").not.toBe("");
    }
    expect(warnings.some((w) => w.includes("listSoulPersons failed"))).toBe(true);
    // P2-E2 起名字回退只复用不新建：拿不到名单时不可能挂人，也不会去 resolvePerson 建人，
    // 所以这里不再期待那条 warn（它只在平台 id 路径失败时才会出现）。
  });
});

describe("EPISODE_SPEAKER_PLATFORM", () => {
  it("与补齐脚本共用的平台名是 tdai，且 platformId 分支的 key 不是名字分支", () => {
    expect(EPISODE_SPEAKER_PLATFORM).toBe("tdai");
    const byId = personKeyOf({ ...TENANT, platform: EPISODE_SPEAKER_PLATFORM, platformId: USER_ID });
    const byName = personKeyOf({ ...TENANT, displayName: "何晨" });
    expect(byId).not.toBe(byName);
    expect(byName.startsWith("p_name_")).toBe(true);
  });
});
