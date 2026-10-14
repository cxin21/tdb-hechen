/**
 * P1 Task 7 — POST /atomic/importance（人工重要度调整）路由单测。
 * 合同：
 * - {id, importance(1-10), reason?} → 记录 importance 覆写 + metadata.importance_source='manual'
 *   + metadata.importance_manual_reason 追加（绝不改写 LLM 的 importance_reason）；
 * - 全量 soul 拷贝（P0-T3：upsert excluded.* 覆盖 → 漏拷 = 编辑刷空）；
 * - 非法值 400 / 未知 id 404 / 跨租户 403；content 不变 → embedding 不重算（undefined 透传）。
 */
import { describe, it, expect } from "vitest";
import { handleAtomicImportance } from "../v2-router.js";
import type { V2RouterDeps } from "../v2-router.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";
import type { L1RecordRow } from "../../core/store/types.js";

const ISO = { teamId: "t-1", userId: "u-1", agentId: "a-1", sessionId: "s-1" };

function l1Row(id: string, over: Partial<L1RecordRow> = {}): L1RecordRow {
  return {
    record_id: id, content: "内容" + id, type: "work_fact", priority: 50, scene_name: "",
    session_key: "", session_id: "s-1", team_id: "t-1", task_id: "", user_id: "u-1",
    agent_id: "a-1", version: 1, timestamp_str: "2026-10-14T00:00:00Z",
    timestamp_start: "", timestamp_end: "", created_time: "2026-10-14T00:00:00Z",
    updated_time: "2026-10-14T00:00:00Z",
    metadata_json: JSON.stringify({ importance_reason: "LLM 判定原因", importance_source: "llm" }),
    occurred_at: "2026-10-14T00:00:00Z", valid_start: null, valid_end: null,
    certainty: "observed", source: "extraction", valence: 0.2, arousal: 0.1,
    significance: 0.8, sensitivity: "none", importance: 2,
    ...over,
  } as L1RecordRow;
}

function makeDeps(row: L1RecordRow | undefined) {
  const upserts: Array<{ record: MemoryRecord; emb: Float32Array | undefined }> = [];
  const deps: V2RouterDeps = {
    requestIsolation: ISO,
    getStore: () => ({
      getL1ByIds: (ids: string[]) => (row && ids.includes(row.record_id) ? [row] : []),
      upsertL1: (record: MemoryRecord, emb: Float32Array | undefined) => {
        upserts.push({ record, emb });
        return true;
      },
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as V2RouterDeps;
  return { deps, upserts };
}

describe("POST /atomic/importance（P1 task-7 人工重要度调整）", () => {
  it("成功：importance 覆写 + source=manual + 手动原因追加 + LLM 原因保留 + soul 全量拷贝", async () => {
    const row = l1Row("r1");
    const { deps, upserts } = makeDeps(row);
    const out = await handleAtomicImportance(
      { id: "r1", importance: 8, reason: "客户承诺过交付" }, {} as never, "rq-1", deps,
    );
    expect(out.code).toBe(0);
    expect(upserts).toHaveLength(1);
    const rec = upserts[0]!.record;
    expect(rec.importance).toBe(8);
    const meta1 = (rec.metadata ?? {}) as Record<string, unknown>;
    expect(meta1.importance_source).toBe("manual");
    expect(meta1.importance_manual_reason).toBe("客户承诺过交付");
    expect(meta1.importance_reason).toBe("LLM 判定原因");   // LLM 原因绝不被覆写
    expect(rec.version).toBe(2);                                     // version 自增
    // P0-T3：soul 字段不得因调整而刷空
    expect(rec.occurred_at).toBe("2026-10-14T00:00:00Z");
    expect(rec.certainty).toBe("observed");
    expect(rec.valence).toBeCloseTo(0.2);
    expect(rec.significance).toBeCloseTo(0.8);
    expect(rec.sensitivity).toBe("none");
    expect(rec.importance).toBe(8);
    // content 不变 → 不重算 embedding（undefined 透传 = metadata-only 写）
    expect(rec.content).toBe("内容r1");
    expect(upserts[0]!.emb).toBeUndefined();
    const d = out.data as { id: string; importance: number; importance_source: string };
    expect(d.id).toBe("r1");
    expect(d.importance).toBe(8);
    expect(d.importance_source).toBe("manual");
  });

  it("不带 reason：仅覆写分值与 source（metadata 无 manual_reason 键）", async () => {
    const row = l1Row("r2");
    const { deps, upserts } = makeDeps(row);
    const out = await handleAtomicImportance({ id: "r2", importance: 9 }, {} as never, "rq-2", deps);
    expect(out.code).toBe(0);
    const rec = upserts[0]!.record;
    expect(rec.importance).toBe(9);
    expect(rec.metadata?.importance_source).toBe("manual");
    expect(rec.metadata?.importance_manual_reason).toBeUndefined();
  });

  it("非法分值（0/11/非数字）→ 400 且不落盘", async () => {
    const { deps, upserts } = makeDeps(l1Row("r3"));
    for (const bad of [0, 11, 3.5, "7"]) {
      const out = await handleAtomicImportance({ id: "r3", importance: bad }, {} as never, "rq-3", deps);
      expect(out.code).toBe(400);
    }
    expect(upserts).toHaveLength(0);
  });

  it("缺 id / 未知 id 404 / 跨租户 403", async () => {
    const { deps } = makeDeps(l1Row("r4"));
    expect((await handleAtomicImportance({ importance: 7 }, {} as never, "rq-4", deps)).code).toBe(400);
    expect((await handleAtomicImportance({ id: "ghost", importance: 7 }, {} as never, "rq-5", deps)).code).toBe(404);
    const evil = l1Row("r5", { team_id: "t-EVIL" });
    const { deps: depsEvil } = makeDeps(evil);
    expect((await handleAtomicImportance({ id: "r5", importance: 7 }, {} as never, "rq-6", depsEvil)).code).toBe(403);
  });
});
