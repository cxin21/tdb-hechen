/**
 * Plugin configuration types and parser (v3).
 *
 * Config is organized into flat functional groups:
 *   capture, extraction, persona, pipeline, recall, embedding
 *
 * Minimal config (zero config): {} — all fields have sensible defaults.
 */

// ============================
// Type definitions
// ============================

/** Prompt family for L1-L3 memory pipeline. */
export type MemoryPromptMode = "chat" | "code";

/** Capture settings — controls L0 conversation recording. */
export interface CaptureConfig {
  /** Enable auto-capture (default: true) */
  enabled: boolean;
  /** Glob patterns to exclude agents (e.g. "bench-judge-*"); matched agents are fully ignored */
  excludeAgents: string[];
  /**
   * L0/L1 local file retention days used as TTL switch.
   * 0 means cleanup disabled.(default: 0)
   */
  l0l1RetentionDays: number;

  /**
   * Allow dangerous low retention (1 or 2 days).
   * Default false: when disabled, non-zero retention must be >= 3.
   */
  allowAggressiveCleanup: boolean;
}

/** Extraction settings (L1) — controls memory extraction from conversations. */
export interface ExtractionConfig {
  /** Enable background extraction (default: true) */
  enabled: boolean;
  /** Enable L1 smart dedup (default: true) */
  enableDedup: boolean;
  /** Max memories per session (default: 20) */
  maxMemoriesPerSession: number;
  /** GROW-EVO P2（§2.2）：durative 效期提取开关（缺省 false = 提取侧不写 valid_start） */
  durativeEnabled: boolean;
  /** D-4（2026-09-22 拍板）：周期性事实提取块（RECURRENCE_BLOCK 门；缺省 false = 逐位现状）。
   *  落点=既有 memory.extraction 组（ExtractionConfig）——勿另开子树（混合行尾教训再现）。 */
  recurrenceEnabled: boolean;
  /**
   * 毒批超时（L1-OUTAGE-20261015 定罪修复）：单次提取 LLM 调用超时 ms。
   * 思考型端点延迟∝prompt 体积（生产实测 13K≈298s 贴线、20K>300s 恒超时）→
   * 大批恒超时 → 游标不推进（F-EV12-1）→ 毒批 5min 死循环。缺省 300_000=逐位现状；
   * clamp 60_000..3_600_000。L1 提取与 L2 场景提取共用本键。
   */
  extractionTimeoutMs: number;
  /**
   * #79 dedup 判重超时（core 三次静默崩溃根修，config-first）：dedup LLM
   * 冲突检测调用超时 ms。崩溃直接前因=LLM 端点超时风暴 × 该路径硬编码
   * timeoutMs:300_000 悬挂堆积。缺省 300_000=逐位现状；clamp 60_000..3_600_000
   * （镜像 extractionTimeoutMs 形态）。
   */
  dedupTimeoutMs: number;
  /**
   * #46 毒批拆分（用户拍板 A，2026-10-17）：scene 抽取失败且批内 >1 条时对半
   * 递归重试（镜像 L1 extractGroupWithSplit 先例）。缺省 false=逐位现状。
   */
  scenePoisonSplit: boolean;
  /**
   * #46 批次上限：scene 抽取前按 memoriesJson 估长（与 scene-extractor.ts:259-267
   * 构造同构）贪心预分批，防巨批。缺省 0=关（单批现状）。
   */
  sceneBatchMaxChars: number;
  /** LLM model for extraction, format: "provider/model" (falls back to OpenClaw default model when omitted) */
  model?: string;
  /** Prompt family for L1 extraction (default: chat). */
  promptMode: MemoryPromptMode;
}

/** Persona (L2/L3) settings — controls scene extraction (L2) and user profile generation (L3). */
export interface PersonaConfig {
  /** Trigger persona generation every N new memories (default: 50) */
  triggerEveryN: number;
  /** Max scene blocks (default: 20) */
  maxScenes: number;
  /** Persona backup count (default: 3) */
  backupCount: number;
  /** Scene blocks backup count (default: 10) */
  sceneBackupCount: number;
  /** LLM model for persona generation, format: "provider/model" (falls back to OpenClaw default model when omitted) */
  model?: string;
  /** Prompt family for L2/L3 prompts (default: chat; code prompts will be wired as they are added). */
  promptMode: MemoryPromptMode;
  /**
   * Per-call reasoning effort for L2 scene extraction (R4 2026-10-06).
   * "none" disables deep thinking; undefined keeps the endpoint default.
   * Chain: cfg.persona.reasoningEffort → SceneExtractor → LLMRunParams.reasoningEffort
   * → providerOptions.openaiCompatible.reasoningEffort.
   */
  reasoningEffort?: string;
}

/** Pipeline trigger settings (L1→L2→L3 scheduling). */
export interface PipelineTriggerConfig {
  /** Trigger L1 after every N conversation rounds (default: 5) */
  everyNConversations: number;
  /** Enable warm-up: start threshold at 1, double after each L1 (1→2→4→...→everyN) (default: true) */
  enableWarmup: boolean;
  /** L1 idle timeout: trigger L1 after this many seconds of inactivity (default: 30) */
  l1IdleTimeoutSeconds: number;
  /** L2 delay after L1: wait this many seconds after L1 completes before triggering L2 (default: 90) */
  l2DelayAfterL1Seconds: number;
  /** L2 min interval: minimum seconds between L2 runs per session (default: 900 = 15 min) */
  l2MinIntervalSeconds: number;
  /** L2 max interval: even without new conversations, trigger L2 at most this often per session (default: 3600 = 60 min) */
  l2MaxIntervalSeconds: number;
  /** Sessions inactive longer than this (hours) stop L2 polling (default: 24) */
  sessionActiveWindowHours: number;
}

/** Recall settings — controls memory retrieval for context injection. */
export interface RecallConfig {
  /** Enable auto-recall (default: true) */
  enabled: boolean;
  /** Max results to return (default: 5) */
  maxResults: number;
  /** Max characters injected for a single recalled L1 memory. 0 disables the per-memory limit. */
  maxCharsPerMemory: number;
  /** Max total characters injected for all recalled L1 memories. 0 disables the total limit. */
  maxTotalRecallChars: number;
  /** F-CLUSTER v2（2026-09-26 拍板）：召回注入行折叠（持续态优先+同文；缺省关=golden A/B 通过后拍板开启） */
  foldClusterEnabled?: boolean;
  /** Minimum score threshold (default: 0.3) */
  scoreThreshold: number;
  /**
   * P0-2（issue #2 打分刻度错配）：native hybrid（TCVDB 服务端 RRF k=60）最低融合分
   * 门槛。RRF 融合分为 rank-only 刻度（单通道 top1≈1/61≈0.0164、双通道 top1≈0.0328），
   * scoreThreshold(0.3, 余弦刻度) 对其形同虚设。缺省 undefined/0 = 关（逐位现状，
   * config-first 铁律）；负值视为关。只约束 native hybrid 路（auto-recall / 工具路
   * executeMemorySearch），SQLite fallback 路的 scoreThreshold 全套精排不受影响。
   */
  nativeMinRRF?: number;
  /** Search strategy (default: "hybrid") */
  strategy: "embedding" | "keyword" | "hybrid";
  /** Overall recall timeout in milliseconds (default: 5000). When exceeded, recall is skipped with a warning. */
  timeoutMs: number;
  /**
   * C1（灵魂记忆 spec §2.2）：coreRef 排序加成幅度（默认 0.05，0=关闭）。
   * 与 priority*1e-6 同族的排序 tiebreak——不参与检索打分、不越过绝对门槛。
   * 负值 clamp 0（宁缺毋滥，不在启动路径抛异常）。
   */
  coreRefBoost: number;
  /**
   * R-A1（结构感知召回 spec §2 R1/R2/R3/R8/R9）：门后排序层结构信号六开关。
   * 默认值 = spec §2（timeBoost 0.05 / recencyBoost 0.03 / sigWeight 0.03 /
   * inferredPenalty 0.1 / reinforcementWeight 0.03 / moodBoost 0=关）；
   * 0 = 该通道完全退出；负值 clamp 0（沿 coreRefBoost 模式），inferredPenalty 另设
   * 上界 1（防负 rankKey 翻转排序语义）。全 0 时与基线排序逐位一致（关断矩阵）。
   */
  timeBoost: number;
  recencyBoost: number;
  sigWeight: number;
  inferredPenalty: number;
  /** D-3：敏感性召回降权乘子（R11，clamp [0,1]；缺省 0=关断恒等）。 */
  sensitivityPenalty: number;
  /**
   * P1-T7（worthiness importance，spec §6）：importance 降权嵌套组。
   * 缺省 enabled:false = 零行为变化；penalty 缺省 0.3、clamp [0,0.9]
   * （1 会把 ≤4 的记忆乘成 0 分沉底，spec 拍板不许；enabled 才真正改排序）。
   * 用户 2026-10-14 拍板：shadowMode 配置项整体移除——开启即真实降权，
   * journal gates.importancePenalty 仍保留 raw/penalized 双分量观测。
   */
  importancePenalty: { enabled: boolean; penalty: number };
  reinforcementWeight: number;
  moodBoost: number;
  /**
   * R-A2（结构感知召回 spec §2 R4）：图一跳通道——边强度门槛（默认 0.5，clamp [0,1]）。
   * 低于该强度的 l1_links 边不入候选池（宁缺毋滥）。
   */
  graphMinStrength: number;
  /**
   * R-A2（R4）：邻居派生分折扣（默认 0.6，clamp [0,1]）。**0 = 图通道完全退出**
   * （getNeighbors 零调用，spec §3 失效即关）；关联路不适用绝对门槛，
   * 以 `[graph:kind]` 标注自证身份（T2 门/T14 租户过滤照常）。
   */
  graphDiscount: number;
  /**
   * R-A2（spec §2 R6）：场景路由加成（tiebreak 层，默认 0.04，0=关）。
   * query 含候选池中出现的 scene_name → 该场景（含层级前缀子场景）记忆 +sceneBoost。
   */
  sceneBoost: number;
  /**
   * R-A3（性能速赢 E1，spec §4）：query embedding TTL 缓存毫秒（默认 60_000，<=0 关）。
   * key=query 原文；命中免外呼（同轮多路归一）。缓存不改变任何检索输入。
   */
  queryEmbeddingCacheTtlMs: number;
  /**
   * R-A3（E2）：listValues 价值锚租户级缓存 TTL 毫秒（默认 60_000，<=0 关）。
   * 进程内全部写路径（upsert/delete/derive/restore/reset 五处穷举）即时失效；
   * TTL 仅作跨进程写漂移防御。由 factory 接线到 VectorStore.setValuesCacheTtlMs。
   */
  valuesCacheTtlMs: number;
  /**
   * R-A3（E3）：同 session 同 query 注入块复用 TTL 毫秒（默认 300_000 = 5min，<=0 关）。
   * 确定性：上轮 query 与本轮**全等**才复用（不做模糊匹配）。
   */
  sessionReuseTtlMs: number;
  /** GROW-EVO P2（§2.3）：召回默认排除失效记忆（valid_end ≤ now）。缺省 true（spec 拍板①：现存库无失效行 = 逐位不变）。 */
  excludeInvalidated: boolean;
  /** GROW-EVO P3 R10（§3.2）：情感显著度权重（缺省 0 = 恒等；实验轨）。 */
  emotionSalienceWeight?: number;
  /**
   * V2-1（引擎二 PPR spec E2.1）：PPR 阻尼系数 d（默认 0.85，clamp [0,1]）。
   * r^(t+1) = d·M·r^(t) + (1-d)·p；0 = r 恒等于种子分布（无非种子质量 = 图通道退化关断）。
   */
  pprDamping: number;
  /**
   * V2-1（spec E2.1）：非种子候选上限 pprTopK（默认 10，clamp [0,100]，取整）。
   * 0 = 零图候选（0 可设 = 通道关断矩阵延续）。
   */
  pprTopK: number;
  /**
   * V2-1（spec E2.1）：PPR 最大迭代轮数（默认 30，clamp [1,100]，取整）。
   * 收敛阈值固定 1e-6；游走展开式下长度 > 迭代数的游走贡献恒零（图构建 BFS 深度同源）。
   */
  pprIterations: number;
  /**
   * V2-2（引擎一 查询自动扩展 spec E1.1）：LLM 语义邻域扩展配置。
   * enabled=false / LLM 不可用 → 通道退出；失败/超时 → 无扩展原 query 照常（E1.4 退化）。
   * maxTerms clamp [1,32] 取整；ttlMs<=0 关缓存；timeoutMs 下界 1000。
   */
  queryExpansion: {
    enabled: boolean;
    maxTerms: number;
    ttlMs: number;
    timeoutMs: number;
    /** 2026-10-19 热路径改造：hybrid-fallback 路扩展词等待帽（ms，0=旧行为全额等待）。
     *  LLM RTT 实测 2.2-2.4s > 热路预算；帽内未返回→本请求零扩展照常检索，
     *  promise 后台完成落 TTL 缓存（下轮同 query 即时命中）。缺省 1500。 */
    hotPathTimeoutMs: number;
    /** 扩展失败负缓存 TTL（ms，0=关）：LLM 故障/超时后短周期内直接短路 []，
     *  不逐请求重付 RTT。缺省 30000。 */
    negativeTtlMs: number;
  };
  /**
   * V2-3（引擎三 E3.1）：探索位——最终排序后、截断前，结构命中且 recall_count < 池内
   * 中位数的低频候选占末席 + [explore] 标注（默认 true，false = 通道退出）。
   */
  exploreSlot: boolean;
  /**
   * V2-3（引擎三 E3.2）：分析型 query 结论层放宽——追加 significance top-5 durative 结论
   * （无需 scene/text 命中；默认 true）。
   */
  conclusionRelaxedForAnalytical: boolean;
  /**
   * Task CAL C1（brief 裁决）：结论层注入前截断——selectL2Conclusions 产出后、注入前
   * 按 maxCharsPerMemory 截断（默认 2000 字符/块，0=不截断）+ 尾部 `…[截断:原文N字]` 标注。
   * 修首跑 F1：巨型场景块摘要（21,660 字符）无截断注入 → 万词面通用匹配器。
   * 纯注入层截断：不碰绝对门槛/九通道排序逻辑（R7 不变式零变化）。
   */
  conclusionLayer: {
    /**
     * 审查修补 I①（关断矩阵纪律）：R7 结论层总开关（缺省 true = 现行为）。
     * false = 结论层整体退出（候选零收集/选择零执行/V2-3 放宽零触发），下游沿
     * "无 L2 命中退化"同一既有路径，输出与 R7 前基线逐位一致。
     */
    enabled: boolean;
    maxCharsPerMemory: number;
    /**
     * Batch B F2（2026-10-20 · issue #76）：结论行截断模式——"chars" 码点中句（现状）|
     * "sentences" 句界整句保留；缺省/非法回落 "chars" = 逐位现状。
     */
    truncateMode: "chars" | "sentences";
    /**
     * Batch B F2（2026-10-20 · issue #76）：结论层注入总预算（所有结论行合并字符上限）。
     * 缺省 undefined = 关 = 逐位现状；负/非有限 → 0（关）；正数 floor。行级配额 =
     * floor(min(maxTotalChars/count, maxCharsPerMemory))（allocateConclusionPerLineChars）。
     */
    maxTotalChars?: number;
    /**
     * v18-c（何晨拍板「全做」2026-10-05）：结论块低密度门——句子级去重保留率下限（0-1；
     * undefined/0 = 关 = 逐位现状；>1 clamp 1）。门在 selectL2Conclusions 候选循环内：
     * conclusionUniqRatio(content) < 阈值 → 跳过取下一名（宁缺毋滥 + 让位语义）。
     * 背景：低密度自指回放块（「同源再交付无新增仅维护热度」句式高频重复）吃满
     * halfLimit 结论层配额（v18 取证 §13 ③）。
     */
    minUniqRatio?: number;
    // #99 F1（2026-10-25）：原 textHitMaxTokenRatio（issue #2 万词面 token 剔除门）退役——
    // 候选集占比自指病灶：候选经 buildFtsQuery FTS 预筛天然含查询 token，占比恒≈1，
    // 最贴题 token 反被剔（P3 结论层 0 行）。键三面退役（类型/解析/yaml），历史 yaml
    // 残留此键被解析器静默忽略；万词面降权回归 idfWeighted 排序消歧（下键）。
    /**
     * 审查修补 I③（TTL 解耦）：幂等结论层缓存 TTL 毫秒。缺省（未配置）= 回落
     * sessionReuseTtlMs 保持现行为；显式 0 = 关（每次重组，不缓存）；负值 clamp 0。
     */
    cacheTtlMs?: number;
    /**
     * #53（2026-10-19）：L2 结论层 textHit IDF 加权排序（缺省 false = 逐位现状）。
     * true = selectL2Conclusions 同 source 层内按 batch 相对 IDF 分降序稳定重排
     * （稀有 token 命中者先于万词面命中者）；层级序与平分保序不变。确定性纯函数。
     */
    idfWeighted: boolean;
    /**
     * R71-A1（2026-10-19）：work_fact 候选 bm25 预地板（legacy 绝对分口径）——raw
     * relevance（=-FTS5 rank）低于此值的候选在进选择器前剔除。缺省 undefined/0 = off。
     * #99 F2（2026-10-25） legacy 化：BM25 分为语料相对值（非可比绝对值），库增长使绝对门
     * 语义漂移（l1_archive 已 6444 行）；新部署用 minBm25RelRatio 相对门，本键保留作未迁移
     * 部署兜底（行为逐位不变）；与 minBm25RelRatio 并存时相对门优先。
     */
    minBm25Rel?: number;
    /**
     * #99 F2（2026-10-25）：work_fact 候选 bm25 预地板相对化——门槛 = α×topRel
     * （topRel=本候选池最大 raw rel），α∈[0,1] clamp。刻度无关（BM25 分为语料相对值，
     * search-at-depth ch3-s2），库增长免重定标；α∈[0.3,0.5] 起步（票面，现值 0.4）。
     * 与 minBm25Rel 并存时相对门优先；缺省 undefined/0 = off（legacy minBm25Rel 独立生效）。
     */
    minBm25RelRatio?: number;
    /**
     * R71-A2（2026-10-19）：结论层 rerank 语义门（主门）。mode 缺省 "shadow"
     * （shadow-first：只记录不过滤，journal gates.conclusionRerank 观测定标后切 enforce）；
     * "enforce" = score < minScore 的选中结论在幂等指纹缓存前剔除；"off" = 零开销。
     * minScore 按 provider 刻度定标（local logits 缺省 -1.0；经验层 -2.0 对结论层实测
     * 太松——设计 §2.2）。门 wiring 与经验层同源（resolveRerankWiring+rerankDeps）。
     * #99 F3（2026-10-25）：local logit 在门边界 sigmoid 归一 0..1 后对门槛（minScore 仍按
     * provider 原生刻度声明，门槛同变换 sigmoid(minScore)，单调等价）；enforce 全员低于
     * 阈值时降级旁路不清零（journal degraded 归因）。
     */
    rerankGate?: { mode: "off" | "shadow" | "enforce"; minScore?: number };
  };
  /**
   * #78 R-b（2026-10-25，survey F4 small-to-big 下半段）：结论卡身世回捞——读面独立开关
   * （不挂 conclusionLayer 语义）。开启时 work_fact 结论候选命中后按 recordId 单跳回捞
   * part_of 证据行，作预算内附加「上下文行」注入（行形态 `- [上下文|场景] 内容`）；
   * maxExtraLines 全局帽（缺省 2），附加行挤经验层配额 ⇒ 注入总行数 = maxResults 恒定。
   * 代码缺省关（enabled 缺省 false = 逐位现状）；部署 yaml 显式开（#77 三键同款）。
   * maxExtraLines 负值 → 0（=关）；非数字/非有限回落缺省 2。
   */
  smallToBig: { enabled: boolean; maxExtraLines: number };
  /**
   * Batch C C-b（#77 伴生，2026-10-20 · survey F6b）：检索期重算时间衰减乘子——
   * compositeScore timeProx 因子 × 0.5^(ageDays/halfLifeDays)（MemOS 对标 30d 半衰期；
   * 永不归零 floor 0.05 = never-a-filter：陈旧只降权绝不埋没，不构成绝对门槛）。
   * 缺省 enabled=false = 逐位现状（config-first）；halfLifeDays 非有限/负 → 30。
   */
  ageDecay: { enabled: boolean; halfLifeDays: number };
  /**
   * Batch C C-b（#77 伴生）：timeProx 时间锚回退——occurredAt 缺失时以记录 createdAt
   * 折算时近因子（治 work_fact 大面积空 occurred_at 期的时近信号全失）。缺省 false
   * = 逐位现状（无实证不加成，R1 口径不变）。
   */
  timeProxFallbackEnabled: boolean;
  /**
   * R71-C（2026-10-19）：fts-only 降级注入帽——向量路死（ftsHits>0 ∧ embeddingHits=0 ∧
   * strategy≠keyword）时注入块（结论+经验合计）从尾部裁到此帽内（结论前置=头部保留
   * 优先）。缺省 2（无结果兜底；0=off=逐位现状）。非降级路径零触碰。
   */
  ftsOnlyInjectCap?: number;
  /**
   * #54（2026-10-19）：召回注入动态 topK——按经验层 scores 分布的 elbow（最大相邻
   * 落差）收缩注入条数（只缩不扩）。缺省 enabled=false=逐位现状（固定条数注入）。
   * 刻度无关（纯相对落差，兼容 cosine/RRF 两种 scores 量纲）；scores 缺席（keyword
   * FTS 路无平行分数）不切；span<=0（全同分/非降序）不切。确定性纯函数
   * dynamicTopKCount（recall-dynamic-topk.ts），调用点 auto-recall.ts R7 经验层切片后。
   */
  dynamicTopK: {
    /** 总开关（缺省 false = 逐位现状）。 */
    enabled: boolean;
    /** 保底条数（clamp [1,50]，先 floor；缺省 2）——elbow 不会切到低于此值的注入。 */
    minTopK: number;
    /** elbow 门槛：最大相邻落差 ≥ dropRatio × (首分-末分) 才切（clamp [0.01,1]；缺省 0.5）。 */
    dropRatio: number;
  };
  /**
   * RV2（task RV2-2，brief 裁决）：精排重设计 = 相关度主导组合分四因子权重
   * compositeScore = 0.70×relevanceNorm + 0.15×timeProx + 0.10×sigNorm + 0.05×coreRefHit。
   * relevance = 候选相关度分池内 max 归一（直接命中=fused score；图候选=派生分
   * maxHitScore×graphDiscount×pprNorm——同量纲同尺度，E2.1 派生分=相关度折扣分）；
   * timeProx = occurred_at 时近性 1/(1+ageDays)；significance = 0..1；coreRef = 标签命中 0/1。
   * 契约：relevance 主因子 ≥70%、结构因子合计 ≤30%；负值 clamp 0；全 0 = 权重信号关断
   * 恒等；**relevance=0 = 退化纯时间/显著排序（预期行为变更，登记）**。
   */
  rerankWeights: {
    relevance: number;
    timeProx: number;
    significance: number;
    coreRef: number;
  };
  /**
   * DS-RECALL-MERGE-001（合并召回 · 核心单点）：/v3/recall 端点配置。
   * enabled 缺省 false = 逐位现状（端点 404，代理走旧路 /v3/atomic/search 自行组装）；
   * yaml 显式开启后，MemoryProxy 瘦传输链路（TdaiL1RecallInjector → /v3/recall）才生效。
   */
  v3Recall: {
    /** 总开关（缺省 false = 逐位现状；enabled=false 时端点返回 404 + 明确错误信息）。 */
    enabled: boolean;
    /** 端点内召回超时毫秒（缺省 5000，与 recall.timeoutMs 同族；超时 → 504，代理降级旧路）。 */
    timeoutMs: number;
  };
  /**
   * P1 召回质量（spec §4.3，task-1）：召回精排 rerank provider 面（memory.recall.rerank.*）。
   * 与上方 rerankWeights（RV2-2 进程内组合分四因子）是**不同概念**——本组是云/本地
   * 精排 provider 配置。铁律：enabled 缺省 false + provider 缺省 none = 逐位现状
   * （config-first 关断矩阵；yaml 显式开启前任何调用方拿不到精排通道，接线在 Task 2）。
   */
  rerank: RecallRerankConfig;
}

