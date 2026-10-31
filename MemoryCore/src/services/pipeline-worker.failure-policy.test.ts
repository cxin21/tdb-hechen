/**
 * D-6/D-7（2026-10-31）· pipeline-worker 失败分类 RED 套件。
 *
 * 缺陷（docs/ops/fullstack-test-capture-isolation.md §4）：
 *   · D-6：LLM 配额耗尽（实测 HTTP 402）时 L1 任务仍被记 completed —— 因为
 *     executeL1 看不到 runner 的失败位（processedCount=0 与「没活干」同型）。
 *     现在 executeL1 依据 result.failed 抛 L1ExtractionFailedError，本套件锁死
 *     该错误在 worker 侧的落地语义：**失败**计数 + 死信 + 不级联。
 *   · D-7：402 曾被当 transient 无限重试（每 ~2s 一次，无上限无退避，还会
 *     重建注入块放大打点）。不可重试类别必须一次即死信。
 */
import { describe, expect, it, vi } from "vitest";
import { PipelineWorker } from "./pipeline-worker.js";
import type { TaskPayload } from "../core/state/types.js";
import { L1ExtractionFailedError } from "../utils/task-failure.js";

function makeTask(overrides: Partial<TaskPayload> = {}): TaskPayload {
  return {
    id: "L1-s1",
    type: "L1",
    instanceId: "default",
    sessionId: "s1",
    teamId: "t1",
    agentId: "a1",
    priority: 1,
    data: {},
    createdAt: 1_000,
    ...overrides,
  };
}

function makeBackend() {
  const enqueued: TaskPayload[] = [];
  const acks: string[] = [];
  return {
    enqueued,
    acks,
    acquireLock: vi.fn(async () => true),
    renewLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
    ackTask: vi.fn(async (id: string) => { acks.push(id); }),
    enqueueTask: vi.fn(async (t: TaskPayload) => { enqueued.push(t); }),
    removeTimer: vi.fn(async () => undefined),
    updateSessionState: vi.fn(async () => undefined),
  };
}

function makeWorker(backend: ReturnType<typeof makeBackend>, err: unknown) {
  const onDeadLetter = vi.fn(async () => undefined);
  const onL1Complete = vi.fn(async () => undefined);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const worker = new PipelineWorker(
    backend as never,
    {
      executeL1: async () => {
        if (err) throw err;
      },
      executeL2: async () => undefined,
      executeL3: async () => undefined,
    },
    { maxRetries: 3, retryBaseDelayMs: 0, onDeadLetter, onL1Complete, workerId: "w-test" },
    logger as never,
  );
  const processTask = (worker as unknown as { processTask: (t: TaskPayload) => Promise<void> }).processTask.bind(worker);
  return { worker, onDeadLetter, onL1Complete, logger, processTask };
}

describe("D-6/D-7 · L1 任务失败分类落地", () => {
  it("402 配额耗尽（executeL1 抛 L1ExtractionFailedError）→ 一次即死信，不重试", async () => {
    const backend = makeBackend();
    const err = new L1ExtractionFailedError("s1", "HTTP 402 insufficient_quota");
    const { worker, onDeadLetter, onL1Complete, processTask } = makeWorker(backend, err);

    await processTask(makeTask());

    const m = worker.getMetrics();
    expect(m.tasksFailed).toBe(1);
    expect(m.tasksDeadLettered).toBe(1);
    expect(m.tasksCompleted).toBe(0);
    expect(m.tasksRetried).toBe(0);
    expect(backend.enqueued).toHaveLength(0);
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    expect(worker.getDeadLetterQueue()[0]).toMatchObject({ error: expect.stringContaining("402") });
    // 失败不得级联：L2 定时器/快路径一律不推进
    expect(onL1Complete).not.toHaveBeenCalled();
    expect(backend.updateSessionState).not.toHaveBeenCalled();
  });

  it("429 限流属可重试：重新入队且 retryCount+1，不写死信", async () => {
    const backend = makeBackend();
    const { worker, onDeadLetter, processTask } = makeWorker(backend, new Error("rate limited: status=429"));

    await processTask(makeTask());

    const m = worker.getMetrics();
    expect(m.tasksRetried).toBe(1);
    expect(m.tasksDeadLettered).toBe(0);
    expect(onDeadLetter).not.toHaveBeenCalled();
    expect(backend.enqueued).toHaveLength(1);
    expect((backend.enqueued[0].data as { retryCount?: number }).retryCount).toBe(1);
  });

  it("429 重试耗尽（retryCount 达 maxRetries）→ 死信（上限仍生效）", async () => {
    const backend = makeBackend();
    const { worker, onDeadLetter, processTask } = makeWorker(backend, new Error("rate limited: status=429"));

    await processTask(makeTask({ data: { retryCount: 3 } }));

    expect(backend.enqueued).toHaveLength(0);
    expect(worker.getMetrics().tasksDeadLettered).toBe(1);
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
  });

  it("生产形状：detail 里没有状态码，靠 extra 携带 402/2067 → 一次即死信，日志带 quota(http=402,code=2067)", async () => {
    const backend = makeBackend();
    // 复刻真实链路：llm-runner 抛的 message 只有供应商中文文案，状态码由 extra 传下来
    const VENDOR_MSG = "当前已达到 Token Plan 用量上限，请升级套餐或等待额度重置 (2067)";
    const err = new L1ExtractionFailedError("s1", VENDOR_MSG, 0, { statusCode: 402, providerCode: "2067" });
    const { worker, onDeadLetter, logger, processTask } = makeWorker(backend, err);

    await processTask(makeTask());

    const m = worker.getMetrics();
    expect(m.tasksFailed).toBe(1);
    expect(m.tasksDeadLettered).toBe(1);
    expect(m.tasksRetried).toBe(0);
    expect(backend.enqueued).toHaveLength(0);
    expect(onDeadLetter).toHaveBeenCalledTimes(1);

    // 观测面：类别与供应商码必须进日志（以前只有 unknown，查不出是配额）
    const logged = logger.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("quota(http=402,code=2067)");
  });

  it("成功任务：completed 计数 + 级联推进，不写死信（反向哨兵）", async () => {
    const backend = makeBackend();
    const { worker, onDeadLetter, onL1Complete, processTask } = makeWorker(backend, undefined);

    await processTask(makeTask());

    const m = worker.getMetrics();
    expect(m.tasksCompleted).toBe(1);
    expect(m.tasksFailed).toBe(0);
    expect(m.tasksDeadLettered).toBe(0);
    expect(onDeadLetter).not.toHaveBeenCalled();
    expect(onL1Complete).toHaveBeenCalledTimes(1);
  });
});
