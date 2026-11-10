/**
 * POST/GET /v3/soul/gate 的合同测试（假 store，不连库）。
 *
 * 这条接口是 P7 唯一可执行的输出侧 gate，测试只盯「行为的形状」：
 *  1. 判定写得清楚（wouldDecision），但输出侧**恒 allow**——shadow 期谁都不许据此改正文；
 *  2. 判定与两难都落库，回包给出 logged / dilemmaId（面板与抽检据此对账）；
 *  3. 租户三头缺一 422 且列缺项，绝不回退 default 桶（回退等于把别人的私话当本人边界）；
 *  4. 读面回「统计 + 语料误杀口径 + 抽检行」，缺读面 503；
 *  5. 命中原文（密钥、私话）既不落库也不回显。
 */
import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  SOUL_GATE_MAX_TEXT_CHARS,
  SOUL_GATE_PATH,
  SOUL_GATE_ROWS_MAX,
  handleSoulGateRoute,
} from "../soul-gate-endpoint.js";

const res = {} as ServerResponse;
const NOW = "2026-11-10T09:00:00.000Z";
const TENANT_HEADERS = {
  "x-tdai-team-id": "t1",
  "x-tdai-user-id": "u1",
  "x-tdai-agent-id": "a1",
};

function makeReq(opts?: { headers?: Record<string, string>; url?: string }) {
  return {
    headers: { ...(opts?.headers ?? TENANT_HEADERS) },
    url: opts?.url ?? SOUL_GATE_PATH,
  } as unknown as IncomingMessage;
}

function makeStore(overrides: Record<string, unknown> = {}) {
  const calls = { logs: [] as unknown[][], dilemmas: [] as unknown[][], gateLogReads: [] as unknown[] };
  const store = {
    listSoulPrivateEventQuotes: async () => [],
    insertSoulGateLog: async (_tenant: unknown, rows: unknown[]) => {
      calls.logs.push(rows);
      return { inserted: rows.length };
    },
    insertSoulDilemma: async (_tenant: unknown, row: { id: string }) => {
      calls.dilemmas.push([row]);
      return row;
    },
    listSoulGateLog: async (_tenant: unknown, opts: unknown) => {
      calls.gateLogReads.push(opts);
      return [
        {
          id: "gate-output-abc",
          at: NOW,
          stage: "output",
          decision: "deny",
          rule_id: "secret_leak",
          reason: "[shadow] allow would-be=deny",
          confidence: 0.9,
          event_id: null,
          action_digest: "sha256:0123456789abcdef",
        },
      ];
    },
    summarizeSoulGateLog: async () => ({
      total: 1,
      shadow: 1,
      enforced: 0,
      wouldBlock: 1,
      wouldBlockRate: 1,
      byDecision: { allow: 0, deny: 1, rewrite: 0, ask: 0 },
      byRule: [{ ruleId: "secret_leak", total: 1, wouldBlock: 1, allow: 0, deny: 1, rewrite: 0, ask: 0 }],
      hitRows: 1,
    }),
    ...overrides,
  };
  return { store, calls };
}

async function call(opts: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  url?: string;
  store?: unknown;
  isAuthorized?: () => boolean;
}) {
  const sendJson = vi.fn();
  const store = "store" in opts ? opts.store : makeStore().store;
  const req = makeReq({ ...(opts.headers ? { headers: opts.headers } : {}), ...(opts.url ? { url: opts.url } : {}) });
  const handled = await handleSoulGateRoute(
    req,
    res,
    new URL(req.url ?? SOUL_GATE_PATH, "http://localhost").pathname,
    opts.method ?? "POST",
    async <T>() => (opts.body ?? {}) as T,
    sendJson,
    {
      getStore: () => store as never,
      ...(opts.isAuthorized ? { isAuthorized: opts.isAuthorized } : {}),
      now: () => NOW,
    },
  );
  const [, status, payload] = (sendJson.mock.calls[0] ?? []) as [unknown, number, unknown];
  return { handled, status, payload: payload as { code: number; data: Record<string, unknown>; error?: { message?: string; details?: unknown } } };
}

