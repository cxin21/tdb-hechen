/**
 * GROW-RACE 互斥测试（REG-REMAINING-004 #9，FLOW-E 实证）。
 * 竞态：runOnce 无互斥 + intervalMs 短 + LLM 慢（timeoutMs=0）→ 多个 run 重叠，
 * 各自基于过期快照算采纳名额 → 超额采纳（实测 l5ug 11→18 击穿 maxTotal=15）。
 * 契约：上一轮在飞 → 本轮 tick 跳过且 debug 可见（不留静默）。
 */
import { describe, it, expect, vi } from "vitest";
import { startLifecycleScheduler } from "../lifecycle-scheduler.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('GROW-RACE 互斥（REG-REMAINING-004 #9）', () => {
  it('上一轮在飞 → 后续 tick 跳过（skip debug 日志 ≥3，无并发 run）', async () => {
    const debugLines: string[] = [];
    const logger = {
      debug: (msg: string) => { if (msg.includes("in flight")) debugLines.push(msg); },
      info: () => {}, warn: () => {}, error: () => {},
    };
    const store = {
      queryL1Records: vi.fn(async () => []),
      getAnchorGrowthState: vi.fn(async () => ({ lastDiscoveryAt: null, lastCorpusCount: null })),
      setAnchorGrowthState: vi.fn(async () => {}),
      listL1TenantTriplets: vi.fn(async () => [{ teamId: "default", userId: "default", agentId: "default" }]),
      listValuesAnyState: vi.fn(async () => []),
      listValues: vi.fn(async () => []),
      upsertValue: vi.fn(async () => true),
      retireValue: vi.fn(async () => true),
      countL1: vi.fn(async () => 1),
    };
    // 慢 LLM：anchor-growth 发现调用 150ms（模拟 Ark timeoutMs=0 慢调用）
    const llmRunner = { run: vi.fn(async () => { await sleep(150); return "[]"; }) };
    const stop = startLifecycleScheduler({
      store: store as never,
      llmRunner: llmRunner as never,
      config: { intervalMs: 30, consolidation: { enabled: false } as never, forgetting: { enabled: false } as never, anchorDiscovery: { enabled: true, intervalHours: 24 } as never },
      logger: logger as never,
    });
    await sleep(400);
    stop();
    expect(debugLines.length).toBeGreaterThanOrEqual(3);
  });
});
