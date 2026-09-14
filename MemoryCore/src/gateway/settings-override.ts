/**
 * Admin settings override — {baseDir}/config-override.json 的读写/校验。
 * 优先级：override > TDAI_LLM_* env > tdai-gateway.yaml（spec §3.2）——
 * 管理员显式意图优先级最高，高于环境变量与 yaml 配置。仅覆盖 llm / embedding 两段。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface LlmSettingsOverride {
  baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number; timeoutMs?: number;
}
export interface EmbeddingSettingsOverride {
  provider?: string; baseUrl?: string; apiKey?: string; model?: string; dimensions?: number;
  sendDimensions?: boolean;
}
export interface SettingsOverride {
  llm?: LlmSettingsOverride;
  embedding?: EmbeddingSettingsOverride;
}

const OVERRIDE_FILE = "config-override.json";
const HTTP_URL_RE = /^https?:\/\/.+/i;

export function readSettingsOverride(dataDir: string): SettingsOverride | null {
  const p = join(dataDir, OVERRIDE_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SettingsOverride;
  } catch {
    return null; // 损坏文件按无 override 处理，服务可正常启动
  }
}

/** 原子写：tmp + rename，避免半写文件被下次启动读到。 */
export function writeSettingsOverride(dataDir: string, o: SettingsOverride): void {
  const p = join(dataDir, OVERRIDE_FILE);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(o, null, 2), "utf-8");
  renameSync(tmp, p);
}

/** 只保留非 undefined 字段：override 中 undefined 不覆盖 base。 */
export function pickDefined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function maskKey(key: string | undefined): { hasApiKey: boolean; apiKeyMasked: string } {
  if (!key) return { hasApiKey: false, apiKeyMasked: "" };
  return { hasApiKey: true, apiKeyMasked: key.length <= 4 ? "****" : `****${key.slice(-4)}` };
}

export function validateOverride(body: unknown): { ok: true; value: SettingsOverride } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const out: SettingsOverride = {};
  const b = (body ?? {}) as Record<string, any>;
  if (b.llm) {
    const llm: LlmSettingsOverride = {};
    if (b.llm.baseUrl !== undefined) {
      if (typeof b.llm.baseUrl === "string" && HTTP_URL_RE.test(b.llm.baseUrl)) llm.baseUrl = b.llm.baseUrl;
      else errors.push("llm.baseUrl 必须是合法 http(s) URL");
    }
    if (b.llm.apiKey !== undefined) {
      if (typeof b.llm.apiKey === "string") llm.apiKey = b.llm.apiKey;
      else errors.push("llm.apiKey 必须是字符串");
    }
    if (b.llm.model !== undefined) {
      if (typeof b.llm.model === "string" && b.llm.model.trim()) llm.model = b.llm.model.trim();
      else errors.push("llm.model 必须是非空字符串");
    }
    for (const intField of ["maxTokens", "timeoutMs"] as const) {
      if (b.llm[intField] !== undefined) {
        const n = Number(b.llm[intField]);
        if (Number.isInteger(n) && n > 0) llm[intField] = n;
        else errors.push(`llm.${intField} 必须是正整数`);
      }
    }
    if (Object.keys(llm).length) out.llm = llm;
  }
  if (b.embedding) {
    const emb: EmbeddingSettingsOverride = {};
    for (const strField of ["provider", "baseUrl", "apiKey", "model"] as const) {
      if (b.embedding[strField] !== undefined) {
        if (typeof b.embedding[strField] === "string") emb[strField] = b.embedding[strField];
        else errors.push(`embedding.${strField} 必须是字符串`);
      }
    }
    if (emb.baseUrl !== undefined && !HTTP_URL_RE.test(emb.baseUrl)) errors.push("embedding.baseUrl 必须是合法 http(s) URL");
    if (emb.model !== undefined && !emb.model.trim()) errors.push("embedding.model 必须是非空字符串");
    if (b.embedding.dimensions !== undefined) {
      const n = Number(b.embedding.dimensions);
      if (Number.isInteger(n) && n > 0) emb.dimensions = n;
      else errors.push("embedding.dimensions 必须是正整数");
    }
    if (b.embedding.sendDimensions !== undefined) {
      if (typeof b.embedding.sendDimensions === "boolean") emb.sendDimensions = b.embedding.sendDimensions;
      else errors.push("embedding.sendDimensions 必须是 boolean");
    }
    if (Object.keys(emb).length) out.embedding = emb;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: out };
}
