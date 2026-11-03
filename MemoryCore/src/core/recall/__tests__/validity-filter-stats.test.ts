/**
 * B2 读侧可观测性：validityFilterStats 纯函数套件（TDD RED 先行）。
 *
 * 目的：读侧现在只有"丢不丢"的谓词（shouldHardDropValidity / validityStateOf），
 * 却没有任何"丢了几行"的可算数值——auto-recall 的 journal 因此无法登记
 * validEndFiltered（grep 全仓 0 命中，2026-11-02 取证）。本函数把同一批行的
 * 效期状态分布与"该通道会丢多少"一次算清，供 journal/排查消费。
 *
 * 纪律：不引入新语义——active/expired/future 一律来自 validityStateOf，
 * dropped 一律等价于 shouldHardDropValidity 为 true 的行数（一致性用例逐行断言）。
 */
import { describe, expect, it } from "vitest";
import { shouldHardDropValidity, validityFilterStats, validityStateOf } from "../validity-policy.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");
type Row = { id: string; valid_start?: string | null; valid_end?: string | null };
const mk = (id: string, valid_start?: string | null, valid_end?: string | null): Row => ({
  id,
  valid_start,
  valid_end,
});

describe("validityFilterStats", () => {
  it("空数组 / 空输入 → 全 0（零行不炸）", () => {
    expect(validityFilterStats([], NOW, "hard")).toEqual({ active: 0, expired: 0, future: 0, dropped: 0 });
  });

  it("hard：active/expired/future 计数正确，dropped = expired + future", () => {
    const rows = [
      mk("a1", "2026-01-01T00:00:00.000Z", null), // active
      mk("a2", null, "2026-12-01T00:00:00.000Z"), // active（未来失效）
      mk("e1", "2026-01-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"), // expired
      mk("e2", null, "2026-09-15T12:00:00.000Z"), // expired（恰好等于 now，≤ 语义）
      mk("f1", "2099-12-01T00:00:00.000Z", null), // future
    ];
    expect(validityFilterStats(rows, NOW, "hard")).toEqual({ active: 2, expired: 2, future: 1, dropped: 3 });
  });

  it("soft：expired 降权保留 → dropped 只数 future", () => {
    const rows = [
      mk("a1", null, null),
      mk("e1", null, "2026-09-01T00:00:00.000Z"),
      mk("f1", "2099-12-01T00:00:00.000Z", null),
    ];
    expect(validityFilterStats(rows, NOW, "soft")).toEqual({ active: 1, expired: 1, future: 1, dropped: 1 });
  });

  it("off：通道完全退出 → dropped = 0（含 future；与 shouldHardDropValidity(off) 一致）", () => {
    const rows = [mk("e1", null, "2026-09-01T00:00:00.000Z"), mk("f1", "2099-12-01T00:00:00.000Z", null)];
    expect(validityFilterStats(rows, NOW, "off")).toEqual({ active: 0, expired: 1, future: 1, dropped: 0 });
  });

  it("脏数据 fail-open：null / 空串 / 非法日期 → 计入 active，不丢（宁缺毋滥）", () => {
    const rows = [
      mk("n1", null, null),
      mk("s1", "", ""),
      mk("x1", "garbage", "not-a-date"),
      mk("x2", undefined, "2026-13-45T99:99:99Z"),
    ];
    expect(validityFilterStats(rows, NOW, "hard")).toEqual({ active: 4, expired: 0, future: 0, dropped: 0 });
  });

  it("accessors：自定义字段名生效（t0/t1），与原字段并行不串扰", () => {
    const custom = [
      { id: "c1", t0: null as string | null, t1: null as string | null },
      { id: "c2", t0: null as string | null, t1: "2026-09-01T00:00:00.000Z" as string | null },
      { id: "c3", t0: "2099-01-01T00:00:00.000Z" as string | null, t1: null as string | null },
    ];
    const stats = validityFilterStats(custom, NOW, "hard", {
      validStart: (r) => r.t0,
      validEnd: (r) => r.t1,
    });
    expect(stats).toEqual({ active: 1, expired: 1, future: 1, dropped: 2 });
  });

  it("now 传毫秒数等价于传 Date（同值同结果）", () => {
    const rows = [mk("e1", null, "2026-09-01T00:00:00.000Z"), mk("a1", null, null)];
    expect(validityFilterStats(rows, NOW.getTime(), "hard")).toEqual(validityFilterStats(rows, NOW, "hard"));
  });

  it("一致性：dropped 逐行等价于 shouldHardDropValidity（三种 mode 全对账）", () => {
    const rows = [
      mk("a1", "2026-01-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"),
      mk("e1", null, "2026-09-01T00:00:00.000Z"),
      mk("f1", "2099-12-01T00:00:00.000Z", null),
      mk("x1", "garbage", "not-a-date"),
    ];
    for (const mode of ["hard", "soft", "off"] as const) {
      const expected = rows.filter((r) => shouldHardDropValidity(r, NOW, mode)).length;
      expect(validityFilterStats(rows, NOW, mode).dropped).toBe(expected);
      // 分布自洽：三类之和恒等于总行数
      const s = validityFilterStats(rows, NOW, mode);
      expect(s.active + s.expired + s.future).toBe(rows.length);
      expect(s.active).toBe(rows.filter((r) => validityStateOf(r, NOW) === "active").length);
    }
  });

  it("单条行也可用（最小输入不退化）", () => {
    expect(validityFilterStats([mk("only", null, "2026-09-01T00:00:00.000Z")], NOW, "hard")).toEqual({
      active: 0,
      expired: 1,
      future: 0,
      dropped: 1,
    });
  });
});
