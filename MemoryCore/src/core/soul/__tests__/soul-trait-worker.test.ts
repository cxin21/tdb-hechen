/**
 * S4 接线验收：worker 把判侧票落成 soul_trait_state（G3 只认本轮新增 episode），
 * 标签提案经余弦去重后落库；判侧缺席/无新事件如实标注，不伪造漂移。
 */
import { describe, expect, it, vi } from "vitest";

import { runSoulMaintenance } from "../worker.js";
import { resolveSoulConfig } from "../types.js";
import { SEED_LABELS, emptyAxisVector } from "../traits.js";
import type { TraitLabelRow } from "../trait-drift.js";
import type { IMemoryStore } from "../../store/types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function makeStore(opts: { labels?: TraitLabelRow[]; axis?: number[]; l0?: unknown[] } = {}) {
  const state = { state: emptyAxisVector(), seedState: emptyAxisVector(), updatedAt: "2026-11-07T00:00:00.000Z" };
  if (opts.axis) {
    state.state.rigor = opts.axis[0] ?? 0;
    state.state.warmth = opts.axis[1] ?? 0;
  }
  const writes: Array<{ state: Record<string, number> }> = [];
  const labelCommits: TraitLabelRow[][] = [];
  const store = {
    listSoulPersona: vi.fn(async () => []),
    commitSoulPersona: vi.fn(async () => ({ upserted: 0, ledgered: 0 })),
    readSoulState: vi.fn(async () => null),
    writeSoulState: vi.fn(async () => undefined),
    recentAffectSignals: vi.fn(async () => []),
    listSoulLedger: vi.fn(async () => []),
    commitSoulEpisodes: vi.fn(async () => ({ inserted: 0 })),
    listSoulEpisodes: vi.fn(async () => []),
    recentL0Messages: vi.fn(async () =>
      (opts.l0 as never[]) ?? [
        {
          record_id: "l0-1",
          session_id: "s1",
          role: "user",
          message_text: "没跑就说绿，这是假绿",
          recorded_at: "2026-11-07T08:00:00.000Z",
        },
        {
          record_id: "l0-2",
          session_id: "s1",
          role: "assistant",
          message_text: "我认领，直接重跑补齐证据",
          recorded_at: "2026-11-07T08:01:00.000Z",
        },
      ],
    ),
    readSoulTraitState: vi.fn(async () => ({ ...state, state: { ...state.state }, seedState: { ...state.seedState } })),
    writeSoulTraitState: vi.fn(async (_t: unknown, input: { state: Record<string, number> }) => {
      writes.push({ state: { ...input.state } });
      Object.assign(state.state, input.state);
    }),
    listSoulTraitLabels: vi.fn(async () => opts.labels ?? []),
    commitSoulTraitLabels: vi.fn(async (_t: unknown, rows: TraitLabelRow[]) => {
      labelCommits.push(rows);
      return { upserted: rows.length };
    }),
  } as unknown as IMemoryStore;
  return { store, writes, labelCommits, state };
}

