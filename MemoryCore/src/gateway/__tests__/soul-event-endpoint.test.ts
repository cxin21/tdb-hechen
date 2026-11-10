/**
 * P1-B（2026-11-10）POST /v3/soul/event 契约测试。
 *
 * RED 判据（对应任务验收）：
 *  1. 成功落库：tool 事件 + 工具证据 → 200 {duplicate:false}，基表/子表/证据都在。
 *  2. 幂等：同 dedupe_key 第二次 → duplicate:true、同一 event_id、insert 只被调一次。
 *  3. 缺租户头 → 422 且列出缺项（绝不回退 default 桶）。
 *  4. 字段非法 → 400（含「无证据却要 observed」由 store 准入拒成 400，不是 500）。
 *  5. 鉴权失败 → 401 信封。
 *  6. 并发重放撞唯一索引 → 仍按 duplicate 处理，不 500。
 *
 * 库是真的（:memory: + SOUL_EVENT_DDL），只把 store 的两个函数包一层 spy 以计数调用。
 */
import { DatabaseSync } from "node:sqlite";

import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SOUL_EVENT_DDL } from "../../core/store/soul-event-ddl.js";
import type { CoreTenant, IMemoryStore } from "../../core/store/types.js";
import { handleSoulEventRoute, SOUL_EVENT_PATH } from "../soul-event-endpoint.js";

vi.mock("../../core/store/soul-event-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/store/soul-event-store.js")>();
  return {
    ...actual,
    insertSoulEvent: vi.fn(actual.insertSoulEvent),
    findSoulEventIdByDedupeKey: vi.fn(actual.findSoulEventIdByDedupeKey),
  };
});

import {
  countSoulEvents,
  findSoulEventIdByDedupeKey,
  getSoulEvent,
  insertSoulEvent,
  listSoulEventEvidence,
} from "../../core/store/soul-event-store.js";

const TENANT: CoreTenant = { teamId: "team-a", userId: "u-1", agentId: "ag-1" };
const TENANT_HEADERS = {
  "x-tdai-team-id": TENANT.teamId,
  "x-tdai-user-id": TENANT.userId,
  "x-tdai-agent-id": TENANT.agentId,
};

let db: DatabaseSync;
let sendJson: ReturnType<typeof vi.fn>;
let body: Record<string, unknown>;

function makeDeps(over: Partial<{ authorized: boolean; store: IMemoryStore | null }> = {}) {
  return {
    getStore: () =>
      over.store === undefined ? ({ getRawDb: () => db } as unknown as IMemoryStore) : over.store,
    isAuthorized: () => over.authorized ?? true,
    logger: { info: () => {}, warn: () => {} },
    now: () => new Date("2026-11-10T14:00:00.000Z"),
  };
}

function makeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/** 与 server 的 parseJsonBody 同形：泛型式返回，测试里固定回放同一份 body。 */
const parseJsonBody = async <T,>(): Promise<T> => body as unknown as T;

async function post(
  payload: Record<string, unknown>,
  headers: Record<string, string> = TENANT_HEADERS,
  depsOver: Parameters<typeof makeDeps>[0] = {},
): Promise<{ status: number; payload: Record<string, unknown> }> {
  body = payload;
  sendJson.mockClear();
  const handled = await handleSoulEventRoute(
    makeReq(headers),
    {} as ServerResponse,
    SOUL_EVENT_PATH,
    "POST",
    parseJsonBody,
    sendJson as never,
    makeDeps(depsOver),
  );
  expect(handled).toBe(true);
  const call = sendJson.mock.calls[0] as [unknown, number, Record<string, unknown>] | undefined;
  expect(call).toBeDefined();
  return { status: call![1], payload: call![2] };
}

function toolPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dedupe_key: "tool:bash:call-1",
    source_kind: "tool",
    summary: "跑 vitest，12/12 通过",
    occurred_at: "2026-11-10T13:59:00.000Z",
    session_id: "s-1",
    persons: ["p_hechen"],
    evidence: [{ role: "tool", quote: "Tests 12 passed (12)", record_id: "call-1" }],
    action: {
      tool: "bash",
      tool_call_id: "call-1",
      args_digest: "sha256:abc123",
      result_status: "success",
      duration_ms: 8412,
      error_code: null,
    },
    epistemic: "observed",
    confidence: 0.85,
    ...over,
  };
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SOUL_EVENT_DDL) db.exec(sql);
  sendJson = vi.fn();
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

