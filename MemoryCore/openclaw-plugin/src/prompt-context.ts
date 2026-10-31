/**
 * 注入文案的 OpenClaw 侧镜像（**不是源**）。
 *
 * 为什么是镜像而不是 import：OpenClaw 插件是独立 npm 包（openclaw-plugin/package.json 只依赖
 * memory-sdk-ts-v2，tsc rootDir=\".\"），构建期不能引用本仓 MemoryCore/src——跨包相对 import 会把
 * MemoryCore 源码卷进它的 dist 产物。
 *
 * 唯一正文源（改文案先改那边，再同步本文件）：
 *   - memory-tools-guide：MemoryCore/src/core/prompts/memory-tools-guide.ts
 *   - 答案口径（币值/建议）：MemoryCore/src/core/prompts/answer-guidance.ts
 *   - 注入块包裹语：MemoryCore/src/core/recall/inject-wrapper.ts（CALIBRATED 档 = 当前生产缺省）
 *
 * 逐字一致性由 MemoryCore/__tests__/openclaw-format-parity.test.ts 断言（改一侧不改另一侧会红）。
 */

/** 包裹语：与 inject-wrapper.ts 的 calibrated 档同文（calibrated = 当前生产缺省，不诱导拒答）。 */
export const RECALL_WRAPPER_HEAD =
  "以下是与问题相关的历史记忆，请据此回答；若信息不足再说明。";

/** memory-tools-guide（与 MemoryCore/src/core/prompts/memory-tools-guide.ts 逐字一致）。 */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

已注入的记忆优先使用：只要其中有与该问题相关的内容，就直接据此作答（必要时注明记忆时间），不要因为记忆不完整而拒答。只有在已注入的记忆完全没有相关线索、需要补充细节时，才调用以下工具获取更多信息：

- **tdai_memory_search**：搜索结构化记忆（L1），适用于回忆用户偏好、历史事件、规则等。
- **tdai_conversation_search**：搜索原始对话（L0），适用于查找具体消息原文、时间线、上下文细节。
- **tdai_read_cos**：读取记忆文件详情（使用下方 Scene Navigation 中的完整相对路径，如 scene_blocks/xxx.md；也可读 persona.md）。

### ⚠️ 调用次数限制
每轮对话中，tdai_memory_search 和 tdai_conversation_search **合计最多调用 3 次**。
- 首次搜索无结果时，可换关键词或换工具重试，但总调用次数不要超过 3 次。
- 若 3 次搜索后仍无结果，说明该细节不在记忆中：请依据已注入的相关记忆作答并注明记录时间；只有已注入的记忆也完全没有相关线索时才说明无法确定，不要编造。
</memory-tools-guide>`;

/** 币值判定规则（与 MemoryCore/src/core/prompts/answer-guidance.ts 逐字一致）。 */
export const ANSWER_CURRENCY_HEADER = "【币值判定规则（重要）】";
export const ANSWER_CURRENCY_RULES: readonly string[] = [
  "1. 提问日期晚于某条记忆的时间戳，不代表该记忆失效：记忆是零散的对话片段，不是连续同步。",
  "2. 若某个属性有多条互相矛盾的记录，以时间最晚的那条为当前值；没有更晚记录时，它就是当前状态。",
  "3. 只有当记忆里完全没有与该问题相关的内容时才拒答；有相关记录（哪怕是较早的）就必须给出答案，并注明该记录的时间。",
];

/** 建议类问题口径（同上，逐字一致）。 */
export const ANSWER_PREFERENCE_HEADER = "【建议类问题口径（重要）】";
export const ANSWER_PREFERENCE_RULES: readonly string[] = [
  "1. 当问题是在征求建议、意见或推荐（tips / ideas / suggestions / 值得吗）时，答案来自用户已经表达过的偏好、习惯与既往选择。",
  "2. 先明确复述相关的既有偏好（做过什么、喜欢什么、正在坚持什么），再据此给出建议；不要只给泛泛建议。",
  "3. 只要记忆里有用户的偏好线索，就不要拒答——偏好题的正确答案就是「顺着用户既有偏好给建议」。",
];

export interface AnswerGuidanceOptions {
  currency?: boolean;
  preference?: boolean;
}

/**
 * 渲染答案口径段（与 MemoryCore buildAnswerGuidance 输出逐字一致）。
 * 两段都关 → 空串（调用方据此零注入）。
 */
export function buildAnswerGuidance(opts: AnswerGuidanceOptions = {}): string {
  const currency = opts.currency ?? true;
  const preference = opts.preference ?? true;
  const blocks: string[] = [];
  if (currency) blocks.push([ANSWER_CURRENCY_HEADER, ...ANSWER_CURRENCY_RULES].join("\n"));
  if (preference) blocks.push([ANSWER_PREFERENCE_HEADER, ...ANSWER_PREFERENCE_RULES].join("\n"));
  return blocks.join("\n\n");
}
