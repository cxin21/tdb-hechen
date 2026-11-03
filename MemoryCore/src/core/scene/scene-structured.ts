/**
 * B3 · L2 结构化场景块（task-4 / docs/research/2026-11-02-memory-layering-extraction-optimization.md §6-B）。
 *
 * 现状病灶：L2 每轮让 LLM 整篇重写场景块（散文体、无长度上界），14 块 ×
 * 99 runs/天 的重复生成是 L2 token 与延迟的主成本。结构化形态把块拆成
 * 摘要 / 主张（带 heat）/ 事件流（append-only）三段，并用代码侧
 * compact 保证单块不超过 persona.l2Form.maxBlockBytes：
 *  - 超限时按 heat 升序裁主张（同 heat 先删靠后者，保序稳定），
 *  - 主张裁光仍超限才从最旧事件开始丢，
 *  - 只剩骨架仍超限时以骨架为准（META 完整性优先，索引/召回读得回去）。
 *
 * META 段保持既有四字段（created/updated/summary/heat），因此
 * scene_index（14 行索引）与 auto-recall 的读路径完全不变。
 * 缺省 structured=false ⇒ 本模块不参与任何写路径（legacy 逐位不变）。
 */

import { formatSceneBlock, parseSceneBlock } from "./scene-format.js";
import type { SceneBlockMeta } from "./scene-format.js";

/** 一条主张：heat 越大越重要，裁剪时从 heat 最低者开始删。 */
export interface StructuredClaim {
  heat: number;
  text: string;
}

export interface StructuredBlockInput {
  meta: SceneBlockMeta;
  summary?: string;
  claims?: StructuredClaim[];
  events?: string[];
}

export type StructuredBlockVersion = "structured" | "legacy";

export interface ParsedStructuredBlock {
  version: StructuredBlockVersion;
  meta: SceneBlockMeta;
  summary: string;
  claims: StructuredClaim[];
  events: string[];
  /** legacy 块的原始正文（structured 块为空串），供升级时保留语义。 */
  legacyContent: string;
}

export interface CompactionResult {
  text: string;
  droppedClaims: StructuredClaim[];
  droppedEvents: string[];
}

/** META 之后的结构化段标题（解析与渲染共用，避免两处漂移）。 */
const SUMMARY_HEADING = "## 摘要";
const CLAIMS_HEADING = "## 主张";
const EVENTS_HEADING = "## 事件流";
const CLAIM_LINE_RE = /^-\s*\[heat:(\d+)\]\s*(.*)$/;
/** 事件行形如 `<ISO 时间戳> | <描述>`；解析不到时间戳的行保持插入序。 */
const EVENT_LINE_RE = /^(\d{4}-\d{2}-\d{2}T[^\s|]+)\s*\|\s*([\s\S]*)$/u;
/**
 * F9：同时间戳事件判「同源改写」的字符二元组 Dice 阈值。
 * 生产 14 块标定：同时间戳里真同源改写对 ≥0.649（0.649/0.764/0.783/0.803/0.821/0.940），
 * 同主题但不同事实的对 ≤0.449（如「TDD 全链」对「合同与门禁」），0.6 恰好落在断层里。
 * 只用于「时间戳完全相同」的事件对——ADR 的「宁可留两条」仍然成立，不做跨时间语义合并。
 */
const EVENT_REWRITE_DICE_MIN = 0.6;
const DERIVED_CLAIMS_MAX = 3;
const LEGACY_SUMMARY_MAX_CHARS = 200;
const LEGACY_MAX_CLAIMS = 8;
const DEFAULT_MAX_BLOCK_BYTES = 4096;