/**
 * P1 召回质量（spec §4.3，task-1）：rerank provider 配置键集。
 * 校验沿 embedding 先例（同文件）：云端 provider 缺 apiKey → configError +
 * enabled 强制 false（不在启动路径抛异常）；非法 provider → 回落 none + configError。
 */
export interface RecallRerankConfig {
  /** 总开关（缺省 false = 逐位现状；开启即真实生效——shadowMode 已按用户 2026-10-14 拍板移除）。 */
  enabled: boolean;
  /** provider（缺省 none = skip）。local 为 Task 3 可插拔 id（落地前工厂显式返回 null）。 */
  provider: "siliconflow" | "dashscope" | "local" | "none";
  /** 云端 provider API Key（siliconflow/dashscope 必填；缺失 → configError + enabled 强制 false）。 */
  apiKey: string;
  /** 端点覆盖（缺省 "" = provider 官方端点；dashscope 业务空间专属域经此设置）。 */
  baseUrl: string;
  /** 模型覆盖（缺省 "" = provider 推荐档：siliconflow Qwen/Qwen3-Reranker-0.6B / dashscope qwen3-rerank）。 */
  model: string;
  /** 单次精排 HTTP 超时毫秒（缺省 800；负值 clamp 0——沿 v3Recall「语义自毁不拦 loud 显形」先例）。 */
  timeoutMs: number;
  /** 送精排的候选池大小（原 topK 5 扩池至此，精排后取回 topK；缺省 12，clamp [1,100] 取整）。 */
  candidates: number;
  /**
   * 相关度门槛（缺省 -2.0；任意有限数透传——负值合法，local logits 刻度门槛可为负）。
   * #99 F3（2026-10-25）：本键恒按 provider 原生刻度声明（local=logit，云 provider=0..1）；
   * 门边界 local logit 先 sigmoid 归一 0..1、门槛同变换 sigmoid(minScore)（单调等价）；
   * 全员低于阈值不清零——回退未重排顺序（journal gates.rerank degraded 归因）。
   */
  minScore: number;
  /** provider:"local"（Task 3 transformers.js 本地模型）参数。 */
  local: {
    /** 模型目录（缺省 "" = 运行期 dataDir/models/reranker/Xenova/bge-reranker-base）。 */
    modelDir: string;
    /** 空闲卸载毫秒（缺省 600000 = 10min；0 = 常驻；负值 clamp 0）。 */
    idleUnloadMs: number;
  };
  /** provider 校验失败说明（云端缺 apiKey / 非法 provider）；caller 负责日志；无错 undefined。 */
  configError?: string;
}

/**
 * 场景块治理设置（DS-SCENE-GOV-001，Task GOV-1）。
 * 铁律：enabled 缺省 false = 生产行为零变化；仅 yaml 显式开启后治理链路才介入。
 */
export interface SceneGovernanceConfig {
  /** 总开关（缺省 false = 逐位现状）。 */
  enabled: boolean;
  /** 块体超限阈值（码点数，非字节）。缺省 8000；clamp [500, 100000]。 */
  maxBlockChars: number;
  /** 蒸馏 LLM 调用超时毫秒。缺省 60000；负值 clamp 0。 */
  distillTimeoutMs: number;
  /** 蒸馏失败兜底硬截断上限（码点）。缺省 20000；clamp 下限 = maxBlockChars（传入更小值抬到 maxBlockChars）。 */
  hardCapChars: number;
}

/** G 记忆图（l1_links）设置 — 写入时建边开关。 */
export interface MemoryLinksConfig {
  /** 在 dedup 决策后为 L1 建边（merge→similar / update→evolve / conflict→conflict）。默认 true。 */
  enabled: boolean;
  /**
   * S1（T9 裁决待办收口）：similar 边最低相似度门槛（真 cosine，score=1-distance）。
   * 低于此值的 "similar" 关系是假关系，宁缺毋滥不建边。默认 0.3（原
   * MIN_SIMILAR_STRENGTH 硬编码值，缺省行为逐位不变）；越界 clamp [0,1]；
   * 非法值（非有限数）拒绝该值回退默认。
   */
  minSimilarity: number;
}

