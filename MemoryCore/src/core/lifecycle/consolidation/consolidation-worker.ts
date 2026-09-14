/**
 * H 巩固 · worker：读取 L1 → 按 subject 分组（阈值/跨期配置化）→ LLM 生成持续态摘要。
 * 持久化：持续态写为一个 [work_fact/observed] L1 记录（observed 红线；原 L1 保留为证据）。
 * 幂等 + best-effort；持久化受 config.persist 控制，失败不阻塞。
 *
 * 审计 F4（第三轮）：
 *   - 幂等：同一 subject 若已有持续态，则复用其 record_id 版本递增覆写，不再每次 tick 新建——
 *     防「同组 ≥3 条 + 跨期」一直满足时每 10 分钟重复 LLM 生成 + 持久化导致持续态无限增殖。
 *   - 租户继承：持续态必须继承源记忆的 team/user/agent，否则隔离查询召不回自己的巩固产物。
 *   - work_fact 不参与源分组（防"摘要的摘要"自我 reinforce，且让 minCount/可用 subject 计数真实）。
 */
import type { IMemoryStore } from "../../store/types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { LLMRunner, Logger } from "../../types.js";
import { groupBySubject, isObservable, type ConsolidationConfig, type SubjectStrategy, DEFAULT_CONSOLIDATION_CONFIG } from "./grouping.js";
import { buildDurativeSummary, type DurativeRecord } from "./summarizer.js";

export type ConsolidationConfigX = ConsolidationConfig & {
  persist?: boolean;
  /**
   * P3-T17（H1，拍板④）：subject 归组策略门。默认 "llm"——dedup LLM 顺带抽取的
   * 语义 subject（源记忆 metadata.subject）优先，缺省词法兜底（存量行为不变）；
   * "lexical" = 纯词法前缀（修复前行为）。embedding 聚类登记为后续可选项（拍板④）。
   */
  subjectStrategy?: SubjectStrategy;
};

export interface ConsolidationWorkerDeps {
  queryL1: () => Promise<Array<MemoryRecord>>;
  llmRunner: LLMRunner;
  config?: ConsolidationConfigX;
  model?: string;
  logger?: Logger;
  /** 持久化用 store（供 upsertL1）。缺省不持久化/仅返回。 */
  store?: IMemoryStore;
  /** P2-T14（H-B2）：租户 filter——源记忆租户字段缺失时，持续态归属兜底为 filter 值（与读侧同一租户）。 */
  filter?: { teamId?: string; userId?: string; agentId?: string; taskId?: string };
}

export interface ConsolidationRunResult {
  groupsFound: number;
  summaries: Array<{ subject: string; durative: DurativeRecord }>;
  persisted: number;
}

/** 只取源记忆（非持续态）参与分组——防止 work_fact 自我 reinforce。 */
function sourceMemories(all: Array<MemoryRecord>): Array<MemoryRecord> {
  // 持续态以 type=work_fact 且 scene_name=consolidated 标识；排除它们做源。
  // P0-T1（H-B3）：守卫在咽喉——进组唯一入口接 isObservable，
  // inferred（推断）源记忆不得被熬成 certainty="observed" 的持续态（洗白门）。
  return all.filter((m) => !(m.type === "work_fact" && m.scene_name === "consolidated") && isObservable(m));
}

/**
 * P3-T17：行归一化兜底。
 * queryL1 的行来源可能是 store 裸行——sqlite 的 L1RecordRow 用 record_id + metadata_json
 * （字符串），而 lifecycle-scheduler 的行映射把 r.metadata（行上不存在 → undefined）展开进
 * metadata，且不带 id。后果（真实链路）：
 *   - subjectOfLlm 读不到 metadata.subject → T17 语义归组失效；
 *   - existingDurativeOf 读不到持续态幂等键，且 existing.id 缺失 → F4 幂等失效（每 tick 增殖）；
 *   - sourceIds 取 m.id 恒空 → evidence_ids 恒空（证据链断裂）。
 * 这里归一化：metadata_json 解析合并进 metadata（行上已有 metadata 字段优先，防覆盖映射补的
 * 时间字段）、record_id 兜底为 id。best-effort：metadata_json 缺失/非法 JSON → 跳过该项修复。
 *
 * P3-T17.5（B）：T17.5-A 已在 scheduler 源头根治行映射，本函数保留为防御（对 tcvdb/单测等
 * 非 scheduler 来源仍有效），但合并方向修正（F-2 双保险）：行 metadata 字段里的派生空串
 * （如 activity_start_time:""）不再盖 metadata_json 真值——空串无信息量，与 T17.5-A 同款过滤。
 * 导出仅供 verify-p3-t17-5 同形断言驱动。
 */
