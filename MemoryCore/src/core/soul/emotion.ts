/**
 * 情绪与心境（确定性，零 LLM）。
 *
 * 三个时间尺度严格分开：
 *  - 情绪（emotion）：必须有对象，半衰期约 3h；对象丢了就只剩心境。
 *  - 心境（mood）：无对象、有基线，半衰期约 48h；注入只写「相对基线的偏离」，
 *    绝不写绝对档位（避免模型把「今天偏沉」读成「我是一个悲观的人」）。
 *  - 人格（persona）：只承接「取舍」，不承接情绪（情绪进 values 的唯一通道是
 *    同一取舍在多次情绪事件中复现）。
 *
 * 现有代码里 appraisal.ts 的 valence 是「锚标签子串命中」，mood-line 的三档是
 * 「加权均值套阈值」——都只服务召回排序。这里补的是缺失的两件事：
 * ① 情绪必须带对象与强度衰减；② 心境必须与基线比较并给出可解释原因。
 */
import { cosine, survivesProjectSwap } from "./gates.js";
import type { SoulEpisode, SoulMaintenanceConfig } from "./types.js";

export interface AppraisalVector {
  /** 与当前目标的相关度 0..1 */
  goalRelevance: number;
  /** 预期违背程度 0..1（0=完全符合预期） */
  expectationViolation: number;
  /** 可控性 0..1（1=我能处理） */
  control: number;
  /** 与规范/红线相容度 0..1（1=完全相容） */
  normCompatibility: number;
  /** 事件主体 */
  agency: "self" | "other" | "environment";
  /**
   * 社交暴露。public = 当众被看见；private = 只有当事人。
   * 缺省 private，旧调用点不被迫改写。
   */
  socialExposure?: "public" | "private";
  /** 这件事是不是我造成的。缺省由 agency 推断。 */
  selfCause?: boolean;
  /** 这件事是不是对方造成的。缺省由 agency 推断。 */
  otherCause?: boolean;
  /** 我摆出了「不是我造成」的证据（被错怪）→ 委屈，不去记成对他的火气。 */
  exculpated?: boolean;
  /** 对方为这件事付出了代价（道谢/辛苦）→ 感激，不是泛泛的开心。 */
  otherCost?: boolean;
  /** 时间压力（被催）→ 着急，不是不安。 */
  urgency?: boolean;
  /** 已经放弃争取（算了/随你）→ 无奈，不是失望。 */
  resignation?: boolean;
  /**
   * 我自己把一件事做成了（交付/通过/改好了），且不是对方的夸奖。
   * 私下是开心，当众是自豪——两种正向不是同一个读数。
   */
  achievement?: boolean;
}

export interface EmotionEvent {
  id: string;
  at: string;
  /** 情绪对象：「何晨」「memory 召回」「这次部署」——没有对象就不是情绪。 */
  object: string;
  label: string;
  valence: number;
  arousal: number;
  /** 0..1 */
  intensity: number;
  /** 支配感 0..1（PAD 第三维）；旧事件没这一列时按 0.5 读，不假装知道。 */
  dominance?: number;
  appraisal: AppraisalVector;
  halfLifeHours: number;
}

export interface MoodState {
  valence: number;
  arousal: number;
  baselineValence: number;
  baselineArousal: number;
  /** 支配感：近段时间整体上「我撑不撑得住」。旧库缺这一列时读作基线 0.5。 */
  dominance?: number;
  baselineDominance?: number;
  updatedAt: string;
  sampleCount: number;
}

/**
 * 注入面心境：MoodState + 造成它的事件（去对象化后的最小三元组）。
 * 分开是刻意的——MoodState 是「现在多沉」，emotion 是「因为谁」；只有前者，
 * 模型只能说「我心情偏低」，说不出「上次因为假绿那事还没过去」。
 */
export interface SoulMoodState extends MoodState {
  emotion?: { object: string; label: string; intensity: number; at: string };
  /**
   * 情绪的混合：主情绪之外还压着哪一条（强度 ≥ 0.3 才写）。
   * 人不会一次只气一件事；只报一个标签会把「恼火里带着着急」说成「恼火」。
   */
  blend?: { label: string; intensity: number };
  /** 同一对象的复发判断。来自事件计数，不随 3 小时半衰期消失。 */
  objectStance?: string;
  /**
   * 情绪已过期、但同一对象近一周还在反复出现时的那条历史标签。
   * 只用来决定「先看哪一层」与情绪门，**不**渲染成因由——原因到期就该从注入里退场，
   * 不能因为要看注意力又把一句「正在消退」挂回去。
   */
  historyEmotion?: { object: string; label: string; at: string };
}

export interface MoodReading {
  mood: MoodState;
  /** 相对基线的偏离 */
  deltaValence: number;
  deltaArousal: number;
  /** 支配感相对基线（无该维度时为 undefined，不伪造 0）。 */
  deltaDominance?: number;
  /** 稳定短语（中文，可直接进 prompt） */
  phrase: string;
  /** 可解释原因（只来自真实情绪对象；无对象则不写原因） */
  reason?: string;
}

interface EmotionTemplate {
  label: string;
  valence: number;
  arousal: number;
  /**
   * 支配感 0..1（PAD 的第三维）：我在这件事上有多撑得住。
   * 只影响读法与注入措辞，不参与标签路由——先路由，再加维度，两件事不混。
   */
  dominance: number;
  /**
   * 该类情绪的默认半衰期（小时）。自我意识类（害羞/尴尬/愧疚）退得慢，
   * 高唤醒类（恼火/着急/振奋）退得快：一次被当众指出，不该两小时就消失，
   * 一次火气也不该挂两天。原先所有情绪共用 cfg.emotionHalfLifeHours=3。
   */
  halfLifeHours: number;
}

