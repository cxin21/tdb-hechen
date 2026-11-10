import { createHash } from "node:crypto";
import {
  CARD_READER_NOTE,
  REDLINE_LINE_MAX_CHARS,
  REDLINE_MAX_ROWS,
  REDLINE_TOTAL_MAX_CHARS,
  SEED_LABELS,
  TRAIT_TOP_N,
  type AxisVector,
  type ProjectedLabel,
} from "./traits.js";

/**
 * 卡投影（S2）：纯函数，输入是设定 + 已投影标签 + 各层文本，输出卡文本与 hash。
 * 只做读侧渲染：不发权重、不写库、不调 LLM。区块顺序由 CARD_BLOCK_ORDER 固定。
 */

export const CARD_SCHEMA_VERSION = "12";
/** 权重变化低于此值视为没变：不重渲染、不换 hash（G5）。 */
export const CARD_RERENDER_MIN_DELTA = 0.05;
/** 底色里只给前 2 个标签带 gloss（§3.1）。 */
export const CARD_GLOSS_TOP_N = 2;

export const CARD_BLOCK_ORDER = [
  "name",
  "image",
  "voice",
  "purpose",
  "traits",
  "redlines",
  "human",
  "relationship",
  "selfHistory",
  "autobiography",
  "openLoops",
] as const;

export type CardBlockKey = (typeof CARD_BLOCK_ORDER)[number];

/** 整卡总预算（task-27/P2-5）：单块上限挡不住每块都达标的叠加。 */
export const CARD_MAX_CHARS = 2000;
/**
 * 超预算时丢块的固定顺序：越靠「未完的事 / 自我史 / 关于你 / 关系」越先让位。
 * 红线不在列表里——它是用户立的边界，任何情况下都不丢（宁可整卡超预算并告警）。
 */
export const CARD_BUDGET_DROP_ORDER: CardBlockKey[] = [
  "openLoops",
  "selfHistory",
  "human",
  "relationship",
];

/**
 * P1-2 两段载荷的预算与丢块序。两段都是**整卡正文的投影**：内容全部来自同一次
 * buildCardBlocks（与整卡同一份 block 构建），不引入卡外文本，也不改动整卡 `text`——
 * 老调用方只读 `text`，行为必须逐字不变（见 __tests__/soul-card-segments.test.ts 的基线断言）。
 */
export const IDENTITY_MAX_CHARS = 1600;
export const ANCHOR_MAX_CHARS = 400;
/**
 * 身份段收录的块（顺序与 CARD_BLOCK_ORDER 同向）：读法常量 + 名称 + 形象 + 说话方式 + 使命 + 红线。
 * 超限时按文档顺序 image → voice → purpose **自后向前**删（purpose 先让位，image 最后）。
 * 红线不在丢块列表里：它逐条 verbatim，永不因身份段预算被删（宁可越界并告警）。
 */
export const IDENTITY_BLOCK_KEYS: CardBlockKey[] = ["name", "image", "voice", "purpose", "redlines"];
export const IDENTITY_DROP_ORDER: CardBlockKey[] = ["purpose", "voice", "image"];
/**
 * 末尾锚收录的块：底色（≤3 行）+ 未完的事（≤2 条）+ 关系（≤1 行）+ 自我史（≤1 行）。
 * 自我史必须进锚：生产实测整卡里「关系 + 自我史」占 79%，若锚只放底色/承诺/关系，
 * 学习到的经历会整段消失——那正是「人格有没有长出来」的唯一可见证据。
 */
export const ANCHOR_BLOCK_KEYS: CardBlockKey[] = ["traits", "openLoops", "relationship", "selfHistory"];
/**
 * 末尾锚超限丢块序：自我史 → 关系 → 未完的事 → 底色。
 * 先让位的是最不稳定、最容易被下一轮改写的自我史，然后是关系；底色与承诺留到最后。
 */
export const ANCHOR_DROP_ORDER: CardBlockKey[] = ["selfHistory", "relationship", "openLoops", "traits"];
export const ANCHOR_TRAIT_MAX_LINES = 3;
export const ANCHOR_PROMISE_MAX = 2;
export const ANCHOR_RELATION_MAX_LINES = 1;
export const ANCHOR_SELF_HISTORY_MAX_LINES = 1;

