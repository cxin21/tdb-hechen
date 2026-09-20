/**
 * memory_search tool: Agent-callable tool for searching L1 memory records.
 *
 * Supports three search strategies with automatic degradation:
 *   1. **hybrid** (default) — FTS5 keyword + vector embedding in parallel,
 *      merged via Reciprocal Rank Fusion (RRF).
 *   2. **embedding** — pure vector similarity (when FTS5 is unavailable).
 *   3. **fts** — pure FTS5 keyword search (when embedding is unavailable).
 *
 * The tool is registered via `api.registerTool()` in index.ts.
 */

import type { IMemoryStore, IsolationFilter, L1SearchResult, MaybePromise } from "../store/types.js";
import { normalizeCoreTenant, type CoreTenant } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";
import { parseTimeWindow, inTimeWindow, type TimeWindow } from "./content-time-window.js";
import { isInvalidated } from "../recall/filter-invalidated.js";
import { rowMatchesIsolation } from "../store/isolation.js";
import { emotionSalienceOf } from "./recall-signals.js";
import {
  buildRankContext,
  DEFAULT_RANK_SIGNALS,
  detectSceneHit,
  sceneSignalOf,
  structuralSignalOf,
  type RankSignals,
} from "./recall-signals.js";
import { runPPRDetail, type PPREdge } from "../recall/ppr.js";
import {
  expandQuery,
  mergeFtsQueryWithExpansion,
  resolveQueryExpansionRunner,
  type ExpansionRunner,
  type QueryExpansionLlmConfig,
} from "../recall/query-expand.js";

// ============================
// Types
// ============================

export interface MemorySearchResultItem {
  id: string;
  content: string;
  type: string;
  team_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  priority: number;
  scene_name: string;
  score: number;
  version: number;
  created_at: string;
  updated_at: string;
  // 灵魂记忆字段读回（P2a）——供 R4/J 等使用
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
  /**
   * C1（灵魂记忆 spec §2.2）：行 metadata 读回（metadata_json 解析）。
   * coreRefBoost 消费 metadata.coreRefs；FTS 行此前不携带 metadata（coreRefs 死读）。
   */
  metadata?: Record<string, unknown>;
  /**
   * C1：本轮"相关"的价值锚 = metadata.coreRefs ∩ query appraisal 命中（fired）。
   * 展示层只显示这个交集（宁缺毋滥：不是所有 coreRefs 都显示）；由
   * executeMemorySearch 在排序阶段计算并标注，coreRefBoost=0 时恒缺省。
   */
  touched_core_refs?: string[];
  /**
   * R-A2（候选池通道，spec §2 R4/R5）：通道自证身份标注（诚实原则）。
   * "graph:ppr:<kind>" = 引擎二 PPR 全图扩散候选（V2-1：派生分=maxHitScore×graphDiscount×pprNorm，
   * 未过绝对门槛；多跳一步到位——一跳 BFS 补池已整体替换，预期行为变更已登记）；
   * "value:<锚>" = 价值反查补池（score=0，位次由 valueBoost/coreRef 通道赋予）。
   * 主检索命中条目恒缺省（区分"相关匹配"与"关联召回"）。
   */
  recall_channel?: string;
}

export interface MemorySearchResult {
  results: MemorySearchResultItem[];
  total: number;
  strategy: string;
  /**
   * T15-C（向量健康三件套）降级可见：true = embedding 已配置，但本次召回实际只走了
   * FTS（strategy==="fts"）——向量层死亡或无向量命中。下游（工具响应/注入块）
   * 应标注 `[degraded: fts-only]`，让用户与 LLM 知道自己在看残废召回。
   * 向量路径（embedding/hybrid）恒 false/undefined。
   */
  degraded?: boolean;
  /** Optional message, e.g. when embedding is not configured. */
  message?: string;
}

const TAG = "[memory-tdai][tdai_memory_search]";

// P0-T4（H-B1）：tcvdb 等后端无 bumpRecallCount 时回退 read-then-write，
// 该 fallback 的 recall_count 恒 1 —— 进程内只 warn 一次（F7 家族：降级如实登记）。
let reconsolidationFallbackWarned = false;

/**
 * 重巩固（reconsolidation，H 设计§4 / spec §4.3）：回忆即强化，仅 observed。
 * 最小诚实实现：不重写 content（防"越回忆越信自己的编造"），只更新召回统计
 * （metadata.recall_count/last_recalled_at），遗忘侧读它做抗遗忘 boost。
 * fire-and-forget、best-effort、只动种子命中（不含邻居扩展），宁缺毋滥。
 *
 * T1-D（T12 审计 F7 同族收官）：自 executeMemorySearch 主路径提取为函数，
 * native-hybrid 早退分支（TCVDB）同样复用——修复 T17.5 审计确认的
 * "native-hybrid 提前 return 跳过 reconsolidation" 缺口。提取为纯代码移动
 *（同语句、同顺序、模块级 warn 标志生命周期不变），主路径行为零变化；
 * native-hybrid 路径为新增行为（早退前对 trimmed 执行，T2 门照常适用——
 * tcvdb 行带 soul 列 certainty，T17.5 审计确认）。
 */
function triggerReconsolidation(
  trimmed: MemorySearchResultItem[],
  vectorStore: IMemoryStore,
  logger: Logger | undefined,
): void {
  try {
    const store = vectorStore as IMemoryStore & {
      updateL1Metadata?: (id: string, patch: Record<string, unknown>) => MaybePromise<boolean>;
      bumpRecallCount?: (id: string, now?: string) => MaybePromise<boolean>;
    };
    if (store?.updateL1Metadata || store?.bumpRecallCount) {
      const nowIso = new Date().toISOString();
      for (const r of trimmed.slice(0, 3)) {
        // 红线：仅 observed 可重巩固（白名单）。FTS 路径行 certainty 恒 undefined
        // （l1_fts 无 certainty 列，W1 未修），黑名单式 === "inferred" 会放行 undefined，
        // inferred 记忆经 FTS 命中也吃抗遗忘 boost —— 必须只放行实证记忆。
        if ((r as { certainty?: string }).certainty !== "observed") continue;
        if (typeof store.bumpRecallCount === "function") {
          // P0-T4（H-B1）：SQL 原子自增，不读回 —— recall_count 真实累加，
          // min(c,5)*0.02 的抗遗忘 boost 生产可达。
          void Promise.resolve(store.bumpRecallCount(r.id, nowIso)).catch(() => {});
        } else {
          // feature-detect 回退（tcvdb 等后端无 bumpRecallCount）：旧 read-then-write 路径。
          // C1 起召回 item 携带 metadata（metadata_json 读回）——后端返回 metadata_json
          // 时 prevCount 可读真值；仍不返回 metadata_json 的后端 prevCount 恒 0
          // → recall_count 恒 1（降级如实 warn 一次，不静默）。
          if (!reconsolidationFallbackWarned) {
            reconsolidationFallbackWarned = true;
            logger?.warn?.(
              `${TAG} [reconsolidation] store 无 bumpRecallCount，回退 read-then-write：recall_count 依赖召回 item 的 metadata（C1 起携带）；后端不返回 metadata_json 时恒 1`,
            );
          }
          const prevMeta = (r as { metadata?: Record<string, unknown> }).metadata ?? {};
          const prevCount = typeof prevMeta.recall_count === "number" ? prevMeta.recall_count : 0;
          void Promise.resolve(
            store.updateL1Metadata!(r.id, { recall_count: prevCount + 1, last_recalled_at: nowIso }),
          ).catch(() => {});
        }
      }
    }
  } catch { /* reconsolidation is best-effort; never break search */ }
}

// ============================
// RRF (Reciprocal Rank Fusion)
// ============================

/** Standard RRF constant from the original RRF paper. */
// RRF K=60：Cormack et al. (2009) 原论文标准常数——协议不变量，硬编码不配置化（GOLD-EVO 判定 2026-09-15）
const RRF_K = 60;

/**
 * Merge multiple ranked lists of `MemorySearchResultItem` via Reciprocal Rank
 * Fusion. Items appearing in multiple lists get their RRF scores summed.
 *
 * Returns items sorted by descending RRF score. The `score` field of each
 * returned item is replaced by the RRF score for consistent ranking semantics.
 */
function rrfMergeL1(...lists: MemorySearchResultItem[][]): MemorySearchResultItem[] {
  const map = new Map<string, { item: MemorySearchResultItem; rrfScore: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const score = 1 / (RRF_K + rank + 1);
      const existing = map.get(item.id);
      if (existing) {
        existing.rrfScore += score;
      } else {
        map.set(item.id, { item, rrfScore: score });
      }
    }
  }

  return [...map.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ item, rrfScore }) => ({ ...item, score: rrfScore }));
}

// ============================
// C1 coreRef 召回消费（spec §2.2：检索层冻结，价值信号只进排序 tiebreak/展示）
// ============================

