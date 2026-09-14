/**
 * K 核心价值锚 + L 当前感受（Appraisal）。
 * 纯逻辑、可测、配置化。价值锚是感受的参照系；当前感受 = 当下语境对价值锚的命中（功能性诚实，不宣称主观情绪）。
 */
export interface CoreValue {
  id: string;
  label: string;
  weight: number; // 0..1
}

export interface AppraisalConfig {
  enabled: boolean;
  /** 命中才输出的阈值（宁缺毋滥，无命中不强给情绪） */
  firedThreshold: number;
}

export const DEFAULT_APPRAISAL_CONFIG: AppraisalConfig = { enabled: true, firedThreshold: 0.4 };

/**
 * 由价值锚序列 + 上下文 text，线性判"这条语境触动哪些价值"。
 * match 用简单字符子串重叠（可换 embedding，当前保轻量）。
 */
export function appraise(
  context: string,
  values: CoreValue[],
  cfg: AppraisalConfig = DEFAULT_APPRAISAL_CONFIG,
): Array<{ value: CoreValue; weight: number; fired: boolean; arousal: number }> {
  if (!cfg.enabled || !context || values.length === 0) return [];
  const ctx = context.toLowerCase();
  const out: Array<{ value: CoreValue; weight: number; fired: boolean; arousal: number }> = [];
  for (const v of values) {
    const hit = v.label && ctx.includes(v.label.toLowerCase());
    const weight = hit ? v.weight : 0;
    out.push({ value: v, weight, fired: weight >= cfg.firedThreshold, arousal: hit ? weight : 0 });
  }
  return out;
}

/** 汇总：是否整体触发了至少一个价值（供注入看重程度）。 */
export function hasFired(appraisal: Array<{ fired: boolean }>): boolean {
  return appraisal.some((a) => a.fired);
}

/**
 * 审计修复 B1：把"当前感受/价值参照"真正接入遗忘打分（feeling §3「价值命中→显著性/遗忘加权」）。
 * 给定一条记忆的 content 与团队的 core_values 参照系，返回一个显著性 boost（0..maxBoost）：
 *   - 命中 1 个价值 label（weight ≥ firedThreshold）→ +0.1
 *   - 每多命中一个，再按命中价值平均权重递增
 *   - 无命中 → 0（零影响，宁缺毋滥）
 * 这样 MemoryCore 的 appraise()（原本的死代码）经 salienceBoost 复用到 I 遗忘打分，
 * 使 core_values 表成为"看重程度"的真实参照系（单一源），而非只存在于 config 与死代码。
 */
export function salienceBoost(
  content: string,
  values: CoreValue[],
  cfg: AppraisalConfig = DEFAULT_APPRAISAL_CONFIG,
  maxBoost = 0.2,
): number {
  if (!cfg.enabled || !content || values.length === 0) return 0;
  const fired = appraise(content, values, cfg).filter((a) => a.fired);
  if (fired.length === 0) return 0;
  const avgWeight = fired.reduce((s, a) => s + a.weight, 0) / fired.length;
  const firstHitBoost = 0.1;
  const extraPerHit = (maxBoost - firstHitBoost) * avgWeight;
  return Math.min(maxBoost, firstHitBoost + extraPerHit * (fired.length - 1) / Math.max(1, fired.length));
}

/** C1（spec §2.2 遗忘消费）：classifyWithValues 可消费的记忆形状。 */
export type SalienceMemoryLike = { content?: string; metadata?: unknown };

/**
 * C1（spec §2.2 遗忘层，B5 缓解）：salienceBoost 的 coreRefs 优先版。
 * 判定顺序：
 *   1. metadata.coreRefs 非空数组（写入侧 dedup LLM 标注的价值锚 label）→
 *      命中集 = coreRefs ∩ 当前价值锚中 weight ≥ firedThreshold 者（"fired"资格）——
 *      不再要求 content 含 label 子串：coreRefs 是写入时 LLM 对"明显触动"的裁决，
 *      是比子串更准的信号（B5：content 不含字面 label 的记忆也能被保护）；
 *   2. coreRefs 缺失/为空 → 子串匹配兜底（= salienceBoost，存量记忆行为逐位不变）；
 *   3. coreRefs 在场但无命中 → 0（宁缺毋滥，不造假 boost）。
 * boost 数值曲线与 salienceBoost 一致（首中 +0.1，多中按平均权重递增，封顶 maxBoost）。
 */
export function salienceBoostWithRefs(
  memory: SalienceMemoryLike,
  values: CoreValue[],
  cfg: AppraisalConfig = DEFAULT_APPRAISAL_CONFIG,
  maxBoost = 0.2,
): number {
  const content = memory.content ?? "";
  const meta = memory.metadata && typeof memory.metadata === "object"
    ? (memory.metadata as Record<string, unknown>)
    : undefined;
  const refsRaw = Array.isArray(meta?.coreRefs) ? (meta!.coreRefs as unknown[]) : undefined;
  const refs = refsRaw
    ? refsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : undefined;
  if (!cfg.enabled || values.length === 0) return 0;
  if (refs && refs.length > 0) {
    const hits = values.filter((v) => refs.includes(v.label) && v.weight >= cfg.firedThreshold);
    if (hits.length === 0) return 0;
    const weights = hits.map((v) => v.weight);
    const avgWeight = weights.reduce((s, w) => s + w, 0) / weights.length;
    const firstHitBoost = 0.1;
    const extraPerHit = (maxBoost - firstHitBoost) * avgWeight;
    return Math.min(maxBoost, firstHitBoost + extraPerHit * (hits.length - 1) / Math.max(1, hits.length));
  }
  // 子串匹配兜底（coreRefs 缺失——存量记忆全走这条，行为不变）
  return salienceBoost(content, values, cfg, maxBoost);
}