export const CARD_BLOCK_TITLES: Record<CardBlockKey, string> = {
  name: "名称",
  image: "形象",
  voice: "说话方式",
  purpose: "使命",
  traits: "底色",
  redlines: "红线",
  human: "关于你",
  relationship: "关系",
  selfHistory: "自我史",
  autobiography: "自传",
  openLoops: "未完的事",
};

export interface CardRedline {
  text: string;
  active?: boolean;
  createdAt?: string;
}

export interface PersonaCardInput {
  profile: {
    name: string;
    /** 名字来源（task-27/A1）：只有声明或骨架。观察级「从对话猜名字」已删除。 */
    nameSource?: "declared" | "skeleton";
    pronoun?: string;
    selfImage?: string;
    voice?: string;
    purpose?: string;
    redlines?: CardRedline[];
  };
  /** projectLabels() 的输出；evidence/状态门槛已在投影里判过。 */
  labels: ProjectedLabel[];
  /** human 层（关于你），逐行，≤12 行。 */
  human?: string[];
  relationship?: string[];
  selfHistory?: string[];
  autobiography?: string;
  /** 通道 B 用的未完的事；卡本体接口不传，传了才渲染。 */
  openLoops?: string[];
  version: number;
  state?: AxisVector;
}

export interface PersonaCardSnapshot {
  version: number;
  hash: string;
  text: string;
  chars: number;
  /** label → 一位小数后的 act，用于「变化 <0.05 不重渲染」比对。 */
  acts: Record<string, number>;
  labels: Array<{ label: string; act: number; gloss?: string }>;
  warnings: string[];
  /** 内部：除底色数字外的整段文本签名，用于「没变就不重渲染」。 */
  signature: string;
}

export interface PersonaCardRenderResult {
  text: string;
  hash: string;
  warnings: string[];
  acts: Record<string, number>;
  labels: Array<{ label: string; act: number; gloss?: string }>;
}

/**
 * 一段载荷（P1-2）。三口径互相自洽：
 *  - `chars` = `text.length`（UTF-16 码元，与整卡 `chars` 同口径）；
 *  - `hash` = sha256(`text`)（UTF-8；**不**加 CARD_READER_NOTE 前缀，也不带卡尾注释）；
 *  - 空段一律 `text=""`、`chars=0`、`hash=""`，原因写进 `warnings`（不塞占位标题）。
 * 整卡 hash 仍是既有口径 sha256(READER_NOTE + 整卡正文)，两段 hash 不替代它。
 */
export interface CardSegment {
  text: string;
  chars: number;
  hash: string;
  warnings: string[];
}

/** 两段载荷的输入：整卡输入 + 只进锚的未完承诺（不进整卡正文，否则会改老 text）。 */
export interface CardSegmentInput extends PersonaCardInput {
  anchorPromises?: string[];
}

export interface CardSegments {
  identity: CardSegment;
  anchor: CardSegment;
}

/**
 * 渲染卡。previous 存在且除底色数字外文本未变、每个标签 |Δact| < 0.05 时，
 * 直接复用上一版文本与 hash（只更新 version），避免每 tick 无意义重渲染。
 */
export function renderPersonaCard(input: PersonaCardInput, previous?: PersonaCardSnapshot | null): PersonaCardSnapshot {
  const body = buildCardBody(input);
  if (previous && body.signature === previous.signature && sameActs(previous.acts, body.acts)) {
    return { ...previous, version: input.version };
  }
  const material = [CARD_READER_NOTE, body.text].join("\n\n");
  const hash = createHash("sha256").update(material, "utf8").digest("hex");
  const short = hash.slice(0, 12);
  // 卡尾只留一条完整注释（v+hash），不再产出未闭合的 `<persona-card …>`：注入体里挂一个
  // 永远没有闭合标签的元素，等于把卡之后的文本都变成「它的内容」，读侧无法判断卡到哪结束。
  // 需要机器可读的版本/哈希时读 `payload_json`（card-service 的 kind="persona-card"），不从正文猜。
  const withTag = `${material}\n\n<!-- persona-card v="${CARD_SCHEMA_VERSION}" hash="${short}" -->`;
  return {
    version: input.version,
    hash,
    text: withTag,
    chars: withTag.length,
    acts: body.acts,
    labels: body.labels,
    warnings: body.warnings,
    signature: body.signature,
  };
}

