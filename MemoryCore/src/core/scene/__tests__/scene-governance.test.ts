import { describe, expect, it } from "vitest";
import {
  buildDistillPrompts,
  countBlockChars,
  hardCapFallback,
  metaChars,
  needsGovernance,
  validateDistilled,
} from "../scene-governance.js";
import { formatMeta, parseSceneBlock } from "../scene-format.js";
import type { SceneBlockMeta } from "../scene-format.js";

const META: SceneBlockMeta = {
  created: "2026-09-01T00:00:00Z",
  updated: "2026-09-02T00:00:00Z",
  summary: "原始摘要",
  heat: 7,
};

function makeBlock(content: string): string {
  return `${formatMeta(META)}\n\n${content}`;
}

describe("countBlockChars（正文码点计数，排除 META 头及其后空行）", () => {
  it("排除 META 头及其后空行，仅对正文做码点计数（emoji 计 1 码点）", () => {
    // 你/好/👍/b = 4 码点（👍 在 UTF-16 占 2 个 code unit）
    expect(countBlockChars(makeBlock("你好👍b"))).toBe(4);
  });

  it("无 META 头时对全文做码点计数", () => {
    expect(countBlockChars("ab👍")).toBe(3);
  });

  it("仅 META 头、正文为空时计数为 0", () => {
    expect(countBlockChars(makeBlock(""))).toBe(0);
  });
});

describe("needsGovernance（超限判定，边界值）", () => {
  it("正文恰等于上限时判定为不超限（= 不触发）", () => {
    expect(needsGovernance(makeBlock("x".repeat(10)), 10)).toBe(false);
  });

  it("正文超出 1 码点即判定超限", () => {
    expect(needsGovernance(makeBlock("x".repeat(11)), 10)).toBe(true);
  });

  it("META 头不计入超限判定（正文很小则不治理）", () => {
    expect(needsGovernance(makeBlock("hi"), 2)).toBe(false);
  });
});

