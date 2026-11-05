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
  SoulMaintenanceConfig,
} from "./types.js";
import type { AppraisalVector, EmotionEvent } from "./emotion.js";
import { normalizeText, stripBullet, survivesProjectSwap, textHash } from "./gates.js";
import { deriveEmotionObject } from "./emotion.js";

/** L0 读面最小形状（只依赖列，不依赖 store 实现）。 */
export interface EpisodeSourceRow {
  record_id: string;
  session_id: string;
  role: string;
  message_text: string;
  /** ISO；缺省时用 timestamp 兜底。 */
  recorded_at?: string;
  timestamp?: number;
}

/** 用户消息里的「纠正/否定」标记：这是人格最值钱的时刻——他明确说不要什么。 */
const CORRECTION_MARKERS: RegExp[] = [
  /(?:不对|不是这样|不是这个|错了|搞错|你错|弄错)/u,
  /(?:别编|不要编|胡说|瞎说|糊弄|骗我|假绿|自欺)/u,
  /(?:没做到|没有做到|没按|没有按|没听懂|漏了|你漏|忽略)/u,
  /(?:重做|再来一遍|返工|推倒|重新做|别自作主张|谁让你)/u,
  /(?:我说的是|我的意思是|你理解错|指的是)/u,
  /(?:还是不对|又说|仍然没有|还是没)/u,
];

/** 分歧/反对：立场冲突（不一定带「错」字）。 */
const DIVERGENCE_MARKERS: RegExp[] = [
  /(?:我不认同|我不认同|我不同意|我反对|我不接受|我不认可)/u,
  /(?:不是我要的|不应该是|不应该这样|我不这么|我不同意)/u,
  /(?:我认为应该|我觉得应该|必须是|只能)/u,
  /(?:不要为了|不能为了|别为了)/u,
];

/** 拍板/决定：他做了选择，选择本身携带优先级。 */
const DECISION_MARKERS: RegExp[] = [
  /(?:拍板|定案|定了|就按|就这个|用这个|采用|采纳|批准|同意)/u,
  /(?:改成|换成|按这个|按我说|按方案|落地|开工|开始做|动手)/u,
];

/** 价值冲突：取舍词一旦出现，这句话就在说「什么比什么重要」。 */
const VALUE_MARKERS: RegExp[] = [
  /(?:宁可|宁愿|与其|取舍|权衡|放弃|牺牲|代价|底线|原则)/u,
  /(?:不能为了|不要为了|不换|绝不换|不拿.{0,8}换)/u,
  /(?:先.{0,8}再.{0,8}|宁可.{0,12}也)/u,
];

/** 强度词：决定情绪强度，不决定方向。 */
const INTENSITY_MARKERS: RegExp[] = [
  /(?:非常|极其|根本|完全|彻底|太|特别|尤其|简直|离谱|过分|严重)/u,
  /(?:气死|火大|恼火|烦躁|焦虑|担心|失望|难受|崩溃|急|慌)/u,
  /(?:必须|一定要|绝不|千万|务必)/u,
];

/** 代价词：values 层「不为效率服务」的确定性证据。 */
const COST_MARKERS: RegExp[] = [
  /(?:放弃|牺牲|代价|错过|不换|宁愿不|宁可少|宁可慢|多花|花时间|不省这个)/u,
];

export interface EpisodeMineOptions {
  /** 回看窗口（天），缺省取 config.episodeWindowDays。 */
  windowDays?: number;
  /** 单轮最多处理消息数。 */
  maxMessages?: number;
  /** 单轮最多产出 episode 数。 */
  maxEpisodes?: number;
  /** 每个会话最多几条（防止一次长吵把窗口刷满）。 */
  perSessionCap?: number;
}

export interface EpisodeMineResult {
  episodes: SoulEpisode[];
  /** 可被 voice few-shot 引用的真实助手原话。voice 是「我」的语体，不是用户画像。 */
  voiceQuotes: SoulEpisodeQuote[];
}

const KIND_ZH: Record<SoulEpisodeKind, string> = {
  correction: "纠正",
  divergence: "分歧",
  value_conflict: "取舍",
  decision: "拍板",
  affect: "情绪",
};

const KIND_BASE_VALENCE: Record<SoulEpisodeKind, number> = {
  correction: -0.55,
  divergence: -0.45,
  value_conflict: -0.2,
  decision: 0.3,
  affect: -0.35,
};

