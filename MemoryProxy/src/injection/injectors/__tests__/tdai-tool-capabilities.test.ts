/**
 * #40（ADR0003-P3 接线票 B）· 工具面策展器 curateToolCapabilities 契约单测。
 *
 * 合同（#40 票面 + ADR0003 §6 接线票 B + #32 渲染一致性合同）：
 *   - 模板直出（禁 LLM、禁逐字 L1 片段，#27 范式）：行 = `能力名：一句话`
 *     （描述取首行、>80 字符截断加 …；空描述 → 裸名）；
 *   - ≤5 行：声明序前 5（确定性输出，KV cache 稳定）；
 *   - 跳过空/纯空白名（宁缺毋滥）；空工具面 → 空数组；
 *   - 记忆化：同工具面（指纹 = [name,description][] 序列化 FNV-1a 32bit）→ 同引用
 *     （工具面未变更不重策展）；内容变更 → 重策展新引用；上限 100 条淘汰不崩。
 *
 * #40-B（ADR0003 派生票 B，2026-10-17）工具面数据源合同修订：新增 config lines
 * 显式通道（第 3 参，readonly string[]）——非空时逐字 1:1 直出（config 即数据源，
 * 工具面实况不参与、不做 firstLine 截断），仍受 maxLines 上限保护；缺失/空 →
 * 回退既有运行时策展（逐位现状）。指纹覆盖 lines（变更即缓存失效重算）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { curateToolCapabilities, resetToolCapabilityCacheForTest } from "../tdai-tool-capabilities.js";
import type { AgentTool } from "../../types.js";

const tool = (name: string, description?: string): AgentTool => ({
  name,
  description: description ?? "",
  parameters: {},
});

describe("#40 · curateToolCapabilities（模板直出 ≤5 行）", () => {
  beforeEach(() => resetToolCapabilityCacheForTest());

  it("≤5 行：7 个工具只出声明序前 5（顺序保持）", () => {
    const lines = curateToolCapabilities([
      tool("t1", "能力一"),
      tool("t2", "能力二"),
      tool("t3", "能力三"),
      tool("t4", "能力四"),
      tool("t5", "能力五"),
      tool("t6", "能力六"),
      tool("t7", "能力七"),
    ]);
    expect(lines).toHaveLength(5);
    expect(lines).toEqual(["t1：能力一", "t2：能力二", "t3：能力三", "t4：能力四", "t5：能力五"]);
  });

  it("行格式：描述取首行；>80 字符截断加省略号；空描述 → 裸名", () => {
    const long = "很".repeat(81);
    const lines = curateToolCapabilities([
      tool("multi", "第一行说明\n第二行说明"),
      tool("long", long),
      tool("nodesc"),
    ]);
    expect(lines).toEqual([
      "multi：第一行说明",
      `long：${"很".repeat(80)}…`,
      "nodesc",
    ]);
  });

  it("空/纯空白名跳过（宁缺毋滥）；空工具面 → 空数组", () => {
    expect(curateToolCapabilities([tool("  ", "空白名"), tool("", "空名"), tool("ok", "有效")]))
      .toEqual(["ok：有效"]);
    expect(curateToolCapabilities([])).toEqual([]);
  });

  it("描述以前导空行开头：取首个非空行而非退化裸名（#40 审查 R4）", () => {
    const lines = curateToolCapabilities([tool("lead", "\n  \n真实自述\n后续行")]);
    expect(lines).toEqual(["lead：真实自述"]);
    expect(curateToolCapabilities([tool("blank", "\n \n ")])).toEqual(["blank"]); // 全空仍裸名
  });

  it("缓存引用冻结：调用方突变不污染缓存（#40 审查 R5）", () => {
    const first = curateToolCapabilities([tool("t1", "能力一")]);
    expect(Object.isFrozen(first)).toBe(true);
    const again = curateToolCapabilities([tool("t1", "能力一")]);
    expect(again).toBe(first);
    expect(again).toEqual(["t1：能力一"]); // 突变尝试后内容不变
  });

  it("记忆化：同工具面（内容相同的不同数组）→ 同引用；内容变更 → 重策展", () => {
    const toolsA = [tool("t1", "能力一"), tool("t2", "能力二")];
    const toolsA2 = [tool("t1", "能力一"), tool("t2", "能力二")];
    const first = curateToolCapabilities(toolsA);
    expect(curateToolCapabilities(toolsA2)).toBe(first);
    const changed = curateToolCapabilities([tool("t1", "能力一"), tool("t2", "能力二改")]);
    expect(changed).not.toBe(first);
    expect(changed).toEqual(["t1：能力一", "t2：能力二改"]);
  });

  it("maxLines 可传：截到指定行数（策展上限由调用方/合同决定）；缓存键含 maxLines（审查 M-2）", () => {
    const three = [tool("t1", "一"), tool("t2", "二"), tool("t3", "三")];
    expect(curateToolCapabilities(three, 2)).toEqual(["t1：一", "t2：二"]);
    // 同工具面不同 maxLines → 不命中截断缓存，重策展出 3 行
    expect(curateToolCapabilities(three, 3)).toEqual(["t1：一", "t2：二", "t3：三"]);
  });
});

// ═══════════════ #40-B（ADR0003 派生票 B）· config lines 显式数据源通道 ═══════════════

describe("#40-B · curateToolCapabilities config lines 显式通道（工具面数据源合同修订）", () => {
  beforeEach(() => resetToolCapabilityCacheForTest());

  it("lines 非空 → 逐字 1:1 直出（config 即数据源：工具面不参与、>80 字符不截、空工具面也直出）", () => {
    const lines = [
      "通用开发协作：代码取证、缺陷定位、测试驱动实现",
      `超长行${"很".repeat(120)}`, // >80 字符：lines 通道不做 firstLine 截断
    ];
    // 工具面在场也不参与策展（换工具面输出不变）
    expect(curateToolCapabilities([tool("t1", "能力一")], undefined, lines)).toEqual(lines);
    // 空工具面同样直出（config 是唯一数据源）
    expect(curateToolCapabilities([], undefined, lines)).toEqual(lines);
  });

  it("lines 仍受 maxLines 上限保护：截到前 maxLines 条（缺省 5 与显式值同效），输出冻结", () => {
    const lines = ["一", "二", "三", "四", "五", "六"];
    const clipped = curateToolCapabilities([], undefined, lines);
    expect(clipped).toEqual(["一", "二", "三", "四", "五"]);
    expect(Object.isFrozen(clipped)).toBe(true);
    expect(curateToolCapabilities([], 2, lines)).toEqual(["一", "二"]);
  });

  it("lines 缺失/空数组 → 回退运行时策展，与旧逻辑逐位一致（同缓存引用=回归锚）", () => {
    const tools = [tool("t1", "能力一"), tool("t2", "能力二")];
    const baseline = curateToolCapabilities(tools);
    expect(baseline).toEqual(["t1：能力一", "t2：能力二"]);
    expect(curateToolCapabilities(tools, undefined, undefined)).toBe(baseline);
    expect(curateToolCapabilities(tools, undefined, [])).toBe(baseline);
  });

  it("lines 变更 → 指纹覆盖 lines：换行重算新引用，同行复用缓存引用", () => {
    const a = curateToolCapabilities([], undefined, ["行A"]);
    const b = curateToolCapabilities([], undefined, ["行B"]);
    expect(b).not.toBe(a);
    expect(b).toEqual(["行B"]);
    expect(curateToolCapabilities([], undefined, ["行A"])).toBe(a);
  });
});

// ═══════════════ kill switch（m00265 用户终审：能力段整段摘除）═══════════════

describe("kill switch · curateToolCapabilities enabled=false → 整段摘除（先于 literal/策展两路径）", () => {
  beforeEach(() => resetToolCapabilityCacheForTest());

  it("enabled=false + config lines 非空 → 返回空数组（config 逐字直出路径也被门住）", () => {
    expect(curateToolCapabilities([], undefined, ["手写行"], false)).toEqual([]);
  });

  it("enabled=false + 无 config lines → 返回空数组（运行时策展路径也被门住）", () => {
    const lines = curateToolCapabilities([tool("t1", "能力一"), tool("t2", "能力二")], undefined, undefined, false);
    expect(lines).toEqual([]);
    expect(Object.isFrozen(lines)).toBe(true);
  });

  it("kill switch 不入缓存：关断期后恢复 enabled=true，输出与从未关断逐位一致（无缓存污染）", () => {
    const before = curateToolCapabilities([tool("t1", "能力一")]);
    curateToolCapabilities([tool("t1", "能力一")], undefined, undefined, false); // 关断调用
    const after = curateToolCapabilities([tool("t1", "能力一")]);
    expect(after).toEqual(["t1：能力一"]);
    expect(after).toBe(before); // 同指纹同引用：关断未污染策展缓存
  });

  it("enabled 缺省（undefined）→ 行为零变化（literal 与策展两路径回归锚）", () => {
    const lines = ["缺省启用行"];
    expect(curateToolCapabilities([], undefined, lines, undefined)).toEqual(lines);
    expect(curateToolCapabilities([tool("t1", "能力一")], undefined, undefined, undefined)).toEqual(["t1：能力一"]);
  });
});
