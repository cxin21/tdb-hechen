/**
 * 任务5（用户 2026-09-22 拍板定案）：召回/灵魂注入日志 writer——单一源。
 * 采集点=performLayeredRecall 返回点（两路共用于同一函数，禁第二份）；
 * 存储=<dataDir>/logs/recall/ 按租户 recall-journal-{team}-{agent}.jsonl；
 * 大小轮转缺省 5MB、数量上限缺省 5（memory.recallJournal.{enabled,rotationSizeMB,maxFiles} 全可配）；
 * best-effort：任何失败吞错零影响主链路（召回热路径纪律）。
 */
import fs from "node:fs";
import path from "node:path";
// P1-T7：类型单一源在 recall-signals.ts——import type 供本文件接口引用，
// 再 re-export 供 journal 消费方单点 import。
import type { RecallJournalImportanceGate } from "../tools/recall-signals.js";
import type { ValidityFilterStats } from "./validity-policy.js";

export interface RecallJournalSearchTiming {
  ftsMs: number;
  embeddingMs: number;
  ftsHits: number;
  embeddingHits: number;
}

/**
 * P1 Task 2（spec §4.5，r3=232a124）：精排观测 gate —— kept/dropped 以本调用候选池口径记录；
 * gate 为真实生效后的结果观测（用户 2026-10-14 拍板移除 shadowMode，重排恒真实生效）；
 * 降级路径（不可用/熔断开/adapter null）ms=0（未外呼）或实际耗时、kept=池大小、dropped=0、无 topScore。
 */
export interface RecallJournalRerankGate {
  provider: string;
  ms: number;
  kept: number;
  dropped: number;
  topScore?: number;
  /**
   * #99 F3（2026-10-25）：local provider 原始 logit 经 sigmoid 归一 0..1 后对门槛——
   * 本键标记刻度（topScore 仍为 raw，取证口径连续）；云 provider 原生 0..1 缺键（native）。
   */
  scoreScale?: "logit-sigmoid";
  /** #99 F3：topScore 的归一化值（logit-sigmoid 时 sigmoid(topScore)；native 不出键）。 */
  top01?: number;
  /** #99 F3：生效门槛的归一化值（仅 logit-sigmoid 出键 = sigmoid(minScore)；native 不出键——native 刻度即 minScore 原值，无需归一化观测）。 */
  threshold01?: number;
  /** #99 F3：优雅降级归因——全员低于阈值不清零，回退未重排顺序注入（预算帽照常生效）。 */
  degraded?: "all-below-minScore";
  /** B2-b（bench/recall-opt）：pass 池 MMR 多样性重排观测（缺字段 = 未启用）。 */
  mmr?: { lambda: number; ms: number };
  /** #135 R4（bench/recall-opt）：作用模式标记（缺字段 = 缺省 "rerank"）。 */
  mode?: "filter";
  /**
   * #144（2026-10-29）：filter 的判定尺子与参数（缺字段 = floor，= 逐位旧行为）。
   * 只带**当前生效**那个尺子的参数：margin 出 filterMarginTop、quantile 出 filterKeepRatio
   * （组装走 rerank/filter-ruler.ts 的 filterRulerGateObs，避免两处各写一套）。
   */
  filterRule?: "floor" | "margin" | "quantile";
  filterMarginTop?: number;
  filterKeepRatio?: number;
  /**
   * #144：规则「过线」条数（cap 与 #137-F 补位**之前**）。kept 是 cap 之后的最终注入条数，
   * 单看 kept 分不清「被尺子裁掉」与「被预算截断」——归因需要这两个数一起看。
   */
  passCount?: number;
  /** #137-F：融合锚点是否被强制保留（true = 精排曾把融合 top-1 挤出窗口）。 */
  anchor?: boolean;
  /** #137-F：floor 补位数（达线行不足预算时按融合序补回的候选数；防小窗口被 floor 饿死）。 */
  floorToppedUp?: number;
}

