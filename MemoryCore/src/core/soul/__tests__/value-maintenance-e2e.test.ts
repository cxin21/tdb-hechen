/**
 * P7 端到端（真实临时库 + 真实 runSoulMaintenanceTick）：
 *   episode（有立场有代价）→ soul_values 有行且证据回指事件
 *   写入侧 shadow gate → soul_gate_log 有行（decision 记「本来会拦」），
 *   但 episode / soul_events / soul_values 一行不少——shadow 期不拦任何写入。
 *   两难：同段不同轴同时命中 → soul_dilemma 一行、有理由、有回看点。
 *   重放同 tick：价值 unchanged、日志不翻倍、两难不翻倍。
 *
 * 只用注入时间与真实 tick：不 sleep、不读真实语义。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../../store/sqlite.js";
import { runSoulMaintenanceTick } from "../../lifecycle/lifecycle-scheduler.js";
import { resolveSoulConfig, type SoulEpisode } from "../types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const SECRET = "sk-abcdefghijklmnopqrstuvwx0123456789";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-p7-e2e-")), "vectors.db");
}

function makeStore(): VectorStore {
  const store = new VectorStore(tmpDb(), 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）：" + res.reason);
  return store;
}

function dbOf(store: VectorStore) {
  return (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
}

type Row = Record<string, unknown>;

function rows(db: ReturnType<typeof dbOf>, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as unknown as Row[];
}

function ep(partial: Partial<SoulEpisode> & { episodeId: string }): SoulEpisode {
  return {
    at: "2026-11-10T09:00:00.000Z",
    day: "2026-11-10",
    kind: "decision",
    title: "一次拍板",
    object: "",
    participants: ["何晨", "assistant"],
    userStance: "",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: 0,
    arousal: 0.3,
    intensity: 0.4,
    evidenceIds: ["m1"],
    sessionId: "s1",
    quote: null,
    affectSource: "lexicon",
    ...partial,
  };
}

function tick(store: VectorStore) {
  return runSoulMaintenanceTick({ store, filter: TENANT, config: resolveSoulConfig({}) });
}

describe("P7 端到端：价值落到真实 tick，gate 只记账不拦写", () => {
  it("有取舍的 episode 长成价值；写入侧 shadow 命中落日志但一行不少；两难有理由与回看点", async () => {
    const store = makeStore();
    const db = dbOf(store);

    store.commitSoulEpisodes(TENANT, [
      ep({
        episodeId: "ep-tradeoff",
        agentStance: "把旧口径留在文档里不删，另起一节写清楚为什么改",
        cost: "多花半小时重写一遍，还得跟人解释两次",
      }),
      ep({
        episodeId: "ep-leak",
        kind: "correction",
        title: "被指出把配置抄进了对话",
        agentStance: "配置就是 " + SECRET + " ，你直接用",
        cost: "当场被指出不安全",
      }),
      ep({
        episodeId: "ep-two-axis",
        kind: "correction",
        title: "既抄了密钥又谎称验证过",
        agentStance: "这份已经全部通过了，password=Sup3rS3cret! 你拿去用",
        cost: "被要求重写",
      }),
    ]);
    const eventsBefore = rows(db, "soul_events").length;
    const episodesBefore = rows(db, "soul_episodes").length;

    const summary = await tick(store);

    // 1) 价值有行，且证据回指 episode（不是凭空一句座右铭）。
    const values = store.listSoulValues!(TENANT, { status: "active" });
    expect(values.length).toBeGreaterThanOrEqual(2);
    for (const v of values) {
      const ids = JSON.parse(v.evidence_event_ids_json) as string[];
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => typeof id === "string" && id.startsWith("ep-"))).toBe(true);
      expect(v.priority).toBeGreaterThan(0);
      expect(v.priority).toBeLessThanOrEqual(1);
    }
    const tradeoff = values.find((v) => v.statement.includes("旧口径"))!;
    expect(tradeoff).toBeTruthy();
    expect(JSON.parse(tradeoff.evidence_event_ids_json)).toEqual(["ep-tradeoff"]);

    // 2) shadow：判定记了「本来会拦」，但 episode / 事件一行没少（写入没被拦）。
    expect(rows(db, "soul_events").length).toBe(eventsBefore);
    expect(rows(db, "soul_episodes").length).toBe(episodesBefore);
    const gateRows = store.listSoulGateLog!(TENANT, { stage: "generation", shadowOnly: true });
    expect(gateRows.length).toBeGreaterThanOrEqual(2);
    const denied = gateRows.filter((r) => r.decision !== "allow");
    expect(denied.length).toBeGreaterThanOrEqual(2);
    for (const r of gateRows) {
      expect(r.reason.startsWith("[shadow]")).toBe(true);
      expect(r.action_digest.startsWith("sha256:")).toBe(true);
    }
    // 命中的敏感字面量不进库
    const allLogs = rows(db, "soul_gate_log").map((r) => JSON.stringify(r)).join("\n");
    expect(allLogs).not.toContain("Sup3rS3cret");
    expect(allLogs).not.toContain("abcdefghij");

    // 3) 两难：密钥 + 谎称验证（两条不同轴）→ 一行，带两侧理由与一周后回看。
    const dilemmas = store.listSoulDilemmas!(TENANT);
    expect(dilemmas.length).toBe(1);
    expect(dilemmas[0]!.choice).toBe("shadow-allow");
    expect(dilemmas[0]!.regret).toBe(0);
    expect(dilemmas[0]!.review_at).toBeTruthy();
    expect(dilemmas[0]!.reason).toContain("secret_leak");
    expect(dilemmas[0]!.reason).toContain("false_claim");
    expect(dilemmas[0]!.conflict_json).not.toContain("Sup3rS3cret");

    // 4) summary 出账（跨租户聚合靠这段）。
    expect(summary.values).toBeTruthy();
    expect(summary.values!.written).toBeGreaterThanOrEqual(2);
    expect(summary.values!.gateEvaluated).toBeGreaterThanOrEqual(2);
    expect(summary.values!.gateHits).toBeGreaterThanOrEqual(2);
    expect(summary.values!.gateLogged).toBeGreaterThanOrEqual(2);
    expect(summary.values!.dilemmas).toBe(1);
  });

  it("同一 tick 重放：价值 unchanged、日志与两难不翻倍", async () => {
    const store = makeStore();
    store.commitSoulEpisodes(TENANT, [
      ep({
        episodeId: "ep-leak",
        agentStance: "已经全部通过了，password=Sup3rS3cret! 拿去用",
        cost: "被要求重写",
      }),
    ]);
    const first = await tick(store);
    expect(first.values!.written).toBe(1);
    expect(first.values!.gateLogged).toBe(1);

    const db = dbOf(store);
    const logsAfterFirst = rows(db, "soul_gate_log").length;
    const dilemmasAfterFirst = rows(db, "soul_dilemma").length;

    const second = await tick(store);
    expect(second.values!.written).toBe(0);
    expect(second.values!.unchanged).toBeGreaterThanOrEqual(1);
    expect(second.values!.gateLogged).toBe(0);
    expect(second.values!.dilemmas).toBe(0);
    expect(rows(db, "soul_gate_log").length).toBe(logsAfterFirst);
    expect(rows(db, "soul_dilemma").length).toBe(dilemmasAfterFirst);
  });

  it("空库：不出价值、不出日志、不编两难", async () => {
    const store = makeStore();
    const summary = await tick(store);
    expect(summary.values).toBeTruthy();
    expect(summary.values!.written).toBe(0);
    expect(summary.values!.gateEvaluated).toBe(0);
    expect(summary.values!.dilemmas).toBe(0);
    expect(store.listSoulValues!(TENANT)).toHaveLength(0);
    expect(store.listSoulGateLog!(TENANT)).toHaveLength(0);
    expect(store.listSoulDilemmas!(TENANT)).toHaveLength(0);
  });
});
