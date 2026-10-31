/**
 * #151（fusion.mode="normalized" 工具路）与 #148（soft 效期沉底降权，工具路）回归。
 *
 * 两条红线：
 *  - normalized 关断（缺省 fusion=undefined）→ 主序仍是加权 RRF，逐位现状；
 *    开启后主序改由通道内归一化融合分（fusion.ts 单一源）决定，原文 dense 权重
 *    0.5 下不会被事实通道的高余弦反超（与钩子路 searchHybrid 同口径）。
 *  - soft = active 在前、expired 沉底 × penalty（缺省 0.5，可配）；
 *    hard/缺省 = 丢 expired；off/excludeInvalidated=false = 原样不丢不降权。
 */
import { describe, expect, it } from "vitest";
import { executeMemorySearch } from "../memory-search.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const KW = "R151NORMPIN";

/** 六信号 + 候选池通道全 0 = 基线排序面（本文件只动融合/效期两个变量）。 */
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
  exploreSlot: false,
} as const;

/** 纯相关度精排（其余因子权重 0）——否则组合分会用 timeProx/significance 重排。 */
const REL_ONLY = { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 } as const;

function vecRow(id: string, score: number, over: Partial<L1SearchResult> = {}): L1SearchResult {
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
    ...over,
  };
}

function ftsRow(id: string, score: number): L1FtsResult {
  return {
    record_id: id,
    content: `${KW} 记忆条目 ${id}`,
    type: "episodic",
    score,
    timestamp_str: "",
    scene_name: "",
    priority: 0,
  } as unknown as L1FtsResult;
}

const embedding = {
  embed: async () => new Float32Array([1, 0, 0]),
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])),
  getDimensions: () => 3,
  getProviderInfo: () => ({ provider: "stub", model: "stub" }),
  isReady: () => true,
  startWarmup: () => undefined,
} as unknown as EmbeddingService;

function mockStore(opts: {
  fts?: L1FtsResult[];
  vec?: L1SearchResult[];
  fact?: L1SearchResult[];
}): IMemoryStore {
  const store: Record<string, unknown> = {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false, l1FactVec: true }),
    searchL1Fts: async () => opts.fts ?? [],
    searchL1Vector: async () => opts.vec ?? [],
    searchL1FactVector: async () => opts.fact ?? [],
    bumpRecallCount: () => true,
  };
  return store as unknown as IMemoryStore;
}

type Params = Parameters<typeof executeMemorySearch>[0];

async function run(store: IMemoryStore, extra: Partial<Params> = {}) {
  return await executeMemorySearch({
    query: KW,
    limit: 10,
    vectorStore: store,
    embeddingService: embedding,
    scoreThreshold: 0.3,
    rerankWeights: REL_ONLY,
    ...ALL_OFF,
    ...extra,
  } as Params);
}

