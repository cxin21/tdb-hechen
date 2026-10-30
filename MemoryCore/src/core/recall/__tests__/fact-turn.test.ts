/**
 * #146（W2b）：事实行 → turn 的读侧折叠。
 *
 * 这些用例钉死的是那次实测回归的根因：事实行模式下若按行计 k，同一 turn 的 n 条事实
 * 各占一个槽（LME90 turnCov@5 78.4→68.0、偏好桶 93.3→55.6）。折叠后 k 槽回到 turn 粒度。
 */
import { describe, expect, it } from "vitest";
import { collapseFactRowsByTurn, containsStaleValue, normalizeStaleText } from "../fact-turn.js";

interface Hit {
  id: string;
  factOf?: string;
  score: number;
  /** #166：本行事实短语（metadata.fact_phrase） */
  phrase?: string;
  /** #166：本行事实值（metadata.fact_value） */
  value?: string;
}

const collapse = (hits: Hit[], superseded: Hit[] = []) =>
  collapseFactRowsByTurn(hits, (h) => h.factOf, (h) => h.score, {
    superseded,
    phraseOf: (h) => h.phrase,
    valueOf: (h) => h.value,
  });

describe("collapseFactRowsByTurn（事实行折叠回 turn）", () => {
  it("无 fact_of 的普通记忆原样保留（缺省路径零变化）", () => {
    const hits: Hit[] = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.8 },
    ];
    const { items, stats } = collapse(hits);
    expect(items.map((h) => h.id)).toEqual(["a", "b"]);
    expect(stats).toMatchObject({ before: 2, collapsed: 0, after: 2, maskedRows: 0, droppedRows: 0, staleValues: 0 });
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
    expect(stats).toMatchObject({ before: 4, collapsed: 2, after: 2 });
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
    expect(collapse([]).stats).toMatchObject({ before: 0, collapsed: 0, after: 0, maskedRows: 0, droppedRows: 0, staleValues: 0 });
  });

  it("不传 superseded 时逐位保持 v2 行为（displayContent 空、无行被剔）", () => {
    const hits: Hit[] = [
      { id: "t1", factOf: "turn-1", score: 0.5, phrase: "用户住在柏林", value: "柏林" },
      { id: "t1#f2", factOf: "turn-1", score: 0.4, phrase: "用户最近迷上摄影", value: "摄影" },
    ];
    const projection = collapse(hits);
    expect(projection.items.map((h) => h.id)).toEqual(["t1"]);
    expect(projection.displayContent.size).toBe(0);
    expect(projection.stats.maskedRows).toBe(0);
  });
});

/**
 * #166：present-intent 值级泄漏补口。
 *
 * 场景（票面复现）：turn-1 一次抽出两条事实——居住城市=柏林(single) 与 爱好=摄影(multi)。
 * 柏林被 turn-3 取代后，**行级**失效正确（turn-1 那条 dropped），但同 turn 的兄弟行
 * turn-1#f2 仍 active，若折叠回 turn 时用父 turn 原文，就会把「我住在柏林…」重新注入。
 * 这里的契约：被取代行所属 turn 的存活行，注入文本降级为**各自的事实短语**；
 * 拿不到干净短语的行直接剔出注入（宁缺毋滥）。
 */
