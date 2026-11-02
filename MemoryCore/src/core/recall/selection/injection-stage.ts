/**
 * #179 S3/S4（2026-11-02）：注入装配选线——意图预算 → 名次尺/地板 → 同回合折叠。
 *
 * 规格 docs/specs/2026-11-02-recall-selection-layered-ruler-spec.md §4.3/§4.5：
 *   - 选择机制归 `recall.layerRuler.{mode,keepRatio,minPerLayer,floor}`（纯名次切 + 标定地板）；
 *   - 注入装配归 `recall.injection.{foldIdentical,budgetByIntent}`（与选线开关独立）；
 *   - 所有新键缺省 = 今天行为（foldIdentical=false、budgetByIntent 全 null）。
 *     `PRODUCTION_INJECTION_BUDGET` 只是「切换时写进生产配置的建议值」，不是代码缺省。
 *
 * 关键不变量：
 *   ① mode=off 时不调用 embedding、不改行、droppedBy 全 0（观测面不是行为开关）；
 *   ② 嵌入超时/报错/空向量/维度不符 → 整段 bypass，注入与 mode=off 逐位一致
 *      （journal 记 ruler.bypass="ruler-unavailable"），绝不退化为「全量注入」也绝不
 *      把 0 相似度当成「全部砍掉」；
 *   ③ 折叠按「回合」：上一回合注入行逐字节相同 → 本回合 0 行（调用方给 previousHash）；
 *   ④ 任何路径都不为「别空着」放宽地板或补位——0 行是合法结果。
 */
import { createHash } from "node:crypto";

import { isAssistantRecallQuery } from "../../recall/query-intent.js";
import { layerRulerSelect, type LayerRulerDropReason } from "./layer-ruler.js";
import { resolveEmbeddingSimFloor } from "./floor-calibration.js";

/** 注入预算的意图档位（对应规格 §4.3 的 budgetByIntent 四键）。 */
export type InjectionIntent = "empty" | "continuation" | "self" | "info";

export interface InjectionBudgetByIntent {
  /** 空查询 / 工具调用轮：0 行。 */
  empty: number | null;
  /** 短续接语：1 行足够（上文已在上下文里）。 */
  continuation: number | null;
  /** 自指召回（「你上次说的…」）：1 行。 */
  self: number | null;
  /** 信息型：null = 不裁（跟 maxResults 走）。 */
  info: number | null;
}

/**
 * 切换时写进生产配置的建议值（规格 §4.3）。注意：**不是**代码缺省——
 * 代码缺省全为 null 才能满足「新键缺省 = 今天行为」。
 */
export const PRODUCTION_INJECTION_BUDGET: Readonly<InjectionBudgetByIntent> = Object.freeze({
  empty: 0,
  continuation: 1,
  self: 1,
  info: null,
});

/** 续接语前缀（须整句都是续接语：长度 ≤12 且无英文/数字实体，避免误砍短问题）。 */
const CONTINUATION_CUES: readonly RegExp[] = [
  /^(?:那)?继续/,
  /^接着/,
  /^然后呢/,
  /^还有呢/,
  /^再来/,
  /^展开说说/,
  /^详细说说/,
  /^继续讲/,
  /^说说看/,
  /^go on\b/i,
  /^continue\b/i,
];

/** 续接语最大长度：超过就认为带了新实体（如「继续昨天那个采购单据改造」）。 */
const CONTINUATION_MAX_CHARS = 12;
/** 剥掉续接前缀后允许的尾巴长度（"继续吧"/"接着说一下" 可以，"继续昨天那个改造" 不行）。 */
const CONTINUATION_TAIL_MAX_CHARS = 4;

/**
 * 查询 → 注入预算档位。纯规则、零外呼：
 *   empty（空/纯空白）→ continuation（短续接语）→ self（自指召回，复用 #138 判据）→ info。
 */