/**
 * R71-A1（2026-10-19）：work_fact 候选 bm25 预地板观测门。
 * kept = 进入 bm25 地板筛选的预选择候选总数（过线 work_fact + 豁免候选）——非 FTS 池大小：
 * scene_block 候选无 bm25Rel 恒豁免地板，kept 会大于 work_fact FTS 行数（#75/#95：生产
 * 619 条 gate 记录 kept ∈ 14-18 与 scene_index 条数精确吻合，非异常）。向后兼容（#95）：
 * kept/dropped 含义不变；旧条目无 keptWorkFact/keptSceneBlock（缺字段 = 拆分引入前）。
 */
export interface RecallJournalConclusionBm25Gate {
  /** 地板阈值（conclusionLayer.minBm25Rel 透传）。 */
  minRel: number;
  /** 预选择候选总数（keptWorkFact + keptSceneBlock）——非 FTS 池大小（见接口注释）。 */
  kept: number;
  /** 被地板删减的候选数；恒为 work_fact 行（scene_block 无 bm25Rel 不参与地板判定，故不设 droppedWorkFact 拆分）。 */
  dropped: number;
  /**
   * #95（2026-10-25）：kept 中 work_fact 来源数 = 过线 FTS 行 + bm25Rel undefined 的豁免行
   * （后端未提供 rank；V2-3 放宽通道不进候选池，不计入）。缺字段 = 旧条目。
   */
  keptWorkFact?: number;
  /**
   * #95（2026-10-25）：kept 中 scene_block 来源数 = 过 identity 门后的 scene_index 候选数
   * （豁免地板，显式计数；与 scene_index 条数可对账）。缺字段 = 旧条目。
   */
  keptSceneBlock?: number;
  /**
   * #99 F2（2026-10-25）：地板口径——relative = 门槛 = α×topRel（minBm25RelRatio 相对门，
   * 刻度无关）；absolute = legacy minBm25Rel 绝对分（未迁移部署）。缺字段 = 旧条目（absolute）。
   */
  mode?: "relative" | "absolute";
  /** #99 F2：relative 口径的 α（conclusionLayer.minBm25RelRatio 透传，[0,1] clamp）。 */
  alpha?: number;
  /** #99 F2：relative 口径的本候选池最大 raw rel（门槛 minRel = alpha×topRel）。 */
  topRel?: number;
}

/** R71-A2（2026-10-19）：结论层 rerank 语义门观测（shadow 记 would-be 决策）。
 *  bypass ∈ rerank-off | rerank-unavailable | breaker-open | rerank-failed（旁路留痕=未执行门控）。 */
export interface RecallJournalConclusionRerankGate {
  mode: "off" | "shadow" | "enforce";
  provider: string;
  ms: number;
  kept: number;
  dropped: number;
  topScore?: number;
  bypass?: "rerank-off" | "rerank-unavailable" | "breaker-open" | "rerank-failed";
  /**
   * #99 F3（2026-10-25）：local provider 原始 logit 经 sigmoid 归一 0..1 后对门槛
   * （topScore 仍为 raw）；云 provider 原生 0..1 缺键（native）。
   */
  scoreScale?: "logit-sigmoid";
  /** #99 F3：topScore 的归一化值（logit-sigmoid 时 sigmoid(topScore)；native 不出键）。 */
  top01?: number;
  /** #99 F3：生效门槛的归一化值（仅 logit-sigmoid 出键 = sigmoid(minScore)；native 不出键——native 刻度即 minScore 原值，无需归一化观测）。 */
  threshold01?: number;
  /** #99 F3：优雅降级归因——enforce 全员低于阈值不清零，保留原选择（降级旁路）。 */
  degraded?: "all-below-minScore";
}

