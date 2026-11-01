/**
 * In-plugin supervisor for the TDB service stack (Wave 4).
 *
 * Before this module the stack was kept alive by a separate DSH *bundle*
 * (`tdb-lifecycle`) that spawned a PowerShell watchdog, which in turn spawned
 * the services. Three processes deep, and every layer needed its own copy of
 * the service table and its own ownership bookkeeping — which is exactly how
 * `tdai-proxy` survived a "delete proxy" edit: the table on disk said three
 * services, the running watchdog still held four in memory, and it kept
 * respawning the one we had just deleted.
 *
 * Here the plugin owns the stack directly:
 *   - the host process IS the parent, so tethering needs no PID polling;
 *   - ownership is a small JSON file, written before the first spawn and after
 *     every change, so a hard host kill leaves enough evidence for the NEXT
 *     boot to reap orphans instead of leaking them;
 *   - one table (`defaultServiceTable`) feeds both the launcher and the status
 *     page;
 *   - every side effect (spawn, kill, probe, clock, sleep, fs) is injected, so
 *     the whole state machine is testable without starting a single service.
 *
 * Fail-open, like every other seam in this plugin: a supervisor that cannot
 * start services must not take the memory plugin down with it.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { probeHealth, waitHealthy } from './health.js';
import { findServiceSpec, type ServiceSpec } from './service-table.js';
import { readEnvFile } from './env-file.js';

export const SUPERVISOR_STATE_VERSION = 1;

export interface SupervisorState {
  version: number;
  /** PID of the host process that owns `owned`. */
  hostPid: number;
  startedAt: string;
  autoRestart: boolean;
  maxRestarts: number;
  restartsUsed: number;
  /** name -> PID of a process THIS supervisor spawned and still owns. */
  owned: Record<string, number>;
  /** name -> why it was given up on (health gate, restart budget). */
  failed?: Record<string, string>;
}

export interface ServiceStatus {
  name: string;
  port: number;
  healthy: boolean;
  pid: number | null;
  pidAlive: boolean;
  /** True only when this supervisor spawned the live process. */
  owned: boolean;
  dir?: string;
}

export interface SupervisorStatus {
  hostPid: number;
  enabled: boolean;
  running: boolean;
  startedAt: string | null;
  autoRestart: boolean;
  restartsUsed: number;
  maxRestarts: number;
  services: ServiceStatus[];
  updatedAt: string;
}

export interface SpawnOptionsLike {
  cwd: string;
  env: Record<string, string | undefined>;
  windowsHide: boolean;
  stdio: Array<'ignore' | number>;
  detached: boolean;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsLike,
) => ChildProcess;

