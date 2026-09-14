/**
 * M persona 演进（自我模型）。
 * 增量式：旧 persona + 近期持续态 → 新 persona；一致性/防漂移（连续高显著才让核心画像变）。
 * 纯逻辑、可测、配置化。守红线：默认只并入 observed(有显著性支撑)的结论。
 */
export interface PersonaEvolutionConfig {
  /** 并入一个持续态所需的最低 significance（防漂移） */
  significanceBar: number;
  /** 一条持续态被 N 次独立观察到才让"核心画像"变（防一两次反常重写） */
  minObserved: number;
}

export const DEFAULT_PERSONA_CONFIG: PersonaEvolutionConfig = { significanceBar: 0.7, minObserved: 2 };

export interface DurativeInput {
  content: string;
  significance?: number;
  certainty?: string;
  observedCount?: number; // 该结论被独立观察的次数（由巩固侧累计）
}

export interface PersonaProposal {
  /** 提议并入的新画像内容 */
  proposed: string[];
  /** 因证据不足被拒的（保留旧 / 标待确认） */
  deferred: string[];
}

/**
 * 从近期持续态中，筛出"显著性到位 + observed + 观察次数达标"者作为新画像内容；
 * 其余 defer（防漂移 + 不冒充 observed）。
 */
export function evolveCandidate(
  duratives: DurativeInput[],
  oldPersona: string,
  cfg: PersonaEvolutionConfig = DEFAULT_PERSONA_CONFIG,
): PersonaProposal {
  const proposed: string[] = [];
  const deferred: string[] = [];
  for (const d of duratives) {
    if ((d.certainty ?? "observed") !== "observed") { deferred.push(d.content); continue; }
    if ((d.significance ?? 0) < cfg.significanceBar) { deferred.push(d.content); continue; }
    if ((d.observedCount ?? 0) < cfg.minObserved) { deferred.push(d.content); continue; }
    // 防重复：旧 persona 已包含则不重复并入
    if (oldPersona.includes(d.content.slice(0, 24))) { deferred.push(d.content); continue; }
    proposed.push(d.content);
  }
  return { proposed, deferred };
}

/** 增量合成下一个 persona（旧 + 提议，保持稳定/一致性）。 */
export function evolvePersona(oldPersona: string, proposal: PersonaProposal): string {
  const base = oldPersona.trim();
  const additions = proposal.proposed.filter((p) => !base.includes(p.slice(0, 24)));
  if (additions.length === 0) return base;
  return `${base}\n${additions.map((p) => `- ${p}`).join("\n")}`;
}