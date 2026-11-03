/**
 * 指纹并入摘要实现版本（B，2026-11-03）。
 *
 * 病灶：sourceFingerprint 只含 attributeKey/subject/源 id 集合——改 prompt、抬 maxTokens、
 * 换模型后**已有卡永远被指纹判成"未变"**，实现变更对存量证据不生效。
 *
 * 合同：
 *  ① 指纹包含「摘要版本 + 模型」标识：版本/模型任一变化 → 指纹变 → 重算；
 *  ② 同一证据 + 同一版本 + 同一模型 → 指纹稳定、复用既有卡 id（不得每次新建卡）；
 *  ③ 版本常量显式导出（升级=重算，语义见 summarizer.ts 注释）。
 */
import { describe, expect, it } from "vitest";
import { runConsolidation, sourceFingerprint } from "../consolidation-worker.js";
import { CONSOLIDATION_SUMMARY_VERSION, summarizeImplementationId } from "../summarizer.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

const DUR1 = '{"content":"第一版持续态摘要","certainty":"observed"}';
const DUR2 = '{"content":"第二版持续态摘要（实现升级后重算）","certainty":"observed"}';

function src(id: string, content: string, day: number): MemoryRecord {
  const ts = `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  return {
    id,
    content,
    type: "episodic",
    priority: 60,
    scene_name: "s",
    source_message_ids: [],
    metadata: {
      subject: "td-agemem",
      work_object: "td-agemem",
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

interface DepsShape {
  queryL1: () => Promise<MemoryRecord[]>;
  model?: string;
  llmRunner: { run: () => Promise<string> };
  config: unknown;
  store: unknown;
  embeddingService: unknown;
  logger: unknown;
}

function makeDeps(
  state: { current: MemoryRecord[] },
  store: unknown,
  extra: Record<string, unknown> = {},
): { deps: DepsShape; calls: Array<{ model?: string }> } {
  const calls: Array<{ model?: string }> = [];
  const deps: DepsShape = {
    queryL1: async () => state.current,
    model: "model-a",
    llmRunner: {
      run: async () => {
        calls.push({ model: deps.model });
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
    embeddingService: null,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
  return { deps, calls };
}

describe("B · 指纹并入摘要版本/模型", () => {
  const group = {
    subject: "td|decision",
    attributeKey: "td|decision",
    memories: [{ id: "r2" }, { id: "r1" }],
  };

  it("同证据同版本同模型：指纹稳定且与源 id 顺序无关", () => {
    expect(sourceFingerprint(group)).toBe(sourceFingerprint({ ...group, memories: [{ id: "r1" }, { id: "r2" }] }));
    expect(sourceFingerprint(group)).toBe(sourceFingerprint(group, undefined, CONSOLIDATION_SUMMARY_VERSION));
  });

  it("只改模型或只改版本：指纹必变", () => {
    const base = sourceFingerprint(group, "model-a");
    expect(sourceFingerprint(group, "model-b")).not.toBe(base);
    expect(sourceFingerprint(group, "model-a", "legacy-1")).not.toBe(base);
    expect(sourceFingerprint(group)).toBe(sourceFingerprint(group, "   ", CONSOLIDATION_SUMMARY_VERSION));
  });

  it("实现标识可显式断言（版本|模型，模型缺省 default）", () => {
    expect(summarizeImplementationId("model-a")).toBe(`${CONSOLIDATION_SUMMARY_VERSION}|model-a`);
    expect(summarizeImplementationId(undefined)).toBe(`${CONSOLIDATION_SUMMARY_VERSION}|default`);
    expect(summarizeImplementationId("  ")).toBe(`${CONSOLIDATION_SUMMARY_VERSION}|default`);
  });

  it("换模型 → 同证据重算一次，但复用既有卡 id（不新建卡）；再跑恢复跳过", async () => {
    const sources = [src("r1", "决定先做前端", 1), src("r2", "拍板：先做前端", 2), src("r3", "决定收口留证", 3)];
    const state = { current: [...sources] };
    const { store, rows } = makeStore();
    const { deps, calls } = makeDeps(state, store);
    const sync = () => {
      state.current = [...sources, ...cardsOf(rows)];
    };

    await runConsolidation(deps as never);
    sync();
    const cardId = cardsOf(rows)[0].id;
    expect(cardsOf(rows)[0].content).toBe("第一版持续态摘要");

    deps.model = "model-b";
    const second = await runConsolidation(deps as never);
    sync();
    expect(calls.length).toBe(2);
    expect(second.skippedUnchanged ?? 0).toBe(0);
    expect(second.persisted).toBe(1);
    expect(cardsOf(rows)).toHaveLength(1);
    expect(cardsOf(rows)[0].id).toBe(cardId);
    expect(cardsOf(rows)[0].content).toBe("第二版持续态摘要（实现升级后重算）");

    const third = await runConsolidation(deps as never);
    expect(calls.length).toBe(2);
    expect(third.skippedUnchanged).toBe(1);
  });

  it("旧版本指纹（存量为 v1 口径）→ 首轮重算并改写为新版本指纹，之后跳过", async () => {
    const sources = [src("r1", "决定先做前端", 1), src("r2", "拍板：先做前端", 2), src("r3", "决定收口留证", 3)];
    const state = { current: [...sources] };
    const { store, rows } = makeStore();
    const { deps, calls } = makeDeps(state, store);
    await runConsolidation(deps as never);

    const card = cardsOf(rows)[0];
    // 用落卡真实键构造旧版指纹（不手写派生键，避免与 attribute-key 归一化规则脱节）：
    // subject/attributeKey 都是 grouping 产出的属性键（如 td-agemem|decision）。
    const key = String(metaOf(card).attribute_key);
    const group = { subject: key, attributeKey: key, memories: sources };
    card.metadata = {
      ...metaOf(card),
      source_fingerprint: sourceFingerprint(group, "model-a", "1"),
    } as unknown as MemoryRecord["metadata"];

    state.current = [...sources, ...cardsOf(rows)];
    const afterUpgrade = await runConsolidation(deps as never);
    state.current = [...sources, ...cardsOf(rows)];
    expect(calls.length).toBe(2);
    expect(afterUpgrade.skippedUnchanged ?? 0).toBe(0);
    expect(metaOf(cardsOf(rows)[0]).source_fingerprint).toBe(sourceFingerprint(group, "model-a"));

    const stable = await runConsolidation(deps as never);
    expect(calls.length).toBe(2);
    expect(stable.skippedUnchanged).toBe(1);
  });
});
