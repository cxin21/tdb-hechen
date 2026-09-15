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
  /** Minimum score threshold (default: 0.3) */
  scoreThreshold: number;
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
     * 审查修补 I③（TTL 解耦）：幂等结论层缓存 TTL 毫秒。缺省（未配置）= 回落
     * sessionReuseTtlMs 保持现行为；显式 0 = 关（每次重组，不缓存）；负值 clamp 0。
     */
    cacheTtlMs?: number;
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
    intervalHours: number;
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
    /** 低于该分且超期才归档。 */
    lowThreshold: number;
    /** 至少经过多少天才可归档。 */
    minAgeDays: number;
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

/** Fully resolved plugin configuration (v3). */
export interface MemoryTdaiConfig {
  /** Global prompt family; group-level promptMode can override it. */
  promptMode: MemoryPromptMode;
  capture: CaptureConfig;
  extraction: ExtractionConfig;
  persona: PersonaConfig;
  pipeline: PipelineTriggerConfig;
  recall: RecallConfig;
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
  /** J 图邻居扩展（memory.search.neighborExpand）。 */
  search: {
    neighborExpand: MemoryNeighborExpandConfig;
  };
  /** 场景块治理（DS-SCENE-GOV-001；enabled 缺省 false = 生产行为零变化）。 */
  sceneGovernance: SceneGovernanceConfig;
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
    allowedSlots: coreMemoryAllowedSlots ?? ["identity", "core_value", "strict_rule"],
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
      return {
        enabled: bool(g, "enabled") ?? true,
        minEvidence: clamp("minEvidence", 5, 1, 50),
        maxPerPass: clamp("maxPerPass", 2, 1, 10),
        maxTotal: clamp("maxTotal", 15, 1, 100),
        intervalHours: clamp("intervalHours", 24, 1, 24 * 30),
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
      lowThreshold: num(lifecycleForgettingGroup, "lowThreshold") ?? 0.12,
      minAgeDays: num(lifecycleForgettingGroup, "minAgeDays") ?? 30,
    },
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
      model: optStr(extractionGroup, "model"),
      promptMode: normalizePromptMode(str(extractionGroup, "promptMode"), globalPromptMode),
    },
    persona: {
      triggerEveryN: num(personaGroup, "triggerEveryN") ?? 50,
      maxScenes: num(personaGroup, "maxScenes") ?? 15,
      backupCount: num(personaGroup, "backupCount") ?? 3,
      sceneBackupCount: num(personaGroup, "sceneBackupCount") ?? 10,
      model: optStr(personaGroup, "model"),
      promptMode: normalizePromptMode(str(personaGroup, "promptMode"), globalPromptMode),
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
      reinforcementWeight: recallSignalBoost(recallGroup, "reinforcementWeight", 0.03),
      moodBoost: recallSignalBoost(recallGroup, "moodBoost", 0),
      // R-A2（spec §2 R4/R6）：候选池通道开关（clamp 模式；graph 两旋钮为比值 clamp [0,1]）
      graphMinStrength: recallSignalBoost(recallGroup, "graphMinStrength", 0.5, 1),
      graphDiscount: recallSignalBoost(recallGroup, "graphDiscount", 0.6, 1),
      sceneBoost: recallSignalBoost(recallGroup, "sceneBoost", 0.04),
      // R-A3（性能速赢 E1/E2/E3）：TTL 缓存开关（毫秒，缺省默认开；<=0 = 关；负值 clamp 0）
      queryEmbeddingCacheTtlMs: recallSignalBoost(recallGroup, "queryEmbeddingCacheTtlMs", 60_000),
      valuesCacheTtlMs: recallSignalBoost(recallGroup, "valuesCacheTtlMs", 60_000),
      sessionReuseTtlMs: recallSignalBoost(recallGroup, "sessionReuseTtlMs", 300_000),
      // V2-1（引擎二 PPR spec E2.1）：PPR 三旋钮（recallSignalBoost clamp 模式，0 可设）。
      // damping 比值 clamp [0,1]（0 = 图通道退化关断）；topK/iterations 取整，topK 0 = 零图候选。
      pprDamping: recallSignalBoost(recallGroup, "pprDamping", 0.85, 1),
      pprTopK: Math.floor(recallSignalBoost(recallGroup, "pprTopK", 10, 100)),
      pprIterations: Math.max(1, Math.floor(recallSignalBoost(recallGroup, "pprIterations", 30, 100))),
      // V2-2（引擎一 spec E1.1）：查询自动扩展（E1.1 默认 true / maxTerms 8 / ttl 10min / timeout 8s）
      queryExpansion: (() => {
        const qe = obj(recallGroup, "queryExpansion");
        return {
          enabled: bool(qe, "enabled") ?? true,
          maxTerms: Math.max(1, Math.floor(recallSignalBoost(qe, "maxTerms", 8, 32))),
          ttlMs: recallSignalBoost(qe, "ttlMs", 600_000),
          timeoutMs: Math.max(1000, recallSignalBoost(qe, "timeoutMs", 8000)),
        };
      })(),
      // V2-3（引擎三 E3.1/E3.2）注意力平衡旋钮（默认开）+ RV2-2 精排重设计（相关度主导）
      exploreSlot: bool(recallGroup, "exploreSlot") ?? true,
      conclusionRelaxedForAnalytical: bool(recallGroup, "conclusionRelaxedForAnalytical") ?? true,
      // Task CAL C1：结论层注入前截断（默认 2000，0=不截断；负值/非有限沿 recallSignalBoost clamp 模式）
      // 审查修补 I①：enabled 总开关（缺省 true=现行为）；I③：cacheTtlMs 独立 TTL
      // （缺省 undefined → 运行期回落 sessionReuseTtlMs；显式 0=关；负值 clamp 0）
      conclusionLayer: (() => {
        const cl = obj(recallGroup, "conclusionLayer");
        return {
          enabled: bool(cl, "enabled") ?? true,
          maxCharsPerMemory: recallSignalBoost(cl, "maxCharsPerMemory", 2000),
          cacheTtlMs: (() => {
            const raw = num(cl, "cacheTtlMs");
            return raw === undefined ? undefined : Math.max(0, Math.floor(raw));
          })(),
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
    search,
    // 场景块治理（DS-SCENE-GOV-001）：enabled 缺省 false，生产零变化
    sceneGovernance,
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
