import { describe, it, expect } from "vitest";
import {
  FACT_ROW_META,
  factRowIdOf,
  factRowMetadata,
  isFactRowMetadata,
  isFactRowSupersedable,
  planFactRows,
  planFactRowsFromMetadata,
} from "./fact-row.js";
import { classifyCardinality } from "./cardinality.js";
import { factKeyOf } from "./supersession.js";

/**
 * #146（W2b 事实级双时态，方案 A）：事实行规划的纯契约测试。
 * 关注点：一条事实一行、同键首见、基数裁决（显式 > 启发式 > 配置缺省）、
 * 失效范围只落到单值事实、metadata 自带追溯字段。
 */

describe("planFactRows（#146 事实行契约）", () => {
  it("一条三元组一条事实行：content 用 phrase，缺省用 subject predicate value 拼接", () => {
    const withPhrase = planFactRows([
      { subject: "用户", predicate: "粉丝数", value: "1300", phrase: "Instagram 粉丝数涨到 1300" },
    ]);
    expect(withPhrase.hasFacts).toBe(true);
    expect(withPhrase.rows).toHaveLength(1);
    expect(withPhrase.rows[0].content).toBe("Instagram 粉丝数涨到 1300");

    const withoutPhrase = planFactRows([{ subject: "用户", predicate: "住在", value: "杭州" }]);
    expect(withoutPhrase.rows[0].content).toBe("用户 住在 杭州");
  });

  it("缺 subject/predicate 的形状不进事实行（宁缺毋滥），返回 hasFacts=false 供调用方整行兜底", () => {
    const plan = planFactRows([{ phrase: "只有一条短语" }, { subject: "", predicate: "x", value: "y" }, null, 42]);
    expect(plan.hasFacts).toBe(false);
    expect(plan.rows).toEqual([]);
  });

  it("单值事实同（实体,属性）只留首见：dropped 计数可观测", () => {
    const plan = planFactRows([
      { subject: "用户", predicate: "住在", value: "杭州", cardinality: "single" },
      { subject: "用户", predicate: "住在", value: "上海", cardinality: "single" },
    ]);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].value).toBe("杭州");
    expect(plan.dropped).toBe(1);
  });

  it("多值事实同键不同值必须都进库（去重键含 value，不能吞事实）", () => {
    const plan = planFactRows([
      { subject: "用户", predicate: "喜欢", value: "徒步", cardinality: "multi" },
      { subject: "用户", predicate: "喜欢", value: "摄影", cardinality: "multi" },
      { subject: "用户", predicate: "喜欢", value: "徒步", cardinality: "multi" },
    ]);
    // 两个不同值各一行；完全重复的那条在更早的 mergeFactTriples 就按 (subject,predicate,value) 合并了，
    // 到不了事实行层——所以这里 dropped=0，是本层没吞事实的证明。
    expect(plan.rows.map((r) => r.value)).toEqual(["徒步", "摄影"]);
    expect(plan.rows.every((r) => r.cardinality === "multi")).toBe(true);
    expect(plan.dropped).toBe(0);
    // 同 fact_key（失效粒度仍是（实体,属性）），只是多值永不参与失效
    expect(plan.rows[0].factKey).toBe(plan.rows[1].factKey);
  });

  it("基数产出：显式标注优先，缺省走 classifyCardinality 启发式（不一致时显式赢）", () => {
    const multi = classifyCardinality("喜欢", "徒步").cardinality;
    const heuristic = planFactRows([{ subject: "用户", predicate: "喜欢", value: "徒步" }]);
    expect(heuristic.rows[0].cardinality).toBe(multi);
    expect(heuristic.rows[0].cardinalityReason).not.toBe("explicit");

    const explicit = planFactRows([{ subject: "用户", predicate: "喜欢", value: "徒步", cardinality: "single" }]);
    expect(explicit.rows[0].cardinality).toBe("single");
    expect(explicit.rows[0].cardinalityReason).toBe("explicit");
  });

  it("cardinalityDefault=multi：启发式落到 default-single 时收紧为 multi（不改显式标注）", () => {
    const decision = classifyCardinality("持有", "账户").cardinality;
    const loose = planFactRows([{ subject: "用户", predicate: "持有", value: "账户" }], { cardinalityDefault: "multi" });
    if (decision === "single") {
      const strict = planFactRows([{ subject: "用户", predicate: "持有", value: "账户" }], { cardinalityDefault: "multi" });
      expect(strict.rows[0].cardinality).toBe("multi");
      expect(strict.rows[0].cardinalityReason).toBe("default-multi");
    }
    // 显式标注不受缺省影响
    const explicit = planFactRows(
      [{ subject: "用户", predicate: "持有", value: "账户", cardinality: "single" }],
      { cardinalityDefault: "multi" },
    );
    expect(explicit.rows[0].cardinality).toBe("single");
    expect(loose.rows).toHaveLength(1);
  });

  it("从 metadata（facts ∪ factTriples）规划：只有三元组才成行，事实键与 factKeyOf 同口径", () => {
    const plan = planFactRowsFromMetadata({
      facts: ["用户养了一只叫团子的猫"], // 无 subject/predicate → 不单独成行（宁缺毋滥）
      factTriples: [{ subject: "用户", predicate: "养猫", value: "团子" }],
    });
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].content).toBe("用户 养猫 团子");
    expect(plan.rows[0].factKey).toBe(factKeyOf("用户", "养猫"));
  });

  it("事实行 id：0 号沿用父记忆 id（图边不悬空），其余确定性加后缀", () => {
    expect(factRowIdOf("m-1", 0)).toBe("m-1");
    expect(factRowIdOf("m-1", 1)).toBe("m-1#f2");
    expect(factRowIdOf("m-1", 2)).toBe("m-1#f3");
  });

  it("事实行 metadata：带 fact_of/fact_index/fact_key/cardinality，且 facts 只含本行事实", () => {
    const row = planFactRows([{ subject: "用户", predicate: "住在", value: "杭州", phrase: "用户住在杭州" }]).rows[0];
    const md = factRowMetadata(row, { parentId: "m-9", index: 1, validStart: "2026-10-01T00:00:00.000Z" });
    expect(md[FACT_ROW_META.factOf]).toBe("m-9");
    expect(md[FACT_ROW_META.factIndex]).toBe(1);
    expect(md[FACT_ROW_META.factKey]).toBe(factKeyOf("用户", "住在"));
    expect(md[FACT_ROW_META.cardinality]).toBe(row.cardinality);
    expect(md.subject).toBe("用户");
    expect(md.facts).toEqual(["用户住在杭州"]);
    expect(md.valid_start).toBe("2026-10-01T00:00:00.000Z");
    expect(isFactRowMetadata(md)).toBe(true);
    expect(isFactRowMetadata({ subject: "用户" })).toBe(false);
    expect(isFactRowSupersedable(row)).toBe(row.cardinality === "single");
  });
});
