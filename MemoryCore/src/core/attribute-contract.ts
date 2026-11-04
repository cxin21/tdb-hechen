/**
 * 属性契约注册表（2026-11-04 定案，用户令「不能只用来看」）。
 *
 * 目的：把「某个属性是否真的在记忆生命周期里生效」从口头结论变成可判定事实。
 * 每条属性必须登记 ≥1 个**非 UI** 消费点（捕获/提取/召回/遗忘/注入/灵魂/生命周期），
 * 且登记项 {path, symbol} 由 __tests__/attribute-contract.test.ts 对真实源码逐一核验：
 * 符号消失 = 测试红。仅登记 UI（面板/抽屉/徽章）会被判为「只用来看」直接红。
 *
 * 维护规则：新增属性列必须同时在此登记消费点；删除消费点必须同步改这里并说明替代路径。
 * 这里不复制实现，只钉住「谁读它、读完改变什么行为」的契约。
 */

/** 属性在生命周期中的生效阶段（非 UI）。 */
export type AttributeStage =
  | "capture"      // 采集/落 L0
  | "extraction"   // 抽取/判重/写 L1
  | "retrieval"    // 召回排序/过滤
  | "forgetting"   // 遗忘/归档
  | "injection"    // 注入提示词
  | "soul"         // 人格/灵魂装配
  | "lifecycle";   // 巩固/反思/演化/失效

export interface AttributeConsumer {
  /** 仓库根相对路径（MemoryCore/... 或 MemoryPanel/...）。 */
  path: string;
  /** 该文件里必须存在的符号/字面量（测试按子串核验）。 */
  symbol: string;
  /** 读了它以后改变的行为（一句话，写清后果）。 */
  effect: string;
  stage: AttributeStage;
}

export interface AttributeContractEntry {
  /** 落库/对外字段名（原始键名，不做译名）。 */
  name: string;
  /** 存储位置：soul 列 / 基础列 / 关联表。 */
  storage: "soul_column" | "base_column" | "link";
  /** 非 UI 消费点（至少 1 条，测试强制）。 */
  consumers: AttributeConsumer[];
  /** UI 可见面（只作补充，不计入「已使用」）。 */
  ui?: string[];
  /** 定案备注：为什么这样算「已使用」。 */
  note: string;
}

