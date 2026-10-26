import type { AssetCapabilityFlags } from "../injection/types.js";
import { resolveBearerToken } from "./bearer-token.js";

export const DEFAULT_ASSET_CAPABILITIES: AssetCapabilityFlags = {
  skill: true,
  llm_wiki: true,
  code_graph: true,
  chat_memory: true,
  // Task 6（P1 recall-quality）：wiki JIT 瘦身注入放量位——shadow-first 默认关
  // （false = 现行全量注入）。meta 未返回该参数（旧内核）时也必须停在 false，
  // 不得被 parseEnabled(undefined)=true 的兜底语义误开。
  wiki_jit: false,
};

interface FetchAssetCapabilitiesInput {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  userId?: string | null;
  userKey?: string | null;
  timeoutMs?: number;
  /**
   * Per-call override for `x-tdai-service-id`，优先于 `serviceId`。
   * 多租户部署下，调用方应传从请求路径解析出的 spaceId。
   */
  serviceIdOverride?: string | null;
}

interface ConfigUserGetEnvelope {
  code?: number;
  message?: string;
  data?: {
    items?: Array<{
      param_name?: string;
      effective_value?: string;
    }>;
  };
}

const PARAM_TO_CAPABILITY: Record<string, keyof AssetCapabilityFlags> = {
  "skill.enabled": "skill",
  "llm_wiki.enabled": "llm_wiki",
  "code_graph.enabled": "code_graph",
  "chat_memory.enabled": "chat_memory",
  // Task 6：wiki JIT 瘦身注入放量开关（meta 能力位，同 llm_wiki.enabled 模式）。
  "wiki_jit.enabled": "wiki_jit",
};

function parseEnabled(value: string | undefined): boolean {
  return value === undefined ? true : value === "1" || value.toLowerCase() === "true";
}

/**
 * Fetch per-user asset capability flags from tdai meta ConfigParam.
 * Failure is non-fatal: proxy defaults to all enabled to avoid breaking normal chat.
 */
export async function fetchAssetCapabilities(input: FetchAssetCapabilitiesInput): Promise<AssetCapabilityFlags> {
  const userId = input.userId?.trim();
  if (!userId) return { ...DEFAULT_ASSET_CAPABILITIES };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const headers: Record<string, string> = {
      // I-2 统一化：与 skill/knowledge/meta/memory-bridge 出站同一解析器
      // （env TDAI_GATEWAY_APIKEY > bootstrap 注入的 tdai.apiKey > 传入值）。
      // 此前裸用 input.apiKey，部署侧只配 env 时探针一律 401（非致命但刷屏）。
      "Authorization": `Bearer ${resolveBearerToken(input.apiKey)}`,
      "x-tdai-service-id": input.serviceIdOverride || input.serviceId,
      "content-type": "application/json",
    };
    if (input.userKey) headers["x-tdai-user-key"] = input.userKey;

    const resp = await fetch(`${input.endpoint.replace(/\/+$/, "")}/v3/meta/config/user/get`, {
      method: "POST",
      headers,
      body: JSON.stringify({ user_id: userId, module: "asset_type" }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn(`[asset-capability] HTTP ${resp.status}: ${text.slice(0, 200)}`);
      return { ...DEFAULT_ASSET_CAPABILITIES };
    }

    const env = await resp.json() as ConfigUserGetEnvelope;
    if (env.code !== 0) {
      console.warn(`[asset-capability] envelope error ${env.code}: ${env.message ?? ""}`);
      return { ...DEFAULT_ASSET_CAPABILITIES };
    }

    const out: AssetCapabilityFlags = { ...DEFAULT_ASSET_CAPABILITIES };
    for (const item of env.data?.items ?? []) {
      const cap = item.param_name ? PARAM_TO_CAPABILITY[item.param_name] : undefined;
      if (cap) out[cap] = parseEnabled(item.effective_value);
    }
    return out;
  } catch (err) {
    console.warn(`[asset-capability] fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ...DEFAULT_ASSET_CAPABILITIES };
  } finally {
    clearTimeout(timer);
  }
}