const POSITIVE_HIGH: EmotionTemplate = { label: "振奋", valence: 0.7, arousal: 0.7, dominance: 0.75, halfLifeHours: 2 };
const POSITIVE_CALM: EmotionTemplate = { label: "踏实", valence: 0.35, arousal: 0.2, dominance: 0.55, halfLifeHours: 12 };
const POSITIVE_SURE: EmotionTemplate = { label: "笃定", valence: 0.5, arousal: 0.3, dominance: 0.7, halfLifeHours: 8 };
const NEGATIVE_ANXIOUS: EmotionTemplate = { label: "悬着", valence: -0.4, arousal: 0.6, dominance: 0.3, halfLifeHours: 4 };
const NEGATIVE_ANGRY: EmotionTemplate = { label: "恼火", valence: -0.6, arousal: 0.7, dominance: 0.6, halfLifeHours: 2 };
const NEGATIVE_DISAPPOINTED: EmotionTemplate = { label: "失望", valence: -0.5, arousal: 0.3, dominance: 0.25, halfLifeHours: 6 };
const NEGATIVE_UNEASY: EmotionTemplate = { label: "不安", valence: -0.4, arousal: 0.55, dominance: 0.3, halfLifeHours: 4 };
const NEGATIVE_GUILT: EmotionTemplate = { label: "愧疚", valence: -0.5, arousal: 0.4, dominance: 0.25, halfLifeHours: 8 };
const NEGATIVE_SHY: EmotionTemplate = { label: "害羞", valence: -0.3, arousal: 0.6, dominance: 0.2, halfLifeHours: 8 };
const NEGATIVE_WRONGED: EmotionTemplate = { label: "委屈", valence: -0.45, arousal: 0.45, dominance: 0.35, halfLifeHours: 6 };
const POSITIVE_JOY: EmotionTemplate = { label: "开心", valence: 0.7, arousal: 0.55, dominance: 0.7, halfLifeHours: 4 };
const POSITIVE_RELIEF: EmotionTemplate = { label: "安心", valence: 0.4, arousal: 0.15, dominance: 0.6, halfLifeHours: 12 };
const POSITIVE_GRATEFUL: EmotionTemplate = { label: "感激", valence: 0.55, arousal: 0.35, dominance: 0.45, halfLifeHours: 6 };
const POSITIVE_PRIDE: EmotionTemplate = { label: "自豪", valence: 0.65, arousal: 0.5, dominance: 0.75, halfLifeHours: 6 };
const NEGATIVE_URGENT: EmotionTemplate = { label: "着急", valence: -0.35, arousal: 0.75, dominance: 0.3, halfLifeHours: 2 };
const NEGATIVE_RESIGNED: EmotionTemplate = { label: "无奈", valence: -0.3, arousal: 0.2, dominance: 0.2, halfLifeHours: 6 };
const NEUTRAL_SURPRISE: EmotionTemplate = { label: "意外", valence: 0, arousal: 0.5, dominance: 0.45, halfLifeHours: 2 };
const NEUTRAL_CALM: EmotionTemplate = { label: "平静", valence: 0, arousal: 0.1, dominance: 0.6, halfLifeHours: 12 };
// ── 2026-11-06 情绪扩充：从「正负 × 唤醒」的 18 个模板补到 24 个。
// 新增的六个都不是同义词替换，各自有独立的触发条件（见 pickTemplate）：
// 释然要「违背后解除」，尴尬要「当众 + 不是我造成 + 场面失序」，
// 失落要「非我可控 + 没做成」，烦躁要「他造成 + 我还拿得住 + 没到被错怪」，
// 欣慰要「我做成 + 强烈目标相关」，同情要「他付出了代价 + 事情没成」。
const POSITIVE_RELIEVED: EmotionTemplate = { label: "释然", valence: 0.45, arousal: 0.2, dominance: 0.65, halfLifeHours: 6 };
const NEGATIVE_AWKWARD: EmotionTemplate = { label: "尴尬", valence: -0.35, arousal: 0.65, dominance: 0.25, halfLifeHours: 8 };
const NEGATIVE_LOST: EmotionTemplate = { label: "失落", valence: -0.45, arousal: 0.25, dominance: 0.25, halfLifeHours: 8 };
const NEGATIVE_IRRITATED: EmotionTemplate = { label: "烦躁", valence: -0.4, arousal: 0.5, dominance: 0.4, halfLifeHours: 4 };
const POSITIVE_WARM: EmotionTemplate = { label: "欣慰", valence: 0.55, arousal: 0.4, dominance: 0.65, halfLifeHours: 8 };
const NEGATIVE_PITY: EmotionTemplate = { label: "同情", valence: -0.3, arousal: 0.35, dominance: 0.4, halfLifeHours: 6 };

const EMOTION_TEMPLATES: readonly EmotionTemplate[] = [
  POSITIVE_HIGH,
  POSITIVE_CALM,
  POSITIVE_SURE,
  NEGATIVE_ANXIOUS,
  NEGATIVE_ANGRY,
  NEGATIVE_DISAPPOINTED,
  NEGATIVE_UNEASY,
  NEGATIVE_GUILT,
  NEGATIVE_SHY,
  NEGATIVE_WRONGED,
  POSITIVE_JOY,
  POSITIVE_RELIEF,
  POSITIVE_GRATEFUL,
  POSITIVE_PRIDE,
  NEGATIVE_URGENT,
  NEGATIVE_RESIGNED,
  NEUTRAL_SURPRISE,
  NEUTRAL_CALM,
  POSITIVE_RELIEVED,
  NEGATIVE_AWKWARD,
  NEGATIVE_LOST,
  NEGATIVE_IRRITATED,
  POSITIVE_WARM,
  NEGATIVE_PITY,
];

export const EMOTION_LABELS = EMOTION_TEMPLATES.map((t) => t.label);

/** 标签 → 模板：落库只有标签与强度，读侧要按标签回查半衰期重算衰减。 */
const TEMPLATE_BY_LABEL: ReadonlyMap<string, EmotionTemplate> = new Map(
  EMOTION_TEMPLATES.map((t) => [t.label, t] as const),
);

/** 某类标签的默认半衰期（小时）；未知标签（旧库历史标签）回落到调用方给的缺省。 */
export function templateHalfLifeHours(label: string, fallback = 4): number {
  return TEMPLATE_BY_LABEL.get((label ?? "").trim())?.halfLifeHours ?? fallback;
}

/**
 * 评价规则版本：改「同一件事被判成哪种情绪」的判据（路由顺序、目标相关度公式、
 * 归因三元组…）时必须递增。只哈希标签集合是不够的——规则变了、标签没变，
 * 版本号不动，情绪史里就会留着按旧判据写下的标签，和当下的判断自相矛盾。
 */
// r3：情绪对象补「可复用情境」抽取（公开裁决/生产级标准/被错怪/他对我的信任）。
// 对象变了就不再是纯读数：同一对象复现会进判断门与注入原因，所以必须换版本留档。
// r4：归因只看「我对这条追责的回复」，不再拿上一轮的表态算这一轮（2026-11-06 第二租户
// 灌数实测：上一轮「不是我造成的」把这一轮「排序这么乱」也读成委屈，真正的恼火丢失）。
const APPRAISAL_RULE_REV = "r4-reply-scoped-attribution";

