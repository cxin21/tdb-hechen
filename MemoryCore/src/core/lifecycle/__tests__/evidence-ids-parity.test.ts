/**
 * WP7（#155 写面）：证据指针键名单源化的验收锁。
 *
 * 问题（审计 §4 #155 + WP2 跨 scope 发现）：结论卡的证据键分裂——
 *   consolidation 卡写 metadata.evidence_ids，reflection 卡写 metadata.evidence_record_ids；
 * 消费方同样分裂（gateway/atomic-by-ids.ts:4 读前者，auto-recall.ts:4161/4201 读后者）。
 * 于是「读面回退某一路证据」时总有另一类卡取不到证据。
 *
 * 本文件锁四件事：
 *  ① 写面单源（evidence-ids.ts）：readEvidenceIds 优先 canonical、回退旧键；withEvidenceIds 双写。
 *  ② reflection 卡（真实 runReflection）双写，两个键内容相同。
 *  ③ consolidation 卡（真实 runConsolidation）同样双写，两个键内容相同。
 *  ④ 两类卡证据键集合一致，同一个读函数 readEvidenceIds 能取出两类卡的证据（不区分来路）。
 */
import { describe, expect, it, vi } from "vitest";
import { runConsolidation } from "../consolidation/consolidation-worker.js";
import { runReflection } from "../reflection.js";
import {
  EVIDENCE_IDS_KEY,
  LEGACY_EVIDENCE_IDS_KEY,
  normalizeEvidenceIds,
  readEvidenceIds,
  withEvidenceIds,
} from "../evidence-ids.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const LOG = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const NOW = "2026-09-18T00:00:00.000Z";

// ── ① 键名契约单源 ────────────────────────────────────────────────────────────
describe("evidence-ids：键名契约单源", () => {
  it("canonical/别名常量就是两套历史键名（不许各写各的字符串）", () => {
    expect(EVIDENCE_IDS_KEY).toBe("evidence_ids");
    expect(LEGACY_EVIDENCE_IDS_KEY).toBe("evidence_record_ids");
  });

  it("读：两键合并去重、canonical 在前（= 读面 recall/evidence-ids.ts 同口径）", () => {
    // 双写后两键内容恒等，合并与回退等价
    expect(readEvidenceIds({ evidence_ids: ["a"], evidence_record_ids: ["a"] })).toEqual(["a"]);
    // 只有旧键的存量卡（双写之前写入的历史卡）不丢证据
    expect(readEvidenceIds({ evidence_record_ids: ["r1", "r2"] })).toEqual(["r1", "r2"]);
    expect(readEvidenceIds({ evidence_ids: [], evidence_record_ids: ["r9"] })).toEqual(["r9"]);
    // 两键不一致（脏卡/历史卡）时合并保序，不丢任一侧
    expect(readEvidenceIds({ evidence_ids: ["a"], evidence_record_ids: ["x", "a"] })).toEqual(["a", "x"]);
    expect(readEvidenceIds({})).toEqual([]);
    expect(readEvidenceIds(undefined)).toEqual([]);
    expect(readEvidenceIds({ evidence_ids: "not-an-array" })).toEqual([]);
  });

  it("写：双写 + 去重 + 去空，两个键内容相同但数组各自独立", () => {
    const md = withEvidenceIds({ subject: "x" }, ["r1", "", "r1", "r2", null]);
    expect(md.subject).toBe("x");
    expect(md[EVIDENCE_IDS_KEY]).toEqual(["r1", "r2"]);
    expect(md[LEGACY_EVIDENCE_IDS_KEY]).toEqual(["r1", "r2"]);
    expect(md[EVIDENCE_IDS_KEY]).not.toBe(md[LEGACY_EVIDENCE_IDS_KEY]);
    // 不改原有注意事项：归一化本身也不产生重复
    expect(normalizeEvidenceIds(["a", "a", " b ", 1])).toEqual(["a", "b", "1"]);
  });
});

// ── ② reflection 卡：真实写卡路径 ─────────────────────────────────────────────
function reflRow(id: string, content: string, significance: number) {
  return { id, content, type: "episodic", significance, createdAt: NOW, updatedAt: NOW, teamId: "t1", userId: "u1", agentId: "a1", metadata: {} };
}

async function writeReflectionCard(): Promise<Record<string, unknown>> {
  const store = { upsertL1: vi.fn(async () => true), addLink: vi.fn(async () => true) };
  const llmRunner = { run: vi.fn(async () => '[{"question":"沟通模式","conclusion":"用户偏好结论先行的沟通","evidence":["r1","r2"]}]') };
  await runReflection({
    queryL1: async () => [reflRow("r1", "用户坚持先给结论", 0.9), reflRow("r2", "用户每周五复盘", 0.8), reflRow("r3", "用户偏好清单式评审", 0.7)] as never,
    config: { enabled: true, rRef: 2 },
    store, llmRunner, logger: LOG,
  });
  const card = (store.upsertL1.mock.calls[0] as unknown[])[0] as { metadata?: Record<string, unknown> };
  return card.metadata ?? {};
}

