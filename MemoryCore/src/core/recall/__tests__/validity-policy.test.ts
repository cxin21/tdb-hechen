import { describe, it, expect } from "vitest";
import { selectByValidity, validityStateOf } from "../validity-policy.js";

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
