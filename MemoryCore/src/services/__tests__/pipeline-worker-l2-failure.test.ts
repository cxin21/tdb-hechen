/**
 * R24-a3：L2 组级失败不能当成功轮（services/pipeline-worker 的级联调度）。
 *
 * 过去的形态：gateway executor 只看 runL2WithStore().skipped，半失败轮仍被当作成功 →
 * cascadeSchedule 写 l2_last_extraction_time（墙钟）+ 入队 L3，失败批永久落在 cursor 后面。
 * 现在：executor 标 _l2HadFailure，级联调度早退（不写墙钟、不入队 L3、不重挂 timer）。
 */
import { describe, it, expect, vi } from "vitest";
import { markL2Outcome } from "../l2-outcome.js";
import { PipelineWorker } from "../pipeline-worker.js";

function makeWorker() {
  const enqueued: any[] = [];
  const stamps: any[] = [];
  const onL2Complete = vi.fn(async () => {});
  const backend: any = {
    enqueueTask: async (t: any) => { enqueued.push(t); },
    updateSessionState: async (_i: string, _s: string, patch: any) => { stamps.push(patch); },
  };
  const executor: any = { executeL1: async () => {}, executeL2: async () => {}, executeL3: async () => {} };
  const logger: any = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const worker = new PipelineWorker(backend, executor, { onL2Complete } as any, logger);
  return { worker, enqueued, stamps, onL2Complete };
}

function l2Task(extra: Record<string, unknown> = {}) {
  return {
    id: "L2-1",
    type: "L2",
    instanceId: "i1",
    sessionId: "s1",
    teamId: "t1",
    agentId: "a1",
    priority: 2,
    createdAt: Date.now(),
    ...extra,
  } as any;
}

describe("R24-a3：L2 组级失败不级联", () => {
  it("_l2HadFailure：不写墙钟、不入队 L3、不重挂 timer", async () => {
    const { worker, enqueued, stamps, onL2Complete } = makeWorker();
    await (worker as any).cascadeSchedule(l2Task({ _l2HadFailure: true }));
    expect(enqueued).toHaveLength(0);
    const stampedExtraction = stamps.filter((p) => "l2_last_extraction_time" in p);
    expect(stampedExtraction).toHaveLength(0);
    expect(onL2Complete).not.toHaveBeenCalled();
  });

  it("成功轮仍然写墙钟 + 入队 L3（守住回归的另一侧）", async () => {
    const { worker, enqueued, stamps, onL2Complete } = makeWorker();
    await (worker as any).cascadeSchedule(l2Task());
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].type).toBe("L3");
    const patched = stamps.find((p) => "l2_last_extraction_time" in p);
    expect(patched?.l2_pending_l1_count).toBe(0);
    expect(typeof patched?.l2_last_extraction_time).toBe("string");
    expect(onL2Complete).toHaveBeenCalledTimes(1);
  });

  it("_l2Skipped 与失败轮同口径（都不级联）", async () => {
    const { worker, enqueued, stamps } = makeWorker();
    await (worker as any).cascadeSchedule(l2Task({ _l2Skipped: true }));
    expect(enqueued).toHaveLength(0);
    expect(stamps.filter((p) => "l2_last_extraction_time" in p)).toHaveLength(0);
  });
});

// R29：生产者侧（gateway 执行器把 L2 结果写回 task）原先零覆盖——r28c-a3 把
// server.ts 的 `if (result.hadFailure === true)` 改成 `if (false)` 后 20 个用例仍全绿。
// 现在标记逻辑是纯函数，语义在下面断言；调用点由源码断言兜住「有没有把 result 传进去」。
describe("markL2Outcome（生产者侧标记）", () => {
  it("hadFailure=true 才置位；false / 缺省 / null 结果都不置位", () => {
    const a: Record<string, unknown> = {};
    markL2Outcome(a, { hadFailure: true });
    expect(a._l2HadFailure).toBe(true);

    const b: Record<string, unknown> = {};
    markL2Outcome(b, { hadFailure: false });
    expect("_l2HadFailure" in b).toBe(false);

    const c: Record<string, unknown> = {};
    markL2Outcome(c, {});
    expect("_l2HadFailure" in c).toBe(false);

    const d: Record<string, unknown> = {};
    markL2Outcome(d, null);
    expect("_l2HadFailure" in d).toBe(false);
  });

  it("skipped 与 hadFailure 可同时置位（失败优先，由消费端决定早退理由）", () => {
    const task: Record<string, unknown> = {};
    markL2Outcome(task, { skipped: true, hadFailure: true });
    expect(task._l2Skipped).toBe(true);
    expect(task._l2HadFailure).toBe(true);
  });

  it("gateway 执行器把 runL2WithStore 的 result 原样交给标记函数（源码断言）", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../gateway/server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/markL2Outcome\(task[^)]*,\s*result\)/);
    // 旧的原地置位必须已经搬走，否则两处口径会再次分叉。
    expect(src.includes("(task as any)._l2HadFailure = true")).toBe(false);
  });
});