/** UTF-8 字节数（与 maxBlockBytes 同一口径）。 */
export function structuredByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function normalizeHeat(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * F9（2026-11-03）：heat 的取值域**只**用于 heat（0..MAX_HEAT），且上游可能按更大
 * 尺度给热度（生产实测 META `heat: 74` / `heat: 315`，结构化形态下 14/14 块被旧
 * clamp 压成常数 10）。归一规则：0..10 原样；越界按十进制尺度逐位折算，直到落回
 * 上界（74→7、100→10、315→3、11→1），最终值域 [0,10] 非负整数。
 *
 * 注意：不要把折算合进 normalizeHeat——它同时被当成「非负整数解析器」用在
 * compactStructuredBlock 的 maxBlockBytes 上（4096 会被折算成 409）。
 */
export const MAX_HEAT = 10;

function clampHeat(value: unknown): number {
  let heat = normalizeHeat(value);
  while (heat > MAX_HEAT) heat = Math.floor(heat / 10);
  return heat;
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s+/u.test(line.trim());
}

function stripMarkdownHeading(line: string): string {
  return line.replace(/^#{1,6}\s*/u, "").trim();
}

function paragraphsOf(content: string): string[] {
  return content
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (structuredByteLength(text) <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const chBytes = structuredByteLength(ch);
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

/** 把正文切成 {标题 → 段内行}，只识别三个结构化段标题。 */
function splitStructuredSections(content: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  const known = new Set([SUMMARY_HEADING, CLAIMS_HEADING, EVENTS_HEADING]);
  let current: string | null = null;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (known.has(trimmed)) {
      current = trimmed;
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current && !trimmed.startsWith("## ")) {
      sections.get(current)!.push(line);
    }
  }
  return sections;
}

function linesToText(lines: string[] | undefined): string {
  if (!lines || lines.length === 0) return "";
  return lines.join("\n").trim();
}

/** 事件行的描述部分（去掉 `<ISO 时间戳> |` 前缀；无时间戳则原样返回）。 */
function eventBody(text: string): string {
  const m = text.match(EVENT_LINE_RE);
  return (m ? m[2]! : text).trim();
}

/** 解析事件行的时间戳毫秒数；无时间戳或不可解析返回 null。 */
function eventStampMs(text: string): number | null {
  const m = text.match(EVENT_LINE_RE);
  if (!m) return null;
  const ms = Date.parse(m[1]!);
  return Number.isFinite(ms) ? ms : null;
}

/** 按句切分摘要（中英文句末 + 换行），剥标题/列表前缀；纯标题与空句不算内容。 */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    if (isHeadingLine(rawLine)) continue;
    const line = stripMarkdownHeading(rawLine)
      .replace(/^[-*+]\s+/u, "")
      .trim();
    if (line === "") continue;
    for (const part of line.split(/[。！？!?；;]+/u)) {
      const sentence = part.trim();
      if (sentence !== "") out.push(sentence);
    }
  }
  return out;
}

/**
 * F9：claim 段为空时的派生兜底——上游（LLM）经常只写摘要/事件而把 `## 主张` 留空，
 * 旧实现照抄空段导致 14/14 块零主张（裁剪也失去 heat 依据）。
 * 顺序：段摘要 → META summary（索引既有摘要面）→ 最后一条事件描述；最多 3 条，
 * heat 取 META heat 的归一值。parse(render(x)) 幂等：派生结果一旦渲染成显式 claim
 * 行，下一轮解析走显式分支，值不变。
 */
function deriveFallbackClaims(params: {
  summary: string;
  metaSummary: string;
  events: string[];
  heat: number;
}): StructuredClaim[] {
  const summarySentences = sentencesOf(params.summary);
  // scene-format 的 extractMetaField 在 summary 值为空时会把下一行 `heat: N` 吞进来
  // （`summary:\s*(.*)` 的 \s 跨行）。兜底派生只在 META summary 为空时才走到这里，
  // 此时读到 "heat: N" 就是上述残片，不能当内容。
  const metaSummary = /^heat:\s*-?\d+$/u.test(params.metaSummary.trim()) ? "" : params.metaSummary;
  const sentences = summarySentences.length > 0 ? summarySentences : sentencesOf(metaSummary);
  if (sentences.length > 0) {
    const unique = [...new Set(sentences)].slice(0, DERIVED_CLAIMS_MAX);
    return unique.map((text) => ({ heat: params.heat, text }));
  }
  const lastEvent = params.events[params.events.length - 1];
  if (lastEvent) {
    const body = eventBody(lastEvent);
    if (body !== "") return [{ heat: params.heat, text: body }];
  }
  return [];
}

/** legacy 块升级：首段 → 摘要，其余段 → 等高 heat 主张（原文语义不丢）。 */
function legacyToStructured(meta: SceneBlockMeta, content: string): { summary: string; claims: StructuredClaim[] } {
  const paragraphs = paragraphsOf(content)
    // 纯标题段（如独占一行的 "## 核心叙事"）不是内容，不能挤进摘要/主张。
    .filter((p) => p.split(/\r?\n/u).some((line) => !isHeadingLine(line) && line.trim().length > 0))
    .map((p) =>
      p
        .split(/\r?\n/u)
        .map((line) => stripMarkdownHeading(line))
        .filter((line) => line.length > 0)
        .join(" ")
        .trim(),
    )
    .filter((p) => p.length > 0);

  const heat = clampHeat(meta.heat);
  const summary =
    truncateToBytes(paragraphs[0] ?? meta.summary ?? "", LEGACY_SUMMARY_MAX_CHARS) ||
    truncateToBytes(meta.summary ?? "", LEGACY_SUMMARY_MAX_CHARS);
  const claims = paragraphs.slice(0, LEGACY_MAX_CLAIMS).map((text) => ({ heat, text }));

  return { summary, claims };
}

/** 解析场景块：识别结构化段；无结构化段即 legacy（升级时按段落派生摘要/主张）。 */
export function parseStructuredBlock(raw: string): ParsedStructuredBlock {
  const block = parseSceneBlock(raw ?? "", "");
  const content = block.content ?? "";
  const sections = splitStructuredSections(content);
  const structured = sections.size > 0;

  if (!structured) {
    const upgraded = legacyToStructured(block.meta, content);
    const heat = clampHeat(block.meta.heat);
    return {
      version: "legacy",
      meta: { ...block.meta, heat },
      summary: upgraded.summary,
      claims:
        upgraded.claims.length > 0
          ? upgraded.claims
          : deriveFallbackClaims({
              summary: upgraded.summary,
              metaSummary: block.meta.summary,
              events: [],
              heat,
            }),
      events: [],
      legacyContent: content,
    };
  }

  const claims: StructuredClaim[] = [];
  for (const line of sections.get(CLAIMS_HEADING) ?? []) {
    const m = line.trim().match(CLAIM_LINE_RE);
    if (!m) continue;
    const text = m[2]!.trim();
    if (text === "") continue;
    claims.push({ heat: clampHeat(m[1]), text });
  }

  const events: string[] = [];
  for (const line of sections.get(EVENTS_HEADING) ?? []) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const body = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
    if (body === "") continue;
    events.push(body);
  }

  const summary = linesToText(sections.get(SUMMARY_HEADING));
  const heat = clampHeat(block.meta.heat);
  return {
    version: "structured",
    meta: { ...block.meta, heat },
    summary,
    claims:
      claims.length > 0 ? claims : deriveFallbackClaims({ summary, metaSummary: block.meta.summary, events, heat }),
    events,
    legacyContent: "",
  };
}

