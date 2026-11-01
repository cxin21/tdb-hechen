/**
 * LLM binding 退役守卫 —— DSH 特化 Wave 3。
 *
 * 背景：接入方只剩 DSH 插件，MemoryProxy 已整包删除。llm_binding 的 mode 收窄为字面量
 * 'custom'（该 instance 直连一个 OpenAI 兼容端点）；'proxy'（旧 context_proxy 记账通道）
 * 与 'byo'（custom 的历史别名）在**写面**一律 400 拒绝。
 *
 * 老数据处理取向 = fail-loud，本文件把它钉死：
 *   ① 写 mode='proxy' / mode='byo' / 带 proxy_base_url → 400，且一行都不落库；
 *   ② 读库里遗留 mode='proxy' 行 → status/list 标 migration_required:true（看得见），
 *      resolveLlmConfig **抛 LlmBindingRetiredError**（不带迁移提示就不算拒绝），
 *      绝不静默按 custom 走；
 *   ③ 遗留 mode='byo' 行 → 语义等同 custom，读取归一、解析照常（无需数据迁移）；
 *   ④ 迁移动作可验证：遗留行按提示 POST /set mode='custom' 后，migration_required 消失。
 *   ⑤ 环境变量 LLM_MODE=proxy 也 fail-loud（loadConfig 直接抛错）。
 */

import { describe, it, expect, afterEach } from "vitest";
import type { Database } from "better-sqlite3";

import { createDb } from "../src/db/client.js";
import {
  createLlmBindingStore,
  resolveLlmConfig,
  LlmBindingRetiredError,
  LLM_BINDING_PROXY_RETIRED_HINT,
} from "../src/store/llm-binding-store.js";
import { createLlmBindingRoutes } from "../src/routes/llm-binding.js";
import { loadConfig, type LlmConfig } from "../src/config.js";

const GLOBAL_LLM: LlmConfig = {
  mode: "custom",
  protocol: "openai",
  provider: "custom",
  apiKey: "sk-global-0001",
  model: "Memory-Model",
  baseUrl: "https://global.example/v1",
  maxTokens: 1024,
  timeoutMs: 1000,
  stream: false,
};

const dbs: Database[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  delete process.env.LLM_MODE;
});

function makeDb(): { db: ReturnType<typeof createDb>["db"]; raw: Database } {
  const inst = createDb({ path: ":memory:" });
  dbs.push(inst.raw);
  return inst;
}

function makeRoutes() {
  const inst = makeDb();
  const store = createLlmBindingStore(inst.db);
  const app = createLlmBindingRoutes({ llmBindingStore: store });
  return { ...inst, store, app };
}

function postJson(
  app: { request: (p: string, init?: RequestInit) => Response | Promise<Response> },
  path: string,
  body: Record<string, unknown>,
  serviceId = "svc-001",
) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-service-id": serviceId },
    body: JSON.stringify(body),
  });
}