export interface RecallJournalGates {
  nativeMinRRF?: { gate: number; kept: number; dropped: number };
  rerank?: RecallJournalRerankGate;
  conclusionBm25?: RecallJournalConclusionBm25Gate;
  conclusionRerank?: RecallJournalConclusionRerankGate;
  /**
   * #138（2026-10-28）：结论卡身世回捞（smallToBig）观测门——生产灰度复核需要区分
   * 「没触发（无 part_of 边/无 work_fact 卡）」与「触发了但证据选错/被预算裁掉」。
   * candidates = 卡的全部 part_of 证据候选数；kept = 实际注入的上下文行数。
   */
  smallToBig?: {
    /** #141（2026-10-28）：增 "slot" = 复合单元记账（结论+必带源证据按 slotCost 占槽）。 */
    mode: "shared" | "additive" | "slot";
    maxExtraLines: number;
    /** true = 按查询相关性排名取证据（#138 修复）；false = 旧序（逐位回滚档）。 */
    ranked: boolean;
    candidates: number;
    kept: number;
    /** #155：候选来源拆分——有 part_of 图边的卡数。 */
    evidenceFromLinks?: number;
    /** #155：图边为空但卡 metadata（evidence_ids / evidence_record_ids）有 id 而回退的卡数。 */
    evidenceFromMetadata?: number;
    /** #155：两条通道都没有证据 id 的卡数（真正的「无身世」卡，才需要补边脚本）。 */
    cardsWithoutEvidence?: number;
  };
  /**
   * #169 证据包观测门：enabled=true 时**恒出现**（含全零计数）——要能区分「没开」与
   * 「开了但一行都没扩成」，否则「+N 档没变好」无法归因到窗口/帽/会话缺失。
   * 口径边界：这些是 pack 行的独立计数，绝不并入 turnCov/sessionCov 等覆盖率指标
   *（pack 行由 bench 单列 adjacencyLines，见 scripts/lib/bench/inject-attribution.mjs）。
   */
  /**
   * A3（P1，2026-11-02）自述行过滤门：`recall.selfNarration.enabled=true` 时**恒出现**
   * （含全零计数）——要能区分「没开」「开了但库里没有 actor=agent 行」与「开了且真丢了 N 行」。
   * 口径：`scanned` 只数**有 recordId 的行**（metas 缺失行按未知保留、不计入），
   * `dropped` 是真正被移出注入候选池的行数；`skipped` 说明提前退出原因。
   */
  /**
   * B2（P3，2026-11-02）效期门；**F7（2026-11-02）改为三层口径**。
   *
   * 旧版只在截断前的全池上算一次、却命名为"这一轮丢了多少"——池里过期 ≠ 注入变少
   *（过期的行本来就可能落在 top 之外）。三层的定义与唯一用途：
   * - `pool`：合并后全池（截断前）。诊断"库里失效行被这一路看见多少"，**不可**当注入差额。
   * - `top`：截断后候选（maxResults 条）。诊断"进榜的里有多少失效"。
   * - `injected`：最终注入集。`injected.dropped` 就是本轮真被效期过滤掉、注入行数变少的量
   *   （hard 档；soft/off 档为 0，因为那时注入点不再二次过滤）。
   * 每层都是 `validityFilterStats` 的单一源输出（同一谓词、同一 accessors）。
   * `validEndFiltered` 保留 = pool.dropped，兼容既有读数脚本；新代码请直接用三层。
   */
  validity?: {
    mode: "soft" | "hard";
    pool: ValidityFilterStats;
    top: ValidityFilterStats;
    injected: ValidityFilterStats;
    /** @deprecated 等于 pool.dropped（池口径），不要当"少注入了多少行"。 */
    validEndFiltered: number;
  };
  selfNarration?: {
    enabled: boolean;
    dropped: number;
    scanned: number;
    skipped?: "disabled" | "self-query" | "empty";
  };
  evidencePack?: {
    enabled: boolean;
    adjacent: number;
    windowMinutes: number;
    maxExtraLines: number;
    seedLines: number;
    seedWithSession: number;
    adjacencyLines: number;
    skippedNoSession: number;
    skippedNoSeedRow: number;
    skippedWindow: number;
    skippedCap: number;
    skippedSessionTooLarge: number;
    sessionsQueried: number;
  };
  /**
   * P1-T7（worthiness importance）：重要度降权观测门——raw vs penalized 双分量
   * （乘子恒真实生效：penalized=实际排序分，raw 为反推值）。类型单一源
   * 在 recall-signals.ts（与乘子实现同文件，防止口径分裂）。
   */
  importancePenalty?: RecallJournalImportanceGate;
  /**
   * #141（2026-10-28）：结论层分阶段路由观测——意图、预算、顺序、成对与仲裁。
   * 灰度复核要能区分「没路由到（default）」与「路由到了但预算 0 / 证据缺失被丢弃」。
   */
  conclusionRouting?: {
    /** classifyRecallIntent 的结果；routing!=="intent" 时为 null。 */
    intent: string | null;
    mode: "off" | "assistantRecall" | "intent";
    /** 本次生效的结论行预算（null = 沿用 maxConclusions/半切缺省）。 */
    budget: number | null;
    order: "conclusion-first" | "turn-first";
    /** 是否强制结论必带源证据（生效值）。 */
    pairing: boolean;
    /** 是否启用表示仲裁（生效值）。 */
    arbitrate: boolean;
    /** 成对约束下因无 part_of 证据被丢弃的结论张数。 */
    unpairedDropped?: number;
    /** 表示仲裁让位的结论张数与阈值（arbitrate 生效时才写）。 */
    arbitrateDropped?: number;
    arbitrateThreshold?: number;
    /** slot 模式：记账后经验层额度与槽位成本。 */
    slotExperienceLimit?: number;
    slotCost?: number;
    /** 降级原因：回捞通道不可用（store 无 part_of 读面 / maxExtraLines=0 / 软失败）→ 成对约束跳过、结论保留。 */
    degraded?: "pairing-unavailable";
    /**
     * 被丢弃结论的样本（≤3 条，recordId + 原因）。只有计数无法回答「丢的是不是
     * 那道题的答案卡」——灰度过线后要复盘具体卡，必须能指名到记录。
     */
    droppedSamples?: Array<{ recordId: string | null; why: string }>;
  };
}

