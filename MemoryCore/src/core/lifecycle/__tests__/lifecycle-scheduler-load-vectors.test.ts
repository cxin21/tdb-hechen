/**
 * B1 修正接线钉（2026-11-02）：lifecycle tick 必须把 store.getL1VectorsByIds 传给巩固 worker，
 * 否则池内记录会被逐条重嵌（生产实证：88 次 429/分钟、tick 10 分钟不结束）。
 * 变异：摘掉 scheduler 的 loadVectors 透传 → 本用例如期红。
 */
import { describe, it, expect, vi } from "vitest";
import { startLifecycleScheduler } from "../lifecycle-scheduler.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function poolRecord(id: string): MemoryRecord {
  const ts = "2026-11-01T00:00:00.000Z";
  return {
    id,
    content: `周末去爬山拍照（${id}）`,
    type: "episodic",
    priority: 60,
    scene_name: "s",
    source_message_ids: [],
    metadata: { subject: "随想" },
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    version: 1,
    sessionKey: "s",
    sessionId: "s",
    occurred_at: ts,
    certainty: "observed",
    significance: 0.6,
    teamId: "t",
    userId: "u",
    agentId: "a",
  } as unknown as MemoryRecord;
}

describe("lifecycle scheduler → consolidation loadVectors 接线", () => {
  it("池内向量从 store 批量读（embed 零调用），不重新嵌入", async () => {
    const records = [poolRecord("p1"), poolRecord("p2"), poolRecord("p3")];
    const getL1VectorsByIds = vi.fn(async (ids: string[]) => {
      const m = new Map<string, Float32Array>();
      for (const id of ids) m.set(id, new Float32Array([1, 1, 1, 1]));
      return m;
    });
    const store = {
      queryL1Records: vi.fn(async () => records.map((r) => ({ ...r, record_id: r.id }))),
      getL1VectorsByIds,
      countL1: vi.fn(async () => records.length),
    };
    const embed = vi.fn(async () => new Float32Array([1, 1, 1, 1]));
    const stop = startLifecycleScheduler({
      store: store as never,
      llmRunner: { run: vi.fn(async () => "{}") } as never,
      config: {
        intervalMs: 60_000,
        consolidation: {
          enabled: true,
          minCount: 99,
          minSpanDays: 0,
          attributeGrouping: { enabled: true, minCos: 0.82 },
        } as never,
        forgetting: { enabled: false } as never,
        anchorDiscovery: { enabled: false } as never,
        reflection: { enabled: false } as never,
      },
      embeddingService: { embed } as never,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
    });
    for (let i = 0; i < 60 && getL1VectorsByIds.mock.calls.length === 0; i++) await sleep(20);
    stop();

    expect(getL1VectorsByIds).toHaveBeenCalled();
    expect((getL1VectorsByIds.mock.calls[0][0] as string[]).sort()).toEqual(["p1", "p2", "p3"]);
    expect(embed).not.toHaveBeenCalled();
  });
});
