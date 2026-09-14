import { describe, expect, it } from "vitest";
import { normalizeScores, applyRecallBudget } from "../wiki-recall-utils.js";
import type { WikiSearchHit } from "../wiki-retrieve-client.js";

function hit(score: number, title = "t"): WikiSearchHit {
  return { path: "p", title, snippet: "s", score, type: "concept", hop: 0 };
}

describe("normalizeScores", () => {
  it("maps [small..max] to [0..1] proportionally", () => {
    const out = normalizeScores([hit(2.27), hit(20.09)]);
    expect(out[0].normScore).toBeCloseTo(0, 3);
    expect(out[1].normScore).toBeCloseTo(1, 3);
    expect(out[0].title).toBe("t"); // order preserved
  });

  it("returns 1 for all when max===min", () => {
    const out = normalizeScores([hit(5), hit(5)]);
    expect(out[0].normScore).toBe(1);
    expect(out[1].normScore).toBe(1);
  });

  it("returns [] for empty input", () => {
    expect(normalizeScores([])).toEqual([]);
  });
});

describe("applyRecallBudget", () => {
  it("truncates by maxTotalChars keeping header intact and staying within budget", () => {
    const ants = "蚁".repeat(100); // 100 code points
    const maxTotalChars = 20;
    const lines = applyRecallBudget([`1. ${ants}`, `2. b`], maxTotalChars, 10);
    const total = lines.join("\n").length;
    // Strict budget invariant: the joined output (bodies + separators) must not
    // exceed maxTotalChars — no slack. The truncation suffix width is reserved.
    expect(total).toBeLessThanOrEqual(maxTotalChars);
    expect(lines[0]).not.toContain(ants); // was truncated
    expect(lines[0]).toContain("…"); // truncation suffix present
    // Second line ran out of budget: it must be dropped, not overflow the total.
    expect(lines).toHaveLength(1);
  });

  it("does not split surrogate pairs when truncating", () => {
    const emoji = "😀".repeat(100); // 100 code points, 200 UTF-16 units
    const maxTotalChars = 20;
    const lines = applyRecallBudget([emoji], maxTotalChars, 10);
    const out = lines[0] ?? "";
    // Every element of Array.from is a whole code point: each must be a full
    // emoji or the suffix — a split pair would surface as lone surrogate halves.
    expect(Array.from(out).every((c) => c === "😀" || c === "…")).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(maxTotalChars);
    // Second line is a non-BMP line that overflows similarly; it is dropped.
    expect(lines).toHaveLength(1);
  });

  it("caps by maxHits", () => {
    const lines = applyRecallBudget(["1", "2", "3", "4"], 0, 2);
    expect(lines).toHaveLength(2);
  });

  it("skips empty input lines instead of dropping the rest", () => {
    const lines = applyRecallBudget(["1", "", "3"], 50, 10);
    expect(lines).toEqual(["1", "3"]);
  });
});