// P1-T7：类型再导出（journal 消费方 import 单一源 recall-journal 即可）
export type { RecallJournalImportanceGate, RecallJournalImportanceGateSpec } from "../tools/recall-signals.js";

/**
 * #61（2026-10-18）：/v3/recall v2 5000ms 硬超时贴脸——分段计时观测。
 * 全部为毫秒整数值；l2 段在 conclusionLayer.enabled=false 时恒为 0；
 * l1 段含 R7 经验行组装（slice/动态 topK/budget，同步微秒级）；
 * soul 段含 mood/state/soul-prefix 渲染全链。
 */
export interface RecallJournalPerfMs {
  total: number;
  scene: number;
  /**
   * #63（2026-10-18）：V2-2 LLM 查询扩展（getExpansionTerms，keyword/hybrid-fallback
   * 路消费）耗时。journal 实锤 l1=4305ms 中 ~4s 为 query-expand LLM 串行阻塞（真实
   * embedding RTT 仅 108ms），不拆本段会再次误诊为「embedding 慢」。native/embedding
   * 路零 LLM 调用 → 恒 0；qe.enabled=false → ≈0。
   */
  expand: number;
  l2: number;
  l1: number;
  soul: number;
}

/**
 * #179（2026-11-02）：选线观测面（mode:off 也记录——观测面不是行为开关）。
 *
 * 口径差：`kept` 是**本回合判定保留数**（fold 也计入淘汰档，故折叠后为 0——
 * 「判定保留」与「实际注入」在 fold 面前是同一个数，否则恒等式不成立），
 * `injected` 是**实际注入行数**。两者在 enforce/off 下相等；shadow 下
 * injected = kept + (ruler 判定丢弃数)，因为 shadow 只记录不裁剪。
 * 恒等式：kept + droppedBy.rank + .floor + .margin + .dup + .budget + .fold = candidates.total。
 *
 * v2（2026-11-02）：margin=层内相对尺淘汰、dup=近重复抑制淘汰；capped=被行长上限截断的
 * 渲染行数（截断不改判定，故不进恒等式）。
 */
