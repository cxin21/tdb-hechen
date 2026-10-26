// src/gateway/settings-override.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettingsOverride, writeSettingsOverride, maskKey, validateOverride, pickDefined, applyRerankOverrideToRaw } from "./settings-override.js";
import { loadGatewayConfig, resetLlmApiKeyDeprecationWarnForTests } from "./config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "core-ovr-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("settings-override (core)", () => {
  it("round-trip 读写", () => {
    expect(readSettingsOverride(dir)).toBeNull();
    writeSettingsOverride(dir, { llm: { baseUrl: "https://x", model: "m" }, embedding: { model: "e", dimensions: 8, sendDimensions: true } });
    const o = readSettingsOverride(dir)!;
    expect(o.llm?.model).toBe("m");
    expect(o.embedding?.sendDimensions).toBe(true);
  });
  it("pickDefined 只保留非 undefined", () => {
    expect(pickDefined({ a: undefined, b: 1 })).toEqual({ b: 1 });
  });
  it("maskKey 尾 4 位", () => {
    expect(maskKey("12345678")).toEqual({ hasApiKey: true, apiKeyMasked: "****5678" });
  });
  it("validateOverride 校验 URL/正整数/非空 model", () => {
    expect(validateOverride({ llm: { baseUrl: "nope" } }).ok).toBe(false);
    expect(validateOverride({ embedding: { dimensions: -1 } }).ok).toBe(false);
    expect(validateOverride({ llm: { baseUrl: "https://a.b", model: "m" }, embedding: { model: "e", dimensions: 4 } }).ok).toBe(true);
  });

  // 回归：config.ts 中 embedding override 合并必须位于"yaml 顶层 embedding 兼容 splice"
  // 之后 —— 否则 splice 的 `str(yaml,"model") ?? memory.embedding.model` 会用 yaml
  // 顶层 embedding 字段覆盖刚合并的 admin override，违背 spec §3.2 优先级
  // （config-override.json > TDAI_LLM_* env > yaml）。本用例通过
  // TDAI_GATEWAY_CONFIG + TDAI_DATA_DIR 构造真实 loadGatewayConfig 场景验证顺序语义。
  it("loadGatewayConfig：yaml 顶层 embedding 不得覆盖 admin override（spec §3.2 顺序）", () => {
    const yamlPath = join(dir, "tdai-gateway.yaml");
    writeFileSync(yamlPath, [
      "llm:",
      "  baseUrl: https://yaml-llm.example/v1",
      "  apiKey: yaml-llm-key",
      "  model: yaml-llm-model",
      "embedding:",
      "  provider: openai",
      "  baseUrl: https://yaml-emb.example/v1",
      "  apiKey: yaml-emb-key",
      "  model: yaml-emb-model",
      "  dimensions: 1024",
      "",
    ].join("\n"), "utf-8");
    writeSettingsOverride(dir, {
      llm: { baseUrl: "https://override-llm.example/v1" },
      embedding: { model: "override-emb-model", dimensions: 8 },
    });

    const keys = [
      "TDAI_GATEWAY_CONFIG", "TDAI_DATA_DIR",
      "TDAI_LLM_PROVIDER", "TDAI_LLM_BASE_URL", "TDAI_LLM_API_KEY", "TDAI_LLM_MODEL",
      "TDAI_LLM_MAX_TOKENS", "TDAI_LLM_TIMEOUT_MS", "TDAI_LLM_STREAM",
      "TDAI_EMBEDDING_PROVIDER", "TDAI_EMBEDDING_BASE_URL", "TDAI_EMBEDDING_API_KEY",
      "TDAI_EMBEDDING_MODEL", "TDAI_EMBEDDING_DIMENSIONS",
    ];
    const saved = new Map(keys.map(k => [k, process.env[k]]));
    process.env.TDAI_GATEWAY_CONFIG = yamlPath;
    process.env.TDAI_DATA_DIR = dir;
    for (const k of keys) if (k !== "TDAI_GATEWAY_CONFIG" && k !== "TDAI_DATA_DIR") delete process.env[k];
    try {
      const cfg = loadGatewayConfig();
      // override 必须最后落：yaml 顶层 embedding 存在时也不得反向覆盖 override
      expect(cfg.memory.embedding.model).toBe("override-emb-model");
      expect(cfg.memory.embedding.dimensions).toBe(8);
      // override 未指定的字段仍由 yaml 顶层块提供（兼容 splice 语义保留）
      expect(cfg.memory.embedding.baseUrl).toBe("https://yaml-emb.example/v1");
      // llm 合并保持在 splice 之前：override 后的 llm 值被 splice 进 memory.llm
      expect(cfg.memory.llm.baseUrl).toBe("https://override-llm.example/v1");
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ── ADR-0006 回归（2026-10-19 生产实锚）：parseConfig 的 embedding enabled 判定跑在
// override 合并之前——yaml memory.embedding.apiKey 用 "${TDAI_LLM_API_KEY}" 占位（一把
// key 同源设计），env 键按 ADR-0006 迁移删除后 expandEnvVars 整串展开为空串 →
// parseConfig 判 disabled（configError 记 missing apiKey）；override（config-override.json）
// 补齐字段后必须重跑判定救回 enabled——最终状态只能由最终合并值决定，不能由中间态定死。
describe("ADR-0006 回归：override 补齐 embedding 后须重跑 enabled 判定", () => {
  const ENV_KEYS = [
    "TDAI_GATEWAY_CONFIG", "TDAI_DATA_DIR",
    "TDAI_LLM_PROVIDER", "TDAI_LLM_BASE_URL", "TDAI_LLM_API_KEY", "TDAI_LLM_MODEL",
    "TDAI_EMBEDDING_PROVIDER", "TDAI_EMBEDDING_BASE_URL", "TDAI_EMBEDDING_API_KEY",
    "TDAI_EMBEDDING_MODEL", "TDAI_EMBEDDING_DIMENSIONS",
  ];
  function withEnv(fn: () => void): void {
    const saved = new Map(ENV_KEYS.map(k => [k, process.env[k]] as const));
    for (const k of ENV_KEYS) if (k !== "TDAI_GATEWAY_CONFIG" && k !== "TDAI_DATA_DIR") delete process.env[k];
    process.env.TDAI_GATEWAY_CONFIG = join(dir, "tdai-gateway.yaml");
    process.env.TDAI_DATA_DIR = dir;
    try { fn(); } finally {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }
  function writeYaml(rows: string[]): void {
    writeFileSync(join(dir, "tdai-gateway.yaml"), rows.join("\n") + "\n", "utf-8");
  }
  it("yaml 占位 apiKey 展开为空串 + override 补齐 → enabled=true 且 configError 清空", () => {
    writeYaml([
      "memory:",
      "  embedding:",
      '    provider: "openai_compatible"',
      "    baseUrl: https://ark.example/api/v3",
      "    apiKey: \"${TDAI_LLM_API_KEY}\"",
      "    model: doubao-embedding-test",
      "    dimensions: 2048",
    ]);
    writeSettingsOverride(dir, { embedding: { baseUrl: "https://override-emb.example/v3", apiKey: "override-emb-key", model: "override-emb-model", dimensions: 2048 } });
    withEnv(() => {
      const cfg = loadGatewayConfig();
      expect(cfg.memory.embedding.enabled).toBe(true);
      expect(cfg.memory.embedding.configError).toBeUndefined();
      expect(cfg.memory.embedding.apiKey).toBe("override-emb-key");
      expect(cfg.memory.embedding.model).toBe("override-emb-model");
    });
  });
  it("override 仍缺字段（yaml 无 model 且 override 不给）→ 保持 disabled 且 configError 保留", () => {
    writeYaml([
      "memory:",
      "  embedding:",
      '    provider: "openai_compatible"',
      "    baseUrl: https://ark.example/api/v3",
      "    apiKey: \"${TDAI_LLM_API_KEY}\"",
      "    dimensions: 2048",
    ]);
    writeSettingsOverride(dir, { embedding: { apiKey: "override-emb-key" } });
    withEnv(() => {
      const cfg = loadGatewayConfig();
      expect(cfg.memory.embedding.enabled).toBe(false);
      expect(cfg.memory.embedding.configError).toBeTruthy();
    });
  });
  it("qclaw 缺 proxyUrl → 不救回（configError 保留）", () => {
    writeYaml([
      "memory:",
      "  embedding:",
      '    provider: "qclaw"',
      "    baseUrl: https://ark.example/api/v3",
      "    apiKey: \"${TDAI_LLM_API_KEY}\"",
      "    model: emb-model",
      "    dimensions: 2048",
    ]);
    writeSettingsOverride(dir, { embedding: { baseUrl: "https://override-emb.example/v3", apiKey: "k", model: "m", dimensions: 8 } });
    withEnv(() => {
      const cfg = loadGatewayConfig();
      expect(cfg.memory.embedding.enabled).toBe(false);
      expect(cfg.memory.embedding.configError).toBeTruthy();
    });
  });
});

describe("maxTokens/timeoutMs=0（不限制语义，2026-09-16 拍板；UI 需可保存 0）", () => {
  it("0 合法且保留（不被拒收）", () => {
    const r = validateOverride({ llm: { maxTokens: 0, timeoutMs: 0 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.llm?.maxTokens).toBe(0);
      expect(r.value.llm?.timeoutMs).toBe(0);
    }
  });
  it("负数仍拒收", () => {
    const r = validateOverride({ llm: { maxTokens: -1 } });
    expect(r.ok).toBe(false);
  });
});

// ── P1 task-4：rerank 段（panel rerank 配置与 embedding 同款持久化语义）──
describe("rerank 段（P1 task-4）", () => {
  it("validateOverride rerank：合法值收编", () => {
    const ok = validateOverride({
      rerank: {
        enabled: true, provider: "local", baseUrl: "https://a.b", apiKey: "k", model: "m",
        timeoutMs: 800, candidates: 12, minScore: -2.5,
        local: { modelDir: "D:/models", idleUnloadMs: 0 },
      },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.rerank?.provider).toBe("local");
      expect(ok.value.rerank?.minScore).toBe(-2.5);
      expect(ok.value.rerank?.local?.idleUnloadMs).toBe(0);
    }
  });
  it("validateOverride rerank：非法值逐字段拒收", () => {
    const bad = validateOverride({
      rerank: { baseUrl: "nope", model: "  ", enabled: 1, timeoutMs: -5, candidates: 0, minScore: "x", local: { idleUnloadMs: -1, modelDir: 42 } },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const joined = bad.errors.join(";");
      for (const frag of ["rerank.baseUrl", "rerank.model", "rerank.enabled", "rerank.timeoutMs", "rerank.candidates", "rerank.minScore", "rerank.local.idleUnloadMs", "rerank.local.modelDir"]) {
        expect(joined).toContain(frag);
      }
    }
  });
  it("shadowMode 键已移除（用户 2026-10-14 拍板）：旧载荷携带该键被静默忽略，不报错不落盘", () => {
    const v = validateOverride({ rerank: { enabled: true, shadowMode: false } });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.rerank?.enabled).toBe(true);
      expect((v.value.rerank as unknown as Record<string, unknown>).shadowMode).toBeUndefined();
    }
  });
  it("rerank 空对象不落 override", () => {
    const r = validateOverride({ rerank: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rerank).toBeUndefined();
  });
  it("round-trip 读写 rerank 段（含 local 子对象）", () => {
    writeSettingsOverride(dir, { rerank: { enabled: true, provider: "local", local: { modelDir: "D:/m", idleUnloadMs: 0 } } });
    const o = readSettingsOverride(dir)!;
    expect(o.rerank?.enabled).toBe(true);
    expect(o.rerank?.local?.modelDir).toBe("D:/m");
    expect(o.rerank?.local?.idleUnloadMs).toBe(0);
  });
  it("applyRerankOverrideToRaw：并入 raw.recall.rerank、local 局部深合并、不改入参", () => {
    const raw: Record<string, unknown> = { recall: { rerank: { enabled: false, local: { modelDir: "yaml-dir" } } }, version: 1 };
    const out = applyRerankOverrideToRaw(raw, { enabled: true, local: { idleUnloadMs: 0 } });
    expect(out).not.toBe(raw);
    expect(raw.recall).toEqual({ rerank: { enabled: false, local: { modelDir: "yaml-dir" } } }); // 入参不变
    const rr = (out as { recall: { rerank: Record<string, any> } }).recall.rerank;
    expect(rr.enabled).toBe(true);
    expect(rr.local.modelDir).toBe("yaml-dir");   // yaml 值保留（局部深合并）
    expect(rr.local.idleUnloadMs).toBe(0);        // override 值并入
    expect(applyRerankOverrideToRaw(raw, undefined)).toBe(raw); // 空 override 原样返回
  });
  it("loadGatewayConfig：rerank override 经 parseConfig 校验通道（非法 provider 回退 none + enabled 强制关）", () => {
    const yamlPath = join(dir, "tdai-gateway.yaml");
    writeFileSync(yamlPath, [
      "memory:",
      "  recall:",
      "    rerank:",
      "      enabled: true",
      "      provider: local",
      "",
    ].join("\n"), "utf-8");
    // override 写入非法 provider —— 必须被 parseConfig 校验拦下（回退 none + enabled=false），
    // 证明 override 注入发生在 parse 之前而非旁路。
    writeSettingsOverride(dir, { rerank: { provider: "bogus", enabled: true } });
    const keys = ["TDAI_GATEWAY_CONFIG", "TDAI_DATA_DIR"];
    const saved = new Map(keys.map(k => [k, process.env[k]]));
    process.env.TDAI_GATEWAY_CONFIG = yamlPath;
    process.env.TDAI_DATA_DIR = dir;
    try {
      const cfg = loadGatewayConfig();
      const rr = cfg.memory.recall.rerank as unknown as Record<string, any>;
      expect(rr.provider).toBe("none");
      expect(rr.enabled).toBe(false);
      expect(String(rr.configError ?? "")).toContain("bogus");
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  it("loadGatewayConfig：rerank override 覆盖 yaml 值（合法时生效）", () => {
    const yamlPath = join(dir, "tdai-gateway.yaml");
    writeFileSync(yamlPath, [
      "memory:",
      "  recall:",
      "    rerank:",
      "      enabled: false",
      "      provider: none",
      "",
    ].join("\n"), "utf-8");
    writeSettingsOverride(dir, { rerank: { enabled: true, provider: "local", local: { idleUnloadMs: 0 } } });
    const keys = ["TDAI_GATEWAY_CONFIG", "TDAI_DATA_DIR"];
    const saved = new Map(keys.map(k => [k, process.env[k]]));
    process.env.TDAI_GATEWAY_CONFIG = yamlPath;
    process.env.TDAI_DATA_DIR = dir;
    try {
      const cfg = loadGatewayConfig();
      const rr = cfg.memory.recall.rerank as unknown as Record<string, any>;
      expect(rr.enabled).toBe(true);
      expect(rr.provider).toBe("local");
      expect(rr.local.idleUnloadMs).toBe(0);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ADR-0006（#70）：llm.apiKey 不再 env 优先 —— override > yaml > env(deprecated warn)。
// 占位符（__X__ / ${X}，云模板未替换/未展开标记）视为未设置。
// baseUrl/model/provider 的 env 优先保留（非秘密，不在本合同内）。
describe("llm.apiKey 解析链（ADR-0006：override > yaml > env-deprecated）", () => {
  const keys = [
    "TDAI_GATEWAY_CONFIG", "TDAI_DATA_DIR", "TDAI_LLM_PROVIDER", "TDAI_LLM_BASE_URL",
    "TDAI_LLM_API_KEY", "TDAI_LLM_MODEL", "TDAI_LLM_MAX_TOKENS", "TDAI_LLM_TIMEOUT_MS", "TDAI_LLM_STREAM",
  ];
  let dir: string;
  let yamlPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmchain-"));
    yamlPath = join(dir, "tdai-gateway.yaml");
    writeFileSync(yamlPath, [
      "llm:",
      "  baseUrl: https://yaml-llm.example/v1",
      "  apiKey: yaml-llm-key",
      "  model: yaml-llm-model",
      "",
    ].join("\n"), "utf-8");
    const saved = new Map(keys.map(k => [k, process.env[k]]));
    for (const k of keys) if (k !== "TDAI_GATEWAY_CONFIG" && k !== "TDAI_DATA_DIR") delete process.env[k];
    process.env.TDAI_GATEWAY_CONFIG = yamlPath;
    process.env.TDAI_DATA_DIR = dir;
    (globalThis as unknown as { __llmChainSaved?: Map<string, string | undefined> }).__llmChainSaved = saved;
    resetLlmApiKeyDeprecationWarnForTests();
  });
  afterEach(() => {
    const saved = (globalThis as unknown as { __llmChainSaved?: Map<string, string | undefined> }).__llmChainSaved;
    if (saved) {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("override key > yaml key > env key", () => {
    writeSettingsOverride(dir, { llm: { apiKey: "ovr-llm-key" } });
    process.env.TDAI_LLM_API_KEY = "env-llm-key";
    const cfg = loadGatewayConfig();
    expect(cfg.llm.apiKey).toBe("ovr-llm-key");
  });

  it("yaml key 压过 env key，且 env 未被采信时不告警", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.TDAI_LLM_API_KEY = "env-llm-key";
    const cfg = loadGatewayConfig();
    expect(cfg.llm.apiKey).toBe("yaml-llm-key");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("仅 env 有 key 时回退生效并发弃用告警（ADR-0006）", () => {
    writeFileSync(yamlPath, [
      "llm:",
      "  baseUrl: https://yaml-llm.example/v1",
      "  model: yaml-llm-model",
      "",
    ].join("\n"), "utf-8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.TDAI_LLM_API_KEY = "env-llm-key-fallback";
    const cfg = loadGatewayConfig();
    expect(cfg.llm.apiKey).toBe("env-llm-key-fallback");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("弃用");
  });

  it("env 占位符 __ARK_KEY__ 视为未设置（落 yaml，不告警）", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.TDAI_LLM_API_KEY = "__ARK_KEY__";
    const cfg = loadGatewayConfig();
    expect(cfg.llm.apiKey).toBe("yaml-llm-key");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("yaml key 为未展开占位符时落 env（发弃用告警）", () => {
    writeFileSync(yamlPath, [
      "llm:",
      "  baseUrl: https://yaml-llm.example/v1",
      '  apiKey: __TDAI_LLM_API_KEY__',
      "  model: yaml-llm-model",
      "",
    ].join("\n"), "utf-8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.TDAI_LLM_API_KEY = "env-llm-key-unexpanded";
    const cfg = loadGatewayConfig();
    expect(cfg.llm.apiKey).toBe("env-llm-key-unexpanded");
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
