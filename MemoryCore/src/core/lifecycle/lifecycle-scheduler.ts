/**
 * H+I 接线：网关侧周期调度器 —— 定期跑巩固(consolidation, 可持久化持续态) + 遗忘判定(forgetting)。
 * best-effort、配置门(memory.lifecycle)、可整体关停；失败只记日志不抛。
 */
import type { IMemoryStore } from "../store/types.js";
import type { LLMRunner, Logger } from "../types.js";
import { runConsolidation, type ConsolidationConfigX } from "./consolidation/consolidation-worker.js";
import { runForgetting, type ForgettingConfig } from "./forgetting/forgetting-worker.js";
import { runReflection, type ReflectionConfig } from "./reflection.js";
import { runAnchorGrowth, type AnchorDiscoveryConfig } from "./anchor-growth.js";
import { runEvolution, type EvolutionWorkerConfig } from "./evolution-worker.js";
import type { SoulMaintenanceConfig } from "../soul/types.js";
import { createSoulRewriter, runSoulMaintenance, type SoulEvidenceRecord } from "../soul/worker.js";

export interface LifecycleConfig {
  enabled: boolean;
  intervalMs: number;
  consolidation?: ConsolidationConfigX;
  forgetting?: ForgettingConfig;
  /** P3-F13：反思触发（Generative Agents 对标；缺省 undefined=关）。 */
  reflection?: ReflectionConfig;
  /**
   * GROW（价值锚自生长）：巩固周期后挂钩的自发现+自动采纳。
   * 缺省 undefined → 默认开（DEFAULT_ANCHOR_DISCOVERY_CONFIG，enabled=true）——
   * 与 consolidation/forgetting 同款"缺省开"语义；LLM runner 缺失时安静跳过。
   * PA：自生长 per-agent 化——遍历有记忆的 distinct agent 三元组（anchor-growth 内部
   * 枚举，不受本 filter 影响；旧 store 无枚举能力时回退 default 单桶）。
   */
  anchorDiscovery?: AnchorDiscoveryConfig;
  /** DS-SOUL-MEMORY-002 P1：agent 自我层双视角（gateway 接线自 coreMemory.selfIdentity，缺省 undefined=关）。
   *  intervalHours：enabled=true 时覆盖 identity worker 冷却（F15 分池节奏）。 */
  selfIdentity?: { enabled: boolean; maxPerPass: number; intervalHours?: number };
  /** S-CHAR-2（M2/P3+P4）：品格张力检测配置（gateway 接线自 coreMemory.characterTension，缺省 undefined=关）。 */
  characterTension?: { enabled: boolean; minInstances: number; maxCandidatesPerPass: number };
  /**
   * P4b（GROW-EVO §4，REG-REMAINING-005 #1）：受控正文演化 worker 配置。
   * 缺省 undefined → 关（config-first：memory.evolution.enabled 缺省 false = 逐位现状；
   * 这是全系统唯一允许改写已固化正文的路径，必须显式开启）。
   */
  evolution?: EvolutionWorkerConfig;
  /**
   * 自维护人格层（m00527）：五槽 + 判定器 + 账本。缺省 undefined → 关（config-first，
   * 逐位现状）。开启后每个 tick 跑一轮 runSoulMaintenance：存量槽导入 → 语料生长 →
   * （可选）LLM 候选 → 生命周期 → 合并 → 心境积分 → 单事务落库账本。
   */
  soulMaintenance?: SoulMaintenanceConfig;
  /** 审计 C：租户隔离 filter。缺省不传（退化为全部数据，保持兼容）；多租户部署应显式传入。
   *  P2-T14（H-B2）：字段全可选 + 增 taskId，与 MemoryLifecycleConfig.filter 同形。 */
  filter?: { teamId?: string; userId?: string; agentId?: string; taskId?: string };
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  enabled: true,
  intervalMs: 10 * 60_000,
};

