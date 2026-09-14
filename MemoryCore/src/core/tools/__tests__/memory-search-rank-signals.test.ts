/**
 * R-A1 排序点①（咽喉 executeMemorySearch）：五通道端到端位次断言 + 关断矩阵。
 * FTS-only mock store（分数全等 → 基线序 = 插入序，稳定排序确定性）。
 * 关断矩阵：任一 boost 置 0 → 该通道零贡献，排序与基线逐位一致。
 */
import { describe, expect, it } from "vitest";
import { executeMemorySearch } from "../memory-search.js";
import { parseTimeWindow } from "../content-time-window.js";
import type { IMemoryStore, L1FtsResult } from "../../store/types.js";

const KW = "RA1PIN";
const NOW = new Date();

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
    metadata_json: over.metadata_json ?? "",
    ...over,
  };
}

function mockStore(
  rows: L1FtsResult[],
  values?: Array<{ value_id: string; label: string; weight: number; valence: number | null }>,
): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async () => rows,
    ...(values ? { listValues: async () => values } : {}),
  } as unknown as IMemoryStore;
}

/** 全关参数 = 基线（六信号全 0 + coreRefBoost 0）。V2-3 行为变更配套：组合分精排/探索位
 * 是排序层的新默认（config 默认开）——本文件钉死 R-A1 语义，故显式关断新层（权重全 0 +
 * exploreSlot false），其行为断言与 V2-3 前逐位一致；新层自身断言见 memory-search-explore-rerank.test.ts。 */
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

describe("R-A1 咽喉排序点：关断矩阵", () => {
  it("全 0 → 与基线逐位一致（等分条目保持插入序）", async () => {
    const rows = [ftsRow("a"), ftsRow("b"), ftsRow("c"), ftsRow("d")];
    expect(await order(mockStore(rows))).toEqual(["a", "b", "c", "d"]);
  });

  it("coreRef 活跃（legacy 路径）+ 六信号全 0 → 仍与基线逐位一致（f53b173 教训：空信号不得跳过排序）", async () => {
    const rows = [ftsRow("a"), ftsRow("b"), ftsRow("c")];
    expect(await order(mockStore(rows), { coreRefBoost: 0.05 })).toEqual(["a", "b", "c"]);
  });

  it("逐通道关断：通道开但数据不匹配 → 基线序不变", async () => {
    const rows = [ftsRow("a"), ftsRow("b")];
    // R1 时间窗开、但条目无 occurred_at → 无信号
    expect(await order(mockStore(rows), { timeBoost: 0.05, ...{ query: `${KW} 上周` } })).toEqual(["a", "b"]);
    // R9 mood 开、fired 为空（query 无 label）→ 无信号
    expect(await order(mockStore(rows), { moodBoost: 0.03 })).toEqual(["a", "b"]);
  });
});

describe("R-A1 咽喉排序点：R1 时间窗", () => {
  it("occurred_at 落 query 时间窗 → 位次前移", async () => {
    const win = parseTimeWindow(`${KW} 上周`, NOW);
    expect(win).not.toBeNull();
    const occurred = new Date(new Date(win!.start).getTime() + 3_600_000).toISOString();
    const rows = [ftsRow("a"), ftsRow("b", { occurred_at: occurred }), ftsRow("c")];
    const res = await order(mockStore(rows), { query: `${KW} 上周`, timeBoost: 0.05 });
    expect(res[0]).toBe("b");
    // 关断：timeBoost=0 → 基线
    expect(await order(mockStore(rows), { query: `${KW} 上周` })).toEqual(["a", "b", "c"]);
  });
  it("valid 区间相交（开放端持续态）→ 位次前移", async () => {
    const win = parseTimeWindow(`${KW} 上周`, NOW)!;
    const startedDuringWin = new Date(new Date(win.start).getTime() + DAY_MS_HALF()).toISOString();
    const rows = [ftsRow("a"), ftsRow("b", { valid_start: startedDuringWin })];
    const res = await order(mockStore(rows), { query: `${KW} 上周`, timeBoost: 0.05 });
    expect(res[0]).toBe("b");
  });
});

describe("R-A1 咽喉排序点：R1 时近性", () => {
  it("last_recalled_at < 24h → 位次前移；关断 → 基线", async () => {
    const recent = new Date(NOW.getTime() - 3_600_000).toISOString();
    const rows = [
      ftsRow("a"),
      ftsRow("b", { metadata_json: JSON.stringify({ last_recalled_at: recent }) }),
    ];
    expect((await order(mockStore(rows), { recencyBoost: 0.03 }))[0]).toBe("b");
    expect(await order(mockStore(rows))).toEqual(["a", "b"]);
  });
  it("25h 前 → 无信号（宁缺毋滥）", async () => {
    const old = new Date(NOW.getTime() - 25 * 3_600_000).toISOString();
    const rows = [
      ftsRow("a"),
      ftsRow("b", { metadata_json: JSON.stringify({ last_recalled_at: old }) }),
    ];
    expect(await order(mockStore(rows), { recencyBoost: 0.03 })).toEqual(["a", "b"]);
  });
});

