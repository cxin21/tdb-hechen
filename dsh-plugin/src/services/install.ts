/**
 * Wiring for the in-plugin service supervisor (Wave 4).
 *
 * `install.ts` exists so `src/index.ts` grows by one call instead of fifty lines:
 * every capability in this plugin is installed by its own module, and the entry
 * point only decides the order.
 *
 * **First question is not "which services" but "does this host manage a stack at
 * all"** (services/scope.ts): the plugin supports talking to a core on another
 * machine, and in that shape a local stack would receive no traffic while still
 * holding three ports. So when the scope says "not managed" this module installs
 * only the read-only answer — the settings page gets `{managed:false, reason}` —
 * and spawns nothing, opens no loopback port, reads no env file.
 *
 * When it IS managed, four things happen:
 *   1. build the supervisor from config (table, env file, logs, state file);
 *   2. start it (fail-open: a broken stack must never take the memory plugin
 *      down — the plugin is useful against an already-running core);
 *   3. expose the control plane on BOTH transports (same-origin routes on the
 *      host web server, loopback fallback);
 *   4. tear it down on dispose — kill when `stopOnDispose`, detach otherwise.
 */
import { join } from 'node:path';
import type { AgememContext, LoggerLike, WebServerService } from '../types.js';
import type { ServicesConfig } from '../config.js';
import { startControlServer, createControlDispatcher, type ControlDeps, type ControlServer } from './control.js';
import { resolveNodePath } from './node-path.js';
import { defaultServiceTable, type ServiceSpec } from './service-table.js';
import { resolveStackScope, type StackScope, type StackScopeReason } from './scope.js';
import {
  createServiceSupervisor,
  type RestartResult,
  type ServiceSupervisor,
  type SupervisorLog,
  type SupervisorStatus,
} from './supervisor.js';

/** Route prefix. Deliberately the retired bundle's: bookmarks and the ported page keep working. */
export const CONTROL_ROUTE_PREFIX = '/tdb-lifecycle';

export interface InstalledServices {
  /** True when this host spawns and supervises the stack. */
  managed: boolean;
  /** Why not, when `managed` is false. */
  reason: StackScopeReason;
  /** One line for the ready log / settings page. */
  detail: string;
  /** Present only when managed. */
  supervisor?: ServiceSupervisor;
  /** Resolved specs (empty when unmanaged), for the ready line and tests. */
  specs: ServiceSpec[];
  /** Resolves once the control plane finished binding (managed only). */
  control?: Promise<ControlServer | null>;
  /** Kept for callers that predate `managed`; equals `managed`. */
  enabled: boolean;
}

export interface InstallServicesInput {
  config: ServicesConfig;
  /**
   * The core address the plugin will actually call (`server.baseUrl`). Decides
   * whether a local stack makes sense: loopback ⇒ yes, anything else ⇒ no.
   */
  coreBaseUrl: string;
  ctx: AgememContext;
  log?: LoggerLike;
  disposers: Array<() => void>;
  // --- seams (tests) ---
  createSupervisor?: typeof createServiceSupervisor;
  startControl?: typeof startControlServer;
  execPath?: string;
}

function asSupervisorLog(log: LoggerLike | undefined): SupervisorLog {
  return {
    info: (message: string) => log?.info?.(message),
    warn: (message: string) => log?.warn?.(message),
    debug: (message: string) => log?.debug?.(message),
  };
}

/**
 * Same-origin routes for the settings page. Mirrors what the bundle registered:
 * `/tdb-lifecycle/{status,start,stop,restart}` on the host web server, so the page
 * fetches its own origin (no CORS, no CSP connect-src exception).
 *
 * Registered even when unmanaged: "there is no stack here, and why" is an answer
 * the page needs, and a 404 would read as "the plugin is broken".
 */
function registerWebRoutes(
  ctx: AgememContext,
  dispatch: ReturnType<typeof createControlDispatcher>,
  log: LoggerLike | undefined,
): void {
  const routes = ['/status', '/start', '/stop', '/restart'].map((subPath) => ({
    kind: 'exact',
    path: CONTROL_ROUTE_PREFIX + subPath,
    handler: (req: unknown, res: unknown) => {
      void dispatch(req as never, res as never, subPath);
    },
  }));
  const register = (server: WebServerService, sub: { effect?: (f: () => unknown, l?: string) => unknown } | null) => {
    for (const route of routes) {
      if (sub !== null && typeof sub.effect === 'function') {
        sub.effect(() => server.register(route), 'agemem: ' + route.path + ' route');
      } else {
        server.register(route);
      }
    }
    log?.info?.('services: control routes registered on the host web server (' + CONTROL_ROUTE_PREFIX + '/*)');
  };
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub) => {
        const server = sub.webServer;
        if (server === undefined || typeof server.register !== 'function') {
          log?.debug?.('services: host exposes no webServer; the settings page uses the loopback control server');
          return;
        }
        register(server, sub);
      });
    } else {
      log?.debug?.('services: the host has no ctx.inject; the settings page uses the loopback control server');
    }
  } catch (error) {
    log?.warn?.('services: web-server route registration failed (' + String((error as Error)?.message ?? error) + ')');
  }
}

