/**
 * A3（P1，2026-11-02）：agent 自述行的注入面过滤（纯函数层）单测。
 *
 * 契约（本文件锁定，改实现前先改这里）：
 *  - enabled=false → 恒等（keptIndexes=0..n-1），零成本（不查 actor）。
 *  - 查询自指（isSelfQuery）→ 不过滤：要召回的正是"AI 自己说过/做过什么"。
 *  - actor === "agent" → 丢；actor 其它值 / 未知 / 行无 recordId → 保留（宁留勿误杀）。
 *  - 载入 actor 的分片（≤20/次）、损坏 metadata_json 容忍、fetch 抛错整体降级为"全部未知"。
 */
import { describe, expect, it } from "vitest";
import {
  filterSelfNarrationLines,
  loadActorByIds,
  narrationTagCoverage,
  SELF_NARRATION_ACTOR,
} from "./self-narration-filter.js";

describe("filterSelfNarrationLines", () => {
  const metas = (ids: Array<string | undefined>) => ids.map((recordId) => (recordId ? { recordId } : undefined));

  it("disabled → 恒等（逐位现状）", () => {
    const out = filterSelfNarrationLines({
      lines: ["a", "b", "c"],
      metas: metas(["r1", "r2", "r3"]),
      actorOf: new Map([["r1", "agent"]]),
      enabled: false,
      isSelfQuery: false,
    });
    expect(out.keptIndexes).toEqual([0, 1, 2]);
    expect(out.dropped).toBe(0);
    expect(out.scanned).toBe(0);
  });

  it("查询自指 → 不过滤（要的就是 AI 自己的行）", () => {
    const out = filterSelfNarrationLines({
      lines: ["a", "b"],
      metas: metas(["r1", "r2"]),
      actorOf: new Map([
        ["r1", "agent"],
        ["r2", "agent"],
      ]),
      enabled: true,
      isSelfQuery: true,
    });
    expect(out.keptIndexes).toEqual([0, 1]);
    expect(out.dropped).toBe(0);
    expect(out.skipped).toBe("self-query");
  });

  it("actor=agent 丢，其它保留（顺序不变）", () => {
    const out = filterSelfNarrationLines({
      lines: ["a", "b", "c", "d"],
      metas: metas(["r1", "r2", "r3", "r4"]),
      actorOf: new Map([
        ["r1", "agent"],
        ["r2", "user"],
        ["r3", "agent"],
        ["r4", "agent"],
      ]),
      enabled: true,
      isSelfQuery: false,
    });
    expect(out.keptIndexes).toEqual([1]);
    expect(out.dropped).toBe(3);
    expect(out.scanned).toBe(4);
    expect(out.droppedRecordIds).toEqual(["r1", "r3", "r4"]);
  });

  it("未知 actor / 无 recordId / metas 缺失 → 一律保留（宁留勿误杀）", () => {
    const out = filterSelfNarrationLines({
      lines: ["a", "b", "c"],
      metas: metas([undefined, "r2", "r3"]),
      actorOf: new Map([["r3", "user"]]),
      enabled: true,
      isSelfQuery: false,
    });
    expect(out.keptIndexes).toEqual([0, 1, 2]);
    expect(out.dropped).toBe(0);
    expect(out.scanned).toBe(2);
  });

  it("全丢 → keptIndexes 空（调用方须能处理零行池）", () => {
    const out = filterSelfNarrationLines({
      lines: ["a"],
      metas: metas(["r1"]),
      actorOf: new Map([["r1", "agent"]]),
      enabled: true,
      isSelfQuery: false,
    });
    expect(out.keptIndexes).toEqual([]);
    expect(out.dropped).toBe(1);
  });

  it("空池 → 零扫描，不炸", () => {
    const out = filterSelfNarrationLines({
      lines: [],
      metas: [],
      actorOf: new Map(),
      enabled: true,
      isSelfQuery: false,
    });
    expect(out.keptIndexes).toEqual([]);
    expect(out.dropped).toBe(0);
    expect(out.scanned).toBe(0);
  });

  it("metas 比 lines 短 → 缺 meta 的行按未知保留", () => {
    const out = filterSelfNarrationLines({
      lines: ["a", "b"],
      metas: metas(["r1"]),
      actorOf: new Map([["r1", "agent"]]),
      enabled: true,
      isSelfQuery: false,
    });
    expect(out.keptIndexes).toEqual([1]);
    expect(out.dropped).toBe(1);
  });
});

