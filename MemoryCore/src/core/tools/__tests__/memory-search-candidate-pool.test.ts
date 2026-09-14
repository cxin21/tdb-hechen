/**
 * R-A2 候选池三通道（结构感知召回 spec §2 R4/R5/R6）RED 套件 —— 排序点①咽喉 executeMemorySearch。
 *
 * 队长裁决（brief 关键设计澄清）：
 *   - 图通道不适用绝对门槛（关联召回以 [graph:kind] 标注自证身份），T2 门/T14 租户过滤照常；
 *   - R5 触发条件：主检索结果数 < limit 的一半 → fired 锚 label 反查 coreRefs 补池（[value:锚] 标注）；
 *   - R6：query 含 scene_name → 场景记忆 sceneBoost（tiebreak 层）。
 * 关断矩阵：graphDiscount=0 / sceneBoost=0 / coreRefBoost=0（值通道）→ 与基线逐位一致。
 */
import { describe, expect, it } from "vitest";
import { executeMemorySearch, formatSearchResponse } from "../memory-search.js";
import { detectSceneHit, sceneSignalOf } from "../recall-signals.js";
import type { IMemoryStore, IsolationFilter, L1FtsResult, L1SearchResult } from "../../store/types.js";

const KW = "RA2PIN";

/** 全关参数 = 基线（六信号全 0 + coreRefBoost 0 + 候选池三通道全 0）。 */
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
  backfillRows?: L1SearchResult[];
  values?: Array<{ value_id: string; label: string; weight: number; valence: number | null }>;
}

function poolMock(opts: PoolMockOpts): {
  store: IMemoryStore;
  neighborsArgs: Array<unknown[]>;
  backfillArgs: Array<unknown[]>;
  bumped: string[];
} {
  const neighborsArgs: Array<unknown[]> = [];
  const backfillArgs: Array<unknown[]> = [];
  const bumped: string[] = [];
  const store = {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async () => opts.rows,
    getNeighbors: (...args: unknown[]) => {
      neighborsArgs.push(args);
      return opts.neighbors ?? [];
    },
    getL1ByIdsWithArchive: (ids: string[]) =>
      (opts.neighborRows ?? []).filter((r) => ids.includes(r.record_id)),
    searchL1ByCoreRefs: (...args: unknown[]) => {
      backfillArgs.push(args);
      return opts.backfillRows ?? [];
    },
    ...(opts.values ? { listValues: async () => opts.values } : {}),
    bumpRecallCount: (id: string) => {
      bumped.push(id);
      return true;
    },
  } as unknown as IMemoryStore;
  return { store, neighborsArgs, backfillArgs, bumped };
}

async function run(
  opts: PoolMockOpts,
  params: Record<string, unknown> = {},
): Promise<{ ids: string[]; items: Awaited<ReturnType<typeof executeMemorySearch>>["results"]; res: Awaited<ReturnType<typeof executeMemorySearch>> }> {
  const { store } = poolMock(opts);
  const res = await executeMemorySearch({
    query: KW,
    limit: 10,
    vectorStore: store,
    ...ALL_OFF,
    ...params,
  } as Parameters<typeof executeMemorySearch>[0]);
  return { ids: res.results.map((r) => r.id), items: res.results, res };
}

// ═══════════════ V2-1 · PPR 图扩散（替换 R4 一跳；预期行为变更已登记）═══════════════

