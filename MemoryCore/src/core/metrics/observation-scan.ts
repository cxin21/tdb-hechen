/**
 * P7/观察窗（2026-11-02）：生产证据读数的**纯函数**层。
 *
 * 三层数据源各有一份"掌故"（日志标记、journal 门、scene 块字节），纯函数在这里
 * 统一成可测试的读数，CLI（scripts/memory-observation.ts）只负责 I/O。
 *
 * 纪律：缺省值不用 0 冒充"没跑"——均值/分位数无样本时返回 null。
 */

/** A1：L2 任务完成的日志标记（pipeline-worker）。 */
const RE_L2_COMPLETED = /Task completed: L2\b/;
/**
 * A1：L2 门拦截标记（2026-11-02 新增）。两种形态都要数：
 *  - pipeline-factory 的 `[L2] Gate skipped (l2-gate): pending=…`（门在执行前拦下，生产实测走这条）
 *  - pipeline-manager 的 `L2 gate-skip: keep l2_last_extraction_time unchanged (pending=…)`
 * 只数其中一种会得到"门从没拦过"的假读数。
 */
const RE_L2_GATE_SKIP = /L2 gate-skip:|Gate skipped \(l2-gate\)/;
/**
 * F2：全局节流拦截标记（pipeline-manager，见 l2-gate.ts 的 L2_THROTTLE_SKIP_REASON）。
 * 节流行同样带 `L2 gate-skip` 字样，必须单独一门：混在一起会把「这个会话还没攒够
 * 记忆」读成「全局节流拦了多少」，反之亦然。扫描时先判 throttle，命中即不再计入 l2GateSkips。
 */
const RE_L2_THROTTLE_SKIP = /L2 gate-skip \(reason=l2-throttle\):/;
/** A1：L2 调度器入队（跑了多少次；"完成"标记只覆盖成功路径，会漏 skip）。 */
const RE_L2_ENQUEUED = /enqueued L2 task/;
/** A1：L2 因候选全失效而跳过（未写块）。 */
const RE_L2_SKIP_INVALIDATED = /All new records invalidated — skipping scene extraction/;
/** A1：L2 真写了场景块（derived_from 边统计行）。 */
const RE_L2_EXTRACTED = /\[L2\] derived_from edges:/;
/** B4：dedup 前置门槛读数（l1-extractor）。 */
const RE_DEDUP = /dedup prefilter: prefiltered=(\d+) llmCalls=(\d+) of (\d+)/;
/** B1：巩固运行读数（consolidation-worker）。 */
// 2026-11-02 起收口行多一个 skippedUnchanged=（源集合指纹跳过）；旧正则要求
// persisted=N (sources= 紧邻，会被新格式打断 ⇒ B1 读数静默归零。故该段设为可选，
// 旧日志（无该字段）仍解析，且不用 0 冒充（字段留 undefined）。
const RE_CONSOL =
  /\[consolidation\] ran: groups=(\d+), summaries=(\d+), persisted=(\d+)(?:, skippedUnchanged=(\d+))? \(sources=(\d+)\)/;

export interface DedupBatch {
  prefiltered: number;
  llmCalls: number;
  total: number;
}

export interface ConsolidationRun {
  groups: number;
  summaries: number;
  persisted: number;
  /** 源集合指纹未变而跳过的组数；旧日志无该字段时为 undefined（不冒充 0）。 */
  skippedUnchanged?: number;
  sources: number;
}

export interface LogObservation {
  l2Completed: number;
  /** A1 每会话门拦截次数（不含全局节流）。 */
  l2GateSkips: number;
  /** F2 全局节流拦截次数（与 l2GateSkips 互斥，不重复计）。 */
  l2ThrottleSkips: number;
  l2Enqueued: number;
  l2SkippedInvalidated: number;
  l2Extracted: number;
  dedupBatches: DedupBatch[];
  consolidationRuns: ConsolidationRun[];
}

/** 日志行首时间戳（含毫秒/偏移/Z）。取整行前缀，避免截断偏移串把窗口筛空。 */
const RE_LINE_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:[+-]\d{2}:\d{2}|Z)?)/;

/**
 * 解析日志行首时间戳；无时间戳返回 NaN（调用方据此跳过，不猜）。
 * 2026-11-02 实测坑：此前调用方 slice(0,25) 把 "+08:00" 截成 "+08:0"，Date.parse 返 NaN，
 * 结果整个 24h 窗口的 A1 读数全为 0。
 */
export function parseLogTimestamp(line: string): number {
  const m = RE_LINE_TS.exec(line);
  if (!m) return Number.NaN;
  return Date.parse(m[1]!);
}

/** 逐行扫描日志文本（不解析时间戳；窗口筛选由调用方做）。 */
export function scanLogLines(lines: readonly string[]): LogObservation {
  const out: LogObservation = {
    l2Completed: 0,
    l2GateSkips: 0,
    l2ThrottleSkips: 0,
    l2Enqueued: 0,
    l2SkippedInvalidated: 0,
    l2Extracted: 0,
    dedupBatches: [],
    consolidationRuns: [],
  };
  for (const line of lines) {
    if (typeof line !== "string") continue;
    if (RE_L2_COMPLETED.test(line)) out.l2Completed += 1;
    if (RE_L2_THROTTLE_SKIP.test(line)) out.l2ThrottleSkips += 1;
    else if (RE_L2_GATE_SKIP.test(line)) out.l2GateSkips += 1;
    if (RE_L2_ENQUEUED.test(line)) out.l2Enqueued += 1;
    if (RE_L2_SKIP_INVALIDATED.test(line)) out.l2SkippedInvalidated += 1;
    if (RE_L2_EXTRACTED.test(line)) out.l2Extracted += 1;
    const dedup = RE_DEDUP.exec(line);
    if (dedup) {
      out.dedupBatches.push({
        prefiltered: Number(dedup[1]),
        llmCalls: Number(dedup[2]),
        total: Number(dedup[3]),
      });
    }
    const consol = RE_CONSOL.exec(line);
    if (consol) {
      out.consolidationRuns.push({
        groups: Number(consol[1]),
        summaries: Number(consol[2]),
        persisted: Number(consol[3]),
        ...(consol[4] === undefined ? {} : { skippedUnchanged: Number(consol[4]) }),
        sources: Number(consol[5]),
      });
    }
  }
  return out;
}

