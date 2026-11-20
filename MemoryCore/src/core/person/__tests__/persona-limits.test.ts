import { describe, expect, it } from "vitest";
import { clampPersonaSections, PERSONA_SECTION_MAX_CHARS } from "../../persona/persona-limits.js";

const doc = (traits: string, narrative: string) =>
  ["# 关于我", "", "## 用户基础信息", "- 职业：后端", "", "## 用户核心特征", traits, "", "## 核心叙事", narrative, "", "## 用户偏好", "- 短句"].join("\n");

describe("clampPersonaSections：提示词里的硬约束在写出侧真的生效", () => {
  it("核心特征超 100 字被截断并留省略号，其他段不动", () => {
    const long = "我".repeat(140);
    const out = clampPersonaSections(doc(long, "正常叙事"));
    const body = out.text.split("## 用户核心特征")[1]!.split("## 核心叙事")[0]!.trim();
    expect(Array.from(body).length).toBe(PERSONA_SECTION_MAX_CHARS.coreTraits);
    expect(body.endsWith("…")).toBe(true);
    expect(out.clamped).toHaveLength(1);
    expect(out.clamped[0]!.before).toBe(140);
    expect(out.text).toContain("正常叙事");
    expect(out.text).toContain("- 短句");
  });

  it("核心叙事超 400 字被截断；英文标题同样命中", () => {
    const en = ["## User Core Traits", "喜欢简洁", "", "## Core Narrative", "x".repeat(500), "", "## 用户偏好", "- 无"].join("\n");
    const out = clampPersonaSections(en);
    expect(out.clamped).toHaveLength(1);
    expect(out.clamped[0]!.heading).toBe("## Core Narrative");
    const body = out.text.split("## Core Narrative")[1]!.split("## 用户偏好")[0]!.trim();
    expect(Array.from(body).length).toBe(PERSONA_SECTION_MAX_CHARS.coreNarrative);
  });

  it("没超长就原样返回（不制造空改动）", () => {
    const src = doc("短特征", "短叙事");
    const out = clampPersonaSections(src);
    expect(out.text).toBe(src);
    expect(out.clamped).toEqual([]);
  });
});
