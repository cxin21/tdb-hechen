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

  // ── #138（2026-10-28）：上下文行预算归属 + 证据相关性排序 + 结论条数上限 ──

  it("#138 预算归属缺省 shared（逐位现状）；additive 显式透传；非法值回落 shared", () => {
    expect(s2bOf({}).budget).toBe("shared");
    expect(s2bOf({ recall: { smallToBig: { enabled: true } } }).budget).toBe("shared");
    expect(s2bOf({ recall: { smallToBig: { enabled: true, budget: "additive" } } }).budget).toBe("additive");
    expect(s2bOf({ recall: { smallToBig: { enabled: true, budget: "other" } } }).budget).toBe("shared");
  });

  it("#138 相关性排序缺省 true（质量修复）；显式 false 可回滚旧序", () => {
    expect(s2bOf({}).relevanceRanked).toBe(true);
    expect(s2bOf({ recall: { smallToBig: { relevanceRanked: false } } }).relevanceRanked).toBe(false);
    expect(s2bOf({ recall: { smallToBig: { relevanceRanked: true } } }).relevanceRanked).toBe(true);
  });

  it("#138 结论条数上限：缺省 undefined（运行期取 floor(maxResults/2)）；正数 floor；0/负/非有限 → 0", () => {
    const clOf = (raw: Record<string, unknown>) => parseConfig(raw).recall.conclusionLayer;
    expect(clOf({}).maxConclusions).toBeUndefined();
    expect(clOf({ recall: { conclusionLayer: { maxConclusions: 3 } } }).maxConclusions).toBe(3);
    expect(clOf({ recall: { conclusionLayer: { maxConclusions: 2.9 } } }).maxConclusions).toBe(2);
    expect(clOf({ recall: { conclusionLayer: { maxConclusions: 0 } } }).maxConclusions).toBe(0);
    expect(clOf({ recall: { conclusionLayer: { maxConclusions: -4 } } }).maxConclusions).toBe(0);
    // num() 对 NaN 返回 undefined（非有限 → 视为未配置）→ 回落运行期缺省
    expect(clOf({ recall: { conclusionLayer: { maxConclusions: Number.NaN } } }).maxConclusions).toBeUndefined();
  });
});
