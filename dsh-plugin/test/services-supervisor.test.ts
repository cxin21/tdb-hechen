import { describe, expect, it, vi } from 'vitest';
import { defaultServiceTable } from '../src/services/service-table.js';
import {
  createServiceSupervisor,
  parseState,
  SUPERVISOR_STATE_VERSION,
  type SupervisorOptions,
  type SupervisorState,
} from '../src/services/supervisor.js';

const SPECS = defaultServiceTable({ repoRoot: 'D:/repo' });
const STATE_PATH = 'D:/repo/data/run/tdb-services.state.json';

interface FakeChild {
  pid: number;
  cwd: string;
  exit: (code?: number | null) => void;
  error: (error: Error) => void;
}

interface HarnessOptions {
  healthy?: number[];
  /** Ports that stay unhealthy forever (a service that never answers /health). */
  never?: number[];
  autoRestart?: boolean;
  maxRestarts?: number;
  envFile?: string;
  initialState?: SupervisorState | null;
  watchIntervalMs?: number;
  healthTimeoutMs?: number;
  files?: Record<string, string>;
  livePids?: number[];
}

function harness(options: HarnessOptions = {}) {
  const healthy = new Set<number>(options.healthy ?? []);
  const never = new Set<number>(options.never ?? []);
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  if (options.initialState !== undefined && options.initialState !== null) {
    files.set(STATE_PATH, JSON.stringify(options.initialState));
  }
  const live = new Set<number>(options.livePids ?? []);
  const spawns: FakeChild[] = [];
  const calls: Array<{ args: readonly string[]; options: { cwd: string; env: Record<string, string>; stdio: unknown[] } }> = [];
  const kills: number[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  let nextPid = 5000;
  let clock = 0;
  const children = new Map<number, FakeChild>();
  // A fake service becomes healthy as soon as it is spawned, which is what the
  // real ones do (they answer /health a few seconds later).  opts out.
  const spawnedPorts = new Set<number>();

  const spawnImpl = vi.fn((command: string, args: readonly string[], spawnOptions: SupervisorOptions extends never ? never : any) => {
    calls.push({ args, options: spawnOptions as { cwd: string; env: Record<string, string>; stdio: unknown[] } });
    const spec = SPECS.find((entry) => entry.dir === (spawnOptions as { cwd: string }).cwd);
    if (spec !== undefined) spawnedPorts.add(spec.port);
    const pid = (nextPid += 1);
    live.add(pid);
    const handlers: { exit: Array<(code: number | null, signal: string | null) => void>; error: Array<(error: Error) => void> } = {
      exit: [],
      error: [],
    };
    const child: FakeChild = {
      pid,
      cwd: spawnOptions.cwd,
      exit: (code = 0) => {
        live.delete(pid);
        for (const handler of handlers.exit) handler(code, null);
      },
      error: (error: Error) => {
        for (const handler of handlers.error) handler(error);
      },
    };
    children.set(pid, child);
    spawns.push(child);
    return {
      pid,
      on: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') handlers.exit.push(handler as never);
        if (event === 'error') handlers.error.push(handler as never);
        return undefined as never;
      },
    } as never;
  }) as never;

  const supervisor = createServiceSupervisor({
    specs: SPECS,
    nodePath: 'node',
    logteeModule: 'file:///D:/etc/logtee.mjs',
    logDir: 'D:/repo/data/logs',
    runDir: 'D:/repo/data/run',
    statePath: STATE_PATH,
    ...(options.envFile !== undefined ? { envFile: options.envFile } : {}),
    autoRestart: options.autoRestart ?? true,
    maxRestarts: options.maxRestarts ?? 3,
    healthTimeoutMs: options.healthTimeoutMs ?? 1000,
    healthIntervalMs: 100,
    watchIntervalMs: options.watchIntervalMs ?? 0,
    ambientEnv: { PATH: 'C:/bin', TDAI_LLM_API_KEY: 'real-key' },
    spawnImpl,
    probe: async (port: number) => !never.has(port) && (healthy.has(port) || spawnedPorts.has(port)),
    pidAlive: (pid: number) => live.has(pid),
    killTree: async (pid: number) => {
      kills.push(pid);
      live.delete(pid);
      children.get(pid)?.exit(0);
    },
    readFileImpl: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) {
        const error = new Error('ENOENT: no such file') as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      }
      return value;
    },
    writeFileImpl: async (path: string, text: string) => {
      files.set(path, text);
    },
    removeFileImpl: async (path: string) => {
      files.delete(path);
    },
    mkdirImpl: async () => undefined,
    openLogImpl: async () => 3,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: {
      info: (message: string) => infos.push(message),
      warn: (message: string) => warnings.push(message),
      debug: () => undefined,
    },
  } as SupervisorOptions);

  const stateOf = (): SupervisorState | null => parseState(files.get(STATE_PATH) ?? null);
  const markHealthy = (port: number): void => {
    healthy.add(port);
  };
  return { supervisor, spawns, calls, kills, warnings, infos, files, stateOf, markHealthy, never, live, children };
}

