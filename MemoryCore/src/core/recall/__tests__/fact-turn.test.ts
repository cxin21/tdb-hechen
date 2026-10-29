/**
 * #146（W2b）：事实行 → turn 的读侧折叠。
 *
 * 这些用例钉死的是那次实测回归的根因：事实行模式下若按行计 k，同一 turn 的 n 条事实
 * 各占一个槽（LME90 turnCov@5 78.4→68.0、偏好桶 93.3→55.6）。折叠后 k 槽回到 turn 粒度。
 */
import { describe, expect, it } from "vitest";
import { collapseFactRowsByTurn } from "../fact-turn.js";

interface Hit {
  id: string;
  factOf?: string;
  score: number;
}

const collapse = (hits: Hit[]) =>
  collapseFactRowsByTurn(hits, (h) => h.factOf, (h) => h.score);

describe("collapseFactRowsByTurn（事实行折叠回 turn）", () => {
  it("无 fact_of 的普通记忆原样保留（缺省路径零变化）", () => {
    const hits: Hit[] = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.8 },
    ];
    const { items, stats } = collapse(hits);
    expect(items.map((h) => h.id)).toEqual(["a", "b"]);
    expect(stats).toEqual({ before: 2, collapsed: 0, after: 2 });
  });

  it("同 turn 的多条事实行只留最高分那条（槽位不再被兄弟事实吃满）", () => {
    const hits: Hit[] = [
      { id: "t1", factOf: "turn-1", score: 0.5 },
      { id: "t1#f2", factOf: "turn-1", score: 0.9 },
      { id: "t1#f3", factOf: "turn-1", score: 0.2 },
      { id: "t2", factOf: "turn-2", score: 0.7 },
    ];
    const { items, stats } = collapse(hits);
    expect(items.map((h) => h.id)).toEqual(["t1#f2", "t2"]);
    expect(items[0].score).toBe(0.9);
    expect(stats).toEqual({ before: 4, collapsed: 2, after: 2 });
  });

  it("保留最高分首次出现的位置（不打乱既有排序语义）", () => {
    const hits: Hit[] = [
      { id: "turn-1", factOf: "turn-1", score: 0.3 },
      { id: "other", score: 0.4 },
      { id: "turn-1#f2", factOf: "turn-1", score: 0.8 },
    ];
    const { items } = collapse(hits);
    expect(items.map((h) => h.id)).toEqual(["turn-1#f2", "other"]);
  });

  it("不同 turn 的事实行互不影响", () => {
    const hits: Hit[] = [
      { id: "t1", factOf: "turn-1", score: 0.5 },
      { id: "t2", factOf: "turn-2", score: 0.6 },
      { id: "t3", factOf: "turn-3", score: 0.7 },
    ];
    const { items, stats } = collapse(hits);
    expect(items).toHaveLength(3);
    expect(stats.collapsed).toBe(0);
  });

  it("空输入安全", () => {
    expect(collapse([]).items).toEqual([]);
    expect(collapse([]).stats).toEqual({ before: 0, collapsed: 0, after: 0 });
  });
});
