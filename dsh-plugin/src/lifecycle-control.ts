/**
 * Thin proxy in front of the `dsh-tdb-lifecycle` control plane (2026-11-07 task-26):
 * the plugin no longer starts, watches or restarts TDB services, so what is left is a
 * transport that lets the settings page talk to its own origin (no CORS / CSP hole).
 *
 *   GET  /tdb-lifecycle/status | /events?limit=N   → the control plane's JSON
 *   POST /tdb-lifecycle/{start,stop,restart}       → ditto, with its control header
 *
 * Nothing is cached or defaulted; an unreachable control plane is 503
 * `{ok:false,error:'control-plane-unreachable'}` — never a fake empty table. The port
 * comes from `TDB_LIFECYCLE_CONTROL_PORT` (default 8446), read per request, no config key.
 */
import type { AgememContext, LoggerLike, WebServerService } from './types.js';

/** Route prefix: unchanged, so an old bookmark and the page agree. */
export const LIFECYCLE_ROUTE_PREFIX = '/tdb-lifecycle';
/** Where `dsh-tdb-lifecycle` binds its loopback control plane by default. */
export const LIFECYCLE_CONTROL_PORT = 8446;
/** Whole-call budget; the control plane answers from memory, so 3s is generous. */
const CONTROL_TIMEOUT_MS = 3000;
/** Non-simple header the control plane requires on every mutating call. */
const CONTROL_HEADER = 'X-Tdb-Control';

export type LifecycleSubPath = '/status' | '/events' | '/start' | '/stop' | '/restart';

export interface LifecycleProxyResult {
  status: number;
  body: string;
}

/** The control plane's origin. Read per request: env is the only knob (no config key). */
export function lifecycleBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.TDB_LIFECYCLE_CONTROL_PORT;
  const port = raw === undefined ? LIFECYCLE_CONTROL_PORT : Number(raw);
  const safe = Number.isInteger(port) && port > 0 && port < 65536 ? port : LIFECYCLE_CONTROL_PORT;
  return 'http://127.0.0.1:' + String(safe);
}

/** Read a JSON body from the host request; anything odd becomes "{}". */
function readBody(req: unknown): Promise<string> {
  const emitter = req as NodeJS.EventEmitter | null;
  if (emitter === null || typeof emitter.on !== 'function') return Promise.resolve('{}');
  return new Promise<string>((resolve) => {
    let raw = '';
    let done = false;
    const finish = (value: string): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    emitter.on('data', (chunk: Buffer | string) => {
      raw += chunk.toString();
      if (raw.length > 4096) finish('{}');
    });
    emitter.on('end', () => finish(raw.trim() === '' ? '{}' : raw));
    emitter.on('error', () => finish('{}'));
  });
}

/**
 * One call to the control plane. Never throws: a dead bundle is a 503 with a
 * machine-readable error, which the page renders as one hint line.
 */
export async function forwardLifecycle(
  subPath: LifecycleSubPath,
  init: { method: 'GET' | 'POST'; body?: string; query?: string },
  env?: Record<string, string | undefined>,
): Promise<LifecycleProxyResult> {
  const headers: Record<string, string> = {};
  if (init.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    // The control plane refuses a mutating call without it (anti-drive-by).
    headers[CONTROL_HEADER] = '1';
  }
  try {
    const response = await fetch(lifecycleBaseUrl(env) + subPath + (init.query ?? ''), {
      method: init.method,
      headers,
      body: init.method === 'POST' ? (init.body ?? '{}') : undefined,
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.text() };
  } catch {
    return { status: 503, body: JSON.stringify({ ok: false, error: 'control-plane-unreachable' }) };
  }
}

function sendJson(res: unknown, status: number, body: string): void {
  const writable = res as { writeHead?: (code: number, heads: Record<string, string>) => void; end?: (b?: string) => void };
  writable.writeHead?.(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  writable.end?.(body);
}

function queryOf(req: unknown): string {
  const raw = String((req as { url?: unknown } | null)?.url ?? '');
  const at = raw.indexOf('?');
  return at < 0 ? '' : raw.slice(at);
}

/**
 * Register the five routes on the host web server. A host build without a web
 * server gets one debug line, and the page then reports the control plane as
 * unreachable — the same shape as a stopped `dsh-tdb-lifecycle`.
 */
export function registerLifecycleControl(ctx: AgememContext, log?: LoggerLike): void {
  const route = (subPath: LifecycleSubPath, method: 'GET' | 'POST') => ({
    kind: 'exact',
    path: LIFECYCLE_ROUTE_PREFIX + subPath,
    handler: async (req: unknown, res: unknown): Promise<void> => {
      const result = method === 'GET'
        ? await forwardLifecycle(subPath, { method, query: subPath === '/events' ? queryOf(req) : '' })
        : await forwardLifecycle(subPath, { method, body: await readBody(req) });
      sendJson(res, result.status, result.body);
    },
  });
  const routes = [
    route('/status', 'GET'),
    route('/events', 'GET'),
    route('/start', 'POST'),
    route('/stop', 'POST'),
    route('/restart', 'POST'),
  ];
  const register = (server: WebServerService, sub: { effect?: (f: () => unknown, l?: string) => unknown } | null): void => {
    for (const item of routes) {
      if (sub !== null && typeof sub.effect === 'function') {
        sub.effect(() => server.register(item), 'agemem: ' + item.path + ' proxy');
      } else {
        server.register(item);
      }
    }
    log?.debug?.('agemem: lifecycle proxy registered (' + LIFECYCLE_ROUTE_PREFIX + '/*)');
  };
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub) => {
        const server = sub.webServer;
        if (server === undefined || typeof server.register !== 'function') {
          log?.debug?.('agemem: host exposes no webServer; the TDB services page cannot reach the control plane');
          return;
        }
        register(server, sub);
      });
      return;
    }
    log?.debug?.('agemem: host has no ctx.inject; the TDB services page cannot reach the control plane');
  } catch (error) {
    log?.warn?.('agemem: lifecycle proxy registration failed (' + String((error as Error)?.message ?? error) + ')');
  }
}