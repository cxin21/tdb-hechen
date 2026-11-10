/**
 * H+I 接线：网关侧周期调度器 —— 定期跑巩固(consolidation, 可持久化持续态) + 遗忘判定(forgetting)。
 * best-effort、配置门(memory.lifecycle)、可整体关停；失败只记日志不抛。
 */
import type { IMemoryStore, SoulEpisodeProvisionResult } from "../store/types.js";
import type { LLMRunner, Logger } from "../types.js";
import { runConsolidation, type ConsolidationConfigX } from "./consolidation/consolidation-worker.js";
import { runForgetting, type ForgettingConfig } from "./forgetting/forgetting-worker.js";
import { runReflection, type ReflectionConfig } from "./reflection.js";
import { runEvolution, type EvolutionWorkerConfig } from "./evolution-worker.js";
import { resolveSoulConfig, type SoulMaintenanceConfig } from "../soul/types.js";
import type { AgentProfileLike } from "../soul/agent-profile.js";
import { createSoulRewriter, runSoulMaintenance, type SoulEvidenceRecord } from "../soul/worker.js";
import type { GoalMaintenanceResult } from "../soul/goals.js";
import type { SelfModelMaintenanceResult } from "../soul/self-model-maintenance.js";
import type { NarrativeMaintenanceResult } from "../soul/narrative.js";
import type { ValueMaintenanceResult } from "../soul/value-maintenance.js";
import { createTraitJudge } from "../soul/trait-judge.js";
import { createPersonProfiler, type PersonProfileReport } from "../person/profile-distiller.js";