// ── ③ consolidation 卡：真实写卡路径 ─────────────────────────────────────────
const SUBJECT = "L1 提取管线修复";

function srcRec(id: string, day: number): MemoryRecord {
  const ts = `2026-10-0${day}T00:00:00.000Z`;
  return {
    id,
    content: `第 ${day} 天：继续修 L1 提取管线 ${id}`,
    type: "episodic",
    priority: 60,
    scene_name: "修复 L1",
    source_message_ids: [],
    metadata: { subject: SUBJECT } as Record<string, unknown> as MemoryRecord["metadata"],
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    version: 1,
    sessionKey: "s",
    sessionId: "s",
    occurred_at: ts,
    certainty: "observed",
    valence: 0,
    arousal: 0,
    significance: 0.6,
    teamId: "t1",
    userId: "u1",
    agentId: "a1",
  } as unknown as MemoryRecord;
}

async function writeConsolidationCard(): Promise<Record<string, unknown>> {
  const rows: MemoryRecord[] = [];
  const store = {
    upsertL1: (rec: MemoryRecord) => {
      const i = rows.findIndex((r) => r.id === rec.id);
      if (i >= 0) rows[i] = rec; else rows.push(rec);
      return true;
    },
    addLink: async () => true,
  };
  const sourceRows = [srcRec("r1", 1), srcRec("r2", 3), srcRec("r3", 5)];
  await runConsolidation({
    queryL1: async () => sourceRows,
    llmRunner: { run: async () => '{"content":"用户长期在修 L1 提取管线","certainty":"observed"}' } as never,
    config: { enabled: true, minCount: 3, minSpanDays: 0, persist: true } as never,
    store: store as never,
    logger: LOG as never,
  });
  return (rows[0]?.metadata ?? {}) as Record<string, unknown>;
}

// ── ②③④ 跨卡一致性 ─────────────────────────────────────────────────────────
describe("WP7：两类结论卡证据键集合一致、同一读函数可取", () => {
  it("reflection 卡双写：evidence_ids 与 evidence_record_ids 同集合", async () => {
    const md = await writeReflectionCard();
    expect(md[EVIDENCE_IDS_KEY]).toEqual(["r1", "r2"]);
    // 兼容别名不许删（auto-recall.ts:4161/4201 仍按旧键读）
    expect(md[LEGACY_EVIDENCE_IDS_KEY]).toEqual(["r1", "r2"]);
    expect(readEvidenceIds(md)).toEqual(["r1", "r2"]);
  });

  it("consolidation 卡双写：evidence_ids 与 evidence_record_ids 同集合", async () => {
    const md = await writeConsolidationCard();
    expect(md[EVIDENCE_IDS_KEY]).toEqual(["r1", "r2", "r3"]);
    expect(md[LEGACY_EVIDENCE_IDS_KEY]).toEqual(["r1", "r2", "r3"]);
    expect(readEvidenceIds(md)).toEqual(["r1", "r2", "r3"]);
  });

  it("两类卡的证据键集合完全一致，同一读函数都能取出非空证据", async () => {
    const reflectionMeta = await writeReflectionCard();
    const consolidationMeta = await writeConsolidationCard();
    const evidenceKeys = (md: Record<string, unknown>) => Object.keys(md).filter((k) => k.startsWith("evidence")).sort();
    // 键集合一致（不多不少）——读面不需要「按卡来路分键」
    expect(evidenceKeys(reflectionMeta)).toEqual(evidenceKeys(consolidationMeta));
    expect(evidenceKeys(reflectionMeta)).toEqual([EVIDENCE_IDS_KEY, LEGACY_EVIDENCE_IDS_KEY].sort());
    // 同一个读函数取出两类卡的证据（这是 #155 读面回退能成立的前提）
    for (const md of [reflectionMeta, consolidationMeta]) {
      const ids = readEvidenceIds(md);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toEqual(md[EVIDENCE_IDS_KEY]);
      expect(ids).toEqual(md[LEGACY_EVIDENCE_IDS_KEY]);
      // 两种真实读面各自能取到证据：gateway/atomic-by-ids.ts 只读 evidence_ids，
      // auto-recall.ts:4161/4201 只读 evidence_record_ids——单写一个键就会有一方空手。
      expect((md[EVIDENCE_IDS_KEY] as string[]).length).toBeGreaterThan(0);
      expect((md[LEGACY_EVIDENCE_IDS_KEY] as string[]).length).toBeGreaterThan(0);
    }
  });
});
