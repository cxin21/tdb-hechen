/**
 * 答案口径段（记忆作答纪律）—— MemoryCore 单一源的 dsh 侧镜像。
 *
 * 为什么需要它：MemoryCore 的读侧规范已经收成单一源
 *   - 答案口径（币值判定 + 建议类问题）：MemoryCore/src/core/prompts/answer-guidance.ts
 *     （ANSWER_GUIDANCE_VERSION = "prod-block-v2-currency+pref"，由 buildAnswerGuidance 渲染）
 *   - 记忆工具指南：MemoryCore/src/core/prompts/memory-tools-guide.ts
 *     （MEMORY_TOOLS_GUIDE_VERSION = "memory-tools-guide-v2-tuned"）
 * 而 dsh 这条接入路径此前只有 head pack（persona）与 volatile（召回块）——同一个核心、
 * 两条接入路径给出不同的回答规范，就是「有证据却拒答」的结构性来源（深池 A 臂 36 个
 * 错题里 27 个是拒答）。
 *
 * 为什么是镜像而不是 import：dsh-plugin 是独立包，tsconfig rootDir = "src"，
 * 构建期不能把 ../MemoryCore/src 卷进 dist。逐字一致性由 test/guidance.test.ts 守住
 * （直接读 MemoryCore 源文件做子串对拍，读不到则 skip 并打印原因，不静默通过）。
 *
 * dsh 侧**显式 override**（不写回 MemoryCore 单一源，等 Lead 裁决）：
 * dsh 插件只注册一个记忆工具 `memory_recall`（src/tools.ts:44），没有
 * tdai_memory_search / tdai_conversation_search / tdai_read_cos（那是 MemoryCore 钩子路的工具面）。
 * 因此工具清单按 dsh 真实工具名重写；反拒答的三句纪律逐字保留，见
 * GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE。
 */

/** 与 MemoryCore ANSWER_GUIDANCE_VERSION 同值（镜像，不是新版本号）。 */
export const ANSWER_GUIDANCE_VERSION = 'prod-block-v2-currency+pref';

/** 与 MemoryCore MEMORY_TOOLS_GUIDE_VERSION 同值（本文件的工具清单已按 dsh 改写，见文件头）。 */
export const MEMORY_TOOLS_GUIDE_VERSION = 'memory-tools-guide-v2-tuned';

/**
 * 本插件实际注入的口径版本：源版本 + dsh 工具面后缀。
 * 日志/排障时据此确认「生产注入的是哪一版口径」。
 */
export const GUIDANCE_VERSION = ANSWER_GUIDANCE_VERSION + '|' + MEMORY_TOOLS_GUIDE_VERSION + '+dsh-tools';

/** 币值判定规则（逐字对齐 MemoryCore/src/core/prompts/answer-guidance.ts）。 */
export const ANSWER_CURRENCY_HEADER = '【币值判定规则（重要）】';
export const ANSWER_CURRENCY_RULES: readonly string[] = [
  '1. 提问日期晚于某条记忆的时间戳，不代表该记忆失效：记忆是零散的对话片段，不是连续同步。',
  '2. 若某个属性有多条互相矛盾的记录，以时间最晚的那条为当前值；没有更晚记录时，它就是当前状态。',
  '3. 只有当记忆里完全没有与该问题相关的内容时才拒答；有相关记录（哪怕是较早的）就必须给出答案，并注明该记录的时间。',
];

/** 建议类问题口径（同上，逐字对齐）。 */
export const ANSWER_PREFERENCE_HEADER = '【建议类问题口径（重要）】';
export const ANSWER_PREFERENCE_RULES: readonly string[] = [
  '1. 当问题是在征求建议、意见或推荐（tips / ideas / suggestions / 值得吗）时，答案来自用户已经表达过的偏好、习惯与既往选择。',
  '2. 先明确复述相关的既有偏好（做过什么、喜欢什么、正在坚持什么），再据此给出建议；不要只给泛泛建议。',
  '3. 只要记忆里有用户的偏好线索，就不要拒答——偏好题的正确答案就是「顺着用户既有偏好给建议」。',
];

