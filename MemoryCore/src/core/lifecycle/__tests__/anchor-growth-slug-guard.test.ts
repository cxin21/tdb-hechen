/**
 * #15 T8b：growthValueId slug 碰撞守卫。
 * 非 CJK label「coffee」vs「coffee!」slug 同为 "coffee" → upsert 互覆（后采纳覆盖先采纳，
 * state 复位 active 还可能复活 retired）。守卫=采纳写入前比对 anyState 快照：目标 value_id
 * 已存在且行 label ≠ 本次 label → 改用 hash 形态兜底（与纯 CJK 形态一致 [:10]）。
 * 纯 CJK label（slug 化为空）本就走完整 hash，天然防碰——不进守卫分支（零迁移）。
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { resolveGrowthValueId } from "../anchor-growth.js";

const hash10 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

describe("#15 slug 碰撞守卫 resolveGrowthValueId", () => {
  it("同 slug 不同 label（coffee vs coffee!）→ hash 形态兜底，互不覆盖", () => {
    const rows = [{ value_id: "coffee", label: "Coffee!" }];
    expect(resolveGrowthValueId("coffee", "theme", rows)).toBe("auto-" + hash10("coffee"));
  });
  it("同 slug 同 label（幂等重采）→ 原 slug 不变", () => {
    const rows = [{ value_id: "coffee", label: "Coffee" }];
    expect(resolveGrowthValueId("coffee", "theme", rows)).toBe("coffee");
  });
  it("纯 CJK label 不进守卫分支——hash 形态逐位不变（零迁移）", () => {
    const rows = [{ value_id: "auto-abcdef1234", label: "别的锚" }];
    expect(resolveGrowthValueId("守诺", "theme", rows)).toBe("auto-" + hash10("守诺"));
  });
  it("person 域碰撞 → p-auto- 前缀 hash 形态（P2 命名空间不破）", () => {
    const rows = [{ value_id: "p-alice", label: "Alice!" }];
    expect(resolveGrowthValueId("Alice", "person", rows)).toBe("p-auto-" + hash10("alice"));
  });
  it("character 域碰撞 → c-auto- 前缀 hash 形态", () => {
    const rows = [{ value_id: "c-steady", label: "Steady!" }];
    expect(resolveGrowthValueId("Steady", "character", rows)).toBe("c-auto-" + hash10("steady"));
  });
  it("无既有行 → 纯 slug 直通", () => {
    expect(resolveGrowthValueId("Coffee Time", "theme", [])).toBe("coffee-time");
  });
});
