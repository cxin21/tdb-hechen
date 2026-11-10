/**
 * soul/worker.ts —— 自维护人格后台工作者（m00527，2026-11-05 用户拍板「LLM 全自动维护、
 * 全生命周期 0 人工参与」，禁止框架态）。
 *
 * 一轮做的事（全部确定性可测，LLM 只是候选来源之一）：
 *  1) 存量槽导入（首次迁移）：core_memory 的 identity/self_identity/strict_rule/core_value
 *     逐行过 classifyLine——事件句/阶段词/项目专名/纯方法论进 method 池（不注入），
 *     红线进 boundary，两难句进 values，第一人称特质进 identity。
 *  2) 语料生长：近 windowDays 的 L1 记录逐句分类，同一句在不同记录里独立出现 ≥ minEvidence
 *     次才准入（证据独立性门 + 事件句门 + 两难门 + 变更率门 + 预算门，全在 gates.ts）。
 *  3) LLM 候选（可选）：rewriter 产出的 {layer,text} 与语料候选同门同权处理——LLM 不获得
 *     任何写权，只是又一个候选来源（证据仍需来自真实记录 id）。
 *  4) 生命周期：30 天无新证据降级（weight×0.7 且降序），90 天或矛盾 2 次冻结（退出注入，
 *     保留可复活）；新证据命中即复活。只增不减——任何路径都不删除条目。
 *  5) 合并：同层相似 ≥ mergeSimilarity 并入权重最高者，被并者 state=merged + mergedInto +
 *     别名累积（可拆回）。
 *  6) 心境：L1 affect 信号 → 情绪事件（对象未知标「未定位」）→ 按半衰期积分成心境，
 *     写 soul_state（既有表）——与基线比而非绝对档位。
 *  7) 账本：准入/拒绝/更新/合并/降级/冻结/复活逐条落 soul_ledger（含 gates/reason/
 *     before 快照）——0 人工审核的前提是全程可回放、可回滚，而不是「相信模型」。
 *
 * 一切外部依赖都可缺席：缺 store 方法=该阶段跳过并如实标注 skipped（不假装成功）。
 */
import type { CoreTenant, IMemoryStore } from "../store/types.js";
import type { Logger } from "../types.js";
import {
  personProfileMaxPerTick,
  type PersonProfileReport,
  type PersonProfileStorePort,
  type PersonProfiler,
} from "../person/profile-distiller.js";
import {
  resolveSoulConfig,
  type EvidenceOrigin,
  type PersonaItem,
  type SoulBudgetReport,
  type SoulEmotionRecord,
  type SoulEpisode,
  type SoulGateStatBump,
  type SoulLayer,
  type SoulLedgerEntry,
  type SoulMaintenanceConfig,
  type SoulRejectionStat,
} from "./types.js";
import {
  episodeDigest,
  emotionEventFromEpisode,
  emotionObjectForEpisode,
  episodeRepaired,
  EPISODE_PER_SESSION_PER_TICK,
  EPISODE_SPEAKER_PLATFORM,
  mineEpisodes,
  personsForEpisode,
} from "./episode.js";
import { normalizePersonName, resolvePerson } from "../person/resolve.js";
import { normalizePersonNameCandidate } from "../record/person-hints.js";
import type { AgentProfileLike } from "./agent-profile.js";
import type { SoulPerson } from "../person/types.js";
import { clampRedlines, mergeDuplicateRedlines } from "./card.js";
import { chargeCall, openCostBudget, redactSecrets } from "./guard.js";
import { contradictRepairClaims, factsFromEpisode, historyItemNeedsUpdate, historyToItems, reversals, settlePromises } from "./history.js";
import { SEED_LABELS, TRAIT_PROTOCOL_VERSION, emptyAxisVector, l1Norm, seedStateFromSeeds, type AxisVector } from "./traits.js";
import { assembleSoulCard } from "./card-service.js";
import { recordSoulDrift } from "./observation.js";
import {
  driftTraits,
  resolveLabelProposals,
  seedLabelRows,
  type TraitProtocolOutput,
} from "./trait-drift.js";
import type { MoodState } from "./emotion.js";
import { allPass, classifyLine, evaluateCandidate, isSelfVoice, normalizeText, personaLength, stripBullet, textHash, textSimilarity } from "./gates.js";
import {
  consolidatePersona,
  freezeItem,
  hasValidTo,
  layerUsedChars,
  planAdmit,
  planContradiction,
  planLifecycle,
  planMerge,
  planRevive,
  planUpdate,
  renderLayerWithBudget,
} from "./persona.js";
import { itemHash as itemHashOf } from "./consolidator.js";
import { integrateMood, emotionFromSignal, activeEmotions, readMood, renderMoodLine, moodBiasLine, decayedIntensity, isReusableAffectObject, isEmotionExpired, isStoredEmotionExpired, pickCurrentEmotion, moodFocusOf, moodGrowthGate, EMOTION_LABELS, EMOTION_TEMPLATE_VERSION, rankLabelsByPad, EMOTION_PAD_NEAR_MAX } from "./emotion.js";
import { canSelfReset, measureDrift, pushDrift, trackOf } from "./drift.js";

/** 语料记录（由调用方从 L1 读取；worker 不直接耦合 L1 表结构）。 */
export interface SoulEvidenceRecord {
  id: string;
  content: string;
  occurredAt?: string;
  valence?: number | null;
  arousal?: number | null;
}

/** LLM 候选（可选来源；返回值仍要过全部确定性门）。 */
export interface SoulRewriteRequest {
  existing: Array<{ layer: SoulLayer; text: string }>;
  records: string[];
  maxCandidates: number;
  /** 本轮独立证据下限（与 cfg.minEvidence 对齐，避免 prompt 说 2、门要 3 的自相矛盾）。 */
  minEvidence?: number;
  /** 事件摘要行（ep-* | kind | day | 对象 | 双方原话 | 代价）。人格主张必须挂在这里。 */
  episodes?: string[];
  /** voice few-shot 的合法来源：「用户原话 | record_id」。 */
  voiceQuotes?: string[];
  /** 此刻的心境行（相对基线偏离 + 真实原因）；让生成侧知道「现在」而不只是「一贯」。 */
  moodLine?: string;
  /** 此刻的判断倾向（由心境+对象确定性生成）；空=无对象/未偏离，不伪造。 */
  moodBias?: string;
  /** 关系层要指名的人。 */
  personName?: string;
}
export type SoulRewriter = (
  req: SoulRewriteRequest,
) => Promise<
  Array<{
    layer: string;
    text: string;
    evidenceIds?: string[];
    /** voice 专用：必须逐字来自 voiceQuotes。 */
    fewShot?: Array<{ quote: string; recordId: string }>;
  }>
>;

export interface SoulWorkerDeps {
  store: Pick<
    IMemoryStore,
    | "listSoulPersona"
    | "commitSoulPersona"
    | "readSoulState"
    | "writeSoulState"
    | "recentAffectSignals"
    | "listSoulLedger"
    | "commitSoulEpisodes"
    | "commitSoulEmotions"
    | "deleteSoulEpisodes"
    | "listSoulEpisodes"
    | "markSoulEpisodesMoodIntegrated"
    | "recentL0Messages"
    | "soulMetaGet"
    | "soulMetaSet"
    | "soulRejectionStats"
    | "bumpSoulGateStats"
    | "hasSoulAlertSince"
    | "rollbackSoulPersona"
    | "upsertSoulPromise"
    | "transitionSoulPromise"
    | "listSoulPromises"
    /* S4：特质层（state 是漂移唯一事实源，标签是方向视图） */
    | "readSoulTraitState"
    | "writeSoulTraitState"
    | "listSoulTraitLabels"
    | "commitSoulTraitLabels"
    /* P2-E：事件挂人（resolvePerson 只用到三个可选方法） */
    | "upsertSoulPerson"
    | "getSoulPersonByPlatform"
    | "listSoulPersons"
  >;
  tenant: CoreTenant;
  now?: string;
  config?: Partial<SoulMaintenanceConfig>;
  trigger: string;
  /** 近窗语料（缺省=不生长，只做存量导入/生命周期/心境）。 */
  recentRecords?: () => Promise<SoulEvidenceRecord[]>;
  /** 事件挖掘输入（L0 原始对话）。缺省时退回 recentRecords 做兼容，但会损失「原话」。 */
  recentL0?: () => Promise<
    Array<{
      record_id: string;
      session_id: string;
      role: string;
      message_text: string;
      recorded_at?: string;
      timestamp?: number;
    }>
  >;
  rewriter?: SoulRewriter;
  logger?: Logger;
  /** 向量器（漂移检测用）；缺席=漂移阶段跳过并如实标注，绝不用词面相似伪造分数。 */
  embed?: (text: string) => Promise<number[]>;
  /**
   * S6 单产线：identity/self_identity 事实的取数接缝（identity-discovery 的 collectIdentityFacts）。
   * worker 只把返回的事实当作**候选**，与语料/rewriter 走同一 mergeCandidates、同一准入判据、
   * 同一 commitSoulPersona 事务——不另开写径。缺席=该来源不参与（如实不假装）。
   */
  identityFacts?: () => Promise<Array<{ layer: "identity" | "self_identity"; text: string; evidenceIds: string[] }>>;
  /**
   * S6 红线投影接缝：每 tick 读一次 meta_agent_persona 的 active 红线，投影进 core_memory.strict_rule，
   * 与 persona upsert / 账本同一事务（判据 2：表单保存后 ≤1 tick 覆盖 100%）。
   * 缺席=不投影（不假装写成功）。跨库读取由 gateway 注入（worker 不碰 metadata 库）。
   */
  readAgentProfile?: (agentId: string) => Promise<AgentProfileLike | null>;
  /** 本轮 LLM 调用上限。缺省 1。0 = 本轮禁止调用。 */
  llmCallBudget?: number;
  /**
   * S4 判侧（[TRAIT-PROTOCOL v1]）：只看本轮新增 episode 的显式行为，吐票与标签提案。
   * 缺席 = 不动特质（如实标注 traitSkipped），绝不用词面相似伪造性格漂移。
   */
  traitJudge?: (episodes: SoulEpisode[]) => Promise<TraitProtocolOutput>;
  /**
   * P2-H：人物档案提炼通道（spec 2026-11-08）。缺席 = 本轮不跑档案、不写水位，
   * 且 `report.personProfile` 保持 undefined（A10 的可执行口径：没接线就必须什么都不发生）。
   * 它是独立的一次 LLM 调用，不吃 `llmCallBudget`——预算只约束「我」的改写，
   * 档案通道有自己的人数额度（`personProfileMaxPersons`）。
   */
  personProfiler?: PersonProfiler;
  /** A12：本轮最多提炼几个人。缺省按 `min(8, maxUpdatedPerCycle*2)` 算。 */
  personProfileMaxPersons?: number;
}

/** 单条条目的漂移结果（可审计；分数来自与真实行为锚的比对，不是自比）。 */
export interface SoulDriftReport {
  layer: SoulLayer;
  itemId: string;
  score: number;
  track: "voice" | "judgment";
  verdict: "ok" | "degrade" | "freeze";
  consecutive: number;
  method: "embedding" | "lexical";
}

export interface SoulMoodReport {
  mood: MoodState;
  line: string;
  activeEmotions: number;
  written: boolean;
  skipped?: string;
  /** 本轮事件实际触发的情绪分布（label → 条数）：上线后先看这张表，而不是只看一条心境行。 */
  labels?: Record<string, number>;
  /** 本轮零触发的模板：语料没给到那种场，或缺对应判据——缺哪种都要说得出来。 */
  dormant?: string[];
  /**
   * 心境门可观测性：门开没开、没开是因为什么。只报告不参与判断——
   * 生产上「门到底会不会响」必须能从 report 里读出来，不能只靠事后猜。
   */
  gate?: {
    focus: string;
    object: string;
    hits: number;
    opened: boolean;
    declined?: "no_live_emotion" | "object_missing" | "count_below_2" | "not_deferred";
    /** 本轮窗口内的事件数与「抽不出对象」的条数：对象锚是否可达的直接证据。 */
    episodes: { total: number; objectMissing: number };
  };
}

export interface SoulWorkerReport {
  /** 节流说明：LLM 改写/漂移未到期，本轮只跑便宜阶段（如实标注，不假装跑过）。 */
  cadenceSkipped?: string;
  at: string;
  trigger: string;
  tenant: CoreTenant;
  stored: boolean;
  imported: number;
  admitted: number;
  /** α 内有界改写（同一 itemId 文本更新）的条数。 */
  updated: number;
  rejected: number;
  /** 跨层换条：同文条目按最新分类口径换到另一层（避免同一句在两段里各出现一次）。 */
  reclassified: number;
  /** 存量槽导入退出人格注入层（冻结，下沉为操作约束；不删除）。 */
  retired?: number;
  /** 从事件确定性长出的自我/关系史条数（不经 LLM，不计 admitted）。 */
  historyAdded?: number;
  /** 规则收紧后不再构成事实、退出注入的旧事件史条数。 */
  historyRetired?: number;
  /** 承诺层：本轮从事件史建/核的承诺（open 新建、kept/broken 迁移）；失败只跳过不阻断。 */
  promises?: { created: number; kept: number; broken: number; skipped: number };
  merged: number;
  /** 结论合并（P1-1）：本轮被标失效的条数（state 不变，只写 validTo/supersededBy）。 */
  consolidated?: number;
  degraded: number;
  frozen: number;
  revived: number;
  ledgerEntries: number;
  budgets: SoulBudgetReport[];
  mood: SoulMoodReport | null;
  rejections: Array<{ layer: string; text: string; codes: string[]; detail?: string }>;
  /** 拒绝原因分布（top 在前）：判据调得对不对，先看拒的都是什么。 */
  rejectTop?: Array<{ code: string; count: number }>;
  /** 近 30 天拒绝原因分布（账本聚合）：本轮 rejectTop 只看得到这一轮，跨轮趋势要读账本。 */
  rejectHistory?: SoulRejectionStat[];
  /** 事件层本轮实况：挖到多少、新落库多少、可检索池多大、各 kind 分布。 */
  episodes?: { mined: number; inserted: number; available: number; byKind: Record<string, number>; purged?: number };
  /** P0-1 stats：本轮挖掘出的候选事件总数（落库前，含被 cap 留下的）。 */
  episodeCandidates?: number;
  /** P0-1 stats：真正站住人格层的候选事件数（kind!=="work" 且有 layers）。 */
  personaCandidates?: number;
  /** P0-1 stats：候选事件按 kind 的分布（挖掘侧口径，与 episodes.byKind 的库内口径区分）。 */
  byKind?: Record<string, number>;
  /** P0-1 stats：只作上下文、不投人格层的事件数（work）。 */
  contextOnly?: number;
  /** B1：本轮因「每会话每 tick 上限」被留下（不顺延丢弃）的新事件条数，无则 0。 */
  episodeCapSkipped?: number;
  /** 本轮真正积进心境的事件条数（未打标、非 work；2026-11-08 起按事件打标，不再用时间水位）。 */
  moodEpisodesIntegrated?: number;
  /** S6 单产线：identity 取数本轮产出（proposed=取数条数，candidates=真正进候选数组的条数）。 */
  identity?: { proposed: number; candidates: number; skipped?: string };
  /** S6 红线投影：active=表单侧仍有效条数，projected=真正写进 strict_rule 的行数。 */
  redlines?: { active: number; projected: number; merged?: number; retired?: number; skipped?: string };
  /** 漂移判定（逐条）；无向量器时为空且 driftSkipped 说明原因。 */
  drift: SoulDriftReport[];
  driftSkipped?: string;
  /** S4 特质层实况：本轮票数、逐轴净票与位移、标签准入/合并/拒绝。 */
  trait?: {
    changed: boolean;
    votes: number;
    rejectedVotes: number;
    /** 采用票数（=votes）与 driftTraits 挡下的票数（单轴超 ±0.05 / L1 超 0.5 / 迟滞），汇总日志用同一口径。 */
    applied: number;
    rejected: number;
    /** 逐轴位移（只有 delta≠0 才有意义；axes 的轻量视图，方便日志/汇总直接读）。 */
    deltas: Array<{ axis: string; delta: number }>;
    l1Clamped: boolean;
    stateL1: number;
    axes: Array<{ axis: string; net: number; delta: number; reason?: string }>;
    labels: { admitted: number; merged: number; rejected: number };
  };
  /**
   * 特质阶段未跑的原因，三态不静默：
   * `no_trait_judge`（没配判侧）/ `no_new_episode`（有判侧但本轮没新增事件）/
   * `judge_failed`（判侧抛错，或返回零票且 invalid>0——原始输出非空却没解析出一条可用票）。
   */
  traitSkipped?: "no_trait_judge" | "no_new_episode" | "judge_failed" | `trait_failed: ${string}`;
  /** D3：本轮把表单特质写成 seedState 了吗（左栏「你设定的」数据源）。 */
  seedState?: { written: boolean; from: "form" | "prev" };
  /** D5：tick 末组装的卡（内容变才追加 soul_snapshots 一行）。 */
  card?: { version: number; hash: string; chars: number; dirty: boolean; seeded: boolean };
  cardSkipped?: string;
  /**
   * P2-H：人物档案通道的本轮账（候选/实际/推迟/成败/丢弃原因）。
   * 只有注入了 `personProfiler` 才出现——没接线时保持 undefined，让「没跑」与「跑了但 0 条」可区分。
   */
  personProfile?: PersonProfileReport;
  /** 运行告警：可观测指标，不静默。语言未覆盖 / 情绪标签长尾（零实例标签过多）。 */
  alerts?: Array<{
    code: "language_unmapped" | "emotion_label_sparse" | "rollback_applied";
    /**
     * control = 有确定性读者，会改变下一轮行为（language_unmapped → 停 LLM 改写；
     * rollback_applied → 已实际改库）。
     * diagnostic = 只用来说明判据与语料脱节，没有控制动作：emotion_label_sparse 每轮
     * 都会触发（24 类里零实例 ≥12 是这份语料的常态），拿它当门会把人格永久冻住。
     * 分这一类不是为了「看起来闭环」，是为了让「没有读者」是写下来的决定，而不是被忘记。
     */
    class: "control" | "diagnostic";
    detail: string;
    records: number;
    admitted: number;
    updated: number;
  }>;
  skipped?: string;
}

