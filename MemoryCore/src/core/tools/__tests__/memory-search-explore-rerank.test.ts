/**
 * V2-3 引擎三 · 注意力平衡（E3.1 探索位）+ RV2 精排重设计 RED 套件 —— 排序点①咽喉 executeMemorySearch。
 *
 * RV2-2（brief 裁决）：候选合并后、截断前——相关度主导组合分精排
 * （0.70×relevanceNorm + 0.15×timeProx + 0.10×sigNorm + 0.05×coreRefHit；权重可配；
 * 全 0 = 精排关断，稳定排序逐位基线；relevance=0 = 纯时间/显著排序——预期行为变更已登记）。
 * E3.1（spec §E3.1）：最终排序后、截断前——若前 N 窗口内无合格候选，末位替换为
 * "结构命中（[graph:ppr]/[value:]/scene）且 recall_count < 池内中位数"的池内候选，
 * 带 [explore] 标注；候选不足时退化为原排序。
 */
import { describe, expect, it } from "vitest";
import {
  applyCompositeRerank,
  applyExploreSlot,
  isStructuralChannel,
  DEFAULT_COMPOSITE_WEIGHTS,
  type CompositeFactors,
} from "../memory-search.js";
import { executeMemorySearch, formatSearchResponse } from "../memory-search.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult } from "../../store/types.js";

const KW = "V2BAL";

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

function ftsRow(id: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: id,
    content: `${KW} 记忆条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score: 0.5,
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
    metadata_json: "",
    ...over,
  };
}

function vecRow(id: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content: `${KW} 邻居条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score: 0,
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
    ...over,
  };
}

interface PoolMockOpts {
  rows: L1FtsResult[];
  neighbors?: Array<{ id: string; type: string; strength: number; hop: number }>;
  neighborRows?: L1SearchResult[];
}

function poolMock(opts: PoolMockOpts): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async () => opts.rows,
    getNeighbors: () => opts.neighbors ?? [],
    getL1ByIdsWithArchive: (ids: string[]) => (opts.neighborRows ?? []).filter((r) => ids.includes(r.record_id)),
    bumpRecallCount: () => true,
  } as unknown as IMemoryStore;
}

async function run(opts: PoolMockOpts, params: Record<string, unknown> = {}) {
  const res = await executeMemorySearch({
    query: KW,
    limit: 10,
    vectorStore: poolMock(opts),
    ...ALL_OFF,
    ...params,
  } as Parameters<typeof executeMemorySearch>[0]);
  return res;
}

// ═══════════════ 共享纯函数（两排序点单一源）═══════════════

