/**
 * #179 · 召回选线尺子（层内相对尺子）——单一源纯函数。
 *
 * 背景（ADR-0013 实锤）：provider 相似度的**绝对**刻度不可跨题/跨模型校准——同一 floor 在
 * 宽题上什么都滤不掉、在窄题上腰斩（rerank logit 侧 floor −7 误滤池内 gold 15.8%、−4 达 18.8%）。
 * 本模块因此只认两类判据：
 *  - **名次**（层内相对）：每层按分数降序取前 ceil(n × keepRatio) 条，下限 minPerLayer 条；
 *    名次判据对任何单调变换免疫（s / s³ / sigmoid 结果逐位一致）。
 *  - **地板**（绝对，只由标定产物供给）：score < floor 一律丢；floor 缺失 = 诚实 no-op。
 * 层与层**不竞争**名次（各层各持配额）：浅池层不会被深池层挤空——这正是旧「全局 half-limit」
 * 让结论层 0 行（#99 F1）的地方。跨层唯一相遇点是预算 budget（意图档位的总行数上限）。
 *
 * 纪律：零 IO / 零时钟 / 零随机 / 不含任何绝对阈值常数（地板数值与比例全部由调用方传入），
 * 因此可被离线标定脚本与生产路径共用一份实现（口径不漂移，ADR-0012）。
 *
 * v2（2026-11-02 判别力实测后）：在名次/地板之外补三件「与内容相干、与刻度无关」的事——
 *  - **相对 margin**：层内以本层最高分（原始 score）为基准，低于 best − Δ 的丢（不跨层比，
 *    因此宽题/窄题各按自己的分布切；绝对 floor 仍可叠加，floor 优先记因）；
 *  - **近重复抑制 dedupe**：按名次贪心，与「已留下者」相似度 ≥ 阈值即丢（reason=dup），
 *    传递性按已留集判（A≈B、B≈C、A≉C ⇒ 留 A、C）；
 *  - **rankScore 与 score 分离**：名次按 rankScore（调用方可给 cos − λ·len 折扣），
 *    floor/margin 仍按原始 score 判——刻度语义不被排序偏好污染。
 *
 * 归因优先级：fold → floor → margin → dup → rank → budget（先命中者记，一个候选只记一个原因）。
 */

/** 丢行原因（journal 的 selection.droppedBy 词汇）。 */
export type LayerRulerDropReason = "rank" | "floor" | "margin" | "dup" | "budget" | "chars" | "fold";

/** 候选行（本模块只比大小，不解析文本内容）。 */
export interface LayerRulerCandidate {
  /** 行原文（逐字节折叠与 journal hash 的原件）。 */
  text: string;
  /** 层标识（结论层 / 工作事实层 / 经验层 / 人格层…）：同层比名次，跨层不比。 */
  layer: string;
  /** 相似度（题内可比；本模块不做绝对判断）。floor/margin 判它。 */
  score: number;
  /** 排序分（缺省 = score）。只影响名次与预算，不影响 floor/margin 的刻度语义。 */
  rankScore?: number;
  /** 稳定 tiebreak（缺省 = 输入下标；越大越靠后）。 */
  order?: number;
}

/** 逐条判定（与输入等长、同序）。 */
export interface LayerRulerDecision {
  index: number;
  text: string;
  layer: string;
  score: number;
  kept: boolean;
  reason: LayerRulerDropReason | null;
}