export function classifyInjectionIntent(text: string): InjectionIntent {
  if (typeof text !== "string") return "info";
  const raw = text.trim();
  if (raw.length === 0) return "empty";
  // 续接语 = 前缀命中 + 剥掉前缀后的尾巴很短（≤4 字）：`继续昨天那个采购单据改造` 这类
  // 「带了新实体」的短句必须归 info，否则会被压到 1 行、把答案挤掉。
  const cue = CONTINUATION_CUES.find((re) => re.test(raw));
  const tail = cue ? raw.replace(cue, "").trim() : "";
  const isContinuation =
    raw.length <= CONTINUATION_MAX_CHARS &&
    cue !== undefined &&
    tail.length <= CONTINUATION_TAIL_MAX_CHARS &&
    !/[0-9A-Za-z]/.test(tail);
  if (isContinuation) return "continuation";
  if (isAssistantRecallQuery(raw)) return "self";
  return "info";
}

/** 取该意图的预算；null = 不裁（今天行为）。0 是有效取值（= 不注入）。 */
export function injectionBudgetOf(intent: InjectionIntent, budget: InjectionBudgetByIntent | undefined): number | null {
  if (!budget) return null;
  const v = budget[intent];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/**
 * 注入行 → 记忆层名（行首 `- [类型|场景]` 的第一段）。无前缀的裸文本归 "unknown"。
 * 行格式源头见 auto-recall.ts 的 formatMemoryLine（`- [${tag}] ${content}`）。
 */
export function layerOfMemoryLine(line: string): string {
  if (typeof line !== "string") return "unknown";
  const m = /^- \[([^\]]+)\]/.exec(line.trim());
  if (!m) return "unknown";
  const tag = m[1].split("|")[0]?.trim() ?? "";
  return tag.length > 0 ? tag : "unknown";
}

/** 行内容 sha256 前 8 hex（journal 不记行全文，只记可对账指纹）。 */
export function hash8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

/** 整批注入行指纹（顺序敏感）：折叠判等用，记在回合台账里。 */
export function hashLines(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\u0000"), "utf8").digest("hex");
}

function cosine(a: Float32Array, b: Float32Array): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 1e-12 || nb <= 1e-12) return null;
  const sim = dot / Math.sqrt(na * nb);
  if (!Number.isFinite(sim)) return null;
  return sim;
}

export type InjectionRulerMode = "off" | "shadow" | "enforce";

export interface InjectionRulerConfig {
  mode: InjectionRulerMode;
  keepRatio: number;
  minPerLayer: number;
  /** 显式地板（配置优先于标定产物）；null = 用标定产物。 */
  floor: number | null;
  /**
   * v2：名次折扣系数 λ（缺省 0 = 纯余弦现状）。rankScore = cos − λ·log10(1 + chars/100)，
   * floor/margin 仍判原始 cos。实测（golden 37 行 10 轮）λ=0.06 把 hi 召回从 0.75 抬到 0.90。
   */
  lengthLambda?: number;
  /** v2：层内相对 margin（原始 cos 刻度）；null/缺省 = 不裁。 */
  margin?: number | null;
  /** v2：近重复抑制阈值（余弦）；null/缺省 = 不裁。生产实测重复对 0.938。 */
  dedupeSim?: number | null;
  /** v2：单行渲染上限（码点）；null/缺省 = 不截断。 */
  maxLineChars?: number | null;
}

