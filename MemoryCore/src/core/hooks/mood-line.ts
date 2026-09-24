/**
 * S-FEEL-1（M1）：近期情绪基调聚合——单一源纯函数。
 *
 * 设计依据：DS-SOUL-EVOLUTION-001 §1.2（公式逐字）/§7.1 六链/§8 红线 R-A + M1 实施计划 S2。
 *   - 加权聚合：w_i = 2^(-age_hours_i / halfLifeHours)；mood_valence = clamp(Σ(v·w)/Σw, -1, 1)
 *   - 三档映射：mood ≥ posThreshold → "positive"；≤ negThreshold → "strained"；否则 "neutral"
 *   - 确定性：同输入逐字节同输出（零 LLM、零随机；nowMs 注入参数，禁 Date.now() 内联）
 *   - 红线 R-A：本模块只做聚合与档位映射，不参与任何召回排序/加权（情绪不得喂自身回路——
 *     F14-bis 是身份版防线，R-A 是情绪版同构）。
 *   - 单一源：computeMoodValence 导出供任务 2（R10 情感显著度权重）复用或反向——禁第二份加权实现。
 *   - 样本契约：samples 须按 occurred_at DESC（store.recentAffectSignals 已保证）；maxSamples 在此截断。
 */
export interface MoodSample {
  valence: number;
  arousal: number | null;
  occurred_at: string;
}

export interface MoodConfig {
  minSamples: number;
  maxSamples: number;
  posThreshold: number;
  negThreshold: number;
  halfLifeHours: number;
  nowMs: number;
}

export type MoodTier = "positive" | "neutral" | "strained";
export interface MoodResult {
  tier: MoodTier | null;
  sampleCount: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 半衰期加权 valence 聚合（单一源，导出供 R10 复用——禁第二份实现）。
 * 防御：非有限 valence / 非法 occurred_at 样本跳过；未来时间戳按 0 龄处理（防超权重）；
 * 全非法 → null（调用侧降级：基调行静默省略）。
 */
export function computeMoodValence(samples: MoodSample[], cfg: Pick<MoodConfig, "halfLifeHours" | "nowMs">): number | null {
  const halfLife = Number(cfg.halfLifeHours) > 0 ? Number(cfg.halfLifeHours) : 48;
  let wSum = 0;
  let vSum = 0;
  for (const sm of samples) {
    if (typeof sm?.valence !== "number" || !Number.isFinite(sm.valence)) continue;
    const t = Date.parse(sm.occurred_at);
    if (!Number.isFinite(t)) continue;
    const ageHours = Math.max(0, (cfg.nowMs - t) / 3600e3);
    const w = Math.pow(2, -ageHours / halfLife);
    vSum += sm.valence * w;
    wSum += w;
  }
  if (wSum <= 0) return null;
  return clamp(vSum / wSum, -1, 1);
}

/**
 * 近期基调三档判定（M1 对外主入口）。
 * 样本数（过滤非法后）< minSamples 或聚合失败 → tier=null（基调行静默省略，宁缺毋滥）。
 */
export function computeMoodTier(samples: MoodSample[], cfg: MoodConfig): MoodResult {
  const maxSamples = Math.max(0, Math.floor(Number(cfg.maxSamples) || 0));
  const valid = samples.filter((sm) => typeof sm?.valence === "number" && Number.isFinite(sm.valence) && Number.isFinite(Date.parse(sm?.occurred_at ?? ""))).slice(0, maxSamples);
  const minSamples = Math.max(0, Math.floor(Number(cfg.minSamples) || 0));
  const mood = computeMoodValence(valid, cfg);
  if (valid.length < minSamples || mood === null) {
    return { tier: null, sampleCount: valid.length };
  }
  const tier: MoodTier = mood >= cfg.posThreshold ? "positive" : mood <= cfg.negThreshold ? "strained" : "neutral";
  return { tier, sampleCount: valid.length };
}
