/**
 * I-2 统一化配套：fetchAssetCapabilities 的 Bearer token 解析单测。
 *
 * 此前直接 `Bearer ${input.apiKey}`（裸 config 值）—— env `TDAI_GATEWAY_APIKEY`
 * 不在透传范围内，部署侧只配 env 时 asset-capability 探针一律 401（非致命：
 * 失败回落 DEFAULT 全 true，但 err.log 刷屏且拿不到真实能力开关）。
 * 统一后与 skill/knowledge/meta/memory-bridge 同语义：
 *   1. env `TDAI_GATEWAY_APIKEY`（trim 过）→ 2. bootstrap 注入 `tdai.apiKey`
 *   → 3. 传入的 apiKey 原样透传。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAssetCapabilities } from "../capabilities.js";
import { resetTdaiGatewayApiKeyForTest, setTdaiGatewayApiKey } from "../bearer-token.js";

/** mock fetch：捕获请求头，返回空 items 的合法 envelope。 */
function stubFetchCapture(): { headers: Record<string, string> } {
  const captured: Record<string, string> = {};
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    Object.assign(captured, init?.headers ?? {});
    return {
      ok: true,
      json: async () => ({ code: 0, data: { items: [] } }),
    } as unknown as Response;
  }));
  return { headers: captured };
}

const BASE_INPUT = {
  endpoint: "http://127.0.0.1:8420",
  apiKey: "",
  serviceId: "default",
  userId: "usr-verify",
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TDAI_GATEWAY_APIKEY;
  resetTdaiGatewayApiKeyForTest();
});

describe("fetchAssetCapabilities Bearer token（I-2 统一为 resolveBearerToken）", () => {
  it("env 设置 + apiKey 为空 → Bearer <env>（trim 过）", async () => {
    process.env.TDAI_GATEWAY_APIKEY = " env-secret-key ";
    const { headers } = stubFetchCapture();
    await fetchAssetCapabilities({ ...BASE_INPUT });
    expect(headers["Authorization"]).toBe("Bearer env-secret-key");
  });

  it("env 未设置 + bootstrap 注入 tdai.apiKey → Bearer <yaml 值>", async () => {
    setTdaiGatewayApiKey("yaml-secret-key");
    const { headers } = stubFetchCapture();
    await fetchAssetCapabilities({ ...BASE_INPUT });
    expect(headers["Authorization"]).toBe("Bearer yaml-secret-key");
  });

  it("env/注入皆未设置 + apiKey 显式值 → 原样透传", async () => {
    const { headers } = stubFetchCapture();
    await fetchAssetCapabilities({ ...BASE_INPUT, apiKey: "explicit-key" });
    expect(headers["Authorization"]).toBe("Bearer explicit-key");
  });

  it("serviceIdOverride 优先于 serviceId（回归护栏，I-2 不改变该行为）", async () => {
    const { headers } = stubFetchCapture();
    await fetchAssetCapabilities({
      ...BASE_INPUT,
      apiKey: "k",
      serviceId: "default",
      serviceIdOverride: "space-42",
    });
    expect(headers["x-tdai-service-id"]).toBe("space-42");
  });
});