export interface InjectionSelectionInput {
  /** 本轮准备注入的行（注入序，已是今天口径的排序结果）。 */
  lines: readonly string[];
  /** 原始用户查询（意图判定与相似度打分都用它）。 */
  query: string;
  ruler: InjectionRulerConfig;
  foldIdentical: boolean;
  budgetByIntent: InjectionBudgetByIntent;
  /** 上一回合注入行指纹（调用方台账；缺省 = 不折叠）。 */
  previousHash?: string;
  /** 标定产物（`${model}@${dims}` → p95 地板）。 */
  calibration?: ReadonlyMap<string, number>;
  model?: string;
  dimensions?: number;
  embedBatch?: (texts: string[]) => Promise<Float32Array[]>;
  /**
   * 单轮选线预算（毫秒）。默认 SELECTION_BUDGET_MS=300（验收门 e：增量 p95≤300ms）；
   * 到点即放弃本轮选线并整段 bypass（不等待、不部分应用）。规格 §4.2 的 800ms 是
   * 语义超时上限，验收门 e 更严，取严者。测试需注入更短预算时显式给。
   */
  budgetMs?: number;
  now?: () => number;
  /** 预判意图（缺省按 query 判；测试/调用方可显式给）。 */
  intent?: InjectionIntent;
  /** v2：单行渲染上限（码点）；优先级 输入 > ruler.maxLineChars > 不截断。 */
  maxLineChars?: number | null;
  /**
   * v3：本轮注入总字符预算（行渲染长度之和）；null/缺省 = 不限。
   * 成本上限（上下文开销），与 budgetByIntent 的行数配额叠加：先按名次装填，装不下的记 chars。
   */
  maxChars?: number | null;
}

export interface InjectionCandidateLine {
  layer: string;
  hash8: string;
  scoreQ?: number;
  bm25Rel?: number;
  kept: boolean;
  droppedBy?: LayerRulerDropReason;
}

export interface InjectionStageOutcome {
  /** 本轮实际注入行（折叠/裁剪后）。 */
  lines: string[];
  /** 本回合注入行指纹（下一回合折叠判等用；折叠发生后仍等于上一回合指纹）。 */
  foldHash: string;
  fold: { identicalLines: number };
  selection: {
    /** 判定保留数（mode=shadow 时是「如果 enforce 会保留几条」）。 */
    kept: number;
    /** 实际注入行数（shadow 下 = kept + ruler 判定丢弃数）。 */
    injected: number;
    droppedBy: {
      rank: number;
      floor: number;
      margin: number;
      dup: number;
      budget: number;
      chars: number;
      fold: number;
    };
    /** v2：本轮被行长上限截断的行数（截断不改判定，只改渲染）。 */
    capped: number;
    /**
     * #179 v3：候选池字符数（选前，= 输入行长度之和）。
     * 与 injectedChars 一起构成 journal 自证口径：不读 memoryLines 也能复盘压缩率。
     */
    poolChars: number;
    /** #179 v3：**实际注入**字符数（选后 + 折叠后；折叠为 0 行时恒 0）。 */
    injectedChars: number;
  };
  ruler: {
    mode: InjectionRulerMode;
    floorSource: "config" | "calibration" | "uncalibrated";
    floor: number | null;
    keepRatio?: number;
    minPerLayer?: number;
    /** v2 生效参数（缺省 0/null = 未启用）。 */
    lengthLambda?: number;
    margin?: number | null;
    dedupeSim?: number | null;
    maxLineChars?: number | null;
    /** v3：本轮字符预算（缺省 null = 未启用）。 */
    maxChars?: number | null;
    /**
     * 降级原因：
     * - "ruler-unavailable"：语义通道不可用（抛错/空向量/维度不符/长度不符）；
     * - "ruler-budget"：本轮选线耗时超预算（SELECTION_BUDGET_MS），到点放弃。
     * 两种都必须让注入与 mode=off 逐位一致（绝不退化全量、也绝不砍光）。
     */
    bypass?: "ruler-unavailable" | "ruler-budget";
    /**
     * v3：降级时的成本兜底。语义通道不可用（超时/报错）时，若配了字符预算，
     * 仍按**原序**贪心装填到预算为止，而不是退回全量注入（v3 前 bypass=全量，
     * 305ms 那轮实测把 8 行全注入）。未配预算时不出现本字段（=逐位现状）。
     */
    fallback?: "char-budget";
    ms?: number;
  };
  candidates: {
    total: number;
    byLayer: Record<string, number>;
    /** 注入层没有 BM25 相对分（结论层的 bm25Rel 在 L2 内部），恒 0 但保留字段。 */
    bm25Exempt: number;
    lines: InjectionCandidateLine[];
    truncated?: true;
  };
}