export interface LifecycleConfig {
  enabled: boolean;
  intervalMs: number;
  consolidation?: ConsolidationConfigX;
  forgetting?: ForgettingConfig;
  /** P3-F13：反思触发（Generative Agents 对标；缺省 undefined=关）。 */
  reflection?: ReflectionConfig;
  /** 身份取数开关键（gateway 接线自 coreMemory.anchorDiscovery，缺省 undefined=开）：
   *  S8 起价值锚自生长已删，本键只剩「soul 单产线是否调 LLM 产身份事实」一个用途。 */
  anchorDiscovery?: { enabled?: boolean };
  /** DS-SOUL-MEMORY-002 P1：agent 自我层双视角（gateway 接线自 coreMemory.selfIdentity，缺省 undefined=关）。
   *  冷却节拍恒取 worker 缺省（F15 分池节奏；配置面已收缩到 enabled/maxPerPass 两键）。 */
  selfIdentity?: { enabled: boolean; maxPerPass: number };
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
  /** S6：表单红线的 metadata 读取接缝（gateway 注入；worker 不碰 metadata 库）。 */
  readAgentProfile?: (agentId: string) => Promise<AgentProfileLike | null>;
  /** S6：identity 取数与红线的开关键/上限（原在 LifecycleConfig，tick 不读整份 config）。 */
  anchorDiscovery?: { enabled?: boolean };
  selfIdentity?: { enabled: boolean; maxPerPass: number };
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
  /**
   * S4 特质实况（跨租户求和）：movedAxes=本轮真正位移的轴数，votes/rejectedVotes=判侧计票，
   * labels=准入+合并的新标签数，skipped=未跑原因去重（no_trait_judge / no_new_episode / trait_failed: …）。
   * 没有这张表，生产上「特质永不漂移」只能靠猜——它必须和 drift 一样被 tick 打出来。
   */
  trait?: { movedAxes: number; votes: number; rejectedVotes: number; labels: number; skipped: string[] };
  rejectTop?: Array<{ code: string; count: number }>;
  /**
   * P2-H 人物档案通道（跨租户求和）：候选/实际/推迟/成败与字段+关系条数。
   * `undefined` = 本轮没接线（没 runner），与「接了线但 0 人可跑」用 attempted=0 区分。
   */
  personProfile?: {
    candidates: number;
    attempted: number;
    deferred: number;
    completed: number;
    failed: number;
    fields: number;
    relations: number;
    outdated: number;
    dropped: number;
  };
  /**
   * P2 §4.4 关系状态层（跨租户求和）：观察到的 person 数 / upsert 行数 / 新增审计行数。
   * `undefined` = 本轮 store 没有写面（没接线），与「跑了但 0 条」可区分。
   */
  personState?: { persons: number; updated: number; events: number };
  /**
   * P2 §10.8 关系边 event_id 回指账（跨租户求和）：扫描/唯一命中/标不可验证。
   * `undefined` = 本轮 store 没有回指写面（没接线），与「跑了但 0 条」可区分。
   */
  relationBackfill?: { scanned: number; linked: number; unverifiable: number };
  /**
   * P2 §10.8 / t13 补事件账（跨租户求和）：扫描/新建/多命中/跳过。
   * `undefined` = 本轮 store 没有补事件写面（没接线），与「跑了但 0 条」可区分。
   */
  relationProvision?: { scanned: number; created: number; ambiguous: number; skipped: number };
  /**
   * P3 §4.5 目标层账（跨租户求和）：候选/新建/再确认/跳过/承诺挂靠/状态迁移 + working 锚是否写出。
   * `undefined` = 本轮 store 没有目标写面（没接线），与「跑了但 0 条」可区分。
   */
  goals?: GoalMaintenanceResult;
  /**
   * P5 §4.7 心境账（跨租户求和，读数取最后一轮）：soul_mood_state 落没落、append-only 账本写了多少、
   * 半衰期、是否真的调节过、衰减后的效价。`undefined` = 本轮没跑心境阶段（与「跑了但 0 条」可区分）。
   */
  mood?: {
    tenants: number;
    stateWritten: number;
    events: number;
    halfLifeHours: number;
    regulated: number;
    valence: number;
    decayedValence: number;
  };
  /**
   * P4 §4.5/§4.6 自我模型账（跨租户求和）：写了多少行、其中多少处于 probation/retired、
   * 校准样本与反思条数。`undefined` = 本轮 store 没有自我模型写面（没接线）。
   */
  selfModel?: SelfModelMaintenanceResult;
  /**
   * P6 / t20 episode 补事件账（跨租户求和）：老库里无事件的 episode 补了几条、多少条补不了、
   * 第一条补不了的示例与原因。计数求和，示例取第一个非空、limitReached 取或。
   * `undefined` = 本轮 store 没有该写面（没接线）。
   */
  episodeProvision?: SoulEpisodeProvisionResult;
  /**
   * P6 §4.8 叙事账（跨租户求和）：巩固了几个月、成章/升版/再确认几篇、跳过的月份
   * （无证据 / 未走完）。`undefined` = 本轮 store 没有叙事读写面（没接线）。
   */
  narrative?: NarrativeMaintenanceResult;
  /**
   * P7 §4.9 价值账（跨租户求和）：价值候选/写了几条、写入侧 shadow gate 判了几条命中几条、
   * 两难几条。undefined = 本轮 store 没有价值写面（没接线）。
   * 注意 gateHits 是「判了会拦」不是「拦了」——shadow 期输出一个字符都没改。
   */
  values?: ValueMaintenanceResult;
  /** 本轮告警码（语言未覆盖 / 标签长尾）。调度器必须打出来，不能只留在 worker 报告里。 */
  alerts?: string[];
}

/**
 * 把一个人的档案账并进整轮 summary（跨租户求和；byReason 明细留在 worker 报告里，
 * 汇总层只留计数，避免日志被模型丢弃原因撑爆）。
 */
