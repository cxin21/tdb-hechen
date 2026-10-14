/**
 * P1 Task 7（worthiness importance，spec §6）：抽取解析面 RED 套件。
 * 契约：
 *  - normalizeImportance 确定性门（镜像 normalizeRecurrence 先例）：LLM 只提议、门裁决——
 *    有限数字且落在 [1,10] → round 取整；越界/NaN/Infinity/字符串/对象/缺省 → undefined
 *    （T7 审稿 I-1：不 clamp 成伪评分，宁缺毋滥）；
 *  - parseExtractionResult 集成：importance + importance_reason → 字段 + metadata
 *    （importance_reason / importance_source='llm'）；合法 importance 缺失时三处全缺席 = 现状；
 *  - 防御第二层：提示词未开启时 LLM 意外输出也被确定性门拒绝；非法输出不产生任何 importance 痕迹。
 */
import { describe, it, expect } from "vitest";
import { parseExtractionResult, normalizeImportance } from "./l1-extractor.js";

const scene = (mems: object[], name = "测试情境") =>
  JSON.stringify([{ scene_name: name, message_ids: ["m1"], memories: mems }]);

describe("normalizeImportance（确定性门）", () => {
  it("合法整数原样；小数四舍五入（TINYINT 口径）", () => {
    expect(normalizeImportance(1)).toBe(1);
    expect(normalizeImportance(10)).toBe(10);
    expect(normalizeImportance(7.6)).toBe(8);
    expect(normalizeImportance(7.4)).toBe(7);
  });
  it("越界 → undefined（审稿 I-1：不 clamp 成伪评分，宁缺毋滥）", () => {
    expect(normalizeImportance(0)).toBeUndefined();
    expect(normalizeImportance(-3)).toBeUndefined();
    expect(normalizeImportance(99)).toBeUndefined();
    expect(normalizeImportance(10.4)).toBeUndefined();
  });
  it("非法输入 → undefined（不伪造默认分）", () => {
    expect(normalizeImportance(Number.NaN)).toBeUndefined();
    expect(normalizeImportance(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeImportance("8")).toBeUndefined();
    expect(normalizeImportance(null)).toBeUndefined();
    expect(normalizeImportance(undefined)).toBeUndefined();
    expect(normalizeImportance({})).toBeUndefined();
  });
});

describe("parseExtractionResult × importance 集成", () => {
  it("合法 importance + 理由 → 字段落位 + metadata 标记（source=llm）", () => {
    const raw = scene([
      { content: "决定将发布日提前到周五", type: "episodic", importance: 8, importance_reason: "明确的排期决策" },
    ]);
    const m = parseExtractionResult(raw, undefined, [])[0].memories[0];
    expect(m.importance).toBe(8);
    expect(m.metadata.importance_reason).toBe("明确的排期决策");
    expect(m.metadata.importance_source).toBe("llm");
  });

  it("LLM 未输出 importance → 三处全缺席（现状口径，不伪造）", () => {
    const raw = scene([{ content: "今天天气不错", type: "episodic" }]);
    const m = parseExtractionResult(raw, undefined, [])[0].memories[0];
    expect(m.importance).toBeUndefined();
    expect(m.metadata.importance_reason).toBeUndefined();
    expect(m.metadata.importance_source).toBeUndefined();
  });

  it("防御第二层：字符串 '8' / NaN / 对象 → 字段缺席且无 source 标记（畸形 LLM 输出）", () => {
    const raw = scene([
      { content: "A", type: "episodic", importance: "8" },
      { content: "B", type: "episodic", importance: Number.NaN },
      { content: "C", type: "episodic", importance: { level: 8 } },
    ]);
    const mems = parseExtractionResult(raw, undefined, [])[0].memories;
    for (const m of mems) {
      expect(m.importance).toBeUndefined();
      expect(m.metadata.importance_source).toBeUndefined();
    }
  });

  it("越界值 → undefined（审稿 I-1）；小数取整；仅理由无分数 → 不标记（不伪造评分）", () => {
    const raw = scene([
      { content: "X", type: "episodic", importance: 99 },
      { content: "Y", type: "episodic", importance: 3.2 },
      { content: "Z", type: "episodic", importance_reason: "光有理由没有分数" },
    ]);
    const mems = parseExtractionResult(raw, undefined, [])[0].memories;
    expect(mems[0].importance).toBeUndefined();
    expect(mems[0].metadata.importance_source).toBeUndefined();
    expect(mems[1].importance).toBe(3);
    expect(mems[2].importance).toBeUndefined();
    expect(mems[2].metadata.importance_source).toBeUndefined();
    expect(mems[2].metadata.importance_reason).toBeUndefined();
  });

  it("理由缺失/非串/空白 → 无 importance_reason，但合法分数照常标记", () => {
    const raw = scene([
      { content: "A", type: "episodic", importance: 7 },
      { content: "B", type: "episodic", importance: 7, importance_reason: 42 },
      { content: "C", type: "episodic", importance: 7, importance_reason: "   " },
    ]);
    const mems = parseExtractionResult(raw, undefined, [])[0].memories;
    for (const m of mems) {
      expect(m.importance).toBe(7);
      expect(m.metadata.importance_source).toBe("llm");
      expect(m.metadata.importance_reason).toBeUndefined();
    }
  });
});
