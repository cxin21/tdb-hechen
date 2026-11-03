import { describe, expect, it } from "vitest";
import {
  aggregateDedupBatches,
  parseLogTimestamp,
  scanLogLines,
  summarizeJournalGates,
  summarizeSceneSizes,
} from "../observation-scan.js";

const LOG_SAMPLE = [
  "2026-11-02T15:28:30.179+08:00 DEBUG [tdai-gateway] [pipeline-worker] Task completed: L2 [default/profile:team:x|agent:y]",
  "2026-11-02T15:28:31.000+08:00 DEBUG [tdai-gateway] [memory-tdai] [pipeline-manager] L2 gate-skip: keep l2_last_extraction_time unchanged (pending=7)",
  "2026-11-02T15:28:32.000+08:00 INFO  [tdai-gateway] [memory-tdai] [L1] dedup prefilter: prefiltered=4 llmCalls=1 of 6",
  "2026-11-02T15:28:33.000+08:00 INFO  [tdai-gateway] [memory-tdai] [L1] dedup prefilter: prefiltered=0 llmCalls=3 of 3",
  "2026-11-02T15:28:34.000+08:00 INFO  [tdai-gateway] [consolidation] ran: groups=9, summaries=9, persisted=9 (sources=120)",
  "unrelated line",
  "Task completed: L20 should not match",
];

describe("parseLogTimestamp（窗口筛选的唯一时间源）", () => {
  it("解析带偏移的 ISO 行首时间戳（曾用 slice(0,25) 截断导致全窗口漏计）", () => {
    const ts = parseLogTimestamp("2026-11-02T15:28:30.179+08:00 DEBUG [x] y");
    expect(Number.isFinite(ts)).toBe(true);
    expect(new Date(ts).toISOString()).toBe("2026-11-02T07:28:30.179Z");
  });

  it("无毫秒 / Z 结尾 / 裸 LocalDate 都能解析", () => {
    expect(new Date(parseLogTimestamp("2026-11-02T15:28:30+08:00 INFO x")).toISOString()).toBe(
      "2026-11-02T07:28:30.000Z",
    );
    expect(new Date(parseLogTimestamp("2026-11-02T07:28:30.000Z INFO x")).toISOString()).toBe(
      "2026-11-02T07:28:30.000Z",
    );
    expect(Number.isFinite(parseLogTimestamp("2026-11-02T15:28:30.5+08:00 x"))).toBe(true);
  });

  it("无时间戳行 => NaN（调用方据此跳过，不猜）", () => {
    expect(Number.isNaN(parseLogTimestamp("no timestamp here"))).toBe(true);
    expect(Number.isNaN(parseLogTimestamp(""))).toBe(true);
  });
});