/** 渲染结构化块：META（既有四字段）+ 摘要 + 主张 + 事件流；空段不写标题。 */
export function renderStructuredBlock(input: StructuredBlockInput): string {
  const summary = (input.summary ?? "").trim();
  const claims = input.claims ?? [];
  const events = input.events ?? [];

  // 三段标题恒在（空段只有标题）：形态稳定，解析侧永远能识别 version="structured"，
  // 下游不必为「这次有没有事件」分支。段标题本身也计入 maxBlockBytes。
  const sections: string[] = [summary === "" ? SUMMARY_HEADING : SUMMARY_HEADING + "\n" + summary];
  const claimLines = claims.map((c) => "- [heat:" + String(clampHeat(c.heat)) + "] " + c.text.trim()).join("\n");
  sections.push(claimLines === "" ? CLAIMS_HEADING : CLAIMS_HEADING + "\n" + claimLines);
  const eventLines = events.map((e) => "- " + e.trim()).join("\n");
  sections.push(eventLines === "" ? EVENTS_HEADING : EVENTS_HEADING + "\n" + eventLines);

  // META 也是 0..MAX_HEAT（越界值来自模型自由发挥，写盘前归一）。
  return formatSceneBlock({ ...input.meta, heat: clampHeat(input.meta.heat) }, sections.join("\n\n"));
}

