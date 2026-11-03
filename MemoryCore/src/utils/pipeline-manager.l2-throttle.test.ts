/**
 * F2 · L2 全局速率门接线（pipeline-manager 的 L2 触发/执行路径）。
 *
 * 验收口径（task-6）：
 *  1. 242 个会话同时待处理（fake clock）→ 单轮放行 ≤ maxSessionsPerRound；
 *  2. 任意滑动 60 分钟内的真实运行数 ≤ maxRunsPerHour；
 *  3. 被全局门拦下的会话：`l2_pending_l1_count` 保留、`l2_last_extraction_time` /
 *     `last_extraction_updated_time` / `last_extraction_time` 逐位不动（不刷新、不清、不推 cursor）；
 *  4. 两个上限都为 0 ⇒ 242 个会话照旧一次全放行（逐位等于加门之前）；
 *  5. boot recovery 挂载会话数超过 `bootRecoveryWarnSessions` ⇒ WARN。
 *
 * 计数口径：窗口里记的是**真实运行**（runner 被调用且未被 skip），不是 enqueued。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryPipelineManager, type PipelineConfig } from "./pipeline-manager.js";
import type { PipelineSessionState } from "./checkpoint.js";
import type { Logger } from "../core/types.js";
import { admitL2Run, getL2AdmissionSnapshot, resetL2Admission, settleL2Run } from "../core/scene/l2-admission.js";

const SESSION_COUNT = 242;
const T0 = Date.parse("2026-11-02T08:00:00.000Z");
const SEED_L2_TIME = "2026-11-02T07:00:00.000Z";
const SEED_CURSOR = "2026-11-01T07:00:00.000Z";
const SEED_EXTRACTION_TIME = "2026-11-01T06:00:00.000Z";
const SEED_PENDING = 30;
/** 与 l2-gate.ts 的窗口/轮次常量对齐（这里显式写死，避免用例跟着实现一起漂）。 */
const WINDOW_MS = 3_600_000;
const ROUND_MS = 60_000;

interface RunLog {
  sessionKey: string;
  at: number;
}

let alive: MemoryPipelineManager | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
  // F2 · 账本是模块级单例（worker 与 manager 共享额度），用例之间必须清零。
  resetL2Admission();
});

afterEach(() => {
  // 只丢掉 fake timer 句柄，不跑 destroy()（destroy 里的 2s 超时在 fake clock 下不会到期）。
  alive = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
});

function makeConfig(gate?: PipelineConfig["l2Gate"]): PipelineConfig {
  return {
    everyNConversations: 5,
    enableWarmup: false,
    l1: { idleTimeoutSeconds: 60 },
    l2: {
      delayAfterL1Seconds: 1,
      minIntervalSeconds: 60,
      maxIntervalSeconds: 3600,
      sessionActiveWindowHours: 24,
    },
    ...(gate ? { l2Gate: gate } : {}),
  };
}

function seedStates(count: number): Record<string, PipelineSessionState> {
  const out: Record<string, PipelineSessionState> = {};
  for (let i = 0; i < count; i++) {
    const key = `sess-${String(i).padStart(3, "0")}`;
    out[key] = {
      session_key: key,
      conversation_count: 0,
      last_extraction_updated_time: SEED_CURSOR,
      last_extraction_time: SEED_EXTRACTION_TIME,
      l2_pending_l1_count: SEED_PENDING,
      l2_last_extraction_time: SEED_L2_TIME,
      last_active_time: T0,
      warmup_threshold: 0,
    } as unknown as PipelineSessionState;
  }
  return out;
}

interface Harness {
  pm: MemoryPipelineManager;
  runs: RunLog[];
  warns: string[];
}

function mkManager(
  gate: PipelineConfig["l2Gate"] | undefined,
  count = SESSION_COUNT,
  /**
   * "skipped" = runner 每次都返回 {skipped:true}（A1 per-session 门 / 空抽取的形态）。
   * 用来钉住「额度只按真实运行记账」：skipped 不算一次运行，不占 60 分钟窗口。
   */
  mode: "ok" | "skipped" = "ok",
): Harness {
  const runs: RunLog[] = [];
  const warns: string[] = [];
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg: string) => warns.push(String(msg)),
    error: () => undefined,
  } as unknown as Logger;

  const pm = new MemoryPipelineManager(makeConfig(gate), logger);
  pm.setPersister(async () => undefined);
  pm.setL1Runner(async () => ({ hasMore: false }));
  pm.setL2Runner(async (sessionKey) => {
    runs.push({ sessionKey, at: Date.now() });
    if (mode === "skipped") return { skipped: true, reason: "l2-gate" } as const;
    return { latestCursor: SEED_CURSOR };
  });
  pm.setL3Runner(async () => undefined);
  pm.start(seedStates(count));
  alive = pm;
  return { pm, runs, warns };
}