export interface DedupAggregate {
  batches: number;
  prefiltered: number;
  llmCalls: number;
  candidateTotal: number;
  /** 零批 => null（"没跑"不能读成"跑得很省"）。 */
  meanLlmCallsPerBatch: number | null;
}

export function aggregateDedupBatches(batches: readonly DedupBatch[]): DedupAggregate {
  let prefiltered = 0;
  let llmCalls = 0;
  let candidateTotal = 0;
  for (const b of batches) {
    prefiltered += safeNumber(b.prefiltered);
    llmCalls += safeNumber(b.llmCalls);
    candidateTotal += safeNumber(b.total);
  }
  const n = batches.length;
  return {
    batches: n,
    prefiltered,
    llmCalls,
    candidateTotal,
    meanLlmCallsPerBatch: n > 0 ? round3(llmCalls / n) : null,
  };
}

export interface SceneSizeSummary {
  files: number;
  totalBytes: number;
  maxBytes: number;
  p50Bytes: number | null;
}

/** B3：scene 块文件大小读数（非有限值直接忽略，不参与计数）。 */
export function summarizeSceneSizes(sizes: readonly number[]): SceneSizeSummary {
  const clean = sizes.filter((n) => Number.isFinite(n) && n >= 0).map((n) => Math.trunc(n));
  if (clean.length === 0) return { files: 0, totalBytes: 0, maxBytes: 0, p50Bytes: null };
  const sorted = [...clean].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    files: sorted.length,
    totalBytes: total,
    maxBytes: sorted[sorted.length - 1]!,
    p50Bytes: sorted[Math.floor((sorted.length - 1) / 2)]!,
  };
}

export interface JournalGateEntry {
  gates?: unknown;
}

export interface JournalGateSummary {
  rounds: number;
  roundsWithValidity: number;
  validityActive: number;
  validityExpired: number;
  validityFuture: number;
  /** 池口径（截断前全池）里被判失效的行数——诊断用，不等于"少注入多少行"。 */
  validityDropped: number;
  /** F7（2026-11-02）：截断后候选（maxResults）里失效的行数。 */
  validityTopDropped: number;
  /** F7：最终注入集里失效的行数（= 真被过滤掉、注入变少的行数）。 */
  validityInjectedDropped: number;
  validityEndFiltered: number;
  roundsWithSelfNarration: number;
  selfNarrationScanned: number;
  selfNarrationDropped: number;
}

/** B2/A3：journal gates 读数（只对出现过的门求和；未出现的门计 0，轮次数分开记）。 */
export function summarizeJournalGates(entries: readonly JournalGateEntry[]): JournalGateSummary {
  const out: JournalGateSummary = {
    rounds: entries.length,
    roundsWithValidity: 0,
    validityActive: 0,
    validityExpired: 0,
    validityFuture: 0,
    validityDropped: 0,
    validityTopDropped: 0,
    validityInjectedDropped: 0,
    validityEndFiltered: 0,
    roundsWithSelfNarration: 0,
    selfNarrationScanned: 0,
    selfNarrationDropped: 0,
  };
  for (const entry of entries) {
    const gates = asRecord(entry?.gates);
    if (!gates) continue;
    const validity = asRecord(gates.validity);
    if (validity) {
      out.roundsWithValidity += 1;
      // F7（2026-11-02）起 gates.validity 是三层结构 {mode,pool,top,injected}。
      // 旧 journal 行（≤ 2026-11-02 前）是扁平 {active,expired,future,dropped}——
      // 观测要跨新旧文件连续读数，所以两条路都读，分不清也不静默当成 0。
      const pool = asRecord(validity.pool);
      if (pool) {
        out.validityActive += safeNumber(pool.active);
        out.validityExpired += safeNumber(pool.expired);
        out.validityFuture += safeNumber(pool.future);
        out.validityDropped += safeNumber(pool.dropped);
        const top = asRecord(validity.top);
        const injected = asRecord(validity.injected);
        if (top) out.validityTopDropped += safeNumber(top.dropped);
        if (injected) out.validityInjectedDropped += safeNumber(injected.dropped);
      } else {
        out.validityActive += safeNumber(validity.active);
        out.validityExpired += safeNumber(validity.expired);
        out.validityFuture += safeNumber(validity.future);
        out.validityDropped += safeNumber(validity.dropped);
      }
      out.validityEndFiltered += safeNumber(validity.validEndFiltered);
    }
    const selfNarration = asRecord(gates.selfNarration);
    if (selfNarration) {
      out.roundsWithSelfNarration += 1;
      out.selfNarrationScanned += safeNumber(selfNarration.scanned);
      out.selfNarrationDropped += safeNumber(selfNarration.dropped);
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
