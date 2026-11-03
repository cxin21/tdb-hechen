/**
 * B4（2026-11-02）：dedup 前置 embedding 门槛（config-first，缺省关闭 = 逐位现状）。
 *
 * 病灶（研究文档 §B4）：每批判重无条件付 1 次 LLM；而向量召回已带真实 cosine 的
 * topScore，cos 明显低的候选对不可能是重复——先筛掉它们可把 LLM 调用降到「有嫌疑的批」。
 *
 * 合同：
 *  - enabled=false（缺省）→ 与今天完全一致（LLM 调用次数不变、决策不变）；
 *  - enabled=true → 候选为空/无分（FTS、NaN、undefined）fail-open 进 LLM（不得漏判）；
 *    cos < minCos 直接判 store 不进 LLM；cos == minCos 视为放行；
 *  - 向量召回/embedding 抛错 → 回落现状（有 FTS 走 FTS，仍进 LLM；无 FTS 全 store），不抛；
 *  - stats 暴露 {llmCalls, prefiltered}，每批调用次数可见。
 */
import { describe, expect, it } from "vitest";
import {
  batchDedup,
  DEFAULT_PREFILTER_MIN_COS,
  prefilterCandidateMatches,
  resolvePrefilterMinCos,
} from "./l1-dedup.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner } from "../types.js";

const mem = (record_id: string) => ({
  record_id,
  content: `新记忆-${record_id}`,
  type: "episodic" as const,
  priority: 70,
  source_message_ids: [] as string[],
  metadata: {},
  scene_name: "测试情境",
});

const row = (record_id: string, score?: number) => ({
  record_id,
  content: "旧记忆内容",
  type: "episodic",
  priority: 60,
  scene_name: "测试情境",
  timestamp_str: "2026-01-01T00:00:00.000Z",
  session_key: "",
  session_id: "",
  ...(score === undefined ? {} : { score }),
});

/** 按新记忆内容查表返回 cos：number=候选带分，undefined=候选无分，null=无候选。 */
function makeStore(scores: Record<string, number | null | undefined>, opts?: { fts?: boolean }) {
  return {
    countL1VectorRows: async () => 5,
    countL1: async () => 5,
    isFtsAvailable: () => opts?.fts !== false,
    searchL1Vector: async (_v: number[], _k: number, content: string) => {
      const s = scores[content];
      if (s === null) return [];
      return [row("old1", s)];
    },
    searchL1Fts: async () => [row("old-fts")],
  } as unknown as IMemoryStore;
}