export interface SupervisorOptions {
  /** Service packages (see defaultServiceTable). */
  specs: readonly ServiceSpec[];
  /** Absolute path of the node executable that runs the services. */
  nodePath: string;
  /** `--import file:///…/logtee.mjs` preload; '' disables the tee. */
  logteeModule?: string;
  /** Where per-run stdout/stderr/tee files go. */
  logDir: string;
  /** Where the ownership state file goes. */
  runDir: string;
  statePath: string;
  /** KEY=VALUE file with the service secrets; '' or a missing file is legal. */
  envFile?: string;
  /** Ambient environment (defaults to process.env). */
  ambientEnv?: Record<string, string | undefined>;
  autoRestart?: boolean;
  maxRestarts?: number;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  /** Delay between watchdog ticks. 0 disables the watchdog (tests). */
  watchIntervalMs?: number;
  log?: SupervisorLog;
  // --- seams (tests only) ---
  spawnImpl?: SpawnLike;
  probe?: (port: number) => Promise<boolean>;
  pidAlive?: (pid: number) => boolean;
  killTree?: (pid: number) => Promise<void>;
  readFileImpl?: (path: string) => Promise<string>;
  writeFileImpl?: (path: string, text: string) => Promise<void>;
  removeFileImpl?: (path: string) => Promise<void>;
  mkdirImpl?: (path: string) => Promise<void>;
  openLogImpl?: (path: string) => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SupervisorLog {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

export interface RestartResult {
  ok: boolean;
  error?: string;
  restarting?: string;
}

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_HEALTH_TIMEOUT_MS = 90_000;
const DEFAULT_HEALTH_INTERVAL_MS = 1000;
const DEFAULT_WATCH_INTERVAL_MS = 5000;

export function pidAliveDefault(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killTreeDefault(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(resolve, 5000);
      killer.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      killer.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function emptyState(hostPid: number, autoRestart: boolean, maxRestarts: number, at: string): SupervisorState {
  return {
    version: SUPERVISOR_STATE_VERSION,
    hostPid,
    startedAt: at,
    autoRestart,
    maxRestarts,
    restartsUsed: 0,
    owned: {},
  };
}

/** Guard against a hand-edited or half-written file: every field is checked. */
export function parseState(raw: string | null): SupervisorState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (value.version !== SUPERVISOR_STATE_VERSION) return null;
  if (typeof value.hostPid !== 'number') return null;
  const owned: Record<string, number> = {};
  if (typeof value.owned === 'object' && value.owned !== null) {
    for (const [name, pid] of Object.entries(value.owned as Record<string, unknown>)) {
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) owned[name] = pid;
    }
  }
  const failed: Record<string, string> = {};
  if (typeof value.failed === 'object' && value.failed !== null) {
    for (const [name, reason] of Object.entries(value.failed as Record<string, unknown>)) {
      if (typeof reason === 'string') failed[name] = reason;
    }
  }
  return {
    version: SUPERVISOR_STATE_VERSION,
    hostPid: value.hostPid,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
    autoRestart: value.autoRestart !== false,
    maxRestarts: typeof value.maxRestarts === 'number' ? value.maxRestarts : DEFAULT_MAX_RESTARTS,
    restartsUsed: typeof value.restartsUsed === 'number' ? value.restartsUsed : 0,
    owned,
    ...(Object.keys(failed).length > 0 ? { failed } : {}),
  };
}

export interface ServiceSupervisor {
  /** Start every service that is not already healthy; adopt an existing supervisor. */
  start(): Promise<void>;
  /** Kill owned services and clear the state file. */
  stop(reason?: string): Promise<void>;
  restartOne(name: string): Promise<RestartResult>;
  status(): Promise<SupervisorStatus>;
  /** Kill services a previous (dead) host left behind. */
  reapOrphans(): Promise<string[]>;
  /**
   * Give up ownership WITHOUT killing: stop the watchdog, keep the state file
   * (rewritten with hostPid 0) so the next boot treats those processes as
   * foreign-but-healthy instead of reaping them. Used when
   * `services.stopOnDispose` is off — "let the stack outlive DSH" has to be an
   * explicit, recorded decision, not the side effect of a missing kill.
   */
  detach(reason?: string): Promise<void>;
  /** Resolve once no restart/respawn task is in flight (tests and clean shutdown). */
  whenIdle(): Promise<void>;
  dispose(): Promise<void>;
}

export function createServiceSupervisor(options: SupervisorOptions): ServiceSupervisor {
  const specs = options.specs;
  const autoRestart = options.autoRestart !== false;
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const log = options.log ?? {};
  const spawnImpl: SpawnLike = options.spawnImpl ?? (nodeSpawn as unknown as SpawnLike);
  const probe = options.probe ?? ((port: number) => probeHealth(port));
  const pidAlive = options.pidAlive ?? pidAliveDefault;
  const killTree = options.killTree ?? killTreeDefault;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readFileImpl = options.readFileImpl ?? ((path: string) => readFile(path, 'utf8'));
  const writeFileImpl =
    options.writeFileImpl ?? ((path: string, text: string) => writeFile(path, text, 'utf8'));
  const removeFileImpl = options.removeFileImpl ?? ((path: string) => rm(path, { force: true }));
  const mkdirImpl = options.mkdirImpl ?? ((path: string) => mkdir(path, { recursive: true }).then(() => undefined));
  const openLogImpl =
    options.openLogImpl ??
    (async (path: string) => {
      const handle = await open(path, 'a');
      return handle.fd;
    });

  // Pids we killed on purpose: their exit must not look like a crash.
  const suppressed = new Set<number>();
  const children = new Map<string, ChildProcess>();
  let state: SupervisorState | null = null;
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let disposed = false;
  let stopping = false;
  const pendingRestarts = new Set<string>();
  // Restart/respawn tasks in flight:  awaits them, so a test (or a
  // clean shutdown) never races a half-finished restart.
  const inFlight = new Set<Promise<unknown>>();
  function track<T>(task: Promise<T>): Promise<T> {
    inFlight.add(task);
    const done = (): void => {
      inFlight.delete(task);
    };
    task.then(done, done);
    return task;
  }

  const nowIso = (): string => new Date(now()).toISOString();

  async function readState(): Promise<SupervisorState | null> {
    try {
      return parseState(await readFileImpl(options.statePath));
    } catch {
      return null;
    }
  }

  async function persist(next: SupervisorState | null): Promise<void> {
    state = next;
    if (next === null) {
      await removeFileImpl(options.statePath).catch(() => undefined);
      return;
    }
    await mkdirImpl(options.runDir).catch(() => undefined);
    await writeFileImpl(options.statePath, JSON.stringify(next, null, 2)).catch((error: unknown) => {
      log.warn?.('services: cannot write the state file (' + String((error as Error)?.message ?? error) + ')');
    });
  }

  /**
   * Build the child environment. The file is read on EVERY spawn, not cached at
   * mount: an operator rotating a key expects the next restart to pick it up,
   * the same way the PowerShell path did (it dot-sourced env.ps1 per start).
   */
  async function childEnv(): Promise<Record<string, string | undefined>> {
    const ambient = options.ambientEnv ?? process.env;
    const env: Record<string, string | undefined> = { ...ambient };
    const envFile = options.envFile?.trim() ?? '';
    if (envFile === '') return env;
    let parsed: Awaited<ReturnType<typeof readEnvFile>>;
    try {
      parsed = await readEnvFile(envFile, ambient, readFileImpl as never);
    } catch (error) {
      log.warn?.('services: cannot read ' + envFile + ' (' + String((error as Error)?.message ?? error) + '); using the ambient environment');
      return env;
    }
    if (parsed === null) {
      // Not an error: an install that keeps its secrets in the host environment
      // is legal. One line, name only — never a value.
      log.debug?.('services: no env file at ' + envFile + '; using the ambient environment');
      return env;
    }
    for (const warning of parsed.warnings) log.warn?.('services env: ' + warning);
    for (const [name, value] of Object.entries(parsed.values)) env[name] = value;
    log.debug?.('services: ' + Object.keys(parsed.values).length + ' variable(s) loaded from ' + envFile);
    return env;
  }

  function timestamp(): string {
    const date = new Date(now());
    const pad = (value: number): string => String(value).padStart(2, '0');
    return (
      date.getFullYear()
      + pad(date.getMonth() + 1)
      + pad(date.getDate())
      + '-'
      + pad(date.getHours())
      + pad(date.getMinutes())
      + pad(date.getSeconds())
    );
  }

  async function spawnService(spec: ServiceSpec, reason: string): Promise<number> {
    const env = await childEnv();
    const stamp = timestamp();
    const outPath = join(options.logDir, spec.name + '-' + stamp + '.out.log');
    const errPath = join(options.logDir, spec.name + '-' + stamp + '.err.log');
    const teePath = outPath + '.tee.log';
    await mkdirImpl(options.logDir).catch(() => undefined);
    // tee first: its own file, because the cmd/redirect generation taught us a
    // shared handle makes writes fail with EBUSY.
    env.TDAI_LOG_FILE = teePath;
    const args: string[] = [];
    const logtee = options.logteeModule?.trim() ?? '';
    if (logtee !== '') args.push('--import', logtee);
    args.push(...spec.args);
    let outFd: number | 'ignore' = 'ignore';
    let errFd: number | 'ignore' = 'ignore';
    try {
      outFd = await openLogImpl(outPath);
      errFd = await openLogImpl(errPath);
    } catch (error) {
      log.warn?.('services: cannot open logs for ' + spec.name + ' (' + String((error as Error)?.message ?? error) + '); stdout/stderr will be dropped');
      outFd = 'ignore';
      errFd = 'ignore';
    }
    const child = spawnImpl(options.nodePath, args, {
      cwd: spec.dir,
      env,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      // Not detached: the child dies with us on a clean stop, and a hard kill
      // leaves the state file as the evidence the next boot reaps.
      detached: false,
    });
    const pid = child.pid ?? 0;
    children.set(spec.name, child);
    child.on('exit', (code: number | null, signal: string | null) => {
      children.delete(spec.name);
      if (disposed || stopping) return;
      // A pid we killed on purpose (failed health gate, operator restart) is not
      // a crash: the caller has already decided what happens next.
      if (suppressed.delete(pid)) return;
      const label = String(code) + '/' + String(signal);
      log.warn?.('services: ' + spec.name + ' exited (' + label + ') — the watchdog owns the restart');
      void track(onChildExit(spec, label));
    });
    child.on('error', (error: Error) => {
      children.delete(spec.name);
      if (disposed || stopping) return;
      log.warn?.('services: ' + spec.name + ' spawn error (' + error.message + ')');
    });
    log.info?.('services: started ' + spec.name + ' pid=' + pid + ' (' + reason + ', cwd=' + spec.dir + ')');
    return pid;
  }

  async function onChildExit(spec: ServiceSpec, label: string): Promise<void> {
    if (!autoRestart) {
      await dropOwned(spec.name, 'exited (' + label + '), auto-restart is off');
      return;
    }
    const current = state;
    if (current === null) return;
    if (current.restartsUsed >= maxRestarts) {
      await dropOwned(spec.name, 'exited (' + label + ') and the restart budget (' + maxRestarts + ') is spent');
      log.warn?.('services: ' + spec.name + ' is down for good this session (restart budget spent)');
      return;
    }
    pendingRestarts.add(spec.name);
    log.info?.('services: restarting ' + spec.name + ' (budget ' + (current.restartsUsed + 1) + '/' + maxRestarts + ')');
    const next: SupervisorState = {
      ...current,
      restartsUsed: current.restartsUsed + 1,
      owned: { ...current.owned },
    };
    delete next.owned[spec.name];
    await persist(next);
    try {
      const pid = await spawnService(spec, 'restart after ' + label);
      const health = await waitHealthy(spec.port, {
        budgetMs: healthTimeoutMs,
        intervalMs: healthIntervalMs,
        probe: () => probe(spec.port),
        now,
        sleep,
      });
      if (!health.ok) {
        suppressed.add(pid);
        await killTree(pid).catch(() => undefined);
        await dropOwned(spec.name, 'health gate failed after restart (' + health.elapsedMs + 'ms)');
        return;
      }
      const owned = state ?? current;
      await persist({ ...owned, owned: { ...owned.owned, [spec.name]: pid } });
    } catch (error) {
      await dropOwned(spec.name, 'respawn failed: ' + String((error as Error)?.message ?? error));
    } finally {
      pendingRestarts.delete(spec.name);
    }
  }

  async function dropOwned(name: string, reason: string): Promise<void> {
    const current = state;
    if (current === null) return;
    const owned = { ...current.owned };
    delete owned[name];
    await persist({ ...current, owned, failed: { ...(current.failed ?? {}), [name]: reason } });
  }

  async function stopOwnedServices(reason: string): Promise<void> {
    const current = state;
    if (current === null) return;
    for (const [name, pid] of Object.entries(current.owned)) {
      if (!pidAlive(pid)) continue;
      log.info?.('services: stopping ' + name + ' (pid ' + pid + ', ' + reason + ')');
      await killTree(pid).catch(() => undefined);
    }
    for (const [name, child] of children) {
      if (child.pid !== undefined) await killTree(child.pid).catch(() => undefined);
      children.delete(name);
    }
  }

  function startWatchdog(): void {
    if (watchTimer !== undefined || watchIntervalMs <= 0) return;
    watchTimer = setInterval(() => {
      void tick();
    }, watchIntervalMs);
    // The host must be free to exit even with the watchdog armed.
    (watchTimer as unknown as { unref?: () => void }).unref?.();
  }

  async function tick(): Promise<void> {
    if (disposed || stopping) return;
    const current = state;
    if (current === null) return;
    if (current.hostPid !== process.pid) {
      // Someone else's stack: leave it alone. This is the defence that keeps two
      // DSH windows from fighting over the same ports.
      log.debug?.('services: state file belongs to host ' + current.hostPid + '; not touching it');
      return;
    }
    for (const name of Object.keys(current.owned)) {
      if (pendingRestarts.has(name)) continue;
      const pid = current.owned[name]!;
      if (pidAlive(pid)) continue;
      const spec = findServiceSpec(specs, name);
      if (spec === undefined) continue;
      log.warn?.('services: ' + name + ' (pid ' + pid + ') is gone; watchdog restarting it');
      await track(onChildExit(spec, 'watchdog'));
    }
  }

  return {
    async start(): Promise<void> {
      if (disposed) return;
      if (started) return;
      started = true;
      const existing = await readState();
      if (existing !== null && existing.hostPid !== process.pid && pidAlive(existing.hostPid)) {
        // Another live host already supervises the stack (two DSH windows).
        log.info?.('services: already supervised by host ' + existing.hostPid + '; adopting instead of starting');
        state = existing;
        startWatchdog();
        return;
      }
      if (existing !== null && existing.hostPid !== process.pid) {
        // Previous host died hard: the services it owned are orphans now.
        await this.reapOrphans();
      }
      await persist(emptyState(process.pid, autoRestart, maxRestarts, nowIso()));
      const env = await childEnv();
      if (env.TDAI_LLM_API_KEY === '__ARK_KEY__') {
        log.warn?.('services: TDAI_LLM_API_KEY is still the placeholder __ARK_KEY__ — LLM calls will fail');
      }
      for (const spec of specs) {
        if (disposed) return;
        if (await probe(spec.port)) {
          log.info?.('services: ' + spec.name + ' is already healthy on ' + spec.port + '; not spawning it (not owned)');
          continue;
        }
        const pid = await spawnService(spec, 'boot');
        const health = await waitHealthy(spec.port, {
          budgetMs: healthTimeoutMs,
          intervalMs: healthIntervalMs,
          probe: () => probe(spec.port),
          now,
          sleep,
        });
        if (!health.ok) {
          suppressed.add(pid);
          await killTree(pid).catch(() => undefined);
          await dropOwned(spec.name, 'health gate failed after ' + health.elapsedMs + 'ms');
          // Same contract as the PowerShell plan: a failed gate aborts the rest
          // of the order, because knowledge and panel are useless without core.
          throw new Error(
            spec.name + ' did not answer /health on port ' + spec.port
            + ' within ' + health.elapsedMs + 'ms (attempts=' + health.attempts + '); see '
            + options.logDir,
          );
        }
        const current = state ?? emptyState(process.pid, autoRestart, maxRestarts, nowIso());
        const failure = { ...(current.failed ?? {}) };
        delete failure[spec.name];
        await persist({
          ...current,
          owned: { ...current.owned, [spec.name]: pid },
          ...(Object.keys(failure).length > 0 ? { failed: failure } : { failed: undefined }),
        });
      }
      startWatchdog();
      const healthy = specs.length;
      log.info?.('services: stack is up (' + healthy + ' service(s), owned=' + Object.keys(state?.owned ?? {}).join(',') + ')');
    },

    async stop(reason = 'requested'): Promise<void> {
      stopping = true;
      try {
        await stopOwnedServices(reason);
      } finally {
        if (watchTimer !== undefined) clearInterval(watchTimer);
        watchTimer = undefined;
        await persist(null);
        stopping = false;
      }
    },

    async restartOne(name: string): Promise<RestartResult> {
      const spec = findServiceSpec(specs, name);
      if (spec === undefined) return { ok: false, error: 'unknown-service' };
      const current = state;
      if (current === null) return { ok: false, error: 'supervisor-not-running' };
      if (!autoRestart) return { ok: false, error: 'auto-restart-disabled' };
      const pid = current.owned[name];
      if (pid === undefined) return { ok: false, error: 'service-not-owned' };
      if (!pidAlive(pid)) return { ok: false, error: 'service-already-down-watchdog-will-restart' };
      log.info?.('services: restart requested for ' + name + ' (pid ' + pid + ')');
      // Kill only; the watchdog sees the dead pid and respawns, so the restart
      // path is the same one a crash takes (no second code path to keep in sync).
      suppressed.add(pid);
      await killTree(pid);
      return { ok: true, restarting: name };
    },

    async status(): Promise<SupervisorStatus> {
      const current = state ?? (await readState());
      const sameHost = current !== null && current.hostPid === process.pid;
      const services = await Promise.all(
        specs.map(async (spec): Promise<ServiceStatus> => {
          const pid = current?.owned?.[spec.name];
          const alive = typeof pid === 'number' ? pidAlive(pid) : false;
          return {
            name: spec.name,
            port: spec.port,
            healthy: await probe(spec.port),
            pid: typeof pid === 'number' ? pid : null,
            pidAlive: alive,
            owned: sameHost && alive,
            dir: spec.dir,
          };
        }),
      );
      return {
        hostPid: process.pid,
        enabled: true,
        running: sameHost,
        startedAt: sameHost ? (current?.startedAt ?? null) : null,
        autoRestart,
        restartsUsed: sameHost ? (current?.restartsUsed ?? 0) : 0,
        maxRestarts: sameHost ? (current?.maxRestarts ?? maxRestarts) : maxRestarts,
        services,
        updatedAt: nowIso(),
      };
    },

    async reapOrphans(): Promise<string[]> {
      const previous = state ?? (await readState());
      if (previous === null) return [];
      if (previous.hostPid === process.pid && started) return [];
      const reaped: string[] = [];
      for (const [name, pid] of Object.entries(previous.owned)) {
        if (!pidAlive(pid)) continue;
        log.warn?.('services: reaping orphan ' + name + ' (pid ' + pid + ') left by host ' + previous.hostPid);
        await killTree(pid).catch(() => undefined);
        reaped.push(name);
      }
      await persist(null);
      return reaped;
    },

    async whenIdle(): Promise<void> {
      // Two passes: a restart can schedule another task while it unwinds.
      for (let round = 0; round < 4 && inFlight.size > 0; round += 1) {
        await Promise.all([...inFlight]);
      }
    },

    async dispose(): Promise<void> {
      disposed = true;
      if (watchTimer !== undefined) clearInterval(watchTimer);
      watchTimer = undefined;
      await stopOwnedServices('host disposing');
    },

    async detach(reason = 'host disposing'): Promise<void> {
      disposed = true;
      if (watchTimer !== undefined) clearInterval(watchTimer);
      watchTimer = undefined;
      const current = state;
      if (current !== null) {
        // hostPid 0 = "no live owner". `pidAlive(0)` is false, so the next boot
        // neither adopts nor reaps: it probes the ports, finds them healthy and
        // leaves them alone — which is exactly what leaving them running means.
        await persist({ ...current, hostPid: 0, owned: {} });
      }
      children.clear();
      log.info?.('services: detached (' + reason + '); the stack keeps running and is no longer owned');
    },
  };
}