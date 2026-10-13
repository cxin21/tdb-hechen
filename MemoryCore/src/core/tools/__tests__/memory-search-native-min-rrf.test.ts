/**
 * P0-2（issue #2）：nativeMinRRF 共识门槛回归测试（tools 路径，咽喉 executeMemorySearch）。
 *
 * native hybrid（TCVDB 服务端 RRF k=60）返回 rank-only 融合分：
 *   单通道 top1≈1/61≈0.0164、双通道 top1≈0.0328（刻度依据 verify-t1.ts:202-203）。
 *   scoreThreshold（0.3 余弦刻度）对其形同虚设 → 独立 nativeMinRRF 门（缺省 0=关=逐位现状）。
 */
import { describe, expect, it, vi } from "vitest";
import { executeMemorySearch } from "../memory-search.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";

const KW = "NRRFPIN";

/** 全关信号参数 = 基线（与 memory-search-candidate-pool.test.ts 同款）。 */
const ALL_OFF = {
  coreRefBoost: 0,
  timeBoost: 0,
  recencyBoost: 0,
  sigWeight: 0,
  inferredPenalty: 0,
  reinforcementWeight: 0,
  moodBoost: 0,
  graphDiscount: 0,
  sceneBoost: 0,
} as const;

function nativeRow(id: string, score: number): L1SearchResult {
  return {
    record_id: id,
    content: `${KW} 记忆条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "sk",
    session_id: "s",
    team_id: "t",
    task_id: "",
    user_id: "u",
    agent_id: "a",
    metadata_json: "{}",
  };
}

function nativeMock(scores: Array<[string, number]>, logger?: { info?: ReturnType<typeof vi.fn>; debug?: ReturnType<typeof vi.fn> }) {
  const results = scores.map(([id, score]) => nativeRow(id, score));
  const searchL1Hybrid = vi.fn(async () => results);
  const store = {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: true }),
    searchL1Hybrid,
    bumpRecallCount: () => true,
  } as unknown as IMemoryStore;
  return { store, searchL1Hybrid, logger };
}

async function runNative(scores: Array<[string, number]>, params: Record<string, unknown> = {}, logger?: { info?: ReturnType<typeof vi.fn>; debug?: ReturnType<typeof vi.fn> }) {
  const { store, searchL1Hybrid } = nativeMock(scores, logger);
  const res = await executeMemorySearch({
    query: KW,
    limit: 10,
    vectorStore: store,
    logger,
    ...ALL_OFF,
    ...params,
  } as Parameters<typeof executeMemorySearch>[0]);
  return { res, searchL1Hybrid };
}

describe("P0-2 nativeMinRRF（tools 路径，native hybrid 共识门槛）", () => {
  // 典型 TCVDB RRF 分数样本：0.0328=双通道 top1；0.0161=单通道 top-2；0.008=单通道尾部
  const SAMPLE: Array<[string, number]> = [["a", 0.0328], ["b", 0.0161], ["c", 0.008]];

  it("未配置（缺省 0）= 逐位现状：3 条全留", async () => {
    const { res } = await runNative(SAMPLE);
    expect(res.results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(res.strategy).toBe("hybrid");
  });

  it("门槛 0.016：单通道尾部 (0.008) 被拦，双通道与单通道 top-2 留存", async () => {
    const { res } = await runNative(SAMPLE, { nativeMinRRF: 0.016 });
    expect(res.results.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("门槛 0.03：仅双通道 top-1 留存（宁缺毋滥）", async () => {
    const { res } = await runNative(SAMPLE, { nativeMinRRF: 0.03 });
    expect(res.results.map((r) => r.id)).toEqual(["a"]);
  });

  it("门槛生效且有淘汰 → logger.info 留痕（kept/dropped/gate，可观测性）", async () => {
    const info = vi.fn();
    const debug = vi.fn();
    await runNative(SAMPLE, { nativeMinRRF: 0.016 }, { info, debug });
    expect(info).toHaveBeenCalledTimes(1);
    const msg = String(info.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("nativeMinRRF gate");
    expect(msg).toContain("kept=2");
    expect(msg).toContain("dropped=1/3");
    expect(msg).toContain("gate=0.016");
  });

  it("门槛生效但无淘汰 → 不产生 info 噪音", async () => {
    const info = vi.fn();
    await runNative(SAMPLE, { nativeMinRRF: 0.005 }, { info, debug: vi.fn() });
    expect(info).not.toHaveBeenCalled();
  });

  it("全部低于门槛 → 0 条（宁缺毋滥，不回退放行）", async () => {
    const { res } = await runNative([["x", 0.004], ["y", 0.006]], { nativeMinRRF: 0.016 });
    expect(res.results).toEqual([]);
  });
});
