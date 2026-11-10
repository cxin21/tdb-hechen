/**
 * soul-event-store（P0-B）契约测试。
 *
 * 守这几条：
 *  1. 一次写入 = 基表 + 类型子表 + 证据，要么全落要么全不落（含子表写到一半失败）。
 *  2. 省略字段按 DDL DEFAULT 物化——这条测试把「DDL 默认值」与「store 抄的默认值」钉在一起，
 *     谁改了 DDL 忘改 store，这里先红。
 *  3. 证据规则在写入侧准入：没有证据只能 inferred + confidence<=0.5，store 不伪造证据。
 *  4. 过滤口径：at 左闭右开、数组多选、空数组短路成零结果、personKey 与 presentPersonKey 不同义。
 *  5. 子表 upsert 是整行覆盖（省略字段回默认值），不是打补丁。
 *  6. 删除显式清四张子表，不靠 ON DELETE CASCADE（PRAGMA foreign_keys 默认 OFF，CASCADE 是死约束）。
 *  7. 租户隔离：读、写、删、子表 upsert 都按 tenant 过滤，异租户一律「不存在」。
 *
 * 每个用例都用 :memory: 库 + 顺序执行 SOUL_EVENT_DDL，互不共享状态。
 */

import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SOUL_EVENT_DDL } from "../soul-event-ddl.js";
import {
  SoulEventWriteError,
  countSoulEvents,
  deleteSoulEvent,
  getSoulEvent,
  getSoulEventDetail,
  insertSoulEvent,
  insertSoulEventInTransaction,
  listSoulEventEvidence,
  listSoulEvents,
  upsertSoulEventAction,
  upsertSoulEventChat,
  upsertSoulEventInTransaction,
  upsertSoulEventReflection,
} from "../soul-event-store.js";
import type { CoreTenant } from "../types.js";
import type { SoulEventChatInsert, SoulEventEvidenceInsert, SoulEventInsert } from "../soul-event-types.js";

const TENANT: CoreTenant = { teamId: "team-a", userId: "u-1", agentId: "ag-1" };
const OTHER_TENANT: CoreTenant = { teamId: "team-a", userId: "u-1", agentId: "ag-2" };

/** 建一个干净的内存库；foreignKeysOn 用来显式对比「开不开启 FK」两种世界。 */
function makeDb(foreignKeysOn = true): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = " + (foreignKeysOn ? "ON" : "OFF"));
  for (const sql of SOUL_EVENT_DDL) db.exec(sql);
  return db;
}

/** 一条基线事件的最小合法形态：其余字段靠 DDL 默认值。 */
function baseEvent(eventId: string, at: string, overrides: Partial<SoulEventInsert> = {}): SoulEventInsert {
  return {
    event_id: eventId,
    at,
    day: at.slice(0, 10),
    valid_from: at,
    actor: "user",
    action: "said",
    source_kind: "chat",
    created_at: at,
    ...overrides,
  };
}

/** 至少一条证据，否则基表写入会被 §4.2 规则拒掉。 */
function evidenceFor(eventId: string, recordId = "l0-1", at = "2026-11-10T09:00:00.000Z"): SoulEventEvidenceInsert[] {
  return [{ event_id: eventId, record_id: recordId, role: "user", at }];
}

/** 某张表里与该事件相关的行数（用于断言子表被清干净）。 */
function childCount(db: DatabaseSync, table: string, eventId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM " + table + " WHERE event_id = ?").get(eventId) as
    { n?: number | bigint } | undefined;
  return Number(row?.n ?? 0);
}

let db: DatabaseSync;

beforeEach(() => {
  db = makeDb();
});

afterEach(() => {
  db.close();
});

