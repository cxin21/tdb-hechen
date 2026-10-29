/**
 * #146 事实级双时态 bench 写面单测：
 *  - facts.mjs 的 cardinality 抽取口径（facts-v3 提示词新增字段）；
 *  - store.mjs 的事实行规划（id/content/metadata 与生产 l1-writer 同形）；
 *  - ingestCase 的「一条事实一行」写入：single 行写前按 fact_key 失效、multi 行不失效、
 *    无三元组 turn 回退整行、contentIndex 把每条事实行映射回父 turn（度量口径不崩）。
 *
 * 断言只碰 bench 侧 API；src/core/record/fact-row.ts 是只读契约（由 Lead 实现）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeFactCardinality } from "../scripts/lib/bench/facts.mjs";
import { VectorStore } from "../src/core/store/sqlite.js";
import {
  buildFactRowRecords,
  ingestCase,
  normalizeWritePolicy,
  turnFactRowContent,
} from "../scripts/lib/bench/store.mjs";

const caseObj = (caseId = "case-1") => ({
  caseId,
  tenant: { user_id: "u", team_id: "t", agent_id: "a" },
  questionDateISO: "2026-01-01T00:00:00Z",
  groups: [
    {
      sessionId: "s1",
      turns: [
        {
          id: "t1",
          role: "user",
          speaker: "user",
          text: "I live in Berlin and I like tea.",
          tsISO: "2025-12-30T08:00:00Z",
        },
        {
          id: "t2",
          role: "assistant",
          speaker: "assistant",
          text: "Noted.",
          tsISO: "2025-12-30T08:01:00Z",
        },
      ],
    },
  ],
});

const turnOf = (c, id) => c.groups.flatMap((g) => g.turns).find((t) => t.id === id);

// 假 store：只实现 ingestCase 用到的两个方法，记录调用顺序（断言「先失效、后写新行」）。
function makeFakeStore(overrides = {}) {
  const calls = [];
  const upserted = [];
  const invalidated = [];
  const store = {
    async invalidateL1ByFactKey(filter, factKey, validEndIso) {
      calls.push({ kind: "invalidate", filter, factKey, validEndIso });
      invalidated.push({ filter, factKey, validEndIso });
      return overrides.invalidatedCount ?? 1;
    },
    async upsertL1(record, vector) {
      calls.push({ kind: "upsert", id: record.id });
      upserted.push({ record, vector });
      return true;
    },
  };
  if (overrides.noInvalidate) delete store.invalidateL1ByFactKey;
  return { store, calls, upserted, invalidated };
}

// 真库（sqlite vec0）要求 Float32Array：普通数组会在 Buffer.from(embedding.buffer) 处抛
// "The first argument must be of type string or Buffer ... Received undefined"——upsertL1 会
// 吞掉异常只回 false（无 logger 时静默），写库数为 0。假 store 不校验，故统一用 Float32Array。
const fakeEmbedding = {
  async embedBatch(texts) {
    return texts.map((_, i) => new Float32Array([1 + i, 0.5, 0.25]));
  },
};

describe("#146 facts-v3 cardinality 抽取口径", () => {
  it("只认 single/multi（大小写与空白归一），其余一律清成未给", () => {
    expect(normalizeFactCardinality("single")).toBe("single");
    expect(normalizeFactCardinality(" MULTI ")).toBe("multi");
    expect(normalizeFactCardinality("Single")).toBe("single");
    for (const bad of ["", "  ", "dual", "both", 1, true, null, undefined, {}]) {
      expect(normalizeFactCardinality(bad)).toBeUndefined();
    }
  });
});

describe("#146 事实行规划（一条事实一行）", () => {
  it("id/content/metadata 与生产同形：父 turn id 保留给首条，后续 #f<n>", async () => {
    const c = caseObj();
    const turn = turnOf(c, "t1");
    const plan = await buildFactRowRecords({
      caseObj: c,
      turn,
      sessionId: "s1",
      turnFacts: {
        triples: [
          { subject: "User", predicate: "city", value: "Berlin", phrase: "lives in Berlin", cardinality: "single" },
          { subject: "User", predicate: "likes", value: "tea", phrase: "likes tea", cardinality: "multi" },
        ],
      },
    });
    expect(plan.hasFacts).toBe(true);
    expect(plan.rows.map((r) => r.record.id)).toEqual(["t1", "t1#f2"]);
    // 前缀与 turnContent 同口径：时间（T 换空格）+ 说话人 + 单条事实短语
    expect(plan.rows[0].record.content).toBe("[2025-12-30 08:00:00Z] user: lives in Berlin");
    expect(plan.rows[1].record.content).toBe("[2025-12-30 08:00:00Z] user: likes tea");
    const md0 = plan.rows[0].record.metadata;
    expect(md0.fact_of).toBe("t1");
    expect(md0.fact_index).toBe(0);
    expect(md0.subject).toBe("User");
    expect(md0.predicate).toBe("city");
    expect(md0.cardinality).toBe("single");
    expect(typeof md0.fact_key).toBe("string");
    expect(md0.fact_key.length).toBeGreaterThan(0);
    // 同实体不同属性 -> 不同 fact_key（失效粒度是（实体，属性））
    expect(plan.rows[1].record.metadata.fact_key).not.toBe(md0.fact_key);
    expect(plan.rows[0].spec.cardinality).toBe("single");
    expect(plan.rows[1].spec.cardinality).toBe("multi");
    // 双时态：valid_start 沿用父 turn 的时刻（bench 是历史回放）
    expect(plan.rows[0].record.valid_start).toBe("2025-12-30T08:00:00Z");
    expect(plan.rows[0].record.metadata.valid_start).toBe("2025-12-30T08:00:00Z");
  });

  it("同（实体，属性）单值只留首见事实，其余计入 dropped", async () => {
    const c = caseObj();
    const turn = turnOf(c, "t1");
    const plan = await buildFactRowRecords({
      caseObj: c,
      turn,
      turnFacts: {
        triples: [
          { subject: "User", predicate: "city", value: "Berlin", cardinality: "single", phrase: "lives in Berlin" },
          { subject: "User", predicate: "city", value: "Munich", cardinality: "single", phrase: "lives in Munich" },
        ],
      },
    });
    expect(plan.rows).toHaveLength(1);
    expect(plan.dropped).toBe(1);
    expect(plan.rows[0].record.content).toBe("[2025-12-30 08:00:00Z] user: lives in Berlin");
  });

  it("同（实体，属性）多值不同值都进库（去重键含 value）", async () => {
    const c = caseObj();
    const turn = turnOf(c, "t1");
    const plan = await buildFactRowRecords({
      caseObj: c,
      turn,
      turnFacts: {
        triples: [
          { subject: "User", predicate: "hobby", value: "hiking", cardinality: "multi", phrase: "likes hiking" },
          { subject: "User", predicate: "hobby", value: "photography", cardinality: "multi", phrase: "likes photography" },
        ],
      },
    });
    expect(plan.hasFacts).toBe(true);
    expect(plan.rows.map((r) => r.spec.value)).toEqual(["hiking", "photography"]);
    expect(plan.dropped).toBe(0);
  });

  it("无可用三元组 -> hasFacts=false（调用方回退整行，绝不丢这一轮）", async () => {
    const c = caseObj();
    const plan = await buildFactRowRecords({ caseObj: c, turn: turnOf(c, "t1"), turnFacts: { triples: [] } });
    expect(plan.hasFacts).toBe(false);
    expect(plan.rows).toEqual([]);
    expect(await buildFactRowRecords({ caseObj: c, turn: turnOf(c, "t1") })).toMatchObject({ hasFacts: false });
  });

  it("无 tsISO 时时间前缀回退题目日期（与 turnContent 一致）", () => {
    const c = caseObj();
    const turn = { ...turnOf(c, "t1"), tsISO: undefined };
    expect(turnFactRowContent(c, turn, "likes tea")).toBe("[2026-01-01 00:00:00Z] user: likes tea");
  });
});

describe("#146 写入策略互斥（不做静默降级）", () => {
  const facts = { byTurn: { t1: { triples: [] } } };

  it("factRows 缺 facts 报错（与另外三档同一校验）", () => {
    expect(() => normalizeWritePolicy({ factRows: true })).toThrow(/需要 facts/);
  });

  it("与 dualWrite / supersede / factChannel 同开各自显式报错", () => {
    expect(() => normalizeWritePolicy({ factRows: true, dualWrite: true }, { facts })).toThrow(/factRows 与 dualWrite 互斥/);
    expect(() => normalizeWritePolicy({ factRows: true, supersede: true }, { facts })).toThrow(/factRows 与 supersede 互斥/);
    expect(() => normalizeWritePolicy({ factRows: true, factChannel: true }, { facts })).toThrow(/factRows 与 factChannel/);
  });

  it("enabled=false 等于没开（可显式回退控制档）", () => {
    expect(normalizeWritePolicy({ factRows: false }, { facts }).factRows).toBeNull();
    expect(normalizeWritePolicy({ factRows: { enabled: false } }, { facts }).factRows).toBeNull();
    expect(normalizeWritePolicy({ factRows: true }, { facts }).factRows).toEqual({ enabled: true });
    // supersede 缺省仍需 cardinalityGate 缺省开（#136 语义不变）
    expect(normalizeWritePolicy({}, { facts }).cardinalityGate).toBe(true);
  });
});

describe("#146 ingestCase 事实行写入", () => {
  const t1Facts = {
    triples: [
      { subject: "User", predicate: "city", value: "Berlin", phrase: "lives in Berlin", cardinality: "single" },
      { subject: "User", predicate: "likes", value: "tea", phrase: "likes tea", cardinality: "multi" },
    ],
  };

  it("有事实的 turn 只写事实行；single 先失效后写、multi 不失效；contentIndex 回填父 turn", async () => {
    const c = caseObj();
    const { store, calls, upserted, invalidated } = makeFakeStore({ invalidatedCount: 2 });
    const contentIndex = new Map();
    const stats = await ingestCase({
      caseObj: c,
      store,
      embedding: fakeEmbedding,
      contentIndex,
      opts: {
        embedMinIntervalMs: 0,
        facts: { byTurn: { t1: t1Facts, t2: { triples: [] } } },
        writePolicy: { factRows: true },
      },
    });

    // t1 -> 两条事实行；t2（无三元组）回退整行。父行 t1 不写。
    expect(upserted.map((u) => u.record.id)).toEqual(["t1", "t1#f2", "t2"]);
    expect(stats.factRows).toBe(2); // 只有 t1 的两条事实行计入；t2 回退整行不算
    expect(stats.factRowTurns).toBe(1);
    expect(stats.written).toBe(3);
    expect(stats.factRowInvalidateOps).toBe(1);
    expect(stats.factRowsInvalidated).toBe(2);

    // 顺序契约：失效调用在任何 upsert 之前（生产 l1-writer 同序）
    expect(calls[0].kind).toBe("invalidate");
    expect(calls.filter((x) => x.kind === "invalidate")).toHaveLength(1);

    // 失效按（tenant 过滤 + fact_key）定位，时刻 = 该 turn 的 valid_start（不用 now）
    const inv = invalidated[0];
    expect(inv.filter).toEqual({ teamId: "t", userId: "u", agentId: "a" });
    expect(inv.factKey).toBe(upserted[0].record.metadata.fact_key);
    expect(upserted[0].record.metadata.cardinality).toBe("single");
    expect(inv.validEndIso).toBe("2025-12-30T08:00:00Z");
    // multi 行不产生失效调用（唯一一次是 single 行）
    expect(upserted[1].record.metadata.cardinality).toBe("multi");

    // 度量口径：每条事实行与回退整行都能解析回父 turn id
    for (const u of upserted) {
      const head = u.record.content.replace(/\s+/g, " ").trim();
      expect(contentIndex.get(head)).toBe(u.record.id.startsWith("t1") ? "t1" : "t2");
    }
  });

  it("同键 single 事实跨 turn 时按 turn 时刻逐次失效（Berlin -> Munich）", async () => {
    const c = caseObj();
    c.groups[0].turns.push({
      id: "t3",
      role: "user",
      speaker: "user",
      text: "I moved to Munich.",
      tsISO: "2025-12-31T09:00:00Z",
    });
    const { store, invalidated } = makeFakeStore({ invalidatedCount: 0 });
    const stats = await ingestCase({
      caseObj: c,
      store,
      embedding: fakeEmbedding,
      contentIndex: new Map(),
      opts: {
        embedMinIntervalMs: 0,
        facts: {
          byTurn: {
            t1: { triples: [{ subject: "User", predicate: "city", value: "Berlin", phrase: "lives in Berlin", cardinality: "single" }] },
            t3: { triples: [{ subject: "User", predicate: "city", value: "Munich", phrase: "lives in Munich", cardinality: "single" }] },
          },
        },
        writePolicy: { factRows: true },
      },
    });
    // 两次 single 写入 -> 两次失效，且 fact_key 同键、时刻各用自己的 turn
    expect(stats.factRowInvalidateOps).toBe(2);
    expect(invalidated).toHaveLength(2);
    expect(invalidated[0].factKey).toBe(invalidated[1].factKey);
    expect(invalidated.map((x) => x.validEndIso)).toEqual(["2025-12-30T08:00:00Z", "2025-12-31T09:00:00Z"]);
  });

  it("store 不支持 invalidateL1ByFactKey 时只告警一次，事实行照写（不静默等同控制档）", async () => {
    const c = caseObj();
    const { store, upserted } = makeFakeStore({ noInvalidate: true });
    const stats = await ingestCase({
      caseObj: c,
      store,
      embedding: fakeEmbedding,
      contentIndex: new Map(),
      opts: {
        embedMinIntervalMs: 0,
        facts: { byTurn: { t1: t1Facts } },
        writePolicy: { factRows: true },
      },
    });
    expect(upserted).toHaveLength(3);
    expect(stats.factRowInvalidateUnsupported).toBe(true);
    expect(stats.factRowInvalidateOps).toBe(1);
    expect(stats.written).toBe(3);
  });

  it("不开 factRows 时逐位现状（每 turn 一行，不失效）", async () => {
    const c = caseObj();
    const { store, invalidated, upserted } = makeFakeStore();
    const stats = await ingestCase({
      caseObj: c,
      store,
      embedding: fakeEmbedding,
      contentIndex: new Map(),
      opts: { embedMinIntervalMs: 0, facts: { byTurn: { t1: t1Facts } } },
    });
    expect(upserted.map((u) => u.record.id)).toEqual(["t1", "t2"]);
    expect(invalidated).toHaveLength(0);
    expect(stats.factRows).toBeUndefined();
    expect(stats.written).toBe(2);
  });
});

// ── 真库落地（src/core/store/sqlite.ts 只读复用）：验证 bench 写的行形状真的能被
// invalidateL1ByFactKey 命中——假 store 只能验调用序，验不了 metadata.fact_key 的落库形状。
describe("#146 真库落地：事实级失效只命中同键旧行", () => {
  it("Berlin -> Munich：旧城市行置 valid_end，兄弟 multi 行与无事实行保持 active", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-fact-rows-store-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 3);
    try {
      const initRes = store.init();
      if (store.isDegraded()) {
        // 环境缺 sqlite 扩展等：降级库不可测，跳过（CI 环境问题，不是断言失败）
        console.warn("[bench-fact-rows] 临时库降级，跳过真库用例：" + initRes.reason);
        return;
      }
      const c = caseObj("case-store");
      c.groups[0].turns.push({
        id: "t3",
        role: "user",
        speaker: "user",
        text: "I moved to Munich and still like tea.",
        tsISO: "2025-12-31T09:00:00Z",
      });
      const contentIndex = new Map();
      const stats = await ingestCase({
        caseObj: c,
        store,
        embedding: fakeEmbedding,
        contentIndex,
        opts: {
          embedMinIntervalMs: 0,
          facts: {
            byTurn: {
              t1: { triples: [{ subject: "User", predicate: "city", value: "Berlin", phrase: "lives in Berlin", cardinality: "single" }] },
              t3: {
                triples: [
                  { subject: "User", predicate: "city", value: "Munich", phrase: "lives in Munich", cardinality: "single" },
                  { subject: "User", predicate: "likes", value: "tea", phrase: "likes tea", cardinality: "multi" },
                ],
              },
            },
          },
          writePolicy: { factRows: true },
        },
      });
      expect(stats.factRowTurns).toBe(2);
      expect(stats.factRows).toBe(3);
      expect(stats.factRowsInvalidated).toBe(1);

      const rows = store
        .queryL1Records()
        .map((r) => ({ id: r.record_id, content: r.content, validEnd: r.valid_end }));
      const byId = new Map(rows.map((r) => [r.id, r]));
      // 旧城市行被本 turn 时刻失效（不是 now）
      expect(byId.get("t1")?.validEnd).toBe("2025-12-31T09:00:00Z");
      expect(byId.get("t1")?.content).toContain("lives in Berlin");
      // 新城市行 active（父 turn t3 的第一条事实行沿用 turn id）
      expect(byId.get("t3")?.content).toContain("lives in Munich");
      expect(byId.get("t3")?.validEnd == null || byId.get("t3")?.validEnd === "").toBe(true);
      // 兄弟 multi 行不被连带失效（事实级失效只碰同 fact_key）
      expect(byId.get("t3#f2")?.content).toContain("likes tea");
      expect(byId.get("t3#f2")?.validEnd == null || byId.get("t3#f2")?.validEnd === "").toBe(true);
      // 无事实 turn 回退整行，行为零变化
      expect(byId.get("t2")?.content).toContain("Noted.");
      // 度量口径：召回命中任一条事实行都能解析回父 turn（contentIndex 键 = normHead(content)）
      expect(contentIndex.get("[2025-12-31 09:00:00Z] user: lives in Munich")).toBe("t3");
      expect(contentIndex.get("[2025-12-31 09:00:00Z] user: likes tea")).toBe("t3");
      expect(contentIndex.get("[2025-12-30 08:00:00Z] user: lives in Berlin")).toBe("t1");
      expect(contentIndex.get("[2025-12-30 08:01:00Z] assistant: Noted.")).toBe("t2");
    } finally {
      try { store.close?.(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
