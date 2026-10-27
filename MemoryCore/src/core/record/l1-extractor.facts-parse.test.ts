/**
 * #137（W1 双通道）：多事实落库解析面套件。
 * 契约：
 *  - 关闭（缺省 / 显式 enabled:false）：完全忽略 LLM 输出的 facts —— metadata 不出现
 *    facts / factTriples（现状形状不变）；
 *  - 开启：normalizeFacts 归一化（折叠空白 / 大小写与尾随标点去重 / 去噪 / 封顶 maxFacts）
 *    → metadata.facts（string[]）；
 *  - includeTriples 且三元组非空 → metadata.factTriples（subject/predicate 必填，value 可空）；
 *  - 脏形状（null / 数字 / 空串 / 纯标点 / 超长 / 嵌套对象 / 非数组）不抛错且被丢弃（宁缺毋滥）；
 *  - 既有 metadata 键（activity_start_time 等）逐位保留；事实全被去噪时不写键。
 */
import { describe, it, expect } from "vitest";
import { parseExtractionResult } from "./l1-extractor.js";

type FactsGate = { enabled: boolean; maxFacts: number; includeTriples: boolean };

const FACTS_ON: FactsGate = { enabled: true, maxFacts: 5, includeTriples: false };

const scene = (mems: object[], name = "测试情境") =>
  JSON.stringify([{ scene_name: name, message_ids: ["m1"], memories: mems }]);

/** 取第 idx 条 memory 的 metadata（未传 facts 门 = 现状口径）。 */
const metaOf = (raw: string, facts?: FactsGate, idx = 0) =>
  parseExtractionResult(raw, undefined, [], facts ? { facts } : undefined)[0].memories[idx].metadata;

describe("parseExtractionResult × facts（#137 多事实落库）", () => {
  it("开启：facts 归一化落 metadata.facts（折叠空白 + 去重 + 保留首见顺序）", () => {
    const raw = scene([
      {
        content: "用户养猫并住在杭州",
        type: "persona",
        facts: ["  用户养了一只叫团子的猫  ", "用户住在杭州", "User lives in Hangzhou", "user lives in hangzhou."],
      },
    ]);
    expect(metaOf(raw, FACTS_ON).facts).toEqual([
      "用户养了一只叫团子的猫",
      "用户住在杭州",
      "User lives in Hangzhou",
    ]);
  });

  it("开启：封顶 maxFacts（配置 1..12，超出的按首见顺序舍弃）", () => {
    const raw = scene([{ content: "x", type: "persona", facts: ["f1", "f2", "f3", "f4"] }]);
    expect(metaOf(raw, { ...FACTS_ON, maxFacts: 2 }).facts).toEqual(["f1", "f2"]);
    expect(metaOf(raw, { ...FACTS_ON, maxFacts: 12 }).facts).toEqual(["f1", "f2", "f3", "f4"]);
  });

  it("关闭：即使 JSON 带 facts（短语与三元组）也完全不落 metadata", () => {
    const raw = scene([
      {
        content: "用户住在杭州",
        type: "persona",
        facts: ["用户住在杭州", { subject: "用户", predicate: "住在", value: "杭州" }],
      },
    ]);
    // 缺省（不传门）
    expect(metaOf(raw)).toEqual({});
    // 显式关闭
    const off = metaOf(raw, { ...FACTS_ON, enabled: false });
    expect(off).toEqual({});
    expect(off.facts).toBeUndefined();
    expect(off.factTriples).toBeUndefined();
  });

  it("includeTriples：三元组落 metadata.factTriples；关闭时只展开成短语、不落三元组", () => {
    const raw = scene([
      {
        content: "用户住在杭州并在浙江大学就读",
        type: "persona",
        facts: [
          "用户住在杭州",
          { subject: "用户", predicate: "就读于", value: "浙江大学" },
          { subject: "", predicate: "住在", value: "上海" }, // subject 缺 → 丢（不猜）
        ],
      },
    ]);
    const on = metaOf(raw, { ...FACTS_ON, includeTriples: true });
    expect(on.factTriples).toEqual([{ subject: "用户", predicate: "就读于", value: "浙江大学" }]);
    // 短语侧同 fact-key 口径：三元组展开成自足短语
    expect(on.facts).toEqual(["用户住在杭州", "用户 就读于 浙江大学"]);

    const off = metaOf(raw, FACTS_ON);
    expect(off.factTriples).toBeUndefined();
    expect(off.facts).toEqual(["用户住在杭州", "用户 就读于 浙江大学"]);
  });

  it("脏形状不抛错且被丢弃（null / 数字 / 空串 / 纯标点 / 过短 / 超长 / 嵌套对象 / 数组元素）", () => {
    const long = "x".repeat(300);
    const raw = scene([
      {
        content: "x",
        type: "persona",
        facts: [null, 42, "", "   ", "。", "a", long, { foo: "bar" }, [], "有效事实"],
      },
    ]);
    expect(metaOf(raw, FACTS_ON).facts).toEqual(["有效事实"]);
    expect(() => parseExtractionResult(raw, undefined, [], { facts: FACTS_ON })).not.toThrow();
  });

  it("facts 非数组 / 非字符串单值：照收或丢弃，不抛错", () => {
    expect(metaOf(scene([{ content: "x", type: "persona", facts: "单条字符串" }]), FACTS_ON).facts).toEqual([
      "单条字符串",
    ]);
    expect(metaOf(scene([{ content: "x", type: "persona", facts: 42 }]), FACTS_ON).facts).toBeUndefined();
    expect(metaOf(scene([{ content: "x", type: "persona", facts: null }]), FACTS_ON).facts).toBeUndefined();
  });

  it("全部被去噪 → 不写 facts 键（不落空数组污染 metadata）", () => {
    const raw = scene([{ content: "x", type: "persona", facts: ["", "。", "a"] }]);
    expect(metaOf(raw, FACTS_ON).facts).toBeUndefined();
  });

  it("既有 metadata 键逐位保留（facts 是增量，不覆盖其他键）", () => {
    const raw = scene([
      {
        content: "用户 2026-09-05 在杭州签约",
        type: "episodic",
        facts: ["用户 2026-09-05 在杭州签约"],
        metadata: { activity_start_time: "2026-09-05T00:00:00.000Z" },
      },
    ]);
    const md = metaOf(raw, FACTS_ON);
    expect(md.activity_start_time).toBe("2026-09-05T00:00:00.000Z");
    expect(md.facts).toEqual(["用户 2026-09-05 在杭州签约"]);
  });

  it("开启：metadata 里 LLM 私塞的原始 facts/factTriples 被归一化结果替换（脏值不绕过确定性门）", () => {
    const raw = scene([
      {
        content: "x",
        type: "persona",
        facts: ["干净事实"],
        metadata: {
          facts: ["  ！！ ", "原样脏值"],
          factTriples: [{ subject: "", predicate: "", value: "" }],
          other: 1,
        },
      },
    ]);
    const md = metaOf(raw, FACTS_ON);
    expect(md.facts).toEqual(["干净事实"]);
    expect(md.factTriples).toBeUndefined();
    expect(md.other).toBe(1);
  });

  it("跨记忆独立：无事实的那条不写 facts 键", () => {
    const raw = scene([
      { content: "有事实", type: "persona", facts: ["用户住在杭州"] },
      { content: "无事实", type: "persona" },
    ]);
    const scenes = parseExtractionResult(raw, undefined, [], { facts: FACTS_ON });
    expect(scenes[0].memories[0].metadata.facts).toEqual(["用户住在杭州"]);
    expect(scenes[0].memories[1].metadata.facts).toBeUndefined();
  });
});