describe("写入：一次事务落全", () => {
  it("基表 + chat + 证据一次写入，读回逐字段一致", () => {
    const write = {
      event: baseEvent("ep-0001", "2026-11-10T09:00:00.000Z", {
        valid_to: "2026-11-11T09:00:00.000Z",
        actor_person_key: "p_a1",
        object: "soul-event-store",
        intent: "确认接口",
        outcome: "未实现",
        status: "open",
        source_ref: "l0-1",
        ownership: "mine",
        epistemic: "observed",
        confidence: 0.9,
        visibility: "private",
        session_id: "sess-1",
        persons_json: '["p_a1","p_b2"]',
        parent_event_id: "ep-parent",
        dedupe_key: "team-a|u-1|ag-1|k1",
        salience: 0.8,
      }),
      chat: {
        event_id: "ep-0001",
        kind: "decision",
        title: "接口定稿",
        user_stance: "要求参数化",
        agent_stance: "已参数化",
        cost: "一次往返",
        valence: 0.4,
        arousal: 0.2,
        intensity: 0.6,
        affect_source: "lexicon",
        quote_json: '{"quote":"全参数化"}',
        signals_json: '["explicit"]',
        layers_json: '{"l1":1}',
        mood_integrated_at: "2026-11-10T09:05:00.000Z",
      } satisfies SoulEventChatInsert,
      evidence: [
        { event_id: "ep-0001", record_id: "l0-1", role: "user", quote: "全参数化", at: "2026-11-10T09:00:00.000Z" },
        {
          event_id: "ep-0001",
          record_id: "l0-2",
          role: "assistant",
          quote: "收到",
          at: "2026-11-10T09:00:30.000Z",
          confidence: 0.7,
        },
      ] as SoulEventEvidenceInsert[],
    };

    const returned = insertSoulEvent(db, TENANT, write);
    expect(returned.event_id).toBe("ep-0001");
    expect(returned.team_id).toBe(TENANT.teamId);
    expect(returned.user_id).toBe(TENANT.userId);
    expect(returned.agent_id).toBe(TENANT.agentId);

    const detail = getSoulEventDetail(db, TENANT, "ep-0001");
    expect(detail).not.toBeNull();
    expect(detail?.event).toEqual({
      event_id: "ep-0001",
      team_id: "team-a",
      user_id: "u-1",
      agent_id: "ag-1",
      at: "2026-11-10T09:00:00.000Z",
      day: "2026-11-10",
      valid_from: "2026-11-10T09:00:00.000Z",
      valid_to: "2026-11-11T09:00:00.000Z",
      actor: "user",
      actor_person_key: "p_a1",
      action: "said",
      object: "soul-event-store",
      intent: "确认接口",
      outcome: "未实现",
      status: "open",
      source_kind: "chat",
      source_ref: "l0-1",
      ownership: "mine",
      epistemic: "observed",
      confidence: 0.9,
      visibility: "private",
      session_id: "sess-1",
      persons_json: '["p_a1","p_b2"]',
      parent_event_id: "ep-parent",
      dedupe_key: "team-a|u-1|ag-1|k1",
      salience: 0.8,
      created_at: "2026-11-10T09:00:00.000Z",
      archived_at: null,
    });
    expect(detail?.chat).toEqual({
      event_id: "ep-0001",
      kind: "decision",
      title: "接口定稿",
      user_stance: "要求参数化",
      agent_stance: "已参数化",
      cost: "一次往返",
      valence: 0.4,
      arousal: 0.2,
      intensity: 0.6,
      affect_source: "lexicon",
      quote_json: '{"quote":"全参数化"}',
      signals_json: '["explicit"]',
      layers_json: '{"l1":1}',
      mood_integrated_at: "2026-11-10T09:05:00.000Z",
    });
    expect(detail?.action).toBeNull();
    expect(detail?.reflection).toBeNull();
    expect(detail?.evidence).toEqual([
      {
        event_id: "ep-0001",
        record_id: "l0-1",
        role: "user",
        quote: "全参数化",
        at: "2026-11-10T09:00:00.000Z",
        confidence: 1,
      },
      {
        event_id: "ep-0001",
        record_id: "l0-2",
        role: "assistant",
        quote: "收到",
        at: "2026-11-10T09:00:30.000Z",
        confidence: 0.7,
      },
    ]);
  });

  it("省略字段按 DDL 默认值物化（把 DDL 与 store 的默认值钉在一起）", () => {
    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-0002", "2026-11-10T10:00:00.000Z"),
      evidence: evidenceFor("ep-0002"),
    });

    expect(getSoulEvent(db, TENANT, "ep-0002")).toEqual({
      event_id: "ep-0002",
      team_id: "team-a",
      user_id: "u-1",
      agent_id: "ag-1",
      at: "2026-11-10T10:00:00.000Z",
      day: "2026-11-10",
      valid_from: "2026-11-10T10:00:00.000Z",
      valid_to: null,
      actor: "user",
      actor_person_key: null,
      action: "said",
      object: "",
      intent: "",
      outcome: "",
      status: "unknown",
      source_kind: "chat",
      source_ref: "",
      ownership: "observed",
      epistemic: "observed",
      confidence: 0.5,
      visibility: "shared",
      session_id: "",
      persons_json: null,
      parent_event_id: null,
      dedupe_key: null,
      salience: 0.5,
      created_at: "2026-11-10T10:00:00.000Z",
      archived_at: null,
    });
    // 证据的 quote / confidence 也有默认值
    expect(listSoulEventEvidence(db, "ep-0002")).toEqual([
      {
        event_id: "ep-0002",
        record_id: "l0-1",
        role: "user",
        quote: "",
        at: "2026-11-10T09:00:00.000Z",
        confidence: 1,
      },
    ]);
  });

  it("省略字段的子表也按 DDL 默认值物化", () => {
    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-0003", "2026-11-10T11:00:00.000Z", { source_kind: "tool", action: "ran" }),
      evidence: evidenceFor("ep-0003"),
      action: { event_id: "ep-0003", tool: "Shell" },
      reflection: { event_id: "ep-0003", lesson: "先读 DDL 再写 store" },
    });

    const detail = getSoulEventDetail(db, TENANT, "ep-0003");
    expect(detail?.action).toEqual({
      event_id: "ep-0003",
      tool: "Shell",
      tool_call_id: null,
      args_digest: null,
      result_status: "unknown",
      duration_ms: null,
      artifact_ref: null,
      error_code: null,
      environment: null,
      verified_by: null,
    });
    expect(detail?.reflection).toEqual({
      event_id: "ep-0003",
      about_event_ids_json: "[]",
      lesson: "先读 DDL 再写 store",
      behavior_change: "",
      verified_at: null,
      confidence: 0.5,
    });
  });

  it("无证据事件只在 inferred 且 confidence<=0.5 时可写（store 不伪造证据）", () => {
    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-0004", "2026-11-10T12:00:00.000Z", { epistemic: "inferred", confidence: 0.5 }),
    });
    expect(listSoulEventEvidence(db, "ep-0004")).toEqual([]);
    expect(getSoulEvent(db, TENANT, "ep-0004")?.epistemic).toBe("inferred");
  });

  it("无证据 + observed（默认）→ 抛错且一行不落", () => {
    expect(() => insertSoulEvent(db, TENANT, { event: baseEvent("ep-0005", "2026-11-10T12:00:00.000Z") })).toThrow(
      SoulEventWriteError,
    );
    expect(getSoulEvent(db, TENANT, "ep-0005")).toBeNull();
    expect(countSoulEvents(db, TENANT)).toBe(0);
  });

  it("无证据 + inferred 但 confidence>0.5 → 抛错", () => {
    expect(() =>
      insertSoulEvent(db, TENANT, {
        event: baseEvent("ep-0006", "2026-11-10T12:00:00.000Z", { epistemic: "inferred", confidence: 0.6 }),
      }),
    ).toThrow(SoulEventWriteError);
    expect(getSoulEvent(db, TENANT, "ep-0006")).toBeNull();
  });

  it("工具类事件带工具证据：observed 允许、confidence 上限 0.9（§4.2 第 4 条）", () => {
    const toolEvidence = (eventId: string, recordId: string): SoulEventEvidenceInsert[] => [
      { event_id: eventId, record_id: recordId, role: "tool", quote: "12 passed, 0 failed", at: "2026-11-10T13:00:00.000Z" },
    ];
    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-tool-ok", "2026-11-10T13:00:00.000Z", {
        source_kind: "test",
        action: "ran_tests",
        epistemic: "observed",
        confidence: 0.9,
      }),
      evidence: toolEvidence("ep-tool-ok", "call-ok"),
    });
    const ok = getSoulEvent(db, TENANT, "ep-tool-ok");
    expect(ok?.epistemic).toBe("observed");
    expect(ok?.confidence).toBe(0.9);
    expect(listSoulEventEvidence(db, "ep-tool-ok").map((row) => [row.role, row.record_id])).toEqual([
      ["tool", "call-ok"],
    ]);

    // 工具自报的 observed 不占满分：0.9 之上直接拒，且一行不落。
    expect(() =>
      insertSoulEvent(db, TENANT, {
        event: baseEvent("ep-tool-over", "2026-11-10T13:05:00.000Z", {
          source_kind: "test",
          action: "ran_tests",
          epistemic: "observed",
          confidence: 0.95,
        }),
        evidence: toolEvidence("ep-tool-over", "call-over"),
      }),
    ).toThrow(/confidence<=0\.9/);
    expect(getSoulEvent(db, TENANT, "ep-tool-over")).toBeNull();
  });

  it("工具类事件没有证据仍拒（空证据只能 inferred<=0.5，§4.2 第 4 条不放开第 1 条）", () => {
    expect(() =>
      insertSoulEvent(db, TENANT, {
        event: baseEvent("ep-tool-noev", "2026-11-10T13:10:00.000Z", {
          source_kind: "tool",
          action: "ran",
          epistemic: "observed",
          confidence: 0.9,
        }),
      }),
    ).toThrow(SoulEventWriteError);
    expect(getSoulEvent(db, TENANT, "ep-tool-noev")).toBeNull();
  });

  it("子表行挂到别的事件上 → 抛错，不留孤儿", () => {
    expect(() =>
      insertSoulEvent(db, TENANT, {
        event: baseEvent("ep-0007", "2026-11-10T12:00:00.000Z"),
        evidence: evidenceFor("ep-9999"),
      }),
    ).toThrow(SoulEventWriteError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM soul_event_evidence").get()).toEqual({ n: 0 });
    expect(getSoulEvent(db, TENANT, "ep-0007")).toBeNull();
  });

  it("载荷里带异租户字段 → 抛错（拒绝跨租户写入）", () => {
    expect(() =>
      insertSoulEvent(db, TENANT, {
        event: baseEvent("ep-0008", "2026-11-10T12:00:00.000Z", { user_id: "u-2" }),
        evidence: evidenceFor("ep-0008"),
      }),
    ).toThrow(/不一致/);
    expect(getSoulEvent(db, TENANT, "ep-0008")).toBeNull();
  });

  it("insertSoulEventInTransaction 不自己 BEGIN，可直接用在调用方事务里", () => {
    db.exec("BEGIN IMMEDIATE");
    insertSoulEventInTransaction(db, TENANT, {
      event: baseEvent("ep-0009", "2026-11-10T13:00:00.000Z"),
      evidence: evidenceFor("ep-0009"),
    });
    // 事务未提交前同一连接内可见（证明没被内部 COMMIT 掉）
    expect(getSoulEvent(db, TENANT, "ep-0009")).not.toBeNull();
    db.exec("COMMIT");
    expect(getSoulEvent(db, TENANT, "ep-0009")).not.toBeNull();
  });

  it("事务内子表写入失败 → 整笔回滚（基表与 chat 都不留）", () => {
    expect(() =>
      insertSoulEvent(db, TENANT, {
        event: baseEvent("ep-0010", "2026-11-10T14:00:00.000Z"),
        chat: { event_id: "ep-0010", kind: "chat" },
        // 两条证据撞同 (event_id, record_id, role) 主键 → 第二条 INSERT 失败
        evidence: evidenceFor("ep-0010", "l0-dup"),
      }),
    ).not.toThrow();

    expect(() =>
      insertSoulEvent(db, TENANT, {
        event: baseEvent("ep-0011", "2026-11-10T14:30:00.000Z"),
        chat: { event_id: "ep-0011", kind: "chat" },
        evidence: [
          { event_id: "ep-0011", record_id: "l0-dup", role: "user", at: "2026-11-10T14:30:00.000Z" },
          { event_id: "ep-0011", record_id: "l0-dup", role: "user", at: "2026-11-10T14:30:01.000Z" },
        ],
      }),
    ).toThrow();

    expect(getSoulEvent(db, TENANT, "ep-0011")).toBeNull();
    expect(childCount(db, "soul_event_chat", "ep-0011")).toBe(0);
    expect(childCount(db, "soul_event_evidence", "ep-0011")).toBe(0);
    // 已提交的 ep-0010 不受影响
    expect(getSoulEvent(db, TENANT, "ep-0010")).not.toBeNull();
  });

  it("重复 event_id → 抛错且原事件保持原样", () => {
    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-0012", "2026-11-10T15:00:00.000Z", { object: "第一次" }),
      evidence: evidenceFor("ep-0012"),
    });
    expect(() =>
      insertSoulEvent(db, TENANT, {
        event: baseEvent("ep-0012", "2026-11-10T15:00:00.000Z", { object: "第二次" }),
        evidence: evidenceFor("ep-0012", "l0-2"),
      }),
    ).toThrow();
    expect(getSoulEvent(db, TENANT, "ep-0012")?.object).toBe("第一次");
    expect(listSoulEventEvidence(db, "ep-0012")).toHaveLength(1);
  });

  it("dedupe_key 非空时全表唯一（partial unique index）", () => {
    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-0013", "2026-11-10T16:00:00.000Z", { dedupe_key: "team-a|u-1|ag-1|k" }),
      evidence: evidenceFor("ep-0013"),
    });
    expect(() =>
      insertSoulEvent(db, TENANT, {
        event: baseEvent("ep-0014", "2026-11-10T16:01:00.000Z", { dedupe_key: "team-a|u-1|ag-1|k" }),
        evidence: evidenceFor("ep-0014"),
      }),
    ).toThrow();
    expect(getSoulEvent(db, TENANT, "ep-0014")).toBeNull();
    // 空串/NULL 不参与唯一约束
    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-0015", "2026-11-10T16:02:00.000Z"),
      evidence: evidenceFor("ep-0015"),
    });
    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-0016", "2026-11-10T16:03:00.000Z"),
      evidence: evidenceFor("ep-0016"),
    });
    expect(countSoulEvents(db, TENANT)).toBe(3);
  });
});

