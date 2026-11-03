/**
 * F2 · 全局速率门的进程内账本（**生产路径**）。
 *
 * 背景（m01638 F2 的根因）：生产 L2 的触发源是 state backend 的 timer
 * （`server.ts:1951-1983 onTimerExpired` → `enqueueTask({type:"L2"})` →
 * `pipeline-worker` → `executor.executeL2` → `core.runL2WithStore`），
 * 根本不经过 `MemoryPipelineManager` 自己的定时器，所以放在 manager 里的
 * 全局门在生产上从未被调用（2026-11-02 17:37 重启后 4h：112 个 distinct
 * scene-extract、44047 条 lock conflict、0 条 reason=l2-throttle）。
 *
 * 本模块把 `l2-gate.ts` 里的纯函数决策（`decideL2Throttle`）落成一个
 * **进程内单例账本**，由 `pipeline-worker` 在**抢锁之前**同步判定：
 *  - 拦下的会话不再进 agent 级锁队列（否则 253 个 L2 任务仍会打成一团）；
 *  - 放行时先记账（in-flight 保守计入窗口），执行结束再结算；
 *  - 只有真实运行（records 被消费）才占滑动窗口，被 A1 门/无增量 skip 的
 *    放行要退还额度，避免无效放行把每小时额度或单轮桶长期占死。
 *
 * 缺省（两个上限都 <=0）⇒ 放行一切且不记账，逐位等于加门之前的运行时行为。
 *
 * 持久化（2026-11-02 生产重启事故）：滑动窗口的 `runTimestamps` 必须跨重启保留，
 * 否则重启后 293 个 boot-recovery 会话会把 hourly 额度瞬间吃满（实际 0 条 L2 完成）。
 * 由调用方通过 {@link configureL2AdmissionPersistence} 注入文件路径；首次使用惰性加载；
 * `inFlight` 不落盘（进程死掉后恒为 0）。未配置任何上限时**完全不碰磁盘**。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decideL2Throttle, pruneL2RunTimestamps, type L2ThrottleDecision } from "./l2-gate.js";

export interface L2AdmissionLimits {
  /** 滑动 60 分钟内最多几次真实运行；缺省/<=0 = 不限。 */
  maxRunsPerHour?: number;
  /** 单轮（60s 桶）最多放行几个 session；缺省/<=0 = 不限。 */
  maxSessionsPerRound?: number;
  /** boot recovery 一次重挂会话数超过该值就打 WARN；缺省 50。 */
  bootRecoveryWarnSessions?: number;
}

export interface L2AdmissionSnapshot {
  /** 已结算的真实运行时间戳（窗口内的）。 */
  runTimestamps: number[];
  /** 已放行但尚未结算的运行数。 */
  inFlight: number;
  /** 当前轮已放行的 session 数。 */
  roundAdmitted: number;
  /** 当前轮起点（epoch ms；0 = 还没有轮次）。 */
  roundStartedAtMs: number;
}

interface LedgerState {
  runTimestamps: number[];
  inFlight: number;
  roundAdmitted: number;
  roundStartedAtMs: number;
}

const state: LedgerState = {
  runTimestamps: [],
  inFlight: 0,
  roundAdmitted: 0,
  roundStartedAtMs: 0,
};

/** 落盘格式版本（将来换格式时靠它迁移/拒读）。 */
const LEDGER_FILE_VERSION = 1;

/** 落盘路径（null/未配置 ⇒ 不读不写，逐位等于无持久化）。 */
let persistenceFilePath: string | null = null;
/** 本进程是否已经尝试过加载（文件缺失/损坏也算「试过」，不反复 warn）。 */
let persistenceLoaded = false;
/** 最近一次 admit 是否开启了门（两个上限任一 >0）——未开启时完全不碰磁盘。 */
let persistenceActive = false;
/** 上一次成功写盘的 JSON（内容未变则不重复写，避免 293 会话突发时白写）。 */
let lastPersistedJson: string | null = null;
/** warn 通道（worker 可注入 logger.warn；缺省 console.warn）。 */
let persistenceWarn: (message: string) => void = (message) => console.warn(message);

export interface L2AdmissionPersistenceOptions {
  /**
   * 账本文件路径；null / undefined = 关闭持久化。
   *
   * 约定：文件里只有 `{ version, runTimestamps }`，与账本同目录的调用方数据目录
   * （生产：`$TDAI_DATA_DIR/l2-admission.json`）。
   */
  filePath: string | null | undefined;
  /** 可选 warn 通道（缺省 console.warn）。 */
  warn?: (message: string) => void;
}