/** 仅比对底色数字：任一标签 |Δ| ≥ 0.05 或标签集合变化 → 需要重渲染。 */
export function sameActs(a: Record<string, number>, b: Record<string, number>, delta = CARD_RERENDER_MIN_DELTA): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!(k in b)) return false;
    if (Math.abs(a[k] - b[k]) >= delta) return false;
  }
  return true;
}

interface CardBody {
  text: string;
  signature: string;
  acts: Record<string, number>;
  labels: Array<{ label: string; act: number; gloss?: string }>;
  warnings: string[];
}

type BuiltBlock = { key: CardBlockKey; lines: string[] };

/** block 构建结果：整卡与两段载荷共用同一份材料，保证三者永不互相矛盾。 */
interface CardBlocks {
  blocks: BuiltBlock[];
  acts: Record<string, number>;
  labels: Array<{ label: string; act: number; gloss?: string }>;
  /** 告警按来源块归因：整卡摊平成 warnings[]（顺序不变），两段只取各自块的那几条。 */
  warnings: Array<{ key: CardBlockKey; message: string }>;
}

function buildCardBlocks(input: PersonaCardInput): CardBlocks {
  const warnings: CardBlocks["warnings"] = [];
  const warn = (key: CardBlockKey, message: string) => warnings.push({ key, message });
  const blocks: BuiltBlock[] = [];

  const name = cls(input.profile.name).trim();
  const pronoun = cls(input.profile.pronoun).trim();
  // 名称块：自称按 spec §2 样例渲染成「自称「我」」；名称缺失时不伪造名字（空设定=没有名字，
  // 而不是硬塞一个「它」让人格卡凭空多出一个自称）。
  // 2026-11-07（task-27/A1）：名字只认声明。没有声明就渲染 `（未命名）` —— 它是**占位**，
  // 不是名字：照旧进 name 块（否则卡前几行全空、连一句「这是谁」都没有），但 warning 保留，
  // 读侧与审计都还能看到「这个 agent 还没名字」。「从对话里猜自述名」那一级已删除。
  if (name) blocks.push({ key: "name", lines: [pronoun ? `${name}（自称「${pronoun}」）` : name] });
  else if (pronoun) blocks.push({ key: "name", lines: [`（未命名，自称「${pronoun}」）`] });
  else {
    blocks.push({ key: "name", lines: ["（未命名）"] });
    warn("name", "名称为空：设定里没有名字");
  }

  const image = cls(input.profile.selfImage).trim();
  if (image) blocks.push({ key: "image", lines: [image] });
  const voice = cls(input.profile.voice).trim();
  if (voice) blocks.push({ key: "voice", lines: [voice] });
  const purpose = cls(input.profile.purpose).trim();
  if (purpose) blocks.push({ key: "purpose", lines: [purpose] });

  // 底色：act 降序 top-5，一位小数；只给前 2 个 gloss；轴名绝不出现。
  // gloss 优先用视图里那份（= `soul_trait_label.gloss`，准入时冻结，自生长标签也有）；
  // 种子词表只在视图没写 gloss（空串/缺失，例如该标签还没有库行）时兜底。
  const labels = input.labels
    .filter((l) => l.status !== "dormant")
    .map((l) => {
      const gloss = l.gloss?.trim() || SEED_LABELS.find((s) => s.label === l.label)?.gloss;
      return { label: l.label, act: Math.round(l.act * 10) / 10, gloss };
    })
    .sort((a, b) => b.act - a.act || a.label.localeCompare(b.label))
    .slice(0, TRAIT_TOP_N);
  const acts: Record<string, number> = {};
  const traitLines = labels.map((l, i) => {
    acts[l.label] = l.act;
    const gloss = i < CARD_GLOSS_TOP_N && l.gloss ? ` · ${l.gloss}` : "";
    return `- ${l.label} ${l.act.toFixed(1)}${gloss}`;
  });
  if (traitLines.length === 0) warn("traits", "底色为空：没有达阈值的标签");
  blocks.push({ key: "traits", lines: traitLines.length ? traitLines : ["- （还没有稳到能算数的底色）"] });

  // 红线：active 才进卡；超限按「最近追加优先」保留并告警，绝不物理删除。
  const redlineWarnings: string[] = [];
  const redlines = clampRedlines(input.profile.redlines ?? [], redlineWarnings);
  for (const w of redlineWarnings) warn("redlines", w);
  if (redlines.length) blocks.push({ key: "redlines", lines: redlines.map((r) => `- ${r}`) });

  pushListBlock(blocks, "human", input.human, 12, warnings, "关于你");
  pushListBlock(blocks, "relationship", input.relationship, 12, warnings, "关系");
  pushListBlock(blocks, "selfHistory", input.selfHistory, 12, warnings, "自我史");
  const auto = cls(input.autobiography).trim();
  if (auto) blocks.push({ key: "autobiography", lines: [auto] });
  pushListBlock(blocks, "openLoops", input.openLoops, 3, warnings, "未完的事");

  return { blocks, acts, labels, warnings };
}

