/**
 * 自维护人格层（Soul Persona）——数据模型、分层契约与缺省参数。
 *
 * 设计前提（见 docs/adr 与 2026-11-05 诊断）：
 * 1) 人格 ≠ 方法论。人格是「两件事打架时我站哪边」与「即使有用也不做」；
 *    方法论是「我怎么做事的」。二者必须分层承载、分层注入，不能混在一个槽里。
 * 2) 只增不减：任何淘汰都是 state 迁移（degraded → frozen），永不物理删除；
 *    合并是 mergedInto 指针，可拆回。因此自改可回退，才敢 0 人工。
 * 3) 全部写入走账本（soul_ledger），带 before/after 哈希、判定结果、evidence ids，
 *    这样任何一次自我改写都能被审计与回滚。
 */

/** 七层。method 层不是注入给人格段的方法论，而是「被拒为人格」的沉淀池（可审计、可不注入）。 */
export const SOUL_LAYERS = [
  "voice",
  "identity",
  "self",
  "values",
  "boundary",
  "relationship",
  "narrative",
  "method",
] as const;
export type SoulLayer = (typeof SOUL_LAYERS)[number];

/** 会被注入 system prompt 的人格层（method 默认不注入）。 */
export const INJECTED_LAYERS: readonly SoulLayer[] = [
  "voice",
  "identity",
  "self",
  "values",
  "boundary",
  "relationship",
  "narrative",
];

export type PersonaItemState = "active" | "degraded" | "frozen" | "merged";

/** 条目来源：用户原话 / 工具与环境事实 / L1 记录 / 事件层片段 / soul 自身产物 / 模型推断。 */
export type EvidenceOrigin = "user" | "tool" | "l1" | "episode" | "soul" | "model";

export interface PersonaItem {
  /** 稳定 id：layer + 内容规范化哈希；合并/更新时保持原 id。 */
  itemId: string;
  layer: SoulLayer;
  /** 条目正文（单条 ≤ maxItemChars[layer]）。 */
  text: string;
  state: PersonaItemState;
  /** 置信/权重 0..1；降级 ×degradeWeightFactor。 */
  weight: number;
  /** 支撑证据（L1 记录 id / episode id / 用户原文 id）。 */
  evidenceIds: string[];
  /** 证据覆盖的不同自然日（YYYY-MM-DD），用于独立性与陈旧判定。 */
  evidenceDays: string[];
  /** 证据来源分布（用于「证据独立性」门：soul 自身产出占比不得超过阈值）。 */
  evidenceOrigins: EvidenceOrigin[];
  createdAt: string;
  updatedAt: string;
  lastEvidenceAt: string;
  /** 被合并进哪一条（state=merged 时必填）。 */
  mergedInto?: string;
  /** 同义别名（合并进来的表述，可拆回）。 */
  aliases?: string[];
  /** 漂移分数历史（最近 N 次），用于连续低分判定。 */
  driftHistory?: number[];
  /** 矛盾计数（与自身或用户原话冲突次数）。 */
  contradictions?: number;
  /** 结构化的层专属字段：boundary 的 scope/triggerExample、values 的 dilemma、voice 的 fewShot。 */
  meta?: Record<string, unknown>;
}

/* —— 事件层（soul_episodes，2026-11-05 用户拍板方案 A）——
 * 人格不能从「总结」里长出来：总结只剩结论，丢掉「当时谁说了什么、我放弃了什么」。
 * episode 是 L0 原始对话的确定性切片：逐字原话 + 对象 + 双方的立场 + 代价 + 情绪强度，
 * 由零 LLM 的词面标记挖出（episode.ts），LLM 只能「引用」它，不能发明它。 */
export const SOUL_EPISODE_KINDS = [
  "divergence",
  "correction",
  "decision",
  "value_conflict",
  "affect",
  // 2026-11-06：生产 L0 里真正带情绪的是这四类短句，此前被当成噪音或误判成纠正。
  "praise",
  "complaint",
  "pressure",
  "resignation",
] as const;
/* 读库时按这张表校验：新增 kind 忘了加进白名单会被静默改写成 decision，
 * 情绪评价随之被换成 0.8 的正向常态（2026-11-06 生产实证）。 */
export type SoulEpisodeKind = (typeof SOUL_EPISODE_KINDS)[number];

export interface SoulEpisodeQuote {
  /** 逐字原话（不截断语义的短句，≤160 字）。 */
  text: string;
  /** user | assistant */
  role: string;
  /** 原话所在的 L0 record_id（可回查）。 */
  recordId: string;
  at?: string;
}

