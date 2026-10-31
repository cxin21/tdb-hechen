/**
 * Wire limits enforced by MemoryCore's v3 data plane, verified in the core
 * sources (not guessed):
 *
 * - one message's `content` is capped at **8192 chars**
 *   (MemoryCore/src/gateway/generated/schemas.ts:88);
 * - `POST /v3/conversation/add` accepts at most **100 messages** per request
 *   (MemoryCore/src/gateway/v2-schemas.ts:120) — a longer batch is rejected with
 *   a 400 for the WHOLE turn, so the plugin used to lose tool-heavy turns
 *   entirely after 8 retries;
 * - `POST /v3/skill/conversation/add` allows up to **500** messages
 *   (MemoryCore/src/gateway/skill-schemas.ts), and it has **no server-side
 *   dedupe**: the same payload delivered twice doubles the L2 buffer. That is
 *   why the skill call is sharded at 500 (one request in practice) instead of
 *   100 — a replay of an earlier chunk must stay impossible.
 *
 * Everything here is pure so the limits are testable without a host or a core.
 */

/**
 * Hard ceiling from the core schema (MemoryCore/src/gateway/generated/schemas.ts):
 * a message longer than this is rejected with a 400 on every retry.
 *
 * The truncation marker COUNTS toward this budget: the body gets
 * 8192 - marker.length, never "8192 plus a suffix". If the marker wording
 * changes, re-check truncateForCore — the tests assert content.length <= 8192
 * after truncation.
 */
export const CORE_MAX_MESSAGE_CHARS = 8192;
export const CORE_MAX_MESSAGES_PER_REQUEST = 100;
export const CORE_MAX_SKILL_MESSAGES_PER_REQUEST = 500;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  originalLength: number;
}

/**
 * Cut one message down to the wire limit **without breaking the payload**:
 * - never splits a surrogate pair (an emoji sliced in half is invalid UTF-16
 *   and the JSON body no longer round-trips);
 * - prefers a line boundary inside the last quarter of the budget, so prose and
 *   markdown blocks are cut between paragraphs instead of mid-sentence;
 * - always leaves a visible marker, so a reader (and the L2 extractor) can tell
 *   the text was clipped rather than believing the turn ended there.
 */
export function truncateForCore(text: string, limit: number = CORE_MAX_MESSAGE_CHARS): TruncatedText {
  const source = typeof text === 'string' ? text : '';
  const originalLength = source.length;
  const budgetLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (budgetLimit === 0) return { text: '', truncated: originalLength > 0, originalLength };
  if (source.length <= budgetLimit) return { text: source, truncated: false, originalLength };

  const marker = '\n…[truncated: ' + originalLength + ' chars]';
  const budget = budgetLimit - marker.length;
  if (budget <= 0) {
    // Pathological limit: still return a bounded, valid string.
    return { text: source.slice(0, budgetLimit), truncated: true, originalLength };
  }

  let cut = budget;
  // Prefer the last newline in the final quarter of the budget: paragraph-safe.
  const floor = Math.max(0, budget - Math.max(200, Math.floor(budget / 4)));
  const newline = source.lastIndexOf('\n', budget);
  if (newline > floor) cut = newline;
  // Boundary safety: index `cut` starts the next rune, so a high surrogate at
  // `cut - 1` would be the left half of a pair that ends at `cut`.
  if (cut > 0 && cut < source.length && isHighSurrogate(source.charCodeAt(cut - 1)) && isLowSurrogate(source.charCodeAt(cut))) {
    cut -= 1;
  }

  return { text: source.slice(0, cut) + marker, truncated: true, originalLength };
}

/**
 * Byte budget for one request body. The core's HTTP layer rejects an oversized
 * body by destroying the socket BEFORE it can send a 413
 * (MemoryCore/src/server.ts:274-315), so the client only ever sees ECONNRESET:
 * measured, 0.9 MB passes while 1.05 MB (L0) and 3.75 MB (skill) always reset.
 * 700000 bytes leaves headroom below the observed 0.9 MB success point.
 */
export const DEFAULT_MAX_REQUEST_BYTES = 700000;

/** Absolute ceiling a config value may not exceed (1 MiB). */
export const CORE_MAX_REQUEST_BYTES = 1000000;

/** Marker left when a payload has to be clipped for the byte budget. */
const BYTE_MARKER = '…[truncated]';

