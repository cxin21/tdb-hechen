/**
 * A1 · pipeline-manager 的 L2 运行后状态（Lead 补口，2026-11-02）。
 *
 * 这条用例钉的是**接线**：纯函数 decideL2PostRun 的语义要真的作用到 checkpoint 上。
 * builder-scene 自曝的病灶：非首轮 skip 仍把 l2_last_extraction_time 重打成 now，
 * 于是门自己的 skip 会把时间门越推越远 —— 生产上退化成纯条数门（A1 目标 99→≤25 落空）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { MemoryPipelineManager, type PipelineConfig } from "./pipeline-manager.js";
import type { PipelineSessionState } from "./checkpoint.js";

const CFG: PipelineConfig = {
  everyNConversations: 5,
  enableWarmup: false,
  l1: { idleTimeoutSeconds: 60 },
  l2: { delayAfterL1Seconds: 1, minIntervalSeconds: 60, maxIntervalSeconds: 120, sessionActiveWindowHours: 24 },
};

const SK = "sess-a1";
const SEED_L2_TIME = "2026-11-02T00:00:00.000Z";
const SEED_CURSOR = "2026-11-02T01:00:00.000Z";

let alive: MemoryPipelineManager | undefined;
afterEach(() => {
  alive?.destroy();
  alive = undefined;
});

function seed(): Record<string, PipelineSessionState> {
  return {
    [SK]: {
      session_key: SK,
      conversation_count: 0,
      last_extraction_updated_time: SEED_CURSOR,
      last_extraction_time: SEED_CURSOR,
      // pending=0 起步：避免 start() 把该会话立刻排进 L2 队列，与用例里的直调互踩。
      l2_pending_l1_count: 0,
      l2_last_extraction_time: SEED_L2_TIME,
    } as unknown as PipelineSessionState,
  };
}

type Runner = (
  k: string,
  cursor?: string,
) => Promise<{ latestCursor?: string; skipped?: boolean; reason?: string } | void>;

/** getSessionState 返回副本，这里直接改内部 map（测试专用，语义=「此刻还有 N 条未处理」）。 */
function setPending(pm: MemoryPipelineManager, n: number): void {
  const states = (pm as unknown as { sessionStates: Map<string, PipelineSessionState> }).sessionStates;
  const st = states.get(SK);
  if (!st) throw new Error("seed missing");
  st.l2_pending_l1_count = n;
}

/** 让两次 runL2 落在不同毫秒（时间戳是 ISO 毫秒串）。 */
const tick = () => new Promise((r) => setTimeout(r, 5));

function mkManager(): { pm: MemoryPipelineManager; runL2: (k: string) => Promise<void>; swap: (r: Runner) => void } {
  const pm = new MemoryPipelineManager(CFG);
  pm.setPersister(async () => {
    /* noop */
  });
  pm.setL1Runner(async () => ({ hasMore: false }));
  pm.setL3Runner(async () => {
    /* noop */
  });
  let current: Runner = async () => ({ latestCursor: "2026-11-02T02:00:00.000Z" });
  pm.setL2Runner((k, c) => current(k, c));
  pm.start(seed());
  alive = pm;
  const runL2 = (k: string) => (pm as unknown as { runL2(s: string): Promise<void> }).runL2(k);
  return {
    pm,
    runL2,
    swap: (r) => {
      current = r;
    },
  };
}

describe("A1 · 门拦下不刷新「上次成功 L2」", () => {
  it("T1 gate skip：时间戳逐位不动、pending 保留、cursor 不推进", async () => {
    const { pm, runL2, swap } = mkManager();
    await runL2(SK);
    const st = pm.getSessionState(SK)!;
    expect(st.l2_last_extraction_time).not.toBe(SEED_L2_TIME);
    const beforeTime = st.l2_last_extraction_time;
    const beforeCursor = st.last_extraction_updated_time;

    st.l2_pending_l1_count = 12;
    setPending(pm, 12);
    await tick();
    swap(async () => ({ skipped: true, reason: "l2-gate" }));
    await runL2(SK);

    const after = pm.getSessionState(SK)!;
    expect(after.l2_last_extraction_time).toBe(beforeTime);
    expect(after.l2_pending_l1_count).toBe(12);
    expect(after.last_extraction_updated_time).toBe(beforeCursor);
  });

  it("T2 legacy 非首轮 skip：逐位今天（刷新时间戳、清 pending）", async () => {
    const { pm, runL2, swap } = mkManager();
    await runL2(SK);
    const st = pm.getSessionState(SK)!;
    const beforeTime = st.l2_last_extraction_time;
    st.l2_pending_l1_count = 7;
    setPending(pm, 7);
    await tick();

    swap(async () => ({ skipped: true }));
    await runL2(SK);

    const after = pm.getSessionState(SK)!;
    expect(after.l2_last_extraction_time).not.toBe(beforeTime);
    expect(after.l2_pending_l1_count).toBe(0);
  });

  it("T3 正常跑完：时间戳刷新、cursor 推进、pending 清零", async () => {
    const { pm, runL2 } = mkManager();
    await runL2(SK);
    const st = pm.getSessionState(SK)!;
    expect(st.l2_last_extraction_time).not.toBe(SEED_L2_TIME);
    expect(st.last_extraction_updated_time).toBe("2026-11-02T02:00:00.000Z");
    expect(st.l2_pending_l1_count).toBe(0);
  });
});
