/**
 * #34（S13/R5，2026-10-16）：当下性 state——会话级状态通道（不落库）。
 *
 * 职责边界（r5-34 + R5 修正）：
 * - 本模块只定义 **形状 + taxonomy + 渲染行**；状态机数据源归 #28（复用同一
 *   state 层，不发明第二套情绪评估）；注入时机归 #37 分层接口（soul.tail）。
 * - **指纹隔离**：state 绝不参与 soulVersion（computeSoulVersion 无 state 入参，
 *   由测试 soul-state.test.ts 显式断言）——state 混入指纹=每轮前缀缓存全失效。
 *   state 参与进程内 cacheKey（不参与持久指纹），见 soul-assembler.ts 接线注释。
 * - taxonomy 单一源：SOUL_STATE_EVENT_KINDS 与 #37 漂移触发共用
 *  （MemoryProxy/docs/soul-block-interface.md 引用本清单，勿在别处复制定义）。
 */
/** state 事件种类（单一源，#37 driftTrigger 共用）。 */
export const SOUL_STATE_EVENT_KINDS = ["user_correction", "tool_failure", "task_switch"] as const;
export type SoulStateEventKind = (typeof SOUL_STATE_EVENT_KINDS)[number];

/** 会话级当下状态（连续值域；top1 活跃价值复用 directional 结构）。 */
export interface SoulState {
  /** 效价连续值 [-1,1]（负=受阻/审慎，正=顺遂/趋近）。 */
  valence: number;
  /** 唤醒连续值 [0,1]（高=切换/紧张，低=平缓）。 */
  arousal: number;
  /** 活跃价值 top1（缺省时由渲染层取 directional 权重最高锚）。 */
  topValue?: string;
  /** 会话内轮次（观测附注，不参与指纹/渲染文案）。 */
  turnSeq?: number;
}

/** 夹紧到合法值域（脏输入防御：状态机上游写坏不炸渲染）。 */
export function clampState(s: SoulState): SoulState {
  const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
  return { ...s, valence: clamp(s.valence, -1, 1), arousal: clamp(s.arousal, 0, 1) };
}

/** 定性桶阈值与 mood-line.ts 三档同源（±0.25），防伪精度：连续值仅以括号小数附注。 */
function valenceBucket(v: number): string {
  return v >= 0.25 ? "偏正" : v <= -0.25 ? "偏负" : "中性";
}
function arousalBucket(a: number): string {
  return a >= 0.6 ? "偏高" : a <= 0.2 ? "平缓" : "中等";
}

/**
 * 渲染「当下状态」行（soul-feeling 尾块专用；依赖 #37 soul.tail 接口）。
 * - null/undefined → ""（逐位现状，config-first）；
 * - topValue 缺省由调用方传 directional top（soul-assembler 已算出，不重算）；
 *   两处皆无 → 省略活跃价值段。
 * - 文案不含主语断言「我感到…」（§1.5 主语越界防线）：只报状态信号本身。
 */
export function renderStateLine(state: SoulState | null | undefined, fallbackTopValue?: string): string {
  if (!state) return "";
  const s = clampState(state);
  const parts = [`${valenceBucket(s.valence)}（${s.valence.toFixed(1)}）`, `唤醒${arousalBucket(s.arousal)}（${s.arousal.toFixed(1)}）`];
  const top = s.topValue?.trim() || fallbackTopValue?.trim() || "";
  if (top) parts.push(`活跃价值：${top}`);
  return `当下状态：${parts.join("·")}`;
}