function renderBlocks(bs: ReadonlyArray<BuiltBlock>): string {
  return bs.map((b) => `## ${CARD_BLOCK_TITLES[b.key]}\n${b.lines.join("\n")}`).join("\n\n");
}

function buildCardBody(input: PersonaCardInput): CardBody {
  const { blocks, acts, labels, warnings } = buildCardBlocks(input);
  const ordered = CARD_BLOCK_ORDER.map((key) => blocks.find((b) => b.key === key)).filter(
    (b): b is BuiltBlock => !!b && b.lines.length > 0,
  );
  // 整卡总预算（task-27/P2-5）：单块上限挡不住「每块都刚好达标」的叠加——
  // 极端设定下卡会长到注入体里挤掉召回。超限按固定顺序丢块：
  // openLoops → selfHistory → human → relationship（越靠「未完的事/自我史」越先让位）。
  // 红线永不丢：它是用户立的边界，宁可整卡超预算并告警，也不静默削掉一条。
  let kept = ordered;
  let text = renderBlocks(kept);
  const dropped: CardBlockKey[] = [];
  for (const key of CARD_BUDGET_DROP_ORDER) {
    if (text.length <= CARD_MAX_CHARS) break;
    const idx = kept.findIndex((b) => b.key === key);
    if (idx < 0) continue;
    kept = [...kept.slice(0, idx), ...kept.slice(idx + 1)];
    dropped.push(key);
    text = renderBlocks(kept);
  }
  const flat = warnings.map((w) => w.message);
  if (dropped.length) {
    flat.push(
      `整卡超过 ${CARD_MAX_CHARS} 字，按 ${CARD_BUDGET_DROP_ORDER.map((k) => CARD_BLOCK_TITLES[k]).join("→")} 丢弃块：` +
        `${dropped.map((k) => CARD_BLOCK_TITLES[k]).join("、")}（红线不丢）`,
    );
  }
  if (text.length > CARD_MAX_CHARS) {
    flat.push(
      `整卡仍超过 ${CARD_MAX_CHARS} 字（${text.length}）：可丢块已丢尽，只剩红线等不可丢块，不静默截断`,
    );
  }
  const signature = kept
    .filter((b) => b.key !== "traits")
    .map((b) => `${b.key}:${b.lines.join("\u0001")}`)
    .join("\u0002");
  return { text, signature, acts, labels, warnings: flat };
}

/** 段 hash：sha256(段自身 text)；空段返回空串（不 hash 一个占位空行）。 */
function segmentHash(text: string): string {
  return text === "" ? "" : createHash("sha256").update(text, "utf8").digest("hex");
}

function segmentOf(text: string, warnings: string[]): CardSegment {
  return { text, chars: text.length, hash: segmentHash(text), warnings };
}