describe("V2-3 共享纯函数（单一源，两排序点对齐）", () => {
  it("isStructuralChannel：graph:/value:/scene: 前缀为真，主检索缺省为假", () => {
    expect(isStructuralChannel("graph:ppr:causal")).toBe(true);
    expect(isStructuralChannel("value:正确性")).toBe(true);
    expect(isStructuralChannel("scene:项目重构")).toBe(true);
    expect(isStructuralChannel(undefined)).toBe(false);
    expect(isStructuralChannel("explore")).toBe(false);
  });

  it("applyCompositeRerank：相关度主导四因子组合降序；work_fact 层不越层；全 0 权重 = 稳定基线序", () => {
    const now = new Date("2026-09-11T00:00:00Z");
    const items: Array<{ id: string; factors: CompositeFactors }> = [
      { id: "a", factors: { relevance: 0.5, occurredAt: "2026-09-10T00:00:00Z", significance: 0.1, coreRefCount: 0, isWorkFact: false } },
      { id: "b", factors: { relevance: 0.3, occurredAt: "2026-09-10T00:00:00Z", significance: 0.1, coreRefCount: 3, isWorkFact: false } },
      { id: "wf", factors: { relevance: 0.1, occurredAt: "2026-09-10T00:00:00Z", significance: 0.2, coreRefCount: 0, isWorkFact: true } },
    ];
    // 默认权重 0.7/0.15/0.1/0.05：a relevanceNorm=1.0（主因子）压过 b 的 coreRef 命中
    const reranked = applyCompositeRerank(items, (it) => it.factors, DEFAULT_COMPOSITE_WEIGHTS, now);
    expect(reranked.map((r) => r.id)).toEqual(["wf", "a", "b"]);
    // relevance=0（预期行为变更登记）：退化纯时间/显著排序——b 凭 coreRef+同分显著反超 a
    const noRel = applyCompositeRerank(items, (it) => it.factors, { relevance: 0, timeProx: 0.15, significance: 0.1, coreRef: 0.05 }, now);
    expect(noRel.map((r) => r.id)).toEqual(["wf", "b", "a"]);
    const stable = applyCompositeRerank(items, (it) => it.factors, { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 }, now);
    // 全 0 权重：组合分恒 0 → 层内稳定基线序；work_fact 分层不属权重信号，仍在前
    expect(stable.map((r) => r.id)).toEqual(["wf", "a", "b"]);
    expect(DEFAULT_COMPOSITE_WEIGHTS).toEqual({ relevance: 0.7, timeProx: 0.15, significance: 0.1, coreRef: 0.05 });
  });

  it("applyCompositeRerank：relevanceNorm 池内 max 归一（两类候选同尺度）；纯相关度权重 = 分数序", () => {
    const now = new Date("2026-09-11T00:00:00Z");
    const items: Array<{ id: string; factors: CompositeFactors }> = [
      { id: "hit1", factors: { relevance: 0.016, occurredAt: null, significance: 0, coreRefCount: 0, isWorkFact: false } },
      { id: "hit2", factors: { relevance: 0.008, occurredAt: null, significance: 0, coreRefCount: 0, isWorkFact: false } },
      { id: "graph", factors: { relevance: 0.004, occurredAt: null, significance: 0, coreRefCount: 0, isWorkFact: false } },
    ];
    const relOnly = applyCompositeRerank(items, (it) => it.factors, { relevance: 0.7, timeProx: 0, significance: 0, coreRef: 0 }, now);
    // relevanceNorm 单调于原始分 → 纯相关度权重序 = 分数降序（基线序，关断矩阵断言同源）
    expect(relOnly.map((r) => r.id)).toEqual(["hit1", "hit2", "graph"]);
    // relevanceNorm 池内 max 归一：graph 派生分（0.016×0.15×pprNorm≈0.004）恒低于命中
    // （折扣语义保持）——即便 timeProx 满分偏袒 graph 的 occurred_at，0.7 权重的相关度差
    // 仍由主因子裁决（hit2 relevanceNorm=0.5 vs graph=0.25，主因子差 0.175 > 结构因子全额 0.3×max）
    const withTime = applyCompositeRerank(
      items,
      (it) => ({ ...it.factors, occurredAt: it.id === "graph" ? "2026-09-11T00:00:00Z" : null }),
      DEFAULT_COMPOSITE_WEIGHTS,
      now,
    );
    expect(withTime.map((r) => r.id)).toEqual(["hit1", "hit2", "graph"]);
  });

  it("applyExploreSlot：窗口无合格候选 → 末位替换为最低 recall_count 结构命中 + 标注；池不超窗 → 原样", () => {
    const pool = [
      { id: "a", channel: undefined, recallCount: 10 },
      { id: "b", channel: undefined, recallCount: 10 },
      { id: "c", channel: undefined, recallCount: 10 },
      { id: "n", channel: "graph:ppr:causal", recallCount: 0 },
    ];
    const out = applyExploreSlot(pool, 3, (p) => ({ channel: p.channel, recallCount: p.recallCount }), (p) => ({ ...p, marked: true }));
    expect(out.map((p) => p.id)).toEqual(["a", "b", "n"]);
    expect((out[2] as { marked?: boolean }).marked).toBe(true);

    const short = applyExploreSlot(pool.slice(0, 3), 3, (p) => ({ channel: p.channel, recallCount: p.recallCount }), (p) => p);
    expect(short.map((p) => p.id)).toEqual(["a", "b", "c"]);

    // 窗口内已有合格低频结构命中 → 不动（E3.1 "前 N 全为高 recall_count" 条件不成立）
    const pool2 = [
      { id: "a", channel: "value:v", recallCount: 0 },
      { id: "b", channel: undefined, recallCount: 10 },
      { id: "c", channel: undefined, recallCount: 10 },
      { id: "n", channel: "graph:ppr:causal", recallCount: 1 },
    ];
    const out2 = applyExploreSlot(pool2, 3, (p) => ({ channel: p.channel, recallCount: p.recallCount }), (p) => p);
    expect(out2.map((p) => p.id)).toEqual(["a", "b", "c", "n"]);
  });
});

