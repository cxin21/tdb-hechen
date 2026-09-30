/**
 * F-CLUSTER 折叠接线修复 RED（2026-09-29）：searchHybrid（SQLite 主形态 fallback 路径）
 * 返回对象缺 metas 字段 → fallback 分支无法执行 foldByDurative 持续态吸收（结构性不可达）。
 * 行为级 RED 已实证：临时网关 A/B 全 block sha256 逐字节相同（foldClusterEnabled on/off 零差异）。
 */
import { describe, it, expect } from "vitest";
import { searchHybrid, recordToFormatable } from "./auto-recall.js";

describe("searchHybrid fallback 折叠接线契约", () => {
  const stubStore = {
    isFtsAvailable: () => false,
    searchL1Vectors: async () => [],
    searchL1Records: async () => [],
    getL1Links: async () => [],
    getNeighbors: async () => [],
  } as never;

  it("T5 返回对象含 metas 字段（折叠所需 recordId/evidenceIds 元数据）", async () => {
    const h = await searchHybrid(
      "测试查询",
      "/tmp/nonexistent",
      8,
      0.3,
      stubStore,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(Array.isArray(h.lines)).toBe(true);
    expect(h.metas).toBeDefined();
    expect(Array.isArray(h.metas)).toBe(true);
  });

  it("T6 FTS keyword 通道基座携带折叠元数据：recordId + evidenceIds", () => {
    const rec = {
      id: "m_fts_test_001",
      type: "work_fact",
      content: "内容",
      scene_name: "会话",
      metadata: { evidence_record_ids: ["src_a", "src_b"] },
      timestamps: ["2026-09-29T00:00:00.000Z"],
    } as never;
    const f = recordToFormatable(rec);
    expect(f.recordId).toBe("m_fts_test_001");
    expect(f.evidenceIds).toEqual(["src_a", "src_b"]);
  });
});
