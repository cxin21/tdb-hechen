/**
 * 人格卡 v13：表演层九块（spec: docs/specs/2026-11-10-persona-card-v13-performance-layer.md）。
 *
 * 与 v12 的关系：v13 只换「正文怎么写、每块从哪来」，不换渲染骨架——
 * 读法常量、hash = sha256(读法 + 正文)、卡尾注释、版本号都沿用。
 * v12 的 11 块渲染器已在阶段 4 删除，`card.ts` 只剩红线截断/去重与 CardSegment 形状；
 * 本模块不带任何开关键，没有 v12/v13 运行时切换，也没有「底色 <0.05 复用上一版」的旁路——
 * 谁渲染都是 v13（`assembleSoulCard` 是唯一入口，hash 只跟正文走）。
 *
 * 三条硬纪律（来自 spec §7，测试兜底）：
 *  1) 正文不出现 Markdown：不加 `##`、不加粗、不列表、不做表格；块标题是纯文本一行。
 *  2) 对对方一律说「你」，不把「用户」当关系对象；也不用「我站在……这边」当独立行。
 *  3) 找不到来源就不渲染：缺数据整块省略并在 warnings 里留 `block_omitted:<块名>`，
 *     不补占位、不写样品台词、不拿别的块冒充。
 */
import { createHash } from "node:crypto";
import { clampRedlines } from "./card.js";
import type { CardRedline, CardSegment } from "./card.js";
import { isReusableAffectObject } from "./emotion.js";
import { CARD_READER_NOTE } from "./traits.js";

/** v13 版本号：卡尾注释与 payload 都写它，读侧据此区分两套渲染器。 */
export const CARD_V13_SCHEMA_VERSION = "13";

/** 整卡硬顶（spec §8）：目标 1900–2250，硬顶 2400。 */
export const CARD_V13_MAX_CHARS = 2400;
/** 身份段硬顶（注入在最前面的稳定段）。 */
export const CARD_V13_IDENTITY_MAX_CHARS = 1000;
/** 末尾锚硬顶（每轮末尾的极短复述）。 */
export const CARD_V13_ANCHOR_MAX_CHARS = 460;
/** 目标区间，仅用于报告/断言，不参与裁剪。 */
export const CARD_V13_TARGET_MIN = 1900;
export const CARD_V13_TARGET_MAX = 2250;

/** 九块顺序（正文就按这个顺序拼）。 */
export const CARD_V13_BLOCK_ORDER = [
  "firstLook",
  "life",
  "character",
  "voice",
  "us",
  "now",
  "memory",
  "boundaries",
  "recent",
] as const;

export type CardV13BlockKey = (typeof CARD_V13_BLOCK_ORDER)[number];

export const CARD_V13_BLOCK_TITLES: Record<CardV13BlockKey, string> = {
  firstLook: "第一眼",
  life: "生活",
  character: "性格",
  voice: "说话",
  us: "我们",
  now: "现在",
  memory: "记得",
  boundaries: "边界",
  recent: "最近的变化",
};

/**
 * 单块上限（spec §8，合计 2180，留 220 字给块标题与过渡）。
 * 注意这是「超过就先丢这一块的后几行」，不是硬截断：红线类行受保护，见 `capBlockLines`。
 */
export const CARD_V13_BLOCK_MAX_CHARS: Record<CardV13BlockKey, number> = {
  firstLook: 220,
  life: 260,
  character: 300,
  voice: 220,
  us: 320,
  now: 220,
  memory: 300,
  boundaries: 180,
  recent: 160,
};

/** 块来源：声明层 / 观察层 / 推算 / 结构化（阶段 2 才有）/ 缺席。 */
export type CardV13Source = "declared" | "observed" | "derived" | "structured" | "absent";
export type CardV13Confidence = "high" | "medium" | "low" | "absent";

/**
 * 整卡超预算时的让位顺序（spec §8）：先丢块，再减行。
 * 永不丢：第一眼、性格（至少两条行为锚）、边界（含红线）。
 */
export const CARD_V13_BUDGET_STEPS: ReadonlyArray<
  { kind: "block"; key: CardV13BlockKey } | { kind: "trim"; key: CardV13BlockKey; maxLines: number }
> = [
  { kind: "block", key: "recent" },
  { kind: "block", key: "life" },
  { kind: "trim", key: "us", maxLines: 2 },
  { kind: "trim", key: "now", maxLines: 2 },
  { kind: "trim", key: "memory", maxLines: 2 },
  { kind: "trim", key: "character", maxLines: 3 },
];

/** 一行正文 + 它来自哪几条证据（空数组 = 这一行没有可回指的证据，通常来自声明层）。 */
export interface CardV13Line {
  text: string;
  evidenceIds?: string[];
}

/**
 * 心境输入：基线取 soul_state；现值优先取 soul_mood_state（阶段 2），
 * 没有慢心境行时才回退 soul_state 的即时读数（样张 §正式实现口径 4）。
 */
export interface CardV13Mood {
  valence: number;
  arousal: number;
  baselineValence: number;
  baselineArousal: number;
  emotionLabel?: string;
  emotionObject?: string;
}