describe('service supervisor: start order', () => {
  it('spawns every unhealthy service in table order and records ownership', async () => {
    const h = harness({ healthy: [8420] });
    // Core is already up (a manual start, or the previous host's stack): it must
    // be left alone and NOT recorded as owned.
    await h.supervisor.start();
    await h.supervisor.whenIdle();

    expect(h.spawns.map((child) => child.cwd)).toEqual(['D:/repo\\MemoryKnowledge', 'D:/repo\\MemoryPanel']);
    const state = h.stateOf();
    expect(state?.hostPid).toBe(process.pid);
    expect(Object.keys(state?.owned ?? {})).toEqual(['tdai-knowledge', 'tdai-panel']);
    // Every spawned pid is live and owned.
    for (const pid of Object.values(state?.owned ?? {})) expect(h.live.has(pid)).toBe(true);
  });

  it('passes the env file into the child environment, plus its own tee path', async () => {
    const h = harness({
      envFile: 'D:/etc/services.env',
      files: {
        // ${NAME} resolves against the merged environment: the file is read
        // first, the ambient host environment fills the rest.
        'D:/etc/services.env': 'TDAI_GATEWAY_APIKEY=from-file\nLLM_API_KEY=${TDAI_LLM_API_KEY}\n',
      },
    });
    await h.supervisor.start();
    expect(h.calls).toHaveLength(3);
    const [first] = h.calls;
    // The file wins over the ambient environment...
    expect(first!.options.env.TDAI_GATEWAY_APIKEY).toBe('from-file');
    // ...and the ambient environment fills a reference the file does not define.
    expect(first!.options.env.LLM_API_KEY).toBe('real-key');
    // The logtee preload is argv[0..1]; the service's own args follow it.
    expect(first!.args.slice(0, 2)).toEqual(['--import', 'file:///D:/etc/logtee.mjs']);
    expect(first!.args).toContain('src/gateway/server.ts');
    // Each service gets its OWN tee file: a shared handle caused EBUSY on writes.
    const tees = h.calls.map((call) => call.options.env.TDAI_LOG_FILE);
    expect(new Set(tees).size).toBe(3);
    for (const tee of tees) expect(tee).toMatch(/\.out\.log\.tee\.log$/);
    // stdout/stderr are file descriptors we opened, not the host's console.
    expect(first!.options.stdio).toEqual(['ignore', 3, 3]);
  });

  it('aborts the order when a service never answers /health, and records why', async () => {
    const h = harness({ never: [8421] });
    // Core answers, knowledge never does: panel must not even be attempted.
    h.markHealthy(8423);
    await expect(h.supervisor.start()).rejects.toThrow(/tdai-knowledge did not answer \/health/);
    expect(h.spawns.map((child) => child.cwd)).toEqual(['D:/repo\\MemoryCore', 'D:/repo\\MemoryKnowledge']);
    const state = h.stateOf();
    expect(state?.owned).toEqual({ 'tdai-core': h.spawns[0]!.pid });
    expect(state?.failed?.['tdai-knowledge']).toContain('health gate failed');
    // The half-started service is killed, not left running behind our back.
    expect(h.kills).toContain(h.spawns[1]!.pid);
    expect(h.live.has(h.spawns[1]!.pid)).toBe(false);
  });
});

describe('service supervisor: ownership', () => {
  it('adopts instead of racing a live host that already supervises the stack', async () => {
    const foreignHost = 4242;
    const h = harness({
      initialState: {
        version: SUPERVISOR_STATE_VERSION,
        hostPid: foreignHost,
        startedAt: '2026-11-01T00:00:00.000Z',
        autoRestart: true,
        maxRestarts: 3,
        restartsUsed: 1,
        owned: { 'tdai-core': 9001 },
      },
      livePids: [foreignHost, 9001],
      healthy: [8420, 8421, 8123],
    });
    await h.supervisor.start();
    expect(h.spawns).toHaveLength(0);
    const status = await h.supervisor.status();
    // status() reports what THIS host owns, which is nothing: a second window must
    // not claim the first window's services.
    expect(status.running).toBe(false);
    expect(status.services.every((service) => service.owned === false)).toBe(true);
  });

  it('reaps orphans left by a host that died hard, then starts cleanly', async () => {
    const deadHost = 1111;
    const orphan = 2222;
    const h = harness({
      initialState: {
        version: SUPERVISOR_STATE_VERSION,
        hostPid: deadHost,
        startedAt: '2026-11-01T00:00:00.000Z',
        autoRestart: true,
        maxRestarts: 3,
        restartsUsed: 0,
        owned: { 'tdai-core': orphan },
      },
      livePids: [orphan],
    });
    await h.supervisor.start();
    expect(h.kills).toContain(orphan);
    expect(h.live.has(orphan)).toBe(false);
    expect(Object.keys(h.stateOf()?.owned ?? {})).toHaveLength(3);
  });
});