export interface RecallJournalSelection {
  kept: number;
  injected: number;
  droppedBy: {
    rank: number;
    floor: number;
    margin: number;
    dup: number;
    budget: number;
    /** v3：超出本轮字符预算（injection.maxChars）而丢的行数。 */
    chars: number;
    fold: number;
  };
  capped?: number;
  /**
   * v3（2026-11-02）：候选池字符数（选前）。**口径澄清**：`memoryLines` 记的是候选池
   * （ruler 关闭时池=注入），所以「注入字符」只能从这里读——否则会误把池当注入（实测
   * 05:57:02 那轮池 1400 字符、注入 562）。
   */
  poolChars?: number;
  /** v3：实际注入字符数（选后 + 折叠后）。恒有 `injectedChars <= poolChars`。 */
  injectedChars?: number;
  /**
   * v3（2026-11-03）：本轮候选池为空（L1/scene/persona 三路全无命中），选线段根本没跑。
   *
   * 为什么仍要写这条零观测：`zeroInjectionRate` 的分母是「带 selection 的轮」，若空池轮
   * 什么都不写，它们就被静默排除在分母外，指标会系统性偏好（生产实测分母 1054、真实轮数
   * 远大于此）。同时用本字段把「池空」与「池非空但一行没注入」区分开——前者是召回缺失，
   * 后者是选线过紧，两种病不该合成一个数。
   */
  emptyPool?: boolean;
}

/** 尺子元信息：谁在生效、地板从哪来、是否降级 bypass、以及新增耗时（嵌入+纯选择）。 */
export interface RecallJournalRuler {
  mode: "off" | "shadow" | "enforce";
  /** 地板来源：config（配置显式）/ calibration（标定产物命中）/ uncalibrated（未标定=诚实 no-op）。 */
  floorSource: "config" | "calibration" | "uncalibrated";
  floor: number | null;
  keepRatio?: number;
  minPerLayer?: number;
  /** v2 生效参数（缺省即 off/0/null：不折扣、不相对裁、不去重、不截断）。 */
  lengthLambda?: number;
  margin?: number | null;
  dedupeSim?: number | null;
  maxLineChars?: number | null;
  /** v3：本轮字符预算（缺省 null = 未启用）。 */
  maxChars?: number | null;
  /**
   * 降级归因：注入与 mode:off 逐位一致。
   * - ruler-unavailable：嵌入报错/空向量/维度不符/长度不符；
   * - ruler-budget：本轮选线耗时超预算（SELECTION_BUDGET_MS=300），到点放弃。
   */
  bypass?: "ruler-unavailable" | "ruler-budget";
  /** v3：bypass 时改走原序字符预算兜底（配了 injection.maxChars 才出现）。 */
  fallback?: "char-budget";
  /** 新增耗时（毫秒）：嵌入批次 + 纯选择（规格 §5-e 的 300ms 判据用的是这个数）。 */
  ms?: number;
}

/** 同回合折叠观测：identicalLines>0 表示本轮注入被折叠为 0 行。 */
export interface RecallJournalFold {
  identicalLines: number;
}

/** 候选池逐条观测：只记可对账指纹，绝不行全文（规格 §4.6）。 */
export interface RecallJournalCandidateLine {
  layer: string;
  hash8: string;
  /** 查询×行 的余弦相似度（3 位小数）；未跑 embedding（off/bypass）时缺字段。 */
  scoreQ?: number;
  /** 注入层没有 BM25 相对分；结论层内部的 bm25Rel 不跨层搬。 */
  bm25Rel?: number;
  kept: boolean;
  droppedBy?: "rank" | "floor" | "margin" | "dup" | "budget" | "chars" | "fold";
}

export interface RecallJournalCandidates {
  total: number;
  byLayer: Record<string, number>;
  bm25Exempt: number;
  /** 上限 40 条；超限 truncated=true，但 total/byLayer/droppedBy 汇总完整。 */
  lines: RecallJournalCandidateLine[];
  truncated?: true;
}

