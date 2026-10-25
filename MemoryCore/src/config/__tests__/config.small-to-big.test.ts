/**
 * #78 R-b：recall.smallToBig config 解析测试（TDD RED 先行）。
 *
 * 契约（拍板 Q2，2026-10-25）：读面独立开关——代码缺省关（enabled 缺省 false）+ 部署
 * yaml 显式开（#77 三键同款：代码保守、yaml 明示）。maxExtraLines 缺省 2（全局帽）；
 * 负值/非有限 → 0 floor（=关，宁缺毋滥）。
 */
import { describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";

const s2bOf = (raw: Record<string, unknown>) => parseConfig(raw).recall.smallToBig;

describe("R-b config：recall.smallToBig", () => {
  it("缺省（无键）→ enabled=false + maxExtraLines=2（代码缺省关）", () => {
    const s2b = s2bOf({});
    expect(s2b.enabled).toBe(false);
    expect(s2b.maxExtraLines).toBe(2);
  });

  it("显式开启透传：{enabled:true, maxExtraLines:5}", () => {
    const s2b = s2bOf({ recall: { smallToBig: { enabled: true, maxExtraLines: 5 } } });
    expect(s2b.enabled).toBe(true);
    expect(s2b.maxExtraLines).toBe(5);
  });

  it("部分键回落缺省：只给 enabled → maxExtraLines=2", () => {
    const s2b = s2bOf({ recall: { smallToBig: { enabled: true } } });
    expect(s2b.enabled).toBe(true);
    expect(s2b.maxExtraLines).toBe(2);
  });

  it("clamp：负值 maxExtraLines → 0（=关）；非数字回落缺省 2（num() 非有限→undefined→缺省）", () => {
    expect(s2bOf({ recall: { smallToBig: { enabled: true, maxExtraLines: -3 } } }).maxExtraLines).toBe(0);
    expect(s2bOf({ recall: { smallToBig: { enabled: true, maxExtraLines: "x" as unknown as number } } }).maxExtraLines).toBe(2);
    expect(s2bOf({ recall: { smallToBig: { enabled: true, maxExtraLines: Number.NaN } } }).maxExtraLines).toBe(2);
  });

  it("非布尔 enabled → false（关断恒等）", () => {
    expect(s2bOf({ recall: { smallToBig: { enabled: "yes" as unknown as boolean } } }).enabled).toBe(false);
  });
});
