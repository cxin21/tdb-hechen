import { describe, expect, it } from 'vitest';
import {
  CORE_MAX_MESSAGE_CHARS,
  CORE_MAX_MESSAGES_PER_REQUEST,
  CORE_MAX_REQUEST_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
  chunkByByteBudget,
  chunkMessages,
  fitMessageToByteBudget,
  jsonByteLength,
  truncateForCore,
  truncateToByteBudget,
} from '../src/wire-limits.js';

/**
 * These limits are the core's schema, not a preference: one message over 8192
 * chars or one batch over 100 messages is rejected with a 400 on every retry,
 * which used to dead-letter the whole turn (user text included).
 */

describe('wire limits', () => {
  it('matches the core schema constants', () => {
    expect(CORE_MAX_MESSAGE_CHARS).toBe(8192);
    expect(CORE_MAX_MESSAGES_PER_REQUEST).toBe(100);
  });

  it('leaves text under the limit untouched', () => {
    const text = 'a'.repeat(CORE_MAX_MESSAGE_CHARS);
    expect(truncateForCore(text)).toEqual({ text, truncated: false, originalLength: CORE_MAX_MESSAGE_CHARS });
  });

  it('clips over the limit, never above it, and says so', () => {
    const text = 'a'.repeat(CORE_MAX_MESSAGE_CHARS + 500);
    const result = truncateForCore(text);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(CORE_MAX_MESSAGE_CHARS + 500);
    expect(result.text.length).toBeLessThanOrEqual(CORE_MAX_MESSAGE_CHARS);
    expect(result.text).toContain('[truncated: 8692 chars]');
  });

  it('prefers a paragraph boundary near the cut', () => {
    const head = 'p'.repeat(7900);
    const tail = 'q'.repeat(4000);
    const result = truncateForCore(head + '\n' + tail);
    // Cut on the newline instead of mid-paragraph, and never keep the tail.
    expect(result.text.startsWith(head)).toBe(true);
    expect(result.text).not.toContain('q');
    expect(result.text).toContain('[truncated: ');
  });

  it('never splits a surrogate pair', () => {
    // Land the cut right in the middle of an emoji.
    const text = 'x'.repeat(CORE_MAX_MESSAGE_CHARS - 1) + '\u{1F600}' + 'y'.repeat(100);
    const result = truncateForCore(text);
    expect(result.text.isWellFormed()).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(CORE_MAX_MESSAGE_CHARS);
  });

  it('shards a long batch in order and keeps small batches whole', () => {
    const messages = Array.from({ length: 250 }, (_value, index) => ({ index }));
    const chunks = chunkMessages(messages, CORE_MAX_MESSAGES_PER_REQUEST);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
    expect(chunks.flat()).toEqual(messages);
    expect(chunkMessages([], 100)).toEqual([]);
    expect(chunkMessages([1, 2], 0)).toEqual([[1], [2]]);
  });
});

/**
 * The byte wall: the core answers an oversized body by destroying the socket
 * (server.ts:274-315) before it can send a 413, so the client only sees
 * ECONNRESET. Measured: 0.9 MB passes, 1.05 MB (L0) and 3.75 MB (skill) reset.
 */
describe('byte budget', () => {
  it('keeps the default budget under the measured 0.9 MB success point', () => {
    expect(DEFAULT_MAX_REQUEST_BYTES).toBe(700000);
    expect(CORE_MAX_REQUEST_BYTES).toBe(1000000);
    expect(DEFAULT_MAX_REQUEST_BYTES).toBeLessThan(900000);
  });

  it('measures the ESCAPED JSON size, not the character count', () => {
    expect(jsonByteLength('abc')).toBe(5);
    // CJK is 3 bytes per char in UTF-8.
    expect(jsonByteLength('中')).toBe(5);
    // A quote, a backslash and a newline each gain an escape byte.
    expect(jsonByteLength('"')).toBe(4);
    expect(jsonByteLength('\\')).toBe(4);
    expect(jsonByteLength(String.fromCharCode(10))).toBe(4);
    // An emoji is one code point, two UTF-16 units, four UTF-8 bytes.
    expect(jsonByteLength('😀')).toBe(6);
    expect(jsonByteLength({ a: 1 })).toBe(7);
  });

  it('clips text to a JSON byte budget and keeps the marker inside it', () => {
    const text = 'x'.repeat(2000);
    const result = truncateToByteBudget(text, 500);
    expect(result.truncated).toBe(true);
    expect(jsonByteLength(result.text)).toBeLessThanOrEqual(500);
    expect(result.text).toContain('…[truncated]');
    // Under budget: untouched.
    expect(truncateToByteBudget('abc', 500)).toEqual({ text: 'abc', truncated: false, originalLength: 3 });
  });

  it('counts CJK at three bytes, so a 500-byte budget keeps ~160 chars', () => {
    const result = truncateToByteBudget('中'.repeat(400), 500);
    expect(jsonByteLength(result.text)).toBeLessThanOrEqual(500);
    expect(result.text.length).toBeLessThan(200);
    expect(result.text.length).toBeGreaterThan(100);
  });

  it('never splits a surrogate pair when clipping by bytes', () => {
    const text = 'x'.repeat(90) + '😀'.repeat(20);
    const result = truncateToByteBudget(text, 120);
    expect(result.text.isWellFormed()).toBe(true);
    expect(jsonByteLength(result.text)).toBeLessThanOrEqual(120);
  });

  it('shards by bytes across the byte budget while keeping order', () => {
    const messages = Array.from({ length: 12 }, (_value, index) => ({ index, content: 'x'.repeat(400) }));
    const envelopeBytes = 120;
    const chunks = chunkByByteBudget(messages, { maxCount: 100, maxBytes: 1000, envelopeBytes });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.flat()).toEqual(messages);
    for (const chunk of chunks) {
      const body = { envelope: 'x'.repeat(envelopeBytes), messages: chunk };
      expect(jsonByteLength(body) + 8).toBeLessThanOrEqual(1100);
    }
  });

  it('still honours the message-count cap when bytes are not the limit', () => {
    const messages = Array.from({ length: 250 }, (_value, index) => ({ index }));
    const chunks = chunkByByteBudget(messages, { maxCount: 100, maxBytes: 10_000_000, envelopeBytes: 60 });
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
    expect(chunks.flat()).toEqual(messages);
    expect(chunkByByteBudget([], { maxBytes: 1000, envelopeBytes: 10 })).toEqual([]);
  });

  it('shrinks one message that alone exceeds the budget', () => {
    const message = { role: 'user' as const, content: '中'.repeat(4000), timestamp: '2026-10-31T10:00:00.000Z' };
    const envelopeBytes = 120;
    const maxBytes = 3000;
    const fitted = fitMessageToByteBudget(message, envelopeBytes, maxBytes);
    expect(fitted.truncated).toBe(true);
    expect(fitted.message.content.isWellFormed()).toBe(true);
    expect(envelopeBytes + 2 + jsonByteLength(fitted.message)).toBeLessThanOrEqual(maxBytes);
    // A fitting message is returned untouched.
    const small = { role: 'user' as const, content: 'ok' };
    expect(fitMessageToByteBudget(small, envelopeBytes, maxBytes)).toEqual({ message: small, truncated: false });
  });
});
