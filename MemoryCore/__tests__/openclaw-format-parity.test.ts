import { describe, it, expect } from "vitest";
// 单一正文源（MemoryCore 生产仓）
import { MEMORY_TOOLS_GUIDE as CANON_GUIDE, MEMORY_TOOLS_GUIDE_VERSION } from "../src/core/prompts/memory-tools-guide.js";
import {
  ANSWER_CURRENCY_HEADER as CANON_CURRENCY_HEADER,
  ANSWER_CURRENCY_RULES as CANON_CURRENCY_RULES,
  ANSWER_PREFERENCE_HEADER as CANON_PREF_HEADER,
  ANSWER_PREFERENCE_RULES as CANON_PREF_RULES,
  buildAnswerGuidance as canonGuidance,
} from "../src/core/prompts/answer-guidance.js";
import { INJECT_WRAPPER_HEADS, injectWrapperHeadOf } from "../src/core/recall/inject-wrapper.js";
// 构建期镜像 + 被测的 OpenClaw 拼装
import {
  MEMORY_TOOLS_GUIDE as MIRROR_GUIDE,
  RECALL_WRAPPER_HEAD,
  ANSWER_CURRENCY_HEADER as MIRROR_CURRENCY_HEADER,
  ANSWER_CURRENCY_RULES as MIRROR_CURRENCY_RULES,
  ANSWER_PREFERENCE_HEADER as MIRROR_PREF_HEADER,
  ANSWER_PREFERENCE_RULES as MIRROR_PREF_RULES,
  buildAnswerGuidance as mirrorGuidance,
} from "../openclaw-plugin/src/prompt-context.js";
import { formatRecallResult } from "../openclaw-plugin/src/format.js";

/**
 * OpenClaw 注入路径 × MemoryCore 生产口径的**逐字** parity（#146 拒答纪律的读侧收口）。
 *
 * 为什么要这个测试：OpenClaw 插件是独立 npm 包（构建期不能 import MemoryCore/src），
 * 文案只能镜像。镜像没有守卫就会再次分叉——历史上它的 formatL1Memories 输出裸块、
 * MEMORY_TOOLS_GUIDE 还是「不足以回答 → 请直接根据已有信息回复」的诱导拒答版本。
 * 本测试把「两处同文」变成可执行断言：任何一侧改文案而另一侧没跟，红。
 */

const L1 = [
  { id: "r1", content: "用户养了一只叫团子的猫", type: "persona" },
  { id: "r2", content: "用户 2026-03 的 Instagram 粉丝 1300", type: "episodic" },
];

describe("openclaw 文案镜像 ≡ MemoryCore 单一源（逐字）", () => {
  it("memory-tools-guide 逐字一致，且版本号已标注", () => {
    expect(MIRROR_GUIDE).toBe(CANON_GUIDE);
    expect(MEMORY_TOOLS_GUIDE_VERSION).toMatch(/memory-tools-guide-v/);
  });

  it("包裹语 = inject-wrapper 的 calibrated 档（= 当前生产缺省档）", () => {
    expect(RECALL_WRAPPER_HEAD).toBe(INJECT_WRAPPER_HEADS.calibrated);
    expect(RECALL_WRAPPER_HEAD).toBe(injectWrapperHeadOf(undefined));
  });

  it("答案口径三段（两个标题 + 两组规则）逐字一致，渲染结果也逐字一致", () => {
    expect(MIRROR_CURRENCY_HEADER).toBe(CANON_CURRENCY_HEADER);
    expect(MIRROR_PREF_HEADER).toBe(CANON_PREF_HEADER);
    expect(MIRROR_CURRENCY_RULES).toEqual(CANON_CURRENCY_RULES);
    expect(MIRROR_PREF_RULES).toEqual(CANON_PREF_RULES);
    expect(mirrorGuidance()).toBe(canonGuidance());
    expect(mirrorGuidance({ currency: false, preference: false })).toBe("");
  });

  it("guide 不含诱导拒答框架（「不足以回答」「请直接根据已有信息回复」「仅作为参考」）", () => {
    for (const banned of ["不足以回答", "请直接根据已有信息回复", "仅作为参考"]) {
      expect(MIRROR_GUIDE).not.toContain(banned);
      expect(CANON_GUIDE).not.toContain(banned);
    }
    // 纪律的另一半必须显式写出：有相关记忆就得答
    expect(MIRROR_GUIDE).toContain("不要因为记忆不完整而拒答");
  });
});

describe("formatL1Memories：与钩子路同一口径（包裹语 + 记忆 + 规则段）", () => {
  it("prependContext = 包裹语 → 记忆行 → 币值/建议口径，全部在 <relevant-memories> 内", () => {
    const out = formatRecallResult(L1, null, []).prependContext;
    expect(out).toBeTruthy();
    const text = String(out);
    expect(text.startsWith("<relevant-memories>")).toBe(true);
    expect(text.endsWith("</relevant-memories>")).toBe(true);
    expect(text).toContain(RECALL_WRAPPER_HEAD);
    expect(text).toContain("[persona] 用户养了一只叫团子的猫");
    expect(text).toContain(CANON_CURRENCY_HEADER);
    expect(text).toContain(CANON_PREF_HEADER);
    for (const line of [...CANON_CURRENCY_RULES, ...CANON_PREF_RULES]) expect(text).toContain(line);
    // 顺序：包裹语先于记忆行，规则段在记忆行之后（先说明这批记忆是什么，再给作答纪律）
    expect(text.indexOf(RECALL_WRAPPER_HEAD)).toBeLessThan(text.indexOf("[persona]"));
    expect(text.indexOf(CANON_CURRENCY_HEADER)).toBeGreaterThan(text.indexOf("[persona]"));
    // 旧的诱导拒答措辞不得回到注入块
    for (const banned of ["不足以回答", "请直接根据已有信息回复", "仅作为参考"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("无召回 → prependContext 为空（零注入，不产生空壳块）", () => {
    expect(formatRecallResult([], null, []).prependContext).toBeUndefined();
  });

  it("appendSystemContext 用的就是单一源 guide 原文", () => {
    const sys = formatRecallResult(L1, "persona-text", []).appendSystemContext;
    expect(String(sys)).toContain(CANON_GUIDE);
    expect(String(sys)).toContain("记忆工具调用指南");
  });
});