export interface LayerRulerInput {
  candidates: readonly LayerRulerCandidate[];
  /** 层内保留比例（0..1，调用方保证已归一）。 */
  keepRatio: number;
  /** 层内下限（≥1）：比例算出 0 也至少留 1 条。 */
  minPerLayer: number;
  /** 绝对地板（标定产物值）；null / 未给 = 不裁。 */
  floor?: number | null;
  /**
   * 层内相对 margin（≥0）：score < 本层最高分 − margin 的丢。null / 未给 = 不裁。
   * 与 floor 互补：floor 管「跨题绝对无关」，margin 管「同题内明显更差」。
   */
  margin?: number | null;
  /**
   * 近重复抑制：similarity(i, j) 为候选两行相似度（调用方按向量算，缺省不启用）。
   * 只在 survivors 之间比较，按名次贪心，与已留者比。null / 未给 = 不裁。
   */
  dedupe?: { similarity: (i: number, j: number) => number; threshold: number } | null;
  /** 跨层总行数预算（意图档位）；null / 未给 = 不限。 */
  budget?: number | null;
  /**
   * 跨层总字符预算（v3，成本上限）：按名次贪心「装得下就装、装不下跳过」，装不下的记 reason=chars。
   * 单位是行渲染长度（text.length），不截断行本身（截断是渲染层的事）。null / 未给 = 不限。
   * 与 budget 的区别：budget 是行数（公平/配额语义），charBudget 是成本（上下文开销语义）；
   * 两者可叠加，先名次配额 → 字符预算 → 行数预算。
   */
  charBudget?: number | null;
  /** 折叠谓词（true = 该候选在本轮已注入过）；纯函数由调用方注入，本模块不碰会话状态。 */
  isFolded?: (candidate: LayerRulerCandidate, index: number) => boolean;
}

export interface LayerRulerOutcome {
  /** 保留下标（升序 = 输入序；本模块绝不重排）。 */
  kept: number[];
  /** 与输入等长的逐条判定。 */
  decisions: LayerRulerDecision[];
}

/** 排序分（rankScore 缺省回落 score；非有限值一律当 score 用）。 */
function rankScoreOf(c: LayerRulerCandidate): number {
  const v = c.rankScore;
  return typeof v === "number" && Number.isFinite(v) ? v : c.score;
}

/** 名次降序 → order 升序 → 下标升序（稳定且确定）。 */
function compareRank(a: number, b: number, candidates: readonly LayerRulerCandidate[]): number {
  const sa = rankScoreOf(candidates[a]);
  const sb = rankScoreOf(candidates[b]);
  if (sa !== sb) return sb > sa ? 1 : -1;
  const oa = candidates[a].order ?? a;
  const ob = candidates[b].order ?? b;
  if (oa !== ob) return oa - ob;
  return a - b;
}

/** 裁预算时的「先裁谁」：排序分最低 → order 最大 → 下标最大。 */
function compareBudgetDrop(a: number, b: number, candidates: readonly LayerRulerCandidate[]): number {
  const sa = rankScoreOf(candidates[a]);
  const sb = rankScoreOf(candidates[b]);
  if (sa !== sb) return sa < sb ? -1 : 1;
  const oa = candidates[a].order ?? a;
  const ob = candidates[b].order ?? b;
  if (oa !== ob) return ob - oa;
  return b - a;
}

/**
 * 层内相对选线（确定性纯函数）。
 *
 * 步骤：① fold ② floor ③ 层内相对 margin ④ 近重复 dedupe ⑤ 层内名次（每层独立配额）
 * ⑥ 字符预算 charBudget（按名次装填，装不下跳过）⑦ 跨层行数 budget。
 * 任一层全被 fold/floor 清空时该层输出 0 行——**不补位**（宁缺毋滥，见规格 §4.5）。
 */
