/**
 * B1 修正（2026-11-02）：巩固层池内 embedding 的配额合同。
 *
 * 生产事故（一手证据）：池内记录逐条 await embed() → 3861 行库 / 1903 行进池，
 * 88 次 429/分钟、lifecycle tick 互斥锁被占 10+ 分钟不结束、L1 写入与召回全线降级。
 * 合同：①优先复用 l1_vec 已入库向量；②只对真正缺失的做有上限补齐；③读向量失败则本次零补齐。
 */
import { describe, expect, it, vi } from "vitest";
import { runConsolidation } from "../consolidation-worker.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

const DURATIVE_JSON = '{"content":"用户常在周末出门拍照","certainty":"observed"}';

function poolRecord(id: string, i: number): MemoryRecord {
  const ts = `2026-10-${String(1 + (i % 9)).padStart(2, "0")}T00:00:00.000Z`;
  return {
    id,
    // 词表外内容 → deriveAttributeKey 返回 null → 进 embedding 池
    content: `周末去爬山拍照（第${i}次）`,
    type: "episodic",
    priority: 60,
    scene_name: "s",
    source_message_ids: [],
    metadata: { subject: "随想" } as unknown as MemoryRecord["metadata"],
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

function vec(seed: number): Float32Array {
  return new Float32Array([1, seed, 0.5, 0.25]);
}

/** 只数"池内记录"的补齐调用——产物持续态也会 embed（R1 源头嵌入），不能混算。 */
function poolEmbedCalls(embed: { mock: { calls: unknown[][] } }): unknown[][] {
  return embed.mock.calls.filter((c) => String(c[0]).includes("爬山"));
}

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

function makeDeps(opts: {
  records: MemoryRecord[];
  store: unknown;
  config?: Record<string, unknown>;
  loadVectors?: (ids: string[]) => Promise<Map<string, Float32Array>> | Map<string, Float32Array>;
  embed?: (t: string) => Promise<Float32Array>;
}) {
  return {
    queryL1: async () => opts.records,
    llmRunner: { run: async () => DURATIVE_JSON } as never,
    config: {
      enabled: true,
      minCount: 2,
      minSpanDays: 1,
      persist: true,
      attributeGrouping: { enabled: true, minCos: 0.82 },
      ...(opts.config ?? {}),
    } as never,
    store: opts.store as never,
    embeddingService: opts.embed ? ({ embed: opts.embed } as never) : null,
    loadVectors: opts.loadVectors as never,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  } as never;
}

describe("B1 修正：池内 embedding 复用与上限", () => {
  it("库里有向量 → 零 embed 调用，且按全部池 id 批量取（不再重嵌全表）", async () => {
    const { store } = makeStore();
    const records = [poolRecord("p1", 1), poolRecord("p2", 2), poolRecord("p3", 3)];
    const loadVectors = vi.fn(async (ids: string[]) => {
      const m = new Map<string, Float32Array>();
      for (const id of ids) m.set(id, vec(1));
      return m;
    });
    const embed = vi.fn(async () => vec(1));
    await runConsolidation(makeDeps({ records, store, loadVectors, embed }));

    expect(loadVectors).toHaveBeenCalledTimes(1);
    expect((loadVectors.mock.calls[0][0] as string[]).sort()).toEqual(["p1", "p2", "p3"]);
    expect(poolEmbedCalls(embed)).toHaveLength(0);
  });

  it("只补真正缺失的向量（有向量的一条不重嵌）", async () => {
    const { store } = makeStore();
    const records = [poolRecord("p1", 1), poolRecord("p2", 2), poolRecord("p3", 3)];
    const loadVectors = async (ids: string[]) => {
      const m = new Map<string, Float32Array>();
      for (const id of ids) if (id !== "p2") m.set(id, vec(1));
      return m;
    };
    const embed = vi.fn(async () => vec(1));
    await runConsolidation(makeDeps({ records, store, loadVectors, embed }));

    const poolCalls = poolEmbedCalls(embed);
    expect(poolCalls).toHaveLength(1);
    expect(String(poolCalls[0][0])).toContain("第2次");
  });

  it("单轮补齐不超过 maxPoolEmbeds（超出的本轮按单条成组，下轮再补）", async () => {
    const { store } = makeStore();
    const records = Array.from({ length: 8 }, (_, i) => poolRecord(`p${i}`, i + 1));
    const embed = vi.fn(async () => vec(1));
    await runConsolidation(
      makeDeps({
        records,
        store,
        loadVectors: async () => new Map(),
        embed,
        config: { attributeGrouping: { enabled: true, minCos: 0.82, maxPoolEmbeds: 3 } },
      }),
    );

    expect(poolEmbedCalls(embed)).toHaveLength(3);
  });

  it("未配 maxPoolEmbeds → 缺省上限 64（不是无上限）", async () => {
    const { store } = makeStore();
    const records = Array.from({ length: 70 }, (_, i) => poolRecord(`p${i}`, i + 1));
    const embed = vi.fn(async () => vec(1));
    await runConsolidation(makeDeps({ records, store, embed }));

    expect(poolEmbedCalls(embed)).toHaveLength(64);
  });

  it("loadVectors 抛错 → 本次零补齐且不抛出（宁可单条成组，不再撞配额）", async () => {
    const { store } = makeStore();
    const records = [poolRecord("p1", 1), poolRecord("p2", 2)];
    const embed = vi.fn(async () => vec(1));
    const res = await runConsolidation(
      makeDeps({
        records,
        store,
        loadVectors: async () => {
          throw new Error("vec read boom");
        },
        embed,
      }),
    );

    expect(poolEmbedCalls(embed)).toHaveLength(0);
    expect(res.groupsFound).toBe(0);
  });

  it("maxPoolEmbeds=0 → 完全关闭补齐（全池按单条成组）", async () => {
    const { store } = makeStore();
    const records = [poolRecord("p1", 1), poolRecord("p2", 2)];
    const embed = vi.fn(async () => vec(1));
    await runConsolidation(
      makeDeps({
        records,
        store,
        embed,
        config: { attributeGrouping: { enabled: true, minCos: 0.82, maxPoolEmbeds: 0 } },
      }),
    );

    expect(poolEmbedCalls(embed)).toHaveLength(0);
  });
});
