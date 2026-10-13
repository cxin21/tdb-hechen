/**
 * P2-T13 鉴权必填配套；I-2 统一化：TdaiClient bearerToken 委托
 * resolveBearerToken（tdai/bearer-token.ts），与 skill/knowledge/meta/
 * memory-bridge/asset-capability 出站调用同一语义。本单测锁定四级语义：
 *   1. env `TDAI_GATEWAY_APIKEY` 最高优先（trim 过）
 *   2. env 未设置 + bootstrap 注入 yaml `tdai.apiKey` → Bearer <yaml 值>
 *   3. env/注入皆未设置 + config.apiKey 显式值 → 原样透传（历史 serviceToken 层）
 *   4. 皆空 → 历史行为不变（"local-proxy"，本机无鉴权网关场景）
 *
 * 变更记录：I-2 前本 client 是 config-first（yaml 显式值覆盖 env）。占位符
 * `${VAR}` 未被部署物化展开时，config-first 会把字面占位符当真值发出
 * `Bearer ${...}` → 401，而 env 里明明有正确的 key —— 故统一为 env-first。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TdaiClient } from "../client.js";
import { resetTdaiGatewayApiKeyForTest, setTdaiGatewayApiKey } from "../bearer-token.js";
import type { TdaiIdentity, TdaiMemoryConfig } from "../types.js";

const IDENTITY: TdaiIdentity = {
  teamId: "team-verify",
  userId: "user-verify",
  agentId: "agent-verify",
  sessionId: "session-verify",
};

function makeConfig(overrides: Partial<TdaiMemoryConfig> = {}): TdaiMemoryConfig {
  return {
    enabled: true,
    endpoint: "http://127.0.0.1:8420",
    apiKey: "",
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

/** mock fetch：捕获请求头，返回空 slots/values 的合法 envelope。 */
function stubFetchCapture(): { headers: Record<string, string> } {
  const captured: Record<string, string> = {};
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    Object.assign(captured, init?.headers ?? {});
    return {
      ok: true,
      json: async () => ({ code: 0, data: { slots: [], values: [] } }),
    } as unknown as Response;
  }));
  return { headers: captured };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TDAI_GATEWAY_APIKEY;
  resetTdaiGatewayApiKeyForTest();
});

describe("TdaiClient bearer token 解析（I-2 统一为 resolveBearerToken）", () => {
  it("env 设置 → Bearer <env>（trim 过）；env 优先于 yaml 配置与 bootstrap 注入", async () => {
    process.env.TDAI_GATEWAY_APIKEY = " env-secret-key ";
    setTdaiGatewayApiKey("yaml-secret-key");
    const { headers } = stubFetchCapture();
    const client = new TdaiClient(makeConfig({ apiKey: "yaml-secret-key" }));
    await client.listCoreMemories(IDENTITY);
    expect(headers["Authorization"]).toBe("Bearer env-secret-key");
  });

  it("env 未设置 + bootstrap 注入 yaml tdai.apiKey → Bearer <yaml 值>", async () => {
    setTdaiGatewayApiKey("yaml-secret-key");
    const { headers } = stubFetchCapture();
    const client = new TdaiClient(makeConfig());
    await client.listCoreMemories(IDENTITY);
    expect(headers["Authorization"]).toBe("Bearer yaml-secret-key");
  });

  it("env/注入皆未设置 + config.apiKey 显式值 → 原样透传（历史 serviceToken 层）", async () => {
    const { headers } = stubFetchCapture();
    const client = new TdaiClient(makeConfig({ apiKey: "explicit-key" }));
    await client.listCoreMemories(IDENTITY);
    expect(headers["Authorization"]).toBe("Bearer explicit-key");
  });

  it("两者皆空 → 历史行为不变（Bearer local-proxy）", async () => {
    const { headers } = stubFetchCapture();
    const client = new TdaiClient(makeConfig());
    await client.listCoreMemories(IDENTITY);
    expect(headers["Authorization"]).toBe("Bearer local-proxy");
  });

  // P2-T12：core-memory 聚合读不再 hardcode default 三元组 —— 改传当前会话 identity
  // （T12-D 四元组；网关侧 core 已租户化，default 桶读不到其它租户的行）。
  it("core-memory 聚合读附当前会话 identity 三元组（P2-T12 租户化语义）", async () => {
    const { headers } = stubFetchCapture();
    const client = new TdaiClient(makeConfig({ apiKey: "k" }));
    await client.listCoreMemories(IDENTITY);
    expect(headers["x-tdai-team-id"]).toBe("team-verify");
    expect(headers["x-tdai-user-id"]).toBe("user-verify");
    expect(headers["x-tdai-agent-id"]).toBe("agent-verify");
  });
});
