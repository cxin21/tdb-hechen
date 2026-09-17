/**
 * extract-worker LIVENESS-CAP 单测（2026-09-17 日志洪水/毒任务修复）。
 *
 * 契约：
 *  - 同一 task 连续 transient 失败达 transientMaxRetries → 转永久失败路径
 *    （retry_count++ → 达 permanentMaxRetries 入 DLQ，数据保留可重放）；
 *  - 未达上限时行为逐位不变（transient 重试、retry_count 不动、不入 DLQ）；
 *  - 成功即清 streak；
 *  - 争锁轮询（dequeued/contended）降 debug，info 面不再刷屏。
 *
 * 实证背景：2026-09-17 03:13 起三个确定性超时任务（超大对话必然超出提取预算）
 * 被无界 transient 重试 154 次 / 5+ 小时，extract-lock 长期占住拖垮 agent 队列，
 * 并派生 60 worker × 2s 轮询的 info 日志洪水 ~2 万行/分钟。
 */
import { describe, it, expect, vi } from "vitest";
import { SkillConversationExtractWorker } from "./extract-worker.js";

const AGENT = { instance_id: "default", space_id: "default", user_id: "u1", team_id: "t1", agent_id: "agt-1" };

function taskEntry() {
  return {
    task_id: "task-1",
    task_ref_id: "ref-1",
    session_id: "s1",
    team_id: "t1",
    agent_id: "agt-1",
    space_id: "default",
    archive_key: "arch-1",
    retry_count: 0,
  };
}

const TIMEOUT_ERR = () => new Error("The operation was aborted due to timeout");

function makeDeps(opts: { transientMaxRetries?: number; permanentMaxRetries?: number; mode?: "timeout" | "ok" | "contend" } = {}) {
  let tasks: Array<Record<string, unknown>> = [taskEntry()];
  const dlq: Array<Record<string, unknown>> = [];
  const writeShapes: Array<number> = [];
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const extractCalls = vi.fn();
  const worker = new SkillConversationExtractWorker({
    workerId: "w1",
    logger: logger as never,
    now: () => 1_000,
    extractLockRenewIntervalMs: 0, // 测试内不启续约定时器
    failureRequeueSleepMs: 0,
    transientMaxRetries: opts.transientMaxRetries ?? 2,
    permanentMaxRetries: opts.permanentMaxRetries ?? 1,
    buffer: {
      readTasks: vi.fn(async () => ({ tasks, updated_at_ms: 0 })),
      writeTasks: vi.fn(async (_a: unknown, doc: { tasks: Array<Record<string, unknown>> }) => {
        writeShapes.push(doc.tasks.length);
        tasks = doc.tasks;
      }),
      readArchive: vi.fn(async () => ({ messages: [{ role: "user", content: "hello" }] })),
      appendDlq: vi.fn(async (_a: unknown, dead: Record<string, unknown>) => { dlq.push(dead); }),
    } as never,
    queue: {
      acquireExtractLock: vi.fn(async () => (opts.mode === "contend" ? null : { token: "h1" })),
      releaseExtractLock: vi.fn(async () => undefined),
      renewExtractLock: vi.fn(async () => true),
      withTasksMutex: vi.fn(async (_a: unknown, _o: unknown, fn: () => Promise<unknown>) => fn()),
      requeueAgent: vi.fn(async () => undefined),
      removeAgent: vi.fn(async () => undefined),
    } as never,
    extractor: {
      extract: vi.fn(async () => {
        extractCalls();
        if (opts.mode === "ok") return { candidates: [{ name: "s", description: "d", when_to_use: "w", steps: [] }] };
        throw TIMEOUT_ERR();
      }),
    } as never,
    sink: { applyCandidates: vi.fn(async () => undefined) },
  });
  const sink = (worker as unknown as { opts: { sink: { applyCandidates: ReturnType<typeof vi.fn> } } }).opts.sink.applyCandidates;
  return { worker, logger, dlq, writeShapes, extractCalls, tasksRef: () => tasks, sink };
}

describe("skill-conv-worker LIVENESS-CAP（2026-09-17）", () => {
  it("连续 transient 达 cap → 转永久路径 → DLQ，任务从 _tasks.json 摘除", async () => {
    const { worker, dlq, writeShapes, extractCalls, tasksRef, logger } = makeDeps({ transientMaxRetries: 2, permanentMaxRetries: 1 });
    // 第 1 轮：streak 1 < 2 → transient 重试，不动 retry_count、不入 DLQ
    await worker.consumeAgent(AGENT);
    expect(extractCalls).toHaveBeenCalledTimes(1);
    expect(dlq).toHaveLength(0);
    // 第 2 轮：streak 2 >= 2 → 永久路径；retry_count 0+1 >= maxRetries 1 → DLQ
    const r2 = await worker.consumeAgent(AGENT);
    expect(extractCalls).toHaveBeenCalledTimes(2);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({ task_id: "task-1", retry_count: 1 });
    expect(String(dlq[0]?.last_error)).toContain("timeout");
    expect(dlq[0]).toHaveProperty("dead_lettered_at_ms");
    expect(writeShapes).toContain(0); // task 被从 _tasks.json 摘除
    expect(tasksRef()).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("transient streak 2 >= cap 2"));
    expect(r2.processedTaskIds).toHaveLength(0);
  });

  it("未达 cap 时行为逐位不变：transient 重试、retry_count 不动、不入 DLQ", async () => {
    const { worker, dlq, extractCalls, tasksRef } = makeDeps({ transientMaxRetries: 5, permanentMaxRetries: 3 });
    await worker.consumeAgent(AGENT);
    await worker.consumeAgent(AGENT);
    expect(extractCalls).toHaveBeenCalledTimes(2);
    expect(dlq).toHaveLength(0);
    expect(tasksRef()).toHaveLength(1);
    expect((tasksRef()[0] as { retry_count?: number }).retry_count ?? 0).toBe(0);
  });

  it("成功即清 streak：成功后重新计数，不误伤后续重试语义", async () => {
    const deps = makeDeps({ transientMaxRetries: 2, permanentMaxRetries: 1 });
    // 先失败 1 次（streak=1）
    await deps.worker.consumeAgent(AGENT);
    // 切换为成功——需重建 extractor mock：直接改 opts.extractor.extract
    const ext = (deps.worker as unknown as { opts: { extractor: { extract: (i: unknown) => Promise<{ candidates: unknown[] }> } } }).opts.extractor;
    ext.extract = async () => ({ candidates: [] });
    const r = await deps.worker.consumeAgent(AGENT);
    expect(r.processedTaskIds).toEqual(["task-1"]);
    expect(deps.dlq).toHaveLength(0);
  });

  it("争锁轮询降 debug：dequeued/contended 不再打 info", async () => {
    const { worker, logger } = makeDeps({ mode: "contend" });
    const r = await worker.consumeAgent(AGENT);
    expect(r.lockContended).toBe(true);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("extract-lock contended"));
    expect(logger.info).not.toHaveBeenCalled();
  });
});