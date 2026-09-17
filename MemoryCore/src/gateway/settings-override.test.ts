// src/gateway/settings-override.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettingsOverride, writeSettingsOverride, maskKey, validateOverride, pickDefined } from "./settings-override.js";
import { loadGatewayConfig } from "./config.js";

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
