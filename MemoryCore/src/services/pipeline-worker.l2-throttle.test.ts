/**
 * F2 · 全局速率门落在**生产真实链路**的 RED 套件。
 *
 * 生产的 L2 是 state-backend timer 直接 enqueue 的 task，由 pipeline-worker 消费；
 * 门必须放在 worker 的 **抢锁之前**，否则被拦的会话仍然排队等 agent 级锁
 * （事故里 253 个 L2 任务共抢一把锁，4 小时 44047 条 lock conflict）。
 *
 * 语义：
 *  - 拦下 ⇒ 不抢锁、不执行、不写 session state，重挂 L2_schedule timer、ACK 本条消息；
 *  - 被 A1 门/无增量 skip 的放行 ⇒ 退还额度（不占窗口）；
 *  - 缺省（两个上限都 <=0）⇒ 逐位等于加门之前。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect, beforeEach } from "vitest";
import { PipelineWorker } from "./pipeline-worker.js";
import {
  configureL2AdmissionPersistence,
  getL2AdmissionSnapshot,
  resetL2Admission,
} from "../core/scene/l2-admission.js";
import { L2_RUN_WINDOW_MS, L2_THROTTLE_ROUND_MS } from "../core/scene/l2-gate.js";
import { scanLogLines } from "../core/metrics/observation-scan.js";

interface TimerCall {
  instanceId: string;
  member: string;
  fireAtMs: number;
}

function makeRig() {
  const calls = {
    acquire: 0,
    ack: [] as string[],
    enqueued: [] as any[],
    timers: [] as TimerCall[],
    stateUpdates: [] as any[],
    removedTimers: [] as string[],
    executed: [] as any[],
    logs: [] as string[],
  };
  const backend = {
    acquireLock: async (_key: string) => {
      calls.acquire++;
      return true;
    },
    releaseLock: async (_key: string) => {},
    renewLock: async (_key: string) => true,
    ackTask: async (msgId: string) => {
      calls.ack.push(msgId);
    },
    enqueueTask: async (task: any) => {
      calls.enqueued.push(task);
    },
    setTimer: async (instanceId: string, member: string, fireAtMs: number) => {
      calls.timers.push({ instanceId, member, fireAtMs });
    },
    setTimerIfEarlier: async () => {},
    removeTimer: async (instanceId: string, member: string) => {
      calls.removedTimers.push(member);
    },
    updateSessionState: async (...args: any[]) => {
      calls.stateUpdates.push(args);
    },
    getSessionState: async () => undefined,
  } as any;
  const executor = {
    executeL1: async () => {},
    executeL2: async (task: any) => {
      calls.executed.push(task);
    },
    executeL3: async () => {},
  } as any;
  const logger = {
    info: (msg: string) => calls.logs.push(msg),
    warn: (msg: string) => calls.logs.push(msg),
    error: (msg: string) => calls.logs.push(msg),
    debug: (msg: string) => calls.logs.push(msg),
  };
  return { calls, backend, executor, logger };
}

function l2Task(sessionId: string, id = `t-${sessionId}`): any {
  return { id, type: "L2", instanceId: "inst-1", sessionId, createdAt: Date.now(), data: {}, _msgId: `msg-${id}` };
}

async function runTasks(worker: any, tasks: any[]): Promise<void> {
  for (const task of tasks) await worker.processTask(task);
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("until: 条件在预期时间内未满足");
}

describe("F2 · pipeline-worker 全局速率门（生产路径）", () => {
  beforeEach(() => resetL2Admission());

  it("滑动窗口满 ⇒ 拦下：不抢锁、不执行、不写 state，重挂 timer + ACK", async () => {
    const { calls, backend, executor, logger } = makeRig();
    const worker: any = new PipelineWorker(backend, executor, { l2Gate: { maxRunsPerHour: 1 } }, logger);

    await runTasks(worker, [l2Task("s1"), l2Task("s2")]);

    expect(calls.executed.map((t) => t.sessionId)).toEqual(["s1"]);
    expect(calls.acquire).toBe(1); // 被拦的任务根本没去抢 agent 级锁
    expect(calls.ack).toContain("msg-t-s2");
    expect(calls.stateUpdates).toHaveLength(1); // 只有真跑的那条做了 L2 后置写入（l2_pending/last_extraction）
    expect(calls.removedTimers).toHaveLength(0);
    expect(calls.timers).toHaveLength(1);
    expect(calls.timers[0].member).toBe("s2:L2_schedule");
    expect(calls.timers[0].fireAtMs - Date.now()).toBeGreaterThan(30 * 60 * 1000); // 窗口不足 ⇒ 等下一次滑出（约 1h）
    expect(calls.logs.some((l) => l.includes("reason=l2-throttle"))).toBe(true);
    expect(worker.getMetrics().l2ThrottleSkips).toBe(1);

    // 观测口径合同：这一行必须被 observation-scan 计入 l2ThrottleSkips
    // （且不能被混算成 did-not-accumulate 的 l2GateSkips），否则 P7 读数永远为 0。
    const scan = scanLogLines(calls.logs);
    expect(scan.l2ThrottleSkips).toBe(1);
    expect(scan.l2GateSkips).toBe(0);
  });

  it("被 A1 门 skip 的放行退还额度：skipped 不占滑动窗口", async () => {
    const { calls, backend, executor, logger } = makeRig();
    executor.executeL2 = async (task: any) => {
      calls.executed.push(task);
      (task as any)._l2Skipped = true; // server.ts:3196 的处理结果
    };
    const worker: any = new PipelineWorker(backend, executor, { l2Gate: { maxRunsPerHour: 1 } }, logger);

    await runTasks(worker, [l2Task("s1"), l2Task("s2")]);

    expect(calls.executed.map((t) => t.sessionId)).toEqual(["s1", "s2"]);
    expect(calls.timers).toHaveLength(0);
    expect(calls.logs.some((l) => l.includes("reason=l2-throttle"))).toBe(false);
    expect(worker.getMetrics().l2ThrottleSkips).toBe(0);
  });

  it("两个上限都 <=0 / 未配置 ⇒ 逐位等于加门之前（不拦、不重挂、不记账）", async () => {
    for (const l2Gate of [undefined, {}, { maxRunsPerHour: 0, maxSessionsPerRound: 0 }]) {
      resetL2Admission();
      const { calls, backend, executor, logger } = makeRig();
      const worker: any = new PipelineWorker(backend, executor, l2Gate === undefined ? {} : { l2Gate }, logger);
      await runTasks(worker, [l2Task("s1"), l2Task("s2"), l2Task("s3")]);
      expect(calls.executed).toHaveLength(3);
      expect(calls.timers).toHaveLength(0);
      expect(calls.acquire).toBe(3);
    }
  });

  it("爆发：10 个会话同一轮只放行 maxSessionsPerRound=2，其余全部重挂到下一轮", async () => {
    const { calls, backend, executor, logger } = makeRig();
    const worker: any = new PipelineWorker(backend, executor, { l2Gate: { maxSessionsPerRound: 2 } }, logger);

    await runTasks(
      worker,
      Array.from({ length: 10 }, (_, i) => l2Task(`s${i}`)),
    );

    expect(calls.executed).toHaveLength(2);
    expect(calls.acquire).toBe(2);
    expect(calls.timers).toHaveLength(8);
    for (const t of calls.timers) {
      const delay = t.fireAtMs - Date.now();
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(61_000); // 下一轮桶口（60s）+ 余量
    }
    expect(worker.getMetrics().l2ThrottleSkips).toBe(8);
  });

  it("账本跨重启（生产路径）：重启前跑过的会话仍占窗口，重启后不会瞬间吃满", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "l2-worker-ledger-"));
    const filePath = path.join(dir, "l2-admission.json");
    try {
      resetL2Admission();
      const first = makeRig();
      const w1: any = new PipelineWorker(
        first.backend,
        first.executor,
        { l2Gate: { maxRunsPerHour: 1 }, l2AdmissionFilePath: filePath },
        first.logger,
      );
      await runTasks(w1, [l2Task("s1")]);
      expect(first.calls.executed).toHaveLength(1);
      expect(existsSync(filePath)).toBe(true);
      const persisted = JSON.parse(readFileSync(filePath, "utf8")) as { runTimestamps: number[] };
      expect(persisted.runTimestamps).toHaveLength(1);

      // 模拟进程重启：内存账本清空，第二个 worker 注入同一文件
      resetL2Admission();
      const second = makeRig();
      const w2: any = new PipelineWorker(
        second.backend,
        second.executor,
        { l2Gate: { maxRunsPerHour: 1 }, l2AdmissionFilePath: filePath },
        second.logger,
      );
      await runTasks(w2, [l2Task("s2")]);

      // 重启前的真实运行仍算已消费 ⇒ s2 被拦（而不是立刻放行把额度吃满）
      expect(second.calls.executed).toHaveLength(0);
      expect(second.calls.timers).toHaveLength(1);
      expect(w2.getMetrics().l2ThrottleSkips).toBe(1);
    } finally {
      configureL2AdmissionPersistence({ filePath: null });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("执行失败不占窗口：失败任务结算为「非真实运行」，后续任务仍可放行", async () => {
    const { calls, backend, executor, logger } = makeRig();
    executor.executeL2 = async (task: any) => {
      calls.executed.push(task);
      if (task.sessionId === "s1") throw Object.assign(new Error("boom"), { status: 500 });
    };
    const worker: any = new PipelineWorker(
      backend,
      executor,
      { l2Gate: { maxRunsPerHour: 1 }, retryBaseDelayMs: 1, maxRetries: 1 },
      logger,
    );

    await runTasks(worker, [l2Task("s1")]);
    await runTasks(worker, [l2Task("s2")]);

    expect(calls.executed.map((t) => t.sessionId)).toEqual(["s1", "s2"]);
    expect(calls.timers).toHaveLength(0);
    expect(worker.getMetrics().l2ThrottleSkips).toBe(0);
  });
});

describe("F2 · 被拦后的唤醒时刻（不早于下一个真实可放行时点 + 有界退避）", () => {
  beforeEach(() => resetL2Admission());

  it("窗口耗尽 ⇒ 唤醒不早于最早一次运行滑出窗口，且最多晚 30s", async () => {
    const { calls, backend, executor, logger } = makeRig();
    const worker: any = new PipelineWorker(backend, executor, { l2Gate: { maxRunsPerHour: 1 } }, logger);

    await runTasks(worker, [l2Task("s1")]);
    const snapshot = getL2AdmissionSnapshot();
    expect(snapshot.runTimestamps).toHaveLength(1);
    const nextSlotAtMs = snapshot.runTimestamps[0] + L2_RUN_WINDOW_MS;

    await runTasks(worker, [l2Task("s2")]);
    expect(calls.timers).toHaveLength(1);

    expect(calls.timers[0].fireAtMs).toBeGreaterThanOrEqual(nextSlotAtMs);
    expect(calls.timers[0].fireAtMs).toBeLessThanOrEqual(nextSlotAtMs + 30_000);
  });

  it("单轮桶耗尽（窗口不限）⇒ 唤醒落在下一轮桶口后 1s 内，不白等到一小时", async () => {
    const { calls, backend, executor, logger } = makeRig();
    const worker: any = new PipelineWorker(backend, executor, { l2Gate: { maxSessionsPerRound: 1 } }, logger);

    await runTasks(worker, [l2Task("s1")]);
    const roundStartAtMs = getL2AdmissionSnapshot().roundStartedAtMs;
    expect(roundStartAtMs).toBeGreaterThan(0);

    await runTasks(worker, [l2Task("s2")]);
    expect(calls.timers).toHaveLength(1);

    const roundResetAtMs = roundStartAtMs + L2_THROTTLE_ROUND_MS;
    expect(calls.timers[0].fireAtMs).toBeGreaterThanOrEqual(roundResetAtMs);
    expect(calls.timers[0].fireAtMs).toBeLessThanOrEqual(roundResetAtMs + 1_000);
  });

  it("inFlight 占满且没有已结算时间戳 ⇒ 有界探测且按会话分散（不再固定 60s 齐醒）", async () => {
    const { calls, backend, executor, logger } = makeRig();
    let releaseFirst!: () => void;
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    executor.executeL2 = async (task: any) => {
      calls.executed.push(task);
      await firstRunGate;
    };
    const worker: any = new PipelineWorker(backend, executor, { l2Gate: { maxRunsPerHour: 1 } }, logger);

    // s0 真的进入 executeL2（inFlight=1）且永不结算 ⇒ runTimestamps 为空、nextSlotAtMs=null
    const inFlight = worker.processTask(l2Task("s0"));
    await until(() => calls.executed.length === 1);
    const snapshot = getL2AdmissionSnapshot();
    expect(snapshot.inFlight).toBe(1);
    expect(snapshot.runTimestamps).toHaveLength(0);
    const roundResetAtMs = snapshot.roundStartedAtMs + L2_THROTTLE_ROUND_MS;

    const sessions = Array.from({ length: 8 }, (_, i) => `s${i + 1}`);
    await runTasks(
      worker,
      sessions.map((s) => l2Task(s)),
    );
    releaseFirst();
    await inFlight;

    expect(calls.timers).toHaveLength(sessions.length);
    for (const timer of calls.timers) {
      // 有界探测：不早于下一轮桶口（不给 inFlight 造成 1s 级轮询），最多晚 30s 抖动
      expect(timer.fireAtMs).toBeGreaterThanOrEqual(roundResetAtMs);
      expect(timer.fireAtMs).toBeLessThanOrEqual(roundResetAtMs + 30_000);
    }
    // 分散：8 个会话不能落在同一毫秒（否则就是"同刻齐醒"）
    const distinctFireAt = new Set(calls.timers.map((t) => t.fireAtMs)).size;
    expect(distinctFireAt).toBeGreaterThanOrEqual(5);
  });
});