/** soul_mood_state 的一行：慢心境现值（不是 soul_state 的即时情绪）。 */
export interface CardV13MoodState {
  label: string;
  valence: number;
  arousal: number;
  intensity: number;
  /** 造成这次心境的事件 id（卡上只做证据回指，不进正文）。 */
  causeEventIds?: string[];
}

/** soul_person_state 的一行：四轴连续状态（默认 0.5，只有偏离足够大才写进卡）。 */
export interface CardV13PersonState {
  personKey: string;
  /** 由 soul_person.displayName 解析；解析不到就整条省略并给 person_unresolved。 */
  name: string;
  trust: number;
  affinity: number;
  respect: number;
  obligation: number;
  evidenceIds?: string[];
}

/** soul_person_relation 的一条现行关系事实（「你与<名字>：<谓词>」）。 */
export interface CardV13RelationFact {
  text: string;
  evidenceIds?: string[];
}

/** soul_working_state 的一行：本轮注意力锚（过期行由读侧过滤，不拿三天前的当现在）。 */
export interface CardV13WorkingState {
  /** 只在有锚时给；只欠着问题、没有在做的事时可以缺。 */
  currentFocus?: string;
  openQuestions: string[];
  currentGoalId?: string | null;
}

/** soul_goals 的一条：只接还在进行的目标（active/blocked；终态不复活）。 */
export interface CardV13Goal {
  goalId: string;
  title: string;
  status: "active" | "blocked";
  blockedReason?: string;
  priority?: number;
  evidenceIds?: string[];
}

/**
 * 阶段 2 的结构化输入。所有字段都可缺：缺哪层就省略对应的行，
 * 不拿 persona 行或旧数值补位（spec §7「找不到来源就不渲染」）。
 */
export interface CardV13Structured {
  /**
   * true = 调用方已按在场者限定范围。此时「我们」只认 structured 的关系事实/状态，
   * 不再回退 persona 的 relationship 行（fail-closed，避免把 A 的关系史漏进 B 的卡）。
   */
  personScoped?: boolean;
  relations?: CardV13RelationFact[];
  personStates?: CardV13PersonState[];
  /** 慢心境；缺省时回退 input.mood（soul_state 即时读数）。 */
  mood?: CardV13MoodState | null;
  working?: CardV13WorkingState | null;
  goals?: CardV13Goal[];
}

export interface SoulCardV13Input {
  profile: {
    name: string;
    nameSource?: "declared" | "skeleton";
    pronoun?: string;
    selfImage?: string;
    voice?: string;
    purpose?: string;
    redlines?: CardRedline[];
  };
  /** 观察层（soul_persona）按层切好的行；调用方负责在场者过滤与新鲜度判定。 */
  lines?: {
    human?: CardV13Line[];
    relationship?: CardV13Line[];
    identity?: CardV13Line[];
    values?: CardV13Line[];
    boundary?: CardV13Line[];
    voice?: CardV13Line[];
    self?: CardV13Line[];
    narrative?: CardV13Line[];
  };
  mood?: CardV13Mood | null;
  /** 阶段 2：soul_person_state / soul_mood_state / soul_goals / soul_working_state / soul_person_relation。 */
  structured?: CardV13Structured;
  /** 底色标签（只做 seeded 判据与报告，不进 v13 正文——数值留在后台）。 */
  labels?: Array<{ label: string; act: number; gloss?: string }>;
  version: number;
}

export interface CardV13BlockMeta {
  id: CardV13BlockKey;
  title: string;
  /** 这一块在整卡正文里的字符数（不含块标题；0 = 省略）。 */
  chars: number;
  source: CardV13Source;
  confidence: CardV13Confidence;
  evidenceIds: string[];
  warnings: string[];
}

export interface PersonaCardV13Snapshot {
  schema: "13";
  version: number;
  hash: string;
  text: string;
  chars: number;
  blocks: CardV13BlockMeta[];
  /** 块 id → 来源；省略的块是 "absent"。响应里的 `sources` 用它。 */
  sources: Record<CardV13BlockKey, CardV13Source>;
  warnings: string[];
  /** 正文签名（不含读法常量与卡尾注释），用于「同输入不重渲染」。 */
  signature: string;
}

interface BuiltV13Block {
  id: CardV13BlockKey;
  lines: string[];
  source: CardV13Source;
  confidence: CardV13Confidence;
  evidenceIds: string[];
  /** 每一行自己的证据（与 lines 同序同长）：预算减行后据此重算 evidenceIds，只算留下的行。 */
  lineEvidence: string[][];
  warnings: string[];
  /** 尾部这些行不可丢（红线逐条 verbatim）。 */
  protectedTail: number;
}

