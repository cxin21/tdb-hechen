import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { writeMemory } from "./l1-writer.js";
import type { ExtractedMemory, DedupDecision } from "./l1-writer.js";
import type { WritePolicy } from "./write-policy.js";
import { factKeyOf } from "./supersession.js";
import { FACT_ROW_META } from "./fact-row.js";
import { selectByValidity } from "../recall/validity-policy.js";
import { VectorStore } from "../store/sqlite.js";
import { DEFAULT_ISOLATION_ID } from "../store/isolation.js";

/**
 * #146（W2b 事实级双时态，方案 A）写面集成测试——在 writeMemory 的公开 seam 上验证：
 *  - factRows 关：即使抽取器给了三元组也只写一条（逐位现状）；
 *  - factRows 开：一个记忆拆成 N 条事实行（0 号沿用父 id），metadata 带 fact_of/fact_key；
 *  - 失效只按 fact_key 命中同（实体,属性）的旧事实行（单值参与，多值 additive 不参与）；
 *  - 开启后**不再**走整行 invalidateL1/归档——同 turn 兄弟事实不被连坐（本票核心）；
 *  - 后端缺 invalidateL1ByFactKey：不回落整行失效，照样写事实行（loud warn）。
 */

const policy = (over: Partial<WritePolicy> = {}): WritePolicy => ({
  factKey: { enabled: false, separator: " | ", maxFactChars: 240 },
  supersession: { enabled: false },
  ...over,
});

const factPolicy = (enabled = true): WritePolicy =>
  policy({ supersession: { enabled: true }, factRows: { enabled } });

function fakeStore(opts: { withFactKeyInvalidate?: boolean } = {}) {
  const calls = {
    upserted: [] as Array<{ id: string; content: string; metadata?: Record<string, unknown>; valid_start?: string }>,
    invalidated: [] as Array<{ id: string; validEnd: string }>,
    factKeyInvalidations: [] as Array<{ factKey: string; validEnd: string; scope: Record<string, string | undefined> }>,
    archived: [] as string[],
  };
  const store: Record<string, unknown> = {
    queryL1Records: async () => [],
    upsertL1: async (record: { id: string; content: string; metadata?: Record<string, unknown>; valid_start?: string }) => {
      calls.upserted.push({ id: record.id, content: record.content, metadata: record.metadata, valid_start: record.valid_start });
      return true;
    },
    archiveL1: async (id: string) => {
      calls.archived.push(id);
      return true;
    },
    addLink: () => true,
    invalidateL1: async (id: string, validEnd: string) => {
      calls.invalidated.push({ id, validEnd });
      return true;
    },
  };
  if (opts.withFactKeyInvalidate !== false) {
    store.invalidateL1ByFactKey = async (
      scope: Record<string, string | undefined>,
      factKey: string,
      validEnd: string,
    ) => {
      calls.factKeyInvalidations.push({ scope, factKey, validEnd });
      return 1;
    };
  }
  const embedding = {
    embed: async () => new Float32Array([1, 0, 0]),
    getDimensions: () => 3,
    isReady: () => true,
  };
  return { store: store as never, embedding: embedding as never, calls };
}

const TWO_FACTS: Record<string, unknown> = {
  factTriples: [
    { subject: "用户", predicate: "粉丝数", value: "1300", cardinality: "single", phrase: "Instagram 粉丝数涨到 1300" },
    { subject: "用户", predicate: "喜欢", value: "徒步", cardinality: "multi", phrase: "用户喜欢徒步" },
  ],
};

const memory = (metadata: Record<string, unknown> = {}): ExtractedMemory => ({
  content: "用户 Instagram 粉丝数涨到 1300，另外他很喜欢徒步",
  type: "work_fact",
  priority: 60,
  source_message_ids: [],
  metadata: metadata as never,
  scene_name: "bench",
});

const decision = (over: Partial<DedupDecision> = {}): DedupDecision => ({
  record_id: "mem-1",
  action: "store",
  target_ids: [],
  ...over,
});

let baseDir: string;
beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "w146-writer-"));
});
afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

async function runWrite(args: {
  policy?: WritePolicy;
  metadata?: Record<string, unknown>;
  decision?: DedupDecision;
  withFactKeyInvalidate?: boolean;
}) {
  const { store, embedding, calls } = fakeStore({ withFactKeyInvalidate: args.withFactKeyInvalidate });
  const record = await writeMemory({
    memory: memory(args.metadata),
    decision: args.decision ?? decision(),
    baseDir,
    sessionKey: "s::k",
    teamId: "t1",
    userId: "u1",
    agentId: "a1",
    vectorStore: store,
    embeddingService: embedding,
    storage: undefined,
    writePolicy: args.policy,
  });
  return { record, calls };
}

