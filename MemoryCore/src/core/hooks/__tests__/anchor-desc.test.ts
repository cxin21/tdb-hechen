/**
 * P0-1A（issue #1，2026-10-13）：锚点 description 写入口 sanitizer 单一源测试。
 * sanitizeAnchorDescription = pending-adopt-merge.sanitizeDescription 原样搬迁
 * （原文件测试钉死的行为逐位保留）；anchorDescriptionAttr = 采纳端便捷口
 * （sanitize + episode 双门 → 非空才回 {description}）。
 */
import { describe, it, expect } from "vitest";
import { sanitizeAnchorDescription, anchorDescriptionAttr, DESC_CONTRACT_V2, descContractPromptLine, passesDescContractV2 } from "../anchor-desc.js";

describe("sanitizeAnchorDescription（单一源，pending-adopt-merge 钉死行为逐位保留）", () => {
  it("尾悬空标点 → 置空（宁缺毋滥不入半句）", () => {
    expect(sanitizeAnchorDescription("证据裁决一切，", 60)).toBe("");
  });
  it("60 字内完整短语 → 原样保留", () => {
    expect(sanitizeAnchorDescription("所有结论须以真实代码与测试取证背书", 60)).toBe("所有结论须以真实代码与测试取证背书");
    expect(sanitizeAnchorDescription("保持审慎", 60)).toBe("保持审慎");
  });
  it("句末标点截断 → 截到最后句末标点", () => {
    expect(sanitizeAnchorDescription("证据裁决一切。拒绝粉饰，", 60)).toBe("证据裁决一切。");
  });
  it("超长且窗口内无句末标点 → 置空（半句实锤）", () => {
    expect(sanitizeAnchorDescription("这是一段完全没有标点的长文本流用于验证写入口截断置空门判定行为是否正确" + "xxxxxxxxxx".repeat(6), 60)).toBe("");
  });
  it("空/空白 → 空串", () => {
    expect(sanitizeAnchorDescription("", 60)).toBe("");
    expect(sanitizeAnchorDescription("   ", 60)).toBe("");
  });
});

describe("anchorDescriptionAttr（采纳端便捷口）", () => {
  it("合格 rationale → {description}", () => {
    expect(anchorDescriptionAttr("先定位根因再动手改。")).toEqual({ description: "先定位根因再动手改。" });
  });
  it("空/undefined → undefined（attrs_json 不写 description 字段）", () => {
    expect(anchorDescriptionAttr("")).toBeUndefined();
    expect(anchorDescriptionAttr(undefined)).toBeUndefined();
    expect(anchorDescriptionAttr(null)).toBeUndefined();
    expect(anchorDescriptionAttr("   ")).toBeUndefined();
  });
  it("悬空尾 → undefined", () => {
    expect(anchorDescriptionAttr("证据裁决一切，")).toBeUndefined();
  });
  it("episode 特征（ISO 日期/HTTP/commit hash）→ undefined（锚保留，desc 不落库）", () => {
    expect(anchorDescriptionAttr("2026-09-01 部署完成。")).toBeUndefined();
    expect(anchorDescriptionAttr("探针 HTTP 200 通过。")).toBeUndefined();
    expect(anchorDescriptionAttr("提交 b1ea2e5 修复。")).toBeUndefined();
  });
  it("custom maxChars 生效（窗口含句末标点 → 截到句末；无标点 → 置空）", () => {
    expect(anchorDescriptionAttr("先定位根因。再动手改。", 6)).toEqual({ description: "先定位根因。" });
    expect(anchorDescriptionAttr("先定位根因再动手改。", 5)).toBeUndefined();
  });
});

describe("#20 T13：desc 内容合同 v2（情境短语+行为取向）", () => {
  it("DESC_CONTRACT_V2 单一源常量齐全（maxChars=60 / rule / bans / goodExample）", () => {
    expect(DESC_CONTRACT_V2.maxChars).toBe(60);
    expect(DESC_CONTRACT_V2.rule).toContain("情境短语");
    expect(DESC_CONTRACT_V2.rule).toContain("行为取向");
    expect(DESC_CONTRACT_V2.bans.length).toBeGreaterThanOrEqual(2);
    expect(DESC_CONTRACT_V2.goodExample).toContain("宁可");
  });
  it("descContractPromptLine 拼出完整合同片段（含禁写与好例）", () => {
    const line = descContractPromptLine();
    expect(line).toContain("情境短语 + 行为取向");
    expect(line).toContain("宁可慢一步验证");
    expect(line).toContain("宁缺毋滥");
  });
  it("passesDescContractV2：取向句式 → true", () => {
    expect(passesDescContractV2("涉及不可再生数据时，宁可慢一步验证，不做不可逆操作。")).toBe(true);
    expect(passesDescContractV2("遇灰色地带先影子验证再落库，而不是直接写主路径。")).toBe(true);
    expect(passesDescContractV2("冲突时优先保全证据，再讨论结论。")).toBe(true);
    expect(passesDescContractV2("决策先固化为显式阈值再定案。")).toBe(true);
  });
  it("passesDescContractV2：纯定义句 → false", () => {
    expect(passesDescContractV2("记忆数据很重要。")).toBe(false);
    expect(passesDescContractV2("数据完整优先是团队的核心原则。")).toBe(false);
    expect(passesDescContractV2("根因优先。")).toBe(false); // 无取向特征
  });
  it("passesDescContractV2：episode 特征 → false（episode 门同源）", () => {
    expect(passesDescContractV2("2026-09-01 部署完成。")).toBe(false);
    expect(passesDescContractV2("探针 HTTP 200 通过。")).toBe(false);
  });
  it("passesDescContractV2：sanitize 置空（断尾/空）→ false", () => {
    expect(passesDescContractV2("")).toBe(false);
    expect(passesDescContractV2("证据裁决一切，")).toBe(false);
  });
});