describe("POST /v3/soul/gate：判得清，但 shadow 期恒 allow", () => {
  it("只认 /v3/soul/gate；其余路径交回 dispatch，非 GET/POST 回 405", async () => {
    expect((await call({ url: "/v3/soul/other" })).handled).toBe(false);
    expect((await call({ method: "PUT" })).status).toBe(405);
  });

  it("泄露凭据：wouldDecision=deny，decision 恒 allow，判定落库，原文字面量不回显", async () => {
    const { store, calls } = makeStore();
    const text = "配置是 sk-abcdefghijklmnopqrstuvwx0123456789，拿走用。";
    const out = await call({ body: { text }, store });
    expect(out.status).toBe(200);
    expect(out.payload.code).toBe(0);
    expect(out.payload.data.decision).toBe("allow");
    expect(out.payload.data.shadow).toBe(true);
    expect(out.payload.data.wouldDecision).toBe("deny");
    expect(out.payload.data.matched).toBe(true);
    expect(out.payload.data.stage).toBe("output");
    expect(String(out.payload.data.digest).startsWith("sha256:")).toBe(true);
    const hits = out.payload.data.hits as Array<Record<string, unknown>>;
    expect(hits.map((h) => h.ruleId)).toEqual(["secret_leak"]);
    expect(JSON.stringify(out.payload)).not.toContain("abcdefghij");

    expect(calls.logs).toHaveLength(1);
    const logged = calls.logs[0]![0] as Record<string, unknown>;
    expect(logged.decision).toBe("deny");
    expect(String(logged.reason).startsWith("[shadow]")).toBe(true);
    expect(out.payload.data.logged).toEqual({ inserted: 1 });
    expect(out.payload.data.dilemmaId).toBeNull();
    expect(out.payload.data.conflict).toBe("none");
  });

  it("隐私边界：边界外人听到原话 → deny；只对当事人 → 放行", async () => {
    const quote = { event_id: "ep-p", visibility: "private", persons: ["p_he"], quote: "我月底可能要换个工作，先别跟别人说", at: NOW };
    const { store } = makeStore({ listSoulPrivateEventQuotes: async () => [quote] });
    const text = "他原话是「我月底可能要换个工作，先别跟别人说」。";

    const leak = await call({ body: { text, audience: ["p_zhou"] }, store });
    expect(leak.payload.data.wouldDecision).toBe("deny");
    expect((leak.payload.data.hits as Array<Record<string, unknown>>)[0]!.ruleId).toBe("privacy_boundary");
    expect(JSON.stringify(leak.payload)).not.toContain("换个工作");

    const own = await call({ body: { text, audience: ["p_he"], persons: ["p_he"] }, store });
    expect(own.payload.data.wouldDecision).toBe("allow");
    expect(own.payload.data.matched).toBe(false);
  });

  it("不同轴冲突：落两难并回 dilemmaId / conflict=present", async () => {
    const quote = { event_id: "ep-p", visibility: "private", persons: ["p_he"], quote: "我月底可能要换个工作，先别跟别人说", at: NOW };
    const { store, calls } = makeStore({ listSoulPrivateEventQuotes: async () => [quote] });
    const out = await call({
      body: { text: "他原话「我月底可能要换个工作，先别跟别人说」，已经全部跑过测试了，全部通过。", audience: ["p_zhou"] },
      store,
    });
    expect(out.payload.data.conflict).toBe("present");
    expect(String(out.payload.data.dilemmaId).startsWith("dil-output-")).toBe(true);
    expect(calls.dilemmas).toHaveLength(1);
    const dilemma = calls.dilemmas[0]![0] as Record<string, unknown>;
    expect(dilemma.choice).toBe("shadow-allow");
    expect(JSON.stringify(dilemma)).not.toContain("换个工作");
  });

  it("租户三头缺一 → 422 并列出缺项（不回退 default 桶）", async () => {
    const out = await call({ headers: { "x-tdai-team-id": "t1" }, body: { text: "随便" } });
    expect(out.status).toBe(422);
    expect(out.payload.code).toBe(422);
    const message = String((out.payload as unknown as { message?: string }).message);
    expect(message).toContain("x-tdai-user-id");
    expect(message).toContain("x-tdai-agent-id");
    expect((out.payload.data as Record<string, unknown>).missing).toEqual(["x-tdai-user-id", "x-tdai-agent-id"]);
  });

  it("未授权 → 401；空/超长正文与非枚举 stage → 400", async () => {
    expect((await call({ body: { text: "x" }, isAuthorized: () => false })).status).toBe(401);
    expect((await call({ body: { text: "   " } })).status).toBe(400);
    expect((await call({ body: { text: "x".repeat(SOUL_GATE_MAX_TEXT_CHARS + 1) } })).status).toBe(400);
    expect((await call({ body: { text: "x", stage: "preflight" } })).status).toBe(400);
    expect((await call({ body: { text: "x", stage: "generation" } })).status).toBe(200);
  });
});

describe("GET /v3/soul/gate：抽检与误杀口径", () => {
  it("回统计、语料误杀口径与抽检行；limit 夹到上限，参数真的传到 store", async () => {
    const { store, calls } = makeStore();
    const out = await call({
      method: "GET",
      url: SOUL_GATE_PATH + "?team=t1&user=u1&agent=a1&limit=9999&shadowOnly=true&decision=deny&stage=output",
      store,
    });
    expect(out.status).toBe(200);
    const data = out.payload.data;
    const stats = data.stats as Record<string, unknown>;
    expect(stats.total).toBe(1);
    expect(stats.wouldBlockRate).toBe(1);
    const calibration = data.calibration as Record<string, unknown>;
    expect(calibration.falsePositiveRate).toBe(0);
    expect(calibration.missed).toBe(0);
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ id: "gate-output-abc", ruleId: "secret_leak", digest: "sha256:0123456789abcdef" });
    const readOpts = calls.gateLogReads[0] as Record<string, unknown>;
    expect(readOpts.limit).toBe(SOUL_GATE_ROWS_MAX);
    expect(readOpts.shadowOnly).toBe(true);
    expect(readOpts.decision).toBe("deny");
    expect(readOpts.stage).toBe("output");
  });

  it("store 缺读面 → 503（不是 500）；store 缺失同样 503", async () => {
    const out = await call({ method: "GET", store: { listSoulPrivateEventQuotes: async () => [] } });
    expect(out.status).toBe(503);
    expect(out.payload.code).toBe(503);
    const none = await call({ method: "GET", store: null });
    expect(none.status).toBe(503);
  });
});
