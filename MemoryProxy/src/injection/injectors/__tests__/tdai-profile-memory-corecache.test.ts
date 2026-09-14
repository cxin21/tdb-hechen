/**
 * P2-T12（K-B4）：injector core 缓存按租户分桶单测。
 *
 * 背景：_coreValuesCache/_coreSlotsCache 原是模块级单例（无租户键）—— 双租户交替注入
 * 时 B 租户拿到 A 租户缓存的 core slots/values（跨租户身份泄漏）。修复：缓存键改为
 * JSON.stringify([teamId, userId, agentId, serviceId])（审查 I-1 修补：裸 `|` join 在
 * 三元组含 `|` 时可碰撞；serviceId 维度隔离 service 模式跨实例共享），值来源统一用
 * 注入时 identity（不 hardcode default）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppraisalValues, loadCoreMemorySlots, resetCoreTenantCachesForTest } from "../tdai-profile-memory-injector.js";
import { TdaiClient } from "../../../tdai/client.js";
import type { TdaiIdentity, TdaiMemoryConfig } from "../../../tdai/types.js";

const TENANT_A: TdaiIdentity = { teamId: "teamA", userId: "userA", agentId: "agentA", sessionId: "sA" };
const TENANT_B: TdaiIdentity = { teamId: "teamB", userId: "userB", agentId: "agentB", sessionId: "sB" };

function makeConfig(): TdaiMemoryConfig {
  return {
    enabled: true,
    endpoint: "http://127.0.0.1:8420",
    apiKey: "k",
    serviceId: "default",
    writeL0: false,
    recallL1: false,
    injectL2L3: false,
    l1Limit: 5,
    l2Limit: 5,
    timeoutMs: 1000,
  };
}

/** stub fetch：按请求头里的 team-id 返回不同租户的 slots/values。 */
function stubFetchPerTenant(payloads: Record<string, unknown>): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    calls++;
    const team = init?.headers?.["x-tdai-team-id"] ?? "";
    return {
      ok: true,
      json: async () => ({ code: 0, data: payloads[team] ?? { slots: [], values: [] } }),
    } as unknown as Response;
  }));
  return { calls: () => calls };
}

/** stub fetch：按请求头里的 service-id 返回不同 service 的 slots/values。 */
function stubFetchPerService(payloads: Record<string, unknown>): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    calls++;
    const svc = init?.headers?.["x-tdai-service-id"] ?? "";
    return {
      ok: true,
      json: async () => ({ code: 0, data: payloads[svc] ?? { slots: [], values: [] } }),
    } as unknown as Response;
  }));
  return { calls: () => calls };
}