/**
 * 事件流 append-only 合并：上一版事件优先、去重后并入新事件，最终按时间归位。
 *
 * F9（2026-11-03）：生产 190 条事件里 23 条与同块内另一条同时间戳且内容高度重合
 * （模型把同一次操作换了措辞重复追加）。旧实现只抹排版差异做精确键，措辞改写认不出来，
 * 且从不排序 → 事件段越写越乱。现在的判重分两层：
 *  1. 规范化键完全相同（空白/大小写/标点差异）→ 同一条，保留首条原文；
 *  2. **仅当时间戳完全相同**且描述归一后的字符二元组 Dice ≥ 0.6 → 判同源改写，
 *     保留信息更全的一条（归一后更长者，同长保留先到者），仍不改写历史。
 * 不做跨时间戳的语义合并：ADR「宁可留两条」优先于去重。
 * 输出按时间升序；解析不到时间戳的事件保持插入序并排在末尾。
 */
export function mergeAppendOnlyEvents(previous: string[], next: string[]): string[] {
  const seen = new Set<string>();
  const kept: Array<{ text: string; key: string; stampMs: number | null; bodyKey: string }> = [];

  for (const event of [...previous, ...next]) {
    const text = String(event ?? "").trim();
    if (text === "") continue;
    const key = eventKeyOf(text);
    if (key === "") continue;
    if (seen.has(key)) continue;

    const candidate = {
      text,
      key,
      stampMs: eventStampMs(text),
      bodyKey: normalizeEventText(eventBody(text)),
    };

    if (candidate.stampMs !== null) {
      const duplicate = kept.findIndex(
        (item) =>
          item.stampMs === candidate.stampMs &&
          charBigramDice(item.bodyKey, candidate.bodyKey) >= EVENT_REWRITE_DICE_MIN,
      );
      if (duplicate >= 0) {
        const existing = kept[duplicate]!;
        // 同源改写：保留信息更全的一条；被替换者也记入 seen，避免后续再判定。
        seen.add(existing.key);
        seen.add(candidate.key);
        if (candidate.bodyKey.length > existing.bodyKey.length) kept[duplicate] = candidate;
        continue;
      }
    }

    seen.add(key);
    kept.push(candidate);
  }

  return kept
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const left = a.event.stampMs;
      const right = b.event.stampMs;
      if (left === null && right === null) return a.index - b.index;
      if (left === null) return 1;
      if (right === null) return -1;
      return left - right || a.index - b.index;
    })
    .map(({ event }) => event.text);
}

/** 只抹排版差异（空白/大小写/标点），不抹时间戳与语义。 */
function normalizeEventText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[，。！？；：、,.!?;:'"“”‘’（）()\[\]【】<>《》~～]/gu, "");
}

/**
 * 事件行的比较键：只抹平排版差异（空白/大小写/标点），不抹平时间戳与语义。
 * 刻意不做相似度阈值——精确键这一层绝不把「部署失败」并进「部署完成」。
 * 同时间戳的措辞改写由 mergeAppendOnlyEvents 的 Dice 阈值层处理。
 */
function eventKeyOf(text: string): string {
  return normalizeEventText(text);
}

/** 字符二元组多重集（用于同一时间戳下的同源改写判定）。 */
function charBigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** 归一文本的字符二元组 Dice 系数：0（无重合）..1（完全相同）。 */
function charBigramDice(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const leftGrams = charBigrams(left);
  const rightGrams = charBigrams(right);
  let intersection = 0;
  let total = 0;
  for (const [gram, count] of leftGrams) {
    total += count;
    intersection += Math.min(count, rightGrams.get(gram) ?? 0);
  }
  for (const count of rightGrams.values()) total += count;
  return total === 0 ? 0 : (2 * intersection) / total;
}

/**
 * 把结构化块压到 maxBlockBytes 以内。
 * 顺序：先裁 heat 最低的主张（同 heat 后出现者先删）→ 再从最旧事件丢 →
 * 最后截摘要 → 只剩骨架仍超限则保留骨架（META 完整性优先）。
 */
