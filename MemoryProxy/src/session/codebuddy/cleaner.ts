/**
 * CodeBuddy Session Init — LastUser text extractor.
 *
 * 曾经这个文件里有 `stripInitArtifacts` 用来在 session_init 完成后剥离
 * 假表单对话（避免 LLM 看到 form 交互）。**该功能已删除**——现在永远保留
 * 用户的所有真实对话（含 session_init form 交互），不做任何删除。
 *
 * 目前只剩一个 export: `getLastUserMessageText`，用于在 session_init
 * state machine 里读最后一条 user / tool 消息的文本以解析用户选择。
 *
 * ── CodeBuddy ask_followup_question 回写格式 ──
 *
 * 用户点击表单后，CodeBuddy 下一条请求中问答所在的消息结构：
 *
 *   [N-2] role=assistant  tool_calls=[{id:"call_session_init_...", function:{name:"ask_followup_question"}}]
 *   [N-1] role=tool       tool_call_id=call_session_init_...  content=<multi_question_result JSON>
 *   [N]   role=user       content=<additional_data> 或其他普通 user 消息
 *
 * multi_question_result JSON（实际抓包格式）：
 *   空壳中间态（表单刚展示，用户还没点）：
 *     {"status":"success","success":true,"result":{"type":"multi_question_result",
 *      "questions":[{"id":"team","options":[...],"multiSelect":false}],
 *      "answers":{},
 *      "message":"Questions displayed. User response will be in <que"}}
 *
 *   真实答案（用户点击后）：
 *     {"status":"success","success":true,"result":{"type":"multi_question_result",
 *      "questions":[{"id":"team","answer":"Team名 (id尾8位)",...}],
 *      "answers":{"team":"Team名 (id尾8位)"}}}
 *
 * getLastUserMessageText 当前只扫描 user 消息，不处理 tool 消息。
 * team 提取依赖 extractor 的 substring 兜底匹配在无关 user 文本中碰巧蹭到 team 名，
 * 不是精确解析。如需可靠提取，需增加 tool 消息解析路径。
 */

import { containsFormTitle, TOOLCALL_PREFIXES } from "./form.js";

export interface RawMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
}

interface AnthropicBlock {
  type?: unknown;
  text?: unknown;
}

/**
 * A `call_*_session_init_`-style identifier that tags a proxy-injected form
 * tool_call (name = ask_user_question / ask_followup_question) and its paired
 * `role: tool` answer message. 兼容 OpenCode 的 `call_oc_session_init_`、
 * WorkBuddy 的 `call_wb_session_init_`、dsh 的 `call_dsh_session_init_`、以及
 * CodeBuddy 的 `call_session_init_` / `toolu_session_init_`。
 */
const SESSION_INIT_TOOLCALL_RE = /call_(wb_|dsh_|oc_|cc_)?session_init_/;

/**
 * Strip the proxy-injected session-init form conversation from `messages`.
 *
 * 移除「assistant 的 form tool_call」与「配对的 role=tool 回答」，让模型不再
 * 看到代理在会话初始化阶段伪造的交互。这在**单 agent auto-select 完成注册**
 * （completeRegistration → intercepted:false → 透传上游）时至关重要：若不剥离，
 * 模型会看到「assistant 问‘是否关联资产’ + tool 答‘是’」的残留，并据此续问
 * team/agent/选择 —— 但那一刻不再有可用 form 工具，模型产出 `id="" name=""`
 * 的空 tool_call，进而触发 upstream 400 `missing messages.tool_call_id` /
 * dsh 侧 `Error: unknown tool ""`。
 *
 * 只剥离代理注入的表单帧（assistant 的 tool_calls 中含 SESSION_INIT_TOOLCALL_RE
 * 前缀 + 配对的 role=tool），绝不动用户其它真实消息。
 */
