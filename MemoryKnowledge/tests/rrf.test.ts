import { test, expect } from "vitest";
import { rrfMerge } from "../src/engines/wiki/manager.js";

test("rrfMerge combines fts and vector ranks", () => {
  const fts = [{ id: "a", score: 5 }, { id: "b", score: 4 }];
  const vec = [{ id: "b", score: 0.9 }, { id: "c", score: 0.8 }];
  const out = rrfMerge(fts, vec);
  expect(out[0].id).toBe("b"); // 两路都出现 → RRF 最高
  expect(out.map((x) => x.id)).toContain("a");
});