let timer: ReturnType<typeof setInterval> | null = null;
// GROW-RACE（REG-REMAINING-004 #9，FLOW-E 实证）：runOnce 无互斥时，上一轮未完成（LLM
// timeoutMs=0 慢调用）+ intervalMs 短 → 多个 run 重叠，各自基于过期快照算采纳名额 free →
// 超额采纳（实测 l5ug 11→18，maxTotal=15 被击穿）。进程级互斥：上一轮在飞则跳过本轮 tick。
let runOnceInFlight = false;
let stallSkips = 0; // 连续跳过计数：≥10 次 warn 一次（互斥引入的停滞面必须可见）

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
    timestamp_str?: string; occurred_at?: string; metadata?: object; metadata_json?: string;
  };
  const parsedMeta = (() => {
    try { return JSON.parse(rec.metadata_json ?? "{}") as Record<string, unknown>; } catch { return {}; }
  })();
  const derived: Record<string, unknown> = {};
  // ADR-0025 C3：timestamp_start 列已删 → 左端语义取 timestamp_str（存量里两者逐位相等）。
  if (rec.timestamp_str) derived.activity_start_time = rec.timestamp_str;
  if (rec.occurred_at) derived.occurred_at = rec.occurred_at;
  return {
    ...rec,
    id: rec.record_id, // ← 根治点 1：id 兜底（消费方 archiveL1/幂等都靠它）
    teamId: rec.team_id,
    userId: rec.user_id,
    agentId: rec.agent_id,
    taskId: rec.task_id,
    timestamps: [rec.timestamp_str ?? ""].filter(Boolean),
    metadata: {
      ...parsedMeta,
      ...(rec.metadata ?? {}), // 保留行上原有 metadata 字段（非 store 裸行来源兼容）
      ...derived,
    },
  };
}

export interface SoulTickDeps {
  store: IMemoryStore;
  /** 显式 filter 优先（单租户部署）；缺省则枚举 core_memory/soul_persona 的租户逐个跑。 */
  filter?: { teamId?: string; userId?: string; agentId?: string; taskId?: string };
  config: SoulMaintenanceConfig;
  llmRunner?: LLMRunner;
  embeddingService?: { embed(t: string): Promise<Float32Array> } | null;
  logger?: Logger;
}

export interface SoulTickSummary {
  tenants: number;
  stored: number;
  imported: number;
  admitted: number;
  /** 拒绝与事件：整轮汇总（单租户失败不拖垮，这里只计成功租户）。 */
  rejected?: number;
  /** 存量槽导入退出人格注入层（冻结）的条数。 */
  retired?: number;
  episodes?: { mined?: number; inserted: number; available: number };
  rejectTop?: Array<{ code: string; count: number }>;
}

/**
 * 自维护人格的每 tick 入口（m00527 生产实证修正）：
 * 后台 worker 比 HTTP handler 少了请求上下文，若沿用「filter 缺失 → 空三元组」，
 * readCore 会读 default 桶（生产全空），人格整合永不发生（首轮生产重启实测 imported=0）。
 * 因此：显式 filter 时只跑该租户；否则枚举有 core/soul 数据的租户逐个跑。
 * 单租户失败只 warn，不拖垮其他租户与整条生命周期。
 */
export async function runSoulMaintenanceTick(deps: SoulTickDeps): Promise<SoulTickSummary> {
  const explicit = Boolean(deps.filter?.teamId || deps.filter?.userId || deps.filter?.agentId);
  let tenants: Array<{ teamId: string; userId: string; agentId: string }>;
  if (explicit) {
    tenants = [
      {
        teamId: deps.filter?.teamId ?? "",
        userId: deps.filter?.userId ?? "",
        agentId: deps.filter?.agentId ?? "",
      },
    ];
  } else if (typeof deps.store.listCoreTenants === "function") {
    tenants = (await Promise.resolve(deps.store.listCoreTenants())) ?? [];
  } else {
    // 旧后端无枚举能力：保持旧行为（单桶 + 全局语料）。
    tenants = [{ teamId: "", userId: "", agentId: "" }];
  }
  const summary: SoulTickSummary = { tenants: 0, stored: 0, imported: 0, admitted: 0, rejected: 0, retired: 0, episodes: { mined: 0, inserted: 0, available: 0 }, rejectTop: [] };
  if (tenants.length === 0) {
    deps.logger?.debug?.("[lifecycle] soul-maintenance skipped: 无带数据的租户（core_memory/soul_persona 均空）");
    return summary;
  }
  for (const tenant of tenants) {
    try {
      const recentRecords = async (): Promise<SoulEvidenceRecord[]> => {
        const l1Filter = tenant.teamId || tenant.userId || tenant.agentId ? { ...tenant } : undefined;
        const rows = (await deps.store.queryL1Records?.(l1Filter)) ?? [];
        return rows
          .slice(-400)
          .map((r) => {
            const rec = r as unknown as {
              record_id?: string;
              id?: string;
              content?: string;
              metadata_json?: string;
              metadata?: Record<string, unknown>;
              occurred_at?: string;
            };
            // queryL1Records 是 snake_case 裸行：id 在 record_id、元数据在 metadata_json。
            const meta = (() => {
              if (rec.metadata && typeof rec.metadata === "object") return rec.metadata;
              try {
                return JSON.parse(rec.metadata_json ?? "{}") as Record<string, unknown>;
              } catch {
                return {};
              }
            })();
            return {
              id: String(rec.record_id ?? rec.id ?? ""),
              content: typeof rec.content === "string" ? rec.content : "",
              occurredAt: rec.occurred_at,
              valence: typeof meta.valence === "number" ? meta.valence : null,
              arousal: typeof meta.arousal === "number" ? meta.arousal : null,
            };
          })
          .filter((r) => r.id !== "" && r.content !== "");
      };
      // 事件挖掘输入：L0 原始对话（保留 role 与原话）。窗口与条数走 soulMaintenance 配置，
      // 不在这里写死——否则「配置项真接线」又一次变成死配置。
      const recentL0 = typeof deps.store.recentL0Messages === "function"
        ? async () =>
            (await Promise.resolve(
              deps.store.recentL0Messages!(tenant, {
                sinceDays: deps.config.episodeWindowDays ?? 30,
                maxMessages: deps.config.maxEpisodeMessages ?? 4000,
              }),
            )) ?? []
        : undefined;
      const res = await runSoulMaintenance({
        store: deps.store,
        tenant: tenant as never,
        config: deps.config,
        trigger: "lifecycle",
        recentRecords,
        recentL0,
        // LLM 只是候选来源之一：runner 缺失时传 undefined（worker 侧跳过，不报错）。
        rewriter: deps.llmRunner ? createSoulRewriter(deps.llmRunner, { taskId: "memory.soul-maintenance" }) : undefined,
        // 漂移检测要向量器；缺省时 worker 如实标注 driftSkipped，不用词面相似伪造分数。
        embed: deps.embeddingService
          ? async (text: string) => Array.from(await deps.embeddingService!.embed(text))
          : undefined,
        logger: deps.logger,
      });
      summary.tenants += 1;
      if (res.stored) summary.stored += 1;
      summary.imported += res.imported;
      summary.admitted += res.admitted;
      summary.rejected = (summary.rejected ?? 0) + res.rejected;
      summary.retired = (summary.retired ?? 0) + (res.retired ?? 0);
      if (res.episodes) {
        summary.episodes = {
          mined: (summary.episodes?.mined ?? 0) + (res.episodes.mined ?? 0),
          inserted: (summary.episodes?.inserted ?? 0) + res.episodes.inserted,
          available: (summary.episodes?.available ?? 0) + res.episodes.available,
        };
      }
      // 拒绝原因跨租户聚合：同一句话被判死的理由，比「rejected=97」一个总数更能指导修判据。
      if (res.rejectTop) {
        const by = new Map((summary.rejectTop ?? []).map((r) => [r.code, r.count]));
        for (const r of res.rejectTop) by.set(r.code, (by.get(r.code) ?? 0) + r.count);
        summary.rejectTop = [...by].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
      }
      const driftBad = res.drift.filter((d) => d.verdict !== "ok").length;
      deps.logger?.info?.(
        `[lifecycle] soul-maintenance tenant=${tenant.teamId || "default"}/${tenant.userId || "default"}/${tenant.agentId || "default"} stored=${res.stored} imported=${res.imported} admitted=${res.admitted} reclassified=${res.reclassified} retired=${res.retired ?? 0} rejected=${res.rejected} merged=${res.merged} degraded=${res.degraded} frozen=${res.frozen} revived=${res.revived} episodes=${res.episodes ? `${res.episodes.available}(+${res.episodes.inserted})` : "n/a"} drift=${res.drift.length}(${driftBad} 异常) ledger=${res.ledgerEntries} mood=${res.mood?.mood?.valence?.toFixed?.(2) ?? "n/a"} emotions=${res.mood?.labels ? Object.entries(res.mood.labels).map(([k, v]) => k + v).join("/") : "n/a"} dormant=${res.mood?.dormant?.join("/") ?? ""}${res.rejectTop ? ` rejectTop=${res.rejectTop.slice(0, 5).map((r) => `${r.code}:${r.count}`).join(",")}` : ""}${res.rejectHistory?.length ? ` reject30d=${res.rejectHistory.slice(0, 5).map((r) => `${r.code}:${r.count}`).join(",")}` : ""}${res.driftSkipped ? ` driftSkipped=${res.driftSkipped}` : ""}${res.skipped ? ` skipped=${res.skipped}` : ""}`,
      );
    } catch (err) {
      deps.logger?.warn?.(
        `[lifecycle] soul-maintenance failed tenant=${tenant.teamId || "default"}/${tenant.userId || "default"}/${tenant.agentId || "default"}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (tenants.length > 1) {
    deps.logger?.info?.(
      `[lifecycle] soul-maintenance summary tenants=${summary.tenants}/${tenants.length} imported=${summary.imported} admitted=${summary.admitted}`,
    );
  }
  return summary;
}

async function runOnce(deps: { store: IMemoryStore; llmRunner: LLMRunner; config: LifecycleConfig; logger?: Logger; embeddingService?: { embed(t: string): Promise<Float32Array> } | null }): Promise<void> {
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
    return (recs ?? []).map((r) => mapL1RowToRecord(r as unknown as Record<string, unknown>));
  };
  if (deps.config.consolidation?.enabled !== false) {
    try {
      const res = await runConsolidation({
        queryL1: async () => (await queryL1()) as never,
        llmRunner: deps.llmRunner,
        config: deps.config.consolidation,
        logger: deps.logger,
        store: deps.store,
        embeddingService: deps.embeddingService,
        // B1 修正（2026-11-02）：池内补齐前先复用 l1_vec 已入库向量——store 支持才传；
        // 不实现的后端退化为"有上限补齐"（绝不逐条重嵌全表）。
        loadVectors: deps.store?.getL1VectorsByIds
          ? (ids: string[]) => Promise.resolve(deps.store.getL1VectorsByIds!(ids))
          : undefined,
        // P2-T14（H-B2）：写路径带同一 filter——源记忆租户缺失时，持续态归属兜底为 filter 值
        filter: deps.config.filter,
      });
      deps.logger?.info?.(`[lifecycle] consolidation groups=${res.groupsFound} persisted=${res.persisted}`);
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
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
        selfIdentity: deps.config.selfIdentity,
        // S-CHAR-2（M2/P4）：品格张力检测接线（FLOW-E 同款教训——不接线即死配置）。
        characterTension: deps.config.characterTension,
        characterPool: deps.config.anchorDiscovery?.character,
        logger: deps.logger,
      });
      if (res.ran) {
        deps.logger?.info?.(`[lifecycle] identity-discovery adopted=${res.adopted} pending=${res.pending}`);
      }
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] identity-discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 自维护人格层（m00527）：槽导入 → 语料生长 → 生命周期 → 合并 → 心境 → 账本。
  // 与 identity-discovery 同轮但互不依赖：后者仍在写 core_memory 槽（旧路径保留可回滚），
  // 本 worker 读槽做一次性导入并把后续变更全部记进 soul_persona / soul_ledger。
  // enabled 缺省 false = 逐位现状；单轮异常只 warn（不得拖垮整条生命周期）。
  if (deps.config.soulMaintenance?.enabled === true) {
    try {
      await runSoulMaintenanceTick({
        store: deps.store,
        filter: deps.config.filter,
        config: deps.config.soulMaintenance,
        llmRunner: deps.llmRunner,
        embeddingService: deps.embeddingService,
        logger: deps.logger,
      });
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] soul-maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
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
        // S-CHAR-2（M2/P3）：T2 挂点接线（缺省 undefined=关）。
        characterTension: deps.config.characterTension,
        logger: deps.logger,
      });
      if (res.ran) {
        deps.logger?.info?.(`[lifecycle] anchor-growth adopted=${res.adopted} retired=${res.retired} reweighted=${res.reweighted} displaced=${res.displaced} skipped=${res.skipped}`);
      }
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] anchor-growth failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // P4b（GROW-EVO §4）：受控正文演化——conflict 边扫描 → 五条件门 → LLM 单次重写 + evolved_from 审计边。
  // 间隔节流与幂等（evolved_from 边）在 worker 内部；config-first：enabled 缺省 false = 逐位现状。
  if (deps.config.evolution?.enabled === true) {
    try {
      const res = await runEvolution({
        queryL1: async () => (await queryL1()) as never,
        llmRunner: deps.llmRunner,
        config: deps.config.evolution,
        store: deps.store,
        embeddingService: deps.embeddingService,
        logger: deps.logger,
      });
      if (res.ran) {
        deps.logger?.info?.(`[lifecycle] evolution scanned=${res.scanned} candidates=${res.candidates} rewrites=${res.rewrites}`);
      } else if (res.skipped && res.skipped !== "interval") {
        deps.logger?.debug?.(`[lifecycle] evolution skipped: ${res.skipped}`);
      }
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] evolution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // P2 SOP Round3 对抗修正（次序）：遗忘判定放 pass 末尾——锚发现/身份发现在同轮先行，
  // 保护上下文（active 锚名集/身份切片）取到本轮最新状态（引导期同轮 forgetting 先跑
  // 会因锚未诞生致 F14 保护名集为空，受保护记录被当场归档，ev8 实证）。
  // P3-F13：反思触发——importance 累计 > R_REF → 强制反思式 L3 蒸馏（产物=普通 L3 结论卡）。
  // 语义=触发生成时机增强（spec §2.8）；固定 interval 兜底由 consolidation 既有节拍承担。
  if (deps.config.reflection?.enabled) {
    try {
      const res = await runReflection({ queryL1: async () => (await queryL1()) as never, config: deps.config.reflection, store: deps.store, llmRunner: deps.llmRunner, logger: deps.logger, filter: deps.config.filter, embeddingService: deps.embeddingService });
      // #91 返工观测夹带（2026-10-23 拍板③）：sim-gated/计票/echo 路由关键点进拍级汇总行。
      deps.logger?.info?.(`[lifecycle] reflection triggered=${res.triggered} cards=${res.cardsWritten} proposals=${res.proposalsPushed ?? 0} simGated=${res.simGated ?? 0} recVotes=${res.recurrenceVotes ?? 0} echoVotes=${res.echoVotes ?? 0} echoSkipped=${res.echoSkipped ?? 0} rateLimitSkipped=${res.rateLimitSkipped ?? 0} gateDegraded=${res.gateDegraded ?? 0}`);
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] reflection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // #91：self_identity pending TTL sweep（复现即投票·默认终局）——recurrence 开才跑
  // （golden 缺省关=零调用逐位）；仿 reflection 块独立 try/catch warn 非致命。
  {
    const recCfg = deps.config.reflection?.selfIdentityGate?.recurrence;
    if (recCfg?.enabled === true) {
      try {
        const swept = await Promise.resolve(deps.store.sweepExpiredSelfIdentityPending?.(deps.config.filter, { ttlHours: recCfg.ttlHours }));
        // #91 返工观测夹带：swept 无条件打（空扫也打，证明 sweep 节拍活着——消除空转无声盲区）。
        deps.logger?.info?.(`[lifecycle] self_identity pending TTL swept=${swept?.length ?? 0}`);
      } catch (err) {
        deps.logger?.warn?.(`[lifecycle] self_identity pending sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // #92 stage 2：self_identity 确定性自动采纳门（三重门高置信自动采纳；缺省 off=逐位现状；2026-10-25 拍板四项）。
  // 独立 try/catch warn 非致命（同 sweep 先例）；动态 import 保持模块懒加载（同 identity-discovery 先例）。
  {
    const aaCfg = deps.config.reflection?.selfIdentityGate?.autoAdopt;
    if (aaCfg?.enabled === true) {
      try {
        const { runSelfIdentityAutoAdopt } = await import("./auto-adopt-gate.js");
        const res = await runSelfIdentityAutoAdopt({ store: deps.store, config: aaCfg, logger: deps.logger });
        // #92 观测夹带：拍级计数行（adopted/blocked/skipped），同 #91 口径——空拍也打，节拍在场可证。
        deps.logger?.info?.(`[lifecycle] self_identity auto-adopt adopted=${res.adopted} blocked=${res.blocked} skipped=${res.skipped}`);
      } catch (err) {
        deps.logger?.warn?.(`[lifecycle] self_identity auto-adopt failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (deps.config.forgetting?.enabled !== false) {
    try {
      const res = await runForgetting({ queryL1: async () => (await queryL1()) as never, config: deps.config.forgetting, logger: deps.logger, store: deps.store, tenant: deps.config.filter });
      deps.logger?.info?.(`[lifecycle] forgetting candidates=${res.candidates.length} archived=${res.archived}`);
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] forgetting failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 启动周期调度（幂等）。返回 stop 函数。 */
export function startLifecycleScheduler(deps: { store: IMemoryStore; llmRunner: LLMRunner; config?: Partial<LifecycleConfig>; logger?: Logger; embeddingService?: { embed(t: string): Promise<Float32Array> } | null }): () => void {
  const cfg = { ...DEFAULT_LIFECYCLE_CONFIG, ...(deps.config ?? {}) };
  if (!cfg.enabled) return () => {};
  if (timer) clearInterval(timer);
  // GROW-RACE 互斥 tick：上一轮未完成则跳过（debug 可见，不留静默）。
  const tick = (): void => {
    if (runOnceInFlight) {
      stallSkips++;
      deps.logger?.debug?.("[lifecycle] previous tick still in flight, skipping (GROW-RACE 互斥)");
      if (stallSkips > 0 && stallSkips % 10 === 0) deps.logger?.warn?.(`[lifecycle] ticks skipped ${stallSkips} consecutively (previous run still in flight) — 生命周期停滞告警`);
      return;
    }
    runOnceInFlight = true;
    void runOnce({ store: deps.store, llmRunner: deps.llmRunner, config: cfg, logger: deps.logger, embeddingService: deps.embeddingService })
      .catch(() => {})
      .finally(() => { runOnceInFlight = false; stallSkips = 0; });
  };
  void tick();
  timer = setInterval(tick, cfg.intervalMs);
  timer.unref?.();
  return () => { if (timer) { clearInterval(timer); timer = null; } };
}