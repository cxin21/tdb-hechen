/**
 * deepseek-harness (dsh) 客户端适配器。
 *
 * 抓包实证(2026-08-14,mitmproxy 6 条真实包,详见
 * `docs/dsh-recon/2026-08-14-dsh-capture-analysis.md`):
 *
 *   - 协议:**标准 OpenAI Chat Completions**(`POST /chat/completions` + SSE),
 *     跟 codebuddy 同族;body/messages shape 100% 兼容(role:system/user/assistant/tool,
 *     tool_calls[] on assistant,单独 role=tool 消息带 tool_call_id)
 *   - 客户端指纹(强):`user-agent: deepseek-harness/*`(dsh attribution 不可关)
 *     + `x-deepseek-harness-user-id`(匿名 UUID 恒定) + `x-deepseek-harness-session-id`
 *     (session-<uuid>) + `x-deepseek-harness-compact:1`(仅 compaction 请求带)
 *   - session_id **只在 header**,body 不带 fallback 字段(跟 codex 的 client_metadata
 *     不同);proxy 侧 sid 提取 100% 依赖 header
 *   - assistant 回带 `reasoning_content`(dsh 特色,仅 tool_calls 轮回带),
 *     proxy 透传即可,不影响 messages parser
 *
 * # 三类请求的区分(main / title / compaction)
 *
 * dsh 主对话 / compaction / session-title 全部共用同一 `x-deepseek-harness-session-id`,
 * **仅 compaction 有独立 header**(compact:1),title 没有 —— 靠 body 特征区分:
 *
 * | 类别 | header 信号 | body 特征 |
 * |---|---|---|
 * | compaction | `x-deepseek-harness-compact: 1` | — |
 * | title-gen | 无 | tools 缺 + thinking.disabled + max_tokens<=128 + system 以 "Create a concise title..." 开头 |
 * | main | 无 | 其它 |
 *
 * classifyRequest 优先级:**compact header > title body-shape > main**;
 * title 判据必须**三合一都满足**才当 aux(单一特征易误判)。
 *
 * # 双协议(2026-09-29 起 dsh v0.2 换成 Anthropic Messages)
 *
 * 上面那套抓包结论只对 **v0.1.x(OpenAI Chat Completions)** 成立。v0.2+ 的 dsh 走
 * `POST {baseURL}/v1/messages`,wire shape 变成:
 *   - 系统提示词在 **`body.system`**(string 或 `[{type:"text",text}]`),不在 messages 里
 *   - user content 是 **block array**(`{type:"text"}` / `{type:"tool_result"}`)
 *   - tool 结果在 `role:"user"` 的 `tool_result` block 里(不再有独立 `role:"tool"`)
 *
 * 因此两个适配点都必须**同时认两种 shape**(v0.1 回归不能坏):
 *   - `classifyRequest`: 三重信号判(compact / title / main)。title-gen 的 system
 *     前缀判定对 v0.2 改读 `body.system`,v0.1 仍兜底 `messages[0].role==="system"`。
 *   - `extractUserText`: str 直接返回;block array 则拼 `type:"text"` 的 text
 *     (跳过 tool_result / thinking),全是 tool_result 时返回 null。
 *
 * # 不同于 CB 的地方
 *   - dsh 主对话在 body.messages 里塞 4 条 role=user:真实用户输入 +
 *     `<system-reminder>` 工作区指令 + `runtime context` 快照 + `<available_skills>` 列表
 *     —— proxy 侧提取最后一条 user 的 str content 时,取"从后往前第一条"就够;
 *     实际用户输入通常在 messages[1](第一条 user)
 *   - dsh 用户输入本身**不带 CB/workbuddy 那种 `<user_query>` wrapper**,直接透传
 */

import type { AgentAdapter, RequestKind } from "./types.js";

// ── Title-gen body-shape detection ───────────────────────────────────────────

/**
 * dsh session-title-llm 请求的 system prompt 固定前缀。
 * 来源:`packages/session/session-title-llm/src/index.ts:252-260` +
 * 抓包 `fixtures/121918-*-9d056d.req.json` 实证。
 *
 * dsh 侧 prompt 完整开头:
 *   "Create a concise title for an AI coding-assistant session from the supplied human messages."
 *
 * 只取前缀做匹配,避免上游 prompt 微调(punctuation / 换行)后判据失效。
 */
const DSH_TITLE_SYSTEM_PROMPT_PREFIX =
  "Create a concise title for an AI coding-assistant session";

/**
 * dsh title-gen 请求的 max_tokens 上限。抓包实证 `max_tokens=64`;
 * 留 128 一点富余,避免上游微调后跟着漂。
 */
