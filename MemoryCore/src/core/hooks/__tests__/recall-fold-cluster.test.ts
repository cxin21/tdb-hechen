import { describe, it, expect } from "vitest";
import { foldSameSourceDuplicates, foldByDurative, foldClusterAware } from "../recall-fold-cluster.js";
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
    // F-CLUSTER 折叠注记剥离（v2 组合语义：同文折叠消费带 ·源×n 的持续态行）
    expect(stripMemoryLineMeta("内容 ·源×2")).toBe("内容");
    expect(stripMemoryLineMeta("内容 ·同源×3")).toBe("内容");
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

/**
 * F-CLUSTER v2（2026-09-26 拍板）：持续态优先折叠——数据源=work_fact.metadata_json
 * .evidence_record_ids（生产在产：366/369=99.2%，991 引用实测）。
 * 语义：召回批内持续态行吸收其引用的源行（源行从输出移除），持续态行尾「·源×n」
 * 计数（n=合并记忆总数含自身，与 v1 ·同源×n 同口径）。
 * 红线：排序零变更（折叠只减行不改序）；宁漏勿错杀（引用源不在批内/元数据缺失一律不折）。
 */
describe("F-CLUSTER v2 foldByDurative", () => {
  const meta = (recordId?: string, evidenceIds?: string[]) => ({ recordId, evidenceIds });
  const DUR = (subject: string) => `- [work_fact|会话D] ${subject}`;
  const SRC = (subject: string) => `- [episodic|会话A] ${subject}`;

  it("RED-6 批内持续态吸收其 evidenceIds 指向的源行 → 源行移除+持续态 ·源×2", () => {
    const lines = [SRC("2026-09-21 我配置了 soul 注入格式"), DUR("我配置过 soul 注入格式（多次迭代）")];
    const metas = [meta("id-src-1"), meta("id-dur-1", ["id-src-1"])];
    const out = foldByDurative(lines, metas).lines;
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("·源×2");
    expect(out[0]).toContain("（多次迭代）"); // 保留的是持续态行
    expect(out[0]).toContain("soul 注入格式");
  });

  it("RED-7 引用源不在本批 → 源外行不折叠、持续态行原样（宁漏勿错杀）", () => {
    const lines = [SRC("批内的无关记忆"), DUR("持续态行")];
    const metas = [meta("id-other"), meta("id-dur-2", ["id-src-9"])];
    const out = foldByDurative(lines, metas).lines;
    expect(out).toEqual(lines);
  });

  it("RED-8 持续态无 evidenceIds / meta 缺失 → 全批原样", () => {
    const lines = [SRC("记忆一"), DUR("持续态行")];
    const metas = [undefined, meta("id-dur-3")];
    expect(foldByDurative(lines, metas).lines).toEqual(lines);
    expect(foldByDurative(lines, [meta("id-a"), undefined]).lines).toEqual(lines);
  });

  it("RED-9 两持续态共享一源 → 源只折一次入先现持续态，后到持续态计数不含已折源", () => {
    const lines = [DUR("持续态甲"), DUR("持续态乙"), SRC("共享源行")];
    const metas = [meta("id-d1", ["id-s"]), meta("id-d2", ["id-s"]), meta("id-s")];
    const out = foldByDurative(lines, metas).lines;
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("·源×2"); // 持续态甲吸收共享源
    expect(out[1]).not.toContain("·源×"); // 持续态乙不重复计数
  });

  it("RED-10 foldClusterAware 组合：先 durative 吸收再同文折叠，计数互不重复", () => {
    const lines = [
      SRC("同文重复记忆"),            // 源行（会被 durative 吸收）
      DUR("同文重复记忆（巩固）"),     // 持续态，evidenceIds 指向源
      "- [episodic|会话C] 同文重复记忆（巩固）", // 与持续态 strip 后同文（v1 面）
    ];
    const metas = [meta("id-s"), meta("id-d", ["id-s"]), meta("id-c")];
    const out = foldClusterAware(lines, metas);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("（巩固）");
    expect(out[0]).toContain("·同源×2"); // durative 吸收源后，残余同文行再并入
    expect(out[0].match(/·源×/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