describe("scanLogLines（A1/B1/B4 日志读数）", () => {
  it("数出 L2 完成 / 门拦截 / dedup 批 / 巩固运行", () => {
    const got = scanLogLines(LOG_SAMPLE);
    expect(got.l2Completed).toBe(1);
    expect(got.l2GateSkips).toBe(1);
    expect(got.dedupBatches).toEqual([
      { prefiltered: 4, llmCalls: 1, total: 6 },
      { prefiltered: 0, llmCalls: 3, total: 3 },
    ]);
    expect(got.consolidationRuns).toEqual([{ groups: 9, summaries: 9, persisted: 9, sources: 120 }]);
  });

  it("A1 另两个口径：入队次数（跑了多少次）与成功抽取（真写了块）", () => {
    const got = scanLogLines([
      "2026-11-02T15:28:30.179+08:00 INFO  [tdai-gateway] [local-timer] Timer fired: abc:L2_schedule → enqueued L2 task",
      "2026-11-02T15:28:31.179+08:00 INFO  [tdai-gateway] [local-timer] Timer fired: def:L2_schedule → enqueued L2 task",
      "2026-11-02T15:28:32.179+08:00 DEBUG [tdai-gateway] [memory-tdai] [pipeline-factory] [L2] All new records invalidated — skipping scene extraction (no candidates)",
      "2026-11-02T15:28:33.179+08:00 DEBUG [tdai-gateway] [memory-tdai] [pipeline-factory] [L2] derived_from edges: 4 (2/15 block(s) ← 2 record(s), scope=team)",
    ]);
    expect(got.l2Enqueued).toBe(2);
    expect(got.l2SkippedInvalidated).toBe(1);
    expect(got.l2Extracted).toBe(1);
  });

  it("门拦截两种日志形态都要数（factory 的 Gate skipped (l2-gate) 是生产实际形态）", () => {
    const got = scanLogLines([
      "2026-11-02T16:28:50.858+08:00 DEBUG [tdai-gateway] [memory-tdai] [pipeline-factory] [L2] Gate skipped (l2-gate): pending=3<30, lastExtraction=752758ms<6h (session=1ff080fd)",
      "2026-11-02T16:29:05.413+08:00 DEBUG [tdai-gateway] [memory-tdai] [pipeline-factory] [L2] Gate skipped (l2-gate): pending=2<30, lastExtraction=790196ms<6h (session=c12d9d3e)",
      "2026-11-02T16:29:06.000+08:00 WARN  [tdai-gateway] [memory-tdai] L2 gate-skip: keep l2_last_extraction_time unchanged (pending=12)",
    ]);
    expect(got.l2GateSkips).toBe(3);
  });

  it("空输入不产出（不做除零，不给默认值）", () => {
    const got = scanLogLines([]);
    expect(got).toEqual({
      l2Completed: 0,
      l2GateSkips: 0,
      l2ThrottleSkips: 0,
      l2Enqueued: 0,
      l2SkippedInvalidated: 0,
      l2Extracted: 0,
      dedupBatches: [],
      consolidationRuns: [],
    });
  });

  it("残缺行不抛错也不计入", () => {
    const got = scanLogLines(["dedup prefilter: prefiltered= llmCalls= of ", "L2 gate-skip:"]);
    expect(got.dedupBatches).toEqual([]);
    expect(got.consolidationRuns).toEqual([]);
  });
});

describe("F2 全局节流读数（2026-11-02 新增的第三种拦截形态）", () => {
  it("throttle 形态单独计数，不混入门拦截（否则「门拦了多少」被节流污染）", () => {
    const got = scanLogLines([
      "2026-11-02T17:30:01.000+08:00 DEBUG [tdai-gateway] [memory-tdai] [pipeline-manager] [s1] L2 gate-skip (reason=l2-throttle): keep l2_last_extraction_time unchanged (pending=1)",
      "2026-11-02T17:30:02.000+08:00 DEBUG [tdai-gateway] [memory-tdai] [pipeline-manager] [s2] L2 gate-skip (reason=l2-throttle): keep l2_last_extraction_time unchanged (pending=3)",
      "2026-11-02T17:30:03.000+08:00 DEBUG [tdai-gateway] [memory-tdai] [pipeline-factory] [L2] Gate skipped (l2-gate): pending=2<30, lastExtraction=1ms<6h (session=s3)",
    ]);
    expect(got.l2ThrottleSkips).toBe(2);
    expect(got.l2GateSkips).toBe(1);
  });

  it("节流行不因为带 L2 gate-skip 字样被当门拦截数进去", () => {
    const got = scanLogLines([
      "2026-11-02T17:30:01.000+08:00 DEBUG [tdai-gateway] [memory-tdai] [pipeline-manager] [s1] L2 gate-skip (reason=l2-throttle): pending=1",
    ]);
    expect(got.l2GateSkips).toBe(0);
    expect(got.l2ThrottleSkips).toBe(1);
  });
});

describe("B1 巩固收口行（2026-11-02 新增 skippedUnchanged 字段）", () => {
  it("新格式解析出 skippedUnchanged（旧正则要求 persisted=N (sources= 会直接归零）", () => {
    const got = scanLogLines([
      "2026-11-02T17:30:10.000+08:00 INFO  [tdai-gateway] [consolidation] ran: groups=20, summaries=0, persisted=0, skippedUnchanged=20 (sources=1200)",
    ]);
    expect(got.consolidationRuns).toEqual([
      { groups: 20, summaries: 0, persisted: 0, skippedUnchanged: 20, sources: 1200 },
    ]);
  });

  it("旧格式（无 skippedUnchanged）仍可解析，不硬塞 0 冒充", () => {
    const got = scanLogLines([
      "2026-11-02T15:28:34.000+08:00 INFO  [tdai-gateway] [consolidation] ran: groups=9, summaries=9, persisted=9 (sources=120)",
    ]);
    expect(got.consolidationRuns).toEqual([{ groups: 9, summaries: 9, persisted: 9, sources: 120 }]);
    expect(got.consolidationRuns[0].skippedUnchanged).toBeUndefined();
  });
});