/**
 * 情绪模板版本：标签集合 + 评价规则版本（FNV-1a）。任一变了版本就变——
 * 情绪史按「事件 × 版本」落行，旧行不被静默改写，审计能看出当时按哪版规则判的。
 */
export const EMOTION_TEMPLATE_VERSION = `et-${fnv1a(`${EMOTION_LABELS.join("|")}|${APPRAISAL_RULE_REV}`)}`;

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * OCC/Scherer 风格的结构化评估 → 情绪。规则是显式的，不做「关键词猜情绪」：
 * 同一个词在不同目标/可控性下会是不同情绪（「又失败了」在可控时=恼火，不可控时=不安）。
 */
export function appraiseEmotion(input: {
  id?: string;
  at: string;
  object: string;
  appraisal: AppraisalVector;
  halfLifeHours?: number;
}): EmotionEvent {
  const a = input.appraisal;
  const template = pickTemplate(a);
  // 强度不再只取「目标相关」与「违背」的最大值：两件事同时成立才最疼
  // （他当面指出的是我最在意的东西）。出行权重 0.55/0.45；公开场合略放大——
  // 被看见的错和只有两个人知道的错，强度本来不同。维度先夹到 0..1，负值不参与。
  const g = clamp01(a.goalRelevance);
  const v = clamp01(a.expectationViolation);
  const exposure = (a.socialExposure ?? "private") === "public" ? 1.12 : 1;
  const intensity = clamp01((0.55 * g + 0.45 * v) * (0.7 + 0.3 * clamp01(a.normCompatibility)) * exposure);
  return {
    id: input.id ?? `emo-${input.at}-${template.label}`,
    at: input.at,
    object: input.object,
    label: template.label,
    valence: template.valence,
    arousal: template.arousal,
    intensity,
    dominance: template.dominance,
    appraisal: a,
    halfLifeHours: input.halfLifeHours ?? template.halfLifeHours,
  };
}

/**
 * 从事件双方原话算评价。不猜情绪词，只看三件可复核的事：
 * 当众与否、归因自己、归因对方。旧字段缺了就按主体和强度补。
 */
export function appraisalFromEpisode(ep: {
  userStance?: string;
  agentStance?: string;
  valence?: number;
  arousal?: number;
  agency?: AppraisalVector["agency"];
}, opts?: { publicSession?: boolean }): AppraisalVector {
  const user = ep.userStance ?? "";
  const me = ep.agentStance ?? "";
  const both = `${user} ${me}`;
  // 生产原话不写「我错了」。指出不对之后我补上、对齐、量过，就是认了是自己的问题。
  const selfCause = /我错了|是我的问题|我没做到|我重做|我改口|补上|已补|已按|已对齐|逐项量过|收口/u.test(me);
  // 对方指出不对、我没有认，归因在对方。不要求原话写出「你的问题」。
  const pointedOut = /不对|错了|搞错|有问题/u.test(user);
  const praised = /改得好|做得好|就按这个|不错/u.test(user);
  const otherCause = /不是我造成|不是我的问题|你的问题|你弄错/u.test(both) || (pointedOut && !selfCause) || praised;
  // 暴露面不只看原话里有没有「当众」：团队频道/群会话本身就是有旁人的场，
  // 在那里被指出错，和一对一私聊被指出错，不是同一种情绪（害羞 vs 愧疚）。
  const publicExposure = opts?.publicSession === true || /当着|当众|大家|会议上/u.test(both);
  const exposure = publicExposure ? "public" : "private";
  const violated = (ep.valence ?? 0) < 0 || /不对|错了|问题/u.test(both);
  return {
    goalRelevance: violated ? 0.3 : Math.max(0.6, Math.abs(ep.valence ?? 0.5)),
    expectationViolation: violated ? 0.8 : 0.1,
    control: ep.arousal ?? 0.5,
    normCompatibility: selfCause ? 0.4 : 0.8,
    agency: ep.agency ?? (selfCause || publicExposure ? "self" : otherCause ? "other" : "environment"),
    socialExposure: exposure,
    selfCause,
    otherCause,
  };
}