const INJECTED: SoulLayer[] = ["voice", "identity", "self", "values", "boundary", "relationship", "narrative", "human"];

/** 从语料里挖候选：逐句分类，按归一化文本聚合独立记录 id（证据计数）。 */
export function mineCandidates(
  records: SoulEvidenceRecord[],
  cfg: SoulMaintenanceConfig,
): Array<{ layer: SoulLayer; text: string; evidenceIds: string[] }> {
  const byText = new Map<string, { layer: SoulLayer; text: string; ids: Set<string> }>();
  for (const rec of records) {
    const content = typeof rec.content === "string" ? rec.content : "";
    if (content === "") continue;
    // 英文句子以 .!? 断句；中文按原有标点。
    for (const raw of content.split(/[\n。；;]|(?<=[.!?])\s+/u)) {
      const text = stripBullet(raw).trim();
      // 长度按人格单位折算（CJK=1、非 CJK=0.4）：英文长句不再被中文字数上限静默丢掉。
      if (text.length < 6 || personaLength(text) > cfg.maxItemChars.identity) continue;
      const cls = classifyLine(text);
      if (cls.layer === null || !INJECTED.includes(cls.layer)) continue;
      const key = normalizeText(text);
      const cur = byText.get(key);
      if (cur) cur.ids.add(rec.id);
      else byText.set(key, { layer: cls.layer, text, ids: new Set([rec.id]) });
    }
  }
  return [...byText.values()].map((v) => ({ layer: v.layer, text: v.text, evidenceIds: [...v.ids] }));
}

/**
 * LLM 候选来源（可选）：把「最近的记录」压缩成 0..maxCandidates 条人格候选。
 *
 * 关键约束（与 gates.ts 同口径，写进 prompt 是为了省 token，不是因为信它）：
 *  - 不许复述事件/进度/项目进度；
 *  - 价值观必须是「两件事打架时站哪边」，方法论一律不要；
 *  - 红线必须是禁令形态、带触发场景；
 *  - 每条必须点名支撑它的记录 id——空证据会被 evidenceIndependence 拒。
 * 返回值仍全部过确定性门；LLM 只提候选，不写库（0 人工的前提）。
 */
export const SOUL_REWRITE_SYSTEM_PROMPT = [
  "你是助手「我」的第一人称作者：输入不是日志，是我和他真实发生过的分歧、纠正、拍板与取舍（episode），以及我自己的原话（quotes）。",
  "任务：从事实里提炼「我」在冲突中稳定站哪边、我说话什么调子、我从什么来路走到今天。你不是在写他的简历，也不是在写工作规范；不要把他写成主语来替我立人格。",
  "只输出 JSON 数组，元素形如 {\"layer\":\"identity|self|values|boundary|relationship|voice|narrative|human\",\"text\":\"...\",\"evidenceIds\":[\"ep-xxxx\"],\"fewShot\":[{\"quote\":\"逐字原话\",\"recordId\":\"r-xxx\"}]}。fewShot 只有 voice 需要。",
  "硬性规则（违反任何一条，这条会被确定性判据丢弃，不是被人类审掉）：",
  "1. identity / values / narrative 的 evidenceIds 必须是 ≥{{MIN_EVIDENCE}} 个不同的 ep-* id；voice 至少 1 个 ep-* 外加 2 条真实原话。给不出就这一层不输出，不要凑。",
  "2. identity 必须是一句「我站在哪边」的立场，不是形容词、不是自我要求。反例：我很严谨 / 我应该先验证。正例：我宁可慢一点把账算清，也不拿一个漂亮的假绿过关。",
  "3. values 必须同时写出冲突的两边和代价：宁可…也不… / 与其…不如… / 即使…也要…，并且点名放弃了什么（时间、速度、面子、某个结果）。只写「我重视质量」不算价值。value 还必须指向一个「没有产出也要守」的东西（体面、尊严、诚实、好奇、审美、不伤害、心安）；纯效率取舍会被 intrinsic_missing 拒；可以说「宁可交回没核实的那格，也不说没问题」「宁可当场跑一遍，也不照记忆写」。",
  "4. voice 写「我怎么说话」，必须是第一人称（句中出现「我」，且不得以「他/她/用户/对方」开头）；给 2 条 fewShot，quote 逐字抄自「我的原话」区（assistant 消息），recordId 也照抄；text 只写一句 ≤120 字的总述（句子长短、语气、称呼、标点、爱用的词），原话只放 fewShot，不要抄进 text，抄进去会超形态上限被整条丢弃。我的原话不足 2 条就不写 voice。禁止把他的原话或他的说话风格写成 voice。",
  "5. narrative 只写一段 100-160 字的「来路」：从哪来、放弃了什么、为什么变成现在这样。只许引用 ep-* id，不许写方法论，不许写「我学会了…」式总结。",
  "6. boundary 只写禁令：不做什么 + 在什么情形下，一句 ≤120 字。不要写「应该做什么」。历史操作红线已在操作约束层，不要抄进 boundary；boundary 只放你为他守着、且为此付过代价的自我边界。",
  "7. self 是自我模型：从「我当时的说法」（agent_stance）里提炼我答应过自己什么、我不愿变成什么、我怕自己变成什么。必须写成「我承诺/我答应自己/我不愿变成/我怕自己…」，≤120 字，并挂 ≥{{MIN_EVIDENCE}} 个我实际表过态的 ep-*；只有他说、我没表态的不算。",
  "8. relationship 只写被他原话证实过的关系事实（他怎么说我们之间），必须点名「{{PERSON}}」或「他/你」，并在句子里用「」逐字引他一句原话（≥8 字），挂 ≥{{MIN_EVIDENCE}} 个有原话的 ep-*。不写猜测与评价，不把协作合同/环境配置写成关系；没有原话就不写这一层。",
  "9. 任何一条都不许出现：日期、票号、commit、文件路径、项目名、工具名、数字指标、本次/本轮/该票。出现即被判为「事件」丢弃。",
  "10. 不许写流程、步骤、SOP、经验法则；不许把「我怎么做事」伪装成「我是谁」。",
  "11. 每条 ≤160 字；宁缺毋滥，证据不够就返回 []。不要复述已有条目。",
  "12. 不写 human 层：这一层（「关于你」的人物档案）由另一个专门的人物提炼器独写，它知道每条属于哪个人、有字段级过期。你这里如果要表达「他是谁/他最近在做什么」，就落到 relationship（我们之间发生的关系事实，仍须逐字原话）或 self（我答应过自己什么）；两类都不成立就返回 []，不要换个层塞进去。",
  "13. 先看「已有条目」再决定写哪层：identity 活跃少于 3 条时优先补 identity（他反复站在哪一边，是最稳的人格）；同义条目已经很多（尤其 voice）就不要再加；values 与 relationship 是另外两层易空的，若事件里确有取舍/他原话，优先补它们，不要用又一条 voice 占满 {{MAX_CANDIDATES}} 条。",
  // P0-3（v4 抽取契约）：禁抽清单自己消化成中文，不引用任何外部项目名。
  // A1 事故的根因不是「assistant 说的话不算」，而是把它的元叙述/即时反应当成了事实
  // （从「我的名字是 X」那段解释里抽出一个名字）。所以禁抽按语义分三类，
  // 并显式写清「可核对事实仍要抽」，否则模型会把规则读成「我说话一律无效」。
  "禁止抽取（这些是对话里的噪声，不是稳定成立的「关于我」；出现即丢弃，不要换个层收进来）：",
  "14. 不抽对我的模糊性格描述：「你看起来很热情」「这听起来很有压力」这类对话中的即时评价与推测，除非他明确确认过这是长期看法。",
  "15. 不抽寒暄与情绪附和：「好的」「收到」「这个问题问得好」「没问题，我来」这类应答只表示收到，本身不含任何事实。",
  "16. 不抽关于我自身能力的元叙述：「我是一个由某某驱动的模型」「我可以帮你做…」「我擅长…」这类自我介绍与能力宣称，是包装不是事实。",
  "17. 但我说出的可核对事实仍要抽：「我把它改成 Arco 组件库了」「这行代码在 a.ts:42」能回到原话逐字核对，属于事实，不许因为出自我的口就当成噪声；写成条目时仍要过第 9 条（不带路径/项目名），必要时改写成不含路径的说法。",
  "18. 每条事实都必须能指回某条具体消息：evidenceIds 里的 ep-* 与 fewShot 的 recordId，必须是输入里真实存在、且能在该条消息原文里找到这句话的那一条；指不回去的宁可不写，不要拿别的 id 凑数。",
].join("\n");

export function buildSoulRewritePrompt(req: SoulRewriteRequest): string {
  const existing = req.existing.length
    ? req.existing.map((e) => `- [${e.layer}] ${e.text}`).join("\n")
    : "（无）";
  // 每行带 id：prompt 要求 evidenceIds 来自输入，不把 id 给出去等于让它编。
  // 不要加「1.」序号——行首就是 id，模型直接抄；加序号会让它把序号当 id。
  const episodes = (req.episodes && req.episodes.length > 0 ? req.episodes : ["（本轮无事件）"]).join("\n");
  const quotes = (req.voiceQuotes && req.voiceQuotes.length > 0 ? req.voiceQuotes : ["（本轮无我的原话）"]).join("\n");
  const records = req.records.length > 0 ? req.records.join("\n") : "（无）";
  return [
    `已有条目（不要重复，可以提出更准确的改写）：\n${existing}`,
    `事件（每行：ep-id | kind | day | 对象 | 他当时的原话 | 我当时的说法 | 代价 | 情绪）：\n${episodes}`,
    `我的原话（assistant 消息，每行：「原话」 | recordId；voice 的 fewShot 只能抄这里）：\n${quotes}`,
    ...(req.moodLine ? [`此刻的心境（相对基线，不是人格）：${req.moodLine}`] : []),
    ...(req.moodBias ? [`此刻的判断倾向（只影响这一次同类情境，不要写成长期人格）：${req.moodBias}`] : []),
    `补充语料（L1 摘要，仅作旁证，不能单独当身份证据）：\n${records}`,
    `最多输出 ${req.maxCandidates} 条候选。没有稳定成立的东西就输出 []。`,
  ].join("\n\n");
}

/** 从 LLM 原始输出里抠 JSON 数组（容忍 \`\`\`json 围栏与前后废话）。 */
export function parseSoulRewriteOutput(raw: string): Array<{
  layer: string;
  text: string;
  evidenceIds?: string[];
  fewShot?: Array<{ quote: string; recordId: string }>;
}> {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Array<{
    layer: string;
    text: string;
    evidenceIds?: string[];
    fewShot?: Array<{ quote: string; recordId: string }>;
  }> = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const o = it as { layer?: unknown; text?: unknown; evidenceIds?: unknown; fewShot?: unknown };
    if (typeof o.layer !== "string" || typeof o.text !== "string") continue;
    const ids = Array.isArray(o.evidenceIds) ? o.evidenceIds.filter((x): x is string => typeof x === "string") : undefined;
    let fewShot: Array<{ quote: string; recordId: string }> | undefined;
    if (Array.isArray(o.fewShot)) {
      fewShot = o.fewShot
        .map((q) => {
          if (!q || typeof q !== "object") return null;
          const qo = q as { quote?: unknown; recordId?: unknown };
          if (typeof qo.quote !== "string" || typeof qo.recordId !== "string") return null;
          return { quote: qo.quote, recordId: qo.recordId };
        })
        .filter((x): x is { quote: string; recordId: string } => x !== null);
    }
    out.push({ layer: o.layer, text: o.text, evidenceIds: ids, fewShot });
  }
  return out;
}

/** 把 LLMRunner 包成 SoulRewriter（调度器一行接线；解析失败=零候选，不抛）。 */
export function createSoulRewriter(
  runner: { run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number; maxTokens?: number }): Promise<string> },
  opts?: { taskId?: string; timeoutMs?: number; maxTokens?: number },
): SoulRewriter {
  const taskId = opts?.taskId ?? "memory.soul-maintenance";
  return async (req) => {
    const call = () =>
      runner.run({
        prompt: buildSoulRewritePrompt(req),
        systemPrompt: SOUL_REWRITE_SYSTEM_PROMPT.replaceAll("{{MIN_EVIDENCE}}", String(req.minEvidence ?? 3))
          .replaceAll("{{PERSON}}", req.personName ?? "他")
          .replaceAll("{{MAX_CANDIDATES}}", String(req.maxCandidates)),
        taskId,
        timeoutMs: opts?.timeoutMs,
        // 800 是历史缺省，对推理模型是死值：reasoning 先吃掉预算，content 为空、
        // finishReason=length（2026-11-05 生产实拍：每轮都空响应，候选恒 0，
        // 人格生成看似「判据太严」实则根本没到判据）。8192 给足推理+3 条短候选。
        maxTokens: opts?.maxTokens ?? 8192,
      });
    let raw: string;
    try {
      raw = await call();
    } catch (err) {
      // 只对「推理把 token 吃光」这一类空响应重试一次；超时/鉴权等照旧上抛，
      // 不把真实故障藏进「零候选」。
      const msg = err instanceof Error ? err.message : String(err);
      if (!/empty response|finishReason=length/i.test(msg)) throw err;
      raw = await call();
    }
    return parseSoulRewriteOutput(raw).slice(0, Math.max(0, req.maxCandidates));
  };
}

function ledgerOf(
  prev: PersonaItem | undefined,
  item: PersonaItem,
  now: string,
  trigger: string,
  action: SoulLedgerEntry["action"],
  reason: string,
  gates: string[],
): SoulLedgerEntry {
  return {
    entryId: `led-${item.layer}-${item.itemId}-${action}-${now}`,
    at: now,
    trigger,
    layer: item.layer,
    itemId: item.itemId,
    action,
    beforeHash: prev ? itemHashOf(prev) : undefined,
    afterHash: itemHashOf(item),
    gates,
    reason,
    evidenceIds: item.evidenceIds,
    before: prev ?? null,
    // 判据 13：每条账本都带判定协议版本，事后能追「这条是谁按哪版规则判的」。
    protocolVersion: TRAIT_PROTOCOL_VERSION,
  };
}

/** 认定为「同一条目的改写」所需的最低相似度（低于此=全新条目，进准入流程）。 */
export const UPDATE_MATCH_SIMILARITY = 0.55;

export interface SoulMergeCandidate {
  layer: SoulLayer;
  text: string;
  evidenceIds: string[];
  origins: ("l1" | "model" | "episode")[];
  /** 事件层证据（ep-*）；identity/values 需 ≥minEpisodeEvidence，narrative ≥1。 */
  episodeIds?: string[];
  /** voice 专属：逐字原话 + 来源记录 id。 */
  fewShots?: Array<{ quote: string; recordId: string }>;
}

export interface SoulMergeContext {
  updatesInWindow?: Partial<Record<SoulLayer, number>>;
  /** 本轮可引用的事件 id 池；给定时候选里的 ep-* 会被过滤到池内（治 LLM 编 id）。 */
  episodeIds?: Set<string>;
  /** voice few-shot 的合法原话池：recordId → 原文。 */
  voiceRecords?: Map<string, string>;
  /** 本轮事件池：self 层的「我表过态」判定要读 agentStance。 */
  episodesById?: Map<string, SoulEpisode>;
  /** P2-E：person_key → 展示名（human 条目 meta.person.displayName）。 */
  personNamesByKey?: Map<string, string>;
  /** 真实触发来源（lifecycle/import/replay/…），写进准入/改写/拒绝账本；缺省 "worker"。 */
  trigger?: string;
}

/**
 * S7 正向来源：只有「用户明确认可」或「事件 outcome 判定解决」才记 trust 事实。
 * 只产出 meta（来源 + 方向 + 时刻），不写文本——信任是证据给的，不是形容词堆出来的。
 */
export function trustMetaFromEpisodes(episodes: SoulEpisode[], now: string): Record<string, unknown> | null {
  const positive = (episodes ?? []).some(
    (ep) => /(?:解决|修复|通过|搞定|完成|有效|认可)/u.test(ep.outcome ?? "") || /(?:谢谢|认可|信任|不错|很好|靠谱|对了|可以)/u.test(ep.userStance ?? ""),
  );
  return positive ? { trust: true, direction: "up", positiveSource: "user_ack_or_resolved", trustUpdatedAt: now } : null;
}

