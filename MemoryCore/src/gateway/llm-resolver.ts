/**
 * LLM provider 解析器 —— 将 yaml 中的 llm 段和 memory systemUser 组合成
 * 内核 runner 直接可用的 {baseUrl, apiKey, model, ...} 配置。
 *
 * DSH 特化（2026-11-01）：唯一保留的模式是 provider="openai"（OpenAI 兼容端点直连），
 * 原 provider="proxy" 分支（把 baseUrl 拼成 `${baseUrl}/proxy/<instanceId>/v1`、
 * apiKey 取 metadata.systemUser.memory.userKey、走 context_proxy 统一鉴权/成本守卫/
 * 可观测链路）已随 MemoryProxy 退出链路整体下线。现在：
 *
 *   - resolveEffectiveLlmConfig：原样返回 llm 配置（不再拼任何路径、不再替换 apiKey）
 *   - llm.provider 仍是 "proxy"（历史配置未改）→ 抛 LlmResolveError，明确告知「已下线」
 *     与修法，而不是静默把请求发到 8096 那个没人监听的端口
 *   - 显式配置缺失（llm.apiKey 为空）→ 抛 LlmResolveError「未配置」，不静默降级
 *
 * 单一职责：本文件只做"计算最终 baseUrl / apiKey"，不新建 runner；调用点
 * （tdai-core 抽取路径、server.ts 启动校验）在构造 runner 前统一调用本函数。
 */

import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";
import type { GatewayMetadataConfig } from "./config.js";
import type { MemorySystemUserConfig } from "../metadata/system-user.js";

export class LlmResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmResolveError";
  }
}

const PROXY_REMOVED_MESSAGE =
  "llm.provider=\"proxy\" 已下线（MemoryProxy 退出链路，DSH 特化 2026-11-01）：" +
  "请把 llm.provider 改为 \"openai\"，并把 llm.baseUrl 指向 OpenAI 兼容端点、" +
  "显式配置 llm.apiKey。内核不再经 context_proxy 转发，也不再使用 memory 系统用户 key。";

const MISSING_API_KEY_MESSAGE =
  "llm.apiKey 未配置：provider=\"proxy\" 下线后内核不再借用 memory 系统用户 key，" +
  "必须在 yaml 的 llm.apiKey（或 config-override.json / 环境变量）里显式配置一把可用的 API Key。";

/**
 * 计算给定 instanceId 下内核 LLM 调用的最终 (baseUrl, apiKey, model, ...)。
 *
 * 现在只剩 standalone 一种形态：返回入参 llm 本身（去掉下方参数只是为了不改动
 * tdai-core.ts / query-expand.ts 这些调用点的签名）。
 *
 * @param llm            gateway yaml 中的 llm 段（provider 恒为 "openai"）
 * @param instanceId     保留参数（原 provider=proxy 时用于拼 /proxy/<iid>/v1）
 * @param memorySystemUser 保留参数（原 provider=proxy 时提供 userKey）
 *
 * @throws {LlmResolveError} provider 仍是 "proxy"（已下线）或 apiKey 缺失（未配置）
 */
export function resolveEffectiveLlmConfig(
  llm: StandaloneLLMConfig,
  _instanceId: string | undefined,
  _memorySystemUser: MemorySystemUserConfig | undefined,
): StandaloneLLMConfig {
  // provider 的配置面已收窄到 "openai"，但 yaml 里可能仍写着 "proxy"，
  // 故按宽类型读出再判定，给出可执行的修法文案而不是静默降级。
  const provider = (llm as { provider?: string }).provider ?? "openai";
  if (provider === "proxy") {
    throw new LlmResolveError(PROXY_REMOVED_MESSAGE);
  }
  if (!llm.apiKey) {
    throw new LlmResolveError(MISSING_API_KEY_MESSAGE);
  }
  return llm;
}

/**
 * 只做校验、不返回配置 —— 用于启动期"fail-fast"检查。
 *
 * 校验项只剩两条：provider 不得是已下线的 "proxy"；llm.apiKey 必须已配置。
 * 原「provider=proxy 时校验 metadata.systemUser.memory（userId + userKey，sk-mem- 格式）」
 * 一段随 proxy 下线删除。
 */
export function validateLlmProviderConfig(
  llm: StandaloneLLMConfig,
  _metadata: GatewayMetadataConfig,
): void {
  if ((llm as { provider?: string }).provider === "proxy") {
    throw new LlmResolveError(PROXY_REMOVED_MESSAGE);
  }
  if (!llm.apiKey) {
    throw new LlmResolveError(MISSING_API_KEY_MESSAGE);
  }
}