// ═══════════════ 咽喉排序点：精排 + 探索位集成 ═══════════════

describe("V2-3 咽喉 executeMemorySearch：组合分精排 + 探索位", () => {
  it("探索位：结构命中且低 recall_count 候选占末席 + [explore] 标注（响应文本可见）", async () => {
    const rows = ["a", "b", "c", "d", "e"].map((id) =>
      ftsRow(id, { metadata_json: JSON.stringify({ recall_count: 10 }) }),
    );
    const res = await run(
      {
        rows,
        neighbors: [{ id: "n1", type: "causal", strength: 0.9, hop: 1 }],
        neighborRows: [vecRow("n1")],
      },
      { graphDiscount: 0.6, graphMinStrength: 0.5, limit: 3 },
    );
    expect(res.results.map((r) => r.id)).toEqual(["a", "b", "n1"]);
    expect(res.results[2]!.recall_channel).toBe("graph:ppr:causal:explore");
    const text = formatSearchResponse(res);
    expect(text).toContain("explore");
  });

  it("exploreSlot=false → 通道退出（原排序逐位）", async () => {
    const rows = ["a", "b", "c", "d", "e"].map((id) =>
      ftsRow(id, { metadata_json: JSON.stringify({ recall_count: 10 }) }),
    );
    const res = await run(
      {
        rows,
        neighbors: [{ id: "n1", type: "causal", strength: 0.9, hop: 1 }],
        neighborRows: [vecRow("n1")],
      },
      { graphDiscount: 0.6, graphMinStrength: 0.5, limit: 3, exploreSlot: false },
    );
    expect(res.results.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("组合分精排：significance/coreRef 因子改变截断前位次；全 0 权重 = 关断恒等", async () => {
    // b: significance 0.9；a: 无因子。两行 FTS 同分（relevanceNorm 相等）→ 相关度不裁决，
    // 显著因子开 → b 前移；全 0 权重 → 基线 a,b
    const rows = [ftsRow("a"), ftsRow("b", { significance: 0.9 })];
    const on = await run({ rows }, { rerankWeights: { relevance: 0, timeProx: 0, significance: 1, coreRef: 0 } });
    expect(on.results.map((r) => r.id)).toEqual(["b", "a"]);
    const off = await run({ rows }, { rerankWeights: { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 } });
    expect(off.results.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("RV2-2 相关度主导：relevance 因子按 fused score 裁决位次（同分显著因子不得越过相关度差）", async () => {
    // FTS 行分可调：a score 0.9、b score 0.3（b 显著 0.9）。默认权重下相关度主因子
    // 差（0.7×(1-1/3)=0.467）> b 的全额结构加成（0.15×1+0.1×0.9+0=0.24）→ a 仍在前。
    const rows = [ftsRow("a", { score: 0.9 }), ftsRow("b", { score: 0.3, significance: 0.9, occurred_at: "2026-09-11T00:00:00Z" })];
    const res = await run({ rows }, { rerankWeights: { relevance: 0.7, timeProx: 0.15, significance: 0.1, coreRef: 0.05 } });
    expect(res.results.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
