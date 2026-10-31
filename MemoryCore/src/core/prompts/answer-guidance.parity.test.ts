import { describe, it, expect } from "vitest";
import { parseConfig } from "../../config.js";
import { INJECT_WRAPPER_HEADS } from "../recall/inject-wrapper.js";
import {
  ANSWER_GUIDANCE_VERSION,
  ANSWER_CURRENCY_HEADER,
  ANSWER_CURRENCY_RULES,
  ANSWER_PREFERENCE_HEADER,
  ANSWER_PREFERENCE_RULES,
  buildAnswerGuidance,
} from "./answer-guidance.js";

/**
 * 生产答案口径单一源的**逐字**保全测试（#146 拒答纪律）。
 *
 * 关键点：这里不复制 bench 的文案，而是真的调用 bench 的 buildAnswerPromptTuned，
 * 断言生产模块里的每一行都在 bench 的产出里逐字出现 ⇒ 两边口径任何一侧漂移都会红。
 * 用运行时动态 import（URL 字符串）而非静态 import：bench 是 .mjs，静态引入会给 typecheck
 * 引入 TS7016（类型检查基线 243 errors 不许增）。
 */
async function benchTuned(opts: { currency: boolean; preference: boolean }): Promise<{ prompt: string; mod: any }> {
  const mod = await import(
    new URL("../../../scripts/lib/bench/llm.mjs", import.meta.url).href
  );
  const prompt = mod.buildAnswerPromptTuned({
    question: "用户的 Instagram 粉丝数现在是多少？",
    block: "2026-03-01 用户：我粉丝涨到 1300 了",
    questionDate: "2026-09-01",
    datasetName: "lme",
    currency: opts.currency,
    preference: opts.preference,
  });
  return { prompt: String(prompt), mod };
}

describe("answer-guidance: 与 bench tuned 口径逐字一致（单一源）", () => {
  it("版本号与 bench 的组合版本同名（report.config.judgePromptVersion 可对齐）", async () => {
    const { mod } = await benchTuned({ currency: true, preference: true });
    expect(ANSWER_GUIDANCE_VERSION).toBe(`${mod.ANSWER_PROMPT_CURRENCY_VERSION}+pref`);
  });

  it("币值规则与建议口径的每一行都逐字出现在 bench tuned（currency+pref）产出里", async () => {
    const { prompt } = await benchTuned({ currency: true, preference: true });
    expect(prompt).toContain(ANSWER_CURRENCY_HEADER);
    expect(prompt).toContain(ANSWER_PREFERENCE_HEADER);
    for (const line of [...ANSWER_CURRENCY_RULES, ...ANSWER_PREFERENCE_RULES]) {
      expect(prompt, `bench tuned 缺这一行（口径漂移）: ${line}`).toContain(line);
    }
  });

  it("bench 关掉两个口径时这些行不再出现（证明两侧仍是同一组开关语义）", async () => {
    const { prompt } = await benchTuned({ currency: false, preference: false });
    expect(prompt).not.toContain(ANSWER_CURRENCY_HEADER);
    expect(prompt).not.toContain(ANSWER_PREFERENCE_HEADER);
    for (const line of ANSWER_CURRENCY_RULES) expect(prompt).not.toContain(line);
  });

  it("buildAnswerGuidance 缺省 = 两段全开；全关 = 空串（不产生空壳标题）", () => {
    const all = buildAnswerGuidance();
    expect(all).toContain(ANSWER_CURRENCY_HEADER);
    expect(all).toContain(ANSWER_PREFERENCE_HEADER);
    for (const line of [...ANSWER_CURRENCY_RULES, ...ANSWER_PREFERENCE_RULES]) expect(all).toContain(line);
    expect(buildAnswerGuidance({ currency: false, preference: false })).toBe("");
  });

  it("口径本体不含诱导拒答措辞（拒答只在「完全没有相关线索」时被允许）", () => {
    const all = buildAnswerGuidance();
    for (const banned of ["如实说明", "仅作为参考", "不足以回答", "无法回答"]) {
      expect(all).not.toContain(banned);
    }
    // 允许拒答的唯一条件必须显式写出，否则「有旧值也必须答」的纪律会被模型自由裁量掉
    expect(ANSWER_CURRENCY_RULES.join("\n")).toContain("只有当记忆里完全没有与该问题相关的内容时才拒答");
  });
});

describe("生产注入面现状（分叉台账，供 recall-core 收口）", () => {
  it("三档包裹语里只有 legacy/neutral 带贬抑或诱导拒答措辞，calibrated 干净", () => {
    // 缺省档（parseConfig({}) 实测）= legacy，含「仅作为参考」贬抑措辞 ⇒ 与 tuned 口径分叉
    expect(INJECT_WRAPPER_HEADS.legacy).toContain("仅作为参考");
    expect(INJECT_WRAPPER_HEADS.neutral).toContain("如实说明");
    expect(INJECT_WRAPPER_HEADS.calibrated).toContain("请据此回答");
    for (const banned of ["如实说明", "仅作为参考", "不足以回答"]) {
      expect(INJECT_WRAPPER_HEADS.calibrated).not.toContain(banned);
    }
  });

  it("生产缺省注入档 = calibrated（WP1b 读侧定档），但包裹语本身仍不含币值/建议口径", () => {
    const mode = parseConfig({}).recall.injectWrapper;
    expect(mode).toBe("calibrated");
    const head = INJECT_WRAPPER_HEADS[mode];
    // 包裹语只负责「怎么看待这批记忆」，不含任何口径规则 ⇒ 规则段必须由 buildAnswerGuidance 追加，
    // 否则生产仍然缺 tuned 的三条币值/三条偏好规则（分叉未收口）。
    expect(head).not.toContain(ANSWER_CURRENCY_HEADER);
    expect(head).not.toContain(ANSWER_PREFERENCE_HEADER);
    for (const line of [...ANSWER_CURRENCY_RULES, ...ANSWER_PREFERENCE_RULES]) {
      expect(head).not.toContain(line);
    }
  });

  it("生产拼装契约：包裹语 + 空行 + buildAnswerGuidance() = tuned 等价块（供 recall-core 接线断言）", () => {
    // 这两行就是 auto-recall 注入块尾部应有的拼装形态；本测试只钉契约，不改 recall-core 的文件。
    const mode = parseConfig({}).recall.injectWrapper;
    const composite = `${INJECT_WRAPPER_HEADS[mode]}\n\n${buildAnswerGuidance()}`;
    expect(composite).toContain(ANSWER_CURRENCY_HEADER);
    expect(composite).toContain(ANSWER_PREFERENCE_HEADER);
    for (const banned of ["如实说明", "仅作为参考", "不足以回答"]) {
      expect(composite).not.toContain(banned);
    }
    // 拼接在包裹语之后（顺序有意义：先说明记忆是什么，再给口径）
    expect(composite.indexOf(INJECT_WRAPPER_HEADS[mode])).toBe(0);
  });
});