const BLOCK_SOURCE: Record<CardV13BlockKey, { source: CardV13Source; confidence: CardV13Confidence }> = {
  firstLook: { source: "declared", confidence: "high" },
  life: { source: "declared", confidence: "high" },
  character: { source: "observed", confidence: "medium" },
  voice: { source: "declared", confidence: "high" },
  us: { source: "observed", confidence: "medium" },
  now: { source: "derived", confidence: "low" },
  memory: { source: "observed", confidence: "medium" },
  boundaries: { source: "declared", confidence: "high" },
  recent: { source: "observed", confidence: "medium" },
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 单行化：多行/连续空白压成一行（正文一行一句，不靠换行排版）。 */
function oneLine(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

/**
 * 渠道占位名出现在行首（t21 兜底）：旧 facts / 旧 soul_persona 行里有「user 对我的要求：…」。
 *
 * 上游 history.ts 已经不再把占位名当人名，但 soul_persona 是 append-only，旧行不会自己消失；
 * 渲染侧必须再挡一次，否则卡上永远有一行不是人说的话。只换主语，不猜是谁说的。
 */
const PLACEHOLDER_SPEAKER =
  /^(?:dsh[-_])?(?:user|assistant|system|agent|unknown|guest|bot|ai|model|human)[ \u3000]*(?=(?:对我|说|指出|要求|开始|不放心|把判断))/iu;

/** 把行首占位名换成「对方」，并把「用户」改成第二人称；其余文本一个字符都不动。 */
function speakerSafe(text: string): string {
  return oneLine(text).replace(/用户/gu, "你").replace(PLACEHOLDER_SPEAKER, "对方");
}

/** 断句：只按句末标点切，保留标点；不切分号（分号常连接同一句的两个动作）。 */
function sentences(text: string): string[] {
  const t = text.replace(/\r\n?/gu, "\n").trim();
  if (t === "") return [];
  return t
    .split(/(?<=[。！？!?])|\n/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** 「身份：生产人物档案链路的拍板决策人」→ { field: "身份", rest: "…" }；没有字段前缀返回 null。 */
function splitField(line: string): { field: string; rest: string } | null {
  const m = /^([^：:]{1,8})[：:]\s*(.+)$/u.exec(oneLine(line));
  if (!m) return null;
  const field = (m[1] ?? "").trim();
  const rest = (m[2] ?? "").trim();
  if (field === "" || rest === "") return null;
  return { field, rest };
}

function uniqLines(lines: ReadonlyArray<CardV13Line>): CardV13Line[] {
  const out: CardV13Line[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const text = oneLine(line.text);
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    out.push({ text, ...(line.evidenceIds?.length ? { evidenceIds: line.evidenceIds } : {}) });
  }
  return out;
}

function evidenceOf(lineEvidence: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const perLine of lineEvidence) {
    for (const id of perLine) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids.slice(0, 8);
}

/**
 * 单块裁剪：先丢受保护行之前的尾行，仍超就截最后一条非保护行；红线一行不丢。
 * 每次裁剪都留 `truncated:<块名>`，不静默削。
 */
interface CappedBlockLines {
  texts: string[];
  /** 保留下来的行在入参数组里的下标，与 texts 一一对应（裁剪只丢整行或截末行，不重排）。 */
  keptIndices: number[];
}

function capBlockLines(
  lines: string[],
  max: number,
  title: string,
  warnings: string[],
  protectedTail = 0,
): CappedBlockLines {
  const out = [...lines];
  const kept = lines.map((_, i) => i);
  const size = (): number => out.join("\n").length;
  while (size() > max && out.length > protectedTail + 1) {
    out.splice(out.length - 1 - protectedTail, 1);
    kept.splice(kept.length - 1 - protectedTail, 1);
    warnings.push(`truncated:${title}（超过单块上限 ${max} 字，丢掉了后几行）`);
  }
  if (size() > max) {
    const idx = out.length - 1 - protectedTail;
    const line = idx >= 0 ? out[idx] : undefined;
    if (typeof line === "string" && line !== "") {
      const keep = Math.max(0, line.length - (size() - max) - 1);
      out[idx] = `${line.slice(0, keep).trimEnd()}…`;
      warnings.push(`truncated:${title}（单行超过 ${max} 字，已截断）`);
    }
  }
  return { texts: out, keptIndices: kept };
}

function blockOf(
  id: CardV13BlockKey,
  lines: CardV13Line[],
  warnings: string[],
  protectedTail = 0,
  sourceOverride?: { source: CardV13Source; confidence: CardV13Confidence },
): BuiltV13Block | null {
  const clean = uniqLines(lines);
  if (clean.length === 0) return null;
  const title = CARD_V13_BLOCK_TITLES[id];
  const capped = capBlockLines(
    clean.map((l) => l.text),
    CARD_V13_BLOCK_MAX_CHARS[id],
    title,
    warnings,
    protectedTail,
  );
  if (capped.texts.length === 0) return null;
  const keptLines = capped.keptIndices
    .map((i) => clean[i])
    .filter((line): line is CardV13Line => line !== undefined);
  const lineEvidence = keptLines.map((line) => line.evidenceIds ?? []);
  return {
    id,
    lines: capped.texts,
    source: sourceOverride?.source ?? BLOCK_SOURCE[id].source,
    confidence: sourceOverride?.confidence ?? BLOCK_SOURCE[id].confidence,
    evidenceIds: evidenceOf(lineEvidence),
    lineEvidence,
    warnings,
    protectedTail: Math.min(protectedTail, capped.texts.length),
  };
}

function firstLookBlock(input: SoulCardV13Input, warnings: string[]): BuiltV13Block | null {
  const lines: CardV13Line[] = [];
  const name = oneLine(input.profile.name ?? "");
  if (name === "") warnings.push("名称为空：声明层没有给 name，卡上用「（未命名）」占位，不从对话里推断");
  lines.push({ text: name === "" ? "（未命名）" : name });
  const image = sentences(input.profile.selfImage ?? "");
  const selfLine = image[0];
  if (selfLine) lines.push({ text: selfLine });
  const purpose = oneLine(input.profile.purpose ?? "");
  if (purpose !== "") lines.push({ text: purpose });
  return blockOf("firstLook", lines, warnings);
}

/**
 * 生活：声明层 selfImage 从第二句起（第一句归「第一眼」），再补 human 层的
 * 喜好/近况/经历/雷点——这些是「他过的日子」，不是关系状态，放这里才不会在 v13 里丢。
 * 都没有就整块省略；source 跟着实际取材走（只有 human 行时是 observed）。
 */
const LIFE_FIELD_TEMPLATES: Record<string, (rest: string) => string> = {
  喜欢: (rest) => `你喜欢${rest}`,
  近况: (rest) => `你最近${rest}`,
  经历: (rest) => `你经历过${rest}`,
  雷点: (rest) => `你受不了${rest}`,
  说话方式: (rest) => `你说话${rest}`,
};

function lifeBlock(input: SoulCardV13Input, warnings: string[]): BuiltV13Block | null {
  const image = sentences(input.profile.selfImage ?? "");
  const declared: CardV13Line[] = image.slice(1).map((text) => ({ text }));
  const human: CardV13Line[] = [];
  for (const line of input.lines?.human ?? []) {
    const parsed = splitField(line.text);
    if (!parsed) continue;
    const template = LIFE_FIELD_TEMPLATES[parsed.field];
    if (!template) continue;
    human.push({ text: template(parsed.rest), ...(line.evidenceIds?.length ? { evidenceIds: line.evidenceIds } : {}) });
  }
  const lines = [...declared, ...human.slice(0, 2)];
  if (lines.length === 0) return null;
  const override = declared.length === 0 ? { source: "observed" as const, confidence: "medium" as const } : undefined;
  return blockOf("life", lines, warnings, 0, override);
}

/**
 * 性格：行为锚。取 identity/values/voice 层的原句（它们本身就是「被指出错时，我先认……」的形状），
 * 只做两件事：把「我站在「X」这边：Y」改写成一句行为锚；丢掉「用户……」这类关系流水账。
 * 标签数值不进正文（spec §5：不拿标签凑锚；不足五条宁可三条）。
 */
function characterBlock(input: SoulCardV13Input, warnings: string[]): BuiltV13Block | null {
  const raw = [
    ...(input.lines?.identity ?? []),
    ...(input.lines?.values ?? []),
    ...(input.lines?.voice ?? []),
  ];
  const anchors: CardV13Line[] = [];
  for (const line of raw) {
    let text = oneLine(line.text);
    const stance = /^我站在「(.+?)」这边[：:]\s*/u.exec(text);
    if (stance) {
      const subject = stance[1] ?? "";
      const rest = text.slice(stance[0].length).trim();
      if (subject === "" || rest === "") continue;
      text = `我把「${subject}」当成底线：${rest}`;
    } else if (/^我站在.+边$/u.test(text)) {
      // 没有后半句的「我站在……这边」是总结句，spec §12 禁它当独立行，直接丢。
      continue;
    }
    // 「用户…」是关系流水账；行首是渠道占位名（user/assistant…）同样不算性格锚——主语都不是人。
    if (text.includes("用户") || PLACEHOLDER_SPEAKER.test(text)) continue;
    anchors.push({ text, ...(line.evidenceIds?.length ? { evidenceIds: line.evidenceIds } : {}) });
    if (uniqLines(anchors).length >= 5) break;
  }
  return blockOf("character", anchors.slice(0, 5), warnings);
}

/** 说话：声音与句长来自声明层 voice；没有声明就退到 voice 层原句；都没有整块省略。 */
function voiceBlock(input: SoulCardV13Input, warnings: string[]): BuiltV13Block | null {
  const declared = sentences(input.profile.voice ?? "").slice(0, 3);
  if (declared.length > 0) return blockOf("voice", declared.map((text) => ({ text })), warnings);
  return blockOf("voice", (input.lines?.voice ?? []).slice(0, 2), warnings);
}

/**
 * 我们：「关系事实 + 连续状态」——human 层里身份/相处/约定/要求四类字段，
 * 加上阶段 2 的 soul_person_relation（你与<名字>：<谓词>）与 soul_person_state 四轴。
 * 先结构化、后观察层：调用方按在场者限定范围（personScoped）时，不再回退
 * persona 的 relationship 行——那是事件流水账，也会把别人的关系史漏进来。
 * 一条事实都没有就整块省略（不写「我们是搭子」这种没有来源的关系类型）。
 */
const US_FIELD_TEMPLATES: Record<string, (rest: string) => string> = {
  身份: (rest) => `你是${rest}`,
  相处: (rest) => `相处上，${rest}`,
  约定: (rest) => `我们说好：${rest}`,
  要求: (rest) => `你要求我：${rest}`,
};

/** 四轴阈值：偏离默认 0.5 至少 0.15 才写，否则「还没长出来」会被读成性格。 */
const PERSON_STATE_STRONG = 0.65;
const PERSON_STATE_WEAK = 0.35;

function personStateLines(state: CardV13PersonState, warnings: string[]): CardV13Line[] {
  const name = oneLine(state.name ?? "");
  if (name === "") {
    warnings.push("person_unresolved:" + state.personKey);
    return [];
  }
  const evidence = state.evidenceIds?.length ? { evidenceIds: state.evidenceIds.slice(0, 3) } : {};
  const out: CardV13Line[] = [];
  if (state.trust >= PERSON_STATE_STRONG) out.push({ text: `我信${name}，答应过的事会兑现。`, ...evidence });
  else if (state.trust <= PERSON_STATE_WEAK) out.push({ text: `对${name}，我还不敢全信，先看下一次。`, ...evidence });
  if (state.affinity >= PERSON_STATE_STRONG) out.push({ text: `和${name}说话，我不用端着。`, ...evidence });
  else if (state.affinity <= PERSON_STATE_WEAK) out.push({ text: `和${name}还隔着一点，没到随口说话的地步。`, ...evidence });
  if (state.respect >= PERSON_STATE_STRONG) out.push({ text: `${name}的判断我服，说不行我会先停下来想。`, ...evidence });
  if (state.obligation >= PERSON_STATE_STRONG) out.push({ text: `我欠${name}一件还没还的事。`, ...evidence });
  return out;
}

function usBlock(input: SoulCardV13Input, warnings: string[]): BuiltV13Block | null {
  const human: CardV13Line[] = [];
  for (const line of input.lines?.human ?? []) {
    const parsed = splitField(line.text);
    if (!parsed) continue;
    const template = US_FIELD_TEMPLATES[parsed.field];
    if (!template) continue;
    human.push({ text: template(parsed.rest), ...(line.evidenceIds?.length ? { evidenceIds: line.evidenceIds } : {}) });
  }
  const structuredRelations = (input.structured?.relations ?? [])
    .map((line) => ({
      text: speakerSafe(line.text),
      ...(line.evidenceIds?.length ? { evidenceIds: line.evidenceIds } : {}),
    }))
    .filter((line) => line.text !== "");
  const stateLines = (input.structured?.personStates ?? [])
    .flatMap((state) => personStateLines(state, warnings))
    .slice(0, 3);
  const scoped = input.structured?.personScoped === true;
  const observedRelations: CardV13Line[] = scoped
    ? []
    : (input.lines?.relationship ?? []).map((line) => ({
        text: speakerSafe(line.text),
        ...(line.evidenceIds?.length ? { evidenceIds: line.evidenceIds } : {}),
      }));
  // 取行优先级（t16 定死，别再倒过来）：已回指的结构化关系 > human 的泛化描述 > 状态维度 > 观察层关系。
  // 关系事实先占前 4 格（生产 agt-h6dp2dvr4a 的何晨卡有 4 条：上级/徒弟/同事/客户），human 其后最多 6 条，
  // 整块上限 8 行——这样 human 占满也不会把第 4 条关系挤掉（core-relations 2026-11-10 实测过 4 条边只出 3 行）；
  // 关系永远不会被裁到 0：它在数组最前，且 slice(0,4) 已封顶。320 字仍由 capBlockLines 硬裁，超了先丢尾。
  const lines = [
    ...structuredRelations.slice(0, 4),
    ...human.slice(0, 6),
    ...stateLines,
    ...observedRelations.slice(0, 2),
  ];
  const structuredUsed = structuredRelations.length > 0 || stateLines.length > 0;
  const block = blockOf(
    "us",
    lines.slice(0, 8),
    warnings,
    0,
    structuredUsed ? { source: "structured", confidence: "medium" } : undefined,
  );
  if (!block) warnings.push("missing_person_state");
  return block;
}

/**
 * 现在：慢心境（soul_mood_state）或即时读数（soul_state）与基线比，写「偏沉/偏松/更稳」不写数字；
 * 注意力/下一步只在 soul_working_state 有未过期行时写，目标只接 active/blocked。
 * 阈值 0.1 是有意的粗粒度：小波动不该让整卡每 tick 换一次文本。
 */
function goalLine(goal: CardV13Goal): CardV13Line {
  const evidence = goal.evidenceIds?.length ? { evidenceIds: goal.evidenceIds.slice(0, 3) } : {};
  const title = oneLine(goal.title ?? "");
  if (goal.status === "blocked") {
    const reason = oneLine(goal.blockedReason ?? "");
    return { text: reason === "" ? `卡在：${title}` : `卡在：${title}（${reason}）`, ...evidence };
  }
  return { text: `下一步：${title}`, ...evidence };
}

/**
 * soul_working_state.current_focus 不是纯句子：goals.ts 的 buildWorkingState 把它拼成
 * 「在做：…；欠着：…；卡住：…」的复合锚，自带标签。卡面这行本身已经叫「手上在做」，
 * 再直拼就会出「手上在做：在做：…」（t25/F2）。这里只取「在做」那一段并抹掉它自带的前缀；
 * 没有「在做」段（只剩欠着/卡住）时返回空——那两种状态由下面的 goals 行与「还欠着」表述，
 * 不在这行重复。没有前缀的纯文本（测试/旧数据）原样返回。
 */
function doingText(raw: string): string {
  const text = oneLine(raw);
  if (text === "") return "";
  if (/^(?:在做|手上在做)[：:]/u.test(text)) {
    const first = text.split("；")[0] ?? "";
    return first.replace(/^(?:在做|手上在做)[：:]\s*/u, "").trim();
  }
  if (/^(?:欠着|卡住)[：:]/u.test(text)) return "";
  return text;
}

function nowBlock(input: SoulCardV13Input, warnings: string[]): BuiltV13Block | null {
  const working = input.structured?.working ?? null;
  const goals = (input.structured?.goals ?? []).filter((g) => g.status === "active" || g.status === "blocked");
  if (!working) warnings.push("missing_working_state");

  const structuredMood = input.structured?.mood ?? null;
  const mood = structuredMood ?? input.mood;
  const lines: CardV13Line[] = [];
  let structuredUsed = structuredMood !== null;

  if (mood) {
    // 基线只认 soul_state（soul_mood_state 没有基线列）；缺基线时用 v13 的固定默认。
    const baselineValence = input.mood?.baselineValence ?? 0;
    const baselineArousal = input.mood?.baselineArousal ?? 0.3;
    const dv = mood.valence - baselineValence;
    const da = mood.arousal - baselineArousal;
    const tone = dv <= -0.1 ? "偏沉" : dv >= 0.1 ? "偏轻" : "还算稳";
    const energy = da <= -0.1 ? "更收着一点" : da >= 0.1 ? "更活一点" : "松紧和平时差不多";
    const evidence = structuredMood?.causeEventIds?.length
      ? { evidenceIds: structuredMood.causeEventIds.slice(0, 3) }
      : {};
    lines.push({ text: `比基线${tone}，${energy}。`, ...evidence });
    const label = oneLine(structuredMood?.label ?? input.mood?.emotionLabel ?? "");
    if (label !== "") {
      // t25/F1：这是 soul_state.emotion_object 最后一个直拼入口。历史脏值
      // （「用户（姓名未提供）是林夏的师父」）与写入侧共用 emotion.ts 的同一把尺子，
      // 不在卡面抄判断；挡掉后只写「心里那点X还在。」，不改写、不解释、不补别的句子。
      const rawObject = oneLine(input.mood?.emotionObject ?? "");
      const object = rawObject !== "" && isReusableAffectObject(rawObject) ? rawObject : "";
      lines.push({ text: object === "" ? `心里那点${label}还在。` : `心里那点${label}还在，冲着${object}。`, ...evidence });
    }
  } else {
    warnings.push("missing_mood_state");
  }

  if (working) {
    const focus = doingText(working.currentFocus ?? "");
    if (focus !== "") {
      lines.push({ text: `手上在做：${focus}` });
      structuredUsed = true;
    }
    for (const question of working.openQuestions ?? []) {
      const text = oneLine(question);
      if (text === "") continue;
      lines.push({ text: `还欠着：${text}` });
      structuredUsed = true;
      if (lines.length >= 4) break;
    }
  }

  const current = working?.currentGoalId ? goals.find((g) => g.goalId === working.currentGoalId) : undefined;
  if (current) {
    lines.push(goalLine(current));
    structuredUsed = true;
  } else {
    const active = goals.find((g) => g.status === "active");
    const blocked = goals.find((g) => g.status === "blocked");
    const next = active ?? blocked;
    if (next) {
      lines.push(goalLine(next));
      structuredUsed = true;
    }
  }

  if (lines.length === 0) return null;
  return blockOf(
    "now",
    lines,
    warnings,
    0,
    structuredUsed ? { source: "structured", confidence: "medium" } : { source: "derived", confidence: "low" },
  );
}

/** 记得：self 层最多三个场景（「我答应自己/我没守住/我一开始没做对」原句）。 */
function memoryBlock(input: SoulCardV13Input, warnings: string[]): BuiltV13Block | null {
  return blockOf("memory", (input.lines?.self ?? []).slice(0, 3), warnings);
}

/** 边界：boundary 层原句（≤2 条）+ 红线逐条 verbatim（受保护，永不丢）。 */
function boundariesBlock(input: SoulCardV13Input, warnings: string[]): BuiltV13Block | null {
  const redlineWarnings: string[] = [];
  const redlines = clampRedlines(
    (input.profile.redlines ?? []).filter((r) => r.active !== false),
    redlineWarnings,
  );
  warnings.push(...redlineWarnings);
  const boundaryLines = (input.lines?.boundary ?? [])
    .slice(0, 2)
    .map((line) => ({ text: speakerSafe(line.text), ...(line.evidenceIds?.length ? { evidenceIds: line.evidenceIds } : {}) }));
  const redlineLines = redlines.map((text) => ({ text }));
  return blockOf("boundaries", [...boundaryLines, ...redlineLines], warnings, redlineLines.length);
}

/** 最近的变化：narrative 层一到两句（「我从什么走到什么、放弃了什么」）。 */
function recentBlock(input: SoulCardV13Input, warnings: string[]): BuiltV13Block | null {
  return blockOf("recent", (input.lines?.narrative ?? []).slice(0, 2), warnings);
}

interface BuiltV13 {
  blocks: BuiltV13Block[];
  warnings: string[];
}

/** 九块构建（每块用自己的上限裁剪），按 CARD_V13_BLOCK_ORDER 返回已排序的块。 */
export function buildV13Blocks(input: SoulCardV13Input): BuiltV13 {
  const warnings: string[] = [];
  const builders: Record<CardV13BlockKey, (i: SoulCardV13Input, w: string[]) => BuiltV13Block | null> = {
    firstLook: firstLookBlock,
    life: lifeBlock,
    character: characterBlock,
    voice: voiceBlock,
    us: usBlock,
    now: nowBlock,
    memory: memoryBlock,
    boundaries: boundariesBlock,
    recent: recentBlock,
  };
  const blocks: BuiltV13Block[] = [];
  for (const key of CARD_V13_BLOCK_ORDER) {
    const block = builders[key](input, warnings);
    if (block) blocks.push(block);
    else warnings.push(`block_omitted:${CARD_V13_BLOCK_TITLES[key]}`);
  }
  return { blocks, warnings };
}

/** 一块的正文（第一眼不带小标题：卡是从名字开始读的，其余块以小标题起一行）。 */
function renderV13Block(block: BuiltV13Block): string {
  if (block.id === "firstLook") return block.lines.join("\n");
  return `${CARD_V13_BLOCK_TITLES[block.id]}\n${block.lines.join("\n")}`;
}

function renderV13Body(blocks: ReadonlyArray<BuiltV13Block>): string {
  return blocks.map(renderV13Block).join("\n\n");
}

/**
 * 渲染 v13 卡。纯函数、无配置、无 I/O：
 *  - hash = sha256(读法常量 + 正文)，沿用 v12 口径；
 *  - 正文超 2400 按 CARD_V13_BUDGET_STEPS 让位（先丢块，再把记得/性格减行），红线永不丢；
 *  - 同一输入两次调用必须逐字节一致（测试锁）。
 */
export function renderPersonaCardV13(input: SoulCardV13Input): PersonaCardV13Snapshot {
  const built = buildV13Blocks(input);
  const warnings = [...built.warnings];
  let kept = built.blocks;
  let body = renderV13Body(kept);

  for (const step of CARD_V13_BUDGET_STEPS) {
    if (body.length <= CARD_V13_MAX_CHARS) break;
    const idx = kept.findIndex((b) => b.id === step.key);
    if (idx < 0) continue;
    if (step.kind === "block") {
      kept = [...kept.slice(0, idx), ...kept.slice(idx + 1)];
      warnings.push(`整卡超过 ${CARD_V13_MAX_CHARS} 字，丢掉块：${CARD_V13_BLOCK_TITLES[step.key]}`);
    } else {
      const block = kept[idx];
      if (!block || block.lines.length <= step.maxLines) continue;
      kept = [
        ...kept.slice(0, idx),
        {
          ...block,
          lines: block.lines.slice(0, step.maxLines),
          lineEvidence: block.lineEvidence.slice(0, step.maxLines),
        },
        ...kept.slice(idx + 1),
      ];
      warnings.push(
        `整卡超过 ${CARD_V13_MAX_CHARS} 字，${CARD_V13_BLOCK_TITLES[step.key]}只留前 ${step.maxLines} 行`,
      );
    }
    body = renderV13Body(kept);
  }
  if (body.length > CARD_V13_MAX_CHARS) {
    warnings.push(
      `整卡仍超过 ${CARD_V13_MAX_CHARS} 字（${body.length}）：可丢块已丢尽，只剩第一眼/性格/边界/红线这类不可丢内容，不静默截断`,
    );
  }

  const material = [CARD_READER_NOTE, body].join("\n\n");
  const hash = sha256(material);
  const text = `${material}\n\n<!-- persona-card v="${CARD_V13_SCHEMA_VERSION}" hash="${hash.slice(0, 12)}" -->`;

  const blocks: CardV13BlockMeta[] = CARD_V13_BLOCK_ORDER.map((id) => {
    const block = kept.find((b) => b.id === id);
    if (!block) {
      return {
        id,
        title: CARD_V13_BLOCK_TITLES[id],
        chars: 0,
        source: "absent",
        confidence: "absent",
        evidenceIds: [],
        warnings: [`block_omitted:${CARD_V13_BLOCK_TITLES[id]}`],
      };
    }
    return {
      id,
      title: CARD_V13_BLOCK_TITLES[id],
      chars: block.lines.join("\n").length,
      source: block.source,
      confidence: block.confidence,
      evidenceIds: evidenceOf(block.lineEvidence),
      warnings: [...new Set(block.warnings)],
    };
  });
  const sources = Object.fromEntries(blocks.map((b) => [b.id, b.source])) as Record<CardV13BlockKey, CardV13Source>;
  const signature = kept.map((b) => `${b.id}:${b.lines.join("\u0001")}`).join("\u0002");
  return {
    schema: "13",
    version: input.version,
    hash,
    text,
    chars: text.length,
    blocks,
    sources,
    warnings: [...new Set(warnings)],
    signature,
  };
}

function segmentHash(text: string): string {
  return text === "" ? "" : sha256(text);
}

function segmentOf(text: string, warnings: string[]): CardSegment {
  return { text, chars: text.length, hash: segmentHash(text), warnings };
}

/**
 * 两段载荷（沿用 v12 的接口与口径：空段 text/chars/hash 全空 + warnings 说明）：
 *  - 身份段 = 读法 + 第一眼 + 性格 + 说话 + 边界，≤1000；超限先丢说话、再丢性格；
 *  - 末尾锚 = 第一眼（≤2 行）+ 红线（≤2 条）+ 现在的心境（≤1 行），≤460；超限先丢心境。
 */
export function buildCardSegmentsV13(input: SoulCardV13Input): { identity: CardSegment; anchor: CardSegment } {
  const built = buildV13Blocks(input);

  const identityWarnings: string[] = [];
  const identityKeys: CardV13BlockKey[] = ["firstLook", "character", "voice", "boundaries"];
  let identityBlocks = identityKeys
    .map((key) => built.blocks.find((b) => b.id === key))
    .filter((b): b is BuiltV13Block => !!b);
  const renderIdentity = (bs: ReadonlyArray<BuiltV13Block>): string =>
    [CARD_READER_NOTE, renderV13Body(bs)].filter((s) => s !== "").join("\n\n");
  let identityText = renderIdentity(identityBlocks);
  for (const key of ["voice", "character"] as const) {
    if (identityText.length <= CARD_V13_IDENTITY_MAX_CHARS) break;
    const idx = identityBlocks.findIndex((b) => b.id === key);
    if (idx < 0) continue;
    identityBlocks = [...identityBlocks.slice(0, idx), ...identityBlocks.slice(idx + 1)];
    identityText = renderIdentity(identityBlocks);
    identityWarnings.push(
      `身份段超过 ${CARD_V13_IDENTITY_MAX_CHARS} 字，丢掉块：${CARD_V13_BLOCK_TITLES[key]}（红线不丢）`,
    );
  }
  if (identityText.length > CARD_V13_IDENTITY_MAX_CHARS) {
    identityWarnings.push(
      `身份段仍超过 ${CARD_V13_IDENTITY_MAX_CHARS} 字（${identityText.length}）：可丢块已丢尽，红线等不可丢块原样保留`,
    );
  }
  if (identityText.trim() === "") {
    identityWarnings.push("身份段为空：没有可渲染的身份块");
    identityText = "";
  }
  const identity = segmentOf(identityText, identityWarnings);

  const anchorWarnings: string[] = [];
  const firstLook = built.blocks.find((b) => b.id === "firstLook");
  const boundaries = built.blocks.find((b) => b.id === "boundaries");
  const now = built.blocks.find((b) => b.id === "now");
  const redlineLines = boundaries
    ? boundaries.lines.slice(boundaries.lines.length - boundaries.protectedTail).slice(0, 2)
    : [];
  let anchorBlocks: BuiltV13Block[] = [];
  if (firstLook) anchorBlocks.push({ ...firstLook, lines: firstLook.lines.slice(0, 2) });
  if (boundaries && redlineLines.length > 0) {
    anchorBlocks.push({ ...boundaries, lines: redlineLines, protectedTail: redlineLines.length });
  }
  if (now) anchorBlocks.push({ ...now, lines: now.lines.slice(0, 1) });
  const renderAnchor = (bs: ReadonlyArray<BuiltV13Block>): string => renderV13Body(bs);
  let anchorText = renderAnchor(anchorBlocks);
  if (anchorText.length > CARD_V13_ANCHOR_MAX_CHARS) {
    const withoutNow = anchorBlocks.filter((b) => b.id !== "now");
    anchorText = renderAnchor(withoutNow);
    anchorWarnings.push(`末尾锚超过 ${CARD_V13_ANCHOR_MAX_CHARS} 字，先丢掉「现在」的心境行`);
    anchorBlocks = [...withoutNow];
  }
  if (anchorText.length > CARD_V13_ANCHOR_MAX_CHARS) {
    const shortFirstLook = anchorBlocks.map((b) =>
      b.id === "firstLook" ? { ...b, lines: b.lines.slice(0, 1) } : b,
    );
    anchorText = renderAnchor(shortFirstLook);
    anchorWarnings.push(`末尾锚仍超过 ${CARD_V13_ANCHOR_MAX_CHARS} 字，第一眼只留名字行`);
  }
  if (anchorText.trim() === "") {
    anchorWarnings.push("末尾锚为空：没有可渲染的第一眼/边界");
    anchorText = "";
  }
  return { identity, anchor: segmentOf(anchorText, anchorWarnings) };
}
