// tests/admin-settings-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminSettingsRoutes } from "../src/routes/admin-settings.js";

function makeApp(dir: string) {
  const config = {
    llm: { mode: "custom", protocol: "openai", provider: "custom", apiKey: "sk-real-1234", model: "m1", baseUrl: "https://a.b", maxTokens: 100, timeoutMs: 200, stream: false },
    embedding: { provider: "openai_compatible", apiKey: "ek-9999", model: "e1", baseUrl: "https://e.b", dimensions: 8 },
  } as any;
  return createAdminSettingsRoutes({ config, dataDir: dir });
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ks-set-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("admin settings routes", () => {
  it("GET /get 返回掩码 key 与 env 来源", async () => {
    const app = makeApp(dir);
    const res = await app.request("/get", { method: "POST" });
    const json: any = await res.json();
    expect(json.code).toBe(0);
    expect(json.data.llm.apiKeyMasked).toBe("****1234");
    expect(json.data.llm.apiKey).toBeUndefined();
    expect(json.data.llm.source).toBe("env");
    expect(json.data.needsRestart).toBeUndefined();
  });
  it("SET 写 override、空 apiKey 保留原值、返回 needsRestart", async () => {
    const app = makeApp(dir);
    const res = await app.request("/set", { method: "POST", body: JSON.stringify({ llm: { model: "m2", apiKey: "" }, embedding: { model: "e1", dimensions: 8 } }), headers: { "content-type": "application/json" } });
    const json: any = await res.json();
    expect(json.code).toBe(0);
    expect(json.data.needsRestart).toBe(true);
    expect(json.data.embeddingChanged).toBe(false);
    const saved = JSON.parse(readFileSync(join(dir, "config-override.json"), "utf-8"));
    expect(saved.llm.model).toBe("m2");
    expect(saved.llm.apiKey).toBeUndefined(); // 空串 = 保留原值，不落盘
  });
  it("embedding model/dimensions 变更返回 embeddingChanged", async () => {
    const app = makeApp(dir);
    const res = await app.request("/set", { method: "POST", body: JSON.stringify({ embedding: { model: "e9", dimensions: 16 } }), headers: { "content-type": "application/json" } });
    const json: any = await res.json();
    expect(json.data.embeddingChanged).toBe(true);
  });
  it("非法输入 400", async () => {
    const app = makeApp(dir);
    const res = await app.request("/set", { method: "POST", body: JSON.stringify({ llm: { baseUrl: "ftp://x" } }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
  });
  it("非法 JSON body 返回 400 且不写盘", async () => {
    const app = makeApp(dir);
    const res = await app.request("/set", { method: "POST", body: "{not-valid-json", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.code).toBe(400);
    expect(json.message).toContain("JSON");
    expect(existsSync(join(dir, "config-override.json"))).toBe(false);
  });
  it("body 既无 llm 也无 embedding 返回 400", async () => {
    const app = makeApp(dir);
    const res = await app.request("/set", { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.code).toBe(400);
    expect(json.message).toContain("llm 或 embedding");
    expect(existsSync(join(dir, "config-override.json"))).toBe(false);
  });
  it("llm/embedding 解析为非对象视为缺失返回 400", async () => {
    const app = makeApp(dir);
    const res = await app.request("/set", { method: "POST", body: JSON.stringify({ llm: "x", embedding: 5 }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.message).toContain("llm 或 embedding");
  });
});

// ── F3：/revectorize fire-and-forget（终审修复）───────────────────────────────
describe("admin settings /revectorize (F3 fire-and-forget)", () => {
  const wiredApp = (dir: string, impl: () => Promise<boolean>, status: () => unknown = () => ({ status: "idle" })) => {
    const config = {
      llm: { mode: "custom", protocol: "openai", provider: "custom", apiKey: "sk-real-1234", model: "m1", baseUrl: "https://a.b", maxTokens: 100, timeoutMs: 200, stream: false },
      embedding: { provider: "openai_compatible", apiKey: "ek-9999", model: "e1", baseUrl: "https://e.b", dimensions: 8 },
    } as any;
    return createAdminSettingsRoutes({ config, dataDir: dir, forceRevectorize: impl, getVectorStatus: status });
  };

  it("未接线返回 400", async () => {
    const app = makeApp(dir);
    const res = await app.request("/revectorize", { method: "POST" });
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.code).toBe(400);
  });

  it("idle 时立即返回 started:true（fire-and-forget：不等待重建完成）", async () => {
    let resolveRebuild!: (v: boolean) => void;
    const slowRebuild = new Promise<boolean>((r) => { resolveRebuild = r; });
    const app = wiredApp(dir, () => slowRebuild, () => ({ status: "idle" }));
    // 旧实现 await 整个重建 → request() 本身阻塞 >500ms；新实现 handler 立即返回
    const winner = await Promise.race([
      (async () => {
        const r = await app.request("/revectorize", { method: "POST" });
        return { kind: "response", status: r.status, json: await r.json() };
      })(),
      new Promise<{ kind: string }>((r) => setTimeout(() => r({ kind: "timeout-first" }), 500)),
    ]);
    expect(winner.kind).toBe("response");
    expect(winner.status).toBe(200);
    expect((winner as any).json.code).toBe(0);
    expect((winner as any).json.data.started).toBe(true);
    resolveRebuild(true); // 收尾：模拟重建最终真正启动
  });

  it("重建已在运行时返回 409 {started:false}（诚实语义）", async () => {
    const app = wiredApp(dir, async () => false, () => ({ status: "running", startedAt: "2026-09-09T00:00:00Z" }));
    const res = await app.request("/revectorize", { method: "POST" });
    expect(res.status).toBe(409);
    const json: any = await res.json();
    expect(json.code).toBe(409);
    expect(json.data.started).toBe(false);
    expect(json.message).toContain("already running");
  });
});
