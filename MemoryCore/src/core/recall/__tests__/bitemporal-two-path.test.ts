/**
 * P1 Task 8（bi-temporal 补口，M4 #6）—— 钩子路/工具路两路排除一致性 E2E。
 *
 * 验收（plan Task 8 / design §7）：失效记忆与未来生效记忆在钩子路（performLayeredRecall
 * 注入块）与工具路（executeMemorySearch）都不召回；restore（清 valid_end）后两路都恢复；
 * 解析失败的行保留（宁缺毋滥）；as-of（validityNow 时间旅行）两路同判。
 *
 * harness：mock store（ftsRow 厂 + searchL1Fts 单通道）——同 auto-recall-rerank /
 * memory-search-candidate-pool 既有 idiom。API 写面（invalidate/restore）由
 * gateway/__tests__/atomic-invalidate.test.ts 单测钉死；本套件钉读面（两路召回）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performLayeredRecall } from "../../hooks/auto-recall.js";
import { executeMemorySearch } from "../../tools/memory-search.js";
import type { IMemoryStore, L1FtsResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { MemoryTdaiConfig } from "../../../config.js";

const KW = "T8Probe";
const NOW = new Date("2026-09-15T12:00:00.000Z");

const IDS = {
  normal: "t8-normal",
  invalidated: "t8-invalidated",
  future: "t8-future",
  parseFail: "t8-parsefail",
} as const;

function ftsRow(id: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: id,
    content: `${KW} ${id} 记忆条目`,
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

/** 四行种子：正常 / 已失效（valid_end 过去）/ 未来生效（valid_start 未来）/ 解析失败。 */
function seedRows(): L1FtsResult[] {
  return [
    ftsRow(IDS.normal, { valid_start: "2026-01-01T00:00:00.000Z" }),
    ftsRow(IDS.invalidated, { valid_start: "2026-01-01T00:00:00.000Z", valid_end: "2026-09-01T00:00:00.000Z" }),
    ftsRow(IDS.future, { valid_start: "2099-12-01T00:00:00.000Z", valid_end: "2099-12-20T00:00:00.000Z" }),
    ftsRow(IDS.parseFail, { valid_end: "not-a-date" }),
  ];
}

function ftsStore(rows: L1FtsResult[]): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async (_q: string, k: number) => rows.slice(0, k),
    searchL1Vector: async () => [],
    getNeighbors: () => [],
    getL1ByIdsWithArchive: () => [],
    searchL1ByCoreRefs: () => [],
  } as unknown as IMemoryStore;
}

function mockEmbedding(): EmbeddingService {
  return { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
}

/** 信号全 0 组合分（确定性基线，同 auto-recall-rerank makeCfg）。 */
function makeCfg(): MemoryTdaiConfig {
  return {
    recall: {
      enabled: true,
      strategy: "hybrid",
      timeoutMs: 5000,
      maxResults: 5,
      scoreThreshold: 0.3,
      coreRefBoost: 0,
      graphDiscount: 0,
      sceneBoost: 0,
      timeBoost: 0,
      recencyBoost: 0,
      sigWeight: 0,
      inferredPenalty: 0,
      reinforcementWeight: 0,
      moodBoost: 0,
      emotionSalienceWeight: 0,
      sensitivityPenalty: 0,
      exploreSlot: false,
      rerankWeights: { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 },
      queryEmbeddingCacheTtlMs: 0,
      sessionReuseTtlMs: 300_000,
      // R71-C fts-only 注入帽与双时态排除语义正交，显式关断（0）；
      // 帽行为在 auto-recall-conclusion-gate.test.ts 覆盖。
      ftsOnlyInjectCap: 0,
    },
  } as unknown as MemoryTdaiConfig;
}

/** 钩子路：performLayeredRecall 注入行 → 命中的种子 id 列表。 */
async function hookIds(rows: L1FtsResult[], validityNow?: Date): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t8-two-path-"));
  try {
    const res = await performLayeredRecall({
      userText: `${KW} 探针`,
      sessionKey: "", // 空 sessionKey → 复用缓存整体关断
      cfg: makeCfg(),
      pluginDataDir: dir,
      vectorStore: ftsStore(rows),
      embeddingService: mockEmbedding(),
      ...(validityNow ? { validityNow } : {}),
    });
    const lines = (res as { memoryLines?: string[] }).memoryLines ?? [];
    return Object.values(IDS).filter((id) => lines.some((l) => l.includes(id)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 工具路：executeMemorySearch 结果 id 列表。 */
async function toolIds(rows: L1FtsResult[], validityNow?: Date): Promise<string[]> {
  const res = await executeMemorySearch({
    query: KW,
    limit: 10,
    vectorStore: ftsStore(rows),
    coreRefBoost: 0, timeBoost: 0, recencyBoost: 0, sigWeight: 0,
    inferredPenalty: 0, reinforcementWeight: 0, moodBoost: 0,
    graphDiscount: 0, sceneBoost: 0,
    ...(validityNow ? { validityNow } : {}),
  } as Parameters<typeof executeMemorySearch>[0]);
  return res.results.map((r) => r.id);
}

const KEPT_AFTER_INVALIDATE = [IDS.normal, IDS.parseFail].sort();

describe("P1 Task 8 · 失效/未来生效两路排除一致性（E2E）", () => {
  it("invalidate（valid_end 过去）+ 未来生效 → 两路都不召回；解析失败保留", async () => {
    const rows = seedRows();
    const hook = (await hookIds(rows)).sort();
    const tool = (await toolIds(rows)).sort();
    expect(hook).toEqual(KEPT_AFTER_INVALIDATE);
    expect(tool).toEqual(KEPT_AFTER_INVALIDATE);
  });

  it("restore（valid_end 清空）→ 两路都恢复该行；未来生效行仍排除", async () => {
    const rows = seedRows();
    // restore 后的 store 形态 = 该行 valid_end 清空（写面由 atomic-invalidate 单测钉死）
    const restored = rows.find((r) => r.record_id === IDS.invalidated)!;
    restored.valid_end = "";
    const hook = (await hookIds(rows)).sort();
    const tool = (await toolIds(rows)).sort();
    expect(hook).toEqual([IDS.invalidated, IDS.normal, IDS.parseFail].sort());
    expect(tool).toEqual([IDS.invalidated, IDS.normal, IDS.parseFail].sort());
  });

  it("as-of 时间旅行（validityNow=NOW）：未来生效行两路同判排除", async () => {
    const rows = seedRows().map((r) =>
      r.record_id === IDS.future ? { ...r, valid_end: "" } : r, // 开放端未来生效行
    );
    const hook = (await hookIds(rows, NOW)).sort();
    const tool = (await toolIds(rows, NOW)).sort();
    expect(hook).toEqual(KEPT_AFTER_INVALIDATE);
    expect(tool).toEqual(KEPT_AFTER_INVALIDATE);
  });
});
