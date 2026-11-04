import { describe, it, expect } from "vitest";
import { buildAdjacency, pprKindRank } from "../ppr.js";

/**
 * D 项（2026-11-04）：边型受控词表落地后，pprKindRank 按**真实词表**重排。
 *
 * 依据：生产 D:/TDB/data/vectors.db l1_links 共 53964 条实测分布
 *   derived_from 42523 / similar 9934 / part_of 1217 / evolve 730 / conflict 91（causal 零行）。
 * causal 无任何存量、无写点，故其「最优」特判删除；evolved_from（演化合并审计边）
 * 是最强的"同一事实不同年代"信号，取最优；conflict 次之（矛盾双方都保留，召回时值得解释）。
 */
describe("D 项 · pprKindRank 按真实边型词表重排", () => {
  it("evolved_from=0 / conflict=1 / 其余=2", () => {
    expect(pprKindRank("evolved_from")).toBe(0);
    expect(pprKindRank("conflict")).toBe(1);
    expect(pprKindRank("similar")).toBe(2);
  });

  it("词表内其余边型与历史/未知字面量统一归 2（不再特判 causal / evolve）", () => {
    // 词表内（store/types.ts LINK_TYPES）但非 tiebreak 优先项
    for (const kind of ["derived_from", "part_of", "evolve"]) {
      expect(pprKindRank(kind)).toBe(2);
    }
    // 历史字面量（测试 fixture / 旧库残留）：causal 曾是最优先(0)，现在不再特判
    expect(pprKindRank("causal")).toBe(2);
    // 完全未知：容忍（归 2，不抛）
    expect(pprKindRank("related")).toBe(2);
    expect(pprKindRank("")).toBe(2);
  });

  it("buildAdjacency：同权同对端三条边按 evolved_from < conflict < similar 排序", () => {
    // 三个同权邻居（kind 分别 similar / conflict / evolved_from），故意乱序输入
    const { adj } = buildAdjacency([
      { src: "seed", tgt: "n1", strength: 0.5, kind: "similar" },
      { src: "seed", tgt: "n1", strength: 0.5, kind: "evolved_from" },
      { src: "seed", tgt: "n1", strength: 0.5, kind: "conflict" },
    ]);
    const kinds = (adj.get("seed") ?? []).map((e) => e.kind);
    expect(kinds).toEqual(["evolved_from", "conflict", "similar"]);
    // 反向侧同序（无向化后两端各一条邻接表）
    expect((adj.get("n1") ?? []).map((e) => e.kind)).toEqual(["evolved_from", "conflict", "similar"]);
  });
});