/** 两段口径的默认档：都开（= 生产最优档）。 */
export const GUIDANCE_DEFAULTS = { currency: true, preference: true, toolsGuide: true } as const;

export interface AnswerGuidanceOptions {
  currency?: boolean;
  preference?: boolean;
}

/** 渲染答案口径两段（与 MemoryCore buildAnswerGuidance 输出逐字一致；两段都关 → 空串）。 */
export function buildAnswerGuidance(options: AnswerGuidanceOptions = GUIDANCE_DEFAULTS): string {
  const currency = options.currency ?? GUIDANCE_DEFAULTS.currency;
  const preference = options.preference ?? GUIDANCE_DEFAULTS.preference;
  const blocks: string[] = [];
  if (currency) blocks.push([ANSWER_CURRENCY_HEADER, ...ANSWER_CURRENCY_RULES].join('\n'));
  if (preference) blocks.push([ANSWER_PREFERENCE_HEADER, ...ANSWER_PREFERENCE_RULES].join('\n'));
  return blocks.join('\n\n');
}

/**
 * 记忆工具指南（dsh 工具面）。与单一源的三处差异全部在**工具清单与次数**上，
 * 三句反拒答纪律与单一源逐字相同：
 *   1. 工具名：memory_recall（本插件注册的），不是 tdai_memory_search / tdai_conversation_search；
 *   2. 删除 tdai_read_cos bullet —— dsh 插件没有读记忆文件的工具；
 *   3. 次数限制只约束 memory_recall（只有一个工具，原来的「合计」不再适用）。
 */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

已注入的记忆优先使用：只要其中有与该问题相关的内容，就直接据此作答（必要时注明记忆时间），不要因为记忆不完整而拒答。只有在已注入的记忆完全没有相关线索、需要补充细节时，才调用以下工具获取更多信息：

- **memory_recall**：检索长期记忆（TDB Agemem）里的笔记、决定、偏好与既往上下文；query 用自然语言描述要查什么。这是本环境下唯一的记忆检索工具。

### ⚠️ 调用次数限制
每轮对话中，memory_recall **最多调用 3 次**。
- 首次搜索无结果时，可换关键词重试，但总调用次数不要超过 3 次。
- 若 3 次搜索后仍无结果，说明该细节不在记忆中：请依据已注入的相关记忆作答并注明记录时间；只有已注入的记忆也完全没有相关线索时才说明无法确定，不要编造。
</memory-tools-guide>`;

/**
 * 与 MemoryCore 单一源的**显式差异清单**（供 Lead 裁决是否回写单一源）。
 * 每项都是「dsh 工具面不同」导致的改写，不是措辞偏好。
 */
export const GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE: readonly string[] = [
  '工具清单：tdai_memory_search / tdai_conversation_search → memory_recall（dsh 插件唯一注册的记忆工具）；不保留任何 tdai_* 工具名，避免教模型调用不存在的工具',
  '删除 tdai_read_cos bullet（dsh 插件没有读 scene_blocks 的工具）',
  '次数限制：从「两个工具合计 3 次」改为「memory_recall 最多 3 次」',
];

export interface GuidanceOptions extends AnswerGuidanceOptions {
  /** 是否附带记忆工具指南（缺省 true）。 */
  toolsGuide?: boolean;
}

/** 完整注入文本：答案口径两段 +（可选）记忆工具指南。段落间用空行分隔，与单一源形状一致。 */
export function buildGuidance(options: GuidanceOptions = GUIDANCE_DEFAULTS): string {
  const sections: string[] = [];
  const answer = buildAnswerGuidance(options);
  if (answer !== '') sections.push(answer);
  if (options.toolsGuide ?? GUIDANCE_DEFAULTS.toolsGuide) sections.push(MEMORY_TOOLS_GUIDE);
  return sections.join('\n\n');
}

/** 缺省档渲染结果（静态文本，模块加载时算一次；注入时不重算）。 */
export const GUIDANCE_TEXT = buildGuidance();
