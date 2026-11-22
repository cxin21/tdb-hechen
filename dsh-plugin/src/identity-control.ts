/**
 * Same-origin transport for the composer identity chip (task-117 v4).
 *
 * The chip lives in the client bundle, which cannot reach the plugin's Node
 * side; it can only fetch its own origin. So the two things the panel needs are
 * two routes here:
 *
 *   GET  /tdb-identity/state?sessionId=...&teamId=...  → ComposerState
 *   POST /tdb-identity/choose  {sessionId, teamId, agentId, taskId?, associate?}
 *                                                      → the staged choice
 *
 * Both are read-light: 'state' never binds anything (it may be called on every
 * panel open), and 'choose' only STAGES — the binding itself is written by the
 * session's first turn, which is what makes "choose before the session starts,
 * read-only afterwards" true rather than cosmetic.
 *
 * A host without a web server gets one debug line; the chip then paints its
 * "unavailable" state instead of a fake empty list.
 */
import type { AgememContext, LoggerLike, WebServerService } from './types.js';
import type { ComposerState, IdentityChoice, SessionIdentity } from './session-identity.js';

/** Route prefix for the chip's transport. */
export const IDENTITY_ROUTE_PREFIX = '/tdb-identity';

/** What the routes answer with: the page never sees a bare string. */
interface IdentityEnvelope {
  ok: boolean;
  data?: ComposerState | IdentityChoice;
  error?: string;
}

function sendJson(res: unknown, status: number, body: string): void {
  const writable = res as { writeHead?: (code: number, heads: Record<string, string>) => void; end?: (b?: string) => void };
  writable.writeHead?.(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  writable.end?.(body);
}

function readBody(req: unknown): Promise<string> {
  const emitter = req as NodeJS.EventEmitter | null;
  if (emitter === null || typeof emitter.on !== 'function') return Promise.resolve('');
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
      // A panel payload is tiny; anything larger is not one of ours.
      if (raw.length > 8192) finish('');
    });
    emitter.on('end', () => finish(raw));
    emitter.on('error', () => finish(''));
  });
}

/** The query string as plain fields (no URL class: the host may pass a path). */
function queryOf(req: unknown): Record<string, string> {
  const raw = String((req as { url?: unknown } | null)?.url ?? '');
  const at = raw.indexOf('?');
  const out: Record<string, string> = {};
  if (at < 0) return out;
  for (const pair of raw.slice(at + 1).split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Register the chip's two routes on the host web server.
 *
 * `identity` is the live SessionIdentity from installSessionIdentity: the chip is
 * a view over the SAME store the pre-step writes, so a session bound by a preset
 * shows as bound in the panel without a second source of truth.
 */
export function registerIdentityControl(ctx: AgememContext, identity: SessionIdentity, log?: LoggerLike): void {
  const stateRoute = {
    kind: 'exact',
    path: IDENTITY_ROUTE_PREFIX + '/state',
    handler: async (req: unknown, res: unknown): Promise<void> => {
      const query = queryOf(req);
      const sessionId = (query.sessionId ?? '').trim();
      const teamId = (query.teamId ?? '').trim();
      if (sessionId === '') {
        sendJson(res, 400, JSON.stringify({ ok: false, error: 'sessionId-required' } satisfies IdentityEnvelope));
        return;
      }
      try {
        const state = await identity.describe(sessionId, teamId === '' ? undefined : teamId);
        sendJson(res, 200, JSON.stringify({ ok: true, data: state } satisfies IdentityEnvelope));
      } catch (error) {
        log?.warn?.('agemem: identity state failed (' + String((error as Error)?.message ?? error) + ')');
        sendJson(res, 500, JSON.stringify({ ok: false, error: 'state-failed' } satisfies IdentityEnvelope));
      }
    },
  };
  const chooseRoute = {
    kind: 'exact',
    path: IDENTITY_ROUTE_PREFIX + '/choose',
    handler: async (req: unknown, res: unknown): Promise<void> => {
      const raw = await readBody(req);
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        sendJson(res, 400, JSON.stringify({ ok: false, error: 'invalid-json' } satisfies IdentityEnvelope));
        return;
      }
      const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
      const sessionId = text(body.sessionId);
      if (sessionId === '') {
        sendJson(res, 400, JSON.stringify({ ok: false, error: 'sessionId-required' } satisfies IdentityEnvelope));
        return;
      }
      // associate=false is the panel's 「本次不关联」: it carries no triple, and
      // saying so explicitly is what lets the persona card be cleared later.
      const associate = body.associate === false ? false : undefined;
      const choice: IdentityChoice = {
        teamId: text(body.teamId),
        agentId: text(body.agentId),
        ...(text(body.taskId) === '' ? {} : { taskId: text(body.taskId) }),
        ...(associate === undefined ? {} : { associate }),
      };
      // associate=false carries no triple by design; only a real pick needs one.
      if (associate !== false && (choice.teamId === '' || choice.agentId === '')) {
        sendJson(res, 400, JSON.stringify({ ok: false, error: 'teamId-and-agentId-required' } satisfies IdentityEnvelope));
        return;
      }
      try {
        // A committed session refuses the write: say so with 409 instead of a
        // 200 that changed nothing, or the chip would report 「待生效」for a click
        // the server dropped on the floor.
        if (!identity.choose(sessionId, choice)) {
          sendJson(res, 409, JSON.stringify({ ok: false, error: 'already-committed' } satisfies IdentityEnvelope));
          return;
        }
        sendJson(res, 200, JSON.stringify({ ok: true, data: choice } satisfies IdentityEnvelope));
      } catch (error) {
        log?.warn?.('agemem: identity choose failed (' + String((error as Error)?.message ?? error) + ')');
        sendJson(res, 500, JSON.stringify({ ok: false, error: 'choose-failed' } satisfies IdentityEnvelope));
      }
    },
  };
  const routes = [stateRoute, chooseRoute];
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub) => {
        const server: WebServerService | undefined = sub.webServer;
        if (server === undefined || typeof server.register !== 'function') {
          log?.debug?.('agemem: host exposes no webServer; the identity chip cannot load its candidates');
          return;
        }
        for (const item of routes) {
          if (typeof sub.effect === 'function') {
            sub.effect(() => server.register(item), 'agemem: ' + item.path);
          } else {
            server.register(item);
          }
        }
        log?.debug?.('agemem: identity chip transport registered (' + IDENTITY_ROUTE_PREFIX + '/*)');
      });
      return;
    }
    log?.debug?.('agemem: host has no ctx.inject; the identity chip cannot load its candidates');
  } catch (error) {
    log?.warn?.('agemem: identity transport registration failed (' + String((error as Error)?.message ?? error) + ')');
  }
}
