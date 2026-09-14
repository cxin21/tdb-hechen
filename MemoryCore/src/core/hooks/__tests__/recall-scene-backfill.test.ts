/**
 * R7-2 L1 经验层 RED 套件（分层召回 DS-RECALL-LAYERED-R7-001 §2 R7-2）。
 * ① sqlite searchL1ByScene：同 scene 精确 + 层级前缀过滤 + T14 租户两步过滤（filter 缺省=旧行为）；
 * ② searchHybrid scene 反查补池：part_of 证据链优先 + 同 scene 过滤 + 预算未满才补 + [scene:名] 标注；
 * ③ 关断矩阵：layered 缺省/空 → getNeighbors/searchL1ByScene 零调用（每通道关断=基线逐位）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchHybrid } from "../auto-recall.js";
import { VectorStore } from "../../store/sqlite.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const Q = "R7E 查询";

function hit(id: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content: `R7E 记忆条目 ${id}`,
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

interface BackfillMockOpts {
  mainHits: L1SearchResult[];
  neighbors?: Array<{ id: string; type: string; strength: number; hop: number }>;
  evidenceRows?: L1SearchResult[];
  sceneRows?: L1SearchResult[];
}

function backfillMock(opts: BackfillMockOpts): {
  vectorStore: IMemoryStore;
  embeddingService: EmbeddingService;
  neighborsIds: string[];
  sceneArgs: unknown[];
} {
  const neighborsIds: string[] = [];
  const sceneArgs: unknown[] = [];
  const vectorStore = {
    isFtsAvailable: () => false,
    searchL1Vector: async () => opts.mainHits,
    getNeighbors: (id: string, ...rest: unknown[]) => {
      neighborsIds.push(id);
      void rest;
      return opts.neighbors ?? [];
    },
    getL1ByIdsWithArchive: (ids: string[]) => (opts.evidenceRows ?? []).filter((r) => ids.includes(r.record_id)),
    searchL1ByScene: (...args: unknown[]) => {
      sceneArgs.push(args);
      return opts.sceneRows ?? [];
    },
  } as unknown as IMemoryStore;
  const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
  return { vectorStore, embeddingService, neighborsIds, sceneArgs };
}

const LAYERED = {
  excludeIds: [],
  conclusionRefs: [{ id: "wf1", sceneName: "项目重构" }],
  sceneNames: ["项目重构", "场景B"],
};

// ═══════════════ R7-2 · searchHybrid scene 反查补池 ═══════════════

describe("R7-2 searchHybrid scene 反查补池（part_of 证据链优先 + 同 scene 过滤）", () => {
  it("池未满 + 结论在场 → part_of 证据入池且带 [scene:名] 标注，主检索结果仍在前", async () => {
    const m = backfillMock({
      mainHits: [hit("a")],
      neighbors: [{ id: "ev1", type: "part_of", strength: 1, hop: 1 }],
      evidenceRows: [hit("ev1", { content: "R7E 证据条目 ev1" })],
    });
    const res = await searchHybrid(Q, "", 4, 0.3, m.vectorStore, m.embeddingService, undefined, undefined, undefined, undefined, LAYERED);
    expect(m.neighborsIds).toEqual(["wf1"]);
    const ev = res.lines.find((l) => l.includes("ev1"));
    expect(ev).toBeDefined();
    expect(ev).toContain("[scene:项目重构]");
    expect(res.lines[0]).toContain("条目 a"); // 主检索位次不被补池行越过
  });

  it("part_of 证据优先于同 scene 记录（同分数下插入序即输出序）", async () => {
    const m = backfillMock({
      mainHits: [hit("a")],
      neighbors: [{ id: "ev1", type: "part_of", strength: 1, hop: 1 }],
      evidenceRows: [hit("ev1", { content: "R7E 证据条目 ev1" })],
      sceneRows: [hit("sc1", { content: "R7E 同场景条目 sc1", scene_name: "场景B" })],
    });
    const res = await searchHybrid(Q, "", 4, 0.3, m.vectorStore, m.embeddingService, undefined, undefined, undefined, undefined, LAYERED);
    const evIdx = res.lines.findIndex((l) => l.includes("ev1"));
    const scIdx = res.lines.findIndex((l) => l.includes("sc1"));
    expect(evIdx).toBeGreaterThan(-1);
    expect(scIdx).toBeGreaterThan(-1);
    expect(evIdx).toBeLessThan(scIdx);
    expect(res.lines[scIdx]).toContain("[scene:场景B]"); // 同 scene 行用自身场景名标注
  });

  it("池已满（主检索 ≥ maxResults）→ 补池通道退出（getNeighbors/searchL1ByScene 零调用）", async () => {
    const m = backfillMock({
      mainHits: [hit("a"), hit("b"), hit("c"), hit("d")],
      neighbors: [{ id: "ev1", type: "part_of", strength: 1, hop: 1 }],
      evidenceRows: [hit("ev1")],
      sceneRows: [hit("sc1")],
    });
    await searchHybrid(Q, "", 4, 0.3, m.vectorStore, m.embeddingService, undefined, undefined, undefined, undefined, LAYERED);
    expect(m.neighborsIds).toHaveLength(0);
    expect(m.sceneArgs).toHaveLength(0);
  });

  it("layered 缺省（无结论）→ 通道退出，与现状逐位一致", async () => {
    const m = backfillMock({
      mainHits: [hit("a")],
      neighbors: [{ id: "ev1", type: "part_of", strength: 1, hop: 1 }],
      evidenceRows: [hit("ev1")],
      sceneRows: [hit("sc1")],
    });
    const res = await searchHybrid(Q, "", 4, 0.3, m.vectorStore, m.embeddingService);
    expect(m.neighborsIds).toHaveLength(0);
    expect(m.sceneArgs).toHaveLength(0);
    expect(res.lines.map((l) => (l.includes("条目 a") ? "a" : "other"))).toEqual(["a"]);
  });

  it("空 layered（结论层空数组）→ 通道退出（关断恒等）", async () => {
    const m = backfillMock({ mainHits: [hit("a")] });
    await searchHybrid(Q, "", 4, 0.3, m.vectorStore, m.embeddingService, undefined, undefined, undefined, undefined, {
      excludeIds: [],
      conclusionRefs: [],
      sceneNames: [],
    });
    expect(m.neighborsIds).toHaveLength(0);
    expect(m.sceneArgs).toHaveLength(0);
  });

  it("补池行尊重 excludeIds（结论已收编 → 反查也不重复）", async () => {
    const m = backfillMock({
      mainHits: [hit("a")],
      neighbors: [{ id: "wf1", type: "part_of", strength: 1, hop: 1 }],
      evidenceRows: [hit("wf1", { content: "R7E 结论本体 wf1" })],
    });
    const res = await searchHybrid(Q, "", 4, 0.3, m.vectorStore, m.embeddingService, undefined, undefined, undefined, undefined, {
      excludeIds: ["wf1"],
      conclusionRefs: [{ id: "wf1", sceneName: "项目重构" }],
      sceneNames: ["项目重构"],
    });
    expect(res.lines.some((l) => l.includes("wf1"))).toBe(false);
  });
});

// ═══════════════ R7-2 · sqlite searchL1ByScene ═══════════════

const TENANT_A = { teamId: "teamA", userId: "userA", agentId: "agentA" };
const TENANT_B = { teamId: "teamB", userId: "userB", agentId: "agentB" };

function makeStore(name: string): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r7-scene-${name}-`));
  const dbPath = path.join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${JSON.stringify(initRes)}`);
  return { store, dir };
}

const mkRecord = (id: string, sceneName: string, tenant: Partial<{ teamId: string; userId: string; agentId: string }> = TENANT_A): MemoryRecord =>
  ({
    id,
    content: `R7E 场景样本 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: sceneName,
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    occurred_at: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
    ...tenant,
  }) as MemoryRecord;

describe("R7-2 sqlite searchL1ByScene（同 scene + 层级前缀 + T14）", () => {
  it("精确 scene 命中；他 scene 排除；score 恒 0", () => {
    const { store, dir } = makeStore("exact");
    try {
      store.upsertL1(mkRecord("s1", "项目重构"), undefined);
      store.upsertL1(mkRecord("s2", "其他场景"), undefined);
      const rows = store.searchL1ByScene(["项目重构"], 10);
      expect(rows.map((r) => r.record_id)).toEqual(["s1"]);
      expect(rows[0].score).toBe(0);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("层级前缀：查「工作」命中「工作/子场景」（与 sceneSignalOf 前缀语义对称）", () => {
    const { store, dir } = makeStore("hier");
    try {
      store.upsertL1(mkRecord("h1", "工作"), undefined);
      store.upsertL1(mkRecord("h2", "工作/子场景"), undefined);
      store.upsertL1(mkRecord("h3", "工作台账"), undefined); // 前缀非层级 → 不命中
      const rows = store.searchL1ByScene(["工作"], 10);
      expect(rows.map((r) => r.record_id).sort()).toEqual(["h1", "h2"]);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("T14 租户过滤：filter 传入时他租户行不可见；缺省 = 全量（旧行为）", () => {
    const { store, dir } = makeStore("tenant");
    try {
      store.upsertL1(mkRecord("ta1", "项目重构", TENANT_A), undefined);
      store.upsertL1(mkRecord("tb1", "项目重构", TENANT_B), undefined);
      const all = store.searchL1ByScene(["项目重构"], 10);
      expect(all.map((r) => r.record_id).sort()).toEqual(["ta1", "tb1"]);
      const filtered = store.searchL1ByScene(["项目重构"], 10, { teamId: "teamA", userId: "userA", agentId: "agentA" });
      expect(filtered.map((r) => r.record_id)).toEqual(["ta1"]);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("空参 / limit<=0 → 空数组（宁缺毋滥）", () => {
    const { store, dir } = makeStore("empty");
    try {
      store.upsertL1(mkRecord("s1", "项目重构"), undefined);
      expect(store.searchL1ByScene([], 10)).toEqual([]);
      expect(store.searchL1ByScene(["项目重构"], 0)).toEqual([]);
      expect(store.searchL1ByScene([""], 10)).toEqual([]);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
