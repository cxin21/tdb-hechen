/**
 * P1 召回质量（spec §4.1/§4.2，task-1）：召回精排 reranker 接口与公共类型。
 *
 * 合同（spec §4.1）：`rerank(query, docs)` 返回按 score 降序的 `[{index, score}]`；
 * 返回 null = reranker 不可用/调用失败——调用方（Task 2 接线层）必须降级为
 * 原序（Mem0 模式），精排永不阻断召回主链路。index 恒指入参 docs 的原始下标。
 *
 * provider id 枚举（spec §4.3）：siliconflow | dashscope | local | none。
 * `local` 是合法可插拔 id（Task 3 transformers.js 本地模型），config 层接受，
 * 工厂层在落地前显式返回 null（见 factory.ts）。
 */

/** 单条精排结果：index=入参 docs 原始下标；score=provider 原始相关度分（不归一）。 */
export interface RerankResult {
  index: number;
  score: number;
}

/** spec §4.1 精排器统一接口（云端/local 各 provider adapter 均实现此接口）。 */
export interface MemoryReranker {
  rerank(query: string, docs: string[]): Promise<RerankResult[] | null>;
}

export type RerankProviderId = "siliconflow" | "dashscope" | "local" | "none";

/**
 * 云端 provider adapter 公共构造项。fetchImpl 依赖注入（缺省 globalThis.fetch）——
 * 合同测试与未来代理链路注入点；apiKey 必填（config 校验已在解析期把关）。
 */
export interface CloudRerankerOptions {
  apiKey: string;
  /** 缺省 = provider 官方端点（各 adapter 常量）。业务空间/反代场景显式覆盖。 */
  baseUrl?: string;
  /** 缺省 = provider 推荐档（各 adapter 常量）。 */
  model?: string;
  /** 单次 HTTP 超时毫秒（缺省 800，spec §4.3）。 */
  timeoutMs?: number;
  /** 依赖注入 fetch（缺省 globalThis.fetch）。 */
  fetchImpl?: typeof fetch;
}
