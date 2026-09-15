/** GROW-EVO P2：filterInvalidated 纯函数套件（§2.3）。 */
import { describe, expect, it } from "vitest";
import { filterInvalidated, isInvalidated } from "../filter-invalidated.js";

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