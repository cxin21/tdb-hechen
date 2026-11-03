/**
 * 幽灵 #N 卡回收（A，2026-11-03）。
 *
 * 病灶：grouping.ts:312-318 组缩容时只产出 base / #2 两个组，#3 卡（上轮 110 条切 3 段时落库）
 * 不再被 existingDurativeOf 命中，也没人写 valid_end —— 读侧持续注入过期摘要。
 *
 * 合同：
 *  ① 组缩容 110→60 后，#3 失效（写 valid_end，不 DELETE 行），#1/#2 仍在；
 *  ② 幂等：重跑不重复写（首次失效时间权威）；
 *  ③ 只回收「同一 base 组」的分段卡，不跨组误伤；
 *  ④ 本轮 group 列表被 maxPerRun 截断时不得回收（可能只是"本轮没轮到"，不是缩容）。
 */
import { describe, expect, it } from "vitest";
import { runConsolidation } from "../consolidation-worker.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

const DUR = '{"content":"持续态摘要","certainty":"observed"}';
const T0 = Date.parse("2026-08-01T00:00:00.000Z");

function src(id: string, workObject: string, content: string, dayOffset: number): MemoryRecord {
  const ts = new Date(T0 + dayOffset * 86_400_000).toISOString();
  return {
    id,
    content,
    type: "episodic",
    priority: 60,
    scene_name: "s",
    source_message_ids: [],
    metadata: {
      subject: workObject,
      work_object: workObject,
      occurred_at: ts,
    } as unknown as MemoryRecord["metadata"],
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    version: 1,
    sessionKey: "s",
    sessionId: "s",
    occurred_at: ts,
    certainty: "observed",
    significance: 0.6,
    teamId: "t1",
    userId: "u1",
    agentId: "a1",
  } as unknown as MemoryRecord;
}

/** 110 条同属性（td|decision）→ 3 段；缩到 60 条 → 2 段，旧 #3 成幽灵。 */
const mainSources = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    src(`m-${String(i).padStart(3, "0")}`, "td", `决定推进主线第${i}步：保持现状`, i),
  );

/** 旁路组（other|tooling）本轮不缩容：它的 #1/#2 不得被主组的回收误伤。 */
const otherSources = Array.from({ length: 55 }, (_, i) =>
  src(`o-${String(i).padStart(3, "0")}`, "other", `改用工具链第${i}版：保持现状`, i),
);

function makeStore() {
  const rows: MemoryRecord[] = [];
  const invalidations: Array<{ id: string; validEnd: string }> = [];
  const store = {
    upsertL1: (rec: MemoryRecord) => {
      const i = rows.findIndex((r) => r.id === rec.id);
      if (i >= 0) rows[i] = rec;
      else rows.push(rec);
      return true;
    },
    addLink: async () => true,
    // 与 sqlite.ts:4611 同语义：只失效开区间行，已失效不覆盖（首次失效时间权威）。
    invalidateL1: (id: string, validEndIso: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row || row.valid_end) return false;
      row.valid_end = validEndIso;
      invalidations.push({ id, validEnd: validEndIso });
      return true;
    },
  };
  return { store, rows, invalidations };
}

const cardsOf = (rows: MemoryRecord[]) => rows.filter((r) => r.type === "work_fact" && r.scene_name === "consolidated");
const metaOf = (rec: MemoryRecord): Record<string, unknown> => (rec.metadata ?? {}) as Record<string, unknown>;
const byAttributeKey = (rows: MemoryRecord[]) =>
  new Map(cardsOf(rows).map((r) => [String(metaOf(r).attribute_key ?? ""), r] as const));

function makeDeps(state: { current: MemoryRecord[] }, store: unknown, extra: Record<string, unknown> = {}) {
  return {
    queryL1: async () => state.current,
    llmRunner: { run: async () => DUR },
    config: {
      enabled: true,
      minCount: 3,
      minSpanDays: 1,
      persist: true,
      subjectStrategy: "lexical",
      attributeGrouping: { enabled: true, minCos: 0.82, maxPoolEmbeds: 0 },
      ...extra,
    } as never,
    store: store as never,
    embeddingService: null as never,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  } as never;
}