function aggregatePersonProfile(summary: SoulTickSummary, report: PersonProfileReport): void {
  if (!summary.personProfile) {
    summary.personProfile = {
      candidates: 0,
      attempted: 0,
      deferred: 0,
      completed: 0,
      failed: 0,
      fields: 0,
      relations: 0,
      outdated: 0,
      dropped: 0,
    };
  }
  const agg = summary.personProfile;
  agg.candidates += report.candidates;
  agg.attempted += report.attempted;
  agg.deferred += report.deferred;
  agg.completed += report.completed;
  agg.failed += report.failed;
  agg.fields += report.fields;
  agg.relations += report.relations;
  agg.outdated += report.outdated;
  agg.dropped += report.dropped;
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
  const summary: SoulTickSummary = { tenants: 0, stored: 0, imported: 0, admitted: 0, rejected: 0, retired: 0, episodes: { mined: 0, inserted: 0, available: 0 }, rejectTop: [], alerts: [] };
  if (tenants.length === 0) {
    deps.logger?.debug?.("[lifecycle] soul-maintenance skipped: 无带数据的租户（core_memory/soul_persona 均空）");
    return summary;
  }
  for (const tenant of tenants) {
    try {
      // S10 补洞（2026-11-07）：清库水位只挡 L0 不够——identity 取数与 L1 证据语料都直读历史行，
      // 清库后首个 tick 仍会拿旧 L1 重新产事实/候选（生产实测 06:31 一批 identity reject 引用旧消息）。
      // 水位在这里读一次，recentRecords / recentL0 / identityFacts 三处共用。
      const watermark =
        typeof deps.store.soulMetaGet === "function"
          ? await Promise.resolve(deps.store.soulMetaGet("episodeWatermark"))
          : undefined;
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
          .filter((r) => r.id !== "" && r.content !== "")
          // 清库前的 L1 行不再进证据池（occurred_at 缺失的行无法判定，保留）。
          .filter((r) => !watermark || !r.occurredAt || r.occurredAt >= watermark);
      };
      // 事件挖掘输入：L0 原始对话（保留 role 与原话）。窗口与条数走 soulMaintenance 配置，
      // 不在这里写死——否则「配置项真接线」又一次变成死配置。
      const recentL0 = typeof deps.store.recentL0Messages === "function"
        ? async () => {
            // S10（2026-11-07）：水位必须在这里也生效。worker 侧那条 sinceIso 分支只在
            // recentL0 缺省时才走；lifecycle 一直注入 recentL0，导致清库后首个 tick 把
            // 旧对话重抽成 86 条事件、当天复活旧人格（生产实测 2026-11-07T14:08:44Z）。
            return (
              (await Promise.resolve(
                deps.store.recentL0Messages!(tenant, {
                  sinceDays: deps.config.episodeWindowDays ?? 30,
                  maxMessages: deps.config.maxEpisodeMessages ?? 4000,
                  ...(watermark ? { sinceIso: watermark } : {}),
                }),
              )) ?? []
            );
          }
        : undefined;
      // S6 单产线：identity 取数只产事实，不写库；事实由 worker 当候选并入同一准入与事务。
      // 与旧 identity-discovery 同一个开关键（anchorDiscovery.enabled），不再有第二条写径。
      const identityFacts =
        deps.anchorDiscovery?.enabled !== false && deps.llmRunner && typeof deps.store.queryL1Records === "function"
          ? async () => {
              const { collectIdentityFacts } = await import("./identity-discovery.js");
              const facts = await collectIdentityFacts({
                store: deps.store,
                tenant,
                llmRunner: deps.llmRunner,
                selfIdentity: deps.selfIdentity,
                logger: deps.logger,
                ...(watermark ? { sinceIso: watermark } : {}),
              });
              return facts.facts;
            }
          : undefined;
      const res = await runSoulMaintenance({
        store: deps.store,
        tenant: tenant as never,
        config: deps.config,
        trigger: "lifecycle",
        recentRecords,
        recentL0,
        identityFacts,
        readAgentProfile: deps.readAgentProfile,
        // LLM 只是候选来源之一：runner 缺失时传 undefined（worker 侧跳过，不报错）。
        rewriter: deps.llmRunner ? createSoulRewriter(deps.llmRunner, { taskId: "memory.soul-maintenance" }) : undefined,
        // S4 判侧：与改写器共用同一个 runner；缺省=undefined，worker 如实标 no_trait_judge，
        // 不再让「没人提供 traitJudge」静默成「特质永不漂移」。
        traitJudge: deps.llmRunner ? createTraitJudge(deps.llmRunner) : undefined,
        // P2-H：人物档案通道与 soul 共用同一个 runner，但有自己的调用节奏（一人一次、
        // 每 tick ≤ min(8, maxUpdatedPerCycle*2) 人，A12）。runner 缺失时整条通道缺席。
        personProfiler: deps.llmRunner ? createPersonProfiler(deps.llmRunner, { logger: deps.logger }) : undefined,
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
      // P2-H：档案通道的账也要出 tick（「跑了几个人、谁被推迟」不能只留在 worker 里）。
      if (res.personProfile) aggregatePersonProfile(summary, res.personProfile);
      // P2 §4.4：关系状态层同样要出 tick——表里有没有行，必须能从 summary 读出来。
      if (res.personState) {
        if (!summary.personState) summary.personState = { persons: 0, updated: 0, events: 0 };
        summary.personState.persons += res.personState.persons;
        summary.personState.updated += res.personState.updated;
        summary.personState.events += res.personState.events;
      }
      // P2 §10.8 / t13：补事件账也要出 tick——「补了几条、多少因为多命中/零命中没补」必须能读出来。
      if (res.relationProvision) {
        if (!summary.relationProvision) {
          summary.relationProvision = { scanned: 0, created: 0, ambiguous: 0, skipped: 0 };
        }
        summary.relationProvision.scanned += res.relationProvision.scanned;
        summary.relationProvision.created += res.relationProvision.created;
        summary.relationProvision.ambiguous += res.relationProvision.ambiguous;
        summary.relationProvision.skipped += res.relationProvision.skipped;
      }
      // P2 §10.8：回指账也要出 tick——「多少边验证了、多少标了不可验证」必须能从 summary 读出来。
      if (res.relationBackfill) {
        if (!summary.relationBackfill) summary.relationBackfill = { scanned: 0, linked: 0, unverifiable: 0 };
        summary.relationBackfill.scanned += res.relationBackfill.scanned;
        summary.relationBackfill.linked += res.relationBackfill.linked;
        summary.relationBackfill.unverifiable += res.relationBackfill.unverifiable;
      }
      // P3 §4.5：目标层账也要出 tick——「立了几条、迁移了几条、working 锚有没有写」必须能从 summary 读出来。
      if (res.goals) {
        if (!summary.goals) {
          summary.goals = {
            candidates: 0,
            created: 0,
            reasserted: 0,
            skipped: 0,
            linked: 0,
            transitions: 0,
            working: false,
            focusChars: 0,
          };
        }
        const goals = summary.goals;
        goals.candidates += res.goals.candidates;
        goals.created += res.goals.created;
        goals.reasserted += res.goals.reasserted;
        goals.skipped += res.goals.skipped;
        goals.linked += res.goals.linked;
        goals.transitions += res.goals.transitions;
        goals.working = goals.working || res.goals.working;
        // focusChars 是「单条 working 锚的长度」，跨租户取最大值（求和会造出一个不存在的长度）。
        goals.focusChars = Math.max(goals.focusChars, res.goals.focusChars);
      }
      // P5 §4.7：心境落表实况也要出 tick——「心境记住了没有」不许只留在 worker 报告里。
      if (res.mood?.moodState) {
        const state = res.mood.moodState;
        if (!summary.mood) {
          summary.mood = {
            tenants: 0,
            stateWritten: 0,
            events: 0,
            halfLifeHours: 0,
            regulated: 0,
            valence: 0,
            decayedValence: 0,
          };
        }
        const mood = summary.mood;
        mood.tenants += 1;
        if (state.written) mood.stateWritten += 1;
        mood.events += state.events;
        if (state.regulated) mood.regulated += 1;
        // 半衰期与读数都是「当前态」：跨租户求和没有意义，取最后一轮（配置一致时即同一个值）。
        mood.halfLifeHours = state.halfLifeHours;
        mood.valence = state.valence;
        mood.decayedValence = state.decayedValence;
      }
      // P4 §4.5/§4.6：自我模型账出 tick——「有没有从失败里学到东西」必须能读出来。
      if (res.selfModel) {
        if (!summary.selfModel) {
          summary.selfModel = {
            scanned: 0,
            written: 0,
            patterns: 0,
            capabilities: 0,
            calibrationInsights: 0,
            calibrationRows: 0,
            reflections: 0,
            probation: 0,
            retired: 0,
          };
        }
        const selfModel = summary.selfModel;
        selfModel.scanned += res.selfModel.scanned;
        selfModel.written += res.selfModel.written;
        selfModel.patterns += res.selfModel.patterns;
        selfModel.capabilities += res.selfModel.capabilities;
        selfModel.calibrationInsights += res.selfModel.calibrationInsights;
        selfModel.calibrationRows += res.selfModel.calibrationRows;
        selfModel.reflections += res.selfModel.reflections;
        selfModel.probation += res.selfModel.probation;
        selfModel.retired += res.selfModel.retired;
      }
      // P6 / t20：补事件账出 tick——「0 章是因为老库没事件」必须能从汇总里直接读出来，
      // 不能只留在某一条 warn 里。计数求和；示例取第一个非空（哪个租户的都行，它只是日志锚点）。
      if (res.episodeProvision) {
        if (!summary.episodeProvision) {
          summary.episodeProvision = {
            scanned: 0,
            created: 0,
            ambiguous: 0,
            notFound: 0,
            noSource: 0,
            skippedWork: 0,
            skippedUnprovisionable: 0,
            skippedExisting: 0,
            failed: 0,
            exampleEpisodeId: null,
            exampleReason: null,
            limitReached: false,
          };
        }
        const provision = summary.episodeProvision;
        provision.scanned += res.episodeProvision.scanned;
        provision.created += res.episodeProvision.created;
        provision.ambiguous += res.episodeProvision.ambiguous;
        provision.notFound += res.episodeProvision.notFound;
        provision.noSource += res.episodeProvision.noSource;
        provision.skippedWork += res.episodeProvision.skippedWork;
        provision.skippedUnprovisionable += res.episodeProvision.skippedUnprovisionable;
        provision.skippedExisting += res.episodeProvision.skippedExisting;
        provision.failed += res.episodeProvision.failed;
        if (provision.exampleEpisodeId === null && res.episodeProvision.exampleEpisodeId !== null) {
          provision.exampleEpisodeId = res.episodeProvision.exampleEpisodeId;
          provision.exampleReason = res.episodeProvision.exampleReason;
        }
        provision.limitReached = provision.limitReached || res.episodeProvision.limitReached;
      }
      // P6 §4.8：叙事账出 tick——「自传有没有长出来、为什么没长」必须能读出来。
      if (res.narrative) {
        if (!summary.narrative) {
          summary.narrative = {
            periods: 0,
            created: 0,
            superseded: 0,
            reasserted: 0,
            skippedNoEvidence: 0,
            skippedUnclosed: 0,
            evidence: 0,
          };
        }
        const narrative = summary.narrative;
        narrative.periods += res.narrative.periods;
        narrative.created += res.narrative.created;
        narrative.superseded += res.narrative.superseded;
        narrative.reasserted += res.narrative.reasserted;
        narrative.skippedNoEvidence += res.narrative.skippedNoEvidence;
        narrative.skippedUnclosed += res.narrative.skippedUnclosed;
        narrative.evidence += res.narrative.evidence;
      }
      // P7 §4.9：价值账出 tick——「有没有长出价值、写入侧红线判了几条、有没有两难」必须能读出来。
      // gateLogged 与 gateHits 分开：命中未必落库（store 缺写面时只判不记），两个数不可互推。
      if (res.values) {
        if (!summary.values) {
          summary.values = {
            candidates: 0,
            declared: 0,
            observed: 0,
            written: 0,
            unchanged: 0,
            skippedNoEvidence: 0,
            gateEvaluated: 0,
            gateHits: 0,
            gateLogged: 0,
            dilemmas: 0,
          };
        }
        const values = summary.values;
        values.candidates += res.values.candidates;
        values.declared += res.values.declared;
        values.observed += res.values.observed;
        values.written += res.values.written;
        values.unchanged += res.values.unchanged;
        values.skippedNoEvidence += res.values.skippedNoEvidence;
        values.gateEvaluated += res.values.gateEvaluated;
        values.gateHits += res.values.gateHits;
        values.gateLogged += res.values.gateLogged;
        values.dilemmas += res.values.dilemmas;
      }
      // S4：特质漂移是本轮唯一会改「我是谁」的写径，必须进 summary 而不是只留在日志里。
      if (res.trait || res.traitSkipped) {
        if (!summary.trait) {
          summary.trait = { movedAxes: 0, votes: 0, rejectedVotes: 0, labels: 0, skipped: [] };
        }
        const trait = summary.trait;
        if (res.trait) {
          trait.movedAxes += res.trait.axes.filter((a) => a.delta !== 0).length;
          trait.votes += res.trait.votes;
          trait.rejectedVotes += res.trait.rejectedVotes;
          trait.labels += res.trait.labels.admitted + res.trait.labels.merged;
        }
        if (res.traitSkipped && !trait.skipped.includes(res.traitSkipped)) trait.skipped.push(res.traitSkipped);
      }
      // 拒绝原因跨租户聚合：同一句话被判死的理由，比「rejected=97」一个总数更能指导修判据。
      if (res.rejectTop) {
        const by = new Map((summary.rejectTop ?? []).map((r) => [r.code, r.count]));
        for (const r of res.rejectTop) by.set(r.code, (by.get(r.code) ?? 0) + r.count);
        summary.rejectTop = [...by].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
      }
      const driftBad = res.drift.filter((d) => d.verdict !== "ok").length;
      // 告警进控制环的最小一步：调度器必须看见，并升级成 warn。不在这里停写——
      // 停写会把「日文语料」变成「人格冻结」，那是另一项产品决定，不是这次要做的。
      for (const alert of res.alerts ?? []) {
        if (!summary.alerts!.includes(alert.code)) summary.alerts!.push(alert.code);
        const line = `[lifecycle] soul-alert ${alert.code}(${alert.class}) tenant=${tenant.teamId || "default"}/${tenant.userId || "default"}/${tenant.agentId || "default"} | ${alert.detail}`;
        // diagnostic 类每轮都会触发（情绪标签长尾是这份语料的常态），用 warn 刷屏会把
        // 真正要人动手的 control 告警淹掉；它进 summary 计数，日志降到 info。
        if (alert.class === "diagnostic") deps.logger?.info?.(line);
        else deps.logger?.warn?.(line);
      }
      deps.logger?.info?.(
        `[lifecycle] soul-maintenance tenant=${tenant.teamId || "default"}/${tenant.userId || "default"}/${tenant.agentId || "default"} stored=${res.stored} imported=${res.imported} admitted=${res.admitted} reclassified=${res.reclassified} retired=${res.retired ?? 0} rejected=${res.rejected} merged=${res.merged} degraded=${res.degraded} frozen=${res.frozen} revived=${res.revived} episodes=${res.episodes ? `${res.episodes.available}(+${res.episodes.inserted})` : "n/a"} drift=${res.drift.length}(${driftBad} 异常) ledger=${res.ledgerEntries} mood=${res.mood?.mood?.valence?.toFixed?.(2) ?? "n/a"} emotions=${res.mood?.labels ? Object.entries(res.mood.labels).map(([k, v]) => k + v).join("/") : "n/a"} dormant=${res.mood?.dormant?.join("/") ?? ""}${res.rejectTop ? ` rejectTop=${res.rejectTop.slice(0, 5).map((r) => `${r.code}:${r.count}`).join(",")}` : ""}${res.rejectHistory?.length ? ` reject30d=${res.rejectHistory.slice(0, 5).map((r) => `${r.code}:${r.count}`).join(",")}` : ""}${res.trait ? ` trait=${res.trait.axes.filter((a) => a.delta !== 0).length}轴/${res.trait.votes}票${res.trait.rejectedVotes ? `(拒${res.trait.rejectedVotes})` : ""}/${res.trait.labels.admitted + res.trait.labels.merged}标签` : ""}${res.traitSkipped ? ` traitSkipped=${res.traitSkipped}` : ""}${res.driftSkipped ? ` driftSkipped=${res.driftSkipped}` : ""}${res.relationProvision ? ` relProv=${res.relationProvision.created}/${res.relationProvision.scanned}` : ""}${res.relationBackfill ? ` relLinked=${res.relationBackfill.linked}/${res.relationBackfill.scanned}` : ""}${res.skipped ? ` skipped=${res.skipped}` : ""}`,
      );
    } catch (err) {
      deps.logger?.warn?.(
        `[lifecycle] soul-maintenance failed tenant=${tenant.teamId || "default"}/${tenant.userId || "default"}/${tenant.agentId || "default"}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (tenants.length > 1) {
    deps.logger?.info?.(
      `[lifecycle] soul-maintenance summary tenants=${summary.tenants}/${tenants.length} imported=${summary.imported} admitted=${summary.admitted}` +
        (summary.personProfile
          ? ` profile.attempted=${summary.personProfile.attempted} profile.fields=${summary.personProfile.fields} profile.relations=${summary.personProfile.relations} profile.deferred=${summary.personProfile.deferred} profile.failed=${summary.personProfile.failed}`
          : ""),
    );
  }
  return summary;
}

async function runOnce(deps: { store: IMemoryStore; llmRunner: LLMRunner; config: LifecycleConfig; logger?: Logger; embeddingService?: { embed(t: string): Promise<Float32Array> } | null; readAgentProfile?: (agentId: string) => Promise<AgentProfileLike | null> }): Promise<void> {
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
  // S6 单产线：旧 identity-discovery 的「直写 core_memory 槽」调用已删除——
  // 取数改由 runSoulMaintenanceTick 内的 collectIdentityFacts 提供，落库只有
  // soul-maintenance 的 commitSoulPersona 一条事务（不再有第二条写径）。
  // 自维护人格层（m00527）：槽导入 → 语料生长 → 生命周期 → 合并 → 心境 → 账本。
  // 与 identity-discovery 同轮但互不依赖：后者仍在写 core_memory 槽（旧路径保留可回滚），
  // 本 worker 读槽做一次性导入并把后续变更全部记进 soul_persona / soul_ledger。
  // S9（2026-11-07）：总闸 enabled 已删除——写入侧恒开；单轮异常只 warn（不得拖垮整条生命周期）。
  {
    try {
      await runSoulMaintenanceTick({
        store: deps.store,
        filter: deps.config.filter,
        config: deps.config.soulMaintenance ?? resolveSoulConfig(),
        llmRunner: deps.llmRunner,
        embeddingService: deps.embeddingService,
        logger: deps.logger,
        readAgentProfile: deps.readAgentProfile,
        anchorDiscovery: deps.config.anchorDiscovery,
        selfIdentity: deps.config.selfIdentity,
      });
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] soul-maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // S8（2026-11-07）：价值锚自生长（anchor-growth）整段删除——core_values 表已不存在，
  // 身份取数改由 soul 单产线（collectIdentityFacts → worker 同一候选数组/同一事务）承担。
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
      deps.logger?.info?.(`[lifecycle] reflection triggered=${res.triggered} cards=${res.cardsWritten} skipped=${res.skipped}`);
    } catch (err) {
      deps.logger?.warn?.(`[lifecycle] reflection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 2026-11-07（T1 提案/pending 通道清除）：self_identity pending TTL sweep 与 #92 自动采纳门
  // 已删除——core_pending 表与人工采纳通道不存在，人格/边界由 soul-maintenance worker 自维护。
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
export function startLifecycleScheduler(deps: { store: IMemoryStore; llmRunner: LLMRunner; config?: Partial<LifecycleConfig>; logger?: Logger; embeddingService?: { embed(t: string): Promise<Float32Array> } | null; readAgentProfile?: (agentId: string) => Promise<AgentProfileLike | null> }): () => void {
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
    void runOnce({ store: deps.store, llmRunner: deps.llmRunner, config: cfg, logger: deps.logger, embeddingService: deps.embeddingService, readAgentProfile: deps.readAgentProfile })
      .catch(() => {})
      .finally(() => { runOnceInFlight = false; stallSkips = 0; });
  };
  void tick();
  timer = setInterval(tick, cfg.intervalMs);
  timer.unref?.();
  return () => { if (timer) { clearInterval(timer); timer = null; } };
}