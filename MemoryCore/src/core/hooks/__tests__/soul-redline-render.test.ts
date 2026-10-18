/**
 * #52 P1 红线渲染单一源单元测试（soul-redline-render.ts）。
 *
 * 合同：
 * 1. 多行 strict_rule（生产实锚：version 5=5 条、每行自带 '- ' 弹头）→ 逐行打
 *    [strict_rule] tag，弹头剥离，行体逐字保留；零 '- [strict_rule] - ' 畸形。
 * 2. 弹头方言全覆盖：'-'/'* '/'+'/'· '/'• '/数字编号（'1.'/'2、'/'3)'）；无弹头行原样。
 * 3. 空行与纯弹头行（'- '）跳过；CRLF 兼容。
 * 4. 非 strict_rule 槽不参与；多 strict_rule 槽依声明序展开。
 * 5. 段名常量与 #24-C1 段名同源（'## 不可逾越（红线）'）。
 */
import { describe, expect, it } from "vitest";
import {
  REDLINE_SECTION_TITLE,
  STRICT_RULE_SLOT,
  renderStrictRuleSectionLines,
  renderStrictRuleTaggedLine,
  renderStrictRuleTaggedLines,
  strictRuleContentLines,
  stripListBullet,
} from "../soul-redline-render.js";

const slot = (content: string) => ({ slot: "strict_rule", content });
const other = (content: string) => ({ slot: "self_identity", content });

describe("stripListBullet / strictRuleContentLines", () => {
  it("弹头方言剥离：破折号/星号/加号/间隔号/实心点/数字编号；无弹头原样", () => {
    expect(stripListBullet("- 已删弹头")).toBe("已删弹头");
    expect(stripListBullet("* 星号")).toBe("星号");
    expect(stripListBullet("+ 加号")).toBe("加号");
    expect(stripListBullet("· 间隔号")).toBe("间隔号");
    expect(stripListBullet("• 实心点")).toBe("实心点");
    expect(stripListBullet("1. 数字点")).toBe("数字点");
    expect(stripListBullet("2、顿号编号")).toBe("顿号编号");
    expect(stripListBullet("3) 括号编号")).toBe("括号编号");
    expect(stripListBullet("无弹头行")).toBe("无弹头行");
    expect(stripListBullet("唯一的-连字符不在行首")).toBe("唯一的-连字符不在行首");
  });

  it("多行拆分：CRLF 兼容、trim、空行与纯弹头行跳过、行体逐字", () => {
    const lines = strictRuleContentLines("- 第一条红线。\r\n\n- \n第二条（无弹头）。  \n- 第四条。");
    expect(lines).toEqual(["第一条红线。", "第二条（无弹头）。", "第四条。"]);
  });

  it("null/undefined/空串 → 空数组（宁缺毋滥）", () => {
    expect(strictRuleContentLines(undefined as never)).toEqual([]);
    expect(strictRuleContentLines(null as never)).toEqual([]);
    expect(strictRuleContentLines("")).toEqual([]);
  });
});

describe("renderStrictRuleTaggedLines / SectionLines", () => {
  it("生产实锚形态：5 条多行带弹头 → 逐行 tag、弹头剥离、零畸形", () => {
    const content = [
      "- 排查期间绝不可通过任何路径删除记忆（P1红线），也绝不可注入测试对话，以免测试数据永久污染l1_records。",
      "- 无论排查还是运维操作，对记忆库零删除、零注入。",
      "- 项目质量基线：typecheck 用 pnpm run typecheck，vitest 基线不突破。",
      "- 无依据不擅为。",
      "- 执行关票等永久性动作前必须先亲跑 MemoryCore 两包全量测试门。",
    ].join("\n");
    const out = renderStrictRuleTaggedLines([slot(content)]);
    expect(out).toHaveLength(5);
    for (const line of out) expect(line.startsWith("- [strict_rule] ")).toBe(true);
    expect(out.join("\n")).not.toContain("- [strict_rule] -");
    expect(out[0]).toBe("- [strict_rule] 排查期间绝不可通过任何路径删除记忆（P1红线），也绝不可注入测试对话，以免测试数据永久污染l1_records。");
  });

  it("非 strict_rule 槽不参与；多 strict_rule 槽依声明序；空槽跳过", () => {
    const out = renderStrictRuleTaggedLines([
      other("我是谁内容"),
      slot("- 第一条。"),
      other("- 不该出现。"),
      slot(""),
      slot("   "),
      slot("第二条。"),
    ]);
    expect(out).toEqual(["- [strict_rule] 第一条。", "- [strict_rule] 第二条。"]);
  });

  it("无 strict_rule / 全空 → 空数组（调用侧省略整段）", () => {
    expect(renderStrictRuleTaggedLines([other("x")])).toEqual([]);
    expect(renderStrictRuleTaggedLines([])).toEqual([]);
    expect(renderStrictRuleSectionLines([slot("")])).toEqual([]);
  });

  it("单行无弹头与旧渲染逐位等价（兼容性回归锚）", () => {
    const line = "无论排查还是运维操作，绝不可通过任何路径删除记忆。";
    expect(renderStrictRuleTaggedLines([slot(line)])).toEqual(["- [strict_rule] " + line]);
    expect(renderStrictRuleTaggedLine(line)).toBe("- [" + STRICT_RULE_SLOT + "] " + line);
  });

  it("段名常量：与 #24-C1 soul-identity 段名同源", () => {
    expect(REDLINE_SECTION_TITLE).toBe("## 不可逾越（红线）");
    expect(STRICT_RULE_SLOT).toBe("strict_rule");
  });
});
