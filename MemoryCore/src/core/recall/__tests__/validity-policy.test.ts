import { describe, it, expect } from "vitest";
import {
  demoteSoftValidity,
  excludeInvalidatedFor,
  selectByValidity,
  shouldHardDropValidity,
  validityPolicyOf,
  validityStateOf,
} from "../validity-policy.js";

/** #136 软失效：效期作为融合特征（降权）而非硬过滤；只有「问现在/最新 且 存在更新的有效行」才硬丢。 */
const NOW = new Date("2026-10-27T00:00:00Z");
const mk = (id: string, vs?: string, ve?: string) => ({ id, valid_start: vs, valid_end: ve });

describe("#136 效期状态与软失效选择", () => {
  it("validityStateOf：active / expired / future / 解析失败保留", () => {
    expect(validityStateOf(mk("a", "2026-01-01"), NOW)).toBe("active");
    expect(validityStateOf(mk("b", "2026-01-01", "2026-02-01"), NOW)).toBe("expired");
    expect(validityStateOf(mk("c", "2027-01-01"), NOW)).toBe("future");
    expect(validityStateOf(mk("d", undefined, "not-a-date"), NOW)).toBe("active");
  });

  it("hard：失效与未生效都丢，生效保序", () => {
    const out = selectByValidity(
      [mk("old", "2026-01-01", "2026-02-01"), mk("future", "2027-01-01"), mk("live", "2026-03-01")],
      { now: NOW, mode: "hard" },
    );
    expect(out.kept.map((x) => x.id)).toEqual(["live"]);
    expect(out.dropped.map((x) => x.id)).toEqual(["old", "future"]);
  });

  it("soft（无当下意图）：失效行降权保留在生效行之后，不删", () => {
    const out = selectByValidity(
      [mk("expired1", "2026-01-01", "2026-02-01"), mk("live", "2026-03-01"), mk("expired2", "2026-01-02", "2026-02-02")],
      { now: NOW, mode: "soft", presentIntent: false },
    );
    expect(out.kept.map((x) => x.id)).toEqual(["live", "expired1", "expired2"]);
    expect(out.demoted.map((x) => x.id)).toEqual(["expired1", "expired2"]);
    expect(out.dropped).toEqual([]);
  });

  it("soft + 当下意图 + 存在更新的有效行：才硬丢旧值", () => {
    const out = selectByValidity(
      [mk("old", "2026-01-01", "2026-02-01"), mk("new", "2026-03-01")],
      { now: NOW, mode: "soft", presentIntent: true },
    );
    expect(out.kept.map((x) => x.id)).toEqual(["new"]);
    expect(out.dropped.map((x) => x.id)).toEqual(["old"]);
  });

  it("soft + 当下意图 但失效行本身就是最新（temporal 场景）：仍保留降权", () => {
    const out = selectByValidity(
      [mk("old", "2025-01-01", "2025-02-01"), mk("latestExpired", "2026-09-01", "2026-09-10")],
      { now: NOW, mode: "soft", presentIntent: true },
    );
    // 全部 expired 时没有"更新行"可比 → 一条都不丢，保原相对序（谁更新交给 recency/validity 融合分）
    expect(out.kept.map((x) => x.id)).toEqual(["old", "latestExpired"]);
    expect(out.demoted.map((x) => x.id)).toEqual(["old", "latestExpired"]);
    expect(out.dropped).toEqual([]);
  });

  it("soft + 当下意图 但开关关断：不硬丢", () => {
    const out = selectByValidity(
      [mk("old", "2026-01-01", "2026-02-01"), mk("new", "2026-03-01")],
      { now: NOW, mode: "soft", presentIntent: true, hardOnPresentIntent: false },
    );
    expect(out.kept.map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("自定义 accessor：事实级效期挂在 metadata 上同样可用", () => {
    const rows = [{ id: "row", metadata: { valid_end: "2026-02-01" } }];
    const out = selectByValidity(rows, {
      now: NOW,
      mode: "hard",
      accessors: { validEnd: (r) => (r.metadata as Record<string, string>).valid_end },
    });
    expect(out.kept).toEqual([]);
  });
});
/** #174：三态映射（off/hard/soft）的唯一实现点——显式关优先于 validity.mode。 */
describe("#174 excludeInvalidatedFor / validityPolicyOf 三态", () => {
  it("excludeInvalidatedFor：false 碾压 mode（--validity-off 在 soft 配置下仍可达成）", () => {
    expect(excludeInvalidatedFor("soft", false)).toBe(false);
    expect(excludeInvalidatedFor("hard", false)).toBe(false);
    expect(excludeInvalidatedFor(undefined, false)).toBe(false);
  });

  it("excludeInvalidatedFor：soft 派生 soft，hard/缺省原样透传（undefined = 下游缺省 hard）", () => {
    expect(excludeInvalidatedFor("soft", true)).toBe("soft");
    expect(excludeInvalidatedFor("soft", undefined)).toBe("soft");
    expect(excludeInvalidatedFor("hard", true)).toBe(true);
    expect(excludeInvalidatedFor("hard", undefined)).toBeUndefined();
    expect(excludeInvalidatedFor(undefined, true)).toBe(true);
    expect(excludeInvalidatedFor(undefined, undefined)).toBeUndefined();
    // 语义等价：undefined 与 true 在下游 filterByValidity/shouldHardDropValidity 都是「硬过滤」
    const expired = mk("old", "2026-01-01", "2026-02-01");
    expect(shouldHardDropValidity(expired, NOW, "hard")).toBe(true);
  });

  it("validityPolicyOf：三态派生（off 只认显式 false）", () => {
    expect(validityPolicyOf("soft", false)).toBe("off");
    expect(validityPolicyOf("soft", undefined)).toBe("soft");
    expect(validityPolicyOf("hard", true)).toBe("hard");
    expect(validityPolicyOf(undefined, undefined)).toBe("hard");
  });

  it("shouldHardDropValidity off：future 也不丢（与工具路 excludeInvalidated=false 原样返回对齐）", () => {
    const future = mk("future", "2027-01-01");
    const expired = mk("old", "2026-01-01", "2026-02-01");
    expect(shouldHardDropValidity(future, NOW, "off")).toBe(false);
    expect(shouldHardDropValidity(expired, NOW, "off")).toBe(false);
    // 对照：hard 丢两者、soft 只丢 future
    expect(shouldHardDropValidity(future, NOW, "hard")).toBe(true);
    expect(shouldHardDropValidity(expired, NOW, "hard")).toBe(true);
    expect(shouldHardDropValidity(future, NOW, "soft")).toBe(true);
    expect(shouldHardDropValidity(expired, NOW, "soft")).toBe(false);
  });
});

/** #148：工具路 soft 沉底降权的共用实现（乘子由 recall.validity.softPenalty 解析）。 */
describe("#148 demoteSoftValidity（沉底 + 降权，唯一乘子解析点）", () => {
  const rows = () => [
    { id: "expired1", valid_start: "2026-01-01", valid_end: "2026-02-01", score: 0.9 },
    { id: "live", valid_start: "2026-03-01", score: 0.5 },
    { id: "expired2", valid_start: "2026-01-02", valid_end: "2026-02-02", score: 0.8 },
  ];

  it("active 在前、expired 沉底且 ×缺省 penalty(0.5)，各保原相对序", () => {
    const out = demoteSoftValidity(rows(), NOW);
    expect(out.kept.map((r) => r.id)).toEqual(["live", "expired1", "expired2"]);
    expect(out.demoted.map((r) => r.id)).toEqual(["expired1", "expired2"]);
    expect(out.kept.find((r) => r.id === "live")!.score).toBeCloseTo(0.5, 12);
    expect(out.kept.find((r) => r.id === "expired1")!.score).toBeCloseTo(0.45, 12);
    expect(out.kept.find((r) => r.id === "expired2")!.score).toBeCloseTo(0.4, 12);
  });

  it("penalty 传入（含越界 clamp 与非法回落）", () => {
    expect(demoteSoftValidity(rows(), NOW, 0.25).kept.find((r) => r.id === "expired1")!.score).toBeCloseTo(0.225, 12);
    expect(demoteSoftValidity(rows(), NOW, 5).kept.find((r) => r.id === "expired1")!.score).toBeCloseTo(0.9, 12);
    expect(demoteSoftValidity(rows(), NOW, -1).kept.find((r) => r.id === "expired1")!.score).toBeCloseTo(0, 12);
    expect(demoteSoftValidity(rows(), NOW, Number.NaN).kept.find((r) => r.id === "expired1")!.score).toBeCloseTo(0.45, 12);
  });

  it("无 expired：逐位返回（不重排、不复制）", () => {
    const input = [{ id: "a", score: 0.2 }, { id: "b", score: 0.9 }];
    const out = demoteSoftValidity(input, NOW);
    expect(out.kept).toEqual(input);
    expect(out.demoted).toEqual([]);
    expect(out.dropped).toEqual([]);
  });

  it("future 行按 soft 口径硬丢（dropped），不进 kept", () => {
    const out = demoteSoftValidity(
      [
        { id: "future", valid_start: "2027-01-01", score: 0.2 },
        { id: "live", score: 0.3 },
      ],
      NOW,
    );
    expect(out.kept.map((r) => r.id)).toEqual(["live"]);
    expect(out.dropped.map((r) => r.id)).toEqual(["future"]);
  });
});
