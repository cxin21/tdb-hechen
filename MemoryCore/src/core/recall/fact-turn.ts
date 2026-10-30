/**
 * #146（W2b 事实级双时态）：事实行 → turn 的读侧投影。
 *
 * 为什么需要这一层（第一性原理）：
 *   记忆系统里有三个粒度，本来就不该共用一个单位——
 *     · 写/失效：**属性槽** (entity, attribute)，只保留最新有效值；
 *     · 存储：事实行（可审计、可追溯）；
 *     · 召回预算与注入：**turn**（一条证据 = 一轮对话的语境）。
 *   写面切到事实级后，若读面仍按行计 k，同一 turn 的 n 条事实会各吃一个槽（槽位通胀），
 *   同时片段化会丢说话人/时间语境。实测（LME90，b1off 浅档）turnCov@5 78.4→68.0、
 *   偏好桶 93.3→55.6。所以读侧必须把同 turn 的事实行折叠回一条。
 *
 * 语义：同 fact_of 的命中只保留**得分最高**的那一条（其 content 即父 turn 原文，
 * 与整行基线逐位一致）；没有 fact_of 的普通记忆原样保留，零行为变化。
 * 纯函数、无 store 依赖（便于单测与 bench 复用）。
 *
 * #166（值级泄漏补口）：v2 的行 content 是父 turn 原文——单值事实被取代后，同 turn 的
 * 多值兄弟行仍 active，折叠回 turn 时又把**旧值所在的原文**带回注入（行级失效正确，
 * 文本级泄漏）。修法：问当下时把**池内**已过期的行（superseded：硬丢或 soft 降权
 * 后仍留在池里的）视为「污染源」——只看硬丢会漏：soft 档的 related 是
 * contentTokenOverlap，属性更新前后原文常无词重叠，过期行多数只被降权保留在池里。
 * 该 turn 的存活行不再用父 turn 原文，而是**各自的事实短语**（metadata.fact_phrase）——
 * 注入单位从 turn 降级为事实集合，旧值没有任何回流入口；无法给出无旧值文本的行
 * 直接剔出注入（宁缺毋滥，绝不带旧值）。
 */

/** 折叠统计（可观测：不静默丢命中）。 */
export interface FactTurnCollapse {
  /** 折叠前条数。 */
  before: number;
  /** 折叠掉（同 turn 低分重复）条数。 */
  collapsed: number;
  /** 折叠后条数。 */
  after: number;
  /** 因旧值污染而把注入文本降级为自身事实短语的存活行数（#166）。 */
  maskedRows: number;
  /** 因遮蔽而整组无行可注入、因而丢掉证据的 turn 数（#166）。 */
  droppedRows: number;
  /** 当污染源取到的被取代旧值个数（#166；去重后计数，不等于「命中次数」）。 */
  staleValues: number;
}

/** #166：present-intent 下池内过期事实行的读法（accessor 由调用方给，零类型耦合）。 */
export interface FactTurnMaskOptions<T> {
  /** 池内已过期的行（硬丢或 soft 降权）：识别「污染 turn」并取出旧值集合。 */
  superseded?: readonly T[];
  /** 该行承载的单条事实短语（metadata.fact_phrase）。 */
  phraseOf?: (entry: T) => string | undefined;
  /** 该行承载的事实值（metadata.fact_value / factTriples[0].value）。 */
  valueOf?: (entry: T) => string | undefined;
}

/** 事实行投影结果：折叠后的候选 + 每个污染 turn 存活行的安全渲染文本。 */
export interface FactTurnProjection<T> {
  items: T[];
  stats: FactTurnCollapse;
  /**
   * 污染 turn 的存活行 → 安全渲染文本（该行自己的事实短语）。读侧格式化时优先用它，
   * 而不是父 turn 原文；不在 Map 里的行沿用原 content（零行为变化）。
   */
  displayContent: Map<T, string>;
}

/** 文本归一（大小写/空白/全半角）——旧值判定与文本无关的排版差异必须先抹平。 */
export function normalizeStaleText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

function isAsciiWordChar(ch: string): boolean {
  return ch !== "" && /[A-Za-z0-9_]/.test(ch);
}

