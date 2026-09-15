/**
 * H+I 接线：网关侧周期调度器 —— 定期跑巩固(consolidation, 可持久化持续态) + 遗忘判定(forgetting)。
 * best-effort、配置门(memory.lifecycle)、可整体关停；失败只记日志不抛。
 */
import type { IMemoryStore } from "../store/types.js";
import type { LLMRunner, Logger } from "../types.js";
import { runConsolidation, type ConsolidationConfigX } from "./consolidation/consolidation-worker.js";
import { runForgetting, type ForgettingConfig } from "./forgetting/forgetting-worker.js";
import { runAnchorGrowth, type AnchorDiscoveryConfig } from "./anchor-growth.js";

export interface LifecycleConfig {
  enabled: boolean;
  intervalMs: number;
  consolidation?: ConsolidationConfigX;
  forgetting?: ForgettingConfig;
  /**
   * GROW（价值锚自生长）：巩固周期后挂钩的自发现+自动采纳。
   * 缺省 undefined → 默认开（DEFAULT_ANCHOR_DISCOVERY_CONFIG，enabled=true）——
   * 与 consolidation/forgetting 同款"缺省开"语义；LLM runner 缺失时安静跳过。
   * PA：自生长 per-agent 化——遍历有记忆的 distinct agent 三元组（anchor-growth 内部
   * 枚举，不受本 filter 影响；旧 store 无枚举能力时回退 default 单桶）。
   */
  anchorDiscovery?: AnchorDiscoveryConfig;
  /** 审计 C：租户隔离 filter。缺省不传（退化为全部数据，保持兼容）；多租户部署应显式传入。
   *  P2-T14（H-B2）：字段全可选 + 增 taskId，与 MemoryLifecycleConfig.filter 同形。 */
  filter?: { teamId?: string; userId?: string; agentId?: string; taskId?: string };
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  enabled: true,
  intervalMs: 10 * 60_000,
};

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * P3-T17.5（R5 第四实例源头修复）：queryL1 行 → MemoryRecord 消费形状的映射。
 *
 * 行形状契约：MemoryRecord 消费方（consolidation 幂等/evidence_ids、forgetting archiveL1、
 * scorer 的 metadata 兜底）需要 id 与完整 metadata。此前本映射不映射 id（record_id 丢失）、
 * metadata 只填两个派生值（丢弃 metadata_json 全部内容——significance/recall_count/subject
 * 全部死读）、且派生空串 ?? "" 会盖真值（F-2 教训）。修法：
 *   - id 兜底 = record_id（根治点 1）；
 *   - metadata_json 解析合并进 metadata（容忍失败 → {}，不造假值）；
 *   - 派生值仅在真值时合并（空串不入 metadata——空串无信息量，不得覆盖 json 真值）。
 * 导出供 verify-p3-t17-5 同形断言直接驱动真实映射（不再复刻副本）。
 */
export function mapL1RowToRecord(r: Record<string, unknown>): Record<string, unknown> {
  const rec = r as {
    record_id?: string; team_id?: string; user_id?: string; agent_id?: string; task_id?: string;
    timestamp_start?: string; timestamp_str?: string; occurred_at?: string; metadata?: object; metadata_json?: string;
  };
  const parsedMeta = (() => {
    try { return JSON.parse(rec.metadata_json ?? "{}") as Record<string, unknown>; } catch { return {}; }
  })();
  const derived: Record<string, unknown> = {};
  if (rec.timestamp_start) derived.activity_start_time = rec.timestamp_start;
  if (rec.occurred_at) derived.occurred_at = rec.occurred_at;
  return {
    ...rec,
    id: rec.record_id, // ← 根治点 1：id 兜底（消费方 archiveL1/幂等都靠它）
    teamId: rec.team_id,
    userId: rec.user_id,
    agentId: rec.agent_id,
    taskId: rec.task_id,
    timestamps: [rec.timestamp_start ?? rec.timestamp_str ?? ""].filter(Boolean),
    metadata: {
      ...parsedMeta,
      ...(rec.metadata ?? {}), // 保留行上原有 metadata 字段（非 store 裸行来源兼容）
      ...derived,
    },
  };
}