describe("buildDistillPrompts（蒸馏 prompt 内嵌 §4.1 保留优先级，spec DS-SCENE-GOV-001）", () => {
  const { systemPrompt, userPrompt } = buildDistillPrompts("【原始块内容】", 8123);

  it("systemPrompt 逐条内嵌四级保留优先级且按序出现", () => {
    expect(systemPrompt).toContain("未闭合");
    expect(systemPrompt).toContain("待确认");
    expect(systemPrompt).toContain("矛盾点");
    expect(systemPrompt).toContain("演变轨迹");
    expect(systemPrompt).toContain("时近性");
    expect(systemPrompt).toContain("近期决策");
    expect(systemPrompt).toContain("索引级");
    expect(systemPrompt).toContain("L1");
    // 优先级顺序：未闭合 < 演变轨迹 < 时近性 < 已闭合（索引级）
    const order = [
      systemPrompt.indexOf("未闭合"),
      systemPrompt.indexOf("演变轨迹"),
      systemPrompt.indexOf("时近性"),
      systemPrompt.indexOf("索引级"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("输出要求内嵌 META 头字段语义（created/updated/summary/heat）与 30-40 词重写", () => {
    expect(systemPrompt).toContain("-----META-START-----");
    expect(systemPrompt).toContain("created");
    expect(systemPrompt).toContain("updated");
    expect(systemPrompt).toContain("summary");
    expect(systemPrompt).toContain("30-40");
    expect(systemPrompt).toContain("heat");
  });

  it("两个 prompt 均内嵌上限数字，userPrompt 携带原始块内容", () => {
    expect(systemPrompt).toContain("8123");
    expect(userPrompt).toContain("8123");
    expect(userPrompt).toContain("【原始块内容】");
  });

  it("要求保持既有章节结构", () => {
    expect(systemPrompt).toContain("章节");
  });
});

describe("hardCapFallback（码点安全硬截断兜底，META 头原样保留）", () => {
  it("对代理对边界文本硬截断：截断点落在 emoji 代理对中段仍零 U+FFFD 且 META 头原样", () => {
    // 正文 105 码点：40 甲 + 25 👍（每个占 2 UTF-16 unit）+ 40 乙；
    // 预算切在正文第 60 码点 = emoji 区间中段，naive UTF-16 切割必劈代理对。
    const content = "甲".repeat(40) + "👍".repeat(25) + "乙".repeat(40);
    const raw = makeBlock(content);
    const headerPrefix = `${formatMeta(META)}\n\n`;
    const headerChars = Array.from(headerPrefix).length;
    const hardCapChars = headerChars + 60;

    const result = hardCapFallback(raw, hardCapChars);

    expect(result.includes("\uFFFD")).toBe(false);
    expect(Array.from(result).length).toBeLessThanOrEqual(hardCapChars);
    expect(result.startsWith(headerPrefix)).toBe(true);
    const parsed = parseSceneBlock(result, "x.md");
    expect(parsed.meta.created).toBe(META.created);
    expect(parsed.meta.heat).toBe(META.heat);
    expect(Array.from(parsed.content).length).toBeGreaterThan(0);
    // 截断点确实落在 emoji 区间（第 40-64 码点之间），且标注计入预算（正文恰 60 码点）
    expect(Array.from(parsed.content).length).toBe(60);
    expect(parsed.content).toContain("👍");
  });

  it("正文不超上限时原样返回（META 头 + 正文逐位不变）", () => {
    const raw = makeBlock("短正文");
    expect(hardCapFallback(raw, 1000)).toBe(raw);
  });

  it("兜底产物通过 validateDistilled（总长 ≤ 上限 + 有 META + 非空正文）", () => {
    const content = "甲".repeat(40) + "👍".repeat(25) + "乙".repeat(40);
    const raw = makeBlock(content);
    const headerChars = Array.from(`${formatMeta(META)}\n\n`).length;
    const capped = hardCapFallback(raw, headerChars + 60);
    expect(validateDistilled(capped, headerChars + 60)).toBe(true);
  });

  it("N2：输入含 U+FFFD 时兜底产物零 U+FFFD（剥离输入残留坏字符，不透传）", () => {
    // 截断点落在 emoji 区间：透传+截断本会把 U+FFFD 一并带入产物
    const content = "甲".repeat(40) + "\uFFFD".repeat(3) + "👍".repeat(25) + "乙".repeat(40);
    const raw = makeBlock(content);
    const headerPrefix = `${formatMeta(META)}\n\n`;
    const hardCapChars = Array.from(headerPrefix).length + 60;

    const capped = hardCapFallback(raw, hardCapChars);

    expect(capped.includes("\uFFFD")).toBe(false);
    expect(Array.from(capped).length).toBeLessThanOrEqual(hardCapChars);
    expect(capped.startsWith(headerPrefix)).toBe(true);
  });
});

describe("metaChars（META 头码点数，供 governor N1 巨型 META 兜底降级判定）", () => {
  it("有成对 META 头时返回头码点数（不含头后的 \\n\\n 分隔）", () => {
    expect(metaChars(makeBlock("正文"))).toBe(Array.from(formatMeta(META)).length);
  });

  it("无 META 头时返回 0", () => {
    expect(metaChars("纯正文没有 META")).toBe(0);
  });
});

describe("validateDistilled（≤上限 + 有 META 头 + 非空正文，三者全过才 true）", () => {
  it("合格蒸馏块返回 true", () => {
    // META 头本身 ≈127 码点，上限须留足余量，否则检验的不是正文条件
    expect(validateDistilled(makeBlock("蒸馏后正文"), 300)).toBe(true);
  });

  it("拒绝总长（含 META）超限的输出", () => {
    const raw = makeBlock("x".repeat(10));
    const total = Array.from(raw).length;
    expect(validateDistilled(raw, total)).toBe(true);
    expect(validateDistilled(raw, total - 1)).toBe(false);
  });

  it("拒绝无 META 头的输出", () => {
    expect(validateDistilled("纯正文没有 META", 100)).toBe(false);
  });

  it("拒绝空正文（仅 META 头；上限 300 确保拒绝原因是空正文而非超限）", () => {
    expect(validateDistilled(makeBlock(""), 300)).toBe(false);
  });

  it("拒绝含 U+FFFD 坏字符的产出（spec §4.2 ④：仍超限或含 U+FFFD → 硬截兜底）", () => {
    // 上限 300 确保拒绝原因是坏字符而非超限/空正文
    expect(validateDistilled(makeBlock("蒸馏正文\uFFFD夹坏字"), 300)).toBe(false);
  });
});
