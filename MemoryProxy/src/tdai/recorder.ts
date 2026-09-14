import type { TdaiClient } from "./client.js";
import type { TdaiIdentity, TdaiMessage } from "./types.js";
import { extractUserQueryText, isDshRuntimeContextSnapshot } from "../common/user-query-extractor.js";

/**
 * 从最后一条 user 消息中抽取「真正的用户提问」，写入 L0。
 *
 * 背景：CodeBuddy / Claude Code / DSH 等编码 agent 的 user 消息里除了真实问题，
 * 还塞了大量 harness 上下文（<additional_data>、current_time、<system_reminder>、
 * DSH 的 `Current runtime context.` 快照等）。如果把整条消息原样写进 L0，记忆
 * 会被这些噪声污染，而且每轮都不一样、检索价值极低。因此这里只保留真实提问。
 *
 * 采用**正向匹配**而非黑名单拒绝：
 *   一条 user 消息应被提取，当且仅当它「看起来是用户/插件直接书写，而非 dsh
 *   官方协议注入」——即 `extractUserQueryText` 清理后非空，且原始内容**不以 `<`
 *   开头**（dsh 的 `<EXTREMELY_IMPORTANT>` / `<system-reminder>` 等协议块都以 `<`
 *   开头），也**不是** `Current runtime context.` 快照。
 *
 *   不枚举任何插件 tag（如 `[分析纪律]`、`【诊断模式】`、`[scm-rag]`）：这些是
 *   团队插件注入、但形态上不以 `<` 开头，会被自然保留为记忆素材；后续新增插件
 *   亦然——**无需改源码**，只要新内容是「非 `<` 协议形态」即可被提取。
 *
 * 抽取算法在 `common/user-query-extractor.ts` 内实现（tdai / mem-command /
 * codebuddy adapter 共用同一份，避免语义漂移）；本模块负责"倒扫 user 消息 →
 * 正向匹配第一条真实用户提问 → 组装 TdaiMessage"。
 */

// 保留 re-export，避免下游（含单测）import 路径变化引发一次性大改。
export { extractUserQueryText };

/**
 * 正向匹配谓词：判定一条 user 消息是否「可提取为记忆的真人/插件输入」。
 *
 * 返回 true 当且仅当：
 *   - `extractUserQueryText` 清理后非空（排除 CC/CB 的 harness 剥离）
 *   - 原始内容不以 `<` 开头（排除 dsh 的 `<EXTREMELY_IMPORTANT>` / `<system-reminder>`
 *     / `<question_answer>` 等协议块）
 *   - 不是 dsh 的 `Current runtime context.` 运行时快照
 *
 * 注意：这里是**正向匹配**，不是维护一份"拒绝/接受"标签清单。插件注入的
 * `[分析纪律]` / `【诊断模式】` / `[scm-rag]` 等不以 `<` 开头，会被当作可提取
 * 记忆保留；dsh 官方协议块统一以 `<` 开头，被结构性地排除。
 */
export function isExtractableUserInput(content: unknown): boolean {
  const raw = extractContentText(content);
  if (!raw.trim()) return false;
  // dsh 官方协议注入统一是 `<...>` 包裹（EXTREMELY_IMPORTANT / system-reminder …）。
  // 真实用户输入 / 团队插件文本不以 `<` 开头。
  if (raw.trimStart().startsWith("<")) return false;
  // dsh 运行时快照（纯文本，无 XML 包裹）
  if (isDshRuntimeContextSnapshot(raw)) return false;
  // 再走一次统一语义清理（CC/CB harness 剥离）确认非空
  return extractUserQueryText(raw).trim().length > 0;
}

export function extractLatestUserMessage(messages: unknown[]): TdaiMessage | null {
  // 通用渠道（CC/CB/workbuddy 等）的原始语义：倒扫取第一条剥离 harness 后非空。
  // 保持原逻辑不变，避免影响其它渠道 —— dsh 用 extractLatestDshUserMessage。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "user") continue;
    const content = extractUserQueryText(extractContentText(msg.content));
    if (content.trim()) return { role: "user", content };
  }
  return null;
}

/**
 * dsh 专用提取：**正向匹配**真实用户消息（而非枚举插件标签）。
 *
 * 与通用 `extractLatestUserMessage` 的区别：用 `isExtractableUserInput` 正向判定
 * 「这条 user 消息看起来是用户/插件直接书写，而不是 dsh 官方协议注入」——
 *    - 不以 `<` 开头（排除 `<EXTREMELY_IMPORTANT>` / `<system-reminder>` 等）
 *    - 不是 `Current runtime context.` 快照
 *    - `extractUserQueryText` 清理后非空
 *
 * 不枚举任何插件 tag（`[分析纪律]` / `【诊断模式】` / `[scm-rag]` 等），它们不以
 * `<` 开头，会被自然保留为记忆素材；新插件注入亦然——**无需改源码**。
 * 对齐 codex / workbuddy 的「渠道独立 extract」设计，仅供 handler.ts dsh 分支调用。
 */
export function extractLatestDshUserMessage(messages: unknown[]): TdaiMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "user") continue;
    if (!isExtractableUserInput(msg.content)) continue;
    return { role: "user", content: extractUserQueryText(extractContentText(msg.content)) };
  }
  return null;
}

export async function recordTdaiTurn(client: TdaiClient, identity: TdaiIdentity | null, userMessage: TdaiMessage | null, assistantContent: string | null | undefined): Promise<void> {
  // [PROBE-v2] full-args dump for L0 write path — DEBUG ONLY
  try {
    const { log } = await import("../report/log.js");
    const caller = () => {
      try { return String(new Error().stack || "").split("\n").slice(2, 6).join("|"); } catch { return ""; }
    };
    log.info("dsh-l0-turn-v2", {
      identityPresent: !!identity,
      identity: identity ? {
        team: identity.teamId, user: identity.userId, agent: identity.agentId,
        session: identity.sessionId, task: identity.taskId, userKey: identity.userKey ? "set" : "unset",
      } : null,
      userMessagePresent: !!userMessage,
      userMessageLen: userMessage ? String(userMessage.content ?? "").length : null,
      userMessageFull: userMessage ? String(userMessage.content ?? "").slice(0, 500) : null,
      assistantLen: assistantContent ? String(assistantContent ?? "").length : null,
      assistantFull: assistantContent ? String(assistantContent ?? "").slice(0, 200) : null,
      caller: caller().slice(0, 300),
    });
  } catch { /* best effort */ }

  if (!identity || !userMessage) {
    // [PROBE] reason why recordTdaiTurn early-returns — DEBUG ONLY
    try {
      const { log } = await import("../report/log.js");
      const prog = () => {
        try { return String(new Error().stack || "").split("\n").slice(2, 6).join("|"); } catch { return ""; }
      };
      log.info("dsh-l0-skip", {
        identity: !!identity, userMessage: !!userMessage,
        reason: !identity ? "no-identity" : "no-user-message",
        agent: identity?.agentId ?? null,
        user: identity?.userId ?? null,
        session: identity?.sessionId ?? null,
        caller: prog().slice(0, 200),
      });
    } catch { /* best effort */ }
    return;
  }
  const messages: TdaiMessage[] = [userMessage];
  if (assistantContent?.trim()) {
    messages.push({ role: "assistant", content: assistantContent });
  }
  await client.addConversation(identity, messages);
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
