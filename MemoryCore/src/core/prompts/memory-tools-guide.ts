/**
 * memory-tools-guide 单一源（生产注入块尾部的能力说明，含调用次数限制）。
 *
 * 为什么收敛：注入内容此前有三份独立副本——钩子路 auto-recall.ts:350、OpenClaw 插件
 * openclaw-plugin/src/format.ts:25、MemoryProxy tdai-profile-memory-injector.ts:280。
 * 三份开篇都是「当上方注入的记忆片段不足以回答用户问题时…」，末尾再叠一句
 * 「说明该信息不在记忆中，请直接根据已有信息回复用户」⇒ 把「证据不足」写进 system，
 * 与 bench tuned 口径（有相关记录就必须作答并注明时间）直接冲突，是拒答率高的机制之一
 * （深池 A 臂 36 错里 27 个是拒答，见 prompts/answer-guidance.ts 文件头）。
 *
 * 本文件是**唯一**正文源：钩子路与 OpenClaw 必须与此逐字一致
 * （OpenClaw 是独立 npm 包、构建期不能 import 本仓 src，故留镜像常量 + parity 测试
 *  MemoryCore/__tests__/openclaw-format-parity.test.ts 逐字比对）。
 *
 * 纪律：只放文案；改这里必须同步 openclaw-plugin/src/prompt-context.ts 与上述 parity 测试。
 */

/** 版本号：文案形状变更时 +1（便于日志/排障时确认生产注入的是哪一版口径）。 */
export const MEMORY_TOOLS_GUIDE_VERSION = "memory-tools-guide-v2-tuned";

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
