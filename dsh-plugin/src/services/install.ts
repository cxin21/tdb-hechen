/**
 * Wiring for the in-plugin service supervisor (Wave 4).
 *
 * `install.ts` exists so `src/index.ts` grows by one call instead of fifty lines:
 * every capability in this plugin is installed by its own module, and the entry
 * point only decides the order. This one owns four things:
 *
 *   1. build the supervisor from config (table, env file, logs, state file);
 *   2. start it (fail-open: a broken stack must never take the memory plugin
 *      down — the plugin is useful against an already-running core);
 *   3. expose the control plane on BOTH transports (same-origin routes on the
 *      host web server, loopback fallback);
 *   4. tear it down on dispose — kill when `stopOnDispose`, detach otherwise.
 */
import { join } from 'node:path';
import type { AgememContext, LoggerLike } from '../types.js';
import type { ServicesConfig } from '../config.js';
import { startControlServer, createControlDispatcher, type ControlServer } from './control.js';
import { defaultServiceTable, type ServiceSpec } from './service-table.js';
import { createServiceSupervisor, type ServiceSupervisor, type SupervisorLog } from './supervisor.js';

/** Route prefix. Deliberately the retired bundle's: bookmarks and the ported page keep working. */
export const CONTROL_ROUTE_PREFIX = '/tdb-lifecycle';

export interface InstalledServices {
  supervisor: ServiceSupervisor;
  /** Resolved specs, for the ready-line and tests. */
  specs: ServiceSpec[];
  /** Resolves once the control plane finished binding (never rejects). */
  control: Promise<ControlServer | null>;
  /** True when this install owns the whole stack lifecycle. */
  enabled: boolean;
}

export interface InstallServicesInput {
  config: ServicesConfig;
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
 */
function registerWebRoutes(
  ctx: AgememContext,
  dispatch: ReturnType<typeof createControlDispatcher>,
  log: LoggerLike | undefined,
): void {
  const subPaths = ['/status', '/start', '/stop', '/restart'];
  const inject = ctx.inject;
  if (typeof inject !== 'function') {
    log?.debug?.('services: the host has no ctx.inject; the settings page uses the loopback control server');
    return;
  }
  try {
    inject.call(ctx, ['webServer'], (sub) => {
      const server = sub?.webServer;
      if (server === undefined || typeof server.register !== 'function') {
        log?.debug?.('services: no webServer service in this host; loopback control only');
        return;
      }
      for (const subPath of subPaths) {
        const route = {
          kind: 'exact',
          path: CONTROL_ROUTE_PREFIX + subPath,
          handler: (req: unknown, res: unknown) => {
            void dispatch(req as never, res as never, subPath);
          },
        };
        // Prefer an effect so the routes are removed with the fiber; a host
        // without `effect` still registers, it just cannot unregister.
        if (typeof sub.effect === 'function') {
          sub.effect(() => server.register(route), 'agemem: ' + route.path + ' route');
        } else {
          server.register(route);
        }
      }
      log?.info?.('services: control routes registered on the host web server (' + CONTROL_ROUTE_PREFIX + '/*)');
    });
  } catch (error) {
    log?.warn?.('services: web-server route registration failed (' + String((error as Error)?.message ?? error) + ')');
  }
}

export function installServices(input: InstallServicesInput): InstalledServices | undefined {
  const { config, ctx, disposers } = input;
  const log = input.log;
  if (!config.enabled) {
    log?.debug?.('services: disabled by config; this plugin spawns nothing');
    return undefined;
  }
  const specs = defaultServiceTable({ repoRoot: config.repoRoot });
  const statePath =
    config.statePath !== '' ? config.statePath : join(config.runDir, 'tdb-services.state.json');
  const nodePath = config.nodePath !== '' ? config.nodePath : (input.execPath ?? process.execPath);
  const supervisor = (input.createSupervisor ?? createServiceSupervisor)({
    specs,
    nodePath,
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

  const dispatch = createControlDispatcher({
    status: () => supervisor.status(),
    start: () => supervisor.start(),
    stop: () => supervisor.stop('control endpoint'),
    restart: (name) => supervisor.restartOne(name),
    log: asSupervisorLog(log),
  });

  // Fail-open: the stack failing to come up must not abort the plugin mount.
  void supervisor.start().catch((error: unknown) => {
    log?.warn?.('services: stack failed to start (' + String((error as Error)?.message ?? error) + ')');
  });

  const control = (input.startControl ?? startControlServer)({
    port: config.controlPort,
    deps: {
      status: () => supervisor.status(),
      start: () => supervisor.start(),
      stop: () => supervisor.stop('control endpoint'),
      restart: (name) => supervisor.restartOne(name),
      log: asSupervisorLog(log),
    },
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
    + ')',
  );

  return { supervisor, specs, control, enabled: true };
}