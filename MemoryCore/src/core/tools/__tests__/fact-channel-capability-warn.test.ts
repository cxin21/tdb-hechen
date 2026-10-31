/**
 * #152 ① · 工具路事实通道：能力位守卫（fail-closed + WARN-once）。
 *
 * 退化路径必须「有痕迹地降级」而不是静默空跑：
 *  - store 未声明 l1FactVec（tcvdb 等服务端 embedding 后端）→ searchL1FactVector **零调用** + WARN 一次；
 *  - 通道未开启 → 零调用且不 WARN（正常配置，不是能力缺失）；
 *  - 能力位 true（sqlite）→ 行为与改动前逐位一致（照常并池）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { executeMemorySearch } from "../memory-search.js";
import { __resetCapabilityWarnings } from "../../store/capability-guard.js";
import type { IMemoryStore, L1SearchResult, StoreCapabilities } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const KW = "R152FACTCAP";

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

/** l1FactVec 能力位可配的 store；事实方法始终存在（证明「有方法但没能力位」也走守卫）。 */
function mockStore(opts: { caps: StoreCapabilities; vec?: L1SearchResult[]; fact?: L1SearchResult[] }) {
  const factCalls: Array<{ topK: number }> = [];
  const store: Record<string, unknown> = {
    isFtsAvailable: () => true,
    getCapabilities: () => opts.caps,
    searchL1Fts: async () => [],
    searchL1Vector: async () => opts.vec ?? [],
    searchL1FactVector: async (_vec: Float32Array, topK: number) => {
      factCalls.push({ topK });
      return opts.fact ?? [];
    },
    bumpRecallCount: () => true,
  };
  return { store: store as unknown as IMemoryStore, factCalls };
}

const CAPS_TCVDB: StoreCapabilities = {
  vectorSearch: true,
  ftsSearch: true,
  nativeHybridSearch: false,
  sparseVectors: false,
  l1FactVec: false,
};
const CAPS_SQLITE: StoreCapabilities = { ...CAPS_TCVDB, l1FactVec: true };

type SearchOptions = Parameters<typeof executeMemorySearch>[0];

async function run(store: IMemoryStore, factChannel: SearchOptions["factChannel"], warns: string[]) {
  const options: SearchOptions = {
    query: KW,
    limit: 10,
    vectorStore: store,
    embeddingService: embedding,
    scoreThreshold: 0.3,
    ...ALL_OFF,
    ...(factChannel ? { factChannel } : {}),
    logger: { warn: (m: string) => { warns.push(m); }, debug: () => {}, info: () => {}, error: () => {} },
  };
  return await executeMemorySearch(options);
}

function capabilityWarns(warns: string[]): string[] {
  return warns.filter((m) => m.includes("[capability]") && m.includes("l1FactVec"));
}

beforeEach(() => __resetCapabilityWarnings());

describe("#152 ① 工具路事实通道 · 能力位守卫", () => {
  it("tcvdb（l1FactVec=false）：零调用 + WARN 一次，主向量命中不受影响", async () => {
    const { store, factCalls } = mockStore({
      caps: CAPS_TCVDB,
      vec: [vecRow("a")],
      fact: [vecRow("b", { score: 0.95 })],
    });
    const warns: string[] = [];
    const res = await run(store, { enabled: true, weight: 0.6 }, warns);
    expect(factCalls).toEqual([]);
    expect(res.results.map((r) => r.id)).toEqual(["a"]);
    expect(capabilityWarns(warns)).toHaveLength(1);
    expect(capabilityWarns(warns)[0]).toContain("l1_fact_vec");
  });

  it("WARN-once：同进程内多次检索只留一条（避免每轮 recall 刷屏）", async () => {
    const { store, factCalls } = mockStore({ caps: CAPS_TCVDB, vec: [vecRow("a")] });
    const warns: string[] = [];
    await run(store, { enabled: true, weight: 0.6 }, warns);
    await run(store, { enabled: true, weight: 0.6 }, warns);
    await run(store, { enabled: true, weight: 0.6 }, warns);
    expect(factCalls).toEqual([]);
    expect(capabilityWarns(warns)).toHaveLength(1);
  });

  it("通道未开启：零调用且不 WARN（正常配置，不是能力缺失）", async () => {
    const { store, factCalls } = mockStore({ caps: CAPS_TCVDB, vec: [vecRow("a")] });
    const warns: string[] = [];
    await run(store, undefined, warns);
    expect(factCalls).toEqual([]);
    expect(capabilityWarns(warns)).toEqual([]);
  });

  it("sqlite（l1FactVec=true）：照常调用事实通道、不 WARN（行为不回退）", async () => {
    const { store, factCalls } = mockStore({
      caps: CAPS_SQLITE,
      vec: [vecRow("a")],
      fact: [vecRow("b", { score: 0.95 })],
    });
    const warns: string[] = [];
    const res = await run(store, { enabled: true, weight: 0.6 }, warns);
    expect(factCalls).toHaveLength(1);
    expect(res.results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(capabilityWarns(warns)).toEqual([]);
  });

  it("能力位缺失（老 store / mock 未声明）：按不可用处理（fail-closed + WARN）", async () => {
    const { store, factCalls } = mockStore({
      caps: { vectorSearch: true, ftsSearch: true, nativeHybridSearch: false, sparseVectors: false } as StoreCapabilities,
      vec: [vecRow("a")],
      fact: [vecRow("b", { score: 0.95 })],
    });
    const warns: string[] = [];
    const res = await run(store, { enabled: true, weight: 0.6 }, warns);
    expect(factCalls).toEqual([]);
    expect(res.results.map((r) => r.id)).toEqual(["a"]);
    expect(capabilityWarns(warns)).toHaveLength(1);
  });
});
