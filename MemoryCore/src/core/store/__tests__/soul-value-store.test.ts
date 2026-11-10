/**
 * P7 三表读写收口（soul_values / soul_gate_log / soul_dilemma）的契约测试。
 *
 * 守五条：
 *  1. 价值：默认 active、优先级夹到 0..1、created_at 只在新行上生效（重观察到不刷新诞生时刻）；
 *  2. 审计：同 id 重放不翻倍；shadowOnly 靠 reason 前缀分流；技能读到「判定」与「执行」两个数；
 *  3. 口径：wouldBlockRate 的分母含放行行（否则恒 100%），byRule 按规则分组，hitRows 只数命中行；
 *  4. 两难：同 id 幂等且不动原有两侧理由，回看只改 regret / outcome_event_id / review_at；
 *  5. 租户：跨租户读不到、改不了、退休不了。
 *
 * 铁律：纯内存库（DatabaseSync(':memory:')），不碰 D:/TDB/data。
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { SOUL_EVENT_DDL } from "../soul-event-ddl.js";
import {
  insertSoulDilemma,
  insertSoulGateLog,
  listSoulDilemmas,
  listSoulGateLog,
  listSoulValues,
  retireSoulValue,
  reviewSoulDilemma,
  summarizeSoulGateLog,
  upsertSoulValue,
} from "../soul-value-store.js";

const T = { teamId: "t1", userId: "u1", agentId: "a1" };
const OTHER = { teamId: "t1", userId: "u1", agentId: "a2" };
const T0 = "2026-11-10T09:00:00.000Z";
const T1 = "2026-11-10T10:00:00.000Z";
const T2 = "2026-11-11T09:00:00.000Z";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const stmt of SOUL_EVENT_DDL) db.exec(stmt);
  return db;
}

function value(id: string, statement: string, extra?: { priority?: number; source?: "declared" | "observed" | "derived" }) {
  return {
    value_id: id,
    statement,
    priority: extra?.priority ?? 0.5,
    source: extra?.source ?? ("declared" as const),
    evidence_event_ids_json: JSON.stringify(["ep-1"]),
    created_at: T0,
  };
}

function logRow(id: string, decision: "allow" | "deny" | "rewrite" | "ask", opts?: { ruleId?: string | null; shadow?: boolean; stage?: "generation" | "action" | "output"; at?: string }) {
  return {
    id,
    at: opts?.at ?? T0,
    stage: opts?.stage ?? ("output" as const),
    action_digest: "sha256:" + id.padEnd(16, "0"),
    rule_id: opts?.ruleId === undefined ? null : opts.ruleId,
    decision,
    reason: (opts?.shadow === false ? "" : "[shadow] allow would-be=" + decision) + " hits=test",
    event_id: null,
    confidence: 0.7,
  };
}

describe("soul_values：取舍是被证据撑住的，不是刷新出来的", () => {
  it("新行默认 active、优先级夹到 0..1、证据序列化成 JSON", () => {
    const db = freshDb();
    const row = upsertSoulValue(db, T, { ...value("v1", "不拿别人的私事当谈资"), priority: 1.8, evidence_event_ids_json: '["ep-1","ep-2"]' });
    expect(row.status).toBe("active");
    expect(row.priority).toBe(1);
    expect(JSON.parse(row.evidence_event_ids_json)).toEqual(["ep-1", "ep-2"]);

    const low = upsertSoulValue(db, T, { ...value("v2", "能用一句话说完就别写三段"), priority: -3 });
    expect(low.priority).toBe(0);
  });

  it("重新观察到同一句话：改优先级与 updated_at，但 created_at 不刷新", () => {
    const db = freshDb();
    upsertSoulValue(db, T, value("v1", "先看证据再下结论", { priority: 0.4 }));
    const again = upsertSoulValue(db, T, {
      ...value("v1", "先看证据再下结论", { priority: 0.9 }),
      created_at: T2,
      updated_at: T2,
    });
    expect(again.priority).toBe(0.9);
    expect(again.created_at).toBe(T0);
    expect(again.updated_at).toBe(T2);
    expect(listSoulValues(db, T)).toHaveLength(1);
  });

  it("退休只改状态、行还在；跨租户退休不到别人", () => {
    const db = freshDb();
    upsertSoulValue(db, T, value("v1", "不替别人承诺"));
    expect(retireSoulValue(db, OTHER, "v1", T1)).toBe(false);
    expect(retireSoulValue(db, T, "v1", T1)).toBe(true);
    const rows = listSoulValues(db, T);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("retired");
    expect(rows[0]!.updated_at).toBe(T1);
    expect(listSoulValues(db, T, { status: "active" })).toHaveLength(0);
  });

  it("列表按优先级倒序、可按来源过滤、租户隔离", () => {
    const db = freshDb();
    upsertSoulValue(db, T, value("v-low", "能省一步就省一步", { priority: 0.2, source: "observed" }));
    upsertSoulValue(db, T, value("v-high", "先看证据再下结论", { priority: 0.9, source: "declared" }));
    upsertSoulValue(db, OTHER, value("v-other", "别人的价值", { priority: 1 }));
    expect(listSoulValues(db, T).map((r) => r.value_id)).toEqual(["v-high", "v-low"]);
    expect(listSoulValues(db, T, { source: "observed" }).map((r) => r.value_id)).toEqual(["v-low"]);
    expect(listSoulValues(db, OTHER).map((r) => r.value_id)).toEqual(["v-other"]);
  });
});

describe("soul_gate_log：判了什么与拦了什么分开读", () => {
  it("同 id 重放不翻倍；同批只统计真正写进去的行数", () => {
    const db = freshDb();
    expect(insertSoulGateLog(db, T, [logRow("g1", "deny", { ruleId: "secret_leak" })])).toEqual({ inserted: 1 });
    expect(insertSoulGateLog(db, T, [logRow("g1", "deny", { ruleId: "secret_leak" })])).toEqual({ inserted: 0 });
    expect(listSoulGateLog(db, T)).toHaveLength(1);
  });

  it("决策 / 阶段 / 规则 / shadow 四个过滤都可单用", () => {
    const db = freshDb();
    insertSoulGateLog(db, T, [
      logRow("g1", "deny", { ruleId: "secret_leak", shadow: true }),
      logRow("g2", "rewrite", { ruleId: "false_claim", shadow: true }),
      logRow("g3", "allow", { ruleId: null, shadow: true }),
      logRow("g4", "deny", { ruleId: "secret_leak", shadow: false, stage: "action" }),
    ]);
    expect(listSoulGateLog(db, T, { decision: "deny" }).map((r) => r.id).sort()).toEqual(["g1", "g4"]);
    expect(listSoulGateLog(db, T, { stage: "action" }).map((r) => r.id)).toEqual(["g4"]);
    expect(listSoulGateLog(db, T, { ruleId: "secret_leak" }).map((r) => r.id).sort()).toEqual(["g1", "g4"]);
    expect(listSoulGateLog(db, T, { shadowOnly: true }).map((r) => r.id).sort()).toEqual(["g1", "g2", "g3"]);
    expect(listSoulGateLog(db, T, { shadowOnly: false }).map((r) => r.id)).toEqual(["g4"]);
    expect(listSoulGateLog(db, OTHER)).toHaveLength(0);
  });

  it("汇总口径：wouldBlockRate 的分母含放行行，byRule 分组，hitRows 只数命中行", () => {
    const db = freshDb();
    insertSoulGateLog(db, T, [
      logRow("g1", "deny", { ruleId: "secret_leak" }),
      logRow("g2", "rewrite", { ruleId: "false_claim" }),
      logRow("g3", "allow", { ruleId: null }),
      logRow("g4", "deny", { ruleId: "secret_leak", shadow: false }),
    ]);
    const stats = summarizeSoulGateLog(db, T);
    expect(stats.total).toBe(4);
    expect(stats.shadow).toBe(3);
    expect(stats.enforced).toBe(1);
    expect(stats.wouldBlock).toBe(3);
    expect(stats.wouldBlockRate).toBeCloseTo(0.75, 5);
    expect(stats.hitRows).toBe(3);
    expect(stats.byDecision).toMatchObject({ allow: 1, deny: 2, rewrite: 1, ask: 0 });
    expect(stats.byRule.map((r) => [r.ruleId, r.total, r.wouldBlock])).toEqual([
      ["secret_leak", 2, 2],
      ["false_claim", 1, 1],
    ]);
    expect(summarizeSoulGateLog(db, OTHER)).toMatchObject({ total: 0, wouldBlockRate: 0, hitRows: 0, byRule: [] });
  });
});

describe("soul_dilemma：当时的两侧理由是事实，回看只补后悔", () => {
  const conflict = {
    id: "dil-1",
    at: T0,
    conflict_json: JSON.stringify({ sides: [{ ruleId: "privacy_boundary" }, { ruleId: "false_claim" }] }),
    choice: "shadow-allow",
    reason: "隐私 vs 诚实",
    regret: 0,
    review_at: "2026-11-17T09:00:00.000Z",
  };

  it("同 id 幂等：第二次写回读的是第一次的行，choice 不被覆盖", () => {
    const db = freshDb();
    const first = insertSoulDilemma(db, T, conflict);
    expect(first?.id).toBe("dil-1");
    const second = insertSoulDilemma(db, T, { ...conflict, choice: "deny", reason: "改主意了" });
    expect(second?.choice).toBe("shadow-allow");
    expect(second?.reason).toBe("隐私 vs 诚实");
    expect(listSoulDilemmas(db, T)).toHaveLength(1);
  });

  it("回看只改 regret / outcome_event_id / review_at，两侧理由原样保留；跨租户返回 null", () => {
    const db = freshDb();
    insertSoulDilemma(db, T, conflict);
    const reviewed = reviewSoulDilemma(db, T, "dil-1", { regret: 0.8, outcomeEventId: "ep-after", reviewAt: T2 });
    expect(reviewed?.regret).toBe(0.8);
    expect(reviewed?.outcome_event_id).toBe("ep-after");
    expect(reviewed?.review_at).toBe(T2);
    expect(JSON.parse(reviewed!.conflict_json).sides).toHaveLength(2);
    expect(reviewSoulDilemma(db, OTHER, "dil-1", { regret: 1 })).toBeNull();
    // 后悔度夹到 0..1
    expect(reviewSoulDilemma(db, T, "dil-1", { regret: 9 })?.regret).toBe(1);
  });

  it("dueBefore 只取到点且未记过后悔的（review_at 为空的不算到期）", () => {
    const db = freshDb();
    insertSoulDilemma(db, T, conflict);
    insertSoulDilemma(db, T, { ...conflict, id: "dil-future", review_at: "2027-01-01T00:00:00.000Z" });
    insertSoulDilemma(db, T, { ...conflict, id: "dil-open", review_at: null });
    expect(listSoulDilemmas(db, T, { dueBefore: "2026-11-18T00:00:00.000Z" }).map((r) => r.id)).toEqual(["dil-1"]);
  });
});
