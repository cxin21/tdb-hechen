/**
 * P0-1 回归（2026-11-04 对抗评审）：敏感度投影不得在任一召回路丢失。
 *
 * 缺陷形态（评审员取证）：
 *  - memory-search.ts 的 FTS 腿 / native-hybrid 腿 / graph 扩展腿 / neighbor 扩展腿
 *    只投影 soul 列的一部分，唯独漏了 sensitivity；向量腿有。
 *  - 注入门 gateSensitivityForInjection 读 item.sensitivity，而 sensitivity-policy 对
 *    非字符串一律判 "none"（= 可注入）→ 漏投影 = 静默绕过门。
 *  - 叠加：rrfMergeWeighted 只并分数不并字段，且 hybrid 合并顺序 ftsItems 第一，
 *    同一条记录被 FTS + 向量同时命中时以 FTS 对象胜出 → 敏感行照样注入。
 *
 * 四个用例分别钉住：FTS 单腿 / 两腿同 id 合并 / 图扩展腿 / 带归属时放行且回观测。
 */
import { describe, expect, it } from "vitest";

import { executeMemorySearch } from "../memory-search.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const KW = "R-P0-SENSITIVITY-PROJECTION";
const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

/** 六信号 + 候选池通道 + 事实通道全 0：只留「投影是否存活」这一个变量。 */
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
    timestamp_str: "2026-10-31T00:00:00Z",
    timestamp_start: "2026-10-31T00:00:00Z",
    timestamp_end: "2026-11-01T00:00:00Z",
    version: 1,
    session_key: "sk",
    session_id: "s",
    team_id: TENANT.teamId,
    task_id: "",
    user_id: TENANT.userId,
    agent_id: TENANT.agentId,
    metadata_json: "{}",
    ...over,
  };
}

function ftsRow(id: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
  const { score: _ignored, ...base } = vecRow(id) as unknown as Record<string, unknown>;
  return {
    ...(base as unknown as L1FtsResult),
    score: 0.8,
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
  graph?: L1SearchResult[];
}): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false, l1FactVec: false }),
    searchL1Fts: async () => opts.fts ?? [],
    searchL1Vector: async () => opts.vec ?? [],
    // 图扩展腿（graph/ppr 召回）：同样必须带出 sensitivity，否则扩展出来的敏感行绕过门。
    exploreByGraph: opts.graph ? async () => opts.graph! : undefined,
    bumpRecallCount: () => true,
  } as unknown as IMemoryStore;
}

async function run(store: IMemoryStore, extra: Record<string, unknown> = {}, limit = 10) {
  return await executeMemorySearch({
    query: KW,
    limit,
    vectorStore: store,
    embeddingService: embedding,
    scoreThreshold: 0.3,
    ...ALL_OFF,
    ...extra,
  } as Parameters<typeof executeMemorySearch>[0]);
}

describe("P0-1：敏感度投影（漏投影 = 静默绕过注入门）", () => {
  it("FTS 单腿：sensitivity='finance' 的行在未声明归属时被拦，且回观测", async () => {
    // 无 embedding 的降级场景 100% 走这条腿——正是评审指出的最坏路径。
    const store = mockStore({ fts: [ftsRow("f1", { sensitivity: "finance" } as Partial<L1FtsResult>)] });
    const result = await run(store);
    expect(result.results.map((r) => r.id)).toEqual([]);
    expect(result.sensitivity?.blocked).toBe(1);
    expect(result.sensitivity?.scanned).toBe(1);
  });

  it("两腿同 id 合并：FTS 对象缺字段、向量对象带 sensitivity → 合并后仍被拦", async () => {
    // 钉住 rrfMergeWeighted 的字段补全：合并顺序 ftsItems 第一，仅并分数会丢 sensitivity。
    const store = mockStore({
      fts: [ftsRow("dup")],
      vec: [vecRow("dup", { sensitivity: "relationship" } as Partial<L1SearchResult>)],
    });
    const result = await run(store);
    expect(result.results.map((r) => r.id)).toEqual([]);
    expect(result.sensitivity?.blocked).toBe(1);
  });

  it("两腿同 id 合并：任一腿带 sensitivity 时可见行也保留该字段（不因合并被洗掉）", async () => {
    // 反向保证：私有归属下放行时，出参仍带 sensitivity——面板徽章与后续提示都靠它。
    const store = mockStore({
      fts: [ftsRow("dup-ok")],
      vec: [vecRow("dup-ok", { sensitivity: "finance" } as Partial<L1SearchResult>)],
    });
    const result = await run(store, { filter: TENANT });
    expect(result.results).toHaveLength(1);
    expect((result.results[0] as { sensitivity?: string }).sensitivity).toBe("finance");
  });

  it("图扩展腿：扩展出来的敏感行同样被拦（不只主召回路）", async () => {
    const store = mockStore({
      fts: [],
      vec: [],
      graph: [vecRow("g1", { sensitivity: "health" } as Partial<L1SearchResult>)],
    });
    const result = await run(store);
    expect(result.results.map((r) => r.id)).toEqual([]);
    if (result.sensitivity) expect(result.sensitivity.blocked).toBeGreaterThanOrEqual(1);
  });

  it("带私有归属：敏感行放行且仍带 sensitivity；观测 blocked=0", async () => {
    const store = mockStore({ fts: [ftsRow("p1", { sensitivity: "finance" } as Partial<L1FtsResult>)] });
    const result = await run(store, { filter: TENANT });
    expect(result.results.map((r) => r.id)).toEqual(["p1"]);
    expect((result.results[0] as { sensitivity?: string }).sensitivity).toBe("finance");
    expect(result.sensitivity?.blocked ?? 0).toBe(0);
  });

  it("先过门再截断：敏感行不白吃名额（limit=2 时仍返回 2 条可见）", async () => {
    // 对抗评审 P2-11：旧顺序 slice(0,limit) → 过门 ⇒ 排在前面的敏感行占掉槽位，
    // 结果条数无故小于 limit 且无对外提示。先门后切应给满 2 条。
    const store = mockStore({
      fts: [
        ftsRow("s-first", { sensitivity: "finance", score: 0.95 } as Partial<L1FtsResult>),
        ftsRow("n2", { score: 0.9 }),
        ftsRow("n3", { score: 0.85 }),
      ],
    });
    const result = await run(store, {}, 2);
    expect(result.results.map((r) => r.id)).toEqual(["n2", "n3"]);
    expect(result.total).toBe(2);
    expect(result.sensitivity?.blocked).toBe(1);
  });
});
