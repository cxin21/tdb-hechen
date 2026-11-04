/**
 * P0：v2 编辑链「取行 → 重建 → upsert」不得刷空行级原话溯源 source_message_ids。
 *
 * 三条真实重建路径（都以 getL1ByIds 取行、随即 upsertL1 整行覆盖）：
 *  - handleAtomicUpdate（v2-router.ts:1488-1524）
 *  - handleAtomicImportance（v2-router.ts:1600-1633）
 *  - handleAtomicInvalidate（v2-router.ts:1709-1742）
 * upsert excluded.* 覆盖语义 = 漏拷即刷空（P0-T3 家族）；本套件走真实 handler 钉住。
 */
import { describe, it, expect } from "vitest";
import { handleAtomicInvalidate, handleAtomicImportance, handleAtomicUpdate } from "../v2-router.js";
import type { V2RouterDeps } from "../v2-router.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";
import type { L1SearchResult } from "../../core/store/types.js";

const ISO = { teamId: "t-1", userId: "u-1", agentId: "a-1", sessionId: "s-1" };

function row(id: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content: "内容" + id,
    type: "work_fact",
    priority: 50,
    scene_name: "",
    score: 0,
    timestamp_str: "2026-11-01T00:00:00Z",
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "",
    session_id: "s-1",
    team_id: "t-1",
    task_id: "",
    user_id: "u-1",
    agent_id: "a-1",
    metadata_json: "{}",
    created_time: "2026-11-01T00:00:00Z",
    occurred_at: "2026-11-01T00:00:00Z",
    valid_start: "2026-11-01T00:00:00Z",
    valid_end: "",
    certainty: "inferred",
    source: "extraction",
    valence: 0.2,
    arousal: 0.1,
    significance: 0.8,
    sensitivity: "none",
    importance: 6,
    source_message_ids: ["m1", "m2"],
    ...over,
  };
}

function makeDeps(existing: L1SearchResult | undefined) {
  const upserts: MemoryRecord[] = [];
  const deps = {
    requestIsolation: ISO,
    getStore: () => ({
      getL1ByIds: (ids: string[]) => (existing && ids.includes(existing.record_id) ? [existing] : []),
      upsertL1: (record: MemoryRecord) => {
        upserts.push(record);
        return true;
      },
      invalidateL1: () => true,
      recordAudit: () => undefined,
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    getEmbedding: () => undefined,
  } as unknown as V2RouterDeps;
  return { deps, upserts };
}

describe("v2 编辑链不得刷空 source_message_ids（P0-T3 家族）", () => {
  it("handleAtomicUpdate：改 content 后原话溯源逐位保留", async () => {
    const { deps, upserts } = makeDeps(row("u1"));
    const out = await handleAtomicUpdate({ id: "u1", content: "改后的内容" }, {} as never, "rq-u1", deps);
    expect(out.code).toBe(0);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].source_message_ids).toEqual(["m1", "m2"]);
    expect(upserts[0].content).toBe("改后的内容");
  });

  it("handleAtomicImportance：改重要度后原话溯源逐位保留", async () => {
    const { deps, upserts } = makeDeps(row("u2"));
    const out = await handleAtomicImportance({ id: "u2", importance: 9 }, {} as never, "rq-u2", deps);
    expect(out.code).toBe(0);
    expect(upserts[0].source_message_ids).toEqual(["m1", "m2"]);
    expect(upserts[0].importance).toBe(9);
  });

  it("handleAtomicInvalidate：失效/恢复后原话溯源逐位保留", async () => {
    const { deps, upserts } = makeDeps(row("u3"));
    const out = await handleAtomicInvalidate({ record_id: "u3", mode: "invalidate" }, {} as never, "rq-u3", deps);
    expect(out.code).toBe(0);
    expect(upserts[0].source_message_ids).toEqual(["m1", "m2"]);
  });
});
