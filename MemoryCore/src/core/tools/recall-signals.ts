/**
 * R-A1（结构感知召回 spec §2 R1/R2/R3/R8/R9）：门后排序层结构信号 —— 纯函数、可单测。
 *
 * 不变式（spec §3）：
 *   1. 绝对相关度门槛语义零变化 —— 本模块所有信号只作用于门后 rankKey，不参与检索打分；
 *   2. 确定性 —— 同 query 同数据同结果：时间窗解析/时近性判定一律以调用方传入的 now
 *      快照为准，无时钟依赖进入排序；
 *   3. 失效即关 —— 每个信号独立可配，0 = 该通道完全退出（逐通道 guard `boost > 0`）；
 *   4. 关断恒等 —— 全 0 时 rankKey 与基线逐位一致：加性分量 +0.0、乘性分量 ×1.0 在
 *      IEEE754 下恒等（沿用 applyCoreRefTiebreak fix1 的论证）；f53b173/fix1 教训：
 *      空信号不得跳过排序，排序恒执行。
 *
 * 数据形状实证（R-A1 报告前节）：
 *   - last_recalled_at / recall_count 存于 metadata_json（sqlite.ts:2650 `$.last_recalled_at`、
 *     bumpRecallCount 写入；C1 起召回 item 携带 metadata 读回）——从 metadata 读取；
 *   - occurred_at/valid_start/valid_end/certainty/valence/significance 为顶层 soul 字段
 *     （L1SearchResult/L1FtsResult 均透传，896ee5d 出参）；
 *   - R9 moodSign：core_values 行带 valence（三值枚举 -1/0/1，LLM derive）——当前轮
 *     appraisal fired 值的 valence 均值符号；fired 为空 / 全 null → 0 → 不加成。
 */
import { parseTimeWindow, type TimeWindow } from "./content-time-window.js";
import { appraise, DEFAULT_APPRAISAL_CONFIG, type CoreValue } from "../lifecycle/feeling/appraisal.js";

/** 排序信号消费的最小条目形状（MemorySearchResultItem / auto-recall soul 源均满足）。 */
export interface RankSignalItem {
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  valence?: number;
  significance?: number;
  metadata?: Record<string, unknown>;
  /** R-A2（R6）：场景路由检测源（buildRankContext items 合同）。 */
  scene_name?: string | null;
}

/**
 * R-A1 六开关（spec §2 默认值；0 = 该通道完全退出）。
 * config 解析见 src/config.ts recall 组（沿 C1 coreRefBoost 的 clamp 负值模式）。
 */
export interface RankSignals {
  /** R1：时间窗命中加成（默认 0.05） */
  timeBoost: number;
  /** R1：时近性加成——last_recalled_at 距今 < 24h（默认 0.03） */
  recencyBoost: number;
  /** R2：significance 加成权重（默认 0.03） */
  sigWeight: number;
  /** R3：inferred 记忆 rankKey 乘法降权（默认 0.1，乘 (1 - penalty)） */
  inferredPenalty: number;
  /** R8：recall_count 对数强化加成权重（默认 0.03） */
  reinforcementWeight: number;
  /** R9：mood-congruent 对称弱偏置（默认 0 = 关；开启建议 0.03） */
  moodBoost: number;
  /** GROW-EVO P3 R10（§3.2）：情感显著度 |valence|×arousal 加成权重（实验轨——缺省 0 =
   *  恒等；进预注册 A/B 队列，未过 A/B 不得置正。判官/抽取器同源偏差 → 永不单独放行）。 */
  emotionSalienceWeight: number;
}

export const DEFAULT_RANK_SIGNALS: RankSignals = {
  timeBoost: 0.05,
  recencyBoost: 0.03,
  sigWeight: 0.03,
  inferredPenalty: 0.1,
  reinforcementWeight: 0.03,
  moodBoost: 0,
  emotionSalienceWeight: 0,
};

/** 全 0 常量：关断矩阵锚点（结构上即"所有通道退出"）。 */
export const ZERO_RANK_SIGNALS: RankSignals = {
  timeBoost: 0,
  recencyBoost: 0,
  sigWeight: 0,
  inferredPenalty: 0,
  reinforcementWeight: 0,
  moodBoost: 0,
  emotionSalienceWeight: 0,
};

