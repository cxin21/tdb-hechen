/**
 * LLM 凭据统一读取器（ADR-0006，#70）——运维脚本 / 一次性工具专用。
 *
 * 服务凭据唯一 SoT = admin settings（config-override.json，settings-override 机制）。
 * 读取优先级：override（baseDir/config-override.json 的 llm 段）> gateway yaml 的 llm 段
 * > TDAI_LLM_* env（deprecated 回退；apiKey 走此通道时 loud 告警一次/值）。
 *
 * baseDir 解析：opts.baseDir → TDAI_DATA_DIR env → yaml data.baseDir。
 * 占位符（__X__ / ${X}，云模板未替换/未展开标记）视为未设置（src/utils/credential.ts）。
 *
 * 返回 null = 三字段（baseUrl/apiKey/model）不齐 —— 调用方负责 loud 报错，
 * 缺凭据 fail-fast，不静默降级。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { isSetCredential } from "../../src/utils/credential.js";

export interface LlmCredential {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 生成 token 上限（override/yaml 透传；0=不限制，reasoning 模型）；未配置则缺省 */
  maxTokens?: number;
  /** LLM 调用超时毫秒（override/yaml 透传）；未配置则缺省 */
  timeoutMs?: number;
  /** apiKey 实际采信通道（凭据的敏感面只在 key） */
  apiKeySource: "override" | "yaml" | "env-deprecated";
}

export interface ReadLlmCredentialOptions {
  /** gateway yaml 路径；缺省 = 本仓库 MemoryCore/tdai-gateway.yaml */
  yamlPath?: string;
  /** config-override.json 所在目录；缺省 = TDAI_DATA_DIR env → yaml data.baseDir */
  baseDir?: string;
  /** 测试钩子：注入 env 快照（缺省读真实 process.env） */
  env?: Record<string, string | undefined>;
}

const REPO_YAML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tdai-gateway.yaml");

let warnedEnvKey: string | null = null;
function warnDeprecatedEnvKey(value: string): void {
  if (warnedEnvKey === value) return;
  warnedEnvKey = value;
  console.error(
    "[read-llm-credential] TDAI_LLM_API_KEY 已弃用（ADR-0006）：LLM 凭据 SoT=admin settings（config-override.json）。" +
      "本次回退读取 env，请尽快迁移：写入 <dataDir>/config-override.json 的 llm 段，或经 admin settings UI 设置。",
  );
}

/** 测试专用：重置弃用告警去重状态。 */
export function _resetDeprecatedEnvKeyWarnForTests(): void {
  warnedEnvKey = null;
}

export function readLlmCredential(opts: ReadLlmCredentialOptions = {}): LlmCredential | null {
  const env = opts.env ?? process.env;
  const yamlPath = opts.yamlPath ?? REPO_YAML;

  let yamlLlm: Record<string, unknown> = {};
  let yamlDataBaseDir: string | undefined;
  try {
    const doc: unknown = YAML.parse(fs.readFileSync(yamlPath, "utf8"));
    if (doc && typeof doc === "object") {
      const obj = doc as Record<string, unknown>;
      if (obj.llm && typeof obj.llm === "object") yamlLlm = obj.llm as Record<string, unknown>;
      const data = obj.data;
      const bd = data && typeof data === "object" ? (data as Record<string, unknown>).baseDir : undefined;
      if (typeof bd === "string" && bd.trim() !== "") {
        yamlDataBaseDir = bd.startsWith("~") ? path.join(os.homedir(), bd.slice(1)) : bd;
      }
    }
  } catch {
    // yaml 缺失/损坏 → 视为无 yaml 通道（不炸，交给 env/override 或最终 null）
  }

  const envDataDir = env["TDAI_DATA_DIR"]?.trim();
  const baseDir = opts.baseDir ?? (envDataDir ? envDataDir : yamlDataBaseDir);

  let overrideLlm: Record<string, unknown> = {};
  if (baseDir) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(baseDir, "config-override.json"), "utf8"));
      if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        if (obj.llm && typeof obj.llm === "object") overrideLlm = obj.llm as Record<string, unknown>;
      }
    } catch {
      // 无 override → 空
    }
  }

  const channels: Array<{ field: "baseUrl" | "apiKey" | "model"; envKey: string }> = [
    { field: "baseUrl", envKey: "TDAI_LLM_BASE_URL" },
    { field: "apiKey", envKey: "TDAI_LLM_API_KEY" },
    { field: "model", envKey: "TDAI_LLM_MODEL" },
  ];
  const out: Partial<Record<"baseUrl" | "apiKey" | "model", string>> = {};
  let apiKeySource: LlmCredential["apiKeySource"] | undefined;
  for (const { field, envKey } of channels) {
    if (isSetCredential(overrideLlm[field])) {
      out[field] = String(overrideLlm[field]).trim();
      if (field === "apiKey") apiKeySource = "override";
      continue;
    }
    if (isSetCredential(yamlLlm[field])) {
      out[field] = String(yamlLlm[field]).trim();
      if (field === "apiKey") apiKeySource = "yaml";
      continue;
    }
    const ev = env[envKey];
    if (isSetCredential(ev)) {
      out[field] = ev.trim();
      if (field === "apiKey") {
        apiKeySource = "env-deprecated";
        warnDeprecatedEnvKey(out[field]);
      }
    }
  }

  if (!isSetCredential(out.baseUrl) || !isSetCredential(out.apiKey) || !isSetCredential(out.model)) return null;

  // 数值行为参数（maxTokens/timeoutMs）：override > yaml > TDAI_LLM_* env（数字）；
  // 0 是合法值（maxTokens 0=不限制），判缺口必须用 nullish/空串判断而非真值。
  const pickNumber = (field: string, envKey: string): number | undefined => {
    for (const src of [overrideLlm[field], yamlLlm[field], env[envKey]]) {
      if (src === undefined || src === null || src === "") continue;
      const n = typeof src === "number" ? src : Number(String(src).trim());
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };
  const maxTokens = pickNumber("maxTokens", "TDAI_LLM_MAX_TOKENS");
  const timeoutMs = pickNumber("timeoutMs", "TDAI_LLM_TIMEOUT_MS");
  return {
    baseUrl: out.baseUrl, apiKey: out.apiKey, model: out.model, apiKeySource: apiKeySource!,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}