/** K 核心记忆写入口信任边界（第三轮审计 F2：防投毒覆盖身份层红线）。 */
export interface MemoryCoreMemoryConfig {
  /** 写入口开关（默认 true = 允许经 /v3/core-memory/write 写）。关掉后写路由返回 403。 */
  writeEnabled: boolean;
  /** 允许写入的 slot 白名单。空数组 = 拒绝所有写入（宁缺毋滥）。 */
  allowedSlots: string[];
  /** 单条 content 最大长度（默认 2000 字符，core 是"自我"小块，不是记忆堆）。 */
  maxContentLength: number;
  /**
   * 价值锚种子（B1 单一源落地）：core_values 表空时用本配置灌种子值。
   * 格式 [{ id, label, weight, created_by }]。缺省空 = 不自动灌。
   */
  seedValues?: Array<{ id: string; label: string; weight: number; createdBy?: string }>;
  /**
   * GROW（价值锚自生长）：调度器挂钩的自发现+自动采纳护栏。
   * 解析+clamp+默认（缺省 = DEFAULT_ANCHOR_DISCOVERY_CONFIG：开/5/2/15/24h）。
   */
  anchorDiscovery: {
    enabled: boolean;
    minEvidence: number;
    maxPerPass: number;
    maxTotal: number;
    /** #94（拍板①）：名额口径——"total"=池内 active 总数（auto+manual+seed 全算，pinned 计入总数，逐出豁免 pinned）；"auto"=旧口径（origin=auto 非钉 + 钉住）。缺省 "total"。 */
    quotaScope: "auto" | "total";
    intervalHours: number;
    /** V10-MAINT-DECOUPLE：维护面独立调度节奏小时数（0=每 tick；clamp 0..168，缺省 6）。 */
    maintainIntervalHours: number;

    /** DS-SOUL-MEMORY-002 P2：人物锚池（spec §2.6 双池；enabled 缺省 false=逐位现状）。 */
    person: {
      enabled: boolean;
      minEvidence: number;
      maxPerPass: number;
      maxTotal: number;
    };
    /** P2：GROW-MAINT 身份分支（F15 身份分支/F20 只警告；enabled 缺省 false=逐位现状）。 */
    identityMaintain: {
      enabled: boolean;
    };
    /** P3：品格锚池（聚合源=self_identity 槽事实；enabled 缺省 false=逐位现状）。 */
    character: {
      enabled: boolean;
      minEvidence: number;
      maxPerPass: number;
      maxTotal: number;
    };
    /** G-SIMMERGE：采纳前字面相似门（enabled 缺省 false=逐位现状；threshold bigram Jaccard）。 */
    similarMerge: {
      enabled: boolean;
      threshold: number;
    };
  };
  /** S-CHAR-2（M2/P3，DS-SOUL-EVOLUTION-001 §2）：品格张力检测。enabled 缺省 false=逐位现状；
   *  检测器确定性（character-tension.ts 单一源）；提案落库走既有 F19/F15 门族（R-D 不新造门）。 */
  characterTension: {
    enabled: boolean;
    minInstances: number;
    maxCandidatesPerPass: number;
  };
  /**
   * S-FEEL-1（M1/DS-SOUL-EVOLUTION-001 §1.4）：近期情绪基调行。enabled 缺省 false=逐位现状；
   * 红线 R-A：mood 不参与召回排序/加权（情绪不得喂自身回路）。窗口/样本数/阈值 clamp 防配置手滑。
   */
  moodLine: {
    enabled: boolean;
    windowHours: number;
    maxSamples: number;
    minSamples: number;
    posThreshold: number;
    negThreshold: number;
    halfLifeHours: number;
  };
  /**
   * DS-SOUL-MEMORY-002 P1：agent 自我层双视角（enabled 缺省 false=逐位现状，
   * 含 LLM prompt 行为）。maxPerPass clamp 1..10；intervalHours clamp 1..168。
   */
  selfIdentity: {
    enabled: boolean;
    maxPerPass: number;
    intervalHours: number;
  };
  /** F17 段级注入预算（chars 为 token 粗粒度近似；clamp 100..2000）。 */
  soulRender: {
    budgetSelfChars: number;
    budgetIdentityChars: number;
    /** F17（审计补齐）：重要的人 行数上限（1..20，缺省 5）。 */
    maxRelationLines: number;
    /** #10 T4：价值锚行总长预算（整锚粒度从尾丢；0=关（缺省，逐位现状），开则建议 480）。 */
    budgetAnchorChars: number;
    /** #10 T4：重要的人 行总长预算（整人粒度从尾丢；0=关（缺省），开则建议 400）。 */
    budgetPersonChars: number;
    /** #10 T4：品格行总长预算（整锚粒度从尾丢；0=关（缺省），开则建议 300）。 */
    budgetCharacterChars: number;
    /** #30（R5-F1 接线）：soul 快照旁路落账开关（缺省 true=开；false=运维关闭持久化写；
     *  零注入影响——只写 soul_snapshots 观测表）。 */
    snapshotsEnabled: boolean;
    /** #52 D3（双通道 slots 去重）：per-turn 身份两行省略门——缺省 true=逐位现状；
     *  显式 false=双通道（selfIdentity.enabled=true）路径跳过（我是谁）[self_identity] 与
     *  （我心中的他）[identity] 两行 slots 行（会话头时机已承载，逐轮省略）；红线段/
     *  价值锚行/重要的人/品格行/感受段/capabilities 段照常。legacy 路径不适用
     *  （身份行是 legacy 唯一身份载体）。布局级渲染门：不翻 soulVersion（批次纪律）。 */
    perTurnSlots: boolean;
    /** #67（R3 身份叙事层，2026-10-19）：identity/self_identity 两槽确定性叙事化门——
     *  缺省 false=逐位现状；显式 true：soul dual 路径身份两行由 renderIdentityNarrative
     *  叙事段替代，且 /v3/core-memory/read 支持 format=narrative（身份两槽折叠为
     *  identity_narrative 合成槽，proxy 经 API 透传消费）。模板常量+事实句逐字，
     *  无 LLM/随机/时钟；生成闸违例或无身份内容→null→条目渲染兜底。Park 2411.10109
     *  口径：条目存储+叙事渲染并存（渲染侧派生不回写存储）；strict_rule/价值锚不动。
     *  布局级渲染门：不翻 soulVersion（批次纪律，ADR-0003 §5：模板指纹 nv 随门声明）。 */
    identityNarrative: { enabled: boolean };
    /** #29（R5）+#42（票 D / D9）：情境锚选择触发门——仅 价值锚行数 > maxRows 才启用
     *  （缺省 999=现状全注入）。scorer=相似度打分器 config 门（D9：确定性 cosine、shadow-first）：
     *  enabled 缺省 false=shadow 只报告不裁剪（渲染逐位现状）；true=转正（threshold 硬门+top-K
     *  重排渲染行）；threshold clamp 0..1 缺省 0（=不设语义硬门：0 只滤除负相关锚行，仅 top-K
     *  生效；>0 才是硬门）。mmrLambda=MMR 多样性 λ（灵魂注入质量轮 2026-10-19：λ<1 时对
     *  发生裁剪的池贪心去扎堆，val=λ·rel−(1−λ)·maxSim；clamp 0..1 缺省 0.7；λ≥1 退化纯 top-K）。
     *  embedBudgetMs=锚 desc 预嵌软预算 ms（灵魂注入质量轮 2026-10-19：E2E 实证冷进程 20 锚
     *  并行 embed 仍 ~3s 顶穿 5000ms v3 召回预算；超预算→scorer 回退声明序+降级渲染不入缓存，
     *  in-flight embed 后台落缓存下一请求即完整渲染。缺省 1200；0=关（无预算，旧行为）。
     *  embedder/queryEmbedding 运行时注入，不入 config。 */
    anchorSelect: { maxRows: number; scorer: { enabled: boolean; threshold: number; mmrLambda: number; embedBudgetMs: number }; shadowSink: { enabled: boolean; file: string } };
    /** soul 去重门（soul-dedupe，2026-10-19）：strictRuleDedup=红线段近重复行收敛
     *  （exact / Jaccard≥阈值 / containment；阈值 clamp 0..1 缺省 0.45，与 soul-dedupe.ts
     *  DEFAULT_RULE_JACCARD_THRESHOLD 标定一致）；anchorDedup=价值锚近重复对收敛
     *  （label 全同或双向包含且短侧≥2 字）。enabled 缺省 false=逐位现状（不去重）；
     *  开启属布局级渲染变更（遵循批次纪律：不翻 soulVersion；dropped 走 debug 日志可审计）。
     *  strictRuleDedup.maxLines=红线段行数上限（0=关缺省，1..50）：去重后从头部保留 N 条
     *  （slots 声明序=重要性序），生产红线墙治理（10 条占 60% 字数）；
     *  suppressAnchorOverlap=true：价值锚 desc 与红线行近重复时锚行让位（红线是硬约束
     *  优先级更高，软取向原则不重复占注入字数）。
     *  anchorDedup.embeddingThreshold（0..1，缺省 0=关）：label 包含对之外的 embedding
     *  语义近重复去重（desc cosine≥阈值保留首现代表锚；生产「取证」六锚同质扎堆治理）。 */
    strictRuleDedup: { enabled: boolean; jaccardThreshold: number; maxLines: number; suppressAnchorOverlap: boolean };
    anchorDedup: { enabled: boolean; embeddingThreshold: number };
    /** #36（R5）：soul_introspect 只读自省面参数——快照取尾条数（1..200 缺省 20）与
     *  孤儿锚证据窗小时数（1..2160 缺省 168=7d）；端点 body 可逐次覆盖。 */
    introspect: { snapshotLimit: number; evidenceWindowHours: number };
    /** #40（ADR0003-P3 接线票 B）：capabilities 数据源门——/v3/recall body 携带策展清单
     *  时是否渲染进 soul 前缀「## 我能做什么」段。缺省 false=现状（不渲染、请求体字段
     *  被忽略）；显式 true 才消费（config-first；渲染行=传入清单 1:1，#32 一致性合同）。 */
    capabilities: { enabled: boolean };
    /** #41（ADR0003-P3 实施票 C，D8 证据门）：promise 确定性证据迁移总开关——缺省
     *  false=逐位现状（抽取管线零 promise 读零 promise 写）；显式 true 才开启：
     *  确认话语白名单（soul-promise-evidence 单一源）→ refKey 严格相等的 open promise
     *  迁移（source=evidence 全链溯源）。 */
    promiseEvidence: { enabled: boolean };
    /** T3（2026-10-17 未来性渲染面，T6-F1 接线）：承诺块渲染门——「我的承诺：」注入
     *  soul-identity（品格后红线前）。缺省 false=逐位现状（零渲染零查询：listSoulPromises
     *  不被调用）；显式 true 才消费（config-first；渲染=最新 3 条 open 承诺原文逐字，
     *  escapeXmlTags 同级消毒；宁缺毋滥：零 open 整块省略）。 */
    promises: { enabled: boolean };
  };
}

/** J 重构式回忆 · 图邻居扩展设置（宁缺毋滥：仅并入 top 种子之邻）。 */
export interface MemoryNeighborExpandConfig {
  /** 默认 false（宁缺毋滥，显式开启才扩）。 */
  enabled: boolean;
  /** 邻居扩展最大跳数（默认 1）。 */
  maxHop: number;
  /** 单次查询最多并入多少个邻居（默认 3）。 */
  maxAdd: number;
}

/** P4b 受控正文演化（GROW-EVO §4.4）设置。config-first：enabled 缺省 false = 逐位现状。 */
export interface MemoryEvolutionConfig {
  /** 总开关（默认 false——全系统唯一允许改写已固化正文的路径，必须显式开启）。 */
  enabled: boolean;
  /** 单轮最多重写多少对（LLM 成本护栏，缺省 3）。 */
  maxRewrites: number;
  /** 进程内节流毫秒（缺省 3600000 = 1 小时；重启归零多做一次幂等扫描，无害）。 */
  intervalMs: number;
}

/** H+I 生命周期 worker（巩固/遗忘）设置。结构复用各 worker 的 config 形状（宽松解析，worker 内再校验）。 */
export interface MemoryLifecycleConfig {
  /** 总开关（默认 true）。 */
  enabled: boolean;
  /** 调度间隔毫秒（默认 600000 = 10 分钟）。 */
  intervalMs: number;
  /**
   * P2-T14（H-B2）：租户隔离 filter——巩固/遗忘只处理该租户的 L1 行。
   * 缺省 undefined = 不传 = 兼容单机（处理全量）；多租户部署应显式配置。
   * （部署级保险：读侧收窄；数据级保险是 grouping 的组内租户一致性校验。）
   */
  filter?: { teamId?: string; userId?: string; agentId?: string; taskId?: string };
  /** H 巩固（默认 enabled）。persist：把持续态写回 L1。 */
  embedBackfill: {
    enabled: boolean;
    intervalMinutes: number;
    batchLimit: number;
  };
  consolidation: {
    enabled: boolean;
    persist: boolean;
    minCount: number;
    minSpanDays: number;
    /**
     * P3-T17（H1，拍板④）：subject 归组策略门。默认 "llm"——dedup LLM 顺带抽取的
     * 语义 subject 优先，缺省词法兜底（存量无 subject 的记忆仍可词法归组）；
     * "lexical" = 纯词法前缀（修复前行为）。embedding 聚类登记为后续可选项。
     */
    subjectStrategy?: "llm" | "lexical";
  };
  /** I 遗忘（默认 enabled）。宁漏勿多：仅 observed 自动归档。 */
  forgetting: {
    enabled: boolean;
    /** 时间衰减 λ（每天）。 */
    lambda: number;
    /** GROW-EVO P3（§3.1）：闪光灯调制 k（缺省 0；clamp [0, 0.9]） */
    arousalRetention: number;
    /** 低于该分且超期才归档。 */
    lowThreshold: number;
    /** 至少经过多少天才可归档。 */
    minAgeDays: number;
    /** P2（F14）：refs 遗忘保护——coreRefs/personRefs/identityRefs 命中仍有效锚或现行身份事实的记录不进归档候选（缺省 false=逐位现状）。 */
    refProtection: boolean;
    /** D-4（2026-09-22 拍板）：周期性事实遗忘保护（缺省 false = 逐位现状）。 */
    recurrenceProtection: boolean;
    /** D-3：敏感偏置——敏感记忆（≠none）整体分值 ×(1-bias)，缺省 0=逐位现状。 */
    sensitivityBias: number;
  };
  /** P3-F13：反思触发（Generative Agents 对标；enabled 缺省 false=逐位现状）。 */
  reflection: {
    enabled: boolean;
    rRef: number;
    /** #27（R5）：反思结论 → 身份层提案（O13 rail）桥接门；缺省 false=逐位现状。 */
    soulProposals: {
      enabled: boolean;
      /** #ε-定标（ADR0003 D7）：shadow 旁路采集（行为零变化）；缺省 false=零旁路。 */
      shadowCalibration?: { enabled?: boolean; file?: string };
      /** #60（S22，2026-10-18）：反思产物契约门（D6 禁伪造当下体验+第一人称+价值锚
       *  引用，确定性机械校验；通过 → attrs.anchor_refs）；缺省 false=逐位现状。 */
      cardContract?: { enabled?: boolean };
      /** #77 Batch D（survey F1）：结论卡原子性契约门（一句话一件事拆条引导）。
       *  拒收门无条件生效，本键只控制 few-shot prompt 附加；缺省 false=逐位现状。 */
      conclusionContract?: { enabled?: boolean };
    };
    /** #44（D8-(c)）：反思周期 → promise 迁移提案桥接门；缺省 false=逐位现状。 */
    promiseProposals: { enabled: boolean };
    /** #81/#91：self_identity 提案相似门——yaml 显式写的键才材料化（parse 白名单接线，FLOW-E「不接线即死配置」教训）；
     *  不写=缺省行为逐位（闸门/抑制缺省开、recurrence 复现计票缺省关）。 */
    selfIdentityGate?: {
      enabled?: boolean;
      threshold?: number;
      suppression?: { enabled?: boolean; maxPending?: number };
      recurrence?: { enabled?: boolean; votes?: number; ttlHours?: number; spanHours?: number };
      /** #91 K 阀（2026-10-24）：源头硬闸缺省 off=逐位现状；窗口内该租户 self_identity 新落库 >= maxNew → push 支路跳过。maxNew 标定 12、窗口缺省 24h。 */
      rateLimit?: { enabled?: boolean; maxNew?: number; windowHours?: number };
      /** #92 stage 2（2026-10-25 拍板四项）：确定性自动采纳门缺省 off=逐位现状；N₂/T₂ 缺省 4/72、矛盾线 0.60（宁拦勿收）、重复线 0.75（单一源标准）。生产启用由部署面显式写 yaml（人格写入终审权变更的最后一道闸）。 */
      autoAdopt?: { enabled?: boolean; votes?: number; spanHours?: number; contradictionThreshold?: number; dupThreshold?: number };
    };
  };
}

/** Embedding service configuration for vector search. */
export interface EmbeddingConfig {
  /** User-facing default is true in schema, but provider="none" still disables embedding effectively. */
  enabled: boolean;
  /** Embedding provider: default "none" disables vector search; other values (e.g. "openai", "deepseek") are treated as OpenAI-compatible remote providers. */
  provider: string;
  /** API Base URL (required for remote provider). */
  baseUrl: string;
  /** API Key (required for remote provider). */
  apiKey: string;
  /** Model name (required for remote provider). */
  model: string;
  /** Vector dimensions (required for remote provider, must match model). */
  dimensions: number;
  /**
   * Whether to send the `dimensions` field in the embeddings request body.
   * Default true (compatible with OpenAI text-embedding-3-* Matryoshka models).
   * Set to false for self-hosted / OSS models that reject unknown `dimensions`
   * (e.g. BGE-M3, which returns HTTP 400 "does not support matryoshka representation").
   */
  sendDimensions: boolean;
  /** Top-K candidates to recall during conflict detection (default: 5) */
  conflictRecallTopK: number;
  /** Proxy URL for qclaw provider — when provider="qclaw", requests are forwarded through this local proxy */
  proxyUrl?: string;
  /** Max input text length in characters before truncation (default: 5000). Texts exceeding this limit are truncated with a warning. */
  maxInputChars: number;
  /** Timeout per embedding API call in milliseconds (default: 10000). */
  timeoutMs: number;
  /** Override timeoutMs for recall-path embedding calls (user-facing, should be shorter). Falls back to timeoutMs. */
  recallTimeoutMs?: number;
  /** Override timeoutMs for capture-path embedding calls (background L1 dedup, can be longer). Falls back to timeoutMs. */
  captureTimeoutMs?: number;
  /** Internal-only local model cache directory, not exposed in plugin schema. */
  modelCacheDir?: string;
  /** If set, contains an error message about invalid remote config (embedding is disabled) */
  configError?: string;
}

/** Daily cleaner settings for local JSONL data (L0/L1). */
export interface MemoryCleanupConfig {
  /** TTL switch from capture.l0l1RetentionDays. Undefined means disabled. */
  retentionDays?: number;

