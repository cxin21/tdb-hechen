/**
 * #67（R3 身份叙事层，2026-10-19）：proxy 侧 API/透传消费合同测试。
 *
 * 设计硬约束（issue #67）：叙事组装单一源在 MemoryCore（renderIdentityNarrative），proxy
 * 经 /v3/core-memory/read format=narrative 透传消费叙事文本，**不复制组装逻辑**（禁双份
 * 实现；soul-dedupe/redline-render 的镜像 parity 合同不适用——#67 不新增镜像文件）。
 * 本文件钉三件事：
 * 1. 请求契约：loadCoreMemorySlots 以 {format:"narrative"} 调 /v3/core-memory/read；
 * 2. 兼容契约：服务端门关=格式被忽略=旧响应形态（身份条目槽原样）——双向兼容；
 * 3. 透传契约：identity_narrative 合成槽（渲染侧派生，Park 2411.10109 条目存储+叙事渲染
 *    并存）原样通过 loadCoreMemorySlots（下游既有 <slot> 通用循环渲染，零叙事特判）。
 * 无 LLM：全部走 stub fetch。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCoreMemorySlots, resetCoreTenantCachesForTest } from "../tdai-profile-memory-injector.js";
import { TdaiClient } from "../../../tdai/client.js";
import type { TdaiIdentity, TdaiMemoryConfig } from "../../../tdai/types.js";

const TENANT: TdaiIdentity = { teamId: "teamA", userId: "userA", agentId: "agentA", sessionId: "sA" };

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

const NARR = [
  "以下事实由你和团队共同写就：",
  "- 我是谁：我是测试者。",
  "- 我心中的他：用户是系统维护者。",
  "这些由你和团队共同确认，请把它们当作当下相处的事实。",
].join("\n");

/** stub fetch：记录请求 body，返回指定 payload。 */
function stubFetchCapture(payload: unknown): { bodies: () => string[] } {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return {
      ok: true,
      json: async () => ({ code: 0, data: payload }),
    } as unknown as Response;
  }));
  return { bodies: () => bodies };
}

beforeEach(() => {
  resetCoreTenantCachesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#67 proxy 叙事透传合同（API 消费，零组装逻辑复刻）", () => {
  it("请求契约：loadCoreMemorySlots 以 {format:\"narrative\"} 请求 /v3/core-memory/read", async () => {
    const cap = stubFetchCapture({ slots: [{ slot: "identity_narrative", content: NARR, source: "narrative", version: 3, updated_at: "" }] });
    const client = new TdaiClient(makeConfig());
    await loadCoreMemorySlots(client, TENANT);
    expect(cap.bodies().length).toBeGreaterThan(0);
    expect(cap.bodies()[0]).toBe(JSON.stringify({ format: "narrative" }));
  });

  it("透传契约：identity_narrative 合成槽原样返回（content 逐字，source=narrative 可审计）", async () => {
    stubFetchCapture({
      slots: [
        { slot: "identity_narrative", content: NARR, source: "narrative", version: 3, updated_at: "2026-10-19T00:00:00Z" },
        { slot: "strict_rule", content: "绝不可删除记忆。", source: "seed", version: 1, updated_at: "" },
      ],
    });
    const client = new TdaiClient(makeConfig());
    const slots = await loadCoreMemorySlots(client, TENANT);
    const narr = slots.find((s) => s.slot === "identity_narrative");
    expect(narr).toBeTruthy();
    expect(narr?.content).toBe(NARR); // 叙事文本逐字（MemoryCore 单一源产出，proxy 不改写）
    expect(narr?.source).toBe("narrative");
    expect(slots.some((s) => s.slot === "strict_rule")).toBe(true);
  });

  it("兼容契约：服务端门关=格式被忽略=旧响应形态（身份条目槽原样，无叙事槽）", async () => {
    stubFetchCapture({
      slots: [
        { slot: "self_identity", content: "我是测试者。", source: "seed", version: 2, updated_at: "" },
        { slot: "identity", content: "用户是系统维护者。", source: "seed", version: 1, updated_at: "" },
      ],
    });
    const client = new TdaiClient(makeConfig());
    const slots = await loadCoreMemorySlots(client, TENANT);
    expect(slots.map((s) => s.slot)).toEqual(["self_identity", "identity"]);
    expect(slots.find((s) => s.slot === "self_identity")?.content).toBe("我是测试者。");
  });

  it("客户端缺省：listCoreMemories 不带 opts 时 body 仍为 {}（旧契约逐字节不变）", async () => {
    const cap = stubFetchCapture({ slots: [] });
    const client = new TdaiClient(makeConfig());
    await client.listCoreMemories(TENANT);
    expect(cap.bodies()[0]).toBe("{}");
  });
});
