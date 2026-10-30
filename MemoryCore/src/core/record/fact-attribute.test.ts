/**
 * #167：抽取期受控 attribute（canonical 属性词表）——词表/归一/基数联动单测。
 *
 * 契约：
 *  - 词表封闭：只有表内名（及无歧义词形别名）通过，表外/脏值一律 undefined（走谓词启发式兜底）；
 *  - 歧义词（city/location/relationship_status）故意不收：它们分不清常住地与旅行目的地、
 *    marital 与一般关系，错并会把多值误判成 single；
 *  - 每个属性自带基数（residence 天然 single / interest 天然 multi）；
 *  - 事实键优先用 attribute：(normSubject, attribute)；无 attribute 才回落 (normSubject, normPredicate)。
 */
import { describe, it, expect } from "vitest";
import {
  ATTRIBUTE_NAMES,
  attributeCardinalityOf,
  normalizeFactAttribute,
  describeAttributes,
} from "./fact-attribute.js";
import { normalizeFactTriples } from "./fact-key.js";
import { factKeyOf } from "./supersession.js";
import { planFactRows, factRowMetadata } from "./fact-row.js";

describe("#167 受控属性词表", () => {
  it("词表封闭：表内名通过，大小写/空白/连字符归一，表外与空值一律 undefined", () => {
    expect(normalizeFactAttribute("residence")).toBe("residence");
    expect(normalizeFactAttribute("  Residence ")).toBe("residence");
    expect(normalizeFactAttribute("marital-status")).toBe("marital_status");
    expect(normalizeFactAttribute("Occupation")).toBe("occupation");
    // 别名只收同义词/词形变体（复数、下划线写法）
    expect(normalizeFactAttribute("job")).toBe("occupation");
    expect(normalizeFactAttribute("company")).toBe("employer");
    expect(normalizeFactAttribute("hobbies")).toBe("interest");
    expect(normalizeFactAttribute("plans")).toBe("plan");
    // 歧义词与表外词：不猜语义（city 可能是常住地也可能是旅行目的地，title 可能是书名）
    for (const bad of ["city", "location", "relationship_status", "title", "favorite", "count", "other", "", "  ", null, undefined, 42, {}, ["residence"]]) {
      expect(normalizeFactAttribute(bad as unknown)).toBeUndefined();
    }
  });

  it("属性自带基数：single 档与 multi 档都不为空，且互斥", () => {
    const single = ATTRIBUTE_NAMES.filter((n) => attributeCardinalityOf(n) === "single");
    const multi = ATTRIBUTE_NAMES.filter((n) => attributeCardinalityOf(n) === "multi");
    expect(single).toEqual(
      expect.arrayContaining(["residence", "occupation", "employer", "education", "age", "phone", "email", "address", "marital_status", "name"]),
    );
    expect(multi).toEqual(
      expect.arrayContaining(["interest", "plan", "preference", "goal", "habit", "possession", "health", "skill", "activity", "travel", "relationship", "opinion", "diet", "membership"]),
    );
    expect(single.length + multi.length).toBe(ATTRIBUTE_NAMES.length);
    // 词表可读描述进提示词（LLM 要按语义挑，不是按名字猜）
    const described = describeAttributes();
    for (const name of ATTRIBUTE_NAMES) expect(described).toContain(name);
  });
});