/** JSON size of one value in UTF-8 bytes (0 when it cannot be serialized). */
export function jsonByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Clip text so that its JSON-encoded form fits `budgetBytes`.
 *
 * Counted per code point (a sliced surrogate pair is invalid UTF-16 and breaks
 * both the wire body and the L2 extractor) and measured on the ESCAPED form:
 * JSON.stringify turns " into \", a newline into \n and a control char into
 * \u0001, so character count is not a safe proxy for bytes.
 */
export function truncateToByteBudget(text: string, budgetBytes: number): TruncatedText {
  const source = typeof text === 'string' ? text : '';
  const originalLength = source.length;
  const budget = Number.isFinite(budgetBytes) ? Math.max(0, Math.floor(budgetBytes)) : 0;
  if (budget === 0) return { text: '', truncated: originalLength > 0, originalLength };
  if (jsonByteLength(source) <= budget) return { text: source, truncated: false, originalLength };
  const room = budget - jsonByteLength(BYTE_MARKER);
  if (room <= 0) return { text: '', truncated: true, originalLength };
  let used = 0;
  let out = '';
  for (const char of source) {
    // Escaped size of ONE code point: the JSON form of a single character is
    // '"…"' (two quote bytes), so subtracting 2 yields its exact contribution.
    const bytes = jsonByteLength(char) - 2;
    if (used + bytes > room) break;
    used += bytes;
    out += char;
  }
  return { text: out + BYTE_MARKER, truncated: true, originalLength };
}

export interface ByteChunkOptions {
  /** Hard cap on messages per request (schema limit). Defaults to 100. */
  maxCount?: number;
  /** Byte budget for the WHOLE body (envelope fields included). */
  maxBytes: number;
  /**
   * Bytes of the body when `messages` is empty, MINUS the two array brackets.
   * Callers derive it with `jsonByteLength({ ...envelope, messages: [] }) - 2`
   * so identity fields and session_id are counted exactly once.
   */
  envelopeBytes: number;
}

/**
 * Split a message list into ordered chunks that respect BOTH the per-request
 * message cap and the byte budget; never reorders and never drops a message.
 * A message that alone exceeds the budget must be shrunk by the caller first
 * (see fitMessageToByteBudget) — otherwise it gets a chunk of its own.
 */
export function chunkByByteBudget<T>(messages: readonly T[], options: ByteChunkOptions): T[][] {
  const list = Array.isArray(messages) ? messages : [];
  const maxCount = Number.isFinite(options.maxCount)
    ? Math.max(1, Math.floor(options.maxCount as number))
    : CORE_MAX_MESSAGES_PER_REQUEST;
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(1, Math.floor(options.maxBytes))
    : DEFAULT_MAX_REQUEST_BYTES;
  const envelopeBytes = Number.isFinite(options.envelopeBytes)
    ? Math.max(0, Math.floor(options.envelopeBytes))
    : 0;
  const chunks: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const message of list) {
    const bytes = jsonByteLength(message);
    // body = envelopeBytes + '[' + items joined by ',' + ']'
    const separator = current.length > 0 ? 1 : 0;
    if (current.length > 0 && (current.length >= maxCount || envelopeBytes + 2 + used + bytes + separator > maxBytes)) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(message);
    used += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Shrink one message's `content` until the whole body fits the byte budget.
 * Used as the last resort for a single oversized message (e.g. a 30k-char
 * summary or a tiny configured maxRequestBytes); returns the message unchanged
 * when it already fits.
 */
export function fitMessageToByteBudget<T extends { content: string }>(
  message: T,
  envelopeBytes: number,
  maxBytes: number,
): { message: T; truncated: boolean } {
  const envelope = Math.max(0, Math.floor(envelopeBytes));
  const budget = Math.max(1, Math.floor(maxBytes));
  if (envelope + 2 + jsonByteLength(message) <= budget) return { message, truncated: false };
  const skeleton = { ...message, content: '' };
  const available = budget - envelope - 2 - jsonByteLength(skeleton);
  const clipped = truncateToByteBudget(message.content, Math.max(0, available));
  return { message: { ...message, content: clipped.text }, truncated: clipped.truncated };
}

/** Split a message list into ordered request-sized chunks; never reorders. */
export function chunkMessages<T>(messages: readonly T[], size: number = CORE_MAX_MESSAGES_PER_REQUEST): T[][] {
  const limit = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : CORE_MAX_MESSAGES_PER_REQUEST;
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < messages.length; index += limit) {
    chunks.push(messages.slice(index, index + limit));
  }
  return chunks;
}
