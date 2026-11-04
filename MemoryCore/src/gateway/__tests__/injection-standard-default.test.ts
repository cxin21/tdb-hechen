// src/gateway/__tests__/injection-standard-default.test.ts
// ADR-0024 增补四（2026-11-04）：注入预算标准档 2400 → 6000 的**配置解析级**契约。
// 90 题 LME oracle 实测给出三臂：6000 档 83/90、80/90，2400 档同码 74/90；
// 缺省已改 6000，但生产 config-override.json 顶层仍钉着 injection.maxChars=2400，
// 由 applyInjectionOverrideToRaw（src/gateway/config.ts:326-341）在 parseConfig 之前
// 盖进 recall.injection —— 优先级高于代码缺省。本文件把两条语义钉死：
//   ① 没有任何显式注入预算（yaml 无 injection 段、override 无 injection 键）→ 标准档 6000；
//   ② 显式 pin（override injection.maxChars=2400 或 null）仍按显式值生效——回滚通道不封。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSettingsOverride } from "../settings-override.js";
import { loadGatewayConfig } from "../config.js";

const ENV_KEYS = [
  "TDAI_GATEWAY_CONFIG",
  "TDAI_DATA_DIR",
  "TDAI_LLM_PROVIDER",
  "TDAI_LLM_BASE_URL",
  "TDAI_LLM_API_KEY",
  "TDAI_LLM_MODEL",
  "TDAI_EMBEDDING_PROVIDER",
  "TDAI_EMBEDDING_BASE_URL",
  "TDAI_EMBEDDING_API_KEY",
  "TDAI_EMBEDDING_MODEL",
  "TDAI_EMBEDDING_DIMENSIONS",
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "core-inj-std-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeMinimalYaml(): void {
  writeFileSync(
    join(dir, "tdai-gateway.yaml"),
    [
      "memory:",
      "  embedding:",
      '    provider: "openai_compatible"',
      "    baseUrl: https://ark.example/api/v3",
      "    apiKey: test-emb-key",
      "    model: doubao-embedding-test",
      "    dimensions: 2048",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function withEnv(fn: () => void): void {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]] as const));
  for (const k of ENV_KEYS) if (k !== "TDAI_GATEWAY_CONFIG" && k !== "TDAI_DATA_DIR") delete process.env[k];
  process.env.TDAI_GATEWAY_CONFIG = join(dir, "tdai-gateway.yaml");
  process.env.TDAI_DATA_DIR = dir;
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("注入预算标准档（ADR-0024 增补四）", () => {
  it("无显式注入预算 → 代码缺省 6000（2K/4K 探针证明 4000 不足、6000 与 12000 同档）", () => {
    writeMinimalYaml();
    writeSettingsOverride(dir, { llm: { baseUrl: "https://x.example/v1", model: "m" } });
    withEnv(() => {
      const cfg = loadGatewayConfig();
      expect(cfg.memory.recall.injection?.maxChars).toBe(6000);
    });
  });

  it("override 显式 pin 2400 仍然生效（生产现网形态；显式值优先于缺省，回滚通道不封）", () => {
    writeMinimalYaml();
    writeSettingsOverride(dir, { injection: { maxChars: 2400 } });
    withEnv(() => {
      const cfg = loadGatewayConfig();
      expect(cfg.memory.recall.injection?.maxChars).toBe(2400);
    });
  });

  it("override 显式 null 仍然表示不限（唯一的不封顶回滚通道）", () => {
    writeMinimalYaml();
    writeSettingsOverride(dir, { injection: { maxChars: null } });
    withEnv(() => {
      const cfg = loadGatewayConfig();
      expect(cfg.memory.recall.injection?.maxChars).toBeNull();
    });
  });
});
