/**
 * Metric Producer — core 组件（门面层）
 *
 * 异步发送监控指标消息，由 IMetricBackend 后端处理。
 * 开源/DSH 构建：后端恒为 Noop 或 Console（OTLP / ClickHouse / Kafka / Langfuse
 * 已在 DSH-only 构建中整体退场，见 docs/adr/0021）。
 *
 * 设计要点：
 *   - 异步发送，不阻塞业务请求
 *   - 发送失败静默忽略（不重试、不阻塞）
 *   - 不修改任何业务代码，纯可观测性组件
 *
 * 使用方式：
 *   import { metricProducer } from "../core/report/metric-producer.js";
 *   metricProducer.send({ metric: "l1_extraction_credit_rate", instanceId: "mem-abc", value: 150 });
 */

import { getObservabilityBackend } from "./factory.js";
import type { MetricMessage, MetricBackendConfig } from "./types.js";

export type { MetricMessage } from "./types.js";

/**
 * Metric Producer 门面。
 *
 * - send(msg) — 发送一条指标消息
 * - initialize(config) — 初始化后端
 * - destroy() — 优雅关闭
 *
 * 内部委托给 IMetricBackend（通过全局单例获取）。
 */
class MetricProducerFacade {
  /**
   * 异步发送一条监控消息。
   * 如果后端未初始化或已关闭，静默忽略。
   *
   * 自动注入 traceId（仅当调用方未手动传入时）：trace 传播已随后端一并退场，
   * 这里退化为「后端 tracePropagation 能给出什么就注入什么」，拿不到即空串。
   */
  send(msg: MetricMessage): void {
    try {
      if (msg.traceId === undefined) {
        try {
          const ctx = getObservabilityBackend().tracePropagation.serializeTraceContext();
          msg = { ...msg, traceId: (ctx as Record<string, unknown>)._traceId as string ?? "" };
        } catch {
          msg = { ...msg, traceId: "" };
        }
      }
      getObservabilityBackend().metric.send(msg);
    } catch {
      // 静默失败
    }
  }

  /**
   * 初始化 Metric 后端。
   * 实际初始化由 initObservabilityBackend() 统一完成，此方法保留用于向后兼容。
   */
  async initialize(config: MetricBackendConfig): Promise<void> {
    try {
      await getObservabilityBackend().metric.initialize(config);
    } catch {
      // 静默失败
    }
  }

  /** 优雅关闭。 */
  async destroy(): Promise<void> {
    try {
      await getObservabilityBackend().metric.destroy();
    } catch {
      // 静默失败
    }
  }
}

/** 全局单例 */
export const metricProducer = new MetricProducerFacade();
