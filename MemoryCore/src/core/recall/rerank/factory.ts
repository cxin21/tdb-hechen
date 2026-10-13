/**
 * P1 召回质量（spec §4.3，task-1）：rerank provider 工厂——config → MemoryReranker。
 *
 * 路由合同（spec §4.3 / brief）：enabled=false、provider=none、未配置 → null
 * （=skip，调用方降级现状，零行为变化）；siliconflow/dashscope → 对应云端 adapter；
 * **provider='local' → null（当前显式占位）**——config 层合法接受该可插拔 id
 * （校验不报错），Task 3 实现 transformers.js 本地 reranker 后在本函数单一
 * 位置接入（届时删本注释并替换为 LocalReranker 构造）。
 * config 校验失败（云端缺 apiKey 等）时 parseConfig 已强制 enabled=false，
 * 这里自然落到 null（双保险，不重复实现校验）。
 */
import type { RecallRerankConfig } from "../../../config.js";
import { DashscopeReranker } from "./dashscope.js";
import { SiliconflowReranker } from "./siliconflow.js";
import type { MemoryReranker } from "./types.js";

export interface RerankerFactoryOpts {
  /** 依赖注入 fetch（测试/代理链路用；缺省 globalThis.fetch）。 */
  fetchImpl?: typeof fetch;
}

export function createReranker(config: RecallRerankConfig, opts?: RerankerFactoryOpts): MemoryReranker | null {
  if (!config?.enabled) return null;
  switch (config.provider) {
    case "siliconflow":
      return new SiliconflowReranker({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || undefined,
        model: config.model || undefined,
        timeoutMs: config.timeoutMs,
        fetchImpl: opts?.fetchImpl,
      });
    case "dashscope":
      return new DashscopeReranker({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || undefined,
        model: config.model || undefined,
        timeoutMs: config.timeoutMs,
        fetchImpl: opts?.fetchImpl,
      });
    case "local":
      // Task 3（本地 transformers.js reranker）接入位：config 已合法接受 provider:"local"，
      // 落地前显式 null = 降级原序（宁缺毋滥，不静默走云端）。
      return null;
    case "none":
    default:
      return null;
  }
}