describe("runSoulMaintenance × 特质漂移（S4）", () => {
  it("判侧票只对本轮新增 episode 生效，落库并记账；种子标签首轮补齐", async () => {
    const { store, writes, labelCommits } = makeStore();
    const judge = vi.fn(async (episodes: Array<{ episodeId: string }>) => ({
      invalid: 0,
      votes: [
        { episodeId: episodes[0].episodeId, axis: "rigor" as const, delta: 1 },
        { episodeId: episodes[0].episodeId, axis: "boundary" as const, delta: 1 },
        { episodeId: "ep-not-mined", axis: "rigor" as const, delta: 1 },
      ],
      labelProposals: [
        {
          label: "较真",
          definition: "对细节反复核对，不肯放过",
          direction: { ...emptyAxisVector(), rigor: 1 },
          evidenceIds: ["ep-1", "ep-2", "ep-3"],
        },
      ],
    }));
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      traitJudge: judge,
    });
    // 至少挖到一条事件 → 判侧被调用
    expect(rep.episodes?.mined ?? 0).toBeGreaterThan(0);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(rep.trait).toBeDefined();
    expect(rep.trait?.votes).toBe(2);
    expect(rep.trait?.rejectedVotes).toBe(1);
    // net=1（单票）< 2 → 不动；判据 5 的「不动」也要有账
    expect(writes).toHaveLength(0);
    expect(rep.trait?.changed).toBe(false);
    // 首轮把 18 条种子落库
    expect(labelCommits[0]).toHaveLength(SEED_LABELS.length);
    // 提案「较真」与种子「严谨」余弦 1 → 并入，不并排
    expect(rep.trait?.labels.admitted).toBe(0);
    expect(rep.trait?.labels.merged).toBe(1);
  });

  it("净票 ≥2 → 单轴位移 ≤0.05 并写回 state；标签提案证据不足被拒", async () => {
    const { store, writes } = makeStore();
    const judge = vi.fn(async (episodes: Array<{ episodeId: string }>) => ({
      invalid: 0,
      votes: [
        { episodeId: episodes[0].episodeId, axis: "rigor" as const, delta: 1 },
        { episodeId: episodes[0].episodeId, axis: "rigor" as const, delta: 1 },
      ],
      labelProposals: [
        {
          label: "凑数",
          definition: "证据不足不该进",
          direction: { ...emptyAxisVector(), rigor: 1 },
          evidenceIds: ["ep-1"],
        },
      ],
    }));
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      traitJudge: judge,
    });
    expect(writes).toHaveLength(1);
    // 净票 2 → 0.02·tanh(2/3) = 0.0117
    expect(writes[0].state.rigor).toBeCloseTo(0.0117, 4);
    expect(Math.abs(writes[0].state.rigor)).toBeLessThanOrEqual(0.05);
    expect(rep.trait?.changed).toBe(true);
    expect(rep.trait?.labels.rejected).toBe(1);
  });

  it("判侧缺席 → traitSkipped=no_trait_judge，state 不写", async () => {
    const { store, writes } = makeStore();
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
    });
    expect(writes).toHaveLength(0);
    expect(rep.traitSkipped).toBe("no_trait_judge");
  });

  it("有判侧但本轮没有新增事件 → traitSkipped=no_new_episode（不调判侧）", async () => {
    const { store, writes } = makeStore({ l0: [] });
    const judge = vi.fn(async () => ({ invalid: 0, votes: [], labelProposals: [] }));
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      traitJudge: judge,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(rep.traitSkipped).toBe("no_new_episode");
    expect(rep.trait?.applied).toBe(0);
    expect(rep.trait?.rejected).toBe(0);
  });

  it("判侧抛错 → traitSkipped=judge_failed（不写 state、不伪造零票）", async () => {
    const { store, writes } = makeStore();
    const judge = vi.fn(async () => {
      throw new Error("judge 503");
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      traitJudge: judge,
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(0);
    expect(rep.traitSkipped).toBe("judge_failed");
    expect(rep.trait?.votes).toBe(0);
  });

  it("判侧返回零票但 invalid>0（原始输出非空、一条没解析出）→ judge_failed", async () => {
    const { store, writes } = makeStore();
    const judge = vi.fn(async () => ({ invalid: 2, votes: [], labelProposals: [] }));
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      traitJudge: judge,
    });
    expect(writes).toHaveLength(0);
    expect(rep.traitSkipped).toBe("judge_failed");
  });

  it("rejected>0：report.trait 带 applied/rejected/deltas，且 tick 日志打 trait=applied/rejected", async () => {
    const { store } = makeStore();
    const judge = vi.fn(async (episodes: Array<{ episodeId: string }>) => ({
      invalid: 0,
      votes: [
        { episodeId: episodes[0].episodeId, axis: "rigor" as const, delta: 1 },
        { episodeId: episodes[0].episodeId, axis: "warmth" as const, delta: 1 },
        // 不在本轮新事件里 → 被 driftTraits 挡下（rejected=1）
        { episodeId: "ep-not-mined", axis: "rigor" as const, delta: 1 },
      ],
      labelProposals: [],
    }));
    const info = vi.fn();
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      traitJudge: judge,
      logger: { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
    });
    expect(rep.trait?.votes).toBe(2);
    expect(rep.trait?.applied).toBe(2);
    expect(rep.trait?.rejected).toBe(1);
    expect(rep.trait?.rejectedVotes).toBe(1);
    expect(Array.isArray(rep.trait?.deltas)).toBe(true);
    expect(info.mock.calls.some((c) => String(c[0]).includes("trait=2/1"))).toBe(true);
  });

  it("票是一次性证据：同一批事件第二轮回投 → votes=0、state 不变；只新增 1 条时 votes=1", async () => {
    // 有状态的最小 store：episode 落库、l0 可追加、trait state 持久。
    const episodes: Array<{ episodeId: string }> = [];
    const seen = new Set<string>();
    const trait = { state: emptyAxisVector(), seedState: emptyAxisVector(), updatedAt: "2026-11-07T00:00:00.000Z" };
    const writes: Array<Record<string, number>> = [];
    const l0: Array<Record<string, unknown>> = [
      { record_id: "l0-1", session_id: "s1", role: "user", message_text: "没跑就说绿，这是假绿", recorded_at: "2026-11-07T08:00:00.000Z" },
      { record_id: "l0-2", session_id: "s1", role: "assistant", message_text: "我认领，直接重跑补齐证据", recorded_at: "2026-11-07T08:01:00.000Z" },
    ];
    const store = {
      listSoulPersona: vi.fn(async () => []),
      commitSoulPersona: vi.fn(async () => ({ upserted: 0, ledgered: 0 })),
      readSoulState: vi.fn(async () => null),
      writeSoulState: vi.fn(async () => undefined),
      recentAffectSignals: vi.fn(async () => []),
      listSoulLedger: vi.fn(async () => []),
      commitSoulEpisodes: vi.fn(async (_t: unknown, eps: Array<{ episodeId: string }>) => {
        let inserted = 0;
        for (const ep of eps) {
          if (seen.has(ep.episodeId)) continue;
          seen.add(ep.episodeId);
          episodes.push(ep);
          inserted += 1;
        }
        return { inserted };
      }),
      listSoulEpisodes: vi.fn(async () => episodes),
      recentL0Messages: vi.fn(async () => l0),
      readSoulTraitState: vi.fn(async () => ({
        state: { ...trait.state },
        seedState: { ...trait.seedState },
        updatedAt: trait.updatedAt,
      })),
      writeSoulTraitState: vi.fn(
        async (_t: unknown, input: { state: Record<string, number>; seedState?: Record<string, number> }) => {
          writes.push({ ...input.state });
          Object.assign(trait.state, input.state);
        },
      ),
      listSoulTraitLabels: vi.fn(async () => [] as TraitLabelRow[]),
      commitSoulTraitLabels: vi.fn(async () => ({ upserted: 0 })),
    } as unknown as IMemoryStore;
    const judge = vi.fn(async (eps: Array<{ episodeId: string }>) => ({
      invalid: 0,
      votes: eps.map((ep) => ({ episodeId: ep.episodeId, axis: "rigor" as const, delta: 1 })),
      labelProposals: [],
    }));
    const run = () =>
      runSoulMaintenance({
        store,
        tenant: TENANT,
        trigger: "lifecycle",
        config: { ...resolveSoulConfig({}) },
        traitJudge: judge,
      });

    const r1 = await run();
    expect(r1.trait?.votes).toBeGreaterThan(0);
    expect(judge).toHaveBeenCalledTimes(1);
    const stateAfter1 = { ...trait.state };

    // 第二轮：同一批窗口事件被重算出来，但没有新增 → 不重投、state 不动。
    const r2 = await run();
    expect(judge).toHaveBeenCalledTimes(1);
    expect(r2.trait?.votes).toBe(0);
    expect(r2.traitSkipped).toBe("no_new_episode");
    expect(trait.state).toEqual(stateAfter1);

    // 第三轮：只多一条语料 → 只按新增那一条投票。
    l0.push(
      { record_id: "l0-3", session_id: "s1", role: "user", message_text: "这版空行校验不对，你说跑过了其实没跑", recorded_at: "2026-11-07T09:00:00.000Z" },
      { record_id: "l0-4", session_id: "s1", role: "assistant", message_text: "我认领，先跑一遍再回你", recorded_at: "2026-11-07T09:01:00.000Z" },
    );
    const r3 = await run();
    expect(judge).toHaveBeenCalledTimes(2);
    expect(r3.trait?.votes).toBe(1);
  });
});
