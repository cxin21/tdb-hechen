import { describe, expect, it } from "vitest";
import { groupBySubject, subjectOf, isObservable, DEFAULT_CONSOLIDATION_CONFIG } from "../grouping.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

function mk(id: string, content: string, priority = 60, timestamps: string[] = [], certainty?: string): MemoryRecord {
  return {
    id, content, type: "work_fact", priority, scene_name: "s", source_message_ids: [],
    metadata: {}, timestamps, createdAt: "", updatedAt: "", version: 1,
    sessionKey: "k", sessionId: "sid", certainty,
  } as MemoryRecord;
}

describe("groupBySubject (H 巩固分组)", () => {
  it("同 subject ≥ minCount 且跨期 → 归组", () => {
    const mems = [
      mk("a", "知识库召回：本地向量跑通", 70, ["2026-09-01T00:00:00Z"]),
      mk("b", "知识库召回：增量对账完成", 70, ["2026-09-05T00:00:00Z"]),
      mk("c", "知识库召回：重排预留", 70, ["2026-09-09T00:00:00Z"]),
    ];
    const groups = groupBySubject(mems, DEFAULT_CONSOLIDATION_CONFIG);
    expect(groups.length).toBe(1);
    expect(groups[0].subject).toContain("知识库召回");
    expect(groups[0].memories.length).toBe(3);
  });

  it("条数不足 minCount → 不归组", () => {
    const mems = [mk("a", "主题X：一条", 70, ["2026-09-01T00:00:00Z"]), mk("b", "主题X：两条", 70, ["2026-09-05T00:00:00Z"])];
    expect(groupBySubject(mems, { ...DEFAULT_CONSOLIDATION_CONFIG, minCount: 3 }).length).toBe(0);
  });

  it("未跨期(span<minSpanDays) → 不归组", () => {
    const mems = [
      mk("a", "同天：三条", 70, ["2026-09-01T00:00:00Z"]),
      mk("b", "同天：三条", 70, ["2026-09-01T00:00:03Z"]),
      mk("c", "同天：三条", 70, ["2026-09-01T00:00:06Z"]),
    ];
    const groups = groupBySubject(mems, { ...DEFAULT_CONSOLIDATION_CONFIG, minSpanDays: 1 });
    expect(groups.length).toBe(0);
  });

  it("inferred 不计为可观察（reconsolidation 红线）", () => {
    expect(isObservable({ certainty: "observed" })).toBe(true);
    expect(isObservable({ certainty: "inferred" })).toBe(false);
  });
});

describe("subjectOf (归并键)", () => {
  it("取冒号/分隔符前", () => {
    expect(subjectOf(mk("a", "知识库召回：本地跑通")).includes("知识库召回")).toBe(true);
  });
});