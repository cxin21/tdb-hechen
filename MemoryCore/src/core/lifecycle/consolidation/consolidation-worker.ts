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
import { createHash } from "node:crypto";
import { embedForLifecycle } from "../embed-helpers.js";
import type { IMemoryStore } from "../../store/types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { LLMRunner, Logger } from "../../types.js";
import {
  groupByAttribute,
  groupBySubject,
  isObservable,
  poolRecordsOf,
  type ConsolidationConfig,
  type ConsolidationGroup,
  type SubjectStrategy,
  DEFAULT_CONSOLIDATION_CONFIG,
} from "./grouping.js";
import {
  buildDurativeSummary,
  summarizeImplementationId,
  CONSOLIDATION_SUMMARY_VERSION,
  type DurativeRecord,
} from "./summarizer.js";
import { isIdentityImposition, stripIdentityStateResidue } from "../identity-discovery.js";
import { readEvidenceIds, withEvidenceIds } from "../evidence-ids.js";

export type ConsolidationConfigX = ConsolidationConfig & {
  persist?: boolean;
  /**
   * P3-T17（H1，拍板④）：subject 归组策略门。默认 "llm"——dedup LLM 顺带抽取的
   * 语义 subject（源记忆 metadata.subject）优先，缺省词法兜底（存量行为不变）；
   * "lexical" = 纯词法前缀（修复前行为）。embedding 聚类登记为后续可选项（拍板④）。
   */
  subjectStrategy?: SubjectStrategy;
  /**
   * B1（P6）属性归组开关（config-first，缺省 undefined = 今天行为）：
   * enabled=true 时用 (entity, attribute) 属性键归组，属性归一不了的记录进池内
   * embedding cos ≥ minCos 单链聚类兜底；false/缺省 = 原 subject 归组，逐位不变。
   *
   * 2026-11-02 修正（B1 生产缺陷）：池内补齐先复用库里已入库向量（deps.loadVectors），
   * 只对真正缺失的做有上限补齐（maxPoolEmbeds，缺省 64）；超上限的按单条成组。
   * 旧行为=逐条重嵌全表（生产实证：1903 条进池 → 88 次 429/分钟、tick 10 分钟不结束）。
   */
  attributeGrouping?: { enabled?: boolean; minCos?: number; maxPoolEmbeds?: number };
  /**
   * 单次持续态摘要的 LLM 超时（毫秒，透传给 summarizer.buildDurativeSummary）。
   * 缺省不传 = 用 summarizer 的 DEFAULT_SUMMARIZE_TIMEOUT_MS（180s）。
   */
  summarizeTimeoutMs?: number;
};

export interface ConsolidationWorkerDeps {
  queryL1: () => Promise<Array<MemoryRecord>>;
  llmRunner: LLMRunner;
  config?: ConsolidationConfigX;
  model?: string;
  logger?: Logger;
  /** 持久化用 store（供 upsertL1）。缺省不持久化/仅返回。 */
  store?: IMemoryStore;
  /** R1（09-27 源头嵌入）：产物写入前嵌入；缺省/失败回退 metadata-only（补偿器兜底）。 */
  embeddingService?: { embed(t: string): Promise<Float32Array> } | null;
  /** P2-T14（H-B2）：租户 filter——源记忆租户字段缺失时，持续态归属兜底为 filter 值（与读侧同一租户）。 */
  filter?: { teamId?: string; userId?: string; agentId?: string; taskId?: string };
  /**
   * B1 修正：按 id 批量取已入库向量（生产绑定 store.getL1VectorsByIds）。
   * 未提供 → 池内做有上限的 embed 补齐；抛错 → 本次零补齐（宁可单条成组，不再撞配额）。
   */
  loadVectors?: (ids: string[]) => Promise<Map<string, Float32Array>> | Map<string, Float32Array>;
}

/** B1 修正：每次巩固对池内记录的 embed 补齐上限（config.lifecycle.consolidation.attributeGrouping.maxPoolEmbeds 覆盖）。 */
const DEFAULT_MAX_POOL_EMBEDS = 64;