describe("读：过滤与计数", () => {
  beforeEach(() => {
    const rows: ReadonlyArray<readonly [string, string, Partial<SoulEventInsert>]> = [
      [
        "ep-a",
        "2026-11-10T09:00:00.000Z",
        {
          action: "asked",
          actor: "user",
          status: "open",
          source_kind: "chat",
          session_id: "s1",
          persons_json: '["p_a1","p_b2"]',
        },
      ],
      [
        "ep-b",
        "2026-11-10T10:00:00.000Z",
        {
          action: "ran",
          actor: "tool",
          status: "done",
          source_kind: "tool",
          session_id: "s1",
          actor_person_key: "p_a1",
        },
      ],
      [
        "ep-c",
        "2026-11-10T11:00:00.000Z",
        {
          action: "asked",
          actor: "third",
          status: "failed",
          source_kind: "observation",
          session_id: "s2",
          parent_event_id: "ep-a",
          archived_at: "2026-11-10T12:00:00.000Z",
        },
      ],
      [
        "ep-d",
        "2026-11-11T09:00:00.000Z",
        { action: "reflected", actor: "self", status: "partial", source_kind: "reflection", session_id: "s2" },
      ],
    ];
    for (const [id, at, overrides] of rows) {
      insertSoulEvent(db, TENANT, { event: baseEvent(id, at, overrides), evidence: evidenceFor(id, "l0-" + id) });
    }
  });

  it("默认不读归档，最新在前", () => {
    expect(listSoulEvents(db, TENANT).map((r) => r.event_id)).toEqual(["ep-d", "ep-b", "ep-a"]);
    expect(listSoulEvents(db, TENANT, { includeArchived: true }).map((r) => r.event_id)).toEqual([
      "ep-d",
      "ep-c",
      "ep-b",
      "ep-a",
    ]);
    expect(listSoulEvents(db, TENANT, { order: "asc" }).map((r) => r.event_id)).toEqual(["ep-a", "ep-b", "ep-d"]);
  });

  it("limit/offset 生效，limit 越界被钳住而不抛错", () => {
    expect(listSoulEvents(db, TENANT, { limit: 1 }).map((r) => r.event_id)).toEqual(["ep-d"]);
    expect(listSoulEvents(db, TENANT, { limit: 1, offset: 1 }).map((r) => r.event_id)).toEqual(["ep-b"]);
    expect(listSoulEvents(db, TENANT, { limit: 0 })).toHaveLength(3);
    expect(listSoulEvents(db, TENANT, { limit: 100000 })).toHaveLength(3);
  });

  it("at 区间左闭右开", () => {
    const ids = listSoulEvents(db, TENANT, {
      atFrom: "2026-11-10T09:00:00.000Z",
      atTo: "2026-11-10T11:00:00.000Z",
      order: "asc",
    }).map((r) => r.event_id);
    expect(ids).toEqual(["ep-a", "ep-b"]);
  });

  it("actor/status/sourceKind 支持数组多选；空数组短路成零结果", () => {
    expect(
      listSoulEvents(db, TENANT, { actor: ["user", "tool"] })
        .map((r) => r.event_id)
        .sort(),
    ).toEqual(["ep-a", "ep-b"]);
    expect(
      listSoulEvents(db, TENANT, { status: ["done", "partial"] })
        .map((r) => r.event_id)
        .sort(),
    ).toEqual(["ep-b", "ep-d"]);
    expect(listSoulEvents(db, TENANT, { sourceKind: "tool" }).map((r) => r.event_id)).toEqual(["ep-b"]);
    expect(listSoulEvents(db, TENANT, { actor: [] })).toEqual([]);
    expect(countSoulEvents(db, TENANT, { actor: [] })).toBe(0);
  });

  it("personKey 看谁做的，presentPersonKey 看谁在场", () => {
    expect(listSoulEvents(db, TENANT, { personKey: "p_a1" }).map((r) => r.event_id)).toEqual(["ep-b"]);
    expect(listSoulEvents(db, TENANT, { presentPersonKey: "p_a1" }).map((r) => r.event_id)).toEqual(["ep-a"]);
    expect(listSoulEvents(db, TENANT, { presentPersonKey: "p_zz" })).toEqual([]);
    // persons_json 为 NULL 的事件不会被 presentPersonKey 命中
    expect(listSoulEvents(db, TENANT, { presentPersonKey: "p_a1", sourceKind: "reflection" })).toEqual([]);
  });

  it("sessionId / parentEventId / action 过滤", () => {
    expect(
      listSoulEvents(db, TENANT, { sessionId: "s1" })
        .map((r) => r.event_id)
        .sort(),
    ).toEqual(["ep-a", "ep-b"]);
    expect(listSoulEvents(db, TENANT, { parentEventId: "ep-a", includeArchived: true }).map((r) => r.event_id)).toEqual(
      ["ep-c"],
    );
    expect(listSoulEvents(db, TENANT, { action: "asked" }).map((r) => r.event_id)).toEqual(["ep-a"]);
  });

  it("countSoulEvents 与 list 同口径，忽略 limit/offset/order", () => {
    expect(countSoulEvents(db, TENANT)).toBe(3);
    expect(countSoulEvents(db, TENANT, { includeArchived: true })).toBe(4);
    expect(countSoulEvents(db, TENANT, { sessionId: "s2", includeArchived: true })).toBe(2);
    expect(countSoulEvents(db, TENANT, { limit: 1 } as never)).toBe(3);
  });

  it("租户隔离：异租户读不到，列表为空", () => {
    expect(getSoulEvent(db, OTHER_TENANT, "ep-a")).toBeNull();
    expect(getSoulEventDetail(db, OTHER_TENANT, "ep-a")).toBeNull();
    expect(listSoulEvents(db, OTHER_TENANT)).toEqual([]);
    expect(countSoulEvents(db, OTHER_TENANT)).toBe(0);
  });

  it("listSoulEventEvidence 按 at / record_id / role 排序，且支持 limit", () => {
    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-e", "2026-11-12T00:00:00.000Z"),
      evidence: [
        { event_id: "ep-e", record_id: "l0-b", role: "tool", at: "2026-11-12T00:00:02.000Z" },
        { event_id: "ep-e", record_id: "l0-a", role: "user", at: "2026-11-12T00:00:02.000Z" },
        { event_id: "ep-e", record_id: "l0-a", role: "assistant", at: "2026-11-12T00:00:01.000Z" },
      ],
    });
    expect(listSoulEventEvidence(db, "ep-e").map((r) => r.record_id + "/" + r.role)).toEqual([
      "l0-a/assistant",
      "l0-a/user",
      "l0-b/tool",
    ]);
    expect(listSoulEventEvidence(db, "ep-e", { limit: 1 }).map((r) => r.record_id)).toEqual(["l0-a"]);
  });
});

