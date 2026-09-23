/**
 * F-R12（flowtest 对抗审查发现，2026-09-23）：recordToFormatable（native-hybrid 路径）
 * 丢 sensitivity（D-3）+ recurrence（D-4）透传——DB 行敏感=finance 但注入行无「敏感:财务」徽章。
 * RED 先行：透传列缺失全 failed。
 */
import { describe, expect, it } from "vitest";
import { formatMemoryLine, recordToFormatable } from "../auto-recall.js";

const REC = { cadence: "weekly", anchor: "WED", note: "每周三例会" };

describe("recordToFormatable 敏感/周期透传（F-R12）", () => {
  it("MemoryRecord sensitivity=finance → formatable 携带", () => {
    const m = recordToFormatable({
      type: "episodic",
      content: "x",
      scene_name: "s",
      metadata: {},
      timestamps: ["2026-09-23T01:00:00Z"],
      sensitivity: "finance",
    } as never);
    expect(m.sensitivity).toBe("finance");
  });

  it("metadata.recurrence 合法 → formatable 携带（与 vector/fts 双通道成对）", () => {
    const m = recordToFormatable({
      type: "episodic",
      content: "x",
      scene_name: "s",
      metadata: { recurrence: REC },
      timestamps: [],
    } as never);
    expect(m.recurrence).toEqual(REC);
  });

  it("注入行渲染出 敏感:财务 徽章（用户看得到）", () => {
    const line = formatMemoryLine({
      type: "episodic",
      content: "用户每月十五号按时偿还房贷八千三百元",
      scene_name: "s",
      sensitivity: "finance",
    } as never);
    expect(line).toContain("敏感:财务");
  });

  it("缺失字段不造值（undefined 保持，逐位现状）", () => {
    const m = recordToFormatable({
      type: "episodic",
      content: "x",
      scene_name: "s",
      metadata: {},
      timestamps: [],
    } as never);
    expect(m.sensitivity).toBeUndefined();
    expect(m.recurrence).toBeUndefined();
  });
});