  /** Whether cleanup is enabled. True only when retentionDays is a valid positive number. */
  enabled: boolean;
  /** Daily execution time in HH:mm format (default: 03:00). */
  cleanTime: string;
}

/** BM25 sparse vector encoding configuration (local @tencentdb-agent-memory/tcvdb-text). */
export interface BM25Config {
  /** Whether BM25 sparse encoding is enabled (default: true) */
  enabled: boolean;
  /** Language for BM25 pre-trained params: "zh" or "en" (default: "zh") */
  language: "zh" | "en";
}

/** Tencent Cloud VectorDB configuration. */
export interface TcvdbConfig {
  /** Instance URL (e.g. "http://10.0.1.1:80" or external domain) */
  url: string;
  /** Account name (default: "root") */
  username: string;
  /** API Key */
  apiKey: string;
  /** Database name (auto-generated from instance_id if empty) */
  database: string;
  /** User-friendly alias for this database (optional, for identification in database.json) */
  alias: string;
  /** Whether to enable VectorDB server-side dense embedding/vector index. Default false: BM25 sparse only. */
  embeddingEnabled?: boolean;
  /** Built-in embedding model (default: "bge-large-zh"; used only when embeddingEnabled=true) */
  embeddingModel: string;
  /** Request timeout in ms (default: 10000) */
  timeout: number;
  /** Path to CA certificate PEM file (for HTTPS connections) */
  caPemPath?: string;
}

/** Storage backend type. */
export type StoreBackend = "sqlite" | "tcvdb";

/** Report settings — controls metric/event reporting. */
export interface ReportConfig {
  /** Enable reporting (default: true) */
  enabled: boolean;
  /** Reporter type: "local" logs structured JSON via logger (default: "local") */
  type: string;
}

/**
 * Standalone LLM configuration — when set, TDAI uses direct API calls
 * instead of the host's built-in LLM runner (e.g. OpenClaw's runEmbeddedPiAgent).
 *
 * This allows using a different (often cheaper/faster) model for memory
 * extraction while the main agent uses a premium model.
 *
 * Leave undefined (default) to use the host's native LLM mechanism.
 */
export interface StandaloneLLMOverrideConfig {
  /** Enable standalone LLM mode (default: false). When false, uses host LLM. */
  enabled: boolean;
  /** OpenAI-compatible API base URL (e.g. "https://api.openai.com/v1"). */
  baseUrl: string;
  /** API key for authentication. */
  apiKey: string;
  /** Model name (e.g. "gpt-4o", "deepseek-v3", "claude-sonnet-4-6"). */
  model: string;
  /** Max output tokens (default: 4096). */
  maxTokens: number;
  /** Request timeout in milliseconds (default: 120000). */
  timeoutMs: number;
  /** 多提供商兼容（T2）：max_tokens 上限（按模型声明，缺省 131072=Ark 上限）。 */
  maxTokensLimit?: number;
  /**
   * LLM 访问模式：
   *   - "openai": 直连 OpenAI 兼容服务（默认）
   *   - "proxy":  走 context_proxy，运行时把 baseUrl 拼成
   *               `${baseUrl}/proxy/<instanceId>/v1`，Authorization 用 memory 系统用户 key
   * gateway 层负责在构造 runner 前把 baseUrl / apiKey 换成解析后的最终值，
   * 因此 runner 无需感知 provider 字段。
   */
  provider?: "openai" | "proxy";
  /** provider=proxy 时的可选配置。 */
  proxy?: {
    /** 是否用 memory systemUser.userKey 作为 Authorization（默认 true）。 */
    useMemorySystemUserKey?: boolean;
  };
  /**
   * 是否用流式请求(streamText)调用上游。默认 false(generateText 非流式)。
   * 个别 OpenAI 兼容上游只接受流式请求时置 true。
   *
   * ⚠️ 仅在 standalone LLM 路径生效(即 llm.enabled=true 时,memory 用自带的
   * StandaloneLLMRunner 调用上游);未启用 standalone 时走 OpenClaw host runner,
   * 该开关被忽略。也不会把增量 token 透传给调用方,只是"以流式协议请求上游后
   * 等待完整文本",给只接受流式的兼容后端做兼容层用。
   */
  stream?: boolean;
}

/** Context Offload settings — controls multi-layer context compression. */
export interface OffloadConfig {
  /** Enable context offload (default: false) */
  enabled: boolean;
  /**
   * LLM execution mode for L1/L1.5/L2 tasks.
   * - "local": call LLM directly via AI SDK (uses offload.model or main agent model)
   * - "backend": route through remote backend service (requires backendUrl)
   * - "client": stateless client mode — all compression delegated to offload server v2
   * - "collect": data collection only — runs L1/L1.5/L2 asynchronously but disables
   *   L3 compression and does NOT occupy the contextEngine slot (uses legacy compaction)
   * Default: "local" (auto-detects based on backendUrl presence for backward compat)
   */
  mode: "local" | "backend" | "client" | "collect";
  /** LLM model for offload tasks, format: "provider/model-id". Falls back to agents.defaults.model when omitted. */
  model?: string;
  /** LLM temperature (default: 0.2) */
  temperature: number;
  /**
   * 是否用流式请求(streamText)调用上游(仅 mode="local" 生效)。默认 false(非流式)。
   * 个别只接受流式请求的 OpenAI 兼容上游需置 true。
   *
   * ⚠️ mode="backend"/"client"/"collect" 由远端 offload server 主导调用,
   * 本地 stream 开关被忽略。也不会把增量 token 透传给调用方,只是"以流式协议
   * 请求上游后等待完整文本",给只接受流式的兼容后端做兼容层用。
   */
  stream?: boolean;
  /** Force-trigger L1 when pending tool pairs >= this threshold (default: 4) */
  forceTriggerThreshold: number;
  /** Custom data directory (absolute path). Default: ~/.openclaw/context-offload */
  dataDir?: string;
  /** Default context window size (default: 200000) */
  defaultContextWindow: number;
  /** Max tool pairs per L1 batch (default: 20) */
  maxPairsPerBatch: number;
  /** Trigger L2 when node_id=null entries >= this count (default: 4) */
  l2NullThreshold: number;
  /** Trigger L2 if hasn't run for this many seconds (default: 300) */
  l2TimeoutSeconds: number;
  /** Mild compression ratio threshold (default: 0.5) */
  mildOffloadRatio: number;
  /** Aggressive compression ratio threshold (default: 0.85) */
  aggressiveCompressRatio: number;
  /** MMD injection token budget ratio (default: 0.2) */
  mmdMaxTokenRatio: number;
  /** Backend service URL. When set, L1/L1.5/L2/L4 LLM calls go through the backend. */
  backendUrl?: string;
  /** Backend API authentication token */
  backendApiKey?: string;
  /** Backend call timeout in milliseconds (default: 10000) */
  backendTimeoutMs: number;
  /**
   * Offload data retention days. Sessions/refs/mmds older than this are cleaned up.
   * 0 = disabled (default). Values in (0, 3) are treated as invalid and forced to 0.
   * Minimum effective value: 3.
   */
  offloadRetentionDays: number;
  /**
   * Max total size in MB for offload debug log files (*.log in dataRoot).
   * When exceeded, the largest logs are truncated to zero.
   * 0 = disabled. Default: 50.
   */
  logMaxSizeMb: number;
  /**
   * User identifier sent as `X-User-Id` on backend requests. This is the
   * primary key used by the backend `/offload/v1/store` endpoint to upsert
   * per-user state. When omitted the plugin falls back to the machine's
   * primary non-loopback IPv4 address.
   */
  userId?: string;

  // ── Client mode fields (used when mode === "client") ──────────────
  /** Offload server v2 base URL (e.g. "http://localhost:9100"). */
  serverUrl?: string;
  /** Bearer token for offload server v2 Authorization header. */
  apiKey?: string;
  /** X-TDAI-Service-Id header value. */
  serviceId?: string;
  /** Agent name used in storage path (default: "default"). */
  agentName?: string;
  /** Client-side threshold: skip compaction when ratio < this value (default: 0.5). */
  compactionRatio?: number;
  /** Ingest request timeout in ms (default: 5000). */
  ingestTimeoutMs?: number;
  /** Compaction request timeout in ms (default: 30000). */
  compactionTimeoutMs?: number;
}

/** T5（用户 2026-09-22 拍板定案）：召回/灵魂注入日志旋钮（缺省 enabled=false=逐位现状）。 */
export interface RecallJournalConfig {
  enabled: boolean;
  rotationSizeMB: number;
  maxFiles: number;
}

/** Fully resolved plugin configuration (v3). */
export interface MemoryTdaiConfig {
  /** Global prompt family; group-level promptMode can override it. */
  promptMode: MemoryPromptMode;
  capture: CaptureConfig;
  extraction: ExtractionConfig;
  persona: PersonaConfig;
  pipeline: PipelineTriggerConfig;
  recall: RecallConfig;
  /** T5（2026-09-22 拍板）：召回/灵魂注入日志（缺省关闭=逐位现状）。 */
  recallJournal?: RecallJournalConfig;
  embedding: EmbeddingConfig;
  /** Storage backend: "sqlite" (default) or "tcvdb" */
  storeBackend: StoreBackend;
  /** Tencent Cloud VectorDB configuration (required when storeBackend = "tcvdb") */
  tcvdb: TcvdbConfig;
  /** BM25 sparse vector encoding (local @tencentdb-agent-memory/tcvdb-text) */
  bm25: BM25Config;
  /** Local JSONL cleanup settings */
  memoryCleanup: MemoryCleanupConfig;
  report: ReportConfig;
  /**
   * Standalone LLM override — when enabled, TDAI bypasses the host's LLM
   * (e.g. OpenClaw's runEmbeddedPiAgent) and uses direct OpenAI-compatible
   * API calls for L1/L2/L3 extraction.
   *
   * Default: disabled (uses host LLM).
   */
  llm: StandaloneLLMOverrideConfig;
  offload: OffloadConfig;
  /** G 记忆图开关（默认 enabled=true）。 */
  links: MemoryLinksConfig;
  /** K 核心记忆写入口信任边界（默认白名单 identity/core_value/strict_rule，长度 2000）。 */
  coreMemory: MemoryCoreMemoryConfig;
  /** H+I 生命周期（巩固/遗忘）配置（config-first：yaml 值真实生效）。 */
  lifecycle: MemoryLifecycleConfig;
  /** P4b 受控正文演化（GROW-EVO §4.4；enabled 缺省 false = 逐位现状）。 */
  evolution: MemoryEvolutionConfig;
  /** J 图邻居扩展（memory.search.neighborExpand）。 */
  search: {
    neighborExpand: MemoryNeighborExpandConfig;
  };
  /** 场景块治理（DS-SCENE-GOV-001；enabled 缺省 false = 生产行为零变化）。 */
  sceneGovernance: SceneGovernanceConfig;
  /** D-3（2026-09-21）：敏感性标注门（extractionEnabled 缺省 false = 逐位现状）。 */
  sensitivity: {
    extractionEnabled: boolean;
  };
  /** P1-T7（2026-10-13，worthiness importance）：写入面 gate——缺省 false =
   *  抽取 prompt 字节不变（LLM 不产出 importance 字段），逐位现状（D-3 镜像）。 */
  worthiness: {
    extractionEnabled: boolean;
  };
  /** #28（R5 统一抽取扩展门，2026-10-16）：L1 抽取 seam 扩展（state rollup/#27 promise/
   *  #5 importance）共用单 gate——缺省 false=prompt 字节逐位不变+扩展全跳过
   *  （worthiness/D-3 先例镜像；语义一处实现，#33 ADR 配置组登记项）。 */
  extractionExtensions: {
    enabled: boolean;
  };
  /**
   * Optional Skill module config. Pass-through to `resolveSkillConfig()` at
   * the host wiring layer; defaults are applied there. When absent, the
   * Skill module is not constructed (host-side gate). Shape: SkillConfigInput.
   */
  skill?: import("./core/skill/types.js").SkillConfigInput;
}

// ============================
// Parser
// ============================

/**
 * Parse plugin config from raw user input.
 * All fields have sensible defaults — minimal config is just {}.
 */