const DAY_MS = 86_400_000;

// ============================
// R1 · 时间感知
// ============================

/**
 * R1 时间窗命中（宁缺毋滥：无窗 / boost=0 → 0）。
 * 命中判定：occurred_at ∈ 窗 ∪ valid 区间与窗相交。
 * 窗口边界统一半开 [ws, we)（R-A1 审查 M-4，S7 第 5 项）：
 *   - occurred_at：ws 属窗（>= ws）、we 不属（< we）；
 *   - valid 区间：覆盖窗内至少一点即相交——valid_end 语义"至该点仍成立"
 *     （缺侧 = ±∞ 开放端，持续态事实"自 X 起/至 X 仍成立"），故起点判 e >= ws
 *     （与 occurred 的 >= ws 同口径；修复前 e > ws 严格开区间与 occurred 分支不一致），
 *     终点判 s < we（we 不属窗）。
 * 两端皆缺 = 无时间锚，不加成（与 inTimeWindow 的过滤语义不同：boost 必须有实证）。
 */
export function timeSignalOf(
  item: RankSignalItem,
  win: TimeWindow | null | undefined,
  boost: number,
): number {
  if (!(boost > 0) || !win) return 0;
  const ws = Date.parse(win.start);
  const we = Date.parse(win.end);
  if (Number.isNaN(ws) || Number.isNaN(we)) return 0;
  // ① occurred_at ∈ 窗
  const occurred = item.occurred_at ? Date.parse(item.occurred_at) : NaN;
  if (!Number.isNaN(occurred) && occurred >= ws && occurred < we) return boost;
  // ② valid 区间与窗相交（缺侧 = ±∞ 开放端；半开窗 [ws, we)：起点 e >= ws、终点 s < we）
  const vs = item.valid_start ? Date.parse(item.valid_start) : NaN;
  const ve = item.valid_end ? Date.parse(item.valid_end) : NaN;
  if (Number.isNaN(vs) && Number.isNaN(ve)) return 0;
  const s = Number.isNaN(vs) ? -Infinity : vs;
  const e = Number.isNaN(ve) ? Infinity : ve;
  return s < we && e >= ws ? boost : 0;
}

/**
 * R1 时近性：metadata.last_recalled_at 距今（now 快照）< 24h → +boost。
 * 未来时间戳不加成（时钟偏移防御，delta >= 0）；读不到/解析失败 → 0。
 */
export function recencySignalOf(item: RankSignalItem, now: Date, boost: number): number {
  if (!(boost > 0)) return 0;
  const raw = item.metadata?.last_recalled_at;
  if (typeof raw !== "string") return 0;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return 0;
  const delta = now.getTime() - t;
  return delta >= 0 && delta < DAY_MS ? boost : 0;
}

// ============================
// R2 · significance
// ============================

/** R2：+ significance * sigWeight（缺失/非有限/非正 → 0）。 */
export function significanceSignalOf(item: RankSignalItem, weight: number): number {
  if (!(weight > 0)) return 0;
  const s = item.significance;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? s * weight : 0;
}

// ============================
// R3 · 置信度分层
// ============================

/**
 * R3：inferred 记忆 rankKey 乘 (1 - penalty)（spec §2：乘法降权，source 归并入同层）。
 * penalty=0 → 恒 1（关断恒等，×1.0 在 IEEE754 下无舍入）。
 */
export function certaintyMultiplierOf(item: RankSignalItem, penalty: number): number {
  if (!(penalty > 0)) return 1;
  return item.certainty === "inferred" ? 1 - penalty : 1;
}

// ============================
// R8 · 强化闭环
// ============================

/** R8：+ log10(1 + recall_count) * weight（对数缩放防马太效应；count≤0/缺失 → 0）。 */
export function reinforcementSignalOf(item: RankSignalItem, weight: number): number {
  if (!(weight > 0)) return 0;
  const c = item.metadata?.recall_count;
  if (typeof c !== "number" || !Number.isFinite(c) || c <= 0) return 0;
  return Math.log10(1 + c) * weight;
}