export function normalizeRowMetadata(m: MemoryRecord): MemoryRecord {
  const out: Record<string, unknown> = { ...(m as unknown as Record<string, unknown>) };
  // record_id → id（裸行缺 id：F4 幂等复用与 evidence_ids 都依赖 id）
  if (!out.id) {
    const rid = out.record_id;
    if (typeof rid === "string" && rid) out.id = rid;
  }
  const mj = out.metadata_json;
  if (typeof mj === "string" && mj.trim()) {
    try {
      const v = JSON.parse(mj) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const meta = (out.metadata ?? {}) as Record<string, unknown>;
        // F-2 修正：过滤空串后再覆盖（空串派生值不得盖 metadata_json 真值）
        const nonEmpty = Object.fromEntries(Object.entries(meta).filter(([, val]) => val !== ""));
        out.metadata = { ...(v as Record<string, unknown>), ...nonEmpty };
      }
    } catch {
      // 非法 JSON：不猜，保持原样（P-D：拿不到真值不造假值）
    }
  }
  return out as unknown as MemoryRecord;
}

/** 从全量记忆中找出「该 subject 已有的持续态」（幂等匹配键 = metadata.subject）。 */
function existingDurativeOf(subject: string, all: Array<MemoryRecord>): MemoryRecord | undefined {
  return all.find((m) => {
    if (!(m.type === "work_fact" && m.scene_name === "consolidated")) return false;
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    return meta.subject === subject;
  });
}

