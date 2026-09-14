/**
 * K/L 感受注入：核心价值锚 + 当前感受（appraisal）。
 * 纯逻辑、配置化（memory.appraisal）、宁缺毋滥：仅当下语境命中某价值标签才输出短块，不宣称主观情绪。
 */
export interface AppraisalValue {
  id: string;
  label: string;
  weight: number;
  /**
   * C2（spec §3.1/§3.3）动机方向：+1=趋近推进、-1=审慎回避、0=中性。
   * null / undefined（未判定，含 config.yaml fallback 值）→ 不输出方向行（宁缺毋滥 + D1 兜底）。
   */
  valence?: number | null;
}

export interface AppraisalConfig {
  enabled: boolean;
  values: AppraisalValue[];
  /** 命中至少一个价值权重达到该阈值才输出 */
  firedThreshold: number;
}

export const DEFAULT_APPRAISAL_CONFIG: AppraisalConfig = {
  enabled: true,
  values: [],
  firedThreshold: 0.4,
};

/** 返回 "<current_feeling>...</current_feeling>" 块；未命中返回 ""（不注入噪音）。 */
export function renderCurrentFeeling(query: string, cfg: AppraisalConfig): string {
  if (!cfg.enabled || !query || cfg.values.length === 0) return "";
  const q = query.toLowerCase();
  const fired = cfg.values.filter((v) => v.label && q.includes(v.label.toLowerCase()) && v.weight >= cfg.firedThreshold);
  if (fired.length === 0) return "";
  const tags = fired.map((v) => `${v.label}(${v.id})`).join(", ");
  // C2（spec §3.3）动机方向行：仅 fired 且 valence 非 NULL 非 0 才出（宁缺毋滥，现状保留）。
  // 措辞陈述性（判定的语义倾向，不是情绪）；混合（同轮命中正负）两行并列——不合成、不假装权衡过。
  const pos = fired.filter((v) => v.valence != null && v.valence > 0).map((v) => v.label);
  const neg = fired.filter((v) => v.valence != null && v.valence < 0).map((v) => v.label);
  const directionLines: string[] = [];
  if (pos.length > 0) directionLines.push(`本轮方向：围绕【${pos.join("、")}】推进`);
  if (neg.length > 0) directionLines.push(`本轮方向：对【${neg.join("、")}】保持审慎`);
  const direction = directionLines.length > 0 ? directionLines.join("\n") + "\n" : "";
  return `<current_feeling>\n当前问题触及的核心价值：${tags}。\n${direction}（功能性的"在意程度"信号：仅提示哪些事在团队/用户价值里重要，不代表主观情绪。）\n</current_feeling>`;
}