/** The answer an unmanaged host gives: read-only, no processes, no ports. */
function passiveDeps(scope: StackScope, log: LoggerLike | undefined): ControlDeps {
  const status = async (): Promise<SupervisorStatus> => ({
    hostPid: process.pid,
    enabled: false,
    running: false,
    startedAt: null,
    autoRestart: false,
    restartsUsed: 0,
    maxRestarts: 0,
    services: [],
    updatedAt: new Date().toISOString(),
    managed: false,
    reason: scope.reason,
    coreHost: scope.coreHost,
  });
  const refuse = async (): Promise<void> => {
    throw new Error('stack-unmanaged: ' + scope.detail);
  };
  const refuseRestart = async (name: string): Promise<RestartResult> => ({
    ok: false,
    error: 'stack-unmanaged (' + name + '): ' + scope.detail,
  });
  log?.debug?.('services: control plane is read-only on this host (' + scope.detail + ')');
  return { status, start: refuse, stop: async () => undefined, restart: refuseRestart, log: asSupervisorLog(log) };
}

export function installServices(input: InstallServicesInput): InstalledServices {
  const { config, ctx, disposers } = input;
  const log = input.log;
  const scope = resolveStackScope({
    enabled: config.enabled,
    coreBaseUrl: input.coreBaseUrl,
    include: config.include.split(','),
  });

  if (!scope.managed) {
    // A remote core is the interesting case: it means "someone else owns the
    // stack", which is a normal deployment, not a mistake. Say it once, loudly
    // enough to be found in the log, and stay out of the way.
    if (scope.reason === 'remote-core') log?.warn?.('services: ' + scope.detail);
    else if (scope.reason === 'no-services') log?.warn?.('services: ' + scope.detail);
    else log?.debug?.('services: ' + scope.detail);
    const dispatch = createControlDispatcher(passiveDeps(scope, log));
    registerWebRoutes(ctx, dispatch, log);
    return {
      managed: false,
      reason: scope.reason,
      detail: scope.detail,
      specs: [],
      enabled: false,
    };
  }

  const specs = defaultServiceTable({ repoRoot: config.repoRoot }).filter((spec) =>
    (scope.include as readonly string[]).includes(spec.name),
  );
  const statePath =
    config.statePath !== '' ? config.statePath : join(config.runDir, 'tdb-services.state.json');
  const node = resolveNodePath({ configured: config.nodePath, execPath: input.execPath });
  if (node.source === 'host') {
    // Correct but surprising: the process list will show the host's own binary.
    log?.warn?.('services: no node on PATH; launching services with the host binary + ELECTRON_RUN_AS_NODE=1 (set services.nodePath to silence this)');
  } else {
    log?.debug?.('services: node for the service stack = ' + node.path + ' (via ' + node.source + ')');
  }

  const supervisor = (input.createSupervisor ?? createServiceSupervisor)({
    specs,
    nodePath: node.path,
    electronRunAsNode: node.electronRunAsNode,
    logteeModule: config.logteeModule,
    logDir: config.logDir,
    runDir: config.runDir,
    statePath,
    envFile: config.envFile,
    autoRestart: config.autoRestart,
    maxRestarts: config.maxRestarts,
    healthTimeoutMs: config.healthTimeoutMs,
    log: asSupervisorLog(log),
  });

  const deps: ControlDeps = {
    status: () => supervisor.status(),
    start: () => supervisor.start(),
    stop: () => supervisor.stop('control endpoint'),
    restart: (name) => supervisor.restartOne(name),
    log: asSupervisorLog(log),
  };
  const dispatch = createControlDispatcher(deps);

  // Fail-open: the stack failing to come up must not abort the plugin mount.
  void supervisor.start().catch((error: unknown) => {
    log?.warn?.('services: stack failed to start (' + String((error as Error)?.message ?? error) + ')');
  });

  const control = (input.startControl ?? startControlServer)({
    port: config.controlPort,
    deps,
    log: asSupervisorLog(log),
  }).catch(() => null);

  registerWebRoutes(ctx, dispatch, log);

  disposers.push(() => {
    void control.then((server) => server?.close()).catch(() => undefined);
    if (config.stopOnDispose) {
      void supervisor.stop('host dispose').catch(() => undefined);
    } else {
      void supervisor.detach('host dispose (stopOnDispose=false)').catch(() => undefined);
    }
  });

  log?.info?.(
    'services: supervisor installed (repo='
    + config.repoRoot
    + ', state='
    + statePath
    + ', control='
    + (config.controlPort > 0 ? '127.0.0.1:' + config.controlPort : 'off')
    + ', envFile='
    + (config.envFile === '' ? 'none' : config.envFile)
    + ', stopOnDispose='
    + (config.stopOnDispose ? 'on' : 'off')
    + ', manages='
    + specs.map((spec) => spec.name).join('+')
    + ')',
  );

  return {
    managed: true,
    reason: scope.reason,
    detail: scope.detail,
    supervisor,
    specs,
    control,
    enabled: true,
  };
}