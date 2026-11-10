/**
 * S3 单测：史可重建 + 冻结语义 + 账本协议版本。
 *
 * 验收（用户 S3 口径）：
 *  1) 连续 3 tick episode_history freeze 增量 = 0（规则收紧后冻结一次即收敛，不每 tick 重冻）；
 *  2) deleteSoulEpisodes 改为归档：默认列表/检索不返回，includeArchived 能读回，重新挖到即解除归档；
 *  3) freeze = 状态迁移 + 权重×0.5 + validTo，planRevive 清掉 validTo；
 *  4) 账本 protocolVersion 真的落库并读回（判据 13）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../../config.js";
import { createStoreBundle } from "../../store/factory.js";
import type { IMemoryStore } from "../../store/types.js";
import { freezeItem, planRevive } from "../persona.js";
import { runSoulMaintenance } from "../worker.js";
import { resolveSoulConfig } from "../types.js";
import type { PersonaItem, SoulEpisode, SoulLedgerEntry } from "../types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function episode(over: Partial<SoulEpisode> = {}): SoulEpisode {
  return {
    episodeId: "ep-a1b2c3",
    at: "2026-11-04T09:00:00.000Z",
    day: "2026-11-04",
    kind: "correction",
    title: "假绿被指出",
    object: "假绿",
    participants: [],
    userStance: "没跑就说绿",
    agentStance: "认领并重跑",
    cost: "",
    outcome: "补齐证据",
    valence: -0.5,
    arousal: 0.6,
    intensity: 0.6,
    evidenceIds: ["l0-1"],
    sessionId: "s1",
    quote: null,
    affectSource: "lexicon",
    signals: [],
    ...over,
  };
}

function ledgerEntry(id: string): SoulLedgerEntry {
  return {
    entryId: id,
    at: "2026-11-05T00:00:00.000Z",
    trigger: "lifecycle",
    layer: "self",
    itemId: "self:h1",
    action: "freeze",
    afterHash: "h1",
    gates: ["episode_history"],
    reason: "测试",
    evidenceIds: ["ep-a1b2c3"],
    protocolVersion: "v1",
  };
}

describe("soul_episodes 归档 / soul_ledger 协议版本（真实临时库）", () => {
  let dataDir: string;
  let bundle: Awaited<ReturnType<typeof createStoreBundle>>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "tdai-soul-s3-"));
    bundle = createStoreBundle(parseConfig({}), { dataDir });
    (bundle.store as unknown as { init?: () => unknown }).init?.();
  });

  afterEach(async () => {
    await bundle.store.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("删除即归档：默认列表/检索不返回，includeArchived 读回，重新挖到解除归档", async () => {
    const store = bundle.store;
    const ep = episode();
    await store.commitSoulEpisodes!(TENANT, [ep]);
    expect(await store.listSoulEpisodes!(TENANT)).toHaveLength(1);

    const res = await store.deleteSoulEpisodes!(TENANT, [ep.episodeId]);
    expect(res.archived).toBe(1);
    expect(res.deleted).toBe(0);

    expect(await store.listSoulEpisodes!(TENANT)).toHaveLength(0);
    expect(await store.searchSoulEpisodes!(TENANT, { text: "假绿" })).toHaveLength(0);
    const all = await store.listSoulEpisodes!(TENANT, { includeArchived: true });
    expect(all).toHaveLength(1);
    expect(all[0].archivedAt).toBeTruthy();

    // 重新挖到同一事件 = 重新成为事实：refresh 路径解除归档。
    await store.commitSoulEpisodes!(TENANT, [ep]);
    const revived = await store.listSoulEpisodes!(TENANT);
    expect(revived).toHaveLength(1);
    expect(revived[0].archivedAt).toBeUndefined();
  });

  it("账本 protocol_version 落库并读回", async () => {
    const store = bundle.store;
    await store.commitSoulPersona!(TENANT, { upsert: [], ledger: [ledgerEntry("led-p1")] });
    const rows = await store.listSoulLedger!(TENANT, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].protocolVersion).toBe("v1");
  });
});

describe("冻结语义", () => {
  const base: PersonaItem = {
    itemId: "self:h1",
    layer: "self",
    text: "我没守住：导出那一格我漏了。",
    state: "active",
    weight: 0.8,
    evidenceIds: ["ep-a1b2c3"],
    evidenceDays: ["2026-11-04"],
    evidenceOrigins: ["l1"],
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
    lastEvidenceAt: "2026-11-04T00:00:00.000Z",
  };

  it("冻结 = frozen + 权重×0.5 + validTo；复活清空 validTo", () => {
    const frozen = freezeItem(base, "2026-11-05T00:00:00.000Z");
    expect(frozen.state).toBe("frozen");
    expect(frozen.weight).toBeCloseTo(0.4, 3);
    expect(frozen.validTo).toBe("2026-11-05T00:00:00.000Z");
    const revived = planRevive(frozen, "2026-11-06T00:00:00.000Z", ["ep-new"]);
    expect(revived.state).toBe("active");
    expect(revived.validTo).toBeUndefined();
  });
});

describe("连续 3 tick episode_history freeze 增量 = 0", () => {
  function makeStore(items: PersonaItem[], episodes: SoulEpisode[]) {
    let ledgerSeq = 0;
    const store = {
      listSoulPersona: vi.fn(async () => items.map((i) => ({ ...i }))),
      commitSoulPersona: vi.fn(async (_t: unknown, plan: { upsert: PersonaItem[]; ledger: SoulLedgerEntry[] }) => {
        for (const it of plan.upsert) {
          const idx = items.findIndex((x) => x.itemId === it.itemId);
          if (idx >= 0) items[idx] = it;
          else items.push(it);
        }
        for (const e of plan.ledger) {
          const key = e.itemId ? items.findIndex((x) => x.itemId === e.itemId) : -1;
          if (key >= 0) {
            const meta = (items[key].meta ?? {}) as Record<string, unknown>;
            items[key] = { ...items[key], meta: { ...meta, [`led-${++ledgerSeq}`]: e.action } };
          }
        }
        return { upserted: plan.upsert.length, ledgered: plan.ledger.length };
      }),
      readSoulState: vi.fn(async () => null),
      writeSoulState: vi.fn(async () => undefined),
      recentAffectSignals: vi.fn(async () => []),
      listSoulLedger: vi.fn(async () => []),
      commitSoulEpisodes: vi.fn(async () => ({ inserted: 0 })),
      listSoulEpisodes: vi.fn(async () => episodes),
      recentL0Messages: vi.fn(async () => []),
    } as unknown as IMemoryStore;
    return store;
  }

  it("首 tick 冻结一次，其后连续 3 tick 不再新增 freeze 账本", async () => {
    const items: PersonaItem[] = [
      {
        itemId: "self:h1",
        layer: "self",
        text: "我没守住：导出那一格我漏了。",
        state: "active",
        weight: 0.8,
        evidenceIds: ["ep-gone"],
        evidenceDays: ["2026-11-01"],
        evidenceOrigins: ["l1"],
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        lastEvidenceAt: "2026-11-01T00:00:00.000Z",
        meta: { source: "episode-history", historyKind: "review" },
      },
    ];
    const store = makeStore(items, []);
    const freezeCounts: number[] = [];
    for (let tick = 0; tick < 4; tick++) {
      const planCalls: Array<{ ledger: SoulLedgerEntry[] }> = [];
      const commit = store.commitSoulPersona as unknown as ReturnType<typeof vi.fn>;
      commit.mockImplementation(async (_t: unknown, plan: { upsert: PersonaItem[]; ledger: SoulLedgerEntry[] }) => {
        planCalls.push(plan);
        for (const it of plan.upsert) {
          const idx = items.findIndex((x) => x.itemId === it.itemId);
          if (idx >= 0) items[idx] = it;
          else items.push(it);
        }
        return { upserted: plan.upsert.length, ledgered: plan.ledger.length };
      });
      await runSoulMaintenance({
        store,
        tenant: TENANT,
        trigger: "lifecycle",
        config: resolveSoulConfig({}),
        now: `2026-11-0${5 + tick}T10:00:00.000Z`,
        recentRecords: async () => [],
        recentL0: async () => [],
      });
      const freezes = planCalls
        .flatMap((p) => p.ledger)
        .filter((e) => e.action === "freeze" && (e.gates ?? []).includes("episode_history"));
      freezeCounts.push(freezes.length);
    }
    expect(freezeCounts[0]).toBe(1);
    expect(freezeCounts.slice(1)).toEqual([0, 0, 0]);
    expect(items[0].state).toBe("frozen");
    expect(items[0].validTo).toBeTruthy();
    expect(items[0].weight).toBeCloseTo(0.4, 3);
  });
});
