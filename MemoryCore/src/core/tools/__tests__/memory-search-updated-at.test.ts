/**
 * B 项（ADR-0025 决定 9，2026-11-04）：memory_search 出参 updated_at / event_end_at 双语义。
 *
 * 语义契约：
 *  - updated_at  = 行的**最近更新时间**（l1_records.updated_time）——旧后端/未补列路径
 *                  缺该列时回退 timestamp_end（事件结束时刻），保证出参恒为可用时间戳；
 *  - event_end_at = 行承载的**事件结束时刻**（l1_records.timestamp_end），恒取该列。
 * timestamp_end 列本身保留不变（既有消费方零影响）。
 *
 * 覆盖三条路径：向量路（searchL1Vector）、FTS 路（searchL1Fts）、以及 updated_time 缺省回退。
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeMemorySearch } from "../memory-search.js";
import { VectorStore } from "../../store/sqlite.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult, MemoryRecord } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const KW = "R-B-UPDATED-AT-PIN";

/** 六信号 + 候选池通道 + 事实通道全 0 = 基线排序面（只留被断言的映射这一个变量）。 */
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

const UPDATED_TIME = "2026-11-02T03:04:05Z";
const TIMESTAMP_END = "2026-11-01T00:00:00Z";

function vecRow(id: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content: `${KW} 记忆条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score: 0.9,
    timestamp_str: "2026-10-31T00:00:00Z",
    timestamp_start: "2026-10-31T00:00:00Z",
    timestamp_end: TIMESTAMP_END,
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

function ftsRow(id: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: id,
    content: `${KW} 记忆条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score: 0.8,
    timestamp_str: "2026-10-31T00:00:00Z",
    timestamp_start: "2026-10-31T00:00:00Z",
    timestamp_end: TIMESTAMP_END,
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

function mockStore(opts: { fts?: L1FtsResult[]; vec?: L1SearchResult[] }): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    // #152 ①：能力位显式声明（事实通道关闭——本套件不考通道合并）。
    getCapabilities: () => ({ nativeHybridSearch: false, l1FactVec: false }),
    searchL1Fts: async () => opts.fts ?? [],
    searchL1Vector: async () => opts.vec ?? [],
    bumpRecallCount: () => true,
  } as unknown as IMemoryStore;
}

async function run(store: IMemoryStore) {
  return await executeMemorySearch({
    query: KW,
    limit: 10,
    vectorStore: store,
    embeddingService: embedding,
    scoreThreshold: 0.3,
    ...ALL_OFF,
  } as Parameters<typeof executeMemorySearch>[0]);
}

describe("B 项：memory_search updated_at / event_end_at 双语义", () => {
  it("向量路：updated_at 取 updated_time（行最近更新时间）", async () => {
    const store = mockStore({ vec: [vecRow("v1", { updated_time: UPDATED_TIME })] });
    const res = await run(store);
    const row = res.results.find((r) => r.id === "v1");
    expect(row).toBeDefined();
    expect(row!.updated_at).toBe(UPDATED_TIME);
  });

  it("向量路：event_end_at 取 timestamp_end（事件结束时刻），且不受 updated_time 影响", async () => {
    const store = mockStore({ vec: [vecRow("v2", { updated_time: UPDATED_TIME })] });
    const res = await run(store);
    const row = res.results.find((r) => r.id === "v2");
    expect(row).toBeDefined();
    expect(row!.event_end_at).toBe(TIMESTAMP_END);
    // 双语义不得混：event_end_at 与 updated_at 是两列两个值
    expect(row!.event_end_at).not.toBe(row!.updated_at);
  });

  it("updated_time 缺省（旧后端不带该列）→ updated_at 回退 timestamp_end", async () => {
    const store = mockStore({ vec: [vecRow("v3")] });
    const res = await run(store);
    const row = res.results.find((r) => r.id === "v3");
    expect(row).toBeDefined();
    expect(row!.updated_at).toBe(TIMESTAMP_END);
    expect(row!.event_end_at).toBe(TIMESTAMP_END);
  });

  it("updated_time 为空串（DDL DEFAULT ''）→ 视为未写，updated_at 回退 timestamp_end（不吐 \"\"）", async () => {
    const store = mockStore({ vec: [vecRow("v4", { updated_time: "" })] });
    const res = await run(store);
    const row = res.results.find((r) => r.id === "v4");
    expect(row).toBeDefined();
    expect(row!.updated_at).toBe(TIMESTAMP_END);
    expect(row!.event_end_at).toBe(TIMESTAMP_END);
  });

  it("FTS 路：updated_at 取 updated_time（子查询带出）", async () => {
    const store = mockStore({ vec: [], fts: [ftsRow("f1", { updated_time: UPDATED_TIME })] });
    const res = await run(store);
    const row = res.results.find((r) => r.id === "f1");
    expect(row).toBeDefined();
    expect(row!.updated_at).toBe(UPDATED_TIME);
    expect(row!.event_end_at).toBe(TIMESTAMP_END);
  });
});

/**
 * 真库回归：上面四条用 mock store，测不到 sqlite.ts 的 SELECT 站点。
 * 2026-11-04 实测曾发现 stmtGetMeta 少选 updated_time → getL1ByIds / searchL1Vector /
 * searchL1FactVector 的 updated_time 恒 undefined，memory_search 静默回退 timestamp_end
 * （mock 用例全绿也发现不了）。本条把「读库能否带出该列」钉成回归。
 */
describe("B 项：真库（VectorStore）updated_time 透传", () => {
  const dirs: string[] = [];
  const stores: VectorStore[] = [];
  afterEach(() => {
    while (stores.length) stores.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const DIM = 8;
  const realEmbedding = {
    embed: async () => new Float32Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0))),
    getDimensions: () => DIM,
    getProviderInfo: () => ({ provider: "stub", model: "stub" }),
    isReady: () => true,
    startWarmup: () => undefined,
  } as unknown as EmbeddingService;

  it("写库 updatedAt≠事件时间 → memory_search 的 updated_at=updatedAt、event_end_at=事件时间", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b-updated-at-"));
    dirs.push(dir);
    const store = new VectorStore(join(dir, "v.db"), DIM);
    stores.push(store);
    const init = store.init();
    if (store.isDegraded()) throw new Error(`临时库降级（环境问题）：${init.reason}`);

    const record = {
      id: "real1",
      content: `${KW} 真库条目 alpha`,
      type: "work_fact",
      priority: 0.5,
      certainty: "observed",
      scene_name: "s",
      source_message_ids: [],
      metadata: {},
      timestamps: [TIMESTAMP_END],
      createdAt: "2026-10-31T00:00:00Z",
      updatedAt: UPDATED_TIME,
      occurred_at: null,
      valid_start: null,
      valid_end: null,
      version: 0,
      sessionKey: "k",
      sessionId: "s",
      teamId: "t",
      userId: "u",
      agentId: "a",
    } as unknown as MemoryRecord;
    expect(store.upsertL1(record, new Float32Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)))).toBe(true);

    const res = await executeMemorySearch({
      query: KW,
      limit: 10,
      vectorStore: store,
      embeddingService: realEmbedding,
      scoreThreshold: 0.3,
      ...ALL_OFF,
    } as Parameters<typeof executeMemorySearch>[0]);

    const row = res.results.find((r) => r.id === "real1");
    expect(row).toBeDefined();
    expect(row!.updated_at).toBe(UPDATED_TIME);
    expect(row!.event_end_at).toBe(TIMESTAMP_END);
  });
});
