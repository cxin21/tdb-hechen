/**
 * AgentContext factory functions and utility methods.
 */

import { TOP_LEVEL_SYSTEM } from "./types.js";
import type {
  AgentContext,
  AgentContextMetadata,
  ContextBlock,
  ContextMessage,
  MessageRole,
} from "./types.js";

/**
 * Create a minimal AgentContext with the given messages and metadata.
 */
export function createAgentContext(
  messages: ContextMessage[],
  requestParams: Record<string, unknown>,
  metadata: AgentContextMetadata,
): AgentContext {
  return {
    messages,
    requestParams,
    metadata,
  };
}

/**
 * Create a text-only ContextBlock.
 */
export function textBlock(content: string, metadata?: Record<string, unknown>): ContextBlock {
  return { type: "text", content, metadata };
}

/**
 * Create a ContextMessage with a single text block.
 */
export function textMessage(role: MessageRole, content: string): ContextMessage {
  return { role, blocks: [{ type: "text", content }] };
}

/**
 * Get the system prompt from context — the message the adapter will hoist back
 * onto the provider's top-level system field.
 *
 * Anthropic parses that field into a message marked {@link TOP_LEVEL_SYSTEM}
 * and forwards any *other* role=system message inside `messages[]` (Claude Code
 * ships AGENTS.md that way, #118). Matching on `role` would return AGENTS.md
 * when the request carries no top-level system prompt at all — system.prefix /
 * system.suffix injections would then be glued into the agent's own AGENTS.md
 * text, and an anchor hit (`pipeline.apply`) would replace it outright.
 *
 * Other protocols have no top-level field, so there the first role=system
 * message *is* the system prompt.
 */
export function getSystemMessage(ctx: AgentContext): ContextMessage | undefined {
  const hoisted = ctx.messages.find((m) => m.metadata?.[TOP_LEVEL_SYSTEM] === true);
  if (hoisted) return hoisted;
  if (ctx.metadata.protocol === "anthropic") return undefined;
  return ctx.messages.find((m) => m.role === "system");
}

/**
 * Get the full text content of a message (all text blocks concatenated).
 */
export function getMessageText(msg: ContextMessage): string {
  return msg.blocks
    .filter((b) => b.type === "text")
    .map((b) => b.content)
    .join("\n");
}

/**
 * Whether the last message in the context carries a tool result.
 *
 * #39（ADR0003-P3 红线动作点近端）：agentic loop 中「尾消息是 tool_result」
 * 意味着模型刚收到工具输出、下一步决策可能再次发起工具调用 —— 这是
 * `tools.before_call` 动作点判定（识别"即将执行工具的轮"）。
 */
export function isToolResultTail(ctx: AgentContext): boolean {
  const msgs = ctx.messages;
  if (msgs.length === 0) return false;
  const tail = msgs[msgs.length - 1];
  return tail.blocks.some((b) => b.type === "tool_result");
}

/**
 * Get the last user message from context.
 */
export function getLastUserMessage(ctx: AgentContext): ContextMessage | undefined {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    if (ctx.messages[i].role === "user") return ctx.messages[i];
  }
  return undefined;
}

/**
 * Check if this context has only a single user turn (first turn).
 */
export function isFirstTurn(ctx: AgentContext): boolean {
  return ctx.messages.filter((m) => m.role === "user").length === 1;
}

/**
 * Insert a text block at the beginning of a message's blocks.
 */
export function prependTextToMessage(msg: ContextMessage, text: string): void {
  msg.blocks.unshift({ type: "text", content: text });
}

/**
 * Append a text block at the end of a message's blocks.
 */
export function appendTextToMessage(msg: ContextMessage, text: string): void {
  msg.blocks.push({ type: "text", content: text });
}
