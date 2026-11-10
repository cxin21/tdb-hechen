/**
 * #67（R3 身份叙事层，2026-10-19）：identity / self_identity 两槽确定性叙事组装器测试。
 *
 * 合同（docs/research/2026-10-19-r3-identity-narrative-layer-design.md = issue #67）：
 * - A 案确定性叙事组装：模板常量 + 事实句逐字保留——无 LLM、无随机、无时钟
 *   （双跑逐字节一致）；仅 identity / self_identity 两槽叙事化，strict_rule 与价值锚不动。
 * - Park 2411.10109 口径：条目存储 + 叙事渲染**并存**（渲染侧派生不回写存储）。
 * - 真实性守门三闸（全部可测试）：生成闸=叙事输出 ⊆ 模板常量 ∪ slots 原文子串
 *   （verifyNarrativeProvenance，违例整段丢弃退回条目渲染）；写入闸=纯函数零副作用
 *   （结构保证：本文件任何测试断言无写路径）；预算闸=超预算整句 drop、保留句逐字。
 * - soul 集成（2026-11-07 task-6 退役）：人格注入移交 DSH 插件，soul-assembler 不再渲染
 *   身份两行，故本文件只保留叙事组装器本身的用例；集成段随旧渲染链一并删除。
 */
import { describe, expect, it } from "vitest";
import {
  IDENTITY_NARRATIVE_SLOT,
  NARRATIVE_TEMPLATE_VERSION,
  renderIdentityNarrative,
  verifyNarrativeProvenance,
} from "../identity-narrative.js";

const NARR_HEAD = "以下事实由你和团队共同写就：";
const NARR_SELF = "- 我是谁：";
const NARR_USER = "- 我心中的他：";
const NARR_TAIL = "这些由你和团队共同确认，请把它们当作当下相处的事实。";

const slots = [
  { slot: "self_identity", content: "我是测试者。" },
  { slot: "identity", content: "用户是系统维护者。" },
  { slot: "strict_rule", content: "绝不可删除记忆。" },
];