function pickTemplate(a: AppraisalVector): EmotionTemplate {
  const exposure = a.socialExposure ?? "private";
  const selfCause = a.selfCause === true;
  const otherCause = a.otherCause === true;
  const goalHit = a.goalRelevance >= 0.55;
  const violated = a.expectationViolation >= 0.5;
  // 当众被看见自己的错，先是害羞，不是愧疚。愧疚要私下、且归因到自己。
  if (exposure === "public" && (selfCause || a.agency === "self") && violated) return NEGATIVE_SHY;
  // 当众把自己做成的事收口，是自豪：和私下的安心不是一个读数（被看见才成立）。
  if (exposure === "public" && selfCause && !violated && goalHit) return POSITIVE_PRIDE;
  // 已经放弃争取：先于愧疚与委屈——它不是「我错了」，也不是「你错怪我了」。
  if (a.resignation === true && violated) return NEGATIVE_RESIGNED;
  // 他付出了代价、事情还没成：是同情，不是「谢谢」的感激（感激要求事情成了）。
  if (a.otherCost === true && violated) return NEGATIVE_PITY;
  // 违背后解除了（原本以为要出问题，结果没出）：释然是「松下来」，不是叠加的开心。
  if (!violated && clamp01(a.expectationViolation) >= 0.4 && a.control >= 0.6) return POSITIVE_RELIEVED;
  // 当众出了岔子、但不是我的锅：是尴尬（场面上的失序），不是委屈（我被错怪）。
  if (exposure === "public" && violated && !selfCause && !a.exculpated && otherCause) return NEGATIVE_AWKWARD;
  // 私下归因自己：我造成的，是愧疚，不是「还没收口」的悬着。
  if (selfCause && violated && exposure === "private") return NEGATIVE_GUILT;
  // 被催着要结果：时间压力先于归因判定，不能被读成「你错怪我了」。
  if (a.urgency === true && violated) return NEGATIVE_URGENT;
  // 对方为我付了代价（道谢/辛苦）：是感激，不是泛泛的开心。
  if (a.otherCost === true && !violated) return POSITIVE_GRATEFUL;
  // 我被错怪并摆出了证据：先于恼火——这是委屈，不是对他的火气。
  if (a.exculpated === true && !selfCause && violated) return NEGATIVE_WRONGED;
  // 他造成的、但没到「被错怪」、我还拿得住：是烦躁（低强度、可处理），不是委屈。
  if (otherCause && !selfCause && violated && !a.exculpated && a.normCompatibility >= 0.3 && a.control >= 0.6) {
    return NEGATIVE_IRRITATED;
  }
  // 对方造成、踩了我的规矩、且我还能处理：是恼火，不是「没办法」的不安。
  if (otherCause && !selfCause && violated && a.normCompatibility < 0.3) return NEGATIVE_ANGRY;
  // 对方造成、我没有做错，是委屈，不是对事的恼火。
  if (otherCause && !selfCause && violated && a.normCompatibility >= 0.3) return NEGATIVE_WRONGED;
  // 自己把事做成、私下里没人看见，是开心；同样的事当众收口是自豪（上面那条）。
  if (a.achievement === true && !violated && goalHit && exposure === "private") return POSITIVE_JOY;
  // 对方肯定是开心，不要求当众；我自己把一件事收口是安心。两者不是同一个正向读数。
  if (goalHit && !violated && otherCause) return POSITIVE_JOY;
  // 我自己把一件很在意的事做成了：是欣慰（带温度的自我肯定），比「安心」更主动。
  if (goalHit && !violated && selfCause && exposure === "private" && clamp01(a.goalRelevance) >= 0.75) {
    return POSITIVE_WARM;
  }
  if (goalHit && !violated && selfCause && exposure === "private") return POSITIVE_RELIEF;
  if (a.normCompatibility < 0.3) {
    return selfCause ? NEGATIVE_GUILT : NEGATIVE_UNEASY;
  }
  if (goalHit && !violated) return a.control >= 0.6 ? POSITIVE_SURE : POSITIVE_CALM;
  if (goalHit && violated) return a.control >= 0.6 ? POSITIVE_HIGH : NEGATIVE_ANXIOUS;
  if (!goalHit && violated) {
    // 不是谁做错，是环境不配合、我又推不动：是失落，不是「还没想明白」的悬着。
    if (a.agency === "environment" && a.control < 0.4) return NEGATIVE_LOST;
    if (a.agency === "self") return NEGATIVE_DISAPPOINTED;
    return a.control >= 0.6 ? NEGATIVE_ANGRY : NEGATIVE_UNEASY;
  }
  if (!goalHit && !violated) return a.control >= 0.6 ? NEUTRAL_CALM : NEUTRAL_SURPRISE;
  return NEUTRAL_SURPRISE;
}

/** 情绪强度按半衰期衰减（返回 0..1）。 */
export function decayedIntensity(
  event: Pick<EmotionEvent, "intensity" | "at" | "halfLifeHours">,
  now: string,
): number {
  const dtHours = (Date.parse(now) - Date.parse(event.at)) / 3_600_000;
  if (!Number.isFinite(dtHours)) return 0;
  if (dtHours <= 0) return clamp01(event.intensity);
  return clamp01(event.intensity * Math.pow(2, -dtHours / Math.max(0.1, event.halfLifeHours)));
}

/**
 * 落库情绪的二次衰减：库里存的是「写入那一刻」已经衰减过的值，
 * 所以从写入时刻（asOf）再衰到 now——两段相乘正好等于「事件发生 → now」，
 * 不会把同一次衰减算两遍。
 */
export function decayedStoredIntensity(
  e: { label: string; intensity: number; asOf: string },
  now: string,
): number {
  return decayedIntensity(
    { intensity: e.intensity, at: e.asOf, halfLifeHours: templateHalfLifeHours(e.label) },
    now,
  );
}

/** 强度低于这个值就当听不见了：不再作为「当下原因」注入。 */
export const EMOTION_EXPIRY_INTENSITY = 0.05;
/** 年龄超过这么多倍半衰期也当过期——强度再高也不能拿三周前的事解释今天。 */
export const EMOTION_EXPIRY_HALF_LIVES = 6;

/**
 * 情绪是否已经到期（事件原值口径）。到期 = 衰减后 < 0.05，或年龄 > 6 个半衰期。
 * 这是「原因会过期」的判据：只要窗口里还有一条说得出口的对象就拿它当原因，
 * 注入面会永远写「因为 X 正在消退」——那不是记忆，是卡住的解释。
 */
export function isEmotionExpired(
  e: Pick<EmotionEvent, "label" | "at" | "intensity">,
  now: string,
): boolean {
  const at = Date.parse(e.at);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return true;
  if (nowMs - at > EMOTION_EXPIRY_HALF_LIVES * templateHalfLifeHours(e.label) * 3_600_000) return true;
  return (
    decayedIntensity({ intensity: e.intensity, at: e.at, halfLifeHours: templateHalfLifeHours(e.label) }, now) <
    EMOTION_EXPIRY_INTENSITY
  );
}

/** 落库行的到期判据：强度是写入时刻的值，所以二次衰减从 asOf 起算，年龄仍从事件发生算。 */
export function isStoredEmotionExpired(
  e: { label: string; intensity: number; at: string; asOf: string },
  now: string,
): boolean {
  const at = Date.parse(e.at);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return true;
  if (nowMs - at > EMOTION_EXPIRY_HALF_LIVES * templateHalfLifeHours(e.label) * 3_600_000) return true;
  return decayedStoredIntensity(e, now) < EMOTION_EXPIRY_INTENSITY;
}

/**
 * 「此刻还在场」的那条情绪：先看仍活跃的（强度 ≥0.15），其次才看窗口里最近一条；
 * 两者都要过到期判据，都不在 → undefined：只写心境、不写原因。
 */
export function pickCurrentEmotion<T extends EmotionEvent>(
  ranked: T[],
  latest: T | undefined,
  now: string,
): T | undefined {
  const live = ranked.find((e) => isReusableAffectObject(e.object) && !isEmotionExpired(e, now));
  if (live) return live;
  if (latest && isReusableAffectObject(latest.object) && !isEmotionExpired(latest, now)) return latest;
  return undefined;
}

/** 仍「在场」的情绪（强度 ≥ threshold），按衰减后强度降序。 */
export function activeEmotions(
  events: EmotionEvent[],
  now: string,
  threshold = 0.15,
): Array<EmotionEvent & { effectiveIntensity: number }> {
  return events
    .map((e) => ({ ...e, effectiveIntensity: decayedIntensity(e, now) }))
    .filter((e) => e.effectiveIntensity >= threshold)
    .sort((x, y) => y.effectiveIntensity - x.effectiveIntensity);
}

