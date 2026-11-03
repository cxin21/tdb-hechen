/**
 * B1（P6）巩固 worker：属性键换掉 subject 字符串后的端到端合同。
 *
 * 病灶（research §2.1/§3.P6）：全史 862 条反思类 L2 共用 metadata.subject="反思结论"，
 * 巩固层把它们并成极少数巨卡（10 张卡承载全部历史）。判据：一批不同主题/属性的反思
 * 必须落成多张卡，且每张卡证据链非空。
 */
import { describe, expect, it } from "vitest";
import { runConsolidation } from "../consolidation-worker.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

const DURATIVE_JSON = '{"content":"用户长期在修 L1 提取管线，并把契约测试当成交付门槛","certainty":"observed"}';

type Link = { sourceId: string; targetId: string; type: string };

function src(id: string, content: string, meta: Record<string, unknown>, day: number): MemoryRecord {
  const ts = `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  return {
    id,
    content,
    type: "episodic",
    priority: 60,
    scene_name: "s",
    source_message_ids: [],
    metadata: meta as unknown as MemoryRecord["metadata"],
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
  const links: Link[] = [];
  const store = {
    upsertL1: (rec: MemoryRecord) => {
      const i = rows.findIndex((r) => r.id === rec.id);
      if (i >= 0) rows[i] = rec;
      else rows.push(rec);
      return true;
    },
    addLink: async (sourceId: string, targetId: string, type: string) => {
      links.push({ sourceId, targetId, type });
      return true;
    },
  };
  return { store, rows, links };
}

function makeDeps(
  state: { current: MemoryRecord[] },
  store: unknown,
  config: Record<string, unknown>,
  embeddingService?: { embed(t: string): Promise<Float32Array> } | null,
) {
  return {
    queryL1: async () => state.current,
    llmRunner: { run: async () => DURATIVE_JSON } as never,
    config: { enabled: true, minCount: 3, minSpanDays: 1, persist: true, ...config } as never,
    store: store as never,
    embeddingService: embeddingService as never,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  } as never;
}

const metaOf = (rec: MemoryRecord): Record<string, unknown> => (rec.metadata ?? {}) as Record<string, unknown>;
const evidenceOf = (rec: MemoryRecord): string[] => {
  const meta = metaOf(rec);
  return Array.isArray(meta.evidence_record_ids) ? (meta.evidence_record_ids as unknown[]).map(String) : [];
};
const cardsOf = (rows: MemoryRecord[]) => rows.filter((r) => r.type === "work_fact" && r.scene_name === "consolidated");

/** 8 条反思：同一个 subject（病灶现场），但三类属性各不相同。 */
function reflectionBatch(): MemoryRecord[] {
  const m = { subject: "反思结论", work_object: "td-agemem" };
  const out: MemoryRecord[] = [];
  const specs: Array<[string, string]> = [
    ["决定", "决定先做前端"],
    ["工具", "使用 bge 向量"],
    ["根因", "bug 根因是元数据丢失"],
  ];
  let day = 1;
  for (const [tag, text] of specs) {
    for (let i = 0; i < 3; i++) {
      out.push(src(`${tag}-${i}`, `${text}（第${i}次复盘）`, { ...m }, day++));
    }
  }
  return out;
}

describe("B1 属性键归组（worker 端到端）", () => {
  it("一批同 subject 反思 → ≥3 张卡，每张证据链非空（不再合成一张巨卡）", async () => {
    const { store, rows } = makeStore();
    const state = { current: reflectionBatch() };
    const res = await runConsolidation(makeDeps(state, store, { attributeGrouping: { enabled: true, minCos: 0.82 } }));
    expect(res.persisted).toBeGreaterThanOrEqual(3);
    const cards = cardsOf(rows);
    expect(cards.length).toBeGreaterThanOrEqual(3);
    for (const card of cards) expect(evidenceOf(card).length).toBeGreaterThan(0);
    const keys = new Set(cards.map((c) => String(metaOf(c).attribute_key ?? "")));
    expect(keys.size).toBeGreaterThanOrEqual(3);
    // 属性键形状：entity|attribute，且三张卡覆盖三类不同属性
    const attrs = cards.map((c) => String(metaOf(c).attribute)).sort();
    expect(attrs).toEqual(["decision", "root_cause", "tooling"]);
  });

  it("两个 subject 不同、attribute 相同的记录 → 同一张卡（自证用属性键不是 subject 串）", async () => {
    const { store, rows } = makeStore();
    const state = {
      current: [
        src("x1", "决定先做前端", { subject: "反思结论", work_object: "td-agemem" }, 1),
        src("x2", "拍板：先做前端", { subject: "完全不同的主题", work_object: "td-agemem" }, 3),
        src("x3", "确定方案：先做前端", { subject: "第三个主题", work_object: "td-agemem" }, 5),
      ],
    };
    const res = await runConsolidation(makeDeps(state, store, { attributeGrouping: { enabled: true, minCos: 0.82 } }));
    expect(res.persisted).toBe(1);
    const cards = cardsOf(rows);
    expect(cards).toHaveLength(1);
    expect(metaOf(cards[0]).attribute_key).toBe("td-agemem|decision");
    expect(evidenceOf(cards[0]).sort()).toEqual(["x1", "x2", "x3"]);
  });

  it("开关缺省（关闭）→ 逐位旧行为：同 subject 归一张卡、不写 attribute_key", async () => {
    const { store, rows } = makeStore();
    const state = { current: reflectionBatch() };
    const res = await runConsolidation(makeDeps(state, store, {}));
    expect(res.persisted).toBe(1);
    const cards = cardsOf(rows);
    expect(cards).toHaveLength(1);
    expect(metaOf(cards[0]).subject).toBe("反思结论");
    expect(metaOf(cards[0]).attribute_key).toBeUndefined();
  });

  it("幂等：已有 attribute_key 卡被复用（id 不变、版本递增），旧 subject 卡仍可读", async () => {
    const { store, rows } = makeStore();
    const state = { current: reflectionBatch() };
    const cfg = { attributeGrouping: { enabled: true, minCos: 0.82 } };
    await runConsolidation(makeDeps(state, store, cfg));
    const first = cardsOf(rows).find((c) => metaOf(c).attribute === "decision")!;
    // 第二轮：把卡留在 queryL1 结果里（真实链路如此），并给决定组添一条新证据——
    // 指纹跳过（2026-11-02 B1 生产缺陷修复）后，**源集合没变的组不再重算**，
    // 只有来了新源的组才重写同一张卡（id 不变、版本递增）。
    state.current = [
      ...reflectionBatch(),
      src("extra-decision", "决定再复盘一次", { subject: "反思结论", work_object: "td-agemem" }, 12),
      ...cardsOf(rows),
    ];
    const res = await runConsolidation(makeDeps(state, store, cfg));
    expect(res.persisted).toBeGreaterThanOrEqual(1);
    expect(res.skippedUnchanged ?? 0).toBeGreaterThanOrEqual(2);
    const again = cardsOf(rows).find((c) => String(c.id) === String(first.id))!;
    expect(Number(again.version)).toBe(2);
  });

  it("属性归一不了 + 有 embedding → 池内 cos 兜底成一张卡", async () => {
    const { store, rows } = makeStore();
    const state = {
      current: [src("p1", "今天天气不错", {}, 1), src("p2", "今天天气挺好", {}, 3), src("p3", "今天天气还行", {}, 5)],
    };
    const cfg = { minCount: 1, attributeGrouping: { enabled: true, minCos: 0.82 } };
    const res = await runConsolidation(makeDeps(state, store, cfg, { embed: async () => new Float32Array([1, 0.01]) }));
    expect(res.persisted).toBe(1);
    expect(evidenceOf(cardsOf(rows)[0])).toHaveLength(3);
  });

  it("属性归一不了 + 无 embedding → 各自独立成卡（不静默丢弃）", async () => {
    const { store, rows } = makeStore();
    const state = {
      current: [
        src("q1", "今天天气不错", {}, 1),
        src("q2", "今天天气挺好", {}, 3),
        src("q3", "苹果手机电池保养", {}, 5),
      ],
    };
    const cfg = { minCount: 1, attributeGrouping: { enabled: true, minCos: 0.82 } };
    const res = await runConsolidation(makeDeps(state, store, cfg, null));
    expect(res.persisted).toBe(3);
    const ids = cardsOf(rows).flatMap(evidenceOf).sort();
    expect(ids).toEqual(["q1", "q2", "q3"]);
  });

  it("防大卡：60 条同属性 → 多张卡，每张 ≤50 且证据并集完整", async () => {
    const { store, rows } = makeStore();
    const state = {
      current: Array.from({ length: 60 }, (_, i) =>
        src(`b${i}`, "决定先做前端", { work_object: "td-agemem" }, (i % 20) + 1),
      ),
    };
    const cfg = { maxPerRun: 0, attributeGrouping: { enabled: true, minCos: 0.82 } };
    const res = await runConsolidation(makeDeps(state, store, cfg));
    expect(res.persisted).toBeGreaterThanOrEqual(2);
    const cards = cardsOf(rows);
    for (const c of cards) expect(evidenceOf(c).length).toBeLessThanOrEqual(50);
    const all = cards.flatMap(evidenceOf).sort();
    expect(all).toHaveLength(60);
  });
});