describe("collapseFactRowsByTurn（#166 present-intent 值级遮蔽）", () => {
  const supersededBerlin: Hit = { id: "turn-1", factOf: "turn-1", score: 0.5, phrase: "用户住在柏林", value: "柏林" };

  it("污染 turn 的存活行改用事实短语渲染（旧值没有任何回流入口）", () => {
    const hits: Hit[] = [{ id: "turn-1#f2", factOf: "turn-1", score: 0.9, phrase: "用户最近迷上摄影", value: "摄影" }];
    const projection = collapse(hits, [supersededBerlin]);
    expect(projection.items.map((h) => h.id)).toEqual(["turn-1#f2"]);
    expect(projection.displayContent.get(projection.items[0])).toBe("用户最近迷上摄影");
    expect(projection.stats.maskedRows).toBe(1);
    expect(projection.stats.droppedRows).toBe(0);
    expect(projection.stats.staleValues).toBe(1);
  });

  it("落选兄弟被剔不算丢证据（droppedRows 只数整组无行可注入的 turn）", () => {
    const hits: Hit[] = [
      { id: "turn-1#f1", factOf: "turn-1", score: 0.9, phrase: "用户最近迷上摄影", value: "摄影" },
      { id: "turn-1#f2", factOf: "turn-1", score: 0.8, value: "吉他" },
    ];
    const projection = collapse(hits, [supersededBerlin]);
    expect(projection.items.map((h) => h.id)).toEqual(["turn-1#f1"]);
    expect(projection.stats.maskedRows).toBe(1);
    expect(projection.stats.droppedRows).toBe(0);
  });

  it("短语缺失 → 该行剔出注入（无法保证不带旧值的行不进上下文）", () => {
    const hits: Hit[] = [{ id: "turn-1#f2", factOf: "turn-1", score: 0.9, value: "摄影" }];
    const projection = collapse(hits, [supersededBerlin]);
    expect(projection.items).toEqual([]);
    expect(projection.stats.droppedRows).toBe(1);
    expect(projection.stats.maskedRows).toBe(0);
  });

  it("短语自身仍含旧值 → 剔出（抽取/归一异常不得把旧值带进去）", () => {
    const hits: Hit[] = [
      { id: "turn-1#f2", factOf: "turn-1", score: 0.9, phrase: "用户住在柏林并迷上摄影", value: "摄影" },
    ];
    const projection = collapse(hits, [supersededBerlin]);
    expect(projection.items).toEqual([]);
    expect(projection.stats.droppedRows).toBe(1);
  });

  it("未被污染的 turn 不受影响（displayContent 不挂、文本仍是父 turn 原文）", () => {
    const hits: Hit[] = [
      { id: "turn-2", factOf: "turn-2", score: 0.8, phrase: "用户还在学吉他", value: "吉他" },
      { id: "plain", score: 0.7 },
    ];
    const projection = collapse(hits, [supersededBerlin]);
    expect(projection.items.map((h) => h.id)).toEqual(["turn-2", "plain"]);
    expect(projection.displayContent.size).toBe(0);
  });

  it("同 turn 多条存活行折叠后只为 winner 挂安全文本（落选兄弟不渲染）", () => {
    const hits: Hit[] = [
      { id: "turn-1#f2", factOf: "turn-1", score: 0.9, phrase: "用户最近迷上摄影", value: "摄影" },
      { id: "turn-1#f3", factOf: "turn-1", score: 0.3, phrase: "用户养了只猫", value: "猫" },
    ];
    const projection = collapse(hits, [supersededBerlin]);
    expect(projection.items.map((h) => h.id)).toEqual(["turn-1#f2"]);
    expect(projection.displayContent.get(projection.items[0])).toBe("用户最近迷上摄影");
    expect(projection.displayContent.size).toBe(1);
    expect(projection.stats.collapsed).toBe(1);
  });

  it("被取代行缺 value 时仍视为污染源（保守：原文不可整段注入）", () => {
    const hits: Hit[] = [{ id: "turn-1#f2", factOf: "turn-1", score: 0.9, phrase: "用户最近迷上摄影", value: "摄影" }];
    const projection = collapse(hits, [{ id: "turn-1", factOf: "turn-1", score: 0.5 }]);
    expect(projection.displayContent.get(projection.items[0])).toBe("用户最近迷上摄影");
    expect(projection.stats.staleValues).toBe(0);
  });
});

describe("containsStaleValue（旧值判定口径）", () => {
  it("CJK 值走子串匹配（中文没有词边界）", () => {
    expect(containsStaleValue("用户住在柏林，最近迷上摄影", "柏林")).toBe(true);
    expect(containsStaleValue("用户搬到慕尼黑", "柏林")).toBe(false);
  });

  it("纯 ASCII 值走词边界：LA 不命中 planning（真实语料误判点）", () => {
    expect(containsStaleValue("user is planning a trip to San Francisco", "LA")).toBe(false);
    expect(containsStaleValue("trip to LA in a few weeks", "LA")).toBe(true);
    expect(containsStaleValue("LA-bound", "LA")).toBe(true);
    expect(containsStaleValue("Berlin trip", "Ber")).toBe(false);
  });

  it("归一化抹平大小写/空白/全半角差异", () => {
    expect(normalizeStaleText("  ＬＡ  bound ")).toBe("la bound");
    expect(containsStaleValue("Ｐｒｅｍｉｅｒ　Silver", "premier silver")).toBe(true);
    expect(containsStaleValue("anything", "")).toBe(false);
  });
});
