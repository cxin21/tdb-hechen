/**
 * StatefulPipelineManager — 基于 IStateBackend 的 Pipeline 调度器
 *
 * 需求 #8: Core 完全无状态化
 *
 * 与原 MemoryPipelineManager 保持相同的外部接口（L1/L2/L3 Runner、
 * notifyConversation、flushSession、destroy），但内部状态全部通过
 * IStateBackend 管理，不在进程内维护任何 Map/Timer/Queue。
 *
 * 当 IStateBackend 为 LocalStateBackend 时，行为与原版完全一致（单进程）。
 * 当 IStateBackend 为远程实现时，Core 完全无状态，支持多副本部署。
 *
 * 关键设计差异：
 * - notifyConversation → captureAtomic（原子递增 + 阈值判断 + 入队/设 Timer）
 * - L1/L2/L3 执行由外部 Worker 从 TaskQueue 消费（本模块只负责入队）
 * - Timer 过期检测由外部 Timer Scanner 负责（或 LocalStateBackend 内置 setTimeout）
 * - flushSession → enqueueTask(flush) 入队而非进程内直接执行
 */

import type { IStateBackend, TaskPayload } from "../core/state/types.js";
import type { PipelineSessionState as StatePipelineSessionState } from "../core/state/types.js";
import { buildPipelineTimerMember } from "../core/state/timer-member.js";
import type { PipelineSessionState as CheckpointPipelineSessionState } from "./checkpoint.js";
import { SessionFilter } from "./session-filter.js";
import { report } from "../core/report/reporter.js";
import { serializeTraceContext } from "../core/report/trace-propagation.js";

// ============================
// Types (兼容原 pipeline-manager.ts 导出)
// ============================

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface CapturedMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
}

export interface PipelineConfig {
  everyNConversations: number;
  enableWarmup: boolean;
  l1: { idleTimeoutSeconds: number };
  l2: {
    delayAfterL1Seconds: number;
    minIntervalSeconds: number;
    maxIntervalSeconds: number;
    sessionActiveWindowHours: number;
  };
}

export interface L1RunnerResult {
  processedCount?: number;
  /**
   * True iff there are still L0 rows past the cursor that this run did not
   * consume. See pipeline-manager.ts L1RunnerResult for the full semantics.
   * Currently only consumed by the standalone MemoryPipelineManager; the
   * service-mode worker pipeline (this class) does not yet honor this flag.
   * TODO: extend pipeline-worker to drain backlog via task re-enqueue.
   */
  hasMore?: boolean;
  /** True iff the over-fetch returned exactly 2N rows — drain via direct enqueue. */
  hasFullBacklog?: boolean;
}
export type L1Runner = (params: { sessionKey: string; msg: CapturedMessage[]; bg_msg: CapturedMessage[] }) => Promise<L1RunnerResult | void>;
export interface L2RunnerResult { latestCursor?: string; }
export type L2Runner = (sessionKey: string, cursor?: string) => Promise<L2RunnerResult | void>;
export type L3Runner = () => Promise<void>;
export type PipelineStatePersister = (states: Record<string, CheckpointPipelineSessionState>) => Promise<void>;

const TAG = "[memory-tdai] [pipeline-v2]";

// ============================
// StatefulPipelineManager
// ============================

export class StatefulPipelineManager {
  private readonly l1IdleTimeoutMs: number;
  private readonly everyNConversations: number;
  private readonly enableWarmup: boolean;
  private readonly l2DelayAfterL1Ms: number;
  private readonly l2MinIntervalMs: number;
  private readonly l2MaxIntervalMs: number;
  private readonly sessionActiveWindowMs: number;

  private readonly stateBackend: IStateBackend;
  /** 默认 instanceId（standalone 模式/checkpoint 恢复用）。service 模式下每次调用显式传入。 */
  private readonly defaultInstanceId: string;
  private readonly sessionFilter: SessionFilter;
  private logger: Logger | undefined;