beforeEach(() => {
  resetCoreTenantCachesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("injector core 缓存租户键（P2-T12 K-B4）", () => {
  it("双租户交替拉 slots → 各自缓存条目，互不串桶", async () => {
    const fetch = stubFetchPerTenant({
      teamA: { slots: [{ slot: "identity", content: "A 的身份", source: "api", version: 1, updated_at: "" }] },
      teamB: { slots: [{ slot: "identity", content: "B 的身份", source: "api", version: 1, updated_at: "" }] },
    });
    const client = new TdaiClient(makeConfig());

    const a1 = await loadCoreMemorySlots(client, TENANT_A);
    const b1 = await loadCoreMemorySlots(client, TENANT_B);
    const a2 = await loadCoreMemorySlots(client, TENANT_A);
    const b2 = await loadCoreMemorySlots(client, TENANT_B);

    expect(a1.map((s) => s.content)).toEqual(["A 的身份"]);
    expect(b1.map((s) => s.content)).toEqual(["B 的身份"]);
    expect(a2.map((s) => s.content)).toEqual(["A 的身份"]);
    expect(b2.map((s) => s.content)).toEqual(["B 的身份"]);
    // 4 次调用 = 每租户首次各 1 次 + （TTL 内）无重复：共 2 次（两桶各命中缓存一次）
    expect(fetch.calls()).toBe(2);
  });

  it("双租户交替拉 values → 各自缓存条目", async () => {
    const fetch = stubFetchPerTenant({
      teamA: { values: [{ value_id: "honesty", label: "A 诚实", weight: 0.9, created_by: "x" }] },
      teamB: { values: [{ value_id: "honesty", label: "B 诚实", weight: 0.7, created_by: "x" }] },
    });
    const client = new TdaiClient(makeConfig());

    const a1 = await loadAppraisalValues(client, TENANT_A);
    const b1 = await loadAppraisalValues(client, TENANT_B);
    const a2 = await loadAppraisalValues(client, TENANT_A, undefined);

    expect(a1.map((v) => v.label)).toEqual(["A 诚实"]);
    expect(b1.map((v) => v.label)).toEqual(["B 诚实"]);
    expect(a2.map((v) => v.label)).toEqual(["A 诚实"]);
    expect(fetch.calls()).toBe(2);
  });

  it("空响应不写缓存 → 下一租户不继承上一租户的空态语义（fallback 仍生效）", async () => {
    const stub = stubFetchPerTenant({});
    const client = new TdaiClient(makeConfig());
    const fallback = [{ id: "cfg-value", label: "来自配置", weight: 0.5 }];

    const a1 = await loadAppraisalValues(client, TENANT_A, { values: fallback });
    // A 空 → fallback；B 空 → fallback（各自独立，不因 A 的结果短路）
    expect(a1.map((v) => v.label)).toEqual(["来自配置"]);
    const b1 = await loadAppraisalValues(client, TENANT_B, { values: fallback });
    expect(b1.map((v) => v.label)).toEqual(["来自配置"]);
    expect(stub.calls()).toBe(2);
  });
});

describe("缓存键分隔符碰撞防护（审查 I-1）", () => {
  it("含 | 的 teamId 与拼接等价三元组不碰撞 → 各自条目独立", async () => {
    // 裸 `|` join 下两组键同为 "a|b|c|d" → 跨租户缓存命中。JSON 序列化后必然不同键。
    const TENANT_PIPE: TdaiIdentity = { teamId: "a", userId: "b|c", agentId: "d", sessionId: "s1" };
    const TENANT_EQUIV: TdaiIdentity = { teamId: "a|b", userId: "c", agentId: "d", sessionId: "s2" };
    const stub = stubFetchPerTenant({
      a: { slots: [{ slot: "identity", content: "pipe 组的内容", source: "api", version: 1, updated_at: "" }] },
      "a|b": { slots: [{ slot: "identity", content: "equiv 组的内容", source: "api", version: 1, updated_at: "" }] },
    });
    const client = new TdaiClient(makeConfig());

    const p1 = await loadCoreMemorySlots(client, TENANT_PIPE);
    const e1 = await loadCoreMemorySlots(client, TENANT_EQUIV);
    const p2 = await loadCoreMemorySlots(client, TENANT_PIPE);
    const e2 = await loadCoreMemorySlots(client, TENANT_EQUIV);

    expect(p1.map((s) => s.content)).toEqual(["pipe 组的内容"]);
    expect(e1.map((s) => s.content)).toEqual(["equiv 组的内容"]);
    // TTL 内重复拉取 → 命中各自条目（若碰撞，后写会覆盖先写，两组拿到同一内容）
    expect(p2.map((s) => s.content)).toEqual(["pipe 组的内容"]);
    expect(e2.map((s) => s.content)).toEqual(["equiv 组的内容"]);
    expect(stub.calls()).toBe(2);
  });

  it("同 identity 不同 serviceId → 缓存不跨 service 实例共享", async () => {
    const stub = stubFetchPerService({
      svcX: { slots: [{ slot: "identity", content: "X 的身份", source: "api", version: 1, updated_at: "" }] },
      svcY: { slots: [{ slot: "identity", content: "Y 的身份", source: "api", version: 1, updated_at: "" }] },
    });
    const cfgX = { ...makeConfig(), serviceId: "svcX" };
    const cfgY = { ...makeConfig(), serviceId: "svcY" };
    const clientX = new TdaiClient(cfgX);
    const clientY = new TdaiClient(cfgY);

    const x1 = await loadCoreMemorySlots(clientX, TENANT_A);
    const y1 = await loadCoreMemorySlots(clientY, TENANT_A);
    const x2 = await loadCoreMemorySlots(clientX, TENANT_A);
    const y2 = await loadCoreMemorySlots(clientY, TENANT_A);

    expect(x1.map((s) => s.content)).toEqual(["X 的身份"]);
    expect(y1.map((s) => s.content)).toEqual(["Y 的身份"]);
    expect(x2.map((s) => s.content)).toEqual(["X 的身份"]);
    expect(y2.map((s) => s.content)).toEqual(["Y 的身份"]);
    expect(stub.calls()).toBe(2);
  });
});
