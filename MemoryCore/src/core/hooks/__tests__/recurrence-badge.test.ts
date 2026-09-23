/**
 * D-4（2026-09-22 拍板）：周期徽章与双通道 formatable 透传测试。
 * RED 先行：formatMemoryLine 徽章 / vectorResultToFormatable / ftsResultToFormatable
 * 透传列缺失全 failed（D-3 丢值点 ④⑥ 同族——漏一个=徽章单通道）。
 */
import { describe, it, expect } from "vitest";
import { formatMemoryLine, vectorResultToFormatable, ftsResultToFormatable } from "../auto-recall.js";

const REC = { cadence: "weekly", anchor: "WED", note: "每周三早上九点例会" };
const REC_NO_NOTE = { cadence: "monthly", anchor: "15", note: "" };

describe("formatMemoryLine 周期徽章", () => {
  it("note 非空 → soul[] 含 周期:note", () => {
    const line = formatMemoryLine({
      type: "episodic", content: "用户每周三早九点例会", recurrence: REC,
    } as never);
    expect(line).toContain("周期:每周三早上九点例会");
    expect(line).toMatch(/^-\s+\[episodic\]/);
  });
  it("note 省略 → cadence+anchor 中文映射（每月15日）", () => {
    const line = formatMemoryLine({
      type: "episodic", content: "x", recurrence: REC_NO_NOTE,
    } as never);
    expect(line).toContain("周期:每月15日");
  });
  it("recurrence 缺失/非法 → 无徽章（逐位现状）", () => {
    expect(formatMemoryLine({ type: "episodic", content: "x" } as never)).not.toContain("周期:");
    expect(formatMemoryLine({ type: "episodic", content: "x", recurrence: "每周三" } as never)).not.toContain("周期:");
  });
  it("与既有 soul 徽章共存（敏感+周期同行，行首结构不破坏）", () => {
    const line = formatMemoryLine({
      type: "episodic", content: "x", occurred_at: "2026-09-22T01:00:00Z",
      sensitivity: "health", recurrence: REC,
    } as never);
    expect(line).toContain("敏感:健康");
    expect(line).toContain("周期:每周三早上九点例会");
    expect(line).toMatch(/^-\s+\[[^\]]+\]\s+.*·soul\[/);
  });
});

function mkVector(metaJson: string) {
  return {
    record_id: "m_v", id: "m_v", type: "episodic", content: "c", score: 1,
    metadata_json: metaJson,
  } as never;
}
function mkFts(metaJson: string) {
  return {
    record_id: "m_f", id: "m_f", type: "episodic", content: "c",
    metadata_json: metaJson,
  } as never;
}

describe("vector/fts 双通道 formatable 周期透传（D-3 丢值点④⑥同族）", () => {
  it("vectorResultToFormatable 从 metadata_json 提取 recurrence（合法形状）", () => {
    const m = vectorResultToFormatable(mkVector(JSON.stringify({ recurrence: REC })));
    expect(m.recurrence).toEqual(REC);
  });
  it("ftsResultToFormatable 从 metadata_json 提取 recurrence（合法形状）", () => {
    const m = ftsResultToFormatable(mkFts(JSON.stringify({ recurrence: REC_NO_NOTE })));
    expect(m.recurrence).toEqual(REC_NO_NOTE);
  });
  it("非法形状/缺失 → undefined（不透传垃圾）", () => {
    expect(vectorResultToFormatable(mkVector(JSON.stringify({ recurrence: "每周三" }))).recurrence).toBeUndefined();
    expect(vectorResultToFormatable(mkVector("{}")).recurrence).toBeUndefined();
    expect(ftsResultToFormatable(mkFts("not-json")).recurrence).toBeUndefined();
  });
});
