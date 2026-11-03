/**
 * C（2026-11-03）：锁死 valid_end 形态 + 遗忘判据回归锚。
 *
 * ① 既有用例 consolidation-validity-open.test.ts:111 用 `rec.valid_end ?? undefined` 断言，
 *    对 NULL 与 '' 不可区分——锁不住回归。这里直接读**原始行**（store 查询 + SQL 谓词）：
 *    开区间卡必须被 `(valid_end IS NULL OR valid_end='')` 命中，且列值不是时间戳；
 *    invalidateL1 之后同一谓词必须不再命中（证明谓词不是空转）。
 * ② 开区间不是遗忘豁免：归档判定（forgetting/scorer.ts classify/scoreFor）只看
 *    significance/priority/年龄/配置阈值，与 valid_end 无关——补一条回归锚，
 *    防止「开区间永不过期」的误读被写进遗忘链。同时锚住缺省参数不被改坏。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runConsolidation } from "../consolidation-worker.js";
import { VectorStore } from "../../../store/sqlite.js";
import { classify, DEFAULT_FORGETTING_CONFIG, scoreFor } from "../../forgetting/scorer.js";
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

const sources = [src("r1", "决定先做前端", 1), src("r2", "拍板：先做前端", 2), src("r3", "决定收口留证", 3)];

function makeDeps(store: VectorStore) {
  return {
    queryL1: async () => store.queryL1Records() as unknown as MemoryRecord[],
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

describe("C · valid_end 形态（原始行）+ 遗忘判据锚", () => {
  it("开区间卡落库后原始列不是时间戳，且被 SQL 开区间谓词命中；invalidate 后不再命中", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consolidation-valid-end-"));
    let store: VectorStore | null = null;
    try {
      store = new VectorStore(join(dir, "vectors.db"), 0);
      await store.init();
      for (const s of sources) store.upsertL1(s, undefined);

      await runConsolidation(makeDeps(store));
      const card = store.queryL1Records().find((r) => r.type === "work_fact" && r.scene_name === "consolidated");
      expect(card).toBeTruthy();

      // ① store 读出的行：开区间（NULL 或 ''），绝不是时间戳
      expect(card!.valid_end === null || card!.valid_end === "").toBe(true);
      const id = card!.record_id;

      const db = new DatabaseSync(join(dir, "vectors.db"));
      try {
        const raw = db.prepare("SELECT valid_end FROM l1_records WHERE record_id = ?").get(id) as {
          valid_end: string | null;
        };
        expect(raw.valid_end === null || raw.valid_end === "").toBe(true);

        const openBefore = db
          .prepare("SELECT COUNT(*) AS n FROM l1_records WHERE record_id = ? AND (valid_end IS NULL OR valid_end = '')")
          .get(id) as { n: number };
        expect(openBefore.n).toBe(1);

        // ② 失效后同一谓词不再命中（对照：谓词不是恒真）
        expect(store!.invalidateL1!(id, "2026-11-03T00:00:00.000Z")).toBe(true);
        const openAfter = db
          .prepare("SELECT COUNT(*) AS n FROM l1_records WHERE record_id = ? AND (valid_end IS NULL OR valid_end = '')")
          .get(id) as { n: number };
        expect(openAfter.n).toBe(0);
        const closed = db.prepare("SELECT valid_end FROM l1_records WHERE record_id = ?").get(id) as {
          valid_end: string | null;
        };
        expect(closed.valid_end).toBe("2026-11-03T00:00:00.000Z");
      } finally {
        db.close();
      }
    } finally {
      store?.close(); // Windows：不关句柄直接 rmSync 报 EBUSY
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("开区间卡不豁免遗忘：400 天旧卡按缺省参数判 archive，15 天新卡 keep", () => {
    const now = Date.parse("2026-11-02T09:00:00Z");
    const old = new Date(now - 400 * 86_400_000).toISOString();
    const card: MemoryRecord = {
      id: "dur_card",
      content: "持续态摘要（开区间）",
      type: "work_fact",
      priority: 80,
      scene_name: "consolidated",
      source_message_ids: [],
      metadata: { subject: "td-agemem", activity_end_time: old } as unknown as MemoryRecord["metadata"],
      timestamps: [old],
      createdAt: old,
      updatedAt: old,
      version: 2,
      sessionKey: "consolidation",
      sessionId: "consolidation",
      occurred_at: old,
      valid_start: old,
      valid_end: "", // 开区间（sqlite 写路径的形态）
      certainty: "observed",
      significance: 0.6,
      teamId: "t1",
      userId: "u1",
      agentId: "a1",
    } as unknown as MemoryRecord;

    // 缺省参数锚：遗忘语义若被改（阈值/衰减/最短年龄），这里先响
    expect(DEFAULT_FORGETTING_CONFIG.lambda).toBe(0.01);
    expect(DEFAULT_FORGETTING_CONFIG.lowThreshold).toBe(0.12);
    expect(DEFAULT_FORGETTING_CONFIG.minAgeDays).toBe(30);

    expect(scoreFor(card, DEFAULT_FORGETTING_CONFIG, now)).toBeLessThan(DEFAULT_FORGETTING_CONFIG.lowThreshold);
    expect(classify(card, DEFAULT_FORGETTING_CONFIG, now)).toBe("archive");
    // valid_end 缺省形态（undefined）与 '' 同判：开区间不是豁免
    expect(classify({ ...card, valid_end: undefined }, DEFAULT_FORGETTING_CONFIG, now)).toBe("archive");

    // 对照：同卡但年龄 15 天 → 未过 minAgeDays，keep（证明上面的 archive 不是恒真）
    const young = new Date(now - 15 * 86_400_000).toISOString();
    expect(classify({ ...card, createdAt: young, occurred_at: young }, DEFAULT_FORGETTING_CONFIG, now)).toBe("keep");
  });
});
