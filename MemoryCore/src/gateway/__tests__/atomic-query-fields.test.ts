/**
 * B 项（ADR-0025 决定 9，2026-11-04）：/v3/atomic 出参 shape 的 event_end_at。
 *
 * 语义分工（与 memory_search 同口径，单一源）：
 *  - updated_at  = 行最近更新时间（l1_records.updated_time；query 路既有行为已正确）；
 *  - event_end_at = 事件结束时刻（l1_records.timestamp_end；search 路行上由
 *                  MemorySearchResultItem.event_end_at 承载）。
 * 两个 shape 必须都产出 event_end_at，否则 UI 属性表一端能看、一端恒缺列。
 */
import { describe, expect, it } from "vitest";
import { handleAtomicQueryShape, handleAtomicSearchShape } from "../atomic-query-fields.js";

describe("B 项：atomic shape 出参 event_end_at", () => {
  it("handleAtomicQueryShape：event_end_at 取 timestamp_end，updated_at 仍取 updated_time", () => {
    const out = handleAtomicQueryShape({
      record_id: "q1",
      content: "内容",
      type: "work_fact",
      updated_time: "2026-11-02T03:04:05Z",
      timestamp_end: "2026-11-01T00:00:00Z",
      timestamp_str: "2026-10-31T00:00:00Z",
    });
    expect(out.event_end_at).toBe("2026-11-01T00:00:00Z");
    expect(out.updated_at).toBe("2026-11-02T03:04:05Z");
  });

  it("handleAtomicQueryShape：timestamp_end 空串 → event_end_at undefined（宁缺毋滥，不伪造）", () => {
    const out = handleAtomicQueryShape({ record_id: "q2", timestamp_end: "" });
    expect(out.event_end_at).toBeUndefined();
  });

  it("handleAtomicQueryShape：updated_time 空串 → updated_at 回退 timestamp_end（不吐空串）", () => {
    const out = handleAtomicQueryShape({
      record_id: "q3",
      updated_time: "",
      timestamp_end: "2026-11-01T00:00:00Z",
    });
    expect(out.updated_at).toBe("2026-11-01T00:00:00Z");
    expect(out.event_end_at).toBe("2026-11-01T00:00:00Z");
  });

  it("handleAtomicSearchShape：updated_at 空串 → 回退 event_end_at（不吐空串）", () => {
    const out = handleAtomicSearchShape({
      id: "s3",
      updated_at: "",
      event_end_at: "2026-11-01T00:00:00Z",
    });
    expect(out.updated_at).toBe("2026-11-01T00:00:00Z");
  });

  it("handleAtomicSearchShape：event_end_at 取行 event_end_at（memory_search 映射结果）", () => {
    const out = handleAtomicSearchShape({
      id: "s1",
      type: "work_fact",
      content: "内容",
      score: 0.9,
      updated_at: "2026-11-02T03:04:05Z",
      event_end_at: "2026-11-01T00:00:00Z",
    });
    expect(out.event_end_at).toBe("2026-11-01T00:00:00Z");
    expect(out.updated_at).toBe("2026-11-02T03:04:05Z");
  });

  it("handleAtomicSearchShape：event_end_at 缺省 → undefined（不回流到 updated_at）", () => {
    const out = handleAtomicSearchShape({ id: "s2", updated_at: "2026-11-02T03:04:05Z" });
    expect(out.event_end_at).toBeUndefined();
    expect(out.updated_at).toBe("2026-11-02T03:04:05Z");
  });
});
