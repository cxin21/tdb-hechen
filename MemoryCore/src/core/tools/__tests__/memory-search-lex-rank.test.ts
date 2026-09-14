/**
 * 排序三刀（2026-09-12 队长裁决，first-principles）RED 套件 —— 排序点①咽喉 executeMemorySearch。
 *
 * 刀一（字典序两段式）：primary = fused score 永不被信号改动；结构信号/priority/coreRef
 *   只在 primary 精确平局组内生效。病灶（golden q9「归档与遗忘的语义」，
 *   runs/2026-09-12T12-08-44 perQuery[8]）：相关项 base RRF 0.016393 + R2 0.00016 被
 *   无关项 base 0.016129 + 3 信号和 0.000568 夺位——加法 rankKey 让 query 无关先验
 *   越过相邻相关度档（相邻差 ≈ 2.8e-4，信号和可达 ~6e-4）。
 * 刀二（补池不挤位）：expandCandidatePool 输出只占直接命中之后的槽位（直接命中保持
 *   基线序；扩展候选按自身派生分内部排序附加在后）。
 * 刀三（登记不动代码）：spec §8 + compositeScoreOf 头部注释（不在本套件断言范围）。
 *
 * 关断恒等：信号全 0 → 与基线逐位一致（比较器退化为 score 降序稳定排序，可证明）。
 */
import { describe, expect, it } from "vitest";
import { executeMemorySearch } from "../memory-search.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult } from "../../store/types.js";

const KW = "LEX3PIN";

/** 全关参数 = 基线（六信号全 0 + coreRefBoost 0 + 精排/探索位关断，钉死本套件断言语境）。 */
const ALL_OFF = {
  coreRefBoost: 0,
  timeBoost: 0,
  recencyBoost: 0,
  sigWeight: 0,
  inferredPenalty: 0,
  reinforcementWeight: 0,
  moodBoost: 0,
  exploreSlot: false,
  rerankWeights: { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 },
} as const;