function mergeCandidates(
  base: PersonaItem[],
  candidates: SoulMergeCandidate[],
  now: string,
  cfg: SoulMaintenanceConfig,
  userCorpus: string[],
  opts?: SoulMergeContext,
): {
  items: PersonaItem[];
  admitted: PersonaItem[];
  updated: number;
  rejections: Array<{ layer: string; text: string; codes: string[]; detail?: string }>;
  ledger: SoulLedgerEntry[];
  /** P0-2：本轮门拒按 (day, code, layer) 聚合后的增量（不落账本，进 soul_gate_stats）。 */
  gateStats: SoulGateStatBump[];
} {
  const map = new Map(base.map((i) => [i.itemId, { ...i }]));
  const admitted: PersonaItem[] = [];
  const rejections: SoulWorkerReport["rejections"] = [];
  const ledger: SoulLedgerEntry[] = [];
  // 账本 trigger 必须写真实来源：所有条目都写 "worker" 时，回放分不清
  // 「生命周期 tick 长出来的」和「导入/回放长出来的」，同一 entryId 也无法追溯触发面。
  const trigger = opts?.trigger ?? "worker";
  let updated = 0;
  const updatesThisRun = new Map<SoulLayer, number>();
  const voiceCorpus = [...userCorpus, ...(opts?.voiceRecords ? [...opts.voiceRecords.values()] : [])];
  // P0-2：拒绝不再逐条落账本（同一候选每 tick 都可能被拒，24h 785 行里 704 行是它，
  // 还把 6h 告警抑制所依赖的「最近 200 行」窗口挤出真实告警）。改按 (day, code, layer) 聚合，
  // 拒绝仍可按 code 统计——只是不再冒充「人格变更」占账本行。
  const gateStats = new Map<string, SoulGateStatBump>();
  const reject = (layer: SoulLayer, text: string, codes: string[], detail: string, evidenceIds: string[]) => {
    rejections.push({ layer, text, codes, detail });
    // 原文片段仍留在本轮 report.rejections 里（回放校准的输入），只是不进账本。
    const day = now.slice(0, 10);
    for (const code of codes.length > 0 ? codes : ["unknown"]) {
      const key = `${layer}|${code}`;
      const cur = gateStats.get(key);
      if (cur) cur.count += 1;
      else gateStats.set(key, { day, code, layer, count: 1, at: now });
    }
  };
  /**
   * P2-E：候选 → 唯一的在场人。
   * 只有 human 层挂人：identity/values/relationship 是「我」的人格，不该被某个自然人领走。
   * 0 人=不写（全局共性行，恒在场）；≥2 人=不写——同时涉及两人，归到谁都是猜。
   */
  const personMetaOf = (layer: SoulLayer, epIds: string[] | undefined): Record<string, unknown> | undefined => {
    if (layer !== "human") return undefined;
    const keys = new Set<string>();
    for (const id of epIds ?? []) {
      for (const key of opts?.episodesById?.get(id)?.persons ?? []) {
        if (typeof key === "string" && key !== "") keys.add(key);
      }
    }
    if (keys.size !== 1) return undefined;
    const key = [...keys][0]!;
    const displayName = opts?.personNamesByKey?.get(key) ?? "";
    return { key, ...(displayName === "" ? {} : { displayName }) };
  };
  for (const raw of candidates) {
    const existing = [...map.values()];
    // S5：情绪不再有否决权（mood_gate defer 语义退场）——情绪只影响判断倾向与
    // 排期记录（report.mood.gate 仍可观测），不能把一批有证据的候选整轮挡在门外。
    // 事件证据只认本轮真实存在的事件（LLM 编造的 ep-* 直接丢弃，不参与计数）。
    const episodeIds = opts?.episodeIds
      ? (raw.episodeIds ?? []).filter((id) => opts.episodeIds!.has(id))
      : raw.episodeIds;
    const fewShots = raw.fewShots
      ? raw.fewShots.filter((q) => (opts?.voiceRecords ? opts.voiceRecords.has(q.recordId) : true))
      : undefined;
    const cand: SoulMergeCandidate = { ...raw, episodeIds, fewShots };
    // P2-E：这条候选最终归属的唯一在场人（只有 human 会命中，见 personMetaOf）。
    const person = personMetaOf(cand.layer, cand.episodeIds);
    // S7 关系对象化：按 object 聚类，每人 ≤3 行。当前只有一个「他」，因此同一桶计数；
    // 到上限就不再新增，转而靠 α 改写合并——关系是史，不是越堆越多的档案。
    // 放在内容门之前：池结构上限与「这条写得像不像关系」是两件事，先答能不能加。
    if (cand.layer === "relationship") {
      const activeRel = [...map.values()].filter((i) => i.layer === "relationship" && i.state !== "merged" && i.state !== "frozen");
      if (activeRel.length >= 3) {
        reject(cand.layer, cand.text, ["relationship_person_cap"], `关系层已有 ${activeRel.length} 行（每人上限 3），请改写既有条目而不是新增`, cand.evidenceIds);
        continue;
      }
    }
    // 自我模型必须「我表过态」：只引用了用户单方面纠正、我当时没说话的 episode，
    // 长出来的只是「他对我的要求」，不是「我答应过自己什么」。
    if (cand.layer === "self" && opts?.episodesById) {
      const cited = (cand.episodeIds ?? [])
        .map((id) => opts.episodesById!.get(id))
        .filter((ep): ep is SoulEpisode => Boolean(ep));
      const owned = cited.filter((ep) => typeof ep.agentStance === "string" && ep.agentStance.trim() !== "");
      if (owned.length === 0) {
        reject(cand.layer, cand.text, ["self_not_owned"], "self 只引用了用户单方发言，没有我自己的表态", cand.evidenceIds);
        continue;
      }
    }
    // identity/values 不能只是用户标准的镜像：被引事件里至少要有一条「我当时表过态/做过选择」。
    // 2026-11-05 生产 review：4 条 identity 全是「我站在…宁可…也不…」，证据却全来自用户纠正，
    // 我从来没有在事件里选择过——那长出来的是他对我的要求，不是我的立场。
    if ((cand.layer === "identity" || cand.layer === "values") && opts?.episodesById) {
      const cited = (cand.episodeIds ?? [])
        .map((id) => opts.episodesById!.get(id))
        .filter((ep): ep is SoulEpisode => Boolean(ep));
      const owned = cited.filter((ep) => typeof ep.agentStance === "string" && ep.agentStance.trim() !== "");
      if (cited.length > 0 && owned.length === 0) {
        reject(cand.layer, cand.text, ["agent_stance_missing"], `${cand.layer} 只引用了用户单方发言的事件，没有我自己的选择`, cand.evidenceIds);
        continue;
      }
    }
    // 关系必须是「史」，不是档案：必须引 ≥minEpisodeEvidence 个他真说过话的 episode。
    // 只写「我们长期协作、他信任我」这种评价，没有具体来路，就是用户档案/合同，不是关系。
    if (cand.layer === "relationship" && opts?.episodesById) {
      const cited = (cand.episodeIds ?? [])
        .map((id) => opts.episodesById!.get(id))
        .filter((ep): ep is SoulEpisode => Boolean(ep));
      const voiced = cited.filter((ep) => Boolean(ep.quote?.text || ep.userStance));
      if (voiced.length < cfg.minEpisodeEvidence) {
        reject(cand.layer, cand.text, ["relationship_history_missing"], `relationship 只引了 ${voiced.length} 个有原话的事件（需 ≥${cfg.minEpisodeEvidence}）`, cand.evidenceIds);
        continue;
      }
    }
    // 证据计数必须覆盖三条合法来源：L1 记录、事件（ep-*）、voice 的逐字原话。
    // 只数 L1 会把「模型按 prompt 只引事件」的候选全部误杀（生产实拍：57 条/轮
    // insufficient_evidence，identity/voice/narrative 因此永远为 0）——这正是
    // 「生成源换成事件层、证据门却还只认 L1」的断链。
    //
    // P2-4（2026-11-07 审计）已评估未采纳：把口径改成「按会话/按天去重」会在
    // 单日真实对话上把整条产线挡死（实测 e2e：同一天两轮、minEvidence=2，
    // 去重后恒为 1 → identity 永不入库），而 minEvidence 的语义本来就是
    // 「不同证据记录数」。要治「同一轮被复述三次」得先改判据定义（按
    // (day, object) 去重 + 要求 outcome 不同），属 P2 提案，本轮不动。
    const evidenceCount = new Set([
      ...cand.evidenceIds,
      ...(cand.episodeIds ?? []),
      ...(cand.fewShots ?? []).map((q) => q.recordId),
    ]).size;
    if (evidenceCount < cfg.minEvidence) {
      reject(cand.layer, cand.text, ["insufficient_evidence"], `独立证据 ${evidenceCount} < ${cfg.minEvidence}`, cand.evidenceIds);
      continue;
    }

    // ① α 有界改写：同层已有一条高相似条目 → 视为它的改写，而不是新增一条。
    // 不这样做的话旧条目永不退场，人格会同时挂「旧说法」和「新说法」两套互相矛盾的自我描述。
    // 判定与执行都走 persona.planUpdate（α 单一源），超限即拒，绝不整块翻修。
    let target: PersonaItem | null = null;
    let bestSim = 0;
    for (const it of map.values()) {
      if (it.layer !== cand.layer || it.state === "merged") continue;
      const sim = textSimilarity(it.text, cand.text);
      if (sim > bestSim) {
        bestSim = sim;
        target = it;
      }
    }
    if (target && bestSim >= UPDATE_MATCH_SIMILARITY) {
      const upd = planUpdate(target, cand.text, now, cfg);
      if (!upd.ok) {
        reject(cand.layer, cand.text, ["alpha_exceeded"], upd.reason ?? "改写幅度超 α", cand.evidenceIds);
        continue;
      }
      const others = [...map.values()].filter((i) => i.itemId !== target!.itemId);
      const reports = evaluateCandidate(upd.item.text, {
        layer: cand.layer,
        now,
        existing: others,
        config: cfg,
        layerUsedChars: layerUsedChars(cand.layer, others),
        userCorpus: voiceCorpus,
        evidenceOrigins: cand.origins,
        evidenceEpisodeIds: cand.episodeIds,
        voiceFewShots: cand.fewShots,
        personName: cfg.personName,
        checkDuplicate: false,
      });
      if (!allPass(reports)) {
        const failed = reports.filter((r) => !r.pass);
        reject(cand.layer, cand.text, failed.map((r) => r.code), failed[0]?.detail ?? failed[0]?.code ?? "gate_failed", cand.evidenceIds);
        continue;
      }
      const usedInWindow = opts?.updatesInWindow?.[target.layer] ?? 0;
      const usedThisRun = updatesThisRun.get(target.layer) ?? 0;
      if (updated >= cfg.maxUpdatedPerCycle) {
        reject(cand.layer, cand.text, ["cycle_cap"], `本轮改写已达 ${cfg.maxUpdatedPerCycle} 条上限`, cand.evidenceIds);
        continue;
      }
      if (usedInWindow + usedThisRun + 1 > cfg.windowRewrites) {
        reject(cand.layer, cand.text, ["window_exceeded"], `窗口内已改写 ${usedInWindow + usedThisRun} 次，上限 ${cfg.windowRewrites}`, cand.evidenceIds);
        continue;
      }
      const day = now.slice(0, 10);
      const sameText = upd.diff === 0;
      // P2-E：唯一在场人 → 改写后的 human 条目保住/补上 meta.person；没有唯一人时**不动**
      // 既有 meta（旧绑定可能是对的，凭空抹掉比留着更像污染）。
      let nextMeta = sameText ? target.meta : { ...(target.meta ?? {}), lastRewriteAt: now };
      if (person) nextMeta = { ...(nextMeta ?? {}), person };
      const next: PersonaItem = {
        ...target,
        text: upd.item.text,
        lastEvidenceAt: now,
        updatedAt: now,
        evidenceIds: Array.from(new Set([...target.evidenceIds, ...cand.evidenceIds])),
        // evidenceDays 记「证据出现的自然日」——陈旧/复现判定要的是日期，不是记录 id。
        evidenceDays: Array.from(new Set([...target.evidenceDays, day])),
        evidenceOrigins: Array.from(new Set<EvidenceOrigin>([...target.evidenceOrigins, ...cand.origins])),
        // 只有正文真的变了才记「改写时间」；同文刷新证据/复活不占 churn 额度。
        meta: nextMeta,
        state: target.state === "frozen" ? planRevive(target, now, cand.evidenceIds).state : target.state,
      };
      map.set(next.itemId, next);
      if (!sameText) {
        updated += 1;
        updatesThisRun.set(next.layer, usedThisRun + 1);
      }
      ledger.push(
        ledgerOf(
          target,
          next,
          now,
          trigger,
          "update",
          sameText ? "新证据刷新" : `α 有界改写（差异 ${upd.diff.toFixed(2)} ≤ ${cfg.alpha}）`,
          sameText ? ["evidence"] : ["alpha_update"],
        ),
      );
      continue;
    }

    // ② 真新条目：走完整准入门（含池预算与重复门）。
    const res = planAdmit({
      layer: cand.layer,
      text: cand.text,
      now,
      existing,
      config: cfg,
      userCorpus: voiceCorpus,
      evidenceOrigins: cand.origins,
      evidenceIds: cand.evidenceIds,
      evidenceDays: [now.slice(0, 10)],
      evidenceEpisodeIds: cand.episodeIds,
      voiceFewShots: cand.fewShots,
      weight: cand.layer === "boundary" ? 0.9 : 0.6,
      meta: { source: cand.origins.join("+"), minedAt: now, ...(person ? { person } : {}) },
    });
    if (!res.item) {
      const failed = res.reports.filter((r) => !r.pass);
      reject(cand.layer, cand.text, failed.map((r) => r.code), failed[0]?.detail ?? failed[0]?.code ?? "gate_failed", cand.evidenceIds);
      continue;
    }
    // S7 正向来源：用户明确认可 / 事件 outcome 判定解决时，关系条目记一条 trust 事实。
    // 只标来源与方向，不改写文本——信任是证据给的，不是形容词堆出来的。
    if (cand.layer === "relationship" && opts?.episodesById) {
      const cited = (cand.episodeIds ?? []).map((id) => opts.episodesById!.get(id)).filter((ep): ep is SoulEpisode => Boolean(ep));
      const trust = trustMetaFromEpisodes(cited, now);
      if (trust) res.item.meta = { ...(res.item.meta ?? {}), ...trust };
    }
    map.set(res.item.itemId, res.item);
    admitted.push(res.item);
    ledger.push(ledgerOf(undefined, res.item, now, trigger, "admit", "准入", res.reports.map((r) => r.code)));
  }
  return { items: [...map.values()], admitted, updated, rejections, ledger, gateStats: [...gateStats.values()] };
}

/** 判侧一次调用：把「抛错」与「解析出零票但原始输出非空（invalid>0）」折算成 judge_failed。 */
type TraitJudgeOutcome = { ok: true; value: TraitProtocolOutput } | { ok: false; reason: string };

async function traitJudgeOnce(
  judge: (episodes: SoulEpisode[]) => Promise<TraitProtocolOutput>,
  episodes: SoulEpisode[],
): Promise<TraitJudgeOutcome> {
  try {
    const value = await judge(episodes);
    if (value.votes.length === 0 && value.invalid > 0) return { ok: false, reason: `zero_votes invalid=${value.invalid}` };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, reason: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 统一的 trait 报告形状：没跑（drift=null）与跑过都出同一套字段，汇总日志不必判空。 */
/**
 * 每会话本轮最多收 cap 条新事件（B1）。
 * 排序：非 work 优先——追责/纠正/取舍是他当面给的态度，派活只是动作词兜底，不能把
 * 追责挤到下一 tick；同类按 at 新→旧。未入选的不会丢：下一 tick 重算时它们仍是 fresh。
 */
export function capFreshEpisodesPerSession(
  eps: SoulEpisode[],
  cap: number = EPISODE_PER_SESSION_PER_TICK,
): SoulEpisode[] {
  if (cap <= 0 || eps.length === 0) return [];
  const bySession = new Map<string, SoulEpisode[]>();
  for (const ep of eps) {
    const list = bySession.get(ep.sessionId);
    if (list) list.push(ep);
    else bySession.set(ep.sessionId, [ep]);
  }
  const out: SoulEpisode[] = [];
  for (const list of bySession.values()) {
    list.sort(
      (a, b) =>
        Number(b.kind !== "work") - Number(a.kind !== "work") || Date.parse(b.at) - Date.parse(a.at),
    );
    out.push(...list.slice(0, cap));
  }
  return out;
}

function traitReportOf(
  state: AxisVector,
  drift: ReturnType<typeof driftTraits> | null,
): NonNullable<SoulWorkerReport["trait"]> {
  const axes = drift?.axes ?? [];
  return {
    changed: drift?.changed ?? false,
    votes: drift?.votes ?? 0,
    rejectedVotes: drift?.rejected ?? 0,
    applied: drift?.votes ?? 0,
    rejected: drift?.rejected ?? 0,
    deltas: axes.filter((a) => a.delta !== 0).map((a) => ({ axis: a.axis, delta: a.delta })),
    l1Clamped: drift?.l1Clamped ?? false,
    stateL1: Number(l1Norm(state).toFixed(4)),
    axes: axes.map((a) => ({ axis: a.axis, net: a.net, delta: a.delta, ...(a.reason ? { reason: a.reason } : {}) })),
    labels: { admitted: 0, merged: 0, rejected: 0 },
  };
}

export async function runSoulMaintenance(deps: SoulWorkerDeps): Promise<SoulWorkerReport> {
  const cfg = resolveSoulConfig(deps.config);
  const now = deps.now ?? new Date().toISOString();
  const report: SoulWorkerReport = {
    at: now,
    trigger: deps.trigger,
    tenant: deps.tenant,
    stored: false,
    imported: 0,
    admitted: 0,
    updated: 0,
    rejected: 0,
    reclassified: 0,
    retired: 0,
    merged: 0,
    degraded: 0,
    frozen: 0,
    revived: 0,
    ledgerEntries: 0,
    budgets: [],
    mood: null,
    rejections: [],
    drift: [],
    alerts: [],
  };
  const store = deps.store;

  // 1) 生命周期基线
  // 2026-11-07（P0-0）：core_memory 槽位通道整体移除——soul 侧不再读槽（readCore 调用点归零），
  // 人格来源只剩 episode-history 与 l1+model+episode 两条。槽位行由 core-proposal 侧删除。
  const existing = typeof store.listSoulPersona === "function" ? ((await store.listSoulPersona(deps.tenant)) ?? []) : [];
  const ledger: SoulLedgerEntry[] = [];
  const map = new Map(existing.map((i) => [i.itemId, { ...i }]));

  // 1-0) 历史槽导入退出人格注入层（2026-11-05 用户拍板「我允许，你做完吧」）。
  // 旧实现把 strict_rule/identity 逐行导入 boundary/identity，导致「补货查询流程」「TDB git
  // 操作」「NC 客开红线」被当成「我不做的事」注入——操作约束伪装成人格，且一旦人格 boundary
  // 非空就把旧红线段接管掉。现在：导入条目冻结（仍可审计/回滚），红线继续由 strict_rule
  // 操作约束段渲染（见 soul-assembler.ts:631），人格层只长自己的取舍。
  // 2026-11-07（P0-0）：槽位通道已删，本段不再读 core_memory，只做一次性清退（已 frozen 跳过）。
  const legacySlotItems = [...map.values()].filter(
    (it) => (it.meta as { source?: unknown } | undefined)?.source === "slot-import",
  );
  if (legacySlotItems.length > 0) {
    for (const it of legacySlotItems) {
      // boundary：历史操作红线下沉 strict_rule。relationship：槽导入是用户档案
      // （姓名/时区/妻子账号），不是关系史，必须退出「我和他的关系」。
      // values/identity 等其它层仍保留，等新证据替换——整层冻结会把注入清空。
      const exitLayer = it.layer === "boundary" || it.layer === "relationship";
      if (!exitLayer || it.state === "frozen") continue;
      const retired: PersonaItem = freezeItem(it, now);
      map.set(retired.itemId, retired);
      report.retired = (report.retired ?? 0) + 1;
      ledger.push(
        ledgerOf(
          it,
          retired,
          now,
          deps.trigger,
          "retire",
          it.layer === "relationship"
            ? "槽导入的用户档案退出关系层；关系史只留有事件证据的生成条目"
            : "历史操作红线退出人格层，下沉为操作约束（strict_rule 段继续渲染）",
          ["legacy_slot_retired"],
        ),
      );
    }
  }
  // 1-0b) voice 语义纠偏（2026-11-05 生产 review）：旧管线的 voice few-shot 取自用户原话，
  // 生成结果整层写成「他开口像下工单」——注入标题却是「## 我的说话方式」。这不是措辞问题，
  // 是把用户画像冒充成我的人格。新判据要求第一人称；旧条目冻结、让位给 assistant 语料重生成。
  // 1-0c) 既有 voice 条目的 fewShot 若早于「证据链修复」落库，recordId 只在 meta 里、
  // 没进 evidenceIds；这里做一次幂等回填，保证审计能从条目一步回查 L0 原话。
  for (const it of [...map.values()]) {
    if (it.layer !== "voice") continue;
    const shots = Array.isArray((it.meta as { fewShot?: unknown } | undefined)?.fewShot)
      ? ((it.meta as { fewShot: Array<{ recordId?: unknown }> }).fewShot)
      : [];
    const ids = shots.map((q) => q?.recordId).filter((x): x is string => typeof x === "string" && x !== "");
    const missing = ids.filter((id) => !it.evidenceIds.includes(id));
    if (missing.length === 0) continue;
    const repaired: PersonaItem = { ...it, evidenceIds: Array.from(new Set([...it.evidenceIds, ...missing])) };
    map.set(repaired.itemId, repaired);
    ledger.push(
      ledgerOf(it, repaired, now, deps.trigger, "update", `补齐 voice fewShot 证据 ${missing.length} 条`, ["evidence_repair"]),
    );
  }
  for (const it of [...map.values()]) {
    if (it.layer !== "voice" || it.state === "frozen" || it.state === "merged") continue;
    if (isSelfVoice(it.text)) continue;
    const retired: PersonaItem = freezeItem(it, now);
    map.set(retired.itemId, retired);
    report.retired = (report.retired ?? 0) + 1;
    ledger.push(
      ledgerOf(it, retired, now, deps.trigger, "retire", "voice 是第三人称用户画像，不是我的语体；冻结后用 assistant 原话重生成", [
        "voice_self_missing",
      ]),
    );
  }

  // 1a) 槽导入已移除（2026-11-07 P0-0）：core_memory 的 identity/self_identity/strict_rule/
  // core_value 不再进入人格层。红线由 strict_rule 操作约束段渲染，人格只吃事件史与证据。
  // 1b) 节流：LLM 改写与漂移是重活（一轮几十次模型/向量调用），按 updateIntervalHours 到期才跑；
  // 生命周期（降级/冻结）、心境积分每个 tick 照跑（便宜且与时间相关）。
  // 到期锚点记在账本 action="cadence"——配置项必须真接线，否则 updateIntervalHours 就是死配置。
  let cadenceSkipped: string | undefined;
  const recentLedger =
    typeof store.listSoulLedger === "function"
      ? ((await Promise.resolve(store.listSoulLedger(deps.tenant, 200))) ?? [])
      : [];
  // 回滚是生命周期的一步，不是只给人手工点的库方法。账本里 action=rollback 且
  // gates 含 rollback_requested 的行，是「点名撤销」的唯一入口：下一轮 tick 看见就执行，
  // 执行结果另写一条 gates=lifecycle_rollback 的账本（rollbackSoulPersona 自己写）。
  // 没有请求就不碰任何条目——禁止把「能回滚」做成「每轮自动回滚最近一次写入」。
  if (typeof store.rollbackSoulPersona === "function") {
    const requested = recentLedger.filter(
      (e) => e.action === "rollback" && (e.gates ?? []).includes("rollback_requested") && typeof e.itemId === "string" && e.itemId !== "",
    );
    const done = new Set(
      recentLedger
        .filter((e) => e.action === "rollback" && (e.gates ?? []).includes("lifecycle_rollback"))
        .map((e) => e.itemId),
    );
    const pending = [...new Set(requested.map((e) => e.itemId as string).filter((id) => !done.has(id)))];
    if (pending.length > 0) {
      const rolled = await Promise.resolve(
        store.rollbackSoulPersona(deps.tenant, pending, { now, reason: "生命周期执行点名回滚", gate: "lifecycle_rollback" }),
      );
      report.alerts = [
        ...(report.alerts ?? []),
        {
          code: "rollback_applied",
          class: "control",
          detail: `点名回滚 ${pending.length} 条：restored=${rolled?.restored ?? 0} removed=${rolled?.removed ?? 0} skipped=${rolled?.skipped ?? 0}`,
          records: pending.length,
          admitted: rolled?.restored ?? 0,
          updated: rolled?.removed ?? 0,
        },
      ];
      const fresh = typeof store.listSoulPersona === "function" ? ((await store.listSoulPersona(deps.tenant)) ?? []) : [];
      for (const id of pending) {
        const next = fresh.find((i) => i.itemId === id);
        if (next) map.set(id, { ...next });
        else map.delete(id);
      }
    }
  }
  // 告警抑制：alert 账本此前每 tick 写一条（生产同一租户 10 分钟一条，48 条同一句），
  // 而唯一读者只打日志——既是噪声，也看不出「已经持续多久」。同一 code 在 6h 内已有
  // alert 账本时只更新 report.alerts（本轮实况），不再追加账本行；跨窗口仍会留续报。
  const ALERT_SUPPRESS_HOURS = 6;
  const alertSuppressSince = new Date(Date.parse(now) - ALERT_SUPPRESS_HOURS * 3_600_000).toISOString();
  // P0-2：抑制判据改成「按 code 查库最近 6h」，不再扫最近 200 行账本。
  // 200 行在生产只覆盖约 3.6h（reject 行占满窗口），短于 6h 抑制窗，同一 code 13h 落 14 条。
  // store 缺该方法（或查库抛错）时才回退旧窗口扫描，保住测试替身与降级后端。
  const alertRecentlyLogged = async (code: string): Promise<boolean> => {
    if (typeof store.hasSoulAlertSince === "function") {
      try {
        return Boolean(await Promise.resolve(store.hasSoulAlertSince(deps.tenant, code, alertSuppressSince)));
      } catch (err) {
        deps.logger?.warn?.(
          `[soul-worker] alert lookup failed (fallback to ledger window): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const sinceMs = Date.parse(now) - ALERT_SUPPRESS_HOURS * 3_600_000;
    return recentLedger.some((e) => {
      if (e.action !== "alert" || !(e.gates ?? []).includes(code)) return false;
      const at = Date.parse(e.at);
      return Number.isFinite(at) ? at > sinceMs : true;
    });
  };
  if (deps.trigger === "lifecycle") {
    const lastRun = recentLedger.find((e) => e.action === "cadence");
    if (lastRun) {
      const hours = (Date.parse(now) - Date.parse(lastRun.at)) / 3_600_000;
      if (Number.isFinite(hours) && hours < cfg.updateIntervalHours) {
        cadenceSkipped = `距上轮整合 ${hours.toFixed(1)}h < ${cfg.updateIntervalHours}h`;
      }
    }
  }
  if (cadenceSkipped) report.cadenceSkipped = cadenceSkipped;

  // 1c) 事件层：L0 真实对话 → 分歧/纠正/拍板/取舍（确定性挖掘，零 LLM）。
  // 为什么要这一层：L1 摘要把「谁说的、原话是什么」洗掉了，只剩下抽象的「倾向」；
  // 人格要的恰恰是「他在哪次冲突里站了哪边、为此放弃了什么」。identity/values/narrative
  // 的准入资格由此而来（gates 的 episode_missing 门），voice 的 few-shot 也从这里取。
  const episodeIds = new Set<string>();
  const voiceRecords = new Map<string, string>();
  let episodePool: SoulEpisode[] = [];
  // P2-E：person_key → 展示名。human 层条目挂人时写进 meta.person.displayName（回显/审计用），
  // 由事件解析与本轮 store.listSoulPersons 共同填充；拿不到就只写 key。
  const personNamesByKey = new Map<string, string>();
  // 有旁人的会话（团队频道/群）＝公开场：同一个错在那里被指出是害羞，私聊里是愧疚。
  // 用会话里真实的 team 消息判定，不要求他的原话自己写出「当众」。
  const publicSessions = new Set<string>();
  try {
    // S10：清库水位（一次写死、只读不改）。派生只吃水位之后的 L0——否则重生首个 tick
    // 会把旧对话重抽成事件，当天就复活旧人格（spec §8）。
    const episodeWatermark =
      typeof store.soulMetaGet === "function"
        ? await Promise.resolve(store.soulMetaGet("episodeWatermark"))
        : undefined;
    const l0 = deps.recentL0
      ? await deps.recentL0()
      : typeof store.recentL0Messages === "function"
        ? ((await Promise.resolve(
            store.recentL0Messages(deps.tenant, {
              sinceDays: cfg.episodeWindowDays,
              maxMessages: cfg.maxEpisodeMessages,
              ...(episodeWatermark ? { sinceIso: episodeWatermark } : {}),
            }),
          )) ?? [])
        : [];
    for (const row of l0 as Array<{ session_id?: string; role?: string; message_text?: string }>) {
      if (row.role !== "user") continue;
      if (!/^\s*Team message from/iu.test(String(row.message_text ?? ""))) continue;
      if (row.session_id) publicSessions.add(row.session_id);
    }
    const minedEpisodes = mineEpisodes(l0, cfg, { windowDays: cfg.episodeWindowDays });
    // 判侧票是一次性证据（G3）：只有「本轮真正新入库」的事件才配投票。
    // mineEpisodes 每 tick 都会把整个窗口重算一遍，若直接把 minedEpisodes.episodes 喂给判侧，
    // 同一批事件会被反复投票 → 净票翻倍、漂移被同一批证据反复推。故先快照已存在的事件 id，
    // 差集才是本轮新增；窗口内但已投过的只记 skipped_repeat，不进应用票数。
    const knownEpisodeIds =
      typeof store.listSoulEpisodes === "function"
        ? new Set(
            (
              (await Promise.resolve(
                store.listSoulEpisodes(deps.tenant, { includeArchived: true, limit: 2000 }),
              )) ?? []
            ).map((ep) => ep.episodeId),
          )
        : new Set<string>();
    // B1：cap 是「每会话每 tick 新增」，不是扫描期截断。先算出本轮真正的新事件，再按
    // 每会话配额挑一批入库；落选的留在窗口里等下一 tick（episodeId 确定性，重算不会重复）。
    const freshAll = minedEpisodes.episodes.filter((ep) => !knownEpisodeIds.has(ep.episodeId));
    const fresh = capFreshEpisodesPerSession(freshAll, EPISODE_PER_SESSION_PER_TICK);
    // P2-E：事件挂人——身份优先取 L0 的真列（user_id → platform=tdai，强证据），
    // 只有老行没带出身份时才回退到 participants 的展示名（历史数据只有名字可查）。
    // 两条路径都 fail-open：解析不出来就写空名单，绝不阻断事件落库。
    // P2-E2：名字回退只复用、不新建。身份的唯一强证据是 L0 的 user_id（平台 id 路径）；
    // 光一个展示名（「Lead」「何晨」这种）既可能是别人的称呼、也可能是配置里填的通用词，
    // 拿它去建人只会往 soul_person 里灌垃圾行，而且第二天按人过滤就会命中这些垃圾。
    // 所以名字这条路只在「租户里已经有人叫这个名/这个别名、且唯一」时才复用，其余一律不挂人。
    const soulPersons: SoulPerson[] = [];
    if (typeof store.listSoulPersons === "function") {
      try {
        for (const p of (await Promise.resolve(store.listSoulPersons(deps.tenant))) ?? []) {
          soulPersons.push(p);
          personNamesByKey.set(p.personKey, p.displayName);
        }
      } catch (err) {
        deps.logger?.warn?.(`[soul-worker] listSoulPersons failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const personByName = new Map<string, { key: string; displayName: string } | null>();
    const lookupEpisodePersonByName = async (
      displayName: string,
    ): Promise<{ key: string; displayName: string } | null> => {
      const cached = personByName.get(displayName);
      if (cached !== undefined) return cached;
      const want = normalizePersonName(displayName);
      const hits =
        want === ""
          ? []
          : soulPersons.filter(
              (p) =>
                normalizePersonName(p.displayName) === want ||
                (p.aliases ?? []).some((alias) => normalizePersonName(alias) === want),
            );
      // 0 条 = 没这个人；>1 条 = 分不清是谁。两种都不挂人，绝不新建。
      const hit = hits.length === 1 ? { key: hits[0].personKey, displayName: hits[0].displayName || displayName } : null;
      personByName.set(displayName, hit);
      if (hit && hit.displayName !== "") personNamesByKey.set(hit.key, hit.displayName);
      return hit;
    };
    // 同一 tick 内同一个平台 id 只解析一次：否则同一个人会被重复查库，多事件并发时还会各建一行。
    const personByPlatformId = new Map<string, { key: string; displayName: string } | null>();
    const resolveEpisodePersonByPlatform = async (
      platformId: string,
      displayName: string,
    ): Promise<{ key: string; displayName: string } | null> => {
      const cached = personByPlatformId.get(platformId);
      if (cached !== undefined) return cached;
      try {
        // 展示名只是标签：有平台 id 时先按 id 命中；名字唯一命中则把 id 补绑到旧行，
        // 让「历史按名字建的人」与「新事件按 id 解析的人」收敛成同一行。
        // 历史事件里可能已经浸进了角色词（旧数据 speaker.displayName=「用户」），
        // 这里再剥一次，避免按平台 id 建出叫「用户」的人。
        const safeName = normalizePersonNameCandidate(displayName) ?? "";
        const person = await resolvePerson(store as unknown as IMemoryStore, deps.tenant, {
          platform: EPISODE_SPEAKER_PLATFORM,
          platformId,
          ...(safeName !== "" ? { displayName: safeName } : {}),
        });
        const hit = { key: person.personKey, displayName: person.displayName || safeName };
        personByPlatformId.set(platformId, hit);
        if (hit.displayName !== "") personNamesByKey.set(hit.key, hit.displayName);
        return hit;
      } catch (err) {
        deps.logger?.warn?.(
          `[soul-worker] resolvePerson(${EPISODE_SPEAKER_PLATFORM}:${platformId}) failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        personByPlatformId.set(platformId, null);
        return null;
      }
    };
    for (const ep of fresh) {
      const keys: string[] = [];
      const hinted = personsForEpisode(ep.participants, ep.speaker);
      if (hinted.platformId) {
        // 有真实身份就只走平台 id 一条路：名字在这条路上只是展示标签，不参与归属。
        const person = await resolveEpisodePersonByPlatform(hinted.platformId, ep.speaker?.displayName ?? "");
        if (person) keys.push(person.key);
      } else {
        for (const name of hinted.names) {
          const person = await lookupEpisodePersonByName(name);
          if (person) keys.push(person.key);
        }
      }
      // 0 个 / ≥2 个都照实写：事件可以同时涉及两个人，这里不做归属猜测（归属在候选聚合侧判断）。
      ep.persons = [...new Set(keys)];
    }
    let inserted = 0;
    if (fresh.length > 0 && typeof store.commitSoulEpisodes === "function") {
      const res = await Promise.resolve(store.commitSoulEpisodes(deps.tenant, fresh));
      inserted = res?.inserted ?? 0;
    }
    report.episodeCapSkipped = freshAll.length - fresh.length;
    const since = new Date(Date.parse(now) - cfg.episodeWindowDays * 86_400_000).toISOString();
    episodePool =
      typeof store.listSoulEpisodes === "function"
        ? ((await Promise.resolve(store.listSoulEpisodes(deps.tenant, { since, limit: 500 }))) ?? [])
        : minedEpisodes.episodes;
    // 事件是「按当前判据从语料重算」的派生视图，不是不可变事实（账本才是）。
    // 旧检测器把注入体/任务书当成他的发言、或把「先A再B」当取舍写下的行，
    // 必须随判据一起退场，否则它们会长期充当他的情绪对象与心境来源。
    // 只清理 affect_source=lexicon 且落在本轮窗口内的行；LLM 候选与窗口外历史不动。
    let purged = 0;
    if (typeof store.deleteSoulEpisodes === "function") {
      const windowStart = Date.parse(now) - cfg.episodeWindowDays * 86_400_000;
      const keep = new Set(minedEpisodes.episodes.map((ep) => ep.episodeId));
      const stale = episodePool
        .filter((ep) => (ep.affectSource ?? "lexicon") === "lexicon")
        .filter((ep) => Date.parse(ep.at) >= windowStart && !keep.has(ep.episodeId))
        .map((ep) => ep.episodeId);
      if (stale.length > 0) {
        const res = await Promise.resolve(store.deleteSoulEpisodes(deps.tenant, stale));
        // S3：删除已改为归档，计数读 archived；兼容旧返回字段。
        purged = res?.archived ?? res?.deleted ?? 0;
        const gone = new Set(stale);
        episodePool = episodePool.filter((ep) => !gone.has(ep.episodeId));
      }
    }
    // fresh 已在本 tick 入库（只含选中的那批）；未入选的留给下一 tick，不投票。
    const freshEpisodes = fresh;
    const repeatEpisodes = minedEpisodes.episodes.length - freshAll.length;
    for (const q of minedEpisodes.voiceQuotes) {
      if (q.recordId) voiceRecords.set(q.recordId, q.text);
    }
    for (const ep of episodePool) episodeIds.add(ep.episodeId);
    const byKind: Record<string, number> = {};
    for (const ep of episodePool) byKind[ep.kind] = (byKind[ep.kind] ?? 0) + 1;
    report.episodes = {
      mined: minedEpisodes.episodes.length,
      inserted,
      available: episodePool.length,
      byKind,
      ...(purged > 0 ? { purged } : {}),
    };
    // P0-1 stats 接线：挖掘侧口径（落库前）与库内口径（episodes.byKind）分开报，
    // 否则「挖到 12 条只落 3 条」在观测面上会被合并成同一个数字。
    report.episodeCandidates = minedEpisodes.stats.candidates;
    report.personaCandidates = minedEpisodes.stats.personaCandidates;
    report.byKind = { ...minedEpisodes.stats.byKind };
    report.contextOnly = minedEpisodes.stats.contextOnly;
    // S4：特质层——六轴 state 只由「本轮新增 episode 的显式行为票」推动（G3），
    // 标签是方向视图（不存独立权重）。判侧缺席就如实标注，绝不用词面相似伪造漂移。
    if (typeof store.readSoulTraitState === "function") {
      try {
        const prevTrait = await Promise.resolve(store.readSoulTraitState(deps.tenant));
        // D3：表单特质 → seedState（两栏「你设定的 / 它现在」的左栏来自这里）。
        // 表单没给特质时才回退到上次 seedState；绝不拿漂移后的 state 冒充设定。
        const seedProfile = deps.readAgentProfile
          ? await deps.readAgentProfile(deps.tenant.agentId).catch(() => null)
          : null;
        const seedTraits = seedProfile?.traits ?? [];
        const seedState: AxisVector =
          seedTraits.length > 0 ? seedStateFromSeeds(seedTraits) : (prevTrait?.seedState ?? emptyAxisVector());
        // 没有历史 state 时，当前状态从「你设定的」出发：否则新 agent 一出生就和设定不一致，
        // drifted 在还没发生任何漂移时就是 true（审墨 2026-11-07：seed≠0 而 axis 全 0）。
        let traitState: AxisVector = prevTrait?.state ?? seedState;
        const seedChanged =
          !prevTrait ||
          JSON.stringify(prevTrait.seedState) !== JSON.stringify(seedState);
        let labels =
          typeof store.listSoulTraitLabels === "function" ? ((await Promise.resolve(store.listSoulTraitLabels(deps.tenant))) ?? []) : [];
        // 首次落 18 条种子：标签库必须有方向载荷，否则投影永远是空的。
        // S10 修订：evidence 只给表单真正选中的种子——没设过特质的租户不该在卡里凭空宣告性格。
        if (labels.length === 0 && typeof store.commitSoulTraitLabels === "function") {
          labels = seedLabelRows(SEED_LABELS, now, { declared: seedTraits.map((s) => s.label) });
          await Promise.resolve(store.commitSoulTraitLabels(deps.tenant, labels));
        }
        // 只喂本轮真正新入库的事件（G3 同源），窗口内已投过的只记 skipped_repeat：
        // 票是一次性证据，同一事件不该每 tick 重投一次。
        const newEpisodes = freshEpisodes;
        if (repeatEpisodes > 0) {
          deps.logger?.info?.(
            `[soul-trait] skipped_repeat=${repeatEpisodes} 票只算本轮新增 ${newEpisodes.length} 条（窗口内老事件不重投）`,
          );
        }
        let stateWritten = false;
        // 判侧三态：没配 provider=no_trait_judge；有 provider 但本轮无新增事件=no_new_episode；
        // provider 抛错、或零票且 invalid>0（原始输出非空却一条也没解析出来）=judge_failed。
        const judgeRes =
          deps.traitJudge && newEpisodes.length > 0 ? await traitJudgeOnce(deps.traitJudge, newEpisodes) : null;
        if (judgeRes && !judgeRes.ok) {
          report.traitSkipped = "judge_failed";
          report.trait = traitReportOf(traitState, null);
          deps.logger?.warn?.(
            `[soul-trait] judge_failed ${judgeRes.reason}（episodes=${newEpisodes.length}，本轮不写 state、不动标签）`,
          );
        } else if (judgeRes && judgeRes.ok) {
          const judged = judgeRes.value;
          const drift = driftTraits(traitState, judged.votes, {
            newEpisodeIds: newEpisodes.map((ep) => ep.episodeId),
          });
          // S8 D10：漂移观测喂给 journal（生命周期线程写、召回线程读；不新开日志通道）。
          recordSoulDrift(
            deps.tenant,
            { changed: drift.axes.filter((a) => a.delta !== 0).length, rejected: drift.rejected },
            now,
          );
          const lab = resolveLabelProposals(judged.labelProposals, labels, { now });
          const labelRows = [...lab.admitted, ...lab.updated];
          if (labelRows.length > 0 && typeof store.commitSoulTraitLabels === "function") {
            await Promise.resolve(store.commitSoulTraitLabels(deps.tenant, labelRows));
          }
          if (drift.changed && typeof store.writeSoulTraitState === "function") {
            await Promise.resolve(store.writeSoulTraitState(deps.tenant, { state: drift.state, seedState, updatedAt: now }));
            traitState = drift.state;
            stateWritten = true;
            // 判据 6：每次真实位移都要能从账本追回净票与步长。
            for (const ax of drift.axes.filter((a) => a.delta !== 0)) {
              const synthetic: PersonaItem = {
                itemId: `trait:${ax.axis}`,
                layer: "identity",
                text: `axis ${ax.axis} net=${ax.net} delta=${ax.delta.toFixed(4)} state=${traitState[ax.axis].toFixed(4)}`,
                state: "active",
                weight: Math.abs(traitState[ax.axis]),
                evidenceIds: [...new Set(judged.votes.filter((v) => v.axis === ax.axis).map((v) => v.episodeId))],
                evidenceDays: [],
                evidenceOrigins: ["episode"],
                createdAt: now,
                updatedAt: now,
                lastEvidenceAt: now,
              };
              // 入口 Σ 超 L1 时，同一轮里既缩了 state 又落了位移，账本要能看出这两件事同时发生，
              // 否则事后只看到 Δ 对不上 Σ≤0.5 的约束。
              const l1Note = drift.l1Clamped ? "（入口 Σ 超限已归一）" : "";
              ledger.push(ledgerOf(undefined, synthetic, now, deps.trigger, "drift", `特质漂移 ${ax.axis}: 净票 ${ax.net} → Δ${ax.delta.toFixed(4)}${l1Note}`, [`trait_protocol:${TRAIT_PROTOCOL_VERSION}`, ...(drift.l1Clamped ? ["trait_l1"] : [])]));
            }
          }
          report.trait = {
            changed: drift.changed,
            votes: drift.votes,
            rejectedVotes: drift.rejected,
            applied: drift.votes,
            rejected: drift.rejected,
            deltas: drift.axes.filter((a) => a.delta !== 0).map((a) => ({ axis: a.axis, delta: a.delta })),
            l1Clamped: drift.l1Clamped,
            stateL1: Number(l1Norm(traitState).toFixed(4)),
            axes: drift.axes.map((a) => ({ axis: a.axis, net: a.net, delta: a.delta, ...(a.reason ? { reason: a.reason } : {}) })),
            labels: { admitted: lab.admitted.length, merged: lab.merged.length, rejected: lab.rejected.length },
          };
          // 判侧实况一行到底：采用/挡下多少票、真正位移了几轴、标签进/并/拒各几条。
          deps.logger?.info?.(
            `[soul-trait] trait=${drift.votes}/${drift.rejected} 票=${judged.votes.length}(invalid=${judged.invalid}) 位移=${drift.axes.filter((a) => a.delta !== 0).length}轴 labels=${lab.admitted.length}/${lab.merged.length}/${lab.rejected.length} l1Clamped=${drift.l1Clamped}`,
          );
        } else {
          report.traitSkipped = deps.traitJudge ? "no_new_episode" : "no_trait_judge";
          report.trait = traitReportOf(traitState, null);
        }
        // 表单改了特质、本轮又没有漂移时也要落 seedState——否则「你设定的」永远停在旧值。
        if (!stateWritten && seedChanged && typeof store.writeSoulTraitState === "function") {
          await Promise.resolve(store.writeSoulTraitState(deps.tenant, { state: traitState, seedState, updatedAt: now }));
          stateWritten = true;
        }
        report.seedState = {
          written: stateWritten,
          from: seedTraits.length > 0 ? "form" : "prev",
        };
      } catch (err) {
        report.traitSkipped = `trait_failed: ${err instanceof Error ? err.message : String(err)}`;
        deps.logger?.warn?.(`[soul-worker] trait drift failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // S3：事件史必须可重建——派生「自我失败/反悔/承诺」时读全量（含已归档行），
    // 否则一次判据收紧就会让历史从注入里凭空消失，「我当时说过什么」再也追不回来。
    // 归档行只供派生，不进本轮的窗口池（gates/mood 仍只看活跃窗口）。
    const historySource =
      typeof store.listSoulEpisodes === "function"
        ? ((await Promise.resolve(store.listSoulEpisodes(deps.tenant, { includeArchived: true, limit: 2000 }))) ?? episodePool)
        : minedEpisodes.episodes;
    // 自我失败/复盘/反悔、关系冲突/修复：从事件确定性长出，不经 LLM。
    // 已有同 itemId 的不覆盖（重跑幂等）。没有我的表态的事件不会进这里。
    const facts = settlePromises(historySource.flatMap(factsFromEpisode), historySource);
    // 承诺层：事件史里的「我答应过自己」不只进注入，还要落到 soul_promises 状态机——
    // 只派生事实不落库时，承诺表永远停在历史残行（生产：1 行 kept、无事件），
    // 承诺就没有「open → kept/broken」的可核对生命周期。
    // 幂等：按 (refKey, content) 对齐已有行；只有 open 行才迁移，终态不重放。
    let promiseStat: { created: number; kept: number; broken: number; skipped: number } | undefined;
    if (
      typeof store.upsertSoulPromise === "function" &&
      typeof store.transitionSoulPromise === "function" &&
      typeof store.listSoulPromises === "function"
    ) {
      const stat = { created: 0, kept: 0, broken: 0, skipped: 0 };
      try {
        const promiseFacts = facts.filter((f) => f.kind === "promise");
        if (promiseFacts.length > 0) {
          const existing = (await Promise.resolve(store.listSoulPromises(deps.tenant, { limit: 500 }))) ?? [];
          const byKey = new Map<string, { promiseId: string; status: string; refKey: string }>();
          for (const p of existing) byKey.set(`${p.refKey}\u0000${p.content}`, { promiseId: p.promiseId, status: p.status, refKey: p.refKey });
          for (const f of promiseFacts) {
            const refKey = f.object === "这件事" ? "" : f.object;
            const key = `${refKey}\u0000${f.text}`;
            let row = byKey.get(key);
            if (!row) {
              const created = await Promise.resolve(
                store.upsertSoulPromise(deps.tenant, {
                  content: f.text,
                  source: "episode-history",
                  createdAt: f.at,
                  refKey,
                }),
              );
              stat.created += 1;
              row = created?.promiseId ? { promiseId: created.promiseId, status: "open", refKey } : undefined;
              if (row) byKey.set(key, row);
            }
            const want = f.fulfillment === "kept" || f.fulfillment === "broken" ? f.fulfillment : undefined;
            if (!want || !row || row.status !== "open") {
              if (want) stat.skipped += 1;
              continue;
            }
            const moved = await Promise.resolve(
              store.transitionSoulPromise(deps.tenant, row.promiseId, want, {
                at: now,
                note: "episode-history settle",
                source: "evidence",
              }),
            );
            if (moved?.ok) {
              row.status = want;
              stat[want] += 1;
            } else {
              stat.skipped += 1;
            }
          }
        }
        promiseStat = stat;
      } catch (err) {
        // 承诺面失败不影响人格生长：记录并继续（下一 tick 会重试同一批事实）。
        deps.logger?.warn?.(
          `[soul-worker] promise sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        promiseStat = stat;
      }
    }
    if (promiseStat) report.promises = promiseStat;
    const grown = historyToItems([...facts, ...reversals(facts)], now);
    let historyAdded = 0;
    const still = new Set(grown.map((item) => item.itemId));
    for (const item of grown) {
      const prev = map.get(item.itemId);
      // 同文同 id 已 active 时不必重建；但权重与 direction 都是判据的一部分：
      // 权重决定注入顺序；direction 是信任升降的语义，旧行缺 direction 时不能因为
      // 「文本没变、权重没变」就永远不补——那会让生产关系史一直停在无方向的旧快照上。
      if (!historyItemNeedsUpdate(prev, item)) continue;
      map.set(item.itemId, prev ? { ...item, createdAt: prev.createdAt } : item);
      historyAdded += 1;
      ledger.push(ledgerOf(prev, item, now, deps.trigger, prev ? "update" : "admit", "事件史确定性长出，非模型自评", ["episode_history"]));
    }
    let historyRetired = 0;
    for (const [id, item] of [...map]) {
      const source = (item.meta as { source?: string } | undefined)?.source;
      if (source !== "episode-history" || item.state !== "active" || still.has(id)) continue;
      const frozen: PersonaItem = freezeItem(item, now);
      map.set(id, frozen);
      historyRetired += 1;
      ledger.push(ledgerOf(item, frozen, now, deps.trigger, "freeze", "事件史规则收紧后不再构成事实，退出注入", ["episode_history"]));
    }
    if (historyAdded > 0) report.historyAdded = historyAdded;
    if (historyRetired > 0) report.historyRetired = historyRetired;
  } catch (err) {
    deps.logger?.warn?.(`[soul-worker] episode mining failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 1d) 情绪进入判断（2026-11-05 结构返工）：生成候选之前先算「此刻」。
  // 旧实现把心境积分放在生成之后，只写库/渲染一行——情绪对判断零影响。
  // 这里把「相对基线偏离 + 最近一次真实对象」转成一条**本次情境的默认倾向**，同时进
  // prompt 与账本 action=arbitrate：同一批候选在偏沉/偏积极两种心境下拿到的上下文不同，
  // 且事后可回放「当时为什么先防着/先信一次」。
  let promptMoodLine: string | undefined;
  let promptMoodBias: string | undefined;
  // 自我向情绪 + 同一对象反复未修 → 本轮生长排期（不是永久封禁，修复写下即放行）。
  // 门是否可达的可观测性（只报告，不参与判断）。
  let moodGateObs: SoulMoodReport["gate"];
  if (typeof store.readSoulState === "function" && typeof store.recentAffectSignals === "function") {
    try {
      const nowMs = Date.parse(now);
      const prevState = (await Promise.resolve(store.readSoulState(deps.tenant))) as
        | {
            valence?: number;
            arousal?: number;
            baselineValence?: number | null;
            baselineArousal?: number | null;
            dominance?: number | null;
            baselineDominance?: number | null;
            sampleCount?: number | null;
            updatedAt?: string;
            emotionObject?: string | null;
            emotionLabel?: string | null;
            emotionIntensity?: number | null;
            emotionAt?: string | null;
          }
        | null;
      if (prevState && typeof prevState.valence === "number" && typeof prevState.arousal === "number") {
        const prevMood: MoodState = {
          valence: prevState.valence,
          arousal: prevState.arousal,
          baselineValence: typeof prevState.baselineValence === "number" ? prevState.baselineValence : 0,
          baselineArousal: typeof prevState.baselineArousal === "number" ? prevState.baselineArousal : 0.3,
          // 支配感：旧行没有这列就不带（整合按 0.5 缺省），不把缺列读成「很被动」。
          ...(typeof prevState.dominance === "number" ? { dominance: prevState.dominance } : {}),
          ...(typeof prevState.baselineDominance === "number" ? { baselineDominance: prevState.baselineDominance } : {}),
          updatedAt: prevState.updatedAt ?? now,
          sampleCount: prevState.sampleCount ?? 0,
        };
        const signals = (await Promise.resolve(
          store.recentAffectSignals(deps.tenant, {
            windowHours: Math.max(24, cfg.moodHalfLifeHours * 2),
            maxSamples: 200,
          }),
        )) as Array<{ valence: number; arousal: number; occurred_at: string; excerpt?: string | null }>;
        const prevUpdatedAt = prevState.updatedAt ? Date.parse(prevState.updatedAt) : Number.NaN;
        const since = Number.isFinite(prevUpdatedAt)
          ? prevUpdatedAt - 5 * 60_000
          : nowMs - Math.max(24, cfg.moodHalfLifeHours * 2) * 3_600_000;
        const fresh = (signals ?? []).filter((s) => {
          const at = Date.parse(s.occurred_at);
          return Number.isFinite(at) && at > since;
        });
        const episodeEvents = episodePool
          .filter((ep) => {
            // P0-B：work 事件不参与心境——派活句没有「情绪对象」，喂进来会把
            // 「跑下全量测试」这种任务当成他此刻的态度来源。
            if (ep.kind === "work") return false;
            const at = Date.parse(ep.at);
            return Number.isFinite(at) && at > since;
          })
          .map((ep) => emotionEventFromEpisode(ep, cfg));
        const events = [...fresh.map((s) => emotionFromSignal(s, now, cfg)), ...episodeEvents];
        const mood = integrateMood(prevMood, events, now, cfg);
        const ranked = activeEmotions(events, now);
        const moodSign = Math.sign(mood.valence);
        // 到期判据：窗口里只要还有一条说得出口的对象就拿它当原因，注入面会永远写
        // 「因为 X 正在消退」——原因永不到期。所以 top 必须是「还活着」的那条。
        const live = (e: (typeof ranked)[number]): boolean =>
          isReusableAffectObject(e.object) && !isEmotionExpired(e, now);
        const top =
          ranked.find((e) => live(e) && Math.sign(e.valence) === moodSign) ??
          ranked.find(live);
        // 当前情绪对象：优先本轮活着的情绪，其次落库的 emotion_object（事件几小时后必然
        // 退出 activeEmotions，但对象史还在——复发计数与判断倾向仍需要它）。
        const object = (top?.object ?? "").trim() || (prevState?.emotionObject ?? "").trim();
        // 同一对象的历史：次数/峰值/修复，口径与注入侧 objectRecurrence 同源。
        // 对象要与 episode 侧同一口径（含 userStance 优先的派生），否则「同一个对象」
        // 只在心境行里成立、在复发计数里永远是 0；hits 的 object 也必须同源，
        // 否则 objectRecurrence 会把每条都当空对象滤掉、计数恒 0。
        const hits = object === ""
          ? []
          : episodePool
              .filter((ep) => emotionObjectForEpisode(ep) === object)
              .map((ep) => ({
                episodeId: ep.episodeId,
                at: ep.at,
                object: emotionObjectForEpisode(ep) || (ep.object ?? ""),
                intensity: Math.abs(ep.valence ?? 0),
                valence: ep.valence ?? 0,
                // 与读侧立场共用 episodeRepaired：只认「补上了/已按/已改/改完/改口」，不认「收口」。
                repaired: episodeRepaired(ep),
              }));
        // 修复看「最近一次」而不是「历史上曾经」：早先补过一次、后来又漏，
        // 旧的 some(repaired) 会把这次新欠账永久放行——门就再也不会响。
        const latestHit = hits.length > 0
          ? [...hits].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
          : undefined;
        const repaired = latestHit?.repaired === true;
        // 情绪门只对「此刻真有一条在场情绪」生效：没有活着的情绪就没有判断偏移，
        // 不能拿上一条已经退场的历史标签继续压身份生长。
        // 「在场」要跨轮算：本轮没有新事件时（6h 节流下很常见），上一轮写下的情绪
        // 只要还没过到期判据就仍然在场——否则状态明明还在，门却按空穿过。
        const prevLive =
          !!prevState?.emotionObject &&
          !!prevState.emotionLabel &&
          typeof prevState.emotionIntensity === "number" &&
          !!prevState.emotionAt &&
          !isStoredEmotionExpired(
            {
              label: prevState.emotionLabel,
              intensity: prevState.emotionIntensity,
              at: prevState.emotionAt,
              asOf: prevState.updatedAt ?? now,
            },
            now,
          );
        const gateFocus = moodFocusOf(top?.label ?? (prevLive ? prevState?.emotionLabel ?? "" : ""));
        const gate =
          gateFocus !== "none" && object !== ""
            ? moodGrowthGate({
                focus: gateFocus,
                object,
                count: hits.length,
                repaired,
              })
            : undefined;
        // 门是否可达：对象锚抽不出来的条数、被挡在 count>=2 之外的次数都写进 report，
        // 不为了「让门命中」去降阈值。
        {
          const episodeObjects = episodePool.map((ep) => emotionObjectForEpisode(ep));
          moodGateObs = {
            focus: gateFocus,
            object,
            hits: hits.length,
            opened: gate !== undefined,
            ...(gate
              ? {}
              : {
                  declined:
                    gateFocus === "none"
                      ? ("no_live_emotion" as const)
                      : object === ""
                        ? ("object_missing" as const)
                        : hits.length < 2
                          ? ("count_below_2" as const)
                          : ("not_deferred" as const),
                }),
            episodes: {
              total: episodeObjects.length,
              objectMissing: episodeObjects.filter((o) => o === "").length,
            },
          };
        }
        if (gate) {
          // S5：门只观测不否决——记录「这一轮本来会被挡住什么」，但不再拦候选。
          // 情绪对判断的影响改由 moodBias / 注意力重排承担（有证据的候选不该被情绪封口）。
          deps.logger?.info?.(`[soul-worker] mood gate observed (no veto): ${gate.code} → 本可暂缓 ${gate.defer.join("/")}｜${gate.reason}`);
          ledger.push({
            entryId: `mg-${now.slice(0, 10)}-${textHash(gate.code + "|" + object + "|" + (top?.label ?? ""))}`,
            at: now,
            trigger: deps.trigger,
            layer: "all",
            action: "arbitrate",
            gates: ["mood_gate", "observed_only", gate.code],
            reason: `${gate.code}｜object=${object} count=${hits.length} repaired=${repaired} latest=${latestHit?.at ?? "none"} label=${top?.label ?? "prev"}｜no veto (S5)｜${gate.reason}`,
            evidenceIds: hits.map((h) => h.episodeId).slice(0, 8),
          });
        }
        const reading = readMood(mood, { emotion: top, threshold: cfg.moodDeviationThreshold * 0.5 });
        promptMoodLine = renderMoodLine(mood, { emotion: top, threshold: cfg.moodDeviationThreshold * 0.5 });
        const topEpisode = object !== "" ? episodePool.find((ep) => ep.object === object) : undefined;
        // 事件来自 L1 摘要时 object 是从首句抽的短语，未必与 episode 池里的 object 逐字相同；
        // 判断倾向只需要「对什么」，没有可回指的 episode 就不编造出处（evidenceIds 留空）。
        const biasEpisode =
          topEpisode ??
          (object !== "" ? ({ episodeId: "", object } as unknown as SoulEpisode) : undefined);
        promptMoodBias =
          moodBiasLine(mood, {
            episode: biasEpisode,
            threshold: cfg.moodDeviationThreshold,
            ...(hits.length > 0 ? { hits } : {}),
          }) ?? undefined;
        if (promptMoodBias) {
          ledger.push({
            entryId: `arb-${now.slice(0, 10)}-${textHash(promptMoodBias)}`,
            at: now,
            trigger: deps.trigger,
            layer: "all",
            action: "arbitrate",
            gates: ["mood_bias"],
            reason: promptMoodBias,
            evidenceIds: topEpisode ? [topEpisode.episodeId] : [],
          });
        }
        deps.logger?.info?.(
          `[soul-worker] mood cue: ${reading.phrase}${promptMoodBias ? `；bias=${promptMoodBias}` : "；无对象/未偏离，不产生判断偏移"}`,
        );
      }
    } catch (err) {
      deps.logger?.warn?.(`[soul-worker] mood cue failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2) 语料生长（确定性）+ 3) LLM 候选（可选，同门）
  let records: SoulEvidenceRecord[] = [];
  if (deps.recentRecords) {
    try {
      records = (await deps.recentRecords()) ?? [];
    } catch (err) {
      deps.logger?.warn?.(`[soul-worker] recentRecords failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const mined = mineCandidates(records, cfg);
  // 单条 L1 记录就能抽出的候选，天然过不了 minEvidence：不送门、不落拒绝账本，
  // 否则每轮几百条结构性 insufficient_evidence 会把真实 LLM 拒绝原因淹掉。
  const candidates: SoulMergeCandidate[] = mined
    .filter((c) => new Set(c.evidenceIds).size >= cfg.minEvidence)
    .map((c) => ({ ...c, origins: ["l1"] }));
  // S6 单产线：identity 事实与语料/LLM 候选同数组——不在这里单独落库。
  // 两处来源都只是「候选」，准入门与事务在 7) 统一收口。
  if (deps.identityFacts) {
    try {
      const facts = (await deps.identityFacts()) ?? [];
      let accepted = 0;
      for (const f of facts) {
        const text = typeof f?.text === "string" ? f.text.trim() : "";
        const ids = Array.isArray(f?.evidenceIds) ? f.evidenceIds.filter((x): x is string => typeof x === "string" && x !== "") : [];
        if (!text || ids.length === 0) continue;
        // self_identity 是旧槽名，人格层里没有这一层：统一落到 identity（D2）。
        candidates.push({ layer: "identity", text, evidenceIds: ids, origins: ["l1", "model"] });
        accepted += 1;
      }
      report.identity = { proposed: facts.length, candidates: accepted };
    } catch (err) {
      deps.logger?.warn?.(`[soul-worker] identityFacts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      report.identity = { proposed: 0, candidates: 0, skipped: err instanceof Error ? err.message : String(err) };
    }
  } else {
    report.identity = { proposed: 0, candidates: 0, skipped: "no_identity_source" };
  }
  const llmBudget = openCostBudget(deps.llmCallBudget ?? 1);
  // 告警的读者在下一轮，不在本轮：本轮刚算出 language_unmapped 时改写已经跑完。
  // 上一轮账本有这条，就跳过 LLM 改写。事件、情绪、承诺核对照跑，不把整个人格冻住。
  // 时间窗：一条旧告警不能永久停掉改写。窗口取一个整合周期（缺省 6h）；语言没修好时
  // 每轮 tick 都会重新记一条告警，所以窗口会一直被刷新；修好后最多再挡一个周期就自动解除。
  const languageHoldMs = Math.max(1, cfg.updateIntervalHours) * 60 * 60 * 1000;
  const languageHeld = recentLedger.some(
    (e) => (e.gates ?? []).includes("language_unmapped") && Date.parse(e.at) >= Date.parse(now) - languageHoldMs,
  );
  if (languageHeld && deps.rewriter) {
    report.skipped = [report.skipped, "language_unmapped"].filter(Boolean).join(";");
  }
  if (deps.rewriter && records.length > 0 && !cadenceSkipped && !languageHeld && !chargeCall(llmBudget)) {
    report.skipped = [report.skipped, "llm_budget"].filter(Boolean).join(";");
  } else if (deps.rewriter && records.length > 0 && !cadenceSkipped && !languageHeld) {
    try {
      const proposed = await deps.rewriter({
        existing: [...map.values()].map((i) => ({ layer: i.layer, text: redactSecrets(i.text) })),
        // 「id | 内容」：prompt 要求 evidenceIds 必须来自输入记录，不把 id 给出去等于让它编。
        // 进模型前脱敏：密钥不能进 prompt，也不能进拒绝账本的原文。
        records: records.slice(0, 200).map((r) => redactSecrets(`${r.id} | ${r.content}`)),
        // 事件是身份主张的唯一合法证据；原话是 voice 的唯一合法素材。
        episodes: episodeDigest(episodePool, { max: cfg.maxEpisodesForPrompt }),
        voiceQuotes: [...voiceRecords.entries()].slice(0, 120).map(([id, text]) => redactSecrets(`「${text}」 | ${id}`)),
        moodLine: promptMoodLine,
        moodBias: promptMoodBias,
        personName: cfg.personName,
        maxCandidates: Math.max(1, cfg.maxUpdatedPerCycle),
        minEvidence: cfg.minEvidence,
      });
      deps.logger?.info?.(
        `[soul-worker] rewriter proposed ${(proposed ?? []).length} candidate(s)` +
          ((proposed ?? []).length > 0
            ? `；首条 = ${String((proposed ?? [])[0]?.layer)}: ${String((proposed ?? [])[0]?.text).slice(0, 40)}`
            : ""),
      );
      for (const p of proposed ?? []) {
        if (typeof p?.text !== "string" || typeof p?.layer !== "string") continue;
        if (!INJECTED.includes(p.layer as SoulLayer)) continue;
        const ids = Array.isArray(p.evidenceIds) && p.evidenceIds.length > 0
          ? p.evidenceIds.filter((x): x is string => typeof x === "string")
          : records.slice(0, 3).map((r) => r.id);
        // 事件 id 与 few-shot 一律过滤到本轮真实池内：模型编 id 就当场失去证据，
        // 而不是靠「prompt 里求它别编」。
        const epIds = ids.filter((id) => episodeIds.has(id));
        // 条目出处要能一路回查到 L0 原文：ep-* 是真事件，但 soul_persona.evidence 里
        // 只有 ep-* 时，审计者还得再跳一层。把被引事件的 quote.recordId（msg-*）一并写入，
        // ep → soul_episodes.quote.recordId 的链仍在 meta.episodeIds/quote 里保留。
        const epRecordIds = epIds
          .map((id) => episodePool.find((e) => e.episodeId === id)?.quote?.recordId)
          .filter((x): x is string => typeof x === "string" && x !== "");
        // voice 的 fewShot 必须「quote 与 recordId 逐字对应」：只校验 recordId 存在，
        // 模型可以拿 A 的原话配 B 的 id，审计链就是假的。对应不上就整条丢掉。
        const fewShots = (p.fewShot ?? []).filter(
          (q) => q && typeof q.quote === "string" && voiceRecords.get(q.recordId) === q.quote,
        );
        const fewShotIds = fewShots.map((q) => q.recordId);
        const evidencedIds = [...new Set([...ids, ...epRecordIds, ...fewShotIds])];
        // 来源如实标注：模型提出的「表述」，但证据是真实 L1 记录 / 事件 → 两类都记，
        // 独立性门按 50% 自身产出算（纯 model 来源会被 self_evidence 拒，这才是它该有的下场）。
        candidates.push({
          layer: p.layer as SoulLayer,
          text: p.text,
          // 事件 id + 真实原话 recordId 同时写进 evidenceIds：条目出处必须能回查
          //（ep-* → soul_episodes → quote.recordId 原文），而不是只剩一个空数组。
          // 出处门另按 episodeIds 计数。
          evidenceIds: evidencedIds,
          origins: ["l1", "model", ...(epIds.length > 0 ? (["episode"] as const) : [])],
          episodeIds: epIds,
          fewShots,
        });
      }
    } catch (err) {
      deps.logger?.warn?.(`[soul-worker] rewriter failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 变更率窗口：windowDays 内同层最多 windowRewrites 次改写（从账本取真实历史，不靠内存计数）。
  const windowStart = Date.parse(now) - cfg.windowDays * 86_400_000;
  const updatesInWindow: Partial<Record<SoulLayer, number>> = {};
  for (const e of recentLedger) {
    if (e.action !== "update" || typeof e.layer !== "string") continue;
    // 同文刷新/复活也记 update（gates=evidence），但不是改写，不占 churn 窗口。
    if (!Array.isArray(e.gates) || !e.gates.includes("alpha_update")) continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || at < windowStart) continue;
    const layer = e.layer as SoulLayer;
    updatesInWindow[layer] = (updatesInWindow[layer] ?? 0) + 1;
  }
  // 逐字语料必须包含本轮全部事件的原话：关系候选引的是「他当时说的那句」，
  // 可能早于最近 400 条 L0；只拿 records 会把真实原话判成 verbatim_missing。
  const verbatimCorpus = [
    ...records.map((r) => r.content),
    ...episodePool.map((ep) => ep.quote?.text ?? "").filter((t) => t !== ""),
  ];
  const grown = mergeCandidates([...map.values()], candidates, now, cfg, verbatimCorpus, {
    updatesInWindow,
    episodeIds,
    voiceRecords,
    episodesById: new Map(episodePool.map((ep) => [ep.episodeId, ep])),
    personNamesByKey,
    trigger: deps.trigger,
  });
  for (const it of grown.items) map.set(it.itemId, it);
  report.admitted += grown.admitted.length;
  report.updated += grown.updated;
  report.rejections.push(...grown.rejections);
  ledger.push(...grown.ledger);
  // P0-2：门拒计数落 soul_gate_stats。统计是观测面，写失败只 warn，绝不能改准入结果。
  if (grown.gateStats.length > 0 && typeof store.bumpSoulGateStats === "function") {
    try {
      await Promise.resolve(store.bumpSoulGateStats(deps.tenant, grown.gateStats));
    } catch (err) {
      deps.logger?.warn?.(`[soul-worker] gate stats failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2b) 语言覆盖告警：判据目前只覆盖中英；日文假名/韩文谚文出现时必须告警，
  // 不能因为日文里夹着汉字就被当成中文放过。没有汉字且零生长也告警（英文路径失效的现场）。
  // 不能静默：这正是「换个语言就不长人格」的现场，必须有一个可告警的指标，而不是等人发现人格是空的。
  const joinedText = records.map((r) => String(r.content)).join("\n");
  // 只需要「有没有汉字」这个布尔值：用 test 短路，不数 35 万个匹配（生产 4707 条语料下
  // 数 CJK 一次要 ~70ms，而告警只看 0/非0）。假名/谚文仍精确计数，它们通常为 0，代价小。
  const hasCjk = /[\u3400-\u9fff\uf900-\ufaff]/u.test(joinedText);
  const countOf = (re: RegExp) => joinedText.match(re)?.length ?? 0;
  const kanaChars = countOf(/[\u3040-\u30ff]/gu);
  const hangulChars = countOf(/[\uac00-\ud7af]/gu);
  const unmappedChars = kanaChars + hangulChars;
  const noGrowth = grown.admitted.length === 0 && grown.updated === 0;
  if (records.length >= 20 && (unmappedChars > 0 || (!hasCjk && noGrowth))) {
    const scripts = [kanaChars > 0 ? `假名 ${kanaChars}` : "", hangulChars > 0 ? `谚文 ${hangulChars}` : ""].filter(Boolean).join("/");
    const detail = unmappedChars > 0
      ? `语料 ${records.length} 条、未覆盖文字 ${scripts} 个（mined=${mined.length}, 过门候选=${candidates.length}, admit=${grown.admitted.length}/update=${grown.updated}）：判据语言未覆盖这场语料`
      : `语料 ${records.length} 条、汉字 0 个，本轮 admit=0/update=0（mined=${mined.length}, 过门候选=${candidates.length}）：判据语言未覆盖这场语料`;
    report.alerts = [...(report.alerts ?? []), { code: "language_unmapped", class: "control", detail, records: records.length, admitted: grown.admitted.length, updated: grown.updated }];
    deps.logger?.warn?.(`[soul-alert] language_unmapped | ${detail}`);
    // 6h 内已写过同 code 的 alert 账本 → 只更新 report.alerts，不再追加行（跨窗口仍续报）。
    if (!(await alertRecentlyLogged("language_unmapped"))) {
      ledger.push({
        entryId: `led-alert-lang-${now}-${records.length}`,
        at: now,
        trigger: deps.trigger,
        layer: "all",
        action: "alert",
        gates: ["language_unmapped"],
        reason: detail,
        evidenceIds: [],
      });
    }
  }

  // 3b) 矛盾：同对象更晚的一次未修复失败，证伪了此前「我补上了」的主张。
  // 这是 contradictions 计数唯一的生产者——没有它，freezeContradictions 永远不可能生效，
  // 一条被反复推翻的修复主张会一直停在注入里。
  for (const hit of contradictRepairClaims([...map.values()], episodePool)) {
    const prev = map.get(hit.itemId);
    if (!prev) continue;
    const next = planContradiction(prev, now, cfg, `后来「${hit.object}」又没修好（${hit.episodeId}）`);
    map.set(hit.itemId, { ...next, meta: { ...(next.meta ?? {}), lastContradictionEpisode: hit.episodeId } });
    ledger.push(
      ledgerOf(
        prev,
        next,
        now,
        deps.trigger,
        "contradict",
        `object=${hit.object} episode=${hit.episodeId} at=${hit.at}`,
        ["contradiction", ...(next.state === "frozen" ? ["frozen_by_contradiction"] : [])],
      ),
    );
    if (next.state === "frozen") {
      deps.logger?.warn?.(`[soul] contradiction froze ${next.itemId} after ${next.contradictions ?? 0} (${hit.object})`);
    }
  }

  // 4) 生命周期 + 5) 合并
  const life = planLifecycle([...map.values()], now, cfg);
  for (const it of life.items) {
    const prev = map.get(it.itemId);
    if (prev && prev.state !== it.state) {
      ledger.push(
        ledgerOf(
          prev,
          it,
          now,
          deps.trigger,
          it.state === "frozen" ? "freeze" : it.state === "degraded" ? "degrade" : "revive",
          `${prev.state} → ${it.state}（无新证据 ${cfg.degradeAfterDays}/${cfg.freezeAfterDays} 天）`,
          ["lifecycle"],
        ),
      );
    }
    map.set(it.itemId, it);
  }
  report.degraded = life.degraded.length;
  report.frozen = life.frozen.length;
  report.revived = life.items.filter((it) => {
    const prev = existing.find((e) => e.itemId === it.itemId);
    return prev ? (prev.state === "frozen" || prev.state === "degraded") && it.state === "active" : false;
  }).length;

  const mergePlan = planMerge([...map.values()], cfg.mergeSimilarity, now, textSimilarity);
  for (const m of mergePlan.merged) {
    const prev = map.get(m.item.itemId);
    map.set(m.item.itemId, m.item);
    ledger.push(
      ledgerOf(prev, m.item, now, deps.trigger, "merge", `并入 ${m.into}（相似 ${m.similarity.toFixed(3)}）`, ["merge"]),
    );
  }
  report.merged = mergePlan.merged.length;

  // 5a-2) 结论合并（P1-1）：同 (layer, meta.object) 的活跃结论上限 3 条，超出者标失效。
  // 与上一步不是同一件事：planMerge 治「同一句话换措辞」（state→merged，留 mergedInto 可拆回），
  // 这里治「同一对象堆了太多不同结论」（state 不变，只写 validTo——每句原话都留在库里可回放）。
  // 每 tick 最多一次；无变化不落账（已失效行不再参与分组，下一 tick 不会重复取代）。
  const consolidated = consolidatePersona([...map.values()], { now, maxPerObject: 3 });
  if (consolidated.superseded.length > 0) {
    const replaced = new Map(consolidated.items.map((it) => [it.itemId, it]));
    for (const s of consolidated.superseded) {
      const it = replaced.get(s.itemId);
      if (!it) continue;
      const prev = map.get(s.itemId);
      map.set(it.itemId, it);
      const object = String((it.meta ?? {}).object ?? "");
      ledger.push(
        ledgerOf(
          prev,
          it,
          now,
          deps.trigger,
          "invalidate",
          `合并：同对象超过 3 条（${it.layer}｜${object || "无对象"}）→ 保留 ${s.by}［${s.reason}］`,
          ["consolidate"],
        ),
      );
    }
    report.consolidated = consolidated.superseded.length;
  }

  // 5b) 漂移：把「当前人格条目」与「真实行为锚（近窗记录）」比，连续低分才降级/冻结。
  // 有向量器走语义 cosine；没有则语体轨走 drift.ts 的词面回退（确定性、可离线），
  // 但判断轨（values/boundary/narrative）没有向量器就不判——措辞不同≠取舍变了，
  // 拿词面相似度冻结判断轨才是伪证据。降级/冻结的 method 会写进报告，能复核。
  if (records.length > 0 && !cadenceSkipped) {
    const anchors = records
      .map((r) => r.content)
      .filter((t) => typeof t === "string" && t.trim().length >= 6)
      .slice(-8);
    const cache = new Map<string, number[] | null>();
    const embedIfAvailable = async (text: string): Promise<number[]> => {
      const hit = cache.get(text);
      if (hit !== undefined) {
        if (hit === null) throw new Error("embed failed earlier");
        return hit;
      }
      try {
        const vec = await deps.embed!(text);
        cache.set(text, Array.from(vec));
        return Array.from(vec);
      } catch (err) {
        cache.set(text, null);
        throw err;
      }
    };
    for (const layer of INJECTED) {
      // 判断轨缺向量器时不判：宁可报 driftSkipped，也不拿「措辞不同」当「取舍变了」。
      if (!deps.embed && trackOf(layer) === "judgment") continue;
      // P1-1 残留（P1-2 顺带修）：已被取代（validTo 非空）的行不再当漂移候选。
      // 否则它们明明不进注入，却仍占 drift 预算、被降级/冻结并多写账本——读侧看不见的迁移。
      // 失效判据与 orderForRender 共用 persona.ts 的 hasValidTo，不复制第二份判断。
      const layerItems = [...map.values()]
        .filter((i) => i.layer === layer && (i.state === "active" || i.state === "degraded") && !hasValidTo(i))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 6);
      for (const it of layerItems) {
        try {
          const v = await measureDrift({
            layer,
            anchors,
            text: it.text,
            ...(deps.embed ? { embed: embedIfAvailable } : {}),
            history: it.driftHistory ?? [],
            config: cfg,
          });
          const next: PersonaItem = {
            ...it,
            driftHistory: pushDrift(it.driftHistory, v.score, cfg.driftHistorySize),
            meta: {
              ...(it.meta ?? {}),
              lastDrift: { score: Number(v.score.toFixed(4)), track: v.track, verdict: v.verdict, at: now, method: v.method },
            },
          };
          // 判断轨冻结；语体轨允许自我复位，只降不冻（drift.ts 的 canSelfReset 是单一事实源）。
          // 冻结统一走 freezeItem：状态 + 权重×0.5 + validTo 一起落，避免「状态已冻结但权重/有效期没变」的半迁移。
          if (v.verdict === "freeze" && !canSelfReset(v.track)) Object.assign(next, freezeItem(next, now));
          else if (v.verdict !== "ok" && next.state === "active") {
            next.state = "degraded";
            next.weight = Number((next.weight * cfg.degradeWeightFactor).toFixed(3));
          }
          report.drift.push({
            layer,
            itemId: it.itemId,
            score: Number(v.score.toFixed(4)),
            track: v.track,
            verdict: v.verdict,
            consecutive: v.consecutive,
            method: v.method,
          });
          if (next.state !== it.state || next.weight !== it.weight) {
            ledger.push(
              ledgerOf(
                it,
                next,
                now,
                deps.trigger,
                "drift",
                `漂移 ${v.method} score=${v.score.toFixed(3)} 连续 ${v.consecutive} 次 → ${v.verdict}`,
                [`drift_${v.verdict}`],
              ),
            );
          }
          // 回滚生产者：漂移判成 freeze/degrade 且点名到具体条目时，写一条可执行的回滚请求，
          // 让本轮稍后（下一 tick）的点名回滚消费者有真实生产者——此前 rollback 账本在生产上
          // 永远是 0 条，消费者空转。幂等锚 = itemId + 变更前快照哈希：同一处漂移反复判
          // freeze/degrade 时 entryId 相同（soul_ledger 是 INSERT OR IGNORE），不会每 tick
          // 重复排一次；消费者只按 itemId 单条回滚，不做全量回滚。
          if (next.state === "frozen" || next.state === "degraded") {
            const beforeHash = itemHashOf(it);
            ledger.push({
              entryId: `rbq-${it.layer}-${it.itemId}-${beforeHash}`,
              at: now,
              trigger: deps.trigger,
              layer: it.layer,
              itemId: it.itemId,
              action: "rollback",
              beforeHash,
              afterHash: itemHashOf(next),
              gates: ["rollback_requested"],
              reason: `漂移点名单条回滚：${v.method} score=${v.score.toFixed(3)} 连续 ${v.consecutive} 次 → ${
                next.state === "frozen" ? "freeze" : "degrade"
              }，恢复该条最后一次非回滚变更前的快照`,
              evidenceIds: it.evidenceIds,
              before: it,
            });
          }
          map.set(next.itemId, next);
        } catch (err) {
          deps.logger?.warn?.(
            `[soul-worker] drift skipped for ${it.itemId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    if (!deps.embed) {
      report.driftSkipped = "判断轨缺向量器（只跑语体轨词面回退，不拿词面相似冻结取舍）";
    }
  } else {
    report.driftSkipped = cadenceSkipped ? `节流未到期：${cadenceSkipped}` : "无近窗记录作行为锚";
  }

  const items = [...map.values()];
  // 拒绝数=拒绝清单长度（单一口径）。此前 report.rejected 从未被赋值，日志恒 rejected=0：
  // 生产上 4 条超长红线被 too_long 判死也显示 0 拒绝——静默丢失在观测面上完全不可见。
  report.rejected = report.rejections.length;
  // 拒绝原因分布：判据调得对不对，先看拒的都是什么。只打总数等于把调参依据扔掉。
  const codeCount = new Map<string, number>();
  for (const r of report.rejections) {
    for (const c of r.codes) codeCount.set(c, (codeCount.get(c) ?? 0) + 1);
  }
  report.rejectTop = [...codeCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({ code, count }));
  // 跨轮拒绝分布：rejections 只覆盖本轮，判据是否系统性误杀要看账本聚合。
  // 该聚合此前只有单测调用，生产日志永远只有「这一轮拒了几条」。
  if (typeof store.soulRejectionStats === "function") {
    try {
      report.rejectHistory =
        (await Promise.resolve(store.soulRejectionStats(deps.tenant, { sinceDays: 30 }))) ?? [];
    } catch (err) {
      deps.logger?.warn?.(
        `[soul-worker] soulRejectionStats failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const layer of INJECTED) {
    report.budgets.push(renderLayerWithBudget(layer, items.filter((i) => i.layer === layer), cfg).report);
  }

  // 6) 心境积分（确定性；无信号也回归基线）
  if (
    typeof store.readSoulState === "function" &&
    typeof store.writeSoulState === "function" &&
    typeof store.recentAffectSignals === "function"
  ) {
    try {
      const nowMs = Date.parse(now);
      const prevState = (await Promise.resolve(store.readSoulState(deps.tenant))) as
        | {
            valence?: number;
            arousal?: number;
            baselineValence?: number | null;
            baselineArousal?: number | null;
            dominance?: number | null;
            baselineDominance?: number | null;
            sampleCount?: number | null;
            topValue?: string | null;
            turnSeq?: number | null;
            updatedAt?: string;
            emotionObject?: string | null;
            emotionLabel?: string | null;
            emotionIntensity?: number | null;
            emotionAt?: string | null;
          }
        | null;
      const signals = (await Promise.resolve(
        store.recentAffectSignals(deps.tenant, { windowHours: Math.max(24, cfg.moodHalfLifeHours * 2), maxSamples: 200 }),
      )) as Array<{ valence: number; arousal: number; occurred_at: string; excerpt?: string | null }>;
      // 增量积分：只吸收「上次积分之后」的新信号。否则每小时 tick 都会把同一批 4 天信号重新加权一遍，
      // sampleCount 无限膨胀、旧事件被反复记功——情绪变成只进不出的积分器，正是要避免的开环。
      // 留 5 分钟重叠，容忍落库与调度的时间抖动（重复吸收同一秒的代价远小于漏掉）。
      const prevUpdatedAt = prevState?.updatedAt ? Date.parse(prevState.updatedAt) : Number.NaN;
      // 首次积分（或旧行 sampleCount=0）必须回看整个事件窗口：生产重启时 soul_state 的
      // updatedAt 是「刚刚」，若仍按 prevUpdatedAt 过滤，120 条历史事件全部 at<since，
      // 心境永远 0、情绪永远进不了判断。回放一次已落库事件不是重复记功——sampleCount 从 0 起步。
      const firstMood = !prevState || (prevState.sampleCount ?? 0) === 0 || !Number.isFinite(prevUpdatedAt);
      const lookbackHours = Math.max(24, (cfg.episodeWindowDays ?? 30) * 24);
      // S10 补洞（2026-11-07）：清库写下的 episodeWatermark 也必须压住「首次积分回看」。
      // 否则清库后首个 tick 把 30 天 L1 全量重放成 200 条样本，05:47 的旧心境（振奋/200 样本）
      // 原样复活——重生变成回魂。水位之后没有新信号就该是空心境，而不是历史重算。
      const moodWatermarkMs =
        typeof store.soulMetaGet === "function"
          ? Date.parse(String((await Promise.resolve(store.soulMetaGet("episodeWatermark"))) ?? ""))
          : Number.NaN;
      const since = Math.max(
        firstMood ? nowMs - lookbackHours * 3_600_000 : prevUpdatedAt - 5 * 60_000,
        Number.isFinite(moodWatermarkMs) ? moodWatermarkMs : Number.NEGATIVE_INFINITY,
      );
      const fresh = (signals ?? []).filter((s) => {
        const at = Date.parse(s.occurred_at);
        return Number.isFinite(at) && at > since;
      });
      // 事件优先：episode 带「因为什么、对谁、多强」，L1 信号只有强弱。两者都吸收，
      // 但情绪的解释权归事件——「上次因为假绿恼火」比「valence=-0.4」有用得多。
      // 信号按「上次积分之后」增量，避免同一批 L1 反复记功。
      // P2-1（2026-11-07）：事件同样按水位增量。此前每 tick 把 episodePool（窗口内全部非 work
      // 事件）整批重投 integrateMood（加权平均），同一事件被反复计权 → 情绪被「持续按住」、
      // 半衰期衰减被反复抵消，等于把情绪做成只进不出的开环。水位存 soulMeta 的 moodIntegratedAt；
      // 首次（无水位）只回看一次事件窗口，等价于旧行为一次，此后只积水位之后的新事件。
      // 2026-11-08 修：原实现按「时间水位」增量（soulMeta.moodIntegratedAt 存处理时刻），
      // 而事件的 at 是消息时间。凡是「上一 tick 之后才被挖出来的旧消息」，其 at 恒小于
      // 水位 → 永久跳过（生产实测：48 条事件、11 条非 work，soul_emotions 却是 0 行）。
      // 现在改按事件打标（soul_episodes.mood_integrated_at）：只回答「这条积过没有」，
      // 与处理时刻/消息时刻两个时钟无关，也天然幂等（每 tick 只积未打标的）。
      const unintegratedEpisodes = episodePool.filter((ep) => {
        // P0-B：work 只喂特质投票与自我史，不进心境积分（同上一处）。
        if (ep.kind === "work") return false;
        return !ep.moodIntegratedAt;
      });
      const episodeEvents = unintegratedEpisodes.map((ep) => ({
        ...emotionEventFromEpisode(ep, cfg, { publicSession: publicSessions.has(ep.sessionId) }),
        // 情绪对象锚要的是 person_key；事件在入库前已经挂过人，这里直接带过来，
        // 只在唯一命中时填（多人事件不猜「冲谁」，见下方 objectPerson）。
        persons: ep.persons ?? [],
      }));
      // §5 P3-D：情绪漏斗六档，严格按处理顺序逐档计数（同一天同 code 累加）。
      // 计数是观测面，不是控制面：任何一档写失败都只告警，不让整轮 tick 失败。
      const funnelDay = now.slice(0, 10);
      const bumpFunnel = async (code: string, count: number): Promise<void> => {
        if (!Number.isFinite(count) || count <= 0) return;
        if (typeof store.bumpSoulGateStats !== "function") return;
        try {
          await Promise.resolve(
            store.bumpSoulGateStats(deps.tenant, [
              { day: funnelDay, code, layer: "emotion", count: Math.floor(count), at: now },
            ]),
          );
        } catch (err) {
          deps.logger?.warn?.(
            `[soul-worker] bumpSoulGateStats(${code}) failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };
      // ① 候选：本 tick 真正进入情绪段的未积分非 work 事件。
      await bumpFunnel("emotion:candidate", unintegratedEpisodes.length);
      // ② 对象门：能抽出可复用对象的候选（抽不到的只是读数，不成情绪）。
      await bumpFunnel(
        "emotion:object_ok",
        unintegratedEpisodes.filter((ep) => emotionObjectForEpisode(ep) !== "").length,
      );
      // ③ 判过评价的（= 走到事件成型的）。
      await bumpFunnel("emotion:appraised", episodeEvents.length);
      // ④ 锚点命中：PAD 离某个模板足够近（按加权欧氏距离；不覆盖写入的 label）。
      await bumpFunnel(
        "emotion:anchor_hit",
        episodeEvents.filter((e) => {
          const near = rankLabelsByPad({ valence: e.valence, arousal: e.arousal, dominance: e.dominance }, 1)[0];
          return (near?.distance ?? Number.POSITIVE_INFINITY) <= EMOTION_PAD_NEAR_MAX;
        }).length,
      );
      // ⑤ 强度门：现有条件是「强度 > 0」（0 强度的事件不成为情绪）。
      await bumpFunnel("emotion:intensity_ok", episodeEvents.filter((e) => e.intensity > 0).length);
      const events = [...fresh.map((s) => emotionFromSignal(s, now, cfg)), ...episodeEvents];
      const prevMood: MoodState | null =
        prevState && typeof prevState.valence === "number" && typeof prevState.arousal === "number"
          ? {
              valence: prevState.valence,
              arousal: prevState.arousal,
              // 基线沿用既有行（旧行无基线列时按「缺省基线」计，不把当前值伪装成基线偏移）。
              baselineValence: typeof prevState.baselineValence === "number" ? prevState.baselineValence : 0,
              baselineArousal: typeof prevState.baselineArousal === "number" ? prevState.baselineArousal : 0.3,
              ...(typeof prevState.dominance === "number" ? { dominance: prevState.dominance } : {}),
              ...(typeof prevState.baselineDominance === "number" ? { baselineDominance: prevState.baselineDominance } : {}),
              updatedAt: prevState.updatedAt ?? now,
              sampleCount: prevState.sampleCount ?? 0,
            }
          : null;
      const mood = integrateMood(prevMood, events, now, cfg);
      // 心境原因必须与心境同向、且对象短到能进一句话：否则「整体偏积极」却拿
      // 「被纠正」当原因，判断偏移会自相矛盾；L1 摘要任务句（>20 字）也不能当对象。
      const ranked = activeEmotions(events, now);
      const usable = (e: { object: string }) => isReusableAffectObject(e.object);
      // 原因按「还在影响」排序，不按心境总符号过滤。
      // 总基调偏正时，最近一次被当面指出的错仍然是原因，抹掉就又变成空原因。
      // 半衰期把昨天的事件衰减到阈值下之后，原因不能跟着消失：
      // 取最近一条仍说得出对象的事件，强度用衰减后的值（可能很小，渲染侧再决定写不写）。
      const latestCause = [...events]
        .filter(usable)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      // 原因会过期：活着的优先，退场的只在还没到判据时兜底，都过期就不写原因。
      // 旧实现只要窗口里还有一条说得出口的对象就写「因为 X 正在消退」，
      // 于是同一句话挂了 24 天、强度千分之七还在当解释。
      const top = pickCurrentEmotion(ranked, latestCause, now);
      const reading = readMood(mood, { emotion: top, threshold: cfg.moodDeviationThreshold * 0.5 });
      // 落库失败不能连累整轮：情绪表与打标都要以「心境确实写进去了」为前提，
      // 所以先把成败记下来，后面按它决定打不打标（不打标 = 下一 tick 重试这批事件）。
      let moodPersisted = true;
      try {
      await Promise.resolve(
        store.writeSoulState(deps.tenant, {
          valence: mood.valence,
          arousal: mood.arousal,
          // 基线也落库：渲染侧（auto-recall → renderMoodLine）要读它才能说「比基线偏低」。
          baselineValence: mood.baselineValence,
          baselineArousal: mood.baselineArousal,
          ...(typeof mood.dominance === "number" ? { dominance: mood.dominance } : {}),
          ...(typeof mood.baselineDominance === "number" ? { baselineDominance: mood.baselineDominance } : {}),
          sampleCount: mood.sampleCount,
          topValue: prevState?.topValue ?? undefined,
          turnSeq: (prevState?.turnSeq ?? 0) + 1,
          // 心境原因：写「正在影响我的那条情绪」的对象与衰减后强度，注入侧才说得出
          // 「因为『假绿』反复出问题」。S5：强度过期（半衰期×6）后对象锚保留——
          // 情绪退了，但「上次因为什么」仍是可回指的事实；intensity 置空才是过期信号，
          // 读侧据此不再说「正在影响」，也不会把对象史一起抹掉。
          emotionObject: top?.object ?? prevState?.emotionObject ?? null,
          emotionLabel: top?.label ?? prevState?.emotionLabel ?? null,
          emotionIntensity: top ? decayedIntensity(top, now) : null,
          emotionAt: top?.at ?? prevState?.emotionAt ?? null,
          updatedAt: now,
        }),
      );
      } catch (err) {
        moodPersisted = false;
        deps.logger?.warn?.(
          `[soul-worker] writeSoulState failed (non-fatal, episodes stay unmarked): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // 本轮真正积进心境的事件条数（未打标、非 work，且心境确实落库）；写失败记 0。
      report.moodEpisodesIntegrated = moodPersisted ? episodeEvents.length : 0;
      // 打标只在心境落库成功之后做：写失败就停在未打标态，下一 tick 重试，不丢事件
      // （重复积一次的代价是权重偏一点，漏一条是永久缺）。
      const integratedIds = unintegratedEpisodes.map((ep) => ep.episodeId).filter((id) => id !== "");
      if (moodPersisted && integratedIds.length > 0 && typeof store.markSoulEpisodesMoodIntegrated === "function") {
        try {
          await Promise.resolve(store.markSoulEpisodesMoodIntegrated(deps.tenant, integratedIds, now));
        } catch (err) {
          deps.logger?.warn?.(
            `[soul-worker] markSoulEpisodesMoodIntegrated failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // 情绪史落表：一条事件 × 一版模板规则一行，注入/审计都能回指「哪条片段、
      // 按哪版规则、当时判成什么」。只存已判出对象的事件（无对象的只是读数，不是情绪）。
      const emotionRows: SoulEmotionRecord[] = episodeEvents
        .filter((e) => e.object !== "" && e.id !== "")
        .map((e) => {
          // §5 P3-A：归因/把握度随行落表，来源是当时那条评价向量。
          const a = (e.appraisal ?? {}) as {
            control?: number;
            normCompatibility?: number;
            agency?: "self" | "other" | "environment";
          };
          const confidence = Math.min(
            1,
            Math.max(0, (a.control ?? 0.5) * (a.normCompatibility ?? 0.5) * 2),
          );
          return {
            episodeId: e.id,
            at: e.at,
            object: e.object,
            label: e.label,
            valence: e.valence,
            arousal: e.arousal,
            ...(typeof e.dominance === "number" ? { dominance: e.dominance } : {}),
            intensity: e.intensity,
            // 缺归因写 null（「不知道因为谁」≠「因为环境」）。
            agency: a.agency ?? (typeof e.agency === "string" ? e.agency : null),
            confidence: Number.isFinite(e.confidence) ? e.confidence : confidence,
            // object_person 要 person_key：不从 participants（展示名）反解，直接用事件已挂的人。
            // 唯一命中才填；0 个或多个都留 null（多人事件不猜「冲谁」）。
            objectPerson: e.persons?.length === 1 ? e.persons[0] : null,
            appraisal: e.appraisal,
            templateVersion: EMOTION_TEMPLATE_VERSION,
            appraisedAt: now,
          };
        });
      if (!moodPersisted) emotionRows.length = 0;
      let committed = 0;
      if (emotionRows.length > 0 && typeof store.commitSoulEmotions === "function") {
        try {
          const res = await Promise.resolve(store.commitSoulEmotions(deps.tenant, emotionRows));
          committed = res?.inserted ?? 0;
        } catch (err) {
          deps.logger?.warn?.(
            `[soul-worker] commitSoulEmotions failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // ⑥ 真正写进表的行数（INSERT OR IGNORE 撞主键不算），必须来自返回值而非 emotionRows.length。
      await bumpFunnel("emotion:committed", committed);
      const labels: Record<string, number> = {};
      for (const e of episodeEvents) labels[e.label] = (labels[e.label] ?? 0) + 1;
      report.mood = {
        mood,
        line: renderMoodLine(mood, { emotion: top, threshold: cfg.moodDeviationThreshold * 0.5 }),
        activeEmotions: activeEmotions(events, now).length,
        written: true,
        labels,
        dormant: EMOTION_LABELS.filter((l) => !labels[l]),
        ...(moodGateObs ? { gate: moodGateObs } : {}),
      };
      // 情绪标签长尾告警：24 类里零实例 ≥ 一半，说明标签集设计与语料/判据脱节。
      // 不自动删标签（会改历史口径），但必须让运维看见「这些标签在本租户从未出现过」。
      const dormantLabels = report.mood.dormant ?? [];
      if (dormantLabels.length >= EMOTION_LABELS.length / 2) {
        const detail = `情绪标签零实例 ${dormantLabels.length}/${EMOTION_LABELS.length}：${dormantLabels.join("/")}`;
        report.alerts = [...(report.alerts ?? []), { code: "emotion_label_sparse", class: "diagnostic", detail, records: episodeEvents.length, admitted: 0, updated: 0 }];
        // diagnostic 类不走 warn：这条每轮都会触发，用 warn 打等于把常态伪装成故障，
        // 与调度器按 class 降级成 info 的口径也会自相矛盾。
        deps.logger?.info?.(`[soul-alert] emotion_label_sparse | ${detail}`);
        // 与 language_unmapped 同一落点：只打日志会在下一轮日志轮转后消失，账本才是可回放的控制信号。
        // 同一 code 6h 内已记过就不再追加（诊断类常态触发的噪声抑制，report 仍每轮如实给出）。
        if (!(await alertRecentlyLogged("emotion_label_sparse"))) {
          ledger.push({
            entryId: `led-alert-sparse-${now}-${episodeEvents.length}`,
            at: now,
            trigger: deps.trigger,
            layer: "all",
            action: "alert",
            gates: ["emotion_label_sparse"],
            reason: detail,
            evidenceIds: [],
          });
        }
      }
    } catch (err) {
      report.mood = {
        mood: null as unknown as MoodState,
        line: "",
        activeEmotions: 0,
        written: false,
        skipped: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    report.mood = { mood: null as unknown as MoodState, line: "", activeEmotions: 0, written: false, skipped: "store 缺 readSoulState/writeSoulState/recentAffectSignals" };
  }

  // 6b) 节流锚点：到期并跑过整合才记，否则每 tick 都会重置窗口。
  if (deps.trigger === "lifecycle" && !cadenceSkipped) {
    ledger.push({
      entryId: `led-cadence-${now}`,
      at: now,
      trigger: deps.trigger,
      layer: "all",
      action: "cadence",
      gates: ["cadence"],
      reason: `整合周期到期（${cfg.updateIntervalHours}h）：本轮已跑 LLM 改写与漂移`,
      evidenceIds: [],
    });
  }

  // 7) 落库（条目 + 账本，单事务）
  if (typeof store.commitSoulPersona !== "function") {
    return { ...report, skipped: "store.commitSoulPersona 缺失" };
  }
  // S6：红线投影与 persona/账本同事务。读的是表单侧 Active 红线（逐字），
  // 行数/总字符上限复用卡渲染同一套 clampRedlines，避免「卡里 30 行、槽里 40 行」。
  let strictRule: string | undefined;
  if (deps.readAgentProfile) {
    try {
      const profile = await deps.readAgentProfile(deps.tenant.agentId);
      const active = (profile?.redlines ?? []).filter((r) => r && r.active !== false && typeof r.text === "string" && r.text.trim() !== "");
      if (active.length > 0) {
        // 判据 9 / spec §5 超限处理：① 相似合并（相等/相似≥0.85/互为子串只留更早一条），
        // ② 仍超 30 行或 2600 字则按「最近追加优先」截断渲染 —— 两条都记账本、都不物理删除。
        // 表单侧已硬拒 >30/>2600（agent-profile.ts validateAgentPersonaInput），这里兜的是
        // 历史数据/直写 metadata 的入口；账本按「合并签名」去重，避免每 tick 刷同样的行。
        const merged = mergeDuplicateRedlines(active.map((r) => ({ text: r.text, active: true, createdAt: r.createdAt ?? "" })));
        const clampWarnings: string[] = [];
        const lines = clampRedlines(merged.rows, clampWarnings);
        strictRule = lines.map((l) => `- ${l}`).join("\n");
        report.redlines = { active: active.length, projected: lines.length, merged: merged.merged.length, retired: clampWarnings.length };
        const signature = JSON.stringify({
          merged: merged.merged.map((m) => [m.kept, m.dropped]),
          warnings: clampWarnings,
        });
        try {
          const seen = typeof store.soulMetaGet === "function" ? await Promise.resolve(store.soulMetaGet("redlineOverflowSignature")) : undefined;
          if (seen !== signature) {
            for (const m of merged.merged) {
              ledger.push({
                entryId: `led-redline-merge-${now}-${m.sim.toFixed(2)}`,
                at: now,
                trigger: deps.trigger,
                layer: "boundary",
                action: "merge",
                gates: ["redline_merge"],
                reason: `红线相似合并（相似度 ${m.sim.toFixed(2)}）：保留「${m.kept.slice(0, 20)}」，并掉来源「${m.dropped.slice(0, 20)}」`,
                evidenceIds: [],
              });
            }
            for (const w of clampWarnings) {
              ledger.push({
                entryId: `led-redline-retire-${now}-${w.length}`,
                at: now,
                trigger: deps.trigger,
                layer: "boundary",
                action: "budget_omit",
                gates: ["redline_overflow"],
                reason: `红线超限（不物理删除，仅不渲染）：${w}`,
                evidenceIds: [],
              });
            }
            if (typeof store.soulMetaSet === "function") await Promise.resolve(store.soulMetaSet("redlineOverflowSignature", signature));
          }
        } catch (err) {
          deps.logger?.warn?.(`[soul-worker] redline ledger failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        report.redlines = { active: 0, projected: 0, skipped: "no_active_redline" };
      }
    } catch (err) {
      deps.logger?.warn?.(`[soul-worker] readAgentProfile failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      report.redlines = { active: 0, projected: 0, skipped: err instanceof Error ? err.message : String(err) };
    }
  } else {
    report.redlines = { active: 0, projected: 0, skipped: "no_profile_source" };
  }
  const res = await store.commitSoulPersona(deps.tenant, { upsert: items, ledger }, strictRule ? { strictRule } : undefined);
  report.stored = true;
  report.ledgerEntries = res.ledgered;

  // P2-H：人物档案（「他」的层）。放在「我」的 commit 之后、卡组装之前，所以本轮新档案
  // 会进同一张卡；失败只记账不抛——档案通道不该把 soul 主流程带崩。
  if (deps.personProfiler) {
    try {
      report.personProfile = await deps.personProfiler({
        store: store as PersonProfileStorePort,
        tenant: deps.tenant,
        now,
        maxPersons: deps.personProfileMaxPersons ?? personProfileMaxPerTick(cfg.maxUpdatedPerCycle),
        trigger: deps.trigger,
      });
    } catch (err) {
      deps.logger?.warn?.(`[soul-worker] person-profile failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // D5：每 tick 末组装一次卡，内容真变才追加 soul_snapshots（append-only、version 自增）。
  // 放在 commit 之后：卡读到的必须是本轮已落库的条目与红线，不能读到半途状态。
  try {
    const card = await assembleSoulCard({
      store,
      tenant: deps.tenant,
      ...(deps.readAgentProfile ? { readAgentProfile: deps.readAgentProfile } : {}),
      now,
      persist: true,
    });
    report.card = {
      version: card.version,
      hash: card.hash,
      chars: card.chars,
      dirty: card.dirty,
      seeded: card.seeded,
    };
  } catch (err) {
    report.cardSkipped = err instanceof Error ? err.message : String(err);
    deps.logger?.warn?.(`[soul-worker] card assembly failed (non-fatal): ${report.cardSkipped}`);
  }
  return report;
}
