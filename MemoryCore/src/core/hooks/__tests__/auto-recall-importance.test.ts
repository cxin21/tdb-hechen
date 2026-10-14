/**
 * P1 Task 7（worthiness importance，spec §6）：recall 接线 RED 套件。
 * 契约（镜像 auto-recall-rank-signals.test.ts 三刀语义；shadowMode 已按用户 2026-10-14
 * 拍板移除——gate 开启即乘子真实生效）：
 *  - enabled：importance ≤4 乘子入 mult —— 仅真平局组内生效（compareLex 末位 mult DESC），
 *    跨档永不可翻越（主序=纯 RRF 证据，R-A1 架构不变）；gates.importancePenalty 携带双分量
 *    （penalized=实际排序分，raw=反推值 + topChanged）供 journal 观测；
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

function rank(over: Partial<{ signals: RankSignals; importanceGate: { penalty: number } }> = {}) {
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

describe("P1-T7 生效模式：乘子入排序（平局组内）+ gates 双分量", () => {
  it("a(imp2) vs b(imp8) 真平局：penalty 0.5 → b 前；关断 → 插入序", async () => {
    const f = fixture({ importance: 2 }, { importance: 8 }, { importance: 8 });
    const baseline = await runDual(f.vec, f.fts, rank());
    expect(baseline.order).toEqual(["a", "b", "c"]);
    const active = await runDual(f.vec, f.fts, rank({
      signals: { ...ZERO_RANK_SIGNALS, importancePenalty: 0.5 },
      importanceGate: { penalty: 0.5 },
    }));
    expect(active.order).toEqual(["b", "a", "c"]);
  });

  it("gates.importancePenalty 双分量可见（penalized=实际分，raw=反推；mode 键已移除）", async () => {
    const f = fixture({ importance: 2 }, { importance: 8 }, { importance: 8 });
    const active = await runDual(f.vec, f.fts, rank({
      signals: { ...ZERO_RANK_SIGNALS, importancePenalty: 0.5 },
      importanceGate: { penalty: 0.5 },
    }));
    const gate = active.res.gates?.importancePenalty;
    expect(gate).toBeDefined();
    expect((gate as unknown as Record<string, unknown>).mode).toBeUndefined(); // shadowMode 已移除
    expect(gate!.penalty).toBe(0.5);
    expect(gate!.items).toBe(3);
    expect(gate!.penalized).toBe(1); // 仅 a（imp2≤4）计数
    expect(gate!.topRaw).toBeCloseTo(1 / 61, 12); // a 除回 0.5 反推（与 b 同分，首见保留 a）
    expect(gate!.topPenalized).toBeCloseTo(1 / 61, 12); // b 不罚顶到实际榜首
    expect(gate!.topChanged).toBe(true); // argmax 行变化：a → b
  });
});

describe("P1-T7 importance NULL/缺省：永不计数、永不罚", () => {
  it("全 NULL 行：penalized=0，topRaw=topPenalized，topChanged=false", async () => {
    const f = fixture(
      { importance: null },
      { importance: null },
      {}, // 缺省（undefined）
    );
    const res = await runDual(f.vec, f.fts, rank({
      signals: { ...ZERO_RANK_SIGNALS, importancePenalty: 0.9 },
      importanceGate: { penalty: 0.9 },
    }));
    expect(res.order).toEqual(["a", "b", "c"]);
    const gate = res.res.gates?.importancePenalty;
    expect(gate).toBeDefined();
    expect(gate!.penalized).toBe(0);
    expect(gate!.topRaw).toBeCloseTo(gate!.topPenalized ?? -1, 12);
    expect(gate!.topChanged).toBe(false);
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
