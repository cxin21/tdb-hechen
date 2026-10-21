import { log } from "../report/log.js";

/**
 * #83 哨兵（log-only，零行为影响）：5 分钟滚动窗双指标。
 *  ① recall 空响应率：/v3/recall 返回空块占比 >0.8 且样本 ≥10 → 告警
 *     （#74 剥噪硬门把纯噪 query 整条 skip 时核心也返回空块 —— 该指标是
 *      「query 源头是否还在喂噪声」的自诊断信号）。
 *  ② turnIntent 缺失率：活跃会话（≥3 个 turn）turnIntent 全缺失 → 告警
 *     （分类器漏判 / 新 harness 形态漏网的兜底观测）。
 * 红线：只打日志，不改任何注入/捕获行为。
 */

const WINDOW_MS = 5 * 60 * 1000;
const EMPTY_RATE_THRESHOLD = 0.8;
const EMPTY_MIN_SAMPLES = 10;
const INTENT_MIN_TURNS = 3;
const RECALL_SAMPLE_CAP = 500;

interface RecallSample { at: number; empty: boolean }
interface IntentSample { at: number; present: boolean }

const recallSamples: RecallSample[] = [];
const intentBySession = new Map<string, IntentSample[]>();
/** 告警冷却（同窗口内同指标只告警一次） */
const intentWarnedAt = new Map<string, number>();
let emptyWarnedAt = 0;

function prune<T extends { at: number }>(arr: T[], now: number): T[] {
  const cut = now - WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i].at < cut) i++;
  return i > 0 ? arr.slice(i) : arr;
}

/** 每次 /v3/recall 主链路返回（非降级）后采样：mergedChain 是否为空数组 */
export function recordRecallOutcome(emptyBlock: boolean): void {
  const now = Date.now();
  const kept = prune(recallSamples, now);
  recallSamples.length = 0;
  recallSamples.push(...kept, { at: now, empty: emptyBlock });
  if (recallSamples.length > RECALL_SAMPLE_CAP) {
    recallSamples.splice(0, recallSamples.length - RECALL_SAMPLE_CAP);
  }
  if (recallSamples.length >= EMPTY_MIN_SAMPLES) {
    const emptyCount = recallSamples.filter((s) => s.empty).length;
    if (emptyCount / recallSamples.length > EMPTY_RATE_THRESHOLD && now - emptyWarnedAt > WINDOW_MS) {
      emptyWarnedAt = now;
      log.warn(
        `[tdai-sentinel][RECALL-EMPTY] recall empty-block rate ${emptyCount}/${recallSamples.length} > ${EMPTY_RATE_THRESHOLD} in ${Math.round(WINDOW_MS / 60000)}min window — query source is likely feeding scaffold noise (check tdai.memory.recallQuerySource / handler wiring)`,
      );
    }
  }
}

/** handler 入口分类后采样：本轮 turnIntent 是否存在 */
export function recordTurnIntentPresence(sessionKey: string, present: boolean): void {
  const now = Date.now();
  const arr = prune(intentBySession.get(sessionKey) ?? [], now);
  arr.push({ at: now, present });
  intentBySession.set(sessionKey, arr);
  if (arr.length >= INTENT_MIN_TURNS && arr.every((s) => !s.present)) {
    const last = intentWarnedAt.get(sessionKey) ?? 0;
    if (now - last > WINDOW_MS) {
      intentWarnedAt.set(sessionKey, now);
      log.warn(
        `[tdai-sentinel][INTENT-MISSING] session=${sessionKey || "(unknown)"} ${arr.length} consecutive turns with no turnIntent — classifier may be missing real user messages (new harness scaffold shape?)`,
      );
    }
  }
}

// ── Me1（审查 4544dc9d，2026-10-22）：injector 注释宣称 turnContext 缺失有哨兵+loud
// 日志兜底，实现无 else 静默回落 legacy。补限频 warn（每会话 60s 一次）让
// 「档位已开但 handler 未接线」可观测、防静默——log-only，零行为影响。
const TURN_CTX_WARN_COOLDOWN_MS = 60_000;
const turnCtxWarnedAt = new Map<string, number>();

/** injector 三档非 legacy 但 turnContext 缺失（handler 未接线/旧渠道）时限频告警 */
export function warnTurnContextMissing(sessionKey: string, querySource: string): void {
  const now = Date.now();
  const last = turnCtxWarnedAt.get(sessionKey) ?? 0;
  if (now - last < TURN_CTX_WARN_COOLDOWN_MS) return;
  turnCtxWarnedAt.set(sessionKey, now);
  log.warn("dsh-recall-turn-context-missing", {
    session: sessionKey || "(unknown)",
    querySource,
    note: "handler did not wire tdaiTurnContext — silently falling back to legacy query (channel wiring gap?)",
  });
}

/** 测试隔离用：清空限频状态（生产代码勿调） */
export function __resetTurnContextWarnForTests(): void {
  turnCtxWarnedAt.clear();
}
