/**
 * R-A2 候选池三通道 RED 套件 —— 排序点② auto-recall searchHybrid（C5 教训：两路同层对齐）。
 * V2-1 PPR 图扩散（[graph:ppr:kind] 标注，替换 R4 一跳——行为变更已登记 + T14/T2 照常语义同工具路）/
 * 价值反查补池 / 场景路由（rankKey 层）。
 */
import { describe, expect, it } from "vitest";
import { searchHybrid } from "../auto-recall.js";
import { ZERO_RANK_SIGNALS, type RankSignals } from "../../tools/recall-signals.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const Q = "RA2H 查询";

function hit(id: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content: `RA2H 记忆条目 ${id}`,
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

interface HybridMockOpts {
  hits: L1SearchResult[];
  neighbors?: Array<{ id: string; type: string; strength: number; hop: number }>;
  neighborRows?: L1SearchResult[];
  backfillRows?: L1SearchResult[];
}

function hybridMock(opts: HybridMockOpts): { vectorStore: IMemoryStore; embeddingService: EmbeddingService; neighborsArgs: Array<unknown[]>; backfillArgs: Array<unknown[]> } {
  const neighborsArgs: Array<unknown[]> = [];
  const backfillArgs: Array<unknown[]> = [];
  const vectorStore = {
    isFtsAvailable: () => false,
    searchL1Vector: async () => opts.hits,
    getNeighbors: (...args: unknown[]) => {
      neighborsArgs.push(args);
      return opts.neighbors ?? [];
    },
    getL1ByIdsWithArchive: (ids: string[]) => (opts.neighborRows ?? []).filter((r) => ids.includes(r.record_id)),
    searchL1ByCoreRefs: (...args: unknown[]) => {
      backfillArgs.push(args);
      return opts.backfillRows ?? [];
    },
  } as unknown as IMemoryStore;
  const embeddingService = {
    embed: async () => new Float32Array(4),
  } as unknown as EmbeddingService;
  return { vectorStore, embeddingService, neighborsArgs, backfillArgs };
}

function rank(over: Partial<{ boost: number; firedLabels: string[]; moodSign: number; signals: RankSignals; graph: { minStrength: number; discount: number }; sceneBoost: number }> = {}) {
  return {
    boost: 0,
    firedLabels: [],
    moodSign: 0,
    timeWindow: null,
    signals: ZERO_RANK_SIGNALS,
    now: new Date(),
    ...over,
  };
}

async function lines(
  opts: HybridMockOpts,
  r?: Parameters<typeof searchHybrid>[8],
  maxResults = 10,
  query = Q,
  /** RV2-2：精排四因子权重（缺省 undefined = 默认相关度主导 0.7/0.15/0.1/0.05）。 */
  rerankWeights?: Parameters<typeof searchHybrid>[13],
): Promise<string[]> {
  const { vectorStore, embeddingService } = hybridMock(opts);
  const res = await searchHybrid(query, "", maxResults, 0.3, vectorStore, embeddingService, undefined, undefined, r, undefined, undefined, undefined, undefined, rerankWeights);
  return res.lines;
}

// ═══════════════ V2-1 · PPR 图扩散（替换 R4 一跳；预期行为变更已登记）═══════════════

describe("V2-1 PPR 图扩散（auto-recall，替换 R4 一跳）", () => {
  const NB = [{ id: "n1", type: "causal", strength: 0.9, hop: 1 }];
  const NROWS = [hit("n1", { content: "RA2H 邻居条目 n1" })];

  it("邻居入池并带 [graph:ppr:causal] 标注", async () => {
    const ls = await lines({ hits: [hit("a")], neighbors: NB, neighborRows: NROWS }, rank({ graph: { minStrength: 0.5, discount: 0.6 } }));
    const n1 = ls.find((l) => l.includes("n1"));
    expect(n1).toBeDefined();
    expect(n1).toContain("[graph:ppr:causal]");
  });

  it("graphDiscount=0（rank 缺 graph）→ 通道退出（getNeighbors 零调用）", async () => {
    const { vectorStore, embeddingService, neighborsArgs } = hybridMock({ hits: [hit("a")], neighbors: NB, neighborRows: NROWS });
    await searchHybrid(Q, "", 10, 0.3, vectorStore, embeddingService, undefined, undefined, rank());
    expect(neighborsArgs.length).toBe(0);
  });

  it("strength < minStrength → 不入池", async () => {
    const ls = await lines(
      { hits: [hit("a")], neighbors: [{ id: "n1", type: "causal", strength: 0.4, hop: 1 }], neighborRows: NROWS },
      rank({ graph: { minStrength: 0.5, discount: 0.6 } }),
    );
    expect(ls.some((l) => l.includes("n1"))).toBe(false);
  });

  it("上限 topK=10", async () => {
    const neighbors = Array.from({ length: 12 }, (_, i) => ({ id: `n${i + 1}`, type: "causal", strength: 0.9, hop: 1 }));
    const ls = await lines(
      { hits: [hit("a")], neighbors, neighborRows: neighbors.map((n) => hit(n.id)) },
      rank({ graph: { minStrength: 0.5, discount: 0.6 } }),
      20,
    );
    const graphLines = ls.filter((l) => l.includes("[graph:ppr:"));
    expect(graphLines.length).toBe(10);
  });
});

// ═══════════════ R5 · 价值反查补池 ═══════════════

describe("R-A2 R5 价值反查补池（auto-recall）", () => {
  const BACKFILL = [hit("v-mem", { content: "RA2H 价值条目 v-mem", metadata_json: JSON.stringify({ coreRefs: ["正确性"] }) })];

  it("结果 < limit 一半 + fired → 补池且带 [value:锚] 标注", async () => {
    const { vectorStore, embeddingService, backfillArgs } = hybridMock({ hits: [hit("a")], backfillRows: BACKFILL });
    const res = await searchHybrid(
      `${Q} 正确性`, "", 4, 0.3, vectorStore, embeddingService, undefined, undefined,
      rank({ boost: 0.05, firedLabels: ["正确性"] }),
    );
    expect(backfillArgs.length).toBe(1);
    const line = res.lines.find((l) => l.includes("v-mem"));
    expect(line).toBeDefined();
    expect(line).toContain("[value:正确性]");
  });

  it("结果 ≥ limit 一半 → 不触发", async () => {
    const { vectorStore, embeddingService, backfillArgs } = hybridMock({ hits: [hit("a"), hit("b")], backfillRows: BACKFILL });
    await searchHybrid(
      `${Q} 正确性`, "", 4, 0.3, vectorStore, embeddingService, undefined, undefined,
      rank({ boost: 0.05, firedLabels: ["正确性"] }),
    );
    expect(backfillArgs.length).toBe(0);
  });

  it("R5 口径以扩池前 mainHitCount 为准（审查 #1 两路口径一致）：R4 扩池后过半不掩盖主检索不足", async () => {
    // 与工具路 memory-search-candidate-pool.test.ts 同构造镜像：主检索 = 1（< limit 4
    // 一半）→ R5 触发；R4 扩池后池 = 3（已过半）不得改判——两路同用扩池前快照。
    const NB = [
      { id: "n1", type: "causal", strength: 0.9, hop: 1 },
      { id: "n2", type: "causal", strength: 0.9, hop: 1 },
    ];
    const { vectorStore, embeddingService, backfillArgs } = hybridMock({
      hits: [hit("a")],
      neighbors: NB,
      neighborRows: [hit("n1"), hit("n2")],
      backfillRows: BACKFILL,
    });
    const res = await searchHybrid(
      `${Q} 正确性`, "", 4, 0.3, vectorStore, embeddingService, undefined, undefined,
      rank({ boost: 0.05, firedLabels: ["正确性"], graph: { minStrength: 0.5, discount: 0.6 } }),
    );
    expect(backfillArgs.length).toBe(1);
    expect(res.lines.find((l) => l.includes("v-mem"))).toBeDefined();
  });

  it("boost=0（值通道关）→ 不触发", async () => {
    const { vectorStore, embeddingService, backfillArgs } = hybridMock({ hits: [hit("a")], backfillRows: BACKFILL });
    await searchHybrid(
      `${Q} 正确性`, "", 4, 0.3, vectorStore, embeddingService, undefined, undefined,
      rank({ boost: 0, firedLabels: ["正确性"] }),
    );
    expect(backfillArgs.length).toBe(0);
  });
});

// ═══════════════ R6 · 场景路由 ═══════════════

describe("R-A2 R6 场景路由（auto-recall）", () => {
  it("query 含场景名 → 真平局组内场景记忆前移；sceneBoost 缺省 → 基线（三刀语义对齐——跨档不可测信号，登记）", async () => {
    // FIX3 同款隔离（RV2-2 登记）+ 排序三刀对齐（2026-09-12）：R6 场景加成仅在跨通道真平局
    // 组内生效——单列表跨档 fixture 已不可测信号（与工具侧 5fc7962 同构，登记）。
    // 双路真平局：a(fts r0) ≡ b(vec r0) 同为 1/61。ON：tie 组内 sceneBoost → b 前。
    const W_OFF = { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 } as const;
    const vectorStore = {
      isFtsAvailable: () => true,
      searchL1Fts: async () => [hit("a")],
      searchL1Vector: async () => [hit("b", { scene_name: "项目重构" })],
    } as unknown as IMemoryStore;
    const embeddingService = {
      embed: async () => new Float32Array(4),
    } as unknown as EmbeddingService;
    const ls = (await searchHybrid(
      "RA2H 查询 项目重构", "", 10, 0.3, vectorStore, embeddingService, undefined, undefined,
      rank({ sceneBoost: 0.04 }), undefined, undefined, undefined, undefined, W_OFF,
    )).lines;
    const order = ls.map((l) => (l.includes("条目 b") ? "b" : "a"));
    expect(order[0]).toBe("b");
    const off = (await searchHybrid(
      "RA2H 查询 项目重构", "", 10, 0.3, vectorStore, embeddingService, undefined, undefined,
      rank(), undefined, undefined, undefined, undefined, W_OFF,
    )).lines;
    expect(off.map((l) => (l.includes("条目 b") ? "b" : "a"))[0]).toBe("a");
  });

  it("RV2-2 预期行为变更（登记）：相关度主导精排下，单名次 RRF 差压过 sceneBoost tiebreak", async () => {
    // a 在向量路排名 0（rrf 1/61）> b 排名 1（1/62）→ relevance 主因子差 ~1.9e-4（归一后
    // ×0.7）；b 的 sceneBoost 0.04 属 rankKey 层、不进组合分 → 默认精排下 a 仍在前。
    // 这正是"相关度主导"契约的落地：结构 tiebreak 只在相关度同分时起作用。
    const hits = [hit("a"), hit("b", { scene_name: "项目重构" })];
    const ls = await lines({ hits }, rank({ sceneBoost: 0.04 }), 10, "RA2H 查询 项目重构");
    const order = ls.map((l) => (l.includes("条目 b") ? "b" : "a"));
    expect(order[0]).toBe("a");
  });
});

// ═══════════════ R-A1 审查 M-2 · 两路合并 first-wins 钉死（S7 第 3 项）═══════════════

function ftsHit(id: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: id,
    content: `M2PIN 双路条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score: 0.9,
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

describe("R-A1 审查 M-2：同记录 FTS/向量两路合并 first-wins（S7 钉死）", () => {
  it("同 id 双路命中 → 单条目；FTS（先到）侧 formatable/coreRef 保留，向量侧只叠加 rrfScore", async () => {
    // 位次设计（可判别 first-wins vs last-wins）：
    //   x: FTS rank0（rrf 1/61）+ 向量 rank1（rrf 1/62）≈ 0.03252；
    //      FTS 侧 metadata 带 coreRefs ["正确性"] → first-wins 下 coreRefHit=+0.05；
    //      向量侧 metadata_json 空 → last-wins 下 coreRefHit=0。
    //   y: 向量 rank0 + significance 1.0（sigWeight 0.03 → +0.03）≈ 0.04639。
    //   first-wins：x=0.0825 > y=0.0464 → x 居首；last-wins：x=0.0325 < y → y 居首。
    const fts = [ftsHit("x", { metadata_json: JSON.stringify({ coreRefs: ["正确性"] }) })];
    const vec = [
      hit("y", { score: 0.9, significance: 1.0 }),
      hit("x", { score: 0.8, metadata_json: "" }),
    ];
    const vectorStore = {
      isFtsAvailable: () => true,
      searchL1Fts: async () => fts,
      searchL1Vector: async () => vec,
      getCapabilities: () => ({ nativeHybridSearch: false }),
    } as unknown as IMemoryStore;
    const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
    const res = await searchHybrid(
      "M2PIN", "", 10, 0.3, vectorStore, embeddingService, undefined, undefined,
      rank({ boost: 0.05, firedLabels: ["正确性"], signals: { ...ZERO_RANK_SIGNALS, sigWeight: 0.03 } }),
    );
    const xLines = res.lines.filter((l) => l.includes("x"));
    expect(xLines).toHaveLength(1); // 两路同记录合并去重：只出一条
    expect(xLines[0]).toContain("双路条目 x"); // first-wins：formatable 取 FTS（先到）侧
    expect(res.lines[0]).toBe(xLines[0]); // first-wins：FTS 侧 coreRef +0.05 → x 居首
  });
});
