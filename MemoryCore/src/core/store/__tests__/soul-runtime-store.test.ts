/**
 * §6/§9 运行时状态层（soul_runtime_store）的 store 级契约（issue #180）。
 *
 * 装配器 assembleTurnState 只吃这几条读面，所以这里钉的是它们的真实行为：
 *  1. 空表：每条读都给「空」而不是抛错（一次缺表不该让会话挂死）；
 *  2. 租户隔离：T1 写进去的 mood / goal / working / 关系，T2 一条都读不到；
 *  3. 双向关系：A→B 与 B→A 是两条边，subjKey/objKey 各自只回一边，结束的边默认可不见；
 *  4. limit 生效且排序确定（关系按 valid_from DESC, rel_id ASC）。
 *
 * 铁律：纯本地 sqlite（临时目录 + dims=0），不碰外部服务、不碰生产库。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../sqlite.js";

const T1 = { teamId: "team-1", userId: "usr-1", agentId: "agt-1" };
const T2 = { teamId: "team-2", userId: "usr-2", agentId: "agt-2" };

const dirs: string[] = [];
const stores: VectorStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(): VectorStore {
  const dir = mkdtempSync(join(tmpdir(), "soul-runtime-"));
  dirs.push(dir);
  const store = new VectorStore(join(dir, "vectors.db"), 0);
  stores.push(store);
  store.init();
  return store;
}

function relation(relId: string, subjKey: string, objKey: string, validFrom: string, validTo: string | null = null) {
  return {
    relId,
    subjKey,
    pred: "一起做过事",
    inversePred: null,
    objKey,
    objName: objKey === "p_b" ? "B" : "A",
    direction: "out" as const,
    quote: "原话",
    recordId: "rec-1",
    evidence: [{ recordId: "rec-1", at: validFrom, quote: "原话" }],
    validFrom,
    validTo,
    createdAt: validFrom,
    updatedAt: validFrom,
  };
}

describe("§6 运行时状态读面：空表不抛、给空", () => {
  it("新库上每条读面都给空", () => {
    const store = makeStore();
    expect(store.readSoulMoodState!(T1)).toBeNull();
    expect(store.listSoulGoals!(T1)).toEqual([]);
    expect(store.getSoulWorkingState!(T1, { sessionId: "s-1" })).toBeNull();
    expect(store.listSoulPersons!(T1)).toEqual([]);
    expect(store.listSoulPersonRelations!(T1)).toEqual([]);
    expect(store.listSoulPersonStates!(T1)).toEqual([]);
  });
});

describe("§6 运行时状态读面：租户隔离", () => {
  it("T1 写进去的 mood / goal / working / 关系，T2 一条都读不到", () => {
    const store = makeStore();
    store.writeSoulMoodState!(T1, { label: "紧绷", valence: -0.4, arousal: 0.6 });
    store.upsertSoulGoal!(T1, {
      goal_id: "g-1",
      title: "把 #180 收口",
      owner: "user",
      kind: "commitment",
      priority: 0.9,
      valid_from: "2026-11-12T00:00:00.000Z",
    });
    store.upsertSoulWorkingState!(T1, {
      session_id: "s-1",
      current_focus: "补 §6 状态层",
      updated_at: "2026-11-12T00:00:00.000Z",
    });
    store.upsertSoulPerson!(T1, { personKey: "p_a", displayName: "A" });
    store.upsertSoulPerson!(T1, { personKey: "p_b", displayName: "B" });
    store.commitSoulPersonRelations(T1, { insert: [relation("rel-1", "p_a", "p_b", "2026-11-12T00:00:00.000Z")] });

    expect(store.readSoulMoodState!(T1)?.label).toBe("紧绷");
    expect(store.readSoulMoodState!(T2)).toBeNull();
    expect(store.listSoulGoals!(T1)).toHaveLength(1);
    expect(store.listSoulGoals!(T2)).toEqual([]);
    expect(store.getSoulWorkingState!(T1, { sessionId: "s-1" })?.current_focus).toBe("补 §6 状态层");
    expect(store.getSoulWorkingState!(T2, { sessionId: "s-1" })).toBeNull();
    expect(store.listSoulPersons!(T1)).toHaveLength(2);
    expect(store.listSoulPersons!(T2)).toEqual([]);
    expect(store.listSoulPersonRelations!(T1)).toHaveLength(1);
    expect(store.listSoulPersonRelations!(T2)).toEqual([]);
  });
});

describe("§6 运行时状态读面：双向关系", () => {
  it("A→B 与 B→A 是两条边，subjKey/objKey 各只回一边", () => {
    const store = makeStore();
    store.upsertSoulPerson!(T1, { personKey: "p_a", displayName: "A" });
    store.upsertSoulPerson!(T1, { personKey: "p_b", displayName: "B" });
    store.commitSoulPersonRelations(T1, {
      insert: [
        relation("rel-ab", "p_a", "p_b", "2026-11-12T00:00:00.000Z"),
        relation("rel-ba", "p_b", "p_a", "2026-11-12T01:00:00.000Z"),
      ],
    });

    // 站在 A 上：出边（subj）一条、入边（obj）一条，合起来才是「双向」。
    const outbound = store.listSoulPersonRelations!(T1, { subjKey: "p_a" });
    const inbound = store.listSoulPersonRelations!(T1, { objKey: "p_a" });
    expect(outbound.map((r) => r.relId)).toEqual(["rel-ab"]);
    expect(inbound.map((r) => r.relId)).toEqual(["rel-ba"]);
    expect(store.listSoulPersonRelations!(T1)).toHaveLength(2);
  });

  it("结束的边默认读不到，includeClosed 才看得见", () => {
    const store = makeStore();
    store.upsertSoulPerson!(T1, { personKey: "p_a", displayName: "A" });
    store.upsertSoulPerson!(T1, { personKey: "p_b", displayName: "B" });
    store.commitSoulPersonRelations(T1, {
      insert: [
        relation("rel-live", "p_a", "p_b", "2026-11-12T00:00:00.000Z"),
        relation("rel-closed", "p_a", "p_b", "2026-11-10T00:00:00.000Z", "2026-11-11T00:00:00.000Z"),
      ],
    });

    expect(store.listSoulPersonRelations!(T1, { subjKey: "p_a" }).map((r) => r.relId)).toEqual(["rel-live"]);
    expect(
      store.listSoulPersonRelations!(T1, { subjKey: "p_a", includeClosed: true }).map((r) => r.relId),
    ).toEqual(["rel-live", "rel-closed"]);
  });

  it("排序确定：valid_from DESC，同刻按 rel_id ASC", () => {
    const store = makeStore();
    store.upsertSoulPerson!(T1, { personKey: "p_a", displayName: "A" });
    store.upsertSoulPerson!(T1, { personKey: "p_b", displayName: "B" });
    store.commitSoulPersonRelations(T1, {
      insert: [
        relation("rel-old", "p_a", "p_b", "2026-11-01T00:00:00.000Z"),
        relation("rel-new", "p_a", "p_b", "2026-11-12T00:00:00.000Z"),
        relation("rel-mid-b", "p_a", "p_b", "2026-11-05T00:00:00.000Z"),
        relation("rel-mid-a", "p_a", "p_b", "2026-11-05T00:00:00.000Z"),
      ],
    });

    expect(store.listSoulPersonRelations!(T1, { subjKey: "p_a" }).map((r) => r.relId)).toEqual([
      "rel-new",
      "rel-mid-a",
      "rel-mid-b",
      "rel-old",
    ]);
  });
});

describe("§6 运行时状态读面：limit", () => {
  it("goals 与 person_states 的 limit 真的收窄结果，且不改变内容", () => {
    const store = makeStore();
    for (const id of ["g-1", "g-2", "g-3"]) {
      store.upsertSoulGoal!(T1, {
        goal_id: id,
        title: "目标 " + id,
        owner: "self",
        kind: "plan",
        priority: 0.4,
        valid_from: "2026-11-12T00:00:00.000Z",
      });
    }
    expect(store.listSoulGoals!(T1)).toHaveLength(3);
    expect(store.listSoulGoals!(T1, { limit: 2 })).toHaveLength(2);

    store.upsertSoulPerson!(T1, { personKey: "p_a", displayName: "A" });
    store.upsertSoulPerson!(T1, { personKey: "p_b", displayName: "B" });
    for (const key of ["p_a", "p_b"]) {
      store.upsertSoulPersonState!(T1, {
        person_key: key,
        trust: 0.5,
        affinity: 0.5,
        respect: 0.5,
        obligation: 0,
        confidence: 0.5,
        evidence_event_ids_json: "[]",
        updated_at: "2026-11-12T00:00:00.000Z",
      } as never);
    }
    expect(store.listSoulPersonStates!(T1)).toHaveLength(2);
    expect(store.listSoulPersonStates!(T1, { limit: 1 })).toHaveLength(1);
  });
});
