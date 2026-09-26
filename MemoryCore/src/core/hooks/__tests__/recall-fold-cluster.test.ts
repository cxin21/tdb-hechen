import { describe, it, expect } from "vitest";
import { foldSameSourceDuplicates } from "../recall-fold-cluster.js";
import { stripMemoryLineMeta } from "../memory-line-meta.js";

/**
 * F-CLUSTER v1 RED（2026-09-26 拍板）：召回注入行同源折叠。
 * 判据映射：提取简洁（同事实多源→一行+计数）；信息完整（计数可见、不丢源数）。
 * 口径红线：stripMemoryLineMeta 必须与 foldNearDuplicates 的 stripMeta 单一源（防 A2 校准漂移）。
 */
describe("F-CLUSTER v1 foldSameSourceDuplicates", () => {
  it("RED-1 同文三行（tag/soul/活动时间变体）→ 保留首现行 + ·同源×3", () => {
    const lines = [
      "- [episodic|会话A] 我在推进 F-CLUSTER 设计拍板 ·soul[发生 2026-09-26 · 情感 0.6] ·(活动时间: 2026-09-26 10:00)",
      "- [episodic|会话B] 我在推进 F-CLUSTER 设计拍板 ·soul[发生 2026-09-26]",
      "- [work_fact|会话C] 我在推进 F-CLUSTER 设计拍板",
    ];
    const out = foldSameSourceDuplicates(lines);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("·同源×3");
    expect(out[0]).toContain("会话A"); // 保留首现行
    expect(out[0]).toContain("F-CLUSTER 设计拍板"); // 内容保真
  });

  it("RED-2 strip 后不同文不折叠（逐字节保真，存量行为零变更）", () => {
    const lines = [
      "- [episodic|s1] 内容甲 ·soul[x]",
      "- [episodic|s2] 内容乙 ·soul[y]",
    ];
    expect(foldSameSourceDuplicates(lines)).toEqual(lines);
  });

  it("RED-3 strip 口径：单缀三剥离 + 多缀循环剥离到不动点（逐字判定要求彻底内容口径）", () => {
    expect(stripMemoryLineMeta("- [t|s] 内容 ·soul[x]")).toBe("内容");
    expect(stripMemoryLineMeta("内容 ·(活动时间: 2026-09-26 10:00)")).toBe("内容");
    expect(stripMemoryLineMeta("- [t|s] 内容")).toBe("内容");
    // 多缀：soul 后仍有活动时间缀——单遍剥离会残留 soul 段（RED-1 失败归因），循环版必须全剥
    expect(stripMemoryLineMeta("- [t|s] 内容 ·soul[发生 09-26] ·(活动时间: 2026-09-26 10:00)")).toBe("内容");
  });

  it("RED-4 边界：空数组/单行/空 strip 行不折叠", () => {
    expect(foldSameSourceDuplicates([])).toEqual([]);
    expect(foldSameSourceDuplicates(["- [t|s] 唯一一行"])).toEqual(["- [t|s] 唯一一行"]);
    const blanks = ["", ""];
    expect(foldSameSourceDuplicates(blanks)).toEqual(blanks); // 空 strip key 不折叠
  });

  it("RED-5 重复行注记幂等：同一行文本出现两次→首行 ·同源×2，无嵌套注记", () => {
    const lines = ["- [t|s] 同文行", "- [t2|s2] 同文行"];
    const out = foldSameSourceDuplicates(lines);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("- [t|s] 同文行 ·同源×2");
    expect(out[0].match(/·同源×/g)?.length).toBe(1);
  });
});