/** GROW-EVO P3 R10（§3.2）：情感显著度 = |valence| × arousal（0..1，双 0 = 恒 0）。
 *  实验轨纯函数——weight 由 cfg.recall.emotionSalienceWeight 承载（缺省 0 = 恒等）；
 *  判官/抽取器同源偏差 → 该信号永不单独放行排序变更，仅进预注册 A/B 队列。 */
export function emotionSalienceOf(src: { valence?: number; arousal?: number } | undefined): number {
  if (!src) return 0;
  const v = typeof src.valence === "number" ? Math.min(Math.abs(src.valence), 1) : 0;
  const a = typeof src.arousal === "number" ? Math.min(Math.max(src.arousal, 0), 1) : 0;
  return v * a;
}

// ============================
// R9 · mood-congruent 弱偏置（默认关）
// ============================

/**
 * R9 moodSign：当前轮 fired valence 均值符号（对称：正负都偏）。
 * fired 为空 / 全 null → 0 → 不加成（宁缺毋滥）。
 */
export function moodSignOf(firedValences: ReadonlyArray<number | null | undefined>): number {
  const vals = firedValences.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (vals.length === 0) return 0;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return mean > 0 ? 1 : mean < 0 ? -1 : 0;
}

/** R9：moodSign 与记忆 valence 同符号 → +boost（valence 0/缺失不加成）。 */
export function moodSignalOf(item: RankSignalItem, moodSign: number, boost: number): number {
  if (!(boost > 0) || moodSign === 0) return 0;
  const v = item.valence;
  if (typeof v !== "number" || !Number.isFinite(v) || v === 0) return 0;
  return Math.sign(v) === moodSign ? boost : 0;
}

// ============================
// R6 · 场景路由（R-A2，spec §2 R6：tiebreak 层，宁缺毋滥）
// ============================

/**
 * R6 场景命中检测（纯函数，确定性）：query 含候选池中出现的 scene_name → 返回该场景名。
 * 规则（宁缺毋滥）：
 *   - 场景名 trim 后长度 < 2 不参与（防单字符噪声命中）；
 *   - 大小写不敏感子串匹配（query 含场景名，ASCII 安全、中文原样）；
 *   - 层级场景名的祖先段同享检测（"项目重构/后端" → "项目重构" 亦可命中，
 *     与条目侧 sceneSignalOf 的层级前缀匹配对称）；
 *   - 多命中取最长场景名（更具体），同长取字典序（确定性，无随机）。
 */
export function detectSceneHit(query: string, sceneNames: readonly (string | undefined | null)[]): string | null {
  const q = (query ?? "").toLowerCase();
  if (!q || !sceneNames || sceneNames.length === 0) return null;
  const names = new Set<string>();
  for (const raw of sceneNames) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (s.length < 2) continue;
    names.add(s);
    // 层级祖先段（"工作/项目A" → "工作"）：与条目侧前缀匹配对称
    let cur = s;
    for (;;) {
      const idx = cur.lastIndexOf("/");
      if (idx <= 0) break;
      cur = cur.slice(0, idx).trim();
      if (cur.length >= 2) names.add(cur);
    }
  }
  const hits = [...names].filter((s) => q.includes(s.toLowerCase()));
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  return hits[0];
}

/**
 * R6 场景加成（tiebreak 层，与 priority/coreRefBoost 同族）：条目 scene_name 与
 * 命中场景精确相等或层级前缀（"工作" 命中 "工作/子场景"）→ +boost。0/未命中 → 0。
 */
export function sceneSignalOf(
  item: { scene_name?: string | null },
  sceneHit: string | null | undefined,
  boost: number,
): number {
  if (!(boost > 0) || !sceneHit) return 0;
  const sn = item?.scene_name;
  if (typeof sn !== "string" || sn.length === 0) return 0;
  return sn === sceneHit || sn.startsWith(`${sceneHit}/`) ? boost : 0;
}

// ============================
// 组合：加性结构信号总量（不含 coreRef 与 R3 乘法——调用方组合）
// ============================