const KIND_WEIGHT: Record<SoulEpisodeKind, number> = {
  value_conflict: 5,
  correction: 4,
  divergence: 3,
  decision: 2,
  affect: 1,
};

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

function classifyUserMessage(text: string): { kind: SoulEpisodeKind; signals: string[] } | null {
  const value = firstHit(text, VALUE_MARKERS);
  if (value) return { kind: "value_conflict", signals: [value] };
  const corr = firstHit(text, CORRECTION_MARKERS);
  if (corr) return { kind: "correction", signals: [corr] };
  const div = firstHit(text, DIVERGENCE_MARKERS);
  if (div) return { kind: "divergence", signals: [div] };
  const dec = firstHit(text, DECISION_MARKERS);
  if (dec) return { kind: "decision", signals: [dec] };
  const strong = hitCount(text, INTENSITY_MARKERS);
  if (strong > 0 && /[！!]/u.test(text)) return { kind: "affect", signals: ["intensity"] };
  return null;
}

function scoreAffect(
  kind: SoulEpisodeKind,
  userText: string,
  decision: { signals: string[] },
): { valence: number; arousal: number; intensity: number; source: "lexicon" | "none" } {
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
  if (s.length < Math.max(6, minChars) || s.length > 80) return false;
  if (/[{}<>`]/u.test(s)) return false;
  if (/(?:https?:\/\/|[A-Za-z]:[\\/]|\/[\w.-]+\/|\.(?:ts|js|json|md|ya?ml)\b)/u.test(s)) return false;
  if (/^#+\s/u.test(s) || /^\|/u.test(s) || /^[-*+·•]\s/u.test(s)) return false;
  if (/^(?:操作|结果|结论|输出|步骤|报错|错误|已|运行|执行|测试|文件|命令|参数|说明)[：:]/u.test(s)) return false;
  if (!/我/u.test(s)) return false;
  return true;
}

/** 一句话是否值得当 few-shot（短、无代码/路径、像人话）。 */
export function isVoiceQuoteCandidate(text: string, minChars: number): boolean {
  const s = stripBullet(text).replace(/\s+/gu, " ").trim();
  if (s.length < Math.max(6, minChars) || s.length > 80) return false;
  if (/[{}<>`]/u.test(s)) return false;
  if (/(?:https?:\/\/|[A-Za-z]:[\\/]|\/[\w.-]+\/|\.(?:ts|js|json|md|ya?ml)\b)/u.test(s)) return false;
  if (/^#+\s/u.test(s) || /^\|/u.test(s)) return false;
  if (/[了吗呢？?]$/u.test(s) && s.length > 40) return false;
  return /(?:我|不要|别|必须|先|就|不|可以|按|这个|你|宁可)/u.test(s);
}

/**
 * 挖掘：按会话排序后，对每条 user 消息判定是否构成一个 episode。
 * 不走 LLM，不做「总结」——只切段与摘句。
 */
export function mineEpisodes(
  rows: EpisodeSourceRow[],
  cfg?: Partial<SoulMaintenanceConfig>,
  opts?: EpisodeMineOptions,
): EpisodeMineResult {
  const windowDays = opts?.windowDays ?? cfg?.episodeWindowDays ?? 30;
  const maxMessages = opts?.maxMessages ?? cfg?.maxEpisodeMessages ?? 4000;
  const maxEpisodes = opts?.maxEpisodes ?? cfg?.maxEpisodesPerRun ?? 120;
  const perSessionCap = opts?.perSessionCap ?? 5;
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
      const cls = classifyUserMessage(raw);
      if (!cls) continue;
      const at = toIso(row);
      if (!at) continue;

      // 同一会话里重复的抱怨只留一条（词面近似即视为同一次）。
      const object = cleanObjectPhrase(raw) || truncate(raw, 24);
      const key = normalizeText(raw);
      const nearDup = episodes.some(
        (e) =>
          e.sessionId === sessionId &&
          (normalizeText(e.userStance) === key ||
            (e.kind === cls.kind && e.object === object && Math.abs(Date.parse(e.at) - Date.parse(at)) < 10 * 60_000)),
      );
      if (nearDup) continue;
      if (sessionEpisodes >= perSessionCap) break;

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
      const firstSentence = (s: string): string => s.split(/[。；;！!？?\n]/u)[0] ?? s;
      const affect = scoreAffect(cls.kind, raw, cls);
      const cost = extractCost(`${raw} ${prevAssistant}`);
      const title = `${KIND_ZH[cls.kind]}：${object}`.slice(0, 80);
      const evidenceIds = Array.from(
        new Set([String(row.record_id ?? ""), prevId, nextId].filter((x) => x.length > 0)),
      );
      const episode: SoulEpisode = {
        episodeId: `ep-${textHash(`${sessionId}|${row.record_id}`)}`,
        at,
        day: at.slice(0, 10),
        kind: cls.kind,
        title,
        object: truncate(object, 48),
        participants: [cfg?.personName || "user", "assistant"],
        userStance: truncate(raw, 160),
        agentStance: prevAssistant ? truncate(firstSentence(prevAssistant), 120) : "",
        cost,
        outcome: nextAssistant ? truncate(firstSentence(nextAssistant), 100) : "",
        valence: affect.valence,
        arousal: affect.arousal,
        intensity: affect.intensity,
        evidenceIds,
        sessionId,
        quote: { text: truncate(raw, 160), role: "user", recordId: String(row.record_id ?? ""), at },
        affectSource: affect.source,
        signals: cls.signals,
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

  episodes.sort(
    (a, b) => KIND_WEIGHT[b.kind] - KIND_WEIGHT[a.kind] || Date.parse(b.at) - Date.parse(a.at),
  );
  return { episodes: episodes.slice(0, maxEpisodes), voiceQuotes };
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
export function episodeAppraisal(
  ep: Pick<SoulEpisode, "kind" | "agentStance" | "outcome" | "intensity">,
): AppraisalVector {
  const hasResponse = ep.agentStance.trim() !== "";
  const followed = /(?:改|已|完成|跑|贴|按|给|重做|补|换成)/u.test(ep.outcome);
  const goalRelevance = Math.max(0.3, Math.min(0.95, 0.45 + 0.5 * ep.intensity));
  const expectationViolation =
    ep.kind === "correction" ? 0.75 : ep.kind === "divergence" ? 0.65 : ep.kind === "value_conflict" ? 0.6 : ep.kind === "decision" ? 0.25 : 0.5;
  const control = hasResponse ? (followed ? 0.75 : 0.6) : 0.3;
  const normCompatibility =
    ep.kind === "correction" ? 0.25 : ep.kind === "divergence" ? 0.35 : ep.kind === "value_conflict" ? 0.6 : ep.kind === "decision" ? 0.8 : 0.5;
  return {
    goalRelevance: Number(goalRelevance.toFixed(3)),
    expectationViolation,
    control: Number(control.toFixed(3)),
    normCompatibility,
    agency: hasResponse ? "self" : "other",
  };
}

/**
 * 情绪对象：优先用事件里可复用的对象；任务标题/项目名不能变成判断倾向，
 * 此时退回 kind 级对象（被纠正/分歧/被拍板…）——仍然说得出「因为什么」，
 * 又不把一次性任务写成长期偏见。moodBiasLine 只接受 ≤20 字且换项目仍成立的对象。
 */
export function emotionObjectForEpisode(ep: Pick<SoulEpisode, "kind" | "object">): string {
  const raw = typeof ep.object === "string" ? ep.object.trim() : "";
  if (raw !== "" && raw.length <= 20 && survivesProjectSwap(raw)) return raw;
  const byKind: Record<string, string> = {
    correction: "被纠正", divergence: "分歧", decision: "被拍板", value_conflict: "价值冲突", affect: "情绪事件",
  };
  return byKind[ep.kind] ?? "这件事";
}

/** episode → 情绪事件（心境积分用；对象与强度都来自真实片段）。 */
export function emotionEventFromEpisode(
  ep: SoulEpisode,
  cfg: Pick<SoulMaintenanceConfig, "emotionHalfLifeHours">,
): EmotionEvent {
  const label =
    ep.valence >= 0.25
      ? ep.arousal >= 0.5
        ? "振奋"
        : "踏实"
      : ep.valence <= -0.25
        ? ep.arousal >= 0.5
          ? "恼火"
          : "失望"
        : "平静";
  return {
    id: ep.episodeId,
    at: ep.at,
    object: emotionObjectForEpisode(ep),
    label,
    valence: ep.valence,
    arousal: ep.arousal,
    intensity: ep.intensity,
    appraisal: episodeAppraisal(ep),
    halfLifeHours: cfg.emotionHalfLifeHours,
  };
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