describe("aggregateDedupBatches（B4：LLM 调用均值）", () => {
  it("均值 = 总 LLM 调用 ÷ 批数；同时保留淘汰/候选总数", () => {
    const got = aggregateDedupBatches([
      { prefiltered: 4, llmCalls: 1, total: 6 },
      { prefiltered: 0, llmCalls: 3, total: 3 },
    ]);
    expect(got).toEqual({ batches: 2, prefiltered: 4, llmCalls: 4, candidateTotal: 9, meanLlmCallsPerBatch: 2 });
  });

  it("零批 => 均值为 null（不是 0，避免把「没跑」读成「跑得很省」）", () => {
    expect(aggregateDedupBatches([]).meanLlmCallsPerBatch).toBeNull();
  });
});

describe("summarizeSceneSizes（B3：单块字节）", () => {
  it("计数/总量/最大值/p50 且忽略非有限值", () => {
    const got = summarizeSceneSizes([100, 200, 300, 400, Number.NaN, Infinity]);
    expect(got.files).toBe(4);
    expect(got.totalBytes).toBe(1000);
    expect(got.maxBytes).toBe(400);
    expect(got.p50Bytes).toBe(200);
  });

  it("空清单 => 全 0 / p50=null", () => {
    expect(summarizeSceneSizes([])).toEqual({ files: 0, totalBytes: 0, maxBytes: 0, p50Bytes: null });
  });
});

describe("summarizeJournalGates（B2/B3/A3 读侧计数）", () => {
  const entries = [
    { gates: { validity: { active: 10, expired: 2, future: 0, dropped: 2, validEndFiltered: 2 } } },
    { gates: { validity: { active: 5, expired: 0, future: 0, dropped: 0, validEndFiltered: 0 } } },
    { gates: { selfNarration: { enabled: true, dropped: 3, scanned: 9 } } },
    {},
  ];

  it("只对含 validity 的轮次求和，并单独统计 selfNarration", () => {
    const got = summarizeJournalGates(entries);
    expect(got.rounds).toBe(4);
    expect(got.roundsWithValidity).toBe(2);
    expect(got.validityDropped).toBe(2);
    expect(got.validityExpired).toBe(2);
    expect(got.roundsWithSelfNarration).toBe(1);
    expect(got.selfNarrationDropped).toBe(3);
  });

  it("F7 三层形状：pool/top/injected 分别累加，injected 是注入差额", () => {
    const got = summarizeJournalGates([
      {
        gates: {
          validity: {
            mode: "hard",
            pool: { active: 8, expired: 2, future: 0, dropped: 2 },
            top: { active: 4, expired: 1, future: 0, dropped: 1 },
            injected: { active: 3, expired: 1, future: 0, dropped: 1 },
            validEndFiltered: 2,
          },
        },
      },
      {
        gates: {
          validity: {
            mode: "soft",
            pool: { active: 6, expired: 1, future: 1, dropped: 1 },
            top: { active: 5, expired: 1, future: 0, dropped: 0 },
            injected: { active: 5, expired: 0, future: 0, dropped: 0 },
            validEndFiltered: 1,
          },
        },
      },
    ]);
    expect(got.roundsWithValidity).toBe(2);
    expect(got.validityDropped).toBe(3); // pool 口径
    expect(got.validityTopDropped).toBe(1);
    expect(got.validityInjectedDropped).toBe(1); // 真少注入
    expect(got.validityExpired).toBe(3);
    expect(got.validityFuture).toBe(1);
  });

  it("缺字段/坏形状不抛错", () => {
    const got = summarizeJournalGates([{ gates: null }, { gates: { validity: { dropped: Number.NaN } } }]);
    expect(got.roundsWithValidity).toBe(1);
    expect(got.validityDropped).toBe(0);
  });
});