function ftsRow(id: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: id,
    content: `${KW} 记忆条目 ${id}`,
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

function vecRow(id: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content: `${KW} 图邻居条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score: 0,
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

interface LexMockOpts {
  rows: L1FtsResult[];
  neighbors?: Array<{ id: string; type: string; strength: number; hop: number }>;
  neighborRows?: L1SearchResult[];
}

function lexMock(opts: LexMockOpts): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async () => opts.rows,
    getNeighbors: async () => opts.neighbors ?? [],
    getL1ByIdsWithArchive: (ids: string[]) =>
      (opts.neighborRows ?? []).filter((r) => ids.includes(r.record_id)),
  } as unknown as IMemoryStore;
}

async function order(store: IMemoryStore, params: Record<string, unknown> = {}): Promise<string[]> {
  const res = await executeMemorySearch({
    query: KW,
    limit: 10,
    vectorStore: store,
    ...ALL_OFF,
    ...params,
  } as Parameters<typeof executeMemorySearch>[0]);
  return res.results.map((r) => r.id);
}

// ═══════════════ 刀一 · 字典序两段式 ═══════════════

describe("刀一 字典序两段式（信号只在 primary 精确平局组内生效）", () => {
  it("q9 病灶回归：低 fused + 大信号和不得夺位高 fused 相邻档（RED：加法 rankKey 下 noise 夺位）", async () => {
    // 复刻 q9 量纲：相邻 RRF 档差 2.64e-4（1/61 - 1/62），信号和 5.4e-4 越过档差。
    const rows = [
      ftsRow("rel", { score: 0.016393 }),                                        // 相关命中：更高 fused
      ftsRow("noise", { score: 0.016129, significance: 0.9 }),                   // 邻位无关：R2 信号 0.9*0.0006=5.4e-4
    ];
    const ids = await order(lexMock({ rows }), { sigWeight: 0.0006 });
    // 加法 rankKey 下：0.016129 + 0.00054 = 0.016669 > 0.016393 → noise 夺位（病灶）。
    // 字典序下：primary 判胜负，noise 的信号只能在平局组内生效 → rel 恒在前。
    expect(ids[0]).toBe("rel");
    expect(ids).toEqual(["rel", "noise"]);
  });

  it("真平局组内：信号仍真实生效（同分条目按 signal-sum 降序）", async () => {
    // RRF 同名次 → 精确同分（1/(60+rank) 逐位相等）——信号的主战场必须保留。
    const rows = [
      ftsRow("plain", { score: 0.016393 }),
      ftsRow("signaled", { score: 0.016393, significance: 0.9 }),
      ftsRow("plain2", { score: 0.016393 }),
    ];
    const ids = await order(lexMock({ rows }), { sigWeight: 0.03 });
    expect(ids[0]).toBe("signaled");
    // 平局组内无信号者保持稳定序（plain 在 plain2 前——插入序）。
    expect(ids.slice(1)).toEqual(["plain", "plain2"]);
  });

  it("R3 inferred 只在平局组内沉底；不同 fused 档不越过", async () => {
    const rows = [
      ftsRow("hi", { score: 0.02, certainty: "inferred" }),   // inferred 但 fused 更高
      ftsRow("lo", { score: 0.016 }),                          // observed 但 fused 更低
    ];
    // 加法/乘法旧语义：0.02*0.9 = 0.018 > 0.016，hi 仍在前——字典序下同样 hi 在前
    // （primary 永不被信号改动）。语义变更登记：旧乘法作用于全 rankKey，新语义
    // inferred 只影响平局组内位次。
    const ids = await order(lexMock({ rows }), { inferredPenalty: 0.1 });
    expect(ids).toEqual(["hi", "lo"]);
  });

  it("平局组内 inferred 沉底（R3 语义保留）", async () => {
    const rows = [
      ftsRow("a", { score: 0.016393, certainty: "inferred" }),
      ftsRow("b", { score: 0.016393 }),
      ftsRow("c", { score: 0.016393 }),
    ];
    const ids = await order(lexMock({ rows }), { inferredPenalty: 0.1 });
    expect(ids).toEqual(["b", "c", "a"]);
  });

  it("关断恒等：信号全 0 + priority/coreRef 零贡献 → 与基线逐位一致", async () => {
    const rows = [
      ftsRow("x", { score: 0.9, significance: 0.9, metadata_json: JSON.stringify({ recall_count: 9 }) }),
      ftsRow("y", { score: 0.5 }),
      ftsRow("z", { score: 0.1, certainty: "inferred" }),
    ];
    // 全 0 → 比较器全部次级判据为 0 → 稳定排序退化为输入序（= score 降序基线）。
    const ids = await order(lexMock({ rows }));
    expect(ids).toEqual(["x", "y", "z"]);
  });
});

// ═══════════════ 刀二 · 补池不挤位 ═══════════════

describe("刀二 补池不挤位（扩展候选只占直接命中之后的槽位）", () => {
  const NB = [{ id: "n1", type: "causal", strength: 0.9, hop: 1 }];

  it("扩展候选派生分高于低分直接命中 → 仍排在其后（RED：同层重跑下 n1 挤掉 low）", async () => {
    // low = 直接命中（fused 0.004）；n1 = 图候选（派生分 0.016×0.6×1 = 0.0096 > 0.004）。
    // 旧同层重跑语义：n1 以更高 key 挤掉 low 的位次（补池挤位病灶）。
    // 刀二语义：直接命中保持基线序，n1 附加在全部直接命中之后。
    const rows = [
      ftsRow("high", { score: 0.016 }),
      ftsRow("low", { score: 0.004 }),
    ];
    const ids = await order(lexMock({ rows, neighbors: NB, neighborRows: [vecRow("n1")] }), {
      graphDiscount: 0.6,
      graphMinStrength: 0.5,
    });
    expect(ids).toEqual(["high", "low", "n1"]);
  });

  it("扩展候选内部按自身派生分降序（附加段内排序语义保留）", async () => {
    const neighbors = [
      { id: "n-weak", type: "similar", strength: 0.5, hop: 1 },
      { id: "n-strong", type: "similar", strength: 0.9, hop: 1 },
    ];
    const rows = [ftsRow("hit", { score: 0.016 })];
    const ids = await order(lexMock({ rows, neighbors, neighborRows: neighbors.map((n) => vecRow(n.id)) }), {
      graphDiscount: 0.6,
      graphMinStrength: 0.5,
    });
    expect(ids).toEqual(["hit", "n-strong", "n-weak"]);
  });
});