function makeEmbedding(throws = false): EmbeddingService {
  return {
    embedBatch: async (texts: string[]) => {
      if (throws) throw new Error("embedding 503");
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
  } as unknown as EmbeddingService;
}

function makeLlm() {
  const captured: Array<{ prompt?: string }> = [];
  const llmRunner = {
    run: async (p: { prompt?: string }) => {
      captured.push(p);
      return "[]";
    },
  } as unknown as LLMRunner;
  return { captured, llmRunner };
}

describe("B4 prefilterCandidateMatches（纯函数）", () => {
  it("关闭：原样全 kept，skipped 为空", () => {
    const matches = [{ newMemory: mem("n1"), candidates: [], topScore: 0.1 }] as never;
    const { kept, skipped } = prefilterCandidateMatches(matches, { enabled: false, minCos: 0.9 });
    expect(kept).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    expect(kept[0]).toBe(matches[0]);
  });

  it("开启：无候选 → skipped；分低于门槛 → skipped；恰好等于/高于 → kept；NaN/undefined → kept", () => {
    const matches = [
      { newMemory: mem("n1"), candidates: [], topScore: 0.99 },
      { newMemory: mem("n2"), candidates: [row("old")], topScore: 0.5 },
      { newMemory: mem("n3"), candidates: [row("old")], topScore: 0.9 },
      { newMemory: mem("n4"), candidates: [row("old")], topScore: 0.95 },
      { newMemory: mem("n5"), candidates: [row("old")], topScore: Number.NaN },
      { newMemory: mem("n6"), candidates: [row("old")] },
    ] as never;
    const { kept, skipped } = prefilterCandidateMatches(matches, { enabled: true, minCos: 0.9 });
    expect(skipped.map((m) => m.newMemory.record_id)).toEqual(["n1", "n2"]);
    expect(kept.map((m) => m.newMemory.record_id)).toEqual(["n3", "n4", "n5", "n6"]);
  });

  it("minCos 非法（NaN/超界）→ 回落缺省（实测校准值）并 clamp 0..1", () => {
    expect(resolvePrefilterMinCos(Number.NaN)).toBe(DEFAULT_PREFILTER_MIN_COS);
    expect(resolvePrefilterMinCos(undefined)).toBe(DEFAULT_PREFILTER_MIN_COS);
    expect(resolvePrefilterMinCos(-1)).toBe(0);
    expect(resolvePrefilterMinCos(5)).toBe(1);
    expect(resolvePrefilterMinCos(0.85)).toBe(0.85);
  });
});

describe("B4 batchDedup 门槛接线", () => {
  it("门槛拦下全部候选 → 零 LLM 调用，全部 store", async () => {
    const { captured, llmRunner } = makeLlm();
    const stats = { llmCalls: 0, prefiltered: 0 };
    const decisions = await batchDedup({
      memories: [mem("n1"), mem("n2")],
      vectorStore: makeStore({ "新记忆-n1": 0.5, "新记忆-n2": 0.42 }),
      embeddingService: makeEmbedding(),
      llmRunner,
      dedupPrefilter: { enabled: true, minCos: 0.9 },
      stats,
    });
    expect(captured).toHaveLength(0);
    expect(stats.llmCalls).toBe(0);
    expect(stats.prefiltered).toBe(2);
    expect(decisions.map((d) => [d.record_id, d.action])).toEqual([
      ["n1", "store"],
      ["n2", "store"],
    ]);
  });

  it("门槛放行一条 → LLM 1 次，prompt 只含放行那条", async () => {
    const { captured, llmRunner } = makeLlm();
    const stats = { llmCalls: 0, prefiltered: 0 };
    const decisions = await batchDedup({
      memories: [mem("n1"), mem("n2")],
      vectorStore: makeStore({ "新记忆-n1": 0.95, "新记忆-n2": 0.5 }),
      embeddingService: makeEmbedding(),
      llmRunner,
      dedupPrefilter: { enabled: true, minCos: 0.9 },
      stats,
    });
    expect(captured).toHaveLength(1);
    expect(stats.llmCalls).toBe(1);
    expect(stats.prefiltered).toBe(1);
    expect(captured[0].prompt ?? "").toContain("新记忆-n1");
    expect(captured[0].prompt ?? "").not.toContain("新记忆-n2");
    expect(decisions.map((d) => d.record_id)).toEqual(["n1", "n2"]);
    expect(decisions.every((d) => d.action === "store")).toBe(true);
  });

  it("cos 恰好等于 minCos → 放行进 LLM（边界含等号）", async () => {
    const { captured, llmRunner } = makeLlm();
    const stats = { llmCalls: 0, prefiltered: 0 };
    await batchDedup({
      memories: [mem("n1")],
      vectorStore: makeStore({ "新记忆-n1": 0.9 }),
      embeddingService: makeEmbedding(),
      llmRunner,
      dedupPrefilter: { enabled: true, minCos: 0.9 },
      stats,
    });
    expect(captured).toHaveLength(1);
    expect(stats.llmCalls).toBe(1);
    expect(stats.prefiltered).toBe(0);
  });

  it("embedding 抛错 + 有 FTS → 回落 FTS，仍进 LLM（不漏判）", async () => {
    const { captured, llmRunner } = makeLlm();
    const stats = { llmCalls: 0, prefiltered: 0 };
    const decisions = await batchDedup({
      memories: [mem("n1")],
      vectorStore: makeStore({ "新记忆-n1": 0.1 }),
      embeddingService: makeEmbedding(true),
      llmRunner,
      dedupPrefilter: { enabled: true, minCos: 0.9 },
      stats,
    });
    expect(captured).toHaveLength(1);
    expect(stats.llmCalls).toBe(1);
    expect(decisions).toHaveLength(1);
  });

  it("embedding 抛错 + 无 FTS → 不抛，全部 store（与关闭时降级一致）", async () => {
    const { llmRunner } = makeLlm();
    const stats = { llmCalls: 0, prefiltered: 0 };
    const decisions = await batchDedup({
      memories: [mem("n1")],
      vectorStore: makeStore({ "新记忆-n1": 0.1 }, { fts: false }),
      embeddingService: makeEmbedding(true),
      llmRunner,
      dedupPrefilter: { enabled: true, minCos: 0.9 },
      stats,
    });
    expect(decisions.map((d) => d.action)).toEqual(["store"]);
    expect(stats.llmCalls).toBe(0);
  });

  it("关闭（缺省）：低分候选仍然进 LLM，调用次数与今天一致", async () => {
    const { captured, llmRunner } = makeLlm();
    const stats = { llmCalls: 0, prefiltered: 0 };
    const decisions = await batchDedup({
      memories: [mem("n1"), mem("n2")],
      vectorStore: makeStore({ "新记忆-n1": 0.1, "新记忆-n2": 0.2 }),
      embeddingService: makeEmbedding(),
      llmRunner,
      stats,
    });
    expect(captured).toHaveLength(1);
    expect(stats.llmCalls).toBe(1);
    expect(stats.prefiltered).toBe(0);
    expect(decisions).toHaveLength(2);
  });

  it("候选为空（零候选批次）：零 LLM 调用（既有快路径不变）", async () => {
    const { captured, llmRunner } = makeLlm();
    const stats = { llmCalls: 0, prefiltered: 0 };
    const decisions = await batchDedup({
      memories: [mem("n1")],
      vectorStore: makeStore({ "新记忆-n1": null }),
      embeddingService: makeEmbedding(),
      llmRunner,
      dedupPrefilter: { enabled: true, minCos: 0.9 },
      stats,
    });
    expect(captured).toHaveLength(0);
    expect(decisions.map((d) => d.action)).toEqual(["store"]);
  });
});
