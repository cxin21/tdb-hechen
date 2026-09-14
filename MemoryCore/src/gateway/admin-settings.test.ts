// src/gateway/admin-settings.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type http from "node:http";
import { makeAdminSettingsRouteTable } from "./admin-settings.js";
import { handleV2Route, type V2RouterDeps } from "./v2-router.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "core-set-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const deps = () => ({
  baseDir: dir,
  getEffective: () => ({
    llm: { baseUrl: "https://a.b", apiKey: "sk-12345678", model: "m1", maxTokens: 10, timeoutMs: 20, provider: "openai" as const, proxy: { useMemorySystemUserKey: true }, stream: false },
    embedding: { provider: "openai_compatible", apiKey: "ek-87654321", model: "e1", baseUrl: "https://e.b", dimensions: 8, sendDimensions: true, enabled: true },
  }),
  getReindexState: () => ({ status: "idle" as const }),
});

describe("admin settings route table (core)", () => {
  it("get 返回掩码 key + rebuildStatus（与 KS / Panel SettingsView 字段名对齐）", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    const res = await table["/v3/admin/settings/get"]!({}, {} as any, "req-1", {});
    expect(res.code).toBe(0);
    const d = res.data as any;
    expect(d.llm.apiKeyMasked).toBe("****5678");
    expect(d.llm.apiKey).toBeUndefined();
    expect(d.rebuildStatus).toEqual({ status: "idle" });
    expect(d.reindexState).toBeUndefined();
  });
  it("set 落盘 + 空 apiKey 保留 + needsRestart", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    const res = await table["/v3/admin/settings/set"]!({ llm: { model: "m2", apiKey: "" }, embedding: { model: "e1", dimensions: 8 } }, {} as any, "req-2", {});
    expect((res.data as any).needsRestart).toBe(true);
    expect((res.data as any).embeddingChanged).toBe(false);
  });
  it("embedding 变更 embeddingChanged=true", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    const res = await table["/v3/admin/settings/set"]!({ embedding: { model: "e9", dimensions: 16 } }, {} as any, "req-3", {});
    expect((res.data as any).embeddingChanged).toBe(true);
  });
  it("非法输入返回 code!=0", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    const res = await table["/v3/admin/settings/set"]!({ llm: { baseUrl: "ftp://x" } }, {} as any, "req-4", {});
    expect(res.code).not.toBe(0);
  });
});

describe("admin settings 分发级集成（handleV2Route → extraRouteTable）", () => {
  // Regression: /v3/admin/* 必须经真实 handleV2Route 分发（isV3Extra 白名单 + extraRouteTable 查找），
  // 否则运行时 404（review finding：isV3Extra 缺 /v3/admin/ 前缀导致路由不可达）。
  it("POST /v3/admin/settings/get 经真实 dispatch 命中并返回 success envelope", async () => {
    const req = {
      headers: { authorization: "Bearer test-key", "x-tdai-service-id": "svc-1" },
    } as unknown as http.IncomingMessage;
    const res = {} as unknown as http.ServerResponse;
    let status = 0;
    let sent: unknown;
    const sendJson = (_res: http.ServerResponse, s: number, body: unknown) => { status = s; sent = body; };
    const parseJsonBody = async <T>() => ({}) as T;
    const routerDeps = {
      getStore: () => undefined,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      deployMode: "standalone" as const,
    } as V2RouterDeps;

    const handled = await handleV2Route(
      req,
      res,
      "/v3/admin/settings/get",
      "POST",
      parseJsonBody,
      sendJson,
      routerDeps,
      makeAdminSettingsRouteTable(deps()),
    );

    expect(handled).toBe(true);
    expect(status).toBe(200);
    const envelope = sent as { code: number; data?: { llm?: Record<string, unknown> } };
    expect(envelope.code).toBe(0);
    expect(envelope.data?.llm).toBeDefined();
    expect(envelope.data?.llm?.apiKeyMasked).toBe("****5678");
  });
});
