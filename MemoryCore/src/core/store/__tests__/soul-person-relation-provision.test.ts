/**
 * P2 §10.8 / t13：确定性补事件——引文在 L0 唯一命中才建 chat 事件，零/多命中一律不建。
 *
 * 为什么需要这一步：旧关系行（distiller 只带 quote+record_id）里有一批引文是 L0 逐字原话，
 * 但当时没建事件，回指就只能判 unverifiable——事实在库里、卡上却看不见。补事件不调模型、
 * 不生成 L0 之外的内容：证据 record_id 就是命中的那行 L0，quote 是关系引文逐字。
 *
 * 判据：唯一命中才建；dedupe_key 由 relation id 确定性派生，重复执行不翻倍；
 * 建完同 tick 的回指必须把边链上（eventId=ev-rel-<relId>、status=active、卡上可见）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { VectorStore } from "../sqlite.js";
import type { CoreTenant } from "../types.js";
import { buildStructuredRelationshipLines } from "../../soul/card-service.js";

const TENANT: CoreTenant = { teamId: "t1", userId: "u1", agentId: "a1" };
const OTHER: CoreTenant = { teamId: "t2", userId: "u2", agentId: "a2" };
const HE = "p_he";
const ZHOU = "p_zhou";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-relation-provision-")), "vectors.db");
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

function l0(store: VectorStore, tenant: CoreTenant, id: string, text: string, role = "user"): void {
  const ok = store.upsertL0(
    {
      id,
      sessionKey: "s1",
      sessionId: "s1",
      teamId: tenant.teamId,
      userId: tenant.userId,
      agentId: tenant.agentId,
      role,
      messageText: text,
      recordedAt: "2026-11-08T02:00:00.000Z",
      timestamp: Date.parse("2026-11-08T02:00:00.000Z"),
    },
    undefined,
  );
  if (!ok) throw new Error("L0 写入失败：" + id);
}

function relation(store: VectorStore, relId: string, quote: string, objKey: string): void {
  store.commitSoulPersonRelations(TENANT, {
    insert: [
      {
        relId,
        subjKey: HE,
        pred: "上级",
        inversePred: null,
        objKey,
        objName: null,
        direction: "out",
        quote,
        recordId: "m_1",
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

function eventCount(store: VectorStore): number {
  return (raw(store).prepare("SELECT COUNT(*) AS n FROM soul_events").get() as { n: number }).n;
}

describe("P2 §10.8 / t13：确定性补事件", () => {
  it("L0 精确唯一命中 → 建 chat 事件（证据逐字回指该 L0 行），同 tick 回指即可链上", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    store.upsertSoulPerson(TENANT, { personKey: ZHOU, displayName: "周衡" });
    l0(store, TENANT, "l0-1", "周衡是我直属上级");
    relation(store, "r-1", "周衡是我直属上级", ZHOU);

    const out = store.provisionSoulRelationEvents(TENANT, { now: "2026-11-10T00:00:00.000Z" });
    expect(out).toEqual({ scanned: 1, created: 1, ambiguous: 0, skipped: 0 });

    const ev = raw(store)
      .prepare("SELECT event_id, source_kind, source_ref, actor, intent, dedupe_key, persons_json FROM soul_events")
      .get() as Record<string, unknown>;
    expect(ev.event_id).toBe("ev-rel-r-1");
    expect(ev.source_kind).toBe("chat");
    expect(ev.source_ref).toBe("l0-1");
    expect(ev.actor).toBe("user");
    expect(ev.intent).toBe("上级");
    // dedupe_key 是 compose 过的：租户三列 + U+001F + 键。
    expect(String(ev.dedupe_key)).toContain("relation-backfill:r-1");
    expect(String(ev.dedupe_key)).toContain("\u001f");
    expect(JSON.parse(String(ev.persons_json))).toEqual([HE]);

    const evd = raw(store)
      .prepare("SELECT record_id, role, quote, confidence FROM soul_event_evidence WHERE event_id = 'ev-rel-r-1'")
      .get() as Record<string, unknown>;
    expect(evd).toEqual({ record_id: "l0-1", role: "user", quote: "周衡是我直属上级", confidence: 1 });

    const chat = raw(store)
      .prepare("SELECT kind, title FROM soul_event_chat WHERE event_id = 'ev-rel-r-1'")
      .get() as Record<string, unknown>;
    expect(chat).toEqual({ kind: "relation", title: "上级" });

    // 同一 tick 的回指：补完事件就能链上，卡上看到这一行。
    const back = store.backfillSoulPersonRelationEventIds(TENANT);
    expect(back).toEqual({ scanned: 1, linked: 1, unverifiable: 0 });
    expect(row(store, "r-1")!.eventId).toBe("ev-rel-r-1");
    expect(row(store, "r-1")!.status).toBe("active");
    expect(cardLines(store)).toContain("你与周衡：上级");
    store.close();
  });

  it("唯一子串命中（L0 原文更长）也建事件；role 跟着 L0 行走", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    l0(store, TENANT, "l0-1", "周衡是我直属上级，汇报线从入职到现在没变过。", "assistant");
    relation(store, "r-1", "周衡是我直属上级", ZHOU);

    const out = store.provisionSoulRelationEvents(TENANT);
    expect(out.created).toBe(1);
    const evd = raw(store)
      .prepare("SELECT record_id, role FROM soul_event_evidence WHERE event_id = 'ev-rel-r-1'")
      .get() as Record<string, unknown>;
    expect(evd).toEqual({ record_id: "l0-1", role: "assistant" });
    expect(store.backfillSoulPersonRelationEventIds(TENANT).linked).toBe(1);
    expect(row(store, "r-1")!.eventId).toBe("ev-rel-r-1");
    store.close();
  });

  it("多命中 → 不建事件（ambiguous），回指标 unverifiable，不进卡", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    l0(store, TENANT, "l0-1", "独立评审后由 Lead 验收。");
    l0(store, TENANT, "l0-2", "上次也是独立评审后由 Lead 验收的");
    relation(store, "r-1", "独立评审后由 Lead 验收", ZHOU);

    const out = store.provisionSoulRelationEvents(TENANT);
    expect(out).toEqual({ scanned: 1, created: 0, ambiguous: 1, skipped: 0 });
    expect(eventCount(store)).toBe(0);
    expect(store.backfillSoulPersonRelationEventIds(TENANT).unverifiable).toBe(1);
    expect(cardLines(store)).toEqual([]);
    store.close();
  });

  it("零命中 → 不建事件（skipped），回指标 unverifiable", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    l0(store, TENANT, "l0-1", "完全无关的一句话");
    relation(store, "r-1", "库里没有这句", ZHOU);

    const out = store.provisionSoulRelationEvents(TENANT);
    expect(out).toEqual({ scanned: 1, created: 0, ambiguous: 0, skipped: 1 });
    expect(eventCount(store)).toBe(0);
    expect(row(store, "r-1")!.status).toBe("active");
    expect(store.backfillSoulPersonRelationEventIds(TENANT).unverifiable).toBe(1);
    store.close();
  });

  it("重复执行不翻倍：第二次 created=0、事件行数不变", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    l0(store, TENANT, "l0-1", "周衡是我直属上级");
    relation(store, "r-1", "周衡是我直属上级", ZHOU);

    expect(store.provisionSoulRelationEvents(TENANT).created).toBe(1);
    const n1 = eventCount(store);
    // 回指之后关系已有 event_id：第三遍连扫描都不该进（但这里先测「事件已存在」这条路：
    // 不跑回指、直接第二次 provision，才证明 dedupe 而不是 event_id 档住了重复）。
    const second = store.provisionSoulRelationEvents(TENANT);
    expect(second).toEqual({ scanned: 1, created: 0, ambiguous: 0, skipped: 1 });
    expect(eventCount(store)).toBe(n1);
    // 回指链上后再跑：已判定的边不再进扫描。
    expect(store.backfillSoulPersonRelationEventIds(TENANT).linked).toBe(1);
    const third = store.provisionSoulRelationEvents(TENANT);
    expect(third).toEqual({ scanned: 0, created: 0, ambiguous: 0, skipped: 0 });
    expect(eventCount(store)).toBe(n1);
    store.close();
  });

  it("该 L0 行已有事件 → 不补，留给回指链上那一条（不把唯一变多命中）", async () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    l0(store, TENANT, "l0-1", "周衡是我直属上级");
    const { insertSoulEvent } = await import("../soul-event-store.js");
    insertSoulEvent(raw(store) as unknown as Parameters<typeof insertSoulEvent>[0], TENANT, {
      event: {
        event_id: "ep-existing",
        at: "2026-11-08T02:00:00.000Z",
        day: "2026-11-08",
        valid_from: "2026-11-08T02:00:00.000Z",
        actor: "user",
        action: "said",
        object: "",
        intent: "上级",
        outcome: "",
        status: "unknown",
        source_kind: "chat",
        source_ref: "l0-1",
        ownership: "theirs",
        epistemic: "observed",
        confidence: 0.8,
        visibility: "shared",
        session_id: "s1",
        salience: 0.5,
        created_at: "2026-11-08T02:00:00.000Z",
      },
      evidence: [
        {
          event_id: "ep-existing",
          record_id: "l0-1",
          role: "user",
          quote: "周衡是我直属上级",
          at: "2026-11-08T02:00:00.000Z",
          confidence: 1,
        },
      ],
    });
    relation(store, "r-1", "周衡是我直属上级", ZHOU);

    expect(store.provisionSoulRelationEvents(TENANT)).toEqual({
      scanned: 1,
      created: 0,
      ambiguous: 0,
      skipped: 1,
    });
    expect(store.backfillSoulPersonRelationEventIds(TENANT).linked).toBe(1);
    expect(row(store, "r-1")!.eventId).toBe("ep-existing");
    store.close();
  });

  it("租户隔离：别的租户的 L0 不算命中；别人的关系不进扫描", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    l0(store, OTHER, "l0-other", "周衡是我直属上级");
    relation(store, "r-1", "周衡是我直属上级", ZHOU);

    expect(store.provisionSoulRelationEvents(TENANT)).toEqual({
      scanned: 1,
      created: 0,
      ambiguous: 0,
      skipped: 1,
    });
    expect(eventCount(store)).toBe(0);
    store.close();
  });
});