const CANDIDATE_LINE_CAP = 40;

/** v2：单行渲染上限的句界字符（不切半个字；找不到句界就硬切并加省略号）。 */
const SENTENCE_ENDS = new Set(["。", "！", "？", "；", "\n", ".", "!", "?", ";"]);

/**
 * 行渲染上限：只在超出时动手；优先在句界收口（保留句号），否则在 limit−1 硬切并补 "…"。
 * 纯函数、无 IO：调用方给上限，本函数不猜「合理长度」。
 */
export function capMemoryLine(text: string, max: number | null | undefined): { text: string; capped: boolean } {
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0 || text.length <= max) {
    return { text, capped: false };
  }
  const limit = Math.floor(max);
  const floor = Math.max(0, Math.floor(limit * 0.4));
  for (let i = Math.min(limit, text.length) - 1; i >= floor; i--) {
    if (SENTENCE_ENDS.has(text[i])) return { text: text.slice(0, i + 1) + "…", capped: true };
  }
  return { text: text.slice(0, Math.max(1, limit - 1)) + "…", capped: true };
}

/**
 * 单轮选线增量预算（验收门 e）。到点即 bypass：本轮注入退回 mode=off 的字面行为。
 * 实测（2026-11-02，20 轮重放，doubao-embedding-vision@2048）：p50 271ms / p95 344ms /
 * max 683ms ⇒ 300ms 会拦下约 5% 的慢轮，那些轮保持今天行为。
 */
export const SELECTION_BUDGET_MS = 300;

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
        // 不让计时器吊住进程退出
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 应用注入选线。纯决策 + 注入式 embedding（不给 embedBatch 即等价 mode=off）。
 * 不写盘、不记日志——journal 字段由调用方从返回值拼装。
 */
