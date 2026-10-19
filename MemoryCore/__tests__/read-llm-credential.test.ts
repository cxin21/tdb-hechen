// __tests__/read-llm-credential.test.ts
// ADR-0006：LLM 凭据 SoT 收敛到 admin settings（config-override.json）。
// 脚本域统一读取器 readLlmCredential 的优先级与占位符合同。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDeprecatedEnvKeyWarnForTests, readLlmCredential } from "../scripts/lib/read-llm-credential.js";

const savedEnv = new Map<string, string | undefined>();

function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv.set(k, process.env[k]);
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    savedEnv.delete(k);
  }
  vi.restoreAllMocks();
});

function makeYaml(dir: string, llm: Record<string, string>, data?: Record<string, string>): string {
  const lines: string[] = [];
  if (Object.keys(llm).length > 0) {
    lines.push("llm:");
    for (const [k, v] of Object.entries(llm)) lines.push("  " + k + ": " + v);
  }
  if (data) {
    lines.push("data:");
    for (const [k, v] of Object.entries(data)) lines.push("  " + k + ": " + v); // plain 标量：Windows 反斜杠路径不能进双引号（YAML 转义）
  }
  const p = join(dir, "tdai-gateway.yaml");
  writeFileSync(p, lines.join("\n") + "\n", "utf-8");
  return p;
}

function makeOverride(dir: string, llm: Record<string, string>) {
  writeFileSync(join(dir, "config-override.json"), JSON.stringify({ llm }), "utf-8");
}

describe("readLlmCredential（ADR-0006：override > yaml > env-deprecated）", () => {
  beforeEach(() => { _resetDeprecatedEnvKeyWarnForTests(); });
  it("override 优先于 yaml 与 env", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmcred-"));
    try {
      const yamlPath = makeYaml(dir, { baseUrl: "https://yaml.example/v1", apiKey: "yaml-key", model: "yaml-model" });
      makeOverride(dir, { baseUrl: "https://ovr.example/v1", apiKey: "ovr-key", model: "ovr-model" });
      setEnv("TDAI_LLM_BASE_URL", "https://env.example/v1");
      setEnv("TDAI_LLM_API_KEY", "env-key");
      setEnv("TDAI_LLM_MODEL", "env-model");
      const cred = readLlmCredential({ yamlPath, baseDir: dir });
      expect(cred).not.toBeNull();
      expect(cred!.baseUrl).toBe("https://ovr.example/v1");
      expect(cred!.apiKey).toBe("ovr-key");
      expect(cred!.model).toBe("ovr-model");
      expect(cred!.apiKeySource).toBe("override");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("无 override 时 yaml 优先于 env", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmcred-"));
    try {
      const yamlPath = makeYaml(dir, { baseUrl: "https://yaml.example/v1", apiKey: "yaml-key", model: "yaml-model" });
      setEnv("TDAI_LLM_BASE_URL", "https://env.example/v1");
      setEnv("TDAI_LLM_API_KEY", "env-key");
      setEnv("TDAI_LLM_MODEL", "env-model");
      const cred = readLlmCredential({ yamlPath, baseDir: dir });
      expect(cred!.apiKey).toBe("yaml-key");
      expect(cred!.apiKeySource).toBe("yaml");
      expect(cred!.baseUrl).toBe("https://yaml.example/v1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("yaml/override 均缺失时回退 env 并发出弃用告警", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmcred-"));
    try {
      const yamlPath = join(dir, "nonexistent.yaml");
      setEnv("TDAI_LLM_BASE_URL", "https://env.example/v1");
      setEnv("TDAI_LLM_API_KEY", "env-key");
      setEnv("TDAI_LLM_MODEL", "env-model");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const cred = readLlmCredential({ yamlPath, baseDir: dir });
      expect(cred!.apiKey).toBe("env-key");
      expect(cred!.apiKeySource).toBe("env-deprecated");
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("弃用");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("占位符（__X__ / \u0024{X}）视为未设置并落到下一通道", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmcred-"));
    try {
      // env 是 __ARK_KEY__ 占位 → 落到 yaml key，且不告警（env 未被采信）
      const yamlPath = makeYaml(dir, { baseUrl: "https://yaml.example/v1", apiKey: "yaml-key", model: "yaml-model" });
      setEnv("TDAI_LLM_BASE_URL", "https://env.example/v1");
      setEnv("TDAI_LLM_API_KEY", "__ARK_KEY__");
      setEnv("TDAI_LLM_MODEL", "env-model");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(readLlmCredential({ yamlPath, baseDir: dir })!.apiKey).toBe("yaml-key");
      expect(errSpy).not.toHaveBeenCalled();
      // yaml 是 \u0024{TDAI_LLM_API_KEY} 未展开占位 → 落到 env（有告警）
      const yaml2 = makeYaml(dir, { baseUrl: "https://yaml.example/v1", apiKey: "\"\u0024{TDAI_LLM_API_KEY}\"", model: "yaml-model" });
      setEnv("TDAI_LLM_API_KEY", "env-key");
      const cred2 = readLlmCredential({ yamlPath: yaml2, baseDir: dir });
      expect(cred2!.apiKey).toBe("env-key");
      expect(cred2!.apiKeySource).toBe("env-deprecated");
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("三字段缺任一 → null（调用方负责 loud 报错）", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmcred-"));
    try {
      const yamlPath = makeYaml(dir, { baseUrl: "https://yaml.example/v1", apiKey: "yaml-key" }); // 无 model
      setEnv("TDAI_LLM_BASE_URL", undefined);
      setEnv("TDAI_LLM_API_KEY", undefined);
      setEnv("TDAI_LLM_MODEL", undefined);
      expect(readLlmCredential({ yamlPath, baseDir: dir })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("baseDir 缺省回退链：TDAI_DATA_DIR → yaml data.baseDir；显式 opts.baseDir 最优先", () => {
    const root = mkdtempSync(join(tmpdir(), "llmcred-root-"));
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    try {
      const yamlPath = makeYaml(root,
        { baseUrl: "https://yaml.example/v1", apiKey: "yaml-key", model: "yaml-model" },
        { baseDir: dataDir });
      makeOverride(dataDir, { baseUrl: "https://ovr.example/v1", apiKey: "ovr-key", model: "ovr-model" });
      setEnv("TDAI_DATA_DIR", undefined);
      const cred = readLlmCredential({ yamlPath });
      expect(cred!.apiKey).toBe("ovr-key");
      const empty = mkdtempSync(join(tmpdir(), "llmcred-empty-"));
      try {
        const cred2 = readLlmCredential({ yamlPath, baseDir: empty });
        expect(cred2!.apiKey).toBe("yaml-key");
        expect(cred2!.apiKeySource).toBe("yaml");
      } finally { rmSync(empty, { recursive: true, force: true }); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});