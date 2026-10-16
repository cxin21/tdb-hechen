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

  it("maxLines 可传：截到指定行数（策展上限由调用方/合同决定）", () => {
    const lines = curateToolCapabilities(
      [tool("t1", "一"), tool("t2", "二"), tool("t3", "三")],
      2,
    );
    expect(lines).toEqual(["t1：一", "t2：二"]);
  });
});
