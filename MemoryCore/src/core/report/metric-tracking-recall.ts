/**
 * Recall Metric Reporter — 召回阶段指标上报。
 *
 * 在召回完成后非侵入式上报以下指标到 Kafka：
 *   - recall_hit_count   : 本次召回命中的 L1 记忆条数
 *   - recall_top_score   : 召回结果中最高相似度分数（TCVDB RRF score）
 *   - recall_latency_ms  : 召回总耗时（毫秒，整数）
 *
 * 设计原则（与 MetricTrackingRunner 完全同构）：
 *   1. 召回完成后，try-catch 做上报（静默失败）
 *   2. 无论上报成功失败，不影响召回结果
 *   3. 召回失败（hasError=true）时不上报
 *   4. 无 instanceId 时不上报
 *   5. 召回 0 条时仍上报 hit_count=0 + latency，但不上报 top_score
 */

import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// Strategy Encoding (numeric for ClickHouse storage)
// ============================

const STRATEGY_CODE: Record<string, number> = {
  skipped: 0,
  keyword: 1,
  embedding: 2,
  hybrid: 3,
};

// ============================
// Input Interface
// ============================

export interface RecallMetricInput {
  /** 实例 ID（Kafka key） */
  instanceId: string;
  /** 召回的 L1 记忆列表（带 score） */
  recalledL1Memories: Array<{ content: string; score: number; type: string }> | undefined;
  /** 生效的召回策略 */
  recallStrategy: string;
  /** 召回总耗时（毫秒） */
  recallLatencyMs: number;
  /** 是否召回失败 */
  hasError: boolean;
  // ── task-100（2026-11-01）：预算内降级观测面（全部可选；老调用方不传 = 不报，逐位旧行为）──
  /** 向量腿是否降级：'fts' = 超预算只用了 FTS 腿；null/undefined = 未降级 */
  degraded?: "fts" | null;
  /** L1 层实际耗时（毫秒） */
  l1Ms?: number;
  /** query embedding 进程内缓存的本请求增量（不是累计值） */
  embedCache?: { hits: number; misses: number };
}

// ============================
// Reporter
// ============================

/**
 * 上报召回阶段指标到 Kafka。
 *
 * 静默安全：任何异常都 try-catch 吞掉，绝不向外抛。
 * 调用时机：在 performAutoRecallCore 返回后、结果传给业务前调用。
 */
export function reportRecallMetrics(input: RecallMetricInput): void {
  try {
    // Guard: 失败时不上报
    if (input.hasError) return;

    // Guard: 无 instanceId 不上报
    if (!input.instanceId) return;

    const memories = input.recalledL1Memories ?? [];
    const hitCount = memories.length;
    const latencyMs = Math.round(input.recallLatencyMs);

    // 1. 上报 recall_hit_count（含 0 条场景）
    try {
      metricProducer.send({
        metric: "recall_hit_count",
        instanceId: input.instanceId,
        value: hitCount,
        source: "core",
      });
    } catch {
      // 静默失败
    }

    // 2. 上报 recall_top_score（仅有记忆时）
    if (hitCount > 0) {
      try {
        const topScore = Math.max(...memories.map((m) => m.score));
        metricProducer.send({
          metric: "recall_top_score",
          instanceId: input.instanceId,
          value: topScore,
          source: "core",
        });
      } catch {
        // 静默失败
      }
    }

    // 3. 上报 recall_latency_ms
    try {
      metricProducer.send({
        metric: "recall_latency_ms",
        instanceId: input.instanceId,
        value: latencyMs,
        source: "core",
      });
    } catch {
      // 静默失败
    }

    // 4. 上报 recall_strategy（数值编码：skipped=0, keyword=1, embedding=2, hybrid=3, 未知=-1）
    try {
      const strategyCode = STRATEGY_CODE[input.recallStrategy] ?? -1;
      metricProducer.send({
        metric: "recall_strategy",
        instanceId: input.instanceId,
        value: strategyCode,
        source: "core",
      });
    } catch {
      // 静默失败
    }

    // ── task-100：降级 / L1 分段耗时 / embedding 缓存命中（度量名独立，不带 label）──
    // 注：MetricMessage 无 tags 字段（kafka-metric-producer.ts:69），票面写的
    // recall.degraded.total{reason} 这种 label 形态在此通道表达不了 ⇒ 用独立度量名：
    //   recall_degraded_total  = 1 表示本轮降级为 fts，0 表示未降级（按 series 聚合即比例）
    //   recall_l1_ms           = L1 层耗时（含向量腿，降级轮 = 预算值）
    //   recall_embed_cache_hits / recall_embed_cache_misses = 每请求增量
    if (input.degraded !== undefined) {
      try {
        metricProducer.send({
          metric: "recall_degraded_total",
          instanceId: input.instanceId,
          value: input.degraded === "fts" ? 1 : 0,
          source: "core",
        });
      } catch {
        // 静默失败
      }
    }
    if (typeof input.l1Ms === "number" && Number.isFinite(input.l1Ms)) {
      try {
        metricProducer.send({
          metric: "recall_l1_ms",
          instanceId: input.instanceId,
          value: Math.round(input.l1Ms),
          source: "core",
        });
      } catch {
        // 静默失败
      }
    }
    if (input.embedCache) {
      try {
        metricProducer.send({
          metric: "recall_embed_cache_hits",
          instanceId: input.instanceId,
          value: input.embedCache.hits,
          source: "core",
        });
        metricProducer.send({
          metric: "recall_embed_cache_misses",
          instanceId: input.instanceId,
          value: input.embedCache.misses,
          source: "core",
        });
      } catch {
        // 静默失败
      }
    }
  } catch {
    // 最外层 catch — 绝不向外抛
  }
}
