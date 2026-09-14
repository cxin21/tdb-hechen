/**
 * /v3/admin/credit-pricing 运行时管理测试（spec §9）。
 *
 * 结构对齐 routes/__tests__/llm-providers.test.ts 的成熟手法：真实 Hono app +
 * app.request(...)，而不是裸 fake Context —— handler 依赖 c.req.json() / c.json()。
 * ProxyStorage 单例每个用例前重置，backend 固定 memory（单测不落盘）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createCreditPricingHandlers,
  applyStoredCreditPricing,
  __resetCreditPricingBaseForTests,
} from "../routes/credit-pricing.js";
import { __resetProxyStorageForTests } from "../storage/factory.js";
import type { ProxyConfig, CreditPricingEntry } from "../types.js";

const entry: CreditPricingEntry = {
  name: "ep-1",
  modelName: "m-1",
  input: 1,
  output: 2,
  cacheRead: 0.1,
  cacheWrite5m: 0.2,
  cacheWrite1h: 0.3,
};

function makeConfig(models: CreditPricingEntry[] = [entry]): ProxyConfig {
  return {
    creditPricing: { models },
    storage: { enabled: true, backend: "memory" },
  } as unknown as ProxyConfig;
}

function buildApp(config: ProxyConfig) {
  const app = new Hono();
  const handlers = createCreditPricingHandlers(config);
  app.get("/v3/admin/credit-pricing", handlers.get);
  app.put("/v3/admin/credit-pricing", handlers.put);
  app.delete("/v3/admin/credit-pricing", handlers.delete);
  return app;
}

const URL = "/v3/admin/credit-pricing";

describe("credit-pricing admin (spec §9)", () => {
  beforeEach(() => {
    __resetProxyStorageForTests();
    __resetCreditPricingBaseForTests(); // 模块级 yaml 底表用例间隔离
  });

  it("GET 返回 yaml 底表 + source:yaml", async () => {
    const app = buildApp(makeConfig());
    const res = await app.request(URL);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.source).toBe("yaml");
    expect(body.data.models).toHaveLength(1);
  });

  it("PUT 校验失败 400（modelName 重复 / 负价格 / 非法字段）", async () => {
    const app = buildApp(makeConfig());
    for (const bad of [
      { models: [{ ...entry, modelName: "a" }, { ...entry, name: "ep-2", modelName: "a" }] },
      { models: [{ ...entry, input: -1 }] },
      { models: "nope" },
    ]) {
      const res = await app.request(URL, {
        method: "PUT",
        body: JSON.stringify(bad),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
    }
  });

  it("PUT 合法整表 → 热替换 config.creditPricing + 持久化", async () => {
    const config = makeConfig();
    const app = buildApp(config);
    const next = { models: [{ ...entry, modelName: "m-2", name: "ep-9" }] };
    const res = await app.request(URL, {
      method: "PUT",
      body: JSON.stringify(next),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.source).toBe("override");
    expect(config.creditPricing.models[0].modelName).toBe("m-2"); // 热生效
    // GET 现在应反映 override
    const after = await app.request(URL);
    const afterBody: any = await after.json();
    expect(afterBody.data.source).toBe("override");
  });

  it("DELETE 恢复 yaml 底表", async () => {
    const config = makeConfig();
    const app = buildApp(config);
    await app.request(URL, {
      method: "PUT",
      body: JSON.stringify({ models: [{ ...entry, modelName: "m-2", name: "ep-9" }] }),
      headers: { "content-type": "application/json" },
    });
    const res = await app.request(URL, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(config.creditPricing.models[0].modelName).toBe("m-1");
    const after = await app.request(URL);
    const afterBody: any = await after.json();
    expect(afterBody.data.source).toBe("yaml");
  });

  it("applyStoredCreditPricing：有存储 override 时启动应用", async () => {
    const config = makeConfig();
    // 用 memory backend 写一次 override 再 apply（经 CREDIT_PRICING_STORAGE_KEY）
    const app = buildApp(config);
    await app.request(URL, {
      method: "PUT",
      body: JSON.stringify({ models: [{ ...entry, modelName: "stored", name: "ep-s" }] }),
      headers: { "content-type": "application/json" },
    });
    const config2 = makeConfig(); // 模拟重启后的新 config
    await applyStoredCreditPricing(config2);
    expect(config2.creditPricing.models[0].modelName).toBe("stored");
  });

  it("启动链路存在 override 时 DELETE 恢复真实 yaml 底表（review finding 回归）", async () => {
    const yamlA: CreditPricingEntry[] = [{ ...entry, modelName: "yaml-a", name: "ep-yaml" }];
    // 先写入 override B 到存储（模拟上一次运行的持久化 override）
    const writer = buildApp(makeConfig());
    await writer.request(URL, {
      method: "PUT",
      body: JSON.stringify({ models: [{ ...entry, modelName: "override-b", name: "ep-ovr" }] }),
      headers: { "content-type": "application/json" },
    });
    // 复刻 index.ts 启动顺序：先 applyStoredCreditPricing 热替换 config，后 createCreditPricingHandlers
    const restarted = makeConfig(yamlA);
    await applyStoredCreditPricing(restarted);
    const app = buildApp(restarted);

    // GET：override 生效
    const before = await app.request(URL);
    const beforeBody: any = await before.json();
    expect(beforeBody.data.source).toBe("override");
    expect(beforeBody.data.models[0].modelName).toBe("override-b");

    // DELETE：必须恢复 yaml 底表 A，而非把 override 冒充 yaml
    const res = await app.request(URL, { method: "DELETE" });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.source).toBe("yaml");
    expect(body.data.models[0].modelName).toBe("yaml-a");
    // 共享 config 热替换同样回到 yaml 底表
    expect(restarted.creditPricing.models[0].modelName).toBe("yaml-a");
  });
});