/** 把 fake clock 里的微任务链跑干净：直到 L2/L3 队列都空闲。 */
async function settle(pm: MemoryPipelineManager, maxSteps = 500): Promise<void> {
  for (let i = 0; i < maxSteps; i++) {
    const q = pm.getQueueSizes();
    if (q.l2 === 0 && q.l2Idle && q.l3 === 0 && q.l3Idle) return;
    await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error("settle: 队列未在预期步数内排空");
}

/** 任意长度 < 1h 的滑动窗口里最多包含多少次运行（= 门允许的峰值）。 */
function maxInSlidingWindow(times: readonly number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let left = 0;
  for (let right = 0; right < sorted.length; right++) {
    while (sorted[right] - sorted[left] >= WINDOW_MS) left += 1;
    best = Math.max(best, right - left + 1);
  }
  return best;
}

describe("F2 · 缺省（两个上限都 0）= 逐位现状", () => {
  it("242 个会话同时待处理 → 一次全放行；只留 boot recovery WARN", async () => {
    const { pm, runs, warns } = mkManager(undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(pm);

    expect(runs).toHaveLength(SESSION_COUNT);
    expect(new Set(runs.map((r) => r.sessionKey)).size).toBe(SESSION_COUNT);
    const stats = pm.getL2ThrottleStats();
    expect(stats.enabled).toBe(false);
    expect(stats.throttleSkips).toBe(0);
    expect(warns.filter((w) => w.includes("Boot recovery"))).toHaveLength(1);
  });
});

describe("F2 · 单轮 session 上限", () => {
  it("maxSessionsPerRound=5：每轮放行 ≤5，被拦会话重挂定时器后逐轮推进直到跑完", async () => {
    const { pm, runs } = mkManager({ maxSessionsPerRound: 5 });

    await vi.advanceTimersByTimeAsync(1_000);
    await settle(pm);
    expect(runs).toHaveLength(5);

    let rounds = 1;
    while (runs.length < SESSION_COUNT && rounds < 200) {
      const before = runs.length;
      await vi.advanceTimersByTimeAsync(ROUND_MS);
      await settle(pm);
      const added = runs.length - before;
      // 单轮放行数不得超过上限（本轮已满 ⇒ 剩余会话被重挂到下一轮）
      expect(added).toBeLessThanOrEqual(5);
      expect(pm.getL2ThrottleStats().roundAdmitted).toBeLessThanOrEqual(5);
      if (added === 0) break;
      rounds += 1;
    }

    expect(runs).toHaveLength(SESSION_COUNT);
    expect(new Set(runs.map((r) => r.sessionKey)).size).toBe(SESSION_COUNT);
    // 计数口径：被拦次数按 distinct 的真实运行之外的会话计
    expect(pm.getL2ThrottleStats().lastRoundAdmitted).toBeLessThanOrEqual(5);
  });
});

describe("F2 · 滑动 60 分钟窗口", () => {
  it("maxRunsPerHour=7：60 分钟内真实运行 ≤7；被拦会话 pending/时间戳/cursor 逐位不动", async () => {
    const { pm, runs } = mkManager({ maxSessionsPerRound: 5, maxRunsPerHour: 7 });

    await vi.advanceTimersByTimeAsync(1_000);
    await settle(pm);
    expect(runs).toHaveLength(5);

    // 第二轮：窗口还剩 2 个额度
    await vi.advanceTimersByTimeAsync(ROUND_MS);
    await settle(pm);
    expect(runs).toHaveLength(7);

    // 之后窗口已满：再推进若干轮也不再放行
    await vi.advanceTimersByTimeAsync(ROUND_MS * 5);
    await settle(pm);
    expect(runs).toHaveLength(7);

    const stats = pm.getL2ThrottleStats();
    expect(stats.enabled).toBe(true);
    expect(stats.windowRuns).toBeLessThanOrEqual(7);
    // throttleSkips 是"拦截次数"（被拦会话重挂后每轮再被拦都会 +1），不是 distinct 会话数；
    // distinct 的口径由下面的 blocked 集合断言钉住。第一轮就有 SESSION_COUNT-5 次拦截，
    // 所以它必须**严格大于** blocked 会话数（235）——这比旧的 >= SESSION_COUNT-7 更紧。
    expect(stats.throttleSkips).toBeGreaterThan(SESSION_COUNT - 7);

    // 被拦会话：pending 保留、三个时间戳/cursor 逐位不动
    const ran = new Set(runs.map((r) => r.sessionKey));
    const blocked = [...Array(SESSION_COUNT).keys()]
      .map((i) => `sess-${String(i).padStart(3, "0")}`)
      .filter((k) => !ran.has(k));
    expect(blocked).toHaveLength(SESSION_COUNT - 7);
    for (const key of blocked.slice(0, 20)) {
      const st = pm.getSessionState(key)!;
      expect(st.l2_pending_l1_count).toBe(SEED_PENDING);
      expect(st.l2_last_extraction_time).toBe(SEED_L2_TIME);
      expect(st.last_extraction_time).toBe(SEED_EXTRACTION_TIME);
      expect(st.last_extraction_updated_time).toBe(SEED_CURSOR);
    }

    // 最早一次运行滑出窗口后，额度恢复
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    await settle(pm);
    expect(runs.length).toBeGreaterThan(7);
    expect(maxInSlidingWindow(runs.map((r) => r.at))).toBeLessThanOrEqual(7);
    expect(pm.getL2ThrottleStats().throttleSkips).toBeGreaterThan(0);
  });

  it("maxRunsPerHour=3 / maxSessionsPerRound=0：首轮即被窗口卡在 3", async () => {
    const { pm, runs } = mkManager({ maxRunsPerHour: 3 });
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(pm);
    expect(runs).toHaveLength(3);
    expect(pm.getL2ThrottleStats().windowRuns).toBe(3);

    // 一轮（60s）之后仍在同一个 60 分钟窗口内 → 不得再放行
    await vi.advanceTimersByTimeAsync(ROUND_MS * 10);
    await settle(pm);
    expect(runs).toHaveLength(3);

    // 60 分钟后额度恢复
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    await settle(pm);
    expect(runs.length).toBeGreaterThan(3);
    expect(maxInSlidingWindow(runs.map((r) => r.at))).toBeLessThanOrEqual(3);
  });
});

describe("F2 · 额度只按真实运行记账", () => {
  it("runner 返回 skipped（A1 门/空抽取）不占 60 分钟窗口：上限 2 也拦不住 8 个 skipped", async () => {
    const { pm, runs } = mkManager({ maxRunsPerHour: 2 }, 8, "skipped");
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(pm);

    // 8 个 session 全部被调用过——skipped 不记账，所以额度从未被吃掉
    expect(runs).toHaveLength(8);
    const stats = pm.getL2ThrottleStats();
    expect(stats.enabled).toBe(true);
    expect(stats.windowRuns).toBe(0);
    expect(stats.throttleSkips).toBe(0);
  });
});

describe("F2 · 共享账本（worker 与 manager 走同一个 admitL2Run 单例）", () => {
  it("别处已用掉的窗口额度，manager 侧立刻可见：不再各记一套", async () => {
    // 模拟 worker 侧（gateway 的唯一真路径）已经跑掉一次真实 L2：同一模块单例记账。
    expect(admitL2Run({ maxRunsPerHour: 1 }, T0).admit).toBe(true);
    settleL2Run(true, T0);

    // manager 用同样的上限：额度已被别处吃掉 ⇒ 一个都不该放行。
    const { pm, runs } = mkManager({ maxRunsPerHour: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(pm);

    expect(runs).toHaveLength(0);
    const stats = pm.getL2ThrottleStats();
    expect(stats.windowRuns).toBe(1);
    expect(stats.throttleSkips).toBeGreaterThan(0);
    expect(getL2AdmissionSnapshot().inFlight).toBe(0);
  });

  it("manager 放行的运行，worker 侧同样能看到（额度双向共享）", async () => {
    const { pm, runs } = mkManager({ maxRunsPerHour: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(pm);
    expect(runs).toHaveLength(1);

    // worker 侧的下一次申请：窗口已被 manager 那次真实运行占满。
    expect(getL2AdmissionSnapshot().runTimestamps).toHaveLength(1);
    expect(admitL2Run({ maxRunsPerHour: 1 }, T0 + 1_000).admit).toBe(false);
  });
});

describe("F2 · boot recovery WARN", () => {
  it("挂载会话数 ≤ bootRecoveryWarnSessions 时不告警", async () => {
    const { warns } = mkManager({ maxSessionsPerRound: 5, bootRecoveryWarnSessions: 300 });
    expect(warns.filter((w) => w.includes("Boot recovery"))).toHaveLength(0);
  });

  it("超阈值（242 > 50）时 WARN 里同时给出会话数与配置阈值", () => {
    const { warns } = mkManager({ maxSessionsPerRound: 5 });
    const hit = warns.filter((w) => w.includes("Boot recovery"));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain("242");
    expect(hit[0]).toContain("bootRecoveryWarnSessions=50");
  });
});
