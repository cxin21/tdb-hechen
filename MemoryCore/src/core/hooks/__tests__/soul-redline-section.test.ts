/**
 * 灵魂注入质量轮批次 2（2026-10-16，用户授权拍板 m00948「待拍板的你就按最优方案…你自己决定」）：
 * - #24-C1：strict_rule 红线独立成段「## 不可逾越（红线）」（r5-24 定案段名，进 #33 词表）——
 *   不变量（invariant）而非性格倾向，从身份叙事拆出置 soul-identity 段尾；原文直出禁改写
 *   （无预算/无截断）；无 strict_rule 整段省略（宁缺毋滥）；legacy 路径逐位不动。
 * - R5-F8：句界集统一——anchorDescOf [。！？；] 与 topDetailClause [。！？；!?\n] 不对称
 *   （第二路审查 F8），统一为共享句界集（含 \n 与半角），消价值锚行 desc 多行渲染缺陷。
 * RED 先行：以下断言按合同写，GREEN 于 soul-assembler.ts。
 */
import { describe, expect, it, vi } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function makeStore(rows: Array<Record<string, unknown>>, slots: Array<Record<string, string>> = []) {
  const listValues = vi.fn(async () => rows);
  const readCore = vi.fn(async () => slots);
  return { listValues, readCore } as never;
}

const STRICT = "无论排查还是运维操作，绝不可通过任何路径删除记忆（P1红线），也绝不可注入测试对话或测试数据。";

describe("#24-C1 红线独立段（dual 路径）", () => {
  it("strict_rule 渲染进「## 不可逾越（红线）」独立段，内容原文逐字，不再混入身份叙事行", async () => {
    const store = makeStore([], [
      { slot: "self_identity", content: "我是谁内容" },
      { slot: "strict_rule", content: STRICT },
    ]);
    const out = await buildSoulPrefix(store, TENANT, undefined, { selfIdentityEnabled: true });
    expect(out).toContain("## 不可逾越（红线）");
    expect(out).toContain(`- [strict_rule] ${STRICT}`); // 原文直出（逐字）
    // 不再与身份散文混排：strict 不应出现在「## 此刻的你」段行内
    const narrative = out.split("## 此刻的你")[1]?.split("## 不可逾越（红线）")[0] ?? "";
    expect(narrative).not.toContain("strict_rule");
    // 段序：红线段在 soul-identity 段尾（此刻的你之后、</soul-identity> 之前）
    const idBlock = out.split("<soul-identity>")[1]?.split("</soul-identity>")[0] ?? "";
    expect(idBlock.indexOf("## 不可逾越（红线）")).toBeGreaterThan(idBlock.indexOf("## 此刻的你"));
    expect(idBlock.indexOf(`- [strict_rule] ${STRICT}`)).toBeGreaterThan(idBlock.indexOf("## 不可逾越（红线）"));
  });

  it("无 strict_rule → 红线段整体省略（宁缺毋滥）", async () => {
    const store = makeStore([], [{ slot: "self_identity", content: "我是谁内容" }]);
    const out = await buildSoulPrefix(store, TENANT, undefined, { selfIdentityEnabled: true });
    expect(out).not.toContain("不可逾越");
  });

  it("无身份 slot、仅 strict_rule → soul-identity 只含红线段（不造空叙事）", async () => {
    const store = makeStore([], [{ slot: "strict_rule", content: STRICT }]);
    const out = await buildSoulPrefix(store, TENANT, undefined, { selfIdentityEnabled: true });
    expect(out).toContain("<soul-identity>");
    expect(out).toContain("## 不可逾越（红线）");
    expect(out).not.toContain("## 此刻的你\n\n"); // 无空叙事段
  });

  it("legacy 路径（selfIdentityEnabled=false）逐位不动：strict_rule 仍为普通 slot 行", async () => {
    const store = makeStore([], [{ slot: "strict_rule", content: STRICT }]);
    const out = await buildSoulPrefix(store, TENANT, undefined, {});
    expect(out).toContain(`- [strict_rule] ${STRICT}`);
    expect(out).not.toContain("不可逾越");
  });
});

describe("R5-F8 句界集统一（共享句界常量，含 \\n 与半角）", () => {
  it("价值锚行 desc 含换行 → 截至首句，消除多行渲染缺陷", async () => {
    const store = makeStore([
      { value_id: "a", label: "根因", weight: 0.8, valence: 1, state: "active", node_type: "theme", attrs_json: JSON.stringify({ description: "第一句事实。\n第二句细节" }) },
    ]);
    const out = await buildSoulPrefix(store, TENANT, undefined, { selfIdentityEnabled: true });
    expect(out).toContain("根因(趋近)：第一句事实。");
    expect(out).not.toContain("第二句细节");
  });

  it("价值锚行 desc 半角句界（! 或 ?）同样截断（句界集跨全半角对称）", async () => {
    const store = makeStore([
      { value_id: "a", label: "风险", weight: 0.6, valence: -1, state: "active", node_type: "theme", attrs_json: JSON.stringify({ description: "先验配置物化!再定位根因" }) },
    ]);
    const out = await buildSoulPrefix(store, TENANT, undefined, { selfIdentityEnabled: true });
    expect(out).toContain("风险(审慎)：先验配置物化!");
    expect(out).not.toContain("再定位根因");
  });

  it("首要子句与价值锚行同句界：desc 首句含半角句界时两处一致（单一源）", async () => {
    const store = makeStore([
      { value_id: "a", label: "根因", weight: 0.8, valence: 1, state: "active", node_type: "theme", attrs_json: JSON.stringify({ description: "第一句事实!\n第二句细节" }) },
    ]);
    const out = await buildSoulPrefix(store, TENANT, undefined, { selfIdentityEnabled: true });
    // 价值锚行与感受段首要子句使用同一句界集，渲染口径一致
    expect(out).toContain("根因(趋近)：第一句事实!");
    expect(out).toContain("根因（首要：第一句事实!）");
    expect(out).not.toContain("第二句细节");
  });
});
