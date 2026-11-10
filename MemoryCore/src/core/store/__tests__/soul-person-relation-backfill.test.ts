/**
 * P2（spec §5.1/§10.8）：关系边 event_id 确定性回指的三态与幂等。
 *
 * 判据：record_id 当 L1 id 走 source_message_ids，或 quote 在 L0 同租户里精确/唯一子串命中，
 * 再经 soul_event_evidence 收敛到**恰好 1 个事件**才写 event_id；零命中或多命中一律
 * status='unverifiable'（保留事实、不进卡），绝不猜、不回退姓名/谓词。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { VectorStore } from "../sqlite.js";
import type { CoreTenant } from "../types.js";
import { buildStructuredRelationshipLines } from "../../soul/card-service.js";
import type { SoulEpisode } from "../../soul/types.js";

const TENANT: CoreTenant = { teamId: "t1", userId: "u1", agentId: "a1" };
const OTHER: CoreTenant = { teamId: "t2", userId: "u2", agentId: "a2" };
const HE = "p_he";
const ZHOU = "p_zhou";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-relation-backfill-")), "vectors.db");
}

function makeStore(dbPath: string): VectorStore {
  const store = new VectorStore(dbPath, 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）：" + res.reason);
  return store;
}

type Raw = {
  prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown };
};
const raw = (store: VectorStore) => (store as unknown as { db: Raw }).db;

function l0(store: VectorStore, tenant: CoreTenant, id: string, text: string): void {
  const ok = store.upsertL0(
    {
      id,
      sessionKey: "s1",
      sessionId: "s1",
      teamId: tenant.teamId,
      userId: tenant.userId,
      agentId: tenant.agentId,
      role: "user",
      messageText: text,
      recordedAt: "2026-11-08T02:00:00.000Z",
      timestamp: Date.parse("2026-11-08T02:00:00.000Z"),
    },
    undefined,
  );
  if (!ok) throw new Error("L0 写入失败：" + id);
}

function episode(id: string, evidenceIds: string[]): SoulEpisode {
  return {
    episodeId: id,
    at: "2026-11-08T02:00:00.000Z",
    day: "2026-11-08",
    kind: "decision",
    title: "关系",
    object: "周衡",
    participants: ["何晨", "周衡"],
    userStance: "周衡是我直属上级",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: 0.2,
    arousal: 0.2,
    intensity: 0.3,
    evidenceIds,
    sessionId: "s1",
    quote: null,
    affectSource: "none",
    persons: [HE],
  };
}

function relation(store: VectorStore, relId: string, quote: string, recordId: string): void {
  store.commitSoulPersonRelations(TENANT, {
    insert: [
      {
        relId,
        subjKey: HE,
        pred: "上级",
        inversePred: null,
        objKey: ZHOU,
        objName: null,
        direction: "out",
        quote,
        recordId,
        evidence: [],
        validFrom: "2026-11-08T00:00:00.000Z",
        validTo: null,
        createdAt: "2026-11-08T00:00:00.000Z",
        updatedAt: "2026-11-08T00:00:00.000Z",
      },
    ],
  });
}

function row(store: VectorStore, relId: string) {
  return store.listSoulPersonRelations(TENANT, { includeClosed: true }).find((r) => r.relId === relId);
}

function cardLines(store: VectorStore) {
  return buildStructuredRelationshipLines({
    relations: store.listSoulPersonRelations(TENANT, { includeClosed: true }),
    personNames: new Map([[ZHOU, "周衡"]]),
    persons: [HE],
  }).lines;
}

describe("P2 §10.8：关系边 event_id 确定性回指", () => {
  it("L0 精确命中且唯一 → 写 event_id，卡上能看到", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    store.upsertSoulPerson(TENANT, { personKey: ZHOU, displayName: "周衡" });
    l0(store, TENANT, "l0-1", "周衡是我直属上级");
    store.commitSoulEpisodes(TENANT, [episode("ep-1", ["l0-1"])]);
    relation(store, "r-1", "周衡是我直属上级", "m_1");

    const out = store.backfillSoulPersonRelationEventIds(TENANT, { now: "2026-11-10T00:00:00.000Z" });
    expect(out).toEqual({ scanned: 1, linked: 1, unverifiable: 0 });
    expect(row(store, "r-1")!.eventId).toBe("ep-1");
    expect(row(store, "r-1")!.status).toBe("active");
    expect(cardLines(store)).toContain("你与周衡：上级");
  });

  it("唯一子串命中（原文更长）也算唯一 → 写 event_id", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    l0(store, TENANT, "l0-1", "周衡是我直属上级，汇报线从入职到现在没变过。");
    store.commitSoulEpisodes(TENANT, [episode("ep-1", ["l0-1"])]);
    relation(store, "r-1", "周衡是我直属上级", "m_1");

    expect(store.backfillSoulPersonRelationEventIds(TENANT).linked).toBe(1);
    expect(row(store, "r-1")!.eventId).toBe("ep-1");
  });

  it("L1 record_id 路径：source_message_ids → L0 → 事件证据", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    l0(store, TENANT, "l0-1", "原文");
    store.commitSoulEpisodes(TENANT, [episode("ep-1", ["l0-1"])]);
    raw(store)
      .prepare(
        "INSERT INTO l1_records (record_id, content, team_id, user_id, agent_id, source_message_ids) VALUES (?,?,?,?,?,?)",
      )
      .run("l1-1", "摘要", TENANT.teamId, TENANT.userId, TENANT.agentId, JSON.stringify(["l0-1"]));
    // quote 在 L0 里根本不出现：只有 L1 路径能连上，证明判据确实先走 record_id。
    relation(store, "r-1", "这句引文不在 L0 里", "l1-1");

    expect(store.backfillSoulPersonRelationEventIds(TENANT).linked).toBe(1);
    expect(row(store, "r-1")!.eventId).toBe("ep-1");
  });

  it("多命中 → unverifiable，保留行但不进卡", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    // 两条都不是精确等于 quote：精确匹配 0 条 → 子串匹配 2 条 → 不唯一。
    l0(store, TENANT, "l0-1", "独立评审后由 Lead 验收。");
    l0(store, TENANT, "l0-2", "上次也是独立评审后由 Lead 验收的");
    store.commitSoulEpisodes(TENANT, [episode("ep-1", ["l0-1"]), episode("ep-2", ["l0-2"])]);
    relation(store, "r-1", "独立评审后由 Lead 验收", "m_1");

    const out = store.backfillSoulPersonRelationEventIds(TENANT);
    expect(out).toEqual({ scanned: 1, linked: 0, unverifiable: 1 });
    const r = row(store, "r-1")!;
    expect(r.eventId).toBeNull();
    expect(r.status).toBe("unverifiable");
    expect(cardLines(store)).toEqual([]);
  });

  it("零命中 → unverifiable；空 quote 同样不猜", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    l0(store, TENANT, "l0-1", "完全无关的一句话");
    relation(store, "r-1", "库里没有这句", "m_1");
    relation(store, "r-2", "   ", "m_2");

    const out = store.backfillSoulPersonRelationEventIds(TENANT);
    expect(out).toEqual({ scanned: 2, linked: 0, unverifiable: 2 });
    expect(row(store, "r-1")!.status).toBe("unverifiable");
    expect(row(store, "r-2")!.status).toBe("unverifiable");
  });

  it("租户隔离：别的租户的 L0 不算命中", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    l0(store, OTHER, "l0-other", "周衡是我直属上级");
    relation(store, "r-1", "周衡是我直属上级", "m_1");

    expect(store.backfillSoulPersonRelationEventIds(TENANT).unverifiable).toBe(1);
    expect(row(store, "r-1")!.eventId).toBeNull();
  });

  it("幂等：已判定（linked/unverifiable）的边不再扫，重跑 scanned=0", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    l0(store, TENANT, "l0-1", "周衡是我直属上级");
    store.commitSoulEpisodes(TENANT, [episode("ep-1", ["l0-1"])]);
    relation(store, "r-1", "周衡是我直属上级", "m_1");
    relation(store, "r-2", "库里没有这句", "m_2");

    store.backfillSoulPersonRelationEventIds(TENANT);
    expect(store.backfillSoulPersonRelationEventIds(TENANT)).toEqual({ scanned: 0, linked: 0, unverifiable: 0 });
    expect(row(store, "r-1")!.eventId).toBe("ep-1");
  });
});
