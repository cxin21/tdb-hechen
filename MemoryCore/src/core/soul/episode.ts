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
import { appraiseEmotion, deriveEmotionObject, extractAffectReferent } from "./emotion.js";
import { appraiseBlameSlots, claimOfFix } from "./slots.js";

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
  /(?:宁可.{0,12}也不|宁愿要.{0,12}不要|拿.{0,8}换)/u,
];

/** 肯定：他明确说「这样对」——正向情绪的生产来源，过去全被当成噪音丢掉。 */
const PRAISE_MARKERS: RegExp[] = [
  /(?:改得好|做得好|干得好|这就对了|就按这个|可以了|不错|很好|漂亮|靠谱)/u,
  /(?:辛苦了|辛苦你|谢谢你|感谢|麻烦你了|费心了)/u,
];

/** 追责：他把问题指到我头上，且没有认可是我的自述——对事是对事，对人才有火。 */
const COMPLAINT_MARKERS: RegExp[] = [
  /(?:你|您).{0,4}(?:又|怎么|到底)?(?:搞错|弄错|写错|改坏|整错|删掉|删了|漏了)/u,
  /(?:为什么|为啥).{0,6}(?:又|还|总是|老是)/u,
  /(?:到底(?:有没有|做好|行不行|为什么)|这才(?:一个|几)|这也叫)/u,
  /(?:太.{1,4}了){2,}/u,
  /(?:又|还)(?:出现|冒出来).{0,6}(?:条|个|问题)/u,
  /(?:不是要求|说好的|不是说好).{0,8}(?:用|按|组件|库)/u,
];

/** 催促：时间压力本身就是一种情绪来源，和「你错怪我了」不是一回事。 */
const PRESSURE_MARKERS: RegExp[] = [
  /(?:尽快|赶紧|马上|立刻|现在就|今晚|今天之内|下班前|等着用|很急|急用)/u,
];