describe("子表 upsert：整行覆盖", () => {
  it("chat upsert 覆盖同一行而不新增", () => {
    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-u1", "2026-11-10T09:00:00.000Z"),
      evidence: evidenceFor("ep-u1"),
      chat: { event_id: "ep-u1", kind: "chat", title: "旧标题", valence: 0.9 },
    });

    expect(upsertSoulEventChat(db, { event_id: "ep-u1", kind: "decision", title: "新标题" }, TENANT)).toEqual({
      upserted: 1,
    });

    expect(childCount(db, "soul_event_chat", "ep-u1")).toBe(1);
    expect(getSoulEventDetail(db, TENANT, "ep-u1")?.chat).toEqual({
      event_id: "ep-u1",
      kind: "decision",
      title: "新标题",
      user_stance: "",
      agent_stance: "",
      cost: "",
      valence: 0,
      arousal: 0,
      intensity: 0,
      affect_source: "lexicon",
      quote_json: null,
      signals_json: null,
      layers_json: null,
      mood_integrated_at: null,
    });
  });

  it("action / reflection upsert 同样整行覆盖", () => {
    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-u2", "2026-11-10T09:00:00.000Z", { source_kind: "tool", action: "ran" }),
      evidence: evidenceFor("ep-u2"),
    });

    expect(upsertSoulEventAction(db, { event_id: "ep-u2", tool: "Shell", result_status: "success" }, TENANT)).toEqual({
      upserted: 1,
    });
    expect(
      upsertSoulEventAction(db, { event_id: "ep-u2", tool: "Shell", result_status: "fail", error_code: "E1" }, TENANT),
    ).toEqual({ upserted: 1 });
    expect(childCount(db, "soul_event_action", "ep-u2")).toBe(1);
    expect(getSoulEventDetail(db, TENANT, "ep-u2")?.action).toEqual({
      event_id: "ep-u2",
      tool: "Shell",
      tool_call_id: null,
      args_digest: null,
      result_status: "fail",
      duration_ms: null,
      artifact_ref: null,
      error_code: "E1",
      environment: null,
      verified_by: null,
    });

    expect(upsertSoulEventReflection(db, { event_id: "ep-u2", lesson: "先验后改" }, TENANT)).toEqual({ upserted: 1 });
    expect(getSoulEventDetail(db, TENANT, "ep-u2")?.reflection?.lesson).toBe("先验后改");
    expect(getSoulEventDetail(db, TENANT, "ep-u2")?.reflection?.about_event_ids_json).toBe("[]");
  });

  it("事件不存在 → 抛错，不留孤儿；租户不符 → 抛错", () => {
    expect(() => upsertSoulEventChat(db, { event_id: "ep-nope", kind: "chat" })).toThrow(SoulEventWriteError);

    insertSoulEvent(db, TENANT, {
      event: baseEvent("ep-u3", "2026-11-10T09:00:00.000Z"),
      evidence: evidenceFor("ep-u3"),
    });
    expect(() => upsertSoulEventChat(db, { event_id: "ep-u3", kind: "chat" }, OTHER_TENANT)).toThrow(
      SoulEventWriteError,
    );
    expect(childCount(db, "soul_event_chat", "ep-u3")).toBe(0);
  });
});