const DSH_TITLE_MAX_TOKENS_CEIL = 128;

/**
 * 判定 dsh 请求是否为 title-gen(body 特征三合一)。
 *
 * 全部条件必须满足才当 aux。任一条不满足即返 false(避免误判 main)。
 */
function isDshTitleGen(body: Record<string, unknown>): boolean {
  // 条件 1: tools 缺失或空数组(主对话恒 25+ 个)
  const tools = body.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (hasTools) return false;

  // 条件 2: thinking 显式为 enabled 的才算主对话
  // - v0.1 抓包:title-gen 恒带 `thinking: { type: "disabled" }` → 放行。
  // - v0.2(anthropic):该字段可能整体缺省(deepseek anthropic adapter 只在开启时带
  //   `thinking:{type:"enabled", budget_tokens}`)→ 缺省也必须放行,否则 title-gen
  //   漏判成 main,标题请求会吃满注入管线(白烧 2-3s + 多次外部调用)。
  // 只排除显式 enabled:主对话恒为 enabled,title-gen 绝不为 enabled。
  const thinking = body.thinking as { type?: string } | undefined;
  if (thinking?.type === "enabled") return false;

  // 条件 3: max_tokens <= 128
  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== "number" || maxTokens > DSH_TITLE_MAX_TOKENS_CEIL) return false;

  // 条件 4: 系统提示词以 title prompt 前缀开头
  const systemText = readDshSystemText(body);
  if (!systemText || !systemText.startsWith(DSH_TITLE_SYSTEM_PROMPT_PREFIX)) return false;

  return true;
}

/**
 * 读 dsh 请求的"系统提示词文本"。
 *
 * - v0.2(anthropic):`body.system` —— string 或 `[{type:"text",text}]` block array
 * - v0.1(openai):`messages[0]` 且 role="system"(content 同样是 string 或 block array)
 *
 * 取不到返回 null。
 */
function readDshSystemText(body: Record<string, unknown>): string | null {
  const fromUnknown = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      const parts = (v as Array<{ type?: unknown; text?: unknown }>)
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string);
      return parts.length > 0 ? parts.join("\n") : null;
    }
    return null;
  };

  const fromBodySystem = fromUnknown(body.system);
  if (fromBodySystem) return fromBodySystem;

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = messages[0] as { role?: string; content?: unknown } | undefined;
  if (!first || first.role !== "system") return null;
  return fromUnknown(first.content);
}

// ── User text extraction ─────────────────────────────────────────────────────

/**
 * 提取用户真正键入的文本。两种 wire shape 都要认:
 *
 * - v0.1(openai):`content` 是 str —— 抓包实证 dsh 从不用 content-blocks。
 * - v0.2(anthropic):`content` 是 block array,用户输入是 `type:"text"` 的 block;
 *   表单答复是 `type:"tool_result"` block(里面才是用户选中的 label 文本)。
 *
 * 只有 tool_result / image / thinking、没有 text block 时返回 null(表示"这条 user
 * 消息里没有用户键入的文本"),让调用方继续往前找 —— 与
 * `agent-adapters/claude-code.ts:22` 的语义一致。
 *
 * 不做 CB 那种 `<user_query>` wrapper 剥离 —— dsh 主对话就是纯用户输入 +
 * 独立 `<system-reminder>` user 消息,没 wrapper 嵌套。
 */
function extractDshUserText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const raw of content as Array<{ type?: unknown; text?: unknown }>) {
    if (raw?.type !== "text") continue;
    if (typeof raw.text !== "string") continue;
    if (raw.text.length === 0) continue;
    parts.push(raw.text);
  }
  if (parts.length === 0) return null;
  return parts.join("\n");
}

// ── Adapter export ───────────────────────────────────────────────────────────

export const dshAdapter: AgentAdapter = {
  agentKind: "dsh",

  classifyRequest(
    body: Record<string, unknown>,
    _path?: string,
    headers?: Record<string, string>,
  ): RequestKind {
    // 信号 1(最强): compact header —— dsh source 硬编码在
    // `packages/llm/llm-deepseek/src/adapter.ts:290-293`,只在
    // `purpose:'compaction'` 时才塞,无歧义
    if (headers?.["x-deepseek-harness-compact"] === "1") return "auxiliary";

    // 信号 2: title-gen body 特征三合一(见 isDshTitleGen)
    if (isDshTitleGen(body)) return "auxiliary";

    // 其它一律 main
    return "main";
  },

  extractUserText(content: unknown): string | null {
    return extractDshUserText(content);
  },
};
