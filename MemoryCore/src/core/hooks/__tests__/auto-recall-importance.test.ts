/**
 * P1 Task 7（worthiness importance，spec §6）：recall 接线 RED 套件。
 * 契约（镜像 auto-recall-rank-signals.test.ts 三刀语义）：
 *  - active 模式：importance ≤4 乘子入 mult —— 仅真平局组内生效（compareLex 末位 mult DESC），
 *    跨档永不可翻越（主序=纯 RRF 证据，R-A1 架构不变）；
 *  - shadow 模式：排序逐位不变（关断恒等），但 gates.importancePenalty 携带双分量
 *    （raw vs penalized + topChanged）供影子日志观测；
 *  - importance NULL/缺省：永不计数、永不罚；
 *  - 无 gate：结果无 gates 字段（缺字段=门未启用口径）。
 */
import { describe, expect, it } from "vitest";
import { searchHybrid } from "../auto-recall.js";
import { ZERO_RANK_SIGNALS, type RankSignals } from "../../tools/recall-signals.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

function mkSoul(
  id: string,
  score: number,
  over: Partial<L1SearchResult> = {},
): L1SearchResult {
  return {
    record_id: id,
    content: `T7IMP 记忆条目 ${id}`,
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

function rank(over: Partial<{ signals: RankSignals; importanceGate: { penalty: number; mode: "shadow" | "active" } }> = {}) {
  return {
    boost: 0,
    firedLabels: [],
    moodSign: 0,
    timeWindow: null,
    signals: ZERO_RANK_SIGNALS,
    now: new Date(),
    ...over,
  };
}

async function runDual(
  vecHits: L1SearchResult[],
  ftsHits: L1SearchResult[],
  r?: Parameters<typeof searchHybrid>[8],
): Promise<{ order: string[]; res: Awaited<ReturnType<typeof searchHybrid>> }> {
  const { vectorStore, embeddingService } = mockStoreDual(vecHits, ftsHits);
  const res = await searchHybrid("T7IMP 查询", "", 10, 0.3, vectorStore, embeddingService, undefined, undefined, r, 0, undefined, undefined, false, { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 });
  return {
    order: res.lines.map((l) => {
      const m = l.match(/T7IMP 记忆条目 (\w+)/);
      return m ? m[1] : l;
    }),
    res,
  };
}

/** 双路真平局 fixture：a(fts r0) ≡ b(vec r0) 同为 1/61；c(vec r1)=1/62。 */
const fixture = (overA: Partial<L1SearchResult> = {}, overB: Partial<L1SearchResult> = {}, overC: Partial<L1SearchResult> = {}) => ({
  vec: [mkSoul("b", 0.5, overB), mkSoul("c", 0.5, overC)],
  fts: [mkSoul("a", 0.5, overA)],
});

describe("P1-T7 active 模式：importance 乘子入排序（平局组内）", () => {
  it("a(imp2) vs b(imp8) 真平局：active penalty 0.5 → b 前；关断 → 插入序", async () => {
    const f = fixture({ importance: 2 }, { importance: 8 }, { importance: 8 });
    const baseline = await runDual(f.vec, f.fts, rank());
    expect(baseline.order).toEqual(["a", "b", "c"]);
    const active = await runDual(f.vec, f.fts, rank({
      signals: { ...ZERO_RANK_SIGNALS, importancePenalty: 0.5 },
      importanceGate: { penalty: 0.5, mode: "active" },
    }));
    expect(active.order).toEqual(["b", "a", "c"]);
  });
});

describe("P1-T7 shadow 模式：排序逐位不变 + 影子日志双分量", () => {
  it("shadow penalty 0.5 → 顺序与基线一致；gates.importancePenalty 双分量可见", async () => {
    const f = fixture({ importance: 2 }, { importance: 8 }, { importance: 8 });
    const shadow = await runDual(f.vec, f.fts, rank({
      importanceGate: { penalty: 0.5, mode: "shadow" },
    }));
    expect(shadow.order).toEqual(["a", "b", "c"]);
    const gate = shadow.res.gates?.importancePenalty;
    expect(gate).toBeDefined();
    expect(gate!.mode).toBe("shadow");
    expect(gate!.penalty).toBe(0.5);
    expect(gate!.items).toBe(3);
    expect(gate!.penalized).toBe(1); // 仅 a（imp2≤4）计数
    expect(gate!.topRaw).toBeCloseTo(1 / 61, 12);
    expect(gate!.topPenalized).toBeCloseTo(1 / 61, 12); // 未罚的 b 顶到 penalized 榜首
    expect(gate!.topChanged).toBe(true);
  });
  it("active 模式同样携带双分量（raw=pen/factor 重建口径）", async () => {
    const f = fixture({ importance: 2 }, { importance: 8 }, { importance: 8 });
    const active = await runDual(f.vec, f.fts, rank({
      signals: { ...ZERO_RANK_SIGNALS, importancePenalty: 0.5 },
      importanceGate: { penalty: 0.5, mode: "active" },
    }));
    const gate = active.res.gates?.importancePenalty;
    expect(gate).toBeDefined();
    expect(gate!.mode).toBe("active");
    expect(gate!.penalized).toBe(1);
    expect(gate!.topRaw).toBeCloseTo(1 / 61, 12);
    expect(gate!.topChanged).toBe(true);
  });
});

describe("P1-T7 importance NULL/缺省：永不计数、永不罚", () => {
  it("全 NULL 行：penalized=0，topRaw=topPenalized，topChanged=false", async () => {
    const f = fixture(
      { importance: null },
      { importance: null },
      {}, // 缺省（undefined）
    );
    const shadow = await runDual(f.vec, f.fts, rank({
      importanceGate: { penalty: 0.9, mode: "shadow" },
    }));
    expect(shadow.order).toEqual(["a", "b", "c"]);
    const gate = shadow.res.gates?.importancePenalty;
    expect(gate).toBeDefined();
    expect(gate!.penalized).toBe(0);
    expect(gate!.topRaw).toBeCloseTo(gate!.topPenalized ?? -1, 12);
    expect(gate!.topChanged).toBe(false);
  });
  it("active 模式 NULL 行不罚（乘子恒 1）", async () => {
    const f = fixture({ importance: null }, { importance: null }, {});
    const active = await runDual(f.vec, f.fts, rank({
      signals: { ...ZERO_RANK_SIGNALS, importancePenalty: 0.9 },
      importanceGate: { penalty: 0.9, mode: "active" },
    }));
    expect(active.order).toEqual(["a", "b", "c"]);
  });
});

describe("P1-T7 关断口径", () => {
  it("无 importanceGate → 结果无 gates 字段（缺字段=门未启用）", async () => {
    const f = fixture({ importance: 2 }, { importance: 2 }, {});
    const res = await runDual(f.vec, f.fts, rank({
      signals: { ...ZERO_RANK_SIGNALS, importancePenalty: 0 },
    }));
    expect(res.res.gates).toBeUndefined();
  });
});
