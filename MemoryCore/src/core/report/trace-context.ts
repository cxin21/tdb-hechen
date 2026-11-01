/**
 * Trace context 门面（DSH-only 构建）。
 *
 * 历史背景：这里原本是 OTel / Langfuse / ClickHouse 三条 trace 通路的传播层。
 * 这些后端已在 DSH-only 构建中整体退场（docs/adr/0021），因此本模块不再持有
 * 任何 trace 上下文实现，只保留一个「从可观测性后端取当前 trace 上下文」的门面，
 * 供任务负载（L1/L2 任务 data）做透传。后端为 noop/console 时返回 `{}`，
 * 展开到任务 data 上等于不增加任何字段——与退场前的行为一致。
 */

import { getObservabilityBackend } from "./factory.js";

/**
 * 序列化当前 trace 上下文（用于跨任务/跨队列传播）。
 * 任何异常都降级为 `{}`：可观测性永远不得影响业务链路。
 */
export function serializeTraceContext(): Record<string, unknown> {
  try {
    const ctx = getObservabilityBackend().tracePropagation.serializeTraceContext();
    return (ctx ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}