export function stripInitArtifacts(messages: RawMessage[]): RawMessage[] {
  // 收集所有仍「未配对」的 session-init 形态 tool_call_id（assistant 侧发起）。
  // assistant 的 tool_calls[] 里命中的 id → 待剥离；对应 role=tool 的
  // tool_call_id 命中 → 待剥离。
  const stripIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray((m as any).tool_calls)) {
      for (const tc of (m as any).tool_calls as Array<{ id?: string; type?: string; function?: { name?: string } }>) {
        const id = tc?.id;
        if (typeof id === "string" && SESSION_INIT_TOOLCALL_RE.test(id)) {
          stripIds.add(id);
        }
      }
    }
  }

  // 若没有任何 session-init tool_call，则无可剥离 —— 快速返回。
  if (stripIds.size === 0) return messages;

  const seenIds = new Set<string>();
  return messages.filter((m) => {
    // 1) 剥掉 assistant 消息中命中前缀的 tool_calls（将 tool_calls 清空，保留
    //    该消息的纯文本 content，避免破坏对话语义）。
    if (m.role === "assistant" && Array.isArray((m as any).tool_calls)) {
      const kept = ((m as any).tool_calls as any[]).filter(
        (tc: any) => !(typeof tc?.id === "string" && SESSION_INIT_TOOLCALL_RE.test(tc.id)),
      );
      const had = ((m as any).tool_calls as any[]).length > kept.length;
      if (had && kept.length > 0) {
        (m as any).tool_calls = kept;
        return true;
      }
      if (had) {
        // 全部 tool_calls 都是 form —— 剥除这整条 assistant 的 form 帧。
        return false;
      }
      return true;
    }

    // 2) 剥掉配对 role=tool 的回答消息。
    if (m.role === "tool") {
      const tcid = (m as any).tool_call_id as string | undefined;
      if (typeof tcid === "string" && SESSION_INIT_TOOLCALL_RE.test(tcid)) {
        const isProvided = stripIds.has(tcid);
        if (!isProvided) seenIds.add(tcid);
        // 命中已收集的 form 发起 id → 剥除；否则这是旧 form 的回答（未在本轮
        // assistant 里出现配对了），保守保留。
        return !isProvided;
      }
    }
    return true;
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get text from last user or tool message containing form answer data.
 *
 * CodeBuddy writes form responses as `role: "tool"` messages with
 * `tool_call_id` matching the session init `ask_followup_question`.
 * We look at BOTH user messages (for old XML `<question_answer>` format)
 * AND tool messages (for the actual `multi_question_result` / plain-text
 * answer format) — picking the LAST relevant one, whichever role it has.
 */
export function getLastUserMessageText(messages: RawMessage[]): string {
  // Sweep from end: the last message (user or tool) that relates to
  // session init is what we want. Tool messages are preferred because
  // CB writes "是，关联团队资产" etc. into tool_result content.
  let best = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role !== "user" && role !== "tool") continue;

    const text = getMessageText(messages[i]);
    if (!text) continue;

    // Tool messages linked to a session-init tool_call are always relevant.
    // 兼容四种前缀：CB 的 `call_session_init_`、WB 的 `call_wb_session_init_`
    // （workbuddy/form.ts 里 TOOLCALL_PREFIX = "call_wb_session_init_"）、
    // dsh 的 `call_dsh_session_init_`（dsh/form.ts TOOLCALL_PREFIX）、
    // opencode 的 `call_oc_session_init_`（opencode/form.ts TOOLCALL_PREFIX）。
    const tcid = (messages[i] as any).tool_call_id as string | undefined;
    if (role === "tool" && tcid && /call_(wb_|dsh_|oc_)?session_init_/.test(tcid)) {
      return text;
    }

    // User messages with form markers have highest priority for old format
    if (role === "user" && (text.includes("<question_answer") || containsFormTitle(text))) {
      return text;
    }

    // Remember the last user/tool text as fallback
    if (!best && role === "user") {
      best = text;
    }
  }
  return best;
}

function getMessageText(msg: RawMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content as AnthropicBlock[]) {
      if (raw.type === "text" && typeof raw.text === "string") {
        parts.push(raw.text);
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(content ?? "");
}
