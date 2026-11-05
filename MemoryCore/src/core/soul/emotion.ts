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
  appraisal: AppraisalVector;
  halfLifeHours: number;
}

export interface MoodState {
  valence: number;
  arousal: number;
  baselineValence: number;
  baselineArousal: number;
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
}

export interface MoodReading {
  mood: MoodState;
  /** 相对基线的偏离 */
  deltaValence: number;
  deltaArousal: number;
  /** 稳定短语（中文，可直接进 prompt） */
  phrase: string;
  /** 可解释原因（只来自真实情绪对象；无对象则不写原因） */
  reason?: string;
}

interface EmotionTemplate {
  label: string;
  valence: number;
  arousal: number;
}

const POSITIVE_HIGH: EmotionTemplate = { label: "振奋", valence: 0.7, arousal: 0.7 };
const POSITIVE_CALM: EmotionTemplate = { label: "踏实", valence: 0.35, arousal: 0.2 };
const POSITIVE_SURE: EmotionTemplate = { label: "笃定", valence: 0.5, arousal: 0.3 };
const NEGATIVE_ANXIOUS: EmotionTemplate = { label: "悬着", valence: -0.4, arousal: 0.6 };
const NEGATIVE_ANGRY: EmotionTemplate = { label: "恼火", valence: -0.6, arousal: 0.7 };
const NEGATIVE_DISAPPOINTED: EmotionTemplate = { label: "失望", valence: -0.5, arousal: 0.3 };
const NEGATIVE_UNEASY: EmotionTemplate = { label: "不安", valence: -0.4, arousal: 0.55 };
const NEGATIVE_GUILT: EmotionTemplate = { label: "愧疚", valence: -0.5, arousal: 0.4 };
const NEUTRAL_SURPRISE: EmotionTemplate = { label: "意外", valence: 0, arousal: 0.5 };
const NEUTRAL_CALM: EmotionTemplate = { label: "平静", valence: 0, arousal: 0.1 };

export const EMOTION_LABELS = [
  POSITIVE_HIGH,
  POSITIVE_CALM,
  POSITIVE_SURE,
  NEGATIVE_ANXIOUS,
  NEGATIVE_ANGRY,
  NEGATIVE_DISAPPOINTED,
  NEGATIVE_UNEASY,
  NEGATIVE_GUILT,
  NEUTRAL_SURPRISE,
  NEUTRAL_CALM,
].map((t) => t.label);

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
  const intensity = clamp01(
    Math.max(a.goalRelevance, a.expectationViolation) * (0.6 + 0.4 * a.normCompatibility),
  );
  return {
    id: input.id ?? `emo-${input.at}-${template.label}`,
    at: input.at,
    object: input.object,
    label: template.label,
    valence: template.valence,
    arousal: template.arousal,
    intensity,
    appraisal: a,
    halfLifeHours: input.halfLifeHours ?? 3,
  };
}