describe('service supervisor: restart budget', () => {
  it('respawns a service that dies on its own and counts the attempt', async () => {
    const h = harness({ maxRestarts: 2 });
    await h.supervisor.start();
    const corePid = h.stateOf()!.owned['tdai-core']!;
    h.children.get(corePid)!.exit(1);
    await h.supervisor.whenIdle();

    const state = h.stateOf()!;
    expect(state.restartsUsed).toBe(1);
    expect(state.owned['tdai-core']).not.toBe(corePid);
    expect(h.spawns).toHaveLength(4);
    expect(h.warnings.join('\n')).toContain('watchdog owns the restart');
  });

  it('stops restarting once the budget is spent, and says so', async () => {
    const h = harness({ maxRestarts: 1 });
    await h.supervisor.start();
    const corePid = h.stateOf()!.owned['tdai-core']!;
    h.children.get(corePid)!.exit(1);
    await h.supervisor.whenIdle();
    const secondPid = h.stateOf()!.owned['tdai-core']!;
    expect(secondPid).not.toBe(corePid);
    h.children.get(secondPid)!.exit(1);
    await h.supervisor.whenIdle();

    const state = h.stateOf()!;
    expect(state.restartsUsed).toBe(1);
    expect(state.owned['tdai-core']).toBeUndefined();
    expect(state.failed?.['tdai-core']).toContain('restart budget');
    expect(h.spawns).toHaveLength(4);
    expect(h.warnings.join('\n')).toContain('down for good this session');
  });

  it('does not restart when autoRestart is off', async () => {
    const h = harness({ autoRestart: false });
    await h.supervisor.start();
    const corePid = h.stateOf()!.owned['tdai-core']!;
    h.children.get(corePid)!.exit(1);
    await h.supervisor.whenIdle();
    expect(h.spawns).toHaveLength(3);
    expect(h.stateOf()?.failed?.['tdai-core']).toContain('auto-restart is off');
  });

  it('restartOne kills an owned service so the watchdog respawns it, and refuses strangers', async () => {
    const h = harness();
    await h.supervisor.start();
    const corePid = h.stateOf()!.owned['tdai-core']!;

    await expect(h.supervisor.restartOne('tdai-proxy')).resolves.toEqual({ ok: false, error: 'unknown-service' });
    await expect(h.supervisor.restartOne('tdai-knowledge')).resolves.toEqual({ ok: true, restarting: 'tdai-knowledge' });
    expect(h.kills).toContain(h.stateOf()!.owned['tdai-knowledge'] ?? -1);
    void corePid;

    const off = harness({ autoRestart: false });
    await off.supervisor.start();
    await expect(off.supervisor.restartOne('tdai-core')).resolves.toEqual({ ok: false, error: 'auto-restart-disabled' });

    const cold = harness();
    await expect(cold.supervisor.restartOne('tdai-core')).resolves.toEqual({ ok: false, error: 'supervisor-not-running' });
  });
});

describe('service supervisor: shutdown', () => {
  it('stops only the pids it owns and clears the state file', async () => {
    const h = harness();
    await h.supervisor.start();
    const owned = Object.values(h.stateOf()!.owned);
    await h.supervisor.stop('test');

    expect(h.kills.sort()).toEqual([...owned].sort());
    expect(h.stateOf()).toBeNull();
    for (const pid of owned) expect(h.live.has(pid)).toBe(false);
  });

  it('detach keeps the stack running and records that nobody owns it', async () => {
    const h = harness();
    await h.supervisor.start();
    const owned = Object.values(h.stateOf()!.owned);
    await h.supervisor.detach('operator asked');

    const state = h.stateOf()!;
    expect(state.hostPid).toBe(0);
    expect(state.owned).toEqual({});
    for (const pid of owned) expect(h.live.has(pid)).toBe(true);
    expect(h.kills).toEqual([]);
  });

  it('dispose never touches services it did not spawn', async () => {
    const h = harness({ healthy: [8420, 8421, 8123] });
    await h.supervisor.start();
    await h.supervisor.dispose();
    expect(h.kills).toEqual([]);
    expect(h.spawns).toEqual([]);
  });
});

describe('service supervisor: status and state parsing', () => {
  it('reports health, ownership and budget for the settings page', async () => {
    const h = harness({ healthy: [8421] });
    await h.supervisor.start();
    const status = await h.supervisor.status();
    expect(status.hostPid).toBe(process.pid);
    expect(status.running).toBe(true);
    expect(status.services.map((service) => [service.name, service.healthy, service.owned])).toEqual([
      ['tdai-core', true, true],
      ['tdai-knowledge', true, false],
      ['tdai-panel', true, true],
    ]);
    expect(status.maxRestarts).toBe(3);
  });

  it('rejects a state file it cannot trust instead of acting on it', () => {
    expect(parseState(null)).toBeNull();
    expect(parseState('not json')).toBeNull();
    expect(parseState(JSON.stringify({ version: 99, hostPid: 1 }))).toBeNull();
    expect(parseState(JSON.stringify({ version: 1, hostPid: 'x' }))).toBeNull();
    const partial = parseState(
      JSON.stringify({ version: 1, hostPid: 7, owned: { 'tdai-core': 12, bad: 'nope' }, failed: { x: 5 } }),
    );
    expect(partial?.owned).toEqual({ 'tdai-core': 12 });
    expect(partial?.failed).toBeUndefined();
    expect(partial?.autoRestart).toBe(true);
  });
});