async function runOnce(deps: { store: IMemoryStore; llmRunner: LLMRunner; config: LifecycleConfig; logger?: Logger }): Promise<void> {
  const now = new Date().toISOString();
  deps.logger?.info?.(`[lifecycle] tick ${now}`);
  const queryL1 = async () => {
    // 审计 C：租户 filter 透传（缺省 undefined 保持旧行为；多租户部署由调用方传 filter）
    const recs = await deps.store.queryL1Records?.(deps.config.filter);
    // 补时间/元数据：让 consolidation(跨期) 与 forgetting(年龄衰减) 真正能算
    // P2-T14（H-B2）：补 teamId/userId/agentId/taskId 派生——L1RecordRow 是 snake_case，
    // 而 consolidation 的租户继承（inheritTenancy）与 grouping 的组内租户校验读 camelCase；
    // 缺了这三个字段，持续态归属会退化为空（跨租户摘要无法被隔离查询召回）。
    // P3-T17.5：行映射根治（id + metadata_json 解析 + 空串不盖真值），见 mapL1RowToRecord。
    return (recs ?? []).map((r) => mapL1RowToRecord(r as Record<string, unknown>));
  };
  if (deps.config.consolidation?.enabled !== false) {
    try {
      const res = await runConsolidation({
        queryL1: async () => (await queryL1()) as never,
        llmRunner: deps.llmRunner,
        config: deps.config.consolidation,
        logger: deps.logger,
        store: deps.store,
        // P2-T14（H-B2）：写路径带同一 filter——源记忆租户缺失时，持续态归属兜底为 filter 值
        filter: deps.config.filter,
      });
      deps.logger?.info?.(`[lifecycle] consolidation groups=${res.groupsFound} persisted=${res.persisted}`);
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (deps.config.forgetting?.enabled !== false) {
    try {
      const res = await runForgetting({ queryL1: async () => (await queryL1()) as never, config: deps.config.forgetting, logger: deps.logger, store: deps.store });
      deps.logger?.info?.(`[lifecycle] forgetting candidates=${res.candidates.length} archived=${res.archived}`);
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] forgetting failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // SOUL（身份自发现）：anchor-growth 同款模式——扫描对话→LLM 提案→分级门→core_memory slots。
  // GROW-EVO P2.1：与价值锚共用 llmRunner；identity slot 自动采纳，core_value/strict_rule pending。
  if (deps.config.anchorDiscovery?.enabled !== false) {
    try {
      const { runIdentityDiscovery } = await import("./identity-discovery.js");
      const res = await runIdentityDiscovery({
        store: deps.store,
        llmRunner: deps.llmRunner,
        config: deps.config.anchorDiscovery,
        logger: deps.logger,
      });
      if (res.ran) {
        deps.logger?.info?.(`[lifecycle] identity-discovery adopted=${res.adopted} pending=${res.pending}`);
      }
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] identity-discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // GROW（价值锚自生长）：巩固周期后挂钩。触发双门（interval 24h + 语料新增）在
  // runAnchorGrowth 内部短路——未到点零 LLM 调用零额外语料查询；LLM runner 缺失
  // （consolidation 同款门）安静跳过。PA：per-agent 化——逐有记忆 agent 三元组跑发现
  // 循环（LLM 成本 = agent 数 × 发现轮；旧 store 无枚举能力回退 default 单桶）。
  if (deps.config.anchorDiscovery?.enabled !== false) {
    try {
      const res = await runAnchorGrowth({
        store: deps.store,
        llmRunner: deps.llmRunner,
        config: deps.config.anchorDiscovery,
        logger: deps.logger,
      });
      if (res.ran) {
        deps.logger?.info?.(`[lifecycle] anchor-growth adopted=${res.adopted} retired=${res.retired} reweighted=${res.reweighted} displaced=${res.displaced} skipped=${res.skipped}`);
      }
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] anchor-growth failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 启动周期调度（幂等）。返回 stop 函数。 */
export function startLifecycleScheduler(deps: { store: IMemoryStore; llmRunner: LLMRunner; config?: Partial<LifecycleConfig>; logger?: Logger }): () => void {
  const cfg = { ...DEFAULT_LIFECYCLE_CONFIG, ...(deps.config ?? {}) };
  if (!cfg.enabled) return () => {};
  if (timer) clearInterval(timer);
  void runOnce({ store: deps.store, llmRunner: deps.llmRunner, config: cfg, logger: deps.logger }).catch(() => {});
  timer = setInterval(() => void runOnce({ store: deps.store, llmRunner: deps.llmRunner, config: cfg, logger: deps.logger }).catch(() => {}), cfg.intervalMs);
  timer.unref?.();
  return () => { if (timer) { clearInterval(timer); timer = null; } };
}