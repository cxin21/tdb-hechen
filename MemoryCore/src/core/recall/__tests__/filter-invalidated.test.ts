/** GROW-EVO P2：filterInvalidated 纯函数套件（§2.3）。
 *  Task 8（bi-temporal 补口，M4 #6）：isOutsideValidityWindow 完整区间语义
 *  （valid_start 未来生效同样排除；解析失败保留）+ 钩子路/工具路一致性钉死。 */
import { describe, expect, it } from "vitest";
import { filterInvalidated, isInvalidated, isOutsideValidityWindow } from "../filter-invalidated.js";
import { filterByValidity } from "../../tools/memory-search.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");
type Item = { id: string; valid_end?: string | null };
const mk = (id: string, valid_end?: string | null): Item => ({ id, valid_end });

describe("GROW-EVO P2 filterInvalidated", () => {
  it("valid_end 过去 → 剔除；未来 → 保留", () => {
    const items = [mk("past", "2026-09-01T00:00:00.000Z"), mk("future", "2026-12-01T00:00:00.000Z")];
    const out = filterInvalidated(items, NOW);
    expect(out.map((i) => i.id)).toEqual(["future"]);
  });
  it("null / undefined / 空串 → 保留", () => {
    const items = [mk("a", null), mk("b", undefined), mk("c", "")];
    expect(filterInvalidated(items, NOW).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
  it("valid_end 恰等于 now → 剔除（≤ 语义）", () => {
    expect(isInvalidated(mk("x", "2026-09-15T12:00:00.000Z"), NOW)).toBe(true);
  });
  it("解析失败的 valid_end → 保留（宁缺毋滥）", () => {
    expect(isInvalidated(mk("y", "not-a-date"), NOW)).toBe(false);
  });
  it("边界相交语义：窗口 ∩ [valid_start, valid_end) 的时点判断由调用方传 now 完成", () => {
    const past = filterInvalidated([mk("z", "2026-06-01T00:00:00.000Z")], new Date("2026-05-01T00:00:00.000Z"));
    expect(past.map((i) => i.id)).toEqual(["z"]); // 时间旅行：now 换成查询时点
  });
});

// ═══════════════ Task 8（bi-temporal 补口，M4 #6）═══════════════

const NOW_T8 = new Date("2026-09-15T12:00:00.000Z");
const VS_PAST = "2026-01-01T00:00:00.000Z";
const VS_FUTURE = "2026-12-01T00:00:00.000Z";
const VE_PAST = "2026-09-01T00:00:00.000Z";
const VE_FUTURE = "2026-12-20T00:00:00.000Z";

describe("Task 8 isOutsideValidityWindow（完整区间 valid_start ≤ now ≤/＜ valid_end）", () => {
  it("valid_end 过去 → 排除；未来 → 保留（isInvalidated 语义逐位保持）", () => {
    expect(isOutsideValidityWindow({ valid_end: VE_PAST }, NOW_T8)).toBe(true);
    expect(isOutsideValidityWindow({ valid_end: VE_FUTURE }, NOW_T8)).toBe(false);
  });
  it("valid_end 恰等于 now → 排除（≤ 语义与 isInvalidated 一致）", () => {
    expect(isOutsideValidityWindow({ valid_end: "2026-09-15T12:00:00.000Z" }, NOW_T8)).toBe(true);
  });
  it("valid_start 未来 → 排除（未来生效记忆补口）", () => {
    expect(isOutsideValidityWindow({ valid_start: VS_FUTURE }, NOW_T8)).toBe(true);
  });
  it("valid_start 过去/恰等于 now → 保留（vs ≤ now 即生效中）", () => {
    expect(isOutsideValidityWindow({ valid_start: VS_PAST }, NOW_T8)).toBe(false);
    expect(isOutsideValidityWindow({ valid_start: "2026-09-15T12:00:00.000Z" }, NOW_T8)).toBe(false);
  });
  it("区间内 → 保留；valid_start 与 valid_end 双夹窗外 → 排除", () => {
    expect(isOutsideValidityWindow({ valid_start: VS_PAST, valid_end: VE_FUTURE }, NOW_T8)).toBe(false);
    expect(isOutsideValidityWindow({ valid_start: "2026-08-01T00:00:00.000Z", valid_end: VE_PAST }, NOW_T8)).toBe(true);
  });
  it("解析失败的 valid_start / valid_end → 保留（宁缺毋滥，不误删）", () => {
    expect(isOutsideValidityWindow({ valid_start: "garbage" }, NOW_T8)).toBe(false);
    expect(isOutsideValidityWindow({ valid_end: "not-a-date" }, NOW_T8)).toBe(false);
    expect(isOutsideValidityWindow({ valid_start: "garbage", valid_end: "not-a-date" }, NOW_T8)).toBe(false);
  });
  it("null / undefined / 空串 → 保留（sqlite 行 valid_start: null 直传形态）", () => {
    expect(isOutsideValidityWindow({}, NOW_T8)).toBe(false);
    expect(isOutsideValidityWindow({ valid_start: null, valid_end: null }, NOW_T8)).toBe(false);
    expect(isOutsideValidityWindow({ valid_start: "", valid_end: "" }, NOW_T8)).toBe(false);
  });
  it("时间旅行：now 传查询时点（as-of 语义保持）", () => {
    const asOfMay = new Date("2026-05-01T00:00:00.000Z");
    // 5 月时点：valid_start=1 月已生效、valid_end=9 月未到 → 生效中
    expect(isOutsideValidityWindow({ valid_start: VS_PAST, valid_end: VE_PAST }, asOfMay)).toBe(false);
    // 10 月时点：valid_end=9 月已过 → 排除
    expect(isOutsideValidityWindow({ valid_start: VS_PAST, valid_end: VE_PAST }, NOW_T8)).toBe(true);
  });
});

describe("Task 8 钩子路/工具路一致性（同一批行同 include/exclude 结论）", () => {
  type WinRow = { id: string; valid_start?: string | null; valid_end?: string | null };
  const batch: WinRow[] = [
    { id: "normal", valid_start: VS_PAST, valid_end: null },
    { id: "invalidated", valid_start: VS_PAST, valid_end: VE_PAST },
    { id: "future", valid_start: VS_FUTURE, valid_end: VE_FUTURE },
    { id: "parse-fail", valid_start: "oops", valid_end: "not-a-date" },
    { id: "no-window", valid_start: null, valid_end: null },
    { id: "open-ended", valid_start: VS_PAST, valid_end: "" },
  ];
  // 钩子路判定 = isOutsideValidityWindow（对齐后 auto-recall 三处排除点的共享谓词）
  const hookVerdict = (rows: WinRow[], now?: Date): string[] =>
    rows.filter((r) => !isOutsideValidityWindow(r, now)).map((r) => r.id).sort();
  // 工具路判定 = filterByValidity（对齐后 memory-search 两 trim 点共用过滤）
  const toolVerdict = (rows: WinRow[], now?: Date): string[] =>
    (filterByValidity(rows as unknown as Array<{ id: string; valid_start?: string; valid_end?: string }>, now) as WinRow[])
      .map((r) => r.id).sort();

  it("缺省分支（无 validityNow）：两路同判", () => {
    expect(toolVerdict(batch)).toEqual(hookVerdict(batch));
  });
  it("validityNow 分支：两路同判", () => {
    expect(toolVerdict(batch, NOW_T8)).toEqual(hookVerdict(batch, NOW_T8));
    expect(toolVerdict(batch, new Date("2026-05-01T00:00:00.000Z"))).toEqual(hookVerdict(batch, new Date("2026-05-01T00:00:00.000Z")));
  });
  it("保留集恰为 normal+parse-fail+no-window+open-ended（排除集=invalidated+future）", () => {
    expect(hookVerdict(batch)).toEqual(["no-window", "normal", "open-ended", "parse-fail"].sort());
  });
});