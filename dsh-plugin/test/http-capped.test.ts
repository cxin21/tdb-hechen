import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  DEFAULT_ALLOWED_SCHEMES,
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_RESPONSE_BYTES_CEILING,
  clampMaxResponseBytes,
  fetchJsonCapped,
  readCapped,
} from '../src/http-capped.js';
import { MemoryClient, type MemoryClientDeps } from '../src/memory-client.js';
import { DEFAULT_MAX_REQUEST_BYTES } from '../src/wire-limits.js';

/**
 * The plugin runs inside the host GUI process, so these caps are a memory-safety
 * boundary, not a nicety: one unbounded body can take the user's session down.
 * The tests therefore assert the ORDER too (content-length short-circuits before
 * any read, a scheme violation never reaches fetch).
 */

function streamResponse(
  chunks: Uint8Array[],
  opts: { declared?: string; status?: number } = {},
): { response: Response; cancel: ReturnType<typeof vi.fn>; reads: () => number } {
  let index = 0;
  let reads = 0;
  const cancel = vi.fn(async () => undefined);
  const reader = {
    read: async () => {
      reads += 1;
      return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined };
    },
    cancel,
  };
  const headers = new Headers();
  if (opts.declared !== undefined) headers.set('content-length', opts.declared);
  const status = opts.status ?? 200;
  const response = { ok: status < 400, status, headers, body: { getReader: () => reader } } as unknown as Response;
  return { response, cancel, reads: () => reads };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('response byte caps', () => {
  it('clamps a configured cap into [1, 16 MiB] and falls back to the default', () => {
    expect(clampMaxResponseBytes(undefined)).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(clampMaxResponseBytes(0)).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(clampMaxResponseBytes(-5)).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(clampMaxResponseBytes(Number.NaN)).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(clampMaxResponseBytes('nope')).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(clampMaxResponseBytes(MAX_RESPONSE_BYTES_CEILING * 4)).toBe(MAX_RESPONSE_BYTES_CEILING);
    expect(clampMaxResponseBytes(0.4)).toBe(1);
    expect(DEFAULT_ALLOWED_SCHEMES).toEqual(['http:', 'https:']);
  });

  it('refuses an oversized content-length WITHOUT reading the body', async () => {
    const { response, reads } = streamResponse([bytes('x')], { declared: '999999' });
    const result = await readCapped(response, 1024);
    expect(result).toEqual({ kind: 'too_large', reason: 'declared content-length 999999 > 1024', declared: 999999, bytes: 0 });
    expect(reads()).toBe(0);
  });

  it('stops a streaming body at the cap and cancels the reader', async () => {
    const { response, cancel, reads } = streamResponse([bytes('a'.repeat(700)), bytes('b'.repeat(700))]);
    const result = await readCapped(response, 1000);
    expect(result.kind).toBe('too_large');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reads()).toBe(2);
  });

  it('lets a body that is exactly at the cap through', async () => {
    const { response, cancel } = streamResponse([bytes('a'.repeat(1000))]);
    const result = await readCapped(response, 1000);
    expect(result).toEqual({ kind: 'ok', text: 'a'.repeat(1000), bytes: 1000 });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes, not characters', async () => {
    const { response } = streamResponse([bytes('记忆')]);
    const result = await readCapped(response, 6);
    expect(result).toEqual({ kind: 'ok', text: '记忆', bytes: 6 });
  });

  it('falls back to text() when the response has no stream', async () => {
    const response = { headers: new Headers(), body: null, text: async () => '{"ok":1}' } as unknown as Response;
    await expect(readCapped(response, 100)).resolves.toEqual({ kind: 'ok', text: '{"ok":1}', bytes: 8 });
  });

  it('refuses file:, data: and javascript: schemes without calling fetch', async () => {
    const fetchImpl = vi.fn();
    for (const url of ['file:///C:/secret.txt', 'data:text/plain,hi', 'javascript:alert(1)']) {
      const result = await fetchJsonCapped(url, {}, { fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(result.kind).toBe('bad_scheme');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honours an explicit allow-list of schemes', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([bytes('{"ok":true}')]).response);
    const result = await fetchJsonCapped('file:///C:/ok.json', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowSchemes: ['file:'],
    });
    expect(result.kind).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a relative URL as bad_url', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchJsonCapped('/v3/core/read', {}, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toMatchObject({
      kind: 'bad_url',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps its own timeout to kind timeout', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const result = await fetchJsonCapped('http://core.local/v3/core/read', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    });
    expect(result.kind).toBe('timeout');
  });

  it('maps a caller abort to kind timeout as well', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pending = fetchJsonCapped('http://core.local/v3/core/read', { signal: controller.signal }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ kind: 'timeout' });
  });

  it('maps a transport failure to kind transport and never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const result = await fetchJsonCapped('http://core.local/v3/core/read', {}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ kind: 'transport', reason: 'ECONNREFUSED' });
  });

  it('returns http status plus text for a small error body', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([bytes('{"code":50001,"message":"nope"}')], { status: 500 }).response);
    const result = await fetchJsonCapped('http://core.local/v3/core/read', {}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ kind: 'http', status: 500, text: '{"code":50001,"message":"nope"}' });
  });

  it('caps a huge error body too (proxy error pages)', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([bytes('x')], { status: 502, declared: '99999999' }).response);
    const result = await fetchJsonCapped('http://core.local/v3/core/read', {}, { fetchImpl: fetchImpl as unknown as typeof fetch, maxBytes: 1024 });
    expect(result).toEqual({ kind: 'http', status: 502, text: '' });
  });

  it('reports bad_json for a non-JSON body', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([bytes('<html>maintenance</html>')]).response);
    await expect(fetchJsonCapped('http://core.local/v3/core/read', {}, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toMatchObject({
      kind: 'bad_json',
      text: '<html>maintenance</html>',
    });
  });

  it('parses a normal envelope', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([bytes('{"code":0,"data":{"content":"hi"}}')]).response);
    const result = await fetchJsonCapped<{ code: number; data: { content: string } }>('http://core.local/v3/core/read', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: 'ok', json: { code: 0, data: { content: 'hi' } }, text: '{"code":0,"data":{"content":"hi"}}', bytes: 34 });
  });
});

describe('memory client through the capped reader', () => {
  function createClient(fetchImpl: typeof fetch, log = { debug: vi.fn() }, overrides: Partial<MemoryClientDeps> = {}): MemoryClient {
    return new MemoryClient({
      baseUrl: 'http://core.local:8420/',
      apiKeyRef: 'TDB_API_KEY',
      identity: { serviceId: 'default', teamId: 'team-1', agentId: 'agt-1', userId: 'usr-1' },
      requestTimeoutMs: 1000,
      maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
      maxResponseBytes: 1024,
      paths: DEFAULT_CONFIG.paths,
      resolveApiKey: async () => 'secret-key',
      log,
      ...overrides,
      fetchImpl,
    });
  }

  it('treats an oversized response as a soft failure and logs the endpoint', async () => {
    const log = { debug: vi.fn() };
    const fetchImpl = vi.fn(async () => streamResponse([bytes('x')], { declared: '99999999' }).response);
    await expect(createClient(fetchImpl as unknown as typeof fetch, log).readCore()).resolves.toBeUndefined();
    const line = String(log.debug.mock.calls[0][0]);
    expect(line).toContain('response too_large');
    expect(line).toContain('endpoint=/v3/core/read');
    expect(line).toContain('declared=99999999');
  });

  it('keeps the 401 auth-failure path and its debug line unchanged', async () => {
    const log = { debug: vi.fn() };
    const onAuthFailure = vi.fn();
    const fetchImpl = vi.fn(async () => streamResponse([bytes('{"code":401}')], { status: 401 }).response);
    await createClient(fetchImpl as unknown as typeof fetch, log, { onAuthFailure }).readCore();
    expect(onAuthFailure).toHaveBeenCalledWith({ path: '/v3/core/read', status: 401 });
    expect(String(log.debug.mock.calls[0][0])).toContain('/v3/core/read -> HTTP 401');
  });

  it('keeps the non-JSON debug line unchanged', async () => {
    const log = { debug: vi.fn() };
    const fetchImpl = vi.fn(async () => streamResponse([bytes('<html>')]).response);
    await createClient(fetchImpl as unknown as typeof fetch, log).readCore();
    expect(String(log.debug.mock.calls[0][0])).toContain('response was not JSON');
  });
});
