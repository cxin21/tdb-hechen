import { describe, it, expect } from "vitest";
import { enforceModelGate, gateForSystemUser } from "../pricing.js";

const pricing = {
  models: [
    { name: "ep-1", modelName: "ark-code-latest", input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  ],
} as any;

describe("enforceModelGate (spec §8)", () => {
  it("成员上游命中 → 无条件放行（即使 model 未登记）", () => {
    expect(enforceModelGate(pricing, { url: "https://x", apiKey: "k", model: "anything" }, "unknown-model")).toBeNull();
  });
  it("无成员上游 + 未登记 model → 返回 400 消息（原文）", () => {
    const msg = enforceModelGate(pricing, null, "nope");
    expect(msg).toBe("Model 'nope' is not a registered display name in the credit pricing table");
  });
  it("无成员上游 + 已登记 modelName → 放行", () => {
    expect(enforceModelGate(pricing, null, "ark-code-latest")).toBeNull();
  });
  it("价目表未配置 → 放行（向后兼容）", () => {
    expect(enforceModelGate(null, null, "anything")).toBeNull();
  });
});

// ── system-user 短路路径门禁（fix round，spec §8 不变式）──
// 迁移前入口门禁在 system-user 短路之前执行（旧注释契约：
// "internal callers must also request by modelName"）。门禁迁转发缝后，
// 短路路径绕过了门禁 —— gateForSystemUser 是该路径的等价门禁：
// 内部服务账号不走成员覆盖（memberUpstream 恒 null）。
describe("gateForSystemUser (spec §8 不变式：短路路径门禁)", () => {
  it("内部服务账号（恒无成员覆盖）+ 未登记 model → 返回 400 消息（原文）", () => {
    const msg = gateForSystemUser(pricing, "nope");
    expect(msg).toBe("Model 'nope' is not a registered display name in the credit pricing table");
  });
  it("已登记 modelName → 放行", () => {
    expect(gateForSystemUser(pricing, "ark-code-latest")).toBeNull();
  });
  it("价目表未配置 → 放行（向后兼容，与迁移前入口门禁一致）", () => {
    expect(gateForSystemUser(null, "anything")).toBeNull();
  });
  it("与 enforceModelGate(config, null, requested) 逐字等价（第二参恒 null）", () => {
    expect(gateForSystemUser(pricing, "unknown-model")).toBe(
      enforceModelGate(pricing, null, "unknown-model"),
    );
  });
});