function pickTemplate(a: AppraisalVector): EmotionTemplate {
  if (a.normCompatibility < 0.3) {
    return a.agency === "self" ? NEGATIVE_GUILT : NEGATIVE_UNEASY;
  }
  const goalHit = a.goalRelevance >= 0.55;
  const violated = a.expectationViolation >= 0.5;
  if (goalHit && !violated) return a.control >= 0.6 ? POSITIVE_SURE : POSITIVE_CALM;
  if (goalHit && violated) return a.control >= 0.6 ? POSITIVE_HIGH : NEGATIVE_ANXIOUS;
  if (!goalHit && violated) {
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

export function emptyMood(now: string, baseline?: { valence?: number; arousal?: number }): MoodState {
  return {
    valence: baseline?.valence ?? 0,
    arousal: baseline?.arousal ?? 0.3,
    baselineValence: baseline?.valence ?? 0,
    baselineArousal: baseline?.arousal ?? 0.3,
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
  baseline?: { valence?: number; arousal?: number },
): MoodState {
  const base = prev ?? emptyMood(now, baseline);
  const dtHours = Math.max(0, (Date.parse(now) - Date.parse(base.updatedAt)) / 3_600_000);
  const priorWeight = Math.pow(2, -dtHours / Math.max(0.1, cfg.moodHalfLifeHours));
  // 先验不是「原样保留上一次读数」，而是「向基线回落一半衰期」：
  // 偏离量乘衰减权重再加回基线。否则没有新情绪时心境会永久停在旧值——
  // 那就成了「一次性情绪 = 永久人格」，正是要避免的开环。
  const priorValence = base.baselineValence + (base.valence - base.baselineValence) * priorWeight;
  const priorArousal = base.baselineArousal + (base.arousal - base.baselineArousal) * priorWeight;
  let wSum = priorWeight;
  let vSum = priorValence * priorWeight;
  let aSum = priorArousal * priorWeight;
  for (const e of events) {
    const w = decayedIntensity(e, now);
    if (w <= 0) continue;
    wSum += w;
    vSum += e.valence * w;
    aSum += e.arousal * w;
  }
  const bv = base.baselineValence;
  const ba = base.baselineArousal;
  return {
    valence: clamp(wSum > 0 ? vSum / wSum : bv, -1, 1),
    arousal: clamp(wSum > 0 ? aSum / wSum : ba, 0, 1),
    baselineValence: bv,
    baselineArousal: ba,
    updatedAt: now,
    sampleCount: base.sampleCount + events.length,
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
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
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
  const derived = deriveEmotionObject(rawObject);
  // 有摘要但它是任务标题/长句时，退回稳定反馈类别（可进「因为 X」又不把一次性任务
  // 写成长期偏见）；连摘要都没有则保持空对象——没有依据就不编造原因。
  const object =
    rawObject === ""
      ? ""
      : derived !== "" && derived.length <= 20 && survivesProjectSwap(derived)
        ? derived
        : v <= -0.25
          ? "最近一次否定"
          : v >= 0.25
            ? "最近一次肯定"
            : "";
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
  const phrase = tension ? `比基线${tone}、${tension}` : `比基线${tone}`;
  const e = opts?.emotion;
  const reason =
    e && e.object && (e.effectiveIntensity ?? 0) >= 0.4
      ? `因为「${e.object}」${emotionReasonSuffix(e.label)}`
      : undefined;
  return { mood, deltaValence: dv, deltaArousal: da, phrase, reason };
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
    case "意外":
      return "超出了预期";
    default:
      return "仍在影响我";
  }
}

/** 注入形态：一行，绝不写成绝对档位。 */
export function renderMoodLine(mood: MoodState, opts?: Parameters<typeof readMood>[1]): string {
  const r = readMood(mood, opts);
  return r.reason ? `近期心境：${r.phrase}，${r.reason}。` : `近期心境：${r.phrase}。`;
}

/**
 * 情绪进入判断（不是情绪进入文案）：把「此刻偏沉/偏积极」转成一条**下一次同类情境的
 * 默认动作倾向**——偏沉时先按最坏情况挡一下，偏积极时先信一次再验证。它只在有真实对象
 * （episode.object）且偏离超过阈值时出现；没有对象就只剩心境，不伪造「因为」。
 *
 * 这是确定性的：同一 mood + 同一 episode 永远给同一句；模型无法自评它「有没有被情绪影响」。
 */
export function moodBiasLine(
  mood: MoodState,
  opts?: { episode?: Pick<SoulEpisode, "object" | "valence">; threshold?: number },
): string | null {
  const threshold = opts?.threshold ?? 0.15;
  const dv = mood.valence - mood.baselineValence;
  if (Math.abs(dv) < threshold) return null;
  const object = typeof opts?.episode?.object === "string" ? opts.episode.object.trim() : "";
  if (object === "") return null;
  // 对象必须是「能换项目仍成立」的一件事，而不是某个具体任务标题/票/项目名：
  // 否则会把「重构 deck-autopilot 的 Issue…」这种一次性任务写成判断倾向，既不可回放也不是人格。
  if (object.length > 20 || !survivesProjectSwap(object)) return null;
  return dv < 0
    ? `此刻我更防着「${object}」：同类的事再出现，我会先按最坏情况挡一下。`
    : `此刻我更愿意在「${object}」上多走一步：先信一次，再验证。`;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

/** 供外部（如测试/回放）比较两段情绪朝向是否一致。 */
export function sameValenceDirection(a: number, b: number): boolean {
  return Math.sign(a) === Math.sign(b) || Math.abs(a) < 0.1 || Math.abs(b) < 0.1;
}

export { cosine };