export function parseConfig(raw: Record<string, unknown> | undefined): MemoryTdaiConfig {
  const c = raw ?? {};
  /**
   * R-A1：memory.recall 结构信号开关解析（沿 C1 coreRefBoost 的 clamp 模式）。
   * 缺省/非有限数 → 默认值；负值 clamp 0（0 = 通道完全退出，不在启动路径抛异常）；
   * max 上界可选（inferredPenalty 上界 1，防 (1-penalty) < 0 翻转排序语义）。
   */
  const recallSignalBoost = (group: Record<string, unknown>, key: string, def: number, max?: number): number => {
    const v = num(group, key);
    if (v === undefined || !Number.isFinite(v)) return def;
    const clamped = Math.max(v, 0);
    return max !== undefined ? Math.min(clamped, max) : clamped;
  };

  // --- Prompt mode (L1-L3) ---
  const promptsGroup = obj(c, "prompts");
  const globalPromptMode = normalizePromptMode(str(c, "promptMode") ?? str(promptsGroup, "mode"));

  // --- Capture (L0) ---
  const captureGroup = obj(c, "capture");

  // --- Retention days validation (from capture.l0l1RetentionDays) ---
  const rawRetentionDays = num(captureGroup, "l0l1RetentionDays") ?? 0;
  const allowAggressiveCleanup = bool(captureGroup, "allowAggressiveCleanup") ?? false;

  let retentionDays: number | undefined;
  if (rawRetentionDays <= 0) {
    retentionDays = undefined;
  } else if (rawRetentionDays >= 3) {
    retentionDays = rawRetentionDays;
  } else if (allowAggressiveCleanup) {
    retentionDays = rawRetentionDays;
  } else {
    retentionDays = undefined;
  }

  // --- Extraction (L1) ---
  const extractionGroup = obj(c, "extraction");

  // --- Persona (L2/L3) ---
  const personaGroup = obj(c, "persona");

  // --- Pipeline ---
  const pipelineGroup = obj(c, "pipeline");

  // --- Recall ---
  const recallGroup = obj(c, "recall");
  const recallJournalGroup = obj(c, "recallJournal");

  // --- Embedding ---
  const embeddingGroup = obj(c, "embedding");
  let embeddingConfigError: string | undefined;

  // Embedding config: determine provider based on user input and apiKey availability
  const embeddingApiKey = str(embeddingGroup, "apiKey") ?? "";
  const embeddingBaseUrl = str(embeddingGroup, "baseUrl") ?? "";
  const embeddingProviderRaw = str(embeddingGroup, "provider") ?? "none";
  const embeddingModelRaw = str(embeddingGroup, "model") ?? "";
  const embeddingDimensionsRaw = num(embeddingGroup, "dimensions");
  const embeddingProxyUrl = str(embeddingGroup, "proxyUrl");

  // provider="none" → embedding disabled (default for zero-config users)
  // provider="local" → no longer exposed to users; treated as disabled at entry level
  // provider="qclaw" → requires proxyUrl for local proxy forwarding
  // Any other value → remote mode (requires apiKey, baseUrl, model, dimensions)
  let embeddingProvider: string;
  let embeddingEnabled = bool(embeddingGroup, "enabled") ?? true;

  if (embeddingProviderRaw === "none") {
    // Explicitly disabled (default): no embedding, no vector search
    embeddingProvider = "none";
    embeddingEnabled = false;
  } else if (embeddingProviderRaw === "local") {
    // Local embedding is not exposed to users; treat as disabled at entry level.
    // Internal LocalEmbeddingService code is preserved but not reachable from config.
    embeddingProvider = "none";
    embeddingEnabled = false;
    embeddingConfigError =
      "Local embedding provider is not available in user config. " +
      "Please configure a remote embedding provider (e.g. openai, deepseek). Embedding has been disabled.";
  } else if (embeddingProviderRaw === "qclaw") {
    // qclaw provider: requires proxyUrl for local proxy forwarding
    const missingFields: string[] = [];
    if (!embeddingProxyUrl) missingFields.push("proxyUrl");
    if (!embeddingBaseUrl) missingFields.push("baseUrl");
    if (!embeddingApiKey) missingFields.push("apiKey");
    if (!embeddingModelRaw) missingFields.push("model");
    if (embeddingDimensionsRaw == null || embeddingDimensionsRaw <= 0) missingFields.push("dimensions");

    if (missingFields.length > 0) {
      const errorMsg =
        `Embedding provider 'qclaw' requires 'proxyUrl', 'baseUrl', 'apiKey', 'model', and 'dimensions' to be set. ` +
        `Missing: ${missingFields.join(", ")}. Embedding has been disabled.`;
      embeddingConfigError = errorMsg;
      embeddingEnabled = false;
      embeddingProvider = embeddingProviderRaw;
    } else {
      embeddingProvider = embeddingProviderRaw;
    }
  } else {
    // Remote mode — validate all required fields
    const missingFields: string[] = [];
    if (!embeddingApiKey) missingFields.push("apiKey");
    if (!embeddingBaseUrl) missingFields.push("baseUrl");
    if (!embeddingModelRaw) missingFields.push("model");
    if (embeddingDimensionsRaw == null || embeddingDimensionsRaw <= 0) missingFields.push("dimensions");

    if (missingFields.length > 0) {
      // Configuration error: disable embedding and log detailed error
      // This does NOT throw — the plugin continues running without vector search
      const errorMsg =
        `Remote embedding provider '${embeddingProviderRaw}' requires 'apiKey', 'baseUrl', 'model', and 'dimensions' to be set. ` +
        `Missing: ${missingFields.join(", ")}. Embedding has been disabled.`;
      // We store the error message so the caller (index.ts) can log it
      embeddingConfigError = errorMsg;
      embeddingEnabled = false;
      embeddingProvider = embeddingProviderRaw; // preserve original for error context
    } else {
      embeddingProvider = embeddingProviderRaw;
    }
  }

  // When provider="none", dimensions=0 signals VectorStore to skip vec0 table
  // creation entirely (deferred until a real embedding provider is configured).
  // This avoids creating vec0 tables with a placeholder dimension that would
  // mismatch if the user later enables a different-dimensional provider.
  const defaultDimensions =
    embeddingProvider === "none" ? 0 :
    embeddingDimensionsRaw ?? 0;
  const defaultModel = embeddingProvider === "none" ? "" : embeddingModelRaw;

  const cleanTime = normalizeCleanTime(str(captureGroup, "cleanTime")) ?? "03:00";

  // --- BM25 (local @tencentdb-agent-memory/tcvdb-text encoder) ---
  const bm25Group = obj(c, "bm25");

  // --- Store backend ---
  const storeBackendRaw = str(c, "storeBackend") ?? "sqlite";
  const storeBackend: StoreBackend = storeBackendRaw === "tcvdb" ? "tcvdb" : "sqlite";

  // --- TCVDB config ---
  const tcvdbGroup = obj(c, "tcvdb");

  const memoryCleanup: MemoryCleanupConfig = {
    retentionDays,
    enabled: retentionDays != null,
    cleanTime,
  };

  // --- Offload ---
  const offloadGroup = obj(c, "offload");

  // Auto-derive offload serverUrl/apiKey/serviceId from top-level server config
  // when offload client fields are not explicitly set.
  const serverGroup = obj(c, "server");
  const serverUrl = optStr(serverGroup, "url");
  const serverApiKey = optStr(serverGroup, "apiKey");
  const serverInstanceId = optStr(serverGroup, "instanceId");

  const offloadMode: "local" | "backend" | "client" | "collect" = (() => {
    const raw = optStr(offloadGroup, "mode");
    if (raw === "local" || raw === "backend" || raw === "client" || raw === "collect") return raw;
    // Auto-derive: if backendUrl is set → "backend"; if server.url is set → "client"; else "local"
    if (optStr(offloadGroup, "backendUrl")) return "backend";
    if (serverUrl) return "client";
    return "local";
  })();

  const offload: OffloadConfig = {
    enabled: bool(offloadGroup, "enabled") ?? false,
    mode: offloadMode,
    model: optStr(offloadGroup, "model"),
    temperature: num(offloadGroup, "temperature") ?? 0.2,
    stream: bool(offloadGroup, "stream") ?? false,
    forceTriggerThreshold: num(offloadGroup, "forceTriggerThreshold") ?? 4,
    dataDir: optStr(offloadGroup, "dataDir"),
    defaultContextWindow: num(offloadGroup, "defaultContextWindow") ?? 200000,
    maxPairsPerBatch: num(offloadGroup, "maxPairsPerBatch") ?? 20,
    l2NullThreshold: num(offloadGroup, "l2NullThreshold") ?? 4,
    l2TimeoutSeconds: num(offloadGroup, "l2TimeoutSeconds") ?? 300,
    mildOffloadRatio: num(offloadGroup, "mildOffloadRatio") ?? 0.5,
    aggressiveCompressRatio: num(offloadGroup, "aggressiveCompressRatio") ?? 0.85,
    mmdMaxTokenRatio: num(offloadGroup, "mmdMaxTokenRatio") ?? 0.2,
    backendUrl: optStr(offloadGroup, "backendUrl"),
    backendApiKey: optStr(offloadGroup, "backendApiKey"),
    backendTimeoutMs: num(offloadGroup, "backendTimeoutMs") ?? 120000,
    offloadRetentionDays: normalizeOffloadRetentionDays(num(offloadGroup, "offloadRetentionDays") ?? 0),
    logMaxSizeMb: num(offloadGroup, "logMaxSizeMb") ?? 50,
    userId: optStr(offloadGroup, "userId"),
    // Client mode fields — fall back to top-level server config when not explicitly set
    serverUrl: optStr(offloadGroup, "serverUrl") ?? serverUrl,
    apiKey: optStr(offloadGroup, "apiKey") ?? serverApiKey,
    serviceId: optStr(offloadGroup, "serviceId") ?? serverInstanceId,
    compactionRatio: num(offloadGroup, "compactionRatio") ?? 0.5,
    ingestTimeoutMs: num(offloadGroup, "ingestTimeoutMs") ?? 5000,
    compactionTimeoutMs: num(offloadGroup, "compactionTimeoutMs") ?? 30000,
  };

  // --- G/H/I/J 真记忆生命周期 ---
  const linksGroup = obj(c, "links");
  const lifecycleGroup = obj(c, "lifecycle");
  const lifecycleConsolidationGroup = obj(lifecycleGroup, "consolidation");
  const lifecycleEmbedBackfillGroup = obj(lifecycleGroup, "embedBackfill");
  const lifecycleForgettingGroup = obj(lifecycleGroup, "forgetting");
  const searchGroup = obj(c, "search");
  const neighborExpandGroup = obj(searchGroup, "neighborExpand");

  const links: MemoryLinksConfig = {
    enabled: bool(linksGroup, "enabled") ?? true,
    // S1（T9 裁决待办收口）：similar 边最低相似度门槛。缺省 0.3（原 MIN_SIMILAR_STRENGTH）；
    // 数字越界 clamp [0,1]；非法值（非有限数，num() 已滤字符串/null）拒绝回退默认——
    // 与本文件其他数字项的 num() ?? default 惯例一致（可用性优先，不在启动路径抛异常）。
    minSimilarity: (() => {
      const raw = num(linksGroup, "minSimilarity");
      if (raw === undefined || !Number.isFinite(raw)) return 0.3;
      return Math.min(Math.max(raw, 0), 1);
    })(),
  };

  // K 核心记忆写入口信任边界（审计 F2）：slot 白名单 + 长度上限 + 总开关。
  const coreMemoryGroup = obj(c, "coreMemory");
  const coreMemoryAllowedSlots = strArray(coreMemoryGroup, "allowedSlots");
  // B1：价值锚种子（core_values 表空时灌入；单一源落地）。
  const seedValuesRaw = Array.isArray(coreMemoryGroup.seedValues) ? coreMemoryGroup.seedValues : undefined;
  const coreMemorySeedValues = seedValuesRaw?.flatMap((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const label = typeof o.label === "string" ? o.label.trim() : "";
    const weight = typeof o.weight === "number" ? Math.min(Math.max(o.weight, 0), 1) : NaN;
    if (!id || !label || !Number.isFinite(weight)) return [];
    return [{ id, label, weight, createdBy: typeof o.createdBy === "string" ? o.createdBy : "config-seed" }];
  });
  const coreMemory: MemoryCoreMemoryConfig = {
    writeEnabled: bool(coreMemoryGroup, "writeEnabled") ?? true,
    // K 设计 §2 默认三槽；空数组=拒绝全部（宁缺毋滥）
    // P1（DS-SOUL-MEMORY-002）：+self_identity（agent 自我层）。信任边界扩展无害——
    // 实际写入仍由 selfIdentity.enabled 门控；显式配置 allowedSlots 时不注入（用户白名单权威）。
    allowedSlots: coreMemoryAllowedSlots ?? ["identity", "core_value", "strict_rule", "self_identity"],
    maxContentLength: num(coreMemoryGroup, "maxContentLength") ?? 2000,
    seedValues: coreMemorySeedValues ?? [],
    // GROW（价值锚自生长）：解析+clamp+默认。clamp 上界防配置手滑（宁缺毋滥）；
    // enabled 缺省 true（与 lifecycle/consolidation/forgetting 同款"缺省开"）。
    anchorDiscovery: (() => {
      const g = obj(coreMemoryGroup, "anchorDiscovery");
      const clamp = (key: string, dflt: number, lo: number, hi: number) => {
        const raw = num(g, key);
        if (raw === undefined || !Number.isFinite(raw)) return dflt;
        return Math.min(hi, Math.max(lo, Math.floor(raw)));
      };
      const pg = obj(g, "person");
      const clampP = (key: string, dflt: number, lo: number, hi: number) => {
        const rawP = num(pg, key);
        if (rawP === undefined || !Number.isFinite(rawP)) return dflt;
        return Math.min(hi, Math.max(lo, Math.floor(rawP)));
      };
      return {
        enabled: bool(g, "enabled") ?? true,
        minEvidence: clamp("minEvidence", 5, 1, 50),
        maxPerPass: clamp("maxPerPass", 2, 1, 10),
        maxTotal: clamp("maxTotal", 15, 1, 100),
        // #94（拍板①）：total=总预算口径（缺省，拍板即行为）；auto=旧口径回滚档。
        quotaScope: str(g, "quotaScope") === "auto" ? ("auto" as const) : ("total" as const),
        intervalHours: clamp("intervalHours", 24, 1, 24 * 30),
        maintainIntervalHours: clamp("maintainIntervalHours", 6, 0, 24 * 7),
        person: {
          enabled: bool(pg, "enabled") ?? false,
          minEvidence: clampP("minEvidence", 5, 1, 50),
          maxPerPass: clampP("maxPerPass", 1, 1, 5),
          maxTotal: clampP("maxTotal", 8, 1, 50),
        },
        identityMaintain: {
          enabled: bool(obj(g, "identityMaintain"), "enabled") ?? false,
        },
        similarMerge: (() => {
          const sg = obj(g, "similarMerge");
          const rawTh = num(sg, "threshold");
          return {
            enabled: bool(sg, "enabled") ?? false,
            // G-SIMMERGE bigram Jaccard 阈值：0.2~0.95 clamp（过低误并无关锚、过高形同虚设）。
            threshold: rawTh !== undefined && Number.isFinite(rawTh) ? Math.min(0.95, Math.max(0.2, rawTh)) : 0.5,
          };
        })(),
        character: (() => {
          const cg = obj(g, "character");
          const clampC = (key: string, dflt: number, lo: number, hi: number) => {
            const rawC = num(cg, key);
            if (rawC === undefined || !Number.isFinite(rawC)) return dflt;
            return Math.min(hi, Math.max(lo, Math.floor(rawC)));
          };
          return {
            enabled: bool(cg, "enabled") ?? false,
            minEvidence: clampC("minEvidence", 2, 1, 50),
            maxPerPass: clampC("maxPerPass", 1, 1, 5),
            maxTotal: clampC("maxTotal", 8, 1, 50),
          };
        })(),
        // #19 T12：rejected 域证据升级重提通道（缺省 false=V12-REPRO 逐位现状；config-first）。
        reproposal: (() => {
          const rg = obj(g, "reproposal");
          const clampR = (key: string, dflt: number, lo: number, hi: number) => {
            const rawR = num(rg, key);
            if (rawR === undefined || !Number.isFinite(rawR)) return dflt;
            return Math.min(hi, Math.max(lo, Math.floor(rawR)));
          };
          return {
            enabled: bool(rg, "enabled") ?? false,
            minEvidenceMultiple: clampR("minEvidenceMultiple", 2, 1, 10),
            maxPerPass: clampR("maxPerPass", 2, 1, 5),
            maxRejectsBeforeCold: clampR("maxRejectsBeforeCold", 2, 1, 10),
          };
        })(),
        // #11 T5：desc 维护环（缺省 false=逐位现状；evidenceMultiple=≥N× 基线触发）。
        descRefresh: (() => {
          const dg = obj(g, "descRefresh");
          const clampD = (key: string, dflt: number, lo: number, hi: number) => {
            const rawD = num(dg, key);
            if (rawD === undefined || !Number.isFinite(rawD)) return dflt;
            return Math.min(hi, Math.max(lo, Math.floor(rawD)));
          };
          return {
            enabled: bool(dg, "enabled") ?? false,
            evidenceMultiple: clampD("evidenceMultiple", 2, 1, 10),
            maxPerPass: clampD("maxPerPass", 2, 1, 5),
          };
        })(),
      };
    })(),
        // S-CHAR-2（M2/P3）：品格张力检测（enabled 缺省 false=逐位现状；clamp 同族防手滑）。
        characterTension: (() => {
          const ct = obj(coreMemoryGroup, "characterTension");
          const clampT = (key: string, dflt: number, lo: number, hi: number) => {
            const rawT = num(ct, key);
            if (rawT === undefined || !Number.isFinite(rawT)) return dflt;
            return Math.min(hi, Math.max(lo, Math.floor(rawT)));
          };
          return {
            enabled: bool(ct, "enabled") ?? false,
            minInstances: clampT("minInstances", 2, 1, 50),
            maxCandidatesPerPass: clampT("maxCandidatesPerPass", 2, 1, 10),
          };
        })(),
    // DS-SOUL-MEMORY-002 P1：agent 自我层（enabled 缺省 false=逐位现状；yaml 值真实生效+clamp）。
    selfIdentity: (() => {
      const g = obj(coreMemoryGroup, "selfIdentity");
      const clamp = (key: string, dflt: number, lo: number, hi: number) => {
        const raw = num(g, key);
        if (raw === undefined || !Number.isFinite(raw)) return dflt;
        return Math.min(hi, Math.max(lo, Math.floor(raw)));
      };
      return {
        enabled: bool(g, "enabled") ?? false,
        maxPerPass: clamp("maxPerPass", 2, 1, 10),
        intervalHours: clamp("intervalHours", 24, 1, 168),
      };
    })(),
    // S-FEEL-1（M1/DS-SOUL-EVOLUTION-001 §1.4）：近期情绪基调（enabled 缺省 false=逐位现状；
    // 红线 R-A：mood 不参与召回排序）。阈值 clamp 到 [-1,1] 合法域，窗口/样本数 clamp 防手滑。
    moodLine: (() => {
      const g = obj(coreMemoryGroup, "moodLine");
      const clampM = (key: string, dflt: number, lo: number, hi: number) => {
      const raw = num(g, key);
      if (raw === undefined || !Number.isFinite(raw)) return dflt;
      return Math.min(hi, Math.max(lo, raw));
      };
      return {
        enabled: bool(g, "enabled") ?? false,
        windowHours: clampM("windowHours", 72, 1, 24 * 30),
        maxSamples: Math.floor(clampM("maxSamples", 20, 1, 200)),
        minSamples: Math.floor(clampM("minSamples", 5, 1, 100)),
        posThreshold: clampM("posThreshold", 0.15, -1, 1),
        negThreshold: clampM("negThreshold", -0.15, -1, 1),
        halfLifeHours: clampM("halfLifeHours", 48, 0.5, 24 * 30),
      };
    })(),
    // F17 段级注入预算（chars 为 token 粗粒度近似；超限截断，宁缺毋滥）。
    soulRender: (() => {
      const g = obj(coreMemoryGroup, "soulRender");
      const clamp = (key: string, dflt: number, lo: number, hi: number) => {
        const raw = num(g, key);
        if (raw === undefined || !Number.isFinite(raw)) return dflt;
        return Math.min(hi, Math.max(lo, Math.floor(raw)));
      };
      return {
        budgetSelfChars: clamp("budgetSelfChars", 600, 100, 2000),
        budgetIdentityChars: clamp("budgetIdentityChars", 900, 100, 2000),
        maxRelationLines: clamp("maxRelationLines", 5, 1, 20),
        // #10 T4：三行锚列表预算（0=关=缺省逐位现状；clamp 上界防手滑写爆）
        budgetAnchorChars: clamp("budgetAnchorChars", 0, 0, 4000),
        budgetPersonChars: clamp("budgetPersonChars", 0, 0, 4000),
        budgetCharacterChars: clamp("budgetCharacterChars", 0, 0, 4000),
        // #30（R5-F1 接线）：快照旁路开关——缺省 true=随新功能上线；显式 false 才关闭。
        snapshotsEnabled: (g as Record<string, unknown>)["snapshotsEnabled"] === undefined
          ? true
          : (g as Record<string, unknown>)["snapshotsEnabled"] === true,
        // #52 D3（双通道 slots 去重）：per-turn 身份两行省略门——缺省 true=逐位现状；
        // 显式 false 才跳过（我是谁）/（我心中的他）slots 行（非布尔值回退缺省，
        // snapshotsEnabled ===true 解析先例）。
        perTurnSlots: (g as Record<string, unknown>)["perTurnSlots"] === undefined
          ? true
          : (g as Record<string, unknown>)["perTurnSlots"] === true,
        // #67（R3 身份叙事层）：身份叙事化门——缺省 false=逐位现状；显式 true 才开启
        //（非布尔值回退缺省，沿 perTurnSlots/snapshotsEnabled 解析先例：形状错不炸配置）。
        identityNarrative: {
          enabled: ((g as Record<string, unknown>)["identityNarrative"] as Record<string, unknown> | undefined)?.["enabled"] === true,
        },
        // #29（R5）：情境锚选择门——缺省 999=现状全注入（当前锚基数个位数，无收益不启动）；
        // clamp 1..999 防手滑 0/负数。#42（票 D / D9）：scorer 门——enabled 缺省 false（shadow）；
        // threshold clamp 0..1 缺省 0；形状错一律回退缺省（宁缺毋滥，沿 capabilities 解析先例）。
        anchorSelect: {
          maxRows: (() => {
            const v = ((g as Record<string, unknown>)["anchorSelect"] as Record<string, unknown> | undefined)?.["maxRows"];
            return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(Math.floor(v), 999)) : 999;
          })(),
          scorer: (() => {
            const s = ((g as Record<string, unknown>)["anchorSelect"] as Record<string, unknown> | undefined)?.["scorer"] as
              | Record<string, unknown>
              | undefined;
            const en = s?.["enabled"];
            const th = s?.["threshold"];
            const ml = s?.["mmrLambda"];
            const eb = s?.["embedBudgetMs"];
            return {
              enabled: en === undefined ? false : en === true,
              threshold: typeof th === "number" && Number.isFinite(th) ? Math.max(0, Math.min(th, 1)) : 0,
              mmrLambda: typeof ml === "number" && Number.isFinite(ml) ? Math.max(0, Math.min(ml, 1)) : 0.7,
              embedBudgetMs: typeof eb === "number" && Number.isFinite(eb) ? Math.max(0, Math.floor(eb)) : 1200,
            };
          })(),
          // T4（方案 Task 4，2026-10-17）：shadow 定标落盘门——缺省关（零写盘零采集）；
          // enabled 仅布尔 true 采纳；file 仅非空 string 采纳，否则缺省
          // data/logs/soul-anchor-shadow.jsonl（reflection shadow sink 同路径惯例）。
          shadowSink: (() => {
            const s = ((g as Record<string, unknown>)["anchorSelect"] as Record<string, unknown> | undefined)?.["shadowSink"] as
              | Record<string, unknown>
              | undefined;
            const f = s?.["file"];
            return {
              enabled: s?.["enabled"] === true,
              file: typeof f === "string" && f.trim() !== "" ? f : "data/logs/soul-anchor-shadow.jsonl",
            };
          })(),
        },
        // soul 去重门（soul-dedupe，2026-10-19）：enabled 缺省 false=逐位现状；
        // jaccardThreshold clamp 0..1 缺省 0.45（soul-dedupe.ts 标定值）；
        // maxLines clamp 0..50 缺省 0=关（红线段行数上限，生产红线墙治理）；
        // suppressAnchorOverlap 缺省 false（价值锚 desc vs 红线行跨段抑制）；
        // anchorDedup.embeddingThreshold clamp 0..1 缺省 0=关（embedding 语义近重复去重）。
        // 形状错一律回退缺省（宁缺毋滥，沿 anchorSelect.scorer 解析先例）。
        strictRuleDedup: (() => {
          const s = (g as Record<string, unknown>)["strictRuleDedup"] as Record<string, unknown> | undefined;
          const th = s?.["jaccardThreshold"];
          const ml = s?.["maxLines"];
          return {
            enabled: s?.["enabled"] === true,
            jaccardThreshold: typeof th === "number" && Number.isFinite(th) ? Math.max(0, Math.min(th, 1)) : 0.45,
            maxLines: typeof ml === "number" && Number.isFinite(ml) ? Math.max(0, Math.min(Math.floor(ml), 50)) : 0,
            suppressAnchorOverlap: s?.["suppressAnchorOverlap"] === true,
          };
        })(),
        anchorDedup: (() => {
          const s = (g as Record<string, unknown>)["anchorDedup"] as Record<string, unknown> | undefined;
          const th = s?.["embeddingThreshold"];
          return {
            enabled: s?.["enabled"] === true,
            embeddingThreshold: typeof th === "number" && Number.isFinite(th) ? Math.max(0, Math.min(th, 1)) : 0,
          };
        })(),
        // #36（R5）：soul_introspect 自省面参数（只读；快照条数 1..200 缺省 20，证据窗 1..2160h 缺省 168）。
        introspect: {
          snapshotLimit: (() => {
            const v = ((g as Record<string, unknown>)["introspect"] as Record<string, unknown> | undefined)?.["snapshotLimit"];
            return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(Math.floor(v), 200)) : 20;
          })(),
          evidenceWindowHours: (() => {
            const v = ((g as Record<string, unknown>)["introspect"] as Record<string, unknown> | undefined)?.["evidenceWindowHours"];
            return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(Math.floor(v), 2160)) : 168;
          })(),
        },
        // #40（ADR0003-P3 接线票 B）：capabilities 渲染门——缺省 false=逐位现状；
        // 非布尔/形状错一律回退 false（宁缺毋滥）。
        capabilities: {
          enabled: ((g as Record<string, unknown>)["capabilities"] as Record<string, unknown> | undefined)?.["enabled"] === true,
        },
        // #41（ADR0003-P3 实施票 C，D8 证据门）：promise 证据迁移总开关——缺省 false=
        // 逐位现状；非布尔/形状错一律回退 false（宁缺毋滥，沿 capabilities 解析先例）。
        promiseEvidence: {
          enabled: ((g as Record<string, unknown>)["promiseEvidence"] as Record<string, unknown> | undefined)?.["enabled"] === true,
        },
        // T3（未来性渲染面，T6-F1 接线 2026-10-17）：承诺块渲染门——缺省 false=逐位现状；
        // 非布尔/形状错一律回退 false（宁缺毋滥，沿 promiseEvidence 解析先例）。
        promises: {
          enabled: ((g as Record<string, unknown>)["promises"] as Record<string, unknown> | undefined)?.["enabled"] === true,
        },
      };
    })(),
  };

  const lifecycle: MemoryLifecycleConfig = {
    enabled: bool(lifecycleGroup, "enabled") ?? true,
    intervalMs: num(lifecycleGroup, "intervalMs") ?? 600_000,
    // P2-T14（H-B2）：租户 filter 显式解析（参照 links 的解析模式）。
    // 全部字段缺省 → undefined（不传 = 兼容单机），任一非空才生成对象。
    filter: (() => {
      const filterGroup = obj(lifecycleGroup, "filter");
      const parsed = {
        teamId: str(filterGroup, "teamId"),
        userId: str(filterGroup, "userId"),
        agentId: str(filterGroup, "agentId"),
        taskId: str(filterGroup, "taskId"),
      };
      return Object.values(parsed).some((v) => v !== undefined) ? parsed : undefined;
    })(),
    embedBackfill: {
      // EMBED-BACKFILL R2（09-27 根治）：向量缺口补偿器——生命周期产物（reflection/
      // consolidation/evolution 结构性不传 embedding）与主链 embed 失败遗留的
      // metadata-only 行周期补嵌。缺省开。
      enabled: bool(lifecycleEmbedBackfillGroup, "enabled") ?? true,
      intervalMinutes: num(lifecycleEmbedBackfillGroup, "intervalMinutes") ?? 30,
      batchLimit: num(lifecycleEmbedBackfillGroup, "batchLimit") ?? 50,
    },
    consolidation: {
      enabled: bool(lifecycleConsolidationGroup, "enabled") ?? true,
      persist: bool(lifecycleConsolidationGroup, "persist") ?? true,
      minCount: num(lifecycleConsolidationGroup, "minCount") ?? 3,
      minSpanDays: num(lifecycleConsolidationGroup, "minSpanDays") ?? 1,
      // P3-T17（H1，拍板④）：subject 归组策略门（默认 llm；非法值忽略走默认）。
      subjectStrategy: (() => {
        const v = str(lifecycleConsolidationGroup, "subjectStrategy");
        return v === "llm" || v === "lexical" ? v : undefined;
      })(),
    },
    forgetting: {
      enabled: bool(lifecycleForgettingGroup, "enabled") ?? true,
      lambda: num(lifecycleForgettingGroup, "lambda") ?? 0.01,
      arousalRetention: Math.min(0.9, Math.max(0, num(lifecycleForgettingGroup, "arousalRetention") ?? 0)),
      // D-3（2026-09-21）：敏感性遗忘偏置——敏感记忆（≠none）整体分值 ×(1-bias)，更早归档。缺省 0=逐位现状。
      sensitivityBias: Math.min(1, Math.max(0, num(lifecycleForgettingGroup, "sensitivityBias") ?? 0)),
      lowThreshold: num(lifecycleForgettingGroup, "lowThreshold") ?? 0.12,
      minAgeDays: num(lifecycleForgettingGroup, "minAgeDays") ?? 30,
      // P2（F14）：refs 遗忘保护开关（缺省 false=逐位现状）
      refProtection: bool(lifecycleForgettingGroup, "refProtection") ?? false,
      recurrenceProtection: bool(lifecycleForgettingGroup, "recurrenceProtection") ?? false,
    },
    // P3-F13：反思触发（Generative Agents 对标；enabled 缺省 false=逐位现状）
    reflection: {
      enabled: bool(obj(lifecycleGroup, "reflection"), "enabled") ?? false,
      // F-EV12-4（REG-REMAINING-006 A-4）：下限 10→1——yaml rRef: 2（2.0≈3 条高显著）
      // 曾被旧下限 10 静默钳到 10（配置值与生效值背离）。significance [0,1] 刻度下 1~2 均为合法意图值。
      rRef: Math.min(100000, Math.max(1, Math.floor(num(obj(lifecycleGroup, "reflection"), "rRef") ?? 150))),
      // #27（R5）：memory.lifecycle.reflection.soulProposals.enabled；缺省 false=零提案=逐位现状
      // #ε-定标（ADR0003 D7）：shadowCalibration.shadow（旁路 JSONL 采集）缺省 false=零旁路
      soulProposals: (() => {
        const soulProposalsGroup = obj(obj(lifecycleGroup, "reflection"), "soulProposals");
        const shadowGroup = obj(soulProposalsGroup, "shadowCalibration");
        const shadowEnabled = bool(shadowGroup, "enabled");
        const shadowFile = str(shadowGroup, "file");
        // #60（S22，2026-10-18）：cardContract 条件材料化——对象且 enabled===true 才带键
        // （显式关/非对象/缺键 = 不带键 = 缺省 off 逐位现状）。
        const cardContractGroup = obj(soulProposalsGroup, "cardContract");
        const cardContractEnabled = bool(cardContractGroup, "enabled");
        // #77 Batch D（survey F1）：conclusionContract 条件材料化——同 cardContract 形态。
        const conclusionContractGroup = obj(soulProposalsGroup, "conclusionContract");
        const conclusionContractEnabled = bool(conclusionContractGroup, "enabled");
        return {
          enabled: bool(soulProposalsGroup, "enabled") ?? false,
          ...(shadowEnabled === undefined && shadowFile === undefined
            ? {}
            : {
                shadowCalibration: {
                  ...(shadowEnabled === undefined ? {} : { enabled: shadowEnabled }),
                  ...(shadowFile === undefined ? {} : { file: shadowFile }),
                },
              }),
          ...(cardContractEnabled === true ? { cardContract: { enabled: true } } : {}),
          ...(conclusionContractEnabled === true ? { conclusionContract: { enabled: true } } : {}),
        };
      })(),
      // #44（D8-(c)）：memory.lifecycle.reflection.promiseProposals.enabled；缺省 false=零提案=逐位现状
      promiseProposals: { enabled: bool(obj(obj(lifecycleGroup, "reflection"), "promiseProposals"), "enabled") ?? false },
      // #81/#91：self_identity 提案相似门——条件材料化（FLOW-E「不接线即死配置」修复，2026-10-24 实证
      // yaml 写了 selfIdentityGate 但 parse 白名单剥离 → recOn 恒 false → #91 机制生产全旁路）。
      // 语义：yaml 显式写的键才带（undefined 省略=消费侧缺省逐位）；整键未写=undefined=现状。
      selfIdentityGate: (() => {
        const sigGroup = obj(obj(lifecycleGroup, "reflection"), "selfIdentityGate");
        const sigEnabled = bool(sigGroup, "enabled");
        const threshold = num(sigGroup, "threshold");
        const supGroup = obj(sigGroup, "suppression");
        const supEnabled = bool(supGroup, "enabled");
        const supMax = num(supGroup, "maxPending");
        const recGroup = obj(sigGroup, "recurrence");
        const recEnabled = bool(recGroup, "enabled");
        const recVotes = num(recGroup, "votes");
        const recTtl = num(recGroup, "ttlHours");
        const recSpan = num(recGroup, "spanHours");
        const rec = {
          ...(recEnabled === undefined ? {} : { enabled: recEnabled }),
          ...(recVotes === undefined ? {} : { votes: recVotes }),
          ...(recTtl === undefined ? {} : { ttlHours: recTtl }),
          ...(recSpan === undefined ? {} : { spanHours: recSpan }),
        };
        const hasRec = Object.keys(rec).length > 0;
        // #91 K 阀（2026-10-24）：rateLimit 子键条件材料化（同 recurrence 形态；不写=不带键=缺省 off 逐位）。
        const rlGroup = obj(sigGroup, "rateLimit");
        const rlEnabled = bool(rlGroup, "enabled");
        const rlMax = num(rlGroup, "maxNew");
        const rlWin = num(rlGroup, "windowHours");
        const rl = {
          ...(rlEnabled === undefined ? {} : { enabled: rlEnabled }),
          ...(rlMax === undefined ? {} : { maxNew: rlMax }),
          ...(rlWin === undefined ? {} : { windowHours: rlWin }),
        };
        const hasRl = Object.keys(rl).length > 0;
        // #92 stage 2（2026-10-25 拍板四项）：autoAdopt 子键条件材料化（同 rateLimit 形态；不写=不带键=缺省 off 逐位）。
        const aaGroup = obj(sigGroup, "autoAdopt");
        const aaEnabled = bool(aaGroup, "enabled");
        const aaVotes = num(aaGroup, "votes");
        const aaSpan = num(aaGroup, "spanHours");
        const aaContra = num(aaGroup, "contradictionThreshold");
        const aaDup = num(aaGroup, "dupThreshold");
        const aa = {
          ...(aaEnabled === undefined ? {} : { enabled: aaEnabled }),
          ...(aaVotes === undefined ? {} : { votes: aaVotes }),
          ...(aaSpan === undefined ? {} : { spanHours: aaSpan }),
          ...(aaContra === undefined ? {} : { contradictionThreshold: aaContra }),
          ...(aaDup === undefined ? {} : { dupThreshold: aaDup }),
        };
        const hasAa = Object.keys(aa).length > 0;
        if (sigEnabled === undefined && threshold === undefined && supEnabled === undefined && supMax === undefined && !hasRec && !hasRl && !hasAa) {
          return undefined;
        }
        return {
          ...(sigEnabled === undefined ? {} : { enabled: sigEnabled }),
          ...(threshold === undefined ? {} : { threshold }),
          ...(supEnabled === undefined && supMax === undefined
            ? {}
            : { suppression: { ...(supEnabled === undefined ? {} : { enabled: supEnabled }), ...(supMax === undefined ? {} : { maxPending: supMax }) } }),
          ...(hasRec ? { recurrence: rec } : {}),
          ...(hasRl ? { rateLimit: rl } : {}),
          ...(hasAa ? { autoAdopt: aa } : {}),
        };
      })(),
    },
  };

  // --- P4b 受控正文演化（GROW-EVO §4.4；config-first：enabled 缺省 false = 逐位现状） ---
  const evolutionGroup = obj(c, "evolution");
  const evolution: MemoryEvolutionConfig = {
    enabled: bool(evolutionGroup, "enabled") ?? false,
    maxRewrites: Math.min(20, Math.max(1, Math.floor(num(evolutionGroup, "maxRewrites") ?? 3))),
    intervalMs: Math.max(60_000, num(evolutionGroup, "intervalMs") ?? 3_600_000),
  };

  const search: MemoryTdaiConfig["search"] = {
    neighborExpand: {
      enabled: bool(neighborExpandGroup, "enabled") ?? false,
      maxHop: num(neighborExpandGroup, "maxHop") ?? 1,
      maxAdd: num(neighborExpandGroup, "maxAdd") ?? 3,
    },
  };

  // 场景块治理（DS-SCENE-GOV-001，Task GOV-1）：仿 conclusionLayer 的解析+clamp+默认模式。
  // 铁律：enabled 缺省 false = 生产行为零变化；仅 yaml 显式开启后治理链路才介入。
  const sceneGovernanceGroup = obj(c, "sceneGovernance");
  const sceneGovernance: SceneGovernanceConfig = (() => {
    const g = sceneGovernanceGroup;
    // clampRange：缺省/非有限数 → 默认值；区间外 clamp（可用性优先，不在启动路径抛异常）。
    const clampRange = (key: string, dflt: number, lo: number, hi: number): number => {
      const raw = num(g, key);
      if (raw === undefined || !Number.isFinite(raw)) return dflt;
      return Math.min(hi, Math.max(lo, raw));
    };
    const maxBlockChars = clampRange("maxBlockChars", 8000, 500, 100_000);
    return {
      enabled: bool(g, "enabled") ?? false,
      maxBlockChars,
      distillTimeoutMs: Math.max(0, num(g, "distillTimeoutMs") ?? 60_000),
      // 兜底硬截断上限不得低于蒸馏阈值：传入更小值抬到 maxBlockChars
      //（否则蒸馏产出恒"超限"进入兜底，语义自毁；负值同理被抬到下限）。
      hardCapChars: Math.max(maxBlockChars, num(g, "hardCapChars") ?? 20_000),
    };
  })();

  return {
    promptMode: globalPromptMode,
    capture: {
      enabled: bool(captureGroup, "enabled") ?? true,
      excludeAgents: strArray(captureGroup, "excludeAgents") ?? [],
      l0l1RetentionDays: retentionDays ?? 0,
      allowAggressiveCleanup,
    },
    extraction: {
      enabled: bool(extractionGroup, "enabled") ?? true,
      enableDedup: bool(extractionGroup, "enableDedup") ?? true,
      maxMemoriesPerSession: num(extractionGroup, "maxMemoriesPerSession") ?? 20,
      // GROW-EVO P2（§2.2）：durative 效期提取开关（缺省 false = 逐位现状）
      durativeEnabled: bool(extractionGroup, "durativeEnabled") ?? false,
      // D-4：周期性事实提取块门（RECURRENCE_BLOCK；缺省 false = 逐位现状）
      recurrenceEnabled: bool(extractionGroup, "recurrenceEnabled") ?? false,
      model: optStr(extractionGroup, "model"),
      promptMode: normalizePromptMode(str(extractionGroup, "promptMode"), globalPromptMode),
      // 毒批超时（L1-OUTAGE-20261015）：缺省 300_000=逐位现状；clamp 60s..1h
      extractionTimeoutMs: Math.min(
        3_600_000,
        Math.max(60_000, num(extractionGroup, "extractionTimeoutMs") ?? 300_000),
      ),
      // #79 dedup 判重超时（config-first）：缺省 300_000=逐位现状；clamp 60s..1h（镜像 extractionTimeoutMs）
      dedupTimeoutMs: Math.min(
        3_600_000,
        Math.max(60_000, num(extractionGroup, "dedupTimeoutMs") ?? 300_000),
      ),
      // #46 毒批拆分+批次上限（config-first）：缺省关=逐位现状
      scenePoisonSplit: bool(extractionGroup, "scenePoisonSplit") ?? false,
      sceneBatchMaxChars: Math.max(0, num(extractionGroup, "sceneBatchMaxChars") ?? 0),
    },
    persona: {
      triggerEveryN: num(personaGroup, "triggerEveryN") ?? 50,
      maxScenes: num(personaGroup, "maxScenes") ?? 15,
      backupCount: num(personaGroup, "backupCount") ?? 3,
      sceneBackupCount: num(personaGroup, "sceneBackupCount") ?? 10,
      model: optStr(personaGroup, "model"),
      promptMode: normalizePromptMode(str(personaGroup, "promptMode"), globalPromptMode),
      // R4：逐调用思考开关（缺省 undefined=端点默认；"none"=关深度思考）
      reasoningEffort: optStr(personaGroup, "reasoningEffort"),
    },
    pipeline: {
      everyNConversations: num(pipelineGroup, "everyNConversations") ?? 5,
      enableWarmup: bool(pipelineGroup, "enableWarmup") ?? true,
      l1IdleTimeoutSeconds: num(pipelineGroup, "l1IdleTimeoutSeconds") ?? 600,
      l2DelayAfterL1Seconds: num(pipelineGroup, "l2DelayAfterL1Seconds") ?? 10,
      l2MinIntervalSeconds: num(pipelineGroup, "l2MinIntervalSeconds") ?? 900,
      l2MaxIntervalSeconds: num(pipelineGroup, "l2MaxIntervalSeconds") ?? 3600,
      sessionActiveWindowHours: num(pipelineGroup, "sessionActiveWindowHours") ?? 24,
    },
    recall: {
      enabled: bool(recallGroup, "enabled") ?? true,
      maxResults: num(recallGroup, "maxResults") ?? 5,
      maxCharsPerMemory: num(recallGroup, "maxCharsPerMemory") ?? 0,
      maxTotalRecallChars: num(recallGroup, "maxTotalRecallChars") ?? 0,
      scoreThreshold: num(recallGroup, "scoreThreshold") ?? 0.3,
      // P0-2（issue #2）：native RRF 共识门槛（缺省 undefined=关=逐位现状；负值=关）
      nativeMinRRF: num(recallGroup, "nativeMinRRF"),
      strategy: validateStrategy(str(recallGroup, "strategy")) ?? "hybrid",
      timeoutMs: num(recallGroup, "timeoutMs") ?? 5000,
      // C1：coreRef 排序加成（默认 0.05；0=关；负值 clamp 0——可用性优先，
      // 与 links.minSimilarity 的"拒绝非法回退默认"惯例同款，不在启动路径抛异常）。
      coreRefBoost: (() => {
        const raw = num(recallGroup, "coreRefBoost");
        if (raw === undefined || !Number.isFinite(raw)) return 0.05;
        return Math.max(raw, 0);
      })(),
      // R-A1（结构感知召回 spec §2）：排序层结构信号六开关（沿 C1 clamp 模式；
      // inferredPenalty 上界 1 防负 rankKey）。全 0 = 与基线排序逐位一致（关断矩阵）。
      timeBoost: recallSignalBoost(recallGroup, "timeBoost", 0.05),
      recencyBoost: recallSignalBoost(recallGroup, "recencyBoost", 0.03),
      sigWeight: recallSignalBoost(recallGroup, "sigWeight", 0.03),
      inferredPenalty: recallSignalBoost(recallGroup, "inferredPenalty", 0.1, 1),
      // D-3（2026-09-21）：敏感性召回降权乘子（R11）——缺省 0=关断恒等（逐位现状）。
      sensitivityPenalty: recallSignalBoost(recallGroup, "sensitivityPenalty", 0, 1),
      // P1-T7（worthiness importance，spec §6）：importance 降权嵌套组（queryExpansion IIFE 先例）。
      // 缺省 enabled false = 零行为变化；开启即真实降权（shadowMode 已按用户 2026-10-14 拍板移除）。
      importancePenalty: (() => {
        const ip = obj(recallGroup, "importancePenalty");
        return {
          enabled: bool(ip, "enabled") ?? false,
          penalty: recallSignalBoost(ip, "penalty", 0.3, 0.9),
        };
      })(),
      reinforcementWeight: recallSignalBoost(recallGroup, "reinforcementWeight", 0.03),
      moodBoost: recallSignalBoost(recallGroup, "moodBoost", 0),
      // R-A2（spec §2 R4/R6）：候选池通道开关（clamp 模式；graph 两旋钮为比值 clamp [0,1]）
      graphMinStrength: recallSignalBoost(recallGroup, "graphMinStrength", 0.5, 1),
      graphDiscount: recallSignalBoost(recallGroup, "graphDiscount", 0.6, 1),
      sceneBoost: recallSignalBoost(recallGroup, "sceneBoost", 0.04),
      // R-A3（性能速赢 E1/E2/E3）：TTL 缓存开关（毫秒，缺省默认开；<=0 = 关；负值 clamp 0）
      queryEmbeddingCacheTtlMs: recallSignalBoost(recallGroup, "queryEmbeddingCacheTtlMs", 60_000),
      valuesCacheTtlMs: recallSignalBoost(recallGroup, "valuesCacheTtlMs", 60_000),
      // GROW-EVO P2（§2.3）：失效排除总开关（缺省 true = spec 拍板①）
      excludeInvalidated: bool(recallGroup, "excludeInvalidated") ?? true,
      // GROW-EVO P3 R10（§3.2）：情感显著度权重（缺省 0 = 恒等；实验轨）
      emotionSalienceWeight: Math.max(0, num(recallGroup, "emotionSalienceWeight") ?? 0),
      sessionReuseTtlMs: recallSignalBoost(recallGroup, "sessionReuseTtlMs", 300_000),
      // V2-1（引擎二 PPR spec E2.1）：PPR 三旋钮（recallSignalBoost clamp 模式，0 可设）。
      // damping 比值 clamp [0,1]（0 = 图通道退化关断）；topK/iterations 取整，topK 0 = 零图候选。
      pprDamping: recallSignalBoost(recallGroup, "pprDamping", 0.85, 1),
      pprTopK: Math.floor(recallSignalBoost(recallGroup, "pprTopK", 10, 100)),
      pprIterations: Math.max(1, Math.floor(recallSignalBoost(recallGroup, "pprIterations", 30, 100))),
      // V2-2（引擎一 spec E1.1）：查询自动扩展（E1.1 默认 true / maxTerms 8 / ttl 10min / timeout 8s）
      // 2026-10-19 热路径改造：hotPathTimeoutMs（hybrid-fallback 扩展等待帽，0=旧行为全额等待，
      // 缺省 1500）+ negativeTtlMs（失败负缓存，0=关，缺省 30000）——journal 实证 expand
      // 顶满 4s clamp 连环黑洞治理（LLM RTT 实测 2.2-2.4s 超热路预算）。
      queryExpansion: (() => {
        const qe = obj(recallGroup, "queryExpansion");
        return {
          enabled: bool(qe, "enabled") ?? true,
          maxTerms: Math.max(1, Math.floor(recallSignalBoost(qe, "maxTerms", 8, 32))),
          ttlMs: recallSignalBoost(qe, "ttlMs", 600_000),
          timeoutMs: Math.max(1000, recallSignalBoost(qe, "timeoutMs", 8000)),
          hotPathTimeoutMs: Math.max(0, Math.floor(recallSignalBoost(qe, "hotPathTimeoutMs", 1500))),
          negativeTtlMs: Math.max(0, Math.floor(recallSignalBoost(qe, "negativeTtlMs", 30_000))),
        };
      })(),
      // V2-3（引擎三 E3.1/E3.2）注意力平衡旋钮（默认开）+ RV2-2 精排重设计（相关度主导）
      exploreSlot: bool(recallGroup, "exploreSlot") ?? true,
      conclusionRelaxedForAnalytical: bool(recallGroup, "conclusionRelaxedForAnalytical") ?? true,
      // Batch C C-b（#77 伴生 · survey F6b）：检索期重算衰减乘子（缺省关=逐位现状；
      // halfLifeDays 非有限/负 → 30 缺省，正值 floor）
      ageDecay: (() => {
        const ad = obj(recallGroup, "ageDecay");
        // ?? NaN：num() 返回 number|undefined 而 Number.isFinite 无 type predicate（TS18048/TS2345）；NaN → 30 缺省，行为不变
        const hl = num(ad, "halfLifeDays") ?? NaN;
        return {
          enabled: bool(ad, "enabled") ?? false,
          halfLifeDays: Number.isFinite(hl) && hl > 0 ? Math.floor(hl) : 30,
        };
      })(),
      timeProxFallbackEnabled: bool(recallGroup, "timeProxFallbackEnabled") ?? false,
      // F-CLUSTER v2：召回折叠总开关（缺省 false = 现行为）。类型声明 config.ts:100
      // 自 09-26 存在，但逐键装载遗漏 → yaml true 装不进运行时（2026-09-30 实锤 fcVal=undefined）。
      foldClusterEnabled: bool(recallGroup, "foldClusterEnabled") ?? false,
      // Task CAL C1：结论层注入前截断（默认 2000，0=不截断；负值/非有限沿 recallSignalBoost clamp 模式）
      // 审查修补 I①：enabled 总开关（缺省 true=现行为）；I③：cacheTtlMs 独立 TTL
      // （缺省 undefined → 运行期回落 sessionReuseTtlMs；显式 0=关；负值 clamp 0）
      conclusionLayer: (() => {
        const cl = obj(recallGroup, "conclusionLayer");
        return {
          enabled: bool(cl, "enabled") ?? true,
          maxCharsPerMemory: recallSignalBoost(cl, "maxCharsPerMemory", 2000),
          // Batch B F2（2026-10-20）：截断模式（"chars"=码点中句现状 | "sentences"=句界；
          // 缺省/非法回落 "chars"=逐位现状）与结论层总预算（缺省 undefined=关；
          // 负/非有限→0=关；正数 floor）
          truncateMode: (() => {
            const raw = str(cl, "truncateMode");
            return raw === "sentences" ? "sentences" : "chars";
          })(),
          maxTotalChars: (() => {
            const raw = num(cl, "maxTotalChars");
            return raw === undefined
              ? undefined
              : Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
          })(),
          // v18-c：结论块低密度门阈值（clamp [0,1]；缺省 undefined = 关逐位现状）
          minUniqRatio: (() => {
            const raw = num(cl, "minUniqRatio");
            return raw === undefined ? undefined : Math.min(1, Math.max(0, raw));
          })(),
          // #99 F1（2026-10-25）：textHitMaxTokenRatio 解析退役（键三面退役；历史 yaml 残留
          // 此键被解析器静默忽略——候选集占比自指病灶，见 selectL2Conclusions 处注释）。
          cacheTtlMs: (() => {
            const raw = num(cl, "cacheTtlMs");
            return raw === undefined ? undefined : Math.max(0, Math.floor(raw));
          })(),
          // #53：L2 结论层 textHit IDF 加权排序（缺省 false=逐位现状）
          idfWeighted: bool(cl, "idfWeighted") ?? false,
          // R71-A1（2026-10-19）：work_fact 候选 bm25 预地板（负值 clamp 0=off；缺省 undefined=off；
          // #99 F2 后为 legacy 绝对分口径，minBm25RelRatio 并存时相对门优先）
          minBm25Rel: (() => {
            const raw = num(cl, "minBm25Rel");
            return raw === undefined ? undefined : Math.max(0, raw);
          })(),
          // #99 F2（2026-10-25）：bm25 地板相对化 α（clamp [0,1]；缺省 undefined=off；
          // 门槛 = α×本候选池最大 raw rel，刻度无关免重定标）
          minBm25RelRatio: (() => {
            const raw = num(cl, "minBm25RelRatio");
            return raw === undefined ? undefined : Math.min(1, Math.max(0, raw));
          })(),
          // R71-A2（2026-10-19）：结论层 rerank 门——mode 非法值回落 "shadow"（shadow-first；
          // minScore 非有限回落 undefined=运行期取 -1.0 缺省）
          rerankGate: (() => {
            const rg = obj(cl, "rerankGate");
            if (!rg || Object.keys(rg).length === 0) return undefined; // 缺键=undefined（零配置逐位现状）
            const rawMode = str(rg, "mode");
            const mode = rawMode === "enforce" || rawMode === "off" ? rawMode : "shadow";
            const minScore = num(rg, "minScore");
            return {
              mode,
              ...(minScore !== undefined && Number.isFinite(minScore) ? { minScore } : {}),
            };
          })(),
        };
      })(),
      // #78 R-b：结论卡身世回捞读面开关（代码缺省关=逐位现状；yaml 显式开——#77 三键同款）。
      // maxExtraLines 缺省 2；负值 clamp 0（=关）；非数字/非有限（num()→undefined）回落缺省 2。
      smallToBig: (() => {
        const sb = obj(recallGroup, "smallToBig");
        return {
          enabled: bool(sb, "enabled") ?? false,
          maxExtraLines: (() => {
            const raw = num(sb, "maxExtraLines");
            return raw === undefined ? 2 : raw > 0 ? Math.floor(raw) : 0;
          })(),
        };
      })(),
      // R71-C（2026-10-19）：fts-only 降级注入帽（缺省 2；非负整数 floor；非数字=undefined=运行期取 2）
      ftsOnlyInjectCap: (() => {
        const raw = num(recallGroup, "ftsOnlyInjectCap");
        return raw === undefined ? undefined : Math.max(0, Math.floor(raw));
      })(),
      // #54：召回注入动态 topK（分数分布 elbow；缺省 false=逐位现状；clamp 见类型注释）
      dynamicTopK: (() => {
        const dk = obj(recallGroup, "dynamicTopK");
        const minTopKRaw = Math.floor(num(dk, "minTopK") ?? 2);
        const dropRatioRaw = num(dk, "dropRatio") ?? 0.5;
        return {
          enabled: bool(dk, "enabled") ?? false,
          minTopK: Math.min(50, Math.max(1, minTopKRaw)),
          dropRatio: Math.min(1, Math.max(0.01, dropRatioRaw)),
        };
      })(),
      // RV2-2（精排重设计）：相关度主导四因子（默认 0.7/0.15/0.1/0.05——relevance ≥70% 契约；
      // 负值 clamp 0；全 0 = 关断恒等；relevance=0 = 纯时间/显著排序，预期行为变更已登记）
      rerankWeights: (() => {
        const rw = obj(recallGroup, "rerankWeights");
        return {
          relevance: recallSignalBoost(rw, "relevance", 0.7),
          timeProx: recallSignalBoost(rw, "timeProx", 0.15),
          significance: recallSignalBoost(rw, "significance", 0.1),
          coreRef: recallSignalBoost(rw, "coreRef", 0.05),
        };
      })(),
      // DS-RECALL-MERGE-001（合并召回）：/v3/recall 核心单点端点。
      // enabled 缺省 false = 逐位现状（关断矩阵纪律：yaml 显式开启前代理链路零变化）；
      // timeoutMs 缺省 5000 与 recall.timeoutMs 同族，负值/非有限 clamp 0（0 = 立即超时，
      // 语义自毁不拦——运维误配会以 504+代理降级 loud 显形，不静默）。
      v3Recall: (() => {
        const vr = obj(recallGroup, "v3Recall");
        return {
          enabled: bool(vr, "enabled") ?? false,
          timeoutMs: Math.max(0, num(vr, "timeoutMs") ?? 5000),
        };
      })(),
      // P1 召回质量（spec §4.3，task-1）：精排 rerank provider 面（与 rerankWeights 不同概念）。
      // enabled 缺省 false + provider 缺省 none = 逐位现状；校验沿 embedding 先例
      // （不抛异常，configError + enabled 强制 false）。timeoutMs 负值 clamp 0（v3Recall
      // loud 显形先例）；candidates clamp [1,100] 取整（0 抬到 1，关断走 enabled 开关）；
      // minScore 任意有限数透传（负值合法）；local.idleUnloadMs 负值 clamp 0（0 = 常驻）。
      rerank: (() => {
        const rr = obj(recallGroup, "rerank");
        const providerRaw = str(rr, "provider") ?? "none";
        let provider: RecallRerankConfig["provider"];
        let enabled = bool(rr, "enabled") ?? false;
        let configError: string | undefined;
        if (VALID_RERANK_PROVIDERS.includes(providerRaw as RecallRerankConfig["provider"])) {
          provider = providerRaw as RecallRerankConfig["provider"];
        } else {
          configError =
            `Rerank provider '${providerRaw}' is not supported (valid: siliconflow, dashscope, local, none). ` +
            "Rerank has been disabled.";
          provider = "none";
          enabled = false;
        }
        const apiKey = str(rr, "apiKey") ?? "";
        if ((provider === "siliconflow" || provider === "dashscope") && !apiKey) {
          configError = `Rerank provider '${provider}' requires 'apiKey' to be set. Rerank has been disabled.`;
          enabled = false;
        }
        const localGroup = obj(rr, "local");
        return {
          enabled,
          provider,
          apiKey,
          baseUrl: str(rr, "baseUrl") ?? "",
          model: str(rr, "model") ?? "",
          timeoutMs: Math.max(0, num(rr, "timeoutMs") ?? 800),
          candidates: Math.max(1, Math.floor(recallSignalBoost(rr, "candidates", 12, 100))),
          minScore: num(rr, "minScore") ?? -2.0,
          local: {
            modelDir: optStr(localGroup, "modelDir") ?? "",
            idleUnloadMs: recallSignalBoost(localGroup, "idleUnloadMs", 600_000),
          },
          configError,
        };
      })(),
    },
    // T5（用户 2026-09-22 拍板定案）：召回/灵魂注入日志——memory 层级独立组（缺省 false=逐位现状）；
    // 大小轮转/数量上限全可配（clamp：rotationSizeMB (0,100]、maxFiles [1,100]）。
    recallJournal: {
      enabled: bool(recallJournalGroup, "enabled") ?? false,
      rotationSizeMB: (() => {
        const raw = num(recallJournalGroup, "rotationSizeMB");
        if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 5;
        return Math.min(raw, 100);
      })(),
      maxFiles: (() => {
        const raw = num(recallJournalGroup, "maxFiles");
        if (raw === undefined || !Number.isFinite(raw) || raw < 1) return 5;
        return Math.min(Math.floor(raw), 100);
      })(),
    },
    embedding: {
      enabled: embeddingEnabled,
      provider: embeddingProvider,
      baseUrl: embeddingBaseUrl,
      apiKey: embeddingApiKey,
      model: str(embeddingGroup, "model") ?? defaultModel,
      dimensions: num(embeddingGroup, "dimensions") ?? defaultDimensions,
      sendDimensions: bool(embeddingGroup, "sendDimensions") ?? true,
      conflictRecallTopK: num(embeddingGroup, "conflictRecallTopK") ?? 5,
      proxyUrl: embeddingProxyUrl,
      maxInputChars: num(embeddingGroup, "maxInputChars") ?? 5000,
      timeoutMs: num(embeddingGroup, "timeoutMs") ?? 10_000,
      recallTimeoutMs: num(embeddingGroup, "recallTimeoutMs") ?? undefined,
      captureTimeoutMs: num(embeddingGroup, "captureTimeoutMs") ?? undefined,
      modelCacheDir: optStr(embeddingGroup, "modelCacheDir"),
      configError: embeddingConfigError,
    },
    storeBackend,
    tcvdb: {
      url: str(tcvdbGroup, "url") ?? "",
      username: str(tcvdbGroup, "username") ?? "root",
      apiKey: str(tcvdbGroup, "apiKey") ?? "",
      database: str(tcvdbGroup, "database") ?? "",
      alias: str(tcvdbGroup, "alias") ?? "",
      embeddingEnabled: bool(tcvdbGroup, "embeddingEnabled") ?? false,
      embeddingModel: str(tcvdbGroup, "embeddingModel") ?? "bge-large-zh",
      timeout: num(tcvdbGroup, "timeout") ?? 10000,
      caPemPath: str(tcvdbGroup, "caPemPath") || undefined,
    },
    bm25: {
      enabled: bool(bm25Group, "enabled") ?? true,
      language: (str(bm25Group, "language") === "en" ? "en" : "zh") as "zh" | "en",
    },
    memoryCleanup,
    report: {
      enabled: bool(obj(c, "report"), "enabled") ?? false,
      type: str(obj(c, "report"), "type") ?? "local",
    },
    llm: (() => {
      const llmGroup = obj(c, "llm");
      const rawProvider = str(llmGroup, "provider");
      const provider: "openai" | "proxy" =
        rawProvider === "proxy" ? "proxy" : "openai";
      const proxyGroup = obj(llmGroup, "proxy");
      return {
        enabled: bool(llmGroup, "enabled") ?? false,
        baseUrl: str(llmGroup, "baseUrl") ?? "https://api.openai.com/v1",
        apiKey: str(llmGroup, "apiKey") ?? "",
        model: str(llmGroup, "model") ?? "gpt-4o",
        maxTokens: num(llmGroup, "maxTokens") ?? 4096,
        timeoutMs: num(llmGroup, "timeoutMs") ?? 120_000,
        // T2（多提供商兼容）：max_tokens 上限（缺省 131072=Ark 上限；config-first 钳制）
        maxTokensLimit: num(llmGroup, "maxTokensLimit") ?? 131072,
        provider,
        stream: bool(llmGroup, "stream") ?? false,
        proxy: {
          // 默认 true：走 proxy 时用 memory 系统用户 key 作为 Authorization。
          useMemorySystemUserKey: bool(proxyGroup, "useMemorySystemUserKey") ?? true,
        },
      };
    })(),
    offload,
    // G/H/I/J 真记忆生命周期（config-first：yaml 值真实生效）
    links,
    coreMemory,
    lifecycle,
    evolution,
    search,
    // 场景块治理（DS-SCENE-GOV-001）：enabled 缺省 false，生产零变化
    sceneGovernance,
    // D-3：敏感性标注门（yaml memory.sensitivity.extractionEnabled；缺省 false）
    sensitivity: {
      extractionEnabled: bool((c.sensitivity ?? {}) as Record<string, unknown>, "extractionEnabled") ?? false,
    },
    // P1-T7：worthiness importance 写入面门（yaml memory.worthiness.extractionEnabled；
    // 缺省 false = 抽取 prompt 字节不变，LLM 不产出 importance 字段，逐位现状）
    worthiness: {
      extractionEnabled: bool((c.worthiness ?? {}) as Record<string, unknown>, "extractionEnabled") ?? false,
    },
    // #28（R5 统一抽取扩展门）：yaml memory.extractionExtensions.enabled；缺省 false=逐位现状。
    extractionExtensions: {
      enabled: bool((c.extractionExtensions ?? {}) as Record<string, unknown>, "enabled") ?? false,
    },
    // Skill: passthrough — let the host wiring call resolveSkillConfig() with
    // ambient probes (TCVDB / COS / embedding / LLMRunner). We don't apply
    // defaults here so the resolver remains the single source of truth.
    skill: (c.skill && typeof c.skill === "object" && !Array.isArray(c.skill))
      ? (c.skill as import("./core/skill/types.js").SkillConfigInput)
      : undefined,
  };
}

