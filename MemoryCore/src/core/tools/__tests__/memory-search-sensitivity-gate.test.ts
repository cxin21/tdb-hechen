/**
 * D-3（ADR-0025 决定 4）：敏感度注入门 · 工具路（executeMemorySearch → memory_search 返回）。
 *
 * 工具返回会原样进模型上下文，与注入块是同一"可见内容面"，因此必须用**同一谓词**
 * （sensitivity-policy）做同一次裁决；被拦行不出现在 results 里，并带出可核对计数。
 */
import { describe, expect, it } from "vitest";
import { executeMemorySearch, gateSensitivityForInjection } from "../memory-search.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const KW = "D3SENSPIN";

/** 六信号 + 候选池通道全 0 = 基线排序面（只留敏感门这一个变量）。 */
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

function row(id: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
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

function mockStore(vec: L1SearchResult[]): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false, l1FactVec: false }),
    searchL1Fts: async () => [],
    searchL1Vector: async () => vec,
    bumpRecallCount: () => true,
  } as unknown as IMemoryStore;
}

async function run(vec: L1SearchResult[], isolationFilter?: { userId?: string }) {
  return await executeMemorySearch({
    query: KW,
    limit: 10,
    vectorStore: mockStore(vec),
    embeddingService: embedding,
    scoreThreshold: 0.3,
    ...ALL_OFF,
    ...(isolationFilter ? { filter: isolationFilter } : {}),
  } as Parameters<typeof executeMemorySearch>[0]);
}

describe("D-3 敏感度注入门（工具路）", () => {
  it("无 owner 身份（undeclared）：敏感行不进 results，普通行照常返回", async () => {
    const res = await run([row("plain"), row("sens", { sensitivity: "relationship" })]);
    expect(res.results.map((r) => r.id)).toEqual(["plain"]);
    expect(res.sensitivity).toEqual({ audience: "undeclared", scanned: 1, blocked: 1, byReason: { undeclared: 1 } });
  });

  it("default 共享兜底桶：带 userId=default 仍不当私有", async () => {
    const res = await run([row("sens", { sensitivity: "health" })], { userId: "default" });
    expect(res.results).toHaveLength(0);
    expect(res.sensitivity?.audience).toBe("undeclared");
    expect(res.sensitivity?.blocked).toBe(1);
  });

  it("可验证 owner（private）：敏感行照常返回（生产今天的形态，逐位不变）", async () => {
    const res = await run([row("plain"), row("sens", { sensitivity: "finance" })], { userId: "usr-1" });
    expect(res.results.map((r) => r.id)).toEqual(["plain", "sens"]);
    expect(res.sensitivity).toEqual({ audience: "private", scanned: 1, blocked: 0 });
  });

  it("枚举外脏值：private 也拦（unclassified）", async () => {
    const res = await run([row("dirty", { sensitivity: "secret" })], { userId: "usr-1" });
    expect(res.results).toHaveLength(0);
    expect(res.sensitivity?.byReason).toEqual({ unclassified: 1 });
  });

  it("池里没有敏感行：不产出 sensitivity 观测（不塞噪声）", async () => {
    const res = await run([row("plain")]);
    expect(res.results).toHaveLength(1);
    expect(res.sensitivity).toBeUndefined();
  });

  it("空池：门是恒等，不产出观测、不抛错", async () => {
    const res = await run([]);
    expect(res.results).toHaveLength(0);
    expect(res.sensitivity).toBeUndefined();
    expect(gateSensitivityForInjection([], undefined).visible).toEqual([]);
  });
});
