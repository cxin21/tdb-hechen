/**
 * 缺口 B · 场景块触发词（纯函数层）RED 套件。
 *
 * 合同：
 *  - 触发词是「中文原词」短语的受控数组：3-8 个、去重、去空、单条有长度上限；不造词、不改写；
 *  - 命中判定做全半角/大小写归一（NFKC + lower）后「包含匹配」，或用仓内既有分词
 *    （buildFtsQuery/parseFtsTokens 单一源）做整词匹配；
 *  - 返回命中的触发词（按原顺序、去重），空数组=未命中——调用侧据此条件必注入。
 */
import { describe, expect, it } from "vitest";
import { matchSceneKeywords, normalizeMatchText, normalizeSceneKeywords } from "../scene-keywords.js";

describe("B · 触发词规范化", () => {
  it("接受数组或字符串；trim、去空、去重（大小写/全半角归一后）", () => {
    expect(normalizeSceneKeywords([" 缓存 ", "缓存", "", "  ", "SQL", "ｓｑｌ"])).toEqual(["缓存", "SQL"]);
    expect(normalizeSceneKeywords("缓存，对账、召回")).toEqual(["缓存", "对账", "召回"]);
  });

  it("上限 8 个、单条上限 24 字（超出丢弃而不是改写）", () => {
    const many = normalizeSceneKeywords(Array.from({ length: 12 }, (_, i) => `词${i}`));
    expect(many).toHaveLength(8);
    const long = normalizeSceneKeywords(["短词", "长".repeat(30)]);
    expect(long).toEqual(["短词"]);
  });

  it("非法输入 → 空数组（不抛）", () => {
    expect(normalizeSceneKeywords(undefined)).toEqual([]);
    expect(normalizeSceneKeywords(null)).toEqual([]);
    expect(normalizeSceneKeywords(42 as unknown as string)).toEqual([]);
  });

  it("归一：NFKC + lower + 折叠空白", () => {
    expect(normalizeMatchText("  ＳＱＬ   Query ")).toBe("sql query");
  });
});

describe("B · 命中判定（包含 + 整词）", () => {
  const KW = ["缓存对账", "召回", "SQL"];

  it("包含匹配（中文短语）", () => {
    expect(matchSceneKeywords("缓存对账怎么做的？", KW)).toEqual(["缓存对账"]);
    expect(matchSceneKeywords("上次的召回实验", KW)).toEqual(["召回"]);
  });

  it("全半角/大小写归一后命中", () => {
    expect(matchSceneKeywords("用ＳＱＬ查一下", KW)).toEqual(["SQL"]);
  });

  it("分词整词命中（token 与触发词相等）", () => {
    expect(matchSceneKeywords("召回 阈值", KW, ["召回", "阈值"])).toEqual(["召回"]);
  });

  it("未命中 → 空数组；空 query/空 keywords 不抛", () => {
    expect(matchSceneKeywords("完全无关的问题", KW)).toEqual([]);
    expect(matchSceneKeywords("", KW)).toEqual([]);
    expect(matchSceneKeywords("缓存对账", [])).toEqual([]);
  });

  it("多个命中按触发词原顺序返回、去重", () => {
    expect(matchSceneKeywords("缓存对账与召回", KW)).toEqual(["缓存对账", "召回"]);
  });
});
