/**
 * 内核侧的 LLM provider 解析器 —— 不依赖 gateway 层。
 *
 * DSH 特化（2026-11-01，ADR-0020）：`provider="proxy"`（走 context_proxy 的
 * `${baseUrl}/proxy/<iid>/v1` + memory 系统用户 `sk-mem-*` key）已随 MemoryProxy
 * 整包退场而消失。现在只剩一种取值：OpenAI 兼容端点直连（provider="openai"），
 * 因此本解析器不再做任何 URL/apiKey 变形 —— 它退化成一个**显式的不变式检查点**：
 * 配置必须已经带上 baseUrl + apiKey，否则抛错（fail loud，而不是悄悄发到错的地址）。
 *
 * 保留文件与两个导出名（`resolveStandaloneLlmForRuntime` / `LlmProviderResolveError`）
 * 是为了不动 5 个调用点（`core/tdai-core.ts`、`gateway/server.ts` ×3、
 * `core/recall/query-expand.ts`）；语义已从"变形"收窄为"校验"。
 *
 * 启动期校验另有 `gateway/llm-resolver.ts`（更早、更严，带修法文案）；本文件负责
 * core 内部的运行期快照，二者共享同一套字段语义。
 */

import type { StandaloneLLMConfig } from "./llm-runner.js";

export class LlmProviderResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmProviderResolveError";
  }
}

const PROXY_REMOVED_HINT =
  "llm.provider=proxy has been removed (MemoryProxy retired, DSH-only build). " +
  'Set llm.provider="openai" and give llm.baseUrl + llm.apiKey of an OpenAI-compatible endpoint.';

/**
 * 返回可直接用于 `StandaloneLLMRunner` 的配置。
 *
 * @param llm          core 侧 llm 配置（gateway loader 已填充）
 * @param _instanceId  历史参数（proxy 时代用于拼 `/proxy/<iid>/v1`），保留签名不改调用点
 */
export function resolveStandaloneLlmForRuntime(
  llm: StandaloneLLMConfig,
  _instanceId?: string,
): StandaloneLLMConfig {
  const provider = (llm as { provider?: string }).provider ?? "openai";
  if (provider === "proxy") {
    throw new LlmProviderResolveError(PROXY_REMOVED_HINT);
  }
  if (provider !== "openai") {
    throw new LlmProviderResolveError(
      `llm.provider="${provider}" is not supported: the DSH-only build supports "openai" (OpenAI-compatible endpoint) only.`,
    );
  }
  if (!llm.baseUrl || !llm.baseUrl.trim()) {
    throw new LlmProviderResolveError(
      "llm.baseUrl is required: set llm.baseUrl to the OpenAI-compatible endpoint root (e.g. https://api.deepseek.com/v1).",
    );
  }
  if (!llm.apiKey || !llm.apiKey.trim()) {
    throw new LlmProviderResolveError(
      "llm.apiKey is required: set llm.apiKey (or env TDAI_LLM_API_KEY) for the OpenAI-compatible endpoint.",
    );
  }
  return llm;
}