/**
 * #146 算法修复②：属性同义归一（canonical attribute）。
 *
 * 背景（真实语料实测）：1796 条三元组 / 1461 个不同 (subject,predicate) 对，跨 turn 同对重复
 * 只有 219 个（15%）。抽取器每次换措辞（"live in" / "lives in" / "city of residence" / "住在"）
 * 字面键就永不相等 ⇒ 事实级失效几乎不触发。归一后同一属性族必须落到同一键。
 */
import { describe, expect, it } from "vitest";
import { factKeyOf } from "./supersession.js";

describe("factKeyOf 属性同义归一（#146）", () => {
  it("居住地族的英文/中文措辞各自落到同一键", () => {
    // subject 侧不跨语言归一（不猜翻译），同 subject 下属性族必须合并
    const en = [
      factKeyOf("user", "live in"),
      factKeyOf("The User", "Lives in"),
      factKeyOf("user", "city of residence"),
      factKeyOf("user", "home city"),
    ];
    expect(new Set(en).size).toBe(1);
    const zh = [
      factKeyOf("用户", "住在"),
      factKeyOf("用户", "居住城市"),
      factKeyOf("用户", "居住地"),
    ];
    expect(new Set(zh).size).toBe(1);
  });

  it("职业/电话/年龄/价格族同样归一（subject 侧不跨语言，只归一属性）", () => {
    expect(factKeyOf("user", "job title")).toBe(factKeyOf("user", "occupation"));
    expect(factKeyOf("用户", "职业")).toBe(factKeyOf("用户", "职位"));
    expect(factKeyOf("user", "phone number")).toBe(factKeyOf("user", "mobile"));
    expect(factKeyOf("用户", "年龄")).toBe(factKeyOf("用户", "age"));
    expect(factKeyOf("user", "cost")).toBe(factKeyOf("user", "price"));
  });

  it("表外属性只做通用归一：大小写/空白/限定词/尾标点/所有格", () => {
    expect(factKeyOf("The User", "Favourite Drink.")).toBe(factKeyOf("user", "favourite drink"));
    expect(factKeyOf("user's", "favorite   drink")).toBe(factKeyOf("user", "favorite drink"));
  });

  it("不同属性不会被误并（宁缺毋滥：表外不猜语义）", () => {
    expect(factKeyOf("user", "favourite drink")).not.toBe(factKeyOf("user", "favourite food"));
    expect(factKeyOf("user", "live in")).not.toBe(factKeyOf("user", "work in"));
  });

  it("归一可重复调用（幂等）：写侧与 supersession 推演共用同一口径", () => {
    const once = factKeyOf("The user", "Lives in.");
    const twice = factKeyOf("the user", factKeyOf("the user", "lives in.").split("\u0000")[1]);
    expect(once).toBe(twice);
  });
});
