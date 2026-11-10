/**
 * P4 端到端（真实临时库 + 真实 tick 路径）：
 *   soul_events（工具失败 / 后续成功）→ soul_self_model（error_pattern，带反例与可推翻状态）
 *   → soul_calibration（predicted 与 actual 都落库，误差读侧算）
 *   → soul_event_reflection（重复失败/修好后才写，verified_at 指向修复那次）
 *   → summary.selfModel 与 summary.mood.moodState 同一份回执可见
 *   → 卡面 memory 段能看到「（推测）」而不是被写成确定结论。
 *
 * 只用注入的时间戳与真实 tick：不 sleep、不读真实语义，重放两次必须同结果。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { runSoulMaintenanceTick } from "../../lifecycle/lifecycle-scheduler.js";
import { summarizeCalibration } from "../../store/soul-self-store.js";
import { assembleSoulCard } from "../card-service.js";
import { resolveSoulConfig, type SoulEpisode } from "../types.js";
import type { SoulEventWrite } from "../../store/soul-event-store.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-p4-e2e-")), "vectors.db");
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

const HOUR = 3600_000;
const iso = (offsetHours: number) => new Date(Date.now() + offsetHours * HOUR).toISOString();

function writeEvent(opts: {
  id: string;
  at: string;
  status: "failed" | "done";
  action: string;
  object: string;
  outcome: string;
  sourceKind?: "test" | "tool";
  confidence?: number;
}): SoulEventWrite {
  return {
    event: {
      event_id: opts.id,
      at: opts.at,
      day: opts.at.slice(0, 10),
      valid_from: opts.at,
      actor: "tool",
      action: opts.action,
      object: opts.object,
      intent: "",
      outcome: opts.outcome,
      status: opts.status,
      source_kind: opts.sourceKind ?? "test",
      epistemic: "observed",
      confidence: opts.confidence ?? 0.9,
      created_at: opts.at,
    },
    evidence: [{ event_id: opts.id, record_id: "call-" + opts.id, role: "tool", quote: opts.outcome, at: opts.at }],
  };
}

function ep(partial: Partial<SoulEpisode> & { episodeId: string; at: string }): SoulEpisode {
  return {
    day: partial.at.slice(0, 10),
    kind: "work",
    title: "一次推进",
    object: "",
    participants: ["何晨", "assistant"],
    userStance: "",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: 0,
    arousal: 0,
    intensity: 0.2,
    evidenceIds: ["m1"],
    sessionId: "s1",
    quote: null,
    affectSource: "none",
    ...partial,
  };
}

type Row = Record<string, unknown>;

function rows(db: ReturnType<typeof dbOf>, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as unknown as Row[];
}

function tick(store: VectorStore) {
  return runSoulMaintenanceTick({ store, filter: TENANT, config: resolveSoulConfig({}) });
}

describe("P4 端到端：自我模型 / 校准 / 反思落到真实 tick", () => {
  it("工具失败后修好一次：probation + 反例 + 反思，且 tick 回执单一口径能看到", async () => {
    const store = makeStore();
    const db = dbOf(store);
    const failedAt = iso(-3);
    const okAt = iso(-2);
    store.commitSoulEvents(TENANT, [
      writeEvent({ id: "e-fail", at: failedAt, status: "failed", action: "vitest", object: "自维护 tick", outcome: "3 个用例没过" }),
      writeEvent({ id: "e-ok", at: okAt, status: "done", action: "vitest", object: "自维护 tick", outcome: "改完 12 例全绿" }),
    ]);
    // 一条 episode：让心境阶段也跑起来，验证同一份 summary 里两种账都在。
    store.commitSoulEpisodes(TENANT, [
      ep({ episodeId: "ep-1", at: iso(-1), kind: "correction", object: "自维护 tick", valence: -0.2, arousal: 0.5, intensity: 0.5 }),
    ]);

    const summary = await tick(store);

    // 1) 校准：predicted 与 actual 都落了，误差留给读侧。
    const cals = store.listSoulCalibration!(TENANT);
    expect(cals.map((r) => r.event_id).sort()).toEqual(["e-fail", "e-ok"]);
    for (const row of cals) expect(row.predicted_confidence).toBeCloseTo(0.9, 5);
    expect(cals.find((r) => r.event_id === "e-fail")?.actual_outcome).toBe("fail");
    expect(cals.find((r) => r.event_id === "e-ok")?.actual_outcome).toBe("success");
    const byDomain = summarizeCalibration(cals);
    expect(byDomain).toHaveLength(1);
    expect(byDomain[0].domain).toBe("测试");
    expect(byDomain[0].samples).toBe(2);
    expect(byDomain[0].bias).toBeCloseTo(0.4, 5); // (0.9-0) 与 (0.9-1) 的均值：整体高估 0.4
    expect(byDomain[0].mae).toBeCloseTo(0.5, 5); // 平均绝对误差：(0.9 + 0.1) / 2

    // 2) 自我模型：一次失败 + 一次修好 = probation，反例必须留在行上。
    const patterns = store.listSoulSelfModel!(TENANT, { kinds: ["error_pattern"] });
    expect(patterns).toHaveLength(1);
    const pattern = patterns[0];
    expect(pattern.status).toBe("probation");
    expect(String(pattern.statement)).toContain("测试");
    expect(String(pattern.statement)).toContain("后来 1 次成了");
    expect(JSON.parse(String(pattern.counterexample_event_ids_json))).toEqual(["e-ok"]);
    expect(JSON.parse(String(pattern.evidence_event_ids_json))).toContain("e-fail");
    expect(pattern.last_confirmed_at).toBe(failedAt);

    // 3) 反思：修好过才写，verified_at 指向修复那次。
    const reflections = rows(db, "soul_event_reflection");
    expect(reflections).toHaveLength(1);
    expect(reflections[0].event_id).toBe("e-fail");
    expect(String(reflections[0].lesson)).toContain("测试");
    expect(reflections[0].verified_at).toBe(okAt);

    // 4) 回执：selfModel 与 mood.moodState 同一份 summary 里都可见。
    expect(summary.selfModel?.scanned ?? 0).toBeGreaterThanOrEqual(2);
    expect(summary.selfModel?.patterns).toBe(1);
    expect(summary.selfModel?.probation).toBe(1);
    expect(summary.selfModel?.calibrationRows).toBe(2);
    expect(summary.selfModel?.reflections).toBe(1);
    expect(summary.mood?.stateWritten).toBe(1);
    expect(summary.mood?.halfLifeHours).toBe(48);

    // 5) 卡面：低置信度的行带「（推测）」，不被写成定论。
    const card = await assembleSoulCard({ store, tenant: TENANT, persist: false });
    expect(card.text).toContain("（推测）");
    expect(card.text).toContain("测试");

    // 6) 重放：同一批事件再跑一次，校准不翻倍、自我模型与反思都不新增。
    const moodEventsBefore = rows(db, "soul_mood_events").length;
    await tick(store);
    expect(store.listSoulCalibration!(TENANT)).toHaveLength(2);
    expect(store.listSoulSelfModel!(TENANT, { kinds: ["error_pattern"] })).toHaveLength(1);
    expect(rows(db, "soul_event_reflection")).toHaveLength(1);
    expect(rows(db, "soul_mood_events").length).toBe(moodEventsBefore);
  });

  it("校准按领域分开算，不给全局分", async () => {
    const store = makeStore();
    // 每个领域都给两条样本：只有一条样本时不该下领域结论（见上一个断言组）。
    store.commitSoulEvents(TENANT, [
      writeEvent({ id: "e-t1", at: iso(-5), status: "failed", action: "vitest", object: "", outcome: "用例没过", confidence: 0.9 }),
      writeEvent({ id: "e-t2", at: iso(-4), status: "done", action: "vitest", object: "", outcome: "改完全绿", confidence: 0.9 }),
      writeEvent({ id: "e-r1", at: iso(-3), status: "failed", action: "recall", object: "召回链路", outcome: "召回没生效", sourceKind: "tool", confidence: 0.5 }),
      writeEvent({ id: "e-r2", at: iso(-2), status: "failed", action: "recall", object: "召回链路", outcome: "还是没生效", sourceKind: "tool", confidence: 0.5 }),
    ]);
    await tick(store);
    const summary = summarizeCalibration(store.listSoulCalibration!(TENANT));
    expect(summary.map((s) => s.domain).sort()).toEqual(["召回", "测试"].sort());
    const byDomain = new Map(summary.map((s) => [s.domain, s]));
    expect(byDomain.get("测试")!.bias).toBeCloseTo(0.4, 5); // 失败高估 0.9、成功低估 0.1 → 净 0.4
    expect(byDomain.get("召回")!.bias).toBeCloseTo(0.5, 5);
    // 结论只落在各自领域上，没有一条「整体上我高估/低估」。
    const insights = store.listSoulSelfModel!(TENANT, { kinds: ["calibration"] });
    expect(insights.map((r) => String(r.scope)).sort()).toEqual(["召回", "测试"].sort());
    for (const row of insights) expect(String(row.statement)).toContain("约");
    // 没有 scope=global 的全局分：结论必须按领域落地。
    expect(insights.some((r) => String(r.scope) === "global")).toBe(false);
  });

  it("只有对话没有可核对的结果：不编自我模型，也不充校准样本", async () => {
    const store = makeStore();
    const db = dbOf(store);
    const at = iso(-2);
    store.commitSoulEvents(TENANT, [
      {
        event: {
          event_id: "c-1",
          at,
          day: at.slice(0, 10),
          valid_from: at,
          actor: "user",
          action: "said",
          object: "召回链路",
          intent: "",
          outcome: "你搞错了吧，召回根本没生效",
          status: "unknown",
          source_kind: "chat",
          epistemic: "observed",
          confidence: 0.8,
          created_at: at,
        },
        evidence: [{ event_id: "c-1", record_id: "l0-1", role: "user", quote: "你搞错了吧，召回根本没生效", at }],
      },
    ]);
    await tick(store);
    expect(rows(db, "soul_self_model")).toHaveLength(0);
    expect(rows(db, "soul_calibration")).toHaveLength(0);
    expect(rows(db, "soul_event_reflection")).toHaveLength(0);
  });
});