describe("R-A1 咽喉排序点：R2 significance", () => {
  it("significance 高者前移；关断 → 基线", async () => {
    const rows = [ftsRow("a"), ftsRow("b", { significance: 0.9 })];
    expect((await order(mockStore(rows), { sigWeight: 0.03 }))[0]).toBe("b");
    expect(await order(mockStore(rows))).toEqual(["a", "b"]);
  });
});

describe("R-A1 咽喉排序点：R3 inferred 降权", () => {
  it("inferred 沉底（乘法 penalty）；penalty=0 → 基线", async () => {
    const rows = [ftsRow("a", { certainty: "inferred" }), ftsRow("b"), ftsRow("c")];
    expect(await order(mockStore(rows), { inferredPenalty: 0.1 })).toEqual(["b", "c", "a"]);
    expect(await order(mockStore(rows))).toEqual(["a", "b", "c"]);
  });
});

describe("R-A1 咽喉排序点：R8 强化闭环", () => {
  it("recall_count 高者前移（对数）；关断 → 基线", async () => {
    const rows = [
      ftsRow("a"),
      ftsRow("b", { metadata_json: JSON.stringify({ recall_count: 9 }) }),
    ];
    expect((await order(mockStore(rows), { reinforcementWeight: 0.03 }))[0]).toBe("b");
    expect(await order(mockStore(rows))).toEqual(["a", "b"]);
  });
});

describe("R-A1 咽喉排序点：R9 mood 对称偏置（默认关）", () => {
  const VALUES_POS = [{ value_id: "v1", label: "正确性", weight: 0.8, valence: 1 }];
  const VALUES_NEG = [{ value_id: "v1", label: "正确性", weight: 0.8, valence: -1 }];

  it("moodSign>0（fired valence 均值正）→ 正 valence 记忆前移；默认 0 → 基线", async () => {
    const rows = [ftsRow("a"), ftsRow("b", { valence: 0.6 })];
    expect((await order(mockStore(rows, VALUES_POS), { query: `${KW} 正确性`, moodBoost: 0.03 }))[0]).toBe("b");
    // 默认关（moodBoost 缺省 0）→ 基线
    expect(await order(mockStore(rows, VALUES_POS), { query: `${KW} 正确性` })).toEqual(["a", "b"]);
  });
  it("moodSign<0 → 负 valence 记忆前移（对称加权）", async () => {
    const rows = [ftsRow("a"), ftsRow("b", { valence: -0.6 })];
    expect((await order(mockStore(rows, VALUES_NEG), { query: `${KW} 正确性`, moodBoost: 0.03 }))[0]).toBe("b");
  });
  it("fired 为空（query 不含 label）→ 无信号", async () => {
    const rows = [ftsRow("a"), ftsRow("b", { valence: 0.6 })];
    expect(await order(mockStore(rows, VALUES_POS), { moodBoost: 0.03 })).toEqual(["a", "b"]);
  });
});

describe("R-A1 咽喉排序点：全开", () => {
  it("多通道叠加：命中条目稳定居首", async () => {
    const win = parseTimeWindow(`${KW} 上周`, NOW)!;
    const occurred = new Date(new Date(win.start).getTime() + 3_600_000).toISOString();
    const rows = [
      ftsRow("a"),
      ftsRow("b", {
        occurred_at: occurred,
        significance: 0.9,
        valence: 0.6,
        metadata_json: JSON.stringify({ recall_count: 9, last_recalled_at: new Date(NOW.getTime() - 3_600_000).toISOString() }),
      }),
      ftsRow("c", { certainty: "inferred" }),
    ];
    const res = await order(mockStore(rows, [{ value_id: "v1", label: "正确性", weight: 0.8, valence: 1 }]), {
      query: `${KW} 上周 正确性`,
      timeBoost: 0.05,
      recencyBoost: 0.03,
      sigWeight: 0.03,
      inferredPenalty: 0.1,
      reinforcementWeight: 0.03,
      moodBoost: 0.03,
    });
    expect(res[0]).toBe("b");
    expect(res[res.length - 1]).toBe("c");
  });
});

function DAY_MS_HALF(): number {
  return 43_200_000;
}
