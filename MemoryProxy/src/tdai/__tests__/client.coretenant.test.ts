/**
 * P2-T12（T12-D）：TdaiClient core-memory 聚合读按租户传三元组。
 *
 * 背景：core_memory/core_values 在 MemoryCore 侧租户化后（K1），聚合读若仍 hardcode
 * default 三元组，只会读到 default 桶的回填行 —— 每租户注入都拿同一份身份小本本
 * （K-B4 跨租户缓存污染的请求侧根因）。client 必须把当前会话 identity 透传成
 * x-tdai-{team,user,agent}-id 头。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TdaiClient } from "../client.js";
import type { TdaiIdentity, TdaiMemoryConfig } from "../types.js";

function makeConfig(overrides: Partial<TdaiMemoryConfig> = {}): TdaiMemoryConfig {
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
    ...overrides,
  };
}

const TENANT_X: TdaiIdentity = { teamId: "teamX", userId: "userX", agentId: "agentX", sessionId: "sX" };

function stubFetchCapture(): { headers: Record<string, string>; bodies: string[] } {
  const captured: Record<string, string> = {};
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    Object.assign(captured, init?.headers ?? {});
    return {
      ok: true,
      json: async () => ({ code: 0, data: { slots: [], values: [] } }),
    } as unknown as Response;
  }));
  return { headers: captured, bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TdaiClient core-memory 聚合读 identity 三元组透传（P2-T12）", () => {
  it("listCoreMemories(identity) → 请求头带 identity 三元组", async () => {
    const { headers } = stubFetchCapture();
    const client = new TdaiClient(makeConfig());
    await client.listCoreMemories(TENANT_X);
    expect(headers["x-tdai-team-id"]).toBe("teamX");
    expect(headers["x-tdai-user-id"]).toBe("userX");
    expect(headers["x-tdai-agent-id"]).toBe("agentX");
  });

  it("listCoreValues(identity) → 请求头带 identity 三元组", async () => {
    const { headers } = stubFetchCapture();
    const client = new TdaiClient(makeConfig());
    await client.listCoreValues(TENANT_X);
    expect(headers["x-tdai-team-id"]).toBe("teamX");
    expect(headers["x-tdai-user-id"]).toBe("userX");
    expect(headers["x-tdai-agent-id"]).toBe("agentX");
  });
});