  // Callbacks (same interface as MemoryPipelineManager)
  private l1Runner: L1Runner | null = null;
  private l2Runner: L2Runner | null = null;
  private l3Runner: L3Runner | null = null;
  private persister: PipelineStatePersister | null = null;

  private destroyed = false;

  /** Tracks instanceIds that have had pipeline activity (for Timer Scanner). */
  private readonly _activeInstances = new Set<string>();

  constructor(
    config: PipelineConfig,
    stateBackend: IStateBackend,
    instanceId: string,
    logger?: Logger,
    sessionFilter?: SessionFilter,
  ) {
    this.l1IdleTimeoutMs = config.l1.idleTimeoutSeconds * 1000;
    this.everyNConversations = config.everyNConversations;
    this.enableWarmup = config.enableWarmup;
    this.l2DelayAfterL1Ms = config.l2.delayAfterL1Seconds * 1000;
    this.l2MinIntervalMs = config.l2.minIntervalSeconds * 1000;
    this.l2MaxIntervalMs = config.l2.maxIntervalSeconds * 1000;
    this.sessionActiveWindowMs = config.l2.sessionActiveWindowHours * 60 * 60 * 1000;
    this.stateBackend = stateBackend;
    this.defaultInstanceId = instanceId;
    this.logger = logger;
    this.sessionFilter = sessionFilter ?? new SessionFilter();

    this.logger?.debug?.(
      `${TAG} Initialized: defaultInstance=${instanceId}, everyN=${config.everyNConversations}, ` +
      `warmup=${config.enableWarmup}, l1Idle=${config.l1.idleTimeoutSeconds}s`,
    );
  }

  // ============================
  // Setup (兼容原接口)
  // ============================

  setL1Runner(runner: L1Runner): void { this.l1Runner = runner; }
  setL2Runner(runner: L2Runner): void { this.l2Runner = runner; }
  setL3Runner(runner: L3Runner): void { this.l3Runner = runner; }
  setPersister(persister: PipelineStatePersister): void { this.persister = persister; }

  /**
   * Start: 恢复 checkpoint 状态到 IStateBackend
   * LocalStateBackend 场景下等价于原 MemoryPipelineManager.start()
   */
  async start(restoredStates?: Record<string, CheckpointPipelineSessionState>): Promise<void> {
    if (this.destroyed) return;

    if (restoredStates) {
      let restored = 0;
      for (const [sessionKey, state] of Object.entries(restoredStates)) {
        if (this.sessionFilter.shouldSkip(sessionKey)) continue;

        await this.stateBackend.updateSessionState(this.defaultInstanceId, sessionKey, {
          conversation_count: state.conversation_count,
          last_active_time: state.last_active_time,
          l2_pending_l1_count: state.l2_pending_l1_count,
          warmup_threshold: state.warmup_threshold ?? 0,
          last_extraction_time: state.last_extraction_time,
          last_extraction_updated_time: state.last_extraction_updated_time,
          l2_last_extraction_time: state.l2_last_extraction_time,
        });
        restored++;
      }
      this.logger?.info(`${TAG} Restored ${restored} session state(s) to StateBackend`);
    }

    this.logger?.info(`${TAG} Pipeline started (backend=${this.stateBackend.constructor.name})`);
  }

  // ============================
  // L0→L1: Notify (called from auto-capture)
  // ============================