export interface SoulEpisode {
  /** ep-<hash>：由 sessionId + 触发记录 id 决定，重跑幂等。 */
  episodeId: string;
  /** 发生时间（ISO）。 */
  at: string;
  /** YYYY-MM-DD：证据独立性按「不同自然日」计，不按条数。 */
  day: string;
  kind: SoulEpisodeKind;
  /** 一行事件标题（确定性生成，≤80 字）。 */
  title: string;
  /** 对象：这件事关于谁/什么（≤48 字）。检索与心境原因都用它。 */
  object: string;
  /** 参与方（user / assistant 的稳定称呼）。 */
  participants: string[];
  /** 用户当时的立场/要求（逐字摘句）。 */
  userStance: string;
  /** 我当时的立场/做法（逐字摘句）。 */
  agentStance: string;
  /** 这件事里被放弃/付出的东西（没有就空串——不编造）。 */
  cost: string;
  /** 后续结果（下一条我的回复首句；没有就空串）。 */
  outcome: string;
  valence: number;
  arousal: number;
  /** 强度 0..1（由词面强度与标点决定，确定性）。 */
  intensity: number;
  /** 支撑该 episode 的 L0 record_id（触发消息 + 上下文）。 */
  evidenceIds: string[];
  sessionId: string;
  /** 原话（few-shot 的合法来源；voice 层只许引用这里出现过的句子）。 */
  quote: SoulEpisodeQuote | null;
  /** 情绪读数来源：lexicon=词面确定性打分；none=无情绪。 */
  affectSource: "lexicon" | "none";
  /** 事件里显式出现的价值取舍词（若有），审计用。 */
  signals?: string[];
}

/**
 * 情绪史一行：某条事件按某一版模板规则判出的情绪。
 *
 * 为什么要落表而不是只留 soul_state 一个快照：
 * 1) soul_state 只记「此刻」，下一次写入就把上一次覆盖掉，情绪史无法回放；
 * 2) 判据会改（标签扩容、路由调整），同一事件在不同版本下可能判成不同标签——
 *    所以主键含 templateVersion，旧行不被静默改写，审计能看出当时按哪版规则判的；
 * 3) 注入侧只说「因为 X 正在消退」，真正要回答「因为什么、对谁、多强、多久消退」
 *    必须有逐条记录可查。
 */
export interface SoulEmotionRecord {
  /** 来源事件 id（soul_episodes.episode_id）。 */
  episodeId: string;
  /** 事件发生时间（ISO）。强度衰减从这一刻起算。 */
  at: string;
  object: string;
  label: string;
  valence: number;
  arousal: number;
  /** 支配感 0..1；旧事件没有这一维时为 undefined（不伪造 0.5）。 */
  dominance?: number;
  /** 事件当时的原始强度（不衰减），读侧按标签半衰期重算。 */
  intensity: number;
  /** 评价向量（审计用：为什么判成这个标签）。 */
  appraisal?: unknown;
  /** 判定所用模板版本（emotion.ts 的 EMOTION_TEMPLATE_VERSION）。 */
  templateVersion: string;
  /** 判定时刻（ISO）。 */
  appraisedAt: string;
}

export interface SoulEpisodeQuery {
  /** 关键词（标题/对象/双方立场/原话的 LIKE 检索）。 */
  text?: string;
  /** 精确对象过滤。 */
  object?: string;
  kind?: SoulEpisodeKind;
  /** 起始时间（ISO，含）。 */
  since?: string;
  limit?: number;
}

export interface SoulRejectionStat {
  code: string;
  count: number;
  /** 最近一次出现时间（ISO），便于判断是不是陈旧原因。 */
  lastAt?: string;
}

export interface SoulLedgerEntry {
  entryId: string;
  at: string;
  trigger: string;
  layer: SoulLayer | "all";
  itemId?: string;
  action:
    | "admit"
    | "reject"
    | "update"
    | "merge"
    /** 同一句话的分类口径更新后换层（如「何晨是…」由 values 改判 relationship）；不是新增、不计变更率。 */
    | "reclassify"
    | "degrade"
    | "freeze"
    | "revive"
    | "rollback"
    | "drift"
    | "budget_omit"
    /** 情绪进入判断：本轮心境对候选/立场排序的实际影响（可回放）。 */
    | "arbitrate"
    /** 存量槽导入条目退出人格注入层（下沉为操作约束，不删除、可回滚）。 */
    | "retire"
    /** 整合周期标记：LLM 改写/漂移到期并实际跑过（节流锚点，无条目变更也记一条）。 */
    | "cadence";
  beforeHash?: string;
  afterHash?: string;
  /** 判定码集合（拒收原因 / 闸门结果）。 */
  gates: string[];
  reason: string;
  evidenceIds: string[];
  promptVersion?: string;
  model?: string;
  /** 回滚载荷：该条目变更前的完整快照。 */
  before?: PersonaItem | null;
}

