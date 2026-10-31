/**
 * Anthropic adapter — round-trip fidelity for system-role messages.
 *
 * #118: Claude Code >= 2.1.277 ships AGENTS.md as a role:"system" message inside
 * `messages[]` while CLAUDE.md stays in the top-level `system` field. The adapter
 * used to filter *every* role=system message out on serialize, so AGENTS.md was
 * silently dropped (no error on either side). Only the top-level field may be
 * hoisted; other system-role messages must stay in `messages[]` in place.
 */
import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import { getSystemMessage } from "../context.js";
import type { AgentContextMetadata, AgentContext } from "../types.js";

const metadata: AgentContextMetadata = {
  protocol: "anthropic",
  traceId: "trace-118",
  keyId: "key-118",
  modelId: "claude-sonnet-4-5",
  stream: true,
  agentSource: "claude-code",
};

const adapter = new AnthropicAdapter();

function parseAndSerialize(body: Record<string, unknown>): Record<string, unknown> {
  return adapter.serialize(adapter.parse(structuredClone(body), { ...metadata }));
}

const AGENTS_TEXT = "# AGENTS.md\n\nAlways answer in Chinese.";
const CLAUDE_TEXT = "You are Claude Code.";

describe("AnthropicAdapter — system-role messages (#118)", () => {
  it("hoists the top-level system field but keeps the AGENTS.md role=system message", () => {
    const out = parseAndSerialize({
      model: "claude-sonnet-4-5",
      system: CLAUDE_TEXT,
      messages: [
        { role: "system", content: AGENTS_TEXT },
        { role: "user", content: "hello" },
      ],
    });

    expect(out.system).toBe(CLAUDE_TEXT);
    expect(out.messages).toEqual([
      { role: "system", content: [{ type: "text", text: AGENTS_TEXT }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("preserves the position of a mid-conversation system message", () => {
    const out = parseAndSerialize({
      model: "claude-sonnet-4-5",
      system: CLAUDE_TEXT,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "system", content: AGENTS_TEXT },
        { role: "user", content: "second" },
      ],
    });

    expect(out.system).toBe(CLAUDE_TEXT);
    expect((out.messages as Array<{ role: string }>).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "system",
      "user",
    ]);
  });

  it("keeps every system-role message when there is no top-level system field", () => {
    const out = parseAndSerialize({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: AGENTS_TEXT },
        { role: "user", content: "hello" },
      ],
    });

    expect(out.system).toBeUndefined();
    expect(out.messages).toEqual([
      { role: "system", content: [{ type: "text", text: AGENTS_TEXT }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("keeps a role=system message untouched when the top-level system is a block array with cache_control", () => {
    const cacheControl = { type: "ephemeral" };
    const out = parseAndSerialize({
      model: "claude-sonnet-4-5",
      system: [
        { type: "text", text: CLAUDE_TEXT, cache_control: cacheControl },
        { type: "text", text: "Available tools: ..." },
      ],
      messages: [
        { role: "system", content: AGENTS_TEXT },
        { role: "user", content: "hello" },
      ],
    });

    expect(out.system).toEqual([
      { type: "text", text: CLAUDE_TEXT, cache_control: cacheControl },
      { type: "text", text: "Available tools: ..." },
    ]);
    expect((out.messages as Array<{ role: string }>)[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: AGENTS_TEXT }],
    });
  });

  it("injects into the top-level system message only, never into an AGENTS.md system message", () => {
    const ctx: AgentContext = adapter.parse(
      {
        model: "claude-sonnet-4-5",
        system: CLAUDE_TEXT,
        messages: [
          { role: "system", content: AGENTS_TEXT },
          { role: "user", content: "hello" },
        ],
      },
      { ...metadata },
    );

    // What the injection pipeline does at system.prefix: mutate whatever
    // getSystemMessage hands back. It must resolve to the hoisted top-level
    // message, not to the AGENTS.md one that merely shares its role.
    const sys = getSystemMessage(ctx);
    expect(sys).toBe(ctx.messages[0]);
    sys!.blocks.unshift({ type: "text", content: "[INJECTED]" });

    const out = adapter.serialize(ctx);
    expect(out.system).toEqual([
      { type: "text", text: "[INJECTED]" },
      { type: "text", text: CLAUDE_TEXT },
    ]);
    expect((out.messages as Array<Record<string, unknown>>)[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: AGENTS_TEXT }],
    });
  });

  it("skips system-prompt injection when the request has no top-level system field", () => {
    // No hoisted message exists, so the only role=system message is AGENTS.md.
    // getSystemMessage must not hand it back — otherwise system.prefix memory
    // lands inside AGENTS.md, and an anchor hit replaces its text entirely.
    const ctx: AgentContext = adapter.parse(
      {
        model: "claude-sonnet-4-5",
        messages: [
          { role: "system", content: AGENTS_TEXT },
          { role: "user", content: "hello" },
        ],
      },
      { ...metadata },
    );

    expect(getSystemMessage(ctx)).toBeUndefined();

    // The pipeline guards on that undefined and leaves the request alone.
    const out = adapter.serialize(ctx);
    expect(out.system).toBeUndefined();
    expect(out.messages).toEqual([
      { role: "system", content: [{ type: "text", text: AGENTS_TEXT }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("still treats the first role=system message as the system prompt on openai", () => {
    // OpenAI has no top-level field, so there the role is the only signal and
    // the marker lookup must fall back to it.
    const ctx: AgentContext = {
      messages: [
        { role: "system", blocks: [{ type: "text", content: "sys" }] },
        { role: "user", blocks: [{ type: "text", content: "hi" }] },
      ],
      requestParams: {},
      metadata: { ...metadata, protocol: "openai" },
    };

    expect(getSystemMessage(ctx)).toBe(ctx.messages[0]);
  });

  it("leaves a plain request (no system-role messages) byte-identical", () => {
    const body = {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: CLAUDE_TEXT,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "tu-1", name: "Read", input: { path: "a.ts" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
        },
      ],
    };

    const out = parseAndSerialize(body);
    expect(out).toEqual(body);
  });
});