export const ATTRIBUTE_CONTRACT: readonly AttributeContractEntry[] = [
  {
    name: "importance",
    storage: "soul_column",
    note: "价值维度：召回降权（≤4 行 ×(1-penalty)）+ 遗忘保留乘子（低重要度更快归档，NULL=未评分不罚）。生产 3334 行有值。",
    consumers: [
      { path: "MemoryCore/src/core/tools/recall-signals.ts", symbol: "importanceMultiplierOf", effect: "importance≤4 的行 rankKey 乘 (1-penalty)，直接改变召回排序", stage: "retrieval" },
      { path: "MemoryCore/src/core/lifecycle/forgetting/scorer.ts", symbol: "importanceRetention", effect: "importance 折算 retention 乘子进入归档打分，低分更易归档", stage: "forgetting" },
      { path: "MemoryCore/src/core/hooks/auto-recall.ts", symbol: "importanceMultiplierOf", effect: "hook 召回把乘子真实乘进 rrfScore", stage: "retrieval" },
    ],
    ui: ["AttributesSection 调级表单（owner-only）", "BlockDetail 属性行"],
  },
  {
    name: "significance",
    storage: "soul_column",
    note: "显著性：遗忘打分的价值主项 × 召回 sigWeight（生产 0，通道存在）+ 注入行展示。",
    consumers: [
      { path: "MemoryCore/src/core/lifecycle/forgetting/scorer.ts", symbol: "significanceOf", effect: "显著性×优先级×衰减决定归档，是遗忘第一权重", stage: "forgetting" },
      { path: "MemoryCore/src/core/tools/recall-signals.ts", symbol: "sigWeight", effect: "sigWeight>0 时按显著性加成召回分", stage: "retrieval" },
      { path: "MemoryCore/src/core/hooks/auto-recall.ts", symbol: "significance", effect: "注入行渲染与 soul 装配读取显著性", stage: "injection" },
    ],
    ui: ["SoulSection 仪表", "MemoryGraphView 节点大小"],
  },
  {
    name: "valence",
    storage: "soul_column",
    note: "情感效价：人格基调聚合（moodLine）+ 遗忘显著性兜底（|valence|）。",
    consumers: [
      { path: "MemoryCore/src/core/hooks/mood-line.ts", symbol: "valence", effect: "聚合近期效价生成注入基调行", stage: "injection" },
      { path: "MemoryCore/src/core/lifecycle/forgetting/scorer.ts", symbol: "valence", effect: "无 significance 时用 |valence| 作价值兜底", stage: "forgetting" },
      { path: "MemoryCore/src/core/store/sqlite.ts", symbol: "recentAffectSignals", effect: "读出近期效价序列供人格链使用", stage: "soul" },
    ],
    ui: ["双色效价条", "图节点色相"],
  },
  {
    name: "arousal",
    storage: "soul_column",
    note: "唤醒度：调制遗忘衰减 λ（effectiveλ=λ(1-k·arousal)）+ 注入强情绪标记。",
    consumers: [
      { path: "MemoryCore/src/core/lifecycle/forgetting/scorer.ts", symbol: "arousalOf", effect: "高唤醒降低有效衰减率，记忆更久保留", stage: "forgetting" },
      { path: "MemoryCore/src/core/hooks/auto-recall.ts", symbol: "强烈", effect: "唤醒≥阈值时注入行加情绪标记", stage: "injection" },
    ],
    ui: ["arousal 徽章"],
  },
  {
    name: "certainty",
    storage: "soul_column",
    note: "确定性：六个硬门（合并/分组/遗忘/检索/强化计数/注入）。",
    consumers: [
      { path: "MemoryCore/src/core/record/l1-extractor.ts", symbol: "inferred", effect: "inferred 记忆在合并/落库时受硬门约束", stage: "extraction" },
      { path: "MemoryCore/src/core/lifecycle/forgetting/forgetting-worker.ts", symbol: "certainty", effect: "推断记忆的归档保护/判定", stage: "forgetting" },
      { path: "MemoryCore/src/core/tools/memory-search.ts", symbol: "certainty", effect: "inferredPenalty 参与召回降权", stage: "retrieval" },
    ],
    ui: ["实见/推断 chip"],
  },
  {
    name: "sensitivity",
    storage: "soul_column",
    note: "敏感度：注入门（非 none 只在私有上下文注入）+ 人工显式降敏（CAS + 审计）。",
    consumers: [
      { path: "MemoryCore/src/core/recall/sensitivity-policy.ts", symbol: "audienceOfOwnerScope", effect: "从候选池归属推导 audience，决定敏感行是否可注入", stage: "injection" },
      { path: "MemoryCore/src/core/tools/memory-search.ts", symbol: "sensitivity", effect: "检索结果投影 sensitivity 供门判定（漏投影=静默放行）", stage: "retrieval" },
      { path: "MemoryCore/src/gateway/v2-router.ts", symbol: "handleAtomicSensitivity", effect: "写路径 CAS 降敏 + 审计", stage: "lifecycle" },
    ],
    ui: ["敏感度 chip", "解除敏感标记（owner-only）"],
  },
  {
    name: "occurred_at",
    storage: "soul_column",
    note: "事件时刻：检索时间窗/版本序 + 遗忘年龄兜底 + 注入时间展示。",
    consumers: [
      { path: "MemoryCore/src/core/tools/memory-search.ts", symbol: "occurred_at", effect: "时间窗过滤与时间相关性排序", stage: "retrieval" },
      { path: "MemoryCore/src/core/lifecycle/forgetting/scorer.ts", symbol: "occurred_at", effect: "无系统时间时作为年龄回退锚", stage: "forgetting" },
      { path: "MemoryCore/src/core/hooks/auto-recall.ts", symbol: "occurred_at", effect: "注入行标注事件时间", stage: "injection" },
    ],
    ui: ["事件时刻行", "日志分组"],
  },
  {
    name: "valid_start",
    storage: "soul_column",
    note: "生效起：有效期内/外判定（soft 降权，hard 丢弃）。",
    consumers: [
      { path: "MemoryCore/src/core/recall/validity-policy.ts", symbol: "valid_start", effect: "判断当前时刻是否落在有效期内，越界按模式降权/丢弃", stage: "retrieval" },
    ],
    ui: ["生效起行"],
  },
  {
    name: "valid_end",
    storage: "soul_column",
    note: "生效止：失效判定 + 面板失效/恢复写入。",
    consumers: [
      { path: "MemoryCore/src/core/recall/validity-policy.ts", symbol: "valid_end", effect: "过期行 soft 降权或 hard 丢弃", stage: "retrieval" },
      { path: "MemoryCore/src/core/store/sqlite.ts", symbol: "valid_end", effect: "失效/恢复落库并参与候选池", stage: "lifecycle" },
    ],
    ui: ["失效/恢复（owner-only）"],
  },
  {
    name: "source_message_ids",
    storage: "base_column",
    note: "原话溯源：提取期证据主键（幻觉 id 剔除、同源覆盖改 update）+ 面板抽屉。",
    consumers: [
      { path: "MemoryCore/src/core/record/l1-extractor.ts", symbol: "source_message_ids", effect: "只保留当批真实消息 id，并据此覆盖判重决策", stage: "extraction" },
      { path: "MemoryCore/src/core/store/sqlite.ts", symbol: "findL1BySourceMessageIds", effect: "按来源 id 反查既有记录，避免同源重复落库", stage: "retrieval" },
    ],
    ui: ["原话抽屉"],
  },
  {
    name: "task_id",
    storage: "base_column",
    note: "作用域键（非灵魂属性）：网关 x-tdai-task-id → L0/L1 → 召回作用域过滤；无生产者时全空。",
    consumers: [
      { path: "MemoryCore/src/gateway/server.ts", symbol: "x-tdai-task-id", effect: "采集请求头解析 task 作用域", stage: "capture" },
      { path: "MemoryCore/src/core/conversation/l0-recorder.ts", symbol: "taskId", effect: "L0 落库携带 task_id 供下游继承", stage: "capture" },
      { path: "MemoryCore/src/core/store/sqlite.ts", symbol: "task_id", effect: "租户过滤按 task_id 收窄候选池", stage: "retrieval" },
    ],
    ui: ["非空时展示作用域"],
  },
  {
    name: "type",
    storage: "base_column",
    note: "记忆类型：召回 typeFilter 分桶 + 面板类型过滤。",
    consumers: [
      { path: "MemoryCore/src/core/tools/memory-search.ts", symbol: "typeFilter", effect: "按类型收窄召回候选", stage: "retrieval" },
      { path: "MemoryCore/src/core/record/l1-extractor.ts", symbol: "type", effect: "抽取阶段决定记忆类型", stage: "extraction" },
    ],
    ui: ["类型过滤"],
  },
  {
    name: "priority",
    storage: "base_column",
    note: "优先级：遗忘永不归档门（-1）+ 价值乘子。",
    consumers: [
      { path: "MemoryCore/src/core/lifecycle/forgetting/scorer.ts", symbol: "priorityOf", effect: "priority=-1 永不归档，其余按值折算保留权重", stage: "forgetting" },
      { path: "MemoryCore/src/core/record/l1-extractor.ts", symbol: "priority", effect: "抽取阶段赋值优先级", stage: "extraction" },
    ],
    ui: ["优先级行"],
  },
  {
    name: "scene_name",
    storage: "base_column",
    note: "场景归属：场景治理/L2 固化 + 召回 sceneFilter（sceneBoost 生产 0）。",
    consumers: [
      { path: "MemoryCore/src/core/tools/memory-search.ts", symbol: "sceneFilter", effect: "按场景名收窄召回候选池", stage: "retrieval" },
      { path: "MemoryCore/src/core/scene/scene-governance.ts", symbol: "scene", effect: "场景治理与固化进入 L2 场景索引", stage: "lifecycle" },
    ],
    ui: ["场景行"],
  },
  {
    name: "updated_time",
    storage: "base_column",
    note: "最近更新时间：反思增量窗口 + 检索排序/对外 updated_at。",
    consumers: [
      { path: "MemoryCore/src/core/lifecycle/reflection.ts", symbol: "updated_time", effect: "反思只处理时间窗内更新过的记录", stage: "lifecycle" },
      { path: "MemoryCore/src/gateway/atomic-query-fields.ts", symbol: "updated_time", effect: "对外 updated_at 统一取 updated_time", stage: "retrieval" },
    ],
    ui: ["最近更新行"],
  },
  {
    name: "created_time",
    storage: "base_column",
    note: "出生时间：遗忘年龄权威时钟（事件年龄不参与衰减）。",
    consumers: [
      { path: "MemoryCore/src/core/lifecycle/forgetting/scorer.ts", symbol: "created_time", effect: "ageDaysOf 以出生时间计算衰减", stage: "forgetting" },
    ],
    ui: ["创建时间行"],
  },
];

/** 测试与消费方共用：非 UI 消费点数量。 */
export function nonUiConsumerCount(entry: AttributeContractEntry): number {
  return entry.consumers.filter((c) => !c.path.startsWith("MemoryPanel/")).length;
}