/**
 * memory-tools-guide 的 **MemoryProxy 适配版**（派生自单一源，不是逐字镜像）。
 *
 * 源：MemoryCore/src/core/prompts/memory-tools-guide.ts（MEMORY_TOOLS_GUIDE /
 *     MEMORY_TOOLS_GUIDE_VERSION = "memory-tools-guide-v2-tuned"）。
 *
 * 为什么派生而不是照抄：源里的工具清单是**钩子路**口径——第三个工具写的是
 * tdai_read_cos（MemoryCore/src/core/tools/read-cos.ts:153），且引用「下方 Scene
 * Navigation」。本包真正注入给 LLM 的是 6 个 curl 工具（见 tdai-tools-injector.ts：
 * tdai_memory_search / tdai_atomic_query / tdai_conversation_search /
 * tdai_conversation_query / tdai_scenario_ls / tdai_read_scene），**没有 tdai_read_cos**。
 * 逐字镜像会把 LLM 指向一个不存在的工具（幻影工具），同时漏掉 4 个真实工具。
 *
 * 派生边界（纪律句逐字保留，只换工具清单段 + 块名口径）：
 *   - 逐字保留：开篇「已注入的记忆优先使用…才调用以下工具获取更多信息：」、
 *     「### ⚠️ 调用次数限制」整段（含 3 次上限与「不要编造」收尾）、版本串。
 *   - 派生：工具清单（按 proxy 真实注册集渲染）、「下方 Scene Navigation」→
 *     「下方 <l2_scene_index>（场景索引）」。
 *   - 每一处派生都必须在 GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE 里登记（源写什么 /
 *     本侧写什么 / 为什么），不允许隐式漂移。
 *
 * 守卫：MemoryProxy/src/__tests__/memory-tools-guide-parity.test.ts
 *   ① 纪律句与版本串逐字 == 源（读源文件文本比对）；
 *   ② 本文件的工具名集合 == 本包真实注册集（从 tdai-tools-injector.ts 渲染结果解析，
 *      不手抄名单）；
 *   ③ 本文件 != 源（防止有人「顺手改回逐字」把幻影工具带回来）。
 *
 * 不改 MemoryCore 单一源：改源会影响钩子路 / openclaw-plugin / dsh-plugin 三个消费方，
 * 不在本票范围。
 */

/** 版本号：与源文件 MEMORY_TOOLS_GUIDE_VERSION 同值（文案形状变更时两边同步 +1）。 */
export const MEMORY_TOOLS_GUIDE_VERSION = "memory-tools-guide-v2-tuned";

/**
 * 逐条声明本文件相对单一源的**派生点**：
 *   source = 源文件里怎么写的（None 表示源里没有这条）
 *   proxy  = 本侧怎么写
 *   why    = 为什么必须不同（不是风格偏好，是事实差异）
 */
export const GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE = [
  {
    field: "工具清单 / 读文件工具",
    source: "- **tdai_read_cos**：读取记忆文件详情（使用下方 Scene Navigation 中的完整相对路径，如 scene_blocks/xxx.md；也可读 persona.md）。",
    proxy: "- **tdai_read_scene**：按 path 读取 L2 场景文件全文（path 取自下方 <l2_scene_index>（场景索引）或 tdai_scenario_ls）",
    why: "本包只注册 scenario/read，没有 cos 文件读接口（tdai-tools-injector.ts 的 bridge allowlist 无 core/*）；写 tdai_read_cos 等于指示 LLM 调幻影工具。",
  },
  {
    field: "工具清单 / L1 按维度列举",
    source: null,
    proxy: "- **tdai_atomic_query**：按 type / 时间窗 / 分页列 L1 记忆（不做语义检索）",
    why: "本包额外暴露 atomic/query；源面向钩子路无此工具，但 proxy 侧不写 LLM 就不知道能按维度列举。",
  },
  {
    field: "工具清单 / L0 按会话取历史",
    source: null,
    proxy: "- **tdai_conversation_query**：按 session 顺序取 L0 历史消息",
    why: "同上：本包注册了 conversation/query，源里没有对应条目。",
  },
  {
    field: "工具清单 / L2 索引列举",
    source: null,
    proxy: "- **tdai_scenario_ls**：列出 L2 场景路径索引（含 summary，不含正文）",
    why: "同上：本包注册了 scenario/ls，用于索引刷新或按前缀过滤。",
  },
  {
    field: "场景索引块名",
    source: "下方 Scene Navigation",
    proxy: "下方 <l2_scene_index>（场景索引）",
    why: "本包实际注入的块名就是 <l2_scene_index>（tdai-profile-memory-injector.ts 的 L2 索引段）；且 persona 尾部的 Scene Navigation 段已被 stripSceneNavigation 剥掉，指「Scene Navigation」会让 LLM 去找一个上下文里不存在的段。",
  },
] as const;

/** 本包注册给 LLM 的工具（用途一句话；工具名集合由 parity 测试与本包注册集对齐）。 */
export interface ProxyToolDoc {
  name: string;
  use: string;
}

export const PROXY_TOOL_DOCS: readonly ProxyToolDoc[] = [
  {
    name: "tdai_memory_search",
    use: "搜索结构化记忆（L1），适用于回忆用户偏好、历史事件、规则等。",
  },
  {
    name: "tdai_atomic_query",
    use: "按 type / 时间窗 / 分页列 L1 记忆（不做语义检索），用于「有哪些」而不是「像什么」。",
  },
  {
    name: "tdai_conversation_search",
    use: "搜索原始对话（L0），适用于查找具体消息原文、时间线、上下文细节。",
  },
  {
    name: "tdai_conversation_query",
    use: "按 session 顺序取 L0 历史消息，用于还原某次会话的前后文。",
  },
  {
    name: "tdai_scenario_ls",
    use: "列出 L2 场景路径索引（含 summary，不含正文），用于刷新索引或按前缀过滤。",
  },
  {
    name: "tdai_read_scene",
    use: "按 path 读取 L2 场景文件全文；path 取自下方 <l2_scene_index>（场景索引）或 tdai_scenario_ls，读 imported_from 分段时带该分段 agent_id。",
  },
] as const;

/** 开篇纪律句：与源文件逐字一致（parity 测试 ① 断言）。 */
const DISCIPLINE_INTRO =
  "已注入的记忆优先使用：只要其中有与该问题相关的内容，就直接据此作答（必要时注明记忆时间），不要因为记忆不完整而拒答。只有在已注入的记忆完全没有相关线索、需要补充细节时，才调用以下工具获取更多信息：";

/** 次数限制段：与源文件逐字一致（parity 测试 ① 断言）。 */
const CALL_LIMIT_SECTION = [
  "### ⚠️ 调用次数限制",
  "每轮对话中，tdai_memory_search 和 tdai_conversation_search **合计最多调用 3 次**。",
  "- 首次搜索无结果时，可换关键词或换工具重试，但总调用次数不要超过 3 次。",
  "- 若 3 次搜索后仍无结果，说明该细节不在记忆中：请依据已注入的相关记忆作答并注明记录时间；只有已注入的记忆也完全没有相关线索时才说明无法确定，不要编造。",
].join("\n");

const TOOL_LIST = PROXY_TOOL_DOCS.map((t) => `- **${t.name}**：${t.use}`).join("\n");

/** 记忆工具调用指南（proxy 适配版：纪律句逐字来自单一源，工具清单按本包注册集渲染）。 */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

${DISCIPLINE_INTRO}

${TOOL_LIST}

${CALL_LIMIT_SECTION}
</memory-tools-guide>`;