/**
 * 注入账本持久化路径（由调用方在构造 worker 时调用一次）。
 *
 * 惰性加载：这里**不读盘**，等第一次真的要用账本（admit）时再加载。切换路径视为
 * 换账本，内存里的旧时间戳会被清掉，避免把 A 文件的额度写进 B 文件。
 */
export function configureL2AdmissionPersistence(options: L2AdmissionPersistenceOptions): void {
  const nextPath = options.filePath ? path.resolve(options.filePath) : null;
  if (options.warn) persistenceWarn = options.warn;
  if (nextPath !== persistenceFilePath) {
    clearLedgerMemory();
    persistenceFilePath = nextPath;
  }
  persistenceLoaded = false;
  lastPersistedJson = null;
}

function clearLedgerMemory(): void {
  state.runTimestamps = [];
  state.inFlight = 0;
  state.roundAdmitted = 0;
  state.roundStartedAtMs = 0;
}

function serializeLedger(): string {
  return JSON.stringify({ version: LEDGER_FILE_VERSION, runTimestamps: state.runTimestamps });
}

/**
 * 首次使用时加载账本。文件缺失 = 首次部署（静默从空账本起）；JSON 损坏/不可读
 * ⇒ warn 后从空账本起。**任何情况下都不抛**——账本坏了不能连带把 L2 全停掉。
 */
function ensureLedgerLoaded(): void {
  if (!persistenceFilePath || persistenceLoaded) return;
  persistenceLoaded = true;

  const filePath = persistenceFilePath;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      persistenceWarn(
        `[l2-admission] ledger read failed (${filePath}): ${err instanceof Error ? err.message : String(err)}；` +
          `从空账本起（本进程内已消费额度不可恢复）`,
      );
    }
    return;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const timestamps = Array.isArray(parsed) ? parsed : (parsed as { runTimestamps?: unknown } | null)?.runTimestamps;
    if (!Array.isArray(timestamps)) throw new Error("runTimestamps 不是数组");
    state.runTimestamps = timestamps.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
    lastPersistedJson = serializeLedger();
  } catch (err) {
    state.runTimestamps = [];
    persistenceWarn(
      `[l2-admission] ledger parse failed (${filePath}): ${err instanceof Error ? err.message : String(err)}；` +
        `从空账本起（文件会在下一次放行时被覆盖）`,
    );
  }
}

/**
 * 原子落盘：写 `<file>.tmp` 再 rename（同目录 rename 在 Windows 上也是原子的）。
 * 失败只 warn，不影响放行语义。
 */