export function emptyMood(
  now: string,
  baseline?: { valence?: number; arousal?: number; dominance?: number },
): MoodState {
  return {
    valence: baseline?.valence ?? 0,
    arousal: baseline?.arousal ?? 0.3,
    dominance: baseline?.dominance ?? 0.5,
    baselineValence: baseline?.valence ?? 0,
    baselineArousal: baseline?.arousal ?? 0.3,
    baselineDominance: baseline?.dominance ?? 0.5,
    updatedAt: now,
    sampleCount: 0,
  };
}

/**
 * 心境积分：先前心境按半衰期衰减后作为先验，再与在场情绪做强度加权平均。
 * 无对象、无事件时也成立（回归基线）——这正是心境与情绪的区别。
 */
export function integrateMood(
  prev: MoodState | null,
  events: EmotionEvent[],
  now: string,
  cfg: Pick<SoulMaintenanceConfig, "moodHalfLifeHours">,
  baseline?: { valence?: number; arousal?: number; dominance?: number },
): MoodState {
  const base = prev ?? emptyMood(now, baseline);
  const dtHours = Math.max(0, (Date.parse(now) - Date.parse(base.updatedAt)) / 3_600_000);
  const priorWeight = Math.pow(2, -dtHours / Math.max(0.1, cfg.moodHalfLifeHours));
  // 先验不是「原样保留上一次读数」，而是「向基线回落一半衰期」：
  // 偏离量乘衰减权重再加回基线。否则没有新情绪时心境会永久停在旧值——
  // 那就成了「一次性情绪 = 永久人格」，正是要避免的开环。
  const priorValence = base.baselineValence + (base.valence - base.baselineValence) * priorWeight;
  const priorArousal = base.baselineArousal + (base.arousal - base.baselineArousal) * priorWeight;
  const baseDom = base.baselineDominance ?? 0.5;
  const curDom = base.dominance ?? baseDom;
  const priorDominance = baseDom + (curDom - baseDom) * priorWeight;
  let wSum = priorWeight;
  let vSum = priorValence * priorWeight;
  let aSum = priorArousal * priorWeight;
  let dSum = priorDominance * priorWeight;
  for (const e of events) {
    const w = decayedIntensity(e, now);
    if (w <= 0) continue;
    wSum += w;
    vSum += e.valence * w;
    aSum += e.arousal * w;
    dSum += (e.dominance ?? 0.5) * w;
  }
  const bv = base.baselineValence;
  const ba = base.baselineArousal;
  return {
    valence: clamp(wSum > 0 ? vSum / wSum : bv, -1, 1),
    arousal: clamp(wSum > 0 ? aSum / wSum : ba, 0, 1),
    dominance: clamp(wSum > 0 ? dSum / wSum : baseDom, 0, 1),
    baselineValence: bv,
    baselineArousal: ba,
    baselineDominance: baseDom,
    updatedAt: now,
    // 样本数 = 本轮真正吸收的事件条数，不是历史累加。旧实现 base.sampleCount + events.length
    // 每轮 +86，生产库读到 3823 时它既不是样本数也不是轮数，只是「重跑过多少次」。
    // 现在空的 0 只表示「这一轮没有可积分的事件」（首轮回放判据仍用它）。
    sampleCount: events.length,
  };
}

/**
 * 情绪对象抽取（确定性，零 LLM）：L1 只有 content 摘要，没有结构化 object 字段，
 * 所以从记录正文首句里取一个「话题短语」当对象（如「何晨指出假绿」）。
 * 取不到（空/纯代词/超短）就返回空串——空对象时 readMood 不写原因（不编造对象）。
 */