describe("#67 renderIdentityNarrative：确定性叙事组装（A 案）", () => {
  it("模板指纹常量在场且为 nv 前缀（ADR-0003 §5 批次纪律：模板变更一次性声明）", () => {
    expect(NARRATIVE_TEMPLATE_VERSION).toMatch(/^nv-/);
    expect(IDENTITY_NARRATIVE_SLOT).toBe("identity_narrative");
  });

  it("事实句逐字保留：self/identity 各一行成句，模板常量原样，strict_rule 不参与", () => {
    const narr = renderIdentityNarrative(slots);
    expect(narr).toBe(
      [NARR_HEAD, "- 我是谁：我是测试者。", "- 我心中的他：用户是系统维护者。", NARR_TAIL].join("\n"),
    );
    // 真实性：事实句是 slots 原文子串（逐字，无转写）；strict_rule 内容不出现
    expect(narr).toContain("我是测试者。");
    expect(narr).toContain("用户是系统维护者。");
    expect(narr).not.toContain("绝不可删除记忆。");
  });

  it("确定性：同输入双跑逐字节一致（无 LLM/随机/时钟）", () => {
    expect(renderIdentityNarrative(slots)).toBe(renderIdentityNarrative(slots));
  });

  it("渲染序不变量：self_identity（我是谁）先于 identity（我心中的他）", () => {
    const narr = renderIdentityNarrative(slots)!;
    expect(narr.indexOf(NARR_SELF)).toBeGreaterThan(-1);
    expect(narr.indexOf(NARR_SELF)).toBeLessThan(narr.indexOf(NARR_USER));
  });

  it("多行内容按行成句、组内以模板分隔符连接（每句仍是原文行逐字）", () => {
    const narr = renderIdentityNarrative([
      { slot: "self_identity", content: "我是测试者。\n也负责代码评审。" },
      { slot: "identity", content: "用户是系统维护者。" },
    ]);
    expect(narr).toContain("- 我是谁：我是测试者。；也负责代码评审。");
    expect(narr).toContain("- 我心中的他：用户是系统维护者。");
  });

  it("预算闸：超预算句整体 drop（不截半句），保留句逐字", () => {
    const narr = renderIdentityNarrative(
      [{ slot: "self_identity", content: "短句。\n这句超预算了。\n短句二。" }],
      { budgetChars: 6 },
    );
    // facts: 短句。(3) / 这句超预算了。(7) / 短句二。(4)；预算 6 → 首句保留（used=3），
    // 第 2 句 3+7>6 → 尾丢（首个超限句连同其后全部丢弃——truncateByLines/applyAnchorBudget
    // 同哲学：整句粒度不截半句、尾丢确定性）。
    expect(narr).toContain("- 我是谁：短句。");
    expect(narr).not.toContain("超预算");
    expect(narr).not.toContain("短句二。");
    expect(narr).not.toContain("…"); // 不截半句、无省略号
  });

  it("无身份内容（缺槽/空串/纯空白）→ null（宁缺毋滥，调用方退回条目渲染）", () => {
    expect(renderIdentityNarrative([])).toBeNull();
    expect(renderIdentityNarrative([{ slot: "strict_rule", content: "绝不可删除记忆。" }])).toBeNull();
    expect(renderIdentityNarrative([{ slot: "self_identity", content: "  \n " }])).toBeNull();
  });

  it("生成闸：渲染产物通过 verifyNarrativeProvenance（独立复验 ⊆ 模板 ∪ 原文）", () => {
    const narr = renderIdentityNarrative(slots)!;
    expect(verifyNarrativeProvenance(narr, slots)).toBe(true);
  });

  it("生成闸违例：混入外部材料/非身份槽内容/被改写的事实 → false", () => {
    // 外部行（既非模板常量也非标签行）
    expect(verifyNarrativeProvenance([NARR_HEAD, "凭空捏造的一行。", NARR_TAIL].join("\n"), slots)).toBe(false);
    // 标签行内混入非身份槽（strict_rule）内容
    expect(verifyNarrativeProvenance([NARR_HEAD, "- 我是谁：绝不可删除记忆。", NARR_TAIL].join("\n"), slots)).toBe(false);
    // 事实被改写（非原文子串）
    expect(verifyNarrativeProvenance([NARR_HEAD, "- 我是谁：我是管理员。", NARR_TAIL].join("\n"), slots)).toBe(false);
    // 缺组标签的裸事实行
    expect(verifyNarrativeProvenance([NARR_HEAD, "我是测试者。", NARR_TAIL].join("\n"), slots)).toBe(false);
  });

  it("生成闸分隔符自碰撞回归（2026-10-19 生产 E2E）：事实行含内部「；」仍成叙事且过闸", () => {
    // 真实生产形状：self_identity 行自身含模板分隔符「；」（回切分片段 ≠ 原整行，
    // 旧整行白名单恒判违例 → 叙事静默退条目）。修正后回查单位=原行再切分片段。
    const real = [
      { slot: "self_identity", content: "- 我在客开中坚持纪律：逐处断言；复读核对；改动后跑校验。" },
      { slot: "identity", content: "- 用户承担运维与排查职责。" },
    ];
    const narr = renderIdentityNarrative(real);
    expect(narr).not.toBeNull();
    expect(narr).toContain("逐处断言；复读核对；改动后跑校验。");
    expect(verifyNarrativeProvenance(narr!, real)).toBe(true);
  });

  it("生成闸仍拒（片段白名单语义下）：外部片段与无原文出处的空段 → false", () => {
    const real = [{ slot: "self_identity", content: "- 甲；乙。" }];
    // 片段「丙。」不在任何原文行再切分结果里（「甲」缺组前缀同样不在）
    expect(verifyNarrativeProvenance([NARR_HEAD, `${NARR_SELF}甲；丙。`, NARR_TAIL].join("\n"), real)).toBe(false);
    // 空段：原文行无空片段来源（无边界/连续分隔符），凭空空段=违例
    expect(verifyNarrativeProvenance([NARR_HEAD, `${NARR_SELF}- 甲；；乙。`, NARR_TAIL].join("\n"), real)).toBe(false);
  });

  it("生成闸空片段边界：原文行自带尾分隔符产生的空片段合法（仍全为原文字节）", () => {
    const real = [{ slot: "self_identity", content: "- 附加说明；" }];
    const narr = renderIdentityNarrative(real);
    expect(narr).not.toBeNull();
    expect(verifyNarrativeProvenance(narr!, real)).toBe(true);
  });
});