function durativeToMemoryRecord(
  d: DurativeRecord,
  existing: MemoryRecord | undefined,
  evSource: MemoryRecord,
  filter?: { teamId?: string; userId?: string; agentId?: string; taskId?: string },
): MemoryRecord {
  const base: MemoryRecord = {
    // 幂等：有既有持续态则复用其 id（ON CONFLICT DO UPDATE 版本递增），否则新建。
    id: existing?.id ?? `dur_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    content: d.content,
    type: "work_fact",
    priority: 80,
    scene_name: "consolidated",
    source_message_ids: [],
    // 审计修复：metadata 断言为宽松类型；F4 加 subject 作幂等键、evidence_ids 记证据链。
    metadata: {
      occurred_at: d.occurred_at,
      activity_start_time: d.valid_start,
      activity_end_time: d.valid_end,
      observed_count: d.observedCount,
      subject: d.subject,
    } as Record<string, unknown> as MemoryRecord["metadata"],
    timestamps: [d.occurred_at],
    createdAt: existing?.createdAt ?? d.occurred_at,
    updatedAt: d.occurred_at,
    version: (existing?.version ?? 0) + 1,
    sessionKey: existing?.sessionKey ?? "consolidation",
    sessionId: existing?.sessionId ?? "consolidation",
    occurred_at: d.occurred_at,
    valid_start: d.valid_start,
    valid_end: d.valid_end,
    certainty: d.certainty,
    valence: 0,
    arousal: 0,
    significance: d.significance,
  };
  // 租户继承（F4）：优先保留既有持续态的归属，否则从源记忆继承（source 里的任一非空值即可）。
  // P2-T14（H-B2）：仍缺的字段用 scheduler 传入的 filter 兜底（写路径与读侧同一租户）。
  return inheritTenancy(base, existing, evSource, filter);
}

/** 从已有持续态 / 源记忆 / lifecycle filter 继承租户归属（F4：持续态必须属于发起方，否则隔离查询召不回）。 */
function inheritTenancy(
  base: MemoryRecord,
  existing: MemoryRecord | undefined,
  evSource: MemoryRecord,
  filter?: { teamId?: string; userId?: string; agentId?: string; taskId?: string },
): MemoryRecord {
  const out = { ...base };
  const baseT = out as unknown as { teamId?: string; userId?: string; agentId?: string; taskId?: string };
  const pickFrom = (src: MemoryRecord): void => {
    const s = src as unknown as { teamId?: string; userId?: string; agentId?: string; taskId?: string };
    if (!baseT.teamId && s.teamId) baseT.teamId = s.teamId;
    if (!baseT.userId && s.userId) baseT.userId = s.userId;
    if (!baseT.agentId && s.agentId) baseT.agentId = s.agentId;
    if (!baseT.taskId && s.taskId) baseT.taskId = s.taskId;
  };
  if (existing) pickFrom(existing);
  pickFrom(evSource);
  if (filter) {
    if (!baseT.teamId && filter.teamId) baseT.teamId = filter.teamId;
    if (!baseT.userId && filter.userId) baseT.userId = filter.userId;
    if (!baseT.agentId && filter.agentId) baseT.agentId = filter.agentId;
    if (!baseT.taskId && filter.taskId) baseT.taskId = filter.taskId;
  }
  return out;
}

export async function runConsolidation(deps: ConsolidationWorkerDeps): Promise<ConsolidationRunResult> {
  const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, ...(deps.config ?? {}) };
  if (!cfg.enabled) return { groupsFound: 0, summaries: [], persisted: 0 };
  const memories = await deps.queryL1();
  // P3-T17：行元数据归一化（metadata_json → metadata），见 normalizeRowMetadata 注释。
  const all = (Array.isArray(memories) ? memories : []).map(normalizeRowMetadata);
  const sources = sourceMemories(all);
  // P2-T14（H-B2 数据级双保险）：groupBySubject 内做组内租户一致性校验——
  // 混租户同前缀组整组丢弃 + warn（log 经 deps.logger 透传）。
  // P3-T17（H1，拍板④）：subject 归组策略门（默认 llm：语义 subject 优先、词法兜底），
  // 从 deps.config 读 strategy 传入。
  const groups = groupBySubject(sources, cfg, deps.logger, cfg.subjectStrategy ?? "llm");
  if (groups.length === 0) return { groupsFound: 0, summaries: [], persisted: 0 };

  const summaries: Array<{ subject: string; durative: DurativeRecord; sourceIds: string[]; evSource: MemoryRecord }> = [];
  let persisted = 0;
  for (const g of groups) {
    const d = await buildDurativeSummary(g, { llmRunner: deps.llmRunner, config: { model: deps.model }, logger: deps.logger });
    if (d) {
      summaries.push({
        subject: g.subject,
        durative: { ...d, subject: g.subject },
        sourceIds: g.memories.map((m) => m.id).filter(Boolean),
        // 租户继承源（F4）：组内首条记忆。P2-T14 后组内租户已由 grouping 校验一致
        // （混租户组整组丢弃），首条即全组归属。
        evSource: g.memories[0],
      });
    }
  }
  // 持久化：写为一个 observed/work_fact L1 记录 + 建"证据链"边（best-effort；失败不阻塞）
  if (cfg.persist !== false && deps.store?.upsertL1) {
    for (const s of summaries) {
      try {
        const existing = existingDurativeOf(s.subject, all);
        const rec = durativeToMemoryRecord(s.durative, existing, s.evSource, deps.filter);
        rec.metadata = { ...(rec.metadata ?? {}), evidence_ids: s.sourceIds } as Record<string, unknown> as MemoryRecord["metadata"];
        if (deps.store.upsertL1(rec, undefined)) {
          persisted++;
          // 时空网络/回忆：持续态(work_fact) → 其点状证据，建 part_of 边（记忆图可见"证据链"）
          if (deps.store.addLink && s.sourceIds.length > 0) {
            for (const ev of s.sourceIds) deps.store.addLink(rec.id, ev, "part_of", 1);
          }
          deps.logger?.debug?.(
            `[consolidation] ${existing ? "re-consolidate (update)" : "create"} durative "${s.subject}" id=${rec.id} v=${rec.version} sources=${s.sourceIds.length}`,
          );
        }
      } catch (err) {
        deps.logger?.warn?.(`[consolidation] persist failed for "${s.subject}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  deps.logger?.info?.(`[consolidation] ran: groups=${groups.length}, summaries=${summaries.length}, persisted=${persisted} (sources=${sources.length})`);
  return { groupsFound: groups.length, summaries, persisted };
}

/** 便捷封装：从 store 读 L1 后巩固（隔离过滤可选）。 */
export async function runConsolidationOnStore(
  store: IMemoryStore,
  llmRunner: LLMRunner,
  opts: { config?: ConsolidationConfigX; filter?: { teamId: string; userId: string; agentId: string }; logger?: Logger },
): Promise<ConsolidationRunResult> {
  return runConsolidation({
    queryL1: async () => (store.queryL1Records ? await store.queryL1Records(opts.filter) : []) as unknown as MemoryRecord[],
    llmRunner,
    config: opts.config,
    logger: opts.logger,
    store,
  });
}