describe("删除：基表 + 四张子表一起清", () => {
  function seedFull(eventId: string): void {
    insertSoulEvent(db, TENANT, {
      event: baseEvent(eventId, "2026-11-10T09:00:00.000Z", { source_kind: "reflection", action: "reflected" }),
      evidence: evidenceFor(eventId),
      chat: { event_id: eventId, kind: "chat" },
      action: { event_id: eventId, tool: "Shell" },
      reflection: { event_id: eventId, lesson: "教训" },
    });
  }

  it("FK 关闭时也不留孤儿（显式删子表，不靠 CASCADE）", () => {
    db.close();
    db = makeDb(false);
    seedFull("ep-d1");
    expect(childCount(db, "soul_event_evidence", "ep-d1")).toBe(1);

    expect(deleteSoulEvent(db, TENANT, "ep-d1")).toEqual({ deleted: 1 });

    expect(getSoulEvent(db, TENANT, "ep-d1")).toBeNull();
    for (const table of ["soul_event_evidence", "soul_event_chat", "soul_event_action", "soul_event_reflection"]) {
      expect(childCount(db, table, "ep-d1")).toBe(0);
    }
  });

  it("FK 打开时同样干净（两条路径一套代码）", () => {
    seedFull("ep-d2");
    expect(deleteSoulEvent(db, TENANT, "ep-d2")).toEqual({ deleted: 1 });
    expect(getSoulEvent(db, TENANT, "ep-d2")).toBeNull();
    expect(childCount(db, "soul_event_chat", "ep-d2")).toBe(0);
  });

  it("租户不符 → deleted:0 且一行不动（子行也不被带走）", () => {
    seedFull("ep-d3");
    expect(deleteSoulEvent(db, OTHER_TENANT, "ep-d3")).toEqual({ deleted: 0 });
    expect(getSoulEvent(db, TENANT, "ep-d3")).not.toBeNull();
    expect(childCount(db, "soul_event_evidence", "ep-d3")).toBe(1);
    expect(childCount(db, "soul_event_reflection", "ep-d3")).toBe(1);
  });

  it("删不存在的 id → deleted:0，不抛错", () => {
    expect(deleteSoulEvent(db, TENANT, "ep-none")).toEqual({ deleted: 0 });
  });
});
describe("upsertSoulEventInTransaction：双写用覆盖", () => {
  /** 造一条带类型子表的证据，避免数组字面量把 role 宽化成 string。 */
  function ev(
    eventId: string,
    recordId: string,
    role: SoulEventEvidenceInsert["role"] = "user",
  ): SoulEventEvidenceInsert {
    return { event_id: eventId, record_id: recordId, role, at: "2026-11-10T09:00:00.000Z" };
  }

  function seedRefreshable(eventId: string): void {
    insertSoulEvent(db, TENANT, {
      event: baseEvent(eventId, "2026-11-10T09:00:00.000Z", { object: "旧对象", status: "open" }),
      evidence: [
        { event_id: eventId, record_id: "l0-old", role: "user", quote: "旧引文", at: "2026-11-10T09:00:00.000Z" },
      ],
      chat: { event_id: eventId, kind: "chat", title: "旧标题", valence: 0.9 },
      action: { event_id: eventId, tool: "Shell", result_status: "success" },
    });
  }

  it("已存在 → 基表整行更新，evidence 整组替换", () => {
    seedRefreshable("ep-r1");

    const returned = upsertSoulEventInTransaction(db, TENANT, {
      event: baseEvent("ep-r1", "2026-11-10T09:00:00.000Z", { object: "新对象", status: "done", confidence: 0.9 }),
      evidence: [
        { event_id: "ep-r1", record_id: "l0-new1", role: "user", quote: "新引文1", at: "2026-11-10T10:00:00.000Z" },
        {
          event_id: "ep-r1",
          record_id: "l0-new2",
          role: "assistant",
          quote: "新引文2",
          at: "2026-11-10T10:01:00.000Z",
          confidence: 0.8,
        },
      ],
    });

    expect(returned.object).toBe("新对象");
    const row = getSoulEvent(db, TENANT, "ep-r1");
    expect(row?.object).toBe("新对象");
    expect(row?.status).toBe("done");
    expect(row?.confidence).toBe(0.9);
    // 未传的可省字段回默认值，证明是整行覆盖而不是打补丁
    expect(row?.ownership).toBe("observed");
    expect(row?.visibility).toBe("shared");
    // evidence 整组替换：旧行消失、新行按 at 排序
    expect(listSoulEventEvidence(db, "ep-r1").map((r) => r.record_id + "/" + r.role)).toEqual([
      "l0-new1/user",
      "l0-new2/assistant",
    ]);
    expect(listSoulEventEvidence(db, "ep-r1").some((r) => r.quote === "旧引文")).toBe(false);
  });

  it("未提供的子表保留不动，提供的子表整行覆盖", () => {
    seedRefreshable("ep-r2");

    // 只给 action：chat 与 evidence 都不该被动
    upsertSoulEventInTransaction(db, TENANT, {
      event: baseEvent("ep-r2", "2026-11-10T09:00:00.000Z", { object: "新对象" }),
      action: { event_id: "ep-r2", tool: "Git", result_status: "fail" },
    });

    const detail = getSoulEventDetail(db, TENANT, "ep-r2");
    expect(detail?.event.object).toBe("新对象");
    expect(detail?.chat?.title).toBe("旧标题");
    expect(detail?.chat?.valence).toBe(0.9);
    expect(detail?.action?.tool).toBe("Git");
    expect(detail?.action?.result_status).toBe("fail");
    // evidence 没给 → 保留原有证据（不能清空，否则 §4.2 破功）
    expect(detail?.evidence.map((r) => r.record_id)).toEqual(["l0-old"]);

    // 再给 chat：只覆盖 chat，action 保留 Git/fail
    upsertSoulEventInTransaction(db, TENANT, {
      event: baseEvent("ep-r2", "2026-11-10T09:00:00.000Z"),
      chat: { event_id: "ep-r2", kind: "decision", title: "新标题" },
    });
    const after = getSoulEventDetail(db, TENANT, "ep-r2");
    expect(after?.chat?.title).toBe("新标题");
    expect(after?.chat?.valence).toBe(0);
    expect(after?.action?.tool).toBe("Git");
    expect(childCount(db, "soul_event_chat", "ep-r2")).toBe(1);
    expect(childCount(db, "soul_event_action", "ep-r2")).toBe(1);
  });

  it("在调用方 BEGIN 内可用，不嵌套事务也不自动提交", () => {
    seedRefreshable("ep-r3");

    db.exec("BEGIN IMMEDIATE");
    upsertSoulEventInTransaction(db, TENANT, {
      event: baseEvent("ep-r3", "2026-11-10T09:00:00.000Z", { object: "事务内改" }),
      evidence: [ev("ep-r3", "l0-tx")],
    });
    // 同连接内已可见；若本函数自己 COMMIT 过，下面的 ROLLBACK 就撤不掉
    expect(getSoulEvent(db, TENANT, "ep-r3")?.object).toBe("事务内改");
    db.exec("ROLLBACK");

    const row = getSoulEvent(db, TENANT, "ep-r3");
    expect(row?.object).toBe("旧对象");
    expect(listSoulEventEvidence(db, "ep-r3").map((r) => r.record_id)).toEqual(["l0-old"]);
  });

  it("重复 upsert 后子表无重复行", () => {
    seedRefreshable("ep-r4");

    for (const title of ["第一版", "第二版", "第三版"]) {
      upsertSoulEventInTransaction(db, TENANT, {
        event: baseEvent("ep-r4", "2026-11-10T09:00:00.000Z"),
        chat: { event_id: "ep-r4", kind: "chat", title },
        action: { event_id: "ep-r4", tool: "Shell" },
        reflection: { event_id: "ep-r4", lesson: title },
        evidence: [{ event_id: "ep-r4", record_id: "l0-same", role: "user", at: "2026-11-10T09:00:00.000Z" }],
      });
    }

    expect(childCount(db, "soul_event_chat", "ep-r4")).toBe(1);
    expect(childCount(db, "soul_event_action", "ep-r4")).toBe(1);
    expect(childCount(db, "soul_event_reflection", "ep-r4")).toBe(1);
    expect(childCount(db, "soul_event_evidence", "ep-r4")).toBe(1);
    expect(getSoulEventDetail(db, TENANT, "ep-r4")?.chat?.title).toBe("第三版");
    expect(getSoulEventDetail(db, TENANT, "ep-r4")?.reflection?.lesson).toBe("第三版");
  });

  it("事件不存在时等价 insert（基表 + 子表 + 证据一次落）", () => {
    const returned = upsertSoulEventInTransaction(db, TENANT, {
      event: baseEvent("ep-r5", "2026-11-10T09:00:00.000Z", { object: "新建" }),
      evidence: [{ event_id: "ep-r5", record_id: "l0-x", role: "user", at: "2026-11-10T09:00:00.000Z" }],
      chat: { event_id: "ep-r5", kind: "chat", title: "首个标题" },
    });

    expect(returned.event_id).toBe("ep-r5");
    const detail = getSoulEventDetail(db, TENANT, "ep-r5");
    expect(detail?.event.team_id).toBe(TENANT.teamId);
    expect(detail?.chat?.title).toBe("首个标题");
    expect(detail?.evidence).toHaveLength(1);
    // 再 upsert 一次同一个 id 也不该撞 PK
    expect(() =>
      upsertSoulEventInTransaction(db, TENANT, { event: baseEvent("ep-r5", "2026-11-10T09:00:00.000Z") }),
    ).not.toThrow();
    expect(countSoulEvents(db, TENANT)).toBe(1);
  });

  it("显式清空证据但事件仍 observed → 抛错（半截写入由调用方 ROLLBACK）", () => {
    seedRefreshable("ep-r6");

    db.exec("BEGIN IMMEDIATE");
    expect(() =>
      upsertSoulEventInTransaction(db, TENANT, {
        event: baseEvent("ep-r6", "2026-11-10T09:00:00.000Z", { object: "改了但该回滚" }),
        evidence: [],
      }),
    ).toThrow(SoulEventWriteError);
    db.exec("ROLLBACK");

    expect(getSoulEvent(db, TENANT, "ep-r6")?.object).toBe("旧对象");
    expect(listSoulEventEvidence(db, "ep-r6")).toHaveLength(1);
  });

  it("已存在但属于别的租户 → 抛错，不改别人的行", () => {
    seedRefreshable("ep-r7");
    expect(() =>
      upsertSoulEventInTransaction(db, OTHER_TENANT, {
        event: baseEvent("ep-r7", "2026-11-10T09:00:00.000Z", { object: "越界改" }),
      }),
    ).toThrow(/别的租户/);
    expect(getSoulEvent(db, TENANT, "ep-r7")?.object).toBe("旧对象");
  });

  it("子表 event_id 与事件不一致 → 抛错", () => {
    seedRefreshable("ep-r8");
    expect(() =>
      upsertSoulEventInTransaction(db, TENANT, {
        event: baseEvent("ep-r8", "2026-11-10T09:00:00.000Z"),
        chat: { event_id: "ep-other", kind: "chat" },
      }),
    ).toThrow(SoulEventWriteError);
    expect(childCount(db, "soul_event_chat", "ep-r8")).toBe(1);
    expect(childCount(db, "soul_event_chat", "ep-other")).toBe(0);
  });
});