export interface ConsolidationRunResult {
  groupsFound: number;
  summaries: Array<{ subject: string; durative: DurativeRecord }>;
  persisted: number;
  /** 组内源集合与既有卡指纹一致、本轮未重算的组数（B1 生产缺陷修复，见 sourceFingerprint）。 */
  skippedUnchanged?: number;
  /**
   * A（2026-11-03）：本轮回收的幽灵 #N 卡数（同 base 组缩容后失效的旧后缀卡）。
   * 计的是 store.invalidateL1 真正写成（返回 true）的条数——已失效的卡不重复计。
   */
  reclaimed?: number;
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

/**
 * 从全量记忆中找出「该组已有的持续态」。
 *
 * B1：幂等匹配键升级为 metadata.attribute_key（属性键），旧字段 metadata.subject 保留为
 * 兼容回退——存量卡（只有 subject）仍可被读到/更新，不会因为换键而读不出来变成孤儿卡。
 * 顺序必须是先属性键后 subject：属性模式下一张卡的 subject 也写属性键，但池簇卡没有
 * attribute_key，只能靠 subject 匹配。
 */
function existingDurativeOf(
  group: { subject: string; attributeKey?: string },
  all: Array<MemoryRecord>,
): MemoryRecord | undefined {
  return all.find((m) => {
    if (!(m.type === "work_fact" && m.scene_name === "consolidated")) return false;
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    if (group.attributeKey && meta.attribute_key === group.attributeKey) return true;
    return meta.subject === group.subject;
  });
}

/**
 * B1 生产缺陷（2026-11-02）：属性归组把组数从 8 抬到 20+，而 worker 每 10 分钟 tick 会把
 * 每个组重新喂给 LLM 生成一遍（版本递增 + 重新嵌入）。实测单卡 30–90s（40 成员组 89.1s），
 * 20 组 ≈ 20–30 分钟 > tick 间隔 → lifecycle 互斥锁整段被占、后续 tick 全被跳过，
 * 且 LLM 成本与 l1_archive churn 成倍上涨（24h churnRatio 8.16 同源）。
 *
 * 组身份 + 组内源 id 集合都没变时，卡片内容必然不变——重算没有信息增量。这里算指纹
 * 落卡（metadata.source_fingerprint），下一轮指纹一致就跳过。增量记忆出现 → 指纹变 → 重算。
 * 只影响"是否重算"，不改卡片写法；老卡没有指纹 → 首轮重算一次后补上。
 *
 * B（2026-11-03）：指纹再并入**摘要实现标识**（版本|模型）——否则改 prompt / 换模型后
 * 同证据仍命中旧指纹，新实现永不生效。同一证据 + 同一实现标识仍命中同一指纹 → 幂等
 * 复用既有卡 id（不新建卡），只是重算内容。版本升级语义见 CONSOLIDATION_SUMMARY_VERSION。
 */
export function sourceFingerprint(
  group: { subject: string; attributeKey?: string; memories: Array<{ id?: string }> },
  model?: string,
  version: string = CONSOLIDATION_SUMMARY_VERSION,
): string {
  const ids = group.memories.map((m) => String(m.id ?? "")).sort();
  const impl = summarizeImplementationId(model, version);
  return createHash("sha1")
    .update(`${impl}|${group.attributeKey ?? ""}|${group.subject}|${ids.join(",")}`)
    .digest("hex");
}

/** chunk 后缀：#2、#3…（grouping.splitChunks 切分同一 base 组时追加）；base 组无后缀。 */
const CHUNK_SUFFIX_RE = /#(\d+)$/;

interface ChunkSeriesRef {
  /** series 身份：属性组 attr:<base>，subject 组 subj:<base>（两套键不互相误伤）。 */
  series: string;
  /** chunk 序号：base=0，#2=2，#3=3…（grouping 只产出这些形态）。 */
  index: number;
  /** 原始键（attribute_key 或 subject 的完整文本）。 */
  raw: string;
}

function chunkSeriesOf(group: { subject: string; attributeKey?: string }): ChunkSeriesRef {
  const isAttribute = Boolean(group.attributeKey);
  const raw = group.attributeKey ?? group.subject;
  const m = CHUNK_SUFFIX_RE.exec(raw);
  const index = m ? Number(m[1]) : 0;
  const base = m ? raw.slice(0, raw.length - m[0].length) : raw;
  return { series: `${isAttribute ? "attr" : "subj"}:${base}`, index, raw };
}

/** 卡片的 series 身份：与 existingDurativeOf 同口径，attribute_key 优先，旧卡回退 subject。 */
function cardChunkSeriesOf(card: MemoryRecord): ChunkSeriesRef | undefined {
  const meta = (card.metadata ?? {}) as Record<string, unknown>;
  const attributeKey = typeof meta.attribute_key === "string" ? meta.attribute_key : undefined;
  if (attributeKey) return chunkSeriesOf({ subject: attributeKey, attributeKey });
  const subject = typeof meta.subject === "string" ? meta.subject : undefined;
  return subject ? chunkSeriesOf({ subject }) : undefined;
}

/**
 * A（2026-11-03）幽灵 #N 卡回收：同一 base 组缩容后（例：110 条 → 60 条，3 张卡 → 2 张），
 * 旧 #3 卡没有对应组、无人写它 → valid_end 永远开区间，读侧持续注入过期摘要。
 *
 * 判据（全部满足才失效，宁可留一张过期卡也不误伤）：
 *   1. 卡片是本 worker 的产物（work_fact + consolidated），有 id，且**未参与本轮**
 *      （参与 = 本轮某组经 existingDurativeOf 命中它；命中的卡本轮会被覆写）；
 *   2. 仍未失效（valid_end 为空——幂等的关键：失效过的卡下一轮直接跳过）；
 *   3. 能解析出 series，且该 series **本轮仍在**（本轮出现）——series 整体消失（组跌破
 *      minCount/换 subject）不回收，避免"暂时不巩固"被误判成"永久缩容"；
 *   4. 序号 ≥ 本轮该 series 的 chunk 数（本轮拥有的号不会被误伤）；
 *   5. base（index 0）永不回收——base 缺失时读侧就没有这张卡的当前版本了。
 *
 * 保守门（maxPerRun）：本轮 groups 可能被截断到 maxPerRun，此时某 series 的 chunk 数不可知
 * （后续 chunk 只是"本轮没轮到"），整轮跳过回收。
 *
 * 写入走 store.invalidateL1（既有 supersession 语义：写 valid_end，不 DELETE 行）；SQL 侧还有
 * `(valid_end IS NULL OR valid_end='')` 守卫，重复调用不会覆盖首次失效时间。
 */
async function reclaimGhostChunks(
  groups: ConsolidationGroup[],
  all: Array<MemoryRecord>,
  deps: ConsolidationWorkerDeps,
  cfg: ConsolidationConfigX,
): Promise<number> {
  const store = deps.store;
  const invalidate = store?.invalidateL1;
  if (!store || !invalidate) return 0;
  if (cfg.maxPerRun > 0 && groups.length >= cfg.maxPerRun) return 0;

  // series → 本轮应有的 chunk 数与存活的 raw 键（base 与 #2.. 都算 live）。
  const expected = new Map<string, { count: number; live: Set<string> }>();
  const participating = new Set<string>();
  for (const g of groups) {
    const ref = chunkSeriesOf(g);
    const slot = expected.get(ref.series) ?? { count: 0, live: new Set<string>() };
    slot.count = Math.max(slot.count, ref.index + 1);
    slot.live.add(ref.raw);
    expected.set(ref.series, slot);
    const existing = existingDurativeOf(g, all);
    if (existing?.id) participating.add(String(existing.id));
  }

  let reclaimed = 0;
  const nowIso = new Date().toISOString();
  for (const card of all) {
    if (!(card.type === "work_fact" && card.scene_name === "consolidated")) continue;
    const id = String(card.id ?? "");
    if (!id || participating.has(id)) continue;
    if (card.valid_end) continue; // 已失效 → 幂等跳过
    const ref = cardChunkSeriesOf(card);
    if (!ref || ref.index === 0) continue;
    const slot = expected.get(ref.series);
    if (!slot) continue; // series 本轮消失：不回收
    if (ref.index < slot.count) continue;
    if (slot.live.has(ref.raw)) continue; // 本轮仍产出该键（数量未缩）
    try {
      const ok = await Promise.resolve(invalidate.call(store, id, nowIso));
      if (ok) reclaimed++;
    } catch (err) {
      deps.logger?.warn?.(
        `[consolidation] reclaim ghost failed: card=${id} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return reclaimed;
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
      activity_end_time: d.activity_end_at,
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
    // F1：持续态是开区间 —— valid_end 不写（store 落 ""，读侧 parseTime("")=undefined=active）。
    // 窗口末走 metadata.activity_end_time，见 durativeToMemoryRecord 的 metadata 段。
    valid_end: undefined,
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

/**
 * B1（P6）：选组门——attributeGrouping.enabled 时走属性键归组，否则逐位保持 subject 归组。
 *
 * 池内记录（属性归一不了）由本层异步 embed（grouping 层保持纯同步/可单测），
 * 失败/无向量 → 该记录各自成组（不丢弃：丢一条就丢一份证据）。
 */
async function selectGroups(
  sources: MemoryRecord[],
  cfg: ConsolidationConfigX,
  deps: ConsolidationWorkerDeps,
): Promise<ConsolidationGroup[]> {
  const attr = cfg.attributeGrouping;
  if (!attr?.enabled) {
    return groupBySubject(sources, cfg, deps.logger, cfg.subjectStrategy ?? "llm");
  }
  const pool = poolRecordsOf(sources);
  const vectors = new Map<string, Float32Array>();
  if (pool.length === 0) {
    return groupByAttribute(sources, cfg, deps.logger, { minCos: attr.minCos, vectors });
  }

  // ① 复用库里已入库向量（关键）：巩固层不得对池内记录重嵌全表——2026-11-02 生产实证：
  //    3861 行库 / 1903 行进池 × 逐条 embed → 88 次 429/分钟、lifecycle tick 互斥 10+ 分钟不结束、
  //    L1 写入与召回全线降级。这些向量在 l1_vec 里本来就有。
  const poolIds = pool.map((m) => String(m.id ?? "")).filter((id) => id.length > 0);
  let loadVectorsFailed = false;
  if (deps.loadVectors && poolIds.length > 0) {
    try {
      const stored = await deps.loadVectors(poolIds);
      for (const [id, v] of stored) if (v && v.length > 0) vectors.set(id, v);
    } catch (err) {
      // 读向量失败 ≠ 可以放开重嵌：配额是共享资源，本次零补齐，缺失的按单条成组（不丢证据）。
      loadVectorsFailed = true;
      deps.logger?.warn?.(
        `[consolidation-pool] loadVectors failed, skip pool embeds this run: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ② 只补真正缺失的向量，且每次有上限（缺省 64）：超上限的本轮按单条成组，下轮再补。
  if (!loadVectorsFailed) {
    const maxEmbeds = Math.max(0, Math.floor(attr.maxPoolEmbeds ?? DEFAULT_MAX_POOL_EMBEDS));
    const missing = pool.filter((m) => {
      const id = String(m.id ?? "");
      return id.length > 0 && !vectors.has(id);
    });
    const toEmbed = maxEmbeds > 0 ? missing.slice(0, maxEmbeds) : [];
    for (const m of toEmbed) {
      const v = await embedForLifecycle(
        deps.embeddingService,
        String(m.content ?? ""),
        "[consolidation-pool]",
        deps.logger,
      );
      if (v) vectors.set(String(m.id ?? ""), v);
    }
    if (missing.length > toEmbed.length) {
      deps.logger?.debug?.(
        `[consolidation-pool] embeds capped: pool=${pool.length} missing=${missing.length} embedded=${toEmbed.length} cap=${maxEmbeds} (余下本轮按单条成组)`,
      );
    }
  }
  return groupByAttribute(sources, cfg, deps.logger, { minCos: attr.minCos, vectors });
}

export async function runConsolidation(deps: ConsolidationWorkerDeps): Promise<ConsolidationRunResult> {
  const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, ...(deps.config ?? {}) };
  if (!cfg.enabled) return { groupsFound: 0, summaries: [], persisted: 0, skippedUnchanged: 0 };
  const memories = await deps.queryL1();
  // P3-T17：行元数据归一化（metadata_json → metadata），见 normalizeRowMetadata 注释。
  const all = (Array.isArray(memories) ? memories : []).map(normalizeRowMetadata);
  const sources = sourceMemories(all);
  // P2-T14（H-B2 数据级双保险）：groupBySubject 内做组内租户一致性校验——
  // 混租户同前缀组整组丢弃 + warn（log 经 deps.logger 透传）。
  // P3-T17（H1，拍板④）：subject 归组策略门（默认 llm：语义 subject 优先、词法兜底），
  // 从 deps.config 读 strategy 传入。
  const groups = await selectGroups(sources, cfg, deps);
  if (groups.length === 0) return { groupsFound: 0, summaries: [], persisted: 0, skippedUnchanged: 0 };

  const summaries: Array<{
    subject: string;
    attributeKey?: string;
    entity?: string;
    attribute?: string;
    durative: DurativeRecord;
    sourceIds: string[];
    fingerprint: string;
    evSource: MemoryRecord;
  }> = [];
  let persisted = 0;
  let skippedUnchanged = 0;
  let reclaimed = 0;
  for (const g of groups) {
    // B：指纹并入实现标识（版本|模型）——换模型/改 prompt 后同证据也会重算。
    const fingerprint = sourceFingerprint(g, deps.model);
    // 源集合与既有卡指纹一致 → 本轮不重算（省 LLM 时间/成本；见 sourceFingerprint 注释）。
    const existingCard = existingDurativeOf(g, all);
    const existingFp = (existingCard?.metadata as Record<string, unknown> | undefined)?.source_fingerprint;
    if (
      existingCard &&
      typeof existingCard.content === "string" &&
      existingCard.content.trim() !== "" &&
      existingFp === fingerprint
    ) {
      skippedUnchanged++;
      deps.logger?.debug?.(
        `[consolidation] skip unchanged "${g.subject}" (sources=${g.memories.length})`,
      );
      continue;
    }
    const d = await buildDurativeSummary(g, {
      llmRunner: deps.llmRunner,
      config: { model: deps.model, timeoutMs: cfg.summarizeTimeoutMs },
      logger: deps.logger,
    });
    if (d) {
      summaries.push({
        subject: g.subject,
        attributeKey: g.attributeKey,
        entity: g.entity,
        attribute: g.attribute,
        durative: { ...d, subject: g.subject },
        sourceIds: g.memories.map((m) => m.id).filter(Boolean),
        fingerprint,
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
        // R5 新缺口（D-R5-7）：蒸馏层身份门——对抗人设/指令/定时状态内容经 L1 承载后
        // 会被蒸馏成「用户偏好」结论卡固化进 L3（ev11 实证：老板大人/秘书/冥想提醒），
        // 绕过 identity-discovery 全部门。第一性原理：蒸馏产物也是身份相关内容的写入面，
        // 必须同过门（单一源：isIdentityImposition 拦人设回显，stripIdentityStateResidue
        // 拦状态陈述/指令）；命中即整条拒收留痕（宁缺毋滥）。
        const gateText = `${s.subject}\n${s.durative.content}`;
        if (isIdentityImposition(gateText) || stripIdentityStateResidue(gateText) === "") {
          deps.logger?.warn?.(`[consolidation] distill gate rejected "${s.subject}" (identity gate)`);
          continue;
        }
        const existing = existingDurativeOf(s, all);
        const rec = durativeToMemoryRecord(s.durative, existing, s.evSource, deps.filter);
        // B1：属性键落卡（幂等标识 + 读面可解释"这张卡覆盖哪个实体的哪类属性"）。
        // subject 仍照旧写（旧读方/旧卡兼容），attribute_key 才是新的幂等键。
        if (s.attributeKey) {
          const meta = (rec.metadata ?? {}) as Record<string, unknown>;
          rec.metadata = {
            ...meta,
            attribute_key: s.attributeKey,
            entity: s.entity,
            attribute: s.attribute,
          } as unknown as MemoryRecord["metadata"];
        }
        // B1 生产缺陷（2026-11-02）：指纹落卡——下一轮同输入直接跳过重算（见 sourceFingerprint）。
        rec.metadata = {
          ...((rec.metadata ?? {}) as Record<string, unknown>),
          source_fingerprint: s.fingerprint,
        } as unknown as MemoryRecord["metadata"];
        // #155 写面一致性：证据指针与 part_of 边必须同口径。addLink 是 ON CONFLICT 幂等累积，
        // 而本行旧实现每轮把证据整列覆盖成"本轮组内源"——复蒸馏后两套证据链分叉（边=累计 N 轮、
        // metadata=仅最近一轮），读面回退任一来源都只看到部分证据。改成同样累积 + 去重（顺序保留）：
        //   读：readEvidenceIds(existing.metadata)（canonical 优先、回退旧键）；不能整体展开
        //       existing.metadata——那会用上一轮的 occurred_at/observed_count 覆盖本轮真值。
        //   写：withEvidenceIds 双写 evidence_ids + evidence_record_ids，键名契约单源在
        //       evidence-ids.ts，两类结论卡（consolidated / reflection）的证据键集合因此完全一致。
        const evidenceIds = [...readEvidenceIds(existing?.metadata), ...s.sourceIds];
        rec.metadata = withEvidenceIds(rec.metadata as Record<string, unknown> | undefined, evidenceIds) as unknown as MemoryRecord["metadata"];
        if (deps.store.upsertL1(rec, await embedForLifecycle(deps.embeddingService, String(rec.content ?? ""), "[consolidation]", deps.logger))) {
          persisted++;
          // 时空网络/回忆：持续态(work_fact) → 其点状证据，建 part_of 边（记忆图可见"证据链"）
          // #155（M3）：addLink 返回 MaybePromise<boolean>（types.ts:736），异步 store 下不 await
          // 会在 runConsolidation 返回后丢边——边没了，读面 getLinksBySource 就永远空。
          // 对齐 reflection.ts writeReflectionPartOfEdges：逐边 await + soft-fail（单边失败不阻塞其余）。
          if (deps.store.addLink && s.sourceIds.length > 0) {
            for (const ev of s.sourceIds) {
              try {
                const ok = await Promise.resolve(deps.store.addLink(rec.id, ev, "part_of", 1));
                if (!ok) deps.logger?.warn?.(`[consolidation] part_of edge soft-failed (returned false): card=${rec.id} evidence=${ev}`);
              } catch (err) {
                deps.logger?.warn?.(`[consolidation] part_of edge soft-failed: card=${rec.id} evidence=${ev} err=${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
          deps.logger?.debug?.(
            `[consolidation] ${existing ? "re-consolidate (update)" : "create"} durative "${s.subject}" id=${rec.id} v=${rec.version} sources=${s.sourceIds.length}`,
          );
        }
      } catch (err) {
        deps.logger?.warn?.(`[consolidation] persist failed for "${s.subject}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A：落卡之后回收同 base 组缩容留下的幽灵 #N 卡（写 valid_end，不删行）。
    // 放在持久化之后：participating 集合用的是本轮 groups 的命中卡，与写入结果无关；
    // 且在 maxPerRun 截断时内部直接跳过（见 reclaimGhostChunks 保守门）。
    reclaimed = await reclaimGhostChunks(groups, all, deps, cfg);
  }
  deps.logger?.info?.(
    `[consolidation] ran: groups=${groups.length}, summaries=${summaries.length}, persisted=${persisted}, skippedUnchanged=${skippedUnchanged}, reclaimed=${reclaimed} (sources=${sources.length})`,
  );
  return { groupsFound: groups.length, summaries, persisted, skippedUnchanged, reclaimed };
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