export async function applyInjectionSelection(input: InjectionSelectionInput): Promise<InjectionStageOutcome> {
  const now = input.now ?? (() => Date.now());
  const t0 = now();
  const lines = input.lines;
  const total = lines.length;
  const layers = lines.map(layerOfMemoryLine);
  const dropOf = new Map<number, LayerRulerDropReason>();
  const intent = input.intent ?? classifyInjectionIntent(input.query);
  const budget = total === 0 ? null : injectionBudgetOf(intent, input.budgetByIntent);

  const counts = { rank: 0, floor: 0, margin: 0, dup: 0, budget: 0, chars: 0, fold: 0 };

  // ① 意图预算：按注入序保留前 N 行（此时还没有分数，不引入新排序）
  const budgetAlive: number[] = [];
  for (let i = 0; i < total; i++) {
    if (budget !== null && i >= budget) {
      dropOf.set(i, "budget");
      counts.budget++;
    } else {
      budgetAlive.push(i);
    }
  }

  // ② 名次尺 + 地板（shadow 只判定不裁剪）
  const ruler: InjectionStageOutcome["ruler"] = {
    mode: input.ruler.mode,
    floorSource: "uncalibrated",
    floor: null,
  };
  let judgeKept: Set<number> | null = null;
  const scoreQ = new Map<number, number>();
  if (input.ruler.mode !== "off" && budgetAlive.length > 0) {
    const floorRes = resolveEmbeddingSimFloor({
      configured: input.ruler.floor,
      calibration: input.calibration,
      model: input.model,
      dims: input.dimensions,
    });
    ruler.floor = floorRes.value;
    ruler.floorSource = floorRes.source;
    ruler.keepRatio = input.ruler.keepRatio;
    ruler.minPerLayer = input.ruler.minPerLayer;
    ruler.lengthLambda = input.ruler.lengthLambda ?? 0;
    ruler.margin = input.ruler.margin ?? null;
    ruler.dedupeSim = input.ruler.dedupeSim ?? null;
    ruler.maxLineChars = input.maxLineChars ?? input.ruler.maxLineChars ?? null;
    ruler.maxChars =
      typeof input.maxChars === "number" && Number.isFinite(input.maxChars) && input.maxChars >= 0
        ? Math.floor(input.maxChars)
        : null;

    const texts = [input.query, ...budgetAlive.map((i) => lines[i])];
    let scores: number[] | null = null;
    const lineVecs: Float32Array[] = [];
    if (!input.embedBatch) {
      ruler.bypass = "ruler-unavailable";
    } else {
      try {
        const settle = input.embedBatch(texts);
        const raced = await withTimeout(settle, input.budgetMs ?? SELECTION_BUDGET_MS);
        if (raced === "timeout") {
          ruler.bypass = "ruler-budget";
        } else if (!Array.isArray(raced) || raced.length !== texts.length) {
          ruler.bypass = "ruler-unavailable";
        } else {
          const q = raced[0];
          const per: number[] = [];
          let bad = !q || q.length === 0;
          for (let k = 1; k < raced.length && !bad; k++) {
            const v = raced[k];
            if (!v || v.length === 0 || (input.dimensions !== undefined && v.length !== input.dimensions)) {
              bad = true;
              break;
            }
            const sim = cosine(q, v);
            if (sim === null) {
              bad = true;
              break;
            }
            per.push(sim);
            lineVecs.push(v);
          }
          if (bad) ruler.bypass = "ruler-unavailable";
          else scores = per;
        }
      } catch {
        ruler.bypass = "ruler-unavailable";
      }
    }

    if (scores && !ruler.bypass) {
      const lambda =
        typeof input.ruler.lengthLambda === "number" &&
        Number.isFinite(input.ruler.lengthLambda) &&
        input.ruler.lengthLambda > 0
          ? input.ruler.lengthLambda
          : 0;
      budgetAlive.forEach((idx, pos) => scoreQ.set(idx, scores[pos]));
      const dedupeSim =
        typeof input.ruler.dedupeSim === "number" &&
        Number.isFinite(input.ruler.dedupeSim) &&
        input.ruler.dedupeSim > 0 &&
        input.ruler.dedupeSim <= 1
          ? input.ruler.dedupeSim
          : null;
      const decision = layerRulerSelect({
        candidates: budgetAlive.map((idx, pos) => {
          const len = lines[idx].length;
          return {
            text: lines[idx],
            layer: layers[idx],
            score: scores[pos],
            // v2：排序分 = cos − λ·lengthFactor（对排序单调、对 floor 无影响）
            rankScore: lambda > 0 ? scores[pos] - lambda * Math.log10(1 + len / 100) : scores[pos],
            order: pos,
          };
        }),
        keepRatio: input.ruler.keepRatio,
        minPerLayer: input.ruler.minPerLayer,
        floor: resolveEmbeddingSimFloor({
          configured: input.ruler.floor,
          calibration: input.calibration,
          model: input.model,
          dims: input.dimensions,
        }).value,
        margin: input.ruler.margin ?? null,
        dedupe:
          dedupeSim === null
            ? null
            : { similarity: (i, j) => cosine(lineVecs[i], lineVecs[j]) ?? 0, threshold: dedupeSim },
        budget: null,
        charBudget: ruler.maxChars ?? null,
      });
      judgeKept = new Set<number>();
      for (const d of decision.decisions) {
        const idx = budgetAlive[d.index];
        if (d.kept) {
          judgeKept.add(idx);
        } else {
          const reason: LayerRulerDropReason = d.reason ?? "rank";
          dropOf.set(idx, reason);
          counts[reason]++;
        }
      }
    }
    // bypass 的成本兜底：拿不到分数也要守住字符预算（原序装填，不引入新排序）。
    if (ruler.bypass && ruler.maxChars !== null) {
      const cap = ruler.maxChars;
      const keptByChars = new Set<number>();
      let used = 0;
      for (const idx of budgetAlive) {
        const len = lines[idx].length;
        if (used + len <= cap) {
          keptByChars.add(idx);
          used += len;
        }
      }
      // 无论装下几行（含 0 行）都必须接管：若这里在 size=0 时跳过，judgeKept 仍为 null
      // → enforce=false → 退回全量注入，预算被静默绕过（比判空更坏：声称守预算却全量注）。
      ruler.fallback = "char-budget";
      judgeKept = keptByChars;
      for (const idx of budgetAlive) {
        if (!keptByChars.has(idx)) {
          dropOf.set(idx, "chars");
          counts.chars++;
        }
      }
    }
    ruler.ms = Math.max(0, Math.round(now() - t0));
  }

  // ③ 同回合折叠：只对「会真正注入的行」判等（enforce 用判定集，shadow/off 用预算后全集）
  // bypass 时判定集缺省为 null：注入必须与 mode=off 逐位一致（绝不因降级把行砍光）
  const enforce = input.ruler.mode === "enforce" && judgeKept !== null;
  const preFold: number[] = enforce ? budgetAlive.filter((idx) => judgeKept!.has(idx)) : [...budgetAlive];
  const foldHashCandidate = hashLines(preFold.map((i) => lines[i]));
  let foldedIdx: number[] = [];
  if (input.foldIdentical && input.previousHash && preFold.length > 0 && input.previousHash === foldHashCandidate) {
    foldedIdx = preFold;
    for (const idx of foldedIdx) {
      dropOf.set(idx, "fold");
      counts.fold++;
    }
  }
  const folded = new Set(foldedIdx);

  const outputIdx = preFold.filter((idx) => !folded.has(idx));
  // ⑤ 渲染上限（v2）：只改渲染、不改判定；截断计数进观测面（capped）。
  const maxLineChars = input.maxLineChars ?? input.ruler.maxLineChars ?? null;
  let cappedCount = 0;
  const injected = outputIdx.map((i) => {
    const capped = capMemoryLine(lines[i], maxLineChars);
    if (capped.capped) cappedCount++;
    return capped.text;
  });

  // ④ 观测面（mode=off 也记录；droppedBy 全 0 表示尺子没淘汰任何行）
  const byLayer: Record<string, number> = {};
  for (const l of layers) byLayer[l] = (byLayer[l] ?? 0) + 1;
  const candLines: InjectionCandidateLine[] = [];
  for (let i = 0; i < total && candLines.length < CANDIDATE_LINE_CAP; i++) {
    const entry: InjectionCandidateLine = { layer: layers[i], hash8: hash8(lines[i]), kept: !dropOf.has(i) };
    const s = scoreQ.get(i);
    if (typeof s === "number" && Number.isFinite(s)) entry.scoreQ = round3(s);
    const why = dropOf.get(i);
    if (why) entry.droppedBy = why;
    candLines.push(entry);
  }
  const candidates: InjectionStageOutcome["candidates"] = {
    total,
    byLayer,
    bm25Exempt: 0,
    lines: candLines,
  };
  if (total > CANDIDATE_LINE_CAP) candidates.truncated = true;

  return {
    lines: injected,
    foldHash: foldHashCandidate,
    fold: { identicalLines: countedFold(counts.fold) },
    selection: {
      kept:
        total - counts.rank - counts.floor - counts.margin - counts.dup - counts.budget - counts.chars - counts.fold,
      injected: injected.length,
      droppedBy: counts,
      capped: cappedCount,
      poolChars: lines.reduce((n, s) => n + s.length, 0),
      injectedChars: injected.reduce((n, s) => n + s.length, 0),
    },
    ruler,
    candidates,
  };
}

function countedFold(n: number): number {
  return n;
}
