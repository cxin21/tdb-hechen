/**
 * R-A1 排序点②（auto-recall searchHybrid，C5 落点同层对齐）：五通道位次断言 + 关断矩阵。
 * C5 教训回归：只改咽喉不改 auto-recall = 静默不一致——本文件钉死第二排序点。
 * work_fact 分层优先级保持在前（加成不越层）。
 */
import { describe, expect, it } from "vitest";
import { searchHybrid } from "../auto-recall.js";
import { ZERO_RANK_SIGNALS, type RankSignals } from "../../tools/recall-signals.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { TimeWindow } from "../../tools/content-time-window.js";

const NOW = new Date();

function mkSoul(
  id: string,
  score: number,
  over: Partial<L1SearchResult> = {},
): L1SearchResult {
  return {
    record_id: id,
    content: `RA1H 记忆条目 ${id}`,
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
    metadata_json: "",
    ...over,
  };
}

function mockStore(hits: L1SearchResult[]): { vectorStore: IMemoryStore; embeddingService: EmbeddingService } {
  const vectorStore = {
    isFtsAvailable: () => false,
    searchL1Vector: async () => hits,
  } as unknown as IMemoryStore;
  const embeddingService = {
    embed: async () => new Float32Array(4),
  } as unknown as EmbeddingService;
  return { vectorStore, embeddingService };
}

/** 排序三刀对齐（2026-09-12）：信号仅跨通道真平局组内生效——单列表跨档 fixture 已不可测信号。
 *  双路 mock：fts 命中与 vec 命中同名次（1/61 ≡ 1/61）构造真平局组。 */
function mockStoreDual(vecHits: L1SearchResult[], ftsHits: L1SearchResult[]): { vectorStore: IMemoryStore; embeddingService: EmbeddingService } {
  const vectorStore = {
    isFtsAvailable: () => ftsHits.length > 0,
    searchL1Fts: async () => ftsHits,
    searchL1Vector: async () => vecHits,
  } as unknown as IMemoryStore;
  const embeddingService = {
    embed: async () => new Float32Array(4),
  } as unknown as EmbeddingService;
  return { vectorStore, embeddingService };
}

async function orderDual(
  query: string,
  vecHits: L1SearchResult[],
  r?: Parameters<typeof searchHybrid>[8],
  ftsHits: L1SearchResult[] = [],
): Promise<string[]> {
  const { vectorStore, embeddingService } = mockStoreDual(vecHits, ftsHits);
  const res = await searchHybrid(query, "", 10, 0.3, vectorStore, embeddingService, undefined, undefined, r, 0, undefined, undefined, false, { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 });
  return res.lines.map((l) => {
    const m = l.match(/RA1H 记忆条目 (\w+)/);
    return m ? m[1] : l;
  });
}

const WIN: TimeWindow = { start: "2026-09-01T00:00:00Z", end: "2026-09-08T00:00:00Z", label: "上周" };

function rank(over: Partial<{ boost: number; firedLabels: string[]; moodSign: number; timeWindow: TimeWindow | null; signals: RankSignals }> = {}) {
  return {
    boost: 0,
    firedLabels: [],
    moodSign: 0,
    timeWindow: null,
    signals: ZERO_RANK_SIGNALS,
    now: NOW,
    ...over,
  };
}

async function order(
  hits: L1SearchResult[],
  r?: Parameters<typeof searchHybrid>[8],
): Promise<string[]> {
  const { vectorStore, embeddingService } = mockStore(hits);
  // V2-3 行为变更配套：本文件钉死 R-A1 语义——显式关断新排序层（探索位 + 组合分精排），
  // 其行为断言与 V2-3 前逐位一致；新层自身断言见 auto-recall-explore-relax.test.ts。
  const res = await searchHybrid("RA1H 查询", "", 10, 0.3, vectorStore, embeddingService, undefined, undefined, r, 0, undefined, undefined, false, { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 });
  return res.lines.map((l) => {
    const m = l.match(/RA1H 记忆条目 (\w+)/);
    return m ? m[1] : l;
  });
}

describe("R-A1 auto-recall 排序点：关断矩阵", () => {
  it("无 rank 信号（legacy）→ 插入序（RRF 同分稳定）", async () => {
    const hits = [mkSoul("a", 0.5), mkSoul("b", 0.5), mkSoul("c", 0.5)];
    expect(await order(hits)).toEqual(["a", "b", "c"]);
  });
  it("rank 全 0 信号 → 与 legacy 逐位一致（(x+0)*1 === x）", async () => {
    const hits = [mkSoul("a", 0.5), mkSoul("b", 0.5), mkSoul("c", 0.5)];
    expect(await order(hits, rank())).toEqual(["a", "b", "c"]);
  });
  it("C5 旧形状（仅 boost+firedLabels）兼容：不崩溃且行为与改动前一致（verify-s5 回归缺口钉死）", async () => {
    const hits = [mkSoul("a", 0.5), mkSoul("b", 0.5), mkSoul("c", 0.5)];
    const legacy = { boost: 0.05, firedLabels: ["不存在锚"] };
    expect(await order(hits, legacy as unknown as Parameters<typeof searchHybrid>[8])).toEqual(["a", "b", "c"]);
  });
});

