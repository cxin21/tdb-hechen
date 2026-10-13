/**
 * P1 召回质量 spec §4.3/§4.5（task-1/task-3）：rerank provider 工厂路由测试。
 * 路由合同：enabled=false / provider=none / 未配置 → null（=skip，调用方
 * 降级现状）；siliconflow/dashscope → 对应 adapter 实例；local → LocalReranker
 * （task-3：transformers.js 本地 reranker，进程级单例池 keyed by modelDir）。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseConfig } from "../../../../config.js";
import { createReranker, resolveLocalModelDir } from "../factory.js";
import { DashscopeReranker } from "../dashscope.js";
import { SiliconflowReranker } from "../siliconflow.js";
import { LocalReranker, resetLocalRerankerPoolForTests } from "../local.js";

const rerankConfigOf = (raw: Record<string, unknown>) => parseConfig({ recall: { rerank: raw } }).recall.rerank;

describe("P1 task-1 rerank 工厂：路由", () => {
  it("缺省（未配置）→ null：零行为变化的第一道闸", () => {
    expect(createReranker(rerankConfigOf({}))).toBeNull();
  });

  it("enabled:false（无论 provider）→ null", () => {
    expect(createReranker(rerankConfigOf({ enabled: false, provider: "siliconflow", apiKey: "sk" }))).toBeNull();
  });

  it("enabled:true + provider:none → null（显式 none = skip）", () => {
    expect(createReranker(rerankConfigOf({ enabled: true, provider: "none" }))).toBeNull();
  });

  it("enabled:true + siliconflow + apiKey → SiliconflowReranker 实例", () => {
    const rr = createReranker(rerankConfigOf({ enabled: true, provider: "siliconflow", apiKey: "sk-x" }));
    expect(rr).toBeInstanceOf(SiliconflowReranker);
    expect(typeof rr?.rerank).toBe("function");
  });

  it("enabled:true + dashscope + apiKey → DashscopeReranker 实例", () => {
    const rr = createReranker(rerankConfigOf({ enabled: true, provider: "dashscope", apiKey: "sk-y" }));
    expect(rr).toBeInstanceOf(DashscopeReranker);
    expect(typeof rr?.rerank).toBe("function");
  });

  it("provider:'local' → LocalReranker 实例（task-3 落地）；同 modelDir 池内共享同一实例", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk3-fac-"));
    try {
      const cfg = rerankConfigOf({ enabled: true, provider: "local", local: { modelDir: dir } });
      const a = createReranker(cfg);
      const b = createReranker(cfg);
      expect(a).toBeInstanceOf(LocalReranker);
      expect(typeof a?.rerank).toBe("function");
      expect(b).toBe(a); // 池：同一模型目录只加载一份（wiring 每调用经过工厂）
    } finally {
      await resetLocalRerankerPoolForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveLocalModelDir：显式 modelDir > dataDir DI > TDAI_DATA_DIR env", () => {
    const repo = "Xenova/bge-reranker-base";
    const cfgExplicit = rerankConfigOf({ enabled: true, provider: "local", local: { modelDir: "D:/models/x" } });
    expect(resolveLocalModelDir(cfgExplicit, "D:/data")).toBe(path.resolve("D:/models/x"));
    const cfgEmpty = rerankConfigOf({ enabled: true, provider: "local" });
    expect(resolveLocalModelDir(cfgEmpty, "D:/data")).toBe(path.join("D:/data", "models", "reranker", repo));
    vi.stubEnv("TDAI_DATA_DIR", "D:/envdata");
    try {
      expect(resolveLocalModelDir(cfgEmpty)).toBe(path.join("D:/envdata", "models", "reranker", repo));
      expect(resolveLocalModelDir(cfgEmpty, "D:/data")).toBe(path.join("D:/data", "models", "reranker", repo));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("云端 provider 缺 apiKey（config 已强制 enabled=false + configError）→ null 双保险", () => {
    const cfg = rerankConfigOf({ enabled: true, provider: "siliconflow" });
    expect(cfg.enabled).toBe(false);
    expect(cfg.configError).toBeTruthy();
    expect(createReranker(cfg)).toBeNull();
  });

  it("apiKey 为纯空白视同缺省：siliconflow 路由为 null（校验同源）", () => {
    expect(createReranker(rerankConfigOf({ enabled: true, provider: "siliconflow", apiKey: "   " }))).toBeNull();
  });
});

describe("P1 task-1 rerank 工厂：依赖注入透传", () => {
  it("opts.fetchImpl 透传到 adapter（自定义 fetch 被实际调用）", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 429 }));
    const rr = createReranker(rerankConfigOf({ enabled: true, provider: "siliconflow", apiKey: "sk-z" }), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(rr).toBeInstanceOf(SiliconflowReranker);
    expect(await rr!.rerank("q", ["d"])).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
