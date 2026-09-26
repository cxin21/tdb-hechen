/**
 * Session key resolution & conversation freshness check.
 *
 * Shared between handler.ts and anthropicHandler.ts.
 */
import { createHash } from "node:crypto";
import type { Context } from "hono";

/** Extract conversation ID from request headers. Returns null if no valid ID found. */
export function resolveConversationId(c: Context): string | null {
  const id =
    c.req.header("x-conversation-id") ??
    c.req.header("x-session-id") ??
    c.req.header("x-claude-code-session-id") ?? // Claude Code CLI sends this
    c.req.header("x-deepseek-harness-session-id") ?? // dsh (deepseek-harness) CLI/web sends this
    c.req.header("x-chat-id") ??
    c.req.header("x-thread-id") ??
    null;
  return id && id.length > 0 ? id : null;
}

/** Check whether the messages look like a fresh conversation (at most 1 user message, no assistant/tool). */
export function isFreshConversation(
  messages: Array<{ role?: string }>,
): boolean {
  let userCount = 0;
  for (const m of messages) {
    const role = m.role ?? "";
    if (role === "assistant" || role === "tool") return false;
    if (role === "user") userCount++;
    if (userCount > 1) return false;
  }
  return userCount <= 1;
}

/** Hash width for derived conversation keys (12 hex chars = 48 bits). */
const CONV_KEY_HASH_LEN = 12;

function extractTextForHash(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: unknown }>)
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n");
  }
  return "";
}

/**
 * Derive a stable per-conversation session key from the FIRST user message.
 *
 * For header-less clients (llm-pi-ai openai-completions adapter sends no
 * x-deepseek-harness-session-id), the fallback sessionKey is per API key,
 * so ALL conversations share one session-init state machine. Concurrent
 * turns poison the pending form state until "max retries, abandoning"
 * writes a sticky bypass. Deriving the key from the first user text gives
 * each conversation its own state machine — the same semantics the
 * session-header agents (claude-code / codex / dsh llm-deepseek) already
 * get from resolveConversationId. Message history only grows forward
 * within a conversation, so the first user text is stable across the
 * whole tool loop (including the session-init form answer turn).
 *
 * Returns null when no user message carries text (caller keeps its own
 * fallback). See session/__tests__/session-key.conv.test.ts.
 */
export function deriveConversationKey(
  messages: Array<Record<string, unknown>>,
): string | null {
  for (const m of messages ?? []) {
    if (m?.role !== "user") continue;
    const text = extractTextForHash(m.content);
    if (!text) continue;
    const h = createHash("sha256").update(text.slice(0, 1024)).digest("hex").slice(0, CONV_KEY_HASH_LEN);
    return `conv-${h}`;
  }
  return null;
}
