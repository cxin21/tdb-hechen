/**
 * #137（W1 双通道）·工具路（tdai_memory_search → executeMemorySearch）事实键平行通道。
 *
 * 与钩子路（auto-recall.searchHybrid）同一红线：
 *  - 通道关闭 / store 未实现 / 无命中 → 与改动前逐位一致（关断矩阵）；
 *  - 开启后事实候选按 weight × 1/(60+rank+1) 并入 RRF，原文 dense 相关度仍是主序主导；
 *  - minScore / onlyForTypes 门控与钩子路同口径。
 */
import { describe, expect, it } from "vitest";
import { executeMemorySearch } from "../memory-search.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const KW = "R137FACTPIN";

/** 六信号 + 候选池通道全 0 = 基线排序面（只留事实通道这一个变量）。 */
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

function vecRow(id: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content: `${KW} 记忆条目 ${id}`,
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
    metadata_json: "{}",
    ...over,
  };
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
  withFactMethod?: boolean;
}): { store: IMemoryStore; factCalls: number[] } {
  const factCalls: number[] = [];
  const store: Record<string, unknown> = {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async () => opts.fts ?? [],
    searchL1Vector: async () => opts.vec ?? [],
    bumpRecallCount: () => true,
  };
  if (opts.withFactMethod !== false) {
    store.searchL1FactVector = async (_vec: Float32Array, topK: number) => {
      factCalls.push(topK);
      return opts.fact ?? [];
    };
  }
  return { store: store as unknown as IMemoryStore, factCalls };
}

async function run(
  store: IMemoryStore,
  factChannel?: Parameters<typeof executeMemorySearch>[0]["factChannel"],
) {
  return await executeMemorySearch({
    query: KW,
    limit: 10,
    vectorStore: store,
    embeddingService: embedding,
    scoreThreshold: 0.3,
    ...ALL_OFF,
    ...(factChannel ? { factChannel } : {}),
  } as Parameters<typeof executeMemorySearch>[0]);
}

describe("#137 工具路事实键平行通道", () => {
  it("通道关闭：只回原文向量命中（逐位现状，且不调用 searchL1FactVector）", async () => {
    const { store, factCalls } = mockStore({ vec: [vecRow("a")], fact: [vecRow("b", { score: 0.95 })] });
    const res = await run(store);
    expect(res.results.map((r) => r.id)).toEqual(["a"]);
    expect(factCalls).toEqual([]);
  });

  it("通道开启：事实候选并入池并按 weight 打折（原文命中仍在前）", async () => {
    const { store } = mockStore({ vec: [vecRow("a")], fact: [vecRow("b", { score: 0.95 })] });
    const res = await run(store, { enabled: true, weight: 0.6 });
    const ids = res.results.map((r) => r.id);
    expect(ids).toEqual(["a", "b"]);
    const b = res.results.find((r) => r.id === "b")!;
    const a = res.results.find((r) => r.id === "a")!;
    // RRF：a = 1/61（dense rank1）；b = 0.6 × 1/61（只有事实通道命中）
    expect(a.score).toBeCloseTo(1 / 61, 10);
    expect(b.score).toBeCloseTo(0.6 / 61, 10);
  });

  it("事实通道 minScore / onlyForTypes 门控生效", async () => {
    const { store } = mockStore({
      vec: [vecRow("a")],
      fact: [vecRow("b", { score: 0.95 }), vecRow("c", { score: 0.95, type: "work_fact" })],
    });
    const minGated = await run(store, { enabled: true, weight: 0.6, minScore: 0.99 });
    expect(minGated.results.map((r) => r.id)).toEqual(["a"]);
    const typeGated = await run(store, { enabled: true, weight: 0.6, onlyForTypes: ["work_fact"] });
    expect(typeGated.results.map((r) => r.id)).toContain("c");
    expect(typeGated.results.map((r) => r.id)).not.toContain("b");
  });

  it("store 未实现 searchL1FactVector（tcvdb 等）：通道静默退出，不抛错", async () => {
    const { store } = mockStore({ vec: [vecRow("a")], fact: [vecRow("b")], withFactMethod: false });
    const res = await run(store, { enabled: true, weight: 0.6 });
    expect(res.results.map((r) => r.id)).toEqual(["a"]);
  });

  it("事实通道是唯一命中源时也能召回（strategy 仍标 embedding 系）", async () => {
    const { store } = mockStore({ vec: [], fact: [vecRow("b", { score: 0.9 })] });
    const res = await run(store, { enabled: true, weight: 0.6 });
    expect(res.results.map((r) => r.id)).toEqual(["b"]);
    expect(res.strategy).toBe("embedding");
  });
});
