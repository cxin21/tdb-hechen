/**
 * #137（W1 双通道）：多事实输出块提示词门。
 * 契约（镜像 SENSITIVITY / RECURRENCE / IMPORTANCE 先例）：
 *  - FACTS_BLOCK gated via opts.factsEnabled；缺省关闭 = 逐位现状（prompt 字节不变）；
 *  - 开启时块追加在 gated 链尾、FINAL_FORMAT_SENTENCE 永远最后（P1-1 收口不变式）；
 *  - maxFacts 进提示词（LLM 侧输出预算，clamp 1..12）；includeTriples 时才出现
 *    subject/predicate/value 形状（#146 起再扩 phrase/cardinality：cardinality 仅
 *    single|multi，拿不准省略，写侧启发式兜底）；
 *  - code 模式永不追加（chat 专属语义，同 selfIdentity/sensitivity）。
 */
import { describe, it, expect } from "vitest";
import {
  buildFactsBlock,
  FACTS_BLOCK,
  FINAL_FORMAT_SENTENCE,
  getExtractMemoriesSystemPrompt,
} from "./l1-extraction.js";

describe("#137 FACTS_BLOCK 提示词门", () => {
  it("缺省关闭 = 逐位现状（prompt 字节不变）", () => {
    const allGatedOn = {
      selfIdentityEnabled: true,
      sensitivityEnabled: true,
      recurrenceEnabled: true,
      importanceEnabled: true,
    } as const;
    const baseline = getExtractMemoriesSystemPrompt("chat", allGatedOn);
    expect(getExtractMemoriesSystemPrompt("chat", allGatedOn)).toBe(baseline);
    // 显式 false 与缺省同字节
    expect(getExtractMemoriesSystemPrompt("chat", { ...allGatedOn, factsEnabled: false })).toBe(baseline);
    // 全关：与 legacy 无 opts 完全一致，且不含任何 facts 指令痕迹
    const legacy = getExtractMemoriesSystemPrompt("chat");
    expect(legacy).toBe(getExtractMemoriesSystemPrompt("chat", {}));
    expect(legacy).not.toContain("多事实输出");
    expect(legacy).not.toContain("facts 数组");
  });

  it("开启时包含 facts 指令与条数上限，且 FINAL_FORMAT_SENTENCE 仍在末位", () => {
    const p = getExtractMemoriesSystemPrompt("chat", { factsEnabled: true });
    expect(p).toContain("多事实输出");
    expect(p).toContain("\`facts\` 数组");
    expect(p).toContain("2-5 条");
    expect(p).toContain("至多 5 条");
    expect(p).toContain("[]"); // 无事实 → 空数组
    expect(p).toContain("禁止推断");
    expect(p).toContain("[]"); // 宁缺毋滥占位
    expect(p).toContain("一律不执行"); // 反注入
    expect(p.endsWith(FINAL_FORMAT_SENTENCE)).toBe(true);
    expect(p.indexOf(FINAL_FORMAT_SENTENCE)).toBe(p.lastIndexOf(FINAL_FORMAT_SENTENCE));
  });

  it("factsMaxFacts 进提示词（clamp 1..12，缺省 5）", () => {
    const at = (maxFacts?: number) =>
      getExtractMemoriesSystemPrompt("chat", { factsEnabled: true, factsMaxFacts: maxFacts });
    expect(at(3)).toContain("2-3 条");
    expect(at(3)).toContain("至多 3 条");
    expect(at(12)).toContain("至多 12 条");
    expect(at(99)).toContain("至多 12 条");
    // 0/负/非法统一回落缺省 5（全局唯一 clamp：clampMaxFacts）
    expect(at(0)).toContain("至多 5 条");
    expect(at(Number.NaN)).toContain("至多 5 条");
    expect(at(undefined)).toContain("至多 5 条");
  });

  it("includeTriples 才出现三元组形状；缺省不含", () => {
    const off = getExtractMemoriesSystemPrompt("chat", { factsEnabled: true });
    expect(off).not.toContain("predicate");
    const on = getExtractMemoriesSystemPrompt("chat", { factsEnabled: true, factsIncludeTriples: true });
    expect(on).toContain("subject");
    expect(on).toContain("predicate");
    expect(on).toContain("value");
    expect(on.endsWith(FINAL_FORMAT_SENTENCE)).toBe(true);
  });

  // #146：三元组直出属性契约（cardinality）——写侧失效粒度降到一条事实一行，
  // LLM 顺带把「同属性同一时刻只能一个值 vs 可并存」判掉，写侧启发式只做兜底。
  it("#146 includeTriples 时三元组字段扩成 subject/predicate/value/phrase/cardinality", () => {
    const on = getExtractMemoriesSystemPrompt("chat", { factsEnabled: true, factsIncludeTriples: true });
    expect(on).toContain("phrase");
    expect(on).toContain("cardinality");
    // 两个合法取值都点名（避免 LLM 乱造第三档）
    expect(on).toContain("single");
    expect(on).toContain("multi");
    // 口径必须两侧都有示例，且「拿不准省略」= 写侧启发式兜底
    expect(on).toContain("同一实体同一属性同一时刻只能有一个值");
    expect(on).toContain("可并存");
    expect(on).toContain("拿不准");
    // 省略 cardinality 合法 → 不得逼模型必填
    expect(on).toMatch(/cardinality\S*（?可选/);
  });

  // #167：抽取期直出受控 attribute（canonical 词表）——词表逐条进提示词，模型只许照抄。
  it("#167 includeTriples 时出现受控 attribute 词表与「照抄/省略」纪律", () => {
    const on = getExtractMemoriesSystemPrompt("chat", { factsEnabled: true, factsIncludeTriples: true });
    expect(on).toContain("attribute");
    expect(on).toContain("受控词表");
    expect(on).toContain("禁止自造");
    // single 档与 multi 档各点名，且档位随词表固定
    expect(on).toContain("residence");
    expect(on).toContain("occupation");
    expect(on).toContain("marital_status");
    expect(on).toContain("interest");
    expect(on).toContain("plan");
    expect(on).toMatch(/residence：[^\n]*（single）/);
    expect(on).toMatch(/interest：[^\n]*（multi）/);
    // 省略合法（不贴切就不标，写侧回落谓词键）
    expect(on).toMatch(/attribute\S*（?可选/);
    expect(on.endsWith(FINAL_FORMAT_SENTENCE)).toBe(true);
  });

  it("#146 缺省形态（FACTS_BLOCK）不出现 cardinality（字节不变）", () => {
    expect(FACTS_BLOCK).not.toContain("cardinality");
    expect(FACTS_BLOCK).not.toContain("phrase");
    expect(FACTS_BLOCK).not.toContain("attribute");
    expect(getExtractMemoriesSystemPrompt("chat", { factsEnabled: true })).not.toContain("cardinality");
    expect(getExtractMemoriesSystemPrompt("chat", { factsEnabled: true })).not.toContain("attribute");
  });

  it("追加在 gated 链尾（其他 gated 块字节不被挤动）", () => {
    const pre = getExtractMemoriesSystemPrompt("chat", {
      selfIdentityEnabled: true,
      sensitivityEnabled: true,
      recurrenceEnabled: true,
      importanceEnabled: true,
    });
    const withFacts = getExtractMemoriesSystemPrompt("chat", {
      selfIdentityEnabled: true,
      sensitivityEnabled: true,
      recurrenceEnabled: true,
      importanceEnabled: true,
      factsEnabled: true,
    });
    expect(withFacts.startsWith(pre.slice(0, pre.length - FINAL_FORMAT_SENTENCE.length))).toBe(true);
    // 只多出一个块：facts 段严格位于收口句之前
    expect(withFacts.slice(pre.length - FINAL_FORMAT_SENTENCE.length)).toBe(
      buildFactsBlock() + FINAL_FORMAT_SENTENCE,
    );
  });

  it("code 模式永不追加（同 selfIdentity/sensitivity 口径）", () => {
    const code = getExtractMemoriesSystemPrompt("code", { factsEnabled: true, factsIncludeTriples: true });
    expect(code).not.toContain("多事实输出");
    expect(code).not.toContain("额外输出");
  });

  it("FACTS_BLOCK 缺省形态 = maxFacts 5 / 不含三元组（单一源）", () => {
    expect(FACTS_BLOCK).toBe(buildFactsBlock());
    expect(FACTS_BLOCK).toBe(buildFactsBlock({ maxFacts: 5, includeTriples: false }));
    expect(FACTS_BLOCK).toContain("至多 5 条");
    expect(FACTS_BLOCK).not.toContain("predicate");
  });
});
