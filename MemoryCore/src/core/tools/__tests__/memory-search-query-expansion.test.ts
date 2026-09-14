/**
 * V2-2 引擎一 · FTS OR 合并集成 RED 套件（§E1.3）——两路（咽喉 executeMemorySearch + auto-recall searchHybrid）。
 *
 * 行为断言：扩展词并入 FTS MATCH 后候选扩大（扩展词独占命中的条目浮现）；
 * LLM 失败 → 原 query 照常（退化逐位基线）；enabled=false → runner 零调用；
 * 向量路不动（无 FTS 构建点改动断言隐含于 mock FTS 过滤语义）。
 */
import { describe, expect, it } from "vitest";
import { executeMemorySearch } from "../memory-search.js";
import { searchHybrid } from "../../hooks/auto-recall.js";
import type { IMemoryStore, L1FtsResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { ExpansionRunner } from "../../recall/query-expand.js";

const KW = "V2QE";

function ftsRow(id: string, content: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: id,
    content,
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

/** FTS mock：按 MATCH 表达式 token 子串过滤（模拟"词面命中"），并记录每次收到的 ftsQuery。 */
function ftsFilterStore(rows: L1FtsResult[]): { store: IMemoryStore; ftsQueries: string[] } {
  const ftsQueries: string[] = [];
  const store = {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async (q: string) => {
      ftsQueries.push(q);
      const toks = q.split(" OR ").map((t) => t.replaceAll('"', ""));
      return rows.filter((r) => toks.some((tok) => tok.length >= 2 && r.content.includes(tok)));
    },
    searchL1Vector: async () => [],
    bumpRecallCount: () => true,
  } as unknown as IMemoryStore;
  return { store, ftsQueries };
}

const ROWS = [
  ftsRow("main", `${KW} 主条目 全面性`),
  ftsRow("exp", "覆盖率 红牌 矩阵（不含主关键词）"),
];

function runner(reply: () => string): ExpansionRunner {
  return { run: async () => reply() } as unknown as ExpansionRunner;
}

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

describe("V2-2 E1.3 咽喉 executeMemorySearch：FTS OR 合并", () => {
  it("扩展词并入 MATCH：扩展词独占命中条目浮现（无扩展时不存在）", async () => {
    const { store, ftsQueries } = ftsFilterStore(ROWS);
    const on = await executeMemorySearch({
      query: `${KW} 提高全面性`,
      limit: 10,
      vectorStore: store,
      ...ALL_OFF,
      queryExpansion: { enabled: true, ttlMs: 0, timeoutMs: 8000, maxTerms: 8, runner: runner(() => '["覆盖率","红牌"]') },
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(on.results.some((r) => r.id === "exp")).toBe(true);
    // FTS MATCH 表达式包含扩展词（词面足迹 widening）
    expect(ftsQueries.some((q) => q.includes('"覆盖率"') && q.includes('"红牌"'))).toBe(true);

    const { store: store2 } = ftsFilterStore(ROWS);
    const off = await executeMemorySearch({
      query: `${KW} 提高全面性`,
      limit: 10,
      vectorStore: store2,
      ...ALL_OFF,
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(off.results.some((r) => r.id === "exp")).toBe(false);
  });

  it("LLM 失败 → 无扩展，原 query 照常（退化逐位基线，不抛错）", async () => {
    const { store } = ftsFilterStore(ROWS);
    const res = await executeMemorySearch({
      query: `${KW} 提高全面性失败退化`,
      limit: 10,
      vectorStore: store,
      ...ALL_OFF,
      queryExpansion: {
        enabled: true, ttlMs: 0, timeoutMs: 8000, maxTerms: 8,
        runner: runner(() => { throw new Error("llm down"); }),
      },
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(res.results.map((r) => r.id)).toEqual(["main"]);
  });

  it("enabled=false → 通道退出（runner 零调用，基线逐位）", async () => {
    let called = 0;
    const { store } = ftsFilterStore(ROWS);
    const res = await executeMemorySearch({
      query: `${KW} 提高全面性关断`,
      limit: 10,
      vectorStore: store,
      ...ALL_OFF,
      queryExpansion: {
        enabled: false, ttlMs: 0, timeoutMs: 8000, maxTerms: 8,
        runner: runner(() => { called++; return '["覆盖率"]'; }),
      },
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(called).toBe(0);
    expect(res.results.map((r) => r.id)).toEqual(["main"]);
  });

  it("TTL 缓存：同 query 二次搜索 runner 只调一次（ttl>0）", async () => {
    let called = 0;
    const { store } = ftsFilterStore(ROWS);
    const q = `${KW} TTL 缓存探针`;
    await executeMemorySearch({
      query: q, limit: 10, vectorStore: store, ...ALL_OFF,
      queryExpansion: { enabled: true, ttlMs: 60_000, timeoutMs: 8000, maxTerms: 8, runner: runner(() => { called++; return '["覆盖率"]'; }) },
    } as Parameters<typeof executeMemorySearch>[0]);
    await executeMemorySearch({
      query: q, limit: 10, vectorStore: store, ...ALL_OFF,
      queryExpansion: { enabled: true, ttlMs: 60_000, timeoutMs: 8000, maxTerms: 8, runner: runner(() => { called++; return '["覆盖率"]'; }) },
    } as Parameters<typeof executeMemorySearch>[0]);
    expect(called).toBe(1);
  });
});

describe("V2-2 E1.3 auto-recall 路 searchHybrid：同层 FTS OR 合并", () => {
  const emb = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;

  it("扩展词经 searchHybrid 并入关键词路：扩展词独占命中条目浮现", async () => {
    const { store } = ftsFilterStore(ROWS);
    const on = await searchHybrid(
      `${KW} 提高全面性 auto`, "", 10, 0.3, store, emb, undefined, undefined, undefined,
      0, undefined, ["覆盖率", "红牌"],
    );
    expect(on.lines.some((l) => l.includes("覆盖率 红牌 矩阵"))).toBe(true);

    const { store: store2 } = ftsFilterStore(ROWS);
    const off = await searchHybrid(`${KW} 提高全面性 auto`, "", 10, 0.3, store2, emb);
    expect(off.lines.some((l) => l.includes("覆盖率 红牌 矩阵"))).toBe(false);
  });
});
