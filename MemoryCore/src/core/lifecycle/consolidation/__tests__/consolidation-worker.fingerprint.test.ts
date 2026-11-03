/**
 * B1 生产缺陷（2026-11-02）：属性归组把组数从 8 抬到 20+，worker 每 tick 重算全部组
 * （单卡实测 30–90s）→ lifecycle 互斥锁被占、tick 互跳、LLM 成本与 churn 翻倍。
 * 合同：组身份 + 组内源 id 集合不变 → 不重算；出现新源/无指纹 → 重算一次后落指纹。
 */
import { describe, expect, it } from "vitest";
import { runConsolidation } from "../consolidation-worker.js";
import { buildDurativeSummary } from "../summarizer.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

const DUR1 = '{"content":"第一版持续态摘要","certainty":"observed"}';
const DUR2 = '{"content":"第二版持续态摘要（新增证据）","certainty":"observed"}';

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

function makeStore() {
  const rows: MemoryRecord[] = [];
  const store = {
    upsertL1: (rec: MemoryRecord) => {
      const i = rows.findIndex((r) => r.id === rec.id);
      if (i >= 0) rows[i] = rec;
      else rows.push(rec);
      return true;
    },
    addLink: async () => true,
  };
  return { store, rows };
}

const cardsOf = (rows: MemoryRecord[]) => rows.filter((r) => r.type === "work_fact" && r.scene_name === "consolidated");
const metaOf = (rec: MemoryRecord): Record<string, unknown> => (rec.metadata ?? {}) as Record<string, unknown>;

function makeDeps(state: { current: MemoryRecord[] }, store: unknown, extra: Record<string, unknown> = {}) {
  const calls: Array<{ timeoutMs?: number }> = [];
  const deps = {
    queryL1: async () => state.current,
    llmRunner: {
      run: async (p: { timeoutMs?: number }) => {
        calls.push({ timeoutMs: p.timeoutMs });
        return calls.length === 1 ? DUR1 : DUR2;
      },
    },
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
  return { deps, calls };
}

describe("consolidation worker · 指纹跳过（B1 生产缺陷）", () => {
  it("同输入第二轮零 LLM 调用、零新版本，且 skippedUnchanged 记账", async () => {
    const sources = [src("r1", "决定先做前端", 1), src("r2", "拍板：先做前端", 2), src("r3", "决定收口留证", 3)];
    const state = { current: [...sources] };
    const { store, rows } = makeStore();
    const { deps, calls } = makeDeps(state, store);

    const first = await runConsolidation(deps);
    state.current = [...sources, ...cardsOf(rows)]; // 真实链路：queryL1 也返回已落库的卡
    expect(first.groupsFound).toBe(1);
    expect(calls.length).toBe(1);
    expect(first.persisted).toBe(1);
    const v1 = cardsOf(rows)[0].version;

    const second = await runConsolidation(deps);
    state.current = [...sources, ...cardsOf(rows)];
    expect(calls.length).toBe(1); // 没重算
    expect(second.summaries.length).toBe(0);
    expect(second.skippedUnchanged).toBe(1);
    expect(second.persisted).toBe(0);
    expect(cardsOf(rows).length).toBe(1);
    expect(cardsOf(rows)[0].version).toBe(v1); // 版本不再每 tick 递增
    expect(typeof metaOf(cardsOf(rows)[0]).source_fingerprint).toBe("string");
  });

  it("出现新源记忆 → 指纹变 → 重算一次", async () => {
    const sources = [src("r1", "决定先做前端", 1), src("r2", "拍板：先做前端", 2), src("r3", "决定收口留证", 3)];
    const state = { current: [...sources] };
    const { store, rows } = makeStore();
    const { deps, calls } = makeDeps(state, store);
    const sync = () => {
      state.current = [...sources, ...cardsOf(rows)];
    }; // 真实链路：queryL1 也返回已落库的卡
    await runConsolidation(deps);
    sync();
    const fp1 = metaOf(cardsOf(rows)[0]).source_fingerprint;

    sources.push(src("r4", "决定补观察窗", 4));
    sync();
    const third = await runConsolidation(deps);
    sync();
    expect(calls.length).toBe(2);
    expect(third.summaries.length).toBe(1);
    expect(third.skippedUnchanged).toBe(0);
    expect(cardsOf(rows)[0].content).toBe("第二版持续态摘要（新增证据）");
    expect(metaOf(cardsOf(rows)[0]).source_fingerprint).not.toBe(fp1);

    const fourth = await runConsolidation(deps);
    expect(calls.length).toBe(2);
    expect(fourth.skippedUnchanged).toBe(1);
  });

  it("存量卡无指纹（上线首轮）→ 重算一次并补指纹，之后跳过", async () => {
    const sources = [src("r1", "决定先做前端", 1), src("r2", "拍板：先做前端", 2), src("r3", "决定收口留证", 3)];
    const state = { current: [...sources] };
    const { store, rows } = makeStore();
    const { deps, calls } = makeDeps(state, store);
    await runConsolidation(deps);

    const card = cardsOf(rows)[0];
    const meta = { ...metaOf(card) };
    delete meta.source_fingerprint;
    card.metadata = meta as unknown as MemoryRecord["metadata"];

    state.current = [...sources, ...cardsOf(rows)];
    const legacyRun = await runConsolidation(deps);
    state.current = [...sources, ...cardsOf(rows)];
    expect(calls.length).toBe(2); // 无指纹必须重算，不能靠"看起来没变"猜
    expect(legacyRun.skippedUnchanged).toBe(0);
    expect(typeof metaOf(cardsOf(rows)[0]).source_fingerprint).toBe("string");

    const after = await runConsolidation(deps);
    expect(calls.length).toBe(2);
    expect(after.skippedUnchanged).toBe(1);
  });

  it("summarizeTimeoutMs 透传到 LLM 调用（截断修复后必须同时抬超时）", async () => {
    const state = {
      current: [src("r1", "决定先做前端", 1), src("r2", "拍板：先做前端", 2), src("r3", "决定收口留证", 3)],
    };
    const { store } = makeStore();
    const { deps, calls } = makeDeps(state, store, { summarizeTimeoutMs: 1234 });
    await runConsolidation(deps);
    expect(calls[0].timeoutMs).toBe(1234);

    const { store: store2 } = makeStore();
    const { deps: deps2, calls: calls2 } = makeDeps(state, store2);
    await runConsolidation(deps2);
    expect(calls2[0].timeoutMs).toBe(180_000);
  });
});

describe("summarizer · 超时缺省（B1 生产缺陷）", () => {
  const group = {
    subject: "定案|decision",
    memories: [{ id: "r1", type: "episodic", content: "决定 X" }],
    latestTs: Date.parse("2026-10-03T00:00:00.000Z"),
    earliestTs: Date.parse("2026-10-01T00:00:00.000Z"),
  } as never;

  it("缺省 180s：覆盖实测最大属性组（44 成员 ≈90–120s）", async () => {
    let got: number | undefined;
    await buildDurativeSummary(group, {
      llmRunner: { run: async (p: { timeoutMs?: number }) => ((got = p.timeoutMs), DUR1) } as never,
    });
    expect(got).toBe(180_000);
  });

  it("config.timeoutMs 可覆盖", async () => {
    let got: number | undefined;
    await buildDurativeSummary(group, {
      llmRunner: { run: async (p: { timeoutMs?: number }) => ((got = p.timeoutMs), DUR1) } as never,
      config: { timeoutMs: 60_000 },
    });
    expect(got).toBe(60_000);
  });
});