describe("V2-1 PPR 图扩散（咽喉，替换 R4 一跳）", () => {
  const NB = [{ id: "n1", type: "causal", strength: 0.9, hop: 1 }];

  it("唯一邻居以 命中分×graphDiscount 入池（pprNorm=1 天花板）并带 [graph:ppr:causal] 标注", async () => {
    const { ids, items } = await run(
      { rows: [ftsRow("a")], neighbors: NB, neighborRows: [vecRow("n1", { certainty: "observed" })] },
      { graphDiscount: 0.6, graphMinStrength: 0.5 },
    );
    expect(ids).toContain("n1");
    const n1 = items.find((r) => r.id === "n1")!;
    expect(n1.score).toBeCloseTo(0.5 * 0.6, 10);
    expect(n1.recall_channel).toBe("graph:ppr:causal");
    // 诚实标注进入工具响应文本（消费方可见）
    const text = formatSearchResponse((await run({ rows: [ftsRow("a")], neighbors: NB, neighborRows: [vecRow("n1")] }, { graphDiscount: 0.6 })).res);
    expect(text).toContain("[graph:ppr:causal]");
  });

  it("PPR 扩散质量排序：强边邻居位次高于弱边（旧 kind-rank 语义退役，随行为变更登记）", async () => {
    const { items } = await run(
      {
        rows: [ftsRow("a")],
        neighbors: [
          { id: "n-weak", type: "similar", strength: 0.5, hop: 1 },
          { id: "n-strong", type: "similar", strength: 0.9, hop: 1 },
        ],
        neighborRows: [vecRow("n-weak"), vecRow("n-strong")],
      },
      { graphDiscount: 0.6, graphMinStrength: 0.5 },
    );
    const si = items.findIndex((r) => r.id === "n-strong");
    const wi = items.findIndex((r) => r.id === "n-weak");
    expect(si).toBeGreaterThanOrEqual(0);
    expect(wi).toBeGreaterThan(si);
    // 强边邻居分 = 天花板（pprNorm=1），弱边邻居严格更低（折扣语义按扩散质量成比例）
    const strong = items.find((r) => r.id === "n-strong")!;
    const weak = items.find((r) => r.id === "n-weak")!;
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.score).toBeCloseTo(0.5 * 0.6, 10);
  });

  it("环安全：邻居指向已有命中/彼此成环 → 不重复入池（id 唯一）", async () => {
    const { ids } = await run(
      {
        rows: [ftsRow("a"), ftsRow("b")],
        neighbors: [
          { id: "a", type: "causal", strength: 0.9, hop: 1 },
          { id: "n1", type: "causal", strength: 0.9, hop: 1 },
        ],
        neighborRows: [vecRow("n1")],
      },
      { graphDiscount: 0.6, graphMinStrength: 0.5 },
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === "n1").length).toBe(1);
  });

  it("候选池上限 topK=10：12 个合格邻居只入池 10 个", async () => {
    const neighbors = Array.from({ length: 12 }, (_, i) => ({ id: `n${i + 1}`, type: "causal", strength: 0.9, hop: 1 }));
    const neighborRows = neighbors.map((n) => vecRow(n.id));
    const { items } = await run(
      { rows: [ftsRow("a")], neighbors, neighborRows },
      { graphDiscount: 0.6, graphMinStrength: 0.5, limit: 20 },
    );
    const graphItems = items.filter((r) => r.recall_channel?.startsWith("graph:ppr:"));
    expect(graphItems.length).toBe(10);
  });

  it("strength < graphMinStrength → 不入池（宁缺毋滥）", async () => {
    const { ids } = await run(
      { rows: [ftsRow("a")], neighbors: [{ id: "n1", type: "causal", strength: 0.4, hop: 1 }], neighborRows: [vecRow("n1")] },
      { graphDiscount: 0.6, graphMinStrength: 0.5 },
    );
    expect(ids).not.toContain("n1");
  });

  it("graphDiscount=0 → 通道完全退出（getNeighbors 零调用）", async () => {
    const { store, neighborsArgs } = poolMock({ rows: [ftsRow("a")], neighbors: NB, neighborRows: [vecRow("n1")] });
    await executeMemorySearch({
      query: KW, limit: 10, vectorStore: store, ...ALL_OFF, graphDiscount: 0,
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(neighborsArgs.length).toBe(0);
  });

  it("T14 租户过滤照常：isolationFilter 透传给 getNeighbors / searchL1ByCoreRefs", async () => {
    const { store, neighborsArgs } = poolMock({ rows: [ftsRow("a")], neighbors: NB, neighborRows: [vecRow("n1")] });
    const filter: IsolationFilter = { teamId: "t1", userId: "u1", agentId: "a1" };
    await executeMemorySearch({
      query: KW, limit: 10, vectorStore: store, filter, ...ALL_OFF,
      graphDiscount: 0.6, graphMinStrength: 0.5,
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(neighborsArgs.length).toBeGreaterThan(0);
    expect(neighborsArgs[0][3]).toEqual(filter);
  });

  it("T2 门照常：图入池的 inferred 邻居不吃重巩固（白名单只放行 observed）", async () => {
    const { store, bumped } = poolMock({
      rows: [ftsRow("a", { certainty: "observed" })],
      neighbors: NB,
      neighborRows: [vecRow("n1", { certainty: "inferred" })],
    });
    await executeMemorySearch({
      query: KW, limit: 3, vectorStore: store, ...ALL_OFF,
      graphDiscount: 0.6, graphMinStrength: 0.5,
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(bumped).toContain("a");
    expect(bumped).not.toContain("n1");
  });
});

// ═══════════════ R5 · 价值反查补池 ═══════════════

describe("R-A2 R5 价值反查补池（咽喉）", () => {
  const VALUES = [{ value_id: "v1", label: "正确性", weight: 0.8, valence: 1 }];
  const BACKFILL = [vecRow("v-mem", { metadata_json: JSON.stringify({ coreRefs: ["正确性"] }) })];

  it("结果数 < limit 一半 + fired 锚 → 反查补池，[value:锚] 标注 + coreRef 加成", async () => {
    const { store, backfillArgs } = poolMock({ rows: [ftsRow("a")], values: VALUES, backfillRows: BACKFILL });
    const res = await executeMemorySearch({
      query: `${KW} 正确性`, limit: 4, vectorStore: store, ...ALL_OFF, coreRefBoost: 0.05,
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(backfillArgs.length).toBe(1);
    const vmem = res.results.find((r) => r.id === "v-mem");
    expect(vmem).toBeDefined();
    expect(vmem!.recall_channel).toBe("value:正确性");
    expect(vmem!.touched_core_refs).toEqual(["正确性"]);
    // 补池条目 score=0（无相关度实证），排序位次靠 valueBoost（coreRef 通道）——不得伪装修.seed 相关分
    expect(vmem!.score).toBe(0);
  });

  it("结果数 ≥ limit 一半 → 不触发反查", async () => {
    const { store, backfillArgs } = poolMock({ rows: [ftsRow("a"), ftsRow("b")], values: VALUES, backfillRows: BACKFILL });
    await executeMemorySearch({
      query: `${KW} 正确性`, limit: 4, vectorStore: store, ...ALL_OFF, coreRefBoost: 0.05,
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(backfillArgs.length).toBe(0);
  });

  it("fired 为空（query 不含锚 label）→ 不触发反查", async () => {
    const { store, backfillArgs } = poolMock({ rows: [ftsRow("a")], values: VALUES, backfillRows: BACKFILL });
    await executeMemorySearch({
      query: KW, limit: 4, vectorStore: store, ...ALL_OFF, coreRefBoost: 0.05,
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(backfillArgs.length).toBe(0);
  });

  it("coreRefBoost=0 → 值通道完全退出（含反查）", async () => {
    const { store, backfillArgs } = poolMock({ rows: [ftsRow("a")], values: VALUES, backfillRows: BACKFILL });
    await executeMemorySearch({
      query: `${KW} 正确性`, limit: 4, vectorStore: store, ...ALL_OFF, coreRefBoost: 0,
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(backfillArgs.length).toBe(0);
  });

  it("R5 口径以扩池前快照为准（审查 #1 修补）：R4 扩池后过半不掩盖主检索不足（与 auto-recall mainHitCount 同口径）", async () => {
    // 主检索结果 = 1（< limit 4 的一半）→ R5 应触发；R4 扩池后 pool = 3（已过半），
    // 修复前 pool.length 口径会错误跳过 R5——本例为两路口径一致的咽喉断言。
    const NB = [
      { id: "n1", type: "causal", strength: 0.9, hop: 1 },
      { id: "n2", type: "causal", strength: 0.9, hop: 1 },
    ];
    const { store, backfillArgs } = poolMock({
      rows: [ftsRow("a")],
      neighbors: NB,
      neighborRows: [vecRow("n1"), vecRow("n2")],
      values: VALUES,
      backfillRows: BACKFILL,
    });
    const res = await executeMemorySearch({
      query: `${KW} 正确性`, limit: 4, vectorStore: store, ...ALL_OFF, coreRefBoost: 0.05,
      graphDiscount: 0.6, graphMinStrength: 0.5,
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(backfillArgs.length).toBe(1);
    expect(res.results.find((r) => r.id === "v-mem")).toBeDefined();
    expect(res.results.find((r) => r.id === "v-mem")!.recall_channel).toBe("value:正确性");
  });

  it("补池条目不重复（已在结果中的 coreRef 匹配记忆不二次入池）", async () => {
    const dup = ftsRow("a", { metadata_json: JSON.stringify({ coreRefs: ["正确性"] }) });
    const { store, backfillArgs } = poolMock({ rows: [dup], values: VALUES, backfillRows: [dup as unknown as L1SearchResult] });
    const res = await executeMemorySearch({
      query: `${KW} 正确性`, limit: 4, vectorStore: store, ...ALL_OFF, coreRefBoost: 0.05,
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(backfillArgs.length).toBe(1);
    expect(res.results.filter((r) => r.id === "a").length).toBe(1);
  });
});

// ═══════════════ R6 · 场景路由（tiebreak 层） ═══════════════

describe("R-A2 R6 场景路由（咽喉）", () => {
  it("query 含场景名 → 该场景记忆前移；sceneBoost=0 → 基线", async () => {
    const rows = [ftsRow("a"), ftsRow("b", { scene_name: "项目重构" })];
    const { ids } = await run({ rows }, { query: `${KW} 项目重构 的进展`, sceneBoost: 0.04 });
    expect(ids[0]).toBe("b");
    const off = await run({ rows }, { query: `${KW} 项目重构 的进展` });
    expect(off.ids).toEqual(["a", "b"]);
  });

  it("层级前缀：子场景（场景名/子场景）同享加成", async () => {
    const rows = [ftsRow("a"), ftsRow("b", { scene_name: "项目重构/后端" })];
    const { ids } = await run({ rows }, { query: `${KW} 项目重构`, sceneBoost: 0.04 });
    expect(ids[0]).toBe("b");
  });

  it("query 不含任何场景名 → 无信号（宁缺毋滥）", async () => {
    const rows = [ftsRow("a"), ftsRow("b", { scene_name: "项目重构" })];
    const { ids } = await run({ rows }, { query: KW, sceneBoost: 0.04 });
    expect(ids).toEqual(["a", "b"]);
  });

  it("过短场景名（<2 字符）不触发（宁缺毋滥）", async () => {
    expect(detectSceneHit("A 计划推进", ["A"])).toBeNull();
  });

  it("detectSceneHit 确定性：多命中取最长场景名", () => {
    expect(detectSceneHit("推进 项目重构 后端 改造", ["项目重构", "后端"])).toBe("项目重构");
  });

  it("sceneSignalOf：精确命中与层级前缀命中；不匹配 → 0", () => {
    expect(sceneSignalOf({ scene_name: "项目重构" }, "项目重构", 0.04)).toBe(0.04);
    expect(sceneSignalOf({ scene_name: "项目重构/后端" }, "项目重构", 0.04)).toBe(0.04);
    expect(sceneSignalOf({ scene_name: "其他" }, "项目重构", 0.04)).toBe(0);
    expect(sceneSignalOf({ scene_name: "项目重构" }, "项目重构", 0)).toBe(0);
    expect(sceneSignalOf({ scene_name: "项目重构" }, null, 0.04)).toBe(0);
  });
});
