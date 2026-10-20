/**
 * DS-RECALL-MERGE-001（合并召回 · 代理瘦传输）· TdaiClient.recallBlockForCtx 契约单测。
 *
 * 契约（spec §4.2）：
 *   - 返回 { block, meta } = /v3/recall 成功（block 为核心组装好的注入块，代理直接前插）；
 *   - 返回 null = recallL1 关闭 / client 未启用（调用方零注入，**不降级**——开关语义不变：
 *     recallL1 控制合并后的唯一代理注入链）；
 *   - 抛错 = 端点不可用（404/5xx/超时/网络/envelope code≠0）——调用方必须降级旧路 +
 *     loud 日志（防静默降级老纪律；与 postForCtx 的"吞错返空"语义相反，同 checkAcl 的
 *     fail-loud 家族，故不复用 postForCtx）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TdaiClient } from "../client.js";
import type { TdaiAgentCtx, TdaiMemoryConfig } from "../types.js";

const CTX: TdaiAgentCtx = {
  teamId: "team-merge",
  userId: "user-merge",
  agentId: "agent-merge",
};

function makeConfig(overrides: Partial<TdaiMemoryConfig> = {}): TdaiMemoryConfig {
  return {
    enabled: true,
    endpoint: "http://127.0.0.1:8420",
    apiKey: "k",
    serviceId: "default",
    writeL0: false,
    recallL1: true,
    injectL2L3: false,
    l1Limit: 5,
    l2Limit: 5,
    timeoutMs: 1000,
    ...overrides,
  };
}

const OK_ENVELOPE = {
  code: 0,
  data: {
    block: "<relevant-memories>\n- [结论|合并召回] 核心组装块\n</relevant-memories>",
    meta: { conclusionCount: 1, experienceCount: 0, sessionReused: false, layered: true },
  },
};

describe("TdaiClient.recallBlockForCtx（DS-RECALL-MERGE-001 瘦传输）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("成功 → 返回 { block, meta }（block/meta 原样透传，代理零渲染）", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => OK_ENVELOPE,
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const client = new TdaiClient(makeConfig());
    const res = await client.recallBlockForCtx(CTX, "合并召回进展", "session-m1", undefined, 5);
    expect(res).not.toBeNull();
    expect(res!.block).toBe(OK_ENVELOPE.data.block);
    expect(res!.meta).toEqual(OK_ENVELOPE.data.meta);
    // 端点路径与隔离头族先例形态（POST /v3/recall + 三元组 + session 头）
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8420/v3/recall");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-tdai-team-id"]).toBe("team-merge");
    expect(headers["x-tdai-agent-id"]).toBe("agent-merge");
    expect(headers["x-tdai-session-id"]).toBe("session-m1");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.query).toBe("合并召回进展");
    expect(body.maxResults).toBe(5);
    // #74：time_point 透传（ISO 可解析；核心据此旁路会话复用缓存+时窗锚定，T4 病灶②接线）
    expect(typeof body.time_point).toBe("string");
    expect(Number.isNaN(Date.parse(String(body.time_point)))).toBe(false);
    // 审查 m5（2026-10-20）：time_point 逐请求新鲜——两次调用单调不减，钉死非冻结常量
    const res2 = await client.recallBlockForCtx(CTX, "合并召回进展", "session-m1", undefined, 5);
    expect(res2).not.toBeNull();
    const [, init2] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const body2 = JSON.parse(String(init2.body)) as Record<string, unknown>;
    expect(Date.parse(String(body2.time_point))).toBeGreaterThanOrEqual(Date.parse(String(body.time_point)));
  });

  it("HTTP 5xx → 抛错（调用方降级旧路）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response));
    const client = new TdaiClient(makeConfig());
    await expect(client.recallBlockForCtx(CTX, "q", "s")).rejects.toThrow(/500/);
  });

  it("HTTP 404（enabled=false 关断档）→ 抛错（调用方降级旧路 = 逐位现状）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
    const client = new TdaiClient(makeConfig());
    await expect(client.recallBlockForCtx(CTX, "q", "s")).rejects.toThrow(/404/);
  });

  it("envelope code≠0 → 抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 40001, message: "bad request" }),
    }) as unknown as Response));
    const client = new TdaiClient(makeConfig());
    await expect(client.recallBlockForCtx(CTX, "q", "s")).rejects.toThrow(/40001/);
  });

  it("网络异常（fetch reject）→ 抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }));
    const client = new TdaiClient(makeConfig());
    await expect(client.recallBlockForCtx(CTX, "q", "s")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("超时（stub fetch 抛 AbortError）→ 映射为 'timeout after' 抛错（调用方降级旧路）", async () => {
    // 直测 AbortError→映射分支：若缺此分支，原始 AbortError 将以 "This operation was
    // aborted" 原样抛出，匹配 /timeout after/ 必失败——断言钉死映射行为。
    vi.stubGlobal("fetch", vi.fn(async () => {
      const abortErr = new Error("This operation was aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }));
    const client = new TdaiClient(makeConfig({ timeoutMs: 1234 }));
    await expect(client.recallBlockForCtx(CTX, "q", "s"))
      .rejects.toThrow(/\/v3\/recall timeout after 1234ms/);
  });

  it("recallL1=false → null 且零网络调用（开关语义不变：控制合并后的唯一注入链）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new TdaiClient(makeConfig({ recallL1: false }));
    const res = await client.recallBlockForCtx(CTX, "q", "s");
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("client 未启用（enabled=false）→ null 且零网络调用", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new TdaiClient(makeConfig({ enabled: false }));
    const res = await client.recallBlockForCtx(CTX, "q", "s");
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ═══════════════ #40（ADR0003-P3 接线票 B）· capabilities 请求体线程 ═══════════════

describe("#40 · recallBlockForCtx capabilities 请求体", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("传入 capabilities → 请求体携带策展清单", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => OK_ENVELOPE,
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const client = new TdaiClient(makeConfig());
    await client.recallBlockForCtx(CTX, "q", "s", undefined, 5, ["t1：能力一"]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ query: "q", maxResults: 5, capabilities: ["t1：能力一"], time_point: expect.any(String) });
  });

  it("未传/空数组 → 请求体不含 capabilities 键（逐位现状）", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => OK_ENVELOPE,
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const client = new TdaiClient(makeConfig());
    await client.recallBlockForCtx(CTX, "q", "s", undefined, 5, []);
    await client.recallBlockForCtx(CTX, "q", "s", undefined, 5);
    const bodies = fetchMock.mock.calls.map((c) =>
      JSON.parse(String((c as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies[0]).toEqual({ query: "q", maxResults: 5, time_point: expect.any(String) });
    expect(bodies[1]).toEqual({ query: "q", maxResults: 5, time_point: expect.any(String) });
  });
});