describe("POST /v3/soul/event", () => {
  it("成功落库：基表 + action 子表 + 工具证据，duplicate:false", async () => {
    const out = await post(toolPayload());
    expect(out.status).toBe(200);
    expect(out.payload.code).toBe(0);
    const data = out.payload.data as { event_id: string; duplicate: boolean };
    expect(data.duplicate).toBe(false);
    expect(data.event_id).toMatch(/^evt-/);

    const row = getSoulEvent(db, TENANT, data.event_id);
    expect(row).toMatchObject({
      source_kind: "tool",
      epistemic: "observed",
      confidence: 0.85,
      actor: "tool",
      action: "bash",
      outcome: "跑 vitest，12/12 通过",
      status: "done",
      session_id: "s-1",
      // 工具事件的源头是 tool_call_id，不是 L0 record_id。
      source_ref: "call-1",
      persons_json: JSON.stringify(["p_hechen"]),
    });
    expect(String(row?.dedupe_key)).toContain("tool:bash:call-1");
    expect(String(row?.dedupe_key)).toContain(TENANT.teamId);
    expect(listSoulEventEvidence(db, data.event_id).map((e) => [e.role, e.record_id])).toEqual([
      ["tool", "call-1"],
    ]);
    expect(countSoulEvents(db, TENANT)).toBe(1);
    expect(insertSoulEvent).toHaveBeenCalledTimes(1);
  });

  it("幂等：同 dedupe_key 第二次 → duplicate:true、同 event_id、insert 只调一次", async () => {
    const first = await post(toolPayload());
    const second = await post(toolPayload());
    const firstData = first.payload.data as { event_id: string; duplicate: boolean };
    const secondData = second.payload.data as { event_id: string; duplicate: boolean };

    expect(firstData.duplicate).toBe(false);
    expect(second.status).toBe(200);
    expect(secondData.duplicate).toBe(true);
    expect(secondData.event_id).toBe(firstData.event_id);
    expect(insertSoulEvent).toHaveBeenCalledTimes(1);
    expect(countSoulEvents(db, TENANT)).toBe(1);
  });

  it("缺租户头 → 422 且列出缺项，绝不回退 default 桶", async () => {
    const out = await post(toolPayload(), {
      "x-tdai-team-id": TENANT.teamId,
      "x-tdai-user-id": TENANT.userId,
    });
    expect(out.status).toBe(422);
    expect(String(out.payload.message)).toContain("x-tdai-agent-id");
    expect((out.payload.data as { missing: string[] }).missing).toEqual(["x-tdai-agent-id"]);
    expect(insertSoulEvent).not.toHaveBeenCalled();
    expect(countSoulEvents(db, TENANT)).toBe(0);
  });

  it("字段非法 → 400：缺 summary / dedupe_key 超长 / source_kind 不在词表", async () => {
    for (const over of [
      { summary: undefined },
      { dedupe_key: "x".repeat(201) },
      { source_kind: "imagination" },
    ]) {
      const out = await post(toolPayload(over));
      expect(out.status).toBe(400);
      expect(out.payload.code).toBe(400);
      expect(out.payload.request_id).toBeTruthy();
    }
    expect(countSoulEvents(db, TENANT)).toBe(0);
  });

  it("无证据却要 observed：store 准入拒成 400（不是 500）", async () => {
    const out = await post(
      toolPayload({ evidence: [], epistemic: "observed", confidence: 0.9 }),
    );
    expect(out.status).toBe(400);
    expect(String(out.payload.message)).toContain("没有任何证据");
    expect(countSoulEvents(db, TENANT)).toBe(0);
  });

  it("鉴权失败 → 401 信封（不落库）", async () => {
    const out = await post(toolPayload(), TENANT_HEADERS, { authorized: false });
    expect(out.status).toBe(401);
    expect(out.payload.code).toBe(401);
    expect(out.payload.request_id).toBeTruthy();
    expect(countSoulEvents(db, TENANT)).toBe(0);
  });

  it("并发重放撞唯一索引 → 按 duplicate 处理，不 500", async () => {
    const first = await post(toolPayload());
    const eventId = (first.payload.data as { event_id: string }).event_id;

    // 模拟「查与插之间被抢先」：让本次的查重漏看（真实库里那行还在），insert 真撞 UNIQUE。
    vi.mocked(findSoulEventIdByDedupeKey).mockImplementationOnce(() => null);
    const out = await post(toolPayload());

    expect(out.status).toBe(200);
    const data = out.payload.data as { event_id: string; duplicate: boolean };
    expect(data.duplicate).toBe(true);
    expect(data.event_id).toBe(eventId);
    expect(countSoulEvents(db, TENANT)).toBe(1);
  });

  it("evidence.quote 超长截断到 400，不整条拒", async () => {
    const out = await post(
      toolPayload({ evidence: [{ role: "tool", quote: "x".repeat(500), record_id: "call-9" }] }),
    );
    expect(out.status).toBe(200);
    const eventId = (out.payload.data as { event_id: string }).event_id;
    const [evidence] = listSoulEventEvidence(db, eventId);
    expect(evidence.quote).toHaveLength(400);
  });
});
