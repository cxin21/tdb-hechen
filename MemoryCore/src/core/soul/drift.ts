/**
 * 人格漂移检测（双轨）。
 *
 * 为什么双轨：语体漂移（说话变味）与判断漂移（取舍变了）不是一回事。
 * 前者可以靠一次锚定复位，后者复位不了——所以判断轨的阈值更严、且冻结后必须人工/离线复核。
 *
 * 有 embedding 用 cosine；没有则退化为字符 bigram Jaccard（确定性、离线可用）。
 * 两者都拿「当前人格文本」与「行为锚（最近真实产出/用户确认过的取舍）」比，
 * 而不是拿人格与自己比——自己比自己恒等于 1，是最常见的假绿。
 */
import { cosine, textSimilarity } from "./gates.js";
import type { SoulLayer, SoulMaintenanceConfig } from "./types.js";

export type DriftTrack = "voice" | "judgment";
export type DriftVerdictKind = "ok" | "degrade" | "freeze";

export interface DriftVerdict {
  track: DriftTrack;
  score: number;
  verdict: DriftVerdictKind;
  /** 连续低于降级阈值的样本数（含本次）。 */
  consecutive: number;
  method: "embedding" | "lexical";
  detail: string;
}

export interface DriftInput {
  layer: SoulLayer;
  /** 行为锚：最近真实产出、用户确认过的取舍、红线触发记录。 */
  anchors: string[];
  /** 当前人格文本（层内条目拼接）。 */
  text: string;
  /** 可选向量器；缺席则走词面回退。 */
  embed?: (text: string) => Promise<number[]>;
  /** 历史分数（旧→新）。 */
  history?: number[];
  config: Pick<SoulMaintenanceConfig, "driftDegrade" | "driftFreeze" | "driftConsecutive" | "driftHistorySize">;
}

export function trackOf(layer: SoulLayer): DriftTrack {
  return layer === "values" || layer === "boundary" || layer === "narrative" ? "judgment" : "voice";
}

export async function measureDrift(input: DriftInput): Promise<DriftVerdict> {
  const track = trackOf(input.layer);
  const cfg = input.config;
  const anchors = input.anchors.map((s) => s.trim()).filter((s) => s.length > 0);
  let method: "embedding" | "lexical" = "lexical";
  let score = 0;
  if (anchors.length === 0) {
    return {
      track,
      score: 0,
      verdict: "ok",
      consecutive: 0,
      method,
      detail: "无行为锚，无法判定漂移（不伪造分数）",
    };
  }
  if (input.embed && input.text.trim().length > 0) {
    try {
      const cur = await input.embed(input.text);
      let best = -1;
      for (const a of anchors) {
        const vec = await input.embed(a);
        best = Math.max(best, cosine(cur, vec));
      }
      score = best;
      method = "embedding";
    } catch {
      method = "lexical";
      score = lexicalDrift(anchors, input.text);
    }
  } else {
    score = lexicalDrift(anchors, input.text);
  }
  const history = [...(input.history ?? []), score];
  const consecutive = trailingBelow(history, cfg.driftDegrade);
  let verdict: DriftVerdictKind = "ok";
  if (consecutive >= cfg.driftConsecutive) {
    if (score < cfg.driftFreeze) verdict = "freeze";
    else if (score < cfg.driftDegrade) verdict = "degrade";
  }
  return {
    track,
    score,
    verdict,
    consecutive,
    method,
    detail: `${method} score=${score.toFixed(3)}，连续低于 ${cfg.driftDegrade} 共 ${consecutive} 次（阈值 ${cfg.driftConsecutive}）`,
  };
}

export function lexicalDrift(anchors: string[], text: string): number {
  let best = 0;
  for (const a of anchors) best = Math.max(best, textSimilarity(a, text));
  return best;
}

export function trailingBelow(history: number[], threshold: number): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i] < threshold) n += 1;
    else break;
  }
  return n;
}

export function pushDrift(history: number[] | undefined, score: number, size: number): number[] {
  const next = [...(history ?? []), Number(score.toFixed(4))];
  return next.slice(-Math.max(1, size));
}

/**
 * 一次锚定复位：只在语体轨允许自动执行；判断轨返回 false，
 * 必须走「降级→观察→离线复核」，不允许自我复位。
 */
export function canSelfReset(track: DriftTrack): boolean {
  return track === "voice";
}
