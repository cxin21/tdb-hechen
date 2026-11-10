/**
 * P4 自我模型与校准（spec §4.5/§4.6）。
 *
 * 三件必须成立的事：
 *  1. 错误模式只从可核对的事实长（测试失败/回滚/后续修复成功/重复失败/用户当场纠正），
 *     不从一句批评推性格；每条认识都带反例，且能被 probation / retired 推翻。
 *  2. 校准只入账有预测有结果的事件，按领域分组，误差（正 = 过度自信）由读侧算，不给全局分。
 *  3. 卡面只放能被行动改变认识的短句：低置信度带「（推测）」，没验证过带「（没验过）」。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import type {
  SoulCalibrationRow,
  SoulEventRow,
  SoulSelfModelRow,
} from "../../store/soul-event-types.js";
import { selfModelId, summarizeCalibration } from "../../store/soul-self-store.js";
import { deriveSelfModel, selfModelCardLines, selfModelConfidenceMarker } from "../self-model.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const OTHER = { teamId: "t2", userId: "u1", agentId: "a1" };

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-self-model-")), "vectors.db");
}

function makeStore(): VectorStore {
  const store = new VectorStore(tmpDb(), 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级：" + res.reason);
  return store;
}

function ev(partial: Partial<SoulEventRow> & { event_id: string }): SoulEventRow {
  return {
    team_id: TENANT.teamId,
    user_id: TENANT.userId,
    agent_id: TENANT.agentId,
    at: "2026-11-01T00:00:00.000Z",
    day: "2026-11-01",
    valid_from: "2026-11-01T00:00:00.000Z",
    valid_to: null,
    actor: "tool",
    actor_person_key: null,
    action: "vitest",
    object: "",
    intent: "",
    outcome: "",
    status: "unknown",
    source_kind: "test",
    source_ref: "call-1",
    ownership: "mine",
    epistemic: "observed",
    confidence: 0.9,
    visibility: "shared",
    session_id: "s1",
    persons_json: null,
    parent_event_id: null,
    dedupe_key: null,
    salience: 0,
    created_at: "2026-11-01T00:00:00.000Z",
    archived_at: null,
    ...partial,
  };
}

function cal(id: string, predicted: number, actual: SoulCalibrationRow["actual_outcome"], at = "2026-11-01T00:00:00.000Z"): SoulCalibrationRow {
  return {
    id,
    team_id: TENANT.teamId,
    user_id: TENANT.userId,
    agent_id: TENANT.agentId,
    domain: "测试",
    predicted_confidence: predicted,
    actual_outcome: actual,
    event_id: id.replace(/^cal:/u, ""),
    at,
    error: null,
    note: "",
  };
}

describe("deriveSelfModel：错误模式从事实长出来，且能被推翻", () => {
  it("一次测试失败：active、confidence 0.45、卡面带（推测）", () => {
    const res = deriveSelfModel({
      events: [ev({ event_id: "e-fail", at: "2026-11-01T01:00:00.000Z", status: "failed", outcome: "召回链路 3 个用例没过" })],
      now: "2026-11-02T00:00:00.000Z",
    });
    const row = res.selfModels.find((r) => r.kind === "error_pattern");
    expect(row?.id).toBe(selfModelId("error_pattern", "测试"));
    expect(row?.status).toBe("active");
    expect(row?.confidence).toBeCloseTo(0.45, 5);
    expect(row?.statement).toContain("我最近 1 次没成");
    expect(selfModelConfidenceMarker({ confidence: Number(row!.confidence ?? 0), last_confirmed_at: row!.last_confirmed_at ?? null })).toBe("（推测）");
    // 校准同时入账：有预测（0.9）、有结果（fail）。
    const cr = res.calibrationRows.find((r) => r.id === "cal:e-fail");
    expect(cr?.actual_outcome).toBe("fail");
    expect(cr?.predicted_confidence).toBe(0.9);
    expect(cr?.domain).toBe("测试");
  });

  it("失败后成了一次：降为 probation，反例留在行上", () => {
    const res = deriveSelfModel({
      events: [
        ev({ event_id: "e-fail", at: "2026-11-01T01:00:00.000Z", status: "failed", outcome: "3 个用例没过" }),
        ev({ event_id: "e-ok1", at: "2026-11-01T02:00:00.000Z", status: "done", outcome: "全绿" }),
      ],
      now: "2026-11-02T00:00:00.000Z",
    });
    const row = res.selfModels.find((r) => r.kind === "error_pattern")!;
    expect(row.status).toBe("probation");
    expect(JSON.parse(row.counterexample_event_ids_json as string)).toEqual(["e-ok1"]);
    expect(row.statement).toContain("后来 1 次成了");
    expect(row.statement).toContain("最近一次没成");
    expect(res.reflections).toHaveLength(1);
    expect(res.reflections[0].verified_at).toBe("2026-11-01T02:00:00.000Z");
  });

  it("失败后连着成了两次：retired（可被推翻，且不进卡）", () => {
    const res = deriveSelfModel({
      events: [
        ev({ event_id: "e-fail", at: "2026-11-01T01:00:00.000Z", status: "failed", outcome: "3 个用例没过" }),
        ev({ event_id: "e-ok1", at: "2026-11-01T02:00:00.000Z", status: "done", outcome: "全绿" }),
        ev({ event_id: "e-ok2", at: "2026-11-01T03:00:00.000Z", status: "done", outcome: "又全绿" }),
      ],
      now: "2026-11-02T00:00:00.000Z",
    });
    const row = res.selfModels.find((r) => r.kind === "error_pattern")!;
    expect(row.status).toBe("retired");
    const cards = selfModelCardLines([{ ...row, team_id: "t1", user_id: "u1", agent_id: "a1", created_at: row.created_at ?? "2026-11-02T00:00:00.000Z" } as SoulSelfModelRow]);
    expect(cards).toHaveLength(0);
  });

  it("两次成功且没有失败：能力行，不写推测", () => {
    const res = deriveSelfModel({
      events: [
        ev({ event_id: "e-ok1", at: "2026-11-01T01:00:00.000Z", action: "bash", status: "done", object: "迁移脚本", outcome: "跑通" }),
        ev({ event_id: "e-ok2", at: "2026-11-01T02:00:00.000Z", action: "bash", status: "done", object: "迁移脚本", outcome: "又跑通" }),
      ],
      now: "2026-11-02T00:00:00.000Z",
    });
    const row = res.selfModels.find((r) => r.kind === "capability")!;
    expect(row.id).toBe(selfModelId("capability", "迁移"));
    expect(row.confidence).toBeCloseTo(0.7, 5);
    expect(selfModelConfidenceMarker({ confidence: Number(row.confidence ?? 0), last_confirmed_at: row.last_confirmed_at ?? null })).toBe("");
  });

  it("用户当场纠正进证据，但不单独构成错误模式（不从一个字推性格）", () => {
    const chat = ev({
      event_id: "c-1",
      at: "2026-11-01T01:00:00.000Z",
      source_kind: "chat",
      actor: "user",
      action: "said",
      status: "unknown",
      object: "召回链路",
      outcome: "你搞错了吧，召回根本没生效",
    });
    const onlyChat = deriveSelfModel({ events: [chat], now: "2026-11-02T00:00:00.000Z" });
    expect(onlyChat.selfModels.filter((r) => r.kind === "error_pattern")).toHaveLength(0);

    const res = deriveSelfModel({
      events: [
        ev({ event_id: "e-fail", at: "2026-11-01T00:30:00.000Z", action: "recall", status: "failed", object: "召回链路", outcome: "召回没生效" }),
        chat,
      ],
      now: "2026-11-02T00:00:00.000Z",
    });
    const row = res.selfModels.find((r) => r.kind === "error_pattern")!;
    expect(row.statement).toContain("被当场指出 1 次");
    expect(JSON.parse(row.evidence_event_ids_json as string)).toContain("c-1");
  });
});

describe("校准：按领域分组，bias 正 = 过度自信", () => {
  it("三个领域行聚合成一条校准认识，不给全局分", () => {
    const carried = [cal("cal:1", 0.9, "fail"), cal("cal:2", 0.9, "fail"), cal("cal:3", 0.9, "fail")];
    const summary = summarizeCalibration(carried);
    expect(summary).toHaveLength(1);
    expect(summary[0].domain).toBe("测试");
    expect(summary[0].samples).toBe(3);
    expect(summary[0].bias).toBeCloseTo(0.9, 5);
    expect(summary[0].mae).toBeCloseTo(0.9, 5);

    const res = deriveSelfModel({ events: [], calibrations: carried, now: "2026-11-02T00:00:00.000Z" });
    const insight = res.selfModels.find((r) => r.kind === "calibration")!;
    expect(insight.scope).toBe("测试");
    expect(insight.statement).toContain("高约");
    expect(insight.statement).toContain("3 次可算");
    // 1 - 0.9 → 0.1，但只有 3 个样本，认识本身不该写成高置信度：下限 0.3（卡上仍标「推测」）。
    expect(insight.confidence).toBeCloseTo(0.3, 5);
  });

  it("同 id 的存量行与本轮新行不重复计样本", () => {
    const carried = [cal("cal:e-ok", 0.8, "success")];
    const res = deriveSelfModel({
      events: [ev({ event_id: "e-ok", at: "2026-11-01T01:00:00.000Z", status: "done", outcome: "成了" })],
      calibrations: carried,
      now: "2026-11-02T00:00:00.000Z",
    });
    expect(res.calibrationRows).toHaveLength(1);
    // 只有 1 个样本 → 不写校准认识（不拿一条样本下结论）。
    expect(res.selfModels.filter((r) => r.kind === "calibration")).toHaveLength(0);
  });

  it("反例与证据与旧行并集：窗口滚掉的旧反例不会被覆盖", () => {
    const prev: SoulSelfModelRow = {
      id: selfModelId("error_pattern", "测试"),
      team_id: TENANT.teamId,
      user_id: TENANT.userId,
      agent_id: TENANT.agentId,
      kind: "error_pattern",
      scope: "测试",
      statement: "旧认识",
      confidence: 0.6,
      evidence_event_ids_json: JSON.stringify(["old-fail"]),
      counterexample_event_ids_json: JSON.stringify(["old-ok"]),
      status: "active",
      last_confirmed_at: "2026-10-01T00:00:00.000Z",
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    };
    const res = deriveSelfModel({
      events: [ev({ event_id: "e-fail", at: "2026-11-01T01:00:00.000Z", status: "failed", outcome: "又没过" })],
      previous: [prev],
      now: "2026-11-02T00:00:00.000Z",
    });
    const row = res.selfModels.find((r) => r.kind === "error_pattern")!;
    expect(JSON.parse(row.evidence_event_ids_json as string)).toEqual(["e-fail", "old-fail"]);
    expect(JSON.parse(row.counterexample_event_ids_json as string)).toEqual(["old-ok"]);
    expect(row.created_at).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("卡面行：短、可行动、带低置信度标记", () => {
  it("最多 2 条，错误模式优先，不出现「用户」二字", () => {
    const rows = [
      { id: "cap", kind: "capability", scope: "迁移", statement: "在迁移这类活上，我最近 3 次都成了", confidence: 0.85, status: "active", last_confirmed_at: "2026-11-01T00:00:00.000Z", evidence_event_ids_json: "[]", counterexample_event_ids_json: "[]", team_id: "", user_id: "", agent_id: "", created_at: "", updated_at: "" },
      { id: "pat", kind: "error_pattern", scope: "测试", statement: "在测试这类活上我最近 1 次没成（最近一次：3 个用例没过）", confidence: 0.45, status: "active", last_confirmed_at: "2026-11-01T00:00:00.000Z", evidence_event_ids_json: "[]", counterexample_event_ids_json: "[]", team_id: "", user_id: "", agent_id: "", created_at: "", updated_at: "" },
      { id: "cal", kind: "calibration", scope: "测试", statement: "在测试上，我给的把握比实际结果高约 0.40（2 次可算）", confidence: 0.6, status: "active", last_confirmed_at: "2026-11-01T00:00:00.000Z", evidence_event_ids_json: "[]", counterexample_event_ids_json: "[]", team_id: "", user_id: "", agent_id: "", created_at: "", updated_at: "" },
    ] as unknown as SoulSelfModelRow[];
    const lines = selfModelCardLines(rows, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toContain("测试");
    expect(lines[0].text).toContain("推测");
    expect(lines.map((l) => l.text).join("")).not.toContain("用户");
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(80);
  });
});

describe("落表：读回、租户隔离、账本幂等", () => {
  it("自我模型整行 upsert + 过滤 + 租户隔离", () => {
    const store = makeStore();
    expect(store.listSoulSelfModel(TENANT)).toEqual([]);
    const row = store.upsertSoulSelfModel!(TENANT, {
      id: selfModelId("error_pattern", "测试"),
      kind: "error_pattern",
      scope: "测试",
      statement: "在测试这类活上，我最近 1 次没成",
      confidence: 0.45,
      evidence_event_ids_json: JSON.stringify(["e1"]),
      counterexample_event_ids_json: "[]",
      status: "active",
      last_confirmed_at: "2026-11-01T00:00:00.000Z",
      created_at: "2026-11-01T00:00:00.000Z",
      updated_at: "2026-11-01T00:00:00.000Z",
    });
    expect(row?.confidence).toBe(0.45);
    expect(store.getSoulSelfModel!(TENANT, selfModelId("error_pattern", "测试"))?.statement).toContain("没成");
    expect(store.listSoulSelfModel!(TENANT, { kinds: ["capability"] })).toHaveLength(0);
    expect(store.listSoulSelfModel!(TENANT, { statuses: ["active"] })).toHaveLength(1);
    expect(store.listSoulSelfModel!(OTHER)).toHaveLength(0);
  });

  it("校准按 id 幂等，领域过滤可读，读侧能算 bias", () => {
    const store = makeStore();
    const rows = [cal("cal:a", 0.9, "fail"), cal("cal:b", 0.8, "success")];
    expect(store.commitSoulCalibration!(TENANT, rows).inserted).toBe(2);
    expect(store.commitSoulCalibration!(TENANT, rows).inserted).toBe(0);
    expect(store.listSoulCalibration!(TENANT)).toHaveLength(2);
    expect(store.listSoulCalibration!(TENANT, { domain: "测试" })).toHaveLength(2);
    expect(store.listSoulCalibration!(TENANT, { domain: "召回" })).toHaveLength(0);
    const summary = summarizeCalibration(store.listSoulCalibration!(TENANT));
    expect(summary[0].bias).toBeCloseTo(0.35, 5); // (0.9-0) 与 (0.8-1) 的均值
    expect(store.listSoulCalibration!(OTHER)).toHaveLength(0);
  });

  it("反思子表可按事件整行覆盖（重复写不新增行）", () => {
    const store = makeStore();
    // 反思是 soul_events 的子表（FK ON DELETE CASCADE），父事件必须先存在。
    store.commitSoulEvents!(TENANT, [
      {
        event: {
          event_id: "e-fail",
          at: "2026-11-01T01:00:00.000Z",
          day: "2026-11-01",
          valid_from: "2026-11-01T01:00:00.000Z",
          actor: "tool",
          action: "vitest",
          object: "",
          intent: "",
          outcome: "3 个用例没过",
          source_kind: "test",
          epistemic: "observed",
          confidence: 0.9,
          created_at: "2026-11-01T01:00:00.000Z",
        },
        evidence: [{ event_id: "e-fail", record_id: "call-1", role: "tool", quote: "FAIL 3 tests", at: "2026-11-01T01:00:00.000Z" }],
      },
    ]);
    const reflection = {
      event_id: "e-fail",
      about_event_ids_json: JSON.stringify(["e-fail"]),
      lesson: "测试没过就别说验证过",
      behavior_change: "先在测试上验过再报完成",
      verified_at: null,
      confidence: 0.5,
    };
    expect(store.upsertSoulEventReflection!(TENANT, reflection).upserted).toBe(1);
    expect(store.upsertSoulEventReflection!(TENANT, { ...reflection, lesson: "改过的认识" }).upserted).toBe(1);
    const raw = (store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } }).db
      .prepare("SELECT lesson FROM soul_event_reflection WHERE event_id = ?")
      .all("e-fail") as Array<{ lesson: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].lesson).toBe("改过的认识");
  });
});