describe("A · 幽灵 #N 卡回收（组缩容 110→60）", () => {
  it("110 条切 3 段落 3 张卡；缩到 60 条后 #3 失效、#1/#2 仍开区间", async () => {
    const state = { current: [...mainSources(110), ...otherSources] };
    const { store, rows, invalidations } = makeStore();
    const deps = makeDeps(state, store);

    const first = await runConsolidation(deps as never);
    expect(first.persisted).toBe(5);
    const before = byAttributeKey(rows);
    expect([...before.keys()].sort()).toEqual([
      "other|tooling",
      "other|tooling#2",
      "td|decision",
      "td|decision#2",
      "td|decision#3",
    ]);
    for (const card of cardsOf(rows)) expect(card.valid_end ?? "").toBe("");

    // 组缩容：源记忆只剩前 60 条；已落库的卡仍在 queryL1 里（真实链路）。
    state.current = [...mainSources(60), ...otherSources, ...cardsOf(rows)];
    const second = await runConsolidation(deps as never);

    const after = byAttributeKey(rows);
    expect(after.get("td|decision")!.valid_end ?? "").toBe("");
    expect(after.get("td|decision#2")!.valid_end ?? "").toBe("");
    expect(after.get("td|decision#3")!.valid_end).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 旁路组不缩容 → 不误伤
    expect(after.get("other|tooling")!.valid_end ?? "").toBe("");
    expect(after.get("other|tooling#2")!.valid_end ?? "").toBe("");
    expect(invalidations.map((i) => i.id)).toEqual([after.get("td|decision#3")!.id]);
    expect(second.reclaimed).toBe(1);
  });

  it("幂等：同缩容状态重跑不再写 valid_end（首次失效时间权威）", async () => {
    const state = { current: [...mainSources(110), ...otherSources] };
    const { store, rows, invalidations } = makeStore();
    const deps = makeDeps(state, store);
    await runConsolidation(deps as never);

    state.current = [...mainSources(60), ...otherSources, ...cardsOf(rows)];
    await runConsolidation(deps as never);
    const ghost = byAttributeKey(rows).get("td|decision#3")!;
    const firstInvalidEnd = ghost.valid_end;
    expect(firstInvalidEnd).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    state.current = [...mainSources(60), ...otherSources, ...cardsOf(rows)];
    const third = await runConsolidation(deps as never);
    expect(third.reclaimed ?? 0).toBe(0);
    expect(invalidations).toHaveLength(1);
    expect(byAttributeKey(rows).get("td|decision#3")!.valid_end).toBe(firstInvalidEnd);
  });

  it("本轮 group 列表被 maxPerRun 截断时不回收（可能只是本轮没轮到）", async () => {
    const ghost: MemoryRecord = {
      ...src("ghost-3", "td", "决定历史摘要", 0),
      id: "ghost-3",
      type: "work_fact",
      scene_name: "consolidated",
      priority: 80,
      metadata: {
        subject: "td|decision#3",
        attribute_key: "td|decision#3",
        source_fingerprint: "stale",
      } as unknown as MemoryRecord["metadata"],
    } as MemoryRecord;
    const state = { current: [...mainSources(110), ghost] };
    const { store, rows, invalidations } = makeStore();
    rows.push(ghost);
    const deps = makeDeps(state, store, { maxPerRun: 2 });

    const result = await runConsolidation(deps as never);
    expect(result.groupsFound).toBe(2);
    expect(result.reclaimed ?? 0).toBe(0);
    expect(invalidations).toHaveLength(0);
    expect(byAttributeKey(rows).get("td|decision#3")!.valid_end ?? "").toBe("");
  });
});