// ============================
// Helper functions
// ============================

/** Get sub-object by key, or empty object if missing. */
function obj(c: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = c[key];
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function str(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function normalizePromptMode(value: string | undefined, fallback: MemoryPromptMode = "chat"): MemoryPromptMode {
  if (value === "code" || value === "chat") return value;
  return fallback;
}

function optStr(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" ? v : undefined;
}

function num(src: Record<string, unknown>, key: string): number | undefined {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function bool(src: Record<string, unknown>, key: string): boolean | undefined {
  const v = src[key];
  return typeof v === "boolean" ? v : undefined;
}

function strArray(src: Record<string, unknown>, key: string): string[] | undefined {
  const v = src[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

const VALID_STRATEGIES: RecallConfig["strategy"][] = ["embedding", "keyword", "hybrid"];

/** P1（spec §4.3，task-1）：rerank provider 白名单（local = Task 3 可插拔 id）。 */
const VALID_RERANK_PROVIDERS: RecallRerankConfig["provider"][] = ["siliconflow", "dashscope", "local", "none"];

/**
 * Validate recall strategy against whitelist.
 * Returns the strategy if valid, undefined otherwise (caller falls back to default).
 */
function validateStrategy(value: string | undefined): RecallConfig["strategy"] | undefined {
  if (!value) return undefined;
  return VALID_STRATEGIES.includes(value as RecallConfig["strategy"])
    ? (value as RecallConfig["strategy"])
    : undefined;
}

/**
 * Normalize a cleanup time string.
 *
 * The input must follow "HH:MM" or "H:MM" format (24-hour clock).
 * If the time is valid, it returns the normalized format "HH:MM"
 * with leading zeros added when necessary.
 * If the format is invalid or the time is out of range
 * (hour: 0–23, minute: 0–59), it returns undefined.
 *
 * Examples:
 * normalizeCleanTime("3:05")  -> "03:05"
 * normalizeCleanTime("03:05") -> "03:05"
 * normalizeCleanTime("23:59") -> "23:59"
 *
 * normalizeCleanTime("24:00") -> undefined   // hour out of range
 * normalizeCleanTime("12:60") -> undefined   // minute out of range
 * normalizeCleanTime("3:5")   -> undefined   // minute must have two digits
 * normalizeCleanTime("abc")   -> undefined   // invalid format
 */
function normalizeCleanTime(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!m) return undefined;

  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return undefined;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return undefined;

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Normalize offload retention days.
 *
 * - `<= 0` → 0 (disabled)
 * - `(0, 3)` → 0 (invalid, force disabled)
 * - `>= 3` → as-is
 */
function normalizeOffloadRetentionDays(value: number): number {
  if (value <= 0) return 0;
  if (value < 3) return 0;
  return value;
}
