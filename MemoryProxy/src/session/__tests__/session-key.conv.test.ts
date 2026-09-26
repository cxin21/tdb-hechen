/**
 * V12-PROVIDER Phase 3 — per-conversation session key derivation for
 * header-less clients (llm-pi-ai openai-completions adapter).
 *
 * Design intent: claude-code / codex / dsh(llm-deepseek) all carry a session
 * header (x-claude-code-session-id / x-deepseek-harness-session-id), giving
 * each conversation its own session-init state machine. llm-pi-ai sends no
 * session header, so sessionKey falls back to apiKeyToKeyId(apiKey) — ALL
 * conversations share one state machine. Concurrent/background turns poison
 * the pending form state (attemptCount++ on every non-answer turn) until
 * "max retries, abandoning" writes a STICKY bypass (Case 3) — the exact
 * production incident of 2026-09-26 06:08→06:14 (journal: dsh:19002fba
 * pending_agent_select ×2 → agent_select max retries, abandoning).
 *
 * Fix: derive a stable per-conversation key from the FIRST user message.
 * Message history only grows forward within a conversation, so the first
 * user text is a stable conversation fingerprint across the whole tool loop
 * (including the session-init form answer turn).
 */
import { describe, it, expect } from "vitest";
import { deriveConversationKey } from "../session-key.js";

describe("deriveConversationKey", () => {
  it("returns conv-<12hex> for a simple conversation", () => {
    const msgs = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "你是谁" },
    ];
    const key = deriveConversationKey(msgs as Array<Record<string, unknown>>);
    expect(key).toMatch(/^conv-[0-9a-f]{12}$/);
  });

  it("is stable as history grows (tool-loop turns keep the same first user message)", () => {
    const base = [
      { role: "system", content: "sys" },
      { role: "user", content: "你是谁" },
    ];
    const grown = [
      ...base,
      { role: "assistant", content: "hi", tool_calls: [{ id: "call_x" }] },
      { role: "tool", tool_call_id: "call_x", content: "answer text" },
      { role: "user", content: "第二个问题" },
    ];
    expect(deriveConversationKey(grown as Array<Record<string, unknown>>)).toBe(
      deriveConversationKey(base as Array<Record<string, unknown>>),
    );
  });

  it("differs for different first user messages", () => {
    const a = [{ role: "user", content: "你是谁" }];
    const b = [{ role: "user", content: "今天天气如何" }];
    expect(deriveConversationKey(a as Array<Record<string, unknown>>)).not.toBe(
      deriveConversationKey(b as Array<Record<string, unknown>>),
    );
  });

  it("skips leading system messages and uses the first USER message", () => {
    const msgs = [
      { role: "system", content: "sys-A" },
      { role: "user", content: "first question" },
      { role: "user", content: "second question" },
    ];
    const only = [{ role: "user", content: "first question" }];
    expect(deriveConversationKey(msgs as Array<Record<string, unknown>>)).toBe(
      deriveConversationKey(only as Array<Record<string, unknown>>),
    );
  });

  it("handles array content (text parts joined)", () => {
    const a = [
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] },
    ];
    const b = [{ role: "user", content: "hello\nworld" }];
    expect(deriveConversationKey(a as Array<Record<string, unknown>>)).toBe(
      deriveConversationKey(b as Array<Record<string, unknown>>),
    );
  });

  it("returns null when there is no user message with text", () => {
    const msgs = [{ role: "system", content: "only system" }];
    expect(deriveConversationKey(msgs as Array<Record<string, unknown>>)).toBeNull();
    expect(deriveConversationKey([])).toBeNull();
  });
});