/** 直接写库模拟「迁移前的老数据」（生产库里已存在的行就是这个形态）。 */
function seedLegacyRow(
  raw: Database,
  row: { serviceId: string; mode: string; baseUrl?: string | null; apiKey?: string | null; proxyBaseUrl?: string | null },
) {
  raw
    .prepare(
      `INSERT INTO llm_binding (service_id, mode, base_url, api_key, enabled, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .run(row.serviceId, row.mode, row.baseUrl ?? null, row.apiKey ?? null, new Date().toISOString());
  // 老库可能有 proxy_base_url 列；新库（本用例）没有 → 条件补写，测完即删。
  const cols = raw.prepare("PRAGMA table_info(llm_binding)").all() as Array<{ name: string }>;
  if (row.proxyBaseUrl && cols.some((c) => c.name === "proxy_base_url")) {
    raw
      .prepare("UPDATE llm_binding SET proxy_base_url = ? WHERE service_id = ?")
      .run(row.proxyBaseUrl, row.serviceId);
  }
}

describe("写面：mode 收窄为 'custom'（proxy/byo 退役）", () => {
  it("mode='proxy' 被拒：400 + 消息点明 retired 与 custom，且不落库", async () => {
    const { app, store } = makeRoutes();
    const res = await postJson(app, "/set", {
      mode: "proxy",
      proxy_base_url: "http://127.0.0.1:8096",
      api_key: "sk-legacy",
    });
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.code).toBe(400);
    expect(json.message).toContain("retired");
    expect(json.message).toContain("custom");
    expect(store.get("svc-001")).toBeNull();
  });

  it("mode='byo' 也被拒（它是 custom 的历史别名，写面只认字面量 custom）", async () => {
    const { app, store } = makeRoutes();
    const res = await postJson(app, "/set", {
      mode: "byo",
      base_url: "https://byo.example/v1",
      api_key: "sk-byo",
    });
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.message).toContain("retired");
    expect(store.get("svc-001")).toBeNull();
  });

  it("带了 proxy_base_url 即视为未迁移完：400 + 退役提示，且不落库", async () => {
    const { app, store } = makeRoutes();
    const res = await postJson(app, "/set", {
      mode: "custom",
      base_url: "https://ok.example/v1",
      api_key: "sk-ok",
      proxy_base_url: "http://127.0.0.1:8096",
    });
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.message).toContain("proxy_base_url");
    expect(json.message).toContain("retired");
    expect(store.get("svc-001")).toBeNull();
  });

  it("mode='custom' + base_url + api_key 正常写入，响应不回显 api_key", async () => {
    const { app, store } = makeRoutes();
    const res = await postJson(app, "/set", {
      mode: "custom",
      base_url: "https://my-llm.example/v1",
      api_key: "sk-my-key",
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.data.mode).toBe("custom");
    expect(json.data.api_key).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("sk-my-key");

    const row = store.get("svc-001")!;
    expect(row.mode).toBe("custom");
    expect(row.base_url).toBe("https://my-llm.example/v1");
    expect(row.api_key).toBe("sk-my-key");
    expect(row.migration_required).toBe(false);
  });

  it("custom 缺 base_url → 400；首次 set 缺 api_key → 400；二次 set 不带 api_key 保留原值", async () => {
    const { app, store } = makeRoutes();

    const noBase = await postJson(app, "/set", { mode: "custom", api_key: "sk-a" });
    expect(noBase.status).toBe(400);
    expect(((await noBase.json()) as any).message).toContain("base_url");

    const noKey = await postJson(app, "/set", { mode: "custom", base_url: "https://a.example/v1" });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as any).message).toContain("api_key");

    await postJson(app, "/set", { mode: "custom", base_url: "https://a.example/v1", api_key: "sk-keep" });
    const again = await postJson(app, "/set", { mode: "custom", base_url: "https://b.example/v1" });
    expect(again.status).toBe(200);
    const row = store.get("svc-001")!;
    expect(row.api_key).toBe("sk-keep");
    expect(row.base_url).toBe("https://b.example/v1");
  });
});

describe("读面：遗留 proxy 绑定 fail-loud（不静默当 custom）", () => {
  it("status/list 标记 migration_required，且 list 不再返回 proxy_base_url", async () => {
    const { app, raw } = makeRoutes();
    seedLegacyRow(raw, { serviceId: "svc-legacy", mode: "proxy", proxyBaseUrl: null, apiKey: "sk-x" });

    const statusRes = await postJson(app, "/status", {}, "svc-legacy");
    const status: any = await statusRes.json();
    expect(status.data.bound).toBe(true);
    expect(status.data.mode).toBe("proxy");
    expect(status.data.migration_required).toBe(true);

    const listRes = await app.request("/list", { method: "POST" });
    const list: any = await listRes.json();
    expect(list.data.items).toHaveLength(1);
    const item = list.data.items[0];
    expect(item.service_id).toBe("svc-legacy");
    expect(item.migration_required).toBe(true);
    expect("proxy_base_url" in item).toBe(false);
    expect(item.has_api_key).toBe(true);
  });

  it("resolveLlmConfig 读到 mode='proxy' → 抛 LlmBindingRetiredError，消息含迁移命令", () => {
    const { store, raw } = makeRoutes();
    seedLegacyRow(raw, { serviceId: "svc-legacy", mode: "proxy", apiKey: "sk-x" });
    const row = store.get("svc-legacy")!;

    let caught: unknown;
    try {
      resolveLlmConfig("svc-legacy", row, GLOBAL_LLM);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmBindingRetiredError);
    const err = caught as LlmBindingRetiredError;
    expect(err.code).toBe("LLM_BINDING_MODE_RETIRED");
    expect(err.serviceId).toBe("svc-legacy");
    expect(err.message).toContain(LLM_BINDING_PROXY_RETIRED_HINT);
    expect(err.message).toContain("custom");
    expect(err.message).toContain("retired");
    expect(err.message).toContain("svc-legacy");
  });

  it("遗留 byo 行（custom 的历史别名）照常解析，不算迁移项", () => {
    const { store, raw } = makeRoutes();
    seedLegacyRow(raw, {
      serviceId: "svc-byo",
      mode: "byo",
      baseUrl: "https://byo.example/v1",
      apiKey: "sk-byo",
    });
    const row = store.get("svc-byo")!;
    expect(row.mode).toBe("byo");
    expect(row.migration_required).toBe(false);

    const resolved = resolveLlmConfig("svc-byo", row, GLOBAL_LLM);
    expect(resolved.baseUrl).toBe("https://byo.example/v1");
    expect(resolved.apiKey).toBe("sk-byo");
    expect(resolved.model).toBe(GLOBAL_LLM.model);
  });

  it("迁移路径可验证：遗留 proxy 行按提示 set custom 后 migration_required 消失、解析恢复", async () => {
    const { app, store, raw } = makeRoutes();
    seedLegacyRow(raw, { serviceId: "svc-legacy", mode: "proxy", apiKey: "sk-old" });

    const legacy = store.get("svc-legacy")!;
    expect(() => resolveLlmConfig("svc-legacy", legacy, GLOBAL_LLM)).toThrow(LlmBindingRetiredError);

    const res = await postJson(
      app,
      "/set",
      { mode: "custom", base_url: "https://new.example/v1" },
      "svc-legacy",
    );
    expect(res.status).toBe(200);

    const migrated = store.get("svc-legacy")!;
    expect(migrated.migration_required).toBe(false);
    expect(migrated.mode).toBe("custom");
    // api_key 未传 → 保留老值
    expect(migrated.api_key).toBe("sk-old");
    expect(resolveLlmConfig("svc-legacy", migrated, GLOBAL_LLM).baseUrl).toBe("https://new.example/v1");
  });

    it("生产老库仍带退役列 proxy_base_url 时，新 schema 读得动（未知列被忽略，不炸）", () => {
    const inst = makeDb();
    inst.raw.exec("ALTER TABLE llm_binding ADD COLUMN proxy_base_url TEXT");
    const store = createLlmBindingStore(inst.db);
    seedLegacyRow(inst.raw, {
      serviceId: "svc-legacy",
      mode: "proxy",
      apiKey: "sk-x",
      proxyBaseUrl: "http://127.0.0.1:8096",
    });

    const row = store.get("svc-legacy")!;
    expect(row.mode).toBe("proxy");
    expect(row.migration_required).toBe(true);
    expect(row.base_url).toBeNull();
  });

  it("无绑定 / 绑定被禁用 → 用全局 LLM_*（不抛错）", () => {
    const { store, raw } = makeRoutes();
    expect(resolveLlmConfig("svc-none", null, GLOBAL_LLM)).toEqual(GLOBAL_LLM);

    seedLegacyRow(raw, { serviceId: "svc-off", mode: "proxy", apiKey: "sk-x" });
    raw.prepare("UPDATE llm_binding SET enabled = 0 WHERE service_id = ?").run("svc-off");
    const row = store.get("svc-off")!;
    expect(row.enabled).toBe(false);
    expect(resolveLlmConfig("svc-off", row, GLOBAL_LLM)).toEqual(GLOBAL_LLM);
  });
});

describe("环境变量 LLM_MODE=proxy 同样 fail-loud", () => {
  it("loadConfig 抛错，消息点明 retired 与替代路径", () => {
    process.env.LLM_MODE = "proxy";
    expect(() => loadConfig()).toThrowError(/LLM_MODE=proxy is retired/);
    process.env.LLM_MODE = "custom";
    expect(() => loadConfig()).not.toThrow();
  });
});
