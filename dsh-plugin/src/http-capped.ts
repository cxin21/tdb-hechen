/**
 * Bounded HTTP reads for everything this plugin pulls over the wire.
 *
 * Why this exists: the plugin runs INSIDE the user's GUI host process. Every
 * call used to be await response.text(), which materializes the whole body in
 * that process before any code can look at it — one oversized or hostile
 * response (a proxy HTML error page, a wrong URL pointing at a file server) is
 * enough to balloon the host's heap and take the user's session with it. There
 * is also no guarantee about WHERE a URL came from: core responses carry
 * "service_url" fields, so a value that was never scheme-checked can point at
 * file: or an arbitrary intranet host.
 *
 * Two layers, both fail-soft (never throw — a memory outage must not break a
 * host turn):
 *   - readCapped(): bytes-only cap on an already-obtained Response.
 *   - fetchJsonCapped(): URL scheme gate + timeout + capped read + JSON parse,
 *     returning a discriminated union instead of throwing.
 *
 * The cap is a MEMORY guard, not a protocol guard: it does not try to be an
 * exact byte count of the body (chunk boundaries make that unnecessary), and it
 * prefers content-length when the server declares one so an oversized body is
 * never even read.
 */

/** Default ceiling for one response body: 2 MiB. */
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Hard ceiling a config value is clamped to: 16 MiB (still a memory-safe read). */
export const MAX_RESPONSE_BYTES_CEILING = 16 * 1024 * 1024;
/** Schemes a memory-service URL may use. Everything else is refused unread. */
export const DEFAULT_ALLOWED_SCHEMES: readonly string[] = ['http:', 'https:'];

/** Clamp any configured byte cap into [1, MAX_RESPONSE_BYTES_CEILING]. */
export function clampMaxResponseBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_RESPONSE_BYTES;
  return Math.min(MAX_RESPONSE_BYTES_CEILING, Math.max(1, Math.floor(value)));
}

export type CappedRead =
  | { kind: 'ok'; text: string; bytes: number }
  | { kind: 'too_large'; reason: string; declared?: number; bytes: number };

/**
 * Read a Response body under a byte cap.
 *
 * Order matters: the declared content-length is checked FIRST, so a server that
 * announces a 200 MB body costs nothing. Only when the length is absent or
 * untrustworthy do we stream chunks and stop the moment the running total
 * crosses the cap, cancelling the reader so the socket is torn down instead of
 * draining into memory.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<CappedRead> {
  const limit = clampMaxResponseBytes(maxBytes);
  const declaredRaw = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length')
    : null;
  const declared = declaredRaw === null || declaredRaw === undefined || declaredRaw === '' ? undefined : Number(declaredRaw);
  if (declared !== undefined && Number.isFinite(declared) && declared > limit) {
    return { kind: 'too_large', reason: 'declared content-length ' + declared + ' > ' + limit, declared, bytes: 0 };
  }

  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') {
    // No stream (204, or a stub response in tests): fall back to text(), which is
    // empty by contract for a body-less response.
    const text = typeof response.text === 'function' ? await response.text() : '';
    const bytes = utf8Length(text);
    if (bytes > limit) return { kind: 'too_large', reason: 'body ' + bytes + ' > ' + limit, bytes };
    return { kind: 'ok', text, bytes };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        // Stop the transfer instead of reading the rest into memory.
        try { await reader.cancel('response too_large'); } catch { /* already closed */ }
        return { kind: 'too_large', reason: 'body exceeded ' + limit + ' bytes', bytes: total };
      }
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel('read failed'); } catch { /* already closed */ }
    throw error;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'ok', text: new TextDecoder('utf-8', { fatal: false }).decode(merged), bytes: total };
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export type CappedFetchResult<T> =
  | { kind: 'ok'; json: T; text: string; bytes: number }
  | { kind: 'bad_url'; reason: string }
  | { kind: 'bad_scheme'; reason: string }
  | { kind: 'timeout'; reason: string }
  | { kind: 'transport'; reason: string }
  | { kind: 'http'; status: number; text: string }
  | { kind: 'too_large'; reason: string; declared?: number }
  | { kind: 'bad_json'; reason: string; text: string };

export interface CappedFetchOptions {
  /** Byte cap for the response body (clamped to [1, 16 MiB]). */
  maxBytes?: number;
  /** Own request timeout in ms; <= 0 means "the caller owns cancellation". */
  timeoutMs?: number;
  /** Allowed URL schemes; anything else is refused WITHOUT calling fetch. */
  allowSchemes?: readonly string[];
  /** Injectable for tests (defaults to the global fetch). */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch JSON with a scheme gate, a timeout and a byte cap. Never throws: every
 * failure mode (including a hostile URL) is a discriminated union the caller
 * can branch on without try/catch.
 */
export async function fetchJsonCapped<T = unknown>(
  url: string,
  init: RequestInit = {},
  options: CappedFetchOptions = {},
): Promise<CappedFetchResult<T>> {
  const limit = clampMaxResponseBytes(options.maxBytes);
  const allowed = options.allowSchemes && options.allowSchemes.length > 0 ? options.allowSchemes : DEFAULT_ALLOWED_SCHEMES;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'bad_url', reason: 'not an absolute URL' };
  }
  if (!allowed.includes(parsed.protocol)) {
    // Refused before any network call: file:/data:/javascript: and friends must
    // never reach fetch(), and a test asserts fetch was called zero times.
    return { kind: 'bad_scheme', reason: 'scheme ' + parsed.protocol + ' not allowed' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? Math.floor(options.timeoutMs) : 0;
  const callerSignal = init.signal ?? undefined;
  const ownTimeout = timeoutMs > 0 && callerSignal === undefined;
  const signal = ownTimeout ? AbortSignal.timeout(timeoutMs) : callerSignal;

  let response: Response;
  try {
    response = await fetchImpl(url, signal ? { ...init, signal } : init);
  } catch (error) {
    if (ownTimeout || (callerSignal && callerSignal.aborted)) {
      return { kind: 'timeout', reason: 'timed out after ' + timeoutMs + 'ms' };
    }
    const name = (error as { name?: string } | undefined)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { kind: 'timeout', reason: 'timed out' };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: 'transport', reason: detail };
  }

  let read: CappedRead;
  try {
    read = await readCapped(response, limit);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: 'transport', reason: detail };
  }

  if (!response.ok) {
    // A rejected request can still carry a huge body (proxy error pages): the
    // same cap applies, and the caller only needs status + a prefix.
    return { kind: 'http', status: response.status, text: read.kind === 'ok' ? read.text : '' };
  }
  if (read.kind === 'too_large') {
    return { kind: 'too_large', reason: read.reason, declared: read.declared };
  }
  try {
    return { kind: 'ok', json: JSON.parse(read.text) as T, text: read.text, bytes: read.bytes };
  } catch {
    return { kind: 'bad_json', reason: 'response was not JSON', text: read.text };
  }
}
