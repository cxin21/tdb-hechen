/**
 * P2 存储面：soul_person_state / soul_person_state_events 的读写与幂等。
 * 两表由 soul-event-ddl.ts 建（生产已有、0 行），这里锁死写入语义：
 * upsert 按 (person_key, team,user,agent) 落一行；审计行按 id 去重（tick 重放不翻倍）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import {
  getSoulPersonState,
  insertSoulPersonStateEvents,
  listSoulPersonStateEvents,
  listSoulPersonStates,
  upsertSoulPersonState,
} from "../soul-person-state-store.js";
import type { CoreTenant } from "../types.js";

const T1: CoreTenant = { teamId: "t1", userId: "u1", agentId: "a1" };
const T2: CoreTenant = { teamId: "t1", userId: "u2", agentId: "a2" };

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-person-state-")), "vectors.db");
}

function makeStore(dbPath: string): VectorStore {
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）：" + initRes.reason);
  return store;
}

function dbOf(store: VectorStore) {
  return (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
}

describe("soul_person_state 存储面", () => {
  it("upsert 建行 → 读回四轴/证据；再 upsert 覆盖数值轴并保留边界结构", () => {
    const store = makeStore(tmpDb());
    const db = dbOf(store);
    expect(getSoulPersonState(db, T1, "p_he")).toBeNull();

    const created = upsertSoulPersonState(db, T1, {
      person_key: "p_he",
      trust: 0.58,
      respect: 0.53,
      last_interaction_at: "2026-11-10T02:00:00.000Z",
      evidence_event_ids_json: JSON.stringify(["ep-1"]),
      confidence: 0.55,
      updated_at: "2026-11-10T03:00:00.000Z",
    });
    expect(created.trust).toBeCloseTo(0.58, 4);
    expect(created.affinity).toBe(0.5);
    expect(created.boundaries_json).toBe("{}");
    expect(created.team_id).toBe("t1");
    expect(created.user_id).toBe("u1");
    expect(created.agent_id).toBe("a1");

    const updated = upsertSoulPersonState(db, T1, {
      person_key: "p_he",
      trust: 0.66,
      boundaries_json: JSON.stringify({ noPush: true }),
      evidence_event_ids_json: JSON.stringify(["ep-1", "ep-2"]),
      updated_at: "2026-11-10T05:00:00.000Z",
    });
    expect(updated.trust).toBeCloseTo(0.66, 4);
    expect(updated.respect).toBeCloseTo(0.53, 4);
    expect(updated.boundaries_json).toBe(JSON.stringify({ noPush: true }));
    expect(listSoulPersonStates(db, T1)).toHaveLength(1);
  });

  it("租户隔离：同一 person_key 在两个租户各一行", () => {
    const store = makeStore(tmpDb());
    const db = dbOf(store);
    upsertSoulPersonState(db, T1, { person_key: "p_he", trust: 0.7, updated_at: "2026-11-10T03:00:00.000Z" });
    upsertSoulPersonState(db, T2, { person_key: "p_he", trust: 0.3, updated_at: "2026-11-10T03:00:00.000Z" });
    expect(getSoulPersonState(db, T1, "p_he")!.trust).toBeCloseTo(0.7, 4);
    expect(getSoulPersonState(db, T2, "p_he")!.trust).toBeCloseTo(0.3, 4);
  });

  it("越界数值被库的 CHECK 拒绝（不在应用层悄悄 clamp）", () => {
    const store = makeStore(tmpDb());
    const db = dbOf(store);
    expect(() =>
      upsertSoulPersonState(db, T1, { person_key: "p_he", trust: 1.5, updated_at: "2026-11-10T03:00:00.000Z" }),
    ).toThrow();
  });
});

describe("soul_person_state_events 存储面", () => {
  it("按 id 幂等：同一批写两次只留一行", () => {
    const store = makeStore(tmpDb());
    const db = dbOf(store);
    const rows = [
      {
        id: "pse:p_he:ep-1:trust",
        person_key: "p_he",
        event_id: "ep-1",
        field: "trust",
        old_value: 0.5,
        new_value: 0.58,
        reason: "何晨把判断权交给我：「这个你自己决定」",
        at: "2026-11-10T02:00:00.000Z",
      },
    ];
    expect(insertSoulPersonStateEvents(db, T1, rows).inserted).toBe(1);
    expect(insertSoulPersonStateEvents(db, T1, rows).inserted).toBe(0);
    const listed = listSoulPersonStateEvents(db, T1, { personKey: "p_he" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.old_value).toBeCloseTo(0.5, 4);
    expect(listed[0]!.new_value).toBeCloseTo(0.58, 4);
    expect(listed[0]!.team_id).toBe("t1");
  });

  it("按 at 倒序列出，并可只查一个人", () => {
    const store = makeStore(tmpDb());
    const db = dbOf(store);
    insertSoulPersonStateEvents(db, T1, [
      { id: "e1", person_key: "p_a", event_id: null, field: "trust", old_value: 0.5, new_value: 0.55, reason: "r1", at: "2026-11-10T01:00:00.000Z" },
      { id: "e2", person_key: "p_a", event_id: null, field: "trust", old_value: 0.55, new_value: 0.6, reason: "r2", at: "2026-11-10T02:00:00.000Z" },
      { id: "e3", person_key: "p_b", event_id: null, field: "affinity", old_value: 0.5, new_value: 0.45, reason: "r3", at: "2026-11-10T03:00:00.000Z" },
    ]);
    const a = listSoulPersonStateEvents(db, T1, { personKey: "p_a" });
    expect(a.map((r) => r.id)).toEqual(["e2", "e1"]);
    expect(listSoulPersonStateEvents(db, T1)).toHaveLength(3);
  });

  it("两张表互不串行：state_events 不写 state 值", () => {
    const store = makeStore(tmpDb());
    const db = dbOf(store);
    insertSoulPersonStateEvents(db, T1, [
      { id: "e1", person_key: "p_he", event_id: "ep-1", field: "trust", old_value: 0.5, new_value: 0.58, reason: "r", at: "2026-11-10T02:00:00.000Z" },
    ]);
    expect(getSoulPersonState(db, T1, "p_he")).toBeNull();
  });
});
