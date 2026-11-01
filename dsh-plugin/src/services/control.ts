/**
 * Control plane for the in-plugin service supervisor (Wave 4).
 *
 * Two transports, one dispatch table — the same split the retired bundle had, and
 * kept on purpose for the same reason:
 *   1. same-origin routes on the DSH web server (`/tdb-lifecycle/*`) — the
 *      settings page fetches its own origin, so no CORS, no CSP connect-src hole;
 *   2. a loopback-only HTTP server on 127.0.0.1:<controlPort> — the fallback for
 *      a host build whose web server does not expose route registration.
 *
 * Security model (unchanged, and stated here because it is the whole reason the
 * control plane is safe to keep):
 *   - bound to 127.0.0.1 only; a request with a non-loopback Origin is refused;
 *   - every mutating call needs the non-simple header `X-Tdb-Control: 1`, so a
 *     cross-origin drive-by form POST cannot pass the CORS preflight.
 *
 * The paths stay `/tdb-lifecycle/*` even though the bundle is gone: the ported
 * settings page and any bookmark keep working, and a user with both installed
 * during the transition hits the same API.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { RestartResult, SupervisorLog, SupervisorStatus } from './supervisor.js';

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const MAX_BODY_BYTES = 4096;
const CONTROL_HEADER = 'x-tdb-control';

export interface ControlDeps {
  status: () => Promise<SupervisorStatus>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: (name: string) => Promise<RestartResult>;
  log?: SupervisorLog;
}

export interface ControlServer {
  port: number;
  close: () => Promise<void>;
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer | string) => {
      raw += chunk.toString();
      if (raw.length > MAX_BODY_BYTES) req.destroy();
    });
    req.on('end', () => {
      if (raw.trim() === '') return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * Pure dispatch: no sockets, so the tests drive it with fake req/res objects.
 * `urlOverride` lets the same-origin route adapter pass the sub-path it matched
 * (the host hands the full URL back, which used to be double-prefixed).
 */
export function createControlDispatcher(
  deps: ControlDeps,
): (req: IncomingMessage, res: ServerResponse, urlOverride?: string) => Promise<void> {
  return async (req, res, urlOverride) => {
    const path = (urlOverride ?? req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && path === '/status') {
        sendJson(res, 200, await deps.status());
        return;
      }
      if (req.method === 'POST') {
        if (req.headers[CONTROL_HEADER] !== '1') {
          sendJson(res, 403, { error: 'missing-control-header' });
          return;
        }
        if (path === '/start') {
          await deps.start();
          sendJson(res, 202, { ok: true, started: true });
          return;
        }
        if (path === '/stop') {
          await deps.stop();
          sendJson(res, 202, { ok: true, stopped: true });
          return;
        }
        if (path === '/restart') {
          const body = await readBody(req);
          const name = body !== null && typeof body.name === 'string' ? body.name : '';
          if (name === '') {
            sendJson(res, 400, { ok: false, error: 'body-must-be-json-with-name' });
            return;
          }
          const result = await deps.restart(name);
          sendJson(res, result.ok ? 202 : 409, result);
          return;
        }
      }
      sendJson(res, 404, { error: 'not-found' });
    } catch (error) {
      deps.log?.warn?.('services: control endpoint error (' + String((error as Error)?.message ?? error) + ')');
      sendJson(res, 500, { error: 'internal' });
    }
  };
}

/**
 * Start the loopback server. Returns `null` when the port is disabled or the
 * bind fails — a second DSH window or a leftover process owning 8444 must not
 * take the plugin down; the same-origin routes still serve the page.
 */
export async function startControlServer(input: {
  port: number;
  deps: ControlDeps;
  log?: SupervisorLog;
}): Promise<ControlServer | null> {
  const port = input.port;
  if (!Number.isInteger(port) || port <= 0) return null;
  const dispatch = createControlDispatcher(input.deps);
  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== '' && !LOOPBACK_ORIGIN.test(origin)) {
      sendJson(res, 403, { error: 'origin-not-allowed' });
      return;
    }
    if (origin !== undefined && origin !== '') res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Tdb-Control',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    void dispatch(req, res);
  });
  const started = await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    server.once('error', (error: Error) => {
      input.log?.warn?.('services: control server on 127.0.0.1:' + port + ' failed (' + error.message + ')');
      done(false);
    });
    server.listen(port, '127.0.0.1', () => {
      input.log?.info?.('services: control server listening on http://127.0.0.1:' + port);
      done(true);
    });
  });
  if (!started) {
    try {
      server.close();
    } catch {
      // Never listened.
    }
    return null;
  }
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            server.closeAllConnections();
          } catch {
            // Older Node: nothing to force-close.
          }
          resolve();
        }, 2000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}