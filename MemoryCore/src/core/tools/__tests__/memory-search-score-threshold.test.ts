/**
 * §28（2026-11-05）：scoreThreshold 缺省 = 0（rank-only）—— tools 路径契约。
 *
 * 背景：0.3 是余弦刻度上的任意绝对值，会在融合前剪掉真证据（LME90 生成档 0.3→0
 * 判对 81→83、turn_cov +1.1pp、逐题 +2/0，见 docs/optimization-results.md §28）。
 * 本套件锁两件事：
 *   ① 不传 scoreThreshold ⇒ 门槛不剪（0.2 的候选也进池，语义门交给精排 + limit）；
 *   ② 显式传 0.3 ⇒ 旧行为可回滚（cosine < 0.3 的候选被拦）。
 */
import { describe, expect, it, vi } from "vitest";
import { executeMemorySearch } from "../memory-search.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";

const KW = "ST28PIN";

/** 全关信号参数 = 基线（与 memory-search-native-min-rrf.test.ts 同款）。 */
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

function row(id: string, score: number): L1SearchResult {
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

function vectorMock(scores: Array<[string, number]>) {
  const rows = scores.map(([id, s]) => row(id, s));
  const searchL1Vector = vi.fn(async () => rows);
  const store = {
    isFtsAvailable: () => true,
    getCapabilities: () => ({}),
    searchL1Vector,
    searchL1Fts: vi.fn(async () => []),
    bumpRecallCount: () => true,
  } as unknown as IMemoryStore;
  const embeddingService = { embed: vi.fn(async () => new Array(8).fill(0.1)) };
  return { store, embeddingService, searchL1Vector };
}

async function run(scores: Array<[string, number]>, params: Record<string, unknown> = {}) {
  const { store, embeddingService } = vectorMock(scores);
  const res = await executeMemorySearch({
    query: KW,
    limit: 10,
    vectorStore: store,
    embeddingService,
    ...ALL_OFF,
    ...params,
  } as unknown as Parameters<typeof executeMemorySearch>[0]);
  return res;
}

describe("§28 scoreThreshold 缺省 0（tools 路径）", () => {
  it("不传 scoreThreshold ⇒ 低余弦候选不被剪（0.2 也进池）", async () => {
    const res = await run([
      ["hi", 0.91],
      ["lo", 0.2],
    ]);
    expect(res.results.map((r) => r.id)).toEqual(["hi", "lo"]);
  });

  it("显式 0.3 ⇒ 回滚旧行为（0.2 被拦、0.91 留存）", async () => {
    const res = await run(
      [
        ["hi", 0.91],
        ["lo", 0.2],
      ],
      { scoreThreshold: 0.3 },
    );
    expect(res.results.map((r) => r.id)).toEqual(["hi"]);
  });
});