/**
 * 文本里是否出现被取代的旧值。
 *
 * 两种匹配口径（缺一不可）：
 *  - 含 CJK 的值：直接子串匹配（中文没有词边界，子串即语义命中）；
 *  - 纯 ASCII 值：**词边界**匹配，否则值 "LA" 会命中 "planning" 里的 "la"（实测误判），
 *    导致正常事实短语被无谓剔除。不使用正则 lookbehind，避免宿主 Node 版本差异。
 */
export function containsStaleValue(text: string, value: string): boolean {
  const haystack = normalizeStaleText(text);
  const needle = normalizeStaleText(value);
  if (!needle) return false;
  if (CJK_RE.test(needle)) return haystack.includes(needle);
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    if (!isAsciiWordChar(haystack[at - 1] ?? "") && !isAsciiWordChar(haystack[at + needle.length] ?? "")) return true;
    from = at + 1;
  }
}

/**
 * 按 fact_of 折叠事实行，保留每组最高分的首条；组内顺序取最高分首次出现的位置。
 *
 * @param entries 已排序的候选（打分序由调用方保证）
 * @param factOfOf 取 fact_of（缺省/空 = 普通记忆，不参与折叠）
 * @param scoreOf 取比较分（调用方传主序分，如 relevance ?? rrfScore）
 * @param opts #166 值级泄漏补口：传 superseded（present-intent 下池内过期的行）后，
 *   污染 turn 的存活行只保留「事实短语不含任何被取代旧值」的行，并在 displayContent
 *   里给出短语文本；缺省（不传）时逐位保持 v2 行为。
 */
export function collapseFactRowsByTurn<T>(
  entries: readonly T[],
  factOfOf: (entry: T) => string | undefined,
  scoreOf: (entry: T) => number,
  opts?: FactTurnMaskOptions<T>,
): FactTurnProjection<T> {
  // 污染 turn → 被取代旧值集合（旧值缺失也照样标记污染：该 turn 的原文不可再整段注入）
  const staleByTurn = new Map<string, string[]>();
  let staleValues = 0;
  for (const row of opts?.superseded ?? []) {
    const parent = factOfOf(row);
    if (!parent) continue;
    let values = staleByTurn.get(parent);
    if (!values) {
      values = [];
      staleByTurn.set(parent, values);
    }
    const value = opts?.valueOf?.(row);
    if (value && normalizeStaleText(value)) {
      values.push(value);
      staleValues++;
    }
  }

  const items: T[] = [];
  const indexOfKey = new Map<string, number>();
  const maskedText = new Map<T, string>();
  let collapsed = 0;
  for (const entry of entries) {
    const parent = factOfOf(entry);
    const stale = parent ? staleByTurn.get(parent) : undefined;
    if (stale) {
      const phrase = opts?.phraseOf?.(entry);
      // 没有短语 → 无法保证不带旧值；短语里仍含旧值 → 抽取/归一异常。两种都剔出注入。
      if (!phrase || stale.some((v) => containsStaleValue(phrase, v))) {
        continue;
      }
      maskedText.set(entry, phrase);
    }
    if (!parent) {
      items.push(entry);
      continue;
    }
    const existingIndex = indexOfKey.get(parent);
    if (existingIndex === undefined) {
      indexOfKey.set(parent, items.length);
      items.push(entry);
      continue;
    }
    collapsed++;
    const existing = items[existingIndex];
    if (scoreOf(entry) > scoreOf(existing)) items[existingIndex] = entry;
  }

  // 丢证据的统计放在折叠之后：被剔的落选兄弟本来也不会注入，先数会高估（#166 review）
  let droppedRows = 0;
  const represented = new Set<string>();
  for (const entry of items) {
    const parent = factOfOf(entry);
    if (parent) represented.add(parent);
  }
  for (const turn of staleByTurn.keys()) {
    if (!represented.has(turn) && entries.some((e) => factOfOf(e) === turn)) droppedRows++;
  }

  // displayContent 只保留折叠后真正会注入的那一条（落选兄弟行不渲染，无需携带）
  const displayContent = new Map<T, string>();
  for (const entry of items) {
    const text = maskedText.get(entry);
    if (text) displayContent.set(entry, text);
  }
  return {
    items,
    stats: {
      before: entries.length,
      collapsed,
      after: items.length,
      maskedRows: displayContent.size,
      droppedRows,
      staleValues,
    },
    displayContent,
  };
}
