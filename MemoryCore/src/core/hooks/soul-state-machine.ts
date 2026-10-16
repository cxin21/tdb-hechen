/**
 * #28（S5-state/R5，2026-10-16）：当下性 state 状态机——事件即时评估（连续值+指数衰减）。
 *
 * 职责边界（r5-28 + #34 分工）：
 * - 本模块=纯状态机（decay / impulse / observation / rollup），无 IO；落库走
 *   IMemoryStore 可选方法 readSoulState/writeSoulState（soul_state 表，#30 soul_snapshots
 *   同款范式）。trait 基线（48h 半衰期聚合）已在 mood-line.ts；本模块=state 当前值
 *   （事件即时评估），两维 valence/arousal 连续值指数衰减（r5-28 分层合同），不发明
 *   第二套情绪评估——事件 taxonomy 复用 soul-state.ts 单一源。
 * - 统一抽取扩展门（memory.extractionExtensions.enabled，缺省 false）控制生产接线
 *   （l1-extractor 落库后 rollup）；门 off=零读零写=逐位现状。
 * - 观察语义：L1 记录 soul 列 valence/arousal（特征抽取器产物）=对状态的**直设观测**
 *   （测量覆盖漂移）；taxonomy 事件 impulse=**加性**（衰减基线上叠加后 clamp）。
 */
import { clampState, type SoulState, type SoulStateEventKind } from "./soul-state.js";

/** state 半衰期（小时）——与 mood-line trait 聚合同一口径（config-first 缺省 48h）。 */
export const STATE_HALF_LIFE_HOURS = 48;

/** taxonomy 事件冲量表（加性；显式 event.valence/arousal 覆盖对应维）。 */
export const STATE_IMPULSES: Record<SoulStateEventKind, { valence: number; arousal: number }> = {
  user_correction: { valence: -0.4, arousal: 0.3 },
  tool_failure: { valence: -0.3, arousal: 0.4 },
  task_switch: { valence: 0, arousal: 0.1 },
};

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const parseMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * 指数衰减（半衰期 STATE_HALF_LIFE_HOURS；at 缺失/非法=无衰减锚，原样返回防漂移）。
 */
export function decayState(prev: SoulState, nowMs: number): SoulState {
  const last = parseMs(prev.at);
  if (last === null) return { ...prev };
  const dtH = Math.max(0, (nowMs - last) / 3_600_000);
  const f = Math.pow(0.5, dtH / STATE_HALF_LIFE_HOURS);
  return { ...prev, valence: round6(prev.valence * f), arousal: round6(prev.arousal * f), at: new Date(nowMs).toISOString() };
}

/** state 事件（taxonomy 冲量；显式 valence/arousal 覆盖对应维）。 */
export interface SoulStateEvent {
  kind: SoulStateEventKind;
  valence?: number;
  arousal?: number;
  /** 事件时刻 ISO（缺省=now）。 */
  at?: string;
}

/** 事件即时评估：先衰减到事件时刻，再叠加冲量（clamp 防爆；turnSeq 单调递增）。 */
export function evaluateStateEvent(prev: SoulState | null, event: SoulStateEvent, nowMs = Date.now()): SoulState {
  const atMs = parseMs(event.at) ?? nowMs;
  const base = prev ? decayState(prev, atMs) : { valence: 0, arousal: 0, at: new Date(atMs).toISOString() };
  return clampState({
    valence: base.valence + (event.valence ?? STATE_IMPULSES[event.kind].valence),
    arousal: base.arousal + (event.arousal ?? STATE_IMPULSES[event.kind].arousal),
    topValue: prev?.topValue,
    turnSeq: (prev?.turnSeq ?? 0) + 1,
    at: new Date(atMs).toISOString(),
  });
}

/** 观测直设（L1 记录 soul 列→state）：给定维覆盖，未给维保留衰减值。 */
export function applyObservation(
  prev: SoulState | null,
  obs: { valence?: number | null; arousal?: number | null; at?: string | null },
  nowMs = Date.now(),
): SoulState {
  const atMs = parseMs(obs.at) ?? nowMs;
  const base = prev ? decayState(prev, atMs) : { valence: 0, arousal: 0, at: new Date(atMs).toISOString() };
  return clampState({
    valence: obs.valence ?? base.valence,
    arousal: obs.arousal ?? base.arousal,
    topValue: prev?.topValue,
    turnSeq: (prev?.turnSeq ?? 0) + 1,
    at: new Date(atMs).toISOString(),
  });
}

/**
 * 会话 rollup：按 occurred_at 升序折叠记录观测，末态再衰减到 now。
 * 无带 soul 列的记录→null（不落库，防状态表被无观测轮次覆盖）。
 */
export function rollupStateFromRecords(
  prev: SoulState | null,
  records: ReadonlyArray<Record<string, unknown> & { valence?: number | null; arousal?: number | null; occurred_at?: string | null }>,
  nowMs = Date.now(),
): SoulState | null {
  const sorted = [...records]
    .filter((r) => r.valence != null || r.arousal != null)
    .sort((a, b) => (parseMs(a.occurred_at) ?? 0) - (parseMs(b.occurred_at) ?? 0));
  if (sorted.length === 0) return null;
  let st: SoulState | null = prev;
  for (const r of sorted) st = applyObservation(st, { valence: r.valence, arousal: r.arousal, at: r.occurred_at ?? undefined }, nowMs);
  return st ? decayState(st, nowMs) : null;
}

/** 统一抽取扩展门读取（r5-28：memory.extractionExtensions.enabled，缺省 false=逐位现状）。 */
export function extractionExtensionsEnabled(memoryConfig: unknown): boolean {
  const c = memoryConfig as { extractionExtensions?: { enabled?: boolean } } | undefined;
  return c?.extractionExtensions?.enabled === true;
}