export function compactStructuredBlock(parsed: ParsedStructuredBlock, maxBlockBytes: number): CompactionResult {
  const cap = Number.isFinite(maxBlockBytes) && maxBlockBytes > 0 ? Math.floor(maxBlockBytes) : DEFAULT_MAX_BLOCK_BYTES;
  const claims = parsed.claims.map((c) => ({ heat: clampHeat(c.heat), text: c.text }));
  const events = [...parsed.events];
  const droppedClaims: StructuredClaim[] = [];
  const droppedEvents: string[] = [];
  let summary = parsed.summary ?? "";

  const build = (): string => renderStructuredBlock({ meta: parsed.meta, summary, claims, events });

  let text = build();
  while (structuredByteLength(text) > cap && claims.length > 0) {
    let dropIdx = 0;
    for (let i = 1; i < claims.length; i++) {
      if (claims[i]!.heat <= claims[dropIdx]!.heat) dropIdx = i;
    }
    droppedClaims.push(claims[dropIdx]!);
    claims.splice(dropIdx, 1);
    text = build();
  }

  while (structuredByteLength(text) > cap && events.length > 0) {
    const dropped = events.shift();
    if (dropped !== undefined) droppedEvents.push(dropped);
    text = build();
  }

  if (structuredByteLength(text) > cap) {
    const overflow = structuredByteLength(text) - cap;
    summary = truncateToBytes(summary, Math.max(0, structuredByteLength(summary) - overflow));
    text = build();
  }

  return { text, droppedClaims, droppedEvents };
}

/**
 * 单块应用结构化形态：
 *  - 解析当前块（LLM 新产品或已有块）；
 *  - 与上一版（抽取前快照）做事件流 append-only 合并；
 *  - 压到 maxBlockBytes。
 * 返回可直接写盘的文本；与入参相同表示无需改写。
 */
export function applyStructuredForm(params: {
  raw: string;
  previousRaw?: string | null;
  maxBlockBytes?: number;
}): string {
  const cap = params.maxBlockBytes && params.maxBlockBytes > 0 ? params.maxBlockBytes : DEFAULT_MAX_BLOCK_BYTES;
  const current = parseStructuredBlock(params.raw);
  const previous = params.previousRaw ? parseStructuredBlock(params.previousRaw) : null;
  const events = mergeAppendOnlyEvents(previous?.events ?? [], current.events);
  return compactStructuredBlock({ ...current, events }, cap).text;
}

/**
 * 结构化形态的 prompt 追加段（structured=true 时才拼，缺省路径逐位不变）。
 * 显式给出三段标题、claim 行格式与字节上限，避免 LLM 自由发挥破坏可解析性。
 */
export function buildStructuredFormGuidance(maxBlockBytes: number): string {
  const cap = maxBlockBytes > 0 ? maxBlockBytes : DEFAULT_MAX_BLOCK_BYTES;
  return [
    "## 输出形态要求（结构化场景块，必须遵守）",
    "",
    "每个场景块 <project>/scene_blocks/<name>.md 的正文必须按以下三段组织，META 段保持既有四字段（created / updated / summary / heat）不变：",
    "",
    "1. " + SUMMARY_HEADING + "：1-3 句、不超过 200 字的事实性摘要，用于 14 行索引与召回（必须能独立读懂）。",
    "2. " +
      CLAIMS_HEADING +
      "：每条一行，格式 - [heat:<0-10>] <可验证的事实/偏好/决策>；heat 表示稳定度与重要性，越稳定越高。",
    "3. " +
      EVENTS_HEADING +
      "：每条一行 - <ISO 时间戳> | <发生了什么>；**append-only**——已存在的事件行必须原样保留，只允许在末尾追加新行，禁止重写或删除历史事件。",
    "",
    "**单块总量硬上限 " +
      String(cap) +
      " 字节（UTF-8）**。超限时按 heat 从低到高删除 " +
      CLAIMS_HEADING +
      " 里的行，不要为压缩而删除历史事件行，也不要把多段散文塞进单条主张。",
    "",
    "不要输出与上述三段无关的自由散文段落；叙事性内容一律拆成主张或事件行。",
  ].join("\n");
}
