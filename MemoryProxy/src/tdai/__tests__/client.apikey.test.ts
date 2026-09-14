/**
 * P2-T13 鉴权必填配套：TdaiClient Bearer token 解析单测。
 *
 * 网关侧翻转"server.apiKey 缺失即生成临时密钥"后（拍板③，行为变更），
 * 跨进程调用方必须配置同一把 key，否则一律 401。本单测锁定 env
 * `TDAI_GATEWAY_APIKEY` 透传语义：
 *   1. env 设置 + yaml apiKey 为空 → 请求头带 `Bearer <env 值>`
 *   2. yaml apiKey 优先于 env（显式配置不被环境变量覆盖）
 *   3. 两者皆空 → 历史行为不变（"local-proxy"，本机无鉴权网关场景）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TdaiClient } from "../client.js";
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
});

describe("TdaiClient bearer token env 透传（TDAI_GATEWAY_APIKEY）", () => {
  it("env 设置 + config.apiKey 为空 → 请求头带 Bearer <env>", async () => {
    process.env.TDAI_GATEWAY_APIKEY = " env-secret-key ";
    const { headers } = stubFetchCapture();
    const client = new TdaiClient(makeConfig());
    await client.listCoreMemories(IDENTITY);
    expect(headers["Authorization"]).toBe("Bearer env-secret-key");
  });

  it("config.apiKey 显式配置 → 优先于 env", async () => {
    process.env.TDAI_GATEWAY_APIKEY = "env-secret-key";
    const { headers } = stubFetchCapture();
    const client = new TdaiClient(makeConfig({ apiKey: "yaml-secret-key" }));
    await client.listCoreMemories(IDENTITY);
    expect(headers["Authorization"]).toBe("Bearer yaml-secret-key");
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