/** 一次条目遍历算齐全部加性分量（调用方再乘 certaintyMultiplierOf）。 */
export function structuralSignalOf(
  item: RankSignalItem,
  ctx: {
    timeWindow: TimeWindow | null | undefined;
    moodSign: number;
    signals: RankSignals;
    now: Date;
  },
): number {
  return (
    timeSignalOf(item, ctx.timeWindow, ctx.signals.timeBoost) +
    recencySignalOf(item, ctx.now, ctx.signals.recencyBoost) +
    significanceSignalOf(item, ctx.signals.sigWeight) +
    reinforcementSignalOf(item, ctx.signals.reinforcementWeight) +
    moodSignalOf(item, ctx.moodSign, ctx.signals.moodBoost)
  );
}

// ============================
// buildRankContext（plan Interfaces 契约：R-A2 复用）
// ============================

/** appraisal fired 后的当前轮价值（valence 来自 core_values 行，可为 null）。 */
export interface FiredValue {
  label: string;
  weight: number;
  valence: number | null;
}

/**
 * 一轮召回的排序上下文（确定性锚点：now 快照）。
 * firedValues：query 的 appraisal fired 价值（coreRef R5/R-A2 反查 + R9 moodSign 源）；
 * timeWindow：query 时间线索解析（宁缺毋滥：解析不出 = null = 无时间信号）；
 * moodSign：fired valence 均值符号（R9）。
 */
export interface RankContext {
  firedValues: FiredValue[];
  firedLabels: string[];
  timeWindow: TimeWindow | null;
  moodSign: number;
  /**
   * R-A2（R6 场景路由）：`items` 中出现的 scene_name 与 query 的命中（plan Interfaces
   * 预留参数的兑现）。items 空 / 不命中 → null。调用方若在候选池就绪后才排序（候选池
   * 即 items），也可直接用 detectSceneHit 在排序点自行计算（同一实现，单一源）。
   */
  sceneHit: string | null;
  now: Date;
}

/** 价值锚行最小形状（store.listValues 行的字集；多余字段无碍）。 */
export interface ValueRowLike {
  value_id?: string;
  label: string;
  weight: number;
  valence?: number | null;
}

/**
 * 组装一轮召回的排序上下文（plan Interfaces：buildRankContext(query, items, opts)）。
 * best-effort：readValues 缺失/抛错 → firedValues 空（coreRef/mood 通道静默关闭，
 * 全链旧行为零影响——与 C1 computeFiredLabels 的降级语义一致）。
 * `items` 为 R-A2 预留参数（R6 场景路由将消费条目 scene_name）；R-A1 不消费。
 */
export async function buildRankContext(
  query: string,
  items: readonly RankSignalItem[],
  opts: {
    readValues?: () => ReadonlyArray<ValueRowLike> | Promise<ReadonlyArray<ValueRowLike>>;
    now?: Date;
  },
): Promise<RankContext> {
  // R-A2（R6）：items 的 scene_name 参与场景命中检测（预留参数兑现）。
  const sceneHit = detectSceneHit(
    query,
    (items ?? []).map((i) => i?.scene_name ?? ""),
  );
  const now = opts.now ?? new Date();
  const firedValues: FiredValue[] = [];
  if (opts.readValues && query && query.trim().length > 0) {
    try {
      const rows = (await opts.readValues()) ?? [];
      const values: CoreValue[] = rows
        .filter((v) => v && typeof v.label === "string" && v.label.trim())
        .map((v) => ({
          id: typeof v.value_id === "string" ? v.value_id : "",
          label: v.label.trim(),
          weight: typeof v.weight === "number" ? v.weight : 0,
        }));
      if (values.length > 0) {
        const valenceByLabel = new Map<string, number | null>();
        for (const r of rows) {
          if (r && typeof r.label === "string" && r.label.trim()) {
            valenceByLabel.set(r.label.trim(), typeof r.valence === "number" ? r.valence : null);
          }
        }
        for (const a of appraise(query, values, DEFAULT_APPRAISAL_CONFIG)) {
          if (a.fired) {
            firedValues.push({
              label: a.value.label,
              weight: a.weight,
              valence: valenceByLabel.get(a.value.label) ?? null,
            });
          }
        }
      }
    } catch {
      // best-effort：价值锚读取失败 = coreRef/mood 通道静默关闭（零影响）
    }
  }
  return {
    firedValues,
    firedLabels: firedValues.map((v) => v.label),
    timeWindow: parseTimeWindow(query, now),
    moodSign: moodSignOf(firedValues.map((v) => v.valence)),
    sceneHit,
    now,
  };
}
