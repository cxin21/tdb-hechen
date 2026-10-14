/**
 * P1 Task 8 — POST /atomic/invalidate（bi-temporal 补口，M4 #6）路由单测。
 * 合同（plan Task 8 / design §7）：
 * - {record_id, valid_end?, mode?="invalidate"|"restore"} → handleAtomicUpdate 既有 valid_end
 *   写路（invalidateL1）的语义化薄封装：invalidate = upsertL1(soul 拷贝) → store.invalidateL1；
 *   restore = upsertL1 清空 valid_end（不放松 handleAtomicUpdate 公开语义，仅本 handler 内部路径）；
 * - 全量 soul 拷贝（P0-T3：upsert excluded.* 覆盖 → 漏拷 = 写一次刷空 soul）；
 * - 非法 valid_end/mode 400 / 未知 id 404 / 跨租户三轴 403；content 不变 → embedding 不重算；
 * - audit：recordAudit L1 update；已失效行再 invalidate → 500（invalidateL1 false 语义原样沿用）；
 * - 薄封装序：upsert 必须先于 invalidate（soul 拷贝会回写既有 valid_end，序反 = 失效被抹回）。
 */
import { describe, it, expect } from "vitest";
import { handleAtomicInvalidate } from "../v2-router.js";
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
    occurred_at: "2026-10-14T00:00:00Z", valid_start: "2026-01-01T00:00:00Z", valid_end: null,
    certainty: "observed", source: "extraction", valence: 0.2, arousal: 0.1,
    significance: 0.8, sensitivity: "none", importance: 2,
    ...over,
  } as L1RecordRow;
}

