/**
 * #137（W1 双通道）：多事实归一化 + 事实通道键文本契约。
 *
 * 这张票的根因之一就是「单短语（metadata.subject）事实覆盖太弱」——所以这里钉死的是
 * 「多来源、脏形状、重复、超预算」下的稳定归约：宁缺毋滥，噪声短语不进键。
 */
import { describe, expect, it } from "vitest";
import {
  buildFactChannelKey,
  buildEmbeddingKey,
  clampMaxFacts,
  factKeyPhrases,
  mergeFactTriples,
  normalizeFactPhrases,
  normalizeFacts,
  normalizeFactTriples,
} from "./fact-key.js";

describe("normalizeFactPhrases（#137 多事实归一化）", () => {
  it("收三种形状：string / {phrase} / {subject,predicate,value}", () => {
    expect(
      normalizeFactPhrases([
        "  用户养了一只叫团子的猫  ",
        { phrase: "用户住在杭州" },
        { subject: "用户", predicate: "就读于", value: "浙江大学" },
      ]),
    ).toEqual(["用户养了一只叫团子的猫", "用户住在杭州", "用户 就读于 浙江大学"]);
  });

  it("折叠空白 + 大小写/尾随标点不敏感去重（保留首见顺序）", () => {
    expect(
      normalizeFactPhrases(["Likes  hiking", "likes hiking.", "LIKES HIKING。", "Plays guitar"]),
    ).toEqual(["Likes hiking", "Plays guitar"]);
  });

  it("丢弃噪声：空白、纯标点、过短、过长（整条丢，不切断）", () => {
    const long = "x".repeat(300);
    expect(normalizeFactPhrases(["", "   ", "。", "a", long, "ok fact"])).toEqual(["ok fact"]);
  });

  it("条数上限唯一 clamp：缺省 5、可收紧、0/负/非法回落 5、上界 12", () => {
    const many = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
    expect(normalizeFactPhrases(many)).toHaveLength(5);
    expect(normalizeFactPhrases(many, { maxFacts: 2 })).toEqual(["f1", "f2"]);
    // 全仓一套语义：非法（0/负/NaN）不再有"不限"分叉，统一回落缺省 5
    expect(normalizeFactPhrases(many, { maxFacts: 0 })).toHaveLength(5);
    expect(normalizeFactPhrases(many, { maxFacts: -3 })).toHaveLength(5);
    expect(normalizeFactPhrases(many, { maxFacts: Number.NaN })).toHaveLength(5);
    expect(clampMaxFacts(undefined)).toBe(5);
    expect(clampMaxFacts(99)).toBe(12);
    expect(clampMaxFacts(0)).toBe(5);
    expect(clampMaxFacts(3.7)).toBe(3);
  });

  it("脏形状不抛错（null/数字/嵌套对象/数组元素）", () => {
    expect(normalizeFactPhrases([null, 42, { foo: "bar" }, [], "有效事实"])).toEqual(["有效事实"]);
    expect(normalizeFactPhrases(undefined)).toEqual([]);
    expect(normalizeFactPhrases("单条字符串")).toEqual(["单条字符串"]);
  });
});

describe("normalizeFactTriples", () => {
  it("subject/predicate 必填，value 可空；去重", () => {
    expect(
      normalizeFactTriples([
        { subject: "用户", predicate: "住在", value: "杭州" },
        { subject: "用户", predicate: "住在", value: "杭州" },
        { subject: "", predicate: "住在", value: "上海" },
        { subject: "用户", predicate: "", value: "上海" },
        { subject: "用户", predicate: "喜欢", value: "" },
      ]),
    ).toEqual([
      { subject: "用户", predicate: "住在", value: "杭州" },
      { subject: "用户", predicate: "喜欢", value: "" },
    ]);
  });
});

describe("mergeFactTriples（多来源三元组去重）", () => {
  it("facts[] 内联三元组 ∪ factTriples 去重保首见，条数按 maxFacts", () => {
    const merged = mergeFactTriples([
      [{ subject: "用户", predicate: "住在", value: "杭州" }],
      [
        { subject: "用户", predicate: "住在", value: "杭州" },
        { subject: "用户", predicate: "养", value: "猫" },
      ],
    ]);
    expect(merged).toEqual([
      { subject: "用户", predicate: "住在", value: "杭州" },
      { subject: "用户", predicate: "养", value: "猫" },
    ]);
    expect(mergeFactTriples([merged], { maxFacts: 1 })).toHaveLength(1);
  });
});

describe("buildFactChannelKey（#137 事实通道键文本）", () => {
  it("只拼事实、不带原文；逗号分隔符可配", () => {
    const key = buildFactChannelKey(["用户住在杭州", "用户养猫"], { separator: " ; " });
    expect(key).toBe("用户住在杭州 ; 用户养猫");
    expect(key).not.toContain("原文");
  });

  it("无事实 / 全是噪声 / 预算为 0 → 空串（调用方据此零外呼、通道退出）", () => {
    expect(buildFactChannelKey([])).toBe("");
    expect(buildFactChannelKey(["", "。", "a"])).toBe("");
    expect(buildFactChannelKey(["用户住在杭州"], { maxFactChars: 0 })).toBe("");
    expect(buildFactChannelKey(undefined)).toBe("");
  });

  it("maxFactChars 预算按整条贪心（不切断单条短语）", () => {
    const key = buildFactChannelKey(["一二三四五", "六七八九十"], { separator: "|", maxFactChars: 6 });
    expect(key).toBe("一二三四五");
    const key2 = buildFactChannelKey(["一二三四五", "六七八九十"], { separator: "|", maxFactChars: 20 });
    expect(key2).toBe("一二三四五|六七八九十");
  });

  it("接受已归一的 {phrases,triples}；includeTriples 时才追加三元组展开文本", () => {
    const facts = {
      phrases: ["用户住在杭州"],
      triples: [{ subject: "用户", predicate: "养", value: "一只猫" }],
    };
    expect(buildFactChannelKey(facts)).toBe("用户住在杭州");
    const withTriples = buildFactChannelKey(facts, { includeTriples: true });
    expect(withTriples.split(" | ")).toEqual(["用户住在杭州", "用户 养 一只猫"]);
  });

  it("maxFacts 封顶后不再追加事实", () => {
    const key = buildFactChannelKey(["f1", "f2", "f3", "f4"], { maxFacts: 2, separator: "|" });
    expect(key).toBe("f1|f2");
  });
});

describe("factKeyPhrases / normalizeFacts", () => {
  it("normalizeFacts 一次给出短语与三元组，同一上限", () => {
    const out = normalizeFacts([
      "用户住在杭州",
      { subject: "用户", predicate: "养", value: "一只猫" },
    ]);
    expect(out.phrases).toEqual(["用户住在杭州", "用户 养 一只猫"]);
    expect(out.triples).toEqual([{ subject: "用户", predicate: "养", value: "一只猫" }]);
  });

  it("factKeyPhrases：includeTriples 时短语在前、三元组展开在后并去重", () => {
    const n = normalizeFacts(["A 住在 B", { subject: "C", predicate: "喜欢", value: "D" }]);
    expect(factKeyPhrases(n, false)).toEqual(["A 住在 B", "C 喜欢 D"]);
    expect(factKeyPhrases(n, true)).toEqual(["A 住在 B", "C 喜欢 D"]);
  });

  it("键替换档（buildEmbeddingKey）行为逐位不变：无事实 = 原文", () => {
    expect(buildEmbeddingKey("原文", [])).toBe("原文");
    expect(buildEmbeddingKey("原文", ["事实"])).toBe("原文 | 事实");
  });
});