export function deriveEmotionObject(raw?: string | null): string {
  if (typeof raw !== "string") return "";
  let s = raw.replace(/\s+/g, " ").trim();
  // 去弹头与引用包装
  s = s.replace(/^[-*+·•]\s*/, "").replace(/^\[(?:strict_rule|identity|self_identity)\]\s*/, "").replace(/^[「"'（(]+/, "");
  // 取首句（情绪对象是「这次什么事」，不是整段记录）
  const cut = s.split(/[。；;！!？?\n]/)[0] ?? "";
  s = cut.trim().replace(/[，,：:、\s]+$/, "");
  if (s.length < 2) return "";
  if (/^(?:用户|他|她|我|对方|记录|内容)$/.test(s)) return "";
  // 上限必须与 isReusableAffectObject 一致：旧实现截到 24+「…」=25 字，21–24 字原句原样返回
  // 又被 20 字上界整句拒掉——这一段长度成了永远进不了判断的死区；超过上限的长句也不再
  // 截断充数（「【任务】把 GitHub issue …」这种前缀不是可复用情境），直接不算对象。
  return s.length > 24 ? "" : s;
}

/** 从 L1 affect 信号（只有 valence/arousal）构造情绪；对象未知时标为「未定位」。 */
export function emotionFromSignal(
  signal: { valence: number; arousal: number; occurred_at: string; excerpt?: string | null; object?: string | null },
  now: string,
  cfg: Pick<SoulMaintenanceConfig, "emotionHalfLifeHours">,
): EmotionEvent {
  const v = clamp(signal.valence, -1, 1);
  const arousal = clamp(signal.arousal, 0, 1);
  const label = v >= 0.25 ? (arousal >= 0.5 ? "振奋" : "踏实") : v <= -0.25 ? (arousal >= 0.5 ? "不安" : "失望") : "平静";
  const rawObject = typeof (signal.object ?? signal.excerpt) === "string" ? (signal.object ?? signal.excerpt)!.trim() : "";
  // 整段标题不能直接当对象，但标题里的人/错/要求可以。抽不到才留空。
  const object = rawObject === "" ? "" : extractAffectReferent(rawObject);
  return {
    id: `sig-${signal.occurred_at}-${label}`,
    at: signal.occurred_at,
    object,
    label,
    valence: v,
    arousal,
    intensity: clamp01(Math.abs(v) * (0.5 + 0.5 * arousal)),
    appraisal: {
      goalRelevance: Math.abs(v),
      expectationViolation: 0,
      control: 0.5,
      normCompatibility: 1,
      agency: "self",
    },
    halfLifeHours: cfg.emotionHalfLifeHours,
  };
}

/** 相对基线的读法：短语 + 可选原因（原因只来自真实对象）。 */
export function readMood(
  mood: MoodState,
  opts?: { emotion?: Pick<EmotionEvent, "object" | "label"> & { effectiveIntensity?: number }; threshold?: number },
): MoodReading {
  const threshold = opts?.threshold ?? 0.15;
  const dv = mood.valence - mood.baselineValence;
  const da = mood.arousal - mood.baselineArousal;
  const tone = dv >= threshold ? "偏积极" : dv <= -threshold ? "偏沉" : "平稳";
  const tension = da >= threshold ? "更绷紧" : da <= -threshold ? "更松弛" : "";
  // 第三维：撑不撑得住。只在库里有这一列时读，旧行缺列就不写这半句（不假装知道）。
  const baseDom = mood.baselineDominance;
  const dd =
    typeof mood.dominance === "number" && typeof baseDom === "number" ? mood.dominance - baseDom : undefined;
  const grip = dd === undefined ? "" : dd >= threshold ? "更能撑住" : dd <= -threshold ? "有点被动" : "";
  const phrase = [`比基线${tone}`, tension, grip].filter((s) => s !== "").join("、");
  const e = opts?.emotion;
  const object = typeof e?.object === "string" ? e.object.trim() : "";
  // 有对象就写原因。强度只决定措辞：还强就写「反复出问题」，
  // 衰减过半就写「正在消退」。不因衰减把原因藏掉——藏掉等于假装没发生过。
  const strong = (e?.effectiveIntensity ?? 0) >= 0.4;
  const reason =
    object !== "" && isReusableAffectObject(object)
      ? `因为「${object}」${strong ? emotionReasonSuffix(e?.label ?? "") : "正在消退"}`
      : undefined;
  return {
    mood,
    deltaValence: dv,
    deltaArousal: da,
    ...(dd === undefined ? {} : { deltaDominance: dd }),
    phrase,
    reason,
  };
}

function emotionReasonSuffix(label: string): string {
  switch (label) {
    case "悬着":
      return "还没收口";
    case "恼火":
      return "反复出问题";
    case "失望":
      return "结果不如预期";
    case "不安":
      return "走向还不确定";
    case "振奋":
      return "推进得比预期顺";
    case "愧疚":
      return "我没做到位";
    case "害羞":
      return "当众被看见了";
    case "委屈":
      return "不是我造成的";
    case "开心":
      return "被当众肯定了";
    case "安心":
      return "我自己收口了";
    case "意外":
      return "超出了预期";
    default:
      return "仍在影响我";
  }
}

/** 注入形态：一行，绝不写成绝对档位。 */
/** 情绪对象的注意力方向：不是又读一个数，而是决定「先看哪一类自己的记录」。 */
export type MoodFocus = "self" | "conflict" | "repair" | "none";

// 覆盖全部 24 个标签（平静除外：平静不偏）。旧版只映射 12 个，另 12 个
// （悬着/感激/着急/无奈/意外/释然/尴尬/失落/烦躁/欣慰/同情）一律 none，
// 于是「当众出岔子的尴尬」「被催的着急」「推不动的失落」都不参与注意力重排与情绪门。
const SELF_FOCUS_LABELS: ReadonlySet<string> = new Set([
  "愧疚",
  "害羞",
  "不安",
  "尴尬",
  "悬着",
  "着急",
  "失落",
  "意外",
]);
const CONFLICT_FOCUS_LABELS: ReadonlySet<string> = new Set([
  "恼火",
  "委屈",
  "失望",
  "烦躁",
  "无奈",
  "同情",
]);
const REPAIR_FOCUS_LABELS: ReadonlySet<string> = new Set([
  "安心",
  "踏实",
  "笃定",
  "振奋",
  "开心",
  "自豪",
  "释然",
  "欣慰",
  "感激",
]);

/**
 * 把当下情绪翻译成注意力方向（确定性，不看强度）：
 *  - 自我向（愧疚/害羞/不安/尴尬/悬着/着急/失落/意外）→ self：先看自己哪次没做对；
 *  - 向外向（恼火/委屈/失望/烦躁/无奈/同情）→ conflict：先看关系里那次冲突；
 *  - 修复向（安心/踏实/笃定/振奋/开心/自豪/释然/欣慰）→ repair：先看补上了什么；
 *  - 平静 → none（不偏）。
 * 无有效对象（含「最近一次肯定/否定」这类假对象）→ none，不偏。
 */
export function moodFocusOf(label: string): MoodFocus {
  const l = (label ?? "").trim();
  if (l === "") return "none";
  return SELF_FOCUS_LABELS.has(l) ? "self" : CONFLICT_FOCUS_LABELS.has(l) ? "conflict" : REPAIR_FOCUS_LABELS.has(l) ? "repair" : "none";
}

export function moodAttention(mood: SoulMoodState): { object: string; focus: MoodFocus } {
  // 在场情绪优先；已退场的看历史标签（同一对象近一周还在反复时由读侧补进 historyEmotion）。
  // 顺序固定：先看现在真在难受什么，再看这件事的历史形状。
  const live = (mood.emotion?.object ?? "").trim();
  if (live !== "" && isReusableAffectObject(live)) {
    return { object: live, focus: moodFocusOf((mood.emotion?.label ?? "").trim()) };
  }
  const past = (mood.historyEmotion?.object ?? "").trim();
  if (past === "" || !isReusableAffectObject(past)) return { object: "", focus: "none" };
  return { object: past, focus: moodFocusOf((mood.historyEmotion?.label ?? "").trim()) };
}

/**
 * 情绪改变判断的第二处落点（2026-11-06，round 9）：不是换一句文案，而是决定这一轮
 * 「长不长我是谁」。愧疚/害羞/不安还挂在一个没修好的对象上时，把同一批证据写成
 * identity/values 就是把一次欠账升格成身份；恼火/委屈还没收口时同理——先修，再定我是谁。
 * 修复一旦写下（或情绪转为修复向），当轮不拦：这不是永久封禁，是排期。
 */
export interface MoodGrowthDeferral {
  defer: Array<"identity" | "values">;
  code: "mood_defer_self" | "mood_defer_conflict";
  reason: string;
}

export function moodGrowthGate(input: {
  focus: MoodFocus;
  object: string;
  count: number;
  repaired: boolean;
}): MoodGrowthDeferral | null {
  const object = (input.object ?? "").trim();
  if (object === "" || input.count < 2) return null;
  if (input.focus === "self" && !input.repaired) {
    return {
      defer: ["identity", "values"],
      code: "mood_defer_self",
      reason: `「${object}」上已经 ${input.count} 次没修好，这一轮先修，不重写我是谁`,
    };
  }
  if (input.focus === "conflict") {
    return {
      defer: ["identity", "values"],
      code: "mood_defer_conflict",
      reason: `和「${object}」的冲突还没收口，这一轮不把它写成我的立场`,
    };
  }
  return null;
}

export function renderMoodLine(mood: SoulMoodState, opts?: Parameters<typeof readMood>[1]): string {
  const emotion = opts?.emotion ?? (mood.emotion ? { object: mood.emotion.object, label: mood.emotion.label, effectiveIntensity: mood.emotion.intensity } : undefined);
  const r = readMood(mood, { ...opts, emotion });
  // 混合：主情绪之外还压着一条（强度 ≥ 0.3）。只报一个标签会把「恼火里带着着急」说成「恼火」。
  const primary = (emotion?.label ?? "").trim();
  const second = mood.blend && mood.blend.intensity >= 0.3 ? mood.blend.label.trim() : "";
  const compound = primary !== "" && second !== "" ? compoundMoodName(primary, second) : "";
  const mix =
    second === "" || second === primary
      ? ""
      : primary === ""
        ? second
        : `${primary}里带着${second}${compound !== "" ? `（${compound}）` : ""}`;
  const body = mix === "" ? r.phrase : `${r.phrase}，${mix}`;
  const head = r.reason ? `近期心境：${body}，${r.reason}。` : `近期心境：${body}。`;
  // 复发判断不看半衰期。同一对象出现过几次，是事实，不因情绪消退而消失。
  const stance = mood.objectStance ?? "";
  // 情绪还要给出一个当场做得到的动作。没有可复用对象时不写——否则就成了无来由的行为指令。
  const objectOk = typeof emotion?.object === "string" && isReusableAffectObject(emotion.object);
  const hint = objectOk ? emotionBehaviorHint(primary) : "";
  // 三句各自成句：立场与提示都不带句号时，直接拼会粘成「要不要挡先摆证据」。
  const asSentence = (text: string): string => {
    const t = (text ?? "").trim();
    return t === "" ? "" : /[。！？]$/u.test(t) ? t : t + "。";
  };
  return `${head}${asSentence(stance)}${asSentence(hint)}`;
}

/** 两个情绪叠在一起时的中文复合名。没有公认说法的组合就不硬造，返回空串。 */
export function compoundMoodName(a: string, b: string): string {
  const key = [a, b].sort().join("+");
  const table: Record<string, string> = {
    "愧疚+着急": "懊恼",
    "失望+恼火": "憋闷",
    "不安+委屈": "憋屈",
    "开心+感激": "欣慰",
    "不安+着急": "心慌",
    "失望+着急": "灰心",
  };
  return table[key] ?? "";
}

/**
 * 情绪对应的当场动作（确定性，零 LLM）。这是「情绪进入行为」的最小落点：
 * 同一标签永远给同一句，模型不能自评「我有没有被情绪影响」。
 */
export function emotionBehaviorHint(label: string): string {
  switch ((label ?? "").trim()) {
    case "害羞":
      return "此刻先摆证据，少说一句场面话。";
    case "尴尬":
      return "先把场面接住，别绕。";
    case "愧疚":
      return "此刻先修，再解释。";
    case "委屈":
      return "先亮事实，不赌气。";
    case "恼火":
      return "先核对是不是又没修好，再开口。";
    case "烦躁":
      return "挑一件现在就能改的做。";
    case "着急":
      return "先给时间点，别铺陈。";
    case "悬着":
      return "先问清收口标准，再动手。";
    case "不安":
      return "先要一手证据，别靠猜。";
    case "失望":
      return "说清哪一步没成，别泛泛带过。";
    case "失落":
      return "把不能控制的部分讲明，别揽成自己的错。";
    case "无奈":
      return "先记下不认同的点，照做也说清代价。";
    case "释然":
      return "把这个收口写下来，别当没发生过。";
    case "安心":
      return "把做法留成可复用的步骤。";
    case "欣慰":
      return "把这次做对的地方说清楚。";
    case "自豪":
      return "把功劳分给具体做过的事，别抬成我是谁。";
    case "开心":
      return "把被肯定的那一点记住，别扩成整体评价。";
    case "感激":
      return "说清谢在哪件事上。";
    case "同情":
      return "先问他要什么，不替他决定。";
    case "振奋":
      return "趁热把下一步落成动作，别只兴奋。";
    case "踏实":
      return "按现在的节奏继续，不加速。";
    case "笃定":
      return "把判断和依据一起写下来。";
    case "意外":
      return "先确认这是新信息还是我看漏了。";
    case "平静":
      return "";
    default:
      return "";
  }
}

/**
 * 情绪进入判断（不是情绪进入文案）：把「此刻偏沉/偏积极」转成一条**下一次同类情境的
 * 默认动作倾向**——偏沉时先按最坏情况挡一下，偏积极时先信一次再验证。它只在有真实对象
 * （episode.object）且偏离超过阈值时出现；没有对象就只剩心境，不伪造「因为」。
 *
 * 这是确定性的：同一 mood + 同一 episode 永远给同一句；模型无法自评它「有没有被情绪影响」。
 */
export interface ObjectHit {
  object: string;
  intensity: number;
  valence: number;
  /** 后来的事件是否把这件事修好了。 */
  repaired?: boolean;
}

export interface ObjectRecurrence {
  object: string;
  count: number;
  peak: number;
  repaired: boolean;
  /** 同一对象再次出现时的默认动作。次数/强度/修复任一变化，这句话必须变。 */
  stance: string;
}

/** 同一对象的复发统计：纯函数，供判断与反事实回放共用。 */
export function objectRecurrence(hits: ObjectHit[], object?: string): ObjectRecurrence {
  const key = (object ?? hits[0]?.object ?? "").trim();
  const mine = hits.filter((h) => h.object.trim() === key);
  const count = mine.length;
  const peak = mine.reduce((m, h) => Math.max(m, Math.abs(h.intensity)), 0);
  const repaired = mine.some((h) => h.repaired === true);
  let stance = "先核对再动";
  if (count === 0) stance = "没有这段史，按事本身判断";
  else if (repaired) stance = "先核对修复是否还在，再决定要不要挡";
  else if (count >= 2 || peak >= 0.7) stance = "同类再出现先挡一下";
  else stance = "记着一次，先核对再动";
  return { object: key, count, peak: Number(peak.toFixed(3)), repaired, stance };
}

export function moodBiasLine(
  mood: MoodState,
  opts?: {
    episode?: Pick<SoulEpisode, "object" | "valence">;
    threshold?: number;
    /** 同一对象的历史。传入后判断跟复发/修复走，不再只看正负偏移。 */
    hits?: ObjectHit[];
  },
): string | null {
  const threshold = opts?.threshold ?? 0.15;
  const dv = mood.valence - mood.baselineValence;
  const object = typeof opts?.episode?.object === "string" ? opts.episode.object.trim() : "";
  // 同一对象的复发史优先于心境数值：出现过几次、修没修好是事实，心境回到基线也不该忘。
  // 只要给了 hits 且对象可复用就出判断；偏移门只管没有对象史的那条旧路。
  if (opts?.hits && object !== "" && isReusableAffectObject(object)) {
    const rec = objectRecurrence(opts.hits, object);
    return `此刻面对「${object}」：${rec.stance}。`;
  }
  if (Math.abs(dv) < threshold) return null;
  if (object === "" || !isReusableAffectObject(object)) return null;
  return dv < 0
    ? `此刻我更防着「${object}」：同类的事再出现，我会先按最坏情况挡一下。`
    : `此刻我更愿意在「${object}」上多走一步：先信一次，再验证。`;
}

/**
 * 反事实：同一模糊情境，有这段情绪/关系史和没有，判断必须不同。
 * 纯函数。history 为空时 withHistory 与 without 相同，调用方应标「未采集」。
 */
export function counterfactualStance(
  situation: string,
  hits: ObjectHit[],
): { situation: string; withHistory: string; withoutHistory: string; differs: boolean } {
  const object = extractAffectReferent(situation) || hits[0]?.object || "这件事";
  const withRec = objectRecurrence(hits, object);
  const without = objectRecurrence([], object);
  return {
    situation,
    withHistory: withRec.stance,
    withoutHistory: without.stance,
    differs: hits.length > 0 && withRec.stance !== without.stance,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

/**
 * 从一段原话里抽出「对谁 / 因为什么」。
 * 整段任务标题不能当对象，但标题里的人、被指出的错、被要求守住的事可以。
 * 抽不到返回空串——空只表示这句里没有可复用原因，不表示情绪没有发生。
 */
export function extractAffectReferent(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const s = raw.replace(/\s+/gu, " ").trim();
  if (s === "") return "";
  if (/何晨/u.test(s)) return "何晨";
  const quoted = /[「"']([^」"']{2,12})[」"']/u.exec(s);
  if (quoted && isReusableAffectObject(quoted[1]!)) return quoted[1]!;
  if (/(?:假绿|自欺|编造)/u.test(s)) return "假绿";
  // 甩锅/错怪必须先于通用「不对」判：否则「这处不对不是我弄的」会被记成
  // 「被当面指出不对」，委屈（exculpated+violated）永远拿不到自己的原因。
  if (/(?:不是我的问题|并非我的问题|不是我做|错怪|甩锅|不是我弄)/u.test(s)) return "被错怪";
  if (/(?:不对|错了|搞错|没做到|重做)/u.test(s)) return "被当面指出不对";
  if (/(?:先取证|先验证|不许改)/u.test(s)) return "先取证再改";
  if (/(?:信任|交给你|你自己)/u.test(s)) return "把方案权交出来";
  // 以下四条是「可复用情境对象」：不是任务标题，而是换任务仍然成立的社会情境。
  // 生产实测：害羞的七条事件因「裁决 PASS-WITH-CONCERNS…」整句 >20 字被拒，
  // 安心的「按生产级标准落地并测试」又因含「落地」被拒——六种情绪里两种因此永远
  // 没有原因、只落成读数（2026-11-06 只读盘）。对象必须是可复用的，才配进判断。
  if (/(?:裁决\s*PASS-WITH-CONCERNS|adversary 裁决|Lead 定夺|公开裁决)/iu.test(s)) return "公开裁决";
  if (/(?:按生产级标准|生产级标准|生产级交付)/u.test(s)) return "生产级标准";
  if (/(?:不放心|信不过|不靠谱|不敢用|靠不住)/u.test(s)) return "他对我的信任";
  const derived = deriveEmotionObject(s);
  return isReusableAffectObject(derived) ? derived : "";
}

/**
 * 能当情绪原因的对象：对人、对一件可复用的事。
 * 任务标题、压缩信封、系统提示、路径、「最近一次肯定/否定」一律不算。
 */
export function isReusableAffectObject(raw: string): boolean {
  const s = raw.trim();
  // 与 deriveEmotionObject 的 24 字上限对齐：21–24 字的完整情境短语可当对象，超长一律不算。
  if (s.length < 2 || s.length > 24) return false;
  if (/最近一次(?:肯定|否定)/u.test(s)) return false;
  if (/\[Compressed|system-reminder|Open objectives|TASK AS OF/iu.test(s)) return false;
  if (/[<>{}\[\]`]/u.test(s)) return false;
  // 问句/商量句是「这次要做什么」，不是「因为什么」：把整句「这个是不是没必要了」当原因，
  // 心境行就会变成对一次性任务的长期偏见。
  if (/[？?]/u.test(s)) return false;
  if (/(?:是不是|是否|为什么|怎么|怎么办|要不要|能否|可不可以|有没有|行不行|你说呢)/u.test(s)) return false;
  if (/(?:[A-Za-z]:[\\/]|\/(?:[\w.-]+\/)+|https?:)/u.test(s)) return false;
  if (/(?:\d{4}-\d{2}-\d{2}|#\d+|\b[0-9a-f]{7,}\b)/iu.test(s)) return false;
  if (/(?:完成|修复|回归|验证|切换|重构|落地|推进|实现|工单|票)/u.test(s) && !/何晨|他|她/u.test(s)) return false;
  return survivesProjectSwap(s);
}

/** 供外部（如测试/回放）比较两段情绪朝向是否一致。 */
export function sameValenceDirection(a: number, b: number): boolean {
  return Math.sign(a) === Math.sign(b) || Math.abs(a) < 0.1 || Math.abs(b) < 0.1;
}

export { cosine };