export function layerRulerSelect(input: LayerRulerInput): LayerRulerOutcome {
  const candidates = input.candidates;
  if (candidates.length === 0) return { kept: [], decisions: [] };

  const keepRatio = Number.isFinite(input.keepRatio) ? Math.min(1, Math.max(0, input.keepRatio)) : 1;
  const minPerLayer = Number.isFinite(input.minPerLayer) ? Math.max(1, Math.floor(input.minPerLayer)) : 1;
  const floor = typeof input.floor === "number" && Number.isFinite(input.floor) ? input.floor : null;
  const margin =
    typeof input.margin === "number" && Number.isFinite(input.margin) && input.margin >= 0 ? input.margin : null;
  const dedupe =
    input.dedupe &&
    typeof input.dedupe.threshold === "number" &&
    Number.isFinite(input.dedupe.threshold) &&
    typeof input.dedupe.similarity === "function"
      ? input.dedupe
      : null;
  const budget =
    typeof input.budget === "number" && Number.isFinite(input.budget) ? Math.max(0, Math.floor(input.budget)) : null;
  const charBudget =
    typeof input.charBudget === "number" && Number.isFinite(input.charBudget)
      ? Math.max(0, Math.floor(input.charBudget))
      : null;

  const reason: Array<LayerRulerDropReason | null> = candidates.map(() => null);
  const survivorsByLayer = new Map<string, number[]>();

  // ① fold ② floor：绝对地板（标定产物）先判，记因优先。
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (input.isFolded?.(c, i) === true) {
      reason[i] = "fold";
      continue;
    }
    if (floor !== null && !(c.score >= floor)) {
      reason[i] = "floor";
      continue;
    }
    const list = survivorsByLayer.get(c.layer);
    if (list) list.push(i);
    else survivorsByLayer.set(c.layer, [i]);
  }

  // ③ 层内相对 margin：以本层最高分为基准（不跨层），低于 best − Δ 的丢。
  if (margin !== null) {
    for (const [layer, idxs] of [...survivorsByLayer.entries()]) {
      let best = -Infinity;
      for (const i of idxs) if (candidates[i].score > best) best = candidates[i].score;
      if (!Number.isFinite(best)) continue;
      const keep: number[] = [];
      for (const i of idxs) {
        if (candidates[i].score >= best - margin) keep.push(i);
        else reason[i] = "margin";
      }
      if (keep.length > 0) survivorsByLayer.set(layer, keep);
      else survivorsByLayer.delete(layer);
    }
  }

  // ④ 近重复抑制：全局按名次贪心，只与「已留下者」比（传递性按已留集判）。
  if (dedupe !== null) {
    const all: number[] = [];
    for (const idxs of survivorsByLayer.values()) all.push(...idxs);
    all.sort((a, b) => compareRank(a, b, candidates));
    const keptSoFar: number[] = [];
    const dup = new Set<number>();
    for (const i of all) {
      let isDup = false;
      for (const j of keptSoFar) {
        const sim = dedupe.similarity(i, j);
        if (Number.isFinite(sim) && sim >= dedupe.threshold) {
          isDup = true;
          break;
        }
      }
      if (isDup) {
        reason[i] = "dup";
        dup.add(i);
      } else {
        keptSoFar.push(i);
      }
    }
    if (dup.size > 0) {
      for (const [layer, idxs] of [...survivorsByLayer.entries()]) {
        const keep = idxs.filter((i) => !dup.has(i));
        if (keep.length > 0) survivorsByLayer.set(layer, keep);
        else survivorsByLayer.delete(layer);
      }
    }
  }

  // ⑤ 层内名次：每层独立配额 ceil(n × keepRatio)，下限 minPerLayer。
  const keptSet = new Set<number>();
  for (const idxs of survivorsByLayer.values()) {
    const n = idxs.length;
    const quota = Math.min(n, Math.max(minPerLayer, Math.ceil(n * keepRatio)));
    const ranked = [...idxs].sort((a, b) => compareRank(a, b, candidates));
    for (let r = 0; r < ranked.length; r++) {
      if (r < quota) keptSet.add(ranked[r]);
      else reason[ranked[r]] = "rank";
    }
  }

  // ⑥ 字符预算：按名次贪心装填（装得下就装、装不下跳过），装不下的记 chars。
  if (charBudget !== null && charBudget >= 0) {
    const ranked = [...keptSet].sort((a, b) => compareRank(a, b, candidates));
    keptSet.clear();
    let used = 0;
    for (const i of ranked) {
      const len = candidates[i].text.length;
      if (used + len <= charBudget) {
        keptSet.add(i);
        used += len;
      } else {
        reason[i] = "chars";
      }
    }
  }

  if (budget !== null && keptSet.size > budget) {
    const drops = [...keptSet].sort((a, b) => compareBudgetDrop(a, b, candidates)).slice(0, keptSet.size - budget);
    for (const i of drops) {
      keptSet.delete(i);
      reason[i] = "budget";
    }
  }

  const kept = [...keptSet].sort((a, b) => a - b);
  const decisions: LayerRulerDecision[] = candidates.map((c, i) => ({
    index: i,
    text: c.text,
    layer: c.layer,
    score: c.score,
    kept: keptSet.has(i),
    reason: keptSet.has(i) ? null : reason[i],
  }));
  return { kept, decisions };
}
