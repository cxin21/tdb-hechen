/**
 * V12-CV（拍板执行⑤，2026-09-26 何晨委托「你自己给一个最优方案」）：core_value 提案采纳
 * 转换层确定性门。
 * 缺陷实锚：v2-router.ts:1870 采纳分支 upsertValue(growthValueId(content), content, …) 以整段
 * 描述当锚 label（锚行灾难性污染，29 条 core_value 提案因此全拒、采纳链从未对 core_value 闭合）。
 * coerceCoreValueAnchor：label 门（非空/≤8 字/无 JSON 结构残留）+description 回退链
 * （缺省 → content 前 60 字）；返回 null = 门不过（router 422，pending 保持不动，不暗箱替用户裁决）。
 */
import { describe, it, expect } from "vitest";
import { coerceCoreValueAnchor } from "./pending-adopt-merge.js";

describe("coerceCoreValueAnchor（core_value 采纳转换层确定性门，V12-CV）", () => {
  it("label+description 齐备 → 原样通过（valueIdSeed=label）", () => {
    const r = coerceCoreValueAnchor({ label: "取证先行", description: "先取证再下结论的工作纪律", content: "用户要求且 AI 已承诺取证先行：先取证再下结论" });
    expect(r).not.toBeNull();
    expect(r!.label).toBe("取证先行");
    expect(r!.description).toBe("先取证再下结论的工作纪律");
    expect(r!.valueIdSeed).toBe("取证先行");
  });
  it("label 缺失/空白/null → null（门不过）", () => {
    expect(coerceCoreValueAnchor({ content: "旧格式提案无 label" })).toBeNull();
    expect(coerceCoreValueAnchor({ label: "   ", content: "x" })).toBeNull();
    expect(coerceCoreValueAnchor({ label: null, content: "x" })).toBeNull();
  });
  it("label 超 8 字 → null", () => {
    expect(coerceCoreValueAnchor({ label: "这是一个超过八个字的标签文案", content: "x" })).toBeNull();
  });
  it("label JSON/结构符号残留 → null", () => {
    expect(coerceCoreValueAnchor({ label: '{"slot":"core_value"}', content: "x" })).toBeNull();
    expect(coerceCoreValueAnchor({ label: "含:半角冒号", content: "x" })).toBeNull();
    expect(coerceCoreValueAnchor({ label: "带\"引号\"", content: "x" })).toBeNull();
  });
  it("description 缺失 → content 前 60 字回退；超 60 字截断", () => {
    const r1 = coerceCoreValueAnchor({ label: "闭环", content: "每个批次都四态收口，问题不过夜" });
    expect(r1!.description).toBe("每个批次都四态收口，问题不过夜");
    const r2 = coerceCoreValueAnchor({ label: "闭环", content: "很".repeat(80) });
    expect([...r2!.description]).toHaveLength(60);
  });
});
