/**
 * A1 · L2 触发门决策（task-4 / docs/research/2026-11-02-memory-layering-extraction-optimization.md §6-A）。
 *
 * 现状病灶：每条新 L1 记忆都会立刻触发一次 L2 全量重写（实测 99 runs/天、
 * p50 74s、p95 18min），绝大多数轮次增量极小。触发门把触发条件从
 * 「有增量」改成「增量攒够条数，或距上次成功抽取已超时间阈值」。
 *
 * 缺省 persona.l2Gate.enabled=false ⇒ 决策恒为「不跳过」，逐位等于今天的行为。
 * 本模块是纯函数，不读写存储、不产生副作用，便于单测钉死边界。
 */

/** persona.l2Gate 在 config 里的形态（只取本模块需要字段）。 */
export interface L2GateConfigLike {
  enabled?: boolean;
  minPendingL1?: number;
  minIntervalHours?: number;
}

/** 门拦下本轮时的返回形态（结构兼容 L2RunnerResult，额外带 reason 供观测）。 */
export interface L2GateSkipResult {
  skipped: true;
  /** "l2-gate" = A1 触发门；"l2-throttle" = F2 全局速率门。 */
  reason: "l2-gate" | "l2-throttle";
}

export interface L2GateDecisionInput {
  /** persona.l2Gate.enabled；非 true 一律不跳过（缺省行为）。 */
  enabled?: boolean;
  /** 未处理 L1 条数（= 本轮 incremental query 返回的 records.length，真实计数）。 */
  pendingCount: number;
  /** checkpoint pipeline_states[sessionKey].l2_last_extraction_time（ISO 串或空）。 */
  lastExtractionAt: string | null | undefined;
  nowMs: number;
  minPendingL1?: number;
  minIntervalHours?: number;
  /** 强制触发通道：true 时无视门阈值。 */
  force?: boolean;
}

export interface L2GateDecision {
  /** true = 本轮不跑 L2（不得推进 cursor、不得消费 records）。 */
  skip: boolean;
  reason?: "l2-gate";
  pendingCount: number;
  minPendingL1: number;
  minIntervalHours: number;
  /** 距上次成功抽取的毫秒数；从未抽取过 = null（视为已超阈值）。 */
  elapsedMs: number | null;
}

export const L2_GATE_DEFAULT_MIN_PENDING_L1 = 30;
export const L2_GATE_DEFAULT_MIN_INTERVAL_HOURS = 6;

const MS_PER_HOUR = 3_600_000;

function normalizeCount(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return fallback;
  return Math.floor(raw);
}

function normalizeHours(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return fallback;
  return raw;
}

function parseTimestampMs(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 判定本轮 L2 是否跳过。
 *
 * 规则（顺序即优先级）：
 *  1. force=true → 不跳过（手动/强制口）；
 *  2. enabled!==true → 不跳过（缺省逐位等于今天）；
 *  3. pendingCount===0 → 跳过（无增量无可抽；调用方通常在更早处早退）；
 *  4. pendingCount>=minPendingL1 → 不跳过（条数门）；
 *  5. 从未成功抽取过，或距上次 >= minIntervalHours → 不跳过（时间门/保底新鲜度）；
 *  6. 否则 → 跳过，reason="l2-gate"。
 */
/** 门拦下本轮时的 reason 字面量（pipeline-factory 返回、pipeline-manager 消费，单点定义）。 */
export const L2_GATE_SKIP_REASON = "l2-gate" as const;

/**
 * F2 · 全局速率门拦下本轮时的 reason 字面量。
 *
 * 语义上它属于「门拦下」这一族（records 未消费 ⇒ 不得刷新 l2_last_extraction_time、
 * 不得清 pending、不得推 cursor），只是拦住它的是**全局**额度而不是单会话阈值。
 */
export const L2_THROTTLE_SKIP_REASON = "l2-throttle" as const;

/** 滑动窗口长度：60 分钟（"每小时最多跑几次"的口径）。 */
export const L2_RUN_WINDOW_MS = MS_PER_HOUR;

/**
 * "一轮" = 60 秒的派发桶。
 *
 * boot recovery 会把几百个会话的 L2 timer 挂在同一毫秒上，一次开火就是一个"爆发"。
 * 桶把爆发切成有序的若干轮：本轮额度用尽 ⇒ 被拦会话重挂到下一轮开头，而不是
 * 继续在同一个 tick 里放行。60s 与 per-session 的 maxInterval 无关，只是派发节奏。
 */
export const L2_THROTTLE_ROUND_MS = 60_000;

/** 缺省上限：0 = 不限（逐位等于加门之前的行为）。 */
export const L2_THROTTLE_DEFAULT_MAX_RUNS_PER_HOUR = 0;
export const L2_THROTTLE_DEFAULT_MAX_SESSIONS_PER_ROUND = 0;

/** 运行结果的**结构**最小面（与 L2RunnerResult 结构兼容，避免本模块反向依赖 utils/）。 */
export interface L2RunnerResultLike {
  skipped?: boolean;
  reason?: string;
  latestCursor?: string;
}

/** 本轮结果是否「被 F2 全局速率门拦下」（与 A1 门区分，便于观测/归因）。 */
export function isL2ThrottleSkip(result: L2RunnerResultLike | void | null | undefined): boolean {
  return result?.skipped === true && result.reason === L2_THROTTLE_SKIP_REASON;
}

/**
 * 本轮结果是否「被门拦下」（区别于 legacy「无增量」的 skip）。
 *
 * 门族 = A1 触发门（"l2-gate"）+ F2 全局速率门（"l2-throttle"）：两者的共同语义是
 * records 未消费 ⇒ 不刷新「上次成功 L2」、不清 pending、不推 cursor。
 */
export function isL2GateSkip(result: L2RunnerResultLike | void | null | undefined): boolean {
  return (
    result?.skipped === true && (result.reason === L2_GATE_SKIP_REASON || result.reason === L2_THROTTLE_SKIP_REASON)
  );
}

export interface L2PostRunState {
  /**
   * true = 本轮算「上次成功 L2」：刷新 checkpoint 的 l2_last_extraction_time、并把
   * 内存里的 minInterval 基准推到 now。
   */
  recordSuccess: boolean;
  /** true = 清空未处理 L1 计数（只有真正消费了 records 的轮次才允许清）。 */
  resetPending: boolean;
}

/**
 * 运行后状态决策（把 pipeline-manager.runL2 的既有时间戳语义收敛成纯函数，便于钉边界）。
 *
 * 为什么必须存在：门拦下的轮次若照旧刷新 l2_last_extraction_time，时间门会被自己的
 * skip 不断推后 ⇒ 「距上次成功抽取 ≥ minIntervalHours」永远不会成立，生产上退化成
 * 纯条数门（A1 的目标 99→≤25 runs/天 也随之落空）。
 *
 * 规则（顺序即优先级）：
 *  1. 门拦下（skipped && reason="l2-gate"）→ 不记成功、不清 pending（records 未消费）；
 *  2. legacy 冷启动 skip（首轮无增量）→ 不记成功、清 pending（逐位今天）；
 *  3. 其余（legacy 非首轮 skip / 正常跑完 / 无返回值）→ 记成功、清 pending（逐位今天）。
 */
export function decideL2PostRun(
  result: L2RunnerResultLike | void | null | undefined,
  opts?: { isFirstRun?: boolean },
): L2PostRunState {
  if (isL2GateSkip(result)) return { recordSuccess: false, resetPending: false };
  const skipped = result?.skipped === true;
  if (skipped && opts?.isFirstRun === true) return { recordSuccess: false, resetPending: true };
  return { recordSuccess: true, resetPending: true };
}

export function decideL2Gate(input: L2GateDecisionInput): L2GateDecision {
  const minPendingL1 = normalizeCount(input.minPendingL1, L2_GATE_DEFAULT_MIN_PENDING_L1);
  const minIntervalHours = normalizeHours(input.minIntervalHours, L2_GATE_DEFAULT_MIN_INTERVAL_HOURS);
  const pendingCount = normalizeCount(input.pendingCount, 0);
  const lastMs = parseTimestampMs(input.lastExtractionAt);
  const elapsedMs = lastMs === null ? null : Math.max(0, Math.floor(input.nowMs) - lastMs);

  const base = { pendingCount, minPendingL1, minIntervalHours, elapsedMs };

  if (input.force === true) return { ...base, skip: false };
  if (input.enabled !== true) return { ...base, skip: false };
  if (pendingCount === 0) return { ...base, skip: true, reason: "l2-gate" };
  if (pendingCount >= minPendingL1) return { ...base, skip: false };
  const byTime = elapsedMs === null || elapsedMs >= minIntervalHours * MS_PER_HOUR;
  if (byTime) return { ...base, skip: false };
  return { ...base, skip: true, reason: "l2-gate" };
}

/** 滑动窗口剪枝：只留 (now - 1h, now] 内的运行时间戳（== cutoff 的按「已滑出」丢弃）。 */
export function pruneL2RunTimestamps(timestamps: readonly number[], nowMs: number): number[] {
  const cutoff = Math.floor(nowMs) - L2_RUN_WINDOW_MS;
  const kept: number[] = [];
  for (const t of timestamps) {
    if (Number.isFinite(t) && t > cutoff) kept.push(t);
  }
  return kept;
}

export interface L2ThrottleInput {
  /** 滑动 60 分钟内最多放行几次真实运行；缺省/<=0 = 不限。 */
  maxRunsPerHour?: number;
  /** 单轮（60s 桶）最多放行几个 session；缺省/<=0 = 不限。 */
  maxSessionsPerRound?: number;
  /** 已发生的真实运行时间戳（enqueued 不算，must be actual runs）。 */
  runTimestamps: readonly number[];
  /** 已放行但尚未结算的运行（保守计入窗口，防并发穿透）。 */
  inFlight: number;
  /** 本轮已经放行的 session 数。 */
  roundAdmitted: number;
  /** 本轮起点（epoch ms；<=0 表示还没有轮次）。 */
  roundStartedAtMs?: number;
  nowMs: number;
}

export interface L2ThrottleDecision {
  admit: boolean;
  reason?: "l2-throttle";
  maxRunsPerHour: number;
  maxSessionsPerRound: number;
  windowUsed: number;
  windowRemaining: number;
  roundAdmitted: number;
  roundRemaining: number;
  roundStartedAtMs: number;
  /** 最早一次运行滑出窗口的时刻（没有运行/不限窗口时 null）。 */
  nextSlotAtMs: number | null;
}

/**
 * F2 · 全局速率门决策（纯函数，pipeline-manager 在**真实执行前**同步调用一次）。
 *
 * 为什么必须是纯函数：242 个会话的 timer 会在同一毫秒开火，放行判定必须能被
 * 单测用 fake clock 逐位钉住（"单轮 ≤ N / 任意 60 分钟 ≤ R"）；把这些算术
 * 留在 manager 里就只能靠集成测试间接推断。
 *
 * 两道闸同时生效、任一满即拦：
 *  - 滑动窗口（maxRunsPerHour）：按**真实运行**计数，不用 enqueued；
 *  - 单轮桶（maxSessionsPerRound）：60s 一轮，拦下的会话由 manager 重挂到下一轮。
 * 值 0 = 该闸不限（两闸都 0 ⇒ 永远 admit，逐位等于加门之前）。
 */
export function decideL2Throttle(input: L2ThrottleInput): L2ThrottleDecision {
  const maxRunsPerHour = normalizeLimit(input.maxRunsPerHour);
  const maxSessionsPerRound = normalizeLimit(input.maxSessionsPerRound);
  const nowMs = Math.floor(input.nowMs);

  const kept = pruneL2RunTimestamps(input.runTimestamps, nowMs);
  const inFlight = Math.max(0, Math.floor(input.inFlight || 0));
  const windowUsed = kept.length + inFlight;
  const windowRemaining = maxRunsPerHour > 0 ? Math.max(0, maxRunsPerHour - windowUsed) : Number.POSITIVE_INFINITY;

  const prevStart = Number.isFinite(input.roundStartedAtMs) ? Math.floor(input.roundStartedAtMs as number) : 0;
  const rollRound = prevStart <= 0 || nowMs - prevStart >= L2_THROTTLE_ROUND_MS;
  const roundStartedAtMs = rollRound ? nowMs : prevStart;
  const roundAdmitted = rollRound ? 0 : Math.max(0, Math.floor(input.roundAdmitted || 0));
  const roundRemaining =
    maxSessionsPerRound > 0 ? Math.max(0, maxSessionsPerRound - roundAdmitted) : Number.POSITIVE_INFINITY;

  const admit = windowRemaining > 0 && roundRemaining > 0;
  // 最早一次运行滑出窗口的时刻（runTimestamps 不要求有序，取 min 而不是首元素）
  const nextSlotAtMs = maxRunsPerHour > 0 && kept.length > 0 ? Math.min(...kept) + L2_RUN_WINDOW_MS : null;

  return {
    admit,
    ...(admit ? {} : { reason: L2_THROTTLE_SKIP_REASON as "l2-throttle" }),
    maxRunsPerHour,
    maxSessionsPerRound,
    windowUsed,
    windowRemaining,
    roundAdmitted,
    roundRemaining,
    roundStartedAtMs,
    nextSlotAtMs,
  };
}

/** 上限归一：undefined/非数/<=0 ⇒ 0（不限）；其余向下取整。 */
function normalizeLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * 被拦后的探测抖动上界（毫秒）。
 *
 * 生产上 293 个会话在同一个 tick 里被拦，如果它们的重挂时刻完全相同，就会在下一个
 * 可放行时点继续"同刻齐醒" ⇒ 每个 tick 仍然只放行 maxSessionsPerRound 个、其余再
 * 撞回来。把抖动摊在 [0, 30s) 上，同一个窗口的会话就有了 30 个不同的重试毫秒，
 * 单个 tick 的峰值被摊平，且最坏只比"最早可放行时点"晚 30s。
 */
export const L2_THROTTLE_RETRY_JITTER_MS = 30_000;

/** 被拦后的最小探测间隔：不早于 now + 1s（防忙等，保留原 1s 下限）。 */
const L2_THROTTLE_RETRY_MIN_MS = 1_000;

/** FNV-1a 32bit：把 sessionKey 稳定映射到抖动区间（同一会话每次落到同一毫秒）。 */
function hashSessionKey(sessionKey: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionKey.length; i++) {
    hash ^= sessionKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * F2 · 被拦后的重挂时刻（单一事实源：worker 与 manager 都只调这一个）。
 *
 * 旧实现（pipeline-worker）把 `roundResetAtMs` 无条件塞进候选、再取 max：inFlight 占满
 * 时 `nextSlotAtMs === null`（窗口里没有已结算时间戳），于是退化成"固定 ~60s 轮询"，
 * 且 293 个会话落在同一毫秒。规则改为：
 *
 *  1. 底座 now + 1s（不忙等）；
 *  2. 单轮桶满 ⇒ 不早于下一轮桶口 `roundStartedAtMs + L2_THROTTLE_ROUND_MS`；
 *  3. 窗口满 ⇒ 不早于下一个**真实**可放行时点：有已结算时间戳时是最早那次滑出窗口
 *     （`nextSlotAtMs`），只有 inFlight 占满时退化为有界探测（一个轮次长度）；
 *     并在此之上加 [0, 30s) 的会话稳定抖动，避免同刻齐醒。
 *
 * 两个上限都 <=0（不限）时这条路径根本不会被调用（门永远 admit），"0 = 不限"语义不变。
 */
export function planL2RetryAtMs(input: {
  decision: L2ThrottleDecision;
  nowMs: number;
  /** 抖动种子（会话键）；缺省时退化为 0 抖动。 */
  sessionKey?: string;
}): number {
  const nowMs = Math.floor(input.nowMs);
  const decision = input.decision;
  let atMs = nowMs + L2_THROTTLE_RETRY_MIN_MS;

  if (decision.roundRemaining <= 0) {
    atMs = Math.max(atMs, Math.floor(decision.roundStartedAtMs) + L2_THROTTLE_ROUND_MS);
  }

  if (decision.windowRemaining <= 0) {
    const slotAtMs = decision.nextSlotAtMs ?? nowMs + L2_THROTTLE_ROUND_MS;
    atMs = Math.max(atMs, Math.floor(slotAtMs));
    atMs += hashSessionKey(input.sessionKey ?? "") % L2_THROTTLE_RETRY_JITTER_MS;
  }

  return atMs;
}
