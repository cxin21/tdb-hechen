/**
 * 生产答案口径（拒答纪律）单一源 —— 与 bench tuned 口径逐字对齐。
 *
 * 为什么需要这个模块（2026-10-31 深池读数）：
 *  A 臂 36 个错题里 27 个（75%）是**拒答**——"记忆只到某日，无法确定现在"这类。
 *  bench 侧（scripts/lib/bench/llm.mjs 的 buildAnswerPromptTuned）早已用两段口径把
 *  「有证据但拒答」压下来：币值判定规则（提问日期晚于记录 ≠ 失效；无更晚记录时最新即当前值；
 *  只有完全没有相关线索才拒答）+ 建议类问题口径（答案就在用户既有偏好里，先复述偏好再建议）。
 *
 *  生产路径此前**没有任何等价口径**：auto-recall 只拼一段包裹语（core/recall/inject-wrapper.ts，
 *  缺省档已由读侧收口为 calibrated）；此外注入块尾部的 memory-tools-guide 有三份副本
 *  （钩子路 auto-recall.ts、openclaw-plugin/src/format.ts、MemoryProxy 注入器），开篇就是
 *  「当上方注入的记忆片段不足以回答用户问题时…」，再叠一句「说明该信息不在记忆中」。
 *  两边口径分叉 ⇒ 生产答得比 bench 保守，这就是拒答率高的读侧机制解释。
 *  该 guide 的正文现已收敛到 core/prompts/memory-tools-guide.ts（本文件只管答案口径两段）。
 *
 * 本模块的定位：把 tuned 口径抽成**唯一**常量与唯一渲染函数，供生产注入路径与 bench 共用；
 *  benches 的逐字一致性由 answer-guidance.parity.test.ts 直接调用 buildAnswerPromptTuned 钉死
 * （bench 侧将来改成 import 本模块常量时，该测试退化为等价性回归，不需要改断言）。
 *
 * 纪律：本文件只放文案与渲染，不掺入召回/排序逻辑；文案改动必须同步 parity 测试。
 */

/** 口径版本：与 bench 的组合版本号同名（eval-memory-bench.mjs 记 report.config.judgePromptVersion）。 */
export const ANSWER_GUIDANCE_VERSION = "prod-block-v2-currency+pref";

/** 币值判定规则（逐字对齐 bench buildAnswerPromptTuned 的 currency 段）。 */
export const ANSWER_CURRENCY_HEADER = "【币值判定规则（重要）】";
export const ANSWER_CURRENCY_RULES: readonly string[] = [
  "1. 提问日期晚于某条记忆的时间戳，不代表该记忆失效：记忆是零散的对话片段，不是连续同步。",
  "2. 若某个属性有多条互相矛盾的记录，以时间最晚的那条为当前值；没有更晚记录时，它就是当前状态。",
  "3. 只有当记忆里完全没有与该问题相关的内容时才拒答；有相关记录（哪怕是较早的）就必须给出答案，并注明该记录的时间。",
];

/** 建议类问题口径（逐字对齐 bench buildAnswerPromptTuned 的 preference 段）。 */
export const ANSWER_PREFERENCE_HEADER = "【建议类问题口径（重要）】";
export const ANSWER_PREFERENCE_RULES: readonly string[] = [
  "1. 当问题是在征求建议、意见或推荐（tips / ideas / suggestions / 值得吗）时，答案来自用户已经表达过的偏好、习惯与既往选择。",
  "2. 先明确复述相关的既有偏好（做过什么、喜欢什么、正在坚持什么），再据此给出建议；不要只给泛泛建议。",
  "3. 只要记忆里有用户的偏好线索，就不要拒答——偏好题的正确答案就是「顺着用户既有偏好给建议」。",
];

/** 生产档默认：两段口径都开（= 深池 A 臂错误里 75% 拒答的对症口径）。 */
export const ANSWER_GUIDANCE_DEFAULTS = { currency: true, preference: true } as const;

export interface AnswerGuidanceOptions {
  /** 币值判定（knowledge-update / temporal 类问题的拒答主因）。 */
  currency?: boolean;
  /** 建议类问题（偏好类问题被误判成「记忆没写答案」而拒答）。 */
  preference?: boolean;
}

/**
 * 渲染答案口径段（空行分隔，与 bench tuned 的段落形状一致）。
 * 两段都关 → 返回空串（调用方据此零注入，不产生空壳标题）。
 */
export function buildAnswerGuidance(opts: AnswerGuidanceOptions = ANSWER_GUIDANCE_DEFAULTS): string {
  const currency = opts.currency ?? ANSWER_GUIDANCE_DEFAULTS.currency;
  const preference = opts.preference ?? ANSWER_GUIDANCE_DEFAULTS.preference;
  const blocks: string[] = [];
  if (currency) blocks.push([ANSWER_CURRENCY_HEADER, ...ANSWER_CURRENCY_RULES].join("\n"));
  if (preference) blocks.push([ANSWER_PREFERENCE_HEADER, ...ANSWER_PREFERENCE_RULES].join("\n"));
  return blocks.join("\n\n");
}
