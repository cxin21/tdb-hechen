/**
 * D-4（2026-09-22 拍板）：recurrence 确定性门单一源单元测试。
 * RED 先行：normalizeRecurrence / recurrenceLabel 模块缺失或口径不符全 failed。
 * 口径铁律：LLM 只提议、门裁决——形状非法→整体 undefined 不落库（宁缺毋滥）；
 * note 可省略（省略时徽章走 cadence+anchor 中文映射）。
 */
import { describe, it, expect } from "vitest";
import { normalizeRecurrence, recurrenceLabel, isRecurrenceMeta } from "../l1-extractor.js";

describe("normalizeRecurrence（确定性门）", () => {
  it("合法形状全通过（weekly/biweekly/daily/monthly/quarterly/yearly）", () => {
    expect(normalizeRecurrence({ cadence: "weekly", anchor: "WED", note: "每周三例会" })).toEqual({
      cadence: "weekly", anchor: "WED", note: "每周三例会",
    });
    expect(normalizeRecurrence({ cadence: "biweekly", anchor: "FRI", note: "每两周评审" })).toEqual({
      cadence: "biweekly", anchor: "FRI", note: "每两周评审",
    });
    expect(normalizeRecurrence({ cadence: "daily", note: "每天早上六点" })).toEqual({
      cadence: "daily", anchor: null, note: "每天早上六点",
    });
    expect(normalizeRecurrence({ cadence: "monthly", anchor: "1", note: "每月初一还贷" })).toEqual({
      cadence: "monthly", anchor: "1", note: "每月初一还贷",
    });
    expect(normalizeRecurrence({ cadence: "quarterly", anchor: null, note: "季度复盘" })).toEqual({
      cadence: "quarterly", anchor: null, note: "季度复盘",
    });
    expect(normalizeRecurrence({ cadence: "yearly", note: "每年十月体检" })).toEqual({
      cadence: "yearly", anchor: null, note: "每年十月体检",
    });
    expect(normalizeRecurrence({ cadence: "weekly", anchor: "WED" })).toEqual({
      cadence: "weekly", anchor: "WED", note: "",
    });
  });

  it("weekly/biweekly 缺 anchor 或非法星期 → 整体 undefined", () => {
    expect(normalizeRecurrence({ cadence: "weekly", note: "每周例会" })).toBeUndefined();
    expect(normalizeRecurrence({ cadence: "weekly", anchor: "WEDNESDAY", note: "每周例会" })).toBeUndefined();
    expect(normalizeRecurrence({ cadence: "biweekly", anchor: "XXX", note: "每两周评审" })).toBeUndefined();
  });

  it("monthly anchor 非法 → undefined；无具体日 → null 宁缺毋滥", () => {
    expect(normalizeRecurrence({ cadence: "monthly", anchor: "32", note: "每月房贷" })).toBeUndefined();
    expect(normalizeRecurrence({ cadence: "monthly", anchor: "0", note: "每月房贷" })).toBeUndefined();
    expect(normalizeRecurrence({ cadence: "monthly", note: "每月阿凯生日" })).toEqual({
      cadence: "monthly", anchor: null, note: "每月阿凯生日",
    });
  });

  it("quarterly/yearly anchor 非 MM-DD → undefined", () => {
    expect(normalizeRecurrence({ cadence: "yearly", anchor: "1-15", note: "年度体检" })).toBeUndefined();
    expect(normalizeRecurrence({ cadence: "quarterly", anchor: "20260915", note: "季度复盘" })).toBeUndefined();
  });

  it("daily 携带 anchor → undefined（daily 无锚）", () => {
    expect(normalizeRecurrence({ cadence: "daily", anchor: "MON", note: "每天早操" })).toBeUndefined();
  });

  it("note 超 20 字 → 整体 undefined；空/缺失按省略处理", () => {
    expect(normalizeRecurrence({ cadence: "weekly", anchor: "WED", note: "x".repeat(21) })).toBeUndefined();
    expect(normalizeRecurrence({ cadence: "weekly", anchor: "WED", note: "" })).toEqual({
      cadence: "weekly", anchor: "WED", note: "",
    });
    expect(normalizeRecurrence({ cadence: "weekly", anchor: "WED", note: "   " })).toEqual({
      cadence: "weekly", anchor: "WED", note: "",
    });
  });

  it("非法 cadence / 非对象输入 → undefined", () => {
    expect(normalizeRecurrence({ cadence: "hourly", anchor: null, note: "每小时" })).toBeUndefined();
    expect(normalizeRecurrence("每周三")).toBeUndefined();
    expect(normalizeRecurrence(null)).toBeUndefined();
    expect(normalizeRecurrence(undefined)).toBeUndefined();
    expect(normalizeRecurrence(42)).toBeUndefined();
  });

  it("note 首尾空白裁剪（>20 字按裁剪后计）", () => {
    expect(normalizeRecurrence({ cadence: "weekly", anchor: "WED", note: "  每周三例会  " })).toEqual({
      cadence: "weekly", anchor: "WED", note: "每周三例会",
    });
  });
});

describe("isRecurrenceMeta（遗忘保护守卫：形状重验）", () => {
  it("合法形状 true；非法/垃圾 false", () => {
    expect(isRecurrenceMeta({ cadence: "weekly", anchor: "WED", note: "每周三例会" })).toBe(true);
    expect(isRecurrenceMeta({ cadence: "daily", anchor: null, note: "" })).toBe(true);
    expect(isRecurrenceMeta({ cadence: "weekly", anchor: null, note: "" })).toBe(false);
    expect(isRecurrenceMeta({ cadence: "weekly", note: "无锚" })).toBe(false);
    expect(isRecurrenceMeta("每周三")).toBe(false);
    expect(isRecurrenceMeta(null)).toBe(false);
    expect(isRecurrenceMeta({ cadence: "weekly", anchor: "WED", note: "x".repeat(21) })).toBe(false);
  });
});

describe("recurrenceLabel（徽章文本：note 首选，缺省 cadence+anchor 中文映射）", () => {
  it("note 非空 → 直接用 note", () => {
    expect(recurrenceLabel({ cadence: "weekly", anchor: "WED", note: "每周三早上九点例会" })).toBe("每周三早上九点例会");
    expect(recurrenceLabel({ cadence: "monthly", anchor: "15", note: "还房贷" })).toBe("还房贷");
  });
  it("无 note → cadence+anchor 中文映射", () => {
    expect(recurrenceLabel({ cadence: "weekly", anchor: "WED", note: "" })).toBe("每周三");
    expect(recurrenceLabel({ cadence: "biweekly", anchor: "FRI", note: "" })).toBe("每两周五");
    expect(recurrenceLabel({ cadence: "daily", anchor: null, note: "" })).toBe("每天");
    expect(recurrenceLabel({ cadence: "monthly", anchor: "15", note: "" })).toBe("每月15日");
    expect(recurrenceLabel({ cadence: "monthly", anchor: null, note: "" })).toBe("每月");
    expect(recurrenceLabel({ cadence: "quarterly", anchor: null, note: "" })).toBe("每季度");
    expect(recurrenceLabel({ cadence: "yearly", anchor: null, note: "" })).toBe("每年");
  });
  it("非法/缺失 → undefined（宁缺毋滥，不渲染徽章）", () => {
    expect(recurrenceLabel({ cadence: "weekly", note: "缺锚" })).toBeUndefined();
    expect(recurrenceLabel(null)).toBeUndefined();
    expect(recurrenceLabel(undefined)).toBeUndefined();
    expect(recurrenceLabel("每周三")).toBeUndefined();
  });
});
