/**
 * #172-②（2026-10-31）：注入块包裹语三档——docs §24.9 承诺的 calibrated 落点。
 *
 * 三档语义（差异只在「包裹语是否诱导拒答」，不改记忆内容、不改排序）：
 *  - legacy：含「仅作为参考」贬抑措辞——2026-10-31 前的生产文案，保留可回滚；
 *  - neutral（#138 前折中档）：中性包裹 + 证据不足时如实说明，保留可回滚；
 *  - calibrated（#172-② 新增，**当前缺省**）：不写「仅作参考」、不诱导拒答，直接指示
 *    「据此回答，信息不足再说明」。动机（docs/optimization-results.md §24.9/§25.6）：
 *    前两档都先声明「可能不相关」，LME90 X 臂仍有 6 例「有证据但拒答」。
 *
 * 纪律：纯函数单一源，钩子路 auto-recall 与 bench 同源；未知值回落**当前缺省**
 * （INJECT_WRAPPER_DEFAULT 单一常量，禁止在别处再写一份 "legacy" 字面量）。
 */
export type InjectWrapperMode = "legacy" | "neutral" | "calibrated";

/**
 * 当前缺省档（WP1b 缺省对齐：legacy/neutral 都被判「诱导拒答」，按读侧最优定档）。
 * 回滚方式 = 这一个常量改回 "legacy"，或 yaml 显式写 injectWrapper: legacy。
 */
export const INJECT_WRAPPER_DEFAULT: InjectWrapperMode = "calibrated";

/** 三档包裹语原文（逐字面对齐，供测试钉死）。 */
export const INJECT_WRAPPER_HEADS: Record<InjectWrapperMode, string> = {
  legacy: "以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：",
  neutral:
    "以下是与当前对话可能相关的历史对话记忆（按时间先后排列）。请结合当前对话使用这些记忆；若记忆不足以回答，请如实说明。",
  calibrated: "以下是与问题相关的历史记忆，请据此回答；若信息不足再说明。",
};

/** 归一化取值：三档原样，未知/undefined → 当前缺省（INJECT_WRAPPER_DEFAULT）。 */
export function injectWrapperModeOf(raw: unknown): InjectWrapperMode {
  if (raw === "legacy" || raw === "neutral" || raw === "calibrated") return raw;
  return INJECT_WRAPPER_DEFAULT;
}

/** 取包裹语原文：未知/undefined → 当前缺省文案。 */
export function injectWrapperHeadOf(raw: unknown): string {
  return INJECT_WRAPPER_HEADS[injectWrapperModeOf(raw)];
}
