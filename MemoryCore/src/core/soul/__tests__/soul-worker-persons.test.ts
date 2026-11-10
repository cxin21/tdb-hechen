/**
 * P2-E：事件挂人 + human 层 per-person 产出（worker 侧接线）。
 *
 * 三条断言（spec §P2-E）：
 *   1) 事件落库前把 participants 里的展示名解析成 person_key（角色词不算人）；
 *   2) 候选的 episodeIds 唯一对应一个在场人 → 只给 **human 层** 条目写 meta.person；
 *   3) 两个及以上在场人 → 不写（同时涉及两人，归到谁都是猜）；非 human 层一律不写。
 * 另加一条 fail-open：resolvePerson / listSoulPersons 抛错时，事件照常落库（人员名单为空），
 * tick 不因此中断——「挂不上人」是降级，不是故障。
 */
import { describe, expect, it, vi } from "vitest";
import { runSoulMaintenance, type SoulEvidenceRecord } from "../worker.js";
import { resolveSoulConfig } from "../types.js";
import type { PersonaItem, SoulEpisode, SoulGateStatBump } from "../types.js";
import type { IMemoryStore } from "../../store/types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const NOW = "2026-11-08T03:00:00.000Z";

const USER_TEXT_A = "不对，你又没跑门禁就报绿，先取证再回话";
const USER_TEXT_B = "先灰度再全量，不要一次全推，这是原则";

const RECORDS: SoulEvidenceRecord[] = [
  { id: "r1", content: "我把召回链路的空结果定位到投影漏列，先取证再改代码。", valence: -0.2, arousal: 0.4 },
  { id: "r2", content: "评审被打回时我没有辩解，直接认领笔误并重跑门禁。", valence: -0.3, arousal: 0.3 },
  { id: "r3", content: "我先跑门禁再回话。", valence: 0, arousal: 0.2 },
];

const PERSON_A = { personKey: "p_name_a", displayName: "何晨", aliases: [] };
const PERSON_B = { personKey: "p_name_b", displayName: "林一", aliases: [] };

function episode(id: string, title: string, participants: string[], persons?: string[]): SoulEpisode {
  return {
    episodeId: id,
    at: "2026-11-08T02:00:00.000Z",
    day: "2026-11-08",
    kind: "decision",
    title,
    object: "",
    participants,
    userStance: "他说了算",
    agentStance: "我照办",
    cost: "",
    outcome: "",
    valence: 0,
    arousal: 0,
    intensity: 0.3,
    evidenceIds: ["l0-1"],
    sessionId: "s1",
    quote: { text: USER_TEXT_A, role: "user", recordId: "l0-1", at: "2026-11-08T01:00:00.000Z" },
    affectSource: "none",
    ...(persons === undefined ? {} : { persons }),
  };
}

function makeStore(opts: {
  episodes?: SoulEpisode[];
  persons?: Array<{ personKey: string; displayName: string; aliases: string[] }>;
  personsThrow?: boolean;
} = {}) {
  const persona: PersonaItem[] = [];
  const committedEpisodes: SoulEpisode[][] = [];
  const personaCommits: Array<{ upsert: PersonaItem[]; ledger: unknown[] }> = [];
  const store = {
    listSoulPersona: vi.fn(async () => []),
    commitSoulPersona: vi.fn(async (_t: unknown, plan: { upsert: PersonaItem[]; ledger: unknown[] }) => {
      personaCommits.push(plan);
      for (const it of plan.upsert) {
        const idx = persona.findIndex((x) => x.itemId === it.itemId);
        if (idx >= 0) persona[idx] = it;
        else persona.push(it);
      }
      return { upserted: plan.upsert.length, ledgered: plan.ledger.length };
    }),
    readSoulState: vi.fn(async () => null),
    writeSoulState: vi.fn(async () => undefined),
    commitSoulEmotions: vi.fn(async () => ({ inserted: 0 })),
    recentAffectSignals: vi.fn(async () => []),
    listSoulLedger: vi.fn(async () => []),
    bumpSoulGateStats: vi.fn(async (_t: unknown, rows: SoulGateStatBump[]) => ({ bumped: rows.length })),
    commitSoulEpisodes: vi.fn(async (_t: unknown, eps: SoulEpisode[]) => {
      committedEpisodes.push(eps.map((e) => ({ ...e })));
      return { inserted: eps.length };
    }),
    listSoulEpisodes: vi.fn(async () => opts.episodes ?? []),
    soulMetaGet: vi.fn(async () => undefined),
    // 两个会话各说一句：mineEpisodes 按会话产事件；cfg.personName 决定 participants 的「人」那一项。
    recentL0Messages: vi.fn(async () =>
      [
        { record_id: "l0-1", session_id: "s1", role: "user", message_text: USER_TEXT_A, recorded_at: "2026-11-08T01:00:00.000Z" },
        { record_id: "l0-2", session_id: "s1", role: "assistant", message_text: "好，先灰度再全量。", recorded_at: "2026-11-08T01:00:05.000Z" },
        { record_id: "l0-3", session_id: "s2", role: "user", message_text: USER_TEXT_B, recorded_at: "2026-11-08T01:30:00.000Z" },
        { record_id: "l0-4", session_id: "s2", role: "assistant", message_text: "记下了，不替你排期。", recorded_at: "2026-11-08T01:30:05.000Z" },
      ].map((m) => ({ ...m, recorded_at: m.recorded_at })),
    ),
    ...(opts.personsThrow
      ? {
          listSoulPersons: vi.fn(async () => {
            throw new Error("soul_person unavailable");
          }),
        }
      : {
          listSoulPersons: vi.fn(async () => opts.persons ?? [PERSON_A, PERSON_B]),
        }),
  } as unknown as IMemoryStore;
  return { store, persona, committedEpisodes, personaCommits };
}

