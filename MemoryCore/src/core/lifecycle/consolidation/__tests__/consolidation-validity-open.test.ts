/**
 * F1（2026-11-02，BLOCKER）：L3 巩固卡写出来就不可召回。
 *
 * 病灶：summarizer 把持续态的 valid_end 写成「组内最新时间」（summarizer.ts:104），
 * worker 原样落库（consolidation-worker.ts:199）；读侧 hard 模式
 * （excludeInvalidated=true）用 shouldHardDropValidity 把 expired 行直接 continue
 * （auto-recall.ts:1211/:1352/:4604）——生产 30/30 张卡 valid_end 全在过去，
 * 词面能命中 FTS、结论层却永远选不到。
 *
 * 合同：持续态是「开区间」——valid_end 留空（有效至今），活动窗口末只进
 * metadata.activity_end_time（审计/段事件展示仍可用）。存量 30 行一次性修正
 * 由 Lead 的迁移脚本完成，不在本用例内。
 */
import { describe, expect, it } from "vitest";
import { runConsolidation } from "../consolidation-worker.js";
import { buildDurativeSummary } from "../summarizer.js";
import { shouldHardDropValidity } from "../../../recall/validity-policy.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

const DUR = '{"content":"持续态摘要（开区间）","certainty":"observed"}';

function src(id: string, content: string, day: number): MemoryRecord {
  const ts = `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  return {
    id,
    content,
    type: "episodic",
    priority: 60,
    scene_name: "s",
    source_message_ids: [],
    metadata: { subject: "定案", work_object: "td-agemem" } as unknown as MemoryRecord["metadata"],
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

const sources = [src("r1", "决定先做前端", 1), src("r2", "拍板：先做前端", 2), src("r3", "决定收口留证", 3)];

function makeStore() {
  const rows: MemoryRecord[] = [];
  return {
    rows,
    store: {
      upsertL1: (rec: MemoryRecord) => {
        const i = rows.findIndex((r) => r.id === rec.id);
        if (i >= 0) rows[i] = rec;
        else rows.push(rec);
        return true;
      },
      addLink: async () => true,
    },
  };
}

const cardsOf = (rows: MemoryRecord[]) => rows.filter((r) => r.type === "work_fact" && r.scene_name === "consolidated");
const metaOf = (rec: MemoryRecord): Record<string, unknown> => (rec.metadata ?? {}) as Record<string, unknown>;

function makeDeps(state: { current: MemoryRecord[] }, store: unknown) {
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
    } as never,
    store: store as never,
    embeddingService: null as never,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  } as never;
}

describe("F1 · L3 持续态是开区间（valid_end 留空）", () => {
  it("summarizer 不再把 valid_end 写成组内最新时间，活动窗口末进 activity_end_at", async () => {
    const group = {
      subject: "定案",
      memories: sources,
      latestTs: Date.parse("2026-10-03T00:00:00.000Z"),
      earliestTs: Date.parse("2026-10-01T00:00:00.000Z"),
    };
    const dur = await buildDurativeSummary(group as never, {
      llmRunner: { run: async () => DUR } as never,
    });
    expect(dur).not.toBeNull();
    // 开区间：没有 valid_end（undefined 或缺失），活动窗口末单独保留
    // DurativeRecord 已删 valid_end 字段：用索引访问钉「字段不存在或为 undefined」
    expect((dur as unknown as Record<string, unknown>).valid_end).toBeUndefined();
    expect(dur!.activity_end_at).toBe("2026-10-03T00:00:00.000Z");
  });

  it("落库卡 valid_end 为空、activity_end_time 保留窗口末", async () => {
    const state = { current: [...sources] };
    const { store, rows } = makeStore();
    const card = await runConsolidation(makeDeps(state, store) as never);
    expect(card.persisted).toBe(1);
    const [rec] = cardsOf(rows);
    expect(rec.valid_end ?? undefined).toBeUndefined();
    expect(metaOf(rec).activity_end_time).toBe("2026-10-03T00:00:00.000Z");
  });

  it("开区间卡在 hard 模式（excludeInvalidated=true）不被硬丢", async () => {
    const state = { current: [...sources] };
    const { store, rows } = makeStore();
    await runConsolidation(makeDeps(state, store) as never);
    const [rec] = cardsOf(rows);
    const now = new Date("2026-11-02T09:00:00.000Z");
    expect(
      shouldHardDropValidity({ valid_start: rec.valid_start, valid_end: rec.valid_end ?? null }, now, "hard"),
    ).toBe(false);
  });

  it("对照：valid_end 在过去时 hard 模式必丢（证明上面的用例不是空转）", () => {
    const now = new Date("2026-11-02T09:00:00.000Z");
    expect(
      shouldHardDropValidity(
        { valid_start: "2026-10-01T00:00:00.000Z", valid_end: "2026-11-02T07:24:42.816Z" },
        now,
        "hard",
      ),
    ).toBe(true);
  });
});