/** metadata_json 宽松解析（容忍损坏 → {}，不造假值）。P-A：唯一实现，网关透传复用。 */
export function parseMetadata(json: string | undefined | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 行上标注的 coreRefs（string[] 宽松校验；缺省/空 = 未标注）。 */
function coreRefsOf(r: Pick<MemorySearchResultItem, "metadata">): string[] {
  const refs = r.metadata?.coreRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
}

/**
 * C1 排序加成（plan Interfaces 契约导出）：query 的 appraisal 命中价值 V ∧ 记忆
 * metadata.coreRefs 含 V → +boost（默认 0.05，0=关闭）。与 priority*1e-6 同族的
 * 轻度 tiebreak——只改变同等相关者中的位次，**不参与检索打分、不越过绝对门槛**。
 */
export function resolveCoreRefBoost(
  r: Pick<MemorySearchResultItem, "metadata">,
  firedLabels: readonly string[],
  boost: number,
): number {
  if (!(boost > 0) || firedLabels.length === 0) return 0;
  const refs = coreRefsOf(r);
  return refs.some((s) => firedLabels.includes(s)) ? boost : 0;
}

/** 本轮"相关"价值 = coreRefs ∩ fired（按 fired 顺序，确定性）。 */
function touchedCoreRefs(r: Pick<MemorySearchResultItem, "metadata">, firedLabels: readonly string[]): string[] {
  const refs = coreRefsOf(r);
  if (refs.length === 0 || firedLabels.length === 0) return [];
  return firedLabels.filter((l) => refs.includes(l));
}

/**
 * C1/R-A1 排序 tiebreak —— 三刀·刀一（2026-09-12 队长裁决）：字典序两段式。
 *
 * 病灶（golden q9，runs/2026-09-12T12-08-44 perQuery[8]）：旧加法 rankKey
 * （score + priority*1e-6 + coreRefBoost + 信号和）×R3 乘法让 query 无关先验
 * 越过相邻相关度档（相邻 RRF 档差 ≈ 2.8e-4，信号和可达 ~6e-4）——相关项被夺位。
 *
 * 新语义（行为变更，已登记 spec §8：加法混排→字典序）：
 *   primary = fused score（**永不**被任何信号改动）；
 *   次级判据只在 primary **精确平局组内**生效，字典序依次为：
 *     priority 降序 → coreRefBoost 降序 → inferred 殿后（R3 语义平移）→
 *     结构信号和（R1 时窗/时近 + R2 + R8 + R9 + R6 场景）降序。
 *   真平局常见（RRF 同名次 → 1/(60+rank) 逐位相等），信号仍有真实作用域。
 * 关断恒等：信号全 0 → 次级判据全 0 → 比较器退化为 score 降序**稳定**排序
 *   （ES2019+ Array.sort 稳定性），与基线逐位一致（可证明，勿跳过排序——f53b173 教训）。
 * touched_core_refs 标注逻辑不变；score 字段本身零改动；检索打分/门槛/RRF 融合零改动。
 */
function applyCoreRefTiebreak(
  items: MemorySearchResultItem[],
  firedLabels: readonly string[],
  coreRefBoost: number,
  rankCtx?: {
    moodSign: number;
    timeWindow: TimeWindow | null;
    signals: RankSignals;
    now: Date;
    /** R-A2（R6）：场景命中（detectSceneHit 结果）+ 加成幅度（tiebreak 层）。 */
    sceneHit?: string | null;
    sceneBoost?: number;
  },
): MemorySearchResultItem[] {
  const secondaryOf = (r: MemorySearchResultItem): [number, number, number, number, number] => [
    typeof r.priority === "number" && Number.isFinite(r.priority) ? r.priority : 0,
    resolveCoreRefBoost(r, firedLabels, coreRefBoost),
    // R3 inferred 殿后旗标（升序消费：observed=0 在前，inferred=1 殿后）。
    // 旧乘法作用于全 rankKey（可跨档沉降）——新语义只在平局组内生效（行为变更已登记）。
    rankCtx && rankCtx.signals.inferredPenalty > 0 && r.certainty === "inferred" ? 1 : 0,
    // 结构信号和（含 R6 场景）——只在平局组内比大小，永不越过 primary 档。
    rankCtx
      ? structuralSignalOf(r, rankCtx) + sceneSignalOf(r, rankCtx.sceneHit, rankCtx.sceneBoost ?? 0)
      : 0,
    // GROW-EVO P3 R10（§3.2）：情感显著度（weight>0 时参与平局链；0 = 恒 0 恒等）
    rankCtx && rankCtx.signals.emotionSalienceWeight > 0 ? emotionSalienceOf(r) * rankCtx.signals.emotionSalienceWeight : 0,
  ];
  const sorted = [...items].sort((a, b) => {
    // primary：fused score 降序——任何信号都不得改动这一层。
    if (b.score !== a.score) return b.score - a.score;
    const sa = secondaryOf(a);
    const sb = secondaryOf(b);
    if (sb[0] !== sa[0]) return sb[0] - sa[0]; // priority 降序
    if (sb[1] !== sa[1]) return sb[1] - sa[1]; // coreRef 降序
    if (sb[2] !== sa[2]) return sa[2] - sb[2]; // inferred 殿后（升序旗标）
    // D5 R10 修复（REG-REMAINING-002 #5 审查发现）：此比较原位于下方无条件 return 之后
    // ——不可达死代码，工具侧 R10 项从未生效（钩子侧 compareLex 接线正确）。移入链内；
    // weight=0 时五元组第 5 位恒 0 → 行为逐位不变，A/B 预注册（2026-09-16-r10-ab-design）
    // 依赖双链可达。
    if (sb[3] !== sa[3]) return sb[3] - sa[3]; // 结构信号和降序
    return sb[4] - sa[4]; // GROW-EVO P3 R10：情感显著度降序（weight>0 时）
  });
  return sorted.map((r) => {
    const touches = touchedCoreRefs(r, firedLabels);
    return touches.length > 0 ? { ...r, touched_core_refs: touches } : r;
  });
}

/**
 * C1/R-A1：读当前租户价值锚行（每次搜索至多一次；R-A1 起 valence 一并透传，
 * 供 buildRankContext 算 R9 moodSign）。
 * best-effort：store 无 listValues / 读失败 → []（coreRef/mood 消费静默关闭，
 * 全链旧路径零影响——R3 降级可见降级无害）。租户三元组从 isolationFilter 派生
 * （缺维度 → default 桶，P2-T12 同形，不允许"缺省=跨租户读"）。
 * fired 判定与 timeWindow/moodSign 组装统一走 recall-signals.buildRankContext
 * （plan Interfaces 契约：R-A2 复用同一上下文组装器）。
 */
async function readTenantValues(
  vectorStore: IMemoryStore,
  isolationFilter: IsolationFilter | undefined,
  logger: Logger | undefined,
): Promise<Array<{ value_id: string; label: string; weight: number; valence: number | null }>> {
  try {
    const listValues = vectorStore.listValues;
    if (typeof listValues !== "function") return [];
    const tenant: CoreTenant = normalizeCoreTenant({
      teamId: isolationFilter?.teamId,
      userId: isolationFilter?.userId,
      agentId: isolationFilter?.agentId,
    });
    const rows = await listValues.call(vectorStore, tenant);
    return (rows ?? [])
      .filter((v) => v && typeof v.label === "string" && v.label.trim())
      .map((v) => ({
        value_id: String(v.value_id ?? ""),
        label: v.label.trim(),
        weight: typeof v.weight === "number" ? v.weight : 0,
        valence: typeof v.valence === "number" ? v.valence : null,
      }));
  } catch (err) {
    logger?.warn?.(
      `${TAG} coreRef values unavailable (non-fatal, coreRefBoost skipped): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// ============================
// R-A2 候选池扩展（spec §2 R5 价值反查补池）+ V2-1 引擎二 PPR 全图扩散（E2.1/E2.3）
// ============================

/**
 * V2-1 引擎二图构建（E2.1 图构建段 + 报告前节 §0.2 等价性论证）：
 * 从种子做逐点 1 跳 getNeighbors BFS（深度 = pprIterations，T14 filter 透传——
 * 每跳两步过滤，不穿跨租户节点）。游走展开式下长度 > 迭代数的游走对 r^(T) 贡献恒零，
 * 故该可达子图与"全图 PPR 非零输出集"精确相等（不可达节点 PPR 恒 0）；
 * getNeighbors SQL UNION 双向 = 无向遍历（邻接表双向各记一条同权边）。
 * 边 strength ≥ graphMinStrength 才入图（宁缺毋滥，弱边不扩散）。
 * 已知近似（登记）：getNeighbors 的 seen 去重使同节点对的并行边（同对异型）收敛为
 * 首见边——store 接口无全量边列举方法（计划文件清单约束），生产稀疏图影响可忽略。
 * 导出供 auto-recall 同层复用（C5/R-A1 教训：两排序点单一源消费）。
 */
export async function collectSeedGraph(
  seedIds: Iterable<string>,
  opts: {
    store: IMemoryStore & {
      getNeighbors?: (id: string, types?: string[], maxHop?: number, filter?: IsolationFilter) => MaybePromise<Array<{ id: string; type: string; strength: number; hop: number }>>;
    };
    isolationFilter?: IsolationFilter;
    graphMinStrength: number;
    maxIterations: number;
  },
): Promise<PPREdge[]> {
  const edges = new Map<string, PPREdge>();
  // 先物化一次性迭代器（seeds.keys() 等）——Set 消费后展开会得到空 frontier（实证踩坑）。
  const frontier0 = [...seedIds];
  const visited = new Set<string>(frontier0);
  let frontier = frontier0;
  for (let depth = 0; depth < opts.maxIterations && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const u of frontier) {
      const nbs = (await opts.store.getNeighbors!(u, undefined, 1, opts.isolationFilter)) ?? [];
      for (const nb of nbs) {
        if (typeof nb?.id !== "string" || nb.id === u) continue; // 自环不入图（getNeighbors 亦不回起点）
        if (typeof nb.strength === "number" && nb.strength >= opts.graphMinStrength) {
          const kind = typeof nb.type === "string" && nb.type ? nb.type : "related";
          // 无向边去重键：节点对（字典序小者在前）+ 边型
          const key = u < nb.id ? `${u}|${nb.id}|${kind}` : `${nb.id}|${u}|${kind}`;
          if (!edges.has(key)) edges.set(key, { src: u, tgt: nb.id, strength: nb.strength, kind });
        }
        if (!visited.has(nb.id)) {
          visited.add(nb.id); // seen 防环（BFS 队列与旧一跳同语义）
          next.push(nb.id);
        }
      }
    }
    frontier = next;
  }
  return [...edges.values()];
}

/**
 * 候选池扩展：V2-1 引擎二 PPR 全图扩散（E2.1，整体替换 R-A2 R4 一跳补池——一跳是
 * PPR 单迭代的退化情形，保留即冗余，E2.3）+ R5 价值反查补池（两通道均 best-effort，失败非致命）。
 *
 * 队长裁决（brief）：图通道**不适用绝对门槛**——它按定义是"关联召回"而非"相关匹配"，
 * 候选以 maxHitScore×graphDiscount×pprNorm 的派生分入池并以 `[graph:ppr:kind]` 标注
 * 自证身份（非种子天花板 = maxHitScore×graphDiscount，折扣语义保持：图候选恒低于命中）；
 * **T2 门/T14 租户过滤照常**：getNeighbors 透传 isolationFilter（sqlite T14 两步过滤），
 * 重巩固白名单（certainty==="observed"）不受扩展影响。
 * 种子 = 门槛后命中全集（E2.1：种子权重 = hit.score 归一化，相关性越高扩散影响力越大）；
 * 多跳自动发生（A→B→C 链一步到位），graphDiscount=0 / pprTopK=0 → 通道完全退出。
 * R5 触发条件：池内结果数 < limit 的一半 → fired 锚 label 反查 coreRefs 匹配记忆补池
 * （score=0 + `[value:锚]` 标注；位次由 coreRef 通道加成赋予，不伪装修.seed 相关分）。
 * 硬查询约束（type/scene 过滤器）对两通道条目照常生效——查询合同不被关联路绕过。
 * 扩展后由调用方按刀二语义消费（补池不挤位：直接命中基线序不动，扩展候选附加在后，
 * 附加段内部按同一字典序比较器排序）。
 */
async function expandCandidatePool(
  results: MemorySearchResultItem[],
  opts: {
    vectorStore: IMemoryStore;
    isolationFilter?: IsolationFilter;
    typeFilter?: string;
    sceneFilter?: string;
    graphDiscount: number;
    graphMinStrength: number;
    /** V2-1（E2.1）：PPR 三旋钮（缺省由 executeMemorySearch 回落默认 0.85/10/30）。 */
    pprDamping: number;
    pprTopK: number;
    pprIterations: number;
    firedLabels: readonly string[];
    coreRefBoost: number;
    limit: number;
    logger?: Logger;
  },
): Promise<MemorySearchResultItem[]> {
  const pool = [...results];
  // R5 触发口径锚：主检索结果数快照（扩池前）——与 auto-recall searchHybrid mainHitCount
  // 同语义（审查 #1 修补：R4 扩池不得掩盖主检索不足，两路同口径"主检索结果 < limit 一半"）。
  const mainCount = pool.length;
  const seen = new Set(pool.map((r) => r.id));
  const store = opts.vectorStore as IMemoryStore & {
    getNeighbors?: (id: string, types?: string[], maxHop?: number, filter?: IsolationFilter) => MaybePromise<Array<{ id: string; type: string; strength: number; hop: number }>>;
    getL1ByIdsWithArchive?: (ids: string[]) => MaybePromise<Array<L1SearchResult>>;
    getL1ByIds?: (ids: string[]) => MaybePromise<Array<L1SearchResult>>;
    searchL1ByCoreRefs?: (labels: string[], limit?: number, filter?: IsolationFilter) => MaybePromise<Array<L1SearchResult>>;
  };
  // 硬查询约束谓词（与主检索 secondary filters 同语义）
  const matchesHardFilters = (sceneName: string, type: string): boolean => {
    if (opts.typeFilter && type !== opts.typeFilter) return false;
    if (opts.sceneFilter && !sceneName.toLowerCase().includes(opts.sceneFilter.toLowerCase())) return false;
    return true;
  };
  try {
    // ── V2-1 引擎二：PPR 全图扩散（E2.1；graphDiscount=0 → 通道完全退出，getNeighbors 零调用）──
    if (opts.graphDiscount > 0 && pool.length > 0 && typeof store.getNeighbors === "function" &&
        (typeof store.getL1ByIdsWithArchive === "function" || typeof store.getL1ByIds === "function")) {
      // 拍板①（P0-F2 处置 C：归档不回流）：候选池扩散同款只解析活跃记录——归档=软删（遗忘语义），
      // 图通道不得复活已遗忘记忆；旧 store 无 getL1ByIds 回退 WithArchive（逐位兼容）。
      const resolveByIds = (ids: string[]) =>
        store.getL1ByIds ? store.getL1ByIds(ids) : store.getL1ByIdsWithArchive!(ids);
      // 种子 = 门槛后命中全集（E2.1 种子向量段）；权重 = hit.score（runPPR 内部归一化）。
      // Σscore=0（ pathological 全零分命中）→ 无扩散（E2.4 天然退化）。
      const seedScoreSum = pool.reduce((s, r) => s + (r.score > 0 ? r.score : 0), 0);
      if (seedScoreSum > 0) {
        const seeds = new Map<string, number>(pool.map((r) => [r.id, r.score]));
        const maxIter = Math.max(1, Math.floor(opts.pprIterations));
        const edges = await collectSeedGraph(seeds.keys(), {
          store, isolationFilter: opts.isolationFilter, graphMinStrength: opts.graphMinStrength, maxIterations: maxIter,
        });
        if (edges.length > 0) {
          const maxHitScore = Math.max(...pool.map((r) => r.score));
          // E2.1 输出评分：非种子 top-pprTopK；候选分 = maxHitScore × graphDiscount × pprNorm
          const detail = runPPRDetail(seeds, edges, {
            damping: opts.pprDamping, topK: opts.pprTopK, maxIterations: maxIter,
          });
          const picked = [...detail.pprNorm.entries()];
          if (picked.length > 0) {
            const rows = (await resolveByIds(picked.map(([id]) => id))) ?? [];
            const byId = new Map(rows.map((r) => [r.record_id, r]));
            const beforeR4 = pool.length;
            for (const [id, pprNorm] of picked) {
              if (seen.has(id)) continue;
              const nr = byId.get(id);
              if (!nr) continue;
              if (!matchesHardFilters(nr.scene_name ?? "", nr.type)) continue;
              seen.add(id);
              const kind = detail.kinds.get(id) ?? "related";
              pool.push({
                id: nr.record_id,
                content: nr.content,
                type: nr.type,
                priority: nr.priority,
                scene_name: nr.scene_name,
                score: maxHitScore * opts.graphDiscount * pprNorm,
                team_id: nr.team_id,
                user_id: nr.user_id,
                agent_id: nr.agent_id,
                task_id: nr.task_id,
                version: nr.version ?? 0,
                created_at: nr.timestamp_start,
                updated_at: nr.timestamp_end,
                occurred_at: nr.occurred_at,
                valid_start: nr.valid_start,
                valid_end: nr.valid_end,
                certainty: nr.certainty,
                source: nr.source,
                valence: nr.valence,
                arousal: nr.arousal,
                significance: nr.significance,
                metadata: parseMetadata(nr.metadata_json),
                recall_channel: `graph:ppr:${kind}`,
              });
            }
            opts.logger?.debug?.(`${TAG} [pool-expand] V2-1 ppr: +${pool.length - beforeR4} graph candidates (edges=${edges.length}, seeds=${seeds.size}), pool=${pool.length}`);
          }
        }
      }
    }
    // ── R5：召回不足（主检索结果数快照 < limit 一半）→ fired 锚 label 反查补池（coreRefBoost=0 → 值通道整体退出）──
    if (opts.coreRefBoost > 0 && opts.firedLabels.length > 0 && mainCount * 2 < opts.limit &&
        typeof store.searchL1ByCoreRefs === "function") {
      const rows = (await store.searchL1ByCoreRefs([...opts.firedLabels], opts.limit, opts.isolationFilter)) ?? [];
      for (const r of rows) {
        if (seen.has(r.record_id)) continue;
        const refs = coreRefsOf({ metadata: parseMetadata(r.metadata_json) }).filter((s) => opts.firedLabels.includes(s));
        if (refs.length === 0) continue; // store 粗筛结果须复核交集（宁缺毋滥）
        if (!matchesHardFilters(r.scene_name ?? "", r.type)) continue;
        seen.add(r.record_id);
        pool.push({
          id: r.record_id,
          content: r.content,
          type: r.type,
          priority: r.priority,
          scene_name: r.scene_name,
          score: 0,
          team_id: r.team_id,
          user_id: r.user_id,
          agent_id: r.agent_id,
          task_id: r.task_id,
          version: r.version ?? 0,
          created_at: r.timestamp_start,
          updated_at: r.timestamp_end,
          occurred_at: r.occurred_at,
          valid_start: r.valid_start,
          valid_end: r.valid_end,
          certainty: r.certainty,
          source: r.source,
          valence: r.valence,
          arousal: r.arousal,
          significance: r.significance,
          metadata: parseMetadata(r.metadata_json),
          recall_channel: `value:${refs[0]}`,
        });
      }
      opts.logger?.debug?.(`${TAG} [pool-expand] R5 value backfill: fired=${JSON.stringify(opts.firedLabels)}, pool=${pool.length}`);
    }
  } catch (err) {
    opts.logger?.warn?.(`${TAG} [pool-expand] failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  return pool;
}

// ============================
// V2-3（引擎三）R-v2.1 精排轻档 + E3.1 探索位 —— 两排序点单一源共享纯函数
//（C5/R-A1 教训：咽喉 executeMemorySearch 与 auto-recall searchHybrid 消费同一实现）
// ============================

/**
 * RV2（召回修正批 task RV2-2，brief 裁决）：精排重设计 = 相关度主导组合分四因子。
 * compositeScore = 0.70×relevanceNorm + 0.15×timeProx + 0.10×sigNorm + 0.05×coreRefHit：
 * - relevanceNorm：候选相关度分归一（直接命中 = fused score 归一；图/扩展候选 = 派生分归一）。
 *   同一尺度论证（设计 §E2.1）：图候选的派生分 = maxHitScore×graphDiscount×pprNorm 本身就在
 *   命中分（RRF/BM25）同一量纲内构造（E2.1"派生分本身就是相关度折扣分"），且派生分天花板
 *   = maxHitScore×discount < maxHitScore——池内 max 归一后两类候选天然同尺度，
 *   且图候选 relevanceNorm 恒低于其种子命中（折扣语义保持）；value/scene 补池行 score=0 → 0。
 * - timeProx：occurred_at 时近性 1/(1+ageDays)，缺失/解析失败/未来 → 0（R1 同口径）。
 * - sigNorm：significance（0..1）。
 * - coreRefHit：结构标签命中（0/1——brief 公式口径，命中数 >0 即 1）。
 * 契约：relevance 为主因子（默认 0.70 ≥ 70%）；结构因子合计 ≤30%（0.15+0.10+0.05）；
 * 权重可配（config 透传见 src/config.ts recall.rerankWeights；负值 clamp 0）。
 * 预期行为变更（登记，RV2-2）：relevance=0 时组合分退化为纯时间/显著排序——**不再是基线恒等**
 * （v1 三因子精排的语义替代）；全 0 权重 = 稳定排序逐位基线（权重信号关断，f53b173 教训沿用）。
 */
export interface CompositeWeights {
  relevance: number;
  timeProx: number;
  significance: number;
  coreRef: number;
}

/** RV2-2 默认：相关度主导 0.7（≥70% 契约）+ 结构因子合计 0.3（时近 0.15 / 显著 0.10 / coreRef 0.05）。 */
export const DEFAULT_COMPOSITE_WEIGHTS: CompositeWeights = { relevance: 0.7, timeProx: 0.15, significance: 0.1, coreRef: 0.05 };

/** 组合分因子投影（两排序点各自从条目形状提取，分数计算单一源）。 */
export interface CompositeFactors {
  /**
   * 候选相关度分（同一查询池内同量纲：直接命中 = fused score；图候选 = 派生分
   * maxHitScore×graphDiscount×pprNorm；value/scene 补池 = 0——池内 max 归一，见上）。
   */
  relevance: number;
  occurredAt?: string | null;
  significance?: number | null;
  /** coreRef 命中数 = metadata.coreRefs ∩ 当前轮 fired labels（fired 空 → 0，宁缺毋滥；组合分按 0/1 消费）。 */
  coreRefCount: number;
  /** work_fact 分层（持续态优先——加成不越 work_fact 分层不变式）。 */
  isWorkFact: boolean;
}

/** occurred_at 时近因子 = 1/(1+ageDays)；缺失/解析失败/未来时间 → 0（无实证不加成，R1 同口径）。 */
function occurredRecencyFactor(occurredAt: string | null | undefined, now: Date): number {
  if (!occurredAt) return 0;
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) return 0;
  const delta = now.getTime() - t;
  if (delta < 0) return 0;
  return 1 / (1 + delta / 86_400_000);
}

/**
 * RV2-2 组合分（相关度主导）：0.70×relevanceNorm + 0.15×timeProx + 0.10×sigNorm + 0.05×coreRefHit。
 * relevanceNorm = f.relevance / maxRelevance（池内 max 归一，0..1；两类候选同尺度见 CompositeWeights 注）；
 * timeProx 因子天然 0..1；significance 天然 0..1；coreRefHit 二值（0/1）。
 * 对应权重为 0 的因子直接不计算（关断矩阵延续：0 = 该因子退出）。
 *
 * 三刀·刀三（2026-09-12 队长裁决，登记不动代码）——rerank 重开前置（spec §8.1 全文为准）：
 * ① 组合分剔除查询无关因子（timeProx/significance 等先验）或同样挂字典序第二段
 *    （只在 primary 精确平局组内生效）——杜绝先验越过相邻相关度档（q9 病灶同构）；
 * ② 跨源分数一律走 RRF 名次语义（BM25/cosine/派生分量纲不可比）；
 * ③ 重跑同判据 A/B 达标才回岗（spec §4.1 预注册判据，差 < 0.02 取关）。
 * 当前生产 rerankWeights 全 0（关断恒等），本函数在纯基线工作点为稳定恒等透传。
 */
export function compositeScoreOf(
  f: CompositeFactors,
  weights: CompositeWeights,
  now: Date,
  maxRelevance: number,
): number {
  // 权重逐键守卫（undefined/负值 → 0）：既有调用方可能传旧形状/部分权重对象，
  // 直接 factor×undefined 会产生 NaN 污染排序比较器（verify-rv2 调试实证）。
  const wRel = weights.relevance > 0 ? weights.relevance : 0;
  const wTime = weights.timeProx > 0 ? weights.timeProx : 0;
  const wSig = weights.significance > 0 ? weights.significance : 0;
  const wCore = weights.coreRef > 0 ? weights.coreRef : 0;
  const rel =
    wRel > 0 && maxRelevance > 0 && Number.isFinite(f.relevance) && f.relevance > 0
      ? f.relevance / maxRelevance
      : 0;
  const time = wTime > 0 ? occurredRecencyFactor(f.occurredAt, now) : 0;
  const sig =
    wSig > 0 && typeof f.significance === "number" && Number.isFinite(f.significance) && f.significance > 0
      ? f.significance
      : 0;
  const core = wCore > 0 && Number.isFinite(f.coreRefCount) && f.coreRefCount > 0 ? 1 : 0;
  return rel * wRel + time * wTime + sig * wSig + core * wCore;
}

/**
 * RV2-2 精排（相关度主导）：候选合并后、截断前——组合分稳定排序（R-v2.1 位置不变）。
 * relevanceNorm 池内 max 归一（maxRelevance = 池内最大 relevance 分；0 = 池内无正分，
 * relevance 因子整体退出）。work_fact 层恒在前（不越分层），层内组合分降序；同分保持
 * 输入序（稳定）。全 0 权重 → 分数恒 0 → 权重信号退出，层内输出与输入逐位一致（关断
 * 恒等，限权重信号；f53b173 教训：排序恒执行不跳过）。I1 裁定：work_fact 分层是 R-A1
 * 前既有展示层不变式，不属 v2 权重信号——全 0 时分层仍生效（恒等声明限定为权重信号）。
 * 确定性：now 由调用方传入快照（R-A1 锚点纪律）。
 */
export function applyCompositeRerank<T>(
  items: readonly T[],
  factorsOf: (item: T) => CompositeFactors,
  weights: CompositeWeights,
  now: Date,
): T[] {
  const w = weights ?? DEFAULT_COMPOSITE_WEIGHTS;
  const factors = items.map(factorsOf);
  const maxRel = factors.reduce((m, f) => (Number.isFinite(f.relevance) && f.relevance > m ? f.relevance : m), 0);
  return factors
    .map((f, i) => ({ f, i, score: compositeScoreOf(f, w, now, maxRel) }))
    .sort((a, b) => (a.f.isWorkFact ? 0 : 1) - (b.f.isWorkFact ? 0 : 1) || b.score - a.score || a.i - b.i)
    .map(({ i }) => items[i]!);
}

/** E3.1 探索位候选资格之一：结构通道命中（[graph:ppr]/[value:]/scene；主检索命中恒缺省）。 */
export function isStructuralChannel(channel: string | undefined | null): boolean {
  return (
    typeof channel === "string" &&
    (channel.startsWith("graph:") || channel.startsWith("value:") || channel.startsWith("scene:"))
  );
}

/**
 * E3.1 探索位：最终排序后、截断前——若前 windowSize 窗口内无合格候选，末位替换为
 * "结构命中 且 recall_count < 池内中位数（缺失计 0）"的池内候选（多合格取 recall_count
 * 最低，平局取先见——确定性），带 withMark 标注自证身份（[explore]）。
 * 退化安全：窗口已有合格候选（E3.1 "前 N 全为高 recall_count" 不成立）/ 池不超窗 /
 * 候选不足 → 原排序逐位返回（不复制窗口外的静默重排）。
 */
export function applyExploreSlot<T>(
  pool: readonly T[],
  windowSize: number,
  proj: (item: T) => { channel?: string; recallCount?: number },
  withMark: (item: T) => T,
): T[] {
  if (!(windowSize > 0) || pool.length === 0 || pool.length <= windowSize) return [...pool];
  const counts = pool.map((p) => {
    const rc = proj(p).recallCount;
    return typeof rc === "number" && Number.isFinite(rc) && rc > 0 ? rc : 0;
  });
  const sortedCounts = [...counts].sort((a, b) => a - b);
  const mid = Math.floor(sortedCounts.length / 2);
  const median = sortedCounts.length % 2 === 0 ? (sortedCounts[mid - 1]! + sortedCounts[mid]!) / 2 : sortedCounts[mid]!;
  const recallCountOf = (p: T): number => {
    const rc = proj(p).recallCount;
    return typeof rc === "number" && Number.isFinite(rc) ? rc : 0;
  };
  const eligible = (p: T): boolean => isStructuralChannel(proj(p).channel) && recallCountOf(p) < median;
  const window = pool.slice(0, windowSize);
  if (window.some(eligible)) return [...pool];
  let pick: T | undefined;
  let pickCount = Infinity;
  for (const p of pool.slice(windowSize)) {
    if (!eligible(p)) continue;
    const c = recallCountOf(p);
    if (c < pickCount) {
      pick = p;
      pickCount = c;
    }
  }
  if (!pick) return [...pool];
  return [...window.slice(0, windowSize - 1), withMark(pick)];
}

// ============================
// R-A3 E1 · query embedding TTL 缓存（性能速赢，spec §4：不碰检索语义）
// ============================

interface EmbeddingCacheEntry {
  promise: Promise<Float32Array>;
  at: number;
}
/** E1 缓存：key=服务实例编号+query 原文+请求 opts（同轮多路归一/同 query 复用），TTL 内命中免外呼。 */
const queryEmbeddingCache = new Map<string, EmbeddingCacheEntry>();
const QUERY_EMBEDDING_CACHE_MAX = 200;

// E1 实例身份编号（审查 #2 修补）：同 query 换 embeddingService 实例不得吃错向量——
// WeakMap 给每个服务实例分配稳定编号（不持有引用、零 GC 负担），key 前缀隔离。
const serviceInstanceIds = new WeakMap<object, number>();
let nextServiceInstanceId = 1;
const serviceIdOf = (svc: EmbeddingService): number => {
  let id = serviceInstanceIds.get(svc);
  if (id === undefined) {
    id = nextServiceInstanceId++;
    serviceInstanceIds.set(svc, id);
  }
  return id;
};

/**
 * E1：query embedding TTL 缓存（默认 60s；ttlMs<=0 = 通道关，直呼 embed）。
 * 失败的调用不缓存（promise 移除，下次重试）；缓存上界 200 条防膨胀（FIFO 驱逐）。
 * 确定性：同 query 同 embedding（缓存只是免去重复外呼，不改变任何检索输入）。
 * key = embeddingService 实例编号 + query 原文 + 请求 opts（审查 #2 修补：多服务同 query
 * 不吃错向量；S7 第 8 项：JSON.stringify(opts) 掺入 key——现状 opts 恒同无实际影响，
 * 防未来 embed opts 携带维度/指令时同 query 异 opts 脏读缓存向量）；
 * 工具侧与 auto-recall 侧共用本模块 Map——同进程同缓存（同轮多路归一）。
 */
export async function cachedQueryEmbedding(
  embeddingService: EmbeddingService,
  query: string,
  ttlMs: number,
  logger?: Logger,
  opts?: Parameters<EmbeddingService["embed"]>[1],
): Promise<Float32Array> {
  if (!(ttlMs > 0)) return embeddingService.embed(query, opts);
  const key = `${serviceIdOf(embeddingService)}\u0000${query}\u0000${JSON.stringify(opts ?? null)}`;
  const now = Date.now();
  const hit = queryEmbeddingCache.get(key);
  if (hit && now - hit.at < ttlMs) {
    logger?.debug?.(`${TAG} [embed-cache] HIT (age=${now - hit.at}ms) svc=#${serviceIdOf(embeddingService)} query="${query.slice(0, 50)}"`);
    return hit.promise;
  }
  if (hit) queryEmbeddingCache.delete(key); // 过期
  const promise = embeddingService.embed(query, opts).catch((err) => {
    queryEmbeddingCache.delete(key); // 失败不缓存，下次重试
    throw err;
  });
  queryEmbeddingCache.set(key, { promise, at: now });
  if (queryEmbeddingCache.size > QUERY_EMBEDDING_CACHE_MAX) {
    const oldest = queryEmbeddingCache.keys().next().value;
    if (oldest !== undefined) queryEmbeddingCache.delete(oldest);
  }
  return promise;
}

// ============================
// Search implementation
// ============================

export async function executeMemorySearch(params: {
  query: string;
  limit: number;
  type?: string;
  scene?: string;
  filter?: IsolationFilter;
  scoreThreshold?: number;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
  /** 重构式回忆（J）：图邻居扩展默认关闭；开启时按 getNeighbors 扩点（default off，宁缺毋滥）。 */
  neighborExpand?: { enabled?: boolean; maxHop?: number; maxAdd?: number };
  /** GROW-EVO P2（§2.3）：失效排除开关（缺省 true = spec 拍板①；由调用方 cfg 透传） */
  excludeInvalidated?: boolean;
  /** A5（REG-REMAINING-001）：time_point 时间旅行——提供时切换"当时有效"双时态过滤 */
  validityNow?: Date;
  /** GROW-EVO P3 R10（§3.2）：情感显著度权重（缺省 0 = 恒等；由调用方 cfg 透传） */
  emotionSalienceWeight?: number;
  /**
   * 重构式回忆（J 设计§3）：query 时间锚窗过滤。
   * "auto" = 从 query 解析（今天/上周/N天前等），解析不出→不过滤；显式传窗则直接用。
   */
  timeWindow?: TimeWindow | "auto";
  /**
   * C1（灵魂记忆 spec §2.2）：coreRef 排序加成幅度（memory.recall.coreRefBoost，
   * 默认 0.05，0=关闭）。只在排序 tiebreak 处生效——不参与检索打分、不越过绝对门槛。
   * 价值锚由本函数内部从 store.listValues(租户) 读取（best-effort，读不到=零影响）。
   */
  coreRefBoost?: number;
  /**
   * R-A1（结构感知召回 spec §2 R1/R2/R3/R8/R9）：门后排序层结构信号六开关，
   * 默认值 = DEFAULT_RANK_SIGNALS（R9 moodBoost 默认 0 = 关）；0 = 通道完全退出；
   * 全 0 时与基线排序逐位一致（关断矩阵，spec §5）。
   */
  timeBoost?: number;
  recencyBoost?: number;
  sigWeight?: number;
  inferredPenalty?: number;
  reinforcementWeight?: number;
  moodBoost?: number;
  /**
   * R-A2（spec §2 R4）：图通道——边强度门槛（默认 0.5）与派生分折扣（默认 0.6）。
   * graphDiscount=0 → 通道完全退出（getNeighbors 零调用，spec §3 失效即关）。
   */
  graphMinStrength?: number;
  graphDiscount?: number;
  /**
   * V2-1（引擎二 PPR spec E2.1）：PPR 三旋钮——damping（默认 0.85，clamp [0,1]）/
   * 非种子候选上限 topK（默认 10，0=零图候选）/ 最大迭代（默认 30）。
   * 缺省回落默认值；config 透传见 v2-router / tdai-core。
   */
  pprDamping?: number;
  pprTopK?: number;
  pprIterations?: number;
  /**
   * R-A2（spec §2 R6）：场景路由加成（tiebreak 层，默认 0.04，0=关）。
   * query 含候选池中出现的 scene_name → 该场景（含层级前缀子场景）记忆 +sceneBoost。
   */
  sceneBoost?: number;
  /**
   * R-A3（E1）：query embedding TTL 缓存毫秒（默认 60_000，<=0 = 关）。
   * key=query 原文；命中免外呼（同轮多路归一）。缓存不改变任何检索输入（语义零变化）。
   */
  queryEmbeddingCacheTtlMs?: number;
  /**
   * V2-2（引擎一 查询自动扩展 spec E1.1-E1.4）：LLM 语义邻域扩展——扩展词以 OR 并入
   * FTS MATCH（词面足迹 widening）；向量路不动（语义相似已处理改写）。候选并集后照常
   * 过绝对门槛（扩展只加候选，门槛仍裁决）；扩展词命中条目不特殊标注（对用户透明）。
   * enabled=false / runner 与 llm 均缺省 → 通道退出；LLM 失败/超时/解析失败 → 无扩展，
   * 原 query 照常（E1.4 失败退化）。TTL 缓存模块级共享（auto-recall 同进程同缓存）。
   */
  queryExpansion?: {
    enabled?: boolean;
    maxTerms?: number;
    ttlMs?: number;
    timeoutMs?: number;
    /** 预构造 runner（优先）；缺省时由 llm 惰性构造（C2 derive 模式，需 llm.baseUrl）。 */
    runner?: ExpansionRunner;
    llm?: QueryExpansionLlmConfig | null;
  };
  /**
   * V2-3（引擎三 E3.1）：探索位——最终排序后、截断前，结构命中且 recall_count < 池内
   * 中位数的低频候选占末席 + [explore] 标注（诚实原则）。默认 true；false = 通道退出。
   */
  exploreSlot?: boolean;
  /**
   * RV2-2（精排重设计）：候选合并后、截断前组合分四因子权重（relevance/timeProx/significance/
   * coreRef，默认 0.7/0.15/0.1/0.05——相关度主导契约：relevance ≥70%、结构合计 ≤30%；
   * 负值 clamp 0。全 0 = 权重信号关断恒等——层内稳定排序逐位基线；relevance=0 = 退化纯
   * 时间/显著排序（**预期行为变更，登记**）；work_fact 分层为既有展示层不变式——I1 裁定）。
   */
  rerankWeights?: CompositeWeights;
}): Promise<MemorySearchResult> {
  const {
    query,
    limit,
    type: typeFilter,
    scene: sceneFilter,
    filter: isolationFilter,
    scoreThreshold = 0.3,
    vectorStore,
    embeddingService,
    logger,
    neighborExpand,
    timeWindow,
    coreRefBoost = 0.05,
    timeBoost = DEFAULT_RANK_SIGNALS.timeBoost,
    recencyBoost = DEFAULT_RANK_SIGNALS.recencyBoost,
    sigWeight = DEFAULT_RANK_SIGNALS.sigWeight,
    inferredPenalty = DEFAULT_RANK_SIGNALS.inferredPenalty,
    reinforcementWeight = DEFAULT_RANK_SIGNALS.reinforcementWeight,
    moodBoost = DEFAULT_RANK_SIGNALS.moodBoost,
    graphMinStrength = 0.5,
    graphDiscount = 0.6,
    pprDamping = 0.85,
    pprTopK = 10,
    pprIterations = 30,
    sceneBoost = 0.04,
    queryEmbeddingCacheTtlMs = 60_000,
    queryExpansion,
    exploreSlot = true,
    emotionSalienceWeight = 0,
    rerankWeights,
  } = params;
  const signals: RankSignals = { timeBoost, recencyBoost, sigWeight, inferredPenalty, reinforcementWeight, moodBoost, emotionSalienceWeight };

  logger?.debug?.(
    `${TAG} CALLED: query="${query.slice(0, 100)}", limit=${limit}, ` +
    `typeFilter=${typeFilter ?? "(none)"}, sceneFilter=${sceneFilter ?? "(none)"}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}`,
  );

  if (!query || query.trim().length === 0) {
    logger?.debug?.(`${TAG} Empty query, returning empty`);
    return { results: [], total: 0, strategy: "none" };
  }

  if (!vectorStore) {
    logger?.warn?.(`${TAG} VectorStore not available`);
    return { results: [], total: 0, strategy: "none" };
  }

  // ── Determine available capabilities ──
  const hasEmbedding = !!embeddingService;
  const hasFts = vectorStore.isFtsAvailable();

  if (!hasEmbedding && !hasFts) {
    logger?.warn?.(`${TAG} Neither EmbeddingService nor FTS5 available — cannot search`);
    return {
      results: [],
      total: 0,
      strategy: "none",
      message:
        "Embedding service is not configured and FTS is not available. " +
        "Memory search requires an embedding provider or FTS5 support. " +
        "Please configure an embedding provider in the embedding.provider setting (e.g. openai_compatible).",
    };
  }

  // ── Over-retrieve for later filtering and RRF merging ──
  const candidateK = limit * 3;

  // ── C1 coreRef + R-A1 排序信号 + R-A2 R6 场景路由：query 的 appraisal fired labels /
  // 时间窗 / moodSign（每次搜索至多算一次；best-effort，空 = 对应特性静默关闭，检索层零影响）。
  // 价值读取仅在 coreRef 或 mood 通道需要时发生（coreRefBoost=0 且六信号全 0 →
  // 零额外读，rankCtx 不组装，走 C1 前的纯基线路径）──
  const needValues = coreRefBoost > 0 || signals.moodBoost > 0;
  const signalsActive =
    signals.timeBoost > 0 ||
    signals.recencyBoost > 0 ||
    signals.sigWeight > 0 ||
    signals.inferredPenalty > 0 ||
    signals.reinforcementWeight > 0 ||
    signals.moodBoost > 0 ||
    sceneBoost > 0;
  const rankContext = needValues || signalsActive
    ? await buildRankContext(query, [], {
        readValues: needValues ? () => readTenantValues(vectorStore, isolationFilter, logger) : undefined,
      })
    : undefined;
  const firedLabels = rankContext?.firedLabels ?? [];
  /**
   * 传给排序层的 rank 参数（rankContext 缺席 = 纯基线；在场但全 0 = 关断恒等）。
   * R-A2（R6）：sceneHit 在候选池就绪后按池内 scene_name 计算（detectSceneHit 与
   * buildRankContext.items 同一实现，单一源；候选池即 items）。
   */
  const rankArgOf = (items: MemorySearchResultItem[]) =>
    rankContext
      ? {
          moodSign: rankContext.moodSign,
          timeWindow: signals.timeBoost > 0 ? rankContext.timeWindow : null,
          signals,
          now: rankContext.now,
          sceneHit: sceneBoost > 0 ? detectSceneHit(query, items.map((r) => r.scene_name)) : null,
          sceneBoost,
        }
      : undefined;

  // ── Native hybrid short-circuit (TCVDB) ──
  // If the store natively supports hybrid search (dense + sparse + RRF in a
  // single API call), skip the dual-path FTS+Vector logic to avoid a redundant
  // second HTTP request with garbled FTS tokens as embedding input.
  if (vectorStore.getCapabilities().nativeHybridSearch && vectorStore.searchL1Hybrid) {
    logger?.debug?.(`${TAG} [native-hybrid] Single-call hybrid search...`);
    const results = await vectorStore.searchL1Hybrid(
      isolationFilter ? { query, topK: candidateK, filter: isolationFilter } : { query, topK: candidateK },
    );
    let items: MemorySearchResultItem[] = results.map((r) => ({
      id: r.record_id,
      content: r.content,
      type: r.type,
      priority: r.priority,
      scene_name: r.scene_name,
      score: r.score,
      team_id: r.team_id,
      user_id: r.user_id,
      agent_id: r.agent_id,
      task_id: r.task_id,
      version: r.version ?? 0,
      created_at: r.timestamp_start,
      updated_at: r.timestamp_end,
      occurred_at: r.occurred_at,
      valid_start: r.valid_start,
      valid_end: r.valid_end,
      certainty: r.certainty,
      source: r.source,
      valence: r.valence,
      arousal: r.arousal,
      significance: r.significance,
      metadata: parseMetadata(r.metadata_json),
    }));

    // Apply secondary filters
    if (typeFilter) items = items.filter((r) => r.type === typeFilter);
    if (sceneFilter) {
      const ns = sceneFilter.toLowerCase();
      items = items.filter((r) => r.scene_name.toLowerCase().includes(ns));
    }
    // ── C1：priority/coreRef 轻度 tiebreak（native-hybrid 与双路同语义）+ R-A1 结构信号 + R-A2 R6 场景路由 ──
    items = applyCoreRefTiebreak(items, firedLabels, coreRefBoost, rankArgOf(items));
    // GROW-EVO P2（§2.3）+ A5：失效排除 / time_point 时间旅行（validityNow 提供时切换双时态）
    const exclItems = filterByValidity(items, params.validityNow, params.excludeInvalidated);
    const trimmed = exclItems.slice(0, limit);
    // T1-D（F7 收官）：native-hybrid 早退前同样执行重巩固 —— 此前提前 return
    // 跳过了主路径尾部的 reconsolidation 块（T17.5 审计确认缺口）。
    triggerReconsolidation(trimmed, vectorStore, logger);
    logger?.debug?.(
      `${TAG} RESULT (strategy=native-hybrid): returning ${trimmed.length} memories ` +
      `(scores: [${trimmed.map((r) => r.score.toFixed(3)).join(", ")}])`,
    );
    return { results: trimmed, total: trimmed.length, strategy: "hybrid" };
  }

  // ── SQLite dual-path: run FTS5 + Vector in parallel, merge with client-side RRF ──
  const [ftsItems, vecItems] = await Promise.all([
    // FTS5 keyword search
    (async (): Promise<MemorySearchResultItem[]> => {
      if (!hasFts) return [];
      try {
        // V2-2（引擎一 E1.1-E1.3）：LLM 语义邻域扩展（FTS 路内联——与向量路并行，
        // 不串行延迟 embedding；native-hybrid 单调用路无本地 FTS 构建点，不扩展）。
        // 失败/超时/解析失败 → [] → merge 退化为原 query（E1.4）。TTL 缓存模块级共享。
        let expansionTerms: string[] = [];
        if (queryExpansion?.enabled) {
          const qeRunner = queryExpansion.runner ??
            (queryExpansion.llm
              ? await resolveQueryExpansionRunner(queryExpansion.llm, undefined, logger)
              : undefined);
          expansionTerms = await expandQuery(query, qeRunner, {
            maxTerms: queryExpansion.maxTerms,
            ttlMs: queryExpansion.ttlMs,
            timeoutMs: queryExpansion.timeoutMs,
            logger,
          });
        }
        // E1.3：扩展词 OR 并入 MATCH（原词在前）；无扩展 → 逐位原 ftsQuery。
        const ftsQuery = mergeFtsQueryWithExpansion(buildFtsQuery(query), expansionTerms);
        if (!ftsQuery) {
          logger?.debug?.(`${TAG} [hybrid-fts] No usable FTS tokens from query`);
          return [];
        }
        logger?.debug?.(`${TAG} [hybrid-fts] FTS5 query: "${ftsQuery}"`);
        const ftsResults = isolationFilter
          ? await vectorStore.searchL1Fts(ftsQuery, candidateK, isolationFilter)
          : await vectorStore.searchL1Fts(ftsQuery, candidateK);
        logger?.debug?.(`${TAG} [hybrid-fts] FTS5 returned ${ftsResults.length} candidates`);
        return ftsResults.map((r) => ({
          id: r.record_id,
          content: r.content,
          type: r.type,
          priority: r.priority,
          scene_name: r.scene_name,
          score: r.score,
          team_id: r.team_id,
      user_id: r.user_id,
      agent_id: r.agent_id,
      task_id: r.task_id,
      version: r.version ?? 0,
          created_at: r.timestamp_start,
          updated_at: r.timestamp_end,
          occurred_at: r.occurred_at,
          // R-A1（R1 时间窗 valid 区间相交分量）：FTS 行 valid_* 补映射——
          // L1FtsResult 类型已带（W1 soul 列），此前漏映射导致 FTS 行持续态信号死读
          valid_start: r.valid_start,
          valid_end: r.valid_end,
          certainty: r.certainty,
          valence: r.valence,
          arousal: r.arousal,
          significance: r.significance,
          // C1：FTS 行 metadata 读回（此前不携带——coreRefs 在 FTS 路径死读）
          metadata: parseMetadata(r.metadata_json),
        }));
      } catch (err) {
        logger?.warn?.(
          `${TAG} [hybrid-fts] FTS5 search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    })(),

    // Vector embedding search
    (async (): Promise<MemorySearchResultItem[]> => {
      if (!hasEmbedding) return [];
      try {
        logger?.debug?.(`${TAG} [hybrid-vec] Generating query embedding...`);
        // R-A3 E1：TTL 缓存（同 query 免外呼；缓存不改变检索输入）
        const queryEmbedding = await cachedQueryEmbedding(embeddingService!, query, queryEmbeddingCacheTtlMs, logger);
        logger?.debug?.(
          `${TAG} [hybrid-vec] Embedding OK, dims=${queryEmbedding.length}, searching top-${candidateK}...`,
        );
        const vecResults: L1SearchResult[] = isolationFilter
          ? await vectorStore.searchL1Vector(queryEmbedding, candidateK, query, isolationFilter)
          : await vectorStore.searchL1Vector(queryEmbedding, candidateK, query);
        logger?.debug?.(`${TAG} [hybrid-vec] Vector search returned ${vecResults.length} candidates`);
        return vecResults.map((r) => ({
          id: r.record_id,
          content: r.content,
          type: r.type,
          priority: r.priority,
          scene_name: r.scene_name,
          score: r.score,
          team_id: r.team_id,
      user_id: r.user_id,
      agent_id: r.agent_id,
      task_id: r.task_id,
      version: r.version ?? 0,
          created_at: r.timestamp_start,
          updated_at: r.timestamp_end,
          occurred_at: r.occurred_at,
          valid_start: r.valid_start,
          valid_end: r.valid_end,
          certainty: r.certainty,
          source: r.source,
          valence: r.valence,
          arousal: r.arousal,
          significance: r.significance,
          metadata: parseMetadata(r.metadata_json),
        }));
      } catch (err) {
        logger?.warn?.(
          `${TAG} [hybrid-vec] Embedding search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    })(),
  ]);

  // ── 绝对相关门控（宁缺毋滥）：L1 向量分是 cosine（0–1 绝对可比），
  //    低于 scoreThreshold（默认 0.3）的 embedding 候选不入池 —— 修"排名即注入"。
  const gatedVec = scoreThreshold > 0 ? vecItems.filter((r) => r.score >= scoreThreshold) : vecItems;

  // ── Determine effective strategy ──
  const ftsOk = ftsItems.length > 0;
  const vecOk = gatedVec.length > 0;
  let strategy: string;

  if (ftsOk && vecOk) {
    strategy = "hybrid";
  } else if (vecOk) {
    strategy = "embedding";
  } else if (ftsOk) {
    strategy = "fts";
  } else {
    logger?.debug?.(`${TAG} Both search paths returned 0 results`);
    return { results: [], total: 0, strategy: hasEmbedding ? "embedding" : "fts" };
  }

  // ── Merge results ──
  let results: MemorySearchResultItem[];
  if (strategy === "hybrid") {
    results = rrfMergeL1(ftsItems, gatedVec);
    logger?.debug?.(
      `${TAG} [hybrid] RRF merged: fts=${ftsItems.length}, vec=${vecItems.length} → ${results.length} unique`,
    );
  } else {
    // Single-source: use whichever list has results (already sorted by score)
    results = ftsOk ? ftsItems : gatedVec;
  }

  // ── Apply secondary filters (type, scene) ──
  const preFilterCount = results.length;
  if (typeFilter) {
    results = results.filter((r) => r.type === typeFilter);
    logger?.debug?.(`${TAG} After type filter "${typeFilter}": ${results.length}/${preFilterCount}`);
  }
  if (sceneFilter) {
    const normalizedScene = sceneFilter.toLowerCase();
    results = results.filter((r) =>
      r.scene_name.toLowerCase().includes(normalizedScene),
    );
    logger?.debug?.(`${TAG} After scene filter "${sceneFilter}": ${results.length}/${preFilterCount}`);
  }
  // ── 重构式回忆（J 设计§3）：query 时间锚 → 时间窗过滤（"当时"查询）──
  const effectiveWindow = timeWindow === "auto" ? parseTimeWindow(query) : timeWindow;
  if (effectiveWindow) {
    const before = results.length;
    results = results.filter((r) => inTimeWindow(r.occurred_at, effectiveWindow));
    logger?.debug?.(
      `${TAG} After time window "${effectiveWindow.label}" [${effectiveWindow.start} ~ ${effectiveWindow.end}): ${results.length}/${before}`,
    );
  }

  // ── priority 轻度 tiebreak（不推翻相关性排序，只让同等相关者里更高优先级靠前）──
  // C1（灵魂记忆 spec §2.2）：rankKey 追加 coreRefBoost（与 priority*1e-6 同位置的
  // 轻度 tiebreak）——检索打分/绝对门槛/RRF 融合语义零改动，仅同等相关者中让
  // "本轮触动价值"的记忆靠前。同时标注 touched_core_refs（供展示尾注）。
  // R-A1（结构感知召回 spec §2）：同层追加 R1/R2/R3/R8/R9 结构信号（rankArg 全 0
  // = 关断恒等；rankArg 缺席 = C1 前纯基线路径）。
  results = applyCoreRefTiebreak(results, firedLabels, coreRefBoost, rankArgOf(results));

  // ── 候选池扩展（V2-1 引擎二 PPR 全图扩散替换 R-A2 R4 一跳 / R5 价值反查补池）──
  // 三刀·刀二（2026-09-12 队长裁决）：补池不挤位（行为变更，已登记 spec §8：补池同层
  // 竞争→附加式）。旧语义：扩展条目与主检索条目同层重跑排序（单一排序点）——派生分
  // 高的图候选可挤掉低分直接命中。新语义：直接命中保持上方 tiebreak 后的基线序不动；
  // 扩展候选只附加在全部直接命中之后，附加段内部按同一字典序比较器排序（自身
  // 派生分/信号决定段内位次）。绝对门槛 / T2 门 / T14 租户过滤语义不变；exploreSlot
  // （E3.1）在最终池上照常工作（从池中取合格候选替换末位——含附加段，语义兼容）。──
  if (graphDiscount > 0 || (coreRefBoost > 0 && firedLabels.length > 0)) {
    const expanded = await expandCandidatePool(results, {
      vectorStore,
      isolationFilter,
      typeFilter,
      sceneFilter,
      graphDiscount,
      graphMinStrength,
      pprDamping,
      pprTopK,
      pprIterations,
      firedLabels,
      coreRefBoost,
      limit,
      logger,
    });
    if (expanded.length !== results.length) {
      const directIds = new Set(results.map((r) => r.id));
      const appended = expanded.filter((r) => !directIds.has(r.id));
      // 附加段内部按同一比较器排序（scene 检测用全量池语境，保持 R6 判定口径不变）。
      const suffix = applyCoreRefTiebreak(appended, firedLabels, coreRefBoost, rankArgOf(expanded));
      results = [...results, ...suffix];
    }
  }

  // ── 重构式回忆（J）：图邻居扩展（默认关；宁缺毋滥，仅并入相关度充足的种子之邻）──
  // 审计 B3：邻居解析走 getL1ByIdsWithArchive——演进/合并的旧证据在归档桶也能读回。
  // fix1 I-4：getL1ByIds/WithArchive/getNeighbors 类型放宽为 MaybePromise（tcvdb 异步取行）
  // ——统一 await，sqlite 同步路径 await 数组零语义变化；不 await 则 tcvdb 后端本段是死代码。
  if (neighborExpand?.enabled && vectorStore?.getNeighbors && (vectorStore?.getL1ByIdsWithArchive || vectorStore?.getL1ByIds)) {
    // 拍板①（P0-F2 处置 C：归档不回流）：邻居扩展只解析活跃记录（getL1ByIds 查 l1_records）——
    // 归档=软删（遗忘语义），图扩展不得复活已遗忘记忆；仅旧 store 无 getL1ByIds 时回退
    // WithArchive（行为逐位兼容）。租户复核与失效排除不变（b91f4d5）。
    const resolveByIds = (ids: string[]) =>
      vectorStore!.getL1ByIds
        ? vectorStore!.getL1ByIds(ids)
        : vectorStore!.getL1ByIdsWithArchive!(ids);
    try {
      const seedIds = results.slice(0, 3).map((r) => r.id);
      const maxHop = neighborExpand.maxHop ?? 1;
      const maxAdd = neighborExpand.maxAdd ?? 3;
      const extra = new Set<string>();
      for (const sid of seedIds) {
        for (const nb of await vectorStore.getNeighbors(sid, undefined, maxHop, isolationFilter) as Array<{ id: string }>) {
          if (results.some((r) => r.id === nb.id)) continue;
          extra.add(nb.id);
          if (extra.size >= maxAdd) break;
        }
        if (extra.size >= maxAdd) break;
      }
      if (extra.size > 0) {
        // P0-F2：扩展邻居租户复核（T14 两步过滤同款——同租户不变量下零行为差，防跨租户边泄漏）。
        const neighborRecords = (await resolveByIds([...extra])).filter((nr) => rowMatchesIsolation(nr as unknown as Record<string, unknown>, isolationFilter));
        for (const nr of neighborRecords) {
          if (results.some((r) => r.id === nr.record_id)) continue;
          results.push({
            id: nr.record_id,
            content: nr.content,
            type: nr.type,
            priority: nr.priority,
            scene_name: nr.scene_name,
            score: 0.2, // 邻居弱相关，仅作扩展补齐（宁缺毋滥：不过强相关门槛）
            version: nr.version ?? 0,
            created_at: nr.timestamp_start,
            updated_at: nr.timestamp_end,
            occurred_at: nr.occurred_at,
            // GROW-EVO P2.1：邻居条目补 soul 有效期字段——否则失效排除过滤器对
            // 邻居项失明（归档+已失效记忆经 archive-aware 邻居解析回流注入块，实测）。
            valid_start: nr.valid_start,
            valid_end: nr.valid_end,
            certainty: nr.certainty,
            valence: nr.valence,
            arousal: nr.arousal,
            significance: nr.significance,
          });
        }
      }
    } catch (err) {
      logger?.warn?.(`${TAG} neighborExpand failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── RV2-2（精排重设计）：候选合并后、截断前——相关度主导组合分精排（relevanceNorm
  // 池内 max 归一：直接命中=fused score / 图候选=派生分 maxHitScore×discount×pprNorm
  // 同量纲同尺度（E2.1 派生分=相关度折扣分）/ value 补池=0；timeProx+sigNorm+coreRefHit
  // 结构因子合计 ≤30%）。与 auto-recall searchHybrid 截断前同层对齐（R-A1 教训；同一
  // 单一源 applyCompositeRerank；work_fact 分层不越层）。
  // 全 0 权重 = 权重信号关断恒等（层内稳定排序逐位基线；work_fact 分层保留——I1 裁定）。 ──
  results = applyCompositeRerank(
    results,
    (r) => ({
      relevance: r.score,
      occurredAt: r.occurred_at,
      significance: r.significance,
      coreRefCount: firedLabels.length > 0 ? coreRefsOf(r).filter((s) => firedLabels.includes(s)).length : 0,
      isWorkFact: r.type === "work_fact",
    }),
    rerankWeights ?? DEFAULT_COMPOSITE_WEIGHTS,
    rankContext?.now ?? new Date(),
  );

  // ── V2-3（E3.1 探索位）：最终排序后、截断前——结构命中且 recall_count < 池内中位数
  // 的低频候选占末席 + [explore] 标注（诚实原则自证身份）；窗口已有合格候选 / 候选不足
  // → 原排序逐位（退化安全）。 ──
  if (exploreSlot) {
    results = applyExploreSlot(
      results,
      limit,
      (r) => ({
        channel: r.recall_channel,
        recallCount: typeof r.metadata?.recall_count === "number" ? r.metadata.recall_count : 0,
      }),
      (r) => ({ ...r, recall_channel: r.recall_channel ? `${r.recall_channel}:explore` : "explore" }),
    );
  }

  // ── Trim to requested limit ──
  // GROW-EVO P2（§2.3）+ A5：失效排除 / time_point 时间旅行（native-hybrid 早退分支同款）
  const exclResults = filterByValidity(results, params.validityNow, params.excludeInvalidated);
  const trimmed = exclResults.slice(0, limit);

  // ── 重巩固（T1-D：提取为 triggerReconsolidation，native-hybrid 分支复用同一函数）──
  triggerReconsolidation(trimmed, vectorStore, logger);

  logger?.debug?.(
    `${TAG} RESULT (strategy=${strategy}): returning ${trimmed.length} memories ` +
    `(scores: [${trimmed.map((r) => r.score.toFixed(3)).join(", ")}])`,
  );

  return {
    results: trimmed,
    total: trimmed.length,
    strategy,
    // T15-C 降级可见：embedding 已配置但实际只走了 FTS → 标注降级
    degraded: strategy === "fts" && hasEmbedding,
  };
}

// ============================
// Tool response formatter
// ============================

export function formatSearchResponse(result: MemorySearchResult, maxChars = 0): string {
  let text = formatSearchResponseInner(result);
  // J 设计§7：片段长度预算（宁缺毋滥）。0 = 不限。按行贪心截断，保留头部说明。
  if (maxChars > 0 && text.length > maxChars) {
    const lines = text.split("\n");
    const out: string[] = [];
    let used = 0;
    for (const line of lines) {
      const w = line.length + 1;
      if (used + w > maxChars) {
        out.push("…（片段预算截断，剩余条目未展示）");
        break;
      }
      out.push(line);
      used += w;
    }
    text = out.join("\n");
  }
  return text;
}

function formatSearchResponseInner(result: MemorySearchResult): string {
  if (result.message) {
    return result.message;
  }
  if (result.results.length === 0) {
    return "No matching memories found.";
  }

  // J 重构式回忆（设计§2/§3）：不是 top-k 取件清单，而是组装"回忆片段"——
  // 持续态(work_fact)优先（稳定结论 > 零碎点），按时间线分组（occurred_at 升序），
  // 每条带确定性/情感/重要度（感知层），保持宁缺毋滥的既有门控不变。
  const items = [...result.results];
  const duratives = items.filter((i) => i.type === "work_fact");
  const points = items.filter((i) => i.type !== "work_fact");
  const sorted = [...duratives, ...points];

  // T15-C 降级可见：FTS-only 降级标注（用户与 LLM 都要知道在看残废召回）
  const lines: string[] = [];
  if (result.degraded) {
    // I-1 复核修补：两义措辞 —— degraded 只证明"本轮向量召回无贡献"，无法区分
    // 向量层降级与相关度门滤除，禁止假警报式单因断言。
    lines.push("[degraded: fts-only] 本轮向量召回无贡献（向量层降级或相关度门滤除），本次仅命中关键词检索（FTS），召回质量可能不完整。", "");
  }
  lines.push(
    `Recollection片段：共 ${result.total} 条相关记忆（持续态优先，按时间线组织）`,
    "",
  );

  let lastDay = "";
  for (const item of sorted) {
    const t = item.occurred_at ?? (item as { created_at?: string }).created_at ?? "";
    const day = t ? t.slice(0, 10) : "";
    if (day && day !== lastDay) {
      lines.push(`### ${day}`);
      lastDay = day;
    }
    const scoreStr = typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
    const sceneStr = item.scene_name ? ` [scene: ${item.scene_name}]` : "";
    const priorityStr = item.priority >= 0 ? ` (priority: ${item.priority})` : " (global instruction)";
    const durStr = item.type === "work_fact" ? " 🔗持续态" : "";
    lines.push(`- **[${item.type}]**${durStr}${priorityStr}${sceneStr}${scoreStr}`);
    lines.push(`  ${item.content}`);
    const soul: string[] = [];
    const m = item as unknown as { occurred_at?: string; certainty?: string; valence?: number; significance?: number };
    if (m.occurred_at) soul.push(`发生 ${m.occurred_at}`);
    if (m.certainty) soul.push(m.certainty === "inferred" ? "推断" : "实见");
    if (m.valence != null) soul.push(`情感 ${m.valence.toFixed(1)}`);
    if (m.significance != null) soul.push(`重要 ${m.significance.toFixed(2)}`);
    if (soul.length > 0) lines.push(`  · ${soul.join(" · ")}`);
    // C1（灵魂记忆 spec §2.2 展示层）：`·触[价值]` 尾注——只显示本轮 appraisal
    // 相关的 coreRefs（executeMemorySearch 已算好交集；空/缺省不输出，宁缺毋滥）。
    const touches = (item as { touched_core_refs?: string[] }).touched_core_refs;
    if (Array.isArray(touches) && touches.length > 0) {
      lines.push(`  ·触[${touches.join(",")}]`);
    }
    // R-A2：候选池通道标注（诚实原则——关联召回自证身份，消费方可见）
    const channel = (item as { recall_channel?: string }).recall_channel;
    if (channel) {
      lines.push(`  ·[${channel}]`);
    }
    lines.push("");
  }

  return lines.join("\n");
}


// A5（REG-REMAINING-001）：time_point 时间旅行过滤——validityNow 提供时切换"当时有效"
// 双时态过滤（vs ≤ tp < ve；vs 缺省 0 / ve 缺省 ∞，与 soul 效期语义一致）；
// 未提供时维持失效排除（excludeInvalidated 缺省 true）。两 trim 点（native-hybrid/双路）共用。
function filterByValidity<T extends { valid_start?: string; valid_end?: string }>(items: T[], validityNow?: Date, excludeInvalidated?: boolean): T[] {
  if (validityNow) {
    const tp = validityNow.getTime();
    return items.filter((i) => {
      const vsRaw = i.valid_start ? Date.parse(i.valid_start) : 0;
      const veRaw = i.valid_end ? Date.parse(i.valid_end) : Number.POSITIVE_INFINITY;
      const vs = Number.isFinite(vsRaw) ? vsRaw : 0;
      const ve = Number.isFinite(veRaw) ? veRaw : Number.POSITIVE_INFINITY;
      return vs <= tp && tp < ve;
    });
  }
  return excludeInvalidated === false ? items : items.filter((i) => !isInvalidated(i as { valid_end?: string }));
}