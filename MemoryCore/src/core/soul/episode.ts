/**
 * soul/episode.ts —— 事件层：从 L0 原始对话里「零 LLM」挖出人格赖以生长的片段。
 *
 * 为什么必须有这一层（2026-11-05 诊断的根因）：
 * 旧管线只从 L1 摘要与 core_memory 槽里长人格，摘要只剩结论——「他当时为什么恼火、
 * 对谁、我放弃了什么」全在压缩中蒸发了，于是人格只能长出「我很严谨」这类方法论。
 * 事件层把原始对话切成有对象的片段：谁说了什么（逐字）、双方立场、代价、情绪强度。
 *
 * 确定性边界：
 *  - 触发、摘句、对象、打分全部是词面规则（可回放、可解释），不调模型；
 *  - 不编造：找不到代价就空串，找不到我的回应就空串；
 *  - episode_id 由会话与触发记录决定，重跑幂等（store 侧 INSERT OR IGNORE）。
 */
import type {
  SoulEpisode,
  SoulEpisodeKind,
  SoulEpisodeQuote,
  SoulEpisodeSignal,
  SoulLayer,
  SoulMaintenanceConfig,
} from "./types.js";
import type { AppraisalVector, EmotionEvent } from "./emotion.js";
import { normalizeText, stripBullet, survivesProjectSwap, textHash } from "./gates.js";
import { applyAppraisalConsistency, appraiseEmotion, clamp01, deriveEmotionObject, extractAffectReferent } from "./emotion.js";
import { appraiseBlameSlots, claimOfFix } from "./slots.js";
import { normalizePersonNameCandidate } from "../record/person-hints.js";

/** L0 读面最小形状（只依赖列，不依赖 store 实现）。 */
export interface EpisodeSourceRow {
  record_id: string;
  session_id: string;
  role: string;
  message_text: string;
  /** ISO；缺省时用 timestamp 兜底。 */
  recorded_at?: string;
  timestamp?: number;
  /**
   * 真实说话人的平台身份（`l0_conversations.user_id`，形如 `usr-2m7b1144d9`）。
   * 可选：老库/老行没带出这列时为空，此时事件照常落库，挂人只能按展示名回退。
   */
  user_id?: string;
  /** 这一轮的 agent 身份（`l0_conversations.agent_id`，形如 `agt-bbr29z58s2`）。 */
  agent_id?: string;
}

/** 用户消息里的「纠正/否定」标记：这是人格最值钱的时刻——他明确说不要什么。 */
const CORRECTION_MARKERS: RegExp[] = [
  /(?:不对|不是这样|不是这个|错了|搞错|你错|弄错)/u,
  /(?:别编|不要编|胡说|瞎说|糊弄|骗我|假绿|自欺)/u,
  /(?:没做到|没有做到|没按|没有按|没听懂|漏了|你漏|忽略)/u,
  /(?:重做|再来一遍|返工|推倒|重新做|别自作主张|谁让你)/u,
  /(?:我说的是|我的意思是|你理解错|指的是)/u,
  /(?:还是不对|又说|仍然没有|还是没)/u,
  /\b(?:that's|that is|this is) (?:wrong|incorrect|not right|not what i (?:said|meant))\b/iu,
  /\b(?:you|u) (?:got it wrong|broke|missed|deleted|removed|forgot|ignored|misread)\b/iu,
  /\b(?:redo|start over|do it again|don't make (?:things|stuff) up|stop (?:making|inventing) (?:things|stuff) up)\b/iu,
  /\b(?:i said|i meant|what i meant|you misunderstood)\b/iu,
];

/** 分歧/反对：立场冲突（不一定带「错」字）。 */
const DIVERGENCE_MARKERS: RegExp[] = [
  /(?:我不认同|我不认同|我不同意|我反对|我不接受|我不认可)/u,
  /(?:不是我要的|不应该是|不应该这样|我不这么|我不同意)/u,
  /(?:我认为应该|我觉得应该|必须是|只能)/u,
  /(?:不要为了|不能为了|别为了)/u,
  /\b(?:i (?:don't|do not) agree|i disagree|i (?:don't|do not) accept|i (?:don't|do not) buy)\b/iu,
  /\b(?:it should be|should not be|not what i want|i think it should|must be)\b/iu,
  /\b(?:don't|do not) (?:do it )?(?:just )?(?:for|to)\b/iu,
];

/** 拍板/决定：他做了选择，选择本身携带优先级。 */
const DECISION_MARKERS: RegExp[] = [
  /(?:拍板|定案|定了|就按|就这个|用这个|采用|采纳|批准|同意)/u,
  /(?:改成|换成|按这个|按我说|按方案|落地|开工|开始做|动手)/u,
  /\b(?:go with|let's go with|use this|switch to|approved|agreed|ship it|start (?:on )?(?:it|this))\b/iu,
];

/** 价值冲突：取舍词一旦出现，这句话就在说「什么比什么重要」。 */
const VALUE_MARKERS: RegExp[] = [
  /(?:宁可|宁愿|与其|取舍|权衡|放弃|牺牲|代价|底线|原则)/u,
  /(?:不能为了|不要为了|不换|绝不换|不拿.{0,8}换)/u,
  /(?:宁可.{0,12}也不|宁愿要.{0,12}不要|拿.{0,8}换)/u,
  /\b(?:rather than|instead of|trade-?off|bottom line|principle|give up|sacrifice|prioriti[sz]e)\b/iu,
];

/** 肯定：他明确说「这样对」——正向情绪的生产来源，过去全被当成噪音丢掉。 */
const PRAISE_MARKERS: RegExp[] = [
  /(?:改得好|做得好|干得好|这就对了|就按这个|可以了|不错|很好|漂亮|靠谱)/u,
  /(?:辛苦了|辛苦你|谢谢你|感谢|麻烦你了|费心了)/u,
  /\b(?:well done|good job|nice work|great work|that's right|looks good|this is good|thanks|thank you|appreciate it)\b/iu,
];

/** 追责：他把问题指到我头上，且没有认可是我的自述——对事是对事，对人才有火。 */
const COMPLAINT_MARKERS: RegExp[] = [
  /(?:你|您).{0,4}(?:又|怎么|到底)?(?:搞错|弄错|写错|改坏|整错|删掉|删了|漏了)/u,
  /(?:为什么|为啥).{0,6}(?:又|还|总是|老是)/u,
  /(?:到底(?:有没有|做好|行不行|为什么)|这才(?:一个|几)|这也叫)/u,
  /(?:太.{1,4}了){2,}/u,
  /(?:又|还)(?:出现|冒出来).{0,6}(?:条|个|问题)/u,
  /(?:不是要求|说好的|不是说好).{0,8}(?:用|按|组件|库)/u,
  /\b(?:why (?:do|did|does|is|are) you|you (?:again|always|never)|this is broken|it (?:doesn't|does not) work|not working)\b/iu,
  /\b(?:that's not what (?:i|we) (?:asked|agreed)|you were supposed to)\b/iu,
];

/** 催促：时间压力本身就是一种情绪来源，和「你错怪我了」不是一回事。 */
const PRESSURE_MARKERS: RegExp[] = [
  /(?:尽快|赶紧|马上|立刻|现在就|今晚|今天之内|下班前|等着用|很急|急用)/u,
  /\b(?:asap|right now|immediately|by (?:end of day|eod|tonight)|urgent|waiting (?:on|for) (?:it|this))\b/iu,
];

/** 作罢：放弃争取，情绪是无奈；再判成失望就会把「我不争了」读成「你没给我」。 */
const RESIGNATION_MARKERS: RegExp[] = [
  /(?:算了|随你|你看着办|不管了|你决定|你定吧)/u,
  /\b(?:whatever|up to you|you decide|forget it|never mind|i give up)\b/iu,
];

/** 强度词：决定情绪强度，不决定方向。 */
const INTENSITY_MARKERS: RegExp[] = [
  /(?:非常|极其|根本|完全|彻底|太|特别|尤其|简直|离谱|过分|严重)/u,
  /(?:气死|火大|恼火|烦躁|焦虑|担心|失望|难受|崩溃|急|慌)/u,
  /(?:必须|一定要|绝不|千万|务必)/u,
  /\b(?:very|extremely|completely|totally|really|seriously|absolutely|furious|angry|anxious|worried|disappointed|frustrated)\b/iu,
];

/** 代价词：values 层「不为效率服务」的确定性证据。 */
const COST_MARKERS: RegExp[] = [
  /(?:放弃|牺牲|代价|错过|不换|宁愿不|宁可少|宁可慢|多花|花时间|不省这个)/u,
  /\b(?:give up|sacrifice|costs?|miss|slower|spend (?:more )?time|give up speed|pay the price)\b/iu,
];

/**
 * 每会话「每 tick 最多新增」配额（B1）：由 worker 在 commit 前对「本轮新增」执行。
 * 扫描期不再按它截断——否则最早入账的几条会永久占住名额，后面的合格消息永远进不来。
 */
export const EPISODE_PER_SESSION_PER_TICK = 5;

/**
 * 每会话扫描候选的防爆上限（B1）：只为防止单个会话把整窗刷满，
 * 与 tick 配额无关；缺省 200，远高于任何真实会话的候选量。
 */
export const EPISODE_SESSION_CANDIDATE_CEILING = 200;

export interface EpisodeMineOptions {
  /** 回看窗口（天），缺省取 config.episodeWindowDays。 */
  windowDays?: number;
  /** 单轮最多处理消息数。 */
  maxMessages?: number;
  /** 单轮最多产出 episode 数。 */
  maxEpisodes?: number;
  /** 每个会话的候选防爆上限（缺省 EPISODE_SESSION_CANDIDATE_CEILING=200）。
   *  注意：这不是「每 tick 入库上限」——那个在 worker 的 commit 前执行。 */
  perSessionCap?: number;
}

/**
 * P0-1：本 tick 的可观测读数。
 *
 * 为什么要它：D1 的判据是「非 work 事件 ≥20/日、候选 ≥5/轮」，过去这两个数字只能靠
 * `soul_episodes` 落表行数推断，而落表还受水位、cap、nearDup 与准入门影响，分不清
 * 「没挖到」和「挖到了没落表」。把挖掘侧的原始产出摊在返回值里，判据才可断言。
 */
export interface EpisodeMineStats {
  /** 本 tick 产出的事件候选数（排序/截断后真正返回的条数）。 */
  candidates: number;
  /** 本 tick 产出按 kind 的计数（只含出现过的 kind）。 */
  byKind: Partial<Record<SoulEpisodeKind, number>>;
  /** 其中「对人格层有信息量」的候选数：kind ≠ work 且 layers 非空（P0-1 判据 ≥5/轮）。 */
  personaCandidates: number;
  /** 带 layers 但 kind=work 的条数：只作判侧上下文，永不计入人格候选。 */
  contextOnly: number;
}

export interface EpisodeMineResult {
  episodes: SoulEpisode[];
  /** 可被 voice few-shot 引用的真实助手原话。voice 是「我」的语体，不是用户画像。 */
  voiceQuotes: SoulEpisodeQuote[];
  /**
   * P0-1：`kind=work` 但带 layers 的事件（只可能是同句附带语气词）。
   * work 永不进人格候选；这一路只给判侧当**上下文**看（「他派这个活时顺带纠正了什么」），
   * 由 P0-2 决定怎么消费——本文件不替它做准入决定。
   */
  contextEpisodes: SoulEpisode[];
  /** P0-1：本 tick 挖掘的原始读数（候选数 / 按 kind 计数 / 人格候选 / 仅上下文）。 */
  stats: EpisodeMineStats;
}

export const KIND_ZH: Record<SoulEpisodeKind, string> = {
  correction: "纠正",
  divergence: "分歧",
  value_conflict: "取舍",
  decision: "拍板",
  affect: "情绪",
  praise: "肯定",
  complaint: "追责",
  pressure: "催促",
  resignation: "作罢",
  work: "任务",
};

const KIND_BASE_VALENCE: Record<SoulEpisodeKind, number> = {
  correction: -0.55,
  divergence: -0.45,
  value_conflict: -0.2,
  decision: 0.3,
  affect: -0.35,
  praise: 0.5,
  complaint: -0.5,
  pressure: -0.25,
  resignation: -0.2,
  // work 不代表他有情绪：方向恒 0，强度由 scoreAffect 单独给固定小值。
  work: 0,
};

const KIND_WEIGHT: Record<SoulEpisodeKind, number> = {
  value_conflict: 5,
  correction: 4,
  complaint: 4,
  divergence: 3,
  decision: 2,
  praise: 2,
  pressure: 2,
  resignation: 1,
  affect: 1,
  // 最低权重：派活是背景信息，不该盖过任何一条真有态度的短句（排序用）。
  work: 0,
};

/**
 * P0-1：kind → 「它对哪些人格层有信息量」的显式映射（这是判据，不是渲染配置）。
 *
 * 为什么要有这张表：`kind` 只回答「这是哪类事」，人格落表要回答「这条能证明哪一层」。
 * 过去两者绑在 worker 的「非 work」过滤里——work 之外的 kind 一股脑进同一条候选流，
 * 于是「纠正 vs 追责 vs 拍板」对哪一层有价值全靠 LLM 自己猜：判据不可断言、统计不出来。
 *
 * 绑定口径（v4 §3 P0-1）：
 *  - correction / praise → identity：他说「我该怎么做才对」「这样对了」，说的是我是谁；
 *  - decision / value_conflict → values：拍板与取舍暴露「什么比什么重要」；
 *  - divergence → values + boundary：不认同既标价值观分歧，也标他能接受的边界；
 *  - complaint → boundary + relationship：追责既划红线，也记「我们之间」的账；
 *  - pressure / affect → relationship：催促与情绪是此刻关系的温度，不构成身份判断；
 *  - resignation → boundary + relationship：「算了 / 随你」是从此不再坚持的边界；
 *  - work → 空：派活本身不是人格证据（P0-1 保持「work 永不进候选」）。
 *
 * 只允许 identity / values / boundary / relationship：self / narrative / voice / human
 * 分别由自我史、摘要、语体语料与画像通道供料，事件层不得越权推断。
 */
export const EPISODE_KIND_LAYERS: Readonly<Record<SoulEpisodeKind, readonly SoulLayer[]>> = {
  correction: ["identity"],
  praise: ["identity"],
  decision: ["values"],
  value_conflict: ["values"],
  divergence: ["values", "boundary"],
  complaint: ["boundary", "relationship"],
  pressure: ["relationship"],
  affect: ["relationship"],
  resignation: ["boundary", "relationship"],
  work: [],
};

/** layers 的输出次序：固定成注入层序的子集，保证同一批信号每次算出同一个数组（可回放）。 */
const EPISODE_LAYER_ORDER: readonly SoulLayer[] = ["identity", "values", "boundary", "relationship"];

function hitCount(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const p of patterns) if (p.test(text)) n += 1;
  return n;
}

function firstHit(text: string, patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  const s = text.trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 纯指代/泛称：换个人、换件事都成立，不能当「这次因为什么」的锚。 */
const PRONOUN_OBJECT = /^(?:用户|他|她|它|我|你|对方|他们|她们|它们|你们|我们|这个|那个|这件|那件|这件事|那件事|这事|那事|此事|这次|那次|上述|以上)$/u;

/** 去掉句首的纠正语气词，留下「关于什么」。 */
export function cleanObjectPhrase(text: string): string {
  const s = text
    .replace(/^\s*[-*+·•]\s*/u, "")
    .replace(/^(?:不对|不是|错了|等等|停|别急)[，,。！!；;\s]*/u, "")
    .trim();
  return deriveEmotionObject(s);
}

/** 在原文里截取代价短语（找不到=空串，绝不补写）。 */
export function extractCost(text: string): string {
  const m = COST_MARKERS[0].exec(text);
  if (!m) return "";
  const idx = Math.max(0, m.index);
  const from = Math.max(0, idx - 12);
  const to = Math.min(text.length, idx + m[0].length + 18);
  return text.slice(from, to).replace(/\s+/gu, " ").trim();
}

/**
 * 语料卫生：L0 里混着注入体（压缩段、ACP 信封、图片回执、子代理通知、整段 prompt）。
 * 这些不是「他说的话」，拿去挖情绪会把系统提示词的情绪词算到他头上。
 */
export function isUtteranceLike(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  // 回执格式提示 / 目标轮询 / 时间采样都是宿主写给模型的状态行，不是他的发言；
  // 把它们当纠正会凭空生成「我没守住：回执格式不合规」，关系史里也会多出一个并不存在的冲突。
  if (/^(?:\[Compressed|\[已|已收到图片|<?acp|<acp|回执格式不合规|Continue working toward the objective|Time sampled|Background subagent|Agent \w|You are |你是一个|你在 |Update the session title|图片的整体预识别)/u.test(t)) return false;
  if (/^[\[{#<>|*]/u.test(t) || /":\s*"/u.test(t) || t.includes("```")) return false;
  if ((t.match(/[\u4e00-\u9fa5]/gu) ?? []).length < 4) return false;
  return true;
}

/** Lead 在团队频道的裁决：公开点名缺陷就是公开纠正，和私聊里的一句「你搞错了」同等真实。 */
const TEAM_VERDICT_MARKERS: RegExp[] = [
  // 必须点名「几处缺陷」：只说「缺陷」多半在讲验收标准，不是在裁决我的活。
  /(?:发现|存在)\s*\d+\s*处[^。！？]{0,10}(?:缺陷|问题)/u,
  // 「必修」单独出现多半是派单要求（「每条 concern 是否本票必修」），
  // 只有挂在具体 C 编号上的才是裁决。
  /C\d[^。！？]{0,24}(?:必修|缺陷)/u,
  // 「未通过」会被写成验收项（「哪些验收条你标成未通过」），只认「未过/打回/中断于」这类裁决语。
  /(?:未过|打回|未收口|中断于|没守住)/u,
];

/**
 * P0-1 附带信号（side-only）：**只加 layers，不改主 kind，也不参与情绪打分**。
 *
 * 为什么单开一张表：主分类器（`classifyMainKind`）的九类标记都要求「这句话的主立场就是它」，
 * 而「跑下全量测试，别再只贴总结」的主立场是派活，纠正只是修饰语。把它们塞进
 * `CORRECTION_MARKERS` 会让所有带「别再」的派活变成情绪事件（连带污染情绪对象与心境）；
 * 整句丢掉又等于「他纠正我怎么做」这句话从没发生过——人格永远学不到。
 * 所以这里只收「同一句里确实表明了立场」的窄语气词：命中就挂到层上，主 kind 照旧。
 */
interface ToneMarker {
  /** 信号名：进 layerSignals，审计时能回答「凭什么给这条 episode 标了这一层」。 */
  label: string;
  re: RegExp;
  /** 语气最接近的 kind（只用于 layerSignals 的归类，不参与主 kind 判定）。 */
  kind: SoulEpisodeKind;
  /** 指向的层。 */
  layers: readonly SoulLayer[];
}

const TONE_MARKERS: readonly ToneMarker[] = [
  // 纠正做法：「别再只贴总结」= 他不接受这种交付形态 → 红线。
  { label: "tone:stop-doing", re: /(?:别再只|不要再只|别只|不要只|别光|不要光|别再|不要再|以后别|下次别)/u, kind: "correction", layers: ["boundary"] },
  // 重复纠正：「跟你说过多少次」= 这条要求早该是我的行为准则 → 身份与红线。
  { label: "tone:repeat-correction", re: /(?:说过(?:多少)?次|跟你说过|提醒过|讲过(?:多少)?次)/u, kind: "correction", layers: ["identity", "boundary"] },
  // 认可做法：「照上次那样」= 他认这条路 → 身份的正向证据。
  { label: "tone:keep-doing", re: /(?:照上次|按上次|跟上次一样|就按刚才|保持这样|这样就对)/u, kind: "praise", layers: ["identity"] },
  // 重复抱怨：「又来了 / 老毛病」= 同一处红线被再次触碰 → 红线与欠账。
  { label: "tone:repeat-complaint", re: /(?:又来了|又犯|老毛病|屡教不改|又忘了)/u, kind: "complaint", layers: ["boundary", "relationship"] },
];

/** 主分类结果：主 kind 决定 episode.kind；附带信号只挂 layers，互不遮蔽。 */
interface UserMessageClassification {
  kind: SoulEpisodeKind;
  /** 落进 `soul_episodes.signals` 的词面标记（保持旧语义：主命中 + 槽位理由）。 */
  signals: string[];
  /** P0-1：本句全部「对某层有信息量」的信号（主 kind 的命中 + 附带信号 + 语气词）。 */
  layerSignals: SoulEpisodeSignal[];
}

/** 主分类：按固定优先序取**一个** kind（这是 episode 的身份，不因附带信号改变）。 */
function classifyMainKind(text: string): { kind: SoulEpisodeKind; signals: string[] } | null {
  // 只认 Lead 的裁决：builder 自己的完工回报里也写「必修」，那是转述不是被纠正。
  if (/^Team message from\s+lead\b/iu.test(text)) {
    const verdict = firstHit(text, TEAM_VERDICT_MARKERS);
    if (verdict) return { kind: "correction", signals: [verdict] };
  }
  const value = firstHit(text, VALUE_MARKERS);
  if (value) return { kind: "value_conflict", signals: [value] };
  // 肯定要在纠正/拍板之前判：真夸奖句里的「就按这个」不是新决策。
  const complaint = firstHit(text, COMPLAINT_MARKERS);
  const praise = firstHit(text, PRAISE_MARKERS);
  if (praise && !complaint && hitCount(text, CORRECTION_MARKERS) === 0) {
    return { kind: "praise", signals: [praise] };
  }
  if (complaint) return { kind: "complaint", signals: [complaint] };
  const corr = firstHit(text, CORRECTION_MARKERS);
  if (corr) return { kind: "correction", signals: [corr] };
  const div = firstHit(text, DIVERGENCE_MARKERS);
  if (div) return { kind: "divergence", signals: [div] };
  const resign = firstHit(text, RESIGNATION_MARKERS);
  if (resign) return { kind: "resignation", signals: [resign] };
  const pressure = firstHit(text, PRESSURE_MARKERS);
  if (pressure) return { kind: "pressure", signals: [pressure] };
  const dec = firstHit(text, DECISION_MARKERS);
  if (dec) return { kind: "decision", signals: [dec] };
  const strong = hitCount(text, INTENSITY_MARKERS);
  if (strong > 0 && /[！!]/u.test(text)) return { kind: "affect", signals: ["intensity"] };
  // 2026-11-07（P0-B）：最小任务通道。
  // 生产 L0 水位之后全是「跑下全量测试」「把这个删掉」这类派活，八类标记一个都不命中，
  // 于是 episodes=0、特质 0 票、人格永远长不出来。这里只补最窄的一条：**有动作词的陈述句**。
  // work 是给特质漂移与自我史供料，不代表他有情绪——emotionObjectForEpisode 对它返回空，
  // scoreAffect 也给固定的小强度（不参与心境门）。
  if (isTaskInstruction(text)) return { kind: "work", signals: ["task_instruction"] };
  return null;
}

/**
 * P0-1：本句命中的全部主分类信号（**不短路**）。
 * 主 kind 只取一个（优先序不变），但同句里其它类别的命中不该被丢掉——
 * 「不对，先把测试跑完」既是纠正，也带派活语境；「不错，但这里又错了」既有认可也有纠正。
 */
function collectKindHits(text: string): Array<{ kind: SoulEpisodeKind; signal: string }> {
  const tables: ReadonlyArray<{ kind: SoulEpisodeKind; patterns: RegExp[] }> = [
    { kind: "value_conflict", patterns: VALUE_MARKERS },
    { kind: "complaint", patterns: COMPLAINT_MARKERS },
    { kind: "correction", patterns: CORRECTION_MARKERS },
    { kind: "divergence", patterns: DIVERGENCE_MARKERS },
    { kind: "resignation", patterns: RESIGNATION_MARKERS },
    { kind: "pressure", patterns: PRESSURE_MARKERS },
    { kind: "decision", patterns: DECISION_MARKERS },
    { kind: "praise", patterns: PRAISE_MARKERS },
  ];
  const hits: Array<{ kind: SoulEpisodeKind; signal: string }> = [];
  for (const t of tables) {
    const signal = firstHit(text, t.patterns);
    if (signal) hits.push({ kind: t.kind, signal });
  }
  if (hitCount(text, INTENSITY_MARKERS) > 0 && /[！!]/u.test(text)) {
    hits.push({ kind: "affect", signal: "intensity" });
  }
  return hits;
}

/**
 * P0-1：把本句的所有信号摊成 (signal, kind, layer) 三元组。
 * 主 kind 自己的层由 `EPISODE_KIND_LAYERS` 另算（见 layersOf），这里负责
 * 「同一句里的其它信号」以及主分类器刻意不认的语气词。
 */
function collectLayerSignals(text: string): SoulEpisodeSignal[] {
  const out: SoulEpisodeSignal[] = [];
  const seen = new Set<string>();
  const push = (signal: string, kind: SoulEpisodeKind, layer: SoulLayer): void => {
    const key = `${signal}|${kind}|${layer}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ signal, kind, layer });
  };
  for (const hit of collectKindHits(text)) {
    for (const layer of EPISODE_KIND_LAYERS[hit.kind] ?? []) push(hit.signal, hit.kind, layer);
  }
  for (const tone of TONE_MARKERS) {
    const m = tone.re.exec(text);
    if (!m) continue;
    for (const layer of tone.layers) push(m[0], tone.kind, layer);
  }
  return out;
}

/**
 * 事件最终标注的层 = 主 kind 的层 ∪ 附带信号的层。
 * 空集返回 undefined（未标注），不写 []：两种状态在类型上不可区分，就别造第三种。
 */
function layersOf(
  kind: SoulEpisodeKind,
  signals: readonly SoulEpisodeSignal[],
): SoulLayer[] | undefined {
  const want = new Set<SoulLayer>(EPISODE_KIND_LAYERS[kind] ?? []);
  for (const s of signals) want.add(s.layer);
  if (want.size === 0) return undefined;
  return EPISODE_LAYER_ORDER.filter((l) => want.has(l));
}

/** 主 kind 决定 episode.kind；附带信号只挂 layers——work 仍是 work，但纠正/抱怨不再被丢。 */
function classifyUserMessage(text: string): UserMessageClassification | null {
  const main = classifyMainKind(text);
  if (!main) return null;
  return { kind: main.kind, signals: main.signals, layerSignals: collectLayerSignals(text) };
}

/** 任务指令的动作动词表（P0-B）：只认「让我去做事」的这一小撮，宁窄勿宽。
 *  「合」要排除「合法/合理/合适/合同」这类名词/形容词——「参数不合法」是报障，不是派活。 */
const TASK_ACTION_VERBS = /(?:跑|改|看|验|加|删|写|读|查|测|装|起|停|合(?!法|理|适|同|约)|补|换)/u;

/**
 * 派活句判定（P0-B）：
 *   - 必须通过语料卫生（注入体/回执/长 prompt 不算）；
 *   - 长度 ≥12（「跑一下」这种太短，当噪音）；
 *   - 命中动作动词；
 *   - 问句不产：以 ？/? 结尾，或含「吗/呢」——问句是在问，不是在派活。
 */
function isTaskInstruction(text: string): boolean {
  const t = text.trim();
  if (!isUtteranceLike(t)) return false;
  if (t.length < 12) return false;
  if (/[?？]\s*$/u.test(t)) return false;
  if (/(?:吗|呢)[?？]?\s*$/u.test(t)) return false;
  return TASK_ACTION_VERBS.test(t);
}

function scoreAffect(
  kind: SoulEpisodeKind,
  userText: string,
  decision: { signals: string[] },
): { valence: number; arousal: number; intensity: number; source: "lexicon" | "none" } {
  // 2026-11-07（P0-B）：work 不评分——派活句里出现「必须/完全」是任务要求，不是他的情绪。
  // 固定 0 / 0.25 / 0.15：够进事件史与特质投票，够不到心境门的强度阈值。
  if (kind === "work") return { valence: 0, arousal: 0.25, intensity: 0.15, source: "lexicon" };
  const strong = hitCount(userText, INTENSITY_MARKERS);
  const excl = (userText.match(/[！!]/gu) ?? []).length;
  let valence = KIND_BASE_VALENCE[kind];
  // 拍板句里如果夹着否定（「就按这个，别再加」），方向仍偏负——选择本身不是愉快。
  if (kind === "decision" && hitCount(userText, CORRECTION_MARKERS) > 0) valence = -0.3;
  if (kind === "value_conflict" && /(?:放弃|牺牲|代价|不换)/u.test(userText)) valence -= 0.05;
  const arousal = Math.min(0.9, 0.4 + 0.12 * strong + 0.08 * Math.min(3, excl));
  const intensity = Math.min(0.95, 0.35 + 0.12 * strong + 0.06 * Math.min(3, excl) + (decision.signals.length > 0 ? 0.05 : 0));
  return {
    valence: Number(Math.max(-1, Math.min(1, valence)).toFixed(3)),
    arousal: Number(arousal.toFixed(3)),
    intensity: Number(intensity.toFixed(3)),
    source: "lexicon",
  };
}

function toIso(row: EpisodeSourceRow): string {
  if (typeof row.recorded_at === "string" && row.recorded_at.length > 0) {
    const t = Date.parse(row.recorded_at);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  if (typeof row.timestamp === "number" && Number.isFinite(row.timestamp)) {
    // timestamp 可能是秒或毫秒：>1e12 视为毫秒。
    const ms = row.timestamp > 1e12 ? row.timestamp : row.timestamp * 1000;
    return new Date(ms).toISOString();
  }
  return "";
}

function sortKey(row: EpisodeSourceRow): number {
  const iso = toIso(row);
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isFinite(t)) return t;
  return typeof row.timestamp === "number" && Number.isFinite(row.timestamp) ? row.timestamp : 0;
}

/** 助手原话是否值得当 voice few-shot：第一人称、短、无代码/路径/清单。 */
export function isAssistantQuoteCandidate(text: string, minChars: number): boolean {
  const s = stripBullet(text).replace(/\s+/gu, " ").trim();
  const cjk = /[\u4e00-\u9fff]/u.test(s);
  const maxChars = cjk ? 80 : 200;
  if (s.length < Math.max(6, minChars) || s.length > maxChars) return false;
  if (/[{}<>`]/u.test(s)) return false;
  if (/(?:https?:\/\/|[A-Za-z]:[\\/]|\/[\w.-]+\/|\.(?:ts|js|json|md|ya?ml)\b)/u.test(s)) return false;
  if (/^#+\s/u.test(s) || /^\|/u.test(s) || /^[-*+·•]\s/u.test(s)) return false;
  if (/^(?:操作|结果|结论|输出|步骤|报错|错误|已|运行|执行|测试|文件|命令|参数|说明)[：:]/u.test(s)) return false;
  if (!/(?:我|\bI\b|\bI(?:'m|'ve|'d|'ll)\b)/u.test(s)) return false;
  return true;
}

/** 一句话是否值得当 few-shot（短、无代码/路径、像人话）。 */
export function isVoiceQuoteCandidate(text: string, minChars: number): boolean {
  const s = stripBullet(text).replace(/\s+/gu, " ").trim();
  const cjk = /[\u4e00-\u9fff]/u.test(s);
  const maxChars = cjk ? 80 : 200;
  if (s.length < Math.max(6, minChars) || s.length > maxChars) return false;
  if (/[{}<>`]/u.test(s)) return false;
  if (/(?:https?:\/\/|[A-Za-z]:[\\/]|\/[\w.-]+\/|\.(?:ts|js|json|md|ya?ml)\b)/u.test(s)) return false;
  if (/^#+\s/u.test(s) || /^\|/u.test(s)) return false;
  if (/[了吗呢？?]$/u.test(s) && s.length > 40) return false;
  return /(?:我|不要|别|必须|先|就|不|可以|按|这个|你|宁可|\bI\b|\bI(?:'m|'ve|'d|'ll)\b|\b(?:would rather|rather than|instead of|never|must|should|won't|don't)\b)/u.test(s);
}

/**
 * 挖掘：按会话排序后，对每条 user 消息判定是否构成一个 episode。
 * 不走 LLM，不做「总结」——只切段与摘句。
 */
const STANCE_MARKER_RE =
  /搞错|弄错|写错|改坏|漏了|不对|错了|假绿|谢谢|感谢|辛苦|改得好|做得好|不错|漂亮|靠谱|尽快|赶紧|马上|立刻|今晚|今天之内|等着用|急用|算了|随你|你看着办|不管了|你决定|缺陷|必修|打回|未收口|不通过|中断|太.{0,8}了|\b(?:wrong|incorrect|broke|missed|thanks|thank you|good job|well done|asap|urgent|whatever|up to you|you decide|broken|not working|disappointed|furious|angry)\b/iu;

/**
 * 立场切片：长 prompt 里只有带情绪/态度的那一句是他此刻的立场。
 * 全条塞进 userStance，会把「你是独立评审代理…」写成「我没守住的承诺」（生产实拍缺陷）。
 * 规则：标记句边界优先，取不到边界就围绕标记开窗；整条不超过 120 字则原样返回。
 */
export function stanceSnippet(raw: string): string {
  const text = (raw ?? "").replace(/\s+/gu, " ").trim();
  if (text.length <= 120) return text;
  const m = STANCE_MARKER_RE.exec(text);
  if (!m) return truncate(text, 120);
  const idx = m.index;
  const startBreak = Math.max(
    text.lastIndexOf("。", idx),
    text.lastIndexOf("！", idx),
    text.lastIndexOf("？", idx),
    text.lastIndexOf("；", idx),
    text.lastIndexOf(";", idx),
    text.lastIndexOf("\n", idx),
  );
  const tailSlices = ["。", "！", "？", "；", ";", "\n"]
    .map((ch) => text.indexOf(ch, idx + m[0].length))
    .filter((n) => n >= 0);
  const end = tailSlices.length > 0 ? Math.min(...tailSlices) + 1 : text.length;
  let seg = text.slice(startBreak + 1, end).trim();
  if (seg.length > 120 || seg.length < 4) {
    const from = Math.max(0, idx - 40);
    seg = text.slice(from, Math.min(text.length, idx + 80)).trim();
  }
  return truncate(seg, 120);
}

export function mineEpisodes(
  rows: EpisodeSourceRow[],
  cfg?: Partial<SoulMaintenanceConfig>,
  opts?: EpisodeMineOptions,
): EpisodeMineResult {
  const windowDays = opts?.windowDays ?? cfg?.episodeWindowDays ?? 30;
  const maxMessages = opts?.maxMessages ?? cfg?.maxEpisodeMessages ?? 4000;
  const maxEpisodes = opts?.maxEpisodes ?? cfg?.maxEpisodesPerRun ?? 120;
  const perSessionCap = opts?.perSessionCap ?? EPISODE_SESSION_CANDIDATE_CEILING;
  const minChars = cfg?.verbatimMinChars ?? 8;

  const sorted = [...(rows ?? [])]
    .filter((r) => r && typeof r.message_text === "string" && r.message_text.trim() !== "")
    .sort((a, b) => sortKey(a) - sortKey(b) || String(a.record_id).localeCompare(String(b.record_id)));
  const cutoff = Date.now() - windowDays * 86_400_000;
  const windowed = sorted
    .filter((r) => {
      const iso = toIso(r);
      const t = iso ? Date.parse(iso) : Number.NaN;
      return !Number.isFinite(t) || t >= cutoff;
    })
    .slice(-maxMessages);

  // 会话内上下文：我需要「我上一条说了什么」与「我下一条怎么回应」。
  const bySession = new Map<string, EpisodeSourceRow[]>();
  for (const r of windowed) {
    const key = String(r.session_id ?? "");
    const list = bySession.get(key);
    if (list) list.push(r);
    else bySession.set(key, [r]);
  }

  const episodes: SoulEpisode[] = [];
  const voiceQuotes: SoulEpisodeQuote[] = [];
  const quoteSeen = new Set<string>();

  for (const [sessionId, list] of bySession) {
    let sessionEpisodes = 0;
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      if (String(row.role) !== "user") continue;
      const raw = stripBullet(row.message_text).replace(/\s+/gu, " ").trim();
      if (raw.length < Math.max(6, minChars)) continue;
      // 注入体先剔掉再分类，否则系统提示词里的「不对/重做」会变成他的情绪事件。
      if (!isUtteranceLike(raw)) continue;
      // 团队频道的 Lead 派单会很长，但里面的裁决句（「发现 3 处收尾缺陷」）是他当众给的纠正，
      // 不能因为整条超长就丢掉；除此之外 800 字以上仍是粘贴的文档/日志。
      const teamLead = /^Team message from\s+lead\b/iu.test(raw);
      // 判「他这句话冲不冲我」要看两侧：我上一轮是否自称已修（复发槽）、我下一条怎么回（承认槽）。
      let prevAssistant = "";
      let prevId = "";
      for (let j = i - 1; j >= 0; j -= 1) {
        if (String(list[j].role) !== "user") {
          prevAssistant = stripBullet(list[j].message_text).replace(/\s+/gu, " ").trim();
          prevId = String(list[j].record_id ?? "");
          break;
        }
      }
      let nextAssistant = "";
      let nextId = "";
      for (let j = i + 1; j < list.length; j += 1) {
        if (String(list[j].role) !== "user") {
          nextAssistant = stripBullet(list[j].message_text).replace(/\s+/gu, " ").trim();
          nextId = String(list[j].record_id ?? "");
          break;
        }
      }
      // 槽位判追责：词表只负责「有没有缺陷」，是不是冲我来的由归因/我的回复/复发补齐。
      // 这样漏一个措辞只坏一个槽（「不管用」不在词表里），整条事件不再消失。
      // 团队频道里的长文是交办单/裁决书，不是他对我这一轮交付的当面判断：短裁决才走槽位。
      const blameSlots =
        teamLead && raw.length > 120
          ? { blame: false, taskLike: true, quoted: false, reason: "team-brief" }
          : appraiseBlameSlots(raw, {
              reply: nextAssistant,
              prevClaimedFix: claimOfFix(prevAssistant),
            });
      let cls = classifyUserMessage(raw);
      if (blameSlots.blame) {
        const tag = `slot:${blameSlots.reason}`;
        if (!cls) {
          // 词表里一个标记都没有（「搜索框搜索报错参数不合法」）——槽位补齐，事件不再整条消失。
          cls = { kind: "complaint", signals: [tag], layerSignals: collectLayerSignals(raw) };
        } else if (
          cls.kind === "decision" ||
          cls.kind === "pressure" ||
          cls.kind === "affect" ||
          cls.kind === "divergence" ||
          // P0-B：work 只是「有动作词」的兜底分类，一旦槽位判定这是冲我来的，
          // 它必须让位给 complaint——派活不追责，追责不派活。
          cls.kind === "work"
        ) {
          // P0-1：改的是 kind（身份），附带信号整批保留——work 升格成追责时，
          // 「他说过多少次」这类 identity/boundary 证据不该跟着一起消失。
          cls = { ...cls, kind: "complaint", signals: [...cls.signals, tag] };
        } else {
          // correction 本身已经是「他说我不对」，不硬改成追责；但把槽位理由留在 signals 里，
          // 关系史据此认「这话是冲我的交付来的」（BLAME_TIGHT 漏掉的措辞）。
          cls = { ...cls, signals: [...cls.signals, tag] };
        }
      }
      // 派活/引述句里带「怎么/为什么」会被词表读成 complaint，但落点是让我去做事，不是挑我的错。
      // 槽位已经确认它不是追责时，把这类降到 decision，避免关系史把它记成冲突。
      if (
        (cls?.kind === "complaint" || cls?.kind === "pressure") &&
        (blameSlots.taskLike || blameSlots.quoted) &&
        !blameSlots.blame
      ) {
        cls = { ...cls, kind: "decision", signals: [...cls.signals, "slot:instruction"] };
      }
      if (raw.length > 800) {
        // 长派单里偶尔也带「错/不对」字样，但只有裁决句才算纠正。
        if (!teamLead || cls?.kind !== "correction" || !TEAM_VERDICT_MARKERS.some((p) => p.test(raw))) continue;
      }
      // 情绪句式是短句：超过 400 字还能命中，多半是粘贴的日志，不是他此刻的态度。
      if (cls && (cls.kind === "praise" || cls.kind === "complaint" || cls.kind === "pressure" || cls.kind === "resignation") && raw.length > 400) continue;
      if (!cls) continue;
      const at = toIso(row);
      if (!at) continue;

      // 长 prompt 里只有带情绪的那一句是他的态度；整段通报进了 userStance，人格层就会把
      // 「你是独立评审代理…」当成自己没守住的承诺（2026-11-06 生产实拍）。取标记句而非整条。
      const stanceSource = teamLead ? raw.replace(/^Team message from\s+lead\s*[:：]\s*/iu, "") : raw;
      const stanceText = stanceSnippet(stanceSource);
      // 同一会话里重复的抱怨只留一条（词面近似即视为同一次）。
      // 对象「关于什么」：抽不到就留空，绝不退回「原文前 24 字」——那条兜底会把
      // 「他」「例会」这类指代/场地当对象（90 天回放实测 4 条可疑里 1 条是纯代词），
      // 而空对象在展示侧本来就有「未定位」，不缺这一句。
      const objectRaw = extractAffectReferent(stanceText) || cleanObjectPhrase(stanceText);
      // 抽出来的是纯代词也不算对象：`extractAffectReferent` 会先命中「他」，
      // 生产实测出现过 `任务：他`（11-07T17:30:45）。这类短语换个人、换件事都成立，
      // 留着只会让「上次因为什么」检索误配。
      const object = PRONOUN_OBJECT.test(objectRaw.trim()) ? "" : objectRaw;
      const key = normalizeText(raw);
      const nearDup = episodes.some(
        (e) =>
          e.sessionId === sessionId &&
          (normalizeText(e.userStance) === key ||
            (e.kind === cls.kind && e.object === object && Math.abs(Date.parse(e.at) - Date.parse(at)) < 10 * 60_000)),
      );
      if (nearDup) continue;
      if (sessionEpisodes >= perSessionCap) break;

      const firstSentence = (s: string): string => s.split(/[。；;！!？?\n]/u)[0] ?? s;
      const affect = scoreAffect(cls.kind, raw, cls);
      const cost = extractCost(`${raw} ${prevAssistant}`);
      const title = (object === "" ? KIND_ZH[cls.kind] : `${KIND_ZH[cls.kind]}：${object}`).slice(0, 80);
      const evidenceIds = Array.from(
        new Set([String(row.record_id ?? ""), prevId, nextId].filter((x) => x.length > 0)),
      );
      const layers = layersOf(cls.kind, cls.layerSignals);
      // 身份来源换成 L0 的真列（user_id/agent_id），不再拿配置里的展示名冒充说话人：
      // cfg.personName 只是标签，默认值「用户」还是角色词 → 按它建人只会得到空名单
      // （生产 57 条 episode 里 50 条 persons 为空就是这么来的）。
      // 只有真带出平台身份时才写 speaker；老行/老库留空 → worker 走展示名回退。
      const speakerUserId = String(row.user_id ?? "").trim();
      const speakerAgentId = String(row.agent_id ?? "").trim();
      // 角色词/代词不是人名：cfg.personName 默认值是「用户」，直接写进 speaker 会让
      // worker 按平台 id 建出一行叫「用户」的人（生产实测 p_5bafd183df38）。
      const speakerName = normalizePersonNameCandidate(cfg?.personName) ?? "";
      const episode: SoulEpisode = {
        episodeId: `ep-${textHash(`${sessionId}|${row.record_id}`)}`,
        at,
        day: at.slice(0, 10),
        kind: cls.kind,
        title,
        object: truncate(object, 48),
        participants: [cfg?.personName || "user", "assistant"],
        // 展示层仍然是 participants（里面有角色词、有标签）；身份只认这一份。
        ...(speakerUserId || speakerAgentId
          ? {
              speaker: {
                ...(speakerUserId ? { userId: speakerUserId } : {}),
                ...(speakerAgentId ? { agentId: speakerAgentId } : {}),
                ...(speakerName ? { displayName: speakerName } : {}),
              },
            }
          : {}),
        userStance: truncate(stanceText, 160),
        agentStance: prevAssistant ? truncate(firstSentence(prevAssistant), 120) : "",
        cost,
        outcome: nextAssistant ? truncate(firstSentence(nextAssistant), 100) : "",
        valence: affect.valence,
        arousal: affect.arousal,
        intensity: affect.intensity,
        evidenceIds,
        sessionId,
        quote: { text: truncate(stanceText, 160), role: "user", recordId: String(row.record_id ?? ""), at },
        affectSource: affect.source,
        signals: cls.signals,
        // P0-1：只在这一条真对某层有信息量时才写字段；空集保持 undefined（= 未标注，见 layersOf）。
        ...(layers ? { layers } : {}),
      };
      episodes.push(episode);
      sessionEpisodes += 1;

      // 注意：这里不收集用户原话。voice 是「我怎么说话」，用户原话属于关系证据
      // （episode.quote），混进来会把 voice 写成第三人称用户画像（2026-11-05 实拍缺陷）。
    }
  }

  // 助手语体语料：不依赖 episode，扫全窗 assistant 消息，按句切出第一人称短句。
  // 为什么必须是 assistant：注入标题是「## 我的说话方式」，引用户原话等于把用户画像
  // 冒充成我的人格（2026-11-05 生产实拍：3 条 voice 全是「他开口像下工单」）。
  for (const row of windowed) {
    if (String(row.role) !== "assistant") continue;
    const at = toIso(row);
    if (!at) continue;
    const flat = stripBullet(row.message_text).replace(/\s+/gu, " ").trim();
    if (flat === "") continue;
    for (const part of flat.split(/[。；;！!？?\n]/u)) {
      const s = part.trim().replace(/^[「"'（(]+|[」"'）)]+$/gu, "");
      if (!isAssistantQuoteCandidate(s, minChars)) continue;
      const text = truncate(s, 80);
      const qk = normalizeText(text);
      if (quoteSeen.has(qk)) continue;
      quoteSeen.add(qk);
      voiceQuotes.push({ text, role: "assistant", recordId: String(row.record_id ?? ""), at });
      if (voiceQuotes.length >= 200) break;
    }
    if (voiceQuotes.length >= 200) break;
  }

  // 截断按「新→旧」：cap 是防爆，不是质量筛选。按 kind 权重截断会让新消息永远排在
  // 高权重旧事件之后，被 slice 掉（B1 的同族饿死）。
  const capped =
    episodes.length > maxEpisodes
      ? [...episodes].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, maxEpisodes)
      : episodes;
  // 返回顺序仍按 kind 权重（判据/摘要消费侧依赖这个次序）。
  capped.sort((a, b) => KIND_WEIGHT[b.kind] - KIND_WEIGHT[a.kind] || Date.parse(b.at) - Date.parse(a.at));
  // P0-1：判据读数从「挖掘产出」这一层就给出来——落表行数受水位/cap/nearDup/准入门影响，
  // 分不清「没挖到」和「挖到了没落表」；这两个数字必须能在返回结构里被测试与生产同时读到。
  const byKind: Partial<Record<SoulEpisodeKind, number>> = {};
  for (const ep of capped) byKind[ep.kind] = (byKind[ep.kind] ?? 0) + 1;
  const contextEpisodes = capped.filter((ep) => ep.kind === "work" && (ep.layers?.length ?? 0) > 0);
  const stats: EpisodeMineStats = {
    candidates: capped.length,
    byKind,
    personaCandidates: capped.filter((ep) => ep.kind !== "work" && (ep.layers?.length ?? 0) > 0).length,
    contextOnly: contextEpisodes.length,
  };
  return { episodes: capped, voiceQuotes, contextEpisodes, stats };
}

/**
 * prompt 用的 digest 行：只给 LLM 事实（id/kind/时间/对象/双方原话/代价），
 * 不给它「结论」，让它在事实里找模式，而不是复述我们的措辞。
 */
export function episodeDigest(
  episodes: SoulEpisode[],
  opts?: { max?: number; maxChars?: number },
): string[] {
  const max = opts?.max ?? 60;
  const maxChars = opts?.maxChars ?? 220;
  const ordered = [...episodes].sort(
    (a, b) => KIND_WEIGHT[b.kind] - KIND_WEIGHT[a.kind] || Date.parse(b.at) - Date.parse(a.at),
  );
  return ordered.slice(0, max).map((e) => {
    const parts = [
      e.episodeId,
      e.kind,
      e.day,
      `object=${e.object || "未定位"}`,
      `user=${e.userStance}`,
      e.agentStance ? `me=${e.agentStance}` : "",
      e.cost ? `cost=${e.cost}` : "",
      `v=${e.valence}/i=${e.intensity}`,
    ].filter((x) => x !== "");
    let line = parts.join(" | ");
    if (line.length > maxChars) line = `${line.slice(0, maxChars)}…`;
    return line;
  });
}

/**
 * 事件 → appraisal（OCC/Scherer 五维）：不再是「按 kind 填常量」。
 * 每一维都来自可观察事实：
 *  - goalRelevance：事件强度（越强越相关）；
 *  - expectationViolation：纠正/分歧 > 取舍 > 拍板；
 *  - control：我当时有没有回应、回应里有没有改成动作；
 *  - normCompatibility：被纠正=我当时不合他的规范（低）；拍板/取舍=同向（高）；
 *  - agency：我有回应=self，否则=other（我只是被动方）。
 * 这让「同一句抱怨、我有没有接住」在情绪读数上真的不同，而不是所有纠正都 -0.55。
 */
function episodeAppraisalRaw(
  ep: Pick<SoulEpisode, "kind" | "agentStance" | "outcome" | "intensity"> & { userStance?: string },
  opts?: { publicSession?: boolean },
): AppraisalVector {
  const hasResponse = ep.agentStance.trim() !== "";
  const both = `${ep.userStance ?? ""} ${ep.agentStance}`;
  const utterance = ep.userStance ?? "";
  const publicExposure0 =
    opts?.publicSession === true ||
    /当着|当众|大家|会议上|\b(?:in front of (?:everyone|the team|the group)|publicly|on the (?:call|meeting)|in the meeting)\b/iu.test(both);
  const exposure0: "public" | "private" = publicExposure0 ? "public" : "private";
  // 四类短句的情绪方向由句式决定，不再套「纠正」的默认负值——
  // 否则「辛苦你了」会被算成负向事件，「算了」会被算成失望。
  if (ep.kind === "praise") {
    return {
      goalRelevance: 0.7,
      expectationViolation: 0.1,
      control: 0.7,
      normCompatibility: 1,
      agency: "other",
      socialExposure: exposure0,
      selfCause: false,
      otherCause: true,
      // 肯定句就是「他在认可我」：开心，而不是拍板式的踏实。
      affirmed: true,
      otherCost: /辛苦|谢谢|感谢|麻烦你|费心/u.test(utterance),
    };
  }
  // 追责句里的归因不能写死成「全是他的错」：他说「是不是你改坏的」时，
  // 我若回「不是我造成的」并贴了证据，这是被错怪（委屈），不是对他发火（恼火）；
  // 我若回「我漏了，这就补上」，这是认了（愧疚/害羞）。归因只看我说了什么，不看他骂得多重。
  if (ep.kind === "complaint") {
    // 认账只看我对这条消息的回复（outcome）；上一轮那句是「我上一条回复」，把这轮的
    // 追责套上去会误判（2026-11-06 灌数实测：上一轮「已按…验完」把「是不是你改坏的」
    // 读成愧疚）。但举证可以来自任何一侧——上一轮已经摆出证据时，这一轮也不该记成恼火。
    const mySide = ep.outcome.trim() !== "" ? ep.outcome : ep.agentStance;
    // 「不是我的问题」是明说；拿证据顶回（返回正常/上游缓存/日志/实测）同样是把我这边洗清，
    // 只是没把「不是我的问题」四个字说出来。举证不足就不算——否则每句追责都成了被错怪。
    const refuted = /返回正常|上游缓存|上游|缓存了旧数据|日志里没|查了日志|实测|真机|截图里|我查到|我核过|复现不出来|旧数据|\b(?:not my fault|not caused by me|your (?:problem|bug)|you got it wrong|upstream|cache[ds]?|logs? (?:show|say)|tested|reproduce[ds]?|old data)\b/iu.test(mySide);
    const exculpated = /不是我造成|不是我的问题|你的问题|你弄错|\b(?:not my fault|not caused by me|your (?:problem|bug)|you got it wrong)\b/iu.test(mySide) || refuted;
    const admitted = /我错了|是我的问题|我没做到|我重做|我改口|补上|已补|已按|已对齐|逐项量过|收口|\b(?:my fault|my mistake|i was wrong|i missed|i'll fix|i will fix|fixed|redo|already fixed|aligned|verified)\b/iu.test(mySide);
    // 他一边怪我，一边说了自己付出的代价（加班/被客户催/被骂）：这不是单纯的追责，
    // 是他也在为这件事付成本——情绪该是同情，不是恼火。代价只看他的话，不替他说。
    const otherCost =
      /(?:我|我们)(?:这边|那边)?(?:也|都)?(?:在)?(?:加班|熬夜|扛着|被客户|被领导|被骂|忙到现在|累)/u.test(utterance) ||
      /\b(?:i|we) (?:also )?(?:worked late|stayed up|got yelled at|got blamed|have been swamped|am exhausted|was up all night)\b/iu.test(utterance);
    return {
      goalRelevance: 0.35,
      expectationViolation: 0.75,
      control: 0.7,
      normCompatibility: 0.25,
      agency: admitted && !exculpated ? "self" : "other",
      socialExposure: exposure0,
      selfCause: admitted && !exculpated,
      // 认账才是「我的错」：路由愧疚/害羞看这一条。
      selfFault: admitted && !exculpated,
      otherCause: true,
      // 追责句本身就是「他在怪我」：路由委屈/恼火靠这一条，不靠 agency 泛判。
      otherBlame: true,
      otherCost,
      exculpated,
    };
  }
  if (ep.kind === "pressure") {
    return {
      goalRelevance: 0.6,
      expectationViolation: 0.5,
      control: 0.6,
      normCompatibility: 0.5,
      agency: "other",
      socialExposure: exposure0,
      selfCause: false,
      otherCause: true,
      urgency: true,
    };
  }
  if (ep.kind === "resignation") {
    return {
      goalRelevance: 0.4,
      expectationViolation: 0.6,
      control: 0.3,
      normCompatibility: 0.5,
      agency: "other",
      socialExposure: exposure0,
      selfCause: false,
      otherCause: true,
      resignation: true,
    };
  }
  const followed = /(?:改|已|完成|跑|贴|按|给|重做|补|换成)|\b(?:fixed|done|changed|ran|posted|per your|redid|replaced|updated|aligned)\b/iu.test(ep.outcome);
  // 目标相关度原来写 `0.45 + 0.5 * intensity`，而强度下限是 0.35 —— 任何事件都 ≥0.625，
  // 于是 pickTemplate 里「与目标无关」那半边（平静/意外/失落/失望）成了死代码。
  // 现在 = 强度基线 + 「这句话是不是在指挥方向」：带着就按/必须/批准/改成的要求
  // 一定与目标有关（否则他的要求会被读成「平静」，等于没听见）；纯插话才落回无关那半边。
  // 「先」后面接汉字才是派活（先百度/先review 里的后者是英文，不算）；「先做」已单列。
  const directive =
    /(?:就按|按方案|按我说|必须|要求|批准|开工|开始做|动手|改成|换成|落地|优先|先做|重做|务必|绝不|千万|先(?=[\u4e00-\u9fa5]))/u.test(utterance) ||
    /\b(?:go with|use this|must|required|approve[ds]?|start|change (?:it )?to|switch to|ship it|priority|redo|make sure|never)\b/iu.test(utterance);
  const goalRelevance = Number(
    Math.max(0.25, Math.min(0.95, 0.25 + 0.55 * ep.intensity + (directive ? 0.2 : 0))).toFixed(3),
  );
  // 「我以为要出问题，结果没出」：他就按原样继续、并明说没影响。这是释然，不是叠加的开心。
  const relieved =
    ep.kind === "decision" &&
    /没出问题|没影响|没坏|恢复正常|不影响|还好|\b(?:no issue|no impact|not broken|back to normal|fine|nothing broke)\b/iu.test(utterance);
  const expectationViolation = relieved
    ? 0.45
    : ep.kind === "correction" ? 0.75 : ep.kind === "divergence" ? 0.65 : ep.kind === "value_conflict" ? 0.6 : ep.kind === "decision" ? 0.25 : 0.5;
  const control = hasResponse ? (followed ? 0.75 : 0.6) : 0.3;
  const normCompatibility =
    ep.kind === "correction" ? 0.25 : ep.kind === "divergence" ? 0.35 : ep.kind === "value_conflict" ? 0.6 : ep.kind === "decision" ? 0.8 : 0.5;
  // 认账看我这条回复（outcome）；举证可以来自任何一侧——上一轮已经写明「不是我造成的」
  // 时，这一轮也不能再记成我认了。
  const mySide = ep.outcome.trim() !== "" ? ep.outcome : ep.agentStance;
  // 举证/甩锅可以来自任何一侧（我上一轮已经写明、这一轮只是追问）；认账只看我这条回复。
  const exculpated =
    /不是我造成|不是我的问题|你的问题|你弄错|\b(?:not my fault|not caused by me|your (?:problem|bug)|you got it wrong)\b/iu.test(`${ep.agentStance} ${ep.outcome}`);
  const selfCause =
    !exculpated &&
    /我错了|是我的问题|我没做到|我重做|我改口|补上|已补|已按|已对齐|逐项量过|收口|\b(?:my fault|my mistake|i was wrong|i missed|i'll fix|i will fix|fixed|redo|already fixed|aligned|verified)\b/iu.test(mySide);
  const otherCause =
    /不是我造成|不是我的问题|你的问题|你弄错|\b(?:not my fault|not caused by me|your (?:problem|bug)|you got it wrong)\b/iu.test(both) || exculpated;
  const publicExposure =
    opts?.publicSession === true ||
    /当着|当众|大家|会议上|\b(?:in front of (?:everyone|the team|the group)|publicly|on the (?:call|meeting)|in the meeting)\b/iu.test(both);
  // 我事后那条回复里写了交付/通过/改好了，且不是被他指出错的当场——这是我自己把事做成了。
  // decision 是「按我的判断落码」，correction 的 outcome 若只是「已改」不算成就，得有可核结果。
  const achievement =
    followed &&
    /完成|通过|全绿|交付|收口|改好了|修好|已修|已改|对齐|跑过|闭环|\b(?:done|passed|all green|delivered|closed|fixed|aligned|ran|closed the loop|shipped)\b/iu.test(ep.outcome) &&
    (ep.kind === "decision" || ep.kind === "correction" || ep.kind === "divergence");
  // 上面算出的 exculpated 直接决定 324/330 两条路由，别在这一层再重新判一次。
  // 我没回应，而这件事卡在外部（上游/接口/网络/环境/第三方）：agency 是 environment，
  // 不是「他造成的」——同样是没做成，可推不动的失落和被他否掉的失望不是同一种情绪。
  const envBlocked =
    !hasResponse &&
    /上游|接口|网络|环境|服务器|缓存|第三方|平台|依赖|\b(?:upstream|api|network|environment|server|cache|third[- ]party|platform|dependency)\b/iu.test(`${utterance} ${ep.outcome}`);
  // P5：他指出我错了（而不是仅仅提了不同意见）——短句追责与「你搞错/又坏/糊弄」这类
  // 明确指认才算；「再想想/再评估」是分歧，不是责怪。
  const otherBlame =
    /不对|错了|搞错|又坏|又错|点不动|糊弄|是不是你|你弄错|你改坏|你的问题|怎么回事|到底/u.test(utterance);
  return {
    goalRelevance: Number(goalRelevance.toFixed(3)),
    expectationViolation,
    control: Number(control.toFixed(3)),
    normCompatibility,
    agency: hasResponse || publicExposure ? "self" : envBlocked ? "environment" : "other",
    socialExposure: publicExposure ? "public" : "private",
    achievement,
    exculpated,
    selfCause,
    selfFault: selfCause,
    otherCause,
    otherBlame,
  };
}

/**
 * P5 事实门：他当面提起的是「我答应过、且已经到期没兑现」的事。
 *
 * 只看他说的话与事件标题（不看我的回复）：我的回复里一句「我补上了」是在收口，
 * 不是他在追账；把 outcome 也算进来，追账会被自己的修复词抵掉。
 * 关键词取「承诺域」×「逾期域」两侧同时命中，任一单侧都不成立——「什么时候」
 * 单出现在闲聊里不是追账，「承诺」单出现也只是在描述计划。
 */
export const PROMISE_WORDS = /(?:承诺|答应|说好|允诺|保证|约定|欠着|欠了|鸽了|说过(?:要|会))/u;
export const OVERDUE_WORDS = /(?:到期|过期|超期|逾期|还没|没做|没交|没兑现|忘了|拖到|拖了|迟了|多久了|什么时候(?:给|交|做|兑现))/u;

export function promiseOverduePointedOut(ep: {
  userStance?: string;
  title?: string;
  object?: string;
}): boolean {
  const said = `${ep.userStance ?? ""} ${ep.title ?? ""} ${ep.object ?? ""}`;
  return PROMISE_WORDS.test(said) && OVERDUE_WORDS.test(said);
}

/**
 * 重评的评价向量：同一条事件在「已经补上了」的证据下重判一次。
 *
 * 只改三件可复核的事：违背解除（×0.25，不是清零——事情确实出过岔子）、
 * 规范相容度抬到 0.7 以上（我补上了，就不算踩着自己的规矩）、
 * 去掉「放弃/催」这类一次性标记。正向禁令也一并解除：补上了就该能落正向。
 */
export function reappraisalOf(a: AppraisalVector): AppraisalVector {
  const base = applyAppraisalConsistency(a);
  return applyAppraisalConsistency({
    ...base,
    expectationViolation: clamp01(base.expectationViolation * 0.25),
    normCompatibility: Math.max(base.normCompatibility, 0.7),
    resignation: false,
    urgency: false,
    positiveForbidden: false,
  });
}

/**
 * 事件 → appraisal（出口门）：先按事实路由，再过两道 P5 门。
 *
 * 1) 归因一致性：agency=self ⇒ selfCause、agency=other ⇒ otherCause（互斥）；
 * 2) 事实门：他追的是「到期未兑现的承诺」→ 一律不许落正向（positiveForbidden）。
 * 门放在出口而不是各 kind 分支里：追账可能被事件分类成 complaint/pressure/decision
 * 任一种，逐分支补条件必然漏。
 */
export function episodeAppraisal(
  ep: Pick<SoulEpisode, "kind" | "agentStance" | "outcome" | "intensity"> & { userStance?: string; title?: string; object?: string },
  opts?: { publicSession?: boolean },
): AppraisalVector {
  const base = applyAppraisalConsistency(episodeAppraisalRaw(ep, opts));
  if (!promiseOverduePointedOut(ep)) return base;
  return applyAppraisalConsistency({
    ...base,
    goalRelevance: Math.max(base.goalRelevance, 0.75),
    expectationViolation: Math.max(base.expectationViolation, 0.75),
    // 欠账是我的事：不是「他造成的」，也不许靠「可控」落回踏实。
    agency: "self",
    selfCause: true,
    otherCause: false,
    normCompatibility: Math.min(base.normCompatibility, 0.2),
    positiveForbidden: true,
  });
}

/**
 * 写侧情绪门与读侧立场必须用同一条「已修复」判据。
 * 只认把结果对上原话的说法（补上了 / 已按 / 已对齐 / 已改 / 改完 / 改口）。
 * 「收口」是交付词，不算修复；「重做了 / 修好了」也不算——否则「我重做了，下轮再跑」会永久放行。
 * 证据看我的回复（agentStance）与他纠正之后的那条 outcome，两列任一命中即已修。
 */
export const REPAIRED_STANCE = /(?:补上了|已按|已对齐|已改|改完|改口)/u;

export function episodeRepaired(ep: { agentStance?: string; outcome?: string }): boolean {
  return REPAIRED_STANCE.test(ep.agentStance ?? "") || REPAIRED_STANCE.test(ep.outcome ?? "");
}

/**
 * 情绪对象：优先用事件里可复用的对象；任务标题/项目名不能变成判断倾向，
 * 此时退回 kind 级对象（被纠正/分歧/被拍板…）——仍然说得出「因为什么」，
 * 又不把一次性任务写成长期偏见。moodBiasLine 只接受 ≤20 字且换项目仍成立的对象。
 */
export function emotionObjectForEpisode(ep: Pick<SoulEpisode, "kind" | "object"> & { userStance?: string }): string {
  // 2026-11-07（P0-B）：work 只喂特质投票与自我史，不进情绪对象/心境——
  // 把「跑下全量测试」当情绪对象，等于说他对着测试用例有态度。
  if (ep.kind === "work") return "";
  const fromStance = extractAffectReferent(ep.userStance);
  if (fromStance !== "") return fromStance;
  const raw = typeof ep.object === "string" ? ep.object.trim() : "";
  const fromObject = extractAffectReferent(raw);
  if (fromObject !== "") return fromObject;
  // 抽不到就不退回「被纠正/被拍板」这种空类别，也不截断任务标题充数。
  return "";
}

/** episode → 情绪事件（心境积分用；对象与强度都来自真实片段）。 */
export function emotionEventFromEpisode(
  ep: SoulEpisode,
  cfg: Pick<SoulMaintenanceConfig, "emotionHalfLifeHours">,
  opts?: { publicSession?: boolean },
): EmotionEvent {
  const appraisal = episodeAppraisal(ep, opts);
  // 先按评价路由出模板，再拿模板的半衰期与支配感；强度/效价/唤醒仍用事件里的实测值。
  const template = appraiseEmotion({ at: ep.at, object: emotionObjectForEpisode(ep), appraisal });
  return {
    ...template,
    id: ep.episodeId,
    valence: ep.valence,
    arousal: ep.arousal,
    intensity: ep.intensity,
    appraisal,
    // 模板半衰期优先（自我意识类 8h / 高唤醒类 2h），取不到才回落到全局配置。
    halfLifeHours: template.halfLifeHours || cfg.emotionHalfLifeHours,
  };
}

/**
 * 重评读数的门：只有「他指出了问题，我后来补上了」这种可复核的修复才算重评。
 * 没有修复证据就不重评——把「我重做了，下轮再跑」当已修复，会永久放行。
 */
export function emotionReappraisalFromEpisode(
  ep: SoulEpisode,
  cfg: Pick<SoulMaintenanceConfig, "emotionHalfLifeHours">,
  opts?: { publicSession?: boolean },
): EmotionEvent | null {
  if (!episodeRepaired(ep)) return null;
  const appraisal = reappraisalOf(episodeAppraisal(ep, opts));
  const template = appraiseEmotion({ at: ep.at, object: emotionObjectForEpisode(ep), appraisal });
  // 重评的效价来自重判后的模板，不沿用原事件的实测 moodScore——重评就是「同一件事换个看法」，
  // 沿用旧效价等于换标签不换读数（旧行是负的、新行还是负的，等于没重评）。
  // 强度取事件强度的 0.8：修复让事情落地，但不该比当时那次冲击更强。
  return {
    ...template,
    id: ep.episodeId,
    valence: template.valence,
    arousal: ep.arousal,
    intensity: clamp01(ep.intensity * 0.8),
    appraisal,
    halfLifeHours: template.halfLifeHours || cfg.emotionHalfLifeHours,
  };
}

/**
 * 重评行要不要单独落：只有「重判后的标签/效价与原读数真的不同」才写。
 * 同一标签、同一效价再写一行只是把同一件事记两遍。
 */
export function reappraisalDiffers(
  original: { label: string; valence: number },
  reappraised: { label: string; valence: number } | null,
): boolean {
  if (!reappraised) return false;
  if (reappraised.label === original.label) return false;
  return Math.abs(reappraised.valence - original.valence) >= 0.05;
}

/**
 * P2-E：不算「人」的参与方词。`participants` 里既有展示名，也有双方角色名
 * （`mineEpisodes` 写的是 `cfg.personName || "user"` 与 `"assistant"`），
 * 角色名不是自然人，不能拿去建 `soul_person`。
 */
export const EPISODE_ROLE_PARTICIPANTS: readonly string[] = ["assistant", "user", "system", "助手", "用户", "系统"];

/**
 * 事件的说话人平台名（`soul_person.platform` 的取值）。运行时与存量补齐脚本共用一份，
 * 写成两处常量就会分成两个身份域：同一人被解析成两个 person_key。
 */
export const EPISODE_SPEAKER_PLATFORM = "tdai";

/**
 * P2-E：从一条事件的参与者名单里挑出「可能是自然人」的名字。
 *
 * 纯函数：不读库、不解析 person_key（那是调用方在写库前做的事），只做剔除与去重。
 * 剔除角色词/空串，保留原始大小写与顺序（展示名要原样进 resolvePerson）；
 * 去重按小写归一，避免同一人被写两次。
 *
 * 第二入参 `speaker` 只回答一件事：这条事件有没有真实平台身份（L0 的 user_id）。
 * 有就返回 `platformId`，调用方据此走「平台 id → 人」的强证据路径；
 * 没有就只给 `names`，调用方回退到展示名（历史数据只有名字可查）。
 * 这里不判断该走哪条路径、也不碰 store——那两件事都在调用侧。
 */
export function personsForEpisode(
  participants: readonly string[] | undefined,
  speaker?: { userId?: string; agentId?: string },
): { names: string[]; platformId?: string } {
  const roles = new Set(EPISODE_ROLE_PARTICIPANTS.map((r) => r.toLowerCase()));
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of participants ?? []) {
    const name = String(raw ?? "").trim();
    if (name === "") continue;
    const key = name.toLowerCase();
    if (roles.has(key) || roles.has(name)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  const platformId = String(speaker?.userId ?? "").trim();
  return platformId === "" ? { names } : { names, platformId };
}

/** 「给一个 query 能召回」：确定性检索（标题/对象/双方立场/原话）。 */
export function matchEpisode(ep: SoulEpisode, query: string): boolean {
  const q = normalizeText(query);
  if (q === "") return true;
  const hay = [ep.title, ep.object, ep.userStance, ep.agentStance, ep.cost, ep.outcome, ep.quote?.text ?? ""]
    .map(normalizeText)
    .join(" ");
  return hay.includes(q);
}