describe("#151 normalized 融合（工具路）", () => {
  it("缺省 fusion=undefined：主序仍是加权 RRF（逐位现状，且不打通道分）", async () => {
    const store = mockStore({ fts: [ftsRow("a", 12)], vec: [vecRow("a", 0.9)], fact: [vecRow("b", 1.0)] });
    const res = await run(store, { factChannel: { enabled: true, weight: 0.3 } });
    const ids = res.results.map((r) => r.id);
    // 事实候选只有 0.3/61，dense+fts 双命中是 2/61 → 原文命中在前
    expect(ids).toEqual(["a", "b"]);
    const a = res.results.find((r) => r.id === "a")!;
    const b = res.results.find((r) => r.id === "b")!;
    expect(a.score).toBeCloseTo(2 / 61, 12);
    expect(b.score).toBeCloseTo(0.3 / 61, 12);
  });

  it("normalized：主序由通道内归一化融合分决定（事实高余弦可越过弱 dense，dense 权重 0.5 主导）", async () => {
    const store = mockStore({ vec: [vecRow("denseWeak", 0.31)], fact: [vecRow("factStrong", 1.0)] });
    const res = await run(store, {
      factChannel: { enabled: true, weight: 0.3 },
      fusion: { mode: "normalized", dense: 0.5, bm25: 0.2, fact: 0.3 },
    });
    const ids = res.results.map((r) => r.id);
    expect(ids).toEqual(["factStrong", "denseWeak"]);
    const dense = res.results.find((r) => r.id === "denseWeak")!;
    const fact = res.results.find((r) => r.id === "factStrong")!;
    // 0.3×cos(1.0)=0.30 vs 0.5×cos(0.31)=0.155
    expect(fact.score).toBeCloseTo(0.3, 12);
    expect(dense.score).toBeCloseTo(0.155, 12);
  });

  it("normalized：dense 权重占优时事实通道不能仅凭高余弦反超原文 rank1", async () => {
    const store = mockStore({ vec: [vecRow("denseTop", 0.9)], fact: [vecRow("factTop", 0.95)] });
    const res = await run(store, {
      factChannel: { enabled: true, weight: 0.3 },
      fusion: { mode: "normalized", dense: 0.5, bm25: 0.2, fact: 0.3 },
    });
    expect(res.results.map((r) => r.id)).toEqual(["denseTop", "factTop"]);
    expect(res.results[0]!.score).toBeCloseTo(0.45, 12);
    expect(res.results[1]!.score).toBeCloseTo(0.285, 12);
  });

  it("normalized：事实路独占命中的条目带 ·[fact] 通道标注，双命中者不标注", async () => {
    const store = mockStore({
      fts: [ftsRow("both", 10)],
      vec: [vecRow("both", 0.8)],
      fact: [vecRow("both", 0.9), vecRow("factOnly", 0.7)],
    });
    const res = await run(store, {
      factChannel: { enabled: true, weight: 0.3 },
      fusion: { mode: "normalized", dense: 0.5, bm25: 0.2, fact: 0.3 },
    });
    const factOnly = res.results.find((r) => r.id === "factOnly")!;
    const both = res.results.find((r) => r.id === "both")!;
    expect(factOnly.recall_channel).toBe("fact");
    expect(both.recall_channel).toBeUndefined();
  });

  it("事实通道观测：factChannelObservation 上报 enabled/weight/merged/ms/hits", async () => {
    const store = mockStore({ vec: [vecRow("dense", 0.9)], fact: [vecRow("f1", 0.8), vecRow("f2", 0.7)] });
    const res = await run(store, {
      factChannel: { enabled: true, weight: 0.3 },
      fusion: { mode: "normalized", dense: 0.5, bm25: 0.2, fact: 0.3 },
    });
    const obs = res.factChannelObservation!;
    expect(obs.enabled).toBe(true);
    expect(obs.weight).toBeCloseTo(0.3, 12);
    expect(obs.hits).toBe(2);
    expect(obs.merged).toBe(2);
    expect(obs.ms).toBeGreaterThanOrEqual(0);
  });
});

describe("#148 soft 效期（工具路：沉底 + 降权）", () => {
  const rows = () => [vecRow("expired", 0.9, { valid_start: "2019-01-01", valid_end: "2020-01-01" }), vecRow("live", 0.5, { valid_start: "2026-01-01" })];

  it("soft：expired 沉底到 active 之后并 ×penalty（缺省 0.5 与钩子路同乘子）", async () => {
    const res = await run(mockStore({ vec: rows() }), { excludeInvalidated: "soft" });
    expect(res.results.map((r) => r.id)).toEqual(["live", "expired"]);
    expect(res.results[0]!.score).toBeCloseTo(0.5, 12);
    expect(res.results[1]!.score).toBeCloseTo(0.45, 12);
  });

  it("soft + 配置 penalty=0.25：乘子来自 recall.validity.softPenalty（不是硬编码 0.5）", async () => {
    const res = await run(mockStore({ vec: rows() }), { excludeInvalidated: "soft", validitySoftPenalty: 0.25 });
    expect(res.results.map((r) => r.id)).toEqual(["live", "expired"]);
    expect(res.results[1]!.score).toBeCloseTo(0.225, 12);
  });

  it("hard/缺省：expired 直接丢弃（原行为不变）", async () => {
    for (const mode of [undefined, true] as const) {
      const res = await run(mockStore({ vec: rows() }), mode === undefined ? {} : { excludeInvalidated: mode });
      expect(res.results.map((r) => r.id)).toEqual(["live"]);
    }
  });

  it("off（excludeInvalidated=false）：不丢不降权（#174 off 语义在工具路侧已成立）", async () => {
    const res = await run(mockStore({ vec: rows() }), { excludeInvalidated: false });
    expect(res.results.map((r) => r.id)).toEqual(["expired", "live"]);
    expect(res.results[0]!.score).toBeCloseTo(0.9, 12);
    expect(res.results[1]!.score).toBeCloseTo(0.5, 12);
  });

  it("时间旅行（validityNow）：按当时有效判定，不走降权", async () => {
    const res = await run(mockStore({ vec: rows() }), {
      excludeInvalidated: "soft",
      validityNow: new Date("2019-06-01T00:00:00Z"),
    });
    // 2019-06 时 expired 行仍生效、live 行还没开始（future → 丢）→ 只剩 expired 且不降权
    expect(res.results.map((r) => r.id)).toEqual(["expired"]);
    expect(res.results[0]!.score).toBeCloseTo(0.9, 12);
  });
});
