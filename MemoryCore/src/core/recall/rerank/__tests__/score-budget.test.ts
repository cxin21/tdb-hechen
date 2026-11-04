import { describe, expect, it } from "vitest";
import { RERANK_SCORE_BUDGET_MS, RERANK_SCORE_CHUNK, rerankWithinBudget } from "../score-budget.js";

const docsOf = (n: number, len = 10): string[] =>
  Array.from({ length: n }, (_, i) => "d" + i + "x".repeat(len - String(i).length - 1));

/** 假钟：每次 now() 前进固定毫秒，模拟「一块耗时」。 */
const fakeClock = (stepMs: number) => {
  let t = 0;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
};

describe("rerankWithinBudget", () => {
  it("池子不超过一块时整池一次送评（保持单次调用语义）", async () => {
    const seen: number[] = [];
    const out = await rerankWithinBudget(docsOf(RERANK_SCORE_CHUNK), async (batch) => {
      seen.push(batch.length);
      return batch.map((_, i) => ({ index: i, score: 1 - i }));
    });
    expect(seen).toEqual([RERANK_SCORE_CHUNK]);
    expect(out.scoredDocs).toBe(RERANK_SCORE_CHUNK);
    expect(out.ranked?.map((r) => r.index)).toEqual(Array.from({ length: RERANK_SCORE_CHUNK }, (_, i) => i));
  });

  it("超过一块时按块滚动，index 还原为整池下标", async () => {
    const total = RERANK_SCORE_CHUNK * 2 + 1;
    const chunks: number[] = [];
    const out = await rerankWithinBudget(
      docsOf(total),
      async (batch) => {
        chunks.push(batch.length);
        return batch.map((_, i) => ({ index: i, score: 1 }));
      },
      fakeClock(0),
    );
    expect(chunks).toEqual([RERANK_SCORE_CHUNK, RERANK_SCORE_CHUNK, 1]);
    expect(out.scoredDocs).toBe(total);
    expect(out.ranked?.map((r) => r.index)).toEqual(Array.from({ length: total }, (_, i) => i));
  });

  it("预算到点即停，剩余候选不计入 scoredDocs / scoredChars", async () => {
    // 每块 400ms：首块 0→400，第二块前 400>700? 否 → 跑；第二块后 800 → 第三块前 800>700 → 停。
    const out = await rerankWithinBudget(
      docsOf(30, 5),
      async (batch) => batch.map((_, i) => ({ index: i, score: 0.5 })),
      fakeClock(400),
      { budgetMs: 1_000 },
    );
    expect(out.scoredDocs).toBe(RERANK_SCORE_CHUNK * 2);
    expect(out.scoredChars).toBe(RERANK_SCORE_CHUNK * 2 * 5);
    expect(out.ranked).toHaveLength(RERANK_SCORE_CHUNK * 2);
  });

  it("任一子块降级（null）→ 整次降级，不返回半份分数", async () => {
    let call = 0;
    const out = await rerankWithinBudget(
      docsOf(20),
      async (batch) => {
        call += 1;
        if (call === 2) return null;
        return batch.map((_, i) => ({ index: i, score: 1 }));
      },
      fakeClock(0),
    );
    expect(out.ranked).toBeNull();
    expect(out.scoredDocs).toBe(0);
  });

  it("首块无条件跑（预算极小时精排不被静默关闭）", async () => {
    const chunks: number[] = [];
    const out = await rerankWithinBudget(
      docsOf(20),
      async (batch) => {
        chunks.push(batch.length);
        return batch.map((_, i) => ({ index: i, score: 1 }));
      },
      fakeClock(10_000),
      { budgetMs: 1 },
    );
    expect(chunks).toEqual([RERANK_SCORE_CHUNK]);
    expect(out.scoredDocs).toBe(RERANK_SCORE_CHUNK);
  });

  it("单块超时：保留已评分块，超时块及之后按未评分处理（不整次降级）", async () => {
    let call = 0;
    const out = await rerankWithinBudget(
      docsOf(RERANK_SCORE_CHUNK * 3),
      async (batch) => {
        call += 1;
        if (call === 2) await new Promise((r) => setTimeout(r, 120));
        return batch.map((_, i) => ({ index: i, score: 1 }));
      },
      fakeClock(0),
      { budgetMs: 5_000, slackMs: 20 },
    );
    // 第 2 块放弃等待 ⇒ 只保留第 1 块
    expect(out.ranked).toHaveLength(RERANK_SCORE_CHUNK);
    expect(out.scoredDocs).toBe(RERANK_SCORE_CHUNK);
  });

  it("超时标记 timedOut（调用方据此不推熔断），且**不去杀在途推理**", async () => {
    const out = await rerankWithinBudget(
      docsOf(RERANK_SCORE_CHUNK * 3),
      async () => {
        await new Promise((r) => setTimeout(r, 120));
        return [{ index: 0, score: 1 }];
      },
      fakeClock(0),
      { budgetMs: 5_000, slackMs: 20 },
    );
    expect(out.timedOut).toBe(true);
    expect(out.ranked).toBeNull();
  });

  it("首块即超时：没有任何分数 ⇒ 整次降级（调用方回到融合原序）", async () => {
    const out = await rerankWithinBudget(
      docsOf(RERANK_SCORE_CHUNK * 2),
      async () => {
        await new Promise((r) => setTimeout(r, 120));
        return [{ index: 0, score: 1 }];
      },
      fakeClock(0),
      { budgetMs: 5_000, slackMs: 20 },
    );
    expect(out.ranked).toBeNull();
    expect(out.scoredDocs).toBe(0);
  });

  it("空池直接返回空结果，不调用 provider", async () => {
    let called = 0;
    const out = await rerankWithinBudget([], async () => {
      called += 1;
      return [];
    });
    expect(called).toBe(0);
    expect(out).toEqual({ ranked: [], scoredDocs: 0, scoredChars: 0 });
  });
});