export interface RecallJournalEntry {
  ts: string;
  query: string;
  strategy: string;
  teamId: string;
  userId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionReused: boolean;
  layered: boolean;
  conclusionCount: number;
  experienceCount: number;
  searchTiming: RecallJournalSearchTiming;
  /**
   * P0-2 验证（issue #2，Spec 终审 a1 落实 2026-10-13）：召回门槛观测——门生效且
   * 有淘汰时记录 kept/dropped（挡下率对比）。缺字段 = 门未启用或未淘汰。
   */
  gates?: RecallJournalGates;
  /** #61 分段计时观测（毫秒）；缺字段 = 旧入口未打点。 */
  perfMs?: RecallJournalPerfMs;
  block?: string;
  memoryLines: string[];
  /**
   * #74（Batch A，2026-10-20）：跳过语义注记。skip 路是独立语义入口（如端点路纯
   * 脚手架查询整条跳过：零检索零注入零指标上报），以 skipReason="scaffold-query"
   * 区分于正常召回条目；缺字段 = 正常召回（向后兼容旧条目与旧消费方）。
   */
  skipReason?: string;
  /** #88：skip 行双留痕（闸门失明定界）——原文截断 120 字符。仅 skip 行携带；缺字段=正常召回。 */
  rawQuery?: string;
  /** #88：skip 行原文 UTF-16 长度。 */
  rawLen?: number;
  /** #88：skip 行原文 sha256 前 8 hex。 */
  rawHash8?: string;
  /** #88：skip 行剥噪残差（sanitizeRecallQuery.residualChars）。 */
  residualChars?: number;
  /** #179：选线判定（mode:off 也记录；缺字段 = 旧入口未接线）。 */
  selection?: RecallJournalSelection;
  /** #179：尺子元信息（含 bypass 降级归因与新增耗时）。 */
  ruler?: RecallJournalRuler;
  /** #179：同回合折叠观测。 */
  fold?: RecallJournalFold;
  /** #179：候选池观测（≤40 条，单轮新增 <4KB）。 */
  candidates?: RecallJournalCandidates;
}

export interface RecallJournalTenant {
  teamId: string;
  agentId?: string;
}

export interface RecallJournalOpts {
  enabled: boolean;
  rotationSizeMB: number;
  maxFiles: number;
}

/** 租户分文件名（缺省 agent 兜底 default；组件 encode 防路径注入）。 */
export function recallJournalFileName(tenant: RecallJournalTenant): string {
  return `recall-journal-${encodeURIComponent(tenant.teamId || "default")}-${encodeURIComponent(tenant.agentId || "default")}.jsonl`;
}

function rotateOldFiles(basePath: string, maxFiles: number): void {
  // 轮转语义：当前文件满 → 改名 .1.jsonl（扩展名保留在尾）；旧 .k.jsonl 顺延 .(k+1).jsonl；
  // 总数（含当前）≤ maxFiles。stem=去掉 .jsonl 扩展后的基名。
  const rotatedKeep = Math.max(maxFiles - 1, 0);
  const stem = basePath.endsWith(".jsonl") ? basePath.slice(0, -".jsonl".length) : basePath;
  for (let i = rotatedKeep; i >= 1; i--) {
    const from = i === 1 ? basePath : `${stem}.${i - 1}.jsonl`;
    const to = `${stem}.${i}.jsonl`;
    if (fs.existsSync(from)) {
      try {
        fs.rmSync(to, { force: true });
        fs.renameSync(from, to);
      } catch {
        /* 单轮失败不影响写入 */
      }
    }
  }
}

export function appendRecallJournal(
  journalDir: string,
  tenant: RecallJournalTenant,
  entry: RecallJournalEntry,
  opts: RecallJournalOpts,
): void {
  try {
    if (!opts?.enabled) return;
    fs.mkdirSync(journalDir, { recursive: true });
    const file = path.join(journalDir, recallJournalFileName(tenant));
    const line = `${JSON.stringify(entry)}\n`;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* 新文件 */
    }
    const limit = Math.max(opts.rotationSizeMB ?? 5, 0) * 1024 * 1024;
    if (size > 0 && limit > 0 && size + Buffer.byteLength(line, "utf8") > limit) {
      rotateOldFiles(file, Math.max(opts.maxFiles ?? 5, 1));
    }
    fs.appendFileSync(file, line, "utf8");
  } catch {
    // best-effort（拍板定案）：日志失败零影响主链路，绝不抛出。
  }
}
