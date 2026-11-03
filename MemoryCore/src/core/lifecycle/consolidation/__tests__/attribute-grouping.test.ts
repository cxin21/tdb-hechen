/**
 * B1（P6）属性键归组 + embedding 兜底：grouping.ts 的归组合同。
 *
 * 现状病灶（research §3.P6）：consolidation-worker.ts:100-106 用 metadata.subject 整串相等
 * 做幂等键 ⇒ 反思结论 862 条共用一个 subject ⇒ 合成一张巨卡。这里锁属性键行为：
 *   - 键 = (entity, attribute)；两键皆可归一才进球，否则进待聚类池；
 *   - 池内单链聚类（cos ≥ minCos）；无 embedding 的记录各自成组，不静默丢弃；
 *   - 单卡记录数上限 MAX_RECORDS_PER_CARD（防大卡），超限均分切卡。
 */
import { describe, expect, it } from "vitest";
import { groupByAttribute, poolRecordsOf, MAX_RECORDS_PER_CARD, DEFAULT_CONSOLIDATION_CONFIG } from "../grouping.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

function mk(id: string, content: string, metadata: Record<string, unknown> = {}, day = 1): MemoryRecord {
  const ts = `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  return {
    id,
    content,
    type: "work_fact",
    priority: 60,
    scene_name: "s",
    source_message_ids: [],
    metadata: metadata as MemoryRecord["metadata"],
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    version: 1,
    sessionKey: "k",
    sessionId: "s",
    occurred_at: ts,
    certainty: "observed",
  } as unknown as MemoryRecord;
}

const vec = (...xs: number[]) => new Float32Array(xs);

describe("groupByAttribute（属性键归组）", () => {
  it("同 entity 同 attribute 不同表述 → 一组", () => {
    const mems = [
      mk("a", "决定先做前端再谈分摊算法", { work_object: "tjbh-frontend" }, 1),
      mk("b", "拍板：先做前端", { work_object: "TJbh-Frontend " }, 3),
      mk("c", "确定方案：先做前端再补后端", { work_object: "tjbh-frontend。" }, 6),
    ];
    const groups = groupByAttribute(mems, DEFAULT_CONSOLIDATION_CONFIG, undefined, { minCos: 0.82 });
    expect(groups).toHaveLength(1);
    expect(groups[0].attributeKey).toBe("tjbh-frontend|decision");
    expect(groups[0].subject).toBe("tjbh-frontend|decision");
    expect(groups[0].memories.map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("同 entity 不同 attribute → 不归（两组）", () => {
    const mems = [
      mk("d1", "决定先做前端", { work_object: "td-agemem" }, 1),
      mk("d2", "拍板：先做前端", { work_object: "td-agemem" }, 3),
      mk("d3", "确定方案：先做前端", { work_object: "td-agemem" }, 5),
      mk("t1", "使用 bge 向量", { work_object: "td-agemem" }, 1),
      mk("t2", "工具链改用 vitest", { work_object: "td-agemem" }, 4),
      mk("t3", "采用单链聚类兜底", { work_object: "td-agemem" }, 7),
    ];
    const groups = groupByAttribute(mems, DEFAULT_CONSOLIDATION_CONFIG, undefined, { minCos: 0.82 });
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.attributeKey).sort()).toEqual(["td-agemem|decision", "td-agemem|tooling"]);
    for (const g of groups) expect(g.memories).toHaveLength(3);
  });

  it("同 subject 不同 attribute → 不归（自证不是 subject 字符串归组）", () => {
    const mems = [
      mk("a1", "决定先做前端", { subject: "反思结论", work_object: "td-agemem" }, 1),
      mk("a2", "拍板：先做前端", { subject: "反思结论", work_object: "td-agemem" }, 3),
      mk("a3", "确定方案：先做前端", { subject: "反思结论", work_object: "td-agemem" }, 5),
      mk("b1", "使用 bge 向量", { subject: "反思结论", work_object: "td-agemem" }, 2),
      mk("b2", "工具链改用 vitest", { subject: "反思结论", work_object: "td-agemem" }, 4),
      mk("b3", "采用单链聚类兜底", { subject: "反思结论", work_object: "td-agemem" }, 6),
    ];
    const groups = groupByAttribute(mems, DEFAULT_CONSOLIDATION_CONFIG, undefined, { minCos: 0.82 });
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.attributeKey)).size).toBe(2);
  });

  it("属性无法归一 → embedding 单链聚类兜底（cos ≥ minCos 归一组）", () => {
    const mems = [
      mk("p1", "今天天气不错", {}, 1),
      mk("p2", "今天天气挺好", {}, 3),
      mk("p3", "苹果手机电池保养", {}, 5),
    ];
    const vectors = new Map<string, Float32Array>([
      ["p1", vec(1, 0)],
      ["p2", vec(0.98, 0.199)],
      ["p3", vec(0, 1)],
    ]);
    const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, minCount: 1 };
    const groups = groupByAttribute(mems, cfg, undefined, { minCos: 0.82, vectors });
    expect(groups).toHaveLength(2);
    const sizes = groups.map((g) => g.memories.length).sort();
    expect(sizes).toEqual([1, 2]);
    // 池内组也必须带可追溯的键（不能是空串 / undefined）
    for (const g of groups) expect(typeof g.subject).toBe("string");
    expect(groups.every((g) => g.attributeKey === undefined)).toBe(true);
  });

  it("embedding 缺失 → 各自独立成组（不静默丢弃）", () => {
    const mems = [
      mk("n1", "今天天气不错", {}, 1),
      mk("n2", "今天天气挺好", {}, 3),
      mk("n3", "苹果手机电池保养", {}, 5),
    ];
    const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, minCount: 1 };
    const groups = groupByAttribute(mems, cfg, undefined, { minCos: 0.82 });
    expect(groups).toHaveLength(3);
    expect(groups.flatMap((g) => g.memories.map((m) => m.id)).sort()).toEqual(["n1", "n2", "n3"]);
  });

  it("空数组 → 空结果", () => {
    expect(groupByAttribute([], DEFAULT_CONSOLIDATION_CONFIG, undefined, { minCos: 0.82 })).toEqual([]);
  });

  it("单条记录（minCount=1）→ 一组", () => {
    const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, minCount: 1 };
    const groups = groupByAttribute([mk("one", "决定先做前端", { work_object: "x" }, 1)], cfg, undefined, {
      minCos: 0.82,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].memories).toHaveLength(1);
  });

  it("全部 null key + 无 embedding（minCount=1）→ 每条各自成组", () => {
    const mems = [mk("z1", "", {}, 1), mk("z2", "", {}, 3)];
    const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, minCount: 1 };
    const groups = groupByAttribute(mems, cfg, undefined, { minCos: 0.82 });
    expect(groups).toHaveLength(2);
  });

  it("minCos 边界：cos 恰好等于 minCos 归组，低于则不归", () => {
    const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, minCount: 1 };
    const mems = [mk("m1", "无关内容甲", {}, 1), mk("m2", "无关内容乙", {}, 3)];
    // 正交向量 → cos 恰好 0；minCos=0 时应归组（≥ 语义）
    const atBoundary = groupByAttribute(mems, cfg, undefined, {
      minCos: 0,
      vectors: new Map([
        ["m1", vec(1, 0)],
        ["m2", vec(0, 1)],
      ]),
    });
    expect(atBoundary).toHaveLength(1);
    // 反向向量 → cos = -1 < 0，不归组
    const below = groupByAttribute(mems, cfg, undefined, {
      minCos: 0,
      vectors: new Map([
        ["m1", vec(1, 0)],
        ["m2", vec(-1, 0)],
      ]),
    });
    expect(below).toHaveLength(2);
  });

  it("minCos 实用边界：0.84 归组、0.80 不归（minCos=0.82）", () => {
    const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, minCount: 1 };
    const mems = [mk("c1", "无关内容甲", {}, 1), mk("c2", "无关内容乙", {}, 3)];
    const hi = groupByAttribute(mems, cfg, undefined, {
      minCos: 0.82,
      vectors: new Map([
        ["c1", vec(1, 0)],
        ["c2", vec(0.84, Math.sqrt(1 - 0.84 * 0.84))],
      ]),
    });
    expect(hi).toHaveLength(1);
    const lo = groupByAttribute(mems, cfg, undefined, {
      minCos: 0.82,
      vectors: new Map([
        ["c1", vec(1, 0)],
        ["c2", vec(0.8, Math.sqrt(1 - 0.8 * 0.8))],
      ]),
    });
    expect(lo).toHaveLength(2);
  });

  it("防大卡：同键 60 条 → 按 MAX_RECORDS_PER_CARD 均分，不合成一张卡", () => {
    const mems = Array.from({ length: 60 }, (_, i) =>
      mk(`big${i}`, "决定先做前端", { work_object: "td-agemem" }, (i % 20) + 1),
    );
    const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, maxPerRun: 0 };
    const groups = groupByAttribute(mems, cfg, undefined, { minCos: 0.82 });
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const g of groups) expect(g.memories.length).toBeLessThanOrEqual(MAX_RECORDS_PER_CARD);
    expect(groups.reduce((n, g) => n + g.memories.length, 0)).toBe(60);
  });

  it("poolRecordsOf 只返回无法归一属性键的记录", () => {
    const mems = [mk("k1", "决定先做前端", { work_object: "td-agemem" }, 1), mk("p1", "今天天气不错", {}, 2)];
    expect(poolRecordsOf(mems).map((m) => m.id)).toEqual(["p1"]);
  });
});