function makeDeps(row: L1RecordRow | undefined, invalidateResult = true) {
  const upserts: Array<{ record: MemoryRecord; emb: Float32Array | undefined }> = [];
  const invalidations: Array<{ id: string; validEnd: string }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const deps: V2RouterDeps = {
    requestIsolation: ISO,
    getStore: () => ({
      getL1ByIds: (ids: string[]) => (row && ids.includes(row.record_id) ? [row] : []),
      upsertL1: (record: MemoryRecord, emb: Float32Array | undefined) => {
        order.push("upsert");
        upserts.push({ record, emb });
        return true;
      },
      invalidateL1: (id: string, validEnd: string) => {
        order.push("invalidate");
        invalidations.push({ id, validEnd });
        return invalidateResult;
      },
      appendAudit: (a: Record<string, unknown>) => {
        audits.push(a);
        return true;
      },
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as V2RouterDeps;
  return { deps, upserts, invalidations, audits, order };
}

describe("POST /atomic/invalidate（P1 task-8 bi-temporal 补口）", () => {
  it("invalidate 缺省：valid_end=now（ISO）+ version 自增 + soul 全量拷贝 + embedding 不重算", async () => {
    const { deps, upserts, invalidations, order } = makeDeps(l1Row("r1"));
    const before = Date.now();
    const out = await handleAtomicInvalidate({ record_id: "r1" }, {} as never, "rq-1", deps);
    const after = Date.now();
    expect(out.code).toBe(0);
    // 薄封装序：upsert 先、invalidate 后（序反 = soul 拷贝把失效抹回）
    expect(order).toEqual(["upsert", "invalidate"]);
    const ve = invalidations[0]!.validEnd;
    expect(invalidations[0]!.id).toBe("r1");
    expect(Number.isFinite(Date.parse(ve))).toBe(true);
    expect(Date.parse(ve)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(ve)).toBeLessThanOrEqual(after + 1000);
    const rec = upserts[0]!.record;
    expect(rec.version).toBe(2);
    expect(rec.content).toBe("内容r1");
    expect(upserts[0]!.emb).toBeUndefined();
    // P0-T3：soul 不得因失效写刷空
    expect(rec.occurred_at).toBe("2026-10-14T00:00:00Z");
    expect(rec.valid_start).toBe("2026-01-01T00:00:00Z");
    expect(rec.certainty).toBe("observed");
    expect(rec.valence).toBeCloseTo(0.2);
    expect(rec.significance).toBeCloseTo(0.8);
    expect(rec.sensitivity).toBe("none");
    expect(rec.importance).toBe(2);
    const d = out.data as { id: string; version: string; valid_end: string };
    expect(d.id).toBe("r1");
    expect(d.version).toBe("v2");
    expect(d.valid_end).toBe(ve);
  });

  it("invalidate 显式 valid_end：原样透传（ISO 合法即可）", async () => {
    const { deps, invalidations } = makeDeps(l1Row("r2"));
    const out = await handleAtomicInvalidate(
      { record_id: "r2", valid_end: "2026-12-31T00:00:00.000Z" }, {} as never, "rq-2", deps,
    );
    expect(out.code).toBe(0);
    expect(invalidations[0]!.validEnd).toBe("2026-12-31T00:00:00.000Z");
    expect((out.data as { valid_end: string }).valid_end).toBe("2026-12-31T00:00:00.000Z");
  });

  it("invalidate 非法 valid_end（乱串/非字符串/空串/空白）→ 400 且不落盘", async () => {
    for (const bad of ["not-a-date", 123, "", "   ", null]) {
      const { deps, upserts, invalidations } = makeDeps(l1Row("r3"));
      const out = await handleAtomicInvalidate({ record_id: "r3", valid_end: bad }, {} as never, "rq-3", deps);
      expect(out.code).toBe(400);
      expect(upserts).toHaveLength(0);
      expect(invalidations).toHaveLength(0);
    }
  });

  it("restore：valid_end 清空（空串直写）+ 不走 invalidateL1 + version 自增 + 响应 valid_end 为空串；body.valid_end 被忽略", async () => {
    const { deps, upserts, invalidations, order } = makeDeps(l1Row("r4", { valid_end: "2026-09-01T00:00:00.000Z" }));
    const out = await handleAtomicInvalidate(
      { record_id: "r4", mode: "restore", valid_end: "2026-12-31T00:00:00.000Z" }, {} as never, "rq-4", deps,
    );
    expect(out.code).toBe(0);
    expect(order).toEqual(["upsert"]);
    expect(invalidations).toHaveLength(0);
    const rec = upserts[0]!.record;
    expect(rec.valid_end).toBe("");
    expect(rec.version).toBe(2);
    expect(rec.valid_start).toBe("2026-01-01T00:00:00Z");
    const d = out.data as { id: string; version: string; valid_end: string };
    expect(d.id).toBe("r4");
    expect(d.version).toBe("v2");
    expect(d.valid_end).toBe("");
  });

  it("mode 非法 → 400 且不落盘", async () => {
    const { deps, upserts, invalidations } = makeDeps(l1Row("r5"));
    const out = await handleAtomicInvalidate({ record_id: "r5", mode: "delete" }, {} as never, "rq-5", deps);
    expect(out.code).toBe(400);
    expect(upserts).toHaveLength(0);
    expect(invalidations).toHaveLength(0);
  });

  it("缺 record_id / 未知 id 404", async () => {
    const { deps } = makeDeps(l1Row("r6"));
    expect((await handleAtomicInvalidate({}, {} as never, "rq-6", deps)).code).toBe(400);
    expect((await handleAtomicInvalidate({ record_id: "  " }, {} as never, "rq-6b", deps)).code).toBe(400);
    expect((await handleAtomicInvalidate({ record_id: "ghost" }, {} as never, "rq-6c", deps)).code).toBe(404);
  });

  it("跨租户/跨用户/跨代理 403（三轴，handleAtomicImportance 同款）", async () => {
    const { deps: d1 } = makeDeps(l1Row("r7", { team_id: "t-EVIL" }));
    expect((await handleAtomicInvalidate({ record_id: "r7" }, {} as never, "rq-7a", d1)).code).toBe(403);
    const { deps: d2 } = makeDeps(l1Row("r7b", { user_id: "u-EVIL" }));
    expect((await handleAtomicInvalidate({ record_id: "r7b" }, {} as never, "rq-7b", d2)).code).toBe(403);
    const { deps: d3 } = makeDeps(l1Row("r7c", { agent_id: "a-EVIL" }));
    expect((await handleAtomicInvalidate({ record_id: "r7c" }, {} as never, "rq-7c", d3)).code).toBe(403);
  });

  it("已失效行再 invalidate → 500（invalidateL1 false 语义：行不存在或已失效不覆盖）", async () => {
    const { deps, invalidations } = makeDeps(l1Row("r8", { valid_end: "2026-09-01T00:00:00.000Z" }), false);
    const out = await handleAtomicInvalidate({ record_id: "r8" }, {} as never, "rq-8", deps);
    expect(out.code).toBe(500);
    expect(String((out as { message?: string }).message ?? "")).toContain("失效写入失败");
    expect(invalidations).toHaveLength(1);
  });

  it("audit：recordAudit L1 update（record_id/version 透传）", async () => {
    const { deps, audits } = makeDeps(l1Row("r9"));
    const out = await handleAtomicInvalidate({ record_id: "r9" }, {} as never, "rq-9", deps);
    expect(out.code).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.record_id).toBe("r9");
    expect(audits[0]!.layer).toBe("L1");
    expect(audits[0]!.action).toBe("update");
    expect(audits[0]!.version).toBe(2);
  });
});