describe("R-A1 auto-recall 排序点：R1 时间窗", () => {
  it("occurred_at 落窗 → 真平局组内前移；关断 → 基线（三刀语义对齐：跨档不可测信号——登记）", async () => {
    // 双路真平局：a(fts r0) ≡ b(vec r0) 同为 1/61；c(vec r1)=1/62。
    // ON：tie 组内 timeBoost → b 前；OFF：稳定插入序 [a, b, c]。
    const res = await orderDual("RA1H 查询", [mkSoul("b", 0.5, { occurred_at: "2026-09-03T10:00:00Z" }), mkSoul("c", 0.5)], rank({ timeWindow: WIN, signals: { ...ZERO_RANK_SIGNALS, timeBoost: 0.05 } }), [mkSoul("a", 0.5)]);
    expect(res[0]).toBe("b");
    const off = await orderDual("RA1H 查询", [mkSoul("b", 0.5), mkSoul("c", 0.5)], rank({ timeWindow: WIN }), [mkSoul("a", 0.5)]);
    expect(off).toEqual(["a", "b", "c"]);
  });
});

describe("R-A1 auto-recall 排序点：R3 inferred 降权", () => {
  it("inferred 平局组内沉底（跨档不沉降——R3 平移与工具侧一致，登记）；penalty=0 → 基线", async () => {
    // 双路真平局：a(inferred, fts r0) ≡ b(observed, vec r0)（fts 先插）；c(vec r1)。
    // ON：tie 组内 mult 旗标 → observed b 前、inferred a 后；OFF：稳定插入序 [a, b, c]。
    const res = await orderDual("RA1H 查询", [mkSoul("b", 0.5), mkSoul("c", 0.5)], rank({ signals: { ...ZERO_RANK_SIGNALS, inferredPenalty: 0.1 } }), [mkSoul("a", 0.5, { certainty: "inferred" })]);
    expect(res).toEqual(["b", "a", "c"]);
    const off = await orderDual("RA1H 查询", [mkSoul("b", 0.5), mkSoul("c", 0.5)], rank(), [mkSoul("a", 0.5)]);
    expect(off).toEqual(["a", "b", "c"]);
  });
});

describe("R-A1 auto-recall 排序点：R2/R8", () => {
  it("significance / recall_count 加成 → 真平局组内前移（三刀语义对齐——登记）", async () => {
    const res = await orderDual("RA1H 查询", [mkSoul("b", 0.5, { significance: 0.9, metadata_json: JSON.stringify({ recall_count: 9 }) }), mkSoul("c", 0.5)], rank({ signals: { ...ZERO_RANK_SIGNALS, sigWeight: 0.03, reinforcementWeight: 0.03 } }), [mkSoul("a", 0.5)]);
    expect(res[0]).toBe("b");
  });
});

describe("R-A1 auto-recall 排序点：R1 时近性", () => {
  it("metadata.last_recalled_at < 24h → 真平局组内前移（三刀语义对齐——登记）", async () => {
    const recent = new Date(NOW.getTime() - 3_600_000).toISOString();
    const res = await orderDual("RA1H 查询", [mkSoul("b", 0.5, { metadata_json: JSON.stringify({ last_recalled_at: recent }) }), mkSoul("c", 0.5)], rank({ signals: { ...ZERO_RANK_SIGNALS, recencyBoost: 0.03 } }), [mkSoul("a", 0.5)]);
    expect(res[0]).toBe("b");
  });
});

describe("R-A1 auto-recall 排序点：R9 mood", () => {
  it("moodSign>0 → 正 valence 真平局组内前移；moodBoost=0 → 基线（三刀语义对齐——登记）", async () => {
    const res = await orderDual("RA1H 查询", [mkSoul("b", 0.5, { valence: 0.6 })], rank({ moodSign: 1, signals: { ...ZERO_RANK_SIGNALS, moodBoost: 0.03 } }), [mkSoul("a", 0.5)]);
    expect(res[0]).toBe("b");
    const off = await orderDual("RA1H 查询", [mkSoul("b", 0.5)], rank({ moodSign: 1 }), [mkSoul("a", 0.5)]);
    expect(off).toEqual(["a", "b"]);
  });
});

describe("R-A1 auto-recall 排序点：work_fact 分层不越层", () => {
  it("信号不得把 point 型顶到 work_fact 层之上", async () => {
    const hits = [
      mkSoul("w", 0.5, { type: "work_fact" }),
      mkSoul("p", 0.5, {
        type: "episodic",
        occurred_at: "2026-09-03T10:00:00Z",
        significance: 0.9,
        metadata_json: JSON.stringify({ recall_count: 9 }),
      }),
    ];
    const res = await order(hits, rank({
      timeWindow: WIN,
      signals: { ...ZERO_RANK_SIGNALS, timeBoost: 0.05, sigWeight: 0.03, reinforcementWeight: 0.03 },
    }));
    expect(res[0]).toBe("w");
  });
});