/** 单行化 + 去重（承诺是「一行一条」，模型偶发给多行会把锚撑破）。 */
function oneLineUnique(lines: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const text = cls(raw).replace(/\s+/gu, " ").trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * P1-2 拆分：把同一批 block 投影成「身份段」与「末尾锚」两个载荷。
 *
 * 口径（可复核）：
 *  - 两段内容只来自 buildCardBlocks（与整卡同一份材料），不拼接卡外文本；
 *  - 身份段 = CARD_READER_NOTE + 名称/形象/说话方式/使命/红线，≤IDENTITY_MAX_CHARS；
 *    超限按 IDENTITY_DROP_ORDER 删块，红线逐条 verbatim 永不删（宁可越界并告警）；
 *  - 末尾锚 = 底色（≤3 行）+ 未完的事（≤2 条）+ 关系（≤1 行），≤ANCHOR_MAX_CHARS；
 *    超限按 ANCHOR_DROP_ORDER 删块；
 *  - 空段 text=""、chars=0、hash=""，原因进 warnings，不塞占位标题；
 *  - 两段都不出现轴名与 α/tanh/方向向量/权重算法（沿用整卡的读侧纪律，由测试兜底）。
 */
export function buildCardSegments(input: CardSegmentInput): CardSegments {
  const built = buildCardBlocks(input);
  const warningsOf = (keys: ReadonlyArray<CardBlockKey>): string[] =>
    built.warnings.filter((w) => keys.includes(w.key)).map((w) => w.message);

  // ── 身份段
  const identityWarnings = warningsOf(IDENTITY_BLOCK_KEYS);
  let identityBlocks = IDENTITY_BLOCK_KEYS.map((key) => built.blocks.find((b) => b.key === key)).filter(
    (b): b is BuiltBlock => !!b && b.lines.length > 0,
  );
  const renderIdentity = (bs: ReadonlyArray<BuiltBlock>): string =>
    [CARD_READER_NOTE, renderBlocks(bs)].filter((s) => s !== "").join("\n\n");
  let identityText = renderIdentity(identityBlocks);
  const identityDropped: CardBlockKey[] = [];
  for (const key of IDENTITY_DROP_ORDER) {
    if (identityText.length <= IDENTITY_MAX_CHARS) break;
    const idx = identityBlocks.findIndex((b) => b.key === key);
    if (idx < 0) continue;
    identityBlocks = [...identityBlocks.slice(0, idx), ...identityBlocks.slice(idx + 1)];
    identityDropped.push(key);
    identityText = renderIdentity(identityBlocks);
  }
  if (identityDropped.length) {
    identityWarnings.push(
      `身份段超过 ${IDENTITY_MAX_CHARS} 字，按 ${IDENTITY_DROP_ORDER.map((k) => CARD_BLOCK_TITLES[k]).join("→")} 丢弃块：` +
        `${identityDropped.map((k) => CARD_BLOCK_TITLES[k]).join("、")}（红线不丢）`,
    );
  }
  if (identityText.length > IDENTITY_MAX_CHARS) {
    identityWarnings.push(
      `身份段仍超过 ${IDENTITY_MAX_CHARS} 字（${identityText.length}）：可丢块已丢尽，红线等不可丢块原样保留，不静默截断`,
    );
  }
  if (identityText.trim() === "") {
    identityWarnings.push("身份段为空：没有可渲染的身份块");
    identityText = "";
  }

  // ── 末尾锚
  const anchorWarnings = warningsOf(ANCHOR_BLOCK_KEYS);
  let anchorBlocks: BuiltBlock[] = [];
  const traitBlock = built.blocks.find((b) => b.key === "traits");
  // 底色块在整卡里恒在（空时是占位行）；锚不搬占位行——空底色时锚该是空的并告警。
  if (built.labels.length > 0 && traitBlock) {
    if (traitBlock.lines.length > ANCHOR_TRAIT_MAX_LINES) {
      anchorWarnings.push(
        `末尾锚的底色只取前 ${ANCHOR_TRAIT_MAX_LINES} 条（整卡共 ${traitBlock.lines.length} 条）`,
      );
    }
    anchorBlocks.push({ key: "traits", lines: traitBlock.lines.slice(0, ANCHOR_TRAIT_MAX_LINES) });
  }
  const promises = oneLineUnique(input.anchorPromises ?? []);
  if (promises.length > ANCHOR_PROMISE_MAX) {
    anchorWarnings.push(`末尾锚的未完的事只取前 ${ANCHOR_PROMISE_MAX} 条（共 ${promises.length} 条）`);
  }
  const promiseLines = promises.slice(0, ANCHOR_PROMISE_MAX).map((t) => `- ${t}`);
  if (promiseLines.length) anchorBlocks.push({ key: "openLoops", lines: promiseLines });
  const relationBlock = built.blocks.find((b) => b.key === "relationship");
  if (relationBlock && relationBlock.lines.length > ANCHOR_RELATION_MAX_LINES) {
    anchorWarnings.push(
      `末尾锚的关系只取前 ${ANCHOR_RELATION_MAX_LINES} 行（整卡共 ${relationBlock.lines.length} 行）`,
    );
  }
  if (relationBlock) {
    anchorBlocks.push({ key: "relationship", lines: relationBlock.lines.slice(0, ANCHOR_RELATION_MAX_LINES) });
  }
  const selfBlock = built.blocks.find((b) => b.key === "selfHistory");
  if (selfBlock && selfBlock.lines.length > ANCHOR_SELF_HISTORY_MAX_LINES) {
    anchorWarnings.push(
      `末尾锚的自我史只取前 ${ANCHOR_SELF_HISTORY_MAX_LINES} 行（整卡共 ${selfBlock.lines.length} 行）`,
    );
  }
  if (selfBlock) {
    anchorBlocks.push({ key: "selfHistory", lines: selfBlock.lines.slice(0, ANCHOR_SELF_HISTORY_MAX_LINES) });
  }
  let anchorText = renderBlocks(anchorBlocks);
  const anchorDropped: CardBlockKey[] = [];
  for (const key of ANCHOR_DROP_ORDER) {
    if (anchorText.length <= ANCHOR_MAX_CHARS) break;
    const idx = anchorBlocks.findIndex((b) => b.key === key);
    if (idx < 0) continue;
    anchorBlocks = [...anchorBlocks.slice(0, idx), ...anchorBlocks.slice(idx + 1)];
    anchorDropped.push(key);
    anchorText = renderBlocks(anchorBlocks);
  }
  if (anchorDropped.length) {
    anchorWarnings.push(
      `末尾锚超过 ${ANCHOR_MAX_CHARS} 字，按 ${ANCHOR_DROP_ORDER.map((k) => CARD_BLOCK_TITLES[k]).join("→")} 丢弃块：` +
        `${anchorDropped.map((k) => CARD_BLOCK_TITLES[k]).join("、")}`,
    );
  }
  if (anchorText.length > ANCHOR_MAX_CHARS) {
    anchorWarnings.push(
      `末尾锚仍超过 ${ANCHOR_MAX_CHARS} 字（${anchorText.length}）：可丢块已丢尽，不静默截断`,
    );
  }
  if (anchorText.trim() === "") {
    anchorWarnings.push("末尾锚为空：没有底色、未完的事、关系或自我史");
    anchorText = "";
  }

  return { identity: segmentOf(identityText, identityWarnings), anchor: segmentOf(anchorText, anchorWarnings) };
}

function pushListBlock(
  blocks: BuiltBlock[],
  key: CardBlockKey,
  lines: string[] | undefined,
  max: number,
  warnings: CardBlocks["warnings"],
  title: string,
): void {
  const clean = (lines ?? []).map((l) => cls(l).trim()).filter(Boolean);
  if (clean.length > max) {
    warnings.push({ key, message: `${title} 超过 ${max} 行，按上限截断（由写侧归并）` });
  }
  if (clean.length) blocks.push({ key, lines: clean.slice(0, max) });
}

/** 红线相似合并阈值（spec §5 超限处理①）。 */
export const REDLINE_MERGE_SIM = 0.85;

/** 比较用的归一文本：去掉空白与标点符号（全角/半角都算），只留字。 */
export function normalizeRedlineForCompare(text: string): string {
  return String(text ?? "").replace(/[\s\p{P}\p{S}]/gu, "");
}

function redlineBigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 相似度：相等/互为连续子串 → 1；否则字符二元组 Dice 系数。 */
export function redlineSimilarity(a: string, b: string): number {
  const x = normalizeRedlineForCompare(a);
  const y = normalizeRedlineForCompare(b);
  if (!x || !y) return 0;
  if (x === y || x.includes(y) || y.includes(x)) return 1;
  const A = redlineBigrams(x);
  const B = redlineBigrams(y);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return (2 * hit) / (A.size + B.size);
}

export interface RedlineMergeOutcome {
  /** 合并后的生效行（正文逐字保留，只去掉被并掉的重复行）。 */
  rows: CardRedline[];
  /** 每一条并掉的来源（写账本用；不进卡、不改正文）。 */
  merged: Array<{ kept: string; dropped: string; sim: number }>;
}

/**
 * 红线去重（spec §5 超限处理①）：与已有行去标点空白后相等、二元组相似 ≥0.85、
 * 或一条是另一条的连续子串 → 并入更早的那条（保留更早的 createdAt），不新增行。
 *
 * 合并只丟「重复的那一行」，不动留用行正文：判据 2 要求红线逐字覆盖 100%，
 * 往正文里追加「来源」标记会让它不再逐字；来源改记账本（可审计、可回放）。
 */
export function mergeDuplicateRedlines(redlines: CardRedline[], simThreshold = REDLINE_MERGE_SIM): RedlineMergeOutcome {
  const rows: CardRedline[] = [];
  const merged: Array<{ kept: string; dropped: string; sim: number }> = [];
  for (const raw of redlines) {
    const text = cls(raw.text).trim();
    if (!text || raw.active === false) continue;
    const hit = rows.find((r) => redlineSimilarity(r.text, text) >= simThreshold);
    if (!hit) {
      rows.push({ text, active: true, createdAt: raw.createdAt ?? "" });
      continue;
    }
    const hitAt = Date.parse(hit.createdAt || "");
    const rawAt = Date.parse(raw.createdAt || "");
    if (Number.isFinite(rawAt) && (!Number.isFinite(hitAt) || rawAt < hitAt)) hit.createdAt = raw.createdAt ?? "";
    merged.push({ kept: hit.text, dropped: text, sim: redlineSimilarity(hit.text, text) });
  }
  return { rows, merged };
}

/**
 * 红线截断：单行 ≤120、≤30 行、总字符 ≤2600。
 * 超限时保留「更早声明」的条目（列表头部优先），新增行一律拒收并记 warning：
 * 红线是用户最早立的边界，越新追加的越该先让步；此前按尾部保留截断，等于先丢用户最早的设定。
 * 输出仍按原顺序；每次截断都记 warning（不静默）。
 */
export function clampRedlines(redlines: CardRedline[], warnings: string[] = []): string[] {
  const active = redlines
    .map((r, i) => ({ text: cls(r.text).trim(), i, active: r.active !== false, createdAt: r.createdAt ?? "" }))
    .filter((r) => r.active && r.text.length > 0);
  let kept = [...active];
  if (kept.length > REDLINE_MAX_ROWS) {
    const rejected = kept.length - REDLINE_MAX_ROWS;
    kept = kept.slice(0, REDLINE_MAX_ROWS);
    warnings.push(`红线超过 ${REDLINE_MAX_ROWS} 行，保留更早的声明、拒收最新 ${rejected} 行`);
  }
  let total = kept.reduce((s, r) => s + r.text.length, 0);
  while (total > REDLINE_TOTAL_MAX_CHARS && kept.length > 1) {
    const dropped = kept.pop()!;
    total -= dropped.text.length;
    warnings.push(`红线总字符超过 ${REDLINE_TOTAL_MAX_CHARS}，拒收最新一条的渲染`);
  }
  const out: string[] = [];
  for (const r of kept) {
    if (r.text.length > REDLINE_LINE_MAX_CHARS) {
      warnings.push(`红线单行超过 ${REDLINE_LINE_MAX_CHARS} 字，已截断渲染`);
      out.push(r.text.slice(0, REDLINE_LINE_MAX_CHARS));
    } else {
      out.push(r.text);
    }
  }
  return out;
}

function cls(v: string | undefined | null): string {
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n") : "";
}