/** 作罢：放弃争取，情绪是无奈；再判成失望就会把「我不争了」读成「你没给我」。 */
const RESIGNATION_MARKERS: RegExp[] = [
  /(?:算了|随你|你看着办|不管了|你决定|你定吧)/u,
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
  praise: "肯定",
  complaint: "追责",
  pressure: "催促",
  resignation: "作罢",
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

function classifyUserMessage(text: string): { kind: SoulEpisodeKind; signals: string[] } | null {
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
const STANCE_MARKER_RE =
  /搞错|弄错|写错|改坏|漏了|不对|错了|假绿|谢谢|感谢|辛苦|改得好|做得好|不错|漂亮|靠谱|尽快|赶紧|马上|立刻|今晚|今天之内|等着用|急用|算了|随你|你看着办|不管了|你决定|缺陷|必修|打回|未收口|不通过|中断|太.{0,8}了/u;

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
          cls = { kind: "complaint", signals: [tag] };
        } else if (
          cls.kind === "decision" ||
          cls.kind === "pressure" ||
          cls.kind === "affect" ||
          cls.kind === "divergence"
        ) {
          cls = { kind: "complaint", signals: [...cls.signals, tag] };
        } else {
          // correction 本身已经是「他说我不对」，不硬改成追责；但把槽位理由留在 signals 里，
          // 关系史据此认「这话是冲我的交付来的」（BLAME_TIGHT 漏掉的措辞）。
          cls = { kind: cls.kind, signals: [...cls.signals, tag] };
        }
      }
      // 派活/引述句里带「怎么/为什么」会被词表读成 complaint，但落点是让我去做事，不是挑我的错。
      // 槽位已经确认它不是追责时，把这类降到 decision，避免关系史把它记成冲突。
      if (
        (cls?.kind === "complaint" || cls?.kind === "pressure") &&
        (blameSlots.taskLike || blameSlots.quoted) &&
        !blameSlots.blame
      ) {
        cls = { kind: "decision", signals: [...cls.signals, "slot:instruction"] };
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
      const object = extractAffectReferent(stanceText) || cleanObjectPhrase(stanceText) || truncate(stanceText, 24);
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
  ep: Pick<SoulEpisode, "kind" | "agentStance" | "outcome" | "intensity"> & { userStance?: string },
  opts?: { publicSession?: boolean },
): AppraisalVector {
  const hasResponse = ep.agentStance.trim() !== "";
  const both = `${ep.userStance ?? ""} ${ep.agentStance}`;
  const utterance = ep.userStance ?? "";
  const publicExposure0 = opts?.publicSession === true || /当着|当众|大家|会议上/u.test(both);
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
    const refuted = /返回正常|上游缓存|上游|缓存了旧数据|日志里没|查了日志|实测|真机|截图里|我查到|我核过|复现不出来|旧数据/u.test(mySide);
    const exculpated = /不是我造成|不是我的问题|你的问题|你弄错/u.test(mySide) || refuted;
    const admitted = /我错了|是我的问题|我没做到|我重做|我改口|补上|已补|已按|已对齐|逐项量过|收口/u.test(mySide);
    // 他一边怪我，一边说了自己付出的代价（加班/被客户催/被骂）：这不是单纯的追责，
    // 是他也在为这件事付成本——情绪该是同情，不是恼火。代价只看他的话，不替他说。
    const otherCost = /(?:我|我们)(?:这边|那边)?(?:也|都)?(?:在)?(?:加班|熬夜|扛着|被客户|被领导|被骂|忙到现在|累)/u.test(utterance);
    return {
      goalRelevance: 0.35,
      expectationViolation: 0.75,
      control: 0.7,
      normCompatibility: 0.25,
      agency: "other",
      socialExposure: exposure0,
      selfCause: admitted && !exculpated,
      otherCause: true,
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
  const followed = /(?:改|已|完成|跑|贴|按|给|重做|补|换成)/u.test(ep.outcome);
  // 目标相关度原来写 `0.45 + 0.5 * intensity`，而强度下限是 0.35 —— 任何事件都 ≥0.625，
  // 于是 pickTemplate 里「与目标无关」那半边（平静/意外/失落/失望）成了死代码。
  // 现在 = 强度基线 + 「这句话是不是在指挥方向」：带着就按/必须/批准/改成的要求
  // 一定与目标有关（否则他的要求会被读成「平静」，等于没听见）；纯插话才落回无关那半边。
  // 「先」后面接汉字才是派活（先百度/先review 里的后者是英文，不算）；「先做」已单列。
  const directive = /(?:就按|按方案|按我说|必须|要求|批准|开工|开始做|动手|改成|换成|落地|优先|先做|重做|务必|绝不|千万|先(?=[\u4e00-\u9fa5]))/u.test(utterance);
  const goalRelevance = Number(
    Math.max(0.25, Math.min(0.95, 0.25 + 0.55 * ep.intensity + (directive ? 0.2 : 0))).toFixed(3),
  );
  // 「我以为要出问题，结果没出」：他就按原样继续、并明说没影响。这是释然，不是叠加的开心。
  const relieved = ep.kind === "decision" && /没出问题|没影响|没坏|恢复正常|不影响|还好/u.test(utterance);
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
  const exculpated = /不是我造成|不是我的问题|你的问题|你弄错/u.test(`${ep.agentStance} ${ep.outcome}`);
  const selfCause = !exculpated && /我错了|是我的问题|我没做到|我重做|我改口|补上|已补|已按|已对齐|逐项量过|收口/u.test(mySide);
  const otherCause = /不是我造成|不是我的问题|你的问题|你弄错/u.test(both) || exculpated;
  const publicExposure = opts?.publicSession === true || /当着|当众|大家|会议上/u.test(both);
  // 我事后那条回复里写了交付/通过/改好了，且不是被他指出错的当场——这是我自己把事做成了。
  // decision 是「按我的判断落码」，correction 的 outcome 若只是「已改」不算成就，得有可核结果。
  const achievement =
    followed &&
    /完成|通过|全绿|交付|收口|改好了|修好|已修|已改|对齐|跑过|闭环/u.test(ep.outcome) &&
    (ep.kind === "decision" || ep.kind === "correction" || ep.kind === "divergence");
  // 上面算出的 exculpated 直接决定 324/330 两条路由，别在这一层再重新判一次。
  // 我没回应，而这件事卡在外部（上游/接口/网络/环境/第三方）：agency 是 environment，
  // 不是「他造成的」——同样是没做成，可推不动的失落和被他否掉的失望不是同一种情绪。
  const envBlocked =
    !hasResponse && /上游|接口|网络|环境|服务器|缓存|第三方|平台|依赖/u.test(`${utterance} ${ep.outcome}`);
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
    otherCause,
  };
}

/**
 * 情绪对象：优先用事件里可复用的对象；任务标题/项目名不能变成判断倾向，
 * 此时退回 kind 级对象（被纠正/分歧/被拍板…）——仍然说得出「因为什么」，
 * 又不把一次性任务写成长期偏见。moodBiasLine 只接受 ≤20 字且换项目仍成立的对象。
 */
export function emotionObjectForEpisode(ep: Pick<SoulEpisode, "kind" | "object"> & { userStance?: string }): string {
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

/** 「给一个 query 能召回」：确定性检索（标题/对象/双方立场/原话）。 */
export function matchEpisode(ep: SoulEpisode, query: string): boolean {
  const q = normalizeText(query);
  if (q === "") return true;
  const hay = [ep.title, ep.object, ep.userStance, ep.agentStance, ep.cost, ep.outcome, ep.quote?.text ?? ""]
    .map(normalizeText)
    .join(" ");
  return hay.includes(q);
}