describe("#167 attribute 进入三元组与事实键", () => {
  it("normalizeFactTriples 只保留表内 attribute，脏值安静丢弃", () => {
    const triples = normalizeFactTriples([
      { subject: "user", predicate: "lives in", value: "Berlin", attribute: "residence" },
      { subject: "user", predicate: "is considering", value: "a trip", attribute: "interest" },
      { subject: "user", predicate: "has", value: "a budget", attribute: "totally-made-up" },
      { subject: "user", predicate: "likes", value: "yoga", attribute: " YOGA " },
    ]);
    expect(triples[0].attribute).toBe("residence");
    expect(triples[1].attribute).toBe("interest");
    expect(triples[2].attribute).toBeUndefined();
    expect(triples[3].attribute).toBeUndefined();
  });

  it("事实键优先 attribute：不同谓词同属性撞键；不同属性不撞；无 attribute 回落谓词", () => {
    const a = factKeyOf("user", "lives in", "residence");
    const b = factKeyOf("The User", "moved to", "residence");
    expect(a).toBe(b);
    expect(a).not.toBe(factKeyOf("user", "lives in", "occupation"));
    expect(factKeyOf("user", "lives in")).toBe(factKeyOf("The user", "Lives in."));
    expect(factKeyOf("user", "lives in")).not.toBe(a);
    // 表外 attribute 视为无 attribute（不改变键口径）
    expect(factKeyOf("user", "lives in", "made-up" as never)).toBe(factKeyOf("user", "lives in"));
  });

  it("计划事实行：键用 attribute；属性基数 > 显式 > 启发式", () => {
    const plan = planFactRows([
      { subject: "user", predicate: "lives in", value: "Berlin", attribute: "residence" },
      { subject: "user", predicate: "is considering", value: "a trip", attribute: "interest" },
    ]);
    expect(plan.rows[0].factKey).toBe(factKeyOf("user", "lives in", "residence"));
    expect(plan.rows[0].cardinality).toBe("single");
    expect(plan.rows[0].cardinalityReason).toBe("attribute:residence");
    expect(plan.rows[1].cardinality).toBe("multi");
    expect(plan.rows[1].cardinalityReason).toBe("attribute:interest");

    // 谓词启发式与属性冲突时以属性为准（residence 即使谓词带 multi 线索也是 single）
    const forced = planFactRows([{ subject: "user", predicate: "likes", value: "Berlin", attribute: "residence" }]);
    expect(forced.rows[0].cardinality).toBe("single");

    // 属性基数最高优先：封闭词表档位压过自由文本显式（写错 explicit 不改 single）
    const mislabeled = planFactRows([{ subject: "user", predicate: "lives in", value: "Berlin", attribute: "residence", cardinality: "multi" }]);
    expect(mislabeled.rows[0].cardinality).toBe("single");
    expect(mislabeled.rows[0].cardinalityReason).toBe("attribute:residence");
    // 无 attribute 时显式仍赢启发式
    const explicit = planFactRows([{ subject: "user", predicate: "likes", value: "Berlin", cardinality: "single" }]);
    expect(explicit.rows[0].cardinality).toBe("single");
    expect(explicit.rows[0].cardinalityReason).toBe("explicit");
  });

  it("属性影响同批去重：residence 同实体同属性只留首见（single），interest 可并存", () => {
    const plan = planFactRows([
      { subject: "user", predicate: "lives in", value: "Berlin", attribute: "residence" },
      { subject: "user", predicate: "moved to", value: "Munich", attribute: "residence" },
      { subject: "user", predicate: "interested in", value: "photography", attribute: "interest" },
      { subject: "user", predicate: "considering", value: "guitar", attribute: "interest" },
    ]);
    expect(plan.rows.map((r) => r.value)).toEqual(["Berlin", "photography", "guitar"]);
    expect(plan.dropped).toBe(1);
  });

  it("attribute 随 factTriples 落 metadata（不额外加专键，读侧/审计看三元组）", () => {
    const plan = planFactRows([{ subject: "user", predicate: "lives in", value: "Berlin", attribute: "residence" }]);
    const md = factRowMetadata(plan.rows[0], { parentId: "m-1", index: 0 });
    expect((md.factTriples as Array<{ attribute?: string }>)[0].attribute).toBe("residence");
    // 无 attribute 的行，三元组不带该字段（字节不变）
    const plain = planFactRows([{ subject: "user", predicate: "likes", value: "yoga" }]);
    const plainMd = factRowMetadata(plain.rows[0], { parentId: "m-2", index: 0 });
    expect((plainMd.factTriples as Array<{ attribute?: string }>)[0]).not.toHaveProperty("attribute");
    expect(plainMd).not.toHaveProperty("fact_attribute");
  });
});