describe("loadActorByIds", () => {
  it("按 20 分片查询（VDB documentIds 上限），合并结果", async () => {
    const calls: string[][] = [];
    const ids = Array.from({ length: 45 }, (_, i) => `r${i}`);
    const actorOf = await loadActorByIds(ids, (batch) => {
      calls.push(batch);
      return batch.map((id) => ({ record_id: id, metadata_json: JSON.stringify({ actor: "agent" }) }));
    });
    expect(calls.map((c) => c.length)).toEqual([20, 20, 5]);
    expect(actorOf.get("r44")).toBe(SELF_NARRATION_ACTOR);
  });

  it("空 ids → 零调用", async () => {
    let called = 0;
    const out = await loadActorByIds([], () => {
      called += 1;
      return [];
    });
    expect(called).toBe(0);
    expect(out.size).toBe(0);
  });

  it("损坏 metadata_json / 重复 id → 跳过坏行、去重", async () => {
    const actorOf = await loadActorByIds(["r1", "r1", "r2"], (batch) => [
      { record_id: "r1", metadata_json: "{broken" },
      { record_id: "r2", metadata_json: JSON.stringify({ actor: "agent" }) },
    ]);
    expect(actorOf.get("r1")).toBeUndefined();
    expect(actorOf.get("r2")).toBe("agent");
  });

  it("fetch 抛错 → 降级为空表（调用方按未知保留，不阻断召回）", async () => {
    const actorOf = await loadActorByIds(["r1"], () => {
      throw new Error("db down");
    });
    expect(actorOf.size).toBe(0);
  });

  it("metadata.actor 非字符串（数字/对象）→ 忽略", async () => {
    const actorOf = await loadActorByIds(["r1", "r2"], () => [
      { record_id: "r1", metadata_json: JSON.stringify({ actor: 1 }) },
      { record_id: "r2", metadata_json: JSON.stringify({ actor: { x: 1 } }) },
    ]);
    expect(actorOf.get("r1")).toBeUndefined();
    expect(actorOf.get("r2")).toBeUndefined();
  });
});

/**
 * A4（2026-11-03）：写侧标签覆盖率对账（只读纯函数，供 metrics 后续调用）。
 * 三个数字回答三个不同的问题，**不可互相替代**：
 *  - tagged：真正带 `metadata.actor="agent"` 的行（读侧过滤的唯一依据）；
 *  - heuristicHits：用**当前版本**启发式重判会命中的行（判定版本口径）；
 *  - taggedMiss：命中启发式但没标签 → 写侧覆盖缺口（开关未开 / 存量行 / 合并改写）。
 */
describe("narrationTagCoverage（写侧覆盖率对账）", () => {
  it("空输入 → 全零", () => {
    expect(narrationTagCoverage([])).toEqual({
      total: 0,
      tagged: 0,
      heuristicHits: 0,
      taggedMiss: 0,
    });
  });

  it("标签 / 启发式 / 缺口分开计数；空内容不计入启发式", () => {
    const out = narrationTagCoverage([
      { content: "我在和用户做记忆系统改造", actor: "agent" },
      { content: "AI 于 2026-10-14 完成 Task 7 代码评审" },
      { content: "模型参数写错了" },
      { content: "我明天提交周报", actor: "agent" },
      { content: undefined, actor: "agent" }, // 空内容仍算 tagged（标签只看 metadata）
    ]);
    // tagged 数的是 metadata 标签，与 content 是否可判无关 → 3 行带标签。
    expect(out).toEqual({ total: 5, tagged: 3, heuristicHits: 2, taggedMiss: 1 });
  });

  it("非 agent 标签不计入 tagged；启发式命中但标签缺失计入 taggedMiss", () => {
    const out = narrationTagCoverage([{ content: "我承诺每周五出周报", actor: "user" }, {}]);
    expect(out).toEqual({ total: 2, tagged: 0, heuristicHits: 1, taggedMiss: 1 });
  });
});