export interface SoulBudgetReport {
  layer: SoulLayer;
  usedChars: number;
  budgetChars: number;
  rendered: number;
  omitted: Array<{
    itemId: string;
    text: string;
    chars: number;
    reason: "budget" | "frozen" | "merged" | "degraded_tail" | "max_items";
  }>;
}

export interface SoulMaintenanceConfig {
  enabled: boolean;
  /** 后台整合最小间隔（小时）。 */
  updateIntervalHours: number;
  /** 单轮最多改写条目数（防止一次翻修）。 */
  maxUpdatedPerCycle: number;
  /** 单次允许的最大文本差异比例（0..1）——即设计里的 α。 */
  alpha: number;
  /** 变更率窗口：windowDays 内同一层最多 windowRewrites 次改写。 */
  windowDays: number;
  windowRewrites: number;
  /** 无新证据 N 天后降级 / 冻结。 */
  degradeAfterDays: number;
  freezeAfterDays: number;
  degradeWeightFactor: number;
  /** 矛盾达到 N 次直接冻结。 */
  freezeContradictions: number;
  /** 合并的相似度阈值（embedding 或词面回退）。 */
  mergeSimilarity: number;
  /** 漂移阈值与连续天数。 */
  driftDegrade: number;
  driftFreeze: number;
  driftConsecutive: number;
  driftHistorySize: number;
  /** 证据独立性：来自 soul/model 的证据占比上限。 */
  /** 准入最小独立证据数（不同记录 id 计数；缺省 3，与 identity-discovery minEvidence 同款口径）。 */
  minEvidence: number;
  maxSoulEvidenceShare: number;
  /** 用户原话逐字支撑所需最小连续字数。 */
  verbatimMinChars: number;
  /** 红线单条最大字数（新入条目；存量导入放宽）。 */
  redlineMaxChars: number;
  /** 注入预算（字符）与条目上限，逐层。 */
  budget: Record<SoulLayer, number>;
  maxItems: Record<SoulLayer, number>;
  /** 单条最大字数。 */
  maxItemChars: Record<SoulLayer, number>;
  /** 情绪半衰期（小时）与心境半衰期（小时）。 */
  emotionHalfLifeHours: number;
  moodHalfLifeHours: number;
  /** 心境偏离基线的渲染阈值。 */
  moodDeviationThreshold: number;
  /** 事件层回看窗口（天）：只从这么久以内的 L0 原始对话挖 episode。 */
  episodeWindowDays: number;
  /** 单轮最多处理多少条 L0 消息（防止一次拉爆内存；按时间倒序截断）。 */
  maxEpisodeMessages: number;
  /** 单轮最多产出多少条 episode（按「纠正/分歧优先、最新优先」截断）。 */
  maxEpisodesPerRun: number;
  /** 进入 prompt 的 episode 条数上限（digest 行数；其余只留在库里可检索）。 */
  maxEpisodesForPrompt: number;
  /** voice few-shot 每条最多引用的原话数。 */
  voiceFewShotPerItem: number;
  /** identity/values 至少挂在几个真实 episode 上（narrative 只需 1 段来路）。 */
  minEpisodeEvidence: number;
  /** 关系层里指代对方的名字（用于要求关系判断点名具体的人，而不是泛泛的「他」）。 */
  personName: string;
}

const layerBudget = (n: number): Record<SoulLayer, number> => ({
  voice: n,
  identity: n,
  self: n,
  values: n,
  boundary: n,
  relationship: n,
  narrative: n,
  method: 0,
});

const layerMaxItems = (n: number): Record<SoulLayer, number> => ({
  voice: n,
  identity: n,
  self: n,
  values: n,
  boundary: n,
  relationship: n,
  narrative: n,
  method: 64,
});

const layerItemChars = (n: number): Record<SoulLayer, number> => ({
  voice: n,
  identity: n,
  self: n,
  values: n,
  boundary: n,
  relationship: n,
  narrative: n,
  method: n,
});