function config(over: Record<string, unknown> = {}) {
  return { ...resolveSoulConfig({}), updateIntervalHours: 0, ...over };
}

describe("P2-E 事件挂人", () => {
  it("participants 里的展示名被解析成 person_key；角色词不进名单", async () => {
    const { store, committedEpisodes } = makeStore();
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: NOW,
      trigger: "manual",
      config: config({ personName: "何晨" }),
      recentRecords: async () => RECORDS,
      rewriter: async () => [],
    });
    const eps = committedEpisodes.flat();
        expect(eps.length).toBeGreaterThan(0);
    // 每个事件都写了人员名单，且名单里只有 p_ 开头的人，没有 assistant/user
    for (const ep of eps) {
      expect(Array.isArray(ep.persons)).toBe(true);
      expect(ep.persons).toEqual([PERSON_A.personKey]);
      expect(ep.participants).toContain("assistant");
    }
    expect(rep.episodes?.inserted ?? 0).toBeGreaterThan(0);
  });

  it("默认 personName 是角色词（用户/助手）→ 名单为空，不给「用户」建人", async () => {
    const { store, committedEpisodes } = makeStore();
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: NOW,
      trigger: "manual",
      config: config(),
      recentRecords: async () => RECORDS,
      rewriter: async () => [],
    });
    const eps = committedEpisodes.flat();
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) expect(ep.persons).toEqual([]);
  });

  it("fail-open：listSoulPersons 抛错时事件照常落库，人员名单为空，tick 不中断", async () => {
    const warnings: string[] = [];
    const { store, committedEpisodes } = makeStore({ personsThrow: true });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: NOW,
      trigger: "manual",
      config: config({ personName: "何晨" }),
      recentRecords: async () => RECORDS,
      logger: { info: () => {}, warn: (m: string) => void warnings.push(m), error: () => {} },
      rewriter: async () => [],
    });
    expect(rep.episodes?.inserted ?? 0).toBeGreaterThan(0);
    for (const ep of committedEpisodes.flat()) expect(ep.persons).toEqual([]);
    expect(warnings.some((w) => w.includes("listSoulPersons failed"))).toBe(true);
  });
});

describe("P2-E human 层 per-person 产出", () => {
  // 事件 id 必须走 evidenceIds：rewriter 提案没有 episodeIds 字段（worker 从 evidenceIds 里过滤真实事件）。
  const humanCandidate = (text: string, episodeIds: string[]) => ({
    layer: "human" as const,
    text,
    evidenceIds: ["r1", "r2", "r3", ...episodeIds],
  });

  it("human 层单写者：改写产线不再产 human 行，挂人能力只留在档案提炼器", async () => {
    const seeded = [episode("ep-a1", "灰度偏好", ["何晨", "assistant"], [PERSON_A.personKey])];
    const { store, personaCommits } = makeStore({ episodes: seeded });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: NOW,
      trigger: "manual",
      config: config({ personName: "何晨" }),
      recentRecords: async () => RECORDS,
      rewriter: async () => [humanCandidate("他没跑门禁就报绿，先取证再回话", ["ep-a1"])],
    });
    // 2026-11-08 单写者：human 只由 core/person/profile-distiller.ts 写（它带 meta.person.key、
    // 字段级 TTL、主语判据）。改写产线即使在唯一在场人时也不再产 human 行。
    const human = personaCommits.flatMap((c) => c.upsert).filter((i) => i.layer === "human");
    expect(human.length).toBe(0);
    const rejected = rep.rejections.filter((r) => r.layer === "human");
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((r) => r.codes.includes("human_writer_removed"))).toBe(true);
    // 事件挂人本身没丢：同一批事件仍带着 person_key（档案提炼器靠它选人）。
    const episodes = await store.listSoulEpisodes!(TENANT, { limit: 10 });
    expect(episodes.some((e) => (e.persons ?? []).includes(PERSON_A.personKey))).toBe(true);
  });


  it("非 human 层即使唯一在场人也不写 meta.person", async () => {
    const seeded = [episode("ep-a1", "灰度偏好", ["何晨", "assistant"], [PERSON_A.personKey])];
    const { store, personaCommits } = makeStore({ episodes: seeded });
    const text = "宁可慢交付，也不交付没验证过的结论";
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: NOW,
      trigger: "manual",
      config: config({ personName: "何晨" }),
      recentRecords: async () => RECORDS,
      rewriter: async () => [{ layer: "values" as const, text, evidenceIds: ["r1", "r2", "r3", "ep-a1"] }],
    });
    const values = personaCommits.flatMap((c) => c.upsert).filter((i) => i.layer === "values");
    for (const item of values) expect((item.meta as { person?: unknown } | undefined)?.person).toBeUndefined();
  });
});