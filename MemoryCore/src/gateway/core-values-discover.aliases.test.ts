/**
 * #18 T11 —— theme 锚 aliases 维度 + 去重粒度修正（集合级）。
 *
 * 根因：①theme 池无 aliases（person 池 F19 有先例）——同主题多措辞各立各锚、quota 互踩；
 * ②theme 去重只比精确 label，LLM 换措辞即绕过（碎片锚第二道门缺失，G-SIMMERGE 缺省关）。
 *
 * 契约（p18 方案）：
 *  1. 提案可带 aliases（同义变体 ≤3，规范化：trim/去重/去同 label）；证据计数=label OR
 *     aliases 任一命中计一次（同行双命中不重复计）；维护重算/挤出同刻度。
 *  2. 去重升级集合级（dedupProposalsWithVariants）：①候选名集 ∩ 既有名集精确命中 → 重复；
 *     ②无精确命中 → 任一名字对字符 bigram Jaccard ≥ 0.75（沿用 0.79 真重复/0.692 同簇
 *     不并的标定，宁漏勿错杀）。
 *  3. fired 消费端口径钉死：salienceBoostWithRefs / appraise 仍按 label——aliases 不参与
 *     fired（防回归测试在 appraisal.test.ts）。
 */
import { describe, it, expect } from "vitest";

import {
  parseProposalsJson,
  recountEvidence,
  dedupProposals,
  dedupProposalsWithVariants,
  type ThemeNameVariants,
} from "../gateway/core-values-discover.js";

describe("#18 aliases 解析规范化", () => {
  it("trim / 去重 / 去同 label / 上限 3", () => {
    const out = parseProposalsJson(JSON.stringify([
      { label: "数据完整", rationale: "r", aliases: [" 数据安全 ", "数据安全", "数据完整", "", "防丢数据", "x1", "x2"] },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]!.aliases).toEqual(["数据安全", "防丢数据", "x1"]);
  });
  it("aliases 缺省 / 非数组 → []（宁缺毋滥）", () => {
    expect(parseProposalsJson('[{"label":"a","rationale":"r"}]')[0]!.aliases).toEqual([]);
    expect(parseProposalsJson('[{"label":"a","rationale":"r","aliases":"数据"}]')[0]!.aliases).toEqual([]);
  });
});

describe("#18 证据计数 OR 口径（label OR aliases，同行只计一次）", () => {
  const corpus = [
    "数据安全 review 通过",
    "数据完整 first",
    "同时强调 数据安全 与 防丢数据",
    "完全无关的一行",
  ];
  it("label 单独：仅精确命中行", () => {
    expect(recountEvidence("数据安全", corpus)).toBe(2);
  });
  it("带 aliases：任一变体命中即计（同行双命中不重复）", () => {
    expect(recountEvidence("数据完整", corpus, ["数据安全", "防丢数据"])).toBe(3);
  });
});

describe("#18 dedupProposalsWithVariants（集合级去重）", () => {
  const existing: ThemeNameVariants[] = [
    { label: "数据完整", aliases: ["防丢数据"] },
  ];
  it("①候选 label 与既有 alias 精确命中 → 拦截", () => {
    const out = dedupProposalsWithVariants([{ label: "防丢数据", rationale: "r", aliases: [] }], existing);
    expect(out).toHaveLength(0);
  });
  it("①候选 alias 与既有 label 精确命中 → 拦截", () => {
    const out = dedupProposalsWithVariants([{ label: "上线纪律", rationale: "r", aliases: ["数据完整"] }], existing);
    expect(out).toHaveLength(0);
  });
  it("②集合 bigram Jaccard < 0.75（不同簇）→ 不拦（宁漏勿错杀标定沿用）", () => {
    const out = dedupProposalsWithVariants([{ label: "数据安全", rationale: "r", aliases: [] }], [
      { label: "数据完整", aliases: ["防丢数据"] },
    ]);
    expect(out).toHaveLength(1);
  });
  it("②bigram Jaccard ≥ 0.75（同簇变体）→ 拦截", () => {
    const out = dedupProposalsWithVariants([{ label: "数据安全性", rationale: "r", aliases: [] }], [
      { label: "数据安全", aliases: [] },
    ]);
    expect(out).toHaveLength(0);
  });
  it("批内去重：后到候选经 alias 变体命中先到候选 → 只留先者", () => {
    const out = dedupProposalsWithVariants([
      { label: "数据完整", rationale: "r1", aliases: ["防丢数据"] },
      { label: "防丢数据", rationale: "r2", aliases: [] },
    ], []);
    expect(out.map((c) => c.label)).toEqual(["数据完整"]);
  });
  it("旧签名 dedupProposals 行为逐位不变（回归）", () => {
    const out = dedupProposals([{ label: "A", rationale: "r", aliases: ["b"] }], ["a"]);
    expect(out).toHaveLength(0);
    const out2 = dedupProposals([{ label: "A", rationale: "r", aliases: ["b"] }], ["b"]);
    expect(out2).toHaveLength(1); // 旧口径只比 label，alias 不拦
  });
});