describe("writeMemory 事实级粒度（#146 方案 A）", () => {
  it("factRows 关：有三元组也只写一条记录（逐位现状）", async () => {
    const { calls } = await runWrite({ policy: factPolicy(false), metadata: TWO_FACTS });
    expect(calls.upserted).toHaveLength(1);
    expect(calls.upserted[0].id).toBe("mem-1");
    expect(calls.factKeyInvalidations).toEqual([]);
  });

  it("factRows 开：一个记忆拆成两条事实行，0 号沿用父 id，metadata 可追溯", async () => {
    const { record, calls } = await runWrite({ policy: factPolicy(), metadata: TWO_FACTS });
    expect(calls.upserted.map((u) => u.id)).toEqual(["mem-1", "mem-1#f2"]);
    // ⚠ 设计要点（可用的前提）：行 content 存**父 turn 原文**，不是单条事实短语——
    // 召回打分/BM25/注入的单位是 turn，短语只活在 metadata.fact_phrase（审计/效期）。
    expect(calls.upserted.map((u) => u.content)).toEqual([
      "用户 Instagram 粉丝数涨到 1300，另外他很喜欢徒步",
      "用户 Instagram 粉丝数涨到 1300，另外他很喜欢徒步",
    ]);
    expect(calls.upserted.map((u) => u.metadata?.[FACT_ROW_META.factPhrase])).toEqual([
      "Instagram 粉丝数涨到 1300",
      "用户喜欢徒步",
    ]);
    for (const [i, row] of calls.upserted.entries()) {
      expect(row.metadata?.[FACT_ROW_META.factOf]).toBe("mem-1");
      expect(row.metadata?.[FACT_ROW_META.factIndex]).toBe(i);
      expect(row.valid_start).toBeTruthy();
    }
    expect(calls.upserted[0].metadata?.[FACT_ROW_META.factKey]).toBe(factKeyOf("用户", "粉丝数"));
    expect(calls.upserted[1].metadata?.[FACT_ROW_META.factKey]).toBe(factKeyOf("用户", "喜欢"));
    // 返回父记忆（事实 0 号 id），调用方建记忆图边不悬空
    expect(record?.id).toBe("mem-1");
  });

  it("写时失效只按 fact_key 命中单值事实：多值事实不参与，且不再整行失效/归档", async () => {
    const { calls } = await runWrite({ policy: factPolicy(), metadata: TWO_FACTS });
    expect(calls.factKeyInvalidations).toHaveLength(1);
    expect(calls.factKeyInvalidations[0].factKey).toBe(factKeyOf("用户", "粉丝数"));
    expect(Number.isNaN(Date.parse(calls.factKeyInvalidations[0].validEnd))).toBe(false);
    expect(calls.factKeyInvalidations[0].scope).toEqual({ teamId: "t1", userId: "u1", agentId: "a1" });
    // 关键：整行路径（invalidateL1 / archiveL1）一次都不该被调用
    expect(calls.invalidated).toEqual([]);
    expect(calls.archived).toEqual([]);
  });

  it("update 目标在事实级粒度下不归档（同 turn 兄弟事实不被连坐）", async () => {
    const d = decision({ action: "update", target_ids: ["old-1"], merged_content: "用户粉丝数更新" });
    const { calls } = await runWrite({ policy: factPolicy(), metadata: TWO_FACTS, decision: d });
    expect(calls.archived).toEqual([]);
    expect(calls.invalidated).toEqual([]);
    expect(d.target_ids).toEqual(["old-1"]); // 保留给 l1-extractor 建图边
  });

  it("后端缺 invalidateL1ByFactKey：不回落整行失效，事实行照常落库", async () => {
    const { calls } = await runWrite({
      policy: factPolicy(),
      metadata: TWO_FACTS,
      withFactKeyInvalidate: false,
    });
    expect(calls.upserted).toHaveLength(2);
    expect(calls.invalidated).toEqual([]);
    expect(calls.archived).toEqual([]);
  });

  it("factRows 开但无可用三元组：回退整行写入（零行为变化）", async () => {
    const { calls } = await runWrite({ policy: factPolicy(), metadata: { facts: ["用户喜欢徒步"] } });
    expect(calls.upserted).toHaveLength(1);
    expect(calls.upserted[0].id).toBe("mem-1");
    expect(calls.upserted[0].content).toBe("用户 Instagram 粉丝数涨到 1300，另外他很喜欢徒步");
  });
  it("隔离参数全缺时失效 scope 落到落库默认桶，绝不放成实例级（跨租户 hazard）", async () => {
    const { store, embedding, calls } = fakeStore();
    await writeMemory({
      memory: memory(TWO_FACTS),
      decision: decision(),
      baseDir,
      sessionKey: "s::k",
      vectorStore: store,
      embeddingService: embedding,
      storage: undefined,
      writePolicy: factPolicy(),
    });
    expect(calls.factKeyInvalidations).toHaveLength(1);
    // 三个隔离字段必须是落库口径（DEFAULT_ISOLATION_ID），不能是 undefined——
    // buildIsolationWhere 会跳过 undefined → filter 变实例级 → 按 fact_key 跨租户写 valid_end。
    expect(calls.factKeyInvalidations[0].scope).toEqual({
      teamId: DEFAULT_ISOLATION_ID,
      userId: DEFAULT_ISOLATION_ID,
      agentId: DEFAULT_ISOLATION_ID,
    });
  });
});
describe("事实级写时失效端到端（真实 sqlite）", () => {
  it("第二个 turn 改单值事实：旧事实行 valid_end 落库，同 turn 多值事实行仍 active", async () => {
    const store = new VectorStore(path.join(baseDir, "vectors.db"), 0);
    const initRes = store.init();
    if (store.isDegraded()) throw new Error(`临时库降级：${initRes.reason}`);
    const embedding = {
      embed: async () => new Float32Array([1, 0, 0]),
      getDimensions: () => 3,
      isReady: () => true,
    } as never;

    const write = async (
      id: string,
      factual: Array<{ subject: string; predicate: string; value: string; cardinality: string; phrase: string }>,
      at?: string,
    ) =>
      writeMemory({
        memory: { ...memory({ factTriples: factual }), ...(at ? { occurred_at: at, valid_start: at } : {}) },
        decision: decision({ record_id: id }),
        baseDir,
        sessionKey: "s::k",
        teamId: "t1",
        userId: "u1",
        agentId: "a1",
        vectorStore: store as never,
        embeddingService: embedding,
        storage: undefined,
        writePolicy: factPolicy(),
      });

    await write(
      "mem-1",
      [
        { subject: "用户", predicate: "粉丝数", value: "1000", cardinality: "single", phrase: "Instagram 粉丝数 1000" },
        { subject: "用户", predicate: "喜欢", value: "徒步", cardinality: "multi", phrase: "用户喜欢徒步" },
      ],
      "2026-03-02T09:12:00.000Z",
    );
    await write(
      "mem-2",
      [{ subject: "用户", predicate: "粉丝数", value: "1300", cardinality: "single", phrase: "Instagram 粉丝数涨到 1300" }],
      "2026-04-11T19:40:00.000Z",
    );

    const rows = (
      store as unknown as {
        queryL1Records: () => Array<{ record_id: string; valid_end: string | null; valid_start?: string; content: string; metadata_json?: string }>;
      }
    ).queryL1Records();
    const byId = new Map(rows.map((r) => [r.record_id, r]));
    expect(byId.get("mem-1")?.valid_end).toBeTruthy();
    expect(byId.get("mem-2")?.valid_end == null || byId.get("mem-2")?.valid_end === "").toBe(true);
    // 同 turn 的多值兄弟事实不被连坐（旧值可追溯、不删除）
    expect(byId.get("mem-1#f2")).toBeTruthy();
    expect(byId.get("mem-1#f2")?.valid_end == null || byId.get("mem-1#f2")?.valid_end === "").toBe(true);
    // 事实短语在被失效的那一行 metadata 里仍可追溯（content 是父 turn 原文，两行同形）
    expect(byId.get("mem-1")?.content).toBe("用户 Instagram 粉丝数涨到 1300，另外他很喜欢徒步");
    const oldMeta = JSON.parse(String(byId.get("mem-1")?.metadata_json ?? "{}")) as Record<string, unknown>;
    expect(oldMeta[FACT_ROW_META.factPhrase]).toBe("Instagram 粉丝数 1000");
    // 区间必须首尾相接：旧行 valid_end = 新事实有效起点（不是写时刻），否则读侧
    // 「问当下 + 被取代」的硬丢判据（candidate.valid_start >= item.valid_end）永远不成立。
    expect(byId.get("mem-1")?.valid_end).toBe("2026-04-11T19:40:00.000Z");
    expect(byId.get("mem-2")?.valid_start).toBe("2026-04-11T19:40:00.000Z");
    // 读侧联动：问当下硬丢旧值，问历史仍可召回（soft 效期，#136 同一谓词）。
    const items = rows.map((r) => ({ ...r, fact_key: "" }));
    const present = selectByValidity(items, {
      now: new Date("2026-05-01T00:00:00.000Z"),
      mode: "soft",
      presentIntent: true,
      hardOnPresentIntent: true,
    });
    expect(present.dropped.map((r) => r.record_id)).toEqual(["mem-1"]);
    const history = selectByValidity(items, { now: new Date("2026-05-01T00:00:00.000Z"), mode: "soft", presentIntent: false });
    expect(history.kept.map((r) => r.record_id)).toContain("mem-1");
    store.close?.();
  });
});