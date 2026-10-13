// src/gateway/rerank-model-admin.test.ts
// P1 task-4：/v3/admin/rerank-model/{status,download} 路由表。
// 密闭性：下载经 downloadOptions 注入 tiny modelFiles + fetchImpl mock（零真实网络）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRerankModelAdminRouteTable, type RerankModelAdminDeps } from "./rerank-model-admin.js";
import { getRerankModelStatus, resetRerankDownloadStateForTests, type RerankModelFileSpec, type StartRerankModelDownloadOptions } from "../core/recall/rerank/downloader.js";
import type { RecallRerankConfig } from "../config.js";

const TINY_MODEL_FILES: RerankModelFileSpec[] = [
  { rel: "config.json", minBytes: 1 },
  { rel: "tokenizer.json", minBytes: 1 },
  { rel: "tokenizer_config.json", minBytes: 1 },
  { rel: "special_tokens_map.json", minBytes: 1 },
  { rel: "model.onnx", minBytes: 1 },
];
const fullValidBody = (rel: string) => `valid:${rel}:${"x".repeat(64)}`;

let tmpRoot: string;
let modelDir: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rk-admin-"));
  modelDir = join(tmpRoot, "models", "reranker", "test-repo");
  resetRerankDownloadStateForTests();
});
afterEach(() => {
  resetRerankDownloadStateForTests();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeFetchMock(calls: Array<{ url: string }>): typeof fetch {
  return (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push({ url });
    const rel = url.split("/resolve/")[1]?.split("/").slice(1).join("/") ?? "";
    const body = fullValidBody(rel);
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-length": String(body.length) } }));
  };
}

const deps = (overrides: Partial<RerankModelAdminDeps> = {}): RerankModelAdminDeps => {
  const calls: Array<{ url: string }> = [];
  return {
    getRerankConfig: () => ({ local: { modelDir } } as unknown as RecallRerankConfig),
    dataDir: tmpRoot,
    downloadOptions: {
      modelFiles: TINY_MODEL_FILES,
      repo: "test-repo",
      fetchImpl: makeFetchMock(calls),
      backoffBaseMs: 1,
      maxRetriesPerSource: 0,
      hfBaseUrl: "http://hf.test",
      modelScopeBaseUrl: "http://ms.test",
    } as Omit<StartRerankModelDownloadOptions, "modelDir">,
    ...overrides,
  };
};

describe("rerank-model-admin route table (P1 task-4)", () => {
  it("status：初始 idle 快照（code=0，无网络）", async () => {
    const table = makeRerankModelAdminRouteTable(deps());
    const res = await table["/v3/admin/rerank-model/status"]!({}, {} as any, "req-s1", {});
    expect(res.code).toBe(0);
    const d = res.data as { state: string; percent: number; files: unknown[] };
    expect(d.state).toBe("idle");
    expect(d.percent).toBe(0);
    expect(Array.isArray(d.files)).toBe(true);
  });
  it("download：触发即返 + 轮询至 ready（percent=100，零真实网络）", async () => {
    const table = makeRerankModelAdminRouteTable(deps());
    const res = await table["/v3/admin/rerank-model/download"]!({}, {} as any, "req-d1", {});
    expect(res.code).toBe(0);
    const snap = res.data as { state: string };
    expect(["downloading", "ready"]).toContain(snap.state);
    await vi.waitFor(() => expect(getRerankModelStatus().state).toBe("ready"), { timeout: 5000 });
    expect(getRerankModelStatus().percent).toBe(100);
  });
  it("status 返回注册表拷贝（无 alias）", async () => {
    const table = makeRerankModelAdminRouteTable(deps());
    await table["/v3/admin/rerank-model/download"]!({}, {} as any, "req-d2", {});
    await vi.waitFor(() => expect(getRerankModelStatus().state).toBe("ready"), { timeout: 5000 });
    const res = await table["/v3/admin/rerank-model/status"]!({}, {} as any, "req-s2", {});
    const d = res.data as { state: string; percent: number };
    expect(d.state).toBe("ready");
    expect(d.percent).toBe(100);
    // 拷贝语义：改返回值不影响注册表
    (d as unknown as { state: string }).state = "mutated";
    expect(getRerankModelStatus().state).toBe("ready");
  });
});