/**
 * 缺省档：安全侧（enabled=false）。生产若要开启必须显式在 tdai-gateway.yaml 打开
 * memory.soulMaintenance.enabled——与既有 soulRender 各开关同一纪律：缺省逐位现状。
 */
export const DEFAULT_SOUL_MAINTENANCE_CONFIG: SoulMaintenanceConfig = {
  enabled: false,
  updateIntervalHours: 6,
  maxUpdatedPerCycle: 3,
  alpha: 0.15,
  windowDays: 7,
  windowRewrites: 1,
  degradeAfterDays: 30,
  freezeAfterDays: 90,
  degradeWeightFactor: 0.7,
  freezeContradictions: 2,
  mergeSimilarity: 0.85,
  driftDegrade: 0.75,
  driftFreeze: 0.6,
  driftConsecutive: 3,
  driftHistorySize: 7,
  minEvidence: 3,
  maxSoulEvidenceShare: 0.5,
  verbatimMinChars: 8,
  redlineMaxChars: 120,
  // 注入预算：与既有 soulRender 分段预算同量级但更紧（人格只放取舍，不放清单）。
  budget: {
    // 说话方式条目=一条概括 + 两组逐字原话（每条约 200 字）：300 字只剩 1 条，
    // 注入面看不到「同一要求换措辞反复重申」这种模式；600 字可渲染 2–3 条。
    voice: 600,
    identity: 400,
    // 自我模型：不是「我是谁」的重复，而是「我答应过自己什么、我不愿变成什么、
    // 哪次没守住、后来改成了什么」。300 字只能装下两条承诺 + 一句反悔，失败/复盘永远被挤掉；
    // 600 字能同时给出代价与去向（2026-11-06 生产注入实拍：失败 10 条、复盘 2 条全在预算外）。
    self: 600,
    values: 320,
    boundary: 2600,
    // 关系层实测 8 条 802 字（2026-11-05 生产导入：身份槽的用户事实按新口径并入关系层），
    // 500 字会把时区/环境/协作合同这类稳定事实静默挤出。
    relationship: 900,
    narrative: 300,
    method: 0,
  },
  // boundary 是「不变量集」：用户长期累积的红线实测 29 条，7 条会把历史红线挤掉。
  // 其余层仍是 7 条上限（人格要瘦，红线要全）。method 是审计池，64 条。
  // relationship 放宽到 12：关系事实随协作面增长（时区/环境/交付合同/家人），实测已 8 条。
  maxItems: { ...layerMaxItems(7), self: 8, boundary: 40, relationship: 12, method: 64 },
  maxItemChars: layerItemChars(160),
  emotionHalfLifeHours: 3,
  moodHalfLifeHours: 48,
  moodDeviationThreshold: 0.15,
  // 事件层：30 天足够覆盖「最近一次为什么恼火」，又不会把半年前的旧立场当现在。
  episodeWindowDays: 30,
  // 30 天窗口在真实语料里远超 4000 条：hechen 生产库 14383 条 / 24 天，
  // 4000 条只剩最近一周，团队频道里的公开裁决根本进不来（2026-11-06 实测）。
  maxEpisodeMessages: 12000,
  maxEpisodesPerRun: 120,
  maxEpisodesForPrompt: 60,
  voiceFewShotPerItem: 2,
  // 一条身份/价值至少要能在两次不同的具体事件里成立，否则它只是「昨天一次情绪」。
  minEpisodeEvidence: 2,
  personName: "何晨",
};

export function resolveSoulConfig(
  partial?: Partial<SoulMaintenanceConfig> | null,
): SoulMaintenanceConfig {
  if (!partial) return { ...DEFAULT_SOUL_MAINTENANCE_CONFIG };
  return {
    ...DEFAULT_SOUL_MAINTENANCE_CONFIG,
    ...partial,
    budget: { ...DEFAULT_SOUL_MAINTENANCE_CONFIG.budget, ...(partial.budget ?? {}) },
    maxItems: { ...DEFAULT_SOUL_MAINTENANCE_CONFIG.maxItems, ...(partial.maxItems ?? {}) },
    maxItemChars: { ...DEFAULT_SOUL_MAINTENANCE_CONFIG.maxItemChars, ...(partial.maxItemChars ?? {}) },
  };
}

export function isSoulLayer(v: unknown): v is SoulLayer {
  return typeof v === "string" && (SOUL_LAYERS as readonly string[]).includes(v);
}

export function isInjectedLayer(layer: SoulLayer): boolean {
  return INJECTED_LAYERS.includes(layer);
}