function persistLedger(): void {
  if (!persistenceActive || !persistenceFilePath) return;
  const json = serializeLedger();
  if (json === lastPersistedJson) return;

  const filePath = persistenceFilePath;
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, json, "utf8");
    renameSync(tmpPath, filePath);
    lastPersistedJson = json;
  } catch (err) {
    persistenceWarn(
      `[l2-admission] ledger persist failed (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 是否有任何一个上限 >0（两个都 <=0 ⇒ 门关闭，逐位等于加门之前）。 */
export function isL2AdmissionEnabled(limits: L2AdmissionLimits | undefined): boolean {
  return normalizeGateLimit(limits?.maxRunsPerHour) > 0 || normalizeGateLimit(limits?.maxSessionsPerRound) > 0;
}

/**
 * 申请一次 L2 运行额度（同步、原子）。
 *
 * 放行 ⇒ in-flight +1、本轮放行数 +1，调用方必须在执行结束（成功/失败/重投）
 * 后调用一次 {@link settleL2Run} 结算；拒绝 ⇒ 账本不变。
 */
export function admitL2Run(limits: L2AdmissionLimits | undefined, nowMs: number = Date.now()): L2ThrottleDecision {
  // 未配上限（门关着）⇒ 不读盘不写盘，逐位等于加门之前的行为。
  persistenceActive = isL2AdmissionEnabled(limits);
  if (persistenceActive) ensureLedgerLoaded();

  const decision = decideL2Throttle({
    maxRunsPerHour: limits?.maxRunsPerHour,
    maxSessionsPerRound: limits?.maxSessionsPerRound,
    runTimestamps: state.runTimestamps,
    inFlight: state.inFlight,
    roundAdmitted: state.roundAdmitted,
    roundStartedAtMs: state.roundStartedAtMs,
    nowMs,
  });

  // 决策里已经算过窗口剪枝/轮次滚动，这里把归一后的账本写回（拒绝时也要写回：
  // 过期时间戳和滚过的轮次必须被收敛，否则下一次判定会看到陈旧状态）。
  state.runTimestamps = pruneL2RunTimestamps(state.runTimestamps, nowMs);
  state.roundStartedAtMs = decision.roundStartedAtMs;
  state.roundAdmitted = decision.roundAdmitted;

  if (decision.admit) {
    state.roundAdmitted += 1;
    state.inFlight += 1;
  }
  // 拒绝时也要落盘：剪枝后的时间戳必须收敛（否则重启后又看到陈旧窗口）。
  persistLedger();
  return decision;
}

/**
 * 结算一次已放行的运行。
 *
 * @param isRealRun true = 真的消费了 records（占滑动窗口）；false = 被门 skip /
 *   无增量 / 执行前就重投（退还单轮额度，不占窗口）。
 */
export function settleL2Run(isRealRun: boolean, nowMs: number = Date.now()): void {
  if (state.inFlight > 0) state.inFlight -= 1;
  if (isRealRun) {
    state.runTimestamps = pruneL2RunTimestamps(state.runTimestamps, nowMs);
    state.runTimestamps.push(Math.floor(nowMs));
    persistLedger();
    return;
  }
  // 无效放行：退还本轮额度（窗口本来就没占，无需处理）
  state.roundAdmitted = Math.max(0, state.roundAdmitted - 1);
  persistLedger();
}

/** 只读快照（深拷贝，便于 /status 与测试断言）。 */
export function getL2AdmissionSnapshot(): L2AdmissionSnapshot {
  return {
    runTimestamps: [...state.runTimestamps],
    inFlight: state.inFlight,
    roundAdmitted: state.roundAdmitted,
    roundStartedAtMs: state.roundStartedAtMs,
  };
}

/**
 * 清空账本（测试隔离用；生产重启进程即天然清空）。
 *
 * 落盘路径保持不变，但把内存标记为「已加载」，避免下一次 admit 把磁盘上的旧账本
 * 又读回来；下一次真正落盘时用空账本覆盖文件。
 */
export function resetL2Admission(): void {
  clearLedgerMemory();
  persistenceLoaded = true;
  lastPersistedJson = null;
}

/**
 * boot recovery 告警行（生产 live 路径：server.ts 的 boot recovery 重挂之后）。
 *
 * 为什么要单独一个函数：manager 里那份 WARN 在生产上是死代码（生产 L2 不走
 * manager 定时器），而「这次重启会一次唤醒多少会话的 L2」正是 F2 要留的证据。
 * 只有真的超过阈值才返回文案，未超过返回 null（调用方据此决定是否 WARN）。
 */
export function bootRecoveryWarnLine(recoveredSessions: number, limits: L2AdmissionLimits | undefined): string | null {
  const threshold = normalizeGateLimit(limits?.bootRecoveryWarnSessions) || 50;
  const recovered = Number.isFinite(recoveredSessions) ? Math.max(0, Math.floor(recoveredSessions)) : 0;
  if (recovered <= threshold) return null;

  const maxRunsPerHour = normalizeGateLimit(limits?.maxRunsPerHour);
  const maxSessionsPerRound = normalizeGateLimit(limits?.maxSessionsPerRound);
  const runsText = maxRunsPerHour > 0 ? `${maxRunsPerHour} 次/小时` : "不限";
  const roundText = maxSessionsPerRound > 0 ? `${maxSessionsPerRound} 个/轮` : "不限";
  return (
    `[pipeline-v2] boot recovery re-armed ${recovered} session(s) > bootRecoveryWarnSessions=${threshold}；` +
    `F2 全局门 maxRunsPerHour=${maxRunsPerHour}（本次重启上限 ${runsText}）、` +
    `maxSessionsPerRound=${maxSessionsPerRound}（${roundText}）——多出的会话会被重挂 timer 排队，不会同一 tick 全放`
  );
}

/** 与 l2-gate.normalizeLimit 同口径（此处只需判「是否 >0」，不重复导出口径）。 */
function normalizeGateLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