  async notifyConversation(
    sessionKey: string,
    _messages: CapturedMessage[],
    instanceId?: string,
    rounds?: number,
    teamId?: string,
    agentId?: string,
  ): Promise<void> {
    if (this.destroyed) return;
    if (this.sessionFilter.shouldSkip(sessionKey)) return;

    const effectiveInstanceId = instanceId ?? this.defaultInstanceId;
    if (effectiveInstanceId === "__unset__") {
      throw new Error(`[pipeline-v2] notifyConversation called without explicit instanceId (session=${sessionKey}, got="${effectiveInstanceId}"). In service mode, instanceId must be provided.`);
    }
    const effectiveRounds = rounds ?? 1;
    this._activeInstances.add(effectiveInstanceId);
    const now = Date.now();
    const state = await this.stateBackend.getSessionState(effectiveInstanceId, sessionKey, teamId, agentId);
    const warmupThreshold = this.getEffectiveThreshold(state?.warmup_threshold ?? (this.enableWarmup ? 1 : 0));

    const taskPayload: TaskPayload = {
      id: `L1-${sessionKey}-${now}`,
      type: "L1",
      instanceId: effectiveInstanceId,
      sessionId: sessionKey,
      teamId,
      agentId,
      priority: 0,
      data: { instanceId: effectiveInstanceId, teamId, agentId, ...serializeTraceContext() },
      createdAt: now,
    };

    const result = await this.stateBackend.captureAtomic({
      instanceId: effectiveInstanceId,
      sessionId: sessionKey,
      teamId,
      agentId,
      // 实际消息已持久化到 Store；这里只原子计数，不再写无用 Buffer 占位符。
      threshold: warmupThreshold,
      fireAtMs: now + this.l1IdleTimeoutMs,
      timerMember: buildPipelineTimerMember(sessionKey, "L1_idle", { teamId, agentId }),
      taskPayload,
      nowMs: now,
      rounds: effectiveRounds,
    });

    if (result.triggered) {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] Threshold reached (${warmupThreshold}), L1 task enqueued`,
      );
      report("pipeline_l1_trigger", {
        sessionKey,
        triggerReason: "threshold",
        conversationCount: warmupThreshold,
        bufferedMessageCount: 0,
      });

      // 推进 warmup 阈值
      await this.advanceWarmupInBackend(sessionKey, state?.warmup_threshold ?? 1, teamId, agentId);
    } else {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] count=${result.conversationCount}/${warmupThreshold}, L1 idle timer set`,
      );
    }
  }

  // ============================
  // Session End
  // ============================

  async flushSession(sessionKey: string, instanceId?: string, teamId?: string, agentId?: string): Promise<void> {
    if (this.destroyed) return;
    if (this.sessionFilter.shouldSkip(sessionKey)) return;

    const effectiveInstanceId = instanceId ?? this.defaultInstanceId;
    if (effectiveInstanceId === "__unset__") {
      this.logger?.error?.(`${TAG} flushSession called without explicit instanceId (session=${sessionKey})`);
      return;
    }
    const state = await this.stateBackend.getSessionState(effectiveInstanceId, sessionKey, teamId, agentId);
    if (!state || state.conversation_count === 0) {
      this.logger?.debug?.(`${TAG} [${sessionKey}] flushSession: nothing to flush`);
      return;
    }

    // 取消 idle timer
    await this.stateBackend.removeTimer(effectiveInstanceId, buildPipelineTimerMember(sessionKey, "L1_idle", { teamId, agentId }));

    // 入队 flush task
    await this.stateBackend.enqueueTask({
      id: `flush-${sessionKey}-${Date.now()}`,
      type: "flush",
      instanceId: effectiveInstanceId,
      sessionId: sessionKey,
      teamId,
      agentId,
      priority: 0,
      data: { instanceId: effectiveInstanceId, teamId, agentId },
      createdAt: Date.now(),
    });

    this.logger?.debug?.(`${TAG} [${sessionKey}] flushSession: flush task enqueued`);
  }

  // ============================
  // Destroy
  // ============================

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // 持久化当前状态（用于 LocalStateBackend 场景的 checkpoint 兼容）
    await this.persistCurrentStates();

    this.logger?.info(`${TAG} Pipeline destroyed`);
  }

  // ============================
  // L2 Timer 推进 (供 Worker 在 L1 完成后调用)
  // ============================

  /**
   * L1 完成后推进 L2 timer（由 Worker 调用）
   */
  async advanceL2TimerAfterL1(sessionKey: string, instanceId?: string, teamId?: string, agentId?: string): Promise<void> {
    if (this.destroyed) return;

    const effectiveId = instanceId ?? this.defaultInstanceId;
    if (effectiveId === "__unset__") {
      this.logger?.error?.(`${TAG} advanceL2TimerAfterL1 called without explicit instanceId (session=${sessionKey})`);
      return;
    }
    const now = Date.now();
    const state = await this.stateBackend.getSessionState(effectiveId, sessionKey, teamId, agentId);
    const lastL2 = state?.l2_last_extraction_time
      ? new Date(state.l2_last_extraction_time).getTime()
      : 0;
    const minIntervalFloor = lastL2 > 0 ? lastL2 + this.l2MinIntervalMs : 0;
    const desiredTime = Math.max(now + this.l2DelayAfterL1Ms, minIntervalFloor);

    const advanced = await this.stateBackend.setTimerIfEarlier(
      effectiveId,
      buildPipelineTimerMember(sessionKey, "L2_schedule", { teamId, agentId }),
      desiredTime,
    );

    if (advanced) {
      this.logger?.debug?.(
        `${TAG} [${effectiveId}/${sessionKey}] L2 timer advanced: firing in ${Math.round((desiredTime - now) / 1000)}s`,
      );
    }
  }

  /**
   * L2 完成后设置 maxInterval timer（由 Worker 调用）
   */
  async armL2MaxInterval(sessionKey: string, instanceId?: string, teamId?: string, agentId?: string): Promise<void> {
    // teamId/agentId 只进入 timer member 值，不进入 Redis timer ZSET key；Lua 仍是单 key，避免 CROSSSLOT。
    if (this.destroyed) return;
    const effectiveId = instanceId ?? this.defaultInstanceId;
    if (effectiveId === "__unset__") {
      this.logger?.error?.(`${TAG} armL2MaxInterval called without explicit instanceId (session=${sessionKey})`);
      return;
    }
    await this.stateBackend.setTimer(
      effectiveId,
      `${sessionKey}:L2_schedule`,
      Date.now() + this.l2MaxIntervalMs,
    );
  }

  // ============================
  // L0 backlog drain (called by Worker after L1 completes)
  // ============================

  /**
   * Enqueue another L1 task immediately for `sessionKey` to drain a known
   * large backlog. Called by the Worker's executor when `runL1WithStore`
   * returns `hasFullBacklog=true` (i.e. the over-fetch returned a full page,
   * indicating many more L0 rows past the cursor).
   *
   * Mirrors the standalone `MemoryPipelineManager.enqueueL1` "idle_timeout"
   * path so both deployment modes behave identically. We do NOT mark the
   * task with `triggeredBy: "drain"` — drain enqueues should pass the same
   * dedup checks as threshold-triggered tasks.
   */
  async enqueueL1Drain(sessionKey: string, instanceId?: string, teamId?: string, agentId?: string): Promise<void> {
    if (this.destroyed) return;
    const effectiveId = instanceId ?? this.defaultInstanceId;
    if (effectiveId === "__unset__") {
      this.logger?.error?.(`${TAG} enqueueL1Drain called without explicit instanceId (session=${sessionKey})`);
      return;
    }
    const now = Date.now();
    await this.stateBackend.enqueueTask({
      id: `L1-drain-${sessionKey}-${now}`,
      type: "L1",
      instanceId: effectiveId,
      sessionId: sessionKey,
      teamId,
      agentId,
      priority: 0,
      data: { instanceId: effectiveId, teamId, agentId, ...serializeTraceContext() },
      createdAt: now,
    });
    this.logger?.debug?.(
      `${TAG} [${effectiveId}/${sessionKey}] L1 drain task enqueued (full backlog)`,
    );
  }

  /**
   * Arm the L1 drain timer to consume a known small tail of L0 rows. Called by
   * the Worker's executor when `runL1WithStore` returns `hasMore=true` but
   * not `hasFullBacklog` (i.e. < 2N rows residual; cheap to defer).
   *
   * v4#5（2026-09-16）：timer member 用独立的 `L1_drain` 后缀，不再复用 `L1_idle`。
   * 定时器到期入队的任务带 `triggeredBy=timer_scanner`，而 executor 会把
   * `conversation_count===0` 的 timer 任务当"已处理完"跳过——续批场景下 count
   * 恰恰几乎总是 0（阈值触发后已清零），复用 L1_idle 曾使游标尾段被该去重
   * 永久饿死（session-e 实锤，见 REG-REMAINING-004 #5）。L1_drain 成员在
   * executor 的 isDrainTimer 豁免面内；任务本身由游标治理：无积压时空跑即
   * 返回（零 LLM 成本），有积压则逐批续跑收敛。
   */
  async armL1IdleAfterDrain(sessionKey: string, instanceId?: string, teamId?: string, agentId?: string): Promise<void> {
    if (this.destroyed) return;
    const effectiveId = instanceId ?? this.defaultInstanceId;
    if (effectiveId === "__unset__") {
      this.logger?.error?.(`${TAG} armL1IdleAfterDrain called without explicit instanceId (session=${sessionKey})`);
      return;
    }
    const fireAtMs = Date.now() + this.l1IdleTimeoutMs;
    // Use `setTimerIfEarlier` so a notifyConversation-armed earlier timer wins.
    // If no timer is pending, this sets it unconditionally.
    await this.stateBackend.setTimerIfEarlier(
      effectiveId,
      buildPipelineTimerMember(sessionKey, "L1_drain", { teamId, agentId }),
      fireAtMs,
    );
    this.logger?.debug?.(
      `${TAG} [${effectiveId}/${sessionKey}] L1 drain timer armed (fires in ${Math.round(this.l1IdleTimeoutMs / 1000)}s)`,
    );
  }

  // ============================
  // Boot recovery（v4#5：重启后恢复待提取队列）
  // ============================

  /**
   * Re-arm a drain timer per checkpointed session after a process restart.
   *
   * LocalStateBackend 的 conversation_count 与 L1_idle timer 全在进程内，重启即失；
   * 且 gateway 路径从不把 checkpoint 状态恢复回 backend（setStatefulPipelineManager
   * 把 ensureSchedulerStarted 变 no-op，start() 无调用方）。重启前已捕获、尚未
   * 过阈值的会话在无新消息时将永久滞留（session-e 实锤：游标停在提取窗口第 10
   * 条，尾段 2 条十几小时无消费——REG-REMAINING-004 #5）。
   *
   * 每个会话键挂一枚 `L1_drain` 定时器（闲置超时后到期）：到期 L1 任务由游标
   * 治理——无积压时空跑即返回（零 LLM 成本），有积压则续批收敛（hasMore →
   * 再次续批 / hasFullBacklog → 立即重入队）。调用方传 checkpoint
   * `runner_states` 的会话键集合（游标所在，唯一可靠的"哪些会话在管线里"清单；
   * pipeline_states 在 disk 上恒空——本类无运行时 persister）。
   *
   * service 模式（defaultInstanceId="__unset__"）无法定位 per-instance 定时器键，
   * 跳过（standalone 单机部署为主场景）。
   *
   * @returns armed timer count
   */
  async recoverPendingSessions(sessionKeys: readonly string[]): Promise<number> {
    if (this.destroyed) return 0;
    if (this.defaultInstanceId === "__unset__") {
      this.logger?.debug?.(`${TAG} recoverPendingSessions skipped: service mode requires explicit instanceId`);
      return 0;
    }
    const fireAtMs = Date.now() + this.l1IdleTimeoutMs;
    let armed = 0;
    for (const sessionKey of sessionKeys) {
      if (this.sessionFilter.shouldSkip(sessionKey)) continue;
      try {
        await this.stateBackend.setTimerIfEarlier(
          this.defaultInstanceId,
          buildPipelineTimerMember(sessionKey, "L1_drain"),
          fireAtMs,
        );
        armed++;
      } catch (err) {
        this.logger?.warn?.(
          `${TAG} recoverPendingSessions: failed to arm drain timer for ${sessionKey}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (armed > 0) {
      this.logger?.info?.(
        `${TAG} Boot recovery: armed L1_drain timer(s) for ${armed} checkpointed session(s) ` +
        `(fires in ${Math.round(this.l1IdleTimeoutMs / 1000)}s)`,
      );
    }
    return armed;
  }

  // ============================
  // Accessors (兼容原接口)
  // ============================

  /** Returns all instanceIds that have had pipeline activity. */
  getActiveInstances(): string[] {
    return [...this._activeInstances];
  }

  async getSessionState(sessionKey: string): Promise<CheckpointPipelineSessionState | undefined> {
    const state = await this.stateBackend.getSessionState(this.defaultInstanceId, sessionKey);
    if (!state) return undefined;
    return {
      conversation_count: state.conversation_count,
      last_extraction_time: state.last_extraction_time,
      last_extraction_updated_time: state.last_extraction_updated_time,
      last_active_time: state.last_active_time,
      l2_pending_l1_count: state.l2_pending_l1_count,
      warmup_threshold: state.warmup_threshold,
      l2_last_extraction_time: state.l2_last_extraction_time,
    };
  }

  getL1Runner(): L1Runner | null { return this.l1Runner; }
  getL2Runner(): L2Runner | null { return this.l2Runner; }
  getL3Runner(): L3Runner | null { return this.l3Runner; }

  get isDestroyed(): boolean { return this.destroyed; }

  // ============================
  // Internal helpers
  // ============================

  private getEffectiveThreshold(warmupThreshold: number): number {
    if (!this.enableWarmup) return this.everyNConversations;
    if (warmupThreshold <= 0) return this.everyNConversations;
    return Math.min(warmupThreshold, this.everyNConversations);
  }

  private async advanceWarmupInBackend(sessionKey: string, currentThreshold: number, teamId?: string, agentId?: string): Promise<void> {
    if (!this.enableWarmup || currentThreshold <= 0) return;

    const next = currentThreshold * 2;
    const newThreshold = next >= this.everyNConversations ? 0 : next;
    await this.stateBackend.updateSessionState(this.defaultInstanceId, sessionKey, {
      warmup_threshold: newThreshold,
      conversation_count: 0, // reset after L1 trigger
    }, teamId, agentId);

    this.logger?.debug?.(
      `${TAG} [${sessionKey}] Warmup ${newThreshold === 0 ? "graduated" : `advanced → ${newThreshold}`}`,
    );
  }

  private async persistCurrentStates(): Promise<void> {
    if (!this.persister) return;

    try {
      const sessions = await this.stateBackend.listActiveSessions(this.defaultInstanceId);
      const states: Record<string, CheckpointPipelineSessionState> = {};

      for (const sessionId of sessions) {
        const state = await this.stateBackend.getSessionState(this.defaultInstanceId, sessionId);
        if (state) {
          states[sessionId] = {
            conversation_count: state.conversation_count,
            last_extraction_time: state.last_extraction_time,
            last_extraction_updated_time: state.last_extraction_updated_time,
            last_active_time: state.last_active_time,
            l2_pending_l1_count: state.l2_pending_l1_count,
            warmup_threshold: state.warmup_threshold,
            l2_last_extraction_time: state.l2_last_extraction_time,
          };
        }
      }

      await this.persister(states);
      this.logger?.debug?.(`${TAG} Persisted ${Object.keys(states).length} session states`);
    } catch (err) {
      this.logger?.error(`${TAG} Failed